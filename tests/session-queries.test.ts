import { acceptedTurnInput } from './turn-input-fixture';
import { FakeEngineQueue } from './engine-queue-fixture';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/services/service-types';
import { HostState } from '../main/services/host-state';
import { SessionService, type EngineClientLike } from '../main/sessions/service';
import { AppServerClient } from '../main/engine/client';
import type { RpcRequestOptions } from '../main/engine/request-scheduler';
import { NdjsonFramer } from '../main/engine/ndjson';
import { SubscriptionAuthService } from '../main/services/subscription-auth';
import { SessionQueries } from '../main/sessions/queries';
import { readSessionTitle } from '../main/services/session-titles';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerSessionQueryHandlers } from '../main/ipc/handlers/session-queries';
import { contextStats } from '../main/sessions/context-stats';
import { SessionQueue } from '../main/sessions/queue';
import { ChatEventForwarder, SessionEventPump } from '../main/sessions/events';
import { bindFriendSession } from '../main/services/friend-session-scope';
import { assert, assertEqual, assertDeepEqual, assertRejects, Harness } from './harness';

const h = new Harness(), roots: string[] = [];
class Client extends EventEmitter implements EngineClientLike {
  readonly queue = new FakeEngineQueue();
  readonly calls: Array<{ method: string; params: Json }> = [];
  readonly scheduling: Array<{ method: string; options?: RpcRequestOptions }> = [];
  respond: (method: string, params: Json) => Json | Promise<Json> = method => { throw new Error(`Unexpected request: ${method}`); };
  isClosed(): boolean { return false; }
  async requestWithTimeout(method: string, params: Json, _timeoutMs?: number, options?: RpcRequestOptions): Promise<unknown> { this.scheduling.push({ method, options }); this.calls.push({ method, params }); return method.startsWith('thread/queue/') ? this.queue.request(method, params) : this.respond(method, params); }
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'klaus-session-query-')); roots.push(root);
  const client = new Client(), state = new HostState(), pushed: Json[] = [], logs: Array<{ kind: string; detail: string }> = [];
  state.rememberSession('renderer-id', 'engine-id', {}, { source: 'custom', selection: 'custom:test' });
  const service = new SessionService({
    state, configRoot: root, manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => {} },
    spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: events => pushed.push(...events),
    log: (kind, detail) => logs.push({ kind, detail }),
  });
  const queries = new SessionQueries(service, state, root), queue = new SessionQueue(service, state);
  const forwarder = new ChatEventForwarder((_channel, value) => { if (Array.isArray(value)) pushed.push(...value); });
  const pump = new SessionEventPump({ state, forwarder, emit: () => {}, currentGeneration: () => 1, log: () => {} });
  return { root, client, state, service, queries, queue, pump, pushed, forwarder, logs };
}
const queued = (uuid: string, value: string, mutable = true): Json => ({ message: { uuid, value, mode: 'prompt', priority: 'now' }, state: 'pending', mutable });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

h.test('confirmed queue admission survives a failed snapshot without restoring duplicate input', async () => {
  const f = fixture(), item = { finalText: 'Retain the accepted instruction', media: [] };
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/engine-client-queue-vectors.json'), 'utf8'));
  f.client.queue.beforeRequest = async method => {
    if (method === 'thread/queue/list') throw { kind: 'server', code: -32000, message: 'disk I/O error' };
  };
  const reply = object(await f.service.clientQueueAdd('renderer-id', { id: 'accepted-before-refresh', item }));
  assertEqual(reply.ok, vector.admission.confirmedAddSurvivesSnapshotFailure, 'an acknowledged add cannot become a refusal after commit');
  assert(!Object.hasOwn(reply, 'snapshot'), 'a failed read must not fabricate an authoritative snapshot');
  assertEqual(f.client.queue.document('renderer-id').rows.length, 1, 'the engine already owns exactly one input');
  assert(f.logs.some(row => row.kind === 'engine-queue-refresh-failed' && row.detail.includes('disk I/O error')), 'the failed projection remains diagnosable');
  f.client.queue.beforeRequest = undefined;
  const recovered = object(await f.service.clientQueueSnapshot('renderer-id'));
  const rows = object(recovered.snapshot).items as Json[];
  assertEqual(rows.length, 1, 'a later authoritative refresh reveals the saved row without resubmission');
  assertEqual(object(rows[0]).id, 'accepted-before-refresh', 'recovery retains the original message identity');
  assertDeepEqual(object(rows[0]).item, item, 'recovery retains the original payload');
  assertEqual(f.client.queue.calls.filter(call => call.method === 'thread/queue/add').length, 1, 'snapshot recovery never issues another add');
  f.forwarder.close();
});

