import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { collectTurnReply, type TurnReplyOptions } from '../main/sessions/turn-reply';
import type { EngineClientLike } from '../main/sessions/service';
import type { ClientEvent } from '../main/engine/protocol';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const h = new Harness();
class Client extends EventEmitter implements EngineClientLike {
  closed = false;
  isClosed() { return this.closed; }
  async requestWithTimeout(): Promise<unknown> { throw new Error('Unexpected request'); }
  receive(event: ClientEvent) { this.emit('event', event); }
  item(text: string, submissionId = 'owned') { this.receive({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'live', submissionId, item: { type: 'agent_message', text } } }); }
  complete(turnId = 'owned') { this.receive({ type: 'turnCompleted', params: { sessionId: 'live', turnId, result: {} } }); }
}
function fixture(overrides: Partial<TurnReplyOptions> = {}) {
  const client = new Client(), controller = new AbortController(), settled: boolean[] = [];
  let interrupts = 0;
  const options: TurnReplyOptions = { client, sessionId: 'live', turnId: 'owned', signal: controller.signal, drainMs: 25,
    start: async (_signal, admitted) => { admitted(); }, interrupt: async () => { interrupts++; client.complete(); }, settled: complete => settled.push(complete), ...overrides };
  return { client, controller, settled, options, interrupts: () => interrupts };
}

