import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Json } from '../main/ipc/contract';
import { object } from '../main/ipc/arguments';
import { IpcHandlerError } from '../main/ipc/registry';
import { HostState } from '../main/services/host-state';
import { ModelUpdates, type ModelCandidate } from '../main/sessions/model-updates';
import { SessionConfiguration } from '../main/sessions/configuration';
import { eventInference } from '../main/sessions/event-context';
import { failureKind, projectEngineEvent } from '../main/ipc/project';
import { ChatEventForwarder, SessionEventPump } from '../main/sessions/events';
import { projectSessionHistory } from '../main/sessions/history';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/inference-snapshot-vectors.json'), 'utf8'));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const state = new HostState(), calls: Array<{ method: string; params: Record<string, Json> }> = [], pushed: Json[] = [], released: string[] = [];
  state.rememberSession('thread', 'live', {}, { source: 'codex', selection: 'codex:a' });
  let revision = 0, changeId: string | undefined, pendingChangeId: string | undefined, modelUpdateError: string | undefined;
  let now = Date.now();
  let runtimeError = false, loseBegin = false, beginApplied = true, losePublish = false, publishApplied = true, cas = false;
  let hideChangeId = false, publishError: string | undefined;
  let beforePublish: ((params: Record<string, Json>) => Promise<void>) | undefined;
  let prepare = async (_id: string, _changeId: string, _signal: AbortSignal): Promise<ModelCandidate> => ({
    init: { modelSelection: 'custom:b', modelSource: { source: 'custom', modelId: 'b' } },
    provider: { source: 'custom', selection: 'custom:b' }, preferenceRevision: state.modelPreferenceRevision('thread'),
  });
  const client = { requestWithTimeout: async (method: string, params: Json): Promise<unknown> => {
    const row = object(params)!; calls.push({ method, params: row });
    if (method === 'session/modelRuntime') {
      if (runtimeError) throw { kind: 'closed' };
      return { revision, ...(changeId && !hideChangeId ? { changeId } : {}), ...(pendingChangeId ? { pendingChangeId } : {}), ...(modelUpdateError ? { modelUpdateError } : {}) };
    }
    if (method === 'session/beginModelUpdate') {
      if (row.expectedRevision !== revision) throw { kind: 'server', message: 'model reconfiguration revision conflict' };
      if (beginApplied) { pendingChangeId = String(row.changeId); modelUpdateError = undefined; }
      if (loseBegin) throw { kind: 'timeout', method };
      return { revision, changeId: row.changeId };
    }
    if (method === 'session/failModelUpdate') {
      if (pendingChangeId === row.changeId) modelUpdateError = String(row.error);
      return { revision, changeId: row.changeId };
    }
    if (method === 'session/reconfigureModel') {
      await beforePublish?.(row);
      if (publishError) throw { kind: 'server', message: publishError };
      if (cas) { cas = false; revision++; throw { kind: 'server', message: 'model reconfiguration revision conflict' }; }
      if (row.expectedRevision !== revision || pendingChangeId !== row.changeId) throw { kind: 'server', message: 'model reconfiguration revision conflict' };
      if (publishApplied) { revision++; changeId = String(row.changeId); pendingChangeId = undefined; }
      if (losePublish) throw { kind: 'timeout', method };
      return { revision, changeId };
    }
    throw new Error('Unexpected method ' + method);
  } };
  const binding = { client, engineId: 'live' };
  const updates = new ModelUpdates({ state, binding: id => state.liveSession(id) ? binding : undefined,
    ensure: (id, current) => { if (state.liveSession(id) !== current.engineId) throw new IpcHandlerError('SESSION_UNAVAILABLE', 'closed'); },
    prepare: (...args) => prepare(...args), release: (_id, id) => released.push(id), push: frames => pushed.push(...frames), now: () => now });
  return { state, calls, pushed, released, binding, updates,
    clock: (offset: number) => { now += offset; },
    prepare: (fn: typeof prepare) => { prepare = fn; }, beforePublish: (fn: typeof beforePublish) => { beforePublish = fn; },
    flags: (flags: { runtimeError?: boolean; loseBegin?: boolean; beginApplied?: boolean; losePublish?: boolean; publishApplied?: boolean; cas?: boolean; hideChangeId?: boolean; publishError?: string }) => {
      if (flags.runtimeError !== undefined) runtimeError = flags.runtimeError;
      if (flags.loseBegin !== undefined) loseBegin = flags.loseBegin;
      if (flags.beginApplied !== undefined) beginApplied = flags.beginApplied;
      if (flags.losePublish !== undefined) losePublish = flags.losePublish;
      if (flags.publishApplied !== undefined) publishApplied = flags.publishApplied;
      if (flags.cas !== undefined) cas = flags.cas;
      if (flags.hideChangeId !== undefined) hideChangeId = flags.hideChangeId;
      if (flags.publishError !== undefined) publishError = flags.publishError;
    },
  };
}

