import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { ClientEvent } from '../main/engine/protocol';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { requestAcknowledged } from '../main/engine/acknowledged';
import { HostState } from '../main/services/host-state';
import { object, string, type JsonObject } from '../main/services/service-types';
import { ThreadToolsService, registerThreadTools, THREAD_TOOL_SPECS, type ThreadToolContext } from '../main/services/thread-tools';
import { DynamicTools } from '../main/sessions/dynamic-tools';
import { createThreadWaitSignals } from '../main/services/thread-wait-signals';
import { SessionService } from '../main/sessions/service';
import { Harness, waitFor } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the real thread-tools gate');
const h = new Harness(), profile = mkdtempSync(join(tmpdir(), 'klaus-thread-tools-live-'));
const manager = new EngineManager('0.0.0-thread-tools-live'), state = new HostState();
const ids = ['614cc8f1-8c61-5f4f-8ef8-8199ba8b267a', '714cc8f1-8c61-5f4f-8ef8-8199ba8b267a', '814cc8f1-8c61-5f4f-8ef8-8199ba8b267a', '914cc8f1-8c61-5f4f-8ef8-8199ba8b267a'];
const target = ids[0]!, privateId = ids[3]!, privateIds = new Set([privateId]);
const options = { command: binary, args: [], cwd: profile,
  env: [['KLAUS_CONFIG_DIR', profile], ['KLAUS_SESSION_DIR', join(profile, 'sessions')], ['KLAUS_PLUGIN_HOME', join(profile, 'plugins')]] as [string, string][] };
const sessions = new SessionService({ manager, state, configRoot: profile, spawnOptions: () => options, pushChatEvents: () => {} });
const calls: Array<{ method: string; params: JsonObject }> = [];
const tools = new ThreadToolsService({ sessions: {
  request(method, params, timeout) { calls.push({ method, params }); return sessions.request(method, params, timeout); },
  listSessions: () => sessions.listSessions(), listArchivedSessions: () => sessions.listArchivedSessions(),
  deliverDelegation: (targetId, request) => sessions.deliverDelegation(targetId, request),
  newSession: options => sessions.newSession(options),
  forkSession: (rendererId, beforeMessageUuid) => sessions.forkSession(rendererId, beforeMessageUuid),
  rename: (id, title) => sessions.rename(id, title),
  setPinned: (id, pinned) => sessions.setPinned(id, pinned),
  setArchived: (id, archived) => sessions.setArchived(id, archived),
  directory: rendererId => sessions.directory(rendererId),
}, isPrivateThread: id => privateIds.has(id) });
const context: ThreadToolContext = { sessionId: 'trusted-fixture-caller', unattended: false, signal: new AbortController().signal, assertCurrent: () => {} };
/** A tool context whose calling conversation is `sessionId`, for delegation tests. */
const contextFor = (sessionId: string): ThreadToolContext => ({ ...context, sessionId });
let engine: ManagedEngine, modelRequests = 0, baseUrl = '';
/** Every loopback provider request, so a test can assert what the model actually saw. */
const requestBodies: JsonObject[] = [];
/**
 * When set, the fixture replies with a `tool_use` for this tool instead of text, so
 * a test can drive the engine into asking for permission. Cleared after one reply.
 */
let scriptedToolCall: { name: string; input: JsonObject } | null = null;
/**
 * When set, the fixture holds each request open until this resolves, so a turn
 * stays RUNNING while a test delivers into it. This is the only way to exercise
 * the steer route against the real engine — without it every turn completes before
 * a delivery can land, and the running-recipient path (the one that folds a
 * message into the turn in flight instead of starting a new one) is never tested.
 */
