import { acceptedTurnInput } from './turn-input-fixture';
import { FakeEngineQueue } from './engine-queue-fixture';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/ipc/arguments';
import { HostState } from '../main/services/host-state';
import { applySessionUltraSelection, readSessionFastMode, readSessionModel, readSessionThinkingLevel, readSessionUltraMode, setSessionFastMode, setSessionModel, setSessionThinkingLevel } from '../main/services/session-store';
import { kvSet, withSettingsDb } from '../main/services/settings';
import { WorkspaceStore } from '../main/services/workspaces';
import { ExtensionDiscovery } from '../main/services/extensions/discovery';
import { SessionService, type EngineClientLike, type SessionServiceDeps } from '../main/sessions/service';
import { readSessionTitle } from '../main/services/session-titles';
import { encodeSelectedTextEnvelope } from '../contracts/selected-text-envelope';
import type { RpcRequestOptions } from '../main/engine/request-scheduler';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

process.env.KLAUS_TEST = '1';
const h = new Harness();
const fixtures: Array<{ root: string; service: SessionService }> = [];
class Client extends EventEmitter implements EngineClientLike {
  readonly calls: Array<{ method: string; params: Record<string, Json>; scheduling?: RpcRequestOptions }> = [];
  readonly queue = new FakeEngineQueue();
  closed = false;
  closeFails = false;
  invalidIdentity = false;
  startError?: Error;
  sideEndpointOverride?: string;
  heldStart?: () => Promise<void>;
  heldClose?: () => Promise<void>;
  heldBackground?: () => Promise<void>;
  heldSubscribe?: () => Promise<void>;
  heldPrepare?: () => Promise<void>;
  heldQueueSnapshot?: () => Promise<void>;
  heldTaskList?: () => Promise<void>;
  heldTurnStart?: () => Promise<void>;
  turnStartError?: Error;
  turnStartReply?: unknown;
  generatedTitle?: string;
  configValues: Record<string, Json> = {};
  effectiveConfig: Record<string, Json> = {};
  queueSnapshot: Record<string, Json> = { revision: 0, items: [], status: 'authoritative' };
  contextSnapshot?: () => Promise<unknown>;
  agents: Json[] = [];
  processes: Json[] = [];
  visible: Json[] = [{ id: 'parent', title: 'Parent', archived: false }];
  private nextId = 0;
  constructor() {
    super();
    this.queue.admit = async params => {
      await this.heldTurnStart?.();
      if (this.turnStartError) return { status: 'not-submitted', submissionId: params.submissionId!, reason: { code: 'invalid-input', message: this.turnStartError.message } };
      return this.turnStartReply === undefined ? acceptedTurnInput(params, 'turn') : this.turnStartReply as Json;
    };
  }
  isClosed(): boolean { return this.closed; }
  sent(method: string): Array<Record<string, Json>> { return this.calls.filter(call => call.method === method).map(call => call.params); }
  async requestWithTimeout(method: string, value: Json, _timeoutMs: number, scheduling?: RpcRequestOptions): Promise<unknown> {
    const params = object(value)!; this.calls.push({ method, params, scheduling });
    if (method.startsWith('thread/queue/')) return this.queue.request(method, value);
    if (method === 'engine/listSessions') return { sessions: { items: this.visible, nextCursor: null } };
    if (method === 'engine/readSessionSummary') return { session: this.visible.find(row => object(row)?.id === params.sessionId) ?? null };
    if (method === 'model/selection/resolve') return { source: params.source, selection: ['auto', 'high', 'medium', 'low'].includes(String(params.selection)) ? `${params.source}:fixture` : params.selection };
    if (method === 'session/start' || method === 'session/forkLive' || method === 'session/startSideTask') {
      await this.heldStart?.();
      if (this.startError) throw this.startError;
      const sessionId = method === 'session/startSideTask' ? this.sideEndpointOverride ?? object(params.init)?.threadId : `live-${++this.nextId}`;
      return { sessionId, initialized: { accepted: true,
        threadId: this.invalidIdentity ? 'wrong-thread' : object(params.init)?.threadId,
        ...(method === 'session/startSideTask' ? { role: 'side_task', ephemeral: true, parentThreadId: params.parentThreadId } : {}) } };
    }
    if (method === 'session/prepare') { await this.heldPrepare?.(); return { sessionId: params.sessionId, ready: true }; }
    if (method === 'session/subscribe') { await this.heldSubscribe?.(); return { subscribed: true }; }
    if (method === 'session/queueSnapshot') { await this.heldQueueSnapshot?.(); return { queueSnapshot: this.queueSnapshot }; }
    if (method === 'session/taskList') { await this.heldTaskList?.(); return { tasks: [] }; }
    if (method === 'session/close') { await this.heldClose?.(); if (this.closeFails) throw new Error('Close failed'); return {}; }
    if (method === 'session/contextSnapshot') {
      if (this.contextSnapshot) return this.contextSnapshot();
      throw new Error('Optional statistics unavailable');
    }
    if (method === 'session/subagentLifecycle') return { subagentLifecycle: { agents: this.agents } };
    if (method === 'session/backgroundProcesses') { await this.heldBackground?.(); return { backgroundProcesses: { processes: this.processes } }; }
    if (method === 'session/history') return { history: [], historyTurnIds: {} };
    if (method === 'session/modelRuntime') return { revision: 0 };
    if (method === 'config/read') return { values: this.configValues, resolved: this.effectiveConfig, sources: {} };
    if (method === 'session/reconfigureModel') return { revision: Number(params.expectedRevision) + 1 };
    // Echo a caller-supplied submissionId: a client-supplied id becomes the engine's
    // turn id verbatim, and `startTurn` rejects a reply that names a different one.
    // Cross-conversation delivery always sends a `delegation-` prefixed id, so a
    // fixture that answered with a fixed turn id would fail every delegated turn.
    if (method === 'turn/submit') {
      await this.heldTurnStart?.();
      if (this.turnStartError) throw this.turnStartError;
      return this.turnStartReply === undefined ? acceptedTurnInput(value, 'turn') : this.turnStartReply;
    }
    if (method === 'session/generateTitle' && this.generatedTitle !== undefined) {
      return { generatedTitle: { threadId: 'parent', title: { title: this.generatedTitle, persisted: false } } };
    }
    if (method === 'turn/interrupt') {
      this.emit('event', { type: 'rawSessionEvent', params: { sessionId: params.sessionId, event: { submissionId: 'fixture-interrupt', turnInterrupt: { accepted: true } } } });
      return { submissionId: 'fixture-interrupt' };
    }
    const acknowledge: Record<string, [string, Json]> = {
      'session/updateThreadHostMetadata': ['hostMetadataUpdated', true], 'session/updateTitle': ['title', { threadId: params.threadId!, title: params.title ?? '' }],
      'session/deleteSession': ['deleted', { threadId: params.threadId!, deleted: true }],
      'session/forkSession': ['session', { threadId: params.newThreadId ?? '', status: 'forked' }],
    };
    const ack = acknowledge[method];
    if (ack) { this.emit('event', { type: 'engineEvent', params: { submissionId: 'ack', [ack[0]]: ack[1] } }); return { submissionId: 'ack' }; }
    throw new Error(`Unexpected facade call: ${method}`);
  }
}
function fixture(overrides: Partial<SessionServiceDeps> = {}, root = mkdtempSync(join(tmpdir(), 'klaus-side-tasks-'))) {
  const client = new Client(), state = new HostState();
  let now = 100;
  assert(kvSet('auth_mode', 'custom', root), 'isolated BYO profile');
  const workspace = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const deleted: string[] = [];
  const events: Json[] = [];
  const service = new SessionService({ configRoot: root, state, workspaces: workspace, pushChatEvents: batch => { events.push(...batch); },
    manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => { client.closed = true; } },
    spawnOptions: () => ({ command: '/bin/true', args: [], env: [] }), sideTaskClock: () => now,
    onDeleted: id => { deleted.push(id); }, ...overrides });
  fixtures.push({ root, service });
  return { root, client, state, service, workspace, deleted, events, advance: (ms: number) => { now += ms; } };
}
async function create(service: SessionService): Promise<string> {
  const row = object(await service.createSideTask('parent'))!;
  assertEqual(row.role, 'side_task', 'ephemeral renderer role'); assertEqual(row.parentSessionId, 'parent', 'family owner');
  return String(row.id);
}
h.test('notification pending policy reads actual side-task ownership without activating or changing the family', async () => {
  const f = fixture(); await f.service.resolveLiveSession('parent');
  const id = await create(f.service);
  f.state.markTurnRunning('parent', 'parent-core', 'parent-submission');
  f.state.markTurnRunning(id, 'child-core', 'child-submission');
  const before = f.client.calls.length;
  assert(f.service.hasPendingNotificationWork('parent', 'parent-submission', []), 'ordinary active side task retains ancestor pending policy');
  f.state.clearTurnRunning(id);
  assertEqual(f.service.hasPendingNotificationWork('parent', 'parent-submission', []), false, 'idle registry membership does not invent activity');
  assertEqual(f.client.calls.length, before, 'notification reads issue no facade/provider calls');
  assertEqual((await f.service.listSideTasks('parent')).length, 1, 'notification policy preserved the existing family');
});
h.test('notification pending policy retains actual start identity after a terminal clears working state before its ACK', async () => {
  const f = fixture(), held = deferred<void>();
  f.client.heldTurnStart = () => held.promise;
  f.client.turnStartReply = { status: 'started', submissionId: 'held-own-start', turnId: 'held-own-start' };
  const sending = f.service.send('parent', { text: 'Held start reply' });
  await waitFor(() => f.client.sent('turn/submit').length === 1, 2000, 'ordinary turn reached held ACK');
  const engineId = f.state.liveSession('parent')!;
  f.client.emit('event', { type: 'productEvent', method: 'turn/started', params: { sessionId: engineId, submissionId: 'held-own-start', detail: { turnId: 'held-own-core' } } });
  f.state.clearTurnRunning('parent');
  const before = f.client.calls.length;
  assertEqual(f.service.hasPendingNotificationWork('parent', 'held-own-start', []), false, 'own authoritative facade identity is not other pending work');
  assertEqual(f.service.hasPendingNotificationWork('parent', 'held-own-core', []), false, 'actual core alias remains correlated after success settlement');
  assert(f.service.hasPendingNotificationWork('parent', 'unrelated-turn', []), 'unrelated terminal cannot consume the pending start');
  assertEqual(f.client.calls.length, before, 'classification adds no engine request');
  held.resolve(); await sending;
  assertEqual(f.service.hasPendingNotificationWork('parent', 'unrelated-turn', []), false, 'ACK finally removes the presentation-only alias record');
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function discovery(load: ExtensionDiscovery['sessionExtensions']): ExtensionDiscovery {
  const result = new ExtensionDiscovery({ configRoot: '' });
  result.sessionExtensions = load;
  return result;
}

const preferenceVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/side-task-preference-vectors.json'), 'utf8')) as {
  cases: Array<{ name: string; parent: { mode: string; source: string; thinking: string; fast: boolean; ultraMode?: boolean }; default: { mode: string; source: string; thinking: string; fast: boolean; ultraMode?: boolean }; resolved: string; stored: string }>;
};
const responsiveness = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/side-task-responsiveness-vectors.json'), 'utf8')) as {
  startMethod: string; parentThreadId: string; sourceSessionId: string; contextSnapshot: Json; contextUsage: Json; cleanupPriority: string;
  sideStartup: {
    loaders: string[];
    configSnapshot: { source: string; reads: number; sharedBy: string[] };
    taskListReads: number; subscribed: boolean; queueAuthority: string;
  };
};
const titleVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/side-task-title-vectors.json'), 'utf8')) as {
  defaults: { firstTitle: string; rendererIndexOverride: { min: number; max: number; index: number; expectedTitle: string } };
  acceptance: { eventType: string; queueAdmissionRenames: boolean; manualBeforeFirstReplaced: boolean; manualAfterFirstProtected: boolean; ordinaryTitlePipeline: string };
  boundary_cases: Array<{ id: string; input: string; expected: string | null }>;
  ordinaryRegression: { text: string; expectedSeed: string; generatedTitle: string };
};
async function sideRow(service: SessionService, id: string): Promise<Record<string, Json>> {
  const row = (await service.listSideTasks('parent')).find(value => object(value)?.id === id);
  assert(row, 'side task remains in its parent family');
  return object(row)!;
}
function titleEvents(events: Json[], id: string): Json[] {
  return events.filter(value => object(value)?.type === titleVectors.acceptance.eventType && object(value)?.sessionId === id);
}
async function queuedRows(service: SessionService, id: string): Promise<Json[]> {
  const items = object(object(await service.clientQueueSnapshot(id))?.snapshot)?.items;
  assert(Array.isArray(items), 'queue reply retains its snapshot rows');
  return items;
}

