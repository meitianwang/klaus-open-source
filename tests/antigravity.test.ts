import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAntigravityCredential } from '../main/services/antigravity-credential';
import { SubscriptionAuthService } from '../main/services/subscription-auth';
import { antigravityUsage, UsageService } from '../main/services/usage';
import { AUTH_MODES } from '../main/services/model-sources';
import { modelSource, validModelSelection } from '../main/services/session-store';
import { mainModelSource } from '../main/services/session-init';
import { IMAGE_SELECTION_SOURCES, VIDEO_SELECTION_SOURCES, AUDIO_SELECTION_SOURCES, ModelFeatureSettings } from '../main/services/model-features';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';
import { ComposerService } from '../main/services/composer';
import { sourceTierCatalog, modelTierCatalog } from '../main/services/model-tier-catalog';
import type { EngineSettings } from '../main/services/engine-settings';
import { mediaFixture, png, resultText } from './media-generation-fixture';
import { rpcAdmission } from '../main/engine/request-scheduler';
import { registerAntigravityModelVariantTests } from './antigravity-model-variants';
import { registerAntigravityLoginTests } from './antigravity-login';

const h = new Harness();
const document = { auth_method: 'consumer', token: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expiry: '2026-10-19T01:00:00Z' }, id_token: `header.${Buffer.from(JSON.stringify({ email: 'user@example.invalid' })).toString('base64url')}.signature` };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-antigravity-'));
  await mkdir(join(root, '.gemini'));
  const path = join(root, '.gemini', 'jetski-standalone-oauth-token');
  await writeFile(path, JSON.stringify(document));
  return { root, path, close: () => rm(root, { recursive: true, force: true }) };
}

h.test('local account adoption projects only bounded credentials and a display claim', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readAntigravityCredential(f.root), { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.parse(document.token.expiry), account: 'user@example.invalid', authMethod: 'consumer' });
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), document);
    await writeFile(f.path, JSON.stringify({ ...document, id_token: 'invalid' }));
    assert.equal((await readAntigravityCredential(f.root)).account, undefined);
  } finally { await f.close(); }
});

h.test('malformed, oversized and non-consumer local credentials fail without source bytes in errors', async () => {
  const f = await fixture();
  try {
    for (const data of [JSON.stringify({ ...document, token: { access_token: 'invalid\nsecret' } }), '{broken', 'x'.repeat(128 * 1024 + 1)]) {
      await writeFile(f.path, data);
      await assert.rejects(readAntigravityCredential(f.root), { message: 'antigravity_local_unreadable' });
    }
    await writeFile(f.path, JSON.stringify({ ...document, auth_method: 'enterprise' }));
    await assert.rejects(readAntigravityCredential(f.root), { message: 'antigravity_auth_method_unsupported' });
    await rm(f.path);
    await mkdir(f.path);
    await assert.rejects(readAntigravityCredential(f.root), { message: 'antigravity_local_unreadable' });
    await rm(f.path, { recursive: true });
    await assert.rejects(readAntigravityCredential(f.root), { message: 'antigravity_local_not_found' });
  } finally { await f.close(); }
});

h.test('logout fences in-flight adoption and leaves the external login unchanged', async () => {
  const f = await fixture(), calls: string[] = [];
  let release!: (value: unknown) => void;
  const adopted = new Promise(resolve => { release = resolve; });
  const service = new SubscriptionAuthService({ configRoot: f.root, homeDir: f.root,
    request: async method => { calls.push(method); return method === 'antigravity/adoptCredential' ? adopted : { ok: true }; },
    openExternal: async () => { throw new Error('Unexpected browser launch'); }, onAuthChanged: () => {},
  });
  try {
    const pending = service.antigravityImportLocal();
    await waitFor(() => calls.length === 1, 1000, 'adoption starts');
    const logout = service.antigravityLogout();
    release({ ok: true, signedIn: true });
    assert.equal(object(await pending).ok, false);
    assert.equal(object(await logout).ok, true);
    assert.deepEqual(calls, ['antigravity/adoptCredential', 'antigravity/logout', 'antigravity/logout']);
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), document);
  } finally { await service.close(); await f.close(); }
});

h.test('disconnect during account refresh cannot publish a stale successful import', async () => {
  const f = await fixture(); let refreshing = false, release!: () => void;
  const refresh = new Promise<void>(resolve => { release = resolve; });
  const service = new SubscriptionAuthService({ configRoot: f.root, homeDir: f.root,
    request: async () => ({ ok: true, signedIn: true }), openExternal: async () => {},
    onAuthChanged: async () => { if (!refreshing) { refreshing = true; await refresh; } },
  });
  try {
    const pending = service.antigravityImportLocal();
    await waitFor(() => refreshing, 1000, 'account refresh starts');
    const logout = service.antigravityLogout(); release();
    assert.equal(object(await pending).ok, false);
    assert.equal(object(await logout).ok, true);
  } finally { release(); await service.close(); await f.close(); }
});

