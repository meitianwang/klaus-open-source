import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Json } from '../main/ipc/contract';
import type { ClientEvent, ReverseRequest } from '../main/engine/protocol';
import { ChatEventForwarder, SessionEventPump, type SessionEventDeps } from '../main/sessions/events';
import { HostState } from '../main/services/host-state';
import { queueSnapshotEvent } from '../main/sessions/queue';
import { normalizeSessionMaxRetries } from '../main/sessions/event-context';
import { pendingQuestionRequests, questionAnswerMetadata } from '../main/sessions/async-questions';
import { projectSessionHistory } from '../main/sessions/history';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();
const contextVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/session-event-context.json'), 'utf8')) as {
  inputs: Record<'retry' | 'retryWithBudget' | 'retryNetworkWait' | 'rawAuth' | 'typedAuth', ClientEvent>;
  authCases: Array<{ name: string; source: string; rawAuth: Array<Record<string, Json>>; typedAuth: Array<Record<string, Json>> }>;
  cursorRecoveryCases: Array<{ name: string; reason: string; recover: boolean }>;
  retryCases: Array<{ name: string; input: 'retry' | 'retryWithBudget' | 'retryNetworkWait'; init: Record<string, Json>; maxRetries: number; attempt: number; phase: string | null; kind: string }>;
};
function fixture(resolveMcpElicitation?: SessionEventDeps['resolveMcpElicitation'], answerAttachments?: SessionEventDeps['answerAttachments'], configRoot?: string, callbacks?: Pick<SessionEventDeps, 'onCursorAuthFailed'>) {
  const state = new HostState();
  state.rememberSession('conversation', 'engine-session', {});
  const delivered: Array<{ channel: string; value: Json }> = [];
  const emit = (channel: string, value: Json): void => { delivered.push({ channel, value }); };
  const forwarder = new ChatEventForwarder(emit);
  let generation = 1;
  const pump = new SessionEventPump({ state, forwarder, emit, currentGeneration: () => generation, log: () => {}, resolveMcpElicitation, answerAttachments, configRoot, ...callbacks });
  return { state, delivered, forwarder, pump, generation: (value: number) => { generation = value; } };
}
function approval(id = 'tool-call', session = 'engine-session') {
  const responses: unknown[] = [];
  const request: ReverseRequest = {
    id: 'wire-id', method: 'approval/request', outstanding: true,
    params: { sessionId: session, request: { id, toolName: 'Bash', input: { command: 'printf test' }, suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', argumentPrefix: 'printf' }], destination: 'session', behavior: 'allow' },
    ] } },
    respond: async response => { request.outstanding = false; responses.push(response); },
    respondError: async (code, message) => { request.outstanding = false; responses.push({ code, message }); },
  };
  return { request, responses };
}

for (const vector of contextVector.authCases) {
  h.test(`bound ${vector.name} projects both auth paths with its committed context`, () => {
    const f = fixture();
    f.state.rememberSession('conversation', 'engine-session', { auth: { token: 'fixture-private-token' } }, { source: vector.source, selection: `${vector.source}:fixture` });
    for (const kind of ['rawAuth', 'typedAuth'] as const) {
      f.state.markTurnRunning('conversation', 'turn-1');
      f.pump.receive(contextVector.inputs[kind], 1);
      assertEqual(f.state.isWorking('conversation'), false, 'the composer leaves its busy state');
    }
    f.forwarder.close();
    // Terminal content does not synthesize an authoritative runtime snapshot.
    const withSession = (frames: Array<Record<string, Json>>) => frames.map(frame => ({ ...frame, sessionId: 'conversation' }));
    assertDeepEqual(f.delivered.flatMap(row => row.value), [...withSession(vector.rawAuth), ...withSession(vector.typedAuth)], 'both paths retain the bound source and renderer identity without a synthetic idle');
    assertDeepEqual(f.state.sessionEventContext('conversation'), { maxRetries: 5, authMode: vector.source }, 'event context exposes only public provider metadata');
  });
}

for (const vector of contextVector.retryCases) {
  h.test(`session retry ceiling: ${vector.name}`, () => {
    const f = fixture();
    f.state.rememberSession('conversation', 'engine-session', vector.init, { source: 'codex', selection: 'codex:fixture' });
    f.pump.receive(contextVector.inputs[vector.input], 1); f.forwarder.close();
    assertDeepEqual(f.delivered.flatMap(row => row.value), [{ type: 'api_retry', sessionId: 'conversation', attempt: vector.attempt, maxRetries: vector.maxRetries, phase: vector.phase, kind: vector.kind }], 'the published ceiling follows the engine budget, then the init, then the default');
  });
}

for (const vector of contextVector.cursorRecoveryCases) {
  h.test(`Cursor recovery: ${vector.name}`, () => {
    let recoveries = 0;
    const f = fixture(undefined, undefined, undefined, { onCursorAuthFailed: () => { recoveries++; } });
    f.state.rememberSession('conversation', 'engine-session', {}, { source: 'cursor', selection: 'cursor:fixture' });
    f.pump.receive({ type: 'productEvent', method: 'turn/failed', params: {
      sessionId: 'engine-session', submissionId: 'turn-1',
      detail: { error: { code: 'auth_failed', message: vector.reason } },
    } }, 1);
    f.forwarder.close();
    assertEqual(recoveries, vector.recover ? 1 : 0, 'only recoverable local snapshots trigger readoption');
  });
}

h.test('retry normalization rejects non-finite values without coercion', () => {
  for (const value of [NaN, Infinity, -Infinity, undefined, {}, []]) assertEqual(normalizeSessionMaxRetries(value), 5, 'invalid values use the engine default budget');
});

