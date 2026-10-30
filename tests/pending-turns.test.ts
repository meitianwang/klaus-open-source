import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { ClientEvent } from '../main/engine/protocol';
import { requestAcknowledged } from '../main/engine/acknowledged';
import { hasPendingMainTurn, PendingTurns, type PendingTurnRequest } from '../main/sessions/pending-turns';
import { vectorPath } from '../main/paths';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(vectorPath('pending-turn-vectors.json'), 'utf8')) as {
  maximumContinuations: number;
  admissionAck: { turnId: string };
  termination: Array<{ stopReason: string; held: boolean }>;
  pending: Array<{ name: string; item: unknown; eligible: boolean }>;
};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const completed = (turnId: string, stopReason = 'completed'): ClientEvent => ({ type: 'turnCompleted', params: { sessionId: 'engine', turnId, result: { stopReason } } });
function fixture(maximum = 25) {
  let generation = 1, live = true;
  const calls: PendingTurnRequest[] = [], forwarded: ClientEvent[] = [], notices: string[] = [];
  let resume: (request: PendingTurnRequest) => Promise<unknown> = async () => ({ started: false, reason: 'empty' });
  const coordinator = new PendingTurns({
    binding: (id, owner) => live && id === 'engine' && owner === generation ? { sessionId: 'renderer', engineSessionId: 'engine', generation } : undefined,
    resume: request => { calls.push(request); return resume(request); },
    forward: event => { forwarded.push(event); }, notice: (_id, text) => { notices.push(text); }, hasPending: () => true,
  }, maximum);
  coordinator.start('renderer');
  return { coordinator, calls, forwarded, notices, respond: (value: typeof resume) => { resume = value; },
    replace: () => { generation++; }, retire: () => { live = false; } };
}

h.test('committed termination and queue ownership vectors gate automatic admission', async () => {
  for (const row of vector.pending) assertEqual(hasPendingMainTurn({ items: [row.item] }), row.eligible, row.name);
  for (const row of vector.termination) {
    const f = fixture(vector.maximumContinuations);
    assertEqual(f.coordinator.receive(completed('submission', row.stopReason), 1), row.held, row.stopReason);
    await f.coordinator.close();
  }
});

h.test('terminal presentation waits for admission and suppresses a continued predecessor', async () => {
  for (const started of [false, true]) {
    const f = fixture(), pending = deferred<unknown>(); f.respond(() => pending.promise);
    assert(f.coordinator.receive(completed('submission'), 1), 'completion is held');
    await waitFor(() => f.calls.length === 1, 1000, 'resume request');
    assertEqual(f.calls[0]!.afterSubmissionId, 'submission', 'facade submission identity is retained');
    assertEqual(f.forwarded.length, 0, 'ACK observation cannot finish the UI');
    pending.resolve({ started });
    await waitFor(() => f.calls[0]!.signal.aborted || started || f.forwarded.length === 1, 1000, 'terminal outcome');
    await Promise.resolve(); await Promise.resolve();
    assertEqual(f.forwarded.length, started ? 0 : 1, 'continued turn has no preceding done flash');
    await f.coordinator.close();
  }
});

h.test('stop, replacement and retirement cannot revive a captured queue continuation', async () => {
  for (const action of ['stop', 'start', 'generation', 'binding']) {
    const f = fixture(), pending = deferred<unknown>(); f.respond(() => pending.promise);
    f.coordinator.receive(completed('submission'), 1);
    await waitFor(() => f.calls.length === 1, 1000, 'resume request');
    if (action === 'stop') f.coordinator.stop('renderer');
    if (action === 'start') f.coordinator.start('renderer');
    if (action === 'generation') f.replace();
    if (action === 'binding') f.retire();
    await assertRejects(async () => f.calls[0]!.assertCurrent(), 'retired request is fenced');
    pending.resolve({ started: false }); await f.coordinator.close();
    assertDeepEqual(f.notices, [], 'stale outcome creates no notice');
    assertEqual(f.forwarded.length, action === 'stop' ? 1 : 0, 'explicit stop releases the actual completion; stale ownership drops it');
  }
});

h.test('failure, interruption and duplicate completion never create repeated inference', async () => {
  const f = fixture(); f.respond(async () => { throw new Error('lost ACK'); });
  assert(!f.coordinator.receive(completed('failed', 'error'), 1), 'failed turns are not continued');
  assert(!f.coordinator.receive(completed('stop', 'aborted'), 1), 'interrupted turns are not continued');
  assert(!f.coordinator.receive(completed('stale'), 0), 'stale generations do not submit');
  f.coordinator.receive(completed('once'), 1); f.coordinator.receive(completed('once'), 1);
  await waitFor(() => f.forwarded.length === 1, 1000, 'failure presentation');
  assertEqual(f.calls.length, 1, 'one request for duplicate completion');
  assertEqual(f.notices.length, 1, 'uncertain continuation is a visible notice');
  await f.coordinator.close();
});

h.test('the chain limit counts continuation turns and an explicit send starts a fresh chain', async () => {
  const f = fixture(2); f.respond(async () => ({ started: true }));
  f.coordinator.receive(completed('first'), 1); f.coordinator.receive(completed('second'), 1);
  await waitFor(() => f.calls.length === 2, 1000, 'two continuations');
  assert(!f.coordinator.receive(completed('third'), 1), 'limit releases the last done');
  assertEqual(f.notices.length, 1, 'remaining queue is explained');
  f.coordinator.start('renderer'); f.coordinator.receive(completed('manual'), 1);
  await waitFor(() => f.calls.length === 3, 1000, 'new user chain');
  await f.coordinator.close();
});

h.test('aborting outcome observation removes its listener without claiming engine cancellation', async () => {
  class Client extends EventEmitter {
    calls = 0;
    async requestWithTimeout(): Promise<unknown> { this.calls++; return { submissionId: 'resume' }; }
  }
  const client = new Client(), controller = new AbortController();
  const result = requestAcknowledged(client, 'session/resumePending', { sessionId: 'engine' }, 'pendingResume', 1000, controller.signal);
  const rejected = assertRejects(() => result, 'outcome observation cancelled');
  controller.abort(); await rejected;
  assertEqual(client.listenerCount('event'), 0, 'no abandoned observer');
  assertEqual(client.calls, 1, 'no second mutation or synthetic engine cancel');
  await assertRejects(() => requestAcknowledged(client, 'session/resumePending', {}, 'pendingResume', 1000, controller.signal), 'pre-aborted scope');
  assertEqual(client.calls, 1, 'pre-aborted work never reaches the facade');
});

h.test('turn-shaped admission ACKs retain an outcome that arrived before the ACK', async () => {
  class Client extends EventEmitter {
    async requestWithTimeout(): Promise<unknown> {
      this.emit('event', { type: 'engineEvent', params: { submissionId: 'resume', pendingResume: { started: true } } });
      return vector.admissionAck;
    }
  }
  const client = new Client();
  assertDeepEqual(await requestAcknowledged(client, 'session/resumePending', {}, 'pendingResume', 1000, undefined, 'turnId'), { started: true }, 'turn identity correlates the actual admission outcome');
  assertEqual(client.listenerCount('event'), 0, 'the successful observer is removed');
});

void h.finish(join(__dirname, 'pending-turns-result.json'), 'pending-turns').then(code => { process.exitCode = code; });