h.test('catalog refresh coalesces while native cancellation retains reserved priority', () => {
  assert.equal(rpcAdmission('antigravity/models', { read: 'warm' }, 1000).coalesceKey, rpcAdmission('antigravity/models', { read: 'warm' }, 1000).coalesceKey);
  assert.ok(rpcAdmission('antigravity/models', {}, 1000).coalesceKey);
  assert.equal(rpcAdmission('antigravity/generateImage', {}, 1000).coalesceKey, undefined);
  assert.equal(rpcAdmission('antigravity/cancelOperation', { operationId: 'one' }, 1000).priority, 'critical');
});

h.test('source identity, native image preferences and quota vectors retain their contracts', async () => {
  const f = await fixture();
  try {
    const vectors = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/antigravity-source-vectors.json'), 'utf8'));
    assert.ok((AUTH_MODES as readonly string[]).includes(vectors.source));
    assert.equal(modelSource(vectors.selection), vectors.source);
    assert.equal(mainModelSource(vectors.selection), vectors.source);
    assert.equal(validModelSelection(vectors.selection), true);
    for (const [kind, sources] of [['image', IMAGE_SELECTION_SOURCES], ['video', VIDEO_SELECTION_SOURCES], ['audio', AUDIO_SELECTION_SOURCES]] as const) assert.equal((sources as readonly string[]).includes(vectors.source), vectors.media[kind]);
    const features = new ModelFeatureSettings(f.root);
    assert.equal(object(features.setMedia('image', { source: vectors.source, model: 'image-model' })).ok, true);
    assert.deepEqual(features.getMedia('image', { source: vectors.source }), { source: vectors.source, model: 'image-model' });
    assert.equal(object(features.setMedia('image', { source: vectors.source, imageEditModel: 'edit-model' })).ok, false);
    assert.equal(object(features.getMedia('image')).model, undefined);
    for (const row of vectors.quota) assert.deepEqual(antigravityUsage(row.input), row.expected, row.name);
  } finally { await f.close(); }
});

h.test('quota queries use the selected cloud source and preserve absent windows', async () => {
  const methods: string[] = [];
  const service = new UsageService({ authMode: () => 'antigravity', models: () => [], codexAccessToken: async () => undefined,
    request: async method => { methods.push(method); return { signedIn: true, windows: [] }; },
  });
  try {
    const answer = object(object(object(await service.query()).snapshot).provider) as JsonObject;
    assert.deepEqual(answer, { state: 'ok', quotaAvailable: false });
    assert.deepEqual(methods, ['antigravity/usage']);
  } finally { await service.close(); }
});

h.test('quota restrictions and amount-only windows survive host projection without invented percentages', () => {
  assert.deepEqual(antigravityUsage({ signedIn: true, windows: [{ id: 'blocked', disabled: true, description: 'Account restricted', groupDescription: 'Premium' }, { id: 'amount', remainingAmount: 42 }] }), {
    state: 'ok', windows: [{ id: 'blocked', disabled: true }, { id: 'amount', remaining: 42 }],
  });
  const pools = [{ creditType: 'GOOGLE_ONE_AI', creditAmount: '9007199254740993', minimumCreditAmountForUsage: '100' }, { creditType: 'CREDIT_TYPE_UNSPECIFIED', creditAmount: '42' }];
  assert.deepEqual(antigravityUsage({ signedIn: true, credits: { pools } }), { state: 'ok', credits: { pools } });
  assert.deepEqual(antigravityUsage({ signedIn: true, windows: [{ id: 'legacy', remaining: 0 }, { id: 'reported', remainingAmount: 4000, remaining: 9 }] }), {
    state: 'ok', windows: [{ id: 'legacy', remaining: 0 }, { id: 'reported', remaining: 4000 }],
  });
});

