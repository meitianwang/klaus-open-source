import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Json } from '../main/ipc/contract';
import { createWorkbuddyMediaFacade, workbuddyMediaFailure, type NativeMediaEngine } from '../main/services/media-generation/native-facade';
import type { GenerationTool } from '../main/services/media-generation/contract';
import type { MediaGenerationDeps } from '../main/services/media-generation/service';
import { object, type JsonObject } from '../main/services/service-types';
import { kvSet } from '../main/services/settings';
import type { Harness } from './harness';
import { mediaFixture, mp3, mp4, png, resultText } from './media-generation-fixture';

const capabilities = {
  image: { available: true, models: [{ id: 'image-one', label: 'Image One' }], defaultModel: 'image-one' },
  imageEdit: { available: true, referenceImages: true, models: [{ id: 'image-one', label: 'Image One' }, { id: 'edit-one', label: 'Edit One' }], defaultModel: 'edit-one' },
  video: { available: true, referenceImages: true, models: [{ id: 'video-one', label: 'Video One' }], defaultModel: 'video-one' },
  audio: { available: true, voice: false, speed: false },
};
function native(overrides: Partial<NonNullable<MediaGenerationDeps['workbuddy']>> = {}): NonNullable<MediaGenerationDeps['workbuddy']> {
  return { status: async () => ({ loggedIn: true }), capabilities: async () => capabilities,
    image: async () => ({ imageBase64: png.toString('base64'), mimeType: 'image/png' }),
    video: async () => ({ videoBase64: mp4.toString('base64'), mimeType: 'video/mp4' }),
    audio: async () => ({ audioBase64: mp3.toString('base64'), mimeType: 'audio/mpeg' }), ...overrides };
}

