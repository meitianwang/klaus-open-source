import { deepEqual, equal, match, ok, throws } from 'node:assert/strict';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ClientEvent } from '../main/engine/protocol';
import type { Json } from '../main/ipc/contract';
import { DynamicTools } from '../main/sessions/dynamic-tools';
import { GENERATION_TOOL_SPECS, LIMITS, SPEECH_EMOTIONS, SPEECH_SPEED_RANGE } from '../main/services/media-generation/contract';
import { base64Bytes } from '../main/services/media-generation/http';
import { minimaxDuration, minimaxRatio, minimaxResolution, speechDownloadUrl } from '../main/services/media-generation/providers';
import { registerMediaGenerationTools } from '../main/services/media-generation/service';
import { kvGet, kvSet } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { registerQwenworkNativeMediaTests } from './qwenwork-native-media';
import { registerWorkbuddyMediaTests } from './workbuddy-media-generation';
import { registerAntigravityNativeMediaTests } from './antigravity-native-media';
import { registerCursorMediaTests } from './cursor-media-generation';
import { registerMediaConversationBoundaryTests } from './media-conversation-boundary';
import { registerCodexImageGenerationTests } from './codex-image-generation';
import { registerMediaHttpTests } from './media-generation-http';
import { Harness, waitFor as waitForCondition } from './harness';
import { generationVector, mediaFixture, mp3, mp4, png, resultText, wav, webp } from './media-generation-fixture';

const h = new Harness();
registerCodexImageGenerationTests(h);
registerMediaHttpTests(h);
registerAntigravityNativeMediaTests(h);
registerCursorMediaTests(h);
registerWorkbuddyMediaTests(h);
registerQwenworkNativeMediaTests(h);
registerMediaConversationBoundaryTests(h);
const waitFor = (predicate: () => boolean): Promise<void> => waitForCondition(predicate, 5000, 'media fixture progress');
const json = (value: Json): Response => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const output = (result: Json): JsonObject => { equal(object(result).success, true, resultText(result)); return object(result); };
const failure = (result: Json): string => { equal(object(result).success, false); return resultText(result); };
async function absent(path: string): Promise<void> { deepEqual(await readdir(path).catch(() => []), []); }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

h.test('media decoding accepts large canonical payloads with every padding length', async () => {
  const vector = object((await generationVector()).base64Decoding);
  for (const offset of [0, 1, 2]) {
    const bytes = Buffer.alloc(Number(vector.largePayloadBytes) + offset, 0xa5);
    deepEqual(base64Bytes(bytes.toString('base64'), bytes.length), bytes);
  }
  for (const raw of vector.accepted as JsonObject[]) {
    const row = object(raw);
    deepEqual(base64Bytes(String(row.encoded), 3), Buffer.from(String(row.decodedHex), 'hex'));
  }
});
h.test('media decoding rejects malformed, noncanonical and oversized payloads', async () => {
  const vector = object((await generationVector()).base64Decoding);
  for (const raw of [...vector.rejected as Json[], undefined, null, 1, {}, []]) {
    throws(() => base64Bytes(raw, LIMITS.videoBytes), /invalid or oversized base64/);
  }
  for (const [raw, maximum] of [['AA==', 0], ['AAA=', 1], ['AAAA', 2]] as const) {
    throws(() => base64Bytes(raw, maximum), /invalid or oversized base64/);
  }
});