h.test('renderer default indices survive materialization and invalid indices reserve no side task', async () => {
  const { service, client } = fixture(), expected = titleVectors.defaults.rendererIndexOverride;
  for (const invalid of [null, 0, -1, 1.5, '2', true, {}, [], Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assertRejects(() => service.createSideTask('parent', invalid), 'invalid index is rejected before allocation');
    assertDeepEqual(await service.listSideTasks('parent'), [], 'invalid index leaves no reservation');
  }
  assertEqual(client.calls.length, 0, 'invalid index never attaches or reaches the engine');
  const row = object(await service.createSideTask('parent', expected.index))!;
  assertEqual(row.initialTitleIndex, expected.index, 'renderer panel ordinal reaches the active row');
  assertEqual(row.title, expected.expectedTitle, 'active row preserves the pending label');
  const next = object(await service.createSideTask('parent'))!;
  assertEqual(next.initialTitleIndex, 2, 'omitting the override still uses current family count');
  assertEqual(client.sent('session/startSideTask').length, 2, 'valid reservations each use the named side facade');
});

h.test('a direct side send updates its title only after a valid turn acknowledgement', async () => {
  const { service, client, state, events, root } = fixture(), id = await create(service), ack = deferred<void>();
  client.heldTurnStart = () => ack.promise;
  const sending = service.send(id, { text: '# Fix **race**' });
  void sending.catch(() => {});
  try {
    await waitFor(() => client.sent('turn/submit').length === 1, 1000, 'turn admission waits at the engine ACK');
    assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'pending ACK retains the default');
    assertEqual((await sideRow(service, id)).initialTitleIndex, 1, 'pending default stays localizable');
    assertDeepEqual(titleEvents(events, id), [], 'no early title push');
    ack.resolve(); await sending;
    assertEqual((await sideRow(service, id)).title, 'Fix race', 'accepted visible request is normalized');
    assertEqual((await sideRow(service, id)).initialTitleIndex, null, 'accepted text becomes an explicit title');
    assertDeepEqual(titleEvents(events, id), [{ type: titleVectors.acceptance.eventType, sessionId: id, title: 'Fix race' }], 'one authoritative title event is already available when send returns');
    assertEqual(readSessionTitle(id, root), undefined, 'side title never enters ordinary durable title state');
    state.clearTurnRunning(id);
    client.emit('event', { type: 'turnCompleted', params: { sessionId: state.liveSession(id), turnId: 'turn', result: { stopReason: 'completed', finalText: 'Done' } } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assertEqual(client.sent('session/generateTitle').length, 0, 'side completion starts no AI title request');
    assertEqual(client.sent('session/updateTitle').length, 0, 'side naming does not write an ordinary engine title');
  } finally { ack.resolve(); await sending.catch(() => {}); }
});

for (const failure of ['rejected-request', 'missing-turn-id', 'empty-turn-id', 'non-string-turn-id'] as const) {
  h.test(`a side title can retry after ${failure}`, async () => {
    const { service, client, state, events } = fixture(), id = await create(service);
    if (failure === 'rejected-request') client.turnStartError = new Error('Fixture turn rejected');
    else client.turnStartReply = failure === 'missing-turn-id' ? {} : { turnId: failure === 'empty-turn-id' ? '' : 7 };
    await assertRejects(() => service.send(id, { text: 'Rejected candidate' }), 'failed admission rejects the send');
    assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'failure retains the default');
    assertEqual(state.isWorking(id), false, 'failed admission is no longer working');
    assertDeepEqual(titleEvents(events, id), [], 'failure emits no title event');
    client.turnStartError = undefined; client.turnStartReply = undefined;
    await service.send(id, { text: '**Accepted retry**' });
    assertEqual((await sideRow(service, id)).title, 'Accepted retry', 'failed admission did not consume first accepted state');
    assertEqual(titleEvents(events, id).length, 1, 'only the accepted retry updates the title');
  });
}

h.test('a media-only first accepted side turn retains the default through later text', async () => {
  const { service, client, state, events, root } = fixture(), id = await create(service);
  const path = join(root, 'one-pixel.png');
  writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX0AAAAASUVORK5CYII=', 'base64'));
  await service.send(id, { text: '', media: [{ path, name: 'one-pixel.png', mimeType: 'image/png' }] });
  const input = client.sent('turn/submit')[0]!.input;
  assert(Array.isArray(input) && object(input[0])?.type === 'image', 'media-only input reaches the normal attachment pipeline');
  assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'no ordinary image-title fallback');
  state.clearTurnRunning(id); await service.send(id, { text: 'Later text' });
  assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'first accepted media turn consumes the naming opportunity');
  assertDeepEqual(titleEvents(events, id), [], 'empty normalized title never publishes a replacement');
});

