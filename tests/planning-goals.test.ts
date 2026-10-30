import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSessionHistory } from '../main/sessions/history';
import { GoalObjectives } from '../main/sessions/goal-objectives';
import { SessionPlanning, coherentPlanningCapture, projectPlanningHistory } from '../main/sessions/planning';
import { goalSnapshot, goalTurnMetadata, planningSnapshot, WorkflowSnapshots } from '../main/sessions/workflow-snapshots';
import { planningInputRequest, planningAnswers } from '../main/sessions/planning-input';
import { SessionQueries } from '../main/sessions/queries';
import { SessionService, type EngineClientLike } from '../main/sessions/service';
import { sessionPermissionPreset, sessionSpecMode } from '../main/services/session-store';
import { kvDel, withSettingsDb } from '../main/services/settings';
import { HostState } from '../main/services/host-state';
import { ChatEventForwarder, SessionEventPump } from '../main/sessions/events';
import { object, type JsonObject } from '../main/services/service-types';
import { projectEngineEvent } from '../main/ipc/project';
import type { Json } from '../main/ipc/contract';
import type { RpcRequestOptions } from '../main/engine/request-scheduler';
import { ChannelRegistry, IpcHandlerError } from '../main/ipc/registry';
import { registerSessionHandlers } from '../main/ipc/handlers/sessions';
import { registerSessionQueryHandlers } from '../main/ipc/handlers/session-queries';
import { bindFriendSession } from '../main/services/friend-session-scope';
import { assert, assertEqual, assertDeepEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness(), roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/planning-goals-vectors.json'), 'utf8'));
const root = () => { const path = mkdtempSync(join(tmpdir(), 'klaus-workflow-')); roots.push(path); return path; };
const goal = (goalId = 'generation-one', status = 'active') => ({ threadId: 'thread', goalId, objective: 'Finish the work', status, tokensUsed: 20, timeUsedSeconds: 10, createdAtMs: 1, updatedAtMs: 2 });
const planning = (revision = 1) => ({ mode: 'plan', revision, plans: [{ id: 'plan', threadId: 'thread', turnId: 'turn', revision: 1, content: '# Plan\n\nComplete the workflow.', status: 'proposed' }], questions: [] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class Client extends EventEmitter implements EngineClientLike {
  readonly calls: { method: string; params: Json }[] = [];
  readonly scheduling: { method: string; timeoutMs?: number; options?: RpcRequestOptions }[] = [];
  readonly promotions: { method: string; params: Json; priority: NonNullable<RpcRequestOptions['priority']> }[] = [];
  respond: (method: string, params: Json) => unknown = (method, params) => {
    if (method === 'turn/interrupt') { this.emit('event', { type: 'rawSessionEvent', params: { sessionId: object(params).sessionId, event: { submissionId: 'control', turnInterrupt: { accepted: true } } } }); return { submissionId: 'control' }; }
    return {};
  };
  isClosed(): boolean { return false; }
  async requestWithTimeout(method: string, params: Json, timeoutMs?: number, options?: RpcRequestOptions): Promise<unknown> {
    this.calls.push({ method, params }); this.scheduling.push({ method, timeoutMs, options });
    options?.onQueued?.(priority => { this.promotions.push({ method, params, priority }); return true; });
    return await this.respond(method, params);
  }
}
function fixture() {
  const state = new HostState(), client = new Client(), pushed: Json[] = [], emitted: { channel: string; payload: Json }[] = [], logs: { kind: string; detail: string }[] = [];
  const configRoot = root();
  const service = new SessionService({ state, configRoot, manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => {} },
    spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: events => pushed.push(...events), log: (kind, detail) => logs.push({ kind, detail }) });
  // Title discovery is covered by the dedicated session fixtures.
  service.seedGoalTitle = async () => undefined;
  const forwarder = new ChatEventForwarder((channel, payload) => emitted.push({ channel, payload }));
  const pump = new SessionEventPump({ state, forwarder, emit: (channel, payload) => emitted.push({ channel, payload }), currentGeneration: () => 1, log: (kind, detail) => logs.push({ kind, detail }) });
  state.rememberSession('thread', 'live', {}, { source: 'custom', selection: 'custom:test' });
  return { state, client, service, forwarder, pump, pushed, emitted, configRoot, logs };
}

h.test('goal snapshots retain every lifecycle state and reject unsafe numeric counters', () => {
  for (const status of vector.goalStatuses) assertEqual(goalSnapshot(goal('generation', status), 1)?.goal?.status, status, status);
  assertEqual(goalSnapshot({ ...goal(), tokensUsed: Number.MAX_SAFE_INTEGER + 1 }, 1), undefined, 'rounded counters are invalid');
  assertEqual(goalSnapshot(goal(), -1), undefined, 'negative revision rejected');
  const snapshots = new WorkflowSnapshots();
  vector.goalReadOrder.forEach((revision: number, index: number) => assertEqual(snapshots.installGoal('thread', { goal: revision === 5 ? null : goal() as never, goalRevision: revision }).goalRevision, vector.goalAcceptedRevisions[index], 'old read cannot overwrite a push or clear'));
  assertEqual(snapshots.installGoal('thread', { goal: goal() as never, goalRevision: 4 }).goal, null, 'clear tombstone wins');
});

for (const invalidation of vector.goalReadLifecycle.invalidations as string[]) h.test(`goal reads reject a response invalidated by ${invalidation}`, () => {
  const snapshots = new WorkflowSnapshots();
  snapshots.installGoal('thread', { goal: goal() as never, goalRevision: 1 });
  const oldRead = snapshots.beginGoalRead('thread');
  if (invalidation === 'update') snapshots.installGoal('thread', { goal: goal('replacement') as never, goalRevision: 2 });
  if (invalidation === 'clear') snapshots.installGoal('thread', { goal: null, goalRevision: 2 });
  if (invalidation === 'newer-read') snapshots.beginGoalRead('thread');
  if (invalidation === 'forget') snapshots.forget('thread');
  assertEqual(snapshots.isCurrentGoalRead('thread', oldRead), false, 'an obsolete read has no authority to install');
});

h.test('a goal read returns intervening authoritative state instead of installing a late higher revision', async () => {
  const f = fixture(), response = deferred<unknown>();
  f.client.respond = () => response.promise;
  const queries = new SessionQueries(f.service, f.state, f.configRoot);
  const pending = queries.goal('thread');
  await waitFor(() => f.client.calls.some(call => call.method === 'session/goal'), 1000, 'goal read entered');
  const latest = f.state.workflows.installGoal('thread', { goal: null, goalRevision: 2 });
  response.resolve({ threadGoal: goal('obsolete'), goalRevision: 99 });
  assertEqual(await pending, latest as unknown as JsonObject, 'the intervening clear owns the result');
  assertEqual(f.state.workflows.goal('thread')?.goal, null, 'a read cannot resurrect the cleared goal');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('equivalent concurrent goal reads share one observation and a failed read permits a retry', async () => {
  const f = fixture(), first = deferred<unknown>();
  let reads = 0;
  f.client.respond = () => { reads++; return first.promise; };
  const queries = new SessionQueries(f.service, f.state, f.configRoot);
  const firstRead = queries.goal('thread');
  await waitFor(() => reads === 1, 1000, 'first read entered');
  const secondRead = queries.goal('thread');
  first.resolve({ threadGoal: goal('current'), goalRevision: 2 });
  const results = await Promise.all([firstRead, secondRead]);
  assertEqual(reads, vector.goalReadLifecycle.requestsPerEquivalentRead, 'equivalent callers never compete for response authority');
  assertEqual(results[0], results[1], 'both waiter orders receive the same accepted snapshot');
  f.client.respond = () => { throw new Error('Read unavailable'); };
  await assertRejects(() => queries.goal('thread'), 'a failed read remains explicit');
  f.client.respond = () => ({ threadGoal: goal('retry'), goalRevision: 3 });
  assertEqual(object((await queries.goal('thread')).goal).goalId, 'retry', 'failed work does not poison the next observation');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('cancelling one observer cannot cancel another observer sharing the goal read', async () => {
  const f = fixture(), response = deferred<unknown>(), controller = new AbortController();
  await f.service.client();
  f.client.respond = () => response.promise;
  const remote = f.service.withEngineOwner({ client: f.client, generation: 1 }, controller.signal, () => f.service.readGoalSnapshot('thread'));
  void remote.catch(() => {});
  await waitFor(() => f.client.calls.length === 1, 1000, 'the remote observer entered its read');
  const local = f.service.readGoalSnapshot('thread');
  controller.abort();
  response.resolve({ threadGoal: goal('current'), goalRevision: 2 });
  await assertRejects(() => remote, 'the cancelled caller retains its ownership fence');
  assertEqual((await local).goal?.goalId, 'current', 'the independent caller receives the shared read');
  assertEqual(f.client.calls.length, vector.goalReadLifecycle.requestsPerEquivalentRead, 'both callers share one provider-free observation');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('a foreground observer promotes shared background goal work without another read authority', async () => {
  const f = fixture(), response = deferred<unknown>();
  await f.service.client();
  f.client.respond = () => response.promise;
  const background = f.service.readGoalSnapshot('thread', { priority: 'background', source: 'thread', conversationId: 'thread' });
  await waitFor(() => f.client.calls.length === 1, 1000, 'the background read entered');
  const foreground = f.service.readGoalSnapshot('thread');
  assertDeepEqual(f.client.promotions, [{ method: 'session/goal', params: { threadId: 'thread', sessionId: 'live' }, priority: 'interactive' }], 'the exact live observation is promoted');
  response.resolve({ threadGoal: goal('current'), goalRevision: 2 });
  assertEqual(await background, await foreground, 'promotion retains shared response authority');
  assertEqual(f.client.calls.length, vector.goalReadLifecycle.requestsPerEquivalentRead, 'promotion issues no additional facade read');
  await f.service.shutdown(); f.forwarder.close();
});

for (const oldFirst of [false, true]) h.test(`an authoritative update separates concurrent goal reads when the old response finishes ${oldFirst ? 'first' : 'last'}`, async () => {
  const f = fixture(), first = deferred<unknown>(), second = deferred<unknown>();
  let reads = 0;
  f.client.respond = () => ++reads === 1 ? first.promise : second.promise;
  const oldRead = f.service.readGoalSnapshot('thread');
  await waitFor(() => reads === 1, 1000, 'first read entered');
  f.state.workflows.installGoal('thread', { goal: goal('pushed') as never, goalRevision: 2 });
  const currentRead = f.service.readGoalSnapshot('thread');
  await waitFor(() => reads === 2, 1000, 'the changed authority owns a fresh read');
  if (oldFirst) {
    first.resolve({ threadGoal: goal('obsolete'), goalRevision: 99 });
    assertEqual((await oldRead).goal?.goalId, 'pushed', 'the early obsolete caller receives the intervening update');
  }
  second.resolve({ threadGoal: goal('current'), goalRevision: 3 });
  await currentRead;
  if (!oldFirst) {
    first.resolve({ threadGoal: goal('obsolete'), goalRevision: 99 });
    assertEqual((await oldRead).goal?.goalId, 'current', 'the late obsolete caller receives the current observation');
  }
  assertEqual(f.state.workflows.goal('thread')?.goal?.goalId, 'current', 'the obsolete response never installs');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('signed safe goal timestamps stay distinct from nonnegative accounting', () => {
  for (const timestamp of vector.validGoalTimestamps) {
    const snapshot = goalSnapshot({ ...goal(), createdAtMs: timestamp, updatedAtMs: timestamp }, 1);
    assertEqual(snapshot?.goal?.createdAtMs, timestamp, 'creation time retains its exact signed value');
    assertEqual(snapshot?.goal?.updatedAtMs, timestamp, 'update time retains its exact signed value');
  }
  for (const field of ['createdAtMs', 'updatedAtMs']) {
    for (const value of vector.invalidGoalTimestamps) assertEqual(goalSnapshot({ ...goal(), [field]: value }, 1), undefined, `${field} rejects an inexact or nonnumeric timestamp`);
  }
  for (const field of ['tokensUsed', 'timeUsedSeconds']) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '100', null, NaN, Infinity]) {
      assertEqual(goalSnapshot({ ...goal(), [field]: value }, 1), undefined, `${field} requires a nonnegative safe integer`);
    }
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      assertEqual(goalSnapshot({ ...goal(), [field]: value }, 1)?.goal?.[field as 'tokensUsed' | 'timeUsedSeconds'], value, `${field} preserves its exact admitted boundary`);
    }
  }
});

h.test('legacy planning permission migrates to independent collaboration with strict approval', () => {
  const config = root();
  sessionSpecMode('legacy', config);
  withSettingsDb(config, db => db.prepare('INSERT INTO session_permission_modes VALUES(?,?,?)').run('legacy', 'plan', 1));
  kvDel('migrated.collaboration_permission_v1', config);
  assertEqual(sessionPermissionPreset('legacy', config), 'default', 'ambiguous old permission never grants edits');
  assertEqual(sessionSpecMode('legacy', config).enabled, true, 'legacy planning intent retained as migration seed');
  assertEqual(sessionPermissionPreset('legacy', config), 'default', 'migration is idempotent');
});

h.test('planning snapshots validate artifact lifecycle and progress without merging unrelated tools', () => {
  for (const status of vector.planStatuses) assert(planningSnapshot({ ...planning(), plans: [{ ...planning().plans[0], status }] }), status);
  assertEqual(planningSnapshot({ ...planning(), progress: { plan: [{ step: 'One', status: 'in_progress' }, { step: 'Two', status: 'in_progress' }] } }), undefined, 'two active steps rejected');
  const snapshots = new WorkflowSnapshots(), first = planningSnapshot(planning(5))!;
  snapshots.installPlanning('thread', first);
  assertEqual(snapshots.installPlanning('thread', planningSnapshot({ ...planning(4), mode: 'default' })!), first, 'late read cannot revert the mode');
});

h.test('saved legacy collaboration migrates once while a newer explicit engine choice wins', async () => {
  for (const raced of [false, true]) {
    const config = root(), state = new HostState(), calls: string[] = [];
    sessionSpecMode('thread', config);
    withSettingsDb(config, db => db.prepare('INSERT INTO session_permission_modes VALUES(?,?,?)').run('thread', 'plan', 1));
    kvDel('migrated.collaboration_permission_v1', config); sessionSpecMode('thread', config);
    let current = { ...planning(0), mode: 'default', plans: [] };
    const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestThreadWorkflow: async (_id: string, method: string, params: JsonObject) => {
      calls.push(method);
      if (method === 'session/setCollaborationMode') {
        assertEqual(params.expectedRevision, 0, 'only untouched state accepts the legacy seed');
        current = { ...current, mode: raced ? 'default' : 'plan', revision: 1 };
        if (raced) throw new Error('Another client established mode first');
      }
      return { planning: current };
    } } as unknown as SessionService;
    const plans = new SessionPlanning(service, state, config), reply = await plans.get('thread');
    assertEqual(object(reply.planning).mode, raced ? 'default' : 'plan', 'authoritative engine revision wins');
    assert(calls.every(method => ['session/collaborationMode', 'session/setCollaborationMode'].includes(method)), 'migration never initializes a provider');
  }
});

h.test('structured planning questions preserve stable IDs, answers arrays and secret metadata', () => {
  const request = { requestId: 'request', request: { metadata: { kind: 'request_user_input', turnId: 'turn', toolCallId: 'tool' }, questions: [
    { id: 'stable-id', header: 'Choice', question: 'Which path?', isOther: true, isSecret: true, options: [{ label: 'A (Recommended)', description: 'First path.' }, { label: 'B', description: 'Second path.' }] },
  ] } };
  const decoded = planningInputRequest(request, 'thread')!;
  assertEqual(decoded.questions[0]?.id, 'stable-id', 'visible wording is not the answer key');
  assertEqual(decoded.questions[0]?.isSecret, true, 'secret metadata retained');
  assertEqual(planningInputRequest({ ...request, request: { ...request.request, metadata: { ...request.request.metadata, isBlocking: false } } }, 'thread')?.optional, true, 'optional classification belongs to the request');
  assertDeepEqual(planningAnswers({ 'stable-id': { answers: ['Other answer'] } }), { 'stable-id': { answers: ['Other answer'] } }, 'ID keyed arrays');
  assertEqual(planningAnswers({ 'Which path?': 'A' }), undefined, 'legacy answer shape remains separate');
  assertEqual(planningInputRequest({ ...request, request: { ...request.request, questions: [{ ...request.request.questions[0], header: 'Too long a heading' }] } }, 'thread'), undefined, 'header limit enforced');
});

h.test('parent-scoped structured input elicitations dedupe snapshot recovery and cancel with their turn', () => {
  const f = fixture();
  const question = { requestId: 'request', turnId: 'turn', toolCallId: 'tool', status: 'pending', request: {
    metadata: { kind: 'request_user_input', isBlocking: true, turnId: 'turn', toolCallId: 'tool' },
    questions: [{ id: 'stable', header: 'Pick', question: 'Which path?', options: [{ label: 'A (Recommended)', description: 'First path.' }, { label: 'B', description: 'Second path.' }] }],
  } };
  f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: '', planning: { ...planning(), questions: [question] } } } }, 1);
  f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: 'parent-turn', elicitation: { requestId: question.requestId, request: question.request } } } }, 1);
  assertEqual(f.emitted.filter(row => row.channel === 'planning-input:requested').length, 1, 'snapshot and parent-scoped elicitation represent one request');
  assertEqual(f.emitted.filter(row => row.channel === 'elicit:request').length, 0, 'structured questions do not acquire the legacy response shape');
  f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'live', turnId: 'turn', result: { stopReason: 'aborted' } } }, 1);
  const resolved = f.emitted.find(row => row.channel === 'planning-input:resolved');
  assertEqual(object(resolved?.payload).status, 'cancelled', 'interruption resolves only the owning tool request');
  f.forwarder.close();
});

