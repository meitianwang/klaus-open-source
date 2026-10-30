import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry, IpcHandlerError } from '../main/ipc/registry';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { GLOBAL_MODEL_TIERS_KEY, readModelTierMapping, setModelTierMapping } from '../main/services/model-tier-settings';
import { kvGet, kvSet } from '../main/services/settings';
import { readSessionModel, setSessionModel } from '../main/services/session-store';
import { object, type EngineRequest } from '../main/services/service-types';
import { assert, assertDeepEqual, assertEqual, assertRejects, type Harness } from './harness';

function thrownCode(action: () => unknown): string {
  try { action(); } catch (error) { return error instanceof IpcHandlerError ? error.code : String(error); }
  throw new Error('Expected the invalid mutation to fail');
}
async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel);
  assert(handler, 'tier channel registered');
  return handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] });
}
export function registerModelTierSettingsTests(h: Harness, freshRoot: () => string): void {
  h.test('shared tier migration matches the committed source-qualified vectors', () => {
    const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/global-model-tier-vectors.json'), 'utf8')) as {
      storageCases: Array<{ name: string; source: string; legacy: string; warning?: string; expected: Record<string, Json> }>;
    };
    for (const row of vectors.storageCases) {
      const root = freshRoot(); kvSet('auth_mode', row.source, root); kvSet('model_tiers:' + row.source, row.legacy, root);
      const mapping = readModelTierMapping(root);
      assertDeepEqual({ high: mapping.high, medium: mapping.medium, low: mapping.low }, row.expected, row.name);
      assertEqual(mapping.migration?.warning, row.warning, row.name + ' warning');
      assertEqual(kvGet('model_tiers:' + row.source, root), row.legacy, row.name + ' evidence');
    }
  });
  h.test('shared tiers migrate only the remembered default source and retain old source rows', () => {
    const root = freshRoot();
    kvSet('auth_mode', 'custom', root);
    kvSet('model_tiers:custom', JSON.stringify({ high: 'strong', medium: 'regular', low: 'fast' }), root);
    kvSet('model_tiers:codex', JSON.stringify({ high: 'other' }), root);
    const first = readModelTierMapping(root);
    assertDeepEqual(first.high, { source: 'custom', modelId: 'strong' }, 'source identity migrated');
    assertDeepEqual(first.medium, { source: 'custom', modelId: 'regular' }, 'medium migrated');
    assertDeepEqual(first.low, { source: 'custom', modelId: 'fast' }, 'low migrated');
    kvSet('auth_mode', 'codex', root);
    assertDeepEqual(readModelTierMapping(root), first, 'switching the default does not replace global mapping');
    assertEqual(kvGet('model_tiers:codex', root), '{"high":"other"}', 'other source retained');
    assertEqual(kvGet('model_tiers:custom', root), '{"high":"strong","medium":"regular","low":"fast"}', 'migration evidence retained');
  });
  h.test('the migration record is internal evidence that saves never rewrite', () => {
    const root = freshRoot();
    kvSet('auth_mode', 'custom', root);
    kvSet('model_tiers:custom', JSON.stringify({ high: 'strong', medium: 'regular', low: 'fast' }), root);
    const migrated = readModelTierMapping(root);
    assertEqual(migrated.migration?.source, 'custom', 'import source recorded once');
    const saved = setModelTierMapping('high', { source: 'custom', modelId: 'strong' }, migrated.revision, root);
    assertDeepEqual(saved.migration, migrated.migration, 'saving a tier leaves the record untouched');
    const brokenRoot = freshRoot();
    kvSet('auth_mode', 'custom', brokenRoot);
    kvSet('model_tiers:custom', '{broken', brokenRoot);
    const broken = readModelTierMapping(brokenRoot);
    assertEqual(broken.migration?.warning, 'invalid_legacy_mapping', 'warning present before any save');
    const brokenSaved = setModelTierMapping('high', null, broken.revision, brokenRoot);
    assertEqual(brokenSaved.migration?.warning, 'invalid_legacy_mapping', 'warning survives a save');
  });
  h.test('retired source rows stay migration evidence and never become routes', () => {
    const root = freshRoot();
    kvSet('auth_mode', 'local', root);
    assertEqual(kvGet('auth_mode', root), 'custom', 'a retired stored mode normalizes on write');
    kvSet('model_tiers:local', '{"low":"replacement"}', root);
    const mapping = readModelTierMapping(root);
    assertEqual(mapping.low, null, 'a retired source row is evidence, not a route');
    const cleared = setModelTierMapping('low', null, mapping.revision, root);
    assertEqual(readModelTierMapping(root).revision, cleared.revision, 'read does not rewrite revision');
  });
  h.test('malformed legacy mappings are retained with a warning and malformed global mappings fail closed', () => {
    const root = freshRoot(); kvSet('auth_mode', 'custom', root);
    kvSet('model_tiers:custom', '{broken', root);
    const mapping = readModelTierMapping(root);
    assertEqual(mapping.migration?.warning, 'invalid_legacy_mapping', 'migration warning');
    assertEqual(mapping.high, null, 'no guessed target');
    assertEqual(kvGet('model_tiers:custom', root), '{broken', 'bad legacy evidence retained');
    kvSet(GLOBAL_MODEL_TIERS_KEY, '{broken', root);
    assertEqual(thrownCode(() => readModelTierMapping(root)), 'MODEL_TIER_MAPPING_INVALID', 'malformed global config refuses');
    assertEqual(kvGet(GLOBAL_MODEL_TIERS_KEY, root), '{broken', 'malformed global value not overwritten');
  });
  h.test('tier compare-and-swap preserves other tiers and conversation main models', () => {
    const root = freshRoot(); setSessionModel('a', 'custom:main-a', 'custom', root); setSessionModel('b', 'codex:main-b', 'codex', root);
    const mainA = readSessionModel('a', root), mainB = readSessionModel('b', root), initial = readModelTierMapping(root);
    const first = setModelTierMapping('high', { source: 'subscription', modelId: 'opus' }, initial.revision, root);
    const second = setModelTierMapping('low', { source: 'custom', modelId: 'fast' }, first.revision, root);
    assertDeepEqual(second.high, first.high, 'editing low preserves high');
    assertEqual(thrownCode(() => setModelTierMapping('medium', { source: 'custom', modelId: 'regular' }, initial.revision, root)), 'MODEL_TIER_REVISION_CONFLICT', 'stale editor refuses');
    assertDeepEqual(readModelTierMapping(root), second, 'conflict does not mutate mapping');
    assertDeepEqual(readSessionModel('a', root), mainA, 'main A unchanged');
    assertDeepEqual(readSessionModel('b', root), mainB, 'main B unchanged');
    assertEqual(thrownCode(() => setModelTierMapping('unknown', null, second.revision, root)), 'BAD_REQUEST', 'unknown tier refuses');
    assertEqual(thrownCode(() => setModelTierMapping('medium', { source: 'unknown', modelId: 'm' }, second.revision, root)), 'BAD_REQUEST', 'unknown source refuses');
  });
  h.test('Cursor auxiliary tiers reject aliases without changing the saved mapping', () => {
    const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/global-model-tier-vectors.json'), 'utf8')) as { invalidCursorModels: string[] };
    const root = freshRoot(), original = readModelTierMapping(root);
    for (const modelId of vectors.invalidCursorModels) {
      assertEqual(thrownCode(() => setModelTierMapping('high', { source: 'cursor', modelId }, original.revision, root)), 'BAD_REQUEST', 'aliases require a concrete selection');
      assertDeepEqual(readModelTierMapping(root), original, 'refused target cannot change another tier or its revision');
    }
  });
  h.test('tier IPC validates catalog membership, never exposes credentials and blocks legacy writes', async () => {
    const root = freshRoot(); kvSet('auth_mode', 'custom', root); kvSet('model_tiers:custom', '{}', root);
    const changed: string[] = [], registry = new ChannelRegistry();
    let credentialReads = 0;
    const request: EngineRequest = async (method, params) => {
      if (method === 'config/read') return { values: { modelProviders: { fast: { provider: 'openai', model: 'small', name: 'Fast' }, missing: { provider: 'openai', model: 'missing', name: 'No key' } } }, resolved: {} };
      if (method === 'model/credential/read') { credentialReads++; return object(params).id === 'fast' ? { apiKey: 'fixture-private-key' } : {}; }
      throw new Error('Unexpected fixture RPC ' + method);
    };
    registerSettingsHandlers(registry, { configRoot: root, request, onSettingsChanged: key => { changed.push(key); }, sourceStatus: async () => ({ loggedIn: false }) });
    const initial = object(object(await invoke(registry, 'settings:models:tiers:get')).mapping);
    const updated = object(await invoke(registry, 'settings:models:tiers:set', { tier: 'low', target: { source: 'custom', modelId: 'fast' }, expectedRevision: initial.revision! }));
    assertDeepEqual(object(updated.mapping).low, { source: 'custom', modelId: 'fast' }, 'cross-source target saved');
    assertDeepEqual(changed, [GLOBAL_MODEL_TIERS_KEY], 'only inference mapping invalidated');
    const catalog = await invoke(registry, 'settings:models:tiers:options');
    assert(!JSON.stringify(catalog).includes('fixture-private-key'), 'credentials never cross bridge');
    assertEqual(object(object(catalog).tiers).low && object(object(object(catalog).tiers).low).status, 'ready', 'configured custom tier ready');
    await invoke(registry, 'settings:models:tiers:set', { tier: 'high', target: { source: 'custom', modelId: 'missing' }, expectedRevision: 1 });
    assertDeepEqual(readModelTierMapping(root).high, { source: 'custom', modelId: 'missing' }, 'a declared model remains selectable before credentials are configured');
    assertEqual(credentialReads, 0, 'catalog membership never requests model credentials');
    const deleted = await assertRejects(() => invoke(registry, 'settings:models:tiers:set', { tier: 'high', target: { source: 'custom', modelId: 'gone' }, expectedRevision: 2 }), 'deleted model');
    assertEqual((deleted as IpcHandlerError).code, 'MODEL_TIER_TARGET_UNAVAILABLE', 'unknown model fails');
    const legacy = await assertRejects(() => invoke(registry, 'settings:kv:set', { key: 'model_tiers:custom', value: '{}' }), 'retired write');
    assertEqual((legacy as IpcHandlerError).code, 'MODEL_TIER_API_REQUIRED', 'legacy mapping is read-only');
    const omitted = await assertRejects(() => invoke(registry, 'settings:models:tiers:set', { tier: 'low', expectedRevision: 2 }), 'omitted target');
    assertEqual((omitted as IpcHandlerError).code, 'BAD_REQUEST', 'missing target cannot clear a configured tier');
    assertDeepEqual(readModelTierMapping(root).low, { source: 'custom', modelId: 'fast' }, 'an explicit null is required to clear a tier');
    assertEqual(readModelTierMapping(root).revision, 2, 'failed writes do not advance revision');
  });
  h.test('a tier save returns once stored and never waits on the per-chat push', async () => {
    const root = freshRoot(); kvSet('auth_mode', 'custom', root); kvSet('model_tiers:custom', '{}', root);
    const changed: string[] = [], logs: string[] = [];
    let releasePush!: () => void;
    let pushSettled = false;
    const pushGate = new Promise<void>(resolve => { releasePush = resolve; });
    const registry = new ChannelRegistry();
    const request: EngineRequest = async (method, params) => {
      if (method === 'config/read') return { values: { modelProviders: { fast: { provider: 'openai', model: 'small', name: 'Fast' } } }, resolved: {} };
      if (method === 'model/credential/read') return { apiKey: 'fixture-private-key' };
      throw new Error('Unexpected fixture RPC ' + method);
    };
    registerSettingsHandlers(registry, {
      configRoot: root, request, log: (kind, detail) => logs.push(`${kind} ${detail}`),
      onSettingsChanged: async key => { changed.push(key); await pushGate; pushSettled = true; }, sourceStatus: async () => ({ loggedIn: false }),
    });
    const saved = object(await invoke(registry, 'settings:models:tiers:set', { tier: 'low', target: { source: 'custom', modelId: 'fast' }, expectedRevision: 0 }));
    assertDeepEqual(object(saved.mapping).low, { source: 'custom', modelId: 'fast' }, 'the stored row is the save');
    assertEqual(changed.length, 1, 'the push started in the background');
    assertEqual(pushSettled, false, 'the reply returned while the push was still in flight');
    releasePush();
    await new Promise(resolve => setTimeout(resolve, 0));
    assertEqual(pushSettled, true, 'the push settles after the reply');
    assertDeepEqual(changed, [GLOBAL_MODEL_TIERS_KEY], 'the push names the tier mapping key');
    // A push that fails after the reply must not surface as an unhandled
    // rejection: it lands in the diagnostic log with its own kind.
    const failing = new ChannelRegistry();
    registerSettingsHandlers(failing, {
      configRoot: root, request, log: (kind, detail) => logs.push(`${kind} ${detail}`),
      onSettingsChanged: () => Promise.reject(new Error('engine gone')), sourceStatus: async () => ({ loggedIn: false }),
    });
    const second = object(await invoke(failing, 'settings:models:tiers:set', { tier: 'high', target: { source: 'custom', modelId: 'fast' }, expectedRevision: 1 }));
    assertDeepEqual(object(second.mapping).high, { source: 'custom', modelId: 'fast' }, 'a later save still succeeds');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert(logs.some(row => row.startsWith('model-tier-push-failed')), 'the failed background push is logged');
  });
}
