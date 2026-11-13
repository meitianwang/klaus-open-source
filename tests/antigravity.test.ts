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

h.test('keychain store feeds local adoption and its refusals stay actionable', async () => {
  const envelope = `go-keyring-base64:${Buffer.from(JSON.stringify({ auth_method: 'consumer', token: { access_token: 'keychain-access', refresh_token: 'keychain-refresh', expiry: '2026-11-19T01:00:00Z' }, id_token_email: 'keychain@example.invalid' })).toString('base64')}`;
  const read = (result: { present: boolean; raw?: string; error?: string }) => async () => result;
  const f = await fixture();
  try {
    await rm(f.path);
    assert.deepEqual(await readAntigravityCredential(f.root, read({ present: true, raw: envelope })), { accessToken: 'keychain-access', refreshToken: 'keychain-refresh', expiresAt: Date.parse('2026-11-19T01:00:00Z'), account: 'keychain@example.invalid', authMethod: 'consumer' });
    await assert.rejects(readAntigravityCredential(f.root, read({ present: true, raw: 'go-keyring-base64:not-base64!!' })), { message: 'antigravity_local_unreadable' });
    await assert.rejects(readAntigravityCredential(f.root, read({ present: true, error: 'antigravity_local_keychain_denied' })), { message: 'antigravity_local_keychain_denied' });
    await assert.rejects(readAntigravityCredential(f.root, read({ present: false })), { message: 'antigravity_local_not_found' });
    await writeFile(f.path, JSON.stringify(document));
    assert.deepEqual(await readAntigravityCredential(f.root, read({ present: true, error: 'antigravity_local_keychain_denied' })), { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: Date.parse(document.token.expiry), account: 'user@example.invalid', authMethod: 'consumer' });
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

h.test('quota failures retain source verdicts instead of blaming every account refusal on the network', async () => {
  for (const code of ['antigravity_account_disabled', 'antigravity_account_restricted', 'antigravity_permission_denied',
    'antigravity_auth_required', 'antigravity_login_expired', 'antigravity_transport_unavailable', 'antigravity_refresh_unavailable']) {
    for (const error of [new Error(code), new Error(`app-server rpc error -32000: ${code}: private response`),
      { code: -32000, message: code }]) {
      const service = new UsageService({ authMode: () => 'antigravity', models: () => [], codexAccessToken: async () => undefined,
        keepAliveEnabled: false, request: async () => { throw error; },
      });
      try {
        const result = object(object(object(await service.query()).snapshot).provider);
        assert.equal(result.state, 'error');
        assert.equal(result.error, code);
      } finally { await service.close(); }
    }
  }
});

h.test('shared quota pools keep their service group titles and one row per window kind', () => {
  const reset = Date.parse('2026-10-26T00:00:00Z');
  const answer = antigravityUsage({ signedIn: true, windows: [
    { id: 'gemini', label: 'Weekly Limit Remaining', groupLabel: 'Gemini Models', usedPercent: 17, resetsAt: reset,
      groupDescription: 'Models within this group: Gemini Flash, Gemini Pro', description: 'A long weekly reset explanation' },
    { id: 'claude', label: 'Weekly Limit Remaining', groupLabel: 'Claude and GPT models', usedPercent: 68, resetsAt: reset + 1000,
      groupDescription: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS', description: 'A different weekly reset explanation' },
  ] });
  assert.deepEqual(answer, { state: 'ok', windows: [
    { id: 'pool_weekly', groupLabel: 'Gemini Models', windowKind: 'weekly', usedPercent: 17, resetsAt: reset, resetNotice: true },
    { id: 'pool_weekly', groupLabel: 'Claude and GPT models', windowKind: 'weekly', usedPercent: 68, resetsAt: reset + 1000, resetNotice: true },
  ] });
});

h.test('unknown pool windows keep their service order and identity inside one group', () => {
  const windows = [{ id: 'z', groupLabel: 'Gemini Models', usedPercent: 10 }, { id: 'a', groupLabel: 'Gemini Models', usedPercent: 70 }];
  const rows = (input: JsonObject[]) => antigravityUsage({ signedIn: true, windows: input }).windows as JsonObject[];
  assert.deepEqual(rows(windows), [
    { id: 'z', groupLabel: 'Gemini Models', usedPercent: 10 },
    { id: 'a', groupLabel: 'Gemini Models', usedPercent: 70 },
  ]);
  assert.deepEqual(rows([...windows].reverse()), rows(windows).reverse());
});

h.test('shared quota pools replace per-model family rows when the service reports groups', () => {
  const opusReset = Date.parse('2026-11-04T10:40:50Z');
  const geminiReset = Date.parse('2026-11-04T10:47:53Z');
  const projected = antigravityUsage({
    signedIn: true,
    plan: 'Google AI Ultra',
    windows: [
      { id: 'q1', modelId: 'chat_20706', label: 'chat_20706', source: 'quota', usedPercent: 0 },
      { id: 'q2', modelId: 'tab_flash_lite_preview', label: 'tab_flash_lite_preview', source: 'quota', usedPercent: 0 },
      { id: 'q3', modelId: 'tab_jump_flash_lite_preview', label: 'tab_jump_flash_lite_preview', source: 'quota', usedPercent: 0 },
      { id: 'q4', modelId: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium', source: 'quota', usedPercent: 70, resetsAt: opusReset },
      { id: 'q5', modelId: 'gemini-3.1-flash-image', label: 'gemini-3.1-flash-image', source: 'quota', usedPercent: 3, resetsAt: geminiReset },
      { id: 'q6', modelId: 'gemini-2.5-flash', label: 'gemini-2.5-flash', source: 'quota', usedPercent: 3, resetsAt: geminiReset },
      { id: 'q7', modelId: 'gemini-3.8-flash-low', label: 'gemini-3.8-flash-low', source: 'quota', usedPercent: 3, resetsAt: geminiReset },
      { id: 'q8', modelId: 'gemini-3.8-flash-high', label: 'gemini-3.8-flash-high', source: 'quota', usedPercent: 3, resetsAt: geminiReset },
      { id: 'q9', modelId: 'gemini-4-argon-low', label: 'gemini-4-argon-low', source: 'quota', usedPercent: 3, resetsAt: geminiReset },
      { id: 'q10', modelId: 'gemini-4-argon-medium', label: 'gemini-4-argon-medium', source: 'quota', usedPercent: 3, resetsAt: geminiReset },
      { id: 'q11', modelId: 'gemini-4-argon-high', label: 'gemini-4-argon-high', source: 'quota', usedPercent: 3, resetsAt: geminiReset },
      { id: 'q12', modelId: 'claude-opus-5-5-low', label: 'claude-opus-5-5-low', source: 'quota', usedPercent: 70, resetsAt: opusReset },
      { id: 'q13', modelId: 'claude-opus-5-5-medium', label: 'claude-opus-5-5-medium', source: 'quota', usedPercent: 70, resetsAt: opusReset },
      { id: 'q14', modelId: 'claude-opus-5-5-high', label: 'claude-opus-5-5-high', source: 'quota', usedPercent: 70, resetsAt: opusReset },
      { id: 'q15', modelId: 'claude-sonnet-5-5-low', label: 'claude-sonnet-5-5-low', source: 'quota', usedPercent: 70, resetsAt: opusReset },
      { id: 'q16', modelId: 'claude-sonnet-5-5-medium', label: 'claude-sonnet-5-5-medium', source: 'quota', usedPercent: 70, resetsAt: opusReset },
      { id: 'q17', modelId: 'claude-sonnet-5-5-high', label: 'claude-sonnet-5-5-high', source: 'quota', usedPercent: 70, resetsAt: opusReset },
      { id: 's1', label: 'Five Hour Limit Remaining', groupLabel: 'Claude and GPT models', source: 'summary', usedPercent: 70, resetsAt: opusReset },
      { id: 's2', label: 'Weekly Limit Remaining', groupLabel: 'Claude and GPT models', source: 'summary', usedPercent: 78, resetsAt: opusReset + 86400_000 },
      { id: 's3', label: 'Five Hour Limit Remaining', groupLabel: 'Gemini Models', source: 'summary', usedPercent: 3, resetsAt: geminiReset },
      { id: 's4', label: 'Weekly Limit Remaining', groupLabel: 'Gemini Models', source: 'summary', usedPercent: 2, resetsAt: geminiReset + 86400_000 },
    ],
  });
  assert.deepEqual(projected, {
    state: 'ok',
    plan: 'Google AI Ultra',
    windows: [
      { id: 'pool_duration_5h', groupLabel: 'Claude and GPT models', windowKind: 'duration', windowToken: '5h', usedPercent: 70, resetsAt: opusReset },
      { id: 'pool_weekly', groupLabel: 'Claude and GPT models', windowKind: 'weekly', usedPercent: 78, resetsAt: opusReset + 86400_000 },
      { id: 'pool_duration_5h', groupLabel: 'Gemini Models', windowKind: 'duration', windowToken: '5h', usedPercent: 3, resetsAt: geminiReset },
      { id: 'pool_weekly', groupLabel: 'Gemini Models', windowKind: 'weekly', usedPercent: 2, resetsAt: geminiReset + 86400_000 },
    ],
  });
  // Accounts without Argon still surface the latest available Gemini family.
  const withoutArgon = antigravityUsage({
    signedIn: true,
    windows: [
      { id: 'q1', modelId: 'claude-opus-4-6-thinking', source: 'quota', usedPercent: 20 },
      { id: 'q2', modelId: 'claude-sonnet-4-6', source: 'quota', usedPercent: 20 },
      { id: 'q3', modelId: 'gemini-2.5-pro', source: 'quota', usedPercent: 10 },
      { id: 'q4', modelId: 'gemini-3.8-flash-medium', source: 'quota', usedPercent: 5 },
      { id: 'q5', modelId: 'gemini-3.8-flash-high', source: 'quota', usedPercent: 5 },
    ],
  });
  assert.deepEqual(withoutArgon, {
    state: 'ok',
    windows: [
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', usedPercent: 20 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', usedPercent: 20 },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', usedPercent: 5 },
    ],
  });
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

h.test('engine catalog notifications broadcast source invalidation and quota windows recognize Carbon and Hydrogen', () => {
  const pushed: Array<{ channel: string; payload: JsonObject }> = [];
  const composer = new ComposerService({
    configRoot: join(tmpdir(), 'klaus-antigravity-notify-unused'),
    engineSettings: { providers: async () => ({}) } as unknown as EngineSettings,
    request: async () => ({}),
    push: (channel, payload) => { pushed.push({ channel, payload: object(payload) }); },
    onSessionConfigChanged: () => {},
  });
  assert.equal(composer.receiveEngineEvent({ type: 'productEvent', method: 'model/catalogChanged', params: { source: 'antigravity' } }), true);
  assert.equal(composer.receiveEngineEvent({ type: 'productEvent', method: 'model/catalogChanged', params: { source: 'unknown-source' } }), false);
  assert.equal(composer.receiveEngineEvent({ type: 'productEvent', method: 'other/event', params: { source: 'antigravity' } }), false);
  assert.deepEqual(pushed, [{ channel: 'app:preferences-changed', payload: { key: 'model_catalog:antigravity' } }]);

  const projected = antigravityUsage({
    signedIn: true,
    plan: 'Google AI Ultra',
    windows: [
      { id: 'quota:gemini-4-hydrogen-high', label: 'gemini-4-hydrogen-high', modelId: 'gemini-4-hydrogen-high', source: 'quota', usedPercent: 5, resetsAt: 1793789273000 },
      { id: 'quota:gemini-4-argon-medium', label: 'gemini-4-argon-medium', modelId: 'gemini-4-argon-medium', source: 'quota', usedPercent: 8, resetsAt: 1793789273000 },
      { id: 'quota:gemini-4-carbon-medium', label: 'gemini-4-carbon-medium', modelId: 'gemini-4-carbon-medium', source: 'quota', usedPercent: 12, resetsAt: 1793789273000 },
      { id: 'quota:gemini-3.8-flash-high', label: 'gemini-3.8-flash-high', modelId: 'gemini-3.8-flash-high', source: 'quota', usedPercent: 3, resetsAt: 1793789273000 },
    ],
  });
  assert.deepEqual(projected, {
    state: 'ok',
    plan: 'Google AI Ultra',
    windows: [
      { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', usedPercent: 12, resetsAt: 1793789273000 },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', usedPercent: 3, resetsAt: 1793789273000 },
    ],
  });
});

void h.finish(join(__dirname, 'antigravity-result.json'), 'antigravity').then(code => { process.exitCode = code; });