h.test('a quote-only accepted side turn never titles itself from the cited passage', async () => {
  const { service, state, events } = fixture(), id = await create(service);
  const quoteOnly = titleVectors.boundary_cases.find(vector => vector.id === 'selected_text_empty_request')!;
  await service.send(id, { text: quoteOnly.input });
  assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'empty request uses no quote fallback');
  state.clearTurnRunning(id); await service.send(id, { text: 'Later human request' });
  assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'accepted quote-only input consumes first accepted state');
  assertDeepEqual(titleEvents(events, id), [], 'quote context publishes no title event');
});

h.test('a first request that literally matches a default label is never mistaken for an uninitialized title', async () => {
  const { service, state, events } = fixture(), id = await create(service);
  const literal = titleVectors.boundary_cases.find(vector => vector.id === 'default_title_literal')!;
  await service.send(id, { text: literal.input });
  state.clearTurnRunning(id); await service.send(id, { text: 'Do not overwrite the first request' });
  assertEqual((await sideRow(service, id)).title, literal.expected, 'default-looking first request remains literal');
  assertEqual((await sideRow(service, id)).initialTitleIndex, null, 'request-derived label loses the default index');
  assertEqual(titleEvents(events, id).length, 1, 'later accepted text publishes no second title');
});

h.test('first acceptance replaces a before-first manual label and later manual renames stay protected', async () => {
  const { service, state, client, events } = fixture(), id = await create(service);
  await service.rename(id, 'Before first turn');
  assertEqual((await sideRow(service, id)).initialTitleIndex, null, 'manual title is initially explicit');
  await service.send(id, { text: '**First accepted request**' });
  assertEqual(titleVectors.acceptance.manualBeforeFirstReplaced, true, 'committed first acceptance rule');
  assertEqual((await sideRow(service, id)).title, 'First accepted request', 'first accepted content determines its tab label');
  await service.rename(id, 'Side task');
  state.clearTurnRunning(id); await service.send(id, { text: 'Later request' });
  assertEqual(titleVectors.acceptance.manualAfterFirstProtected, true, 'committed later manual naming rule');
  assertEqual((await sideRow(service, id)).title, 'Side task', 'later default-looking manual label remains explicit');
  assertEqual(titleEvents(events, id).length, 1, 'later turn does not publish an automatic replacement');
  assertEqual(client.sent('session/updateTitle').length, 0, 'side manual rename stays in the side registry');
});

h.test('side titles prefer visible display metadata and fall back to the validated selected-text request', async () => {
  for (const withMetadata of [true, false]) {
    const { service, client } = fixture(), id = await create(service);
    const wire = encodeSelectedTextEnvelope('Explain **the request**', [{ text: 'Unrelated quoted passage', requestOffset: 7 }]);
    const payload: Record<string, Json> = { text: wire, ...(withMetadata ? { displayMetadata: { displayText: '# Visible **composer request**' } } : {}) };
    await service.send(id, payload);
    assertEqual(client.sent('turn/submit')[0]!.input, wire, 'model-visible envelope is preserved');
    assertEqual((await sideRow(service, id)).title, withMetadata ? 'Visible composer request' : 'Explain the request', 'title uses human-visible request rather than envelope headings or passage');
  }
});

h.test('explicit empty display text never falls back to a nonempty model context', async () => {
  const { service, state, events } = fixture(), id = await create(service);
  await service.send(id, { text: 'Model context that is not the visible request', displayMetadata: { displayText: '' } });
  state.clearTurnRunning(id); await service.send(id, { text: 'Second visible request' });
  assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'empty visible request consumes first accepted state without fallback');
  assertDeepEqual(titleEvents(events, id), [], 'no model-context title is published');
});

for (const name of ['unicode_title_over_120_codepoints', 'ascii_title_over_4096_bytes', 'unicode_title_over_4096_bytes']) {
  h.test(`accepted side labels retain ${name}`, async () => {
    const { service, events } = fixture(), id = await create(service), vector = titleVectors.boundary_cases.find(candidate => candidate.id === name)!;
    await service.send(id, { text: vector.input });
    assertEqual((await sideRow(service, id)).title, vector.expected, 'automatic labels retain the full normalized request');
    assertEqual(object(titleEvents(events, id)[0])?.title, vector.expected, 'authoritative title event carries the full request too');
  });
}

for (const mode of ['automatic-resume', 'deliver-now'] as const) {
  h.test(`queued first side input is named only after ${mode} dispatch accepts it`, async () => {
    const { service, client, events } = fixture(), id = await create(service), ack = deferred<void>();
    const visible = '# Visible **queued request**', finalText = 'Model-only context that must not become the tab title';
    client.heldTurnStart = () => ack.promise;
    const added = object(await service.clientQueueAdd(id, { id: 'first-queued', item: { text: 'Raw fallback', finalText, displayText: visible, media: [] } }))!;
    assertEqual(added.ok, true, 'queue admission succeeds');
    assertEqual(titleVectors.acceptance.queueAdmissionRenames, false, 'committed queue timing');
    assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'queue admission retains default');
    assertDeepEqual(titleEvents(events, id), [], 'queue admission publishes no title update');
    assertEqual(client.sent('thread/queue/start').length, 0, 'queue admission starts no turn');
    const delivering = mode === 'deliver-now' ? service.clientQueueDeliver(id, 'first-queued') : undefined;
    if (mode === 'automatic-resume') assertEqual(object(await service.clientQueueResume(id))?.ok, true, 'automatic queue resume is accepted');
    try {
      await waitFor(() => client.sent('thread/queue/start').length === 1, 1000, 'dispatch reaches atomic queue admission');
      assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'pending dispatch ACK retains default');
      assertDeepEqual(titleEvents(events, id), [], 'no title update before queued ACK');
      ack.resolve(); if (delivering) assertEqual(object(await delivering)?.ok, true, 'manual dispatch receives an accepted result');
      await waitFor(() => titleEvents(events, id).length === 1, 1000, 'accepted queued input publishes one title update');
      assertEqual((await sideRow(service, id)).title, 'Visible queued request', 'both dispatch entries retain the queued displayText');
      assertDeepEqual(client.queue.admissions[0]!.row.input, [{ type: 'text', text: finalText }], 'stored native model-visible context remains intact');
      await waitFor(async () => (await queuedRows(service, id)).length === 0, 1000, 'accepted queue row is consumed');
    } finally { ack.resolve(); await delivering?.catch(() => {}); }
  });
  h.test(`failed ${mode} side dispatch keeps the default and a retry can name the first turn`, async () => {
    const { service, client, events } = fixture(), id = await create(service);
    client.turnStartError = Object.assign(new Error('Fixture queued dispatch rejected'), { kind: 'server', code: -32000 });
    await service.clientQueueAdd(id, { id: 'retry-queued', item: { text: 'Raw context', finalText: 'Raw context', displayText: '**Accepted queued retry**', media: [] } });
    if (mode === 'deliver-now') assertEqual(object(await service.clientQueueDeliver(id, 'retry-queued'))?.ok, false, 'manual rejected dispatch is retryable');
    else {
      await service.clientQueueResume(id);
      await waitFor(async () => typeof object((await queuedRows(service, id))[0])?.pausedReason === 'string', 1000, 'automatic rejected dispatch restores a paused row');
    }
    assertEqual((await sideRow(service, id)).title, titleVectors.defaults.firstTitle, 'failed queued send retains default');
    assertDeepEqual(titleEvents(events, id), [], 'failed queued send emits no title update');
    client.turnStartError = undefined;
    assertEqual(object(await service.clientQueueDeliver(id, 'retry-queued'))?.ok, true, 'explicit retry is accepted');
    assertEqual((await sideRow(service, id)).title, 'Accepted queued retry', 'first failed attempt did not consume naming state');
    assertEqual(titleEvents(events, id).length, 1, 'only the successful retry publishes a title');
  });
}