h.test('active-turn settings callback acknowledges a fence before returning, without waiting for preparation', async () => {
  const f = fixture(), prepared = deferred<ModelCandidate>();
  f.state.markTurnRunning('thread', 'old-step');
  f.prepare(async () => prepared.promise);
  const configuration = new SessionConfiguration({ state: f.state, configRoot: '/unused', request: async () => ({}), log: () => {}, publishInference: async () => f.updates.changed('thread') });
  await configuration.composerChanged({ kind: 'model', sessionId: 'thread' });
  assertEqual(f.calls.filter(row => row.method === 'session/beginModelUpdate').length, 1, 'engine fence acknowledged');
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 0, 'preparation has not completed');
  assertEqual(object(f.pushed[0])?.status, 'preparing', 'UI state follows the acknowledged fence');
  assertEqual(f.state.runningTurnId('thread'), 'old-step', 'no turn lifecycle mutation');
  prepared.resolve({ init: {}, provider: { source: 'custom', selection: 'custom:b' }, preferenceRevision: f.state.modelPreferenceRevision('thread') });
  await f.updates.refresh('thread', f.binding);
  assertDeepEqual(f.calls.filter(row => row.method !== 'session/modelRuntime').map(row => row.method), vector.publicationMethods, 'named publication ordering');
  assertEqual(f.state.runningTurnId('thread'), 'old-step', 'next-step readiness never relabels the old step');
});

h.test('composer default-only change invalidates no live conversation', async () => {
  const f = fixture(); let calls = 0;
  const configuration = new SessionConfiguration({ state: f.state, configRoot: '/unused', request: async () => ({}), log: () => {}, publishInference: async () => { calls++; } });
  await configuration.composerChanged({ kind: 'model' }); await configuration.settingsChanged('composer.main_model');
  assertEqual(calls, 0, 'future defaults never broadcast'); assertEqual(f.state.inferencePending('thread'), false, 'existing selection retained');
});

h.test('prediction display preferences preserve every live conversation binding', async () => {
  const f = fixture(); const publications: Array<string | undefined> = [];
  f.state.rememberSession('other-thread', 'other-live', {}, { source: 'custom', selection: 'custom:b' });
  f.state.markTurnRunning('other-thread', 'running-step');
  const configuration = new SessionConfiguration({ state: f.state, configRoot: '/unused', request: async () => ({}),
    log: () => {}, publishInference: async id => { publications.push(id); } });
  for (const key of ['composer_predictions_enabled', 'composer_predictions_has_accepted']) {
    await configuration.settingsChanged(key);
    assertEqual(f.state.isStale('thread'), false, `${key} preserves the idle writer`);
    assertEqual(f.state.isStale('other-thread'), false, `${key} preserves unrelated running writers`);
    assertEqual(f.state.liveSession('thread'), 'live', 'the existing live identity stays attached');
    assertEqual(f.state.inferencePending('thread'), false, 'display state never fences inference');
    assertEqual(f.state.runningTurnId('other-thread'), 'running-step', 'running lifecycle stays attached');
  }
  assertDeepEqual(publications, [], 'display state never publishes model changes');
});