h.test('global model changes preserve active event contexts until their own reconfiguration succeeds', () => {
  const f = fixture();
  f.state.rememberSession('conversation', 'engine-session', { config: { maxRetries: 7 } }, { source: 'codex', selection: 'codex:fixture' });
  f.state.markModelChanged();
  f.state.rememberSession('next-conversation', 'next-engine', { config: { maxRetries: 0 } }, { source: 'custom', selection: 'custom:fixture' });
  assert(f.state.inferencePending('conversation'), 'the global change marks the old selection pending');
  for (const kind of ['retry', 'typedAuth'] as const) {
    const frame = contextVector.inputs[kind];
    f.pump.receive(frame, 1);
    f.pump.receive({ ...frame, params: { ...(frame as { params: Record<string, Json> }).params, sessionId: 'next-engine' } } as ClientEvent, 1);
  }
  f.forwarder.flush();
  assertDeepEqual(f.delivered.flatMap(row => row.value), [
    { type: 'api_retry', sessionId: 'conversation', attempt: 1, maxRetries: 7, phase: null, kind: 'rate_limit' },
    { type: 'api_retry', sessionId: 'next-conversation', attempt: 1, maxRetries: 0, phase: null, kind: 'rate_limit' },
    { type: 'auth_required', sessionId: 'conversation', reason: 'Session credential expired', mode: 'codex' },
    { type: 'interrupted', sessionId: 'conversation', turnId: 'turn-1' },
    { type: 'auth_required', sessionId: 'next-conversation', reason: 'Session credential expired', mode: 'custom' },
    { type: 'interrupted', sessionId: 'next-conversation', turnId: 'turn-1' },
  ], 'concurrent old and new conversations keep independent sources and budgets');
  assertEqual(f.state.updateInference('conversation', 'retired-engine', {}, { source: 'local', selection: 'local:fixture' }, 1), false, 'a retired source binding cannot retarget the card');
  assertEqual(f.state.sessionEventContext('conversation')?.authMode, 'codex', 'rejected replacement preserves the active source');
  assert(f.state.updateInference('conversation', 'engine-session', { config: { model: 'fixture' } }, { source: 'qoder', selection: 'qoder:fixture' }, f.state.modelPreferenceRevision('conversation')), 'an acknowledged replacement changes the bound provider');
  assertDeepEqual(f.state.sessionEventContext('conversation'), { maxRetries: 7, authMode: 'qoder' }, 'model reconfiguration retains the original session retry policy');
  f.delivered.length = 0; f.pump.receive(contextVector.inputs.typedAuth, 1); f.forwarder.close();
  assertDeepEqual(f.delivered.flatMap(row => row.value), contextVector.authCases.find(row => row.source === 'qoder')!.typedAuth.map(frame => ({ ...frame, sessionId: 'conversation' })), 'subsequent events use the successfully reconfigured provider');
});

h.test('old engine generations cannot publish retry or auth events with a replacement binding', async () => {
  const f = fixture();
  f.state.rememberSession('conversation', 'engine-session', { config: { maxRetries: 7 } }, { source: 'codex', selection: 'codex:fixture' });
  await f.state.invalidateConnection(); f.generation(2);
  f.state.rememberSession('conversation', 'engine-session', { config: { maxRetries: 0 } }, { source: 'custom', selection: 'custom:fixture' });
  f.state.markTurnRunning('conversation', 'turn-1');
  for (const frame of Object.values(contextVector.inputs)) f.pump.receive(frame, 1);
  f.forwarder.flush();
  assertDeepEqual(f.delivered, [], 'no old-generation events escape through the reused identity');
  assert(f.state.isWorking('conversation'), 'old auth failure cannot settle the new turn');
  f.pump.receive(contextVector.inputs.retry, 2); f.pump.receive(contextVector.inputs.typedAuth, 2); f.forwarder.close();
  assertDeepEqual(f.delivered.flatMap(row => row.value), [
    { type: 'api_retry', sessionId: 'conversation', attempt: 1, maxRetries: 0, phase: null, kind: 'rate_limit' },
    { type: 'auth_required', sessionId: 'conversation', reason: 'Session credential expired', mode: 'custom' },
    { type: 'interrupted', sessionId: 'conversation', turnId: 'turn-1' },
  ], 'the replacement generation uses its own bound context');
  f.state.forgetSession('conversation');
  assertEqual(f.state.sessionEventContext('conversation'), undefined, 'retiring a binding also retires its event context');
});

h.test('burst forwarding is bounded, ordered and flushed on close', () => {
  const f = fixture();
  f.forwarder.enqueue(Array.from({ length: 600 }, (_, index) => ({ index })));
  f.forwarder.close();
  assertDeepEqual(f.delivered.map(row => (row.value as Json[]).length), [256, 256, 88], 'bounded batches');
  assertDeepEqual(f.delivered.flatMap(row => row.value), Array.from({ length: 600 }, (_, index) => ({ index })), 'no event lost');
  f.forwarder.enqueue([{ index: 601 }]);
  assertEqual(f.delivered.length, 3, 'closed forwarder rejects new events');
});

const queueVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/queue-snapshot-event-vectors.json'), 'utf8')) as {
  vectors: Array<{ name: string; snapshot: Record<string, Json>; event: Record<string, Json> }>;
};

h.test('admitted queue pushes deliver the committed renderer event shape with no polling', () => {
  for (const vector of queueVectors.vectors) {
    const f = fixture();
    f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine-session', event: { queueSnapshot: vector.snapshot } } }, 1);
    f.forwarder.close();
    assertDeepEqual(f.delivered, [{ channel: 'chat:event:batch', value: [vector.event] }], vector.name);
    assertDeepEqual(queueSnapshotEvent('conversation', vector.snapshot), vector.event, 'hydration uses the same flat renderer projection');
  }
});

h.test('queue events preserve admitted state and suppress replies, stale revisions and stale connections', () => {
  const f = fixture();
  const send = (snapshot: Record<string, Json>, submissionId = '', generation = 1, sessionId = 'engine-session'): void => {
    f.pump.receive({ type: 'rawSessionEvent', params: { sessionId, event: { submissionId, queueSnapshot: snapshot } } }, generation);
  };
  const pending = queueVectors.vectors[0]!, failed = queueVectors.vectors[2]!;
  send(pending.snapshot);
  send({ revision: 8, items: [], status: 'authoritative' }, 'correlated-request');
  send({ revision: 6, items: [], status: 'authoritative' });
  send({ revision: 8, items: [], status: 'authoritative' }, '', 0);
  send({ revision: 8, items: [], status: 'authoritative' }, '', 1, 'unknown-session');
  send({ revision: 8, items: null, status: 'authoritative' });
  send(failed.snapshot);
  send({ revision: 10, items: [], status: 'authoritative' });
  f.forwarder.close();
  assertDeepEqual(f.delivered, [{ channel: 'chat:event:batch', value: [pending.event, failed.event] }], 'only admitted events can change the renderer queue');
  assertEqual(f.state.queueSnapshot('conversation')?.revision, 9, 'durability failure remains authoritative for this binding');
});

