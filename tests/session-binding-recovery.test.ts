import { acceptedTurnInput } from './turn-input-fixture';
import { FakeEngineQueue } from './engine-queue-fixture';
// A turn start re-checks the live binding against the engine id it resolved a moment
// earlier. These tests pin the two halves of that check: a binding that vanished between
// the resolve and the turn start is rebuilt and the send proceeds, while a binding that
// now names a different engine session still refuses the turn. The removal side is pinned
// too: every path that drops a binding reports the session and the reason, so a
// reproduced race leaves an attributable trace instead of a silent gap.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { assert, assertEqual, Harness, waitFor } from './harness';
import { HostState } from '../main/services/host-state';
import { SessionService, type EngineClientLike, type SessionServiceDeps } from '../main/sessions/service';
import { IpcHandlerError } from '../main/ipc/registry';
import { kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';

const h = new Harness();
const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-binding-recovery-'));
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
  private readonly submitReplies = new Map<string, string>();
  replySubmit(mode: 'start-if-idle' | 'steer', fallbackSubmissionId = 'fixture-turn'): this {
    this.submitReplies.set(mode, fallbackSubmissionId);
    return this;
  }
  sentSubmit(mode: 'start-if-idle' | 'steer'): Json[] {
    return this.calls.filter(call => call.method === 'turn/submit' && (call.params as Record<string, Json>).mode === mode).map(call => call.params);
  }

  private readonly replies = new Map<string, Json>();
  closed = false;

  reply(method: string, value: Json): this {
    this.replies.set(method, value);
    return this;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async requestWithTimeout(method: string, params: Json): Promise<unknown> {
    this.calls.push({ method, params });
    if (method.startsWith('thread/queue/')) return this.queue.request(method, params);
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
    if (method === 'turn/submit' && !this.replies.has(method)) {
      const mode = String((params as Record<string, Json>).mode), fallback = this.submitReplies.get(mode);
      if (fallback !== undefined) return acceptedTurnInput(params, fallback);
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

h.test('parallel settings capability reads occupy one provider operation and do not cache settled metadata', async () => {
  let release!: (value: Json) => void;
  const pending = new Promise<Json>(resolve => { release = resolve; });
  class Capabilities extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'workbuddy/capabilities') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params });
      if (this.sent(method).length > 4) throw new Error('workbuddy_operation_limit');
      return pending;
    }
  }
  const client = new Capabilities(), { service } = serviceWith(client, freshRoot());
  const reads = Array.from({ length: 24 }, () => service.request('workbuddy/capabilities', {}));
  await waitFor(() => client.sent('workbuddy/capabilities').length > 0, 1000, 'capability read entered');
  assertEqual(client.sent('workbuddy/capabilities').length, 1, 'parallel panels share one operation');
  release({ image: { available: true } });
  assert((await Promise.all(reads)).every(value => (value as { image: { available: boolean } }).image.available), 'all panels receive current metadata');
  await service.request('workbuddy/capabilities', {});
  assertEqual(client.sent('workbuddy/capabilities').length, 2, 'a later read revalidates instead of reusing a settled cache');
});

h.test('operation-owned capability reads and custom time budgets remain independent', async () => {
  let release!: (value: Json) => void;
  const pending = new Promise<Json>(resolve => { release = resolve; });
  class Capabilities extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'workbuddy/capabilities') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params }); return pending;
    }
  }
  const client = new Capabilities(), { service } = serviceWith(client, freshRoot());
  const reads = [service.request('workbuddy/capabilities', {}), service.request('workbuddy/capabilities', {}),
    service.request('workbuddy/capabilities', { operationId: 'voice-one' }),
    service.request('workbuddy/capabilities', { operationId: 'voice-two' }),
    service.request('workbuddy/capabilities', {}, 1234)];
  await waitFor(() => client.sent('workbuddy/capabilities').length === 4, 1000, 'independent reads entered');
  release({ audio: { available: true } }); await Promise.all(reads);
  assertEqual(client.sent('workbuddy/capabilities').length, 4, 'only the two plain settings reads shared an operation');
});

h.test('a rejected capability read is shared only while pending and can recover after credential replacement', async () => {
  let fail!: () => void;
  const pending = new Promise<Json>((_resolve, reject) => { fail = () => reject(new Error('workbuddy_credential_changed')); });
  class Capabilities extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'workbuddy/capabilities') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params });
      return this.sent(method).length === 1 ? pending : { video: { available: true } };
    }
  }
  const client = new Capabilities(), { service } = serviceWith(client, freshRoot());
  const settled = Promise.allSettled(Array.from({ length: 8 }, () => service.request('workbuddy/capabilities', {})));
  await waitFor(() => client.sent('workbuddy/capabilities').length === 1, 1000, 'failed read entered');
  fail(); assert((await settled).every(value => value.status === 'rejected'), 'no panel receives stale readiness');
  const recovered = await service.request('workbuddy/capabilities', {}) as { video: { available: boolean } };
  assertEqual(recovered.video.available, true, 'a fresh credential read can recover');
  assertEqual(client.sent('workbuddy/capabilities').length, 2, 'the rejected promise was evicted');
});