h.test('unacknowledged queue admission and definite refusal cannot report confirmed success', async () => {
  for (const phase of ['before-commit', 'lost-ack']) {
    const f = fixture(), fail = async (method: string) => {
      if (method === 'thread/queue/add') throw { kind: phase === 'lost-ack' ? 'timeout' : 'server', message: 'Admission was not confirmed' };
    };
    if (phase === 'lost-ack') f.client.queue.afterCommit = fail;
    else f.client.queue.beforeRequest = fail;
    const reply = object(await f.service.clientQueueAdd('renderer-id', { id: 'unconfirmed-add', item: { finalText: 'Keep this input' } }));
    assertEqual(reply.ok, false, 'only a received admission acknowledgement can confirm ownership');
    assertEqual(f.client.queue.document('renderer-id').rows.length, phase === 'lost-ack' ? 1 : 0, 'the fixture distinguishes committed input from refusal');
    f.forwarder.close();
  }
});

h.test('browser authorization survives an account lookup beyond the ordinary read deadline', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/cursor-browser-login-vectors.json'), 'utf8')) as {
    pollTimeoutMs: number; readTimeoutMs: number; delayedCompletionMs: number;
  };
  const root = mkdtempSync(join(tmpdir(), 'klaus-browser-login-')); roots.push(root);
  const input = new PassThrough(), client = new AppServerClient(input, 'browser-login-fixture');
  const calls: Array<{ method: string; timeoutMs: number }> = [];
  const request = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = (method, params, timeoutMs, options) => {
    calls.push({ method, timeoutMs });
    return request(method, params, timeoutMs, options);
  };
  let completion: ReturnType<typeof setTimeout> | undefined, published = 0;
  const reply = (id: number, result: Json): void => client.feedStdout(Buffer.from(JSON.stringify({ id, result }) + '\n'));
  const framer = new NdjsonFramer(line => {
    const message = JSON.parse(line) as { id: number; method: string };
    if (message.method === 'cursor/loginStart') {
      reply(message.id, { ok: true, flowId: 'delayed-flow', authUrl: 'https://cursor.com/loginDeepControl' });
    } else if (message.method === 'cursor/loginPoll') {
      completion = setTimeout(() => reply(message.id, { ok: true, credentialId: 'browser-credential', authMethod: 'browser' }), vector.delayedCompletionMs);
    } else reply(message.id, { loggedIn: true });
  });
  input.on('data', chunk => framer.push(chunk));
  const sessions = new SessionService({
    state: new HostState(), configRoot: root, manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => {} },
    spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: () => {},
  });
  const auth = new SubscriptionAuthService({
    configRoot: root, homeDir: root, request: (method, params) => sessions.request(method, object(params)),
    cursorClientVersion: async () => 'fixture-public-version', openExternal: async () => {}, onAuthChanged: () => { published++; },
  });
  try {
    assert(vector.delayedCompletionMs > vector.readTimeoutMs, 'the fixture crosses the ordinary read deadline');
    assertEqual(object(await auth.cursorStart()).ok, true, 'the browser flow starts');
    assertEqual(object(await auth.cursorPoll('delayed-flow')).ok, true, 'the delayed authorization reaches the account service');
    assertEqual(published, 1, 'authentication completion is published once');
    await sessions.request('cursor/status', {});
    await sessions.request('cursor/status', {}, 1234);
    assertDeepEqual(calls.map(call => call.timeoutMs), [vector.readTimeoutMs, vector.pollTimeoutMs, vector.readTimeoutMs, 1234],
      'the longer deadline is scoped to browser polling and explicit deadlines are preserved');
  } finally {
    if (completion) clearTimeout(completion);
    await auth.close();
    client.endStdout();
    await sessions.shutdown();
    input.destroy();
  }
});

h.test('automatic inspection leaves an unloaded conversation unloaded', async () => {
  const f = fixture();
  try {
    assertEqual(await f.queries.contextStats('cold-thread'), null, 'unavailable live counters are not fabricated');
    await assertRejects(() => f.queries.tasks('cold-thread'), 'tasks cannot resume a conversation during inspection');
    await assertRejects(() => f.queries.agents('cold-thread'), 'unavailable agents must not look like an authoritative empty snapshot');
    await assertRejects(() => f.queries.request('cold-thread', 'session/backgroundProcesses'), 'process inspection never starts a session');
    await assertRejects(() => f.service.requestExistingSession('cold-thread', 'session/fileChanges'), 'change records cannot materialize model history');
    assertEqual(f.client.calls.length, 0, 'no activation, provider resolution, or runtime RPC is issued');
    assertEqual(f.state.liveSession('cold-thread'), undefined, 'the saved thread retains no live binding');
    assertEqual(f.pushed.length, 0, 'inspection failures do not append transcript errors');
  } finally { await f.service.shutdown(); f.forwarder.close(); }
});

