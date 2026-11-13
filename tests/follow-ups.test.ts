import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { ClientEvent } from '../main/engine/protocol';
import { FollowUps, type FollowUpRequest } from '../main/sessions/follow-ups';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/follow-up-delivery-vectors.json'), 'utf8')) as {
  identity: Pick<FollowUpRequest, 'sessionId' | 'engineSessionId' | 'messageId' | 'text' | 'delivery' | 'targetTurnId'>;
  request: { method: string; params: Record<string, Json> };
  delegationRequest: { method: string; params: Record<string, Json> };
  ack: Json; reply: Json; queued: Json; applied: Json;
  delegationIdentity: Pick<FollowUpRequest, 'sessionId' | 'engineSessionId' | 'messageId' | 'text' | 'delivery' | 'targetTurnId'>;
  delegationQueued: Json; delegationApplied: Json;
  outcomes: Array<{ name: string; envelope: Record<string, Json>; state: string; error?: string; reason?: string }>;
};
class Client extends EventEmitter {
  calls: Array<{ method: string; params: Json }> = [];
  response: () => Promise<unknown> = async () => vector.ack;
  async requestWithTimeout(method: string, params: Json): Promise<unknown> { this.calls.push({ method, params }); return this.response(); }
  outcome(envelope: Record<string, Json>, sessionId = 'engine-session', submissionId = 'steer-message-one', type: 'rawSessionEvent' | 'sessionEvent' | 'engineEvent' = 'rawSessionEvent'): void {
    this.emit('event', { type, params: { sessionId, event: { submissionId, ...envelope } } } satisfies ClientEvent);
  }
}
function fixture(timeoutMs?: number) {
  const client = new Client(), events: Json[] = [];
  let current = true;
  const followUps = new FollowUps(batch => { events.push(...batch); }, timeoutMs);
  const request: FollowUpRequest = { ...vector.identity, client, input: vector.identity.text,
    assertCurrent: () => { if (!current) throw new Error('The original engine binding was replaced'); } };
  return { client, events, followUps, request, replace: () => { current = false; } };
}
const drained = async (f: ReturnType<typeof fixture>): Promise<void> => waitFor(() => f.followUps.pendingCount() === 0, 1000, 'delivery observers settled');

h.test('ACK returns the visible message immediately and only a correlated terminal determines delivery', async () => {
  for (const outcome of vector.outcomes) {
    const f = fixture();
    assertDeepEqual(await f.followUps.submit(f.request), vector.reply, 'submission result is independent of terminal delivery');
    assertDeepEqual(f.client.calls, [vector.request], 'only the named running-turn steer is submitted');
    assertDeepEqual(f.events, [vector.queued], 'ACK cannot masquerade as applied');
    assertEqual(f.followUps.pendingCount(), 1, 'delivery is still pending after IPC resolves');
    f.client.outcome(outcome.envelope);
    assertDeepEqual(f.events, [vector.queued, { ...(vector.queued as Record<string, Json>), state: outcome.state,
      ...(outcome.error ? { error: outcome.error } : {}), ...(outcome.reason ? { reason: outcome.reason } : {}) }], outcome.name);
    if (outcome.state === 'unconfirmed') f.client.outcome({ steered: { applied: true } });
    await drained(f);
    assertEqual(f.client.listenerCount('event'), 0, 'terminal outcome releases its listener');
    f.client.outcome(outcome.envelope); assertEqual(f.events.length, outcome.state === 'unconfirmed' ? 3 : 2, 'duplicate terminal does not repeat a notice');
    await f.followUps.close();
  }
});

h.test('a terminal emitted before the ACK is retained and ordered after admission', async () => {
  const f = fixture(); let acknowledge!: (value: unknown) => void;
  f.client.response = () => new Promise(resolve => { acknowledge = resolve; });
  let returned = false;
  const reply = f.followUps.submit(f.request).then(value => { returned = true; return value; });
  f.client.outcome({ steered: { applied: true } });
  await Promise.resolve();
  assertEqual(returned, false, 'a terminal alone does not invent submission admission');
  assertDeepEqual(f.events, [], 'no event reordered ahead of ACK');
  acknowledge(vector.ack); assertDeepEqual(await reply, vector.reply, 'admitted once'); await drained(f);
  assertDeepEqual(f.events, [vector.queued, vector.applied], 'fast engine keeps queued then applied'); await f.followUps.close();
});

