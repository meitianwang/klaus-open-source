import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientEvent } from '../main/engine/protocol';
import { createThreadWaitSignals } from '../main/services/thread-wait-signals';
import { ThreadWaitCoordinator, type ThreadWaitState } from '../main/services/thread-wait';
import { Harness } from './harness';

const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-thread-wait-signals-'));

/** Engine events, built the way the pump hands them over. */
const turnCompleted = (sessionId = 'engine-b'): ClientEvent => ({ type: 'turnCompleted', params: { sessionId, turnId: 'turn-1' } });
const threadDeleted = (sessionId = 'engine-b'): ClientEvent => ({ type: 'threadDeleted', params: { sessionId } });
const reverseRequest: ClientEvent = { type: 'reverseRequest', request: { method: 'approval/request', params: {}, id: 1, outstanding: true, respond: async () => {}, respondError: async () => {} } };
const product = (method: string): ClientEvent => ({ type: 'productEvent', method, params: {} });
const streamClosed: ClientEvent = { type: 'streamClosed' };

h.test('engine events that can move a target wake every change listener, and noise does not', () => {
  const signals = createThreadWaitSignals();
  let wakes = 0;
  signals.onChange(() => { wakes += 1; });

  for (const event of [turnCompleted(), threadDeleted(), reverseRequest, product('turn/failed'), product('thread/status/changed')]) {
    signals.engineChanged(event);
  }
  assert.equal(wakes, 5, 'each relevant event wakes the wait exactly once');

  // A turn that merely produced output, a protocol error, or the stream closing
  // must not wake anything: commentary never wakes a wait, and a closed stream is
  // handled by the tool's own abort, not by pretending a target changed.
  for (const event of [product('item/completed'), product('turn/plan/updated'), streamClosed, { type: 'sessionEvent', params: {} } as ClientEvent]) {
    signals.engineChanged(event);
  }
  assert.equal(wakes, 5, 'irrelevant events leave the wait alone');
});

h.test('input wakes only the conversation that was typed into', () => {
  const signals = createThreadWaitSignals();
  const woken: string[] = [];
  signals.onInput('thread-a', () => woken.push('a'));
  signals.onInput('thread-b', () => woken.push('b'));

  signals.input('thread-a');
  assert.deepEqual(woken, ['a'], 'only the waiting conversation ends its own wait');
  signals.input('thread-b');
  assert.deepEqual(woken, ['a', 'b']);
  // An unknown conversation has no listeners and must not throw.
  signals.input('thread-missing');
  assert.deepEqual(woken, ['a', 'b']);
});

h.test('unsubscribing stops delivery and releases the listener bucket', () => {
  const signals = createThreadWaitSignals();
  let changeWake = 0, inputWake = 0;
  const offChange = signals.onChange(() => { changeWake += 1; });
  const offInput = signals.onInput('thread-a', () => { inputWake += 1; });
  assert.deepEqual(signals.listenerCounts(), { change: 1, input: 1 });

  signals.engineChanged(turnCompleted());
  signals.input('thread-a');
  assert.deepEqual([changeWake, inputWake], [1, 1]);

  offChange(); offInput();
  assert.deepEqual(signals.listenerCounts(), { change: 0, input: 0 }, 'both buckets are empty after unsubscribe');
  signals.engineChanged(turnCompleted());
  signals.input('thread-a');
  assert.deepEqual([changeWake, inputWake], [1, 1], 'a removed listener is never called again');
});

h.test('a listener that unsubscribes during its own notification cannot skip its siblings', () => {
  const signals = createThreadWaitSignals();
  const order: string[] = [];
  let offSelf: () => void = () => {};
  offSelf = signals.onChange(() => { order.push('self-removing'); offSelf(); });
  signals.onChange(() => order.push('second'));
  signals.onChange(() => order.push('third'));

  signals.engineChanged(turnCompleted());
  // Iterating a live set while removing from it would skip an entry; copying
  // first is what makes all three run.
  assert.deepEqual(order, ['self-removing', 'second', 'third']);
  order.length = 0;
  signals.engineChanged(turnCompleted());
  assert.deepEqual(order, ['second', 'third'], 'the removed listener stays gone');
});