h.test('inspection cannot follow a retired binding into a new runtime', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<Json>();
  f.client.respond = method => {
    assertEqual(method, 'session/contextSnapshot', 'only the original read reaches the runtime');
    entered.resolve();
    return release.promise;
  };
  const first = f.service.requestExistingSession('renderer-id', 'session/contextSnapshot');
  await entered.promise;
  const queued = f.service.requestExistingSession('renderer-id', 'session/taskList');
  f.state.forgetSession('renderer-id');
  const firstRejected = assertRejects(() => first, 'the in-flight snapshot cannot outlive its binding');
  const queuedRejected = assertRejects(() => queued, 'queued inspection rejects instead of resuming');
  release.resolve({ context: { totalTokens: 1, contextWindow: 100 } });
  await Promise.all([firstRejected, queuedRejected]);
  assertDeepEqual(f.client.calls.map(call => call.method), ['session/contextSnapshot'], 'no replacement session or delayed task read is admitted');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('profile activity reads one persisted aggregate without resuming a conversation', async () => {
  const f = fixture(), registry = new ChannelRegistry();
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/profile-activity-vectors.json'), 'utf8')) as {
    valid: { name: string; data: Json }[]; invalid: { name: string; data: Json }[];
  };
  let response: Json = vectors.valid[0]!.data;
  f.client.respond = (method, params) => {
    assertEqual(method, 'engine/profileActivity', 'the aggregate has one named read-only facade');
    assertDeepEqual(params, {}, 'profile reads never activate or target a conversation');
    return response;
  };
  registerSessionQueryHandlers(registry, { sessions: f.service, state: f.state, configRoot: f.root });
  const handler = registry.lookup('profile:activity')!;
  const context = { role: 'main' as const, senderId: 1, channel: 'profile:activity', args: [] };
  for (const vector of vectors.valid) {
    response = vector.data;
    assertDeepEqual(await handler(context), response, vector.name);
  }
  for (const vector of vectors.invalid) {
    response = vector.data;
    await assertRejects(() => Promise.resolve(handler(context)), vector.name);
  }
  assertEqual(f.client.calls.length, vectors.valid.length + vectors.invalid.length, 'no hidden session reads or resume calls');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('a pre-cancelled prediction context read never reaches the engine', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await f.service.predictionContext('renderer-id', controller.signal).then(
    () => { throw new Error('A cancelled context read must reject'); },
    error => assertEqual(error.name, 'AbortError', 'cancellation stays explicit'),
  );
  assertEqual(f.client.calls.length, 0, 'no engine read or resume is admitted');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('a cancelled prediction context queued behind a mutation cannot resume a retired binding', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<Json>(), controller = new AbortController();
  bindFriendSession(f.root, 'renderer-id', { accountId: 'account', friendshipId: 'friend', friendUserId: 'user' });
  f.client.respond = (method): Json | Promise<Json> => {
    if (method === 'session/contextSnapshot') { entered.resolve(); return release.promise; }
    if (method === 'turn/interrupt') { f.client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'engine-id', event: { submissionId: 'close-control', turnInterrupt: { accepted: true } } } }); return { submissionId: 'close-control' }; }
    if (method === 'session/close') return {};
    throw new Error(`A cancelled context read admitted ${method}`);
  };
  const mutation = f.service.requestSession('renderer-id', 'session/contextSnapshot');
  await entered.promise;
  const context = f.service.predictionContext('renderer-id', controller.signal);
  controller.abort();
  await f.service.retireFriendTaskSession('renderer-id');
  assertEqual(f.state.liveSession('renderer-id'), undefined, 'the actual close retired the live binding');
  const cancellation = context.then(
    () => { throw new Error('The queued cancelled context read must reject'); },
    error => assertEqual(error.name, 'AbortError', 'the queued operation keeps its cancellation'),
  );
  release.resolve({}); await mutation; await cancellation;
  assertDeepEqual(f.client.calls.map(call => call.method), ['session/contextSnapshot', 'turn/interrupt', 'session/close'], 'only ordinary system teardown follows cancellation, without delayed resume or context reads');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('a live prediction context reads the mapped session without admitting a turn', async () => {
  const f = fixture();
  f.client.respond = (method, params) => {
    assertEqual(method, 'session/predictionContext', 'one named context read');
    assertEqual(object(params).sessionId, 'engine-id', 'the captured live identity is used');
    return { turnId: 'terminal-turn', model: 'model', provider: 'openai', planMode: false, running: false };
  };
  assertDeepEqual(await f.service.predictionContext('renderer-id', new AbortController().signal),
    { turnId: 'terminal-turn', model: 'model', provider: 'openai', planMode: false, running: false, source: 'custom' }, 'the complete eligibility snapshot is returned');
  assertEqual(f.client.calls.length, 1, 'no foreground turn or auxiliary operation is created');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('context statistics match committed numeric vectors without inventing per-resource usage',()=>{
  const fixture=JSON.parse(readFileSync(join(__dirname,'../../contracts/vectors/context-statistics-vectors.json'),'utf8')) as {vectors:Array<{name:string;input:Json;expected:Record<string,Json>}>};
  for(const vector of fixture.vectors){
    const actual=contextStats(vector.input);
    for(const [key,value] of Object.entries(vector.expected))assertDeepEqual(actual[key],value,vector.name+': '+key);
    assertDeepEqual([actual.memoryFiles,actual.mcpTools,actual.agents,actual.skills],[[],[],[],null],'no unsupported breakdown is inferred');
  }
});
h.test('missing or invalid context counters produce an unavailable notice rather than a zero snapshot',async()=>{
  const f=fixture();
  assertEqual(await f.queries.contextStats(''),null,'no selected conversation');assertEqual(f.client.calls.length,0,'does not start an idle engine');
  for(const value of [{},{context:{totalTokens:-1,contextWindow:1000}},{context:{totalTokens:1,contextWindow:'1000'}}]){
    f.client.respond=()=>value as Json;assertEqual(await f.queries.contextStats('renderer-id'),null,'invalid data is not shown as zero');
  }
  assertEqual(f.pushed.length,3,'each failed request has a notice');
  f.client.respond=(method,params)=>{assertEqual(method,'session/contextSnapshot','named facade');assertEqual(object(params).sessionId,'engine-id','translated identity');return {context:{totalTokens:50,contextWindow:100}};};
  assertEqual(object(await f.queries.contextStats('renderer-id')).percentage,50,'valid measured snapshot recovers');f.forwarder.close();
});

h.test('optional context read failures remain diagnostic and cannot append transcript notices', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/context-statistics-vectors.json'), 'utf8')).readFailure;
  for (const error of [
    { kind: 'server', code: -32000, message: 'session terminated before the request completed' },
    { kind: 'server', code: -32004, message: 'unknown session' },
    { kind: 'timeout', method: 'session/contextSnapshot' },
    new Error('Read failed'),
  ]) {
    const f = fixture();
    f.client.respond = () => { throw error; };
    assertEqual(await f.queries.contextStats('renderer-id'), vector.result, 'no fabricated counters');
    assertEqual(f.pushed.length, vector.transcriptNotices, 'background reads do not become conversation messages');
    assertEqual(f.logs.filter(row => row.kind === vector.diagnosticKind).length, 1, 'failure remains diagnosable');
    assertEqual(f.state.isStale('renderer-id'), 'code' in error && typeof error.code === 'number' && [-32000, -32004].includes(error.code), 'only a definitive session loss marks the binding stale');
    f.forwarder.close();
  }
  const f = fixture();
  f.client.respond = () => { throw { kind: 'server', code: -32000, message: 'unrelated provider refusal' }; };
  await f.queries.contextStats('renderer-id');
  assertEqual(f.state.isStale('renderer-id'), false, 'a generic server error does not prove session loss');
  f.client.respond = () => ({ context: { totalTokens: 25, contextWindow: 100 } });
  assertEqual(object(await f.queries.contextStats('renderer-id')).percentage, 25, 'a later valid monitor read recovers');
  f.forwarder.close();
});

h.test('side questions wait for their correlated result even when it arrives before the ACK', async () => {
  const f = fixture();
  await f.service.client();
  const listeners = f.client.listenerCount('event');
  f.client.respond = (method, params) => {
    assertEqual(method, 'session/sideQuestion', 'named facade only');
    const value = object(params);
    assertEqual(value.sessionId, 'engine-id', 'live engine identity');
    f.client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'engine-id', event: { submissionId: 'someone-else', sideQuestion: { response: 'wrong' } } } });
    f.client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'engine-id', event: { submissionId: value.submissionId, sideQuestion: { response: 'correlated answer' } } } });
    return { submissionId: value.submissionId! };
  };
  assertEqual((await f.service.sideQuestion('renderer-id', 'write a commit description')).response, 'correlated answer', 'submission ACK is not an answer');
  assertEqual(f.client.listenerCount('event'), listeners, 'waiter releases listener');
  f.client.respond = () => ({ error: 'provider refused' });
  await assertRejects(() => f.service.sideQuestion('renderer-id', 'again'), 'facade refusal');
  assertEqual(f.client.listenerCount('event'), listeners, 'rejection releases listener');
  f.forwarder.close();
});

