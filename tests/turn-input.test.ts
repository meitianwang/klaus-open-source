import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { InvalidTurnInputReplyError, submitTurnInput, TurnInputRefusedError, type TurnInputMode, type TurnInputRequest } from '../main/engine/turn-input';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/turn-input-vectors.json'), 'utf8')) as {
  accepted: Array<{ name: string; mode: TurnInputMode; reply: Json }>;
  refusals: Array<{ reason: string; code: string }>;
  invalid: Array<{ name: string; mode: TurnInputMode; reply: Json }>;
};
class Client extends EventEmitter {
  calls: Array<{ method: string; params: Json; timeoutMs: number }> = [];
  constructor(private readonly reply: () => Promise<unknown>) { super(); }
  async requestWithTimeout(method: string, params: Json, timeoutMs: number): Promise<unknown> {
    this.calls.push({ method, params, timeoutMs });
    return this.reply();
  }
}
function request(mode: TurnInputMode): TurnInputRequest {
  return { sessionId: 'engine-session', input: mode === 'continue-if-idle' ? [] : 'Inspect the final tool result', mode,
    submissionId: 'submission-one', ...(mode === 'steer' ? { expectedTurnId: 'running-turn' } : {}) };
}
async function rejected(client: Client, input: TurnInputRequest): Promise<unknown> {
  try { await submitTurnInput(client, input, 1234); }
  catch (error) { return error; }
  throw new Error('Expected input submission to reject');
}
for (const one of vector.accepted) h.test(one.name, async () => {
  const client = new Client(async () => one.reply), input = request(one.mode);
  assertDeepEqual(await submitTurnInput(client, input, 1234), one.reply, 'validated engine admission');
  assertDeepEqual(client.calls, [{ method: 'turn/submit', params: input as unknown as Json, timeoutMs: 1234 }], 'single atomic named RPC');
});
for (const one of vector.refusals) h.test(`structured refusal: ${one.reason}`, async () => {
  const client = new Client(async () => ({ status: 'not-submitted', submissionId: 'submission-one', reason: { code: one.reason, activeTurnId: 'racing-turn' } }));
  const error = await rejected(client, request('start-if-idle'));
  assert(error instanceof TurnInputRefusedError, 'explicit refusal has a safe rejection type');
  assertEqual(error.kind, 'server', 'queue caller can distinguish safe rejection from uncertainty');
  assertEqual(error.code, one.code, 'busy race retains queue claim release semantics');
  assertDeepEqual(error.reason, { code: one.reason, activeTurnId: 'racing-turn' }, 'structured reason survives');
  assertEqual(client.calls.length, 1, 'refusal cannot trigger another submission');
});
for (const one of vector.invalid) h.test(`invalid ACK: ${one.name}`, async () => {
  const client = new Client(async () => one.reply), error = await rejected(client, request(one.mode));
  assert(error instanceof InvalidTurnInputReplyError, 'malformed acknowledgement is uncertain');
  assertEqual(error.kind, 'invalid_ack', 'caller can retain uncertainty');
  assertDeepEqual(client.calls.map(call => call.method), ['turn/submit'], 'no retry or legacy fallback');
});
h.test('transport timeout preserves uncertainty and never downgrades the method', async () => {
  const timeout = { kind: 'timeout', method: 'turn/submit' };
  const client = new Client(async () => { throw timeout; });
  assertEqual(await rejected(client, request('start-or-steer')), timeout, 'transport failure retains its identity');
  assertDeepEqual(client.calls.map(call => call.method), ['turn/submit'], 'one issued submission');
});
h.test('optional metadata and queue identities reach the same atomic request', async () => {
  const client = new Client(async () => ({ status: 'steered', submissionId: 'submission-one', turnId: 'running-turn', steered: { applied: true } }));
  const input: TurnInputRequest = { ...request('steer'), queueMessageId: 'queue-one', delivery: 'delegation',
    options: { model: 'fixture-model' }, displayMetadata: { displayText: 'Check output' } };
  assertDeepEqual(await submitTurnInput(client, input, 1234), { status: 'steered', submissionId: 'submission-one', turnId: 'running-turn' }, 'admission excludes an embedded application claim');
  assertDeepEqual(client.calls[0]?.params, input as unknown as Json, 'payload reaches engine without a second facade');
});
h.test('engine-assigned submission identity is accepted when caller omits it', async () => {
  const client = new Client(async () => ({ status: 'started', submissionId: 'generated-submission', turnId: 'generated-submission' }));
  const input = request('start-if-idle'); delete input.submissionId;
  assertDeepEqual(await submitTurnInput(client, input, 1234), { status: 'started', submissionId: 'generated-submission', turnId: 'generated-submission' }, 'server identity binds the started turn');
});
h.test('explicit steering without a target is rejected before any input is issued', async () => {
  for (const target of [undefined, '']) {
    const client = new Client(async () => { throw Error('Input must not be issued'); });
    const input = { ...request('steer'), expectedTurnId: target };
    const error = await rejected(client, input);
    assert(error instanceof TurnInputRefusedError, 'invalid local intent is a safe refusal');
    assertEqual(error.reason.code, 'invalid-input', 'a target is mandatory for explicit steering');
    assertEqual(client.calls.length, 0, 'no unchecked steering reaches the engine');
  }
});
h.test('automatic routing with a captured target cannot accept a different turn or a replacement start', async () => {
  for (const reply of [{ status: 'steered', submissionId: 'submission-one', turnId: 'replacement-turn' },
    { status: 'started', submissionId: 'submission-one', turnId: 'submission-one' }]) {
    const client = new Client(async () => reply);
    const error = await rejected(client, { ...request('start-or-steer'), expectedTurnId: 'running-turn' });
    assert(error instanceof InvalidTurnInputReplyError, 'an incompatible admission remains uncertain');
    assertEqual(client.calls.length, 1, 'target mismatch never retries into another turn');
  }
});
h.test('non-steerable operation kinds remain structured through host refusal', async () => {
  for (const turnKind of ['review', 'compact']) {
    const reason = { code: 'active-turn-not-steerable', turnKind, activeTurnId: 'operation-one' };
    const client = new Client(async () => ({ status: 'not-submitted', submissionId: 'submission-one', reason }));
    const error = await rejected(client, request('steer'));
    assert(error instanceof TurnInputRefusedError, 'operation refusal retains its type');
    assertDeepEqual(error.reason, reason, 'clients need not parse a diagnostic message');
  }
});
void h.finish(join(__dirname, 'turn-input-result.json'), 'turn-input').then(code => { process.exitCode = code; });
