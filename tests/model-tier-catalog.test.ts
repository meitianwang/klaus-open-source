import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineSettings } from '../main/services/engine-settings';
import { modelTierCatalog, sourceTierCatalog, validateTierTarget, type TierCatalogDeps } from '../main/services/model-tier-catalog';
import type { ModelTierMapping } from '../main/services/model-tier-settings';
import type { EngineRequest, JsonObject } from '../main/services/service-types';
import { object } from '../main/services/service-types';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';
import { ComposerService } from '../main/services/composer';
import { modelOptionForValue, modelOptionHasValue, modelOptionsForValue } from '../shared/cursor-model-catalog';
import { resolveSubagentModelPolicy, subagentOptionsFromCatalog } from '../main/services/subagent-model-policy';

// The tier catalog fans out across every model source. These tests pin the
// two properties the settings page depends on: the source fan-out runs in
// parallel with the mapping read (so a local row never delays the engine
// RPCs), and every source reports its own timing so a slow open is
// measurable instead of felt.

const h = new Harness();

h.test('subagent catalog choices retain source-qualified identities and exact declared family members', async () => {
  const policy = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/global-model-tier-vectors.json'), 'utf8')).routeInvariants.subagentModelSelection;
  const choices = subagentOptionsFromCatalog({ sources: [
    { source: 'custom', status: 'ready', options: [{ modelId: 'configured-entry', label: 'Display name', apiKey: 'must-not-travel' }, { modelId: 'configured-entry' }] },
    { source: 'cursor', status: 'ready', options: [{ modelId: 'family[effort=low]', label: 'Family', cursorVariants: [
      { value: 'cursor:family[effort=low]' }, { value: 'cursor:family[effort=high]', label: 'High' }, { value: 'custom:injected' },
    ] }] },
    { source: 'codex', status: 'unavailable', options: [{ modelId: 'signed-out-model' }] },
    { source: 'subscription', status: 'error', options: [{ modelId: 'failed-model' }] },
    { source: 'invented', status: 'ready', options: [{ modelId: 'unknown-source' }] },
    { source: 'trae', status: 'ready', options: [{ modelId: 'invalid\nvalue' }] },
  ] });
  assertDeepEqual(choices, [
    { value: 'custom:configured-entry', label: 'custom · Display name' },
    { value: 'cursor:family[effort=low]', label: 'cursor · Family' },
    { value: 'cursor:family[effort=high]', label: 'cursor · Family (High)' },
  ], 'only safe catalog identities and labels travel to the engine');
  let reads = 0;
  const load = async () => { reads++; return choices; };
  assertEqual(policy.catalogSetting, 'klaus.subagentModelCatalog', 'the configuration key is pinned by the selection contract');
  assertEqual(policy.catalogDefault, false, 'catalog selection defaults off');
  assertDeepEqual(policy.disabledChoices, ['low', 'medium', 'high'], 'tier mode advertises only three tiers');
  assertEqual(policy.enabledTiers, false, 'catalog mode excludes tier aliases');
  assertDeepEqual(await resolveSubagentModelPolicy({}, load), { subagentModelCatalog: false, subagentModelOptions: [] }, 'default is tier-only');
  assertEqual(reads, 0, 'tier mode does not query model catalogs');
  assertDeepEqual(await resolveSubagentModelPolicy({ subagentModelCatalog: true }, load), { subagentModelCatalog: true, subagentModelOptions: choices }, 'enabled mode carries the same concrete choices');
  assertEqual(reads, 1, 'enabled mode loads once');
  assertDeepEqual(await resolveSubagentModelPolicy({ subagentModelCatalog: true }, async () => []),
    { subagentModelCatalog: true, subagentModelOptions: [] }, 'an empty catalog never turns the policy back into tiers');
  const labels = subagentOptionsFromCatalog({ sources: [{ source: 'custom', status: 'ready', options: [
    { modelId: 'scalar', label: '\t' + '😀'.repeat(300) + '\0' }, { modelId: 'bad\ud800' },
  ] }] });
  assertEqual(labels.length, 1, 'invalid scalar model identities are not advertised');
  assert(Buffer.byteLength(labels[0]!.label) <= 512 && !/\p{Cc}/u.test(labels[0]!.label)
    && Buffer.from(labels[0]!.label).toString('utf8') === labels[0]!.label, 'labels satisfy the engine byte and scalar-text limits');
});