h.test('repeated waits do not accumulate listeners for one conversation', () => {
  const signals = createThreadWaitSignals();
  // Each wait subscribes, then unsubscribes when it settles. A hundred cycles must
  // leave nothing behind, or a long-running app would grow the bucket per wait.
  for (let index = 0; index < 100; index += 1) {
    const off = signals.onInput('thread-a', () => {});
    assert.deepEqual(signals.listenerCounts(), { change: 0, input: 1 }, `one listener during wait ${index}`);
    off();
    assert.deepEqual(signals.listenerCounts(), { change: 0, input: 0 }, `bucket released after wait ${index}`);
  }
});

h.test('an event arriving with no listeners is a no-op rather than an error', () => {
  const signals = createThreadWaitSignals();
  signals.engineChanged(turnCompleted());
  signals.input('thread-a');
  assert.deepEqual(signals.listenerCounts(), { change: 0, input: 0 });
});

/**
 * The hub and the coordinator composed, the way `runtime.ts` and
 * `ThreadToolsService.wait` wire them in production.
 *
 * Each half is tested separately, but neither
 * suite would notice if the two disagreed — a hub that notifies on the wrong
 * event, or a coordinator subscribing to a signal the hub never fires, would
 * leave `wait_threads` polling on its fallback tick forever while both suites
 * stayed green. That is the exact failure this pins.
 *
 * `tickMs` is set far above the assertion deadline on purpose: if the event path
 * were broken the wait could not resolve in time, so a pass can only mean the
 * signal — not a tick — woke it.
 */
const activeState = (threadId: string): ThreadWaitState =>
  ({ threadId, statusType: 'active', activeFlags: [], latestTurn: { id: 'turn-1', status: 'inProgress' }, latestText: null });
const doneState = (threadId: string): ThreadWaitState =>
  ({ threadId, statusType: 'idle', activeFlags: [], latestTurn: { id: 'turn-1', status: 'completed' }, latestText: 'All done.' });

function composedCoordinator(states: Map<string, ThreadWaitState>, signals: ReturnType<typeof createThreadWaitSignals>) {
  return new ThreadWaitCoordinator({
    readState: async threadId => {
      const state = states.get(threadId);
      if (!state) throw new Error('The conversation was not found');
      return state;
    },
    onChange: listener => signals.onChange(listener),
    onInput: (threadId, listener) => signals.onInput(threadId, listener),
    tickMs: 300_000,
  });
}

h.test('a real engine event wakes a composed wait without waiting for a tick', async () => {
  const signals = createThreadWaitSignals();
  const states = new Map([['thread-b', activeState('thread-b')]]);
  const coordinator = composedCoordinator(states, signals);

  const started = Date.now();
  const waiting = coordinator.wait({
    targets: [{ threadId: 'thread-b' }], timeoutMs: 60_000, signal: new AbortController().signal, callerId: 'thread-a' });
  await new Promise(resolve => setTimeout(resolve, 30));

  // The target finishes, and the engine pump reports it exactly as it does in
  // production. Nothing else should be able to end this wait.
  states.set('thread-b', doneState('thread-b'));
  signals.engineChanged(turnCompleted('thread-b'));

  const outcome = await waiting;
  const elapsed = Date.now() - started;
  assert.equal(outcome.endReason, 'wake', 'the turn completion woke the wait');
  assert.equal(outcome.wake?.threadId, 'thread-b');
  assert.equal(outcome.wake?.reason, 'turnCompleted');
  assert(elapsed < 10_000, `woken by the event in ${elapsed}ms, not by the 300000ms tick`);
  assert.equal(outcome.polls[0]?.text, 'All done.', 'the waking poll carries the target progress');
  assert.equal(signals.listenerCounts().change, 0, 'the settled wait unsubscribed itself');
});