h.test('committed vectors pin fixed tool declarations and bounded generation contracts', async () => {
  const vector = await generationVector(); deepEqual(GENERATION_TOOL_SPECS.map(spec => spec.name), vector.declarations);
  for (const [key, value] of Object.entries(object(vector.limits))) equal((LIMITS as Record<string, number>)[key], value, key);
  const selection = object(vector.selection);
  equal(selection.globalForImage, true); equal(selection.globalForVideo, true); equal(selection.globalForAudio, true);
  deepEqual(selection.imageChoices, ['none', 'codex', 'cursor', 'qoder', 'qwenwork', 'qoderwork', 'workbuddy', 'antigravity', 'trae', 'bailian', 'minimax']);
  deepEqual(selection.videoChoices, ['none', 'minimax', 'workbuddy', 'qwenwork', 'trae']);
  deepEqual(selection.audioChoices, ['none', 'cursor', 'minimax', 'bailian', 'workbuddy']);
  deepEqual(selection.musicChoices, ['none', 'qwenwork']);
  equal(selection.imageSourcesVisibleWithoutCredential, true);
  equal(selection.imageEnumerationProbesCapabilities, false);
  equal(selection.imageDisconnectedSelectionShowsToast, true);
  equal(selection.imageCustomSelectionRetired, true);
  equal(selection.musicSourcesVisibleWithoutCredential, true);
  equal(selection.musicEnumerationProbesCapabilities, false);
  equal(selection.musicDisconnectedSelectionShowsToast, true);
  equal(selection.musicIndependentFromSpeech, true);
  equal(selection.audioSubscriptionSourcesSelectableWithoutCredential, true);
  equal(selection.audioDisconnectedSelectionShowsToast, true);
  equal(selection.availabilityRequiresCredential, true);
  equal(selection.explicitSelectionWins, true); equal(selection.unselectedEndpointIsInert, true);
  equal(selection.videoSubscriptionModelOverridePreserved, true);
  equal(selection.audioSubscriptionModelAndVoicePreserved, true);
  equal(selection.unavailableSelectionFallsBack, false);
  equal(object(selection.migration).firstSavedConfigWins, true);
  equal(object(selection.migration).retiredLocalRowsMigrate, true);
});
h.test('unconfigured or unknown sources give an actionable notice without reading files or calling providers', async () => {
  const f = await mediaFixture();
  try {
    match(failure(await f.service.execute('generate_image', { prompt: 'hello', source_images: ['/not/read'] }, f.context())), /Image generation is disabled/);
    match(failure(await f.service.execute('generate_video', { prompt: 'hello' }, f.context('invented'))), /valid model source/);
    equal(f.requests.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('stored local generation choices remain visible and never fall back to another provider', async () => {
  for (const raw of (await generationVector()).retiredLocalConfigs as JsonObject[]) {
    const row = object(raw), kind = row.kind as 'image' | 'video', source = String(row.source);
    let providerCalls = 0;
    const f = await mediaFixture({ deps: {
      subscriptions: { codexAccessToken: async () => { providerCalls++; return { accessToken: 'fixture-token', accountId: 'fixture-account' }; } },
      qoder: {
        status: async () => { providerCalls++; return { loggedIn: true }; },
        generate: async () => { providerCalls++; return { imageBase64: png.toString('base64') }; },
      },
      fetch: async () => { providerCalls++; throw new Error('Retired configuration must not submit a request.'); },
    } });
    try {
      const key = `${kind}_generation.model_config:${source}`, stored = JSON.stringify(row.stored);
      equal(kvSet(key, stored, f.root), true);
      deepEqual(f.features.getMedia(kind, { source }), row.projection);
      const tool = kind === 'image' ? 'generate_image' : 'generate_video';
      const input: Json = kind === 'image' ? { prompt: 'Blue', source_images: ['/never-read.png'] } : { prompt: 'Blue' };
      match(failure(await f.service.execute(tool, input, f.context(source))), /generation is disabled/);
      equal(providerCalls, 0); equal(f.requests.length, 0); equal(f.generated.length, 0);
      equal(kvGet(key, f.root), stored); await absent(join(f.root, 'sessions'));
      f.features.setMedia(kind, { source }); deepEqual(f.features.getMedia(kind, { source }), {});
    } finally { await f.close(); }
  }
});
h.test('generated image URL downloads keep signed query strings but receive no provider credentials', async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return String(url).includes('/asset.png') ? new Response(new Uint8Array(png)) : json({ data: [{ url: 'https://cdn.invalid/asset.png?signature=fixture' }] });
    },
  } });
  try {
    f.select('codex');
    output(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context()));
    equal(calls.length, 2); equal(calls[0]!.headers.get('Authorization'), 'Bearer fixture-token');
    equal(calls[1]!.url, 'https://cdn.invalid/asset.png?signature=fixture'); equal(calls[1]!.headers.get('Authorization'), null);
    equal(f.generated.length, 1);
  } finally { await f.close(); }
});
h.test('Bailian and MiniMax image routes spend the plan credential and download the returned URLs', async () => {
  for (const row of [
    { selection: 'bailian', path: '/api/v1/services/aigc/multimodal-generation/generation', model: 'qwen-image-3.0-pro', parameters: { size: '1024*1024' } as JsonObject | undefined },
    { selection: 'minimax', path: '/v1/image_generation', model: 'image-01', parameters: undefined as JsonObject | undefined },
  ]) {
    let origin = '';
    const f = await mediaFixture({
      respond: (request, response) => {
        if (request.path === '/img.png') { response.end(png); return; }
        response.end(JSON.stringify(row.selection === 'bailian'
          ? { output: { choices: [{ message: { content: [{ type: 'image', image: origin + '/img.png' }] } }] } }
          : { data: { image_urls: [origin + '/img.png'] } }));
      },
      deps: {
        bailian: { credential: async () => ({ apiKey: 'fixture-plan-key', baseUrl: origin, region: 'cn' }) },
        minimax: { credential: async () => ({ apiKey: 'fixture-plan-key', baseUrl: origin, region: 'cn' }) },
      },
    });
    try {
      origin = f.origin;
      equal(object(f.select(row.selection)).ok, true);
      const result = output(await f.service.execute('generate_image', { prompt: 'Blue', size: '1024x1024' }, f.context()));
      equal(f.requests.length, 2); equal(f.requests[0]!.path, row.path);
      match(String(f.requests[0]!.headers.authorization), /^Bearer fixture-plan-key$/);
      equal(object(f.requests[0]!.body).model, row.model);
      deepEqual(object(f.requests[0]!.body).parameters, row.parameters);
      equal(f.requests[1]!.headers.authorization, undefined);
      deepEqual(await readFile(f.generated[0]!.paths[0]!), png);
      match(resultText(result), /^Saved: /);
      match(failure(await f.service.execute('generate_image', { prompt: 'Blue', source_images: ['/never-read'] }, f.context())), /text-to-image only/);
      equal(f.requests.length, 2);
    } finally { await f.close(); }
  }
});
h.test('Codex selection uses subscription credentials and a saved custom endpoint never redirects it', async () => {
  const calls: Array<{ url: string; headers: Headers }> = []; let credentials = 0;
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => { credentials++; return { accessToken: 'private-fixture-token', accountId: 'fixture-account' }; } },
    fetch: async (url, init) => { calls.push({ url: String(url), headers: new Headers(init?.headers) }); return json({ data: [{ b64_json: png.toString('base64') }] }); },
  } });
  try {
    f.select('codex');
    const result = await f.service.execute('generate_image', { prompt: 'Blue' }, f.context('subscription')); output(result);
    equal(calls[0]!.url, 'https://chatgpt.com/backend-api/codex/images/generations'); equal(calls[0]!.headers.get('Authorization'), 'Bearer private-fixture-token'); equal(calls[0]!.headers.get('originator'), 'codex_cli_rs'); equal(calls[0]!.headers.get('ChatGPT-Account-Id'), 'fixture-account');
    equal(calls[0]!.headers.get('version'), '0.159.2');
    equal(JSON.stringify(result).includes('private-fixture-token'), false);
    f.config('custom', 'image', { model: 'saved-custom-image' });
    const saved = f.features.getMedia('image');
    output(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context('subscription')));
    equal(credentials, 2); equal(calls[1]!.url, calls[0]!.url);
    equal(calls[1]!.headers.get('Authorization'), 'Bearer private-fixture-token');
    output(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context('custom')));
    equal(credentials, 3); equal(calls[2]!.url, calls[0]!.url);
    deepEqual(f.features.getMedia('image'), saved); equal(f.generated.length, 3); equal(f.requests.length, 0);
  } finally { await f.close(); }
});
h.test('subscription selections ignore custom endpoints and reject unsupported references before reading', async () => {
  const qoderCalls: JsonObject[] = [], qwenworkCalls: JsonObject[] = [], qoderworkCalls: JsonObject[] = [];
  const f = await mediaFixture({ deps: {
    qoder: { status: async () => ({ loggedIn: true }), generate: async params => { qoderCalls.push(params); return { imageBase64: png.toString('base64') }; } },
    qwenwork: { status: async () => ({ loggedIn: true }), capabilities: async () => ({ image: { available: true, models: ['image-one'], defaultModel: 'image-one' } }), image: async params => { qwenworkCalls.push(params); return { imageBase64: png.toString('base64'), mimeType: 'image/png' }; }, video: async () => ({}), audio: async () => ({}) },
    qoderwork: { status: async () => ({ loggedIn: true }), generate: async params => { qoderworkCalls.push(params); return { imageBase64: png.toString('base64') }; } },
  } });
  try {
    f.config('custom', 'image', { model: 'unselected-image' });
    const saved = f.features.getMedia('image');
    f.select('qoder');
    output(await f.service.execute('generate_image', { prompt: 'Blue', size: '1024x1024' }, f.context('custom', 'qoder-thread')));
    deepEqual(qoderCalls, [{ prompt: 'Blue', sessionId: 'qoder-thread', size: '1024x1024' }]);
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue', source_images: ['/never-read'] }, f.context('custom'))), /text-to-image only/); equal(qoderCalls.length, 1);
    f.select('qwenwork');
    output(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context('custom', 'qwenwork-thread')));
    deepEqual(qwenworkCalls, [{ prompt: 'Blue', model: 'image-one' }]);
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue', source_images: ['/never-read'] }, f.context('custom'))), /currently unavailable/); equal(qwenworkCalls.length, 1);
    f.select('qoderwork');
    output(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context('custom', 'qoderwork-thread')));
    deepEqual(qoderworkCalls, [{ prompt: 'Blue', sessionId: 'qoderwork-thread' }]);
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue', source_images: ['/never-read'] }, f.context('custom'))), /text-to-image only/); equal(qoderworkCalls.length, 1);
    equal(f.requests.length, 0); deepEqual(f.features.getMedia('image'), saved);
  } finally { await f.close(); }
});
h.test('a signed-out image subscription never falls back to a configured custom endpoint', async () => {
  const f = await mediaFixture();
  try {
    f.config('custom', 'image', { model: 'available-custom-image' });
    const saved = f.features.getMedia('image');
    for (const selection of ['codex', 'qoder', 'qwenwork', 'qoderwork']) {
      f.select(selection);
      match(failure(await f.service.execute('generate_image', { prompt: 'Blue', source_images: ['/not/read'] }, f.context())), selection === 'qwenwork' ? /Reconnect the generation account/ : /not configured/);
    }
    equal(f.requests.length, 0); equal(f.generated.length, 0);
    deepEqual(f.features.getMedia('image'), saved); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('a selected image subscription failure does not retry on a saved custom endpoint', async () => {
  const calls: string[] = [];
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-subscription-token', accountId: 'fixture-account' }) },
    fetch: async url => { calls.push(String(url)); return new Response('', { status: 522 }); },
  } });
  try {
    f.config('custom', 'image', { model: 'available-custom-image' }); f.select('codex');
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context('subscription'))), /HTTP 522/);
    deepEqual(calls, ['https://chatgpt.com/backend-api/codex/images/generations']);
    equal(f.requests.length, 0); equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('image credential, status and generation failures never invoke an unselected custom endpoint', async () => {
  for (const selection of ['codex', 'qoder', 'qwenwork', 'qoderwork'] as const) {
    for (const phase of selection === 'codex' ? ['credential'] : ['status', 'generate', 'result']) {
      const backend = {
        status: async () => { if (phase === 'status') throw new Error('Fixture status failed.'); return { loggedIn: true }; },
        generate: async () => { if (phase === 'result') return {}; throw new Error('Fixture generation failed.'); },
      };
      const f = await mediaFixture({ deps: selection === 'codex'
        ? { subscriptions: { codexAccessToken: async () => { throw new Error('Fixture credential failed.'); } } }
        : { [selection]: backend } });
      try {
        f.config('custom', 'image', { model: 'available-custom-image' }); f.select(selection);
        const saved = f.features.getMedia('image');
        ok(failure(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context('subscription'))).length > 0);
        equal(f.requests.length, 0); equal(f.generated.length, 0);
        deepEqual(f.features.getMedia('image'), saved); await absent(join(f.root, 'sessions'));
      } finally { await f.close(); }
    }
  }
});
h.test('an unselected retired local image configuration does not block the selected subscription', async () => {
  const calls: string[] = [];
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    fetch: async url => { calls.push(String(url)); return json({ data: [{ b64_json: png.toString('base64') }] }); },
  } });
  try {
    const stored = JSON.stringify({ provider: 'local', localModel: 'retired-image' });
    equal(kvSet('image_generation.model_config', stored, f.root), true); f.select('codex');
    output(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context()));
    deepEqual(calls, ['https://chatgpt.com/backend-api/codex/images/generations']);
    equal(kvGet('image_generation.model_config', f.root), stored);
    equal(object(f.features.getImageSelection()).selection, 'codex', 'the retired custom choice cannot reclaim the selection');
    equal(calls.length, 1);
  } finally { await f.close(); }
});
h.test('invalid arguments, invalid media bytes and provider errors never create artifacts or disclose credentials', async () => {
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-secret', accountId: 'fixture-account' }) },
    fetch: async () => new Response(JSON.stringify({ error: { message: 'fixture-secret should not cross the boundary' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
  } });
  try {
    f.select('codex');
    for (const input of [{ prompt: '' }, { prompt: 'Blue', source_images: ['relative'] }, { prompt: 'Blue', extra: true }] as Json[]) failure(await f.service.execute('generate_image', input, f.context()));
    equal(f.requests.length, 0); const text = failure(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context())); match(text, /HTTP 400/); equal(text.includes('fixture-secret'), false);
    f.deps.fetch = async () => json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context())), /not a PNG/); equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('aborting a pending provider fetch closes the request and leaves no late files', async () => {
  let started = 0;
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    fetch: async (_url, init) => { started++; return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true }); } }), { headers: { 'Content-Type': 'application/json' } }); },
  } }), controller = new AbortController();
  try {
    f.select('codex'); const pending = f.service.execute('generate_image', { prompt: 'Blue' }, f.context('custom', 'cancelled', controller.signal));
    await waitFor(() => started === 1); controller.abort(); match(failure(await pending), /cancelled or timed out/); equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('shutdown waits for a cancellation-ignoring dependency and suppresses its eventual image result', async () => {
  const response = deferred<Response>(); let started = false;
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    fetch: async () => { started = true; return response.promise; },
  } });
  try {
    f.select('codex'); const pending = f.service.execute('generate_image', { prompt: 'Blue' }, f.context()); await waitFor(() => started);
    let closed = false; const closing = f.service.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); equal(closed, false);
    response.resolve(json({ data: [{ b64_json: png.toString('base64') }] })); await closing; match(failure(await pending), /cancelled/); equal(closed, true); equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { response.resolve(json({})); await f.close(); }
});
h.test('a video call follows the global selection even when the conversation language source moves under it', async () => {
  const vector = object((await generationVector()).minimaxVideo);
  let held: ServerResponse | null = null, baseUrl = '';
  const taskReply = (): JsonObject => { const row = JSON.parse(JSON.stringify(vector.taskResponse)) as JsonObject; object(object(row.task).content).url = baseUrl + '/download'; return row; };
  const f = await mediaFixture({
    respond: (request, response) => {
      // Hold the submit response until the language source has moved, so the
      // switch lands inside the in-flight window.
      if (request.method === 'POST') { held = response; return; }
      if (request.path === '/download') { response.end(mp4); return; }
      response.end(JSON.stringify(taskReply()));
    },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    f.selectVideo('minimax');
    // The conversation's language source is provenance only. It flips to a
    // different value while the call is in flight — the situation that used to
    // cancel a video — and the generation still finishes on the route the global
    // selection named. `assertCurrent` stays quiet because the SESSION is alive;
    // losing the session is the only thing that cancels.
    const context = { ...f.context(), source: 'custom' };
    Object.defineProperty(context, 'source', { get: () => (held === null ? 'custom' : 'minimax') });
    const pending = f.service.execute('generate_video', { prompt: 'Waves' }, context);
    await waitFor(() => held !== null);
    held!.setHeader('Content-Type', 'application/json');
    held!.end(JSON.stringify(vector.submitResponse));
    output(await pending);
    equal(f.generated.length, 1, 'the video publishes despite the language source moving mid-call');
    deepEqual(f.requests.map(row => row.path), ['/v2/video_generation', '/v2/query/video_generation/task-1', '/download'],
      'the route stayed the subscription route the selection named');
  } finally { await f.close(); }
});
h.test('session release cancels only that conversation while another generation finishes', async () => {
  let started = 0;
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    fetch: async (_url, init) => {
      started++;
      if (JSON.parse(String(init?.body ?? '{}')).prompt === 'hold') return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init?.signal?.reason), { once: true }); } }), { headers: { 'Content-Type': 'application/json' } });
      return json({ data: [{ b64_json: png.toString('base64') }] });
    },
  } });
  try {
    f.select('codex'); const pending = f.service.execute('generate_image', { prompt: 'hold' }, f.context('custom', 'closing')); await waitFor(() => started === 1);
    const next = f.service.execute('generate_image', { prompt: 'finish' }, f.context('custom', 'continuing')); await f.service.releaseSession('closing'); failure(await pending); output(await next);
    deepEqual(f.generated.map(row => row.sessionId), ['continuing']); await absent(join(f.root, 'sessions', 'closing'));
  } finally { await f.close(); }
});
h.test('media deadline interrupts an unfinished stream, and the per-tool deadline remains opt-in for existing registrations', async () => {
  const f = await mediaFixture({ deps: {
    deadlines: { image: 20 },
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    fetch: async (_url, init) => new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true }); } }), { headers: { 'Content-Type': 'application/json' } }),
  } });
  const replies: JsonObject[] = [], dynamic = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: () => true, log: () => {} });
  try {
    f.select('codex'); match(failure(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context())), /timed out/); await absent(join(f.root, 'sessions'));
    dynamic.register({ name: 'short', type: 'function' }, async (_args, _id, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { success: true }; }, { timeoutMs: 10 });
    dynamic.register({ name: 'ordinary', type: 'function' }, async () => { await new Promise(resolve => setTimeout(resolve, 25)); return { success: true }; });
    for (const tool of ['short', 'ordinary']) dynamic.receive({ type: 'rawSessionEvent', params: { sessionId: 'writer', event: { dynamicToolCall: { callId: tool, tool, arguments: {} } } } } as ClientEvent);
    await waitFor(() => replies.length === 2); equal(object(replies.find(row => row.callId === 'short')!.response).success, false); equal(object(replies.find(row => row.callId === 'ordinary')!.response).success, true);
  } finally { await dynamic.close(); await f.close(); }
});
h.test('source and generated response size bounds fail before any artifact is published', async () => {
  const f = await mediaFixture({ deps: { subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) } } });
  try {
    f.select('codex'); const path = join(f.root, 'too-large.png'), file = await open(path, 'wx'); try { await file.truncate(LIMITS.sourceBytes + 1); } finally { await file.close(); }
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue', source_images: [path] }, f.context())), /20 MiB/); equal(f.requests.length, 0);
    f.deps.fetch = async () => new Response('{}', { headers: { 'Content-Length': String(17 * 1024 ** 2) } });
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context())), /too large/);
    f.deps.fetch = async () => json({ data: [{ b64_json: '!!!!' }] });
    match(failure(await f.service.execute('generate_image', { prompt: 'Blue' }, f.context())), /invalid or oversized base64/); equal(f.generated.length, 0);
  } finally { await f.close(); }
});
h.test('Qoder cancellation drains the named request and never treats its eventual remote result as a saved image', async () => {
  const result = deferred<Json>(); let started = false;
  const f = await mediaFixture({ deps: { qoder: { status: async () => ({ loggedIn: true }), generate: async () => { started = true; return result.promise; } } } });
  try {
    f.select('qoder');
    const pending = f.service.execute('generate_image', { prompt: 'Blue' }, f.context('custom')); await waitFor(() => started);
    let released = false; const release = f.service.releaseSession('session').then(() => { released = true; }); await new Promise(resolve => setImmediate(resolve)); equal(released, false);
    result.resolve({ imageBase64: png.toString('base64') }); await release; match(failure(await pending), /remote job may still finish/); equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { result.resolve({}); await f.close(); }
});
h.test('workspace deletion reservations prevent a pending generation from recreating the removed directory', async () => {
  const response = deferred<Response>(); let started = false;
  const f = await mediaFixture({ deps: {
    subscriptions: { codexAccessToken: async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }) },
    fetch: async () => { started = true; return response.promise; },
  } });
  try {
    f.select('codex'); const pending = f.service.execute('generate_image', { prompt: 'Blue' }, f.context()); await waitFor(() => started);
    const release = await f.workspaces.quiesceDirectory(f.workspaces.resolveSessionDirectory('session'));
    try { response.resolve(json({ data: [{ b64_json: png.toString('base64') }] })); failure(await pending); equal(f.generated.length, 0); await absent(join(f.root, 'sessions')); }
    finally { release(); }
  } finally { response.resolve(json({})); await f.close(); }
});
h.test('a terminal turn aborts only its owned host call and cannot cancel a queued continuation', async () => {
  const replies: JsonObject[] = [], stopped: string[] = [], complete = deferred<Json>(), started: string[] = [];
  const dynamic = new DynamicTools({ request: async (_method, params) => { replies.push(params); }, knownSession: () => true, log: message => { throw new Error(message); } });
  try {
    dynamic.register({ name: 'owned' }, async (args, _id, signal) => {
      const turn = String(object(args).turn); started.push(turn);
      signal.addEventListener('abort', () => stopped.push(turn), { once: true });
      if (turn === 'new') return complete.promise;
      return new Promise<Json>(resolve => signal.addEventListener('abort', () => resolve({ success: false }), { once: true }));
    });
    for (const turn of ['old', 'new']) dynamic.receive({ type: 'rawSessionEvent', params: { sessionId: 'same', event: { submissionId: turn, dynamicToolCall: { callId: turn, turnId: turn, tool: 'owned', arguments: { turn } } } } } as ClientEvent);
    await waitFor(() => started.length === 2);
    dynamic.receive({ type: 'turnCompleted', params: { sessionId: 'same', turnId: 'old', result: { stopReason: 'interrupted' } } });
    await waitFor(() => stopped.length > 0); deepEqual(stopped, ['old']); equal(replies.length, 0);
    dynamic.receive({ type: 'productEvent', method: 'turn/failed', params: { sessionId: 'different', turnId: 'new' } });
    complete.resolve({ success: true }); await waitFor(() => replies.length === 1); equal(replies[0]!.callId, 'new'); equal(object(replies[0]!.response).success, true);
    await dynamic.close(); deepEqual(stopped, ['old']);
  } finally { complete.resolve({ success: false }); await dynamic.close(); }
});