h.test('tool start reaches the renderer before its permission card', () => {
  const f = fixture();
  const a = approval();
  f.pump.receive({ type: 'productEvent', method: 'item/started', params: {
    sessionId: 'engine-session', item: { type: 'tool_call', id: 'tool-call', toolName: 'Bash', arguments: { command: 'printf test' } },
  } }, 1);
  assertEqual(f.delivered.length, 0, 'tool start is initially batched');
  f.pump.receive({ type: 'reverseRequest', request: a.request }, 1);
  assertDeepEqual(f.delivered.map(row => row.channel), ['chat:event:batch', 'permission:request'], 'approval flush order');
  const chat = f.delivered[0]!.value as Array<Record<string, Json>>;
  assertEqual(chat[1]!.sessionId, 'conversation', 'events use the renderer session identity');
  const card = f.delivered[1]!.value as Record<string, Json>;
  assertEqual(card.toolCallId, 'tool-call', 'card attaches to the original tool row');
  assertEqual(card.requestId, '1:approval:tool-call', 'answer identity includes generation');
  f.forwarder.close();
});

h.test('permission updates preserve engine values and malformed answers keep the request pending', async () => {
  const f = fixture(); const a = approval();
  f.pump.receive({ type: 'reverseRequest', request: a.request }, 1);
  await assertRejects(() => f.pump.respond({ requestId: '1:approval:tool-call', decision: 'allow', acceptedSuggestionIndices: [9] }, true), 'invalid suggestion rejected');
  assertEqual(f.state.pendingCount(), 1, 'invalid answer did not consume the request');
  await f.pump.respond({ requestId: '1:approval:tool-call', decision: 'allow', acceptedSuggestionIndices: [0], updatedInput: { command: 'printf reviewed' } }, true);
  assertDeepEqual(a.responses, [{ decision: 'allow', updatedInput: { command: 'printf reviewed' }, updatedPermissions: [
    { type: 'addRules', rules: [{ toolName: 'Bash', argumentPrefix: 'printf' }], destination: 'session', behavior: 'allow' },
  ] }], 'selected values are raw permission updates');
  await assertRejects(() => f.pump.respond({ requestId: '1:approval:tool-call', decision: 'deny' }, true), 'duplicate response rejected');
  f.forwarder.close();
});

h.test('the production pump publishes approved sub-agent rows with renderer ownership',async()=>{
  const f=fixture(), a=approval('task-call');
  f.pump.receive({type:'productEvent',method:'item/started',params:{sessionId:'engine-session',item:{type:'tool_call',id:'task-call',toolName:'task',status:'in_progress',arguments:{description:'Child',run_in_background:true}}}},1);
  f.pump.receive({type:'reverseRequest',request:a.request},1);
  assertEqual(f.pump.agentTasks.presentation('conversation').tasks['task-call'],undefined,'approval is still pending');
  await f.pump.respond({requestId:'1:approval:task-call',decision:'allow'},true);
  f.forwarder.flush();
  const frames=f.delivered.filter(row=>row.channel==='chat:event:batch').flatMap(row=>row.value as Array<Record<string,Json>>);
  const changed=frames.find(frame=>frame.type==='tasks_changed');
  assertEqual(changed?.sessionId,'conversation','same renderer ownership');
  assert(!!changed?.tasks,'actual approval callback publishes task presentation'); f.forwarder.close();
});

h.test('an answer from an old generation cannot approve a reused request ID', async () => {
  const f = fixture(); const old = approval();
  f.pump.receive({ type: 'reverseRequest', request: old.request }, 1);
  f.state.invalidateConnection(); f.generation(2);
  f.state.rememberSession('conversation', 'engine-session', {});
  const next = approval(); f.pump.receive({ type: 'reverseRequest', request: next.request }, 2);
  await assertRejects(() => f.pump.respond({ requestId: '1:approval:tool-call', decision: 'allow' }, true), 'stale answer rejected');
  assertEqual(next.responses.length, 0, 'new request remains unanswered');
  await f.pump.respond({ requestId: '2:approval:tool-call', decision: 'deny' }, true);
  assertDeepEqual(next.responses, [{ decision: 'deny' }], 'current answer delivered');
  f.forwarder.close();
});

h.test('unknown session approvals fail explicitly without displaying a misplaced card', () => {
  const f = fixture(); const a = approval('call', 'other-session');
  f.pump.receive({ type: 'reverseRequest', request: a.request }, 1);
  assertEqual(f.delivered.length, 0, 'no card routed to the current conversation');
  assertEqual(f.state.pendingCount(), 0, 'no orphan pending request');
  assertEqual((a.responses[0] as { code: number }).code, -32602, 'engine receives identity failure');
  f.forwarder.close();
});

h.test('structured elicitation preserves questions and cannot use the permission answer path', async () => {
  const f = fixture(); const a = approval();
  const request: ReverseRequest = { ...a.request, method: 'elicitation/request', params: {
    sessionId: 'engine-session', elicitation: { requestId: 'ask', request: {
      prompt: 'Choose a direction', questions: [{ id: 'choice', question: 'Which one?' }], metadata: { context: 'fixture' },
    } },
  } };
  f.pump.receive({ type: 'reverseRequest', request }, 1);
  const card = f.delivered[0]!.value as Record<string, Json>;
  assertEqual(card.responseChannel, 'elicit', 'question is an elicitation');
  assertDeepEqual(card.toolInput, { questions: [{ id: 'choice', question: 'Which one?' }], metadata: { context: 'fixture' } }, 'question schema retained');
  await assertRejects(() => f.pump.respond({ requestId: '1:elicit:ask', decision: 'allow' }, true), 'permission channel cannot answer a question');
  await f.pump.respond({ requestId: '1:elicit:ask', response: { kind: 'answers', answers: { choice: 'first' } } }, false);
  assertDeepEqual(a.responses, [{ kind: 'answers', answers: { choice: 'first' } }], 'structured answers retained');
  f.forwarder.close();
});

function questionRequest(attachmentsSupported = true) {
  const responses: Json[] = [];
  const request: ReverseRequest = {
    id: 'question-wire', method: 'elicitation/request', outstanding: true,
    params: { sessionId: 'engine-session', elicitation: { requestId: 'ask', request: {
      prompt: 'Which details?', questions: [{ question: 'Which details?' }], ...(attachmentsSupported ? { attachmentsSupported: true } : {}),
    } } },
    respond: async response => { request.outstanding = false; responses.push(response as Json); },
    respondError: async (code, message) => { request.outstanding = false; responses.push({ code, message }); },
  };
  return { request, responses };
}
const attachmentAnswer = { kind: 'answers', answers: { 'Which details?': 'See screenshot' }, attachments: { 'Which details?': [{ path: '/fixture/uploads/screenshot.png', name: 'screenshot.png', type: 'image/png', size: 8 }] } };
const attachmentMedia = { 'Which details?': [{ type: 'image', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }] };