function mapping(): ModelTierMapping {
  return { version: 1, revision: 3, high: { source: 'custom', modelId: 'p1' }, medium: null, low: null };
}

function deps(logs: string[], events: string[]): TierCatalogDeps {
  const request: EngineRequest = async (method, params) => {
    if (method === 'model/credential/read') {
      events.push(`credential:${object(params).id}`);
      return { apiKey: 'stored-key' };
    }
    throw new Error(`unexpected engine method ${method}`);
  };
  const engine = {
    providers: async () => ({ p1: { name: 'P One', model: 'm-1', capabilities: {} } }),
  } as unknown as EngineSettings;
  return {
    configRoot: '/tmp/unused',
    request,
    engine: { ...engine, providers: async () => { events.push('providers'); return engine.providers(); } } as EngineSettings,
    sourceStatus: async () => ({ loggedIn: false }),
    log: (_kind, detail) => { logs.push(detail); },
  };
}

h.test('the source fan-out starts before a pending mapping resolves', async () => {
  const logs: string[] = [];
  const events: string[] = [];
  let resolveMapping!: (value: ModelTierMapping) => void;
  const mappingPromise = new Promise<ModelTierMapping>(resolve => { resolveMapping = resolve; });
  const catalog = modelTierCatalog(mappingPromise, deps(logs, events));
  // The provider catalog must start while the mapping read is still pending.
  await new Promise(resolve => setTimeout(resolve, 40));
  const providersBeforeMapping = events.includes('providers');
  resolveMapping(mapping());
  const reply = await catalog;
  assert(providersBeforeMapping, 'provider catalog read ran while the mapping was still pending');
  assert(!events.some(event => event.startsWith('credential:')), 'catalog does not inspect model credentials');
  assertEqual(reply.ok, true, 'catalog reply ok');
  assertEqual(reply.revision, 3, 'reply carries the mapping revision');
  const sources = reply.sources as JsonObject[];
  const custom = sources.find(row => row.source === 'custom') as JsonObject;
  assertEqual(custom.status, 'ready', 'custom source ready');
  const codex = sources.find(row => row.source === 'codex') as JsonObject;
  assertEqual(codex.status, 'unavailable', 'signed-out source unavailable');
  assertEqual(codex.reasonCode, 'MODEL_SOURCE_NOT_SIGNED_IN', 'signed-out reason code');
  const tiers = reply.tiers as JsonObject;
  assertEqual(object(tiers.high).status, 'ready', 'mapped tier ready');
  assertEqual(object(tiers.high).label, 'P One', 'mapped tier label comes from the catalog');
  assertEqual(object(tiers.medium).status, 'inherit', 'unmapped tier inherits');
});

h.test('every source reports one timing entry with its own split', async () => {
  const logs: string[] = [];
  const events: string[] = [];
  await modelTierCatalog(mapping(), deps(logs, events));
  assertEqual(logs.length, 16, 'one timing entry per source');
  const rows = logs.map(detail => JSON.parse(detail) as JsonObject);
  const sources = rows.map(row => String(row.source)).sort();
  assertEqual(sources.join(','), 'antigravity,ark,bailian,codex,cursor,custom,kimi,kiro,minimax,qoder,qoderwork,qwenwork,subscription,trae,workbuddy,zhipu', 'every source reported');
  for (const row of rows) {
    for (const key of ['totalMs', 'optionsMs', 'statusMs']) {
      assertEqual(typeof row[key], 'number', `${String(row.source)} reports ${key}`);
    }
  }
  assert(!events.some(event => event.startsWith('credential:')), 'no catalog performs per-model credential reads');
});

h.test('catalog discovery and tier selection leave model eligibility to inference', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/model-catalog-selection-vectors.json'), 'utf8'));
  let credentialReads = 0;
  const dependencies = deps([], []);
  dependencies.sourceStatus = async () => ({ loggedIn: true });
  dependencies.request = async method => {
    if (method === 'model/credential/read') {
      credentialReads++;
      throw new Error('Catalog discovery must not read credentials');
    }
    return { models: [{ key: 'restricted', id: 'restricted', alias: 'restricted', modelId: 'restricted', display_name: 'Restricted', ...vector.accountMetadata }] };
  };
  for (const source of vector.sources as string[]) {
    const modelId = source === 'custom' ? 'p1' : 'restricted';
    const catalog = await sourceTierCatalog(source, dependencies);
    assertEqual(catalog.status, 'ready', `${source} catalog is ready`);
    assertEqual((catalog.options as unknown[]).length, 1, `${source} retains its catalog row`);
    await validateTierTarget({ source, modelId }, dependencies);
  }
  assertEqual(credentialReads, vector.catalogCredentialReads, 'catalog listing and selection do not read per-model credentials');
});