h.test('Bailian and MiniMax image routes spend the plan credential and download the returned URLs', async () => {
  for (const row of [
    { selection: 'bailian', path: '/api/v1/services/aigc/multimodal-generation/generation', model: 'qwen-image-3.0-pro', parameters: { size: '1024*1024' } },
    { selection: 'minimax', path: '/v1/image_generation', model: 'image-01', parameters: undefined },
  ] as const) {
    let origin = '';
    const f = await mediaFixture({
      respond: (request, response) => {
        if (request.path === '/img.png') { response.end(png); return; }
        response.end(JSON.stringify(row.selection === 'bailian'
          ? { output: { choices: [{ message: { content: [{ type: 'image', image: origin + '/img.png' }] } }] } }
          : { data: { image_urls: [origin + '/img.png'] } }));
      },
      deps: {
        bailian: { credential: async () => ({ apiKey: 'fixture-plan-key', baseUrl: origin, region: 'cn' }) },
        minimax: { credential: async () => ({ apiKey: 'fixture-plan-key', baseUrl: origin, region: 'cn' }) },
      },
    });
    try {
      origin = f.origin;
      equal(object(f.select(row.selection)).ok, true);
      const result = output(await f.service.execute('generate_image', { prompt: 'Blue', size: '1024x1024' }, f.context()));
      equal(f.requests.length, 2); equal(f.requests[0]!.path, row.path);
      match(String(f.requests[0]!.headers.authorization), /^Bearer fixture-plan-key$/);
      equal(object(f.requests[0]!.body).model, row.model);
      deepEqual(object(f.requests[0]!.body).parameters, row.parameters);
      equal(f.requests[1]!.headers.authorization, undefined);
      deepEqual(await readFile(f.generated[0]!.paths[0]!), png);
      match(resultText(result), /^Saved: /);
      match(failure(await f.service.execute('generate_image', { prompt: 'Blue', source_images: ['/never-read'] }, f.context())), /text-to-image only/);
      equal(f.requests.length, 2);
    } finally { await f.close(); }
  }
});
h.test('MiniMax videos ignore an unselected retired local configuration and complete their task protocol', async () => {
  const vector = object((await generationVector()).minimaxVideo);
  // The vector names the download URL as a placeholder because the fixture's port is
  // only known once the server is listening; the shape is what the vector pins.
  let baseUrl = '';
  const taskReply = (): JsonObject => { const row = JSON.parse(JSON.stringify(vector.taskResponse)) as JsonObject; object(object(row.task).content).url = baseUrl + '/download'; return row; };
  const f = await mediaFixture({
    respond: (request, response) => {
      if (request.path === '/download') { response.end(mp4); return; }
      if (request.path === '/v2/video_generation') { response.end(JSON.stringify(vector.submitResponse)); return; }
      response.end(JSON.stringify(taskReply()));
    },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    const stored = JSON.stringify({ provider: 'local', localModel: 'retired-video' });
    equal(kvSet('video_generation.model_config', stored, f.root), true);
    f.selectVideo('minimax');
    const result = await f.service.execute('generate_video', vector.input!, f.context('custom')); output(result);
    deepEqual(f.requests.map(row => row.path), [...(vector.paths as string[]), '/download']);
    deepEqual(f.requests[0]!.body, vector.body);
    // The plan's own task route, not the OpenAI shape: an integer duration, a
    // resolution keyword and a required ratio instead of a string `seconds`.
    equal(typeof f.requests[0]!.body.duration, 'number');
    equal(Array.isArray(f.requests[0]!.body.content), true);
    // The subscription key rides as a bearer token and the download needs no header.
    match(String(f.requests[0]!.headers.authorization), /^Bearer fixture-subscription-key$/);
    equal(f.requests[2]!.headers.authorization, undefined);
    deepEqual(await readFile(f.generated[0]!.paths[0]!), mp4);
    match(f.generated[0]!.paths[0]!, /\.mp4$/);
    match(resultText(result), /^Video saved to /);
    equal(resultText(result).includes('MiniMax-H3'), false);
    equal((object(result).contentItems as JsonObject[]).length, 1, 'video bytes never enter the model response');
    equal(kvGet('video_generation.model_config', f.root), stored);
    kvSet('video_generation.selection', 'custom', f.root);
    match(failure(await f.service.execute('generate_video', vector.input!, f.context())), /disabled/);
    equal(f.requests.length, 3);
  } finally { await f.close(); }
});
h.test('MiniMax size and duration mapping only ever emits values the task route accepts', async () => {
  const mapping = object(object((await generationVector()).minimaxVideo).mapping);
  for (const raw of mapping.cases as JsonObject[]) {
    const size = typeof raw.size === 'string' ? raw.size : undefined;
    equal(minimaxRatio(size), raw.ratio, `ratio for ${size || '(absent)'}`);
    equal(minimaxResolution(size, false), raw.resolution, `resolution for ${size || '(absent)'}`);
  }
  // The fast model tops out at 768P and refuses a 4-second task, so the same size
  // must map differently rather than produce a task the service rejects after it has
  // already been accepted and started spending allowance.
  for (const raw of mapping.fastModel as JsonObject[]) {
    const fastSize = typeof raw.size === 'string' ? raw.size : undefined;
    if (fastSize !== undefined) {
      equal(minimaxRatio(fastSize), raw.ratio, `fast ratio for ${fastSize}`);
      equal(minimaxResolution(fastSize, true), raw.resolution, `fast resolution for ${fastSize}`);
    }
    const fastSeconds = typeof raw.seconds === 'number' ? raw.seconds : undefined;
    if (fastSeconds !== undefined) equal(minimaxDuration(fastSeconds, true), raw.duration, `fast duration for ${fastSeconds}`);
  }
  for (const raw of mapping.duration as JsonObject[]) {
    const seconds = typeof raw.seconds === 'number' ? raw.seconds : undefined;
    equal(minimaxDuration(seconds, false), raw.duration, `duration for ${seconds ?? '(absent)'}`);
  }
  // `adaptive` is a legal ratio for the API but not for a text-only submission, which
  // is the only shape generate_video sends, so it must never be produced.
  ok(!(mapping.cases as JsonObject[]).some(row => row.ratio === 'adaptive'));
  // Every emitted value is one the service listed in its own validation error.
  const ratios = object((await generationVector()).minimaxVideo).ratios as string[];
  for (const row of mapping.cases as JsonObject[]) ok(ratios.includes(String(row.ratio)), `${row.ratio} is accepted`);
});
h.test('MiniMax video without a stored subscription key answers with an actionable notice and makes no request', async () => {
  const f = await mediaFixture({ deps: { minimax: { credential: async () => undefined } } });
  try {
    f.config('custom', 'video', { model: 'available-custom-video' }); f.selectVideo('minimax');
    const text = failure(await f.service.execute('generate_video', { prompt: 'Waves' }, f.context('custom')));
    match(text, /subscription credential/);
    match(text, /Settings/, 'the notice directs configuration changes to settings');
    equal(f.requests.length, 0, 'no request is made without a credential');
    equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('MiniMax video reports an exhausted allowance or a refused key without echoing upstream prose or the credential', async () => {
  let exhaustedBase = '';
  const exhausted = await mediaFixture({
    respond: (_request, response) => { response.writeHead(402); response.end(JSON.stringify({ error: { type: 'insufficient_balance_error', http_code: '402', message: 'fixture-subscription-key insufficient balance' } })); },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl: exhaustedBase, region: 'cn' }) } },
  });
  try {
    exhausted.config('custom', 'video', {});
    exhausted.selectVideo('minimax');
    exhaustedBase = exhausted.origin;
    const text = failure(await exhausted.service.execute('generate_video', { prompt: 'Waves' }, exhausted.context('custom')));
    match(text, /no remaining video allowance/);
    match(text, /reset|Settings/, 'the notice explains where to resolve the allowance');
    equal(text.includes('fixture-subscription-key'), false, 'the credential never crosses the model boundary');
    equal(exhausted.generated.length, 0);
    deepEqual(exhausted.requests.map(row => row.path), ['/v2/video_generation']);
  } finally { await exhausted.close(); }

  let refusedBase = '';
  const refused = await mediaFixture({
    respond: (_request, response) => { response.writeHead(401); response.end(JSON.stringify({ error: { type: 'authorized_error', http_code: '401' } })); },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl: refusedBase, region: 'cn' }) } },
  });
  try {
    refused.config('custom', 'video', {});
    refused.selectVideo('minimax');
    refusedBase = refused.origin;
    match(failure(await refused.service.execute('generate_video', { prompt: 'Waves' }, refused.context('custom'))), /account and plan in Settings/);
    deepEqual(refused.requests.map(row => row.path), ['/v2/video_generation']);
  } finally { await refused.close(); }
});
h.test('a failed or expired MiniMax task stops instead of polling to the ceiling', async () => {
  let polls = 0;
  const f = await mediaFixture({
    respond: (request, response) => {
      if (request.path === '/v2/video_generation') { response.end(JSON.stringify({ task_id: 'task-1' })); return; }
      polls++;
      response.end(JSON.stringify({ task: { id: 'task-1', status: polls < 2 ? 'queued' : 'expired', error: { message: 'fixture-secret' } } }));
    },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl: f.origin, region: 'cn' }) } },
  });
  try {
    f.selectVideo('minimax');
    const text = failure(await f.service.execute('generate_video', { prompt: 'Waves' }, f.context('custom')));
    equal(polls, 2, 'a terminal state ends polling at once');
    equal(f.generated.length, 0);
    equal(text.includes('fixture-secret'), false, 'upstream error text does not cross the model boundary');
    await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('MiniMax video tolerates temporary transport loss and then stops at the bounded poll ceiling', async () => {
  let polls = 0;
  const f = await mediaFixture({ deps: {
    minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl: f.origin, region: 'cn' }) },
    fetch: async (url, init) => {
      if (init?.method === 'POST') return json({ task_id: 'never' });
      if (String(url) === f.origin + '/download') return new Response(new Uint8Array(mp4));
      polls++; if (polls <= 2) throw new TypeError('Fixture connection refused.');
      return json({ task: { id: 'never', status: 'running' } });
    },
  } });
  try {
    f.selectVideo('minimax');
    match(failure(await f.service.execute('generate_video', { prompt: 'Waves' }, f.context('custom'))), /may still complete/,
      'an accepted task that never settles says so rather than claiming it failed');
    equal(polls, 9, 'two lost polls are retried inside the same bounded ceiling');
    equal(f.generated.length, 0);
  } finally { await f.close(); }
});
h.test('the MiniMax selection honours the stored model knob while the credential stays the engine\'s', async () => {
  const vector = object((await generationVector()).minimaxVideo);
  let baseUrl = '';
  const taskReply = (): JsonObject => { const row = JSON.parse(JSON.stringify(vector.taskResponse)) as JsonObject; object(object(row.task).content).url = baseUrl + '/download'; return row; };
  const f = await mediaFixture({
    respond: (request, response) => {
      if (request.path === '/download') { response.end(mp4); return; }
      if (request.path === '/v2/video_generation') { response.end(JSON.stringify(vector.submitResponse)); return; }
      response.end(JSON.stringify(taskReply()));
    },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    f.selectVideo('minimax');
    // Subscription model preferences cannot redirect its credential through a custom endpoint.
    equal(object(f.features.setMedia('video', { source: 'minimax', model: 'MiniMax-H3-Max' })).ok, true);
    f.config('custom', 'video', { model: 'custom-video', baseUrl: 'https://stale.invalid', apiKey: 'stale-key' });
    output(await f.service.execute('generate_video', { ...object(vector.input), seconds: 5 }, f.context('custom')));
    equal(f.requests[0]!.body.model, 'MiniMax-H3-Max', 'the model knob is honoured');
    equal(String(f.requests[0]!.headers.authorization), 'Bearer fixture-subscription-key', 'the credential is the engine\'s, not the stale row\'s');
    // The requested five-second duration is preserved on the selected route.
    equal(f.requests[0]!.body.duration, 5);
    match(f.requests[0]!.path, /\/v2\/video_generation$/);
  } finally { await f.close(); }
});
h.test('a retired custom video selection folds to the disabled state and makes no request', async () => {
  const f = await mediaFixture();
  try {
    kvSet('video_generation.selection', 'custom', f.root);
    f.config('custom', 'video', { model: 'sora-2' });
    equal(object(f.features.getVideoSelection()).selection, 'none', 'the retired endpoint selection folds to disabled');
    const text = failure(await f.service.execute('generate_video', { prompt: 'Waves', seconds: 4, size: '1280x720' }, f.context('minimax')));
    match(text, /disabled/);
    equal(object(f.selectVideo('custom')).ok, false, 'the retired endpoint cannot be reselected');
    equal(f.requests.length, 0); equal(f.generated.length, 0);
  } finally { await f.close(); }
});
h.test('switching the global video selection moves every later video call, like the image one', async () => {
  const vector = object((await generationVector()).minimaxVideo);
  let baseUrl = '';
  const taskReply = (): JsonObject => { const row = JSON.parse(JSON.stringify(vector.taskResponse)) as JsonObject; object(object(row.task).content).url = baseUrl + '/download'; return row; };
  const f = await mediaFixture({
    respond: (request, response) => {
      if (request.path === '/download') { response.end(mp4); return; }
      // The MiniMax task protocol answers its own shapes…
      if (request.path === '/v2/video_generation') { response.end(JSON.stringify(vector.submitResponse)); return; }
      if (request.path.startsWith('/v2/query/video_generation')) { response.end(JSON.stringify(taskReply())); return; }
      // …and the OpenAI-compatible protocol answers its own, once the selection
      // moves to custom.
      if (request.path.endsWith('/content')) { response.end(mp4); return; }
      response.end(JSON.stringify(request.method === 'POST' ? { id: 'job-1', status: 'queued' } : { id: 'job-1', status: 'completed' }));
    },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    // Start on the subscription route…
    f.selectVideo('minimax');
    output(await f.service.execute('generate_video', vector.input!, f.context('custom')));
    match(f.requests[0]!.path, /\/v2\/video_generation$/);
    // …then disable video: the next call reports the disabled state instead of
    // following any endpoint row, even though nothing about the conversation changed.
    f.selectVideo('none');
    match(failure(await f.service.execute('generate_video', { prompt: 'Waves' }, f.context('custom'))), /disabled/);
    equal(f.requests.length, 3, 'only the subscription route made requests');
  } finally { await f.close(); }
});

h.test('committed vectors pin the four speech protocols generate_audio dispatches on', async () => {
  const vector = await generationVector();
  deepEqual(GENERATION_TOOL_SPECS.map(spec => spec.name), ['generate_image', 'generate_video', 'generate_audio', 'generate_music']);
  const selection = object(vector.selection);
  equal(selection.globalForAudio, true);
  deepEqual(selection.audioChoices, ['none', 'cursor', 'minimax', 'bailian', 'workbuddy']);
  equal(selection.audioSubscriptionModelAndVoicePreserved, true);
  const limits = object(vector.limits);
  equal(limits.audioBytes, LIMITS.audioBytes); equal(limits.audioMs, LIMITS.audioMs);
  const speech = object(vector.openaiSpeech);
  equal(speech.path, '/v1/audio/speech'); equal(speech.extension, 'mp3');
  equal(object(vector.minimaxSpeech).audioIsHex, true);
  // The offered delivery styles are exactly the ones the MiniMax protocol accepts,
  // on both the tool schema and the committed wire vector.
  const minimax = object(vector.minimaxSpeech);
  deepEqual(minimax.emotions, [...SPEECH_EMOTIONS]);
  equal(minimax.emotionOmittedUnlessAsked, true);
  deepEqual(object(vector.speedRange), SPEECH_SPEED_RANGE as unknown as JsonObject);
  const audioSpec = GENERATION_TOOL_SPECS.find(spec => object(spec).name === 'generate_audio')!;
  deepEqual(object(object(object(audioSpec.inputSchema).properties).emotion).enum, [...SPEECH_EMOTIONS]);
  const speedSpec = object(object(object(audioSpec.inputSchema).properties).speed);
  equal(speedSpec.type, 'number'); equal(speedSpec.minimum, SPEECH_SPEED_RANGE.min); equal(speedSpec.maximum, SPEECH_SPEED_RANGE.max);
  // Model Studio answers on its own multimodal path with a download URL, not the
  // compatible shape; Zhipu speaks the compatible shape but only answers wav.
  equal(object(vector.dashscopeSpeech).path, '/api/v1/services/aigc/multimodal-generation/generation');
  equal(object(vector.dashscopeSpeech).extension, 'wav');
  const zhipu = object(vector.zhipuSpeech);
  equal(zhipu.path, '/api/paas/v4/audio/speech'); equal(zhipu.extension, 'wav');
  equal(object(zhipu.body).response_format, 'wav', 'Zhipu refuses an mp3 request');
});
h.test('an unconfigured audio backend gives an actionable notice without calling a provider', async () => {
  const f = await mediaFixture();
  try {
    equal(object(f.features.getAudioSelection()).selection, 'none');
    match(failure(await f.service.execute('generate_audio', { text: 'Say this aloud.' }, f.context())), /disabled/);
    equal(f.requests.length, 0); equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
    f.selectAudio('minimax');
    match(failure(await f.service.execute('generate_audio', { text: 'Say this aloud.' }, f.context())), /subscription credential/);
    equal(f.requests.length, 0);
    f.selectAudio('bailian');
    match(failure(await f.service.execute('generate_audio', { text: 'Say this aloud.' }, f.context())), /subscription credential/);
    equal(f.requests.length, 0);
  } finally { await f.close(); }
});
h.test('audio arguments are validated before any provider call, like the other media kinds', async () => {
  const f = await mediaFixture({ respond: (_request, response) => response.end(mp3) });
  try {
    f.selectAudio('custom'); f.config('custom', 'audio', {});
    for (const input of [{ text: '' }, { text: '   ' }, {}, { text: 'hi', extra: true }, { text: 'hi', voice: '' }, { text: 'hi', emotion: 'auto' }, { text: 'hi', emotion: 3 }, { text: 'hi', speed: 0 }, { text: 'hi', speed: 2.5 }, { text: 'hi', speed: 'fast' }, { text: 'x'.repeat(10001) }] as Json[]) {
      failure(await f.service.execute('generate_audio', input, f.context()));
    }
    match(failure(await f.service.execute('generate_audio', { text: 'hi', emotion: 'auto' }, f.context())), /Invalid speech emotion/);
    match(failure(await f.service.execute('generate_audio', { text: 'hi', speed: 2.5 }, f.context())), /Invalid speech rate/);
    equal(f.requests.length, 0, 'no invalid call reaches a provider');
    equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('retired custom speech never calls an endpoint even when a complete legacy configuration exists', async () => {
  const f = await mediaFixture();
  try {
    f.config('custom', 'audio', { provider: 'openai-compatible', model: 'legacy-speech', voice: 'alloy' });
    equal(kvSet('audio_generation.selection', 'custom', f.root), true);
    equal(object(f.features.getAudioSelection()).selection, 'none');
    match(failure(await f.service.execute('generate_audio', { text: 'Say this aloud.' }, f.context())), /disabled/);
    equal(object(f.selectAudio('custom')).ok, false);
    equal(f.requests.length, 0); equal(f.generated.length, 0);
  } finally { await f.close(); }
});
h.test('the MiniMax speech route decodes hex audio and spends the plan subscription key', async () => {
  const vector = object((await generationVector()).minimaxSpeech);
  let baseUrl = '';
  const f = await mediaFixture({
    respond: (_request, response) => response.end(JSON.stringify({
      data: { audio: mp3.toString('hex'), status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' },
    })),
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    f.selectAudio('minimax');
    const result = await f.service.execute('generate_audio', vector.input!, f.context('custom')); output(result);
    deepEqual(f.requests.map(row => row.path), [vector.path]);
    deepEqual(f.requests[0]!.body, vector.body);
    match(String(f.requests[0]!.headers.authorization), /^Bearer fixture-subscription-key$/);
    deepEqual(await readFile(f.generated[0]!.paths[0]!), mp3);
    match(f.generated[0]!.paths[0]!, /\.mp3$/);
    match(resultText(result), /^Audio saved to /);
    equal(f.requests.length, 1, 'the plan route is synchronous: no poll and no download');
  } finally { await f.close(); }
});
h.test('a named emotion rides in MiniMax voice_setting while an unnamed one stays off the wire', async () => {
  const vector = object((await generationVector()).minimaxSpeech);
  const override = object(vector.emotionOverride);
  let baseUrl = '';
  const f = await mediaFixture({
    respond: (_request, response) => response.end(JSON.stringify({ data: { audio: mp3.toString('hex') }, base_resp: { status_code: 0 } })),
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    f.selectAudio('minimax');
    const styled = resultText(await f.service.execute('generate_audio', override.input!, f.context('custom')));
    match(styled, /^Audio saved to /);
    deepEqual(object(f.requests[0]!.body as JsonObject).voice_setting, override.voiceSetting, 'the named delivery style reaches voice_setting');
    const plain = resultText(await f.service.execute('generate_audio', vector.input!, f.context('custom')));
    match(plain, /^Audio saved to /);
    equal(plain.includes('emotion'), false, 'no emotion in the result line when none was asked');
    const setting = object(f.requests[1]!.body as JsonObject).voice_setting as JsonObject;
    equal('emotion' in setting, false, 'omitting the field is what leaves delivery to the model');
    const paced = object(vector.speedOverride);
    match(resultText(await f.service.execute('generate_audio', paced.input!, f.context('custom'))), /^Audio saved to /);
    deepEqual(object(f.requests[2]!.body as JsonObject).voice_setting, paced.voiceSetting, 'a per-call pace replaces the neutral speed');
    const unpaced = resultText(await f.service.execute('generate_audio', vector.input!, f.context('custom')));
    equal(unpaced.includes('speed'), false, 'no pace in the result line when none was asked');
    equal(object(object(f.requests[3]!.body as JsonObject).voice_setting).speed, 1, 'an unpaced call keeps the neutral speed');
  } finally { await f.close(); }
});
h.test('MiniMax speech keeps a saved model and voice override and never uses a stored endpoint host', async () => {
  let baseUrl = '';
  const f = await mediaFixture({
    respond: (_request, response) => response.end(JSON.stringify({ data: { audio: mp3.toString('hex') }, base_resp: { status_code: 0 } })),
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    f.selectAudio('minimax');
    // The model is source-specific; the existing shared voice cannot redirect credentials.
    equal(object(f.features.setMedia('audio', { source: 'minimax', model: 'speech-2.8-hd' })).ok, true);
    equal(kvSet('audio_generation.model_config', JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://other.example/v1', apiKey: 'other-secret', model: 'custom-speech', voice: 'audiobook_female_1' }), f.root), true);
    output(await f.service.execute('generate_audio', { text: 'Say this aloud.' }, f.context('custom')));
    deepEqual(f.requests.map(row => row.path), ['/v1/t2a_v2']);
    const body = f.requests[0]!.body as JsonObject;
    equal(body.model, 'speech-2.8-hd'); equal(object(body.voice_setting).voice_id, 'audiobook_female_1');
    match(String(f.requests[0]!.headers.authorization), /^Bearer fixture-subscription-key$/);
    equal(String(f.requests[0]!.headers.authorization).includes('other-secret'), false);
    match(String(kvGet('audio_generation.model_config', f.root) ?? ''), /other\.example/, 'the stored row survives untouched');
    output(await f.service.execute('generate_audio', { text: 'Say this aloud.', voice: 'voice-override' }, f.context('custom')));
    equal(object(object(f.requests[1]!.body).voice_setting).voice_id, 'voice-override', 'a per-call voice overrides the saved default');
  } finally { await f.close(); }
});
h.test('bytes that are not audio never become an artifact, whichever speech route returned them', async () => {
  let baseUrl = '';
  const f = await mediaFixture({
    respond: (_request, response) => response.end(JSON.stringify({ data: { audio: Buffer.from('invalid audio').toString('hex') }, base_resp: { status_code: 0 } })),
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-secret', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin; f.selectAudio('minimax');
    match(failure(await f.service.execute('generate_audio', { text: 'Say this aloud.' }, f.context())), /not a valid audio file/);
    equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('a speech refusal names what to change and never echoes the stored key', async () => {
  let baseUrl = '';
  const f = await mediaFixture({ respond: (_request, response) => {
    response.writeHead(401);
    response.end(JSON.stringify({ base_resp: { status_code: 1001, status_msg: 'fixture-secret is not a valid key' } }));
  }, deps: { minimax: { credential: async () => ({ apiKey: 'fixture-secret', baseUrl, region: 'cn' }) } } });
  try {
    baseUrl = f.origin; f.selectAudio('minimax');
    const text = failure(await f.service.execute('generate_audio', { text: 'Say this aloud.' }, f.context()));
    match(text, /speech generation credential was refused/);
    equal(text.includes('fixture-secret'), false, 'the stored key never crosses the model boundary');
    equal(f.generated.length, 0); await absent(join(f.root, 'sessions'));
  } finally { await f.close(); }
});
h.test('switching the global audio selection moves every later audio call, like video', async () => {
  const vector = object((await generationVector()).minimaxSpeech);
  let baseUrl = '';
  const f = await mediaFixture({
    respond: (request, response) => {
      if (request.path === String(vector.path)) { response.end(JSON.stringify({ data: { audio: mp3.toString('hex') }, base_resp: { status_code: 0 } })); return; }
      response.setHeader('Content-Type', 'audio/mpeg'); response.end(mp3);
    },
    deps: { minimax: { credential: async () => ({ apiKey: 'fixture-subscription-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    f.selectAudio('minimax');
    output(await f.service.execute('generate_audio', vector.input!, f.context('custom')));
    equal(f.requests[0]!.path, String(vector.path));
    f.selectAudio('none');
    match(failure(await f.service.execute('generate_audio', vector.input!, f.context('custom'))), /disabled/);
    equal(f.requests.length, 1, 'disabling speech prevents the next provider call');
  } finally { await f.close(); }
});
h.test('the Bailian audio route spends the Token Plan key on the plan gateway', async () => {
  const vector = object((await generationVector()).bailianSpeech);
  let baseUrl = '';
  const f = await mediaFixture({
    respond: (request, response) => {
      if (request.path === String(vector.downloadPath)) { response.setHeader('Content-Type', 'audio/mpeg'); response.end(mp3); return; }
      const row = JSON.parse(JSON.stringify(vector.response)) as JsonObject;
      object(object(row.output).audio).url = baseUrl + String(vector.downloadPath);
      response.end(JSON.stringify(row));
    },
    deps: { bailian: { credential: async () => ({ apiKey: 'fixture-plan-key', baseUrl, region: 'cn' }) } },
  });
  try {
    baseUrl = f.origin;
    f.selectAudio('bailian');
    const result = await f.service.execute('generate_audio', vector.input!, f.context('custom')); output(result);
    equal(f.requests[0]!.path, String(vector.path));
    deepEqual(f.requests[0]!.body, vector.body);
    match(String(f.requests[0]!.headers.authorization), /^Bearer fixture-plan-key$/);
    // The plan's own model, not the public route's: the plan gateway 404s the other.
    equal(object(f.requests[0]!.body).model, 'qwen-audio-3.0-tts-plus');
    deepEqual(await readFile(f.generated[0]!.paths[0]!), mp3);
    match(f.generated[0]!.paths[0]!, /\.mp3$/);
    match(resultText(result), /^Audio saved to /);
    equal(f.requests.length, 2, 'one synthesis call and one download');
    // A stored endpoint row must not redirect the plan key: only model and voice ride.
    f.selectAudio('bailian');
    equal(kvSet('audio_generation.model_config', JSON.stringify({ provider: 'openai-compatible', baseUrl: 'https://other.example/v1', apiKey: 'other-secret', model: 'qwen-audio-3.0-tts-flash' }), f.root), true);
    output(await f.service.execute('generate_audio', vector.input!, f.context('custom')));
    equal(f.requests[2]!.path, String(vector.path), 'the second call still runs the plan route');
    equal(String(f.requests[2]!.headers.authorization).includes('other-secret'), false);
  } finally { await f.close(); }
});
h.test('a public speech result link is upgraded to https while loopback links stay http', async () => {
  // The platform publishes its result links over plain http; the same public host
  // serves identical bytes over https, so a public link is upgraded rather than
  // fetched in the clear. A loopback link has no TLS to upgrade to.
  equal(speechDownloadUrl('http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/prod/a.mp3?sig=1'),
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/prod/a.mp3?sig=1');
  equal(speechDownloadUrl('http://127.0.0.1:9455/download.mp3'), 'http://127.0.0.1:9455/download.mp3');
  equal(speechDownloadUrl('http://localhost:8080/a.wav'), 'http://localhost:8080/a.wav');
  equal(speechDownloadUrl('https://example.test/a.mp3'), 'https://example.test/a.mp3');
  // Credentials and non-http schemes are still refused.
  let refused = 0;
  for (const raw of ['ftp://example.test/a.mp3', 'http://user:pass@example.test/a.mp3']) {
    try { speechDownloadUrl(raw); } catch { refused++; }
  }
  equal(refused, 2);
});
h.test('the audio selection is stored globally and an unknown value is refused', async () => {
  const f = await mediaFixture();
  try {
    deepEqual(f.selectAudio('minimax'), { ok: true, selection: 'minimax' });
    deepEqual(f.features.getAudioSelection(), { ok: true, selection: 'minimax', config: {} });
    const refused = object(f.selectAudio('codex'));
    equal(refused.ok, false); equal(refused.error, 'audio_selection_unknown'); equal(refused.selection, 'minimax', 'a refused write leaves the stored selection alone');
    // The audio endpoint row keeps its protocol choice and its voice, because the
    // three speech routes speak three incompatible shapes.
    f.features.setMedia('audio', { provider: 'dashscope', baseUrl: 'https://example.test', apiKey: 'k', model: 'qwen-tts', voice: 'Cherry' });
    deepEqual(f.features.getMedia('audio'), { baseUrl: 'https://example.test', apiKey: 'k', model: 'qwen-tts', voice: 'Cherry', provider: 'dashscope' });
    // An unrecognised provider falls back to the compatible route rather than
    // rejecting a row an older build wrote.
    f.features.setMedia('audio', { provider: 'invented', apiKey: 'k' });
    equal(object(f.features.getMedia('audio')).provider, 'openai-compatible');
  } finally { await f.close(); }
});

void h.finish(join(__dirname, 'media-generation-results.json'), 'media-generation').then(code => { process.exitCode = code; });