h.test('compaction waits past progress events for its measured outcome and reports no-op honestly',async()=>{
  const f=fixture();
  f.client.respond=(method,params)=>{
    assertEqual(method,'session/compactStart','named manual compaction');const submissionId=object(params).submissionId;
    assertEqual(object(params).instructions,'retain decisions','custom instruction');
    f.client.emit('event',{type:'rawSessionEvent',params:{sessionId:'engine-id',event:{submissionId,compactProgress:{phase:'started'}}}});
    f.client.emit('event',{type:'rawSessionEvent',params:{sessionId:'engine-id',event:{submissionId,compactProgress:{phase:'completed'}}}});
    f.client.emit('event',{type:'rawSessionEvent',params:{sessionId:'engine-id',event:{submissionId,compact:{compacted:true,beforeTokens:8000,afterTokens:2000}}}});
    return {submissionId:submissionId!};
  };
  assertDeepEqual(await f.service.compactSession('renderer-id','retain decisions'),{ok:true,preTokens:8000,postTokens:2000},'actual final counters');
  f.client.respond=()=>({compact:{compacted:false,reason:'summary-inflated'}});
  const noop=object(await f.service.compactSession('renderer-id',''));assertEqual(noop.ok,false,'no successful mutation claimed');assertEqual(noop.error,noop.notice,'optimistic UI can clear its pending indicator');
  f.state.markTurnRunning('renderer-id','turn');const count=f.client.calls.length;assertEqual(object(await f.service.compactSession('renderer-id','')).ok,false,'busy turn refused');assertEqual(f.client.calls.length,count,'no mutation while turn active');f.forwarder.close();
});