h.test('an engine replacement never reuses or publishes the old capability read', async () => {
  let release!: (value: Json) => void;
  const pending = new Promise<Json>(resolve => { release = resolve; });
  class OldCapabilities extends FakeClient {
    override async requestWithTimeout(method: string, params: Json): Promise<unknown> {
      if (method !== 'workbuddy/capabilities') return super.requestWithTimeout(method, params);
      this.calls.push({ method, params }); return pending;
    }
  }
  const oldClient = new OldCapabilities(), replacement = new FakeClient().reply('workbuddy/capabilities', { image: { available: false } });
  let current: FakeClient = oldClient;
  const { service } = serviceWith(oldClient, freshRoot(), { manager: {
    attach: async () => ({ client: current, generation: current === oldClient ? 1 : 2 }),
    shutdownAll: async () => { current.closed = true; },
  } });
  const oldRead = service.request('workbuddy/capabilities', {});
  const settled = Promise.allSettled([oldRead]);
  await waitFor(() => oldClient.sent('workbuddy/capabilities').length === 1, 1000, 'old read entered');
  oldClient.closed = true; current = replacement;
  let disconnected: unknown;
  try { await service.request('workbuddy/capabilities', {}); } catch (error) { disconnected = error; }
  assert(disconnected instanceof IpcHandlerError, 'the first request observes the closed connection');
  assertEqual((disconnected as IpcHandlerError).code, 'ENGINE_DISCONNECTED', 'connection cleanup precedes replacement attachment');
  const next = await service.request('workbuddy/capabilities', {}) as { image: { available: boolean } };
  assertEqual(next.image.available, false, 'the replacement owns its own readiness');
  release({ image: { available: true } });
  assertEqual((await settled)[0]?.status, 'rejected', 'the old client cannot publish readiness after replacement');
  assertEqual(replacement.sent('workbuddy/capabilities').length, 1, 'replacement received its own request');
});

const TAB_MENTION = 'plugin://browser@klaus-bundled?mention=tab-v1&browserId=iab&tabId=7&title=Docs&url=https%3A%2F%2Fexample.com%2Fdocs';

h.test('a binding dropped between resolve and turn start is rebuilt and the send proceeds', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/start', { sessionId: 'thread' }).replySubmit('start-if-idle', 'turn-1');
  // The send resolves the binding before entering the mutation lock; this expansion hook
  // runs in between and stands in for whatever removed the binding in that window.
  const built = serviceWith(client, root, {
    browserTabContext: async () => {
      built.state.forgetSession('thread', 'test-window-drop');
      return '';
    },
  });
  await built.service.send('thread', { text: `${TAB_MENTION} summarize` });
  assertEqual(client.sent('session/start').length, 2, 'the resolve and the rebuild each started the session once');
  assertEqual(client.sentSubmit('start-if-idle').length, 1, 'the turn started once the binding was rebuilt');
  assertEqual(built.state.liveSession('thread'), 'thread', 'the rebuilt binding names the resolved engine id');
});

h.test('a binding replaced by another engine session still refuses the turn', async () => {
  const root = byoRoot();
  const client = new FakeClient().reply('session/start', { sessionId: 'thread' }).replySubmit('start-if-idle', 'turn-1');
  const built = serviceWith(client, root, {
    browserTabContext: async () => {
      built.state.rememberSession('thread', 'replacement', {});
      return '';
    },
  });
  let error: unknown;
  try {
    await built.service.send('thread', { text: `${TAB_MENTION} summarize` });
  } catch (thrown) { error = thrown; }
  assert(error instanceof IpcHandlerError, 'the send was refused');
  assertEqual((error as IpcHandlerError).code, 'SESSION_UNAVAILABLE', 'a replaced binding is not silently adopted');
  assertEqual(client.sentSubmit('start-if-idle').length, 0, 'no turn reached the engine');
});

h.test('every binding removal names its session and the path removing it', async () => {
  const drops: Array<{ rendererId: string; engineId: string; reason: string }> = [];
  const state = new HostState({ onDrop: (rendererId, engineId, reason) => drops.push({ rendererId, engineId, reason }) });
  state.rememberSession('thread', 'engine-1', {});
  state.forgetSession('thread', 'session-deleted');
  state.rememberSession('thread', 'engine-2', {});
  state.markStale('thread');
  assertEqual(state.takeStaleBinding('thread'), 'engine-2', 'the stale binding is taken');
  state.rememberSession('other', 'engine-3', {});
  state.invalidateConnection();
  assertEqual(drops.length, 3, 'each removal reported once');
  assertEqual(drops[0]?.reason, 'session-deleted', 'delete names itself');
  assertEqual(drops[1]?.reason, 'stale-binding-taken', 'stale rebuild names itself');
  assertEqual(drops[2]?.reason, 'connection-invalidated', 'connection loss names itself');
  assert(drops.every(drop => drop.rendererId.length > 0 && drop.engineId.length > 0), 'every report carries both identities');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'session-binding-recovery-result.json'), 'session-binding-recovery');
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp dir that will not delete is not a test failure.
    }
  }
  process.exit(failed);
})();
