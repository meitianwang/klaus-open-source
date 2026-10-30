import assert from 'node:assert/strict';
import type { Json } from '../main/ipc/contract';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_MODES } from '../main/services/model-sources';
import { AUTH_CHANNELS } from '../main/ipc/handlers/auth';
import { ComposerService } from '../main/services/composer';
import type { EngineSettings } from '../main/services/engine-settings';
import { readSessionModel, readSessionThinkingLevel, readSessionUltraMode, setSessionModel, modelSource, validModelSelection } from '../main/services/session-store';
import { mainModelSource } from '../main/services/session-init';
import { SubscriptionAuthService, type SubscriptionAuthDeps } from '../main/services/subscription-auth';
import { traeUsage, UsageService } from '../main/services/usage';
import { modelTierCatalog, sourceTierCatalog } from '../main/services/model-tier-catalog';
import { modelConfigUpdate, modelPreference, MobileModelConfigProjection } from '../main/services/mobile/model-config';
import { object, type JsonObject } from '../main/services/service-types';
import { modelOptionForValue, modelOptionHasValue } from '../shared/cursor-model-catalog';
import { pickTraeModelMetadata, traeThinkingLevels, traeThinkingLevel } from '../shared/trae-model-catalog';
import { SUBSCRIPTION_WEB_SEARCH_SOURCES } from '../contracts/web-search-settings';
import { VOICE_INPUT_SOURCES, VOICE_NATIVE_STREAMING_SOURCES, voiceUploadContainer } from '../shared/voice-input';
import { rpcAdmission } from '../main/engine/request-scheduler';
import { Harness, waitFor } from './harness';
import { registerTraeCredentialTests } from './trae-credential';
import { mediaFixture, png, mp4, resultText } from './media-generation-fixture';
import { voiceModelAccess, type VoiceEngineConnection } from '../main/app/voice-runtime';
import { mobileFixture } from './mobile-fixture';