let holdProvider: { gate: Promise<void>; requests: number } | null = null;
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/messages') { response.writeHead(404); response.end('No fixture route'); return; }
  void (async () => {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 1024 * 1024) throw new Error('Fixture request too large'); chunks.push(buffer); }
    const body = object(JSON.parse(Buffer.concat(chunks).toString()));
    assert.equal(request.headers['x-api-key'], 'fixture-only-key'); modelRequests += 1; requestBodies.push(body);
    if (holdProvider) { holdProvider.requests += 1; await holdProvider.gate; }
    if (scriptedToolCall) {
      // One tool call, then back to text. Shape mirrors memory-snapshots-live: a
      // tool_use block opened with empty input, streamed as input_json_delta, and
      // closed with stop_reason tool_use so the engine treats it as a real call.
      const call = scriptedToolCall; scriptedToolCall = null;
      const block = { type: 'tool_use', id: 'fixture-tool-call', name: call.name, input: call.input };
      const toolEvents = [
        { type: 'message_start', message: { id: 'fixture-tool', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { ...block, input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(toolEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    const events = [
      { type: 'message_start', message: { id: 'fixture-answer', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A real newer turn from the loopback fixture.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }, { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  })().catch(error => { process.stderr.write('Thread fixture provider: ' + String(error) + '\n'); if (!response.headersSent) response.writeHead(500); response.end('fixture failure'); });
});
const request = (method: string, params: JsonObject) => engine.client.requestWithTimeout(method, params, 20_000);
function result(value: Json, success = true): JsonObject {
  const envelope = object(value); assert.equal(envelope.success, success);
  const text = String((envelope.contentItems as JsonObject[])[0]!.text);
  if (!success) return { text };
  return object(JSON.parse(text));
}

h.test('real named imports and one loopback turn create a durable pageable transcript in an isolated profile', async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object'); baseUrl = `http://127.0.0.1:${address.port}`;
  engine = await manager.attach(options);
  for (const [index, threadId] of ids.entries()) {
    const value = object(await request('engine/importExternalSession', { threadId, cwd: profile, title: threadId === privateId ? 'PRIVATE SANDBOX FIXTURE' : `Public fixture ${index}`,
      source: { providerId: 'qoder', format: 'claude-jsonl', path: join(profile, `fixture-${index}.jsonl`), contentSha256: String(index).repeat(64) },
      hostMetadata: { ...(index === 0 || index === 3 ? { sidebarPinnedAt: index + 1 } : {}), retrievalSummary: `stored summary ${index}` },
      messages: [{ role: 'user', text: 'Original imported question', timestampMs: 1_700_000_000_000 + index }, { role: 'assistant', text: 'Original imported answer', timestampMs: 1_700_000_001_000 + index }] }));
    assert.equal(value.persisted, true);
  }
  const started = object(await request('session/start', { resume: target, init: { threadId: target, cwd: profile,
    provider: { type: 'anthropic', model: 'fixture-thread-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-only-key' },
    config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxOutputTokens: 1024 } } }));
  assert.equal(started.sessionId, target);
  let completed = false;
  const receive = (event: ClientEvent) => { if (event.type === 'turnCompleted' && object(event.params).sessionId === target) completed = true; };
  engine.client.on('event', receive);
  try {
    await request('session/subscribe', { sessionId: target }); await request('turn/start', { sessionId: target, input: 'Create the newer turn.' });
    await waitFor(() => completed, 20_000, 'real turn completion'); assert.equal(modelRequests, 1);
  } finally { engine.client.off('event', receive); await request('session/close', { sessionId: target }); }
});
h.test('real read_thread pages recent and older turns with one facade request per call and no task activation', async () => {
  const before = calls.length;
  const recent = result(await tools.execute('read_thread', { threadId: target }, context));
  assert.equal(calls.length - before, 1); assert.equal(object(recent.page).hasMore, true);
  assert.equal((recent.turns as Json[]).length, 1); assert(JSON.stringify(recent.turns).includes('A real newer turn from the loopback fixture.'));
  const cursor = object(recent.page).nextCursor!;
  const older = result(await tools.execute('read_thread', { threadId: target, cursor }, context));
  assert.equal(calls.length - before, 2); assert.equal((older.turns as Json[]).length, 1); assert.equal(object(older.page).hasMore, false);
  assert.notEqual(object((recent.turns as Json[])[0]).id, object((older.turns as Json[])[0]).id);
  assert(JSON.stringify(older.turns).includes('Original imported question')); assert.deepEqual(state.bindings(), []); assert.equal(modelRequests, 1);
  assert.deepEqual(calls.at(-1), { method: 'engine/readThread', params: { threadId: target, limit: 1, cursor } });
});
h.test('a real cross-conversation delivery reaches the recipient engine as a delegation envelope and starts its turn', async () => {
  const recipient = ids[1]!, caller = ids[2]!;
  // Start the recipient on the loopback provider and bind it, the way the first
  // test does for `target`. Delivery then resolves an EXISTING live binding rather
  // than building an init from profile config, which keeps this test about the
  // delivery path and not about provider configuration.
  const started = object(await request('session/start', { resume: recipient, init: { threadId: recipient, cwd: profile,
    provider: { type: 'anthropic', model: 'fixture-thread-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-only-key' },
    config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxOutputTokens: 1024 } } }));
  assert.equal(started.sessionId, recipient);
  state.rememberSession(recipient, recipient, {}, { source: 'custom', selection: 'custom:fixture' });
  await request('session/subscribe', { sessionId: recipient });
  let completed = false, completedTurnId = '';
  const receive = (event: ClientEvent) => {
    if (event.type === 'turnCompleted' && object(event.params).sessionId === recipient) {
      completed = true;
      // Capture the identity the engine assigned, so the delegated turn can be
      // shown to carry the `delegation-` prefix through the REAL binary rather
      // than only in the unit fixture.
      const params = object(event.params);
      completedTurnId = string(params.turnId ?? params.submissionId ?? '');
    }
  };
  engine.client.on('event', receive);
  const turnsBefore = modelRequests, bodiesBefore = requestBodies.length;
  try {
    const delivered = result(await tools.execute('send_message_to_thread',
      { threadId: recipient, prompt: 'Finish the parser fix and report back.' }, contextFor(caller)));
    assert.equal(delivered.ok, true);
    assert.equal(delivered.delivered, 'started', 'an idle recipient gets a new turn');
    assert.equal(delivered.overridesApplied, false, 'no model or thinking override was requested');
    assert.equal(delivered.archived, false);
    // The recipient really ran: this is the end-to-end proof that a conversation
    // can start work in another one.
    await waitFor(() => completed, 20_000, 'the recipient ran a real turn');
    assert(modelRequests > turnsBefore, 'the loopback provider was called for the recipient');
    // What the recipient's MODEL saw must be the envelope naming the CALLER — that
    // source id is the only thing that makes a reply with send_message_to_thread
    // possible, and the prompt must survive the escaping intact.
    const sent = requestBodies.slice(bodiesBefore).map(body => JSON.stringify(body)).join('\n');
    assert(sent.includes('<source-thread-id>'), 'the delegation envelope reached the provider request');
    assert(sent.includes(caller), 'the envelope names the sending conversation');
    assert(sent.includes('Finish the parser fix and report back.'), 'the prompt arrived verbatim');
    // The turn id the engine echoed back is the one the host supplied, so the
    // delegated turn is identifiable in the engine's own records — the same
    // provenance `channel-` gives an IM turn and `steer-` a follow-up.
    assert.match(completedTurnId, /^delegation-/, 'the engine kept the delegated turn identity');
    // In a JSON-stringified body a REAL newline shows as the two characters `\n`,
    // while a double-escaped envelope shows as `\\n`. Requiring the first and
    // rejecting the second is what proves the envelope kept its line structure
    // instead of arriving as literal backslash text.
    assert(sent.includes('<klaus-delegation>\\n'), 'the envelope keeps real newlines');
    assert(!sent.includes('<klaus-delegation>\\\\n'), 'the envelope is not double-escaped');
  } finally {
    engine.client.off('event', receive);
    await request('session/close', { sessionId: recipient });
    // Release the binding this test added so later tests (which archive and delete
    // by id) see a clean host state, exactly as `session/close` leaves `target` in
    // the first test.
    state.forgetSession(recipient);
  }
});
h.test('a real delivery into a RUNNING conversation reaches its model and reports what the sender cannot see', async () => {
  // This is the route no other test covered, and the one that produced a real
  // overnight failure: a coordinator sent the same message four times to a worker
  // that had received all four and had been answering. Every earlier assertion
  // used an IDLE recipient, which starts a new turn and leaves a normal user
  // message behind — so the whole "where did my message go" failure mode was
  // invisible to the suite.
  //
  // It needs the REAL engine because the question is what the engine does with a
  // mid-turn message: a host-level fake would only prove the host's own guess.
  const recipient = ids[1]!, caller = ids[2]!;
  const started = object(await request('session/start', { resume: recipient, init: { threadId: recipient, cwd: profile,
    provider: { type: 'anthropic', model: 'fixture-thread-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-only-key' },
    config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxOutputTokens: 1024 } } }));
  assert.equal(started.sessionId, recipient);
  state.rememberSession(recipient, recipient, {}, { source: 'custom', selection: 'custom:fixture' });

  // Hold the provider open so the first turn is still RUNNING when the delivery
  // arrives; otherwise it completes first and the host would take the turn route.
  let release!: () => void;
  holdProvider = { gate: new Promise<void>(resolve => { release = resolve; }), requests: 0 };
  const bodiesBefore = requestBodies.length;
  // Baseline the recipient's transcript BEFORE the delivery. This thread is reused
  // by an earlier test, so asserting an absolute turn count here would depend on
  // what that test left behind; asserting the DELTA depends only on this one.
  const readTurns = async (): Promise<Json[]> => {
    const page = result(await tools.execute('read_thread', { threadId: recipient, turnLimit: 10, includeOutputs: true }, contextFor(caller)));
    return page.turns as Json[];
  };
  const turnsBefore = await readTurns();
  const userTextOf = (turns: Json[]): string => turns
    .flatMap(turn => (object(turn).items as Json[]).filter(item => object(item).type === 'userMessage'))
    .map(message => JSON.stringify(object(message).content)).join('\n');
  assert(!userTextOf(turnsBefore).includes('Stop and report what you found instead.'),
    'the steered text is not in the transcript before it is sent');
  // Registered BEFORE the provider is released: the turn completes as soon as the
  // engine gets its second provider reply, so a listener attached after that point
  // waits forever for an event that already fired.
  let completed = false;
  const receive = (event: ClientEvent) => { if (event.type === 'turnCompleted' && object(event.params).sessionId === recipient) completed = true; };
  try {
    await request('session/subscribe', { sessionId: recipient });
    engine.client.on('event', receive);
    const submissionId = 'fixture-running-delegation';
    const firstTurn = request('turn/start', { sessionId: recipient, submissionId, input: 'Start the long investigation.' });
    // Wait until the engine has actually asked the provider, which is what makes
    // the turn live rather than merely requested.
    await waitFor(() => holdProvider!.requests > 0, 20_000, 'the recipient turn is in flight');
    state.markTurnRunning(recipient, submissionId, submissionId);

    const delivered = result(await tools.execute('send_message_to_thread',
      { threadId: recipient, prompt: 'Stop and report what you found instead.' }, contextFor(caller)));
    assert.equal(delivered.ok, true);
    assert.equal(delivered.delivered, 'steered', 'a running recipient is steered, not given a new turn');

    // Admission is not application. The sender must inspect the recipient's
    // queue and replies before retrying, especially if its owner stops the turn.
    assert.equal(typeof delivered.notice, 'string', 'a steered delivery always carries a notice');
    assert.match(String(delivered.notice), /admitted to its queue; application is not yet confirmed/i);
    assert.match(String(delivered.notice), /stops or fails before consuming it/i);
    assert.match(String(delivered.notice), /remains queued for the recipient owner to resume/i);
    assert.match(String(delivered.notice), /check queued messages and replies before resending/i);
    assert.equal(typeof delivered.messageId, 'string', 'the admitted input has a stable message identity');
    assert.equal(delivered.overridesApplied, false, 'no overrides were requested, so none applied');

    // 2. THE MODEL REALLY SAW IT, INSIDE THE SAME PROVIDER REQUEST SERIES. Release
    //    the provider and let the engine make its next call: the steering text must
    //    be in what the model receives. With no tool call in flight the engine
    //    preserves the delegation envelope when the queued input is consumed.
    release();
    await waitFor(() => requestBodies.length > bodiesBefore + 1, 30_000,
      'the engine made another provider call after the steering message');
    const laterBodies = requestBodies.slice(bodiesBefore + 1).map(body => JSON.stringify(body)).join('\n');
    assert(laterBodies.includes('Stop and report what you found instead.'),
      'the steered prompt reached the recipient model');
    assert(laterBodies.includes('<source-thread-id>'),
      'and it reached the model inside the delegation envelope, so a reply can be addressed');
    assert(laterBodies.includes(caller), 'the envelope names the sending conversation');

    // 3. THE TURN STILL COMPLETES — steering did not corrupt or stall it.
    await firstTurn;
    await waitFor(() => completed, 20_000, 'the steered turn finished');

    // This no-tools delegation stays queued until the running turn finishes,
    // then becomes a durable user message in its own continuation turn.
    const turnsAfter = await readTurns();
    const userText = userTextOf(turnsAfter);
    assert(userText.includes('Stop and report what you found instead.'),
      'the drained input is a durable native user message');
    assert(userText.includes('<klaus-delegation>'),
      'and it is still wrapped, so the recipient can address its reply to the sender');
    const carrying = turnsAfter.filter(turn =>
      userTextOf([turn]).includes('Stop and report what you found instead.'));
    assert.equal(carrying.length, 1, 'exactly one turn carries the delegated message');
    assert(!userTextOf(carrying).includes('Start the long investigation.'),
      'the deferred delegation belongs to its own continuation turn');
    assert.equal(turnsAfter.length, turnsBefore.length + 2,
      'the initial turn and deferred delegation create two new turns');
  } finally {
    if (holdProvider) release();
    holdProvider = null;
    engine.client.off('event', receive);
    await request('session/close', { sessionId: recipient }).catch(() => undefined);
    state.forgetSession(recipient);
  }
});

h.test('a real wait_threads wakes on a real turn completion and reports engine-read progress', async () => {
  // Everything here is production wiring: the signal hub, the coordinator, and
  // `engine/readThread` against the real binary. The unit suites cover the wake
  // rules with fake state; this covers the part they cannot — that the engine's
  // actual thread projection yields a status, a turn id and text that the
  // coordinator recognizes as a completed target.
  const waitTarget = ids[1]!, waiter = ids[2]!;
  const signals = createThreadWaitSignals();
  // This test builds its own service (the file-level `tools` has no wait signals
  // wired), so it needs its own call recorder: asserting against `calls` would
  // inspect a different instance's traffic and never see this service's reads.
  const waitCalls: string[] = [];
  const waitingTools = new ThreadToolsService({ sessions: {
    request: (method, params, timeout) => { waitCalls.push(method); return sessions.request(method, params, timeout); },
    listSessions: () => sessions.listSessions(), listArchivedSessions: () => sessions.listArchivedSessions(),
    deliverDelegation: (targetId, request) => sessions.deliverDelegation(targetId, request),
    newSession: options => sessions.newSession(options),
    forkSession: (rendererId, beforeMessageUuid) => sessions.forkSession(rendererId, beforeMessageUuid),
    rename: (id, title) => sessions.rename(id, title),
    setPinned: (id, pinned) => sessions.setPinned(id, pinned),
    setArchived: (id, archived) => sessions.setArchived(id, archived),
    directory: rendererId => sessions.directory(rendererId),
  }, isPrivateThread: id => privateIds.has(id), wait: signals });

  const started = object(await request('session/start', { resume: waitTarget, init: { threadId: waitTarget, cwd: profile,
    provider: { type: 'anthropic', model: 'fixture-thread-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-only-key' },
    config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxOutputTokens: 1024 } } }));
  assert.equal(started.sessionId, waitTarget);
  state.rememberSession(waitTarget, waitTarget, {}, { source: 'custom', selection: 'custom:fixture' });

  // The hub is fed exactly as runtime.ts feeds it: every engine event goes in.
  const pump = (event: ClientEvent) => signals.engineChanged(event);
  engine.client.on('event', pump);
  try {
    await request('session/subscribe', { sessionId: waitTarget });
    const baseline = result(await waitingTools.execute('wait_threads',
      { targets: [{ threadId: waitTarget }], timeoutMs: 0 }, contextFor(waiter)));
    const previousCursor = object((baseline.polls as Json[])[0]!).cursor;
    assert(typeof previousCursor === 'string', 'the reused recipient has a previous durable turn cursor');
    const requestsBefore = waitCalls.length;
    // Start the wait FIRST so it is actually blocked when the turn finishes; a
    // wait started after completion would pass by polling and prove nothing.
    const waiting = waitingTools.execute('wait_threads',
      { targets: [{ threadId: waitTarget, afterCursor: previousCursor }], timeoutMs: 20_000 }, contextFor(waiter));
    await new Promise(resolve => setTimeout(resolve, 200));
    await request('turn/start', { sessionId: waitTarget, input: 'Do the waited-on work.' });

    const outcome = result(await waiting);
    assert.equal(outcome.timedOut, false, 'the wait did not run out its timeout');
    const wake = object(outcome.wake!);
    assert.equal(wake.reason, 'turnCompleted', 'woken by the real turn completing');
    assert.equal(wake.threadId, waitTarget);
    const poll = object((outcome.polls as Json[])[0]!);
    assert.equal(poll.threadId, waitTarget);
    // The owner remains loaded until finally; completion makes it idle.
    assert.equal(poll.status, 'idle', 'the engine reports the loaded completed owner as idle');
    assert.equal(poll.turnStatus, 'completed');
    // The cursor is `turnId:status` from the engine's own turn identity, which is
    // what a caller passes back to suppress already-delivered text.
    assert.match(String(poll.cursor), /^[^:]+:completed$/, 'the cursor names the completed turn');
    assert.notEqual(poll.cursor, previousCursor, 'the wake belongs to the newly started turn');
    assert.equal(poll.changed, true);
    // It went through the real facade, not a stub.
    assert(waitCalls.slice(requestsBefore).includes('engine/readThread'),
      'the wait read target state through engine/readThread');
  } finally {
    engine.client.off('event', pump);
    await request('session/close', { sessionId: waitTarget }).catch(() => undefined);
    state.forgetSession(waitTarget);
  }
});

