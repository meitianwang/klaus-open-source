import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClientEvent } from '../main/engine/protocol';
import type { Json } from '../main/ipc/contract';
import { HostState } from '../main/services/host-state';
import { registerMediaGenerationTools } from '../main/services/media-generation/service';
import { object, type JsonObject } from '../main/services/service-types';
import { kvSet } from '../main/services/settings';
import { DynamicTools } from '../main/sessions/dynamic-tools';
import { SessionService, type EngineClientLike, type SessionServiceDeps } from '../main/sessions/service';
import { SIDE_TASK_IDLE_MS } from '../main/sessions/side-tasks';
import { Harness, waitFor } from './harness';
import { mediaFixture, resultText } from './media-generation-fixture';
import { FakeEngineQueue } from './engine-queue-fixture';

const h = new Harness();
type Stage = [string, boolean];
function deferred(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
async function vector(name: string, stages: Stage[]): Promise<void> {
  const all = object(JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/session-closing.json'), 'utf8')));
  deepEqual(stages, object(all.cases)[name]);
}
class Client extends EventEmitter implements EngineClientLike {
  readonly queue = new FakeEngineQueue();
  closed = false;
  failTitle = false;
  /** Answer `session/close` the way the engine answers for a session it no longer holds. */
  failCloseUnknown = false;
  holdClose?: Promise<void>;
  calls: Array<{ method: string; params: JsonObject }> = [];
  isClosed(): boolean { return this.closed; }
  async requestWithTimeout(method: string, value: Json): Promise<unknown> {
    const params = object(value); this.calls.push({ method, params });
    if (method.startsWith('thread/queue/')) return this.queue.request(method, params);
    if (method === 'session/close') {
      if (this.failCloseUnknown) throw { kind: 'server', code: -32004, message: `unknown session: ${String(params.sessionId)}` };
      await this.holdClose; return {};
    }
    if (method === 'model/selection/resolve') return { source: params.source, selection: params.selection === 'auto' ? 'custom:fixture' : params.selection };
    if (method === 'session/start') return { sessionId: 'live-' + String(object(params.init).threadId) };
    if (method === 'session/prepare') return { sessionId: (params as { sessionId: string }).sessionId, ready: true };
    if (method === 'session/subscribe') return { subscribed: true };
    if (method === 'session/taskList') return { tasks: [] };
    if (method === 'session/queueSnapshot') return { queueSnapshot: { revision: 0, status: 'authoritative', items: [] } };
    if (method === 'session/createSideTask') return { session: { threadId: params.newThreadId } };
    // The host migrated side-task creation to the named `session/startSideTask`
    // facade (engine 1aa44077). Its reply is asserted strictly: sessionId must equal
    // the reserved renderer endpoint, and `initialized` must echo accepted/role/
    // ephemeral/parentThreadId — plus agentDefinitionName when the init named one
    // (assertSessionAgent). Legacy createSideTask stays for the old path.
    if (method === 'session/startSideTask') {
      const init = object(params.init), threadId = String(init.threadId);
      return {
        sessionId: threadId,
        initialized: {
          accepted: true,
          threadId,
          role: 'side_task',
          ephemeral: true,
          parentThreadId: params.parentThreadId,
          ...(typeof init.agentDefinitionName === 'string' ? { agentDefinitionName: init.agentDefinitionName } : {}),
        },
      };
    }
    if (method === 'engine/listSessions') return { sessions: { items: [{ id: 'parent', title: 'Parent' }], nextCursor: null } };
    if (method === 'engine/readSessionSummary') return { session: object(params).sessionId === 'parent' ? { id: 'parent', title: 'Parent' } : null };
    if (method === 'session/history') return { history: [] };
    if (method === 'session/subagentLifecycle') return { subagentLifecycle: { agents: [] } };
    if (method === 'session/backgroundProcesses') return { backgroundProcesses: { processes: [] } };
    if (method === 'config/read') return { resolved: {}, sources: {} };
    if (method === 'turn/interrupt') {
      this.emit('event', { type: 'rawSessionEvent', params: { sessionId: params.sessionId, event: { submissionId: 'fixture-interrupt', turnInterrupt: { accepted: true } } } });
      return { submissionId: 'fixture-interrupt' };
    }
    if (method === 'session/updateTitle' && this.failTitle) throw new Error('Fixture title persistence failed');
    const acknowledgement: Record<string, [string, Json]> = {
      'session/deleteSession': ['deleted', { threadId: params.threadId!, deleted: true }],
      'session/updateTitle': ['title', params.title ?? ''],
    };
    const reply = acknowledgement[method];
    if (reply) { this.emit('event', { type: 'engineEvent', params: { submissionId: 'ack', [reply[0]]: reply[1] } }); return { submissionId: 'ack' }; }
    throw new Error(`Unexpected fixture request: ${method}`);
  }
}
async function fixture(overrides: Partial<SessionServiceDeps> = {}) {
  const media = await mediaFixture(), client = new Client(), state = new HostState(); let now = 100;
  kvSet('auth_mode', 'custom', media.root); media.config('custom', 'image', {});
  const sessions = new SessionService({ configRoot: media.root, state, workspaces: media.workspaces, pushChatEvents: () => {}, sideTaskClock: () => now,
    manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => { client.closed = true; } },
    spawnOptions: () => ({ command: '/unused', args: [], env: [] }), ...overrides });
  await sessions.client();
  state.rememberSession('one', 'engine-one', { cwd: media.workspaces.resolveSessionDirectory('one') }, { source: 'custom', selection: 'custom:fixture' });
  return { media, client, state, sessions, advance: () => { now += SIDE_TASK_IDLE_MS + 1; }, close: async () => { await sessions.shutdown(); await media.close(); } };
}

h.test('delete fences a dynamic call already queued before the first asynchronous cleanup hook', async () => {
  const prepare = deferred(), closing = deferred(), closed = deferred(), stages: Stage[] = [], replies: JsonObject[] = [];
  const f = await fixture({
    beginClosing: async id => { stages.push(['preparing', f.sessions.isSessionClosing(id)]); await prepare.promise; return () => {}; },
    onClosing: async id => { stages.push(['closing', f.sessions.isSessionClosing(id)]); await closing.promise; },
    onClosed: async id => { stages.push(['closed-hook', f.sessions.isSessionClosing(id)]); await closed.promise; },
  });
  const dynamic = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: id => id === 'engine-one', log: message => { throw new Error(message); } });
  let deletion: Promise<Json> | undefined;
  try {
    registerMediaGenerationTools(dynamic, f.media.service, (_name, _engineId, signal) => ({ ...f.media.context('custom', 'one', signal), assertCurrent: () => {
      signal.throwIfAborted(); if (f.sessions.isSessionClosing('one') || f.state.liveSession('one') !== 'engine-one') throw new Error('The conversation is closing.');
    } }));
    stages.push(['before', f.sessions.isSessionClosing('one')]);
    dynamic.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine-one', event: { dynamicToolCall: { callId: 'late', turnId: 'turn', tool: 'generate_image', arguments: { prompt: 'Must not charge' } } } } } as ClientEvent);
    deletion = f.sessions.deleteSession('one'); equal(f.sessions.isSessionClosing('one'), true); equal(f.sessions.isSessionClosing('other'), false);
    await waitFor(() => replies.length === 1, 1000, 'late dynamic request rejected');
    equal(object(replies[0]!.response).success, false); match(resultText(replies[0]!.response!), /cancelled/);
    equal(f.media.requests.length, 0); deepEqual(f.media.generated, []);
    prepare.resolve(); await waitFor(() => stages.some(([name]) => name === 'closing'), 1000, 'close hook');
    closing.resolve(); await waitFor(() => stages.some(([name]) => name === 'closed-hook'), 1000, 'post-close hook');
    closed.resolve(); await deletion; stages.push(['finished', f.sessions.isSessionClosing('one')]);
    await vector('delete', stages); equal(f.state.liveSession('one'), undefined);
  } finally { prepare.resolve(); closing.resolve(); closed.resolve(); await deletion?.catch(() => {}); await dynamic.close(); await f.close(); }
});
h.test('overlapping failed preparations release only their own admission hold', async () => {
  const gates = [deferred(), deferred()]; let entered = 0;
  const f = await fixture({ beginClosing: async () => { await gates[entered++]!.promise; return () => {}; } });
  try {
    const first = f.sessions.deleteSession('one'), firstRejected = rejects(first, /First failure/);
    const second = f.sessions.deleteSession('one'), secondRejected = rejects(second, /Second failure/);
    await waitFor(() => entered === 2, 1000, 'both preparation scopes'); const stages: Stage[] = [['both-pending', f.sessions.isSessionClosing('one')]];
    gates[0]!.reject(new Error('First failure')); await firstRejected; stages.push(['first-failed', f.sessions.isSessionClosing('one')]);
    gates[1]!.reject(new Error('Second failure')); await secondRejected; stages.push(['all-failed', f.sessions.isSessionClosing('one')]);
    await vector('overlap', stages); equal(f.state.liveSession('one'), 'engine-one');
  } finally { for (const gate of gates) gate.resolve(); await f.close(); }
});
h.test('synchronous preparation failure and direct close-hook failure cannot leak a closing marker', async () => {
  for (const preparation of [true, false]) {
    const f = await fixture(preparation ? { beginClosing: () => { throw new Error('Synchronous failure'); } } : { onClosing: () => { throw new Error('Direct close failure'); } });
    try { await rejects(f.sessions.deleteSession('one'), /failure/); equal(f.sessions.isSessionClosing('one'), false); equal(f.state.liveSession('one'), 'engine-one'); }
    finally { await f.close(); }
  }
});
h.test('idle side-task expiry fences direct close even though no preparation hook runs', async () => {
  const gate = deferred(); let closingId = '', preparations = 0;
  const f = await fixture({ beginClosing: async () => { preparations++; return () => {}; }, onClosing: async id => { closingId = id; await gate.promise; } });
  let sweeping: Promise<void> | undefined;
  try {
    const id = String(object(await f.sessions.createSideTask('parent')).id), stages: Stage[] = [['active', f.sessions.isSessionClosing(id)]];
    f.advance(); sweeping = f.sessions.sweepSideTasks(); await waitFor(() => closingId === id, 1000, 'expiry close started');
    equal(preparations, 0); stages.push(['closing', f.sessions.isSessionClosing(id)]);
    gate.resolve(); await sweeping; stages.push(['expired', f.sessions.isSessionClosing(id)]); await vector('expiry', stages); equal(f.state.liveSession(id), undefined);
  } finally { gate.resolve(); await sweeping?.catch(() => {}); await f.close(); }
});
h.test('startup rollback fences a still-bound writer before awaiting its close RPC', async () => {
  const f = await fixture(), gate = deferred(); f.client.failTitle = true; f.client.holdClose = gate.promise;
  const startup = f.sessions.newSession({ title: 'Cannot persist' }), failed = rejects(startup, /title persistence failed/);
  try {
    await waitFor(() => f.client.calls.some(call => call.method === 'session/close'), 1000, 'startup cleanup RPC');
    const id = String(object(f.client.calls.find(call => call.method === 'session/start')!.params.init).threadId);
    equal(f.state.liveSession(id), 'live-' + id); const stages: Stage[] = [['rolling-back', f.sessions.isSessionClosing(id)]];
    gate.resolve(); await failed; stages.push(['finished', f.sessions.isSessionClosing(id)]); await vector('startup-rollback', stages); equal(f.state.liveSession(id), undefined);
  } finally { gate.resolve(); await failed; await f.close(); }
});
h.test('stale rebuilds and engine loss remain unavailable through the existing binding checks', async () => {
  let closingStale = false;
  const f = await fixture({ onClosing: id => { closingStale = f.state.bindings().find(row => row.rendererId === id)?.stale === true; } });
  try {
    f.state.markStale('one'); await f.sessions.history('one'); equal(closingStale, true);
    equal(f.state.bindings().find(row => row.rendererId === 'one')?.stale, false);
    f.client.closed = true; f.client.emit('event', { type: 'streamClosed' }); equal(f.sessions.engine(), undefined); equal(f.state.liveCount(), 0);
  } finally { await f.close(); }
});
h.test('shutdown closes admission synchronously and retains it after the engine drains', async () => {
  const f = await fixture(), stages: Stage[] = [['before', f.sessions.isSessionClosing('one')]];
  try {
    const stopped = f.sessions.shutdown(); stages.push(['draining', f.sessions.isSessionClosing('one')]);
    await stopped; stages.push(['finished', f.sessions.isSessionClosing('one')]); await vector('shutdown', stages);
  } finally { await f.close(); }
});

