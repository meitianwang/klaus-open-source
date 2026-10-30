import { buildSessionInitAsync } from '../main/services/session-init';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor, type Harness } from './harness';
import type { Json } from '../main/ipc/contract';
import { ComposerService } from '../main/services/composer';
import { sourceTierCatalog, validateTierTarget } from '../main/services/model-tier-catalog';
import { MobileModelConfigProjection, applyModelPreference } from '../main/services/mobile/model-config';
import { readSessionModel, readSessionThinkingLevel, readSessionUltraMode, setSessionModel, setSessionThinkingLevel } from '../main/services/session-store';
import { antigravityThinkingLevels, antigravityVariantForThinking, pickAntigravityModelMetadata } from '../shared/antigravity-model-catalog';
import { modelOptionForValue, modelOptionHasValue } from '../shared/cursor-model-catalog';
import { object, type EngineRequest, type JsonObject } from '../main/services/service-types';
import type { EngineSettings } from '../main/services/engine-settings';

export function registerAntigravityModelVariantTests(h: Harness): void {
  const model = (level: string) => `antigravity:gemini-3.8-flash-${level}`;
  const engine = { providers: async () => ({}) } as unknown as EngineSettings;
  async function fixture(changed: (root: string, change: unknown) => Promise<void> | void = () => {}, beforeCatalog?: () => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), 'klaus-model-variants-'));
    const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/antigravity-model-variants.json'), 'utf8'));
    const entries: JsonObject[] = vector.entries;
    const request: EngineRequest = async (method, raw) => {
      const params = object(raw);
      if (method === 'antigravity/models') { await beforeCatalog?.(); return { models: entries }; }
      if (method === 'model/selection/resolve') return { source: 'antigravity', selection: params.selection === 'auto' ? model('high') : params.selection ?? '' };
      throw new Error('Unexpected fixture request: ' + method);
    };
    const service = new ComposerService({ configRoot: root, engineSettings: engine, request, push: () => {}, onSessionConfigChanged: change => changed(root, change) });
    return { root, entries, request, service, close: () => rm(root, { recursive: true, force: true }) };
  }

  h.test('declared model variants form one menu row and keep every saved concrete selection', async () => {
    const f = await fixture();
    try {
      const rows = (await f.service.options('antigravity')).map(object);
      const family = rows.filter(row => row.label === 'Gemini 3.8 Flash');
      assert.equal(family.length, 1);
      assert.equal(family[0]!.value, model('high'));
      assert.deepEqual(family[0]!.supportedThinkingLevels, ['low', 'medium', 'high']);
      for (const level of ['low', 'medium', 'high']) {
        const selected = object(modelOptionForValue(rows, model(level)));
        assert.equal(selected.value, model(level)); assert.equal(selected.defaultThinkingLevel, level);
        assert.equal(selected.label, 'Gemini 3.8 Flash');
        assert(modelOptionHasValue(family[0], model(level).slice('antigravity:'.length)));
      }
      assert(!rows.some(row => /\((?:High|Medium|Low|Thinking)\)$/.test(String(row.label))));
      assert(!rows.some(row => ['antigravity:chat_20706', 'antigravity:gemini-3.1-flash-image', 'antigravity:gemini-3.5-flash-lite'].includes(String(row.value))));
      const lite = rows.filter(row => row.label === 'Gemini 3.5 Flash Lite');
      assert.equal(lite.length, 1);
      assert.equal(lite[0]!.description, lite[0]!.label);
      assert.deepEqual(lite[0]!.supportedThinkingLevels, ['low']);
      for (const key of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-thinking']) {
        const selected = object(modelOptionForValue(rows, `antigravity:${key}`));
        assert.equal(selected.label, 'Gemini 3.5 Flash Lite');
        assert.equal(selected.value, `antigravity:${key}`);
        setSessionModel('lite', `antigravity:${key}`, 'antigravity', f.root);
        await f.service.setThinking({ sessionId: 'lite', level: 'low' });
        assert.equal(readSessionModel('lite', f.root).mode, `antigravity:${key}`);
      }
      assert(!rows.some(row => row.description !== row.label && typeof row.description === 'string' && /^gemini-/.test(row.description)));
    } finally { await f.close(); }
  });

  h.test('protocol members determine reasoning and mismatched metadata cannot rewrite a model', async () => {
    const f = await fixture();
    try {
      const rows = (await f.service.options('antigravity')).map(object);
      const family = object(rows.find(row => row.label === 'Gemini 3.5 Flash'));
      const metadata = pickAntigravityModelMetadata(family);
      assert.equal(antigravityVariantForThinking(metadata, 'antigravity:gemini-3-flash-agent', 'medium')?.value, 'antigravity:gemini-3.5-flash-low');
      assert.equal(antigravityVariantForThinking(metadata, 'antigravity:gemini-3-flash-agent', 'low')?.value, 'antigravity:gemini-3.5-flash-extra-low');
      assert.equal(antigravityVariantForThinking(metadata, 'antigravity:gemini-3-flash-agent', 'off'), undefined);
      object(f.entries.find(entry => entry.key === 'gemini-3.8-flash-medium')).providerMetadata = { thinkingBudget: 9000 };
      const changed = (await f.service.options('antigravity')).map(object);
      assert.equal(object(modelOptionForValue(changed, model('medium'))).antigravityFamilyId, undefined);
      assert(changed.some(row => row.value === model('medium')));
      f.entries.push({ key: 'future-high', display_name: 'Future Model (High)', capabilities: {} });
      assert((await f.service.options('antigravity')).some(row => object(row).value === 'antigravity:future-high'));
    } finally { await f.close(); }
  });

  h.test('reasoning changes atomically switch concrete IDs and retain independent sessions and Ultra', async () => {
    const observed: unknown[] = [];
    const f = await fixture((root, change) => { observed.push({ change, model: readSessionModel('main', root).mode, level: readSessionThinkingLevel('main', root) }); });
    try {
      setSessionModel('main', model('high'), 'antigravity', f.root);
      setSessionModel('side', model('high'), 'antigravity', f.root);
      setSessionThinkingLevel('main', 'off', f.root);
      assert.equal(object(await f.service.getThinking('main')).level, 'high');
      for (const level of ['low', 'medium', 'high']) {
        await f.service.setThinking({ sessionId: 'main', level });
        assert.equal(readSessionModel('main', f.root).mode, model(level));
        assert.equal(readSessionThinkingLevel('main', f.root), level);
        assert.equal(readSessionModel('side', f.root).mode, model('high'));
      }
      await f.service.setThinking({ sessionId: 'main', level: 'ultra' });
      assert.equal(readSessionModel('main', f.root).mode, model('high'));
      assert.equal(object(await f.service.getThinking('main')).level, 'high');
      assert.equal(readSessionThinkingLevel('main', f.root), 'high');
      assert.equal(readSessionUltraMode('main', f.root), true);
      assert.equal(readSessionUltraMode('side', f.root), false);
      assert(observed.every(raw => { const row = raw as { model: string; level: string }; return row.model === model(row.level); }));
      const before = readSessionModel('main', f.root);
      await assert.rejects(f.service.setThinking({ sessionId: 'main', level: 'off' }), /reasoning level is unavailable/);
      assert.deepEqual(readSessionModel('main', f.root), before);
    } finally { await f.close(); }
  });

  h.test('automatic defaults and combined phone selections resolve their concrete reasoning member', async () => {
    const f = await fixture();
    try {
      setSessionModel('main', 'auto', 'antigravity', f.root);
      assert.equal(object(await f.service.getThinking('main')).level, 'high');
      await f.service.setThinking({ sessionId: 'main', level: 'medium' });
      assert.equal(readSessionModel('main', f.root).mode, model('medium'));
      await f.service.setModel({ sessionId: 'main', source: 'antigravity', mode: model('high'), thinkingLevel: 'low' });
      assert.equal(readSessionModel('main', f.root).mode, model('low'));
      assert.equal(readSessionThinkingLevel('main', f.root), 'low');
      setSessionThinkingLevel('main', 'off', f.root);
      await f.service.setModel({ sessionId: 'main', source: 'antigravity', mode: model('high') });
      assert.equal(readSessionThinkingLevel('main', f.root), 'high');
    } finally { await f.close(); }
  });

  h.test('restored and inherited native selections use their declared thinking during inference preparation', async () => {
    const f = await fixture();
    try {
      setSessionModel('restored', model('medium'), 'antigravity', f.root);
      setSessionThinkingLevel('restored', 'off', f.root);
      const build = (id: string) => buildSessionInitAsync({ rendererId: id, cwd: f.root, configRoot: f.root }, { configRoot: f.root, request: f.request });
      let built = await build('restored');
      assert(built.ok); assert.equal(object(built.init.config).thinking, true); assert.equal(object(built.init.config).effort, 'medium');
      assert.equal(readSessionThinkingLevel('restored', f.root), 'off', 'preparing inference does not overwrite stored preferences');
      setSessionModel('', 'auto', 'antigravity', f.root);
      setSessionThinkingLevel('', 'off', f.root);
      built = await build('new');
      assert(built.ok); assert.equal(built.selection, model('high')); assert.equal(object(built.init.config).effort, 'high');
      await f.service.setUltraMode({ sessionId: 'restored', enabled: true });
      built = await build('restored');
      assert(built.ok); assert.equal(object(built.init.config).effort, 'medium');
      assert.equal(object(built.init.config).ultraMode, true);
      assert.equal(readSessionThinkingLevel('restored', f.root), 'off');
      setSessionModel('unknown', 'antigravity:future-model', 'antigravity', f.root);
      setSessionThinkingLevel('unknown', 'off', f.root);
      built = await build('unknown');
      assert(built.ok); assert.equal(object(built.init.config).thinking, false);
    } finally { await f.close(); }
  });

  h.test('failed model publication rolls back both the native member and thinking selection', async () => {
    const f = await fixture(() => { throw new Error('Publication rejected'); });
    try {
      setSessionModel('main', model('high'), 'antigravity', f.root);
      setSessionThinkingLevel('main', 'high', f.root);
      const defaults = readSessionModel('', f.root);
      await assert.rejects(f.service.setThinking({ sessionId: 'main', level: 'low' }), /Publication rejected/);
      assert.equal(readSessionModel('main', f.root).mode, model('high'));
      assert.equal(readSessionThinkingLevel('main', f.root), 'high');
      assert.deepEqual(readSessionModel('', f.root), defaults);
    } finally { await f.close(); }
  });

  h.test('a delayed reasoning edit cannot overwrite a newer model selection', async () => {
    let started = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(() => {}, async () => { started = true; await gate; });
    try {
      setSessionModel('main', model('high'), 'antigravity', f.root);
      const pending = f.service.setThinking({ sessionId: 'main', level: 'low' });
      await waitFor(() => started, 1000, 'native model catalog starts');
      setSessionModel('main', model('medium'), 'antigravity', f.root);
      release();
      await assert.rejects(pending, /selected model changed/);
      assert.equal(readSessionModel('main', f.root).mode, model('medium'));
    } finally { release(); await f.close(); }
  });

  h.test('known members remain selectable with truthful account state through thinking, tiers and mobile catalogs', async () => {
    const f = await fixture();
    try {
      const low = object(f.entries.find(entry => entry.key === 'gemini-3.8-flash-low'));
      low.disabled = true; low.unavailableReason = 'Account restricted';
      const medium = object(f.entries.find(entry => entry.key === 'gemini-3.8-flash-medium'));
      medium.capabilities = { mediaInputMimeTypes: ['video/mp4'] };
      const restrictedLite = object(f.entries.find(entry => entry.key === 'gemini-2.5-flash'));
      restrictedLite.disabled = true; restrictedLite.unavailableReason = 'Account restricted';
      const rows = (await f.service.options('antigravity')).map(object);
      const lite = rows.filter(row => row.label === 'Gemini 3.5 Flash Lite');
      assert.equal(lite.length, 1);
      assert.equal(lite[0]!.value, 'antigravity:gemini-2.5-flash-lite');
      assert.equal(object(modelOptionForValue(rows, 'antigravity:gemini-2.5-flash')).available, false);
      assert.equal(object(modelOptionForValue(rows, 'antigravity:gemini-2.5-flash')).reason, 'Account restricted');
      assert.equal(object(modelOptionForValue(rows, model('low'))).available, false);
      assert.equal(object(modelOptionForValue(rows, model('low'))).reason, 'Account restricted');
      assert.deepEqual(object(modelOptionForValue(rows, model('medium'))).mediaInputMimeTypes, ['video/mp4']);
      setSessionModel('main', model('high'), 'antigravity', f.root);
      await f.service.setThinking({ sessionId: 'main', level: 'low' });
      assert.equal(readSessionModel('main', f.root).mode, model('low'));
      await f.service.setModel({ sessionId: 'main', source: 'antigravity', mode: model('low') });
      assert.equal(readSessionModel('main', f.root).mode, model('low'));
      const deps = { configRoot: f.root, engine, request: f.request, sourceStatus: async () => ({ loggedIn: true }) };
      const tier = await sourceTierCatalog('antigravity', deps);
      assert.equal(object(modelOptionForValue(tier.options as JsonObject[], 'gemini-3.8-flash-medium')).modelId, 'gemini-3.8-flash-medium');
      await validateTierTarget({ source: 'antigravity', modelId: 'gemini-3.8-flash-medium' }, deps);
      await validateTierTarget({ source: 'antigravity', modelId: 'gemini-3.8-flash-low' }, deps);
      await assert.rejects(validateTierTarget({ source: 'antigravity', modelId: 'unknown-member' }, deps));
      await assert.rejects(validateTierTarget({ source: 'antigravity', modelId: 'gemini-3.8-flash-low' }, { ...deps, sourceStatus: async () => ({ loggedIn: false }) }));
      const mobile = new MobileModelConfigProjection(async (channel): Promise<Json> => channel === 'session:get-main-model-options' ? { options: rows } : { loggedIn: true });
      const phoneRows = await mobile.models('antigravity');
      assert.equal(object(modelOptionForValue(phoneRows, model('medium'))).value, model('medium'));
      assert.equal(object(modelOptionForValue(phoneRows, model('low'))).available, false);
      assert(phoneRows.every(row => row.description === undefined));
      const preference = { source: 'antigravity', selection: model('low'), thinkingLevel: 'low' };
      await mobile.validate(preference);
      await applyModelPreference(async (channel, payload) => {
        assert.equal(channel, 'session:set-main-model');
        return f.service.setModel(object(payload));
      }, 'phone', preference);
      assert.equal(readSessionModel('phone', f.root).mode, model('low'));
      await assert.rejects(mobile.validate({ ...preference, selection: 'antigravity:unknown-member' }));
      const signedOut = new MobileModelConfigProjection(async (channel): Promise<Json> => channel === 'session:get-main-model-options' ? { options: rows } : { loggedIn: false });
      await assert.rejects(signedOut.validate(preference));
      const other = new MobileModelConfigProjection(async (channel): Promise<Json> => channel === 'session:get-main-model-options' ? { options: [{ value: 'codex:restricted', available: false }] } : { loggedIn: true });
      await other.validate({ source: 'codex', selection: 'codex:restricted', thinkingLevel: 'high' });
      const paid = rows.find(row => row.label === 'Gemini 4 Argon')!;
      assert.equal(paid.available, false);
      assert.deepEqual(antigravityThinkingLevels(pickAntigravityModelMetadata(paid), String(paid.value)), ['low', 'medium', 'high']);
      const allRestricted = await sourceTierCatalog('antigravity', { ...deps, request: async (method): Promise<Json> => {
        assert.equal(method, 'antigravity/models');
        return { models: f.entries.map(entry => ({ ...entry, disabled: true })) };
      } });
      assert.equal(allRestricted.status, 'ready');
      assert((allRestricted.options as JsonObject[]).every(row => row.available === false));
    } finally { await f.close(); }
  });
}