h.test('a persisted preference is not reported as a failed save when its engine fence is unknown', async () => {
  const f = fixture(), logs: string[] = []; f.flags({ loseBegin: true, beginApplied: false });
  const configuration = new SessionConfiguration({ state: f.state, configRoot: '/unused', request: async () => ({}),
    log: kind => logs.push(kind), publishInference: async () => f.updates.changed('thread') });
  await configuration.composerChanged({ kind: 'model', sessionId: 'thread' });
  assertEqual(object(f.pushed.at(-1))?.status, 'failed', 'runtime failure has its explicit push state');
  assert(f.state.inferencePending('thread'), 'failed runtime publication still denies cached inference');
  assertDeepEqual(logs, ['model-fence-failed'], 'save callback does not pretend the persisted preference reverted');
});

h.test('global tier and auth configuration changes fence live sessions', async () => {
  const f = fixture(); const ids: Array<string | undefined> = [];
  const configuration = new SessionConfiguration({ state: f.state, configRoot: '/unused', request: async () => ({}), log: () => {}, publishInference: async id => { ids.push(id); } });
  for (const key of ['model_tiers:global', 'modelProviders', 'auth_mode', 'advisor']) await configuration.settingsChanged(key);
  assertDeepEqual(ids, [undefined, undefined, undefined, undefined], 'each actual shared configuration change publishes');
  assertEqual(f.state.isStale('thread'), false, 'Advisor updates do not replace the session writer');
});

h.test('lost begin ACK is reconciled by the exact pending change identity', async () => {
  const f = fixture(); f.flags({ loseBegin: true }); f.state.markModelChanged('thread');
  await f.updates.refresh('thread', f.binding);
  assertEqual(f.state.inferencePending('thread'), false, 'fence proof recovered');
  assertEqual(f.calls.filter(row => row.method === 'session/beginModelUpdate').length, 1, 'no blind begin replay');
});

h.test('unknown begin ACK with no fence proof fails closed before preparing or publishing', async () => {
  const f = fixture(); let preparations = 0;
  f.flags({ loseBegin: true, beginApplied: false }); f.state.markModelChanged('thread');
  f.prepare(async () => { preparations++; throw new Error('must not prepare'); });
  await assertRejects(() => f.updates.refresh('thread', f.binding), 'unknown fence');
  assert(f.state.inferenceUncertain('thread'), 'unknown begin denies cached provider admission');
  assertEqual(preparations, 0, 'preparation never runs without a known fence');
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 0, 'nothing published');
  assert(!f.pushed.some(row => object(row)?.status === 'preparing'), 'no optimistic prepared UI');
});

h.test('lost publish ACK restores a committed candidate without a second publication', async () => {
  const f = fixture(); f.flags({ losePublish: true }); f.state.markModelChanged('thread');
  await f.updates.refresh('thread', f.binding);
  assertEqual(f.state.sessionProvider('thread')?.source, 'custom', 'runtime changeId proves actual publication');
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 1, 'one complete publication');
});

h.test('unconfirmed publish preserves candidate routes and refuses cached-provider admission', async () => {
  const f = fixture(); f.flags({ losePublish: true, publishApplied: false }); f.state.markModelChanged('thread');
  await assertRejects(() => f.updates.refresh('thread', f.binding), 'unknown publish');
  assert(f.state.inferenceUncertain('thread'), 'unknown provider is fenced'); assertEqual(f.released.length, 0, 'unknown candidate routes remain live');
  assertEqual(f.state.sessionProvider('thread')?.source, 'codex', 'no optimistic identity update');
});

h.test('CAS conflict rereads revision and prepares the latest selection with a new fence', async () => {
  const f = fixture(); f.flags({ cas: true }); f.state.markModelChanged('thread');
  await f.updates.refresh('thread', f.binding);
  const publications = f.calls.filter(row => row.method === 'session/reconfigureModel');
  assertEqual(publications.length, 2, 'bounded conflict recovery'); assertEqual(publications[1]?.params.expectedRevision, 1, 'new CAS uses the current runtime');
  assert(publications[0]?.params.changeId !== publications[1]?.params.changeId, 'a failed fence is not reused'); assertEqual(f.released.length, 1, 'only rejected candidate released');
});

