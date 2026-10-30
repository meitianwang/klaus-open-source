import { deepEqual, equal, match, rejects } from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { registerModelFeatureHandlers } from '../main/ipc/handlers/model-features';
import { ChannelRegistry } from '../main/ipc/registry';
import { providerCapabilities } from '../contracts/provider-capabilities';
import { configuredMediaModel, mediaPreferenceFields } from '../contracts/effective-media-models';
import { createAntigravityMediaFacade } from '../main/services/media-generation/native-facade';
import type { NativeMediaConnection } from '../main/services/media-generation/service';
import { mediaModelCatalog } from '../main/services/media-model-catalog';
import { object, type JsonObject } from '../main/services/service-types';
import type { Harness } from './harness';
import { generationVector, mediaFixture, png, resultText } from './media-generation-fixture';

const capabilities = {
  image: { available: true, models: ['image-one', 'image-two'], defaultModel: 'image-one' },
  imageEdit: { available: true, referenceImages: true, models: ['image-two'], defaultModel: 'image-two' },
};
const image = { imageBase64: png.toString('base64'), mimeType: 'image/png' };
function native(overrides: Partial<NativeMediaConnection> = {}): NativeMediaConnection {
  return { status: async () => ({ loggedIn: true }), capabilities: async () => capabilities,
    image: async () => image, video: async () => { throw new Error('Unexpected video route.'); }, audio: async () => { throw new Error('Unexpected audio route.'); }, ...overrides };
}