h.test('question responses normalize attachments before settling the waiting engine', async () => {
  const normalized: Json[] = [];
  const f = fixture(undefined, async groups => { normalized.push(groups); return attachmentMedia; });
  const q = questionRequest(); f.pump.receive({ type: 'reverseRequest', request: q.request }, 1);
  assertEqual((f.delivered[0]!.value as Record<string, Json>).attachmentsSupported, true, 'the card advertises engine support');
  await f.pump.respond({ requestId: '1:elicit:ask', response: attachmentAnswer }, false);
  assertDeepEqual(normalized, [attachmentAnswer.attachments], 'the uploader owns attachment normalization');
  assertDeepEqual(q.responses, [{ kind: 'answers', answers: attachmentAnswer.answers, attachments: attachmentMedia }], 'the engine receives image bytes with the exact answer');
  f.forwarder.close();
});

h.test('invalid, unsupported or failed attachments preserve the pending question', async () => {
  for (const supported of [false, true]) {
    const f = fixture(undefined, async () => { throw new Error('Cannot read attachment'); });
    const q = questionRequest(supported); f.pump.receive({ type: 'reverseRequest', request: q.request }, 1);
    await assertRejects(() => f.pump.respond({ requestId: '1:elicit:ask', response: attachmentAnswer }, false), 'missing capability or unreadable image is explicit');
    assertEqual(f.state.pendingCount(), 1, 'a failed image does not consume the question');
    assertDeepEqual(q.responses, [], 'no filename-only success reaches the engine');
    for (const attachments of [{ 'Unknown question': [] }, { 'Which details?': {} }] as Array<Record<string, Json>>) {
      await assertRejects(() => f.pump.respond({ requestId: '1:elicit:ask', response: { ...attachmentAnswer, attachments } }, false), 'attachments require a matching answered question and list');
    }
    await f.pump.respond({ requestId: '1:elicit:ask', response: { kind: 'answers', answers: attachmentAnswer.answers } }, false);
    assertDeepEqual(q.responses, [{ kind: 'answers', answers: attachmentAnswer.answers }], 'old text-only answers remain unchanged');
    f.forwarder.close();
  }
});

h.test('attachment normalization cannot race a second answer or a retired engine', async () => {
  for (const retire of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture(undefined, async () => { await gate; return attachmentMedia; });
    const q = questionRequest(); f.pump.receive({ type: 'reverseRequest', request: q.request }, 1);
    const first = f.pump.respond({ requestId: '1:elicit:ask', response: attachmentAnswer }, false);
    const second = retire ? undefined : f.pump.respond({ requestId: '1:elicit:ask', response: attachmentAnswer }, false);
    if (retire) await f.state.invalidateConnection();
    release();
    const results = await Promise.allSettled(second ? [first, second] : [first]);
    assertEqual(results.filter(row => row.status === 'fulfilled').length, retire ? 0 : 1, 'only one still-pending response can settle');
    assertEqual(q.responses.filter(row => (row as Record<string, Json>).kind === 'answers').length, retire ? 0 : 1, 'no old or duplicate attachment response escapes');
    f.forwarder.close();
  }
});

h.test('stale connection and turn completions do not clear newer running state', () => {
  const f = fixture(); f.generation(2); f.state.markTurnRunning('conversation', 'new-turn');
  f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'new-turn' } }, 1);
  assertEqual(f.delivered.length, 0, 'old connection ignored');
  f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'old-turn' } }, 2);
  assert(f.state.isWorking('conversation'), 'old turn cannot end the new one');
  // The stale completion is STILL forwarded (the renderer applies it under its
  // own turnId and ignores it for the live turn); only the registry stays untouched.
  const staleFrames = f.delivered.flatMap(row => row.value as Array<Record<string, Json>>);
  assertDeepEqual(staleFrames.map(frame => frame.type), ['done'], 'a stale completion retains its own content without claiming current runtime status');
  assertEqual(staleFrames.find(frame => frame.type === 'done')?.turnId, 'old-turn', 'and keeps the turn it names');
  f.delivered.length = 0;
  f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'new-turn' } }, 2);
  assertEqual(f.state.isWorking('conversation'), false, 'current turn completed');
  f.forwarder.close();
});

h.test('facade submission completion resolves to the engine turn identity', () => {
  const f = fixture();
  f.pump.receive({ type: 'productEvent', method: 'turn/started', params: {
    sessionId: 'engine-session', submissionId: 'turn_3', detail: { type: 'turn.started', turnId: 'actual-turn-uuid' },
  } }, 1);
  assertEqual(f.state.runningTurnId('conversation'), 'actual-turn-uuid', 'running identity is the engine UUID');
  f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'turn_3', result: { stopReason: 'completed' } } }, 1);
  assertEqual(f.state.isWorking('conversation'), false, 'completion matched its submission alias');
  const chat = f.delivered.flatMap(row => row.value as Array<Record<string, Json>>);
  assertEqual(chat.find(row => row.type === 'done')?.turnId, 'actual-turn-uuid', 'renderer completion uses the same turn UUID');
  f.forwarder.close();
});

h.test('active turn correlation cannot be evicted by unrelated conversations', () => {
  const f = fixture();
  f.pump.receive({ type: 'productEvent', method: 'turn/started', params: {
    sessionId: 'engine-session', submissionId: 'target-submission', detail: { type: 'turn.started', turnId: 'target-engine-turn' },
  } }, 1);
  for (let index = 0; index < 512; index += 1) {
    const rendererId = `conversation-${index}`, engineId = `engine-${index}`;
    f.state.rememberSession(rendererId, engineId, {});
    f.pump.receive({ type: 'productEvent', method: 'turn/started', params: {
      sessionId: engineId, submissionId: `submission-${index}`, detail: { type: 'turn.started', turnId: `turn-${index}` },
    } }, 1);
  }
  f.pump.receive({ type: 'turnCompleted', params: {
    sessionId: 'engine-session', turnId: 'target-submission', result: { stopReason: 'completed' },
  } }, 1);
  assertEqual(f.state.isWorking('conversation'), false, 'unrelated active aliases cannot strand the target turn');
  f.forwarder.close();
  const chat = f.delivered.flatMap(row => row.value as Array<Record<string, Json>>);
  assertEqual(chat.find(row => row.type === 'done' && row.sessionId === 'conversation')?.turnId, 'target-engine-turn', 'the target completion retains its engine UUID');
});

