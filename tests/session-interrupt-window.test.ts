// A stop click settles the running registry OPTIMISTICALLY so the button feels
// instant, but the engine turn keeps winding down until its terminal event
// lands. In that window the session looks idle to every `isWorking` guard, and
// the 2026-10-08 incident showed exactly what that costs: a history read raced
// the stop, took the stale-binding rebuild path, `session/close`d the engine
// session and killed the aborting turn — which then died as a red
// "session shutdown closed Setup context admission" failure instead of a stop.
//
// These tests pin the interrupt window: while it is open, the rebuild path
// keeps the live binding and an explicit close still interrupts the dying turn
// before closing its session, so the transcript gets its terminal frame.
import { FakeEngineQueue } from './engine-queue-fixture';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { assert, assertEqual, Harness } from './harness';
import { HostState } from '../main/services/host-state';
import { SessionService, type EngineClientLike, type SessionServiceDeps } from '../main/sessions/service';
import { kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';

const h = new Harness();
const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-interrupt-window-'));
  roots.push(root);
  return root;
}

function byoRoot(): string {
  const root = freshRoot();
  assertEqual(kvSet('auth_mode', 'custom', root), true, 'the BYO precondition was written');
  return root;
}

interface Call { method: string; params: Json }

class FakeClient extends EventEmitter implements EngineClientLike {
  readonly calls: Call[] = [];
  readonly queue = new FakeEngineQueue();
  private readonly replies = new Map<string, Json>();
  private readonly outcomes = new Map<string, Record<string, Json>>();
  closed = false;

  reply(method: string, value: Json): this {
    this.replies.set(method, value);
    return this;
  }

  /** Script an operation whose completion arrives as an event, like the engine's acks. */
  replyAcknowledged(method: string, envelope: Record<string, Json>): this {
    this.outcomes.set(method, envelope);
    return this.reply(method, { submissionId: 'fixture-submission' });
  }

  isClosed(): boolean {
    return this.closed;
  }

  async requestWithTimeout(method: string, params: Json): Promise<unknown> {
    this.calls.push({ method, params });
    if (method.startsWith('thread/queue/')) return this.queue.request(method, params);
    if (method === 'turn/interrupt') {
      this.emit('event', { type: 'rawSessionEvent', params: { sessionId: (params as Record<string, Json>).sessionId, event: { submissionId: 'fixture-interrupt', turnInterrupt: { accepted: true } } } });
      return { submissionId: 'fixture-interrupt' };
    }
    const outcome = this.outcomes.get(method);
    if (outcome) this.emit('event', { type: 'engineEvent', params: { submissionId: 'fixture-submission', ...outcome } });
    if (method === 'session/prepare' && !this.replies.has(method)) return { sessionId: (params as { sessionId: string }).sessionId, ready: true };
    if (method === 'session/subscribe' && !this.replies.has(method)) return { subscribed: true };
    if (method === 'session/taskList' && !this.replies.has(method)) return { tasks: [] };
    if (method === 'session/setupLifecycle' && !this.replies.has(method)) return { setupLifecycle: { idempotencyResults: {} } };
    if (method === 'session/queueSnapshot' && !this.replies.has(method)) return { queueSnapshot: { revision: 0, status: 'authoritative', items: [] } };
    if (method === 'config/read' && !this.replies.has(method)) return { resolved: {}, sources: {} };
    if (method === 'model/selection/resolve' && !this.replies.has(method)) {
      const saved = params as { source: string; selection: string };
      return { source: saved.source, selection: saved.selection === 'auto' ? `${saved.source}:fixture-default` : saved.selection };
    }
    if (!this.replies.has(method)) throw new Error(`fake client: no reply scripted for ${method}`);
    return this.replies.get(method);
  }

  sent(method: string): Json[] {
    return this.calls.filter(call => call.method === method).map(call => call.params);
  }
}

function serviceWith(client: FakeClient, configRoot: string, overrides: Partial<SessionServiceDeps> = {}): { service: SessionService; state: HostState; pushed: Json[] } {
  const state = new HostState();
  const pushed: Json[] = [];
  const service = new SessionService({
    manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => { client.closed = true; } },
    state,
    spawnOptions: () => ({ command: '/bin/true', args: [], env: [] }),
    pushChatEvents: events => pushed.push(...events),
    configRoot,
    ...overrides,
  });
  return { service, state, pushed };
}