h.test('only admitted unsolicited queue frames advance the mirror, without read polling', async () => {
  const f = fixture();
  const send = (revision: number, submissionId: string, status = 'authoritative') => f.pump.receive({ type: 'rawSessionEvent', params: {
    sessionId: 'engine-id', event: { submissionId, queueSnapshot: { revision, items: [queued('message', 'queued')], status, privateEngineField: true } },
  } }, 1);
  send(2, ''); send(3, 'correlated-reply'); send(1, '');
  const result = await f.queue.snapshot('renderer-id');
  assertEqual(object(result.snapshot).revision, 2, 'older or reply-scoped frames cannot overwrite admitted state');
  assertEqual(object(result.snapshot).privateEngineField, undefined, 'engine-only fields were not exposed');
  assertEqual(f.client.calls.length, 0, 'snapshot reads do not poll the engine');
  send(3, '', 'persistence-failed'); send(4, '');
  assertEqual((await f.queue.snapshot('renderer-id')).code, 'persistence-failed', 'durability failure cannot heal on an unsolicited frame');
  f.forwarder.close();
  assertEqual(f.pushed.length, 2, 'only admitted frames were announced');
  assertEqual(object(f.pushed[0]).sessionId, 'renderer-id', 'UI identity is used');
  f.state.markStale('renderer-id'); f.state.takeStaleBinding('renderer-id');
  assertEqual(f.state.queueSnapshot('renderer-id'), undefined, 'a replaced binding cannot retain its old queue');
});

