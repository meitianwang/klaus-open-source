import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Json } from '../main/ipc/contract';
import { createQoderMediaFacade, type QoderMediaEngine } from '../main/services/media-generation/qoder-facade';
import { object } from '../main/services/service-types';
import { Harness, waitFor } from './harness';
import { generationVector, mediaFixture, png, resultText } from './media-generation-fixture';

const h = new Harness();
interface Call { method: string; params: Json; timeoutMs: number }
class FakeClient {
  closed = false;
  calls: Call[] = [];
  constructor(readonly answer: (call: Call) => Promise<Json> = async (call): Promise<Json> => {
    if (call.method === 'qoder/status') return { loggedIn: true };
    return { imageBase64: png.toString('base64') };
  }) {}
  isClosed(): boolean { return this.closed; }
  requestWithTimeout(method: string, params: Json, timeoutMs: number): Promise<Json> {
    const call = { method, params, timeoutMs }; this.calls.push(call); return this.answer(call);
  }
}
function deferred(): { promise: Promise<Json>; resolve(value: Json): void; reject(error: unknown): void } {
  let resolve!: (value: Json) => void, reject!: (error: unknown) => void;
  const promise = new Promise<Json>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
function beforeNextTurn<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, nextTurn().then(() => { throw new Error('The host observation did not settle before the next event-loop turn.'); })]);
}