h.test('ordinary first-content fallback and one AI title generation remain independent of side labels', async () => {
  const { service, client, state, events, root } = fixture(), expected = titleVectors.ordinaryRegression;
  client.visible = [{ id: 'parent', title: 'New Chat', archived: false }]; client.generatedTitle = expected.generatedTitle;
  const id = await create(service);
  await service.send(id, { text: '# Side **request**' });
  state.clearTurnRunning(id);
  client.emit('event', { type: 'turnCompleted', params: { sessionId: state.liveSession(id), turnId: 'turn', result: { stopReason: 'completed' } } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assertEqual(client.sent('session/generateTitle').length, 0, 'side completion uses no ordinary title inference');
  await service.send('parent', { text: expected.text });
  await waitFor(() => readSessionTitle('parent', root)?.source === 'seed', 1000, 'ordinary accepted content still seeds the title');
  assertEqual(titleVectors.acceptance.ordinaryTitlePipeline, 'seed-then-first-turn-generation', 'ordinary pipeline contract');
  assertEqual(readSessionTitle('parent', root)?.title, expected.expectedSeed, 'ordinary sixty-codepoint fallback still retains its existing raw formatting');
  client.emit('event', { type: 'productEvent', method: 'turn/started', params: { sessionId: state.liveSession('parent'), turnId: 'turn' } });
  await waitFor(() => readSessionTitle('parent', root)?.source === 'ai', 1000, 'the first turn generates the ordinary title');
  state.clearTurnRunning('parent');
  const terminal = { type: 'turnCompleted', params: { sessionId: state.liveSession('parent'), turnId: 'turn', result: { stopReason: 'completed', finalText: 'Done' } } };
  client.emit('event', terminal);
  await waitFor(() => readSessionTitle('parent', root)?.source === 'ai', 1000, 'ordinary generated title is acknowledged and persisted');
  client.emit('event', terminal); await new Promise<void>(resolve => setImmediate(resolve));
  assertEqual(client.sent('session/generateTitle').length, 1, 'ordinary AI title is generated once');
  assertEqual(readSessionTitle('parent', root)?.title, expected.generatedTitle, 'ordinary AI result remains authoritative');
  assertEqual(readSessionTitle(id, root), undefined, 'side title remains outside ordinary durable state');
  assertEqual((await sideRow(service, id)).title, 'Side request', 'ordinary inference does not rewrite the side tab');
  assertDeepEqual(titleEvents(events, 'parent').map(value => object(value)?.title), [expected.expectedSeed, expected.generatedTitle], 'ordinary fallback and AI title publish in the existing order');
});

for (const vector of preferenceVectors.cases) h.test(`side task inherits preferences: ${vector.name}`, async () => {
  const { root, service, client } = fixture();
  const select = (id: string, preferences: typeof vector.parent) => {
    setSessionModel(id, preferences.mode, preferences.source, root);
    setSessionThinkingLevel(id, preferences.thinking, root);
    setSessionFastMode(id, preferences.fast, root);
    applySessionUltraSelection(id, preferences.ultraMode ?? false, root);
  };
  select('parent', vector.parent);
  select('another-conversation', vector.default);
  const id = await create(service);
  const init = object(client.sent('session/startSideTask')[0]?.init)!;
  const resolution = client.sent('model/selection/resolve')[0]!;
  assertEqual(resolution.source, vector.parent.source, 'parent source copied before startup');
  assertEqual(resolution.selection, vector.parent.mode, 'parent selection copied before startup');
  assertDeepEqual(readSessionModel(id, root), { mode: vector.stored, source: vector.parent.source }, 'side preference retains resolved tier or original selection');
  assertEqual(readSessionThinkingLevel(id, root), vector.parent.thinking, 'parent reasoning copied');
  assertEqual(readSessionFastMode(id, root), vector.parent.fast, 'parent Fast mode copied');
  assertEqual(readSessionUltraMode(id, root), vector.parent.ultraMode ?? false, 'parent orchestration mode copied independently');
  assertEqual(init.modelSelection, vector.resolved, 'actual engine model follows parent');
  assertEqual(object(init.config)?.effort, vector.parent.thinking, 'actual engine reasoning follows parent');
  assertEqual(object(init.config)?.ultraMode, vector.parent.ultraMode ?? false, 'actual engine orchestration follows parent');
  if (vector.parent.source === 'codex') assertEqual(object(init.config)?.fastMode, vector.parent.fast, 'actual Codex Fast mode follows parent');
  assertDeepEqual(readSessionModel('', root), { mode: vector.default.mode, source: vector.default.source }, 'inheritance does not overwrite future defaults');
  assertEqual(readSessionThinkingLevel('', root), vector.default.thinking, 'reasoning default preserved');
  assertEqual(readSessionFastMode('', root), vector.default.fast, 'Fast mode default preserved');
  assertEqual(readSessionUltraMode('', root), vector.default.ultraMode ?? false, 'orchestration default preserved');
  select(id, vector.default);
  assertDeepEqual(readSessionModel('parent', root), { mode: vector.parent.mode, source: vector.parent.source }, 'side task changes leave parent independent');
  assertEqual(readSessionUltraMode('parent', root), vector.parent.ultraMode ?? false, 'side orchestration changes leave parent independent');
  const sibling = await create(service);
  assertDeepEqual(readSessionModel(sibling, root), { mode: vector.stored, source: vector.parent.source }, 'new sibling still inherits parent');
  assertEqual(readSessionUltraMode(sibling, root), vector.parent.ultraMode ?? false, 'new sibling still inherits parent orchestration');
});

h.test('ephemeral admission inherits workspace, stays out of history, and closes without deleting files', async () => {
  const { root, service, client, workspace, state } = fixture();
  const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'user.txt'), 'preserve');
  workspace.save({ id: 'group', name: 'Group', roots: [project, join(root, 'second')] });
  workspace.bindSession('parent', { workspaceId: 'group' });
  const id = await create(service);
  const init = object(client.sent('session/startSideTask')[0]?.init)!;
  assertEqual(init.cwd, project, 'parent workspace inherited before activation');
  assertEqual(workspace.workspaceId(id), 'group', 'workspace membership inherited');
  assertEqual(client.sent('session/createSideTask').length, 0, 'atomic side-task start needs no second role conversion');
  assertEqual(client.sent('session/start').length, 0, 'no ordinary endpoint is started for a side task');
  assertEqual(client.sent('session/startSideTask')[0]?.parentThreadId, 'parent', 'named facade owns the parent context');
  assert(client.calls.findIndex(call => call.method === 'session/startSideTask') < client.calls.findIndex(call => call.method === 'session/subscribe'), 'side role established before subscription');
  assertEqual(client.sent('session/taskList').length, responsiveness.sideStartup.taskListReads, 'materialized side startup follows the committed task-list contract');
  client.visible.push({ id, title: 'Not a sidebar thread' });
  assert(!(await service.listSessions()).some(row => object(row)?.id === id), 'ephemeral role never leaks through stored list');
  assert(!(await service.catalogPage()).rows.some(row => object(row)?.id === id), 'ephemeral role never leaks through a catalog page');
  assertEqual(service.isCatalogVisible(id), false, 'cached catalogs also exclude ephemeral identities');
  assertEqual(await service.catalogRow(id), null, 'targeted catalog lookup cannot expose a side task');
  setSessionModel(id, 'custom:temporary', 'custom', root);
  assertDeepEqual(await service.closeSideTask(id), { ok: true }, 'close acknowledged');
  assertEqual(state.liveSession(id), undefined, 'live binding drained');
  assertEqual(workspace.workspaceId(id), undefined, 'ephemeral work context removed');
  assertEqual(withSettingsDb(root, db => db.prepare('SELECT session_id FROM session_main_models WHERE session_id=?').get(id)), undefined, 'ephemeral model choice removed');
  assertDeepEqual(client.sent('session/deleteSession').map(params => params.threadId), [id], 'closing a side conversation deletes its persisted thread');
  assertEqual(readFileSync(join(project, 'user.txt'), 'utf8'), 'preserve', 'workspace user files untouched');
  await assertRejects(() => service.resolveLiveSession(id), 'closed ephemeral identity cannot resume');
  await assertRejects(() => service.pendingQuestions(id), 'closed ephemeral questions cannot reopen the side context');
  await assertRejects(() => service.closeSideTask('parent'), 'close refuses ordinary conversation');
});