const h = new Harness();
const vector = () => readFile(join(__dirname, '../../contracts/vectors/trae-source-vectors.json'), 'utf8').then(JSON.parse);
const start = (flowId = 'fixture-flow') => ({ ok: true, flowId, authUrl: 'https://www.trae.cn/authorization?state=fixture', expiresAt: Date.now() + 60_000 });
async function authFixture(overrides: Partial<SubscriptionAuthDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-trae-host-'));
  const calls: Array<{ method: string; params: unknown }> = [], opened: string[] = [];
  let publications = 0;
  const service = new SubscriptionAuthService({ configRoot: root, homeDir: root,
    request: async (method, params) => { calls.push({ method, params }); return method === 'trae/loginStart' ? start() : { ok: true, loggedIn: true }; },
    openExternal: async url => { opened.push(url); }, onAuthChanged: () => { publications++; }, ...overrides });
  return { root, service, calls, opened, publications: () => publications, close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}

registerTraeCredentialTests(h);

h.test('the Trae source has explicit model identity and independent native search and speech selections', async () => {
  const v = await vector();
  assert((AUTH_MODES as readonly string[]).includes(v.source));
  assert.equal(mainModelSource(v.selection), v.source);
  assert.equal(modelSource(v.selection), v.source);
  assert.equal(validModelSelection('trae:fixture-chat::effort=light'), true);
  for (const action of ['status', 'start', 'poll', 'cancel', 'import-local', 'logout', 'models']) assert((AUTH_CHANNELS as readonly string[]).includes(`trae-auth:${action}`));
  assert((SUBSCRIPTION_WEB_SEARCH_SOURCES as readonly string[]).includes('trae'));
  assert((VOICE_INPUT_SOURCES as readonly string[]).includes('trae'));
  assert((VOICE_NATIVE_STREAMING_SOURCES as readonly string[]).includes('trae'));
  assert.equal(voiceUploadContainer('trae'), 'wav');
  assert.equal(rpcAdmission('trae/models', { read: 'warm' }, 1000).coalesceKey, rpcAdmission('trae/models', { read: 'warm' }, 1000).coalesceKey);
  assert.equal(rpcAdmission('trae/loginCancel', { flow: { flowId: 'one' } }, 1000).priority, 'critical');
  assert.equal(rpcAdmission('trae/cancelOperation', { operationId: 'one' }, 1000).priority, 'critical');
});

h.test('browser authorization opens only the validated URL and retires a committed flow before notification', async () => {
  let service!: SubscriptionAuthService;
  const f = await authFixture({ onAuthChanged: async () => { await service.traeCancel('fixture-flow'); } }); service = f.service;
  try {
    assert.equal(object(await f.service.traeStart()).ok, true);
    assert.deepEqual(f.opened, [start().authUrl]);
    assert.equal(object(await f.service.traePoll('fixture-flow')).ok, true);
    assert.deepEqual(f.calls.map(row => row.method), ['trae/loginStart', 'trae/loginPoll']);
  } finally { await f.close(); }
});

h.test('pending authorization never publishes a login or consumes its owned flow', async () => {
  let polls = 0;
  const f = await authFixture({ request: async method => method === 'trae/loginStart' ? start()
    : method === 'trae/loginPoll' && ++polls === 1 ? { ok: true, status: 'pending' } : { ok: true, status: 'success' } });
  try {
    await f.service.traeStart();
    assert.deepEqual(await f.service.traePoll('fixture-flow'), { ok: false, status: 'pending', pending: true });
    assert.equal(f.publications(), 0);
    assert.equal(object(await f.service.traePoll('fixture-flow')).ok, true);
    assert.equal(f.publications(), 1);
  } finally { await f.close(); }
});

h.test('unsafe authorization URLs fail before opening a browser and cancel their owned flow', async () => {
  for (const authUrl of ['http://www.trae.cn/authorization', 'https://www.trae.cn.invalid/authorization', 'https://www.trae.cn/other', 'https://user:pass@www.trae.cn/authorization', 'https://www.trae.cn/authorization#fragment']) {
    const methods: string[] = [];
    const f = await authFixture({ request: async method => { methods.push(method); return method === 'trae/loginStart' ? { ...start(), authUrl } : { ok: true }; } });
    try {
      assert.deepEqual(await f.service.traeStart(), { ok: false, error: 'trae_login_url_invalid' });
      assert.deepEqual(f.opened, []);
      assert.deepEqual(methods, ['trae/loginStart', 'trae/loginCancel']);
    } finally { await f.close(); }
  }
});

h.test('cancellation fences a delayed successful poll and cannot cancel a newer account flow', async () => {
  let release!: (value: unknown) => void, polls = 0, starts = 0;
  const pending = new Promise(resolve => { release = resolve; }), methods: Array<[string, unknown]> = [];
  const f = await authFixture({ request: async (method, params) => {
    methods.push([method, params]);
    if (method === 'trae/loginStart') return start(++starts === 1 ? 'old' : 'new');
    if (method === 'trae/loginPoll' && ++polls === 1) return pending;
    return { ok: true, loggedIn: true };
  } });
  try {
    await f.service.traeStart();
    const first = f.service.traePoll('old');
    await waitFor(() => methods.some(([method]) => method === 'trae/loginPoll'), 1000, 'the pending poll starts');
    await f.service.traeCancel('old');
    const next = f.service.traeStart();
    release({ ok: true, loggedIn: true });
    assert.deepEqual(await first, { ok: false, error: 'trae_login_cancelled' });
    assert.equal(object(await next).flowId, 'new');
    const before = methods.length;
    await f.service.traeCancel('old');
    assert.equal(methods.length, before);
    assert.equal(object(await f.service.traePoll('new')).ok, true);
    assert.equal(f.publications(), 1);
    assert(!methods.some(([method]) => method === 'trae/logout'));
  } finally { release({ ok: true }); await f.close(); }
});

h.test('a failed post-commit notification does not turn a saved login into a failed authorization', async () => {
  const f = await authFixture({ onAuthChanged: () => { throw new Error('notification unavailable'); } });
  try {
    await f.service.traeStart();
    assert.equal(object(await f.service.traePoll('fixture-flow')).ok, true);
    assert(!f.calls.some(row => row.method === 'trae/logout' || row.method === 'trae/loginCancel'));
  } finally { await f.close(); }
});

h.test('missing local login reports a safe code without opening a browser or writing another account', async () => {
  const f = await authFixture();
  try {
    assert.deepEqual(await f.service.traeImportLocal(), { ok: false, error: 'trae_local_not_found' });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.opened, []);
  } finally { await f.close(); }
});

h.test('allowance projection retains pack limits and expiry without inventing used percentages', async () => {
  const v = await vector();
  for (const row of v.quota) assert.deepEqual(traeUsage(row.input), row.expected, row.name);
  const service = new UsageService({ authMode: () => 'trae', models: () => [], codexAccessToken: async () => undefined,
    request: async method => { assert.equal(method, 'trae/usage'); return { signedIn: true, windows: [] }; } });
  try { assert.deepEqual(object(object(object(await service.query()).snapshot).provider), { state: 'ok', quotaAvailable: false }); }
  finally { await service.close(); }
});