h.test('goal objective preparation preserves complete Unicode text and accepted files', async () => {
  const config = root(), objectives = new GoalObjectives(config), boundary = '😀'.repeat(vector.materializeBoundary);
  assertEqual((await objectives.prepare('thread', { text: boundary })).objective, boundary, 'exact boundary is inline');
  const prepared = await objectives.prepare('thread', { text: boundary + 'Z' });
  assert(prepared.preparationId, 'long text has owned preparation');
  assertEqual(prepared.displayText, prepared.objective, 'the complete final reference is the canonical human display and copy source');
  assert(!prepared.displayText.includes('…'), 'materialization does not invent a truncated display preview');
  const path = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'), prepared.preparationId!, 'objective.md');
  assertEqual(readFileSync(path, 'utf8'), boundary + 'Z', 'the whole prepared text remains available to the engine');
  await objectives.accept('thread', prepared.preparationId!, prepared.objective);
  assertEqual(readFileSync(path, 'utf8'), boundary + 'Z', 'acceptance retains exact file content');
  await assertRejects(() => objectives.ownedResources('different-thread', prepared.preparationId!, prepared.objective), 'another thread cannot adopt the prepared resources');
  await assertRejects(() => objectives.ownedResources('thread', prepared.preparationId!, 'Read the complete goal objective from this Klaus-owned file: /etc/passwd'), 'forged reference receives no owned-resource authority');
});

h.test('goal eligibility survives metadata-less updates while newer ownership reads replace unknown notices', () => {
  const snapshots = new WorkflowSnapshots();
  snapshots.installGoal('thread', { goal: null, goalRevision: 0, goalPursuitEligible: false, goalPursuitEligibilityNotice: 'Open this thread to determine eligibility.' });
  const known = snapshots.installGoal('thread', { goal: null, goalRevision: 0, goalPursuitEligible: true });
  assertEqual(known.goalPursuitEligibilityNotice, undefined, 'a conclusive ownership read removes the obsolete notice');
  assertEqual(snapshots.installGoal('thread', { goal: goal() as never, goalRevision: 1 }).goalPursuitEligible, true, 'a goal update does not erase static ownership metadata');
  assertEqual(snapshots.installGoal('thread', { goal: null, goalRevision: 2 }).goalPursuitEligible, true, 'null clear notifications preserve known eligibility');
  assertEqual(goalSnapshot(null, 0, 'true'), undefined, 'malformed eligibility cannot authorize pursuit');
  const blocked = snapshots.installGoal('thread', { goal: null, goalRevision: 3, goalPursuitEligible: false });
  assertEqual(snapshots.installGoal('thread', { goal: goal() as never, goalRevision: 2, goalPursuitEligible: true }), blocked, 'an older goal revision cannot overwrite newer negative ownership metadata');
  assertEqual(snapshots.installGoal('thread', { goal: goal() as never, goalRevision: 4 }).goalPursuitEligible, false, 'metadata-less later accounting retains the negative ownership decision');
});

h.test('bounded friend and scoped tasks reject goal pursuit before preparation or activation and keep legacy controls', async () => {
  for (const kind of ['friend', 'metadata-friend', 'live-scope', 'saved-scope', 'unknown-legacy']) {
    const f = fixture(), config = f.configRoot, registry = new ChannelRegistry();
    if (kind === 'friend') bindFriendSession(config, 'thread', { accountId: 'account', friendshipId: 'friend', friendUserId: 'user' });
    if (kind === 'live-scope') f.state.rememberSession('thread', 'live', { config: { taskResourceScope: { taskId: 'bounded' } } }, { source: 'custom', selection: 'custom:test' });
    if (kind === 'saved-scope' || kind === 'unknown-legacy') f.state.forgetSession('thread');
    let current = goal(), revision = 1;
    f.client.respond = (method, params) => {
      if (method === 'engine/readSessionSummary') return { session: { id: 'thread', ...(kind === 'metadata-friend' ? { hostMetadata: { threadSource: 'friend' } } : {}) } };
      if (method === 'session/goal') return { threadGoal: current, goalRevision: revision, ...(kind === 'unknown-legacy' ? { goalPursuitEligibilityNotice: 'Open this thread to determine eligibility.' } : { goalPursuitEligible: false }) };
      if (method === 'session/setGoal') { assertEqual(object(params).status, 'paused', 'only an existing legacy pause reaches the named mutation'); current = goal('generation-one', 'paused'); return { threadGoal: current, goalRevision: ++revision }; }
      if (method === 'session/clearGoal') return { goalCleared: true, goalRevision: ++revision };
      if (method === 'turn/interrupt') return {};
      throw new Error(`An ineligible goal control admitted ${method}`);
    };
    const queries = registerSessionQueryHandlers(registry, { sessions: f.service, state: f.state, configRoot: config });
    const prepare = registry.lookup('goal:prepare-objective')!;
    const before = readdirSync(config).filter(name => name.startsWith('goal-objective'));
    const failure = await assertRejects(async () => prepare({ role: 'main', senderId: 1, channel: 'goal:prepare-objective', args: [{ sessionId: 'thread', input: { text: 'x'.repeat(4001), clientRequestId: 'blocked-intent' } }] }), 'an ineligible task cannot own prepared goal files') as IpcHandlerError;
    assertEqual(failure.code, 'GOAL_UNAVAILABLE', 'the bounded-task refusal is explicit');
    const mutations: JsonObject[] = [{ objective: 'Edited objective' }, { tokenBudget: null }, { status: 'active' }, { objective: 'Explicit objective', submit: true, clientRequestId: 'blocked-submit' }];
    for (const value of mutations) {
      await assertRejects(() => queries.setGoal('thread', value), 'creation, edits, budget changes and resume stay outside the bounded task');
    }
    assertDeepEqual(readdirSync(config).filter(name => name.startsWith('goal-objective')), before, 'rejected pursuit produces no objective directory or intent binding');
    assert(f.client.calls.every(call => ['engine/readSessionSummary', 'session/goal'].includes(call.method)), 'eligibility never resolves a provider, initializes a model or submits work');
    if (kind === 'friend' || kind === 'live-scope') assertEqual(f.client.calls.length, 0, 'known local task boundaries refuse before even reading the engine');
    await queries.goal('thread');
    await queries.setGoal('thread', { status: 'paused', expectedGoalId: 'generation-one', expectedGoalRevision: revision });
    if (f.state.liveSession('thread')) {
      f.state.markTurnRunning('thread', 'legacy-turn');
      await f.service.interrupt('thread', 'legacy-turn');
      assert(f.client.calls.some(call => call.method === 'turn/interrupt'), 'Stop remains available for a running legacy bounded-task goal');
    }
    await queries.clearGoal('thread', { expectedGoalId: 'generation-one', expectedGoalRevision: revision });
    assert(f.client.calls.some(call => call.method === 'session/setGoal'), 'legacy pause remains available');
    assert(f.client.calls.some(call => call.method === 'session/clearGoal'), 'legacy clear remains available');
    await f.service.shutdown(); f.forwarder.close();
  }
});