h.test('a real wait_threads with timeoutMs zero snapshots without waiting', async () => {
  const signals = createThreadWaitSignals();
  const snapshotTools = new ThreadToolsService({ sessions: {
    request: (method, params, timeout) => sessions.request(method, params, timeout),
    listSessions: () => sessions.listSessions(), listArchivedSessions: () => sessions.listArchivedSessions(),
    deliverDelegation: (targetId, request) => sessions.deliverDelegation(targetId, request),
    newSession: options => sessions.newSession(options),
    forkSession: (rendererId, beforeMessageUuid) => sessions.forkSession(rendererId, beforeMessageUuid),
    rename: (id, title) => sessions.rename(id, title),
    setPinned: (id, pinned) => sessions.setPinned(id, pinned),
    setArchived: (id, archived) => sessions.setArchived(id, archived),
    directory: rendererId => sessions.directory(rendererId),
  }, isPrivateThread: id => privateIds.has(id), wait: signals });
  // The first test's `target` finished a turn and was closed, so it reads as an
  // unloaded thread with completed history. A `timeoutMs: 0` probe must report that
  // finished work immediately as a wake — that is the point of an immediate
  // snapshot: a coordinator learns "this one is already done" without blocking.
  const startedAt = Date.now();
  const outcome = result(await snapshotTools.execute('wait_threads',
    { targets: [{ threadId: target }], timeoutMs: 0 }, contextFor(ids[2]!)));
  assert.equal(outcome.timedOut, false, 'an already-finished target is reported at once, not as a timeout');
  assert.equal(object(outcome.wake!).reason, 'turnCompleted', 'the immediate snapshot sees the completed turn');
  assert.equal(object(outcome.wake!).threadId, target);
  assert.equal((outcome.polls as Json[]).length, 1, 'the snapshot carries the target');
  assert.equal(object((outcome.polls as Json[])[0]!).status, 'notLoaded');
  assert(Date.now() - startedAt < 10_000, 'timeoutMs 0 returns at once');
});