h.test('delete succeeds when the engine no longer holds the live session', async () => {
  const f = await fixture();
  try {
    f.client.failCloseUnknown = true;
    const deleted = await f.sessions.deleteSession('one');
    equal(object(deleted)?.ok, true);
    equal(f.state.liveSession('one'), undefined);
    deepEqual(f.client.calls.filter(call => call.method === 'session/close').map(call => call.params.sessionId), ['engine-one']);
    deepEqual(f.client.calls.filter(call => call.method === 'session/deleteSession').map(call => call.params.threadId), ['one']);
  } finally { await f.close(); }
});
h.test('startup rollback drops the binding when the compensating close reports an unknown session', async () => {
  const f = await fixture();
  try {
    f.client.failTitle = true; f.client.failCloseUnknown = true;
    await rejects(f.sessions.newSession({ title: 'doomed' }), /title/i);
    const id = String(object(f.client.calls.find(call => call.method === 'session/start')!.params.init).threadId);
    equal(f.state.liveSession(id), undefined);
    equal(f.state.bindings().some(row => row.rendererId === id), false);
    equal(f.state.liveSession('one'), 'engine-one');
  } finally { await f.close(); }
});

h.test('storage cleanup reserves an idle binding without closing or interrupting it', async () => {
  const f = await fixture();
  try {
    const release = await f.sessions.holdIdleStorageDeletion('one');
    equal(typeof release, 'function'); equal(f.sessions.isSessionClosing('one'), true);
    equal(f.state.liveSession('one'), 'engine-one');
    equal(f.client.calls.some(call => ['session/close', 'turn/interrupt'].includes(call.method)), false);
    equal(await f.sessions.holdIdleStorageDeletion('one'), null);
    release!(); release!(); equal(f.sessions.isSessionClosing('one'), false);
  } finally { await f.close(); }
});
h.test('storage cleanup preserves running turns and the accepted interruption window', async () => {
  const f = await fixture();
  try {
    f.state.markTurnRunning('one', 'turn-one');
    equal(await f.sessions.holdIdleStorageDeletion('one'), null); equal(f.state.isWorking('one'), true);
    f.state.clearTurnRunning('one'); f.state.noteInterruptWindow('one');
    equal(await f.sessions.holdIdleStorageDeletion('one'), null);
    equal(f.client.calls.some(call => ['session/close', 'turn/interrupt'].includes(call.method)), false);
    f.state.clearInterruptWindow('one');
  } finally { f.state.clearTurnRunning('one'); f.state.clearInterruptWindow('one'); await f.close(); }
});
h.test('storage catalog preserves the activity clock and rejects an unavailable source', async () => {
  const f = await fixture();
  const request = f.client.requestWithTimeout.bind(f.client);
  try {
    f.client.requestWithTimeout = (method, value) => method === 'engine/listSessions'
      ? Promise.resolve({ sessions: { items: [{ id: 'one', title: 'Idle', updatedAt: 12345, archived: false }, { id: 'old', title: 'Old', updatedAt: 6789, archived: true }], nextCursor: null } })
      : request(method, value);
    const rows = await f.sessions.storageCatalog();
    equal(object(rows[0]).updatedAt, 12345); equal(object(rows[1]).archived, true);
    f.client.requestWithTimeout = (method, value) => method === 'engine/listSessions' ? Promise.reject(Error('Catalog unavailable')) : request(method, value);
    await rejects(f.sessions.storageCatalog(), /Catalog unavailable/);
  } finally { f.client.requestWithTimeout = request; await f.close(); }
});