h.test('status and generation use the committed named RPC deadlines and preserve direct results', async () => {
  const client = new FakeClient(), facade = createQoderMediaFacade(() => ({ client, generation: 1 })), signal = new AbortController().signal;
  deepEqual(await facade.status(signal), { loggedIn: true });
  const params = { prompt: 'A blue square', sessionId: 'thread', size: '1024x1024' };
  deepEqual(await facade.generate(params, signal), { imageBase64: png.toString('base64') });
  const vector = object((await generationVector()).qoderRpc);
  deepEqual(client.calls, [{ ...object(vector.status), params: {} }, { ...object(vector.generate), params }]);
});
h.test('a request cancelled before dispatch never looks up or submits to the engine', async () => {
  let lookups = 0; const facade = createQoderMediaFacade(() => { lookups++; return { client: new FakeClient(), generation: 1 }; }), controller = new AbortController();
  controller.abort();
  await rejects(facade.status(controller.signal), { name: 'AbortError' });
  await rejects(facade.generate({ prompt: 'Do not send' }, controller.signal), { name: 'AbortError' });
  equal(lookups, 0);
});
h.test('cancellation before the dispatch microtask emits no named request', async () => {
  const client = new FakeClient(), facade = createQoderMediaFacade(() => ({ client, generation: 1 })), controller = new AbortController();
  const request = facade.generate({ prompt: 'Do not send' }, controller.signal), cancelled = rejects(beforeNextTurn(request), { name: 'AbortError' });
  controller.abort(); await cancelled; deepEqual(client.calls, []);
});
h.test('status and generation cancellation release observation without waiting for an accepted RPC', async () => {
  for (const method of ['status', 'generate'] as const) {
    const late = deferred(), client = new FakeClient(() => late.promise), controller = new AbortController();
    const facade = createQoderMediaFacade(() => ({ client, generation: 1 }));
    const request = method === 'status' ? facade.status(controller.signal) : facade.generate({ prompt: 'Image' }, controller.signal);
    await nextTurn(); equal(client.calls.length, 1);
    const cancelled = rejects(beforeNextTurn(request), { name: 'AbortError' }); controller.abort(); await cancelled;
    late.resolve({ imageBase64: png.toString('base64') }); await nextTurn();
    deepEqual(client.calls.map(call => call.method), [method === 'status' ? 'qoder/status' : 'qoder/generateImage']);
  }
});
h.test('late rejection after cancellation stays observed and never retries on the replacement engine', async () => {
  const late = deferred(), first = new FakeClient(() => late.promise), next = new FakeClient(), controller = new AbortController();
  let engine = { client: first, generation: 1 }; const facade = createQoderMediaFacade(() => engine), unhandled: unknown[] = [];
  const observe = (reason: unknown): void => { unhandled.push(reason); }; process.on('unhandledRejection', observe);
  try {
    const request = facade.generate({ prompt: 'Image' }, controller.signal); await nextTurn();
    const cancelled = rejects(beforeNextTurn(request), { name: 'AbortError' }); controller.abort(); await cancelled;
    engine = { client: next, generation: 2 }; late.reject(new Error('Late remote failure'));
    await nextTurn(); await nextTurn(); deepEqual(unhandled, []); deepEqual(next.calls, []); equal(first.calls.length, 1);
    deepEqual(await facade.status(new AbortController().signal), { loggedIn: true }); equal(next.calls.length, 1);
  } finally { process.removeListener('unhandledRejection', observe); }
});
h.test('client identity and captured generation independently reject an obsolete engine reply', async () => {
  for (const replaceClient of [true, false]) {
    const late = deferred(), first = new FakeClient(() => late.promise), replacement = new FakeClient();
    const engine = { client: first, generation: 1 }, facade = createQoderMediaFacade(() => engine);
    const request = facade.generate({ prompt: 'Image' }, new AbortController().signal); await nextTurn();
    if (replaceClient) engine.client = replacement; else engine.generation++;
    const stale = rejects(request, /connection changed/); late.resolve({ imageBase64: png.toString('base64') }); await stale;
    equal(first.calls.length, 1); deepEqual(replacement.calls, []);
  }
});
h.test('engine removal and a closed original client cannot return a stale status result', async () => {
  for (const remove of [true, false]) {
    const late = deferred(), client = new FakeClient(() => late.promise);
    let engine: QoderMediaEngine | undefined = { client, generation: 1 }; const facade = createQoderMediaFacade(() => engine);
    const request = facade.status(new AbortController().signal); await nextTurn();
    if (remove) engine = undefined; else client.closed = true;
    const stale = rejects(request, /connection changed/); late.resolve({ loggedIn: true }); await stale;
    equal(client.calls.length, 1);
  }
});
h.test('unavailable engines and provider failures return safe errors while timeout wording preserves remote uncertainty', async () => {
  const signal = new AbortController().signal;
  await rejects(createQoderMediaFacade(() => undefined).status(signal), /unavailable/);
  const closed = new FakeClient(); closed.closed = true;
  await rejects(createQoderMediaFacade(() => ({ client: closed, generation: 1 })).status(signal), /unavailable/); deepEqual(closed.calls, []);
  for (const synchronous of [true, false]) {
    const client = new FakeClient(() => { const error = new Error('private-provider-fixture'); if (synchronous) throw error; return Promise.reject(error); });
    await rejects(createQoderMediaFacade(() => ({ client, generation: 1 })).generate({ prompt: 'Image' }, signal), { message: 'The Qoder request failed.' });
  }
  const timedOut = new FakeClient(async () => { throw { kind: 'timeout', method: 'qoder/generateImage' }; });
  await rejects(createQoderMediaFacade(() => ({ client: timedOut, generation: 1 })).generate({ prompt: 'Image' }, signal), /timed out\. An accepted remote job may still finish/);
});
h.test('session release finishes before a pending Qoder response and only a new engine request can publish', async () => {
  const late = deferred(), first = new FakeClient(async call => call.method === 'qoder/status' ? { loggedIn: true } : late.promise), next = new FakeClient();
  let engine = { client: first, generation: 1 }; const f = await mediaFixture({ deps: { qoder: createQoderMediaFacade(() => engine) } });
  try {
    f.select('qoder');
    const old = f.service.execute('generate_image', { prompt: 'Old image' }, f.context('qoder', 'old'));
    await waitFor(() => first.calls.length === 2, 1000, 'Qoder generation submitted');
    await beforeNextTurn(f.service.releaseSession('old'));
    const cancelled = await old; equal(object(cancelled).success, false); match(resultText(cancelled), /accepted remote job may still finish/i);
    engine = { client: next, generation: 2 };
    const fresh = await f.service.execute('generate_image', { prompt: 'New image' }, f.context('qoder', 'new')); equal(object(fresh).success, true);
    late.resolve({ imageBase64: png.toString('base64') }); await nextTurn();
    deepEqual(f.generated.map(row => row.sessionId), ['new']);
    deepEqual(await readdir(join(f.root, 'sessions', 'old')).catch(() => []), []);
    deepEqual(first.calls.map(call => call.method), ['qoder/status', 'qoder/generateImage']);
    deepEqual(next.calls.map(call => call.method), ['qoder/status', 'qoder/generateImage']);
  } finally { late.resolve({ imageBase64: png.toString('base64') }); await f.close(); }
});

void h.finish(join(__dirname, 'qoder-media-facade-results.json'), 'qoder-media-facade').then(code => { process.exitCode = code; });