h.test('ordinary ownership eligibility permits goal preparation independently of the runtime feature flag', async () => {
  const f = fixture(), registry = new ChannelRegistry();
  f.state.rememberSession('thread', 'live', { config: { goal: false } }, { source: 'custom', selection: 'custom:test' });
  f.client.respond = method => { if (method === 'engine/readSessionSummary') return { session: null }; assertEqual(method, 'session/goal', 'preparation checks only provider-free authoritative ownership'); return { goalPursuitEligible: true, goalRevision: 0 }; };
  registerSessionQueryHandlers(registry, { sessions: f.service, state: f.state, configRoot: f.configRoot });
  const result = object(await registry.lookup('goal:prepare-objective')!({ role: 'main', senderId: 1, channel: 'goal:prepare-objective', args: [{ sessionId: 'thread', input: { text: 'x'.repeat(4001) } }] }));
  assert(typeof result.preparationId === 'string', 'an ordinary root may prepare while automatic model goal tools are disabled');
  assertEqual(result.displayText, result.objective, 'the full final file reference is the presentation source');
  assertDeepEqual(f.client.calls.map(call => call.method), ['engine/readSessionSummary', 'session/goal'], 'lazy ordinary eligibility needs no saved rollout, provider auth or model turn');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('immutable accepted preparations replay their original display DTO after display policy changes', async () => {
  const config = root(), input = { text: 'x'.repeat(4001), clientRequestId: 'legacy-display-receipt' };
  const objectives = new GoalObjectives(config), current = await objectives.prepare('thread', input);
  const path = join(config, 'goal-objective-intents', createHash('sha256').update('thread').digest('hex'), createHash('sha256').update(input.clientRequestId).digest('hex') + '.json');
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  binding.prepared.displayText = 'x'.repeat(3999) + '…';
  writeFileSync(path, JSON.stringify(binding), { mode: 0o600 });
  await objectives.markSubmitting('thread', current.preparationId!, current.objective);
  await objectives.accept('thread', current.preparationId!, current.objective);
  const retry = await new GoalObjectives(config).prepare('thread', input);
  assertDeepEqual(retry, binding.prepared, 'an accepted old receipt retains its exact immutable objective/display/path fingerprint');
  assertEqual(retry.objective, current.objective, 'display compatibility never changes the authoritative owned-file reference');
  const next = await new GoalObjectives(config).prepare('thread', { ...input, clientRequestId: 'new-display-receipt' });
  assertEqual(next.displayText, next.objective, 'only a new reviewed intent uses the full current reference display');
});

h.test('attachments use one directory, preserve URL references, and discard only their own draft', async () => {
  const config = root(), objectives = new GoalObjectives(config);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const prepared = await objectives.prepare('thread', { text: 'Use [$Files](app://files)', selectedText: 'Selected text', pastes: [{ text: 'Complete paste\nSecond line' }], images: [{ dataUrl: `data:image/png;base64,${png.toString('base64')}` }, { url: 'https://example.com/image.jpg' }] });
  assert(prepared.objective.includes('Use $Files\n\nSelected text'), 'display labels and selected text join objective');
  assert(prepared.objective.includes('https://example.com/image.jpg'), 'URL remains a URL');
  const threadDir = join(config, 'goal-objectives', readdirSync(join(config, 'goal-objectives'))[0]!);
  const draftDir = join(threadDir, readdirSync(threadDir)[0]!);
  assertEqual(readdirSync(threadDir).length, 1, 'one lazy draft directory');
  assert(readFileSync(join(draftDir, 'image-1.png')).equals(png), 'original image bytes preserved');
  assertEqual(readFileSync(join(draftDir, 'paste-1.txt'), 'utf8'), 'Complete paste\nSecond line', 'full paste stored');
  writeFileSync(join(threadDir, 'unrelated.txt'), 'keep');
  await objectives.discard('thread', prepared.preparationId!);
  assertDeepEqual(readdirSync(threadDir), ['unrelated.txt'], 'cleanup is scoped to its preparation');
});

h.test('local PNG and data JPEG attachments preserve bytes, extension and MIME checks', async () => {
  const config = root(), objectives = new GoalObjectives(config);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]), jpeg = Buffer.from([255, 216, 255, 224, 0, 16]);
  const source = join(config, 'source.png'); writeFileSync(source, png);
  const prepared = await objectives.prepare('thread', { text: 'Use these exact images', images: [
    { path: source, mimeType: 'image/png' }, { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, mimeType: 'image/jpeg' },
  ] });
  const threadDir = join(config, 'goal-objectives', readdirSync(join(config, 'goal-objectives'))[0]!);
  const draftDir = join(threadDir, readdirSync(threadDir)[0]!);
  assert(readFileSync(join(draftDir, 'image-1.png')).equals(png), 'local PNG bytes retained');
  assert(readFileSync(join(draftDir, 'image-2.jpg')).equals(jpeg), 'data JPEG bytes retain their image extension');
  await assertRejects(() => objectives.prepare('thread', { text: '', images: [{ path: source, mimeType: 'image/jpeg' }] }), 'declared MIME cannot reinterpret PNG bytes');
  await objectives.discard('thread', prepared.preparationId!);
  assert(readFileSync(source).equals(png), 'cleanup never deletes the source image');
});

h.test('goal images preserve generic safe filename extensions and original data bytes', async () => {
  const config = root(), objectives = new GoalObjectives(config);
  for (const one of vector.goalImageExtensions) {
    const bytes = one.dataSubtype === 'jpeg' ? Buffer.from([255, 216, 255, 224, 0, 16]) : one.dataSubtype === 'png' ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]) : Buffer.from('Opaque admitted image bytes\n');
    const source = join(config, one.sourceName ?? 'input-file'); writeFileSync(source, bytes);
    const image = one.dataSubtype ? { dataUrl: `data:image/${one.dataSubtype};base64,${bytes.toString('base64')}`, filename: one.filename }
      : { path: source, filename: one.filename, mimeType: one.mimeType === null ? undefined : one.mimeType ?? 'image/x-unrecognized-format' };
    const prepared = await objectives.prepare('thread', { text: '', images: [image] });
    const manifest = await objectives.ownedResources('thread', prepared.preparationId!, prepared.objective);
    assertEqual(manifest.files[0]?.name, `image-1.${one.expected}`, 'safe final suffix or sanitized subtype determines only the owned name');
    const path = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'), prepared.preparationId!, String(manifest.files[0]?.name));
    assert(readFileSync(path).equals(bytes), 'unknown image formats remain exact opaque bytes');
    assertDeepEqual(await new GoalObjectives(config).ownedResources('thread', prepared.preparationId!, prepared.objective), manifest, 'generic safe suffix survives private descriptor reload');
    await objectives.discard('thread', prepared.preparationId!);
    assert(readFileSync(source).equals(bytes), 'the materializer never rewrites its source');
  }
  const percent = await objectives.prepare('thread', { text: '', images: [{ dataUrl: 'data:image/x-custom,%3Cimage%3E%F0%9F%98%80%3C%2Fimage%3E' }] });
  const percentManifest = await objectives.ownedResources('thread', percent.preparationId!, percent.objective);
  const percentPath = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'), percent.preparationId!, percentManifest.files[0]!.name);
  assertEqual(readFileSync(percentPath, 'utf8'), '<image>😀</image>', 'percent-encoded image text is decoded without transcoding its content');
  await assertRejects(() => objectives.prepare('thread', { text: '', images: [{ dataUrl: 'data:image/x-custom,%FF' }] }), 'malformed percent encoding is explicit');
});

h.test('large owned paste files bypass renderer restoration limits without truncating their bytes', async () => {
  const config = root(), objectives = new GoalObjectives(config);
  const directory = join(config, 'pasted-text', '00000000-0000-4000-8000-000000000000'); mkdirSync(directory, { recursive: true });
  const path = join(directory, 'pasted-text.txt'), text = 'Full pasted evidence 😀\n'.repeat(4000); writeFileSync(path, text);
  const prepared = await objectives.prepare('thread', { text: '', pastes: [{ path }] });
  const attachment = prepared.objective.replace('Read the attached text: ', '');
  assertEqual(readFileSync(attachment, 'utf8'), text, 'complete paste stored in its independent goal-owned file');
  await assertRejects(() => objectives.prepare('thread', { text: '', pastes: [{ path: '/etc/passwd' }] }), 'forged pasted-text path refused');
  await objectives.discard('thread', prepared.preparationId!);
  assertEqual(readFileSync(path, 'utf8'), text, 'discard never deletes original attachments owned by another subsystem');
});

h.test('materialization failure cleans only the newly owned directory and rejects symlink escape', async () => {
  const config = root(), objectives = new GoalObjectives(config);
  await assertRejects(() => objectives.prepare('thread', { text: '', pastes: [{ text: 'first' }], images: [{ dataUrl: 'data:image/png;base64,YQ==' }] }), 'bad image content rejected');
  const threadDir = join(config, 'goal-objectives', readdirSync(join(config, 'goal-objectives'))[0]!);
  assertEqual(readdirSync(threadDir).length, 0, 'failed preparation removed');
  const target = join(root(), 'outside.md'); writeFileSync(target, 'outside');
  const prepared = await objectives.prepare('thread', { text: 'x'.repeat(4001) });
  const path = prepared.objective.split(': ').slice(1).join(': '); rmSync(path); symlinkSync(target, path);
  await assertRejects(() => objectives.ownedResources('thread', prepared.preparationId!, prepared.objective), 'symlink outside root rejected');
});