h.test('unarchive restores a storage-owned working copy before activating its chat', async () => {
  const order: string[] = [];
  const f = await fixture({ beforeUnarchive: async id => { order.push('restore:' + id); } });
  const request = f.client.requestWithTimeout.bind(f.client);
  f.client.requestWithTimeout = async (method, value) => {
    if (method !== 'session/unarchiveSession') return request(method, value);
    order.push('unarchive');
    f.client.emit('event', { type: 'engineEvent', params: { submissionId: 'storage-unarchive', unarchived: { threadId: object(value).threadId, status: 'restored' } } });
    return { submissionId: 'storage-unarchive' };
  };
  try {
    equal(object(await f.sessions.setArchived('one', false)).ok, true);
    deepEqual(order, ['restore:one', 'unarchive']);
  } finally { await f.close(); }
});
h.test('failed storage restoration preserves the archived chat', async () => {
  const f = await fixture({ beforeUnarchive: async () => { throw Error('Snapshot verification failed'); } });
  try {
    const result = object(await f.sessions.setArchived('one', false));
    equal(result.ok, false); match(String(result.error), /Snapshot verification failed/);
    equal(f.client.calls.some(call => call.method === 'session/unarchiveSession'), false);
  } finally { await f.close(); }
});

h.test('storage cleanup leaves voice-owned conversations bound and uninterrupted', async () => {
  const f = await fixture({ isSessionRetirementProtected: id => id === 'one' });
  try {
    equal(f.sessions.isStorageBusy('one'), true);
    equal(await f.sessions.holdIdleStorageDeletion('one'), null);
    equal(f.state.liveSession('one'), 'engine-one');
    equal(f.client.calls.some(call => ['session/close', 'turn/interrupt'].includes(call.method)), false);
  } finally { await f.close(); }
});

void h.finish(join(__dirname, 'session-closing-results.json'), 'session-closing').then(code => { process.exitCode = code; });