h.test('side initialization starts independent loaders together and preserves every declaration', async () => {
  const names = ['tools', 'extensions', 'styles', 'capabilities'] as const;
  const gates = Object.fromEntries(names.map(name => [name, deferred<void>()])) as Record<typeof names[number], ReturnType<typeof deferred<void>>>;
  const entered: string[] = [], snapshots: Array<{ loader: string; values: Record<string, Json> | undefined }> = [];
  let project = '', extraRoot = '', capabilityOwner = '';
  const tools: Json[] = [{ name: 'fixture-tool', description: 'Preserved tool', inputSchema: { type: 'object' } }];
  const additions = { agents: [{ name: 'fixture-agent', prompt: 'Preserved agent' }], skills: [{ name: 'fixture-skill', body: 'Preserved skill' }], commandHooks: [{ event: 'Stop', command: 'true' }] };
  const styles = { outputStyles: [{ name: 'fixture-style', body: 'Preserved style' }], selectedOutputStyle: 'fixture-style' };
  const capabilities = { mcpServers: [{ name: 'fixture-server', transport: 'stdio', command: '/bin/true' }], runtimeCapabilityRoots: [{ id: 'fixture-root', enabled: true }] };
  const { root, service, client, workspace, state } = fixture({
    dynamicTools: async values => { entered.push('dynamicTools'); snapshots.push({ loader: 'dynamicTools', values }); await gates.tools.promise; return tools; },
    extensions: discovery(async (cwd, roots) => {
      entered.push('extensions'); assertEqual(cwd, project, 'extensions use the parent project');
      assertDeepEqual(roots, [extraRoot], 'extensions retain extra workspace roots');
      await gates.extensions.promise; return additions;
    }),
    sessionStyles: async (cwd, roots, values) => {
      entered.push('sessionStyles'); snapshots.push({ loader: 'sessionStyles', values }); assertEqual(cwd, project, 'styles use the parent project');
      assertDeepEqual(roots, [extraRoot], 'styles retain extra workspace roots');
      await gates.styles.promise; return styles;
    },
    hostCapabilities: async (owner, cwd, values) => {
      entered.push('hostCapabilities'); snapshots.push({ loader: 'hostCapabilities', values }); capabilityOwner = owner;
      assertEqual(cwd, project, 'capabilities use the parent project');
      await gates.capabilities.promise; return capabilities;
    },
  });
  project = join(root, 'project'); extraRoot = join(root, 'second'); mkdirSync(project); mkdirSync(extraRoot);
  workspace.save({ id: 'group', name: 'Group', roots: [project, extraRoot] });
  workspace.bindSession('parent', { workspaceId: 'group' });
  const raw = { desktop: { webSearch: { source: 'codex' } }, outputStyle: 'fixture-style', mcpServers: { fixture: { command: '/bin/true' } } };
  client.configValues = raw; client.effectiveConfig = { maxRetries: 7 };
  let remembered: Json = null;
  const remember = state.rememberSession.bind(state);
  state.rememberSession = (id, engineId, init, provider) => { remembered = structuredClone(init); remember(id, engineId, init, provider); };
  const starting = create(service); void starting.catch(() => {});
  try {
    await waitFor(() => entered.length === responsiveness.sideStartup.loaders.length, 1000, 'all committed independent loaders entered before any release');
    assertDeepEqual([...entered].sort(), [...responsiveness.sideStartup.loaders].sort(), 'each committed loader entered once');
    assertEqual(client.sent(responsiveness.startMethod).length, 0, 'the named facade starts only after all declarations are loaded');
    gates.capabilities.resolve(); gates.styles.resolve(); gates.extensions.resolve(); gates.tools.resolve();
    const id = await starting, init = object(client.sent(responsiveness.startMethod)[0]?.init)!;
    assertEqual(capabilityOwner, id, 'capabilities are scoped to the actual side identity');
    assertEqual(init.cwd, project, 'session cwd remains the parent project');
    assert((object(object(init.config)?.sandbox_workspace_write)?.writable_roots as Json[]).includes(extraRoot), 'session sandbox preserves additional workspace roots');
    assertEqual(object(init.config)?.maxRetries, 7, 'effective engine configuration remains applied');
    assertDeepEqual(init.dynamicTools, tools, 'dynamic tool declarations preserved');
    for (const key of ['agents', 'skills', 'commandHooks'] as const) assertDeepEqual(init[key], additions[key], `${key} declarations preserved`);
    assertDeepEqual(init.outputStyles, styles.outputStyles, 'output style bodies preserved');
    assertEqual(init.selectedOutputStyle, styles.selectedOutputStyle, 'selected style preserved');
    assertDeepEqual(init.hostCapabilities, capabilities, 'MCP servers and runtime roots preserved');
    assertDeepEqual(object(remembered)?.hostCapabilities, capabilities, 'active binding retains the initialized capabilities');
    assertDeepEqual(snapshots, responsiveness.sideStartup.configSnapshot.sharedBy.map(loader => ({ loader, values: raw })), `declaration loaders preserve ${responsiveness.sideStartup.configSnapshot.source}`);
    assertEqual(snapshots.every(snapshot => snapshot.values === raw) ? 'config/read.values' : 'different profile', responsiveness.sideStartup.configSnapshot.source, 'declaration loaders reuse the exact committed raw configuration snapshot');
    assertEqual(client.sent('config/read').length, responsiveness.sideStartup.configSnapshot.reads, 'side startup follows the committed configuration read budget');
    assertDeepEqual(client.sent('config/read'), [{ cwd: project }], 'side startup reads the effective parent project profile');
  } finally {
    for (const gate of Object.values(gates)) gate.resolve();
    await starting.catch(() => {});
  }
});

