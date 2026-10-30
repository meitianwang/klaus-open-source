import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { AUTH_MODES } from '../main/services/model-sources';
import { AUTH_CHANNELS } from '../main/ipc/handlers/auth';
import { ComposerService } from '../main/services/composer';
import type { EngineSettings } from '../main/services/engine-settings';
import { readSessionModel, readSessionThinkingLevel, readSessionUltraMode, setSessionModel, modelSource, validModelSelection } from '../main/services/session-store';
import { mainModelSource } from '../main/services/session-init';
import { SubscriptionAuthService, type SubscriptionAuthDeps } from '../main/services/subscription-auth';
import { readKiroCredential } from '../main/services/kiro-credential';
import { kiroUsage } from '../main/services/usage';
import { object } from '../main/services/service-types';
import { modelOptionForValue, modelOptionHasValue } from '../shared/cursor-model-catalog';
import { pickKiroModelMetadata, kiroThinkingLevels, kiroThinkingLevel } from '../shared/kiro-model-catalog';
import { modelConfigUpdate } from '../main/services/mobile/model-config';
import { SUBSCRIPTION_WEB_SEARCH_SOURCES } from '../contracts/web-search-settings';
import { rpcAdmission } from '../main/engine/request-scheduler';
import { MobileProjection } from '../main/services/mobile/projection';
import { Harness, waitFor } from './harness';