h.test('reply uses only the last completed assistant item of its exact session and turn', async () => {
  const f = fixture(); const reply = collectTurnReply(f.options);
  f.client.item('first');
  f.client.receive({ type: 'productEvent', method: 'item/agentMessage/delta', params: { sessionId: 'live', submissionId: 'owned', text: 'unfinished' } });
  f.client.item('final'); f.client.item('another turn', 'other');
  f.client.receive({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'another', submissionId: 'owned', item: { type: 'agent_message', text: 'another session' } } });
  f.client.complete('other'); f.client.complete();
  assertDeepEqual(await reply, { reply: 'final' }, 'correlated final reply');
  assertDeepEqual(f.settled, [true], 'terminal proof'); assertEqual(f.client.listenerCount('event'), 0, 'listener removed');
});
h.test('a terminal event before the start ACK stays terminal', async () => {
  const f = fixture();
  f.options.start = async (_signal, admitted) => { admitted(); f.client.item('early'); f.client.complete(); await Promise.resolve(); };
  assertDeepEqual(await collectTurnReply(f.options), { reply: 'early' }, 'early completion preserved'); assertEqual(f.interrupts(), 0, 'completed work is not interrupted');
});
h.test('real facade identities correlate by submission and the terminal final text is authoritative', async () => {
  const f = fixture(), result = collectTurnReply(f.options);
  f.client.receive({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'live', turnId: 'engine-uuid', submissionId: 'owned', item: { type: 'agent_message', text: 'Earlier assistant item' } } });
  f.client.receive({ type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: 'owned', event: { type: 'turn.completed', turnId: 'engine-uuid' } } } });
  f.client.receive({ type: 'turnCompleted', params: { sessionId: 'live', turnId: 'owned', submissionId: 'another-submission', result: { finalText: 'Foreign reply' } } });
  f.client.receive({ type: 'turnCompleted', params: { sessionId: 'another-session', turnId: 'owned', result: { finalText: 'Foreign session' } } });
  f.client.receive({ type: 'turnCompleted', params: { sessionId: 'live', turnId: 'owned', result: { stopReason: 'completed', finalText: 'Actual final reply' } } });
  assertDeepEqual(await result, { reply: 'Actual final reply' }, 'facade final result overrides intermediate content');
  assertEqual(f.interrupts(), 0, 'raw completion cannot cancel the owned turn');
});
h.test('explicit empty final results clear partial text and oversized terminal results fail without interrupting completed work', async () => {
  const empty = fixture(), cleared = collectTurnReply(empty.options); empty.client.item('Partial answer');
  empty.client.receive({ type: 'turnCompleted', params: { sessionId: 'live', turnId: 'owned', result: { finalText: '' } } });
  assertDeepEqual(await cleared, { reply: null }, 'empty final result is not replaced by partial text');
  const large = fixture(), rejected = collectTurnReply(large.options);
  large.client.receive({ type: 'turnCompleted', params: { sessionId: 'live', turnId: 'owned', result: { finalText: 'x'.repeat(1024 * 1024 + 1) } } });
  await assertRejects(() => rejected, 'oversized final reply'); assertEqual(large.interrupts(), 0, 'terminal work is already drained');
});
h.test('an interrupted facade result never sends a partial answer as a successful task result', async () => {
  const f = fixture(), result = collectTurnReply(f.options); f.client.item('Partial answer');
  f.client.receive({ type: 'turnCompleted', params: { sessionId: 'live', turnId: 'owned', result: { stopReason: 'aborted', finalText: 'Partial answer' } } });
  const error = await assertRejects(() => result, 'interrupted turn'); assertEqual((error as { code: string }).code, 'TURN_INTERRUPTED', 'interruption is explicit');
});
h.test('a failed turn never returns a partial reply', async () => {
  const f = fixture(); const reply = collectTurnReply(f.options); f.client.item('partial');
  f.client.receive({ type: 'productEvent', method: 'turn/failed', params: { sessionId: 'live', submissionId: 'owned', detail: { error: { message: 'provider failed' } } } });
  const error = await assertRejects(() => reply, 'failed turn'); assertEqual(String(error), 'Error: provider failed', 'engine error preserved'); assertDeepEqual(f.settled, [true], 'failed terminal is drained');
});
h.test('cancellation before admission starts no interrupt', async () => {
  const f = fixture();
  f.options.start = async signal => { f.controller.abort(new Error('cancelled before admission')); signal.throwIfAborted(); };
  await assertRejects(() => collectTurnReply(f.options), 'cancelled admission'); assertEqual(f.interrupts(), 0, 'never interrupt another turn'); assertDeepEqual(f.settled, [true], 'no engine resource admitted');
});
h.test('an interrupt ACK does not release an accepted turn before its terminal event', async () => {
  const f = fixture({ drainMs: 1000 }); let interrupted = false, finished = false;
  f.options.interrupt = async () => { interrupted = true; };
  const result = collectTurnReply(f.options).finally(() => { finished = true; }); void result.catch(() => {});
  f.controller.abort(new Error('owner closed')); await waitFor(() => interrupted, 1000, 'interrupt submitted');
  assert(!finished, 'still owns the engine turn'); assertDeepEqual(f.settled, [], 'no premature settled callback');
  f.client.complete(); await assertRejects(() => result, 'cancelled turn must not reply'); assertDeepEqual(f.settled, [true], 'actual terminal drains owner');
});
h.test('a lost start ACK interrupts and drains before returning its original failure', async () => {
  const f = fixture();
  f.options.start = async (_signal, admitted) => { admitted(); throw { kind: 'timeout', method: 'turn/submit' }; };
  const error = await assertRejects(() => collectTurnReply(f.options), 'lost ACK');
  assertDeepEqual(error, { kind: 'timeout', method: 'turn/submit' }, 'transport failure retained'); assertEqual(f.interrupts(), 1, 'exactly one cancellation'); assertDeepEqual(f.settled, [true], 'cancel terminal proves release');
});
h.test('a formal start rejection needs no interrupt and a failed cancellation retains ownership', async () => {
  const rejected = fixture();
  rejected.options.start = async (_signal, admitted) => { admitted(); throw { kind: 'server', code: -1, message: 'denied' }; };
  await assertRejects(() => collectTurnReply(rejected.options), 'formal rejection'); assertEqual(rejected.interrupts(), 0, 'no accepted turn'); assertDeepEqual(rejected.settled, [true], 'rejection proves release');
  const stuck = fixture(); stuck.options.interrupt = async () => { throw new Error('connection still live but write failed'); };
  const reply = collectTurnReply(stuck.options); stuck.controller.abort();
  const error = await assertRejects(() => reply, 'failed cancellation'); assertEqual((error as { code: string }).code, 'CANCEL_FAILED', 'drain failure surfaced'); assertDeepEqual(stuck.settled, [false], 'live owner retained');
});
h.test('an unconfirmed interruption retains hosted ownership and surfaces its exact diagnostic', async () => {
  const f = fixture({ interrupt: async () => ({ ok: true, accepted: true, confirmed: false, interruptionError: 'Lost atomic interrupt outcome' }) });
  const reply = collectTurnReply(f.options); f.controller.abort();
  const error = await assertRejects(() => reply, 'uncertain cancellation cannot report a completed owner');
  assert(String(error).includes('Lost atomic interrupt outcome'), 'the actual interruption diagnostic survives');
  assertDeepEqual(f.settled, [false], 'uncertainty retains owned admission until terminal or disconnection');
});
h.test('missing cancellation terminal fails within its drain deadline', async () => {
  const f = fixture({ interrupt: async () => {} }); const reply = collectTurnReply(f.options); f.controller.abort();
  const error = await assertRejects(() => reply, 'terminal timeout'); assertEqual((error as { code: string }).code, 'CANCEL_FAILED', 'undrained failure'); assertDeepEqual(f.settled, [false], 'not falsely released');
});
h.test('an engine exit rejects and releases the waiter without issuing another request', async () => {
  const f = fixture(); const reply = collectTurnReply(f.options); f.client.closed = true; f.client.receive({ type: 'streamClosed' });
  await assertRejects(() => reply, 'engine exited'); assertEqual(f.interrupts(), 0, 'closed engine not interrupted'); assertDeepEqual(f.settled, [true], 'physical exit proves release');
});
h.test('an oversized reply cancels and drains instead of returning success', async () => {
  const large = fixture(); const reply = collectTurnReply(large.options); large.client.item('x'.repeat(1024 * 1024 + 1));
  await assertRejects(() => reply, 'oversized reply'); assertEqual(large.interrupts(), 1, 'reply bound interrupts');
});
h.test('an active turn runs until a terminal event or an explicit cancellation', async () => {
  const f = fixture(); let finished = false;
  const reply = collectTurnReply(f.options).finally(() => { finished = true; }); void reply.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 60));
  assert(!finished, 'no wall clock kills an owned turn'); assertEqual(f.interrupts(), 0, 'nothing cancels an unattended but live turn');
  f.client.complete(); assertDeepEqual(await reply, { reply: null }, 'the terminal event still ends the wait');
});
void h.finish(join(__dirname, 'turn-reply-result.json'), 'turn-reply').then(code => { process.exitCode = code; });