h.test('failed side initialization waits for every loader before cleaning late capability routes', async () => {
  const names = ['tools', 'extensions', 'styles', 'capabilities'] as const;
  const gates = Object.fromEntries(names.map(name => [name, deferred<void>()])) as Record<typeof names[number], ReturnType<typeof deferred<void>>>;
  const entered: string[] = [], lifecycle: string[] = [], routes = new Set<string>(), deleted: string[] = [];
  let sideId = '';
  const { service, client, state } = fixture({
    dynamicTools: async () => { entered.push('tools'); await gates.tools.promise; return []; },
    extensions: discovery(async () => { entered.push('extensions'); await gates.extensions.promise; return {}; }),
    sessionStyles: async () => { entered.push('styles'); await gates.styles.promise; return {}; },
    hostCapabilities: async id => {
      sideId = id; entered.push('capabilities'); await gates.capabilities.promise;
      routes.add(id); lifecycle.push('capabilities allocated'); return { mcpServers: [], runtimeCapabilityRoots: [] };
    },
    onDeleted: id => { deleted.push(id); routes.delete(id); lifecycle.push('cleanup'); },
  });
  const starting = create(service); void starting.catch(() => {});
  let settled = false; void starting.then(() => { settled = true; }, () => { settled = true; });
  try {
    await waitFor(() => entered.length === 4, 1000, 'failure fixture starts every loader');
    gates.styles.reject(new Error('Fixture style load failed'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assertEqual(settled, false, 'one failure does not settle startup while other loaders remain live');
    assertDeepEqual(deleted, [], 'rollback cannot run before the remaining loaders settle');
    gates.tools.resolve(); gates.extensions.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assertDeepEqual(deleted, [], 'pending capability allocation still owns the cleanup boundary');
    gates.capabilities.resolve();
    await assertRejects(() => starting, 'the failed declaration rejects side creation');
    assert(sideId.length > 0 && deleted.includes(sideId), 'failed side ownership was cleaned');
    assert(lifecycle.indexOf('capabilities allocated') < lifecycle.indexOf('cleanup'), 'late capability routes exist before cleanup runs');
    assertEqual(routes.size, 0, 'no capability route can survive the failed creation');
    assertEqual(client.sent('session/startSideTask').length, 0, 'no partial declaration set reached the engine');
    assertEqual(state.liveSession(sideId), undefined, 'failed initialization has no active binding');
    assertDeepEqual(await service.listSideTasks('parent'), [], 'failed reservation releases its slot after cleanup');
  } finally {
    for (const gate of Object.values(gates)) gate.resolve();
    await starting.catch(() => {});
  }
});

h.test('a synchronous side loader failure still settles delayed capability allocation before cleanup', async () => {
  const capabilities = deferred<void>();
  const entered: string[] = [], lifecycle: string[] = [], routes = new Set<string>(), deleted: string[] = [];
  const failure = new Error('Fixture synchronous tool load failed');
  let sideId = '';
  const { service, client, state } = fixture({
    dynamicTools: () => { entered.push('dynamicTools'); throw failure; },
    extensions: discovery(async () => { entered.push('extensions'); return {}; }),
    sessionStyles: async () => { entered.push('sessionStyles'); return {}; },
    hostCapabilities: async id => {
      sideId = id; entered.push('hostCapabilities'); await capabilities.promise;
      routes.add(id); lifecycle.push('capabilities allocated'); return { mcpServers: [], runtimeCapabilityRoots: [] };
    },
    onDeleted: id => { deleted.push(id); routes.delete(id); lifecycle.push('cleanup'); },
  });
  const starting = create(service); void starting.catch(() => {});
  let settled = false; void starting.then(() => { settled = true; }, () => { settled = true; });
  try {
    await waitFor(() => entered.length === responsiveness.sideStartup.loaders.length, 1000, 'every committed loader starts despite a synchronous failure');
    assertDeepEqual([...entered].sort(), [...responsiveness.sideStartup.loaders].sort(), 'a synchronous throw cannot skip another committed loader');
    await new Promise<void>(resolve => setImmediate(resolve));
    assertEqual(settled, false, 'startup waits for the delayed capability loader after a synchronous failure');
    assertDeepEqual(deleted, [], 'rollback has not run before the capability allocation settles');
    capabilities.resolve();
    const error = await assertRejects(() => starting, 'the synchronous declaration failure rejects side creation');
    assert(error instanceof AggregateError, 'the settled loader failure remains an initialization aggregate');
    assertEqual(error.errors.length, 1, 'the aggregate contains the failed loader');
    assertEqual(error.errors[0], failure, 'the original synchronous failure is retained');
    assert(sideId.length > 0 && deleted.includes(sideId), 'the failed side reservation was cleaned');
    assert(lifecycle.indexOf('capabilities allocated') < lifecycle.indexOf('cleanup'), 'cleanup follows the delayed capability allocation');
    assertEqual(routes.size, 0, 'no delayed capability route survives rollback');
    assertEqual(client.sent('session/startSideTask').length, 0, 'failed declarations cannot start an engine endpoint');
    assertEqual(state.liveSession(sideId), undefined, 'synchronous failure leaves no live binding');
    assertDeepEqual(await service.listSideTasks('parent'), [], 'cleanup releases the failed side reservation');
  } finally {
    capabilities.resolve(); await starting.catch(() => {});
  }
});

h.test('materialized side startup skips task-list work but waits for subscription and the authoritative queue', async () => {
  const { service, client, state } = fixture();
  const subscription = deferred<void>(), queue = deferred<void>(), tasks = deferred<void>();
  client.heldSubscribe = () => subscription.promise; client.heldQueueSnapshot = () => queue.promise;
  client.heldTaskList = () => tasks.promise; client.queueSnapshot = { revision: 7, items: [], status: 'authoritative' };
  const starting = create(service); void starting.catch(() => {});
  let settled = false; void starting.then(() => { settled = true; }, () => { settled = true; });
  try {
    await waitFor(() => client.sent('session/subscribe').length === 1, 1000, 'side subscription entered');
    assertEqual(client.sent('session/subscribe').length, responsiveness.sideStartup.subscribed ? 1 : 0, 'side startup keeps the committed event subscription');
    assertEqual(settled, false, 'side metadata is not returned before event subscription');
    assertEqual(client.sent('session/queueSnapshot').length, 0, 'queue capture follows subscription');
    subscription.resolve();
    await waitFor(() => client.sent('session/queueSnapshot').length === 1, 1000, 'side authoritative queue entered without releasing task-list work');
    assertEqual(client.sent('session/taskList').length, responsiveness.sideStartup.taskListReads, 'a materialized side follows the committed task-list budget');
    assertEqual(settled, false, 'side metadata still waits for the actual queue receipt');
    queue.resolve(); const id = await starting;
    assertEqual(state.queueSnapshot(id)?.revision, 7, 'the actual engine queue revision is installed before returning');
    assertEqual(state.queueSnapshot(id)?.status, responsiveness.sideStartup.queueAuthority, 'side startup installs the committed authoritative queue');
    assertEqual(state.liveSession(id), id, 'the usable side identity remains bound');
  } finally {
    subscription.resolve(); queue.resolve(); tasks.resolve(); await starting.catch(() => {});
  }
});

h.test('ordinary creation keeps serial declarations and waits for core readiness', async () => {
  const names = ['tools', 'extensions', 'styles', 'capabilities'] as const;
  const gates = Object.fromEntries(names.map(name => [name, deferred<void>()])) as Record<typeof names[number], ReturnType<typeof deferred<void>>>;
  const entered: string[] = [], snapshots: Array<Record<string, Json> | undefined> = [];
  const { service, client } = fixture({
    dynamicTools: async values => { entered.push('tools'); snapshots.push(values); await gates.tools.promise; return []; },
    extensions: discovery(async () => { entered.push('extensions'); await gates.extensions.promise; return {}; }),
    sessionStyles: async (_cwd, _roots, values) => { entered.push('styles'); snapshots.push(values); await gates.styles.promise; return {}; },
    hostCapabilities: async (_id, _cwd, values) => { entered.push('capabilities'); snapshots.push(values); await gates.capabilities.promise; return { mcpServers: [], runtimeCapabilityRoots: [] }; },
  });
  const raw = { outputStyle: 'ordinary-fixture' }; client.configValues = raw;
  const prepared = deferred<void>(); client.heldPrepare = () => prepared.promise;
  const starting = service.newSession(); void starting.catch(() => {});
  let settled = false; void starting.then(() => { settled = true; }, () => { settled = true; });
  try {
    for (const [index, name] of names.entries()) {
      await waitFor(() => entered.length === index + 1, 1000, `ordinary ${name} loader entered`);
      assertDeepEqual(entered, names.slice(0, index + 1), 'ordinary declarations remain serial');
      assertEqual(client.sent('session/start').length, 0, 'ordinary engine startup waits for declarations');
      gates[name].resolve();
    }
    await waitFor(() => client.sent('session/prepare').length === 1, 1000, 'ordinary preparation entered');
    assertEqual(client.sent('session/startSideTask').length, 0, 'ordinary creation keeps its named start facade');
    assertEqual(client.sent('session/subscribe').length, 0, 'subscription waits for core readiness');
    assertEqual(client.sent('session/taskList').length, 0, 'task data does not trigger preparation');
    assertEqual(client.sent('session/queueSnapshot').length, 0, 'ordinary queue capture follows core readiness');
    assertEqual(settled, false, 'ordinary startup waits for readiness');
    assertDeepEqual(snapshots, [undefined, raw, raw], 'ordinary dynamic tools keep fresh configuration reads while styles and capabilities share the profile');
    prepared.resolve(); await starting;
    assertEqual(client.sent('session/subscribe').length, 1, 'ready endpoint subscribes once');
    assertEqual(client.sent('session/queueSnapshot').length, 1, 'ordinary startup still installs the queue snapshot');
  } finally {
    for (const gate of Object.values(gates)) gate.resolve();
    prepared.resolve(); await starting.catch(() => {});
  }
});

h.test('a peer conversation cannot deliver into a side task', async () => {
  // A side task is host plumbing owned by a parent conversation, so it is kept out of
  // `list_threads` and out of the catalog. That is not enough on its own:
  // `threadRow` still returns its row and `assertPublicThread` only covers private
  // diagnostic threads, so without an explicit refusal at the delivery choke point a
  // peer that learned the id could start a turn inside it — spending the parent's
  // resources on work the parent never asked for, in a target that can expire
  // mid-turn. `deliverDelegation` is the only place one conversation starts a turn in
  // another, which is why the guard lives there.
  const { service, client, state } = fixture();
  const id = await create(service);
  assert(service.isSideTask(id), 'the fixture produced a real side task');
  const startedBefore = client.sent('turn/submit').length;

  const result = await service.deliverDelegation(id, {
    text: '<klaus-delegation>\n  <source-thread-id>thread-a</source-thread-id>\n  <input>Do this too.</input>\n</klaus-delegation>',
    displayText: 'Do this too.',
  });
  assertEqual(result.ok, false, 'delivery into a side task is refused');
  assert(/not found/i.test(String((result as { error: string }).error)), 'reported as an unknown target, not as a special case');
  assertEqual(client.sent('turn/submit').length, startedBefore, 'no turn was started inside the side task');
  assertEqual(client.sent('turn/submit').length, 0, 'and nothing was steered into it either');
  assertEqual(state.isWorking(id), false, 'the side task was never set running');

  // An ordinary conversation stays reachable, so the guard is scoped rather than a
  // blanket refusal of everything the host does not title.
  const ordinary = await service.deliverDelegation('parent', { text: 'x', displayText: 'x' });
  assertEqual(ordinary.ok, true, 'an ordinary conversation still accepts delivery');
});

h.test('more than eight concurrent reservations remain independent and failed cleanup stays retryable', async () => {
  const { service, client } = fixture();
  let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); client.heldStart = () => ready;
  const outcomes = Promise.allSettled(Array.from({ length: 12 }, (_, index) => service.createSideTask('parent', index + 1)));
  await waitFor(() => client.sent('session/startSideTask').length === 1, 1000, 'one serialized startup entered');
  release(); const results = await outcomes;
  assertEqual(results.filter(result => result.status === 'fulfilled').length, 12, 'all requested tabs can start');
  assertEqual(client.sent('session/startSideTask').length, 12, 'each tab owns an engine resource');
  const id = String(object((results[0] as PromiseFulfilledResult<Json>).value)?.id);
  client.closeFails = true;
  await assertRejects(() => service.closeSideTask(id), 'failed drain surfaces error');
  const failed = (await service.listSideTasks('parent')).find(row => object(row)?.id === id);
  assertEqual(object(failed)?.sideTaskStatus, 'failed', 'failed resource remains visible for cleanup');
  await create(service);
  client.closeFails = false; await service.closeSideTask(id);
  assertEqual((await service.listSideTasks('parent')).length, 12, 'successful close removes only its own tab');
});

h.test('invalid startup identity does not lose an unclosed endpoint or leak an unusable reservation', async () => {
  const { service, client, state } = fixture(); client.invalidIdentity = true; client.closeFails = true;
  await assertRejects(() => service.createSideTask('parent'), 'startup and cleanup failure');
  const retained = object((await service.listSideTasks('parent'))[0])!, id = String(retained.id);
  assertEqual(retained.sideTaskStatus, 'failed', 'failed startup is inspectable');
  assertEqual(state.liveSession(id), id, 'partially started endpoint remains owned');
  await assertRejects(() => service.resolveLiveSession(id), 'failed side task cannot infer');
  client.closeFails = false; await service.closeSideTask(id);
  await assertRejects(() => service.createSideTask('parent'), 'identity-only failure');
  assertDeepEqual(await service.listSideTasks('parent'), [], 'successful rollback frees failed reservation');
  client.invalidIdentity = false; await create(service);
});

h.test('a timed-out atomic start retains its endpoint and reservation until cleanup succeeds', async () => {
  const { service, client, state } = fixture();
  client.startError = new Error('RPC request timed out'); client.closeFails = true;
  await assertRejects(() => service.createSideTask('parent'), 'timeout with an undrained endpoint is visible');
  const requestedId = String(object(client.sent('session/startSideTask')[0]?.init)?.threadId);
  const retained = object((await service.listSideTasks('parent'))[0])!;
  assertEqual(retained.id, requestedId, 'the preallocated identity owns the failed reservation');
  assertEqual(retained.sideTaskStatus, 'failed', 'cleanup remains retryable');
  assertEqual(state.liveSession(requestedId), requestedId, 'a missing startup reply cannot abandon the reserved endpoint');
  assertEqual(client.sent('session/close')[0]?.sessionId, requestedId, 'rollback targets the identity reserved by the facade');
  await assertRejects(() => service.resolveLiveSession(requestedId), 'inference cannot use an uncertain startup');
  client.closeFails = false; await service.closeSideTask(requestedId);
  assertDeepEqual(await service.listSideTasks('parent'), [], 'only an acknowledged close releases the reservation');
  assertEqual(state.liveSession(requestedId), undefined, 'the uncertain endpoint binding was drained');
  client.startError = undefined; await create(service);
});

h.test('a timed-out start does not release its slot while its close acknowledgement is pending', async () => {
  const { service, client } = fixture();
  let release!: () => void; const closed = new Promise<void>(resolve => { release = resolve; });
  client.startError = new Error('RPC request timed out'); client.heldClose = () => closed;
  const pending = service.createSideTask('parent'); const rejected = assertRejects(() => pending, 'startup timeout survives cleanup');
  await waitFor(() => client.sent('session/close').length === 1, 1000, 'the reserved endpoint enters cleanup');
  const requestedId = String(object(client.sent('session/startSideTask')[0]?.init)?.threadId);
  assert(service.isSideTask(requestedId), 'cleanup keeps the starting reservation');
  release(); await rejected;
  assertEqual(service.isSideTask(requestedId), false, 'the close acknowledgement releases the reservation');
  assertDeepEqual(await service.listSideTasks('parent'), [], 'the closed timeout cannot become an active tab');
});

h.test('a mismatched startup endpoint cannot redirect cleanup into the parent', async () => {
  const { service, client, state } = fixture();
  state.rememberSession('parent', 'parent', {}); client.sideEndpointOverride = 'parent';
  await assertRejects(() => service.createSideTask('parent'), 'a mismatched side endpoint is refused');
  const requestedId = String(object(client.sent('session/startSideTask')[0]?.init)?.threadId);
  assertEqual(client.sent('session/close')[0]?.sessionId, requestedId, 'cleanup owns only the requested side endpoint');
  assertEqual(state.liveSession('parent'), 'parent', 'the parent binding is preserved');
  assertDeepEqual(await service.listSideTasks('parent'), [], 'successful cleanup releases the invalid side reservation');
});

h.test('idle side tasks remain available until explicitly closed without background expiry reads', async () => {
  const { service, state, client, advance } = fixture(); const id = await create(service);
  state.markTurnRunning(id); advance(2 * 60 * 60 * 1000);
  assertEqual((await service.listSideTasks('parent')).length, 1, 'active work remains attached');
  state.clearTurnRunning(id); advance(24 * 60 * 60 * 1000);
  const rows = await service.listSideTasks('parent');
  assertEqual(rows.length, 1, 'idle tabs persist past the former one-hour deadline');
  assertEqual(object(rows[0])?.expiresAt, undefined, 'metadata carries no destructive deadline');
  assertDeepEqual(await service.touchSideTask(id), { ok: true }, 'activity remains accepted');
  assertEqual(client.sent('session/subagentLifecycle').length, 0, 'listing does not schedule expiry inspection');
  assertEqual(client.sent('session/backgroundProcesses').length, 0, 'idle tabs need no shell inspection');
  assertEqual(client.sent('session/close').length, 0, 'elapsed time cannot discard context');
  await service.send(id, { text: 'Continue the retained side discussion' });
  assertEqual(client.sent('turn/submit').length, 1, 'the original endpoint still accepts work');
  await service.closeSideTask(id);
  assert(!service.isSideTask(id), 'explicit close releases identity');
  assertEqual(state.liveSession(id), undefined, 'explicit close drains the binding');
  assertDeepEqual(await service.touchSideTask(id), { ok: false }, 'activity cannot resurrect a closed endpoint');
});

h.test('optional side statistics are coalesced and cannot cross a live binding', async () => {
  const { service, client, state } = fixture(); const id = await create(service);
  let release!: (value: unknown) => void;
  client.contextSnapshot = () => new Promise(resolve => { release = resolve; });
  const cold = await service.listSideTasks('parent');
  assertEqual(object(cold[0])?.contextUsage, undefined, 'tabs return before a cold statistics read');
  await service.listSideTasks('parent');
  assertEqual(client.sent('session/contextSnapshot').length, 1, 'repeated tab reads share the pending statistics request');
  release(responsiveness.contextSnapshot); await new Promise(resolve => setImmediate(resolve));
  const warm = await service.listSideTasks('parent');
  assertDeepEqual(object(warm[0])?.contextUsage, responsiveness.contextUsage, 'last measured statistics are available on the next read');
  state.rememberSession(id, 'replacement-side-engine', {});
  release(responsiveness.contextSnapshot); await new Promise(resolve => setImmediate(resolve));
  const rebound = await service.listSideTasks('parent');
  assertEqual(object(rebound[0])?.contextUsage, undefined, 'old engine counters never label a new binding');
  release(responsiveness.contextSnapshot); await new Promise(resolve => setImmediate(resolve));
});

h.test('side creation snapshots a live parent without starting or resuming that parent', async () => {
  const { service, client, state } = fixture(); await service.client();
  state.rememberSession(responsiveness.parentThreadId, responsiveness.sourceSessionId, {});
  state.markTurnRunning(responsiveness.parentThreadId);
  const id = await create(service), params = client.sent(responsiveness.startMethod)[0]!;
  assertEqual(params.parentThreadId, responsiveness.parentThreadId, 'parent thread relation reaches the facade');
  assertEqual(params.sourceSessionId, responsiveness.sourceSessionId, 'running parent uses its current live context');
  assertEqual(object(params.init)?.threadId, id, 'destination identity is explicit');
  assertEqual(client.sent('session/start').length, 0, 'parent recovery is not a prerequisite');
  assertEqual(client.sent('session/createSideTask').length, 0, 'side creation is one atomic lifecycle request');
});

h.test('side creation does not install an idle-expiry timer tied to the request scope', async () => {
  const { service, client, advance } = fixture(); await service.client();
  const original = global.setInterval, controller = new AbortController(); let intervals = 0;
  global.setInterval = ((...args: Parameters<typeof setInterval>) => { intervals++; return original(...args); }) as typeof setInterval;
  let id: string;
  try { id = await service.withEngineOwner(service.engine()!, controller.signal, () => create(service)); }
  finally { global.setInterval = original; }
  controller.abort(); advance(24 * 60 * 60 * 1000);
  assertEqual(intervals, 0, 'temporary context lives until close or application shutdown');
  assert(service.isSideTask(id), 'retired creation request does not retire its side endpoint');
  assertEqual(client.sent('session/close').length, 0, 'no expiry cleanup was scheduled');
});

h.test('parent deletion drains children first, and directory retirement cannot leave dead side-task rows', async () => {
  const { root, service, client, workspace } = fixture();
  const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'keep'), 'keep');
  workspace.bindSession('parent', { workdir: project });
  const first = await create(service); await service.deleteSession('parent');
  assert(!service.isSideTask(first), 'parent deletion removes child');
  assert(client.calls.findIndex(call => call.method === 'session/close') < client.calls.findIndex(call => call.method === 'session/deleteSession'), 'child closes before parent file deletion');
  await assertRejects(() => service.createSideTask('parent'), 'deleted parent cannot create an orphan');
  const another = fixture(); const otherProject = join(another.root, 'project'); mkdirSync(otherProject);
  another.workspace.bindSession('parent', { workdir: otherProject }); const second = await create(another.service);
  const release = await another.service.quiesceDirectory(otherProject);
  assert(!another.service.isSideTask(second), 'directory drain removes ephemeral registry row'); release();
  assert(existsSync(join(project, 'keep')), 'host lifecycle does not remove user files');
});