h.test('saved goal reads and mutations do not initialize a provider or schedule a host turn', async () => {
  const f = fixture(); f.state.forgetSession('thread');
  f.client.respond = method => method === 'engine/readSessionSummary' ? { session: { id: 'thread' } } : method === 'session/clearGoal' ? { goalCleared: true, goalRevision: 3 } : { threadGoal: goal(), goalRevision: method === 'session/goal' ? 1 : 2, goalAdmission: 'deferred', goalPursuitEligible: true };
  const queries = new SessionQueries(f.service, f.state, root());
  await queries.goal('thread'); await queries.setGoal('thread', { objective: 'Edited goal', tokenBudget: null, expectedGoalId: 'generation-one', expectedGoalRevision: 1 }); await queries.clearGoal('thread', { expectedGoalId: 'generation-one', expectedGoalRevision: 2 });
  assertDeepEqual(f.client.calls.map(call => call.method), ['session/goal', 'engine/readSessionSummary', 'session/goal', 'session/setGoal', 'session/clearGoal'], 'only saved named facades');
  assertDeepEqual(f.client.calls.find(call => call.method === 'session/setGoal')?.params, { threadId: 'thread', origin: 'user', objective: 'Edited goal', tokenBudget: null, expectedGoalId: 'generation-one', expectedGoalRevision: 1 }, 'tri-state budget and user provenance cross the wire');
  assertEqual(object(f.client.calls.find(call => call.method === 'session/clearGoal')?.params).expectedGoalRevision, 2, 'clear retains its observed generation revision');
  const admitted = f.client.calls.length;
  await assertRejects(() => queries.setGoal('thread', { objective: 'Stale', expectedGoalRevision: -1 }), 'invalid revision rejected');
  assertEqual(f.client.calls.length, admitted, 'invalid preconditions do not reach the engine');
  assertEqual(f.state.liveSession('thread'), undefined, 'no provider session created');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('invalid goal controls reject before mutation or provider activation in live and saved conversations', async () => {
  for (const live of [false, true]) {
    const f = fixture();
    if (!live) f.state.forgetSession('thread');
    const queries = new SessionQueries(f.service, f.state, f.configRoot);
    f.client.respond = method => {
      if (method === 'engine/readSessionSummary') return { session: { id: 'thread' } };
      if (method === 'session/goal') return { threadGoal: null, goalRevision: 0, goalPursuitEligible: true };
      throw new Error(`Invalid controls reached ${method}`);
    };
    const invalid: JsonObject[] = [
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'].map(tokenBudget => ({ tokenBudget })),
      ...['', ' ', '😀'.repeat(4001)].map(objective => ({ objective })),
      ...['complete', 'blocked', 'usage_limited', 'budget_limited'].map(status => ({ status })),
      { expectedGoalRevision: -1, status: 'paused' },
      { expectedGoalRevision: 0.5, status: 'paused' },
      { expectedGoalRevision: Number.MAX_SAFE_INTEGER + 1, status: 'paused' },
      { submit: true, objective: 'Missing stable submission identity' },
    ];
    try {
      for (const value of invalid) {
        const failure = await assertRejects(() => queries.setGoal('thread', value), 'invalid controls are refused') as IpcHandlerError;
        assertEqual(failure.code, 'BAD_REQUEST', 'invalid user controls retain a typed refusal');
      }
      assert(f.client.calls.every(call => ['engine/readSessionSummary', 'session/goal'].includes(call.method)), 'validation can observe ownership but never admits a mutation or model operation');
      assertEqual(f.state.liveSession('thread'), live ? 'live' : undefined, 'validation does not activate or replace a provider binding');
      assertEqual(f.state.runningTurnId('thread'), undefined, 'invalid controls never acquire a running turn');
      assertDeepEqual(readdirSync(f.configRoot).filter(name => name.startsWith('goal-objective')), [], 'invalid controls create no private objective resources');
    } finally { await f.service.shutdown(); f.forwarder.close(); }
  }
});

h.test('saved friend goal read pause and clear use only provider-free named controls', async () => {
  const f = fixture(); f.state.forgetSession('thread');
  bindFriendSession(f.configRoot, 'thread', { accountId: 'account', friendshipId: 'friendship', friendUserId: 'sender' });
  const queries = new SessionQueries(f.service, f.state, f.configRoot);
  f.client.respond = (method, params) => {
    const input = object(params);
    assertEqual(input.threadId, 'thread', 'saved friend controls use the durable conversation');
    assertEqual(input.sessionId, undefined, 'saved stopping does not invent a live provider session');
    if (method === 'session/goal') return { threadGoal: goal(), goalRevision: 1, goalPursuitEligible: false };
    if (method === 'session/setGoal') {
      assertDeepEqual(input, { threadId: 'thread', origin: 'user', status: 'paused', expectedGoalId: 'generation-one', expectedGoalRevision: 1 }, 'pause retains exact observed source guards');
      return { threadGoal: goal('generation-one', 'paused'), goalRevision: 2 };
    }
    if (method === 'session/clearGoal') {
      assertDeepEqual(input, { threadId: 'thread', origin: 'user', expectedGoalId: 'generation-one', expectedGoalRevision: 2 }, 'clear remains bound to the paused generation');
      return { goalCleared: true, goalRevision: 3 };
    }
    throw new Error(`Saved friend control attempted ${method}`);
  };
  try {
    assertEqual(object((await queries.goal('thread')).goal).status, 'active', 'an existing friend goal remains readable');
    assertEqual(object(object(await queries.setGoal('thread', { status: 'paused', expectedGoalId: 'generation-one', expectedGoalRevision: 1 })).goal).status, 'paused', 'an existing friend goal remains pausable');
    const cleared = object(await queries.clearGoal('thread', { expectedGoalId: 'generation-one', expectedGoalRevision: 2 }));
    assertEqual(cleared.goal, null, 'clear installs an explicit null snapshot');
    assertEqual(cleared.cleared, true, 'clear retains the acknowledged outcome');
    assertDeepEqual(f.client.calls.map(call => call.method), ['session/goal', 'session/setGoal', 'session/clearGoal'], 'no provider setup or host turn is involved');
    assertEqual(f.state.liveSession('thread'), undefined, 'saved friend stopping creates no provider binding');
  } finally { await f.service.shutdown(); f.forwarder.close(); }
});

h.test('a delayed goal read cannot replace update and clear pushes in live or saved scope', async () => {
  for (const live of [false, true]) {
    const f = fixture(), entered = deferred<void>(), response = deferred<JsonObject>();
    if (!live) f.state.forgetSession('thread');
    const queries = new SessionQueries(f.service, f.state, f.configRoot);
    f.client.respond = (method, params) => {
      assertEqual(method, 'session/goal', 'observation uses the provider-free named goal read');
      assertEqual(object(params).threadId, 'thread', 'read retains its durable conversation address');
      assertEqual(object(params).sessionId, live ? 'live' : undefined, 'only an existing live binding is attached');
      entered.resolve(); return response.promise;
    };
    try {
      const pending = queries.goal('thread'); await entered.promise;
      const address = live ? { sessionId: 'live' } : { threadId: 'thread' };
      f.pump.receive({ type: 'rawSessionEvent', params: { ...address, event: { submissionId: '', threadGoal: goal('generation-one', 'paused'), goalRevision: 2 } } }, 1);
      f.pump.receive({ type: 'rawSessionEvent', params: { ...address, event: { submissionId: '', goalCleared: true, goalRevision: 3 } } }, 1);
      response.resolve({ threadGoal: goal(), goalRevision: 1 });
      const result = await pending;
      assertEqual(result.goal, null, 'the actual slow read returns the newer clear');
      assertEqual(result.goalRevision, 3, 'the slow response cannot regress authoritative ordering');
      const updates = f.emitted.filter(row => row.channel === 'goal:updated').map(row => object(row.payload));
      assertDeepEqual(updates.map(row => [row.sessionId, row.goalRevision]), [['thread', 2], ['thread', 3]], 'secondary consumers receive both revisions in order');
      assertEqual(object(updates[0]!.goal).status, 'paused', 'the preceding update remains visible');
      assertEqual(updates[1]!.goal, null, 'the final clear is explicitly nullable');
      assertEqual(f.state.workflows.goal('thread')?.goal, null, 'shared projection retains the clear after the read settles');
      assertEqual(f.client.calls.length, 1, 'observation neither retries nor activates a provider');
    } finally { await f.service.shutdown(); f.forwarder.close(); }
  }
});

h.test('saved planning and question recovery read their documents without provider activation', async () => {
  const f = fixture(); f.state.forgetSession('thread');
  f.client.respond = method => ({ planning: planning(), ...(method === 'session/readPlanDocument' ? { document: { planId: 'plan', revision: 1, content: '# Plan', path: '/owned/PLAN.md' } } : {}) });
  const plans = new SessionPlanning(f.service, f.state);
  await plans.get('thread'); await plans.plans('thread'); await plans.readDocument('thread', { planId: 'plan', revision: 1 }); await f.service.pendingPlanningInput('thread');
  assertDeepEqual(f.client.calls.map(call => call.method), ['session/collaborationMode', 'session/plans', 'session/readPlanDocument', 'session/plans'], 'only provider-free named reads');
  assert(f.client.calls.every(call => object(call.params).threadId === 'thread' && !Object.hasOwn(object(call.params), 'sessionId')), 'saved address stays provider-free');
  assertEqual(f.state.liveSession('thread'), undefined, 'observation creates no live inference owner');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('inherited objective previews use current engine ownership and ignore accounting-only revisions', async () => {
  for (const changed of [false, true]) {
    const calls: { method: string; params: JsonObject }[] = []; let reads = 0;
    const reference = 'Read the complete goal objective from this Klaus-owned file: /trusted/source-preparation/objective.md';
    const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {},
      readGoalSnapshot: async (id: string) => {
        const reply = await service.requestThreadWorkflow(id, 'session/goal');
        return goalSnapshot(reply.threadGoal ?? null, reply.goalRevision)!;
      },
      requestThreadWorkflow: async (id: string, method: string, params: JsonObject = {}) => {
      assertEqual(id, 'fork', 'preview remains bound to its current fork'); calls.push({ method, params });
      if (method === 'session/goal') return { threadGoal: { ...goal('inherited'), threadId: 'fork', objective: changed && reads++ > 0 ? 'Changed source' : reference }, goalRevision: calls.length };
      assertEqual(method, 'session/readGoalObjective', 'one provider-free named reader owns inherited resources');
      assertDeepEqual(params, { expectedGoalId: 'inherited' }, 'renderer paths and source-owner hints confer no authority');
      return { goalId: 'inherited', objective: 'Complete inherited objective 😀\nSecond line' };
    } } as unknown as SessionService;
    const queries = new SessionQueries(service, new HostState(), root());
    if (changed) await assertRejects(() => queries.readGoalObjective('fork', reference), 'same-generation source edits invalidate an outstanding preview');
    else assertEqual((await queries.readGoalObjective('fork', reference)).content, 'Complete inherited objective 😀\nSecond line', 'a counter-only update does not truncate or reject the full preview');
    assertDeepEqual(calls.map(call => call.method), ['session/goal', 'session/readGoalObjective', 'session/goal'], 'preview never activates a model or creates a host path grant');
  }
});

h.test('goal conflict replies stay typed while unknown transport outcomes remain retryable', async () => {
  const f = fixture(), queries = new SessionQueries(f.service, f.state, root());
  f.client.respond = method => { if (method === 'engine/readSessionSummary') return { session: { id: 'thread' } }; if (method === 'session/goal') return { goalPursuitEligible: true }; throw { kind: 'server', code: -32000, message: 'Goal revision conflict', data: { code: 'GOAL_CONFLICT', feature: 'goal' } }; };
  const conflict = await assertRejects(() => queries.setGoal('thread', { objective: 'Edited', expectedGoalRevision: 1 }), 'definitive stale goal edit') as { code?: string };
  assertEqual(conflict.code, 'GOAL_CONFLICT', 'the UI can retire only a definitively rejected intent');
  f.client.respond = method => { if (method === 'engine/readSessionSummary') return { session: { id: 'thread' } }; if (method === 'session/goal') return { goalPursuitEligible: true }; throw { kind: 'timeout', method: 'session/setGoal' }; };
  const unknown = await assertRejects(() => queries.setGoal('thread', { objective: 'Edited', expectedGoalRevision: 1 }), 'unknown admission') as { code?: string; kind?: string };
  assertEqual(unknown.kind, 'timeout', 'transport uncertainty remains distinguishable');
  assertEqual(unknown.code, undefined, 'a timeout never fabricates a definitive conflict');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('owned goal preparation requires a known local conversation without loading its provider', async () => {
  const f = fixture(); f.state.forgetSession('thread');
  f.client.respond = method => { assertEqual(method, 'engine/readSessionSummary', 'provider-free existence read'); return { session: null }; };
  await assertRejects(() => f.service.assertExistingWorkflowThread('peer-thread'), 'an arbitrary peer identity is not a local conversation');
  assertDeepEqual(f.client.calls.map(call => call.method), ['engine/readSessionSummary'], 'no session activation or file write was admitted');
  assertEqual(f.state.liveSession('peer-thread'), undefined, 'unknown IDs do not acquire a local binding');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('different goal conversations mutate independently while one conversation stays serialized', async () => {
  const gate = deferred<JsonObject>(), calls: string[] = [];
  const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestThreadWorkflow: async (id: string) => { calls.push(id); return id === 'A' ? gate.promise : { goalCleared: true, goalRevision: 1 }; } } as unknown as SessionService;
  const queries = new SessionQueries(service, new HostState(), root());
  const first = queries.clearGoal('A'), second = queries.clearGoal('A'), other = await queries.clearGoal('B');
  assertEqual(object(other).cleared, true, 'B does not wait for A');
  assertDeepEqual(calls, ['A', 'B'], 'only the first A admitted');
  gate.resolve({ goalCleared: true, goalRevision: 1 }); await Promise.all([first, second]);
  assertDeepEqual(calls, ['A', 'B', 'A'], 'same-conversation writes retain order');
});

h.test('owned manifests use persisted exact bytes and survive accepted or uncertain restart retries', async () => {
  const config = root(), objectives = new GoalObjectives(config);
  const prepared = await objectives.prepare('thread', { text: 'x'.repeat(4001), pastes: [{ text: 'Exact paste 😀' }] });
  const manifest = await objectives.ownedResources('thread', prepared.preparationId!, prepared.objective);
  assertDeepEqual(manifest.files.map(file => file.name), ['paste-1.txt', 'objective.md'], 'only private generated resource names enter the manifest');
  const directory = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'), prepared.preparationId!);
  for (const file of manifest.files) {
    const bytes = readFileSync(join(directory, file.name));
    assertEqual(file.sizeBytes, bytes.length, 'actual persisted byte size');
    assertEqual(file.sha256, createHash('sha256').update(bytes).digest('hex'), 'lowercase exact persisted digest');
  }
  assertEqual(statSync(join(directory, 'preparation.json')).mode & 0o777, 0o600, 'private immutable descriptor permissions');
  assertDeepEqual(await new GoalObjectives(config).ownedResources('thread', prepared.preparationId!, prepared.objective), manifest, 'fresh host reloads only the private descriptor');
  await assertRejects(() => new GoalObjectives(config).ownedResources('other-thread', prepared.preparationId!, prepared.objective), 'another thread cannot adopt preparation identity');
  assertEqual(await objectives.markSubmitting('thread', prepared.preparationId!, prepared.objective), true, 'first attempt writes an uncertainty marker');
  const restarted = new GoalObjectives(config);
  await restarted.discard('thread', prepared.preparationId!);
  assertDeepEqual(await restarted.ownedResources('thread', prepared.preparationId!, prepared.objective), manifest, 'crash before acknowledgement cannot clean possibly admitted files');
  await restarted.accept('thread', prepared.preparationId!, prepared.objective);
  await new GoalObjectives(config).discard('thread', prepared.preparationId!);
  assertDeepEqual(await new GoalObjectives(config).ownedResources('thread', prepared.preparationId!, prepared.objective), manifest, 'accepted resources retain the exact retry fingerprint after restart');
  writeFileSync(join(directory, 'paste-1.txt'), 'Tampered bytes');
  await assertRejects(() => new GoalObjectives(config).ownedResources('thread', prepared.preparationId!, prepared.objective), 'changed files cannot gain resource authority');
  const descriptor = join(directory, 'preparation.json'), outside = join(config, 'outside-descriptor.json');
  writeFileSync(outside, readFileSync(descriptor), { mode: 0o600 }); rmSync(descriptor); symlinkSync(outside, descriptor);
  await assertRejects(() => new GoalObjectives(config).ownedResources('thread', prepared.preparationId!, prepared.objective), 'a descriptor symlink cannot create private resource authority');
  assert(readFileSync(outside).length > 0, 'descriptor validation preserves unrelated source files');
});

h.test('equal conversation and goal identities keep prepared resources inside independent host roots', async () => {
  const roots = [root(), root()], requests: JsonObject[][] = [[], []];
  const sessionId = 'same-conversation', goalId = 'same-generation';
  const full = 'Preserve the complete objective 😀\n'.repeat(300), paste = 'Complete pasted evidence 😀\n'.repeat(2000);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const hosts = roots.map((config, index) => {
    const request = async (id: string, method: string, params: JsonObject) => {
      assertEqual(id, sessionId, 'each host retains the same durable conversation identity');
      assertEqual(method, 'session/setGoal', 'acceptance uses only the named goal mutation');
      requests[index]!.push(params);
      return { threadGoal: { ...goal(goalId), threadId: sessionId, objective: params.objective }, goalRevision: 1, goalAdmission: 'scheduled' };
    };
    const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestThreadWorkflow: request, requestActiveWorkflow: request } as unknown as SessionService;
    return new SessionQueries(service, new HostState(), config);
  });
  const prepared = await Promise.all(hosts.map(host => host.objectives.prepare(sessionId, {
    text: full, pastes: [{ text: paste }], images: [{ dataUrl: `data:image/png;base64,${png.toString('base64')}` }],
  })));
  const directories = prepared.map((one, index) => join(roots[index]!, 'goal-objectives', createHash('sha256').update(sessionId).digest('hex'), one.preparationId!));
  const originals = directories.map(directory => readdirSync(directory).map(name => ({ name, sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') })));
  for (const index of [0, 1]) {
    const own = hosts[index]!, other = prepared[1 - index]!;
    await assertRejects(() => own.objectives.ownedResources(sessionId, other.preparationId!, other.objective), 'equal conversation identity grants no foreign private preparation');
    await assertRejects(() => own.objectives.discard(sessionId, other.preparationId!), 'one host cannot discard another host draft');
    const result = object(await own.setGoal(sessionId, { ...prepared[index]!, submit: true, clientRequestId: `same-host-intent-${index}`, expectedGoalId: null }));
    assertEqual(object(result.goal).goalId, goalId, 'both hosts may legitimately receive an equal engine generation');
    const manifest = object(requests[index]![0]!.ownedResources);
    assertEqual(manifest.preparationId, prepared[index]!.preparationId, 'only that host private descriptor supplies resources');
  }
  for (const index of [0, 1]) {
    const own = new GoalObjectives(roots[index]!), other = prepared[1 - index]!;
    await assertRejects(() => own.ownedResources(sessionId, other.preparationId!, other.objective), 'an equal accepted goal generation cannot cross a host root after restart');
    await assertRejects(() => own.discard(sessionId, other.preparationId!), 'accepted foreign identities cannot delete another root');
    const directory = directories[index]!, manifest = await own.ownedResources(sessionId, prepared[index]!.preparationId!, prepared[index]!.objective);
    assertDeepEqual(manifest.files.map(file => file.name), ['paste-1.txt', 'image-1.png', 'objective.md'], 'each host reopens its complete owned file set');
    assertEqual(readFileSync(join(directory, 'paste-1.txt'), 'utf8'), paste, 'foreign attempts preserve every paste byte');
    assert(readFileSync(join(directory, 'image-1.png')).equals(png), 'foreign attempts preserve every image byte');
    assertEqual(readFileSync(join(directory, 'objective.md'), 'utf8').split('\n\n')[0], full.trim(), 'each root retains its own complete objective body');
    assert(prepared[index]!.objective.includes(directory), 'each materialized objective names its actual host root');
    assertDeepEqual(readdirSync(directory).filter(name => name !== 'admission.json').map(name => ({ name, sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') })), originals[index], 'acceptance changes only its admission marker, never another original file');
  }
});

h.test('concurrent goal preparations have a bounded admission lane and release it after completion', async () => {
  const objectives = new GoalObjectives(root());
  const preparing = Array.from({ length: vector.ownedResourceLimits.maxConcurrentPreparations }, () => objectives.prepare('thread', { text: 'x'.repeat(4001) }));
  const rejected = await assertRejects(() => objectives.prepare('thread', { text: 'Another draft' }), 'a fifth concurrent materialization is explicit') as IpcHandlerError;
  assertEqual(rejected.code, 'GOAL_PREPARATIONS_BUSY', 'resource admission stays bounded before file creation');
  const prepared = await Promise.all(preparing);
  assertEqual((await objectives.prepare('thread', { text: 'After completion' })).objective, 'After completion', 'finished operations release their lane');
  for (const one of prepared) await objectives.discard('thread', one.preparationId!);
});

if (process.platform !== 'win32') h.test('nonregular goal attachment sources reject without waiting for a pipe writer', async () => {
  const config = root(), pipe = join(config, 'image-pipe');
  const created = spawnSync('mkfifo', [pipe], { encoding: 'utf8' });
  assertEqual(created.status, 0, 'the isolated POSIX pipe fixture exists');
  const objectives = new GoalObjectives(config);
  let timer: NodeJS.Timeout | undefined, expired = false;
  try {
    const failure = await assertRejects(() => Promise.race([
      objectives.prepare('thread', { text: 'Inspect image', images: [{ path: pipe }] }),
      new Promise<never>((...handlers) => { timer = setTimeout(() => { expired = true; handlers[1](new Error('Nonregular attachment read stalled')); }, 500); }),
    ]), 'a named pipe is not a regular attachment') as IpcHandlerError;
    assertEqual(expired, false, 'safe open returns before a writer appears');
    assertEqual(failure.code, 'BAD_REQUEST', 'nonregular files are refused at the boundary');
  } finally { if (timer) clearTimeout(timer); }
});

h.test('goal owned file limits reject the whole preparation and preserve source files', async () => {
  const config = root(), objectives = new GoalObjectives(config);
  const accepted = await objectives.prepare('thread', { text: '', pastes: Array.from({ length: vector.ownedResourceLimits.maxFiles - 1 }, () => ({ text: 'a' })) });
  const manifest = await objectives.ownedResources('thread', accepted.preparationId!, accepted.objective);
  assertEqual(manifest.files.length, vector.ownedResourceLimits.maxFiles, 'objective.md counts toward the exact 256-file boundary');
  await objectives.discard('thread', accepted.preparationId!);
  await assertRejects(() => objectives.prepare('thread', { text: '', pastes: Array.from({ length: vector.ownedResourceLimits.maxFiles }, () => ({ text: 'a' })) }), 'the 257th owned file rejects the whole draft');
  const threadRoot = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'));
  assertDeepEqual(readdirSync(threadRoot), [], 'a limit rejection leaves no partial preparation');
});

h.test('attachment-only goal submission forwards private manifests and retains accepted bytes', async () => {
  for (const kind of ['paste', 'image']) {
    const config = root(), calls: JsonObject[] = [], source = join(config, 'source.png');
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]); writeFileSync(source, png);
    let currentObjective = '';
    const admit = async (id: string, method: string, params: JsonObject) => {
      assertEqual(id, 'thread', 'prepared objective stays bound to its target thread');
      assertEqual(method, 'session/setGoal', 'one named goal admission'); calls.push(params);
      if (typeof params.objective === 'string') currentObjective = params.objective;
      return { threadGoal: { ...goal(), objective: currentObjective }, goalRevision: calls.length, goalAdmission: 'scheduled' };
    };
    const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestThreadWorkflow: admit, requestActiveWorkflow: admit } as unknown as SessionService;
    const queries = new SessionQueries(service, new HostState(), config);
    const prepared = await queries.objectives.prepare('thread', kind === 'paste' ? { text: '', pastes: [{ text: 'Complete paste-only objective' }] } : { text: '', images: [{ path: source }] });
    await queries.setGoal('thread', { ...prepared, submit: true, clientRequestId: `attachment-${kind}`, expectedGoalId: null, ownedResources: { preparationId: 'forged', files: [{ name: 'secrets', sizeBytes: 0, sha256: '0'.repeat(64) }] } } as unknown as JsonObject);
    assertEqual(calls[0]?.submit, true, 'attachment-only composer submission is a real objective intent');
    assertEqual(calls[0]?.clientRequestId, `attachment-${kind}`, 'the explicit objective keeps its stable receipt identity');
    const manifest = object(calls[0]?.ownedResources), files = manifest.files as JsonObject[];
    assertEqual(manifest.preparationId, prepared.preparationId, 'renderer-supplied manifest is ignored');
    assertDeepEqual(files.map(file => file.name), [kind === 'paste' ? 'paste-1.txt' : 'image-1.png'], 'only generated attachment is admitted');
    const owned = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'), prepared.preparationId!, String(files[0]?.name));
    assert(readFileSync(owned).equals(kind === 'paste' ? Buffer.from('Complete paste-only objective') : png), 'accepted attachment-only bytes remain readable');
    assert(readFileSync(source).equals(png), 'source image remains intact');
    await queries.setGoal('thread', { tokenBudget: null });
    assertEqual(calls[1]?.ownedResources, undefined, 'budget-only changes never carry a resource manifest');
  }
});

h.test('definite goal rejection cleans only its draft while a lost acknowledgement retains restart resources', async () => {
  for (const uncertain of [false, true]) {
    const config = root(), requests: JsonObject[] = []; let admitted = 0;
    const request = async (id: string, method: string, params: JsonObject) => {
      assertEqual(id, 'thread', 'recovery retains the target thread');
      assertEqual(method, 'session/setGoal', 'recovery uses the named goal facade');
      requests.push(params);
      if (requests.length === 1) {
        if (uncertain) { admitted++; throw { kind: 'timeout', method: 'session/setGoal' }; }
        throw new IpcHandlerError('GOAL_CONFLICT', 'The observed goal changed');
      }
      assertDeepEqual(params, requests[0], 'restart retries retain the exact original guards and owned-resource fingerprint');
      return { threadGoal: { ...goal(), objective: params.objective }, goalRevision: 1, goalAdmission: 'scheduled' };
    };
    const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestThreadWorkflow: request, requestActiveWorkflow: request } as unknown as SessionService;
    const queries = new SessionQueries(service, new HostState(), config);
    const unrelated = await queries.objectives.prepare('thread', { text: '', pastes: [{ text: 'Unrelated draft' }] });
    const prepared = await queries.objectives.prepare('thread', { text: '', pastes: [{ text: 'Submission evidence' }] });
    const manifest = await queries.objectives.ownedResources('thread', prepared.preparationId!, prepared.objective);
    const intent = { objective: prepared.objective, preparationId: prepared.preparationId!, submit: true, clientRequestId: 'original-submission', expectedGoalId: null, expectedGoalRevision: 0 };
    await assertRejects(() => queries.setGoal('thread', intent), 'the failed admission remains explicit');
    const restarted = new GoalObjectives(config);
    assert((await restarted.ownedResources('thread', unrelated.preparationId!, unrelated.objective)).files.length > 0, 'unrelated preparation survives');
    if (uncertain) {
      await restarted.discard('thread', prepared.preparationId!);
      assertDeepEqual(await restarted.ownedResources('thread', prepared.preparationId!, prepared.objective), manifest, 'ambiguous outcomes retain immutable restart metadata and bytes');
      const freshQueries = new SessionQueries(service, new HostState(), config);
      await freshQueries.setGoal('thread', intent);
      assertEqual(admitted, 1, 'the exact retried receipt observes the original admission');
    } else await assertRejects(() => restarted.ownedResources('thread', prepared.preparationId!, prepared.objective), 'a proven first-attempt rejection removed exactly its owned draft');
  }
});

h.test('immutable goal intents recover actual re-preparation after lost acknowledgement and source removal', async () => {
  const config = root(), source = join(config, 'source.TIFF'), requests: JsonObject[] = [];
  const bytes = Buffer.from('Exact opaque image bytes'); writeFileSync(source, bytes);
  const input = { text: 'Full objective 😀\n'.repeat(400), clientRequestId: 'durable-ui-retry', pastes: [{ text: 'Complete pasted evidence' }], images: [{ path: source, filename: 'Original.TIFF', mimeType: 'image/tiff' }] };
  let admitted = 0;
  const request = async (_id: string, method: string, params: JsonObject) => {
    assertEqual(method, 'session/setGoal', 'recovery uses the same named admission'); requests.push(params);
    if (requests.length === 1) { admitted++; throw { kind: 'timeout', method }; }
    assertDeepEqual(params, requests[0], 'actual re-preparation preserves the full immutable engine fingerprint');
    return { threadGoal: { ...goal(), objective: params.objective }, goalRevision: 1, goalAdmission: 'scheduled' };
  };
  const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestActiveWorkflow: request, logQueryFailure: () => {} } as unknown as SessionService;
  const first = new SessionQueries(service, new HostState(), config), prepared = await first.objectives.prepare('thread', input);
  const guards = { submit: true, clientRequestId: input.clientRequestId, expectedGoalId: null, expectedGoalRevision: 0, tokenBudget: 1000 };
  await assertRejects(() => first.setGoal('thread', { ...prepared, ...guards }), 'the accepted outcome can lose its acknowledgement');
  const originalManifest = object(requests[0]?.ownedResources);
  rmSync(source);
  const restarted = new SessionQueries(service, new HostState(), config);
  await restarted.objectives.discard('thread', prepared.preparationId!);
  const retry = await restarted.objectives.prepare('thread', input);
  assertDeepEqual(retry, prepared, 'a restarted real UI reprepare receives the original prepared DTO without reopening its source');
  assertDeepEqual(await restarted.objectives.ownedResources('thread', retry.preparationId!, retry.objective), originalManifest, 'owned manifest authority is exact across restart');
  assertEqual(object(await restarted.setGoal('thread', { ...retry, ...guards })).ok, true, 'the stable receipt observes its original admission');
  assertEqual(admitted, 1, 'a stable immutable replay does not create a second admission');
  const rejected = await assertRejects(() => restarted.objectives.prepare('thread', { ...input, text: 'Different objective' }), 'same request identity cannot silently become another semantic intent') as IpcHandlerError;
  assertEqual(rejected.code, 'GOAL_INTENT_CONFLICT', 'only a definitive intent conflict permits a new reviewed request identity');
  assertEqual(requests.length, 2, 'a changed intent is rejected before any engine admission');
  const binding = join(config, 'goal-objective-intents', createHash('sha256').update('thread').digest('hex'), createHash('sha256').update(input.clientRequestId).digest('hex') + '.json');
  assertEqual(statSync(binding).mode & 0o777, 0o600, 'durable intent mapping remains private');
  const directory = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'), retry.preparationId!);
  assert(readFileSync(join(directory, 'image-1.tiff')).equals(bytes), 'possibly admitted image bytes survive all cleanup attempts');
});

h.test('resource-free goal preflight cancellation owns no private entries and retries exact DTOs after restart', async () => {
  for (const images of [undefined, [{ url: 'https://example.com/image.bmp' }]]) {
    const config = root(), input = { text: 'Inline objective 😀', images, clientRequestId: 'inline-intent' };
    const prepared = await new GoalObjectives(config).prepare('thread', input);
    assertEqual(prepared.preparationId, undefined, 'inline and URL-only objectives require no private materialized files');
    if (prepared.preparationId) await new GoalObjectives(config).discard('thread', prepared.preparationId);
    assertDeepEqual(readdirSync(config), [], 'cancelling a resource-free preflight leaves no private mapping or files');
    const retry = await new GoalObjectives(config).prepare('thread', input);
    assertDeepEqual(retry, prepared, 'the same exact input remains byte-for-byte deterministic across host restart');
    let fingerprint: string | undefined, admissions = 0;
    const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestActiveWorkflow: async (_id: string, _method: string, params: JsonObject) => {
      const current = JSON.stringify(params);
      if (fingerprint !== undefined && fingerprint !== current) throw new IpcHandlerError('GOAL_CONFLICT', 'The immutable engine request changed');
      if (fingerprint === undefined) { fingerprint = current; admissions++; }
      return { threadGoal: { ...goal(), objective: params.objective }, goalRevision: 1, goalAdmission: 'scheduled' };
    } } as unknown as SessionService;
    const guards = { submit: true, clientRequestId: input.clientRequestId, expectedGoalId: null, expectedGoalRevision: 0 };
    await new SessionQueries(service, new HostState(), config).setGoal('thread', { ...prepared, ...guards });
    await new SessionQueries(service, new HostState(), config).setGoal('thread', { ...retry, ...guards });
    await assertRejects(() => new SessionQueries(service, new HostState(), config).setGoal('thread', { ...retry, ...guards, objective: 'Changed inline intent' }), 'the named engine receipt rejects a changed resource-free intent');
    assertEqual(admissions, 1, 'stable resource-free retry and rejection create no extra admission');
    assertDeepEqual(readdirSync(config), [], 'accepted inline receipts still have no host-owned resource cleanup');
  }
});

h.test('concurrent immutable goal preparation claims never replace a winner or leak losing files', async () => {
  const config = root(), input = { text: 'x'.repeat(4001), clientRequestId: 'concurrent-intent' };
  const first = new GoalObjectives(config), second = new GoalObjectives(config);
  const sameLane = await Promise.all([first.prepare('thread', input), first.prepare('thread', input), second.prepare('thread', input)]);
  sameLane.forEach(one => assertDeepEqual(one, sameLane[0], 'same intent coalesces or recovers the immutable atomic winner'));
  const threadRoot = join(config, 'goal-objectives', createHash('sha256').update('thread').digest('hex'));
  assertDeepEqual(readdirSync(threadRoot), [sameLane[0]!.preparationId], 'only the winning preparation owns files');
  const conflicting = await Promise.allSettled([
    first.prepare('thread', { text: 'A'.repeat(4001), clientRequestId: 'conflicting-intent' }),
    second.prepare('thread', { text: 'B'.repeat(4001), clientRequestId: 'conflicting-intent' }),
  ]);
  assertEqual(conflicting.filter(result => result.status === 'fulfilled').length, 1, 'exactly one different-semantic contender wins');
  const failure = conflicting.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assertEqual(failure.reason.code, 'GOAL_INTENT_CONFLICT', 'the losing semantic intent is explicit');
  assertEqual(readdirSync(threadRoot).length, 2, 'the rejected contender removes only its own unaccepted files');
});

h.test('prepared cancellation and proven first rejection release only their matching immutable binding', async () => {
  for (const rejected of [false, true]) {
    const config = root(), input = { text: 'x'.repeat(4001), clientRequestId: 'rejected-intent' };
    const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestActiveWorkflow: async () => { throw new IpcHandlerError('GOAL_CONFLICT', 'The observed goal changed'); } } as unknown as SessionService;
    const queries = new SessionQueries(service, new HostState(), config), prepared = await queries.objectives.prepare('thread', input);
    const unrelated = await queries.objectives.prepare('thread', { text: 'Unrelated'.repeat(600), clientRequestId: 'unrelated-intent' });
    if (rejected) await assertRejects(() => queries.setGoal('thread', { ...prepared, submit: true, clientRequestId: input.clientRequestId, expectedGoalId: null }), 'a proven engine conflict committed no receipt');
    else await queries.objectives.discard('thread', prepared.preparationId!);
    const fresh = new GoalObjectives(config), next = await fresh.prepare('thread', input);
    assert(next.preparationId !== prepared.preparationId, 'an unadmitted binding can be prepared again after explicit cancellation or proven rejection');
    assertDeepEqual(await fresh.prepare('thread', { text: 'Unrelated'.repeat(600), clientRequestId: 'unrelated-intent' }), unrelated, 'cleanup cannot erase an unrelated immutable binding');
    const bindingRoot = join(config, 'goal-objective-intents', createHash('sha256').update('thread').digest('hex'));
    const binding = join(bindingRoot, createHash('sha256').update(input.clientRequestId).digest('hex') + '.json'), outside = join(config, 'outside.json');
    writeFileSync(outside, readFileSync(binding), { mode: 0o600 }); rmSync(binding); symlinkSync(outside, binding);
    await assertRejects(() => new GoalObjectives(config).prepare('thread', input), 'a symlink cannot replace private immutable intent authority');
    assert(readFileSync(outside).length > 0, 'rejected metadata preserves unrelated files');
  }
});

h.test('cancellation racing a durable ownership claim cannot delete possibly admitted resources', async () => {
  for (const discardFirst of [false, true]) {
    const config = root(), first = new GoalObjectives(config), second = new GoalObjectives(config);
    const input = { text: 'x'.repeat(4001), clientRequestId: 'ownership-race' };
    const prepared = await first.prepare('thread', input);
    await second.prepare('thread', input);
    const mark = () => first.markSubmitting('thread', prepared.preparationId!, prepared.objective);
    const discard = () => second.discard('thread', prepared.preparationId!);
    const outcomes = await Promise.allSettled(discardFirst ? [discard(), mark()] : [mark(), discard()]);
    const claimed = outcomes[discardFirst ? 1 : 0]!;
    if (claimed.status === 'fulfilled') {
      assertDeepEqual(await new GoalObjectives(config).prepare('thread', input), prepared, 'a successful uncertainty claim retains immutable restart binding');
      assert((await new GoalObjectives(config).ownedResources('thread', prepared.preparationId!, prepared.objective)).files.length > 0, 'claimed files remain readable after concurrent cancellation');
    } else {
      const retry = await new GoalObjectives(config).prepare('thread', input);
      assert(retry.preparationId !== prepared.preparationId, 'a cancellation winner fails the claim before any engine admission');
    }
  }
});

h.test('goal turn provenance projects exact lifecycle metadata and saved history without prompt heuristics', () => {
  for (const one of vector.goalTurnMetadataCases) assertDeepEqual(goalTurnMetadata(one.input) ?? null, one.expected, 'committed provenance vector');
  const f = fixture(), metadata = { goalContinuation: true, inputOrigin: 'automatic', goalId: 'generation-one' };
  f.pump.receive({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'live', submissionId: 'submission', detail: { turnId: 'turn', ...metadata }, ...metadata } }, 1);
  f.forwarder.flush();
  const frames = f.emitted.flatMap(row => Array.isArray(row.payload) ? row.payload : []);
  const active = frames.map(object).find(frame => frame.type === 'session_runtime_status');
  const requesting = frames.map(object).find(frame => frame.type === 'stream_mode');
  assertDeepEqual(active, { type: 'session_runtime_status', sessionId: 'thread', status: 'active', turnId: 'turn', ...metadata }, 'captured automatic generation accompanies lifecycle activation');
  assertEqual(requesting?.goalId, metadata.goalId, 'requesting preserves the same bound generation');
  const raw = projectEngineEvent({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: 'submission', event: { type: 'turn.started', turnId: 'turn', ...metadata } } } });
  assertDeepEqual(raw, [], 'typed lifecycle projection remains the single root start source');
  const history = projectSessionHistory({ history: [], turnGoalMetadata: { turn: metadata, legacy: { origin: 'goal_continuation' } } }, 'thread');
  assertDeepEqual(object(history).turnGoalMetadata, { turn: metadata }, 'saved history carries only validated captured metadata');
  assertEqual(goalTurnMetadata({ goalContinuation: true, text: 'The same automatic-looking prompt' }), undefined, 'prompt wording creates no provenance');
  f.forwarder.close();
});

h.test('canonical goal submission items dedupe lost acknowledgement replay and keep captured history identity', async () => {
  const f = fixture(), captured = vector.goalSubmissionItem, saved: Json[] = []; let calls = 0;
  const request = async (id: string, method: string, params: JsonObject) => {
    assertEqual(id, 'thread', 'the receipt stays bound to its conversation');
    assertEqual(method, 'session/setGoal', 'the host uses one named goal mutation');
    assertEqual(params.clientRequestId, captured.clientRequestId, 'ambiguous retry retains its original identity');
    if (!calls++) saved.push({ type: 'user', uuid: captured.messageUuid, content: [{ type: 'text', text: captured.text }] });
    f.pump.receive({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'live', item: {
      id: captured.messageUuid, type: 'user_message', text: captured.text, status: 'completed', isMeta: false,
    } } }, 1);
    if (calls === 1) throw { kind: 'timeout', method };
    return { threadGoal: { ...goal(), objective: captured.text }, goalRevision: 1, goalAdmission: 'scheduled' };
  };
  const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestActiveWorkflow: request } as unknown as SessionService;
  const queries = new SessionQueries(service, f.state, root());
  const intent = { objective: captured.text, submit: true, clientRequestId: captured.clientRequestId, expectedGoalId: null, expectedGoalRevision: 0 };
  await assertRejects(() => queries.setGoal('thread', intent), 'the lost acknowledgement remains uncertain');
  assertEqual(object(await queries.setGoal('thread', intent)).ok, true, 'the exact retry observes accepted authority');
  f.forwarder.flush();
  const frames = f.emitted.flatMap(row => Array.isArray(row.payload) ? row.payload : []).map(object).filter(frame => frame.type === 'user_message');
  assertEqual(frames.length, 1, 're-emitted canonical UUID produces one live objective');
  assertEqual(object(frames[0]?.message).uuid, captured.messageUuid, 'live identity is the captured durable UUID');
  assertEqual(object(frames[0]?.message).isMeta, false, 'a human can type the same words as an internal instruction');
  assertEqual(frames[0]?.turnId, undefined, 'a goal mutation RPC identity never becomes a model turn');
  const freshHistory = object(projectSessionHistory({ history: saved, historyTurnIds: { [captured.messageUuid]: captured.turnId } }, 'thread'));
  const users = (freshHistory.messages as Json[]).map(object).filter(row => row.role === 'user');
  assertEqual(users.length, 1, 'fresh saved history contains the initiating objective once');
  assertEqual(users[0]?.uuid, captured.messageUuid, 'replay keeps the same canonical identity');
  assertEqual(users[0]?.turnId, captured.turnId, 'the durable bound event supplies the actual captured turn');
  const internal = projectEngineEvent({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'live', item: {
    id: 'internal-input', type: 'user_message', text: captured.text, status: 'completed', isMeta: true,
  } } });
  assertEqual(object(internal[0]?.message).isMeta, true, 'internal input provenance survives the renderer boundary');
  const hidden = object(projectSessionHistory({ history: [...saved, { type: 'user', uuid: 'internal-input', isMeta: true, content: [{ type: 'text', text: captured.text }] }] }, 'thread'));
  assertEqual((hidden.messages as Json[]).length, 1, 'internal instructions never become saved human records');
  f.forwarder.close();
});

