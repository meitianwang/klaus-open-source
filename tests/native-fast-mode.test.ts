import type { Json } from '../main/ipc/contract';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComposerService, type ComposerChange } from '../main/services/composer';
import { buildSessionInitAsync } from '../main/services/session-init';
import { forgetEphemeralPreferences, inheritSessionComposerPreferences, readSessionFastMode, readSessionModel, readSessionThinkingLevel, setSessionFastMode, setSessionModel } from '../main/services/session-store';
import { kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { object, string, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { fastModePreferenceKey, pickFastModeMetadata } from '../shared/model-fast-mode';
import { applyModelPreference, modelConfigUpdate, MobileModelConfigProjection } from '../main/services/mobile/model-config';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';
import { registerCursorComposerControlTests } from './cursor-composer-controls';

process.env.KLAUS_TEST = '1';
const h = new Harness(), roots: string[] = [];
const freshRoot = () => { const root = mkdtempSync(join(tmpdir(), 'klaus-native-fast-')); roots.push(root); return root; };
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/native-fast-mode-vectors.json'), 'utf8')) as {
  cases: Array<{ source: string; supported: boolean; fastBilling?: 'extraCredits'; name?: string; metadata?: JsonObject }>;
};
function requestFor(source: string, supported: boolean, fastBilling?: 'extraCredits', metadata?: JsonObject): EngineRequest {
  return async (method, params) => {
    if (method === 'model/selection/resolve') return { source: object(params).source!, selection: object(params).selection! };
    if (method === `${source}/models`) return { models: [{ alias: 'fixture', key: 'fixture', label: 'Fixture',
      ...(metadata ?? { fastMode: supported, capabilities: { fastMode: supported } }), ...(fastBilling ? { fastBilling } : {}) }] };
    if (method.endsWith('/setThinkingLevel')) return {};
    throw new Error(`Unexpected request: ${method}`);
  };
}
for (const row of vectors.cases) h.test(row.name ?? `${row.source} catalog Fast=${row.supported} controls the common setter and init`, async () => {
  const root = freshRoot(), changes: ComposerChange[] = [], request = requestFor(row.source, row.supported, row.fastBilling, row.metadata);
  const service = new ComposerService({ configRoot: root, request, push: () => {}, onSessionConfigChanged: change => { changes.push(change); } });
  const mode = `${row.source}:fixture`;
  setSessionModel('one', mode, row.source, root);
  setSessionModel('two', mode, row.source, root);
  const state = { enabled: false, supported: row.supported, ...(row.fastBilling ? { billing: row.fastBilling } : {}) };
  assertDeepEqual(await service.getFastMode('one'), state, 'catalog eligibility and billing');
  const options = await service.options(row.source);
  assertDeepEqual(pickFastModeMetadata(options[0]), { supportsFastMode: row.supported, ...(row.fastBilling ? { fastBilling: row.fastBilling } : {}) }, 'safe catalog metadata');
  if (row.supported) {
    await service.setFastMode({ sessionId: 'one', enabled: true });
    assertEqual(readSessionFastMode('one', root), true, 'current conversation persists');
    assertEqual(readSessionFastMode('two', root), false, 'other conversation remains unchanged');
    assertEqual(kvGet(fastModePreferenceKey(row.source)!, root), 'true', 'source-specific future default');
    setSessionModel('future', mode, row.source, root);
    assertEqual(readSessionFastMode('future', root), true, 'future conversation inherits only this source default');
    assertDeepEqual(readSessionModel('one', root), { source: row.source, mode }, 'native request Fast preserves model key');
    assertDeepEqual(changes, [{ kind: 'fast', sessionId: 'one' }], 'scoped inference publication');
  } else {
    await assertRejects(() => service.setFastMode({ sessionId: 'one', enabled: true }), 'unsupported model rejected');
    assertEqual(kvGet(fastModePreferenceKey(row.source)!, root), null, 'rejected pick does not create a default');
  }
  const init = await buildSessionInitAsync({ rendererId: 'one', cwd: root, configRoot: root }, { request });
  assert(init.ok, 'named facade session init succeeds');
  assertEqual(object(init.init.config).fastMode, row.supported ? true : undefined, 'only eligible native request gets Fast');
});
h.test('source preferences and inherited conversations never share Fast defaults across providers', () => {
  const root = freshRoot();
  kvSet('composer.codex_fast_mode', 'true', root);
  setSessionModel('parent', 'codex:fixture', 'codex', root);
  assertEqual(readSessionFastMode('parent', root), true, 'legacy Codex default retained');
  for (const source of ['subscription', 'qoder']) {
    setSessionModel('parent', `${source}:fixture`, source, root);
    assertEqual(readSessionFastMode('parent', root), false, 'new source starts independently');
    setSessionFastMode('parent', true, root, source);
    inheritSessionComposerPreferences('parent', `child-${source}`, root);
    assertEqual(readSessionFastMode(`child-${source}`, root), true, 'fork captures current source');
  }
  setSessionModel('parent', 'custom:fixture', 'custom', root);
  assertEqual(readSessionFastMode('parent', root), false, 'unsupported source suppresses preference');
  setSessionModel('parent', 'codex:fixture', 'codex', root);
  assertEqual(readSessionFastMode('parent', root), true, 'return restores Codex preference');
  setSessionModel('parent', 'subscription:fixture', 'subscription', root);
  assertEqual(readSessionFastMode('parent', root), true, 'return restores that source only');
  forgetEphemeralPreferences('parent', root);
  kvSet('composer.subscription_fast_mode', 'false', root);
  assertEqual(readSessionFastMode('parent', root, 'subscription'), false, 'deleted conversation has no orphan source preference');
});
h.test('new native Fast migrations keep existing conversations Standard and session-only writes preserve defaults', async () => {
  const root = freshRoot();
  setSessionModel('existing', 'subscription:fixture', 'subscription', root);
  withSettingsDb(root, db => {
    db.prepare('DELETE FROM settings WHERE key = ?').run('migrated.composer_native_fast_sources_v1');
    db.prepare('DELETE FROM session_source_fast_modes').run();
  });
  kvSet('composer.subscription_fast_mode', 'true', root);
  assertEqual(readSessionFastMode('existing', root), false, 'an unopened existing conversation is not opted in');
  kvSet('composer.subscription_fast_mode', 'false', root);
  const service = new ComposerService({ configRoot: root, request: requestFor('subscription', true), push: () => {}, onSessionConfigChanged: () => {} });
  await service.setFastMode({ sessionId: 'existing', enabled: true, updateDefaults: false });
  assertEqual(readSessionFastMode('existing', root), true, 'session-only Fast selection applied');
  assertEqual(kvGet('composer.subscription_fast_mode', root), 'false', 'future source default unchanged');
});
h.test('catalog waits cannot write Fast into a newly selected source', async () => {
  const root = freshRoot(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const request = requestFor('subscription', true);
  const service = new ComposerService({ configRoot: root, push: () => {}, onSessionConfigChanged: () => {}, request: async (method, params) => {
    if (method === 'subscription/models') { enter(); await gate; }
    return request(method, params);
  } });
  setSessionModel('one', 'subscription:fixture', 'subscription', root);
  const pending = service.setFastMode({ sessionId: 'one', enabled: true });
  await entered;
  setSessionModel('one', 'codex:fixture', 'codex', root);
  release();
  await assertRejects(() => pending, 'stale source rejected');
  assertEqual(kvGet('composer.subscription_fast_mode', root), null, 'no stale default write');
});
h.test('mobile Fast updates are typed and project authoritative capability metadata', async () => {
  assertDeepEqual(modelConfigUpdate({ sessionId: 'one', fastMode: true }), { sessionId: 'one', fastMode: true }, 'Fast-only update');
  let rejected = false;
  try { modelConfigUpdate({ sessionId: 'one', fastMode: 'true' }); } catch { rejected = true; }
  assert(rejected, 'strings are not accepted as booleans');
  const calls: JsonObject[] = [];
  const projection = new MobileModelConfigProjection(async (channel, payload): Promise<Json> => {
    if (channel === 'session:get-main-model') return { source: 'subscription', mode: 'subscription:fixture', resolvedMode: 'subscription:fixture' };
    if (channel === 'session:get-thinking-level') return { level: 'high' };
    if (channel === 'session:get-ultra-mode') return { enabled: false };
    if (channel === 'session:get-fast-mode') return { enabled: true, supported: true, billing: 'extraCredits' };
    if (channel === 'auth:status') return { loggedIn: true };
    if (channel.endsWith('auth:status') || channel.endsWith('-auth:status')) return { loggedIn: false };
    if (channel === 'settings:models:list') return [];
    if (channel === 'session:get-main-model-options') return { options: [{ value: 'subscription:fixture', label: 'Fixture', supportsFastMode: true, fastBilling: 'extraCredits' }] };
    throw new Error(`Unexpected mobile read: ${channel} ${string(object(payload).source)}`);
  }, () => 1);
  const snapshot = await projection.snapshot('one');
  assertEqual(snapshot.fastMode, true, 'effective Fast state');
  assertEqual(snapshot.fastModeSupported, true, 'effective support');
  assertEqual(snapshot.fastModeBilling, 'extraCredits', 'billing notice independent of allowance');
  assertEqual(object((snapshot.models as JsonObject[])[0]).supportsFastMode, true, 'model capability retained');
  await applyModelPreference(async (channel, payload) => { calls.push({ channel, ...object(payload) }); return { ok: true }; }, 'one', { source: 'subscription', selection: 'subscription:fixture', thinkingLevel: 'high', fastMode: true });
  assertEqual(calls.length, 1, 'one atomic named configuration update');
  assertEqual(calls[0]?.channel, 'session:set-main-model', 'existing named model channel');
  assertEqual(calls[0]?.fastMode, true, 'typed native flag');
});
h.test('combined request Fast updates persist one source and conversation without changing future defaults', async () => {
  const root = freshRoot(), changes: ComposerChange[] = [];
  const service = new ComposerService({ configRoot: root, request: requestFor('subscription', true), push: () => {}, onSessionConfigChanged: change => { changes.push(change); } });
  setSessionModel('one', 'codex:fixture', 'codex', root);
  await service.setModel({ sessionId: 'one', mode: 'subscription:fixture', source: 'subscription', thinkingLevel: 'high', fastMode: true, updateDefaults: false });
  assertEqual(readSessionFastMode('one', root), true, 'source Fast saved with model');
  assertEqual(readSessionFastMode('one', root, 'codex'), false, 'other source preference unchanged');
  assertEqual(kvGet('composer.subscription_fast_mode', root), null, 'future Fast default unchanged');
  assertEqual(kvGet('composer.main_model', root), 'codex:fixture', 'future model default unchanged');
  assertDeepEqual(changes, [{ kind: 'model', sessionId: 'one' }], 'one complete configuration publication');
});
h.test('combined model reasoning and Fast changes validate the final native member before mutation', async () => {
  const root = freshRoot(), changes: ComposerChange[] = [];
  const key = (effort: string, fast: boolean) => `cursor:fixture[fast=${fast},reasoning_effort=${effort}]`;
  const initial = key('high', false);
  const models = [['high', false], ['high', true], ['low', false]].map(([effort, fast]) => ({
    key: key(String(effort), Boolean(fast)).slice(7), modelId: 'fixture', modelName: 'Fixture',
    requestedModel: { modelId: 'fixture', maxMode: false, parameters: [{ id: 'reasoning_effort', value: String(effort) }, { id: 'fast', value: String(fast) }] },
  }));
  const service = new ComposerService({ configRoot: root, push: () => {}, onSessionConfigChanged: change => { changes.push(change); }, request: async method => {
    if (method === 'cursor/models') return { models };
    throw new Error(`Unexpected request: ${method}`);
  } });
  setSessionModel('one', initial, 'cursor', root, { thinkingLevel: 'high' });
  await assertRejects(() => service.setModel({ sessionId: 'one', mode: initial, source: 'cursor', thinkingLevel: 'low', fastMode: true }), 'missing final combination rejected');
  assertEqual(readSessionModel('one', root).mode, initial, 'saved exact member unchanged');
  assertEqual(readSessionThinkingLevel('one', root), 'high', 'saved reasoning unchanged');
  assertEqual(kvGet('composer.main_model', root), initial, 'future model default unchanged');
  assertDeepEqual(changes, [], 'no partial inference publication');
  await service.setModel({ sessionId: 'one', mode: initial, source: 'cursor', thinkingLevel: 'high', fastMode: true, updateDefaults: false });
  assertEqual(readSessionModel('one', root).mode, key('high', true), 'compatible final exact member saved');
  assertEqual(kvGet('composer.main_model', root), initial, 'session-only future default unchanged');
  assertDeepEqual(changes, [{ kind: 'model', sessionId: 'one' }], 'one complete inference publication');
  await service.setModel({ sessionId: 'one', mode: key('high', true), source: 'cursor', thinkingLevel: 'low', fastMode: false, updateDefaults: false });
  assertEqual(readSessionModel('one', root).mode, key('low', false), 'combined edit does not require an unavailable intermediate member');
});
registerCursorComposerControlTests(h, freshRoot);
void (async () => {
  const failed = await h.finish(`${__dirname}/native-fast-mode-result.json`, 'native-fast-mode');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(failed);
})();