h.test('a terminal turn settles deferred capability reloads for its renderer session', () => {
  const settled: string[] = [];
  const state = new HostState();
  state.rememberSession('conversation', 'engine-session', {});
  const forwarder = new ChatEventForwarder(() => {});
  const pump = new SessionEventPump({ state, forwarder, emit: () => {}, currentGeneration: () => 1, log: () => {},
    onTurnSettled: id => { settled.push(id); } });
  state.markTurnRunning('conversation', 'submission');
  pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'submission', result: { stopReason: 'completed' } } }, 1);
  assertDeepEqual(settled, ['conversation'], 'the idle session settles deferred reloads');
  settled.length = 0;
  state.markTurnRunning('conversation', 'other-submission');
  pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'unrelated', result: { stopReason: 'completed' } } }, 1);
  assertDeepEqual(settled, [], 'a foreign terminal event leaves the running session alone');
  forwarder.close();
});

h.test('every terminal turn outcome clears the matching running state', () => {
  const cases: Array<{ name: string; terminal: ClientEvent }> = [
    { name: 'completed', terminal: { type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'submission', result: { stopReason: 'completed' } } } },
    { name: 'aborted', terminal: { type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'submission', result: { stopReason: 'aborted' } } } },
    { name: 'failed', terminal: { type: 'productEvent', method: 'turn/failed', params: { sessionId: 'engine-session', submissionId: 'submission', detail: { error: { code: 'internal', message: 'failed' } } } } },
    { name: 'auth', terminal: { type: 'productEvent', method: 'turn/failed', params: { sessionId: 'engine-session', submissionId: 'submission', detail: { error: { code: 'auth_failed', message: 'expired' } } } } },
  ];
  for (const entry of cases) {
    const f = fixture();
    f.pump.receive({ type: 'productEvent', method: 'turn/started', params: {
      sessionId: 'engine-session', submissionId: 'submission', detail: { type: 'turn.started', turnId: 'engine-turn' },
    } }, 1);
    f.pump.receive(entry.terminal, 1);
    assertEqual(f.state.isWorking('conversation'), false, `${entry.name} clears the running state`);
    f.forwarder.close();
  }
});

const mcpVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mcp-elicitation-vectors.json'), 'utf8')) as {
  request: Record<string, Json>; card: Record<string, Json>; answer: Record<string, Json>; response: Record<string, Json>;
};
const mcpFrame = (event: Record<string, Json> = mcpVector.request, sessionId = 'engine-session') => ({ type: 'rawSessionEvent' as const, params: { sessionId, event: { mcpElicitation: event } } });

h.test('committed MCP form vector uses its named facade and preserves typed fields and original metadata', async () => {
  const calls: unknown[][] = [];
  const f = fixture(async (...args) => { calls.push(args); });
  f.forwarder.enqueue([{ type: 'tool_start', sessionId: 'conversation', toolName: 'mcp__computer-use__get_app_state' }]);
  f.pump.receive(mcpFrame(), 1);
  assertDeepEqual(f.delivered.map(row => row.channel), ['chat:event:batch', 'elicit:request'], 'the tool precedes its typed card');
  assertDeepEqual(f.delivered[1]!.value, mcpVector.card, 'the published form has the pinned renderer shape');
  await f.pump.respond({ requestId: mcpVector.card.requestId!, response: mcpVector.answer }, false);
  assertDeepEqual(calls, [['engine-session', 1, 'mcp-form', mcpVector.response]], 'the authenticated original owner and structured values reach the named resolver');
  assertEqual(f.state.pendingCount(), 0, 'the completed response retires its card'); f.forwarder.close();
});
h.test('MCP answers wait for facade completion and malformed values or duplicate clicks cannot consume a grant', async () => {
  let release!: () => void, calls = 0;
  const f = fixture(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); });
  f.pump.receive(mcpFrame(), 1); f.pump.receive(mcpFrame(), 1);
  assertEqual(f.delivered.length, 1, 'duplicate wire events publish one card');
  await assertRejects(() => f.pump.respond({ requestId: mcpVector.card.requestId!, response: { kind: 'accept', values: [] } }, false), 'string-list answers cannot masquerade as a typed form');
  assertEqual(f.state.pendingCount(), 1, 'invalid values leave the original card available');
  let completed = false;
  const answer = f.pump.respond({ requestId: mcpVector.card.requestId!, response: mcpVector.answer }, false).then(() => { completed = true; });
  await assertRejects(() => f.pump.respond({ requestId: mcpVector.card.requestId!, response: mcpVector.answer }, false), 'a concurrent click cannot resolve twice');
  assertEqual(completed, false, 'IPC success waits for the actual facade terminal'); assertEqual(calls, 1, 'one named operation');
  release(); await answer; f.forwarder.close();
});
h.test('MCP terminal cancellation dismisses its card and prevents delayed permission reuse', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  f.pump.receive(mcpFrame(), 1);
  f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine-session', event: { mcpElicitationResolved: { requestId: 'mcp-form', action: 'cancel' } } } }, 1);
  f.forwarder.flush();
  assertEqual(f.state.pendingCount(), 0, 'the engine terminal removed its unanswered card');
  assertDeepEqual(f.delivered[1]!.value, [{ type: 'elicit_cancelled', requestId: mcpVector.card.requestId!, sessionId: 'conversation' }], 'the renderer retracts the actual card');
  await assertRejects(() => f.pump.respond({ requestId: mcpVector.card.requestId!, response: mcpVector.answer }, false), 'a stale user answer is refused');
  f.pump.receive(mcpFrame(), 1); assertEqual(f.delivered.length, 2, 'a repeated event cannot revive a completed grant');
  assertEqual(calls, 0, 'no facade call after cancellation'); f.forwarder.close();
});
h.test('MCP response identities are scoped to their original engine generation and conversation', async () => {
  const calls: unknown[][] = []; const f = fixture(async (...args) => { calls.push(args); });
  f.pump.receive(mcpFrame(), 1); f.state.invalidateConnection(); f.generation(2);
  f.state.rememberSession('conversation', 'engine-session', {}); f.pump.receive(mcpFrame(), 2);
  await assertRejects(() => f.pump.respond({ requestId: mcpVector.card.requestId!, response: mcpVector.answer }, false), 'old engine answers cannot target a reused request ID');
  await f.pump.respond({ requestId: '2:mcp:engine-session:mcp-form', response: { kind: 'decline' } }, false);
  assertEqual(calls.length, 1, 'only the current generation answered');
  assertEqual(calls[0]![1], 2, 'the resolver gets the captured current generation');
  f.pump.receive(mcpFrame({ ...mcpVector.request, requestId: 'unknown' }, 'other-engine'), 2);
  assertEqual(f.state.pendingCount(), 0, 'unknown sessions cannot route cards into another conversation'); f.forwarder.close();
});
h.test('MCP facade failure cancels the original operation and never reports approval success', async () => {
  const calls: Record<string, Json>[] = [];
  const f = fixture(async (_engineId, _generation, _requestId, response) => { calls.push(response); if (response.action === 'accept') throw new Error('Fixture resolve terminal failed'); });
  f.pump.receive(mcpFrame(), 1);
  await assertRejects(() => f.pump.respond({ requestId: mcpVector.card.requestId!, response: mcpVector.answer }, false), 'failed terminal rejects the user action');
  assertDeepEqual(calls.map(row => row.action), ['accept', 'cancel'], 'cleanup cancels the unresolved original request'); f.forwarder.close();
});