h.test('a stale binding is not rebuilt while a stopped turn is still winding down', async () => {
  const root = byoRoot();
  const client = new FakeClient()
    .reply('session/start', { sessionId: 'thread' })
    .reply('turn/submit', { status: 'started', submissionId: 'turn-1', turnId: 'turn-1' })
    .reply('turn/interrupt', {})
    .reply('session/close', { closed: true })
    .reply('session/history', { history: [], historyTurnIds: {} });
  const built = serviceWith(client, root);
  await built.service.send('thread', { text: 'q' });
  assertEqual(client.sent('session/start').length, 1, 'the send started the session once');
  // The event pump registers the running turn from the engine's stream frames;
  // the fake has no pump, so the registry is set the way the pump would.
  built.state.markTurnRunning('thread', 'turn-1');

  // The user stop: the registry settles synchronously and the interrupt leg
  // runs in the background.
  const stopped = await built.service.interrupt('thread', 'turn-1');
  assertEqual((stopped as { accepted?: boolean }).accepted, true, 'the stop was accepted');
  assertEqual(built.state.isWorking('thread'), false, 'the optimistic settlement cleared the running flag');
  assertEqual(built.state.inInterruptWindow('thread'), true, 'the window is open until the engine terminal event');

  // A preference change marks the binding stale; the very next session-scoped
  // read (the history reload a transcript performs) must NOT close the engine
  // session while the aborting turn still owns it.
  built.state.markStale('thread');
  await built.service.history('thread');

  assertEqual(client.sent('session/close').length, 0, 'no close reached the engine inside the interrupt window');
  assertEqual(built.state.liveSession('thread'), 'thread', 'the live binding survived the read');

  // The engine terminal event closes the window; a later stale read rebuilds
  // as usual.
  built.state.clearInterruptWindow('thread');
  await built.service.history('thread');
  assertEqual(client.sent('session/close').length, 1, 'the stale binding rebuilds once the window is over');
  assertEqual(client.sent('session/start').length, 2, 'the rebuild started a fresh engine session');
});

h.test('an explicit close inside the window interrupts the dying turn first', async () => {
  const root = byoRoot();
  const client = new FakeClient()
    .reply('session/start', { sessionId: 'thread' })
    .reply('turn/submit', { status: 'started', submissionId: 'turn-1', turnId: 'turn-1' })
    .reply('turn/interrupt', {})
    .reply('session/close', { closed: true })
    .replyAcknowledged('session/deleteSession', { deleted: { threadId: 'thread', deleted: true } });
  const built = serviceWith(client, root);
  await built.service.send('thread', { text: 'q' });
  built.state.markTurnRunning('thread', 'turn-1');
  const stopped = await built.service.interrupt('thread', 'turn-1');
  assertEqual((stopped as { accepted?: boolean }).accepted, true, 'the stop was accepted');

  // A delete is an explicit teardown: it still closes the session, but the
  // dying turn gets its interrupt first so the transcript can settle it as a
  // stop instead of a teardown failure.
  await built.service.deleteSession('thread');

  const interruptAt = client.calls.findIndex(call => call.method === 'turn/interrupt');
  const closeAt = client.calls.findIndex(call => call.method === 'session/close');
  assert(interruptAt >= 0, 'the interrupt reached the engine');
  assert(closeAt > interruptAt, 'the close followed the interrupt, not the other way round');
  assertEqual(built.state.liveSession('thread'), undefined, 'the binding is gone after the delete');
});

h.test('the interrupt window expires so a lost terminal event cannot pin a session', async () => {
  const state = new HostState();
  state.markTurnRunning('thread', 'turn-1');
  state.clearTurnRunning('thread');
  state.noteInterruptWindow('thread');
  assertEqual(state.inInterruptWindow('thread'), true, 'the window is open right after the stop');
  state.clearInterruptWindow('thread');
  assertEqual(state.inInterruptWindow('thread'), false, 'the terminal event closes the window');
  // A session whose window was never noted is simply not in one.
  assertEqual(state.inInterruptWindow('other'), false, 'an unrelated session has no window');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'session-interrupt-window-result.json'), 'session-interrupt-window');
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp dir that will not delete is not a test failure.
    }
  }
  process.exit(failed);
})();