h.test('an incomplete local login disables Cursor tier discovery and selection', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/global-model-tier-vectors.json'), 'utf8')).cursorNeedsReimport;
  const dependencies = deps([], []);
  let requests = 0;
  dependencies.sourceStatus = async () => vector.state;
  dependencies.request = async () => { requests++; throw new Error('An incomplete login must not query models'); };
  const reply = await sourceTierCatalog(vector.source, dependencies);
  assertEqual(reply.status, vector.status, 'incomplete local login is unavailable');
  assertEqual(reply.reasonCode, vector.reasonCode, 're-import remains actionable');
  assertEqual((reply.options as unknown[]).length, 0, 'no incomplete-source models are offered');
  const error = await assertRejects(() => validateTierTarget({ source: 'cursor', modelId: 'fixture' }, dependencies), 'incomplete local login');
  assertEqual((error as { code: string }).code, 'MODEL_TIER_TARGET_UNAVAILABLE', 'saving cannot bypass readiness');
  assertEqual(requests, 0, 'catalog reads are skipped until local login is imported again');
});

h.test('grouped Cursor catalogs preserve exact nondefault members through tiers and native selects', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/cursor-family-selection-vectors.json'), 'utf8'));
  const dependencies = deps([], []);
  dependencies.sourceStatus = async () => ({ loggedIn: true, authMethod: 'browser' });
  dependencies.request = async method => {
    assertEqual(method, 'cursor/models', 'only model discovery is needed');
    return { models: vector.models };
  };
  const composer = new ComposerService({ configRoot: dependencies.configRoot, request: dependencies.request, push: () => {}, onSessionConfigChanged: () => {} });
  const options = await composer.options('cursor');
  assertEqual(options.length, 1, 'one base model row');
  const row = object(options[0]);
  assertEqual(row.label, 'Fixture Model', 'base display name is genuine metadata');
  assertEqual(row.value, vector.defaultSelection, 'family menu starts with the declared default');
  assertEqual((row.cursorVariants as unknown[]).length, 2, 'exact members remain available');
  const selected = object(modelOptionForValue(options, vector.savedSelection));
  assertEqual(selected.value, vector.savedSelection, 'saved inference identity is retained');
  assertDeepEqual(selected.supportedThinkingLevels, ['high'], 'native thinking metadata belongs to the saved member');
  assertEqual(selected.defaultThinkingLevel, 'high', 'representative effort cannot replace the saved effort');
  assertEqual(object(modelOptionsForValue(options, vector.savedSelection)[0]).value, vector.savedSelection, 'native selects preserve current members');
  assertEqual(modelOptionHasValue(row, vector.removedSelection), false, 'same family does not make removed variants available');
  const tierRows = await sourceTierCatalog('cursor', dependencies);
  assertEqual((tierRows.options as unknown[]).length, 1, 'tier catalog is grouped');
  await validateTierTarget({ source: 'cursor', modelId: vector.savedSelection.slice(7) }, dependencies);
  await assertRejects(() => validateTierTarget({ source: 'cursor', modelId: vector.removedSelection.slice(7) }, dependencies), 'removed concrete member');
  const reply = await modelTierCatalog({ version: 1, revision: 1, high: { source: 'cursor', modelId: vector.savedSelection.slice(7) }, medium: null, low: null }, {
    ...dependencies, sourceStatus: async source => ({ loggedIn: source === 'cursor' }),
    request: async (method, params) => method === 'cursor/models' ? { models: vector.models } : deps([], []).request(method, params),
  });
  assertEqual(object(object(reply.tiers).high).status, 'ready', 'a saved nondefault tier remains ready');
  assertEqual(object(object(reply.tiers).high).label, 'Fixture Model', 'tier label uses the family');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'model-tier-catalog-result.json'), 'model-tier-catalog');
  process.exit(failed);
})();
