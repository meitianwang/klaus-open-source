import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { RpcRequestOptions } from '../main/engine/request-scheduler';
import type { EngineClientLike } from '../main/sessions/service';
import { interruptTurn, requireInterruptConfirmation, turnInterruptOutcome } from '../main/sessions/turn-interrupt';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();
class Client extends EventEmitter implements EngineClientLike {
  calls: { method: string; params: Json; timeout?: number; scheduling?: RpcRequestOptions }[] = [];
  respond: () => Promise<unknown> = async () => ({ submissionId: 'control' });
  isClosed(): boolean { return false; }
  async requestWithTimeout(method: string, params: Json, timeout?: number, scheduling?: RpcRequestOptions): Promise<unknown> {
    this.calls.push({ method, params, timeout, scheduling }); return this.respond();
  }
  final(id = 'control', outcome: unknown = { accepted: true }): void {
    this.emit('event', { type: 'rawSessionEvent', params: { sessionId: 'live', event: { submissionId: id, turnInterrupt: outcome } } });
  }
}
const request = (client: Client) => interruptTurn({ client, sessionId: 'live', rendererId: 'thread', origin: 'user-stop', expectedTurnId: 'foreground', outcomeTimeoutMs: 100 });

h.test('final outcome preceding its ACK is correlated after the listener is installed', async () => {
  const client = new Client();
  client.respond = async () => { assertEqual(client.listenerCount('event'), 1, 'listener precedes dispatch'); client.final('other', { accepted: false }); client.final(); return { submissionId: 'control' }; };
  assertDeepEqual(await request(client), { accepted: true }, 'the correlated outcome wins');
  assertEqual(client.listenerCount('event'), 0, 'listener removed after success');
  assertEqual(client.calls[0]?.scheduling?.signal?.aborted, true, 'request controller released');
});
h.test('an acknowledgement alone never confirms cancellation or goal pause', async () => {
  const client = new Client(); let finished = false;
  const pending = request(client).finally(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve(); assertEqual(finished, false, 'ACK is only transport acceptance');
  client.final('unrelated'); await Promise.resolve(); assertEqual(finished, false, 'another control outcome cannot satisfy this one');
  client.final('control', { accepted: true, goalPauseError: 'Goal storage unavailable' });
  assertEqual((await pending).goalPauseError, 'Goal storage unavailable', 'pause failure stays explicit while cancellation succeeds');
});
h.test('all origins use exact typed fences and separate scheduling from the pause deadline', async () => {
  for (const origin of ['user-stop', 'system', 'targeted-turn'] as const) {
    const client = new Client(); client.respond = async () => { client.final(); return { submissionId: 'control' }; };
    await interruptTurn({ client, sessionId: 'live', rendererId: 'thread', origin, expectedTurnId: 'foreground' });
    const call = client.calls[0]!;
    assertDeepEqual(call.params, { sessionId: 'live', origin, expectedTurnId: 'foreground' }, 'foreground fence is never request correlation');
    assertEqual(call.timeout, origin === 'user-stop' ? 500 : 15000, 'only user stop dispatch is critical');
    assertEqual(call.scheduling?.priority, origin === 'user-stop' ? 'critical' : 'interactive', 'ordinary control has ordinary admission');
  }
});
h.test('missing final outcome has a bounded explicit deadline and cleans listeners', async () => {
  const client = new Client();
  await assertRejects(() => interruptTurn({ client, sessionId: 'live', rendererId: 'thread', origin: 'system', outcomeTimeoutMs: 5 }), 'ACK without outcome fails');
  assertEqual(client.listenerCount('event'), 0, 'deadline cleanup');
  assertEqual(client.calls[0]?.scheduling?.signal?.aborted, true, 'deadline aborts outstanding dispatch');
});
h.test('connection loss before an acknowledgement cannot hang a pending control request', async () => {
  const client = new Client(); client.respond = async () => new Promise(() => {});
  const pending = request(client); client.emit('event', { type: 'streamClosed', reason: 'closed' });
  await assertRejects(() => pending, 'disconnect rejects even a hung dispatch');
  assertEqual(client.listenerCount('event'), 0, 'disconnect cleanup');
  assertEqual(client.calls[0]?.scheduling?.signal?.aborted, true, 'disconnect aborts dispatch');
});
h.test('a stale reservation is a final refusal and never retargets a replacement', async () => {
  const client = new Client(); client.respond = async () => { client.final('control', { accepted: false }); return { submissionId: 'control' }; };
  assertDeepEqual(await request(client), { accepted: false }, 'the engine owns the atomic stale verdict');
  assertEqual(client.calls.length, 1, 'no bare retry against a later reservation');
});
h.test('malformed outcomes and dispatch failures release every listener', async () => {
  for (const malformed of [true, false]) {
    const client = new Client(); client.respond = async () => { if (malformed) { client.final('control', { accepted: 'yes' }); return { submissionId: 'control' }; } throw new Error('write failed'); };
    await assertRejects(() => request(client), 'malformed or failed dispatch rejects');
    assertEqual(client.listenerCount('event'), 0, 'failure cleanup');
  }
});
h.test('early unrelated outcomes stay bounded and cannot corrupt the matching receipt', async () => {
  const client = new Client(); client.respond = async () => { for (let i = 0; i < 1000; i++) client.final(String(i), { accepted: false }); client.final(); return { submissionId: 'control' }; };
  assertEqual((await request(client)).accepted, true, 'bounded backlog retains latest matching receipt');
  assertEqual(client.listenerCount('event'), 0, 'bounded backlog released');
});
h.test('trusted void callers reject uncertain interruption and pause diagnostics explicitly', async () => {
  for (const value of [{ accepted: false, confirmed: true }, { accepted: true, confirmed: false, interruptionError: 'Lost final outcome' }, { accepted: true, confirmed: true, goalPauseError: 'Pause storage failed' }]) {
    await assertRejects(async () => requireInterruptConfirmation(value), 'a void adapter cannot report success while discarding a diagnostic');
  }
  requireInterruptConfirmation({ accepted: true, confirmed: true });
  requireInterruptConfirmation({ accepted: true });
});
h.test('outcome decoder retains only typed bounded diagnostics', () => {
  assertEqual(turnInterruptOutcome({ accepted: true, goalPauseError: 'x'.repeat(9000) })?.goalPauseError?.length, 8192, 'bounded diagnostics');
  for (const value of [{ accepted: true, interruptedTurnId: '' }, { accepted: true, goalPauseError: 1 }, { accepted: 1 }]) assertEqual(turnInterruptOutcome(value), undefined, 'invalid wire rejected');
  assert(turnInterruptOutcome({ accepted: true, interruptedTurnId: 'facade-turn' }), 'valid receipt');
});
void h.finish(join(__dirname, 'turn-interrupt-result.json'), 'turn-interrupt').then(code => process.exit(code));