h.test('queue mutations use the mapped engine identity and advance only from the acknowledged outcome', async () => {
  const f = fixture();
  f.state.installQueueSnapshot('renderer-id', { revision: 4, status: 'authoritative', items: [queued('one', 'old'), queued('two', 'second')] });
  f.client.respond = (_method, params) => ({ queueMutation: { mutationId: object(params).mutationId ?? null, status: 'applied', snapshot: { revision: 5, status: 'authoritative', items: [queued('one', 'new')] } } });
  const result = await f.queue.mutate('edit', { sessionId: 'renderer-id', request: { uuid: 'one', mutationId: 'edit-1', edit: { value: 'new' } } });
  assertEqual(result.ok, true, 'applied outcome');
  assertDeepEqual(f.client.calls[0], { method: 'session/editQueued', params: { sessionId: 'engine-id', mutationId: 'edit-1', uuid: 'one', expectedRevision: 4, edit: { value: 'new' } } }, 'named facade with actual revision');
  assertEqual(f.state.queueSnapshot('renderer-id')?.revision, 5, 'post-operation mirror updated');
  f.client.respond = () => ({ queueMutation: { status: 'stale-revision', snapshot: { revision: 6, status: 'authoritative', items: [] } } });
  const conflict = await f.queue.mutate('remove', { sessionId: 'renderer-id', request: { uuid: 'one', mutationId: 'remove-1' } });
  assertEqual(conflict.code, 'stale-revision', 'durable engine refusal reaches the UI');
  assertEqual(f.state.queueSnapshot('renderer-id')?.revision, 6, 'a refusal can carry a newer authoritative snapshot');
});

h.test('only confirmed removal retires follow-up observation; an application race remains applied', async () => {
  for (const status of ['applied', 'stale-revision', 'stale-pending']) {
    const f = fixture(); await f.service.client(); f.state.markTurnRunning('renderer-id', 'wire-turn');
    f.client.respond = (method, params) => {
      assertEqual(method, 'turn/submit', 'one named admission');
      return acceptedTurnInput(params);
    };
    const admitted = object(await f.service.followUp('renderer-id', { text: 'Queued removal race' }));
    assertEqual(admitted.ok, true, 'original input admitted');
    const messageId = String(admitted.messageId);
    f.state.installQueueSnapshot('renderer-id', { revision: 4, status: 'authoritative', items: [queued(messageId, 'Queued removal race')] });
    const receipt = () => f.client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'engine-id', event: {
      submissionId: `steer-${messageId}`, steered: { applied: true },
    } } });
    f.client.respond = (method, params) => {
      assertEqual(method, 'session/removeQueued', 'existing named removal facade');
      assertEqual(object(params).expectedRevision, 4, 'engine removal is revision fenced');
      assertEqual(object(params).uuid, messageId, 'same durable input identity');
      if (status === 'stale-revision') receipt();
      return { queueMutation: { status: status === 'stale-pending' ? 'stale-revision' : status, snapshot: { revision: 5, status: 'authoritative',
        items: status === 'stale-pending' ? [queued(messageId, 'Queued removal race')] : [] } } };
    };
    const removed = await f.queue.mutate('remove', { sessionId: 'renderer-id', request: { uuid: messageId, mutationId: 'remove-race' } });
    assertEqual(removed.ok, status === 'applied', 'only engine confirmation cancels observation');
    const statuses = f.pushed.filter(event => object(event).type === 'follow_up_status').map(event => object(event).state);
    assertDeepEqual(statuses, status === 'stale-pending' ? ['engine_queued'] : ['engine_queued', status === 'applied' ? 'removed' : 'applied'], 'removal and application are distinct terminal outcomes');
    const count = f.pushed.length; receipt();
    assertEqual(f.pushed.length, count + (status === 'stale-pending' ? 1 : 0), 'late receipt is observed only when removal was refused and input remains pending');
    await f.service.shutdown(); f.forwarder.close();
  }
});

h.test('invalid and reserved queue actions cannot reach the engine', async () => {
  const f = fixture();
  f.state.installQueueSnapshot('renderer-id', { revision: 1, status: 'authoritative', items: [{ ...object(queued('one', 'busy')), state: 'reserved' }] });
  assertEqual((await f.queue.mutate('remove', { sessionId: 'renderer-id', request: { uuid: 'one', mutationId: 'remove' } })).code, 'reserved', 'reserved input cannot be edited');
  assertEqual((await f.queue.mutate('reorder', { sessionId: 'renderer-id', request: { item: { source: 'rust', uuid: 'one' }, mutationId: 'reorder' } })).code, 'invalid-request', 'missing before is not move-to-end');
  assertEqual((await f.queue.mutate('edit', { sessionId: 'renderer-id', request: { uuid: 'one', mutationId: 'edit', edit: { value: [{ type: 'image', mimeType: 'image/png', base64: 'invalid!' }] } } })).code, 'invalid-request', 'invalid binary input rejected');
  assertEqual(f.client.calls.length, 0, 'no bad mutation reached the facade');
});