h.test('quota group titles replace descriptive footnotes while balances and resets stay independent', () => {
  const reset = Date.parse('2026-10-26T00:00:00Z');
  const answer = antigravityUsage({ signedIn: true, windows: [
    { id: 'gemini', label: 'Weekly Limit Remaining', groupLabel: 'Gemini Models', usedPercent: 17, resetsAt: reset,
      groupDescription: 'Models within this group: Gemini Flash, Gemini Pro', description: 'A long weekly reset explanation' },
    { id: 'claude', label: 'Weekly Limit Remaining', groupLabel: 'Claude and GPT models', usedPercent: 68, resetsAt: reset + 1000,
      groupDescription: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', description: 'A different weekly reset explanation' },
  ] });
  assert.deepEqual(answer, { state: 'ok', windows: [
    { id: 'gemini', label: 'Gemini', usedPercent: 17, resetsAt: reset },
    { id: 'claude', label: 'Claude / GPT', usedPercent: 68, resetsAt: reset + 1000 },
  ] });
});

h.test('quota groups with the same short title keep distinct stable names', () => {
  const windows = [{ id: 'z', groupLabel: 'Gemini Models', usedPercent: 10 }, { id: 'a', groupLabel: 'Gemini Models', usedPercent: 70 }];
  const names = (input: JsonObject[]) => Object.fromEntries((antigravityUsage({ signedIn: true, windows: input }).windows as JsonObject[]).map(row => [row.id, row.label]));
  assert.deepEqual(names(windows), { a: 'Gemini 1', z: 'Gemini 2' });
  assert.deepEqual(names([...windows].reverse()), names(windows));
});

h.test('cloud model rows preserve reported entitlements while known tier selections remain assignable', async () => {
  const f = await fixture(), calls: string[] = [];
  const engine = { providers: async () => ({}) } as unknown as EngineSettings;
  const request = async (method: string) => {
    calls.push(method);
    if (method !== 'antigravity/models') throw new Error('Unexpected model source');
    return { models: [{ key: 'paid', display_name: 'Paid model', disabled: true, efforts: ['low', 'high'] }, { key: 'ready', display_name: 'Ready model', capabilities: { mediaInputMimeTypes: ['audio/wav'] } }] };
  };
  try {
    const composer = new ComposerService({ configRoot: f.root, request, engineSettings: engine, push: () => {}, onSessionConfigChanged: () => {} });
    const rows = (await composer.options('antigravity')).map(object);
    assert.equal(rows[0]!.value, 'antigravity:paid'); assert.equal(rows[0]!.available, false);
    assert.deepEqual(rows[1]!.mediaInputMimeTypes, ['audio/wav']);
    const deps = { configRoot: f.root, request, engine, sourceStatus: async (source: string) => ({ loggedIn: source === 'antigravity' }) };
    assert.equal((object(await sourceTierCatalog('antigravity', deps)).options as unknown[]).length, 2);
    const reply = await modelTierCatalog({ version: 1, revision: 0, high: { source: 'antigravity', modelId: 'paid' }, medium: null, low: null }, deps);
    assert.equal(object(object(reply.tiers).high).status, 'ready');
    assert.ok(calls.every(method => method === 'antigravity/models'));
  } finally { await f.close(); }
});

h.test('global image selection uses the account-native model independently of the chat source', async () => {
  const calls: JsonObject[] = [];
  const f = await mediaFixture({ deps: { antigravity: {
    status: async () => ({ loggedIn: true }), capabilities: async () => ({ image: { available: true, models: [{ id: 'native-image', label: 'Image' }], defaultModel: 'native-image' } }),
    image: async params => { calls.push(params); return { imageBase64: png.toString('base64'), mimeType: 'image/png' }; },
    video: async () => { throw new Error('Unexpected video request'); }, audio: async () => { throw new Error('Unexpected audio request'); },
  } } });
  try {
    assert.equal(object(f.select('antigravity')).ok, true);
    const answer = await f.service.execute('generate_image', { prompt: 'A blue square' }, f.context('custom'));
    assert.equal(object(answer).success, true, resultText(answer));
    assert.equal(calls.length, 1); assert.equal(calls[0]!.model, 'native-image');
    assert.equal(f.requests.length, 0); assert.equal(f.generated.length, 1);
  } finally { await f.close(); }
});

h.test('unavailable native image editing rejects before reading source files', async () => {
  let called = false;
  const f = await mediaFixture({ deps: { antigravity: {
    status: async () => ({ loggedIn: true }), capabilities: async () => ({ imageEdit: { available: false } }),
    image: async () => { called = true; throw new Error('Unavailable operation invoked'); },
    video: async () => ({}), audio: async () => ({}),
  } } });
  try {
    f.select('antigravity');
    const answer = await f.service.execute('generate_image', { prompt: 'Edit', source_images: ['/never-read.png'] }, f.context());
    assert.equal(object(answer).success, false); assert.match(resultText(answer), /currently unavailable/); assert.equal(called, false);
    assert.equal(f.requests.length, 0); assert.equal(f.generated.length, 0);
  } finally { await f.close(); }
});

h.test('native image output publishes every validated image and rejects a malformed later image atomically', async () => {
  let invalid = false;
  const f = await mediaFixture({ deps: { antigravity: {
    status: async () => ({ loggedIn: true }), capabilities: async () => ({ image: { available: true, models: ['native-image'], defaultModel: 'native-image' } }),
    image: async () => ({ images: [{ imageBase64: png.toString('base64'), mimeType: 'image/png' }, { imageBase64: png.toString('base64'), mimeType: invalid ? 'image/jpeg' : 'image/png' }] }),
    video: async () => ({}), audio: async () => ({}),
  } } });
  try {
    f.select('antigravity');
    assert.equal(object(await f.service.execute('generate_image', { prompt: 'Two images' }, f.context())).success, true);
    assert.equal(f.generated.length, 1); assert.equal(f.generated[0]!.paths.length, 2);
    invalid = true;
    const answer = await f.service.execute('generate_image', { prompt: 'Two images' }, f.context());
    assert.equal(object(answer).success, false); assert.match(resultText(answer), /media type/);
    assert.equal(f.generated.length, 1, 'no file from the invalid batch is published');
  } finally { await f.close(); }
});

registerAntigravityModelVariantTests(h);
registerAntigravityLoginTests(h);
void h.finish(join(__dirname, 'antigravity-result.json'), 'antigravity').then(code => { process.exitCode = code; });