h.test('persistent CAS rejection has a finite retry budget rather than a hidden busy loop', async () => {
  const f = fixture(); f.state.markModelChanged('thread'); f.beforePublish(async () => f.flags({ cas: true }));
  await assertRejects(() => f.updates.refresh('thread', f.binding), 'CAS budget exhausted');
  await new Promise(resolve => setTimeout(resolve, 5));
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 6, 'no automatic unbounded reprepare');
  assertEqual(f.state.sessionProvider('thread')?.source, 'codex', 'no rejected candidate becomes active');
  assert(f.state.inferencePending('thread'), 'saved preference cannot admit cached inference');
});

h.test('revision increment without a matching changeId is not proof, and later exact proof restores without replay', async () => {
  const f = fixture(); f.state.markModelChanged('thread'); f.flags({ losePublish: true, hideChangeId: true });
  await assertRejects(() => f.updates.refresh('thread', f.binding), 'revision alone cannot establish ownership');
  assert(f.state.inferenceUncertain('thread'), 'an increment is still unknown ownership');
  assertEqual(f.released.length, 0, 'possibly published routes are retained');
  f.flags({ hideChangeId: false }); await f.updates.refresh('thread', f.binding);
  assertEqual(f.state.sessionProvider('thread')?.source, 'custom', 'later exact changeId is reconciled');
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 1, 'no blind second publish after lost ACK');
});

h.test('latest preference supersedes a slow prepare without waiting for its completion', async () => {
  const f = fixture(), stale = deferred<ModelCandidate>(); let prepares = 0;
  f.state.markModelChanged('thread');
  f.prepare(async () => { prepares++; return prepares === 1 ? stale.promise : { init: {}, provider: { source: 'custom', selection: 'custom:latest' }, preferenceRevision: f.state.modelPreferenceRevision('thread') }; });
  await f.updates.changed('thread'); await waitFor(() => prepares === 1, 1000, 'first prepare is held');
  f.state.markModelChanged('thread'); await f.updates.changed('thread'); await f.updates.refresh('thread', f.binding);
  assertEqual(f.state.sessionProvider('thread')?.selection, 'custom:latest', 'only latest preferences admitted');
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 1, 'stale prepare never publishes');
  stale.resolve({ init: {}, provider: { source: 'codex', selection: 'codex:stale' }, preferenceRevision: 1 });
  await new Promise(resolve => setTimeout(resolve, 0)); assert(f.released.length > 0, 'late unused routes are reclaimed');
});

h.test('candidate mapping exists when request events arrive before publication ACK', async () => {
  const f = fixture(); f.state.markModelChanged('thread');
  let source: string | undefined;
  f.beforePublish(async row => { source = f.state.sessionEventContext('thread', { revision: 1, changeId: String(row.changeId), model: 'b' })?.authMode; });
  await f.updates.refresh('thread', f.binding); assertEqual(source, 'custom', 'pre-ACK event uses candidate identity');
  assertEqual(f.state.sessionEventContext('thread', { revision: 0, model: 'a' })?.authMode, 'codex', 'old step retains initial source after publication');
});