h.test('an approval reverse request wakes a composed wait as needs-attention', async () => {
  const signals = createThreadWaitSignals();
  // Starts genuinely progressing and only LATER becomes actionable. Setting the
  // flag before the wait would make the first poll wake immediately, so the
  // reverseRequest wiring would never be exercised and this test would pass even
  // with `engineChanged` dead — which is exactly what a mutation check caught.
  const states = new Map([['thread-b', activeState('thread-b')]]);
  const coordinator = composedCoordinator(states, signals);

  const started = Date.now();
  const waiting = coordinator.wait({
    targets: [{ threadId: 'thread-b' }], timeoutMs: 30_000, signal: new AbortController().signal, callerId: 'thread-a' });
  await new Promise(resolve => setTimeout(resolve, 30));

  // The target parks on an approval and the engine reports it as a reverse request.
  states.set('thread-b', { ...activeState('thread-b'), activeFlags: ['waitingOnApproval'] });
  signals.engineChanged(reverseRequest);

  const outcome = await waiting;
  assert.equal(outcome.endReason, 'wake');
  assert.equal(outcome.wake?.reason, 'actionableStatus', 'a pending approval is "needs attention"');
  assert.equal(outcome.wake?.threadId, 'thread-b');
  // The elapsed bound is what makes this test mean anything. Without it the test
  // still passed with `engineChanged` dead, because the coordinator's own timer
  // fires at `min(tickMs, remaining)` and re-polls — so it woke LATE rather than
  // never. Asserting only `endReason` cannot tell an event-driven wake from a
  // timeout-driven re-poll; asserting the wall clock can.
  const elapsed = Date.now() - started;
  assert(elapsed < 10_000, `woken by the reverse request in ${elapsed}ms, not by a timer re-poll`);
});

h.test('human input into the caller ends a composed wait early', async () => {
  const signals = createThreadWaitSignals();
  const states = new Map([['thread-b', activeState('thread-b')], ['thread-c', activeState('thread-c')]]);
  const coordinator = composedCoordinator(states, signals);

  const started = Date.now();
  const waiting = coordinator.wait({
    targets: [{ threadId: 'thread-b' }, { threadId: 'thread-c' }], timeoutMs: 60_000,
    signal: new AbortController().signal, callerId: 'thread-a' });
  await new Promise(resolve => setTimeout(resolve, 30));
  signals.input('thread-a');

  const outcome = await waiting;
  assert.equal(outcome.endReason, 'interrupted', 'the person typing outranks the wait they started');
  assert.equal(outcome.wake, null, 'no target is claimed to have finished');
  assert(Date.now() - started < 10_000, 'returned promptly');
  assert.deepEqual(signals.listenerCounts(), { change: 0, input: 0 }, 'both subscriptions released');
});

h.test('input into an unrelated conversation does not end the wait', async () => {
  const signals = createThreadWaitSignals();
  const states = new Map([['thread-b', activeState('thread-b')]]);
  const coordinator = composedCoordinator(states, signals);

  const waiting = coordinator.wait({
    targets: [{ threadId: 'thread-b' }], timeoutMs: 500, signal: new AbortController().signal, callerId: 'thread-a' });
  await new Promise(resolve => setTimeout(resolve, 30));
  signals.input('thread-unrelated');

  const outcome = await waiting;
  assert.equal(outcome.endReason, 'timeout', 'someone typing elsewhere is not a reason to stop waiting');
  assert.equal(outcome.timedOut, true);
});

void h.finish(join(root, 'result.json'), 'thread-wait-signals').then(code => {
  process.exitCode = 1;
  try { rmSync(root, { recursive: true, force: true }); } finally { process.exitCode = code; }
}).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