h.test('chat projection keeps account-restricted families and excludes hidden and non-chat inventory', async () => {
  const v = await vector(), calls: unknown[] = [];
  const composer = new ComposerService({ configRoot: '/tmp/unused-trae-catalog', request: async (method, params) => {
    calls.push([method, params]);
    assert.equal(method, 'trae/models');
    return { models: [v.family, { key: 'completion', purpose: 'completion' }, { key: 'internal', purpose: 'chat', is_invisible_to_user: true }] };
  }, push: () => {}, onSessionConfigChanged: () => {} });
  const rows = await composer.options('trae'), row = object(rows[0]);
  assert.equal(rows.length, 1);
  assert.equal(row.available, false);
  assert.deepEqual(traeThinkingLevels(pickTraeModelMetadata(row)), ['light', 'high']);
  assert.equal(traeThinkingLevel(pickTraeModelMetadata(row), v.selection), 'high');
  assert.equal(modelOptionHasValue(row, 'trae:fixture-chat::effort=light'), true);
  assert.equal(object(modelOptionForValue(rows, 'trae:fixture-chat::effort=light')).value, 'trae:fixture-chat::effort=light');
  assert.deepEqual(calls, [['trae/models', { read: 'warm' }]]);
});

h.test('native effort selection is session scoped, preserves canonical preferences and exits Ultra atomically', async () => {
  const v = await vector(), root = await mkdtemp(join(tmpdir(), 'klaus-trae-effort-'));
  let fail = false;
  const changes: unknown[] = [];
  const request = async (method: string): Promise<unknown> => method === 'trae/models' ? { models: [v.family] } : { source: 'trae', selection: v.selection };
  const composer = new ComposerService({ configRoot: root, request, engineSettings: { providers: async () => ({}) } as unknown as EngineSettings,
    push: () => {}, onSessionConfigChanged: change => { changes.push(change); if (fail) throw new Error('publication failed'); } });
  try {
    setSessionModel('', 'custom:future', 'custom', root, { thinkingLevel: 'max' });
    setSessionModel('target', v.selection, 'trae', root, { thinkingLevel: 'high', ultraMode: true, updateDefaults: false });
    setSessionModel('other', 'custom:other', 'custom', root, { thinkingLevel: 'medium', updateDefaults: false });
    assert.deepEqual(await composer.setThinking({ sessionId: 'target', level: 'light', ultraMode: false }), { ok: true });
    assert.equal(readSessionModel('target', root).mode, 'trae:fixture-chat::effort=light');
    assert.equal(readSessionThinkingLevel('target', root), 'high');
    assert.equal(readSessionUltraMode('target', root), false);
    assert.equal(readSessionModel('', root).mode, 'custom:future');
    assert.equal(readSessionThinkingLevel('', root), 'max');
    assert.equal(readSessionModel('other', root).mode, 'custom:other');
    assert.equal(readSessionThinkingLevel('other', root), 'medium');
    assert.deepEqual(await composer.getThinking('target'), { level: 'light' });
    assert.deepEqual(await composer.setThinking({ sessionId: 'other', level: 'light' }), { error: 'invalid level' });
    fail = true;
    await assert.rejects(composer.setThinking({ sessionId: 'target', level: 'high' }), /publication failed/);
    assert.equal(readSessionModel('target', root).mode, 'trae:fixture-chat::effort=light');
    assert.equal(readSessionThinkingLevel('target', root), 'high');
    assert.equal(readSessionUltraMode('target', root), false);
    assert(changes.length >= 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('native effort changes resolve source-scoped model tier aliases before selecting a member', async () => {
  const v = await vector(), root = await mkdtemp(join(tmpdir(), 'klaus-trae-tier-effort-'));
  const resolutions: unknown[] = [];
  const composer = new ComposerService({ configRoot: root, request: async (method, params) => {
    if (method === 'trae/models') return { models: [v.family] };
    assert.equal(method, 'model/selection/resolve'); resolutions.push(params);
    assert.equal(object(params).source, 'trae');
    return { source: 'trae', selection: v.selection };
  }, push: () => {}, onSessionConfigChanged: () => {} });
  try {
    for (const alias of ['auto', 'high', 'medium', 'low']) {
      setSessionModel('target', alias, 'trae', root, { thinkingLevel: 'high', updateDefaults: false });
      assert.deepEqual(await composer.setThinking({ sessionId: 'target', level: 'light' }), { ok: true });
      assert.equal(readSessionModel('target', root).mode, 'trae:fixture-chat::effort=light');
      await composer.setModel({ sessionId: 'target', mode: alias, source: 'trae', thinkingLevel: 'light', updateDefaults: false });
      assert.equal(readSessionModel('target', root).mode, 'trae:fixture-chat::effort=light');
    }
    assert(resolutions.length >= 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('native members remain available to shared tiers and the mobile exact-selection projection', async () => {
  const v = await vector(), root = await mkdtemp(join(tmpdir(), 'klaus-trae-mobile-'));
  const deps = { configRoot: root, request: async () => ({ models: [v.family] }), engine: {} as EngineSettings, sourceStatus: async () => ({ loggedIn: true }) };
  try {
    const catalog = await sourceTierCatalog('trae', deps);
    assert.equal(catalog.status, 'ready');
    assert.equal(object(modelOptionForValue(catalog.options as JsonObject[], 'fixture-chat::effort=light')).modelId, 'fixture-chat::effort=light');
    assert.deepEqual(modelPreference({ source: 'trae', selection: 'trae:fixture-chat::effort=light', thinkingLevel: 'light' }), { source: 'trae', selection: 'trae:fixture-chat::effort=light', thinkingLevel: 'light' });
    assert.throws(() => modelConfigUpdate({ sessionId: null, source: 'custom', thinkingLevel: 'light' }));
    assert.deepEqual(modelConfigUpdate({ sessionId: 'target', thinkingLevel: 'light' }, 'trae'), { sessionId: 'target', thinkingLevel: 'light' });
    assert.throws(() => modelConfigUpdate({ sessionId: 'other', thinkingLevel: 'light' }, 'custom'));
    const composer = new ComposerService({ configRoot: root, request: deps.request, push: () => {}, onSessionConfigChanged: () => {} });
    const models = await composer.options('trae');
    const mobile = new MobileModelConfigProjection(async (channel): Promise<Json> => channel === 'trae-auth:status' ? { loggedIn: true } : channel === 'session:get-main-model-options' ? { options: models } : { loggedIn: false });
    const projected = await mobile.models('trae');
    assert.deepEqual(projected[0]!.supportedThinkingLevels, ['light', 'high']);
    await mobile.validate({ source: 'trae', selection: 'trae:fixture-chat::effort=light', thinkingLevel: 'light' });
    await assert.rejects(mobile.validate({ source: 'trae', selection: 'trae:fixture-chat::effort=light', thinkingLevel: 'undeclared' }), /reasoning level is unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('a mobile partial native-effort update resolves only its explicitly scoped current source', async () => {
  const f = await mobileFixture(), v = await vector();
  const composer = new ComposerService({ configRoot: f.root, request: async () => ({ models: [v.family] }), push: () => {}, onSessionConfigChanged: () => {} });
  setSessionModel('s2', v.selection, 'trae', f.root, { thinkingLevel: 'high', updateDefaults: false });
  setSessionModel('s1', 'custom:other', 'custom', f.root, { thinkingLevel: 'medium', updateDefaults: false });
  f.intercept(async (channel, payload): Promise<Json | undefined> => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (channel === 'trae-auth:status') return { loggedIn: true };
    if (channel === 'session:get-main-model') { const row = readSessionModel(sessionId, f.root); return { ...row, resolvedMode: row.mode }; }
    if (channel === 'session:get-thinking-level') return composer.getThinking(sessionId);
    if (channel === 'session:get-main-model-options' && payload.source === 'trae') return { options: await composer.options('trae') };
    if (channel === 'session:set-thinking-level') return composer.setThinking(payload);
    if (channel === 'session:set-main-model') return composer.setModel(payload);
    return undefined;
  });
  try {
    await f.enable();
    const result = await f.request('POST', '/api/mobile/model-config', { sessionId: 's2', thinkingLevel: 'light' });
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.equal(readSessionModel('s2', f.root).mode, 'trae:fixture-chat::effort=light');
    assert.equal(readSessionThinkingLevel('s2', f.root), 'high');
    assert.equal(readSessionModel('s1', f.root).mode, 'custom:other');
    const rejected = await f.request('POST', '/api/mobile/model-config', { sessionId: 's1', thinkingLevel: 'light' });
    assert.equal(rejected.status, 400);
    assert.equal(readSessionThinkingLevel('s1', f.root), 'medium');
    const unknown = await f.request('POST', '/api/mobile/model-config', { sessionId: 'unknown', thinkingLevel: 'light' });
    assert.equal(unknown.status, 404);
  } finally { await f.close(); }
});

h.test('a first mobile draft with no native effort control applies its model and preserves canonical defaults', async () => {
  const f = await mobileFixture(), v = await vector();
  const composer = new ComposerService({ configRoot: f.root, request: async () => ({ models: [{ key: 'plain', display_name: 'Plain', purpose: 'chat', available: true }, v.family] }), push: () => {}, onSessionConfigChanged: () => {} });
  setSessionModel('', 'custom:global', 'custom', f.root, { thinkingLevel: 'max' });
  f.intercept(async (channel, payload): Promise<Json | undefined> => {
    if (channel === 'trae-auth:status') return { loggedIn: true };
    if (channel === 'session:get-main-model-options' && payload.source === 'trae') return { options: await composer.options('trae') };
    if (channel === 'session:set-main-model') return composer.setModel(payload);
    return undefined;
  });
  try {
    await f.enable();
    const response = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'trae-no-effort', modelPreference: { source: 'trae', selection: 'trae:plain', thinkingLevel: 'medium' }, initialMessage: { text: 'First message', clientMessageId: 'trae-first' } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = f.sessions.find(row => row.id !== 's1' && row.id !== 's2')!.id as string;
    assert.equal(readSessionModel(id, f.root).mode, 'trae:plain');
    assert.equal(readSessionModel('', f.root).mode, 'custom:global');
    assert.equal(readSessionThinkingLevel('', f.root), 'max');
    assert.equal(f.sent.length, 1);
    assert.equal(f.calls.find(row => row.channel === 'session:set-main-model')!.payload.updateDefaults, false);
    const native = await f.request('POST', '/api/mobile/sessions', { clientDraftId: 'trae-native-effort', modelPreference: { source: 'trae', selection: v.selection, thinkingLevel: 'light' }, initialMessage: { text: 'Native effort', clientMessageId: 'trae-native-first' } });
    assert.equal(native.status, 201, JSON.stringify(native.body));
    const nativeId = f.sessions.find(row => !['s1', 's2', id].includes(row.id as string))!.id as string;
    assert.equal(readSessionModel(nativeId, f.root).mode, 'trae:fixture-chat::effort=light');
    assert.equal(readSessionModel('', f.root).mode, 'custom:global');
    assert.equal(readSessionThinkingLevel('', f.root), 'max');
    assert.equal(f.sent.length, 2);
  } finally { await f.close(); }
});

h.test('service-default image and video generation stay independent of the chat source and saved custom endpoints', async () => {
  const calls: Array<{ kind: string; params: JsonObject }> = [];
  const f = await mediaFixture({ deps: { trae: {
    status: async () => ({ loggedIn: true }),
    capabilities: async () => ({ image: { available: true }, imageEdit: { available: true, referenceImages: true }, video: { available: true } }),
    image: async params => { calls.push({ kind: 'image', params }); return { imageBase64: png.toString('base64'), mimeType: 'image/png' }; },
    video: async params => { calls.push({ kind: 'video', params }); return { videoBase64: mp4.toString('base64'), mimeType: 'video/mp4' }; },
    audio: async () => { throw new Error('Unexpected speech request'); },
  } } });
  try {
    f.config('custom', 'image', { model: 'unused-custom' });
    assert.equal(object(f.features.setImageSelection({ selection: 'trae', model: '' })).ok, true);
    assert.equal(object(f.features.setVideoSelection({ selection: 'trae', model: '' })).ok, true);
    const image = await f.service.execute('generate_image', { prompt: 'A blue square' }, f.context('custom'));
    assert.equal(object(image).success, true, resultText(image));
    const video = await f.service.execute('generate_video', { prompt: 'A moving square', seconds: 5 }, f.context('codex'));
    assert.equal(object(video).success, true, resultText(video));
    assert.deepEqual(calls.map(row => row.kind), ['image', 'video']);
    assert.equal(Object.hasOwn(calls[0]!.params, 'model'), false);
    assert.equal(Object.hasOwn(calls[1]!.params, 'model'), false);
    assert.equal(calls[1]!.params.seconds, 5);
    assert.equal(f.requests.length, 0);
    assert.equal(f.generated.length, 2);
    assert.equal(object(f.features.setImageSelection({ selection: 'trae', model: 'invented-model' })).ok, false);
  } finally { await f.close(); }
});

h.test('an explicit image-edit capability admits local references through the host media entrance', async () => {
  const calls: JsonObject[] = [];
  const f = await mediaFixture({ deps: { trae: {
    status: async () => ({ loggedIn: true }),
    capabilities: async () => ({ image: { available: true, referenceImages: true, models: [] }, imageEdit: { available: true, referenceImages: true, models: [] } }),
    image: async params => { calls.push(params); return { imageBase64: png.toString('base64'), mimeType: 'image/png' }; },
    video: async () => ({}), audio: async () => ({}),
  } } });
  try {
    const input = join(f.root, 'reference.png'); await writeFile(input, png);
    f.select('trae');
    const result = await f.service.execute('generate_image', { prompt: 'Change the circle to green', source_images: [input] }, f.context());
    assert.equal(object(result).success, true, resultText(result));
    assert.equal(calls.length, 1);
    assert.equal(object((calls[0]!.referenceImages as JsonObject[])[0]).mimeType, 'image/png');
    assert.equal(f.generated.length, 1);
  } finally { await f.close(); }
});

h.test('service-default image allowance remains source-scoped and every returned image is validated before publication', async () => {
  let invalid = false;
  const f = await mediaFixture({ deps: { trae: {
    status: async () => ({ loggedIn: true }), capabilities: async () => ({ image: { available: true } }),
    image: async () => ({ images: [{ imageBase64: png.toString('base64'), mimeType: 'image/png' }, { imageBase64: png.toString('base64'), mimeType: invalid ? 'image/jpeg' : 'image/png' }] }),
    video: async () => ({}), audio: async () => ({}),
  }, workbuddy: { status: async () => ({ loggedIn: true }), capabilities: async () => ({ image: { available: true } }),
    image: async () => { throw new Error('A source without a concrete model cannot run'); }, video: async () => ({}), audio: async () => ({}) } } });
  try {
    f.select('trae');
    assert.equal(object(await f.service.execute('generate_image', { prompt: 'Two images' }, f.context())).success, true);
    assert.equal(f.generated[0]!.paths.length, 2);
    invalid = true;
    const failed = await f.service.execute('generate_image', { prompt: 'Two images' }, f.context());
    assert.equal(object(failed).success, false);
    assert.match(resultText(failed), /media type/);
    assert.equal(f.generated.length, 1);
    f.select('workbuddy');
    const other = await f.service.execute('generate_image', { prompt: 'Missing model' }, f.context());
    assert.equal(object(other).success, false);
    assert.match(resultText(other), /configuration is no longer available/);
    assert.equal(f.generated.length, 1);
  } finally { await f.close(); }
});

h.test('subscription transcription and streaming readiness use the Trae facade without exposing custom credentials', async () => {
  const calls: Array<{ method: string; params: Json }> = [];
  const client = { isClosed: () => false, on: () => {}, off: () => {}, requestWithTimeout: async (method: string, params: Json): Promise<Json> => {
    calls.push({ method, params });
    if (method === 'trae/status') return { loggedIn: true };
    if (method === 'trae/capabilities') return { transcription: { available: true, streaming: true } };
    if (method === 'trae/transcribeAudio') return { text: 'The complete recording.' };
    throw new Error(`Unexpected voice method ${method}`);
  } };
  const connection = { client, generation: 1 } as unknown as VoiceEngineConnection;
  const access = voiceModelAccess({ providers: async () => { throw new Error('No custom credential access'); } }, async () => { throw new Error('No separate transport'); }, '/tmp/unused-trae-voice', () => connection);
  const signal = new AbortController().signal;
  assert.equal(await access.streaming!.available('trae', signal), true);
  assert.equal(await access.transcriptionAvailable!('trae', signal), true);
  assert.equal(await access.transcribeAudio!('trae', { operationId: 'transcription', audioBase64: 'AQID', mimeType: 'audio/wav' }, signal), 'The complete recording.');
  assert.equal(calls.at(-1)!.method, 'trae/transcribeAudio');
  assert.deepEqual(calls.at(-1)!.params, { operationId: 'transcription', audioBase64: 'AQID', mimeType: 'audio/wav' });
});

void h.finish(join(__dirname, 'trae-result.json'), 'trae').then(code => { process.exitCode = code; });