h.test('real list summaries retain public pins and exclude the durable private task before limiting results', async () => {
  const listed = result(await tools.execute('list_threads', { limit: 1 }, context));
  assert.deepEqual((listed.pinnedThreads as JsonObject[]).map(row => [row.id, row.pinnedIndex]), [[target, 1]]);
  assert.equal((listed.threads as Json[]).length, 1); assert(!JSON.stringify(listed).includes(privateId)); assert(!JSON.stringify(listed).includes('PRIVATE SANDBOX'));
  const before = calls.length; result(await tools.execute('read_thread', { threadId: privateId }, context), false); assert.equal(calls.length, before);
});
/**
 * The design's load-bearing assumption, end to end through the real binary.
 *
 * The whole mutating half of this feature rests on one claim: declaring
 * `readOnly: false` on a host tool spec is what makes the engine ask the user
 * before it runs. Each link is tested separately elsewhere — the engine's adapter
 * returns the host's declaration (`server_tests.rs`), the permission engine turns
 * a non-read-only tool into `Ask` (`permission/engine.rs`), and the specs declare
 * it — but nothing proved the composition for THESE specs
 * in a real process. A wrong `readOnly` here would silently let one conversation
 * write into another with no prompt.
 */
h.test('a real send_message_to_thread call asks the user for approval before the host runs it', async () => {
  const approvalThread = ids[2]!;
  // The specs go in exactly as production sends them, so the engine sees the same
  // `readOnly` declarations the app would give it.
  const started = object(await request('session/start', { resume: approvalThread, init: { threadId: approvalThread, cwd: profile,
    provider: { type: 'anthropic', model: 'fixture-thread-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-only-key' },
    dynamicTools: THREAD_TOOL_SPECS,
    config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxOutputTokens: 1024 } } }));
  assert.equal(started.sessionId, approvalThread);

  // A reverse request IS the engine asking. Capture it without answering, which
  // leaves the turn parked in exactly the state the user would see.
  const seen: Array<{ method: string; params: JsonObject }> = [];
  const receive = (event: ClientEvent) => {
    if (event.type !== 'reverseRequest') return;
    seen.push({ method: event.request.method, params: object(event.request.params) });
  };
  engine.client.on('event', receive);
  await request('session/subscribe', { sessionId: approvalThread });
  scriptedToolCall = { name: 'send_message_to_thread', input: { threadId: target, prompt: 'Needs approval.' } };
  try {
    // Deliberately NOT awaited: turn/start resolves only when the turn finishes,
    // and it cannot finish while the approval sits unanswered. Awaiting it would
    // just wait out the 20s timeout and fail.
    void request('turn/start', { sessionId: approvalThread, input: 'Delegate please.' }).catch(() => undefined);
    await waitFor(() => seen.length > 0, 20_000, 'the engine asked the user before running the host tool');
    assert.equal(seen[0]!.method, 'approval/request', 'writing into another conversation is an approval, not an elicitation');
    assert.equal(string(object(seen[0]!.params).sessionId), approvalThread, 'the request names the calling session');
    assert.equal(string(object(seen[0]!.params.request).toolName), 'send_message_to_thread', 'the prompt names the tool the model called');
    // The read tools declared `readOnly: true` must NOT have prompted first: if they
    // had, seen[0] would name one of them and the mutating tools would be no
    // stricter than a read.
    assert.equal(seen.length, 1, 'exactly one approval, for the mutating tool');
  } finally {
    engine.client.off('event', receive);
    scriptedToolCall = null;
    // Release the parked turn rather than leaving a live session for later tests.
    await request('turn/interrupt', { sessionId: approvalThread }).catch(() => undefined);
    await request('session/close', { sessionId: approvalThread }).catch(() => undefined);
    state.forgetSession(approvalThread);
  }
});