h.test('a delegated steer carries its envelope on the applied verdict so the live layer can draw it', async () => {
  const f = fixture();
  assertDeepEqual(await f.followUps.submit({ ...vector.delegationIdentity, client: f.client, input: vector.delegationIdentity.text, assertCurrent: () => {} }), vector.reply, 'delegated submission admits like any steer');
  assertDeepEqual(f.client.calls, [{ method: 'turn/submit', params: { sessionId: 'engine-session', input: vector.delegationIdentity.text, mode: 'steer', submissionId: 'steer-message-one', delivery: 'delegation', expectedTurnId: 'target-turn', queueMessageId: 'message-one', displayMetadata: { inputPresentation: { version: 1, kind: 'steer' } } } }], 'the delegation delivery keeps its envelope text and delivery tag');
  assertDeepEqual(f.events, [vector.delegationQueued], 'the queued notice keeps the raw envelope as its text');
  f.client.outcome({ steered: { applied: true } }); await drained(f);
  // The engine appends the envelope to the turn's last tool result AFTER that
  // call's terminal event, so the renderer's live tool card can never see it.
  // The applied verdict is the host's own observation of the drain and is the
  // only frame that can carry the bubble to the running transcript.
  assertDeepEqual(f.events, [vector.delegationQueued, vector.delegationApplied], 'the applied verdict carries the parsed envelope');
  await f.followUps.close();
});