export function registerWorkbuddyMediaTests(h: Harness): void {
  h.test('WorkBuddy global media choices forward references and publish validated files independently of the language source', async () => {
    const calls: Array<{ kind: string; params: JsonObject }> = [], base = native();
    const workbuddy = native(Object.fromEntries((['image', 'video', 'audio'] as const).map(kind => [kind, async (params: JsonObject, signal: AbortSignal) => {
      calls.push({ kind, params }); return base[kind](params, signal);
    }])));
    const f = await mediaFixture({ deps: { workbuddy } });
    try {
      for (const kind of ['image', 'video', 'audio'] as const) f.config('custom', kind, { baseUrl: 'https://private.invalid', apiKey: 'never-forward', model: 'custom-model' });
      f.select('workbuddy'); f.selectVideo('workbuddy'); f.selectAudio('workbuddy');
      const source = join(f.root, 'reference.png'); await writeFile(source, png);
      for (const [tool, args] of [['generate_image', { prompt: 'Blue' }], ['generate_image', { prompt: 'Edit', source_images: [source] }], ['generate_video', { prompt: 'Move', seconds: 4, source_images: [source] }], ['generate_audio', { text: 'Hello' }]] as Array<[GenerationTool, Json]>) {
        const result = await f.service.execute(tool, args, f.context('custom'));
        equal(object(result).success, true, resultText(result));
      }
      deepEqual(calls, [
        { kind: 'image', params: { prompt: 'Blue', sessionId: 'session', model: 'image-one' } },
        { kind: 'image', params: { prompt: 'Edit', sessionId: 'session', model: 'image-one', referenceImages: [{ dataBase64: png.toString('base64'), mimeType: 'image/png' }] } },
        { kind: 'video', params: { prompt: 'Move', sessionId: 'session', model: 'video-one', seconds: 4, referenceImages: [{ dataBase64: png.toString('base64'), mimeType: 'image/png' }] } },
        { kind: 'audio', params: { text: 'Hello' } },
      ]);
      deepEqual(await Promise.all(f.generated.flatMap(row => row.paths).map(path => readFile(path))), [png, png, mp4, mp3]);
      equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  h.test('WorkBuddy native preferences never read or overwrite custom endpoint configuration', async () => {
    const f = await mediaFixture({ deps: { workbuddy: native() } });
    try {
      f.config('custom', 'image', { model: 'custom-image' });
      equal(object(f.features.setMedia('image', { source: 'workbuddy', model: 'image-one' })).ok, true);
      deepEqual(f.features.getMedia('image', { source: 'workbuddy' }), { source: 'workbuddy', model: 'image-one' });
      equal(object(f.features.getMedia('image')).model, 'custom-image');
      equal(object(f.features.setMedia('image', { source: 'workbuddy', apiKey: 'must-not-save' })).ok, false);
      equal(JSON.stringify(f.features.getMedia('image', { source: 'workbuddy' })).includes('must-not-save'), false);
      kvSet('image_generation.native_model:workbuddy', JSON.stringify({ model: 'retired-model' }), f.root); f.select('workbuddy');
      match(resultText(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context())), /configuration is no longer available/);
      equal(f.generated.length, 0); equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  h.test('an image model that cannot edit fails without substituting the editing default', async () => {
    let calls = 0;
    const f = await mediaFixture({ deps: { workbuddy: native({
      capabilities: async () => ({ ...capabilities, imageEdit: { available: true, referenceImages: true, models: ['edit-only'], defaultModel: 'edit-only' } }),
      image: async () => { calls++; return { imageBase64: png.toString('base64'), mimeType: 'image/png' }; },
    }) } });
    try {
      f.select('workbuddy');
      equal(object(f.features.setMedia('image', { source: 'workbuddy', model: 'image-one' })).ok, true);
      const result = await f.service.execute('generate_image', { prompt: 'Edit', source_images: ['/must-not-read'] }, f.context());
      match(resultText(result), /Image editing is unavailable/);
      equal(object(result).success, false);
      equal(calls, 0); equal(f.generated.length, 0); equal(f.requests.length, 0);
      equal(object(f.features.getMedia('image', { source: 'workbuddy' })).model, 'image-one');
    } finally { await f.close(); }
  });
  h.test('WorkBuddy rejects unavailable capabilities and speech overrides before reading files or submitting', async () => {
    let calls = 0;
    const f = await mediaFixture({ deps: { workbuddy: native({ image: async () => { calls++; return {}; }, audio: async () => { calls++; return {}; }, capabilities: async () => ({ ...capabilities, imageEdit: { available: false } }) }) } });
    try {
      f.select('workbuddy'); f.selectAudio('workbuddy');
      match(resultText(await f.service.execute('generate_image', { prompt: 'Edit', source_images: ['/must-not-read'] }, f.context())), /currently unavailable/);
      for (const override of [{ voice: 'voice' }, { speed: 1 }, { emotion: 'calm' }] as JsonObject[]) match(resultText(await f.service.execute('generate_audio', { text: 'Hello', ...override }, f.context())), /not supported/);
      equal(calls, 0); equal(f.generated.length, 0); equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  h.test('WorkBuddy failed or expired selections retain intent and never fall back to custom media', async () => {
    for (const workbuddy of [native({ status: async () => ({ loggedIn: true, needsReimport: true }) }), native({ video: async () => ({ videoBase64: mp4.toString('base64'), mimeType: 'video/webm' }) })]) {
      const f = await mediaFixture({ deps: { workbuddy } });
      try {
        f.config('custom', 'video', {}); f.selectVideo('workbuddy');
        equal(object(await f.service.execute('generate_video', { prompt: 'Move' }, f.context())).success, false);
        equal(object(f.features.getVideoSelection()).selection, 'workbuddy'); equal(f.generated.length, 0); equal(f.requests.length, 0);
      } finally { await f.close(); }
    }
  });
  h.test('WorkBuddy facade cancellation and late replies stay bound to the captured engine', async () => {
    const calls: Array<{ method: string; params: Json }> = [];
    let finish!: (value: Json) => void;
    const result = new Promise<Json>(resolve => { finish = resolve; });
    const client = { isClosed: () => false, requestWithTimeout: async (method: string, params: Json) => { calls.push({ method, params }); return method === 'workbuddy/cancelOperation' ? { cancelled: true } : result; } };
    let engine: NativeMediaEngine | undefined = { client, generation: 1 };
    const facade = createWorkbuddyMediaFacade(() => engine), controller = new AbortController();
    const pending = facade.video({ prompt: 'Move' }, controller.signal); await nextTurn();
    engine = undefined; const rejected = rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected;
    deepEqual(calls.map(call => call.method), ['workbuddy/generateVideo', 'workbuddy/cancelOperation']);
    equal(object(calls[0]!.params).operationId, object(calls[1]!.params).operationId);
    finish({ videoBase64: mp4.toString('base64'), mimeType: 'video/mp4' }); await nextTurn();
    for (const code of ['workbuddy_credentials_expired', 'workbuddy_unsupported_parameter', 'workbuddy_rate_limit', 'unknown']) equal(workbuddyMediaFailure(new Error(code + ' private-token')).message.includes('private-token'), false);
  });
}