h.test('an accepted goal acknowledgement remains accepted after a newer completion and clear', async () => {
  const response = deferred<JsonObject>(), state = new HostState();
  const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestActiveWorkflow: async () => response.promise } as unknown as SessionService;
  const queries = new SessionQueries(service, state, root());
  const pending = queries.setGoal('thread', { objective: 'Fast objective', submit: true, clientRequestId: 'fast-goal', expectedGoalId: null });
  await Promise.resolve();
  state.workflows.installGoal('thread', { goal: goal('fast', 'complete') as never, goalRevision: 2 });
  state.workflows.installGoal('thread', { goal: null, goalRevision: 3 });
  response.resolve({ threadGoal: goal('fast'), goalRevision: 1, goalAdmission: 'scheduled' });
  const reply = object(await pending);
  assertEqual(reply.ok, true, 'the durable submission was accepted');
  assertEqual(reply.admission, 'scheduled', 'the authoritative admission receipt survives snapshot reconciliation');
  assertEqual(reply.goal, null, 'a completed and cleared goal is never resurrected by its old acknowledgement');
  assertEqual(reply.goalRevision, 3, 'the newer clear remains the current authority');
});

h.test('goal event pushes include null clears and ignore obsolete read and event revisions', () => {
  const f = fixture();
  const send = (goalRevision: number, clear = false) => f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: '', goalRevision, ...(clear ? { goalCleared: true } : { threadGoal: goal() }) } } }, 1);
  f.state.workflows.installGoal('thread', { goal: goal() as never, goalRevision: 1 });
  send(1); send(2, true); send(1); send(2, true);
  const updates = f.emitted.filter(row => row.channel === 'goal:updated');
  assertEqual(updates.length, 2, 'one update per authoritative revision');
  assertEqual(object(updates[1]?.payload).goal, null, 'clear has explicit null');
  f.forwarder.close();
});