/**
 * The other half of the permission gate, also through the real binary.
 *
 * Default mode asks; plan mode must DENY outright, because plan mode is read-only
 * and a conversation delivering into another one is a mutation. Asserting only the
 * approval path would leave open the worst failure: a plan-mode session writing
 * into another conversation. The read tool is exercised in the same session to show
 * the gate is per-tool and not a blanket block — `read_thread` still runs.
 */
h.test('plan mode denies send_message_to_thread outright while read_thread still runs', async () => {
  const planThread = ids[2]!;
  const dynamicErrors: string[] = [];
  let hostCalls = 0, readCalls = 0, readReply: Json | undefined;
  const dynamic = new DynamicTools({ request, knownSession: id => id === planThread,
    log: message => { if (dynamicErrors.length < 4) dynamicErrors.push(message.slice(-2048)); } });
  registerThreadTools({ register(spec, handler, options) {
    const name = string(object(spec).name);
    dynamic.register(spec, async (input, engineId, signal) => {
      hostCalls += 1;
      const response = await handler(input, engineId, signal);
      if (name === 'read_thread') { readCalls += 1; readReply = response; }
      return response;
    }, options);
  } }, tools, (engineId, signal) => ({ ...contextFor(engineId), signal,
    assertCurrent: () => { signal.throwIfAborted(); assert.equal(engineId, planThread); } }));
  const started = object(await request('session/start', { resume: planThread, init: { threadId: planThread, cwd: profile,
    provider: { type: 'anthropic', model: 'fixture-thread-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-only-key' },
    dynamicTools: dynamic.definitions(), permissionMode: 'default',
    config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxOutputTokens: 1024 } } }));
  assert.equal(started.sessionId, planThread);

  const beforeMode = modelRequests;
  const selected = object(await request('session/setCollaborationMode', { sessionId: planThread, mode: 'plan' }));
  const observed = object(await request('session/collaborationMode', { sessionId: planThread }));
  assert.equal(object(selected.planning).mode, 'plan', 'the named setter enters independent Plan collaboration');
  assert.equal(object(observed.planning).mode, 'plan', 'an independent read confirms Plan before the model turn');
  assert.equal(object(observed.planning).revision, object(selected.planning).revision, 'the read retains the acknowledged mode revision');
  assert.equal(modelRequests, beforeMode, 'setting and reading collaboration mode performs no inference');

  const approvals: string[] = [];
  let completed = false, completedTurnId = '';
  const receive = (event: ClientEvent) => {
    dynamic.receive(event, engine.generation);
    if (event.type === 'reverseRequest') approvals.push(event.request.method);
    if (event.type === 'turnCompleted' && object(event.params).sessionId === planThread) {
      completed = true; completedTurnId = string(object(event.params).turnId);
    }
  };
  const actualToolResult = (): JsonObject => {
    const messages = requestBodies.at(-1)?.messages;
    assert(Array.isArray(messages), 'the actual provider request retains native messages');
    const last = object(messages.at(-1));
    assert.equal(last.role, 'user', 'the follow-up request ends with the actual tool result');
    assert(Array.isArray(last.content), 'the actual tool result retains its native block array');
    const results = last.content.map(object).filter(block => block.type === 'tool_result' && block.tool_use_id === 'fixture-tool-call');
    assert.equal(results.length, 1, 'the current native tool call has exactly one correlated result');
    return results[0]!;
  };
  engine.client.on('event', receive);
  await request('session/subscribe', { sessionId: planThread });
  scriptedToolCall = { name: 'send_message_to_thread', input: { threadId: target, prompt: 'Must be denied.' } };
  try {
    // A denied mutation returns to the model without asking the host to execute it.
    const beforeDeniedTurn = modelRequests;
    const deniedTurn = object(await request('turn/start', { sessionId: planThread, input: 'Try to delegate.' }));
    await waitFor(() => completed, 20_000, 'the turn finished without waiting on a prompt');
    assert.deepEqual(approvals, [], 'plan mode never offers to run a mutation, it refuses');
    assert.equal(typeof deniedTurn.turnId, 'string', 'the denied turn has its real facade identity');
    assert.equal(completedTurnId, deniedTurn.turnId, 'the actual denied-tool turn completed');
    assert.equal(modelRequests, beforeDeniedTurn + 2, 'the denied tool result reaches one actual model follow-up');
    assert.equal(actualToolResult().is_error, true, 'the model receives an explicit denial result');
    assert.equal(hostCalls, 0, 'Plan denied the mutation before any host tool handler ran');

    // Keep the same live Plan session and execute the read through the real model bridge.
    completed = false;
    const beforeReadTurn = modelRequests;
    scriptedToolCall = { name: 'read_thread', input: { threadId: target } };
    const readTurn = object(await request('turn/start', { sessionId: planThread, input: 'Read the fixture conversation.' }));
    await waitFor(() => completed, 20_000, 'the Plan read tool turn completed through the actual engine');
    assert.equal(typeof readTurn.turnId, 'string', 'the read turn has its real facade identity');
    assert.equal(completedTurnId, readTurn.turnId, 'the actual read-tool turn completed');
    assert.equal(modelRequests, beforeReadTurn + 2, 'the real read result reaches one actual model follow-up');
    assert.equal(hostCalls, 1, 'only the read tool reached the production host dispatcher');
    assert.equal(readCalls, 1, 'the read handler ran exactly once');
    assert(readReply !== undefined, 'the production read handler returned its actual response');
    const readResult = result(readReply);
    assert.equal(typeof object(readResult.thread).id, 'string', 'a read tool still resolves in the same Plan session');
    assert.equal(object(readResult.thread).id, target, 'the actual read returned the requested fixture identity');
    const nativeResult = actualToolResult();
    assert.notEqual(nativeResult.is_error, true, 'the model receives a successful read result');
    const nativeContent = nativeResult.content;
    assert(typeof nativeContent === 'string' || Array.isArray(nativeContent), 'the native read result retains textual content');
    const nativeText = typeof nativeContent === 'string' ? nativeContent : nativeContent.map(block => string(object(block).text)).join('');
    assert.equal(nativeText, string(object((object(readReply).contentItems as Json[])[0]).text), 'the model receives the exact production host read result');
    assert.deepEqual(approvals, [], 'neither Plan mutation denial nor the read requests approval');
    assert.deepEqual(dynamicErrors, [], 'the real dynamic-tool bridge completed without errors');
    const afterRead = object(await request('session/collaborationMode', { sessionId: planThread }));
    assert.equal(object(afterRead.planning).mode, 'plan', 'the same live conversation remains in Plan after the read');
  } finally {
    engine.client.off('event', receive);
    scriptedToolCall = null;
    try { await dynamic.close(); }
    finally {
      await request('session/close', { sessionId: planThread }).catch(() => undefined);
      state.forgetSession(planThread);
    }
  }
});