export function registerAntigravityNativeMediaTests(h: Harness): void {
  h.test('Antigravity image models share one preference for generation and editing without changing music or custom settings', async () => {
    const calls: JsonObject[] = [], f = await mediaFixture({ deps: { antigravity: native({ image: async params => { calls.push(params); return { images: [image, image] }; } }) } });
    try {
      f.config('custom', 'image', { model: 'custom-image' }); f.selectMusic('qwenwork');
      equal(object(f.features.setMedia('image', { source: 'antigravity', model: 'image-two' })).ok, true);
      equal(object(f.select('antigravity')).ok, true);
      const reference = join(f.root, 'reference.png'); await writeFile(reference, png);
      for (const input of [{ prompt: 'Draw' }, { prompt: 'Edit', source_images: [reference] }] as JsonObject[]) {
        const result = await f.service.execute('generate_image', input, f.context('codex'));
        equal(object(result).success, true, resultText(result));
        equal((object(result).contentItems as JsonObject[]).filter(row => row.type === 'inputImage').length, 2);
      }
      deepEqual(calls, [
        { prompt: 'Draw', model: 'image-two' },
        { prompt: 'Edit', model: 'image-two', referenceImages: [{ dataBase64: png.toString('base64'), mimeType: 'image/png' }] },
      ]);
      deepEqual(await Promise.all(f.generated.flatMap(row => row.paths).map(path => readFile(path))), [png, png, png, png]);
      equal(object(f.features.getMedia('image')).model, 'custom-image');
      equal(object(f.features.getMusicSelection()).selection, 'qwenwork');
      equal(f.requests.length, 0);
    } finally { await f.close(); }
  });
  h.test('Antigravity native image catalogs list the verified service-managed route and retain unavailable saved selections', async () => {
    const f = await mediaFixture();
    try {
      equal(configuredMediaModel('image', 'antigravity', {}), '');
      deepEqual(mediaPreferenceFields('image', 'antigravity'), ['model']);
      f.select('antigravity'); f.features.setMedia('image', { source: 'antigravity', model: 'saved-image' });
      const deps = { signedIn: async (source: string) => source === 'antigravity', capabilities: async () => providerCapabilities(capabilities) };
      const catalog = await mediaModelCatalog('image', f.features, deps);
      deepEqual(catalog.current, { source: 'antigravity', modelId: 'saved-image' });
      deepEqual(catalog.options.filter(row => row.source === 'antigravity'), [
        { source: 'antigravity', modelId: '', available: true, selectable: true, connected: true },
        { source: 'antigravity', modelId: 'saved-image', available: false, selectable: false, connected: true },
      ]);
      const disconnected = await mediaModelCatalog('image', f.features, { ...deps, signedIn: async () => false });
      equal(disconnected.availability.antigravity, false);
      deepEqual(disconnected.options.filter(row => row.source === 'antigravity'), [
        { source: 'antigravity', modelId: '', available: false, selectable: true, connected: false },
        { source: 'antigravity', modelId: 'saved-image', available: false, selectable: false, connected: false },
      ]);
      for (const kind of ['video', 'audio', 'music'] as const) {
        equal(mediaPreferenceFields(kind, 'antigravity'), null);
        equal(object(f.features.setMedia(kind, { source: 'antigravity', model: 'must-not-save' })).ok, false);
        deepEqual(f.features.getMedia(kind, { source: 'antigravity' }), {});
        equal((await mediaModelCatalog(kind, f.features, deps)).options.some(row => row.source === 'antigravity'), false);
      }
    } finally { await f.close(); }
  });
  h.test('Antigravity settings keep a disconnected verified source selectable and reject unknown models and media kinds', async () => {
    const f = await mediaFixture(), registry = new ChannelRegistry(); let connected = true;
    try {
      registerModelFeatureHandlers(registry, { features: f.features, onSettingsChanged: () => {}, sourceStatus: async source => ({ loggedIn: source === 'antigravity' && connected }), request: async method => {
        return method === 'antigravity/capabilities' ? capabilities : {};
      } });
      const call = async (channel: string, args: JsonObject) => object(await registry.lookup(channel)!({ channel, args: [args], role: 'main', senderId: 1 }));
      equal((await call('settings:image-selection:set', { selection: 'antigravity' })).ok, true);
      equal((await call('settings:image-gen:set', { source: 'antigravity', model: 'missing' })).ok, false);
      for (const kind of ['video', 'audio', 'music']) {
        equal((await call(`settings:${kind}-gen:set`, { source: 'antigravity', model: 'must-not-save' })).ok, false);
        match(String((await call(`settings:${kind}-gen:get`, { source: 'antigravity' })).error), /does not offer/);
      }
      connected = false;
      equal((await call('settings:image-gen:set', { source: 'antigravity', model: 'image-one' })).ok, false);
      equal((await call('settings:image-selection:set', { selection: 'antigravity' })).ok, true, 'a disconnected verified source stays selectable');
      equal(object(f.features.getImageSelection()).selection, 'antigravity');
    } finally { await f.close(); }
  });
  h.test('Antigravity image editing and expired access fail before file reads without substituting another model or source', async () => {
    for (const mode of ['edit', 'expired', 'unavailable'] as const) {
      let calls = 0;
      const f = await mediaFixture({ deps: { antigravity: native({ status: async () => ({ loggedIn: true, needsLogin: mode === 'expired' }), capabilities: async () => mode === 'unavailable' ? {} : capabilities, image: async () => { calls++; return image; } }) } });
      try {
        f.config('custom', 'image', { model: 'custom-image' }); f.select('antigravity');
        f.features.setMedia('image', { source: 'antigravity', model: 'image-one' });
        const result = await f.service.execute('generate_image', { prompt: 'Edit', source_images: ['/must-not-read'] }, f.context());
        equal(object(result).success, false);
        match(resultText(result), mode === 'edit' ? /Image editing is unavailable/ : mode === 'expired' ? /Reconnect the generation account/ : /currently unavailable/);
        equal(calls, 0); equal(f.requests.length, 0); equal(f.generated.length, 0);
        equal(object(f.features.getImageSelection()).selection, 'antigravity');
      } finally { await f.close(); }
    }
  });
  h.test('Antigravity image collections are bounded and every result MIME type is validated before publication', async () => {
    const vector = object((await generationVector()).antigravityImage);
    equal(vector.maximumResults, 8); deepEqual(vector.unsupportedOutputKinds, ['video', 'audio', 'music']);
    for (const reply of [{ images: [] }, { images: Array(9).fill(image) }, { images: [image, { ...image, mimeType: 'image/jpeg' }] }]) {
      const f = await mediaFixture({ deps: { antigravity: native({ image: async () => reply }) } });
      try {
        f.select('antigravity');
        equal(object(await f.service.execute('generate_image', { prompt: 'Draw' }, f.context())).success, false);
        equal(f.generated.length, 0); equal(f.requests.length, 0);
      } finally { await f.close(); }
    }
  });
  h.test('Antigravity media facade uses image named methods and never submits unsupported outputs', async () => {
    const calls: Array<{ method: string; params: Json }> = [];
    const client = { isClosed: () => false, requestWithTimeout: async (method: string, params: Json) => { calls.push({ method, params }); return image; } };
    const facade = createAntigravityMediaFacade(() => ({ generation: 1, client })), signal = new AbortController().signal;
    await facade.image({ prompt: 'Draw', model: 'image-one' }, signal);
    deepEqual(calls.map(row => row.method), ['antigravity/generateImage']);
    equal(typeof object(calls[0]!.params).operationId, 'string');
    await rejects(facade.video({ prompt: 'Move' }, signal), /Video generation is unavailable/);
    await rejects(facade.audio({ text: 'Hello' }, signal), /Speech and music generation are unavailable/);
    equal(calls.length, 1);
    const failedClient = { ...client, requestWithTimeout: async () => { throw new Error('antigravity_credentials_expired private-token'); } };
    const failed = createAntigravityMediaFacade(() => ({ generation: 1, client: failedClient }));
    await rejects(failed.image({ prompt: 'Draw' }, signal), { message: 'Reconnect the generation account in Settings before generating media.' });
  });
}