h.test('plan acceptance submits complete content once and records recoverable admission failures', async () => {
  const calls: { method: string; params: JsonObject }[] = []; let fail = true, admission = 'pending', revision = 1;
  const snapshot = () => ({ ...planning(revision), implementation: { clientRequestId: 'click', planId: 'plan', revision: 1, input: '# Edited\n\nFull implementation specification.', implementationId: 'plan-implementation-click', admission } });
  const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestSession: async (_id: string, method: string, params: JsonObject) => {
    calls.push({ method, params });
    if (method === 'session/settlePlanImplementation') { admission = String(params.outcome); revision++; return { planning: snapshot() }; }
    if (method === 'session/plans') return { planning: snapshot() };
    return { planning: snapshot(), accepted: admission !== 'started', admission, implementationId: 'plan-implementation-click', implementationInput: String(params.content) };
  }, submitPlanningTurn: async (_id: string, input: string, id: string) => { assertEqual(input, '# Edited\n\nFull implementation specification.', 'full editor content'); assertEqual(id, 'plan-implementation-click', 'stable receipt'); if (fail) throw new Error('Admission refused'); } } as unknown as SessionService;
  (service as unknown as { requestThreadWorkflow: SessionService['requestThreadWorkflow'] }).requestThreadWorkflow = service.requestSession.bind(service);
  (service as unknown as { requestPlanningRecovery: SessionService['requestPlanningRecovery'] }).requestPlanningRecovery = service.requestSession.bind(service);
  const plans = new SessionPlanning(service, new HostState()), input = { planId: 'plan', revision: 1, content: '# Edited\n\nFull implementation specification.', clientRequestId: 'click' };
  await assertRejects(() => plans.action('thread', input, 'implementation'), 'failed admission visible');
  assertEqual(calls.find(call => call.method === 'session/settlePlanImplementation')?.params.outcome, 'failed', 'recoverable state recorded');
  fail = false; await plans.action('thread', input, 'implementation');
  assertDeepEqual(calls.filter(call => call.method === 'session/settlePlanImplementation').map(call => call.params.outcome), ['failed', 'started'], 'started after authoritative admission');
  await plans.action('thread', input, 'implementation');
  assertEqual(calls.filter(call => call.method === 'session/settlePlanImplementation').length, 2, 'duplicate started receipt cannot execute again');
});

