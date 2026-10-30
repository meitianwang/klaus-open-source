import assert from 'node:assert/strict';
import { join } from 'node:path';
import { queryPrediction } from '../main/sessions/prediction-query';
import { Harness } from './harness';
import type { EngineClientLike } from '../main/sessions/service';
import type { Json } from '../main/ipc/contract';
import type { RpcRequestOptions } from '../main/engine/request-scheduler';

const h = new Harness();
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject }; }
function fixture(run: (method: string, params: Json) => Promise<unknown>) {
  const calls: Array<{ method: string; params: Json; options?: RpcRequestOptions }> = [];
  const client: EngineClientLike = { isClosed: () => false, on: () => {}, off: () => {}, requestWithTimeout: async (method, params, _timeout, options) => { calls.push({ method, params, options }); return run(method, params) } };
  return { client, calls };
}
void (async () => {
  await h.test('prediction calls use background capacity and inherit effort when no override was configured', async () => {
    const f = fixture(async () => ({ suggestion: '  Continue.  ' }));
    assert.deepEqual(await queryPrediction(f.client, 'session-a', 'turn-a', 'dynamic prompt', null, new AbortController().signal), { suggestion: 'Continue.' });
    const params = f.calls[0]!.params as Record<string, Json>;
    assert.equal(params.sessionId, 'session-a'); assert.equal(params.sourceTurnId, 'turn-a'); assert.equal(params.prompt, 'dynamic prompt'); assert(!('effort' in params));
    assert.deepEqual(f.calls[0]!.options, { priority: 'background', source: 'thread', conversationId: 'session-a' });
  });
  await h.test('pre-cancelled requests never reach the engine', async () => {
    const controller = new AbortController(); controller.abort(); const f = fixture(async () => assert.fail());
    await assert.rejects(queryPrediction(f.client, 'session-a', 'turn-a', 'prompt', 'high', controller.signal)); assert.equal(f.calls.length, 0);
  });
  await h.test('cancellation uses reserved capacity and retains the exact source connection and request identity', async () => {
    const prediction = deferred<unknown>(), controller = new AbortController();
    const f = fixture(async method => {
      if (method === 'session/predictMessage') return prediction.promise;
      assert.equal(method, 'session/cancelPrediction'); prediction.reject(new Error('engine cancelled')); return { submissionId: 'cancel-ack' };
    });
    const result = queryPrediction(f.client, 'session-a', 'turn-a', 'prompt', 'high', controller.signal); controller.abort();
    await assert.rejects(result, /engine cancelled/);
    assert.equal(f.calls.length, 2);
    assert.equal((f.calls[1]!.params as Record<string, Json>).requestId, (f.calls[0]!.params as Record<string, Json>).requestId);
    assert.deepEqual(f.calls[1]!.options, { priority: 'critical', source: 'thread', conversationId: 'session-a' });
  });
  await h.test('a late successful engine result remains cancelled and never becomes a draft', async () => {
    const pending = deferred<unknown>(), controller = new AbortController();
    const f = fixture(async method => method === 'session/predictMessage' ? pending.promise : { submissionId: 'cancel-ack' });
    const result = queryPrediction(f.client, 'session-a', 'turn-a', 'prompt', null, controller.signal); controller.abort(); pending.resolve({ suggestion: 'Late text' });
    await assert.rejects(result, error => error instanceof Error && error.name === 'AbortError');
    assert.equal(f.calls.filter(call => call.method === 'session/cancelPrediction').length, 1);
  });
  await h.test('invalid engine suggestions are rejected and the request is retired', async () => {
    const f = fixture(async method => method === 'session/predictMessage' ? { suggestion: 42 } : { submissionId: 'cancel-ack' });
    await assert.rejects(queryPrediction(f.client, 'session-a', 'turn-a', 'prompt', null, new AbortController().signal), /invalid prediction/);
    assert.equal(f.calls[1]!.method, 'session/cancelPrediction');
  });
  process.exitCode = await h.finish(join(__dirname, 'prediction-query-result.json'), 'prediction-query');
})();