h.test('task pagination restarts on identity drift and never returns a mixed revision', async () => {
  const f = fixture();
  const pages = [
    { taskListId: 'list', revision: 1, tasks: [{ id: 'old' }], nextCursor: 'p2', cursorStatus: 'current' },
    { taskListId: 'list', revision: 2, tasks: [{ id: 'mixed' }], nextCursor: null, cursorStatus: 'current' },
    { taskListId: 'list', revision: 2, tasks: [{ id: 'new', subject: 'Current', status: 'completed' }], nextCursor: null, cursorStatus: 'current' },
  ];
  f.client.respond = () => ({ taskList: pages.shift()! });
  const reply = object(await f.queries.tasks('renderer-id'));
  assertEqual(f.client.calls.length, 3, 'new snapshot was read after drift');
  assertEqual(object((reply.tasks as Json[])[0]).id, 'new', 'partial old revision discarded');
  assertEqual(object(f.client.calls[2]!.params).sessionId, 'engine-id', 'reads use live binding');
  f.client.respond = () => { throw new Error('storage unavailable'); };
  await assertRejects(() => f.queries.tasks('renderer-id'), 'a failed read must not masquerade as no tasks');
});

h.test('sub-agent reopen keeps its tool result, final identity and timing maps', async () => {
  const f = fixture();
  f.client.respond = (): Json => ({ subagentTranscript: {
    messages: [
      { type: 'assistant', uuid: 'a', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'printf child' } }] },
      { type: 'tool_result', uuid: 'r', toolUseId: 'tool', content: [{ type: 'text', text: 'child output' }], isError: false },
      { type: 'assistant', uuid: 'final', content: [{ type: 'text', text: 'Child complete' }] },
    ],
    turnIndex: { historyTurnIds: { a: 'turn', r: 'turn', final: 'turn' }, turnFinalMessageIds: { turn: 'final' }, turnStartedAtMs: { turn: 10 }, turnFinishedAtMs: { turn: 20 }, turnStatuses: { turn: 'completed' } },
  } });
  const reply = object(await f.queries.agentHistory('renderer-id', 'child-id')), messages = reply.messages as Json[];
  const first = object(messages[0]), blocks = first.contentBlocks as Json[];
  assertEqual(first.id, 'child-id-0', 'child identity prefixes its rows');
  assert(object(blocks[0]).__result !== undefined, 'expandable tool result attached');
  assertEqual(object(messages[messages.length - 1]).isFinalReply, true, 'final reply restored');
  assertDeepEqual(reply.turnFinishedAtMs, { turn: 20 }, 'child clock survives reopen');
  assertDeepEqual(f.client.calls[0], { method: 'session/subagentTranscript', params: { threadId: 'renderer-id', agentId: 'child-id', sessionId: 'engine-id' } }, 'parent endpoint and child identity remain distinct');
});