const h = new Harness();
const vector = () => readFile(join(__dirname, '../../contracts/vectors/kiro-source-vectors.json'), 'utf8').then(JSON.parse);
const start = (flowId = 'fixture-flow') => ({ ok: true, flowId, authUrl: 'https://app.kiro.dev/signin?state=fixture' });
async function authFixture(overrides: Partial<SubscriptionAuthDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-kiro-host-'));
  const calls: Array<{ method: string; params: unknown }> = [], opened: string[] = [];
  let publications = 0;
  const service = new SubscriptionAuthService({ configRoot: root, homeDir: root,
    request: async (method, params) => { calls.push({ method, params }); return method === 'kiro/loginStart' ? start() : { ok: true, loggedIn: true }; },
    openExternal: async url => { opened.push(url); }, onAuthChanged: () => { publications++; }, ...overrides });
  return { root, service, calls, opened, publications: () => publications, close: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}

h.test('Kiro retains explicit model identity and independent search selection', async () => {
  const v = await vector();
  assert((AUTH_MODES as readonly string[]).includes(v.source));
  assert.equal(mainModelSource(v.selection), 'kiro');
  assert.equal(modelSource(v.selection), 'kiro');
  assert(validModelSelection(v.selection));
  for (const action of ['status', 'start', 'poll', 'cancel', 'import-local', 'logout', 'models']) assert((AUTH_CHANNELS as readonly string[]).includes(`kiro-auth:${action}`));
  assert((SUBSCRIPTION_WEB_SEARCH_SOURCES as readonly string[]).includes('kiro'));
  assert.equal(rpcAdmission('kiro/loginCancel', {}, 1000).priority, 'critical');
  assert.equal(rpcAdmission('kiro/cancelOperation', {}, 1000).priority, 'critical');
});

h.test('Kiro excludes routing aliases from cached catalogs and phone choices', async () => {
  const v = await vector(), root = await mkdtemp(join(tmpdir(), 'klaus-kiro-catalog-'));
  const reads: unknown[] = [];
  const composer = new ComposerService({ configRoot: root, request: async (_method, params) => {
    reads.push(params);
    return { models: [{ key: 'auto', display_name: 'Auto' }, { key: 'auto::effort=max', display_name: 'Auto' }, v.family] };
  }, engineSettings: { providers: async () => ({}) } as unknown as EngineSettings, push: () => {}, onSessionConfigChanged: () => {} });
  try {
    for (const read of ['warm', 'cached'] as const) {
      assert.deepEqual((await composer.options('kiro', false, read)).map(row => object(row).value), ['kiro:fixture-chat']);
    }
    assert.equal(reads.length, 2);
    assert((await composer.options('qoder')).some(row => object(row).value === 'qoder:auto'));
    const phone = new MobileProjection(async (channel): Promise<Json> => {
      if (channel === 'session:get-main-model') return { source: 'kiro', mode: 'kiro:fixture-chat' };
      if (channel === 'session:get-main-model-options') return { options: [{ value: 'kiro:auto', label: 'Auto' }, { value: 'kiro:fixture-chat', label: 'Fixture Chat' }] };
      return {};
    }, () => undefined, new Set(), new Set());
    const state = await phone.runtimeConfig(null);
    assert.deepEqual((state.mainModelOptions as any[]).map(row => row.value), ['kiro:fixture-chat']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

h.test('Kiro browser login retires committed authorization before account publication', async () => {
  let service!: SubscriptionAuthService;
  const f = await authFixture({ onAuthChanged: async () => { await service.kiroCancel('fixture-flow'); } }); service = f.service;
  try {
    assert.equal(object(await service.kiroStart()).ok, true);
    assert.deepEqual(f.opened, [start().authUrl]);
    assert.equal(object(await service.kiroPoll('fixture-flow')).ok, true);
    assert.deepEqual(f.calls.map(row => row.method), ['kiro/loginStart', 'kiro/loginPoll']);
  } finally { await f.close(); }
});

h.test('Kiro login rejects unsafe browser handoff without changing existing sources', async () => {
  for (const authUrl of ['http://app.kiro.dev/signin', 'https://app.kiro.dev.invalid/signin', 'https://app.kiro.dev/other', 'https://user:pass@app.kiro.dev/signin', 'https://app.kiro.dev/signin#fragment']) {
    const f = await authFixture({ request: async method => method === 'kiro/loginStart' ? { ...start(), authUrl } : { ok: true } });
    try { assert.deepEqual(await f.service.kiroStart(), { ok: false, error: 'kiro_login_url_invalid' }); assert.deepEqual(f.opened, []); }
    finally { await f.close(); }
  }
});

h.test('Kiro cancellation fences delayed polls and never cancels a replacement flow', async () => {
  let release!: (value: unknown) => void, starts = 0, polling = false;
  const pending = new Promise(resolve => { release = resolve; });
  const f = await authFixture({ request: async method => {
    if (method === 'kiro/loginStart') return start(++starts === 1 ? 'old' : 'new');
    if (method === 'kiro/loginPoll' && !polling) { polling = true; return pending; }
    return { ok: true };
  } });
  try {
    await f.service.kiroStart();
    const poll = f.service.kiroPoll('old');
    await waitFor(() => polling, 1000, 'the pending poll starts');
    await f.service.kiroCancel('old');
    const next = f.service.kiroStart(); release({ ok: true });
    assert.equal(object(await poll).error, 'kiro_login_cancelled');
    assert.equal(object(await next).flowId, 'new');
    await f.service.kiroCancel('old');
    assert.equal(object(await f.service.kiroPoll('new')).ok, true);
    assert.equal(f.publications(), 1);
  } finally { release({ ok: true }); await f.close(); }
});

h.test('local Kiro adoption reads a bounded allowlist and leaves the external grant intact', async () => {
  const f = await authFixture();
  const dir = join(f.root, '.aws/sso/cache'), path = join(dir, 'kiro-auth-token.json');
  const raw = JSON.stringify({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh', profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/test', expiresAt: new Date(Date.now() + 60_000).toISOString(), authMethod: 'social', provider: 'Google', arbitrarySecret: 'must-not-copy' });
  try {
    await mkdir(dir, { recursive: true }); await writeFile(path, raw);
    const credential = await readKiroCredential(f.root);
    assert.equal(credential.accessToken, 'fixture-access'); assert.equal(credential.arbitrarySecret, undefined);
    assert.equal(object(await f.service.kiroImportLocal()).ok, true);
    assert.deepEqual(f.calls.map(row => row.method), ['kiro/adoptCredential']);
    assert.equal(object(f.calls.at(0)?.params).localFollow, true);
    assert.equal(await readFile(path, 'utf8'), raw);
    await writeFile(path, JSON.stringify({ ...JSON.parse(raw), expiresAt: '2020-01-01T00:00:00.000Z' }));
    await assert.rejects(readKiroCredential(f.root), /kiro_local_expired/);
    await writeFile(path, 'x'.repeat(128 * 1024 + 1));
    await assert.rejects(readKiroCredential(f.root), /kiro_local_unreadable/);
  } finally { await f.close(); }
});

h.test('Kiro quota keeps decimal precision and excludes expired trial pools', async () => {
  const v = await vector(), projected = kiroUsage(v.quota), windows = projected.windows as any[];
  assert.equal(windows.length, 1);
  assert.equal(windows[0].used, 2.28); assert.equal(windows[0].remaining, 47.72);
  assert.equal(windows[0].total, 50); assert.equal(windows[0].resetsAt, 1793491200000);
  assert.equal(projected.plan, 'KIRO FREE');
  const missing = kiroUsage({ signedIn: true, usageBreakdownList: [{ currentUsageWithPrecision: 0 }] });
  assert.equal((missing.windows as any[])[0].total, undefined);
  assert.equal((missing.windows as any[])[0].remaining, undefined);
});

h.test('Kiro exact native efforts preserve restricted members without changing shared preferences', async () => {
  const v = await vector(), root = await mkdtemp(join(tmpdir(), 'klaus-kiro-effort-'));
  const composer = new ComposerService({ configRoot: root, request: async method => method === 'kiro/models' ? { models: [v.family] } : { source: 'kiro', selection: v.selection }, engineSettings: { providers: async () => ({}) } as unknown as EngineSettings, push: () => {}, onSessionConfigChanged: () => {} });
  try {
    const rows = await composer.options('kiro');
    assert.equal(rows.length, 1); assert.equal(object(rows[0]).available, false);
    assert.deepEqual(kiroThinkingLevels(pickKiroModelMetadata(rows[0])), ['none', 'high', 'max']);
    assert(modelOptionHasValue(rows[0], v.selection));
    assert.equal(object(modelOptionForValue(rows, v.selection)).value, v.selection);
    setSessionModel('', 'custom:future', 'custom', root, { thinkingLevel: 'high' });
    setSessionModel('target', v.selection, 'kiro', root, { thinkingLevel: 'medium', ultraMode: true, updateDefaults: false });
    setSessionModel('other', 'custom:other', 'custom', root, { thinkingLevel: 'low', updateDefaults: false });
    assert.deepEqual(await composer.setThinking({ sessionId: 'target', level: 'none' }), { ok: true });
    assert.equal(readSessionModel('target', root).mode, 'kiro:fixture-chat::effort=none');
    assert.equal(readSessionThinkingLevel('target', root), 'medium'); assert.equal(readSessionUltraMode('target', root), false);
    assert.equal(readSessionModel('', root).source, 'custom'); assert.equal(readSessionThinkingLevel('other', root), 'low');
    assert.equal(kiroThinkingLevel(pickKiroModelMetadata(rows[0]), v.selection), 'max');
    assert.equal(modelConfigUpdate({ sessionId: 'target', source: 'kiro', thinkingLevel: 'max' }).thinkingLevel, 'max');
    assert.throws(() => modelConfigUpdate({ sessionId: 'other', source: 'custom', thinkingLevel: 'kiro-only' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

void h.finish(join(__dirname, 'kiro-result.json'), 'kiro').then(code => { process.exitCode = code; });