h.test('lost plan admission replies reconcile the durable started receipt across a host restart', async () => {
  let admission = 'pending', executions = 0, revision = 1;
  const settlements: string[] = [];
  const snapshot = () => ({ ...planning(revision), implementation: { planId: 'plan', revision: 1, clientRequestId: 'lost', implementationId: 'plan-implementation-lost', input: 'Complete implementation', admission } });
  const service = { seedGoalTitle: async () => undefined, assertGoalPursuitEligible: async () => {}, requestSession: async (_id: string, method: string, params: JsonObject) => {
    if (method === 'session/settlePlanImplementation') { settlements.push(String(params.outcome)); return { planning: snapshot() }; }
    return { planning: snapshot(), accepted: admission === 'pending', admission, implementationId: 'plan-implementation-lost', implementationInput: 'Complete implementation' };
  }, submitPlanningTurn: async () => { executions++; admission = 'started'; revision++; throw new Error('The admission reply and event were lost'); } } as unknown as SessionService;
  (service as unknown as { requestThreadWorkflow: SessionService['requestThreadWorkflow'] }).requestThreadWorkflow = service.requestSession.bind(service);
  (service as unknown as { requestPlanningRecovery: SessionService['requestPlanningRecovery'] }).requestPlanningRecovery = service.requestSession.bind(service);
  const input = { planId: 'plan', revision: 1, clientRequestId: 'lost', content: 'Complete implementation' };
  assertEqual((await new SessionPlanning(service, new HostState()).action('thread', input, 'implementation')).admission, 'started', 'authoritative claim wins over a lost transport');
  await new SessionPlanning(service, new HostState()).action('thread', input, 'implementation');
  assertEqual(executions, 1, 'fresh host cannot execute the admitted plan again');
  assertDeepEqual(settlements, [], 'uncertain host never downgrades durable started to failed');
});

h.test('plan item and delta projection preserves artifact identities and progress shape', () => {
  const artifact = planning().plans[0]!;
  const item = projectEngineEvent({ type: 'productEvent', method: 'item/started', params: { sessionId: 'live', item: { type: 'proposed_plan', id: 'item', plan: artifact } } });
  assertEqual(item[0]?.type, 'proposed_plan', 'separate plan item');
  assertDeepEqual(item[0]?.plan, artifact, 'complete artifact preserved');
  const delta = projectEngineEvent({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { event: { type: 'plan.delta', planId: 'plan', turnId: 'turn', revision: 2, delta: 'Chunk' } } } });
  assertEqual(delta[0]?.type, 'proposed_plan_delta', 'stream delta');
  assertEqual(delta[0]?.delta, 'Chunk', 'content exact');
});

h.test('fresh saved history replays exact completed accounting after the live goal was cleared', async () => {
  const f = fixture(); f.state.forgetSession('thread');
  const completed = { ...goal('achieved', 'complete'), objective: 'Deliver the reviewed result', tokensUsed: 987, timeUsedSeconds: 65 };
  f.client.respond = method => {
    assertEqual(method, 'engine/readThreadHistory', 'saved observation does not activate a provider');
    return { ...JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply, threadId: 'thread', history: [], goalCompletions: [{ goal: completed, goalRevision: 8 }] };
  };
  const projected = object(await f.service.storedHistory('thread'));
  const messages = projected.messages as Json[], blocks = object(messages[0]).contentBlocks as Json[];
  assertDeepEqual(object(blocks[0]).goal, completed, 'goal identity, objective, terminal state and final accounting survive restart');
  assertEqual(object(blocks[0]).type, 'goal_completion', 'dedicated persisted presentation');
  assertEqual(f.state.liveSession('thread'), undefined, 'no live provider session');
  assertEqual(f.client.calls.length, 1, 'zero model requests');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('saved completion records retain chronological turn placement and stable replay identity without trusting human metadata', async () => {
  const f = fixture(); f.state.forgetSession('thread');
  const completed = { ...goal('achieved', 'complete'), objective: 'Retain the audited achievement', tokensUsed: 987, timeUsedSeconds: 65 };
  const history = [
    { type: 'user', uuid: 'earlier', content: [{ type: 'text', text: 'Earlier conversation' }] },
    { type: 'assistant', uuid: 'actual-final', content: [{ type: 'text', text: 'The work is complete.' }] },
    { type: 'user', uuid: 'later', content: [{ type: 'text', text: 'A later unrelated request' }] },
    { type: 'user', uuid: 'human-quotation', subtype: 'goal_completion', text: JSON.stringify(completed), content: [{ type: 'text', text: JSON.stringify(completed) }] },
  ];
  const stored = {
    ...JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/stored-history-vectors.json'), 'utf8')).reply,
    threadId: 'thread', history,
    historyTurnIds: { earlier: 'earlier-turn', 'actual-final': 'completed-turn', later: 'later-turn', 'human-quotation': 'quoted-turn' },
    goalCompletions: [{ goal: completed, goalRevision: 8, sourceTurnId: 'completed-turn', turnId: 'stale-turn' }],
  };
  f.client.respond = method => {
    if (method === 'engine/readThreadHistory') return stored;
    if (method === 'session/goal') return { threadGoal: null, goalRevision: 9 };
    throw new Error(`Saved completion observation attempted ${method}`);
  };
  const completionRows = (value: JsonObject) => (value.messages as Json[]).map(object).filter(row => (row.contentBlocks as Json[] ?? []).some(block => object(block).type === 'goal_completion'));
  try {
    const first = object(await f.service.storedHistory('thread')), rows = first.messages as Json[];
    assertDeepEqual(rows.map(row => object(row).uuid), ['earlier', 'actual-final', 'goal-completed-achieved-8', 'later', 'human-quotation'], 'completion is inserted directly after its actual turn, before later conversation');
    const completion = completionRows(first);
    assertEqual(completion.length, 1, 'one authoritative generation produces one chronological completion');
    assertEqual(completion[0]!.turnId, 'completed-turn', 'completion retains its actual admitted turn identity');
    const legacy = object(projectSessionHistory({ ...stored, goalCompletions: [{ goal: completed, goalRevision: 8, turnId: 'completed-turn' }] }, 'thread'));
    assertEqual(completionRows(legacy)[0]!.turnId, 'completed-turn', 'older completion turn aliases remain readable');
    assertDeepEqual(object((completion[0]!.contentBlocks as Json[])[0]).goal, completed, 'terminal identity, objective and exact accounting stay intact');
    const queries = new SessionQueries(f.service, f.state, f.configRoot);
    assertEqual((await queries.goal('thread')).goal, null, 'the live goal has already been cleared');
    const reopened = object(await f.service.storedHistory('thread'));
    assertDeepEqual(completionRows(reopened), completion, 'fresh saved observation retains the same UUID, turn attribution and full completion record');
    const forged = object(projectSessionHistory({ ...stored, goalCompletions: [] }, 'thread'));
    assertDeepEqual(completionRows(forged), [], 'human subtype and JSON wording cannot create a completion block');
    const quoted = (forged.messages as Json[]).map(object).find(row => row.uuid === 'human-quotation');
    assertEqual(quoted?.role, 'user', 'the quoted human record remains ordinary user history');
    assertEqual(quoted?.text, JSON.stringify(completed), 'forgery rejection never removes authentic human text');
    f.state.workflows.installGoal('thread', { goal: goal('replacement') as never, goalRevision: 10 });
    assertDeepEqual(completionRows(object(await f.service.storedHistory('thread'))), completion, 'a new active goal does not erase prior historical achievement');
    assert(f.client.calls.every(call => ['engine/readThreadHistory', 'session/goal'].includes(call.method)), 'historical completion observation never activates a provider or mutates a goal');
    assertEqual(f.state.liveSession('thread'), undefined, 'reopening completion creates no live provider binding');
  } finally { await f.service.shutdown(); f.forwarder.close(); }
});

h.test('completed goal tool results retain the final snapshot after their own tool card', () => {
  const completed = goal('complete-tool', 'complete');
  const projected = object(projectSessionHistory({ history: [
    { type: 'assistant', uuid: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'update_goal', input: { status: 'complete' } }] },
    { type: 'tool_result', toolUseId: 'tool', output: { ok: true, goal: completed }, content: [{ type: 'text', text: 'Achieved.' }], isError: false },
  ] }, 'thread'));
  const blocks = object((projected.messages as Json[])[0]).contentBlocks as Json[];
  assertEqual(object(blocks[0]).type, 'tool_use', 'tool appears first');
  assertEqual(object(blocks[1]).type, 'goal_completion', 'completion immediately follows result');
  assertDeepEqual(object(blocks[1]).goal, completed, 'full completion evidence retained');
});