h.test('hook failures stay out of the transcript and land in the host log', () => {
  // The transcript never carries a hook's runtime failure; the
  // management surface (Settings → Hooks) and the host log are where it is visible.
  const state = new HostState();
  state.rememberSession('conversation', 'engine-session', {});
  const delivered: Json[] = [];
  const logs: string[] = [];
  const forwarder = new ChatEventForwarder((_channel, value) => { delivered.push(...(Array.isArray(value) ? value : [value])); });
  const pump = new SessionEventPump({ state, forwarder, emit: () => {}, currentGeneration: () => 1, log: (kind, detail) => { logs.push(`${kind}: ${detail}`); } });
  const failure = (kind: string) => ({
    type: 'rawSessionEvent',
    params: { sessionId: 'engine-session', extensionFailure: { kind, id: `${kind}-1`, message: 'hook failed' } },
  }) as unknown as ClientEvent;
  pump.receive(failure('hook'), 1);
  pump.receive(failure('plugin'), 1);
  forwarder.close();
  assertDeepEqual(delivered, [{ type: 'extension_failure', sessionId: 'conversation', kind: 'plugin', id: 'plugin-1', message: 'hook failed' }], 'the plugin notice survives, the hook one does not');
  assertEqual(logs.length, 1, 'exactly the hook failure was logged');
  assertEqual(logs[0]!.includes('hook-1'), true, 'the log names the failed hook');
});

h.test('engine stream close reports a transient recovering state, not a settled error', () => {
  // The badge must converge with recovery: a closed engine stream is the START of a
  // reconnect (the next engine-needing call re-attaches), so the renderer gets
  // `reconnecting`; only the attach-success path may later settle it to ok. Emitting
  // a terminal `error` here is what left the titlebar badge red forever after a
  // healthy respawn.
  const f = fixture();
  f.pump.receive({ type: 'streamClosed' } as unknown as ClientEvent, 1);
  f.forwarder.close();
  assertDeepEqual(
    f.delivered.filter(row => row.channel === 'engine:status'),
    [{ channel: 'engine:status', value: { status: 'reconnecting' } }],
    'the badge receives a transient recovering state',
  );
});

const asyncQuestion = {
  requestId: 'question-1', turnId: 'turn-1', toolCallId: 'question-tool-1', state: 'pending', answers: {},
  request: { prompt: 'Choose a result format', attachmentsSupported: true, questions: [
    { question: 'Which format?', header: 'Format', options: [{ label: 'Paragraph', description: 'Readable prose' }, { label: 'List', description: 'Three items' }] },
    { question: 'Which language?', header: 'Language', options: [{ label: 'Chinese', description: 'Chinese wording' }, { label: 'English', description: 'English wording' }] },
  ] },
};
const answerMetadata = { requestId: asyncQuestion.requestId, turnId: asyncQuestion.turnId, toolCallId: asyncQuestion.toolCallId,
  clientResponseId: 'response-1', questions: asyncQuestion.request.questions, answers: { 'Which format?': 'List' } };
const answerResolution = { requestId: asyncQuestion.requestId, turnId: asyncQuestion.turnId, state: 'pending',
  answers: answerMetadata.answers, userMessageId: 'answer-user-1', clientResponseId: answerMetadata.clientResponseId,
  userMessage: { uuid: 'answer-user-1', content: [{ type: 'text', text: 'List' }], questionAnswer: answerMetadata } };

h.test('asynchronous questions preserve identities and do not park or stop the running turn', () => {
  const f = fixture(); f.state.markTurnRunning('conversation', 'turn-1');
  f.forwarder.enqueue([{ type: 'text_delta', sessionId: 'conversation', text: 'Working before asking' }]);
  f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine-session', event: { type: 'question.requested', question: asyncQuestion } } }, 1);
  f.pump.receive({ type: 'productEvent', method: 'question/requested', params: { sessionId: 'engine-session', question: asyncQuestion } }, 1);
  f.forwarder.close();
  assertEqual(f.delivered.length, 2, 'raw/product duplicates publish one request after earlier stream text');
  assertEqual(f.delivered[0]?.channel, 'chat:event:batch', 'earlier assistant message stays ahead of the chip');
  const card = f.delivered[1]?.value as Record<string, Json>;
  assertDeepEqual([card.requestId, card.turnId, card.toolCallId, card.responseChannel, card.toolName, card.sessionId],
    ['question-1', 'turn-1', 'question-tool-1', 'async-question', 'ask_user_async', 'conversation'], 'the renderer sees original question and engine turn identities');
  assert(f.state.isWorking('conversation'), 'asking does not stop execution');
  assertEqual(f.state.pendingForSession('conversation').length, 0, 'async input is never a blocking reverse request');
});