h.test('connection loss keeps persisted side ownership and resumes it on the next connection', async () => {
  const old = new Client(), replacement = new Client(); let current = old;
  const { service, state } = fixture({ manager: {
    attach: async () => ({ client: current, generation: current === old ? 1 : 2 }),
    shutdownAll: async () => { old.closed = true; replacement.closed = true; },
  } });
  const id = await create(service);
  old.closed = true; old.emit('event', { type: 'streamClosed' });
  await waitFor(() => state.liveSession(id) === undefined, 1000, 'dead connection clears the binding');
  assert(service.isSideTask(id), 'persisted side ownership survives the connection loss');
  current = replacement;
  const resumed = await service.resolveLiveSession(id);
  assert(resumed !== undefined, 'the side task resumes on the replacement connection');
  const starts = replacement.sent('session/start');
  assertEqual(starts[starts.length - 1]?.resume, id, 'the resume targets the persisted side thread');
});

h.test('a late startup reply never closes its old endpoint identity on a replacement connection', async () => {
  const old = new Client(), replacement = new Client(); let current = old;
  const { service, state } = fixture({ manager: {
    attach: async () => ({client:current,generation:current === old ? 1 : 2}),
    shutdownAll: async () => { old.closed = true; replacement.closed = true; },
  } });
  let release!: () => void; old.heldStart = () => new Promise<void>(resolve => { release = resolve; });
  const starting = service.createSideTask('parent'); void starting.catch(() => {});
  await waitFor(() => !!release, 1000, 'old startup response held');
  old.closed = true; old.emit('event', {type:'streamClosed'}); current = replacement;
  await service.client(); release();
  await assertRejects(() => starting, 'old activation loses its connection');
  assertEqual(replacement.sent('session/close').length, 0, 'cleanup cannot target an unrelated endpoint on the new connection');
  assertEqual(state.bindings().length, 0, 'dead endpoint is not remembered as a new live resource');
  assertDeepEqual(await service.listSideTasks('parent'), [], 'old generation reservation is gone');
  await create(service);
});