h.test('a second follow-up can be admitted while the first is still awaiting delivery', async () => {
  const f = fixture();
  f.client.response = async () => ({ status: 'steered', submissionId: (f.client.calls.at(-1)!.params as Record<string, Json>).submissionId, turnId: 'target-turn' });
  await f.followUps.submit(f.request);
  assertEqual((await f.followUps.submit({ ...f.request, messageId: 'message-two', text: 'Also inspect stderr', input: 'Also inspect stderr' })).ok, true, 'submission does not await the first delivery');
  assertEqual(f.followUps.pendingCount(), 2, 'both deliveries remain independent');
  f.client.outcome({ error: 'Second input refused' }, 'engine-session', 'steer-message-two');
  f.client.outcome({ steered: { applied: true } }); await drained(f);
  const terminalStates = f.events.map(event => event as Record<string, Json>).filter(event => event.state !== 'engine_queued')
    .map(event => [event.messageId, event.state]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  assertDeepEqual(terminalStates, [['message-one', 'applied'], ['message-two', 'failed']], 'out-of-order outcomes retain their own message identity');
  await f.followUps.close();
});

h.test('wrong conversations and submissions cannot settle delivery or displace an early matching outcome', async () => {
  const f = fixture();
  f.client.response = async () => {
    for (let index = 0; index < 140; index++) f.client.outcome({ error: 'unrelated failure' }, 'other-engine', `other-${index}`);
    f.client.outcome({ steered: { applied: true } }, 'other-engine');
    f.client.outcome({ steered: { applied: true } }, 'engine-session', 'another-submission');
    return vector.ack;
  };
  await f.followUps.submit(f.request); assertDeepEqual(f.events, [vector.queued], 'foreign events ignored before and after ACK');
  f.client.outcome({ steered: { applied: true } }, 'engine-session', 'steer-message-one', 'sessionEvent');
  await drained(f); assertDeepEqual(f.events, [vector.queued, vector.applied], 'same binding and identity settle the waiter'); await f.followUps.close();
});

h.test('invalid ACKs and unknown transport failures remain uncertain without inviting duplicate submission', async () => {
  for (const response of [async () => ({}), async () => ({ submissionId: 'another-submission' }), async () => ({ submissionId: 'another-submission', steered: { applied: true } }), async () => { throw new Error('submission failed'); }]) {
    const f = fixture(); f.client.response = response;
    const reply = await f.followUps.submit(f.request);
    assert(!reply.ok && reply.unconfirmed === true, 'issued request lacks a definitive refusal');
    assertEqual((f.events.at(-1) as Record<string, Json>).state, 'unconfirmed', 'uncertainty is explicit');
    f.client.outcome({ steered: { applied: true } }); await drained(f);
    assertDeepEqual(f.events.at(-1), vector.applied, 'late receipt can recover'); await f.followUps.close();
  }
});

h.test('a steered admission ignores an embedded applied flag until a correlated raw event arrives', async () => {
  const f = fixture(); f.client.response = async () => ({ ...(vector.ack as Record<string, Json>), steered: { applied: true } });
  assertDeepEqual(await f.followUps.submit(f.request), vector.reply, 'valid admission returns promptly');
  assertDeepEqual(f.events, [vector.queued], 'ACK cannot claim application');
  assertEqual(f.followUps.pendingCount(), 1, 'application observer stays active');
  f.client.outcome({ steered: { applied: true } }, 'other-engine');
  f.client.outcome({ steered: { applied: true } }, 'engine-session', 'other-submission');
  assertDeepEqual(f.events, [vector.queued], 'foreign receipts cannot apply this input');
  f.client.outcome({ steered: { applied: true } }); await drained(f);
  assertDeepEqual(f.events, [vector.queued, vector.applied], 'only the subsequent matching event applies');
  assertDeepEqual(f.client.calls, [vector.request], 'one atomic submission without fallback'); await f.followUps.close();
});

h.test('structured turn submission refusals are safe and release only their delivery observer', async () => {
  for (const code of ['not-idle', 'no-active-turn', 'expected-turn-mismatch', 'active-turn-not-steerable', 'session-closing']) {
    const f = fixture(); f.client.response = async () => ({ status: 'not-submitted', submissionId: 'steer-message-one', reason: { code } });
    const reply = await f.followUps.submit(f.request);
    assert(!reply.ok && !reply.unconfirmed, 'explicit engine refusal is safe to restore');
    assertEqual(f.followUps.pendingCount(), 0, 'refused submission retains no observer');
    assertEqual(f.client.listenerCount('event'), 0, 'listener is released');
    assertDeepEqual(f.events, [], 'no queued or applied event is invented');
    assertDeepEqual(f.client.calls, [vector.request], 'no retry through another method'); await f.followUps.close();
  }
});

h.test('wrong state and wrong turn acknowledgements stay unconfirmed until an actual receipt', async () => {
  for (const ack of [
    { status: 'started', submissionId: 'steer-message-one', turnId: 'steer-message-one' },
    { status: 'steered', submissionId: 'steer-message-one', turnId: 'replacement-turn' },
    { status: 'applied', submissionId: 'steer-message-one', turnId: 'target-turn' },
  ]) {
    const f = fixture(); f.client.response = async () => ack;
    const reply = await f.followUps.submit(f.request);
    assert(!reply.ok && reply.unconfirmed, 'inconsistent admission cannot prove safe rejection');
    assertEqual((f.events.at(-1) as Record<string, Json>).reason, 'invalid_ack', 'uncertainty retains its cause');
    assertDeepEqual(f.client.calls, [vector.request], 'invalid reply never triggers retry');
    f.client.outcome({ steered: { applied: true } }); await drained(f);
    assertDeepEqual(f.events.at(-1), vector.applied, 'late matching application remains observable'); await f.followUps.close();
  }
});

h.test('an explicit server refusal is safe to return without a delivery observer', async () => {
  const f = fixture(); f.client.response = async () => { throw { kind: 'server', code: -32602, message: 'Input refused before enqueue' }; };
  const refused = await f.followUps.submit(f.request);
  assert(!refused.ok && !refused.unconfirmed, 'server refusal is definitive');
  assertEqual(f.followUps.pendingCount(), 0, 'no rejected input remains observed');
  assertDeepEqual(f.events, [], 'ordinary caller error owns refused input'); await f.followUps.close();
});

h.test('a known correlated rejection before ACK is returned as refusal without inventing admission', async () => {
  const f = fixture();
  f.client.response = async () => { f.client.outcome({ error: 'steer turn is no longer active' }); return vector.ack; };
  assertDeepEqual(await f.followUps.submit(f.request), { ok: false, error: 'steer turn is no longer active' }, 'known refusal wins over generic ACK');
  assertDeepEqual(f.events, [], 'no phantom queued or user bubble');
  assertEqual(f.followUps.pendingCount(), 0, 'known rejected input releases observer'); await f.followUps.close();
});

h.test('an admission RPC timeout stays unconfirmed and retains an eventual receipt', async () => {
  const f = fixture(); f.client.response = async () => { throw { kind: 'timeout', method: 'turn/submit' }; };
  const reply = await f.followUps.submit(f.request);
  assert(!reply.ok && reply.unconfirmed === true, 'uncertain admission cannot invite an unsafe resend');
  assertEqual((f.events.at(-1) as Record<string, Json>).state, 'unconfirmed', 'no hard rejection');
  assertEqual(f.followUps.pendingCount(), 1, 'eventual receipt is still observed');
  f.client.outcome({ steered: { applied: true } }); await drained(f);
  assertDeepEqual(f.events.at(-1), vector.applied, 'late application is recorded after RPC timeout'); await f.followUps.close();
});

h.test('connection loss reports unconfirmed delivery once and cleans up pending listeners', async () => {
  const f = fixture(); await f.followUps.submit(f.request);
  f.client.emit('event', { type: 'streamClosed' } satisfies ClientEvent); await drained(f);
  const failure = f.events[1] as Record<string, Json>;
  assertEqual(failure.state, 'unconfirmed', 'disconnect cannot claim rejected');
  assertEqual(failure.reason, 'connection_closed', 'uncertainty is explicit');
  assertEqual(f.client.listenerCount('event'), 0, 'closed connection has no waiter'); await f.followUps.close();
});

h.test('retirement and generation replacement cannot apply a stale receipt or interrupt the main turn', async () => {
  for (const retire of ['session', 'generation', 'binding'] as const) {
    const f = fixture(); await f.followUps.submit(f.request);
    if (retire === 'session') f.followUps.retireSession('conversation');
    else if (retire === 'generation') f.followUps.invalidate();
    else f.replace();
    f.client.outcome({ steered: { applied: true } }); await drained(f);
    assertEqual((f.events[1] as Record<string, Json>).state, 'unconfirmed', retire + ' invalidates original receipt');
    assertEqual(f.events.length, 2, 'one terminal status');
    assertDeepEqual(f.client.calls.map(call => call.method), ['turn/submit'], 'no unsupported cancellation or main-turn interruption');
    assertEqual(f.client.listenerCount('event'), 0, 'old listener removed'); await f.followUps.close();
  }
});

h.test('retirement before ACK resolves promptly and a late ACK cannot revive the message', async () => {
  for (const closedStream of [false, true]) {
    const f = fixture(); let acknowledge!: (value: unknown) => void;
    f.client.response = () => new Promise(resolve => { acknowledge = resolve; });
    const reply = f.followUps.submit(f.request);
    await Promise.resolve();
    if (closedStream) f.client.emit('event', { type: 'streamClosed' } satisfies ClientEvent);
    else f.followUps.retireSession('conversation');
    const uncertain = await reply;
    assert(!uncertain.ok && uncertain.unconfirmed === true && uncertain.messageId === f.request.messageId, 'issued input is uncertain, so no resendable draft is restored'); await drained(f);
    acknowledge(vector.ack); await new Promise(resolve => setTimeout(resolve, 0));
    assertEqual(f.events.length, 1, 'late ACK cannot revive an uncertain retired input');
    assertEqual((f.events[0] as Record<string, Json>).state, 'unconfirmed', 'connection loss is not rejection'); assertEqual(f.client.listenerCount('event'), 0, 'observer released'); await f.followUps.close();
  }
});


h.test('retirement before dispatch is a safe refusal and sends no input', async () => {
  const f = fixture();
  const reply = f.followUps.submit(f.request);
  f.followUps.retireSession('conversation');
  const refused = await reply;
  assert(!refused.ok && !refused.unconfirmed, 'input was never issued');
  await Promise.resolve();
  assertEqual(f.client.calls.length, 0, 'no later dispatch');
  assertEqual(f.events.length, 0, 'no uncertainty notice for unissued input'); await f.followUps.close();
});

h.test('RPC timeout reconciles authoritative pending UUID after the owning turn stops', async () => {
  const f = fixture(); f.client.response = async () => { throw { kind: 'timeout', method: 'turn/submit' }; };
  await f.followUps.submit(f.request);
  f.client.response = async () => ({ queueSnapshot: { status: 'authoritative', items: [{ state: 'pending', message: { uuid: f.request.messageId } }] } });
  await f.followUps.turnEnded(f.client, 'engine-session', f.request.targetTurnId, 'interrupted');
  assertEqual((f.events.at(-1) as Record<string, Json>).state, 'pending', 'queue proves pending despite missing RPC ACK');
  f.client.outcome({ steered: { applied: true } }); await drained(f);
  assertDeepEqual(f.events.at(-1), vector.applied, 'late applied receipt still settles'); await f.followUps.close();
});

h.test('a closed RPC after issuance cannot be presented as safe rejection', async () => {
  const f = fixture(); f.client.response = async () => { throw { kind: 'closed' }; };
  const reply = await f.followUps.submit(f.request);
  assert(!reply.ok && reply.unconfirmed === true, 'issued request may have reached durable queue');
  assertEqual((f.events.at(-1) as Record<string, Json>).reason, 'connection_closed', 'uncertainty describes lost connection');
  await f.followUps.close();
});

h.test('timeout retains one observer and late applied replaces uncertainty', async () => {
  const f = fixture(5); await f.followUps.submit(f.request);
  await waitFor(() => f.events.length === 2, 1000, 'confirmation timeout');
  assertEqual((f.events[1] as Record<string, Json>).state, 'unconfirmed', 'timeout is not input rejection');
  assertEqual(f.followUps.pendingCount(), 1, 'late receipt remains observable');
  assertEqual(f.client.listenerCount('event'), 1, 'one central listener');
  f.client.outcome({ steered: { applied: true } }); await drained(f);
  assertDeepEqual(f.events.at(-1), vector.applied, 'late application clears uncertainty');
  assertDeepEqual(f.client.calls, [vector.request], 'timeout neither cancels input nor resends it'); await f.followUps.close();
});

h.test('interrupted and failed turns keep exact queued IDs pending without automatic resume', async () => {
  for (const reason of ['interrupted', 'turn_failed']) {
    const f = fixture(); await f.followUps.submit(f.request);
    f.client.response = async () => ({ queueSnapshot: { status: 'authoritative', items: [
      { state: 'pending', message: { uuid: 'other-input', value: f.request.text } },
      { state: 'pending', message: { uuid: f.request.messageId, value: f.request.text } },
    ] } });
    await f.followUps.turnEnded(f.client, 'engine-session', 'wrong-turn', reason);
    assertEqual(f.events.length, 1, 'unrelated terminal cannot alter delivery');
    await f.followUps.turnEnded(f.client, 'engine-session', 'target-turn', reason);
    assertDeepEqual(f.events.at(-1), { ...(vector.queued as object), state: 'pending', reason }, 'authoritative UUID remains queued');
    assertDeepEqual(f.client.calls.map(call => call.method), ['turn/submit', 'session/queueSnapshot'], 'no implicit resume after stop or failure');
    f.client.outcome({ steered: { applied: true } }); await drained(f);
    await f.followUps.close();
  }
});

h.test('a terminal before ACK is reconciled after admission and missing or unavailable queues stay unconfirmed', async () => {
  for (const snapshot of [{ status: 'authoritative', items: [] }, { status: 'persistence-failed', items: [] }]) {
    const f = fixture(); await f.followUps.submit(f.request);
    f.client.response = async () => ({ queueSnapshot: snapshot });
    await f.followUps.turnEnded(f.client, 'engine-session', 'target-turn', 'interrupted');
    assertEqual((f.events.at(-1) as Record<string, Json>).state, 'unconfirmed', 'missing UUID does not fabricate delivery');
    await f.followUps.close();
  }
});

h.test('stopped-before-ACK admission reconciles exact pending input after the ACK arrives', async () => {
  const f = fixture(); let acknowledge!: (value: unknown) => void;
  f.client.response = () => new Promise(resolve => { acknowledge = resolve; });
  const reply = f.followUps.submit(f.request);
  await Promise.resolve();
  f.client.response = async () => ({ queueSnapshot: { status: 'authoritative', items: [{ state: 'pending', message: { uuid: 'message-one' } }] } });
  await f.followUps.turnEnded(f.client, 'engine-session', 'target-turn', 'interrupted');
  acknowledge(vector.ack); await reply;
  await waitFor(() => f.events.some(event => (event as Record<string, Json>).state === 'pending'), 1000, 'post-ACK queue reconciliation');
  assertEqual(f.followUps.pendingCount(), 1, 'input stays observed for later explicit resume');
  await f.followUps.close();
});

h.test('confirmed removal before ACK consumes input and a late ACK cannot restore it', async () => {
  const f = fixture(); let acknowledge!: (value: unknown) => void;
  f.client.response = () => new Promise(resolve => { acknowledge = resolve; });
  const reply = f.followUps.submit(f.request); await Promise.resolve();
  f.followUps.removed(f.request.sessionId, f.request.messageId);
  const removed = await reply;
  assert(!removed.ok && removed.removed === true && removed.messageId === f.request.messageId, 'confirmed owner removal consumes payload without retry');
  assertEqual(f.followUps.pendingCount(), 0, 'removed input has no waiter');
  acknowledge(vector.ack); await new Promise(resolve => setTimeout(resolve, 0));
  assertDeepEqual(f.events.map(event => (event as Record<string, Json>).state), ['removed'], 'late ACK cannot invent queued or applied input'); await f.followUps.close();
});

h.test('confirmed removal clears uncertainty and releases its observer without claiming application', async () => {
  const f = fixture(5); await f.followUps.submit(f.request);
  await waitFor(() => f.events.length === 2, 1000, 'uncertain delivery');
  f.followUps.removed(f.request.sessionId, f.request.messageId);
  assertEqual((f.events.at(-1) as Record<string, Json>).state, 'removed', 'confirmed queue removal is explicit');
  assertEqual(f.followUps.pendingCount(), 0, 'removed input releases bounded observer');
  assertEqual(f.client.listenerCount('event'), 0, 'removed input releases listener');
  const count = f.events.length; f.client.outcome({ steered: { applied: true } });
  assertEqual(f.events.length, count, 'late applied cannot revive removed input'); await f.followUps.close();
});

h.test('128 deliveries share one bounded listener and excess admission is refused', async () => {
  const f = fixture();
  f.client.response = async () => ({ status: 'steered', submissionId: (f.client.calls.at(-1)!.params as Record<string, Json>).submissionId, turnId: 'target-turn' });
  for (let index = 0; index < 128; index++) await f.followUps.submit({ ...f.request, messageId: `bounded-${index}` });
  assertEqual(f.followUps.pendingCount(), 128, 'delivery map has its explicit bound');
  assertEqual(f.client.listenerCount('event'), 1, 'listeners do not grow with input count');
  assertEqual((await f.followUps.submit({ ...f.request, messageId: 'overflow' })).ok, false, 'overflow refused before submission');
  assertEqual(f.client.calls.length, 128, 'no overflowing engine input'); await f.followUps.close();
  assertEqual(f.client.listenerCount('event'), 0, 'close removes central listener');
});

h.test('slash commands and duplicate identities never submit another steer and shutdown drains all waiters', async () => {
  const f = fixture();
  assertEqual((await f.followUps.submit({ ...f.request, text: '  /compact' })).ok, false, 'slash command belongs to the next turn');
  assertDeepEqual(f.client.calls, [], 'no slash command sent as model input');
  await f.followUps.submit(f.request);
  assertEqual((await f.followUps.submit(f.request)).ok, false, 'duplicate identity cannot create a second waiter');
  await f.followUps.close();
  assertEqual(f.followUps.pendingCount(), 0, 'shutdown drained its observers');
  assertEqual(f.client.listenerCount('event'), 0, 'no listener retained by shutdown');
  assertEqual((await f.followUps.submit({ ...f.request, messageId: 'after-close' })).ok, false, 'closed service cannot admit new work');
});

h.test('a delegation follow-up carries the delegation history shape, not the user one', async () => {
  const f = fixture();
  assertDeepEqual(
    await f.followUps.submit({ ...f.request, delivery: 'delegation' }),
    vector.reply,
    'a delegation steer submits like any follow-up',
  );
  assertDeepEqual(f.client.calls, [vector.delegationRequest], 'the delivery shape rides the steer request');
  await f.followUps.close();
});

void h.finish(join(__dirname, 'follow-ups-result.json'), 'follow-ups').then(code => { process.exitCode = code; });