h.test('partial question answers publish one attributed user message before resolution and retain original question indices', () => {
  const f = fixture(); f.state.markTurnRunning('conversation', 'turn-1');
  f.pump.receive({ type: 'productEvent', method: 'question/requested', params: { sessionId: 'engine-session', question: asyncQuestion } }, 1);
  f.delivered.length = 0;
  for (const event of [
    { type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: answerResolution } },
    { type: 'rawSessionEvent', params: { sessionId: 'engine-session', event: { type: 'question.resolved', questionResolved: answerResolution } } },
  ] as ClientEvent[]) f.pump.receive(event, 1);
  f.forwarder.close();
  assertDeepEqual(f.delivered.map(row => row.channel), ['chat:event:batch', 'question:resolved'], 'duplicates do not create another answer bubble or resolution');
  const user = (f.delivered[0]!.value as Array<Record<string, Json>>)[0]!;
  assertEqual(user.type, 'user_message', 'answer is a user message');
  assertEqual(user.turnId, 'turn-1', 'answer stays in its original running turn');
  const message = (user.message as Record<string, Json>).message as Record<string, Json>;
  assertDeepEqual(message.questionAnswer, answerMetadata, 'answer retains full question preview attribution');
  assertEqual(message.steered, true, 'a question answer cannot become an edit-turn opener');
  assertDeepEqual(f.delivered[1]!.value, { sessionId: 'conversation', requestId: 'question-1', turnId: 'turn-1', state: 'pending',
    answers: answerMetadata.answers, userMessageId: 'answer-user-1', clientResponseId: 'response-1' }, 'the unresolved batch remains pending');
  const recovered = pendingQuestionRequests({ questions: [{ ...asyncQuestion, answers: answerMetadata.answers }] }, 'conversation');
  assertDeepEqual(recovered[0]?.toolInput.questions, asyncQuestion.request.questions, 'recovery preserves full question ordering');
  assertDeepEqual(recovered[0]?.answers, answerMetadata.answers, 'recovery identifies only already answered keys');
});

h.test('question requests and answers retire on their own terminal turn and engine connection', () => {
  for (const terminal of ['done', 'disconnect'] as const) {
    const f = fixture(); f.state.markTurnRunning('conversation', 'turn-1');
    f.pump.receive({ type: 'productEvent', method: 'question/requested', params: { sessionId: 'engine-session', question: asyncQuestion } }, 1);
    f.delivered.length = 0;
    if (terminal === 'done') f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'turn-1', result: { stopReason: 'completed' } } }, 1);
    else f.pump.receive({ type: 'streamClosed' }, 1);
    f.forwarder.close();
    assertDeepEqual(f.delivered.filter(row => row.channel === 'question:resolved').map(row => row.value), [
      { sessionId: 'conversation', requestId: 'question-1', turnId: 'turn-1', state: 'expired', answers: {} },
    ], `${terminal} removes the interactive chip without inventing an answer`);
  }
});

h.test('unknown sessions, malformed records, old generations and unrelated terminal turns cannot change a pending question', () => {
  const f = fixture(); f.state.markTurnRunning('conversation', 'turn-1');
  const event = (sessionId: string, question: Json): ClientEvent => ({ type: 'productEvent', method: 'question/requested', params: { sessionId, question } });
  f.pump.receive(event('unknown-session', asyncQuestion), 1);
  f.pump.receive(event('engine-session', asyncQuestion), 0);
  f.pump.receive(event('engine-session', { ...asyncQuestion, requestId: '' }), 1);
  assertDeepEqual(f.delivered, [], 'invalid or stale questions never escape');
  f.pump.receive(event('engine-session', asyncQuestion), 1); f.delivered.length = 0;
  f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'other-turn', result: { stopReason: 'completed' } } }, 1);
  f.forwarder.close();
  assert(!f.delivered.some(row => row.channel === 'question:resolved'), 'another terminal turn cannot expire this chip');
  assert(f.state.isWorking('conversation'), 'the active turn remains running');
});

h.test('an accepted question resolution cannot attribute another request or user message to its answer', () => {
  const f = fixture(); f.state.markTurnRunning('conversation', 'turn-1');
  f.pump.receive({ type: 'productEvent', method: 'question/requested', params: { sessionId: 'engine-session', question: asyncQuestion } }, 1);
  f.delivered.length = 0;
  for (const userMessage of [
    { ...answerResolution.userMessage, uuid: 'another-user' },
    { ...answerResolution.userMessage, questionAnswer: { ...answerMetadata, requestId: 'another-question' } },
    { ...answerResolution.userMessage, questionAnswer: { ...answerMetadata, answers: { 'Which format?': 'Paragraph' } } },
  ]) f.pump.receive({ type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: { ...answerResolution, userMessage } } }, 1);
  f.forwarder.flush();
  assertDeepEqual(f.delivered, [], 'malformed receipts neither manufacture an answer bubble nor retire its pending question');
  f.pump.receive({ type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: answerResolution } }, 1);
  f.forwarder.close();
  assertDeepEqual(f.delivered.map(row => row.channel), ['chat:event:batch', 'question:resolved'], 'only the matching authoritative receipt resolves the question');
});

h.test('failed question persistence resets submitting state without fabricating an accepted user answer', () => {
  const f = fixture(); f.state.markTurnRunning('conversation', 'turn-1');
  f.pump.receive({ type: 'productEvent', method: 'question/requested', params: { sessionId: 'engine-session', question: {
    ...asyncQuestion, state: 'submitting', answers: answerMetadata.answers,
  } } }, 1);
  f.delivered.length = 0;
  const reset = { requestId: 'question-1', turnId: 'turn-1', state: 'pending', answers: answerMetadata.answers,
    userMessage: null, userMessageId: null, clientResponseId: null };
  for (let attempt = 0; attempt < 2; attempt++) {
    f.pump.receive({ type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: reset } }, 1);
  }
  f.forwarder.flush();
  assertDeepEqual(f.delivered, Array.from({ length: 2 }, () => ({ channel: 'question:resolved', value: {
    sessionId: 'conversation', requestId: 'question-1', turnId: 'turn-1', state: 'pending', answers: answerMetadata.answers,
  } })), 'each failed-write reset releases submitting while preserving previously accepted answers');
  assert(f.state.isWorking('conversation'), 'a failed write reset leaves its owning turn running');
  f.delivered.length = 0;
  for (const malformed of [
    { ...reset, state: 'answered' },
    { ...reset, userMessageId: 'answer-user-1' },
    { ...reset, clientResponseId: 'response-1' },
    { ...reset, userMessage: '' },
    { ...reset, userMessageId: '' },
  ] as Json[]) f.pump.receive({ type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: malformed } }, 1);
  f.forwarder.flush();
  assertDeepEqual(f.delivered, [], 'an incomplete or malformed accepted receipt cannot masquerade as a pending reset');
  f.pump.receive({ type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: answerResolution } }, 1);
  f.forwarder.close();
  assertDeepEqual(f.delivered.map(row => row.channel), ['chat:event:batch', 'question:resolved'], 'the later authoritative accepted receipt still inserts its real answer');
});

