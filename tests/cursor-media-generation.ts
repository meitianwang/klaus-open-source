import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Json } from '../main/ipc/contract';
import { AppServerClient } from '../main/engine/client';
import { createCursorMediaFacade, cursorMediaFailure, type CursorMediaEngine } from '../main/services/media-generation/cursor-facade';
import type { MediaGenerationDeps } from '../main/services/media-generation/service';
import { object, type JsonObject } from '../main/services/service-types';
import { kvGet, kvSet } from '../main/services/settings';
import type { Harness } from './harness';
import { mediaFixture, mp3, png, resultText } from './media-generation-fixture';

interface Call { method: string; params: Json; timeoutMs: number }
class Client {
  calls: Call[] = [];
  closed = false;
  constructor(readonly answer: (call: Call) => Promise<Json> = async () => ({ loggedIn: true })) {}
  isClosed(): boolean { return this.closed; }
  requestWithTimeout(method: string, params: Json, timeoutMs: number): Promise<Json> {
    const call = { method, params, timeoutMs }; this.calls.push(call); return this.answer(call);
  }
}
function deferred(): { promise: Promise<Json>; resolve(value: Json): void; reject(error: unknown): void } {
  let resolve!: (value: Json) => void, reject!: (error: unknown) => void;
  const promise = new Promise<Json>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
function native(overrides: Partial<NonNullable<MediaGenerationDeps['cursor']>> = {}): NonNullable<MediaGenerationDeps['cursor']> {
  return { status: async () => ({ loggedIn: true }), image: async () => ({ imageBase64: png.toString('base64'), mimeType: 'image/png' }),
    audio: async () => ({ audioBase64: mp3.toString('base64'), mimeType: 'audio/mpeg' }),
    ...overrides };
}

export function registerCursorMediaTests(h: Harness): void {
  h.test('a retired video selection cannot spend a configured custom provider', async () => {
    const f = await mediaFixture();
    try {
      f.config('custom', 'video', { model: 'configured-video' });
      kvSet('video_generation.selection', 'cursor', f.root);
      equal(object(f.features.getVideoSelection()).selection, 'none', 'a retired video selection folds to the disabled state');
      const result = await f.service.execute('generate_video', { prompt: 'A blue circle moves' }, f.context());
      equal(object(result).success, false); match(resultText(result), /disabled/);
      equal(f.requests.length, 0); equal(f.generated.length, 0);
      equal(object(f.selectVideo('custom')).ok, false, 'the retired endpoint cannot be reselected');
      equal(object(f.features.getVideoSelection()).selection, 'none', 'a rejected choice preserves the disabled state');
    } finally { await f.close(); }
  });
  h.test('Cursor media uses the global choice across language sources without consulting custom endpoints', async () => {
    const calls: Array<{ kind: string; params: JsonObject }> = [];
    const replies = native();
    const cursor = native(Object.fromEntries((['image', 'audio'] as const).map(kind => [kind, async (params: JsonObject, signal: AbortSignal) => {
      calls.push({ kind, params }); return replies[kind](params, signal);
    }])));
    const f = await mediaFixture({ deps: { cursor } });
    try {
      f.select('cursor'); f.selectAudio('cursor');
      for (const kind of ['image', 'video', 'audio'] as const) f.config('custom', kind, { baseUrl: 'https://private.invalid', apiKey: 'never-forward' });
      const source = join(f.root, 'reference.png'); await writeFile(source, png);
      equal(object(await f.service.execute('generate_image', { prompt: 'Blue', size: '16:9', source_images: [source] }, f.context('custom'))).success, true);
      equal(object(await f.service.execute('generate_image', { prompt: 'Green' }, { ...f.context('cursor'), modelSelection: 'cursor:concrete' })).success, true);
      equal(object(await f.service.execute('generate_audio', { text: 'Hello', voice: 'voice-one', speed: 1.25 }, f.context('codex'))).success, true);
      deepEqual(calls, [
        { kind: 'image', params: { prompt: 'Blue', size: '16:9', referenceImages: [{ dataBase64: png.toString('base64'), mimeType: 'image/png' }] } },
        { kind: 'image', params: { prompt: 'Green', modelSelection: 'cursor:concrete' } },
        { kind: 'audio', params: { text: 'Hello', voice: 'voice-one', speed: 1.25 } },
      ]);
      deepEqual(await Promise.all(f.generated.flatMap(row => row.paths).map(path => readFile(path))), [png, png, mp3]);
      equal(f.requests.length, 0);
      match(JSON.stringify(f.features.getMedia('image')), /private.invalid/);
    } finally { await f.close(); }
  });
  h.test('Cursor media refuses expired accounts and unsupported speech controls before dispatch', async () => {
    let calls = 0;
    for (const status of [{ loggedIn: false }, { loggedIn: true, needsLogin: true }, { loggedIn: true, needsReimport: true }] as JsonObject[]) {
      const f = await mediaFixture({ deps: { cursor: native({ status: async () => status, image: async () => { calls++; return {}; } }) } });
      try {
        f.select('cursor');
        match(resultText(await f.service.execute('generate_image', { prompt: 'Blue', source_images: ['/must-not-read'] }, f.context())), /Reconnect the generation account/);
        equal(object(f.features.getImageSelection()).selection, 'cursor');
        equal(f.generated.length, 0);
      } finally { await f.close(); }
    }
    const f = await mediaFixture({ deps: { cursor: native({ audio: async () => { calls++; return {}; } }) } });
    try {
      f.selectAudio('cursor');
      match(resultText(await f.service.execute('generate_audio', { text: 'Hello', emotion: 'calm' }, f.context())), /does not support the emotion/);
      match(resultText(await f.service.execute('generate_audio', { text: 'Hello', speed: 0.5 }, f.context())), /0.75 and 2/);
      equal(calls, 0); equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  h.test('Cursor reference size limits fail before submitting a provider job', async () => {
    let submitted = 0;
    const f = await mediaFixture({ deps: { cursor: native({ image: async () => { submitted++; return {}; } }) } });
    try {
      f.select('cursor');
      for (const sizes of [[4 * 1024 * 1024 + 1], [3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024]]) {
        const paths: string[] = [];
        for (const [index, size] of sizes.entries()) {
          const path = join(f.root, `bounded-reference-${index}.png`), bytes = Buffer.alloc(size); png.copy(bytes);
          await writeFile(path, bytes); paths.push(path);
        }
        const result = await f.service.execute('generate_image', { prompt: 'Use these reference images', source_images: paths }, f.context());
        equal(object(result).success, false); match(resultText(result), /4 MiB each and 8 MiB combined/);
      }
      equal(submitted, 0); equal(f.requests.length, 0); equal(f.generated.length, 0);
    } finally { await f.close(); }
  });
  h.test('Cursor media validates output bytes and MIME and never falls back after an independent service denial', async () => {
    const invalid = [native({ image: async () => ({ imageBase64: png.toString('base64'), mimeType: 'image/jpeg' }) }),
      native({ audio: async () => ({ audioBase64: Buffer.from('{}').toString('base64'), mimeType: 'audio/mpeg' }) }),
      native({ image: async () => { throw cursorMediaFailure(new Error('cursor_native_capability_not_enabled private-token')); } })];
    for (let i = 0; i < invalid.length; i++) {
      const f = await mediaFixture({ deps: { cursor: invalid[i] } });
      try {
        f.select('cursor'); f.selectAudio('cursor');
        const tool = i === 1 ? 'generate_audio' : 'generate_image';
        const result = await f.service.execute(tool, tool === 'generate_audio' ? { text: 'Hello' } : { prompt: 'Blue' }, f.context());
        equal(object(result).success, false); equal(resultText(result).includes('private-token'), false);
        equal(f.generated.length, 0); equal(f.requests.length, 0);
        deepEqual(await readdir(join(f.root, 'sessions')).catch(() => []), []);
      } finally { await f.close(); }
    }
  });
  h.test('Cursor facade pins named methods and bounded deadlines and attaches unique operation identifiers', async () => {
    const client = new Client(), facade = createCursorMediaFacade(() => ({ client, generation: 1 })), signal = new AbortController().signal;
    await facade.status(signal); await facade.image({ prompt: 'Blue' }, signal); await facade.audio({ text: 'Hello' }, signal);
    deepEqual(client.calls.map(call => [call.method, call.timeoutMs]), [['cursor/status', 15_000], ['cursor/generateImage', 300_000], ['cursor/generateAudio', 300_000]]);
    deepEqual(client.calls[0]!.params, {});
    const ids = client.calls.slice(1).map(call => object(call.params).operationId);
    equal(new Set(ids).size, 2); for (const id of ids) match(String(id), /^[a-f0-9-]{36}$/);
  });
  h.test('Cursor facade cancellation before dispatch sends nothing and in-flight cancellation stays on the original engine', async () => {
    const late = deferred(), first = new Client(async call => call.method === 'cursor/cancelOperation' ? { ok: true } : late.promise), replacement = new Client();
    let engine: CursorMediaEngine | undefined = { client: first, generation: 1 };
    const facade = createCursorMediaFacade(() => engine), early = new AbortController();
    const unsubmitted = facade.image({ prompt: 'Blue' }, early.signal); early.abort(); await rejects(unsubmitted, { name: 'AbortError' }); equal(first.calls.length, 0);
    const controller = new AbortController(), pending = facade.image({ prompt: 'Blue' }, controller.signal); await nextTurn();
    engine = { client: replacement, generation: 2 };
    const rejected = rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected;
    deepEqual(first.calls.map(call => call.method), ['cursor/generateImage', 'cursor/cancelOperation']);
    equal(object(first.calls[0]!.params).operationId, object(first.calls[1]!.params).operationId); deepEqual(replacement.calls, []);
    late.reject(new Error('Late private failure')); await nextTurn(); await nextTurn();
  });
  h.test('Cursor facade rejects obsolete replies and sanitizes timeout and provider classifications', async () => {
    const late = deferred(), client = new Client(() => late.promise), engine = { client, generation: 1 };
    const pending = createCursorMediaFacade(() => engine).image({ prompt: 'Blue' }, new AbortController().signal); await nextTurn();
    engine.generation++; const rejected = rejects(pending, /connection changed/); late.resolve({}); await rejected;
    const timeout = new Client(async call => { if (call.method === 'cursor/cancelOperation') return { ok: true }; throw { kind: 'timeout' }; });
    await rejects(createCursorMediaFacade(() => ({ client: timeout, generation: 1 })).audio({ text: 'Hello' }, new AbortController().signal), /timed out/);
    deepEqual(timeout.calls.map(call => call.method), ['cursor/generateAudio', 'cursor/cancelOperation']);
    for (const code of ['cursor_native_capability_not_enabled', 'cursor_rate_limit', 'cursor_permission_denied', 'cursor_credentials_expired', 'cursor_invalid_request', 'unknown']) {
      equal(cursorMediaFailure(new Error(code + ' private-token')).message.includes('private-token'), false);
    }
  });
  h.test('queued native media cancellation removes the RPC and reaches the reserved control slot', async () => {
    const frames: JsonObject[] = [];
    const client = new AppServerClient(new Writable({ write(chunk, _encoding, callback) {
      frames.push(JSON.parse(String(chunk)) as JsonObject); callback();
    } }));
    const blockers = Array.from({ length: 5 }, () => client.requestWithTimeout('cursor/generateAudio', { text: 'Pending fixture' }, 5000).catch(() => null));
    try {
      await nextTurn(); equal(frames.length, 5);
      const controller = new AbortController();
      const pending = createCursorMediaFacade(() => ({ client, generation: 1 })).image({ prompt: 'Do not submit' }, controller.signal);
      await nextTurn(); equal(client.schedulingStats().queued, 1);
      const rejected = rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected; await nextTurn();
      equal(frames.filter(frame => frame.method === 'cursor/cancelOperation').length, 1, 'cancellation is admitted while ordinary requests occupy all their slots');
      for (const frame of frames) client.feedStdout(Buffer.from(JSON.stringify({ id: frame.id, result: { ok: true } }) + '\n'));
      await Promise.all(blockers); await nextTurn();
      equal(frames.some(frame => frame.method === 'cursor/generateImage'), false, 'cancelled queued work never reaches the engine after capacity becomes available');
      equal(client.schedulingStats().consumers, 0);
    } finally { client.close(); await Promise.all(blockers); }
  });
}