h.test('the public interrupt route retains user origin and requires an exact targeted fence', async () => {
  const f = fixture(), registry = new ChannelRegistry();
  registerSessionHandlers(registry, { sessions: f.service, state: f.state, events: f.pump, configRoot: f.configRoot, chooseExportPath: async () => undefined });
  const handler = registry.lookup('chat:interrupt')!;
  const invoke = (value: Json) => Promise.resolve().then(() => handler({ channel: 'chat:interrupt', role: 'main', senderId: 1, args: [value] }));
  for (const value of [{ sessionId: 'thread', origin: 'system' }, { sessionId: 'thread', origin: 'targeted-turn' }, { sessionId: 'thread', expectedTurnId: 7 }] as Json[]) await assertRejects(() => invoke(value), 'public callers cannot invent system authority or omit a target');
  assertEqual(f.client.calls.length, 0, 'invalid origins fail before engine activation');
  await f.service.client();
  for (const targeted of [false, true]) {
    f.state.markTurnRunning('thread', 'core', 'facade');
    const result = object(await invoke({ sessionId: 'thread', expectedTurnId: 'core', ...(targeted ? { origin: 'targeted-turn' } : {}) }));
    assertEqual(result.confirmed, true, 'structured final result survives the IPC route');
    const call = f.client.calls.filter(row => row.method === 'turn/interrupt').at(-1)!;
    assertDeepEqual(call.params, { sessionId: 'live', expectedTurnId: 'facade', origin: targeted ? 'targeted-turn' : vector.turnInterrupt.defaultOrigin }, 'a normal fenced Stop stays user-origin');
  }
  await f.service.shutdown(); f.forwarder.close();
});

h.test('system teardown confirms engine pause before host cleanup and closes before process fallback', async () => {
  for (const hookFailure of [false, true]) {
    const state = new HostState(), client = new Client(), order: string[] = [], logs: string[] = [];
    const service = new SessionService({ state, configRoot: root(), manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => { order.push('engine fallback'); } },
      spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: () => {}, log: kind => logs.push(kind),
      onClosing: async () => { order.push('host cleanup'); if (hookFailure) throw new Error('Host cleanup failed'); } });
    state.rememberSession('thread', 'live', {}, { source: 'custom', selection: 'custom:test' });
    state.workflows.installGoal('thread', { goal: goal() as never, goalRevision: 1 });
    client.respond = (method, params) => {
      order.push(method);
      if (method === 'turn/interrupt') {
        assertEqual(object(params).origin, 'system', 'system teardown never invents user revocation');
        order.push('engine paused');
        client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: 'control', turnInterrupt: { accepted: true, ...(hookFailure ? { goalPauseError: 'Goal storage unavailable' } : {}) } } } });
        return { submissionId: 'control' };
      }
      return {};
    };
    state.parkReverse({ requestId: 'dialog', sessionId: 'thread', isApproval: true, card: {}, toolName: 'Read', request: { outstanding: true, respond: async () => { order.push('cancel dialog'); }, respondError: async () => {} } });
    await service.client(); await service.shutdown();
    assert(order.indexOf('engine paused') < order.indexOf('host cleanup'), 'engine pause precedes callback');
    assert(order.indexOf('engine paused') < order.indexOf('cancel dialog'), 'engine pause precedes card cancellation');
    assert(order.indexOf('session/close') < order.indexOf('engine fallback'), 'core close precedes process fallback even when cleanup fails');
    assertEqual(order.filter(method => method === 'turn/interrupt').length, 1, 'only one cancellation control');
    assert(!order.includes('session/goal') && !order.includes('session/setGoal'), 'the host has no second goal writer');
    if (hookFailure) { assert(logs.includes('session-shutdown-cleanup-failed'), 'callback failure explicit'); assert(logs.includes('goal-pause-before-close-failed'), 'pause diagnostic explicit'); }
  }
});

h.test('shutdown attempts core close after cleanup failure and records the process fallback reason', async () => {
  const state = new HostState(), client = new Client(), order: string[] = [], logs: string[] = [];
  const service = new SessionService({ state, configRoot: root(), manager: { attach: async () => ({ client, generation: 1 }), shutdownAll: async () => { order.push('force fallback'); } },
    spawnOptions: () => ({ command: '/unused', args: [], env: [] }), pushChatEvents: () => {}, log: kind => logs.push(kind),
    onClosing: async () => { order.push('cleanup failed'); throw new Error('Cleanup refused'); } });
  state.rememberSession('thread', 'live', {}, { source: 'custom', selection: 'custom:test' });
  client.respond = (method, params) => {
    order.push(method);
    if (method === 'turn/interrupt') { client.emit('event', { type: 'rawSessionEvent', params: { sessionId: object(params).sessionId, event: { submissionId: 'control', turnInterrupt: { accepted: true } } } }); return { submissionId: 'control' }; }
    if (method === 'session/close') throw new Error('Core close deadline expired');
    return {};
  };
  await service.client(); await service.shutdown();
  assert(order.indexOf('cleanup failed') < order.indexOf('session/close'), 'host cleanup failure cannot skip core drain');
  assert(order.indexOf('session/close') < order.indexOf('force fallback'), 'named close is attempted before process fallback');
  assert(logs.includes('session-shutdown-cleanup-failed') && logs.includes('session-shutdown-close-failed'), 'both real failures retain explicit diagnostics');
});

h.test('fenced user Stop translates the captured facade reservation and reports engine pause errors', async () => {
  for (const origin of ['user-stop', 'targeted-turn'] as const) {
    const f = fixture(); f.state.markTurnRunning('thread', 'core-turn', 'facade-turn'); await f.service.client();
    f.client.respond = (method, params) => {
      if (method === 'turn/interrupt') {
        f.client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: 'control', turnInterrupt: { accepted: true, goalPauseError: 'Conditional pause refused' } } } });
        return { submissionId: 'control' };
      }
      return {};
    };
    const result = object(await f.service.interrupt('thread', 'core-turn', origin));
    assertDeepEqual(f.client.calls.filter(row => row.method === 'turn/interrupt').map(row => row.params), [{ sessionId: 'live', origin, expectedTurnId: 'facade-turn' }], 'a UI core identity becomes the exact foreground facade fence');
    assertEqual(result.confirmed, true, 'final engine receipt is required');
    assertEqual(result.goalPauseError, 'Conditional pause refused', 'pause error survives accepted cancellation');
    assert(!f.client.calls.some(row => row.method === 'session/goal' || row.method === 'session/setGoal'), 'there is no pre-read mutation race');
    await f.service.shutdown(); f.forwarder.close();
  }
});

h.test('a delayed stale interruption never retries against the newer turn of the same goal', async () => {
  const f = fixture(); f.state.markTurnRunning('thread', 'old'); await f.service.client();
  f.client.respond = (method, params) => {
    if (method === 'turn/interrupt') {
      if (object(params).origin === 'user-stop') f.state.markTurnRunning('thread', 'replacement');
      f.client.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: 'control', turnInterrupt: { accepted: object(params).origin !== 'user-stop' } } } });
      return { submissionId: 'control' };
    }
    return {};
  };
  const result = object(await f.service.interrupt('thread', 'old'));
  assertEqual(result.accepted, false, 'atomic engine stale result remains a refusal');
  assertEqual(f.state.runningTurnId('thread'), 'replacement', 'replacement runtime remains running');
  assertEqual(f.client.calls.filter(row => row.method === 'turn/interrupt').length, 1, 'no retry without fence');
  await f.service.shutdown(); f.forwarder.close();
});

h.test('late pause diagnostics surface without rewriting current goal or runtime state', () => {
  const f = fixture(); f.state.markTurnRunning('thread', 'replacement'); f.state.workflows.installGoal('thread', { goal: goal() as never, goalRevision: 3 });
  f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: 'old-control', turnInterrupt: { accepted: true, goalPauseError: 'Late pause failure' } } } }, 1);
  f.forwarder.flush();
  assertEqual(f.state.runningTurnId('thread'), 'replacement', 'late outcome never cancels a replacement host turn');
  assertEqual(f.state.workflows.goal('thread')?.goalRevision, 3, 'outcome is not a goal snapshot');
  assert(f.logs.some(row => row.kind === 'turn-interrupt-outcome'), 'late outcome is recorded');
  assert(f.emitted.some(row => Array.isArray(row.payload) && row.payload.some(item => object(item).type === 'notice')), 'late failure is visible');
  f.forwarder.close();
});

h.test('renderer plan history vectors preserve ordered artifacts without changing raw model records', () => {
  for (const row of vector.planningHistory.cases) {
    const plan = { id: 'artifact', threadId: 'thread', turnId: 'turn', revision: 9, content: '# Latest edited plan', status: row.status || 'proposed' };
    const raw: Json = { messages: [{ uuid: 'source', role: 'assistant', turnId: row.unattributed ? 'other' : 'turn', text: row.raw,
      contentBlocks: [{ type: 'text', text: row.raw, ...(row.commentary ? { phase: 'commentary' } : {}) }] }] };
    const before = JSON.stringify(raw);
    const result = object(projectPlanningHistory(raw, 'thread', { mode: 'plan', revision: 10, plans: [plan] } as never));
    assertEqual(JSON.stringify(raw), before, row.name + ': source model records remain exact');
    if (!row.expected) { assertEqual(JSON.stringify(result), before, row.name + ': no guessed artifact'); continue; }
    const message = object((result.messages as Json[])[0]), blocks = message.contentBlocks as Json[];
    assertDeepEqual(blocks.map(block => object(block).type === 'proposed_plan' ? 'PLAN' : object(block).text), row.expected, row.name);
    assertEqual(object(object(blocks.find(block => object(block).type === 'proposed_plan')).plan).revision, 9, row.name + ': authoritative revision retained');
  }
});

h.test('planning history captures retry the whole cut and fail closed on continuing mutations', async () => {
  const initial: Json = { history: [{ type: 'assistant', content: [{ type: 'text', text: '<proposed_plan>\nPlan\n</proposed_plan>' }] }] };
  const revisions = [1, 2, 2, 2]; let reads = 0, checks = 0;
  const captured = await coherentPlanningCapture(initial, async () => { reads++; return { ...object(initial), cut: reads }; },
    async () => ({ mode: 'plan', revision: revisions.shift()!, plans: [] }), () => { checks++; });
  assertEqual(object(captured.value).cut, 2, 'a changed bracket discards the entire first capture');
  assertEqual(captured.planning?.revision, 2, 'only the state spanning the selected cut is joined');
  assert(checks >= 8, 'ownership is checked across asynchronous boundaries');
  let revision = 0, rejected = false;
  try { await coherentPlanningCapture(initial, async () => initial, async () => ({ mode: 'plan', revision: ++revision, plans: [] }), () => {}); }
  catch (error) { rejected = error instanceof IpcHandlerError && error.code === 'PLAN_HISTORY_CHANGED'; }
  assert(rejected && revision === 6, 'three unstable cuts report an explicit retryable error');
  const plain = { history: [] };
  const unchanged = await coherentPlanningCapture(plain, async () => { throw Error('unexpected capture'); }, async () => { throw Error('unexpected planning read'); }, () => {});
  assertEqual(unchanged.value, plain, 'ordinary history needs no planning request');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'planning-goals-result.json'), 'planning-goals');
  for (const path of roots) rmSync(path, { recursive: true, force: true });
  process.exit(failed);
})();