h.test('invalid preparation preserves the old provider, emits failure and never publishes', async () => {
  const f = fixture(); f.state.markModelChanged('thread'); f.prepare(async () => { throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Sign in to the model source'); });
  await assertRejects(() => f.updates.refresh('thread', f.binding), 'invalid source');
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 0, 'no unauthorized provider sent');
  assertEqual(f.state.sessionProvider('thread')?.source, 'codex', 'old capture identity retained'); assert(f.state.inferencePending('thread'), 'new work remains blocked');
  assertEqual(object(f.pushed.at(-1))?.error, 'Sign in to the model source', 'inline UI has an explicit error');
  assertEqual(f.calls.filter(row => row.method === vector.failureMethod).length, 1, 'failed host preparation explicitly fails its matching capture fence');
});

h.test('a definitive pre-dispatch publication rejection fails its exact fence immediately', async () => {
  const f = fixture(); f.state.markModelChanged('thread');
  f.flags({ publishError: 'Provider configuration was rejected before dispatch' });
  await assertRejects(() => f.updates.refresh('thread', f.binding), 'rejected publication');
  const begin = f.calls.find(row => row.method === 'session/beginModelUpdate')!;
  const failures = f.calls.filter(row => row.method === 'session/failModelUpdate');
  assertEqual(failures.length, 1, 'capture does not remain pending until the timeout');
  assertEqual(failures[0]?.params.changeId, begin.params.changeId, 'only the rejected fence is failed');
  assertEqual(f.released.length, 1, 'only the known uncommitted candidate is released');
  assertEqual(f.state.sessionProvider('thread')?.source, 'codex', 'original requests retain their provider');
  assert(f.state.inferencePending('thread'), 'rejection never authorizes a new cached-provider request');
});

h.test('host preparation timeout fails its engine fence and reclaims only unused candidate routes', async () => {
  const f = fixture(); f.state.markModelChanged('thread');
  f.prepare(async () => { f.clock(75_001); return new Promise<ModelCandidate>(() => {}); });
  await assertRejects(() => f.updates.refresh('thread', f.binding), 'preparation timeout');
  assertEqual(object(f.pushed.at(-1))?.error, 'Model preparation timed out', 'finite preparation error is explicit');
  assertEqual(f.calls.filter(row => row.method === 'session/failModelUpdate').length, 1, 'timeout is not left as a dangling capture wait');
  assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 0, 'nothing publishes after timeout');
});

h.test('closed binding cannot publish or update the new session identity', async () => {
  const f = fixture(), prepared = deferred<ModelCandidate>(); f.state.markModelChanged('thread'); f.prepare(async () => prepared.promise);
  await f.updates.changed('thread'); const admission = f.updates.refresh('thread', f.binding);
  f.state.forgetSession('thread'); prepared.resolve({ init: {}, provider: { source: 'custom', selection: 'custom:b' }, preferenceRevision: 1 });
  await assertRejects(() => admission, 'closed binding'); assertEqual(f.calls.filter(row => row.method === 'session/reconfigureModel').length, 0, 'no publish after close');
});

h.test('attribution strips secrets, projects step starts, and leaves aggregate turn usage unlabelled', () => {
  const inference = { revision: 2, changeId: 'next', model: 'b', source: 'custom', token: 'private', baseUrl: 'private-url' };
  const params = { sessionId: 'live', event: { event: { type: 'provider.decision', event: { kind: 'request_started', inference } } } };
  assertDeepEqual(eventInference(params), vector.publicInference, 'non-secret whitelist');
  assertDeepEqual(projectEngineEvent({ type: 'rawSessionEvent', params }), [{ type: 'stream_mode', sessionId: 'live', mode: 'requesting', inference: vector.publicInference }], 'normal next-step requesting event changes actual request attribution');
  const usage = { requests: [{ inference: vector.publicInference, inputTokens: 12 }], inputTokens: 12 };
  const result = projectEngineEvent({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { event: { type: 'turn.completed', inference, usage } } } });
  assertDeepEqual(result, [{ type: 'turn_usage', sessionId: 'live', usage }], 'aggregate usage preserves per-request records, never labels the whole turn with its last model');
});

h.test('history preserves captured non-secret attribution and leaves legacy rows unlabelled', () => {
  const reply = object(projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'new', content: [{ type: 'text', text: 'captured' }], inference: { ...vector.publicInference, token: 'private' } },
    { type: 'assistant', uuid: 'legacy', content: [{ type: 'text', text: 'legacy' }] },
  ] }, 'thread'))!;
  const rows = reply.messages as Array<Record<string, Json>>;
  assertDeepEqual(rows[0]?.inference, vector.publicInference, 'new history keeps original request ownership');
  assertEqual(rows[1]?.inference, undefined, 'legacy history is not backfilled from current preferences');
  assert(!JSON.stringify(reply).includes('private'), 'stored private fields are never forwarded');
});