h.test('real archived pages preserve cursor exclusivity while a private archived row remains invisible', async () => {
  // Baseline the model count: this test's real claim is that archiving and listing
  // NEVER call the model. A global `=== 1` would silently also assert "no earlier
  // test used the model", which is not this test's business — the delegation test
  // above legitimately does.
  const turnsBefore = modelRequests;
  for (const threadId of ids.slice(1)) await requestAcknowledged(engine.client, 'session/archiveSession', { threadId }, 'archived', 20_000);
  const first = result(await tools.execute('list_archived_threads', { limit: 1 }, context));
  assert.equal((first.threads as Json[]).length, 1); assert.equal(typeof first.nextCursor, 'string');
  const second = result(await tools.execute('list_archived_threads', { limit: 1, cursor: first.nextCursor! }, context));
  assert.equal((second.threads as Json[]).length, 1); assert.equal(second.nextCursor, null);
  assert.notEqual(object((first.threads as Json[])[0]).id, object((second.threads as Json[])[0]).id);
  assert(!JSON.stringify([first, second]).includes(privateId));
  assert.equal(modelRequests, turnsBefore, 'archiving and listing never call the model');
});
h.test('a deleted real thread fails instead of returning fake empty history and all owned engine work is reaped', async () => {
  for (const threadId of ids) {
    const deleted = object(await requestAcknowledged(engine.client, 'session/deleteSession', { threadId }, 'deleted', 20_000)); assert.equal(deleted.deleted, true);
  }
  result(await tools.execute('read_thread', { threadId: target }, context), false);
  await tools.close(); await sessions.shutdown(); assert.equal(manager.liveProcessCount(), 0);
});
void h.finish(join(profile, 'result.json'), 'thread-tools-live').then(async code => {
  try { await tools.close(); await sessions.shutdown(); }
  finally {
    server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(profile, { recursive: true, force: true });
  }
  process.exitCode = code;
}).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