h.test('a saved child opens without resuming its unavailable parent provider', async () => {
  const f = fixture(); f.state.forgetSession('renderer-id');
  const saved = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply;
  f.client.respond = (method, params) => {
    assertEqual(method, 'engine/readSubagentHistory', 'only the provider-free facade is allowed');
    assertDeepEqual(params, { threadId: 'renderer-id', agentId: 'child-id' }, 'parent and child disk identities');
    return { ...saved, threadId: 'renderer-id', agentId: 'child-id', meta: null, surfacedTools: [] };
  };
  const reply = object(await f.queries.agentHistory('renderer-id', 'child-id'));
  assertEqual(object((reply.messages as Json[])[1]).id, 'child-id-1', 'the child still owns its rendered rows');
  assertEqual(f.state.liveSession('renderer-id'), undefined, 'saved read creates no live parent');
  assertEqual(f.client.calls.length, 1, 'no provider initialization');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('sub-agent reconciliation uses background admission without changing its facade payload', async () => {
  const f = fixture();
  f.client.respond = () => ({ subagentLifecycle: { agents: [] } });
  await f.queries.agents('renderer-id');
  assertDeepEqual(f.client.calls, [{ method: 'session/subagentLifecycle', params: { sessionId: 'engine-id' } }], 'the public facade remains unchanged');
  assertDeepEqual(f.client.scheduling[0]?.options, { priority: 'background', source: 'thread', conversationId: 'renderer-id' }, 'repair reads retain their conversation budget and yield to interaction');
});

h.test('sub-agent lifecycle states follow committed vectors and malformed rows cannot become live agents', async () => {
  const f = fixture();
  const vector = JSON.parse(readFileSync(join(__dirname,'../../contracts/vectors/agent-task-snapshot-vectors.json'),'utf8'));
  const row = {agentId:'child',kind:'persistent',status:'running',context:{description:'Child',agentType:'worker',parentAgentId:'direct-parent',spawnTurnId:'parent-turn',depth:2},startedAtMs:10,updatedAtMs:20,completedAtMs:null};
  for(const expected of vector.statuses) {
    f.client.respond=()=>({subagentLifecycle:{agents:[{...row,status:expected.wire,lastError:expected.error ?? null}]}});
    const agent=object(((await f.queries.agents('renderer-id')).agents as Json[])[0]);
    assertEqual(agent.status,expected.status,expected.wire+' status'); assertEqual(agent.idle,expected.idle,expected.wire+' idle');
    assertEqual(agent.agentType,'worker','real role'); assertEqual(agent.kind,'persistent','real kind');
    assertEqual(agent.parentAgentId,'direct-parent','direct-parent identity'); assertEqual(agent.depth,2,'nested depth');
    assertEqual(agent.spawnTurnId,'parent-turn','durable parent turn ownership');
    assertEqual(agent.error,expected.error ?? '',expected.wire+' error');
  }
  for(const agents of [[{...row,agentId:''}],[{...row,status:'unexpected'}],[{...row,kind:'unexpected'}],[row,row]]) {
    f.client.respond=()=>({subagentLifecycle:{agents}});
    await assertRejects(()=>f.queries.agents('renderer-id'),'invalid lifecycle must reject');
  }
  f.forwarder.close();
});

h.test('internal memory maintenance never becomes a user-visible sub-agent', async () => {
  const f = fixture();
  const memory = {
    agentId: 'memory-child', kind: 'foreground', status: 'failed',
    context: {
      agentType: 'general-purpose',
      description: 'You maintain a persistent memory directory for an ongoing software-engineering project.\nBelow is the recent conversation.',
    },
    startedAtMs: 10, updatedAtMs: 20, completedAtMs: 20,
  };
  const user = {
    agentId: 'user-child', kind: 'foreground', status: 'completed',
    context: { agentType: 'general-purpose', description: 'Review the release checklist.' },
    startedAtMs: 11, updatedAtMs: 21, completedAtMs: 21,
  };
  f.client.respond = () => ({ subagentLifecycle: { agents: [memory, user] } });
  const agents = (await f.queries.agents('renderer-id')).agents as Json[];
  assertEqual(agents.length, 1, 'legacy internal lifecycle row is hidden');
  assertEqual(object(agents[0]).id, 'user-child', 'ordinary child remains visible');
  f.forwarder.close();
});

h.test('goal mutations preserve provenance and budget tri-state while the engine owns admission', async () => {
  const f = fixture(); let goalRevision = 0;
  f.client.respond = (method): Json => {
    if (method === 'engine/readSessionSummary') return { session: { id: 'renderer-id' } };
    if (method === 'session/goal') return { goalPursuitEligible: true };
    assertEqual(method, 'session/setGoal', 'mutation follows the provider-free ownership preflight without a host-started turn');
    return { threadGoal: { threadId: 'renderer-id', goalId: 'generation', objective: 'User objective', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, createdAtMs: 1, updatedAtMs: 1 }, goalRevision: ++goalRevision, goalAdmission: 'scheduled' };
  };
  await f.queries.setGoal('renderer-id', { objective: 'User objective', submit: true, clientRequestId: 'submit-1', expectedGoalId: null, expectedGoalRevision: 0 });
  const seeded = readSessionTitle('renderer-id', f.root);
  assertEqual(seeded?.title, 'User objective', 'an explicit goal submission seeds the title a composer send would have');
  assertEqual(seeded?.source, 'seed', 'goal-seeded titles carry seed provenance');
  const change = object(f.client.calls.find(row => row.method === 'session/setGoal')!.params);
  assert(!Object.hasOwn(change, 'tokenBudget'), 'absent budget stays absent');
  assertEqual(change.origin, 'user', 'user-control provenance is explicit');
  assertEqual(change.submit, true, 'explicit composer intent is distinct from editor writes');
  assertEqual(change.clientRequestId, 'submit-1', 'retry receipt retained');
  assertEqual(change.expectedGoalId, null, 'absence precondition retained');
  assertEqual(change.expectedGoalRevision, 0, 'same-generation revision precondition retained');
  await f.queries.setGoal('renderer-id', { tokenBudget: null });
  assertEqual(f.client.calls.filter(row => row.method === 'turn/submit').length, 0, 'the host cannot duplicate engine-owned goal admission');
  assertEqual(object(f.client.calls.filter(row => row.method === 'session/setGoal')[1]!.params).tokenBudget, null, 'explicit null removes the budget');
  f.forwarder.close();
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'session-queries-result.json'), 'session-queries');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(failed);
})();