h.test('a sign-out publication failure settles quietly without announcing a model fault', async () => {
  const f = fixture(); f.state.markModelChanged('thread');
  f.prepare(async () => { throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Sign in to the model source'); });
  await f.updates.changed('thread', 'signed-out');
  await waitFor(() => f.pushed.some(row => object(row)?.status === 'failed'), 1000, 'the sign-out failure settles');
  const failure = object(f.pushed.at(-1))!;
  assertEqual(failure.quiet, true, 'an expected sign-out failure carries the quiet marker');
  assertEqual(f.calls.filter(row => row.method === vector.failureMethod).length, 1, 'the fence is explicitly failed');
  assert(f.state.inferencePending('thread'), 'the dead credential still blocks cached-provider admission');
});

h.test('a user selection after a quiet sign-out failure announces its own failure', async () => {
  const f = fixture(); f.state.markModelChanged('thread');
  f.prepare(async () => { throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Sign in to the model source'); });
  await f.updates.changed('thread', 'signed-out');
  await waitFor(() => f.pushed.filter(row => object(row)?.status === 'failed').length === 1, 1000, 'the quiet failure settles');
  f.state.markModelChanged('thread');
  await f.updates.changed('thread');
  await waitFor(() => f.pushed.filter(row => object(row)?.status === 'failed').length === 2, 1000, 'the later failure settles');
  const failure = object(f.pushed.at(-1))!;
  assertEqual(failure.quiet, undefined, 'a user-driven failure keeps its announcement');
});

h.test('closing a live conversation during model preparation settles without pushing a false preparation-failed toast', async () => {
  const f = fixture(), logs: string[] = [], prepared = deferred<ModelCandidate>();
  const updates = new ModelUpdates({
    state: f.state,
    binding: id => f.state.liveSession(id) ? f.binding : undefined,
    ensure: (id, current) => {
      if (f.state.liveSession(id) !== current.engineId) {
        throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The conversation closed before its model changed');
      }
    },
    prepare: () => prepared.promise,
    release: (_id, id) => f.released.push(id),
    push: frames => f.pushed.push(...frames),
    log: kind => logs.push(kind),
  });
  f.state.markModelChanged('thread');
  await updates.changed('thread');
  f.state.forgetSession('thread', 'session-closed');
  prepared.resolve({
    init: { modelSelection: 'custom:b', modelSource: { source: 'custom', modelId: 'b' } },
    provider: { source: 'custom', selection: 'custom:b' },
    preferenceRevision: 1,
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert(!f.pushed.some(row => object(row)?.status === 'failed'), 'unloaded session does not emit a false model preparation failure');
  assertDeepEqual(logs, [], 'expected unload logs no model-update-failed fault');
});

h.test('closing a live conversation before fence confirmation resolves changed cleanly and projects withheld failure kind', async () => {
  const f = fixture(), logs: string[] = [];
  let closing = false;
  const updates = new ModelUpdates({
    state: f.state,
    binding: id => f.state.liveSession(id) ? f.binding : undefined,
    ensure: () => {
      if (closing) throw new IpcHandlerError('SESSION_UNAVAILABLE', 'The conversation closed before its model changed');
    },
    prepare: async () => ({
      init: { modelSelection: 'custom:b', modelSource: { source: 'custom', modelId: 'b' } },
      provider: { source: 'custom', selection: 'custom:b' },
      preferenceRevision: 1,
    }),
    release: (_id, id) => f.released.push(id),
    push: frames => f.pushed.push(...frames),
    log: kind => logs.push(kind),
  });
  closing = true;
  f.state.markModelChanged('thread');
  await updates.changed('thread');
  assert(!f.pushed.some(row => object(row)?.status === 'failed'), 'mid-close fence abort does not push a false failure toast');
  assertDeepEqual(logs, [], 'mid-close fence abort logs no failure');

  assertEqual(failureKind({
    code: 'provider_error',
    message: 'the model declined to respond to this request',
    kind: 'withheld',
  }), 'withheld', 'host preserves withheld provider error kind');
});

void h.finish(join(__dirname, 'model-updates-results.json'), 'model-updates').then(code => { process.exitCode = code; });