h.test('terminal settlement delivers admitted durable answers once and keeps the remaining request retired', () => {
  for (const state of ['cancelled', 'expired']) {
    const f = fixture(); f.state.markTurnRunning('conversation', 'turn-1');
    f.pump.receive({ type: 'productEvent', method: 'question/requested', params: { sessionId: 'engine-session', question: asyncQuestion } }, 1);
    f.delivered.length = 0;
    f.pump.receive({ type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: { ...answerResolution, state } } }, 1);
    f.pump.receive({ type: 'rawSessionEvent', params: { sessionId: 'engine-session', event: { type: 'question.resolved', questionResolved: { ...answerResolution, state } } } }, 1);
    f.pump.receive({ type: 'turnCompleted', params: { sessionId: 'engine-session', turnId: 'turn-1', result: { stopReason: 'completed' } } }, 1);
    f.forwarder.close();
    const chat = f.delivered.filter(row => row.channel === 'chat:event:batch').flatMap(row => row.value as Array<Record<string, Json>>);
    assertEqual(chat.filter(row => row.type === 'user_message').length, 1, 'terminal publication and its raw duplicate use one accepted answer UUID');
    assertDeepEqual(f.delivered.filter(row => row.channel === 'question:resolved').map(row => (row.value as Record<string, Json>).state), [state],
      'terminal answer delivery never reopens the unresolved question');
  }
});

h.test('saved question-answer metadata matches live answer attribution and rejects malformed metadata', () => {
  const projected = projectSessionHistory({ history: [{ type: 'user', uuid: 'answer-user-1', content: [{ type: 'text', text: 'List' }], questionAnswer: answerMetadata }],
    historyTurnIds: { 'answer-user-1': 'turn-1' } }, 'conversation') as Record<string, Json>;
  const row = (projected.messages as Array<Record<string, Json>>)[0]!;
  assertDeepEqual(row.questionAnswer, answerMetadata, 'question preview and submitted answers survive a history reload');
  assertEqual(row.steered, true, 'reloaded answer retains its non-opener semantics');
  assertEqual(row.turnId, 'turn-1', 'reloaded answer keeps the owner turn');
  assertEqual(questionAnswerMetadata({ ...answerMetadata, answers: { 'Unrelated question': 'Secret' } }), undefined, 'unrelated answer keys cannot acquire question attribution');
  assertEqual(questionAnswerMetadata({ ...answerMetadata, clientResponseId: null }), undefined, 'invalid submission identity is not rendered as an attributed answer');
});

h.test('question answer images use identical managed media paths in live events and replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-question-image-'));
  try {
    const f = fixture(undefined, undefined, root);
    f.state.markTurnRunning('conversation', 'turn-1');
    f.pump.receive({ type: 'productEvent', method: 'question/requested', params: { sessionId: 'engine-session', question: asyncQuestion } }, 1);
    f.delivered.length = 0;
    const content: Json[] = [{ type: 'text', text: 'List' }, { type: 'image', mimeType: 'image/png', base64: Buffer.from('question-image').toString('base64') }];
    const userMessage = { ...answerResolution.userMessage, content };
    f.pump.receive({ type: 'productEvent', method: 'question/resolved', params: { sessionId: 'engine-session', questionResolved: { ...answerResolution, userMessage } } }, 1);
    f.forwarder.close();
    const frame = (f.delivered[0]!.value as Array<Record<string, Json>>)[0]!;
    const live = (frame.message as Record<string, Json>).message as Record<string, Json>;
    const image = (live.content as Array<Record<string, Json>>).find(block => block.type === 'image')!;
    assertEqual(readFileSync(String(image.path), 'utf8'), 'question-image', 'the host stores the accepted answer image bytes');
    const replay = projectSessionHistory({ history: [{ ...userMessage, type: 'user' }] }, 'conversation', root) as Record<string, Json>;
    const row = (replay.messages as Array<Record<string, Json>>)[0]!;
    assertDeepEqual(row.contentBlocks, live.content, 'reload uses the same content and managed image path as the authoritative live bubble');
    assertDeepEqual(row.questionAnswer, live.questionAnswer, 'question attribution survives alongside image attachments');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

h.test('production mobile forwarding preserves native turn identity and normalizes legacy submission IDs', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/mobile-event-identity-vectors.json'), 'utf8')) as {
    cases: Array<{ name: string; input: ClientEvent; type: string; turnId?: string; messageId?: string; innerType?: string }>;
  };
  const f = fixture();
  f.pump.receive({ type: 'productEvent', method: 'turn/started', params: { sessionId: 'engine-session', submissionId: 'submit-1', detail: { turnId: 'turn-1' } } }, 1);
  f.forwarder.flush(); f.delivered.length = 0;
  for (const row of vector.cases) {
    if (row.innerType) continue;
    const input = row.input as ClientEvent & { params: Record<string, Json> };
    f.pump.receive({ ...input, params: { ...input.params, sessionId: 'engine-session' } } as ClientEvent, 1);
    f.forwarder.flush();
    const events = f.delivered.flatMap(value => value.value) as Array<Record<string, Json>>;
    const frame = events.find(value => value.type === row.type);
    assert(frame !== undefined, row.name + ': real forwarder delivered the item');
    assertEqual(frame.turnId, row.turnId === 'submit-1' ? 'turn-1' : row.turnId, row.name + ': core turn is stable');
    if (row.messageId) assertEqual(frame.messageId, row.messageId, row.name + ': item identity is stable');
    f.delivered.length = 0;
  }
  f.forwarder.close();
});

h.test('stable question IDs survive pending and saved-answer projections with identical prompts', () => {
  const questions = asyncQuestion.request.questions.map((question, index) => ({ ...question, id: `question-${index}`, question: 'Same prompt' }));
  const answers = { 'question-0': 'List', 'question-1': 'Commands' };
  const projected = pendingQuestionRequests({ questions: [{ ...asyncQuestion, request: { ...asyncQuestion.request, questions }, answers }] }, 'conversation');
  assertDeepEqual(projected[0]?.toolInput.questions, questions, 'question IDs remain attached to their prompts');
  assertDeepEqual(projected[0]?.answers, answers, 'same prompts retain separate answers');
  assertDeepEqual(questionAnswerMetadata({ ...answerMetadata, questions, answers })?.answers, answers, 'saved replies retain stable answer keys');
});

void h.finish(join(__dirname, 'session-events-result.json'), 'session-events').then(code => process.exit(code));