h.test('a structural settings change rebuilds a live side task instead of refusing its next question', async () => {
  const { service, client, state } = fixture();
  const id = await create(service);
  const first = state.liveSession(id);
  assert(first !== undefined, 'the side task starts live');
  state.markStale(id);
  const rebuilt = await service.resolveLiveSession(id);
  assert(rebuilt !== first, 'the stale endpoint was replaced by the rebuild');
  assert(client.sent('session/close').some(params => params.sessionId === first), 'the old endpoint closed before the rebuild');
  const starts = client.sent('session/start');
  const start = starts[starts.length - 1]!;
  assertEqual(start.resume, id, 'the rebuild resumes the persisted side-task thread');
  assertEqual(state.isStale(id), false, 'the rebuilt binding is fresh');
  assert(service.isSideTask(id), 'the registry row survives the rebuild');
  assertEqual(client.sent('session/startSideTask').length, 1, 'only creation used the side facade');
  await service.send(id, { text: 'Next question after the settings change' });
  await waitFor(() => client.sent('turn/submit').length === 1, 2000, 'the rebuilt side task admits the next question');
});

h.test('a restarted host rematerializes persisted side tasks from their durable registry', async () => {
  const first = fixture(); const id = await create(first.service);
  const reboot = fixture({}, first.root);
  const rows = await reboot.service.listSideTasks('parent');
  assertEqual(rows.length, 1, 'the persisted side task returns after a restart');
  assertEqual(object(rows[0])?.id, id, 'the same identity is rematerialized');
  const resumed = await reboot.service.resolveLiveSession(id);
  assert(resumed !== undefined, 'the rematerialized side task resumes from its rollout');
  assert(reboot.service.isSideTask(id), 'rematerialized ownership is live');
});

h.test('a dropped live binding resumes the persisted side thread instead of refusing', async () => {
  const { service, client, state } = fixture(); const id = await create(service);
  const first = state.liveSession(id);
  state.forgetSession(id, 'binding-lost');
  const resumed = await service.resolveLiveSession(id);
  assert(resumed !== first, 'the lost binding is replaced by a resume');
  const starts = client.sent('session/start');
  assertEqual(starts[starts.length - 1]?.resume, id, 'the resume targets the persisted side thread');
  assert(service.isSideTask(id), 'registry ownership retained');
});

h.test('pinning a side task surfaces it in the sidebar row set without un-hiding the panel list', async () => {
  const { service } = fixture(); const id = await create(service);
  const pinned = object(await service.setPinned(id, true))!;
  assert(typeof pinned.sidebarPinnedAt === 'number' && Number(pinned.sidebarPinnedAt) > 0, 'pin acknowledges a timestamp');
  assert((await service.listSessions()).some(row => object(row)?.id === id), 'a pinned side task reaches the sidebar row set');
  assertEqual((await service.listSideTasks('parent')).length, 1, 'the panel still lists it');
  await service.setPinned(id, false);
  assert(!(await service.listSessions()).some(row => object(row)?.id === id), 'unpinning returns it to panel-only');
});

h.test('archiving a side task parks it out of the panel and into the archive view', async () => {
  const { service, state } = fixture(); const id = await create(service);
  const archived = object(await service.setArchived(id, true))!;
  assertEqual(archived.ok, true, 'archive acknowledged');
  assertEqual((await service.listSideTasks('parent')).length, 0, 'the panel hides archived side tasks');
  assert((await service.listArchivedSessions()).some(row => object(row)?.id === id), 'the archive view lists it');
  assertEqual(state.liveSession(id), undefined, 'archiving released the live endpoint');
  const restored = object(await service.setArchived(id, false))!;
  assertEqual(restored.status, 'restored', 'unarchive acknowledges restoration');
  assertEqual((await service.listSideTasks('parent')).length, 1, 'the panel lists it again');
  const resumed = await service.resolveLiveSession(id);
  assert(resumed !== undefined, 'the unarchived side task resumes from its rollout');
});

h.test('forking a side task uses the durable disk fork and leaves the source live', async () => {
  const { service, client } = fixture(); const id = await create(service);
  const branch = object(await service.forkSession(id))!;
  assertEqual(client.sent('session/forkSession').length, 1, 'the durable fork facade owns the branch');
  assertEqual(client.sent('session/forkLive').length, 0, 'no live-endpoint fork remains');
  assert(service.isSideTask(id), 'the source side task stays live');
  assert(!service.isSideTask(String(branch.id)), 'the branch is an ordinary conversation');
});

h.test('pin and archive flags survive a host restart through the durable registry', async () => {
  const first = fixture(); const id = await create(first.service);
  await first.service.setPinned(id, true);
  const reboot = fixture({}, first.root);
  assert((await reboot.service.listSessions()).some(row => object(row)?.id === id), 'the pinned side task rematerializes pinned');
  await reboot.service.setPinned(id, false);
  await reboot.service.setArchived(id, true);
  const reboot2 = fixture({}, first.root);
  assert((await reboot2.service.listArchivedSessions()).some(row => object(row)?.id === id), 'the archived side task rematerializes archived');
  assertEqual((await reboot2.service.listSideTasks('parent')).length, 0, 'and stays out of the panel');
});

void (async () => {
  const code = await h.finish(join(__dirname, 'session-side-tasks-result.json'), 'session-side-tasks');
  for (const { root, service } of fixtures) { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
  process.exitCode = code;
})();
