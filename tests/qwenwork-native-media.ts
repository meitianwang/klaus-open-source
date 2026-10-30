import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeMediaConnection } from '../main/services/media-generation/service';
import { createQwenworkNativeMediaFacade } from '../main/services/media-generation/native-facade';
import { kvSet } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import type { Harness } from './harness';
import { generationVector, mediaFixture, mp3, mp4, png, resultText } from './media-generation-fixture';

const capabilities = {
  image: { available: true, models: ['image-one', 'image-two'], defaultModel: 'image-one', referenceImages: 4 },
  imageEdit: { available: true, models: ['image-one', 'image-two'], defaultModel: 'image-one', referenceImages: 4 },
  video: { available: true, models: ['video-one'], defaultModel: 'video-one' },
  music: { available: true, models: ['music-one'], defaultModel: 'music-one' },
  audio: { available: false },
};
function native(calls: Array<{ method: string; params: JsonObject }>): NativeMediaConnection {
  return { status: async () => ({ loggedIn: true }), capabilities: async () => capabilities,
    image: async params => { calls.push({ method: 'image', params }); return { imageBase64: png.toString('base64'), mimeType: 'image/png' }; },
    video: async params => { calls.push({ method: 'video', params }); return { videoBase64: mp4.toString('base64'), mimeType: 'video/mp4' }; },
    audio: async params => { calls.push({ method: 'music', params }); return { audioBase64: mp3.toString('base64'), mimeType: 'audio/mpeg' }; },
  };
}
export function registerQwenworkNativeMediaTests(h: Harness): void {
  h.test('native video option failures keep routing details private', async () => {
    const vector = object(object((await generationVector()).qwenworkRpc).videoSizeFailure);
    const client = { isClosed: () => false, requestWithTimeout: async () => { throw new Error(String(vector.errorCode)); } };
    const facade = createQwenworkNativeMediaFacade(() => ({ generation: 1, client }));
    await rejects(facade.video({ prompt: 'Sunlight', size: '1280x720' }, new AbortController().signal), { message: String(vector.message) });
  });
  h.test('native video generation publishes multi-megabyte results byte for byte', async () => {
    const vector = object((await generationVector()).base64Decoding);
    const bytes = Buffer.alloc(Number(vector.largePayloadBytes)); mp4.copy(bytes);
    for (const source of ['qwenwork', 'workbuddy'] as const) {
      const calls: Array<{ method: string; params: JsonObject }> = [];
      const connection = native(calls);
      connection.video = async params => { calls.push({ method: 'video', params }); return { videoBase64: bytes.toString('base64'), mimeType: 'video/mp4' }; };
      const f = await mediaFixture({ deps: { [source]: connection } });
      try {
        f.selectVideo(source);
        const result = await f.service.execute('generate_video', { prompt: 'Sunlight through a window' }, f.context());
        equal(object(result).success, true, resultText(result));
        equal(calls.length, 1); equal(f.generated.length, 1);
        deepEqual(await readFile(f.generated[0]!.paths[0]!), bytes);
        equal(f.requests.length, 0);
      } finally { await f.close(); }
    }
  });
  h.test('QwenWork generation and editing use one saved image model independently of video routing', async () => {
    const calls: Array<{ method: string; params: JsonObject }> = [], f = await mediaFixture({ deps: { qwenwork: native(calls) } });
    try {
      kvSet('image_generation.native_model:qwenwork', JSON.stringify({ model: 'image-two', imageEditModel: 'image-one' }), f.root);
      f.select('qwenwork'); f.selectVideo('qwenwork');
      f.config('custom', 'image', { apiKey: 'never-forward', model: 'custom-image' });
      const path = join(f.root, 'reference.png'); await writeFile(path, png);
      equal(object(await f.service.execute('generate_image', { prompt: 'Draw' }, f.context('codex'))).success, true);
      equal(object(await f.service.execute('generate_image', { prompt: 'Edit', source_images: [path] }, f.context('codex'))).success, true);
      equal(object(await f.service.execute('generate_video', { prompt: 'Move', seconds: 7, size: '720p' }, f.context('subscription'))).success, true);
      deepEqual(calls, [
        { method: 'image', params: { prompt: 'Draw', model: 'image-two' } },
        { method: 'image', params: { prompt: 'Edit', model: 'image-two', referenceImages: [{ dataBase64: png.toString('base64'), mimeType: 'image/png' }] } },
        { method: 'video', params: { prompt: 'Move', seconds: 7, size: '720p', model: 'video-one' } },
      ]);
      deepEqual(await Promise.all(f.generated.flatMap(row => row.paths).map(path => readFile(path))), [png, png, mp4]);
      equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  h.test('speech and music use independent selections, tools and model preferences', async () => {
    const calls: Array<{ method: string; params: JsonObject }> = [];
    const f = await mediaFixture({ deps: { qwenwork: native(calls), cursor: {
      status: async () => ({ loggedIn: true }), image: async () => ({}),
      audio: async params => { calls.push({ method: 'speech', params }); return { audioBase64: mp3.toString('base64'), mimeType: 'audio/mpeg' }; },
    } } });
    try {
      f.selectAudio('cursor'); f.selectMusic('qwenwork');
      equal(object(f.features.setMedia('music', { source: 'qwenwork', model: 'music-one' })).ok, true);
      const results = await Promise.all([
        f.service.execute('generate_music', { prompt: 'Warm acoustic music', lyrics: 'A quiet morning in the sun' }, f.context()),
        f.service.execute('generate_audio', { text: 'Read this aloud' }, f.context()),
      ]);
      for (const result of results) equal(object(result).success, true, resultText(result));
      deepEqual(calls.find(row => row.method === 'music'), { method: 'music', params: { prompt: 'Warm acoustic music', lyrics: 'A quiet morning in the sun', model: 'music-one' } });
      equal(calls.filter(row => row.method === 'speech').length, 1);
      equal(object(f.features.getAudioSelection()).selection, 'cursor');
      equal(object(f.features.getMusicSelection()).selection, 'qwenwork');
      for (const input of [{ prompt: 'Music', text: 'Speech' }, { prompt: 'Music', voice: 'voice' }, { prompt: 'Music', speed: 1 }, { prompt: 'Music', emotion: 'happy' }, { prompt: 'Music', lyrics: 'short' }, { prompt: 'x'.repeat(2001) }] as JsonObject[]) equal(object(await f.service.execute('generate_music', input, f.context())).success, false);
      match(resultText(await f.service.execute('generate_audio', { prompt: 'Music' }, f.context())), /generate_music/);
      equal(object(f.selectAudio('qwenwork')).ok, false);
      f.selectAudio('none');
      equal(object(f.features.getMusicSelection()).selection, 'qwenwork');
      equal(object(await f.service.execute('generate_music', { prompt: 'Instrumental music' }, f.context())).success, true);
      f.selectAudio('cursor'); f.selectMusic('none');
      match(resultText(await f.service.execute('generate_music', { prompt: 'Music' }, f.context())), /Music generation is disabled/);
      equal(object(await f.service.execute('generate_audio', { text: 'Still speaking' }, f.context())).success, true);
      equal(f.requests.length, 0);
      for (const generated of f.generated) deepEqual(await readFile(generated.paths[0]!), mp3);
    } finally { await f.close(); }
  });
  h.test('QwenWork reference bounds reject locally before any native operation', async () => {
    const calls: Array<{ method: string; params: JsonObject }> = [], f = await mediaFixture({ deps: { qwenwork: native(calls) } });
    try {
      f.select('qwenwork');
      const path = join(f.root, 'oversized.png'), bytes = Buffer.alloc(4 * 1024 * 1024 + 1); png.copy(bytes); await writeFile(path, bytes);
      match(resultText(await f.service.execute('generate_image', { prompt: 'Edit', source_images: [path] }, f.context())), /4 MiB each/);
      match(resultText(await f.service.execute('generate_image', { prompt: 'x'.repeat(2501) }, f.context())), /2500/);
      equal(calls.length, 0); equal(f.generated.length, 0); equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  h.test('QwenWork media facade uses named generation and cancellation identities', async () => {
    const calls: Array<{ method: string; params: JsonObject }> = [];
    const client = { isClosed: () => false, requestWithTimeout: async (method: string, params: unknown) => { calls.push({ method, params: object(params) }); return {}; } };
    const facade = createQwenworkNativeMediaFacade(() => ({ generation: 1, client })), signal = new AbortController().signal;
    await facade.capabilities(signal); await facade.image({ prompt: 'Image' }, signal); await facade.video({ prompt: 'Video' }, signal); await facade.audio({ prompt: 'Music' }, signal);
    deepEqual(calls.map(row => row.method), ['qwenwork/capabilities', 'qwenwork/generateImage', 'qwenwork/generateVideo', 'qwenwork/generateMusic']);
    equal(new Set(calls.slice(1).map(row => row.params.operationId)).size, 3);
  });
}
