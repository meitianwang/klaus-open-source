import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerModelFeatureHandlers } from '../main/ipc/handlers/model-features';
import { ModelFeatureSettings, readFeatureModelReference } from '../main/services/model-features';
import { buildSessionInit, buildSessionInitAsync } from '../main/services/session-init';
import { resolveFeatureTargets } from '../main/services/session-provider';
import { setSessionModel } from '../main/services/session-store';
import { kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { object } from '../main/services/service-types';
import { configuredInference, replaceInferenceInit } from '../main/sessions/inference';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/feature-model-targets-vectors.json'), 'utf8')) as {
  cases: Array<{ name: string; main: string; stored: Record<string, string>; targets: Record<string, Json> }>;
};

const SLOT_KEYS = {
  title: 'feature_models.title',
  prediction: 'feature_models.prediction',
  memory: 'feature_models.memory',
  voice_refinement: 'feature_models.voice_refinement',
} as const;

/** The vectors pin target identity, not the human message wording. */
function strippedTargets(targets: Json): Json {
  const value = object(targets), out: Record<string, Json> = {};
  for (const slot of ['title', 'prediction', 'memory'] as const) {
    const entry = value[slot];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const identity: Record<string, Json> = { ...(entry as Record<string, Json>) };
      delete identity.message;
      out[slot] = identity;
    } else out[slot] = entry ?? null;
  }
  return out;
}

export function registerFeatureModelTargetTests(h: Harness, freshRoot: () => string): void {
  for (const row of vectors.cases) h.test(`Feature model routing: ${row.name}`, async () => {
    const root = freshRoot(), calls: string[] = [];
    const mainSource = row.main.slice(0, row.main.indexOf(':'));
    setSessionModel('thread', row.main, mainSource, root);
    for (const [slot, value] of Object.entries(row.stored)) kvSet(SLOT_KEYS[slot as keyof typeof SLOT_KEYS], value, root);
    const built = await buildSessionInitAsync({ rendererId: 'thread', cwd: root, configRoot: root }, {
      request: async (method, params) => {
        calls.push(method);
        assertEqual(method, 'model/selection/resolve', 'only the main identity is resolved in the host');
        assertEqual(object(params).selection, row.main, 'a feature pick cannot replace the main selection');
        return { source: mainSource, selection: row.main };
      },
    });
    assert(built.ok, 'a bad or signed-out feature pick cannot prevent main setup');
    assertEqual(built.init.modelSelection, row.main, 'main model is retained');
    assertDeepEqual(calls, ['model/selection/resolve'], 'no credential, source status or rank query');
    const published = built.init.featureTargets as Json;
    assertDeepEqual(strippedTargets(published), row.targets, 'feature targets cross the facade as identities or explicit nulls');
    const wire = object(published);
    assert(!('voiceRefinement' in wire) && !('voice_refinement' in wire), 'the speech refinement pick never enters the session init');
    for (const [slot, value] of Object.entries(row.stored)) assertEqual(kvGet(SLOT_KEYS[slot as keyof typeof SLOT_KEYS], root), value, 'the stored choice never silently drifts');
    assertDeepEqual(buildSessionInit({ rendererId: 'thread', cwd: root, configRoot: root }).ok, true, 'sync init remains available');
    const inference = configuredInference(built.init, {}, {});
    assertDeepEqual(inference.featureTargets, built.init.featureTargets, 'full inference publication retains the feature targets');
    const cleared = replaceInferenceInit(built.init, { ...inference, featureTargets: null });
    assertEqual(cleared.featureTargets, null, 'an explicit null clears the published targets');
  });

  h.test('Feature model writes patch one slot, reject invalid identities and keep the saved picks', () => {
    const root = freshRoot(), features = new ModelFeatureSettings(root);
    assertDeepEqual(object(features.getFeatureModels()).settings, { title: '', prediction: '', memory: '', voiceRefinement: '' }, 'every slot defaults to follow-the-chat-model');
    assertEqual(object(features.setFeatureModels({ title: 'codex:gpt-5' })).ok, true, 'a qualified identity saves');
    assertEqual(object(features.setFeatureModels({ memory: 'qoder:keep' })).ok, true, 'a patch touches only its slot');
    assertDeepEqual(object(features.getFeatureModels()).settings, { title: 'codex:gpt-5', prediction: '', memory: 'qoder:keep', voiceRefinement: '' }, 'untouched slots are preserved');
    for (const patch of [{ title: 'opus' }, { title: 'unknown:opus' }, { prediction: 'custom:' }, { prediction: 'custom: model' }, { memory: 'custom:model\ninside' }, { memory: 'custom:' + 'x'.repeat(1025) }, { title: 'cursor:auto' }, { title: 'cursor:default@max' }, { title: 42 }, { voiceRefinement: 'cursor:high' }] as Array<Record<string, Json>>) {
      const rejected = object(features.setFeatureModels(patch));
      assertEqual(rejected.ok, false, 'invalid identity is rejected');
      assertEqual(rejected.error, 'feature_model_invalid', 'invalid identity is diagnosable');
    }
    assertDeepEqual(object(features.getFeatureModels()).settings, { title: 'codex:gpt-5', prediction: '', memory: 'qoder:keep', voiceRefinement: '' }, 'failed validation preserves every saved choice');
    assertEqual(object(object(features.setFeatureModels({ title: '  off ' })).settings).title, '', 'retired sentinel words normalize to unset');
    assertDeepEqual(features.getFeatureTargets().title, null, 'a cleared slot publishes null');
    kvSet('feature_models.prediction', 'opus', root);
    const prediction = object(features.getFeatureTargets().prediction);
    assertEqual(prediction.type, 'unavailable', 'an invalid stored row publishes an unavailable target');
    assertEqual(prediction.code, 'FEATURE_MODEL_INVALID', 'so the engine can degrade it to the main model');
    assertEqual(readFeatureModelReference('voice_refinement', root), null, 'the call-time reader folds an unset slot to null');
    kvSet('feature_models.voice_refinement', 'qoder:asr-polish', root);
    assertDeepEqual(readFeatureModelReference('voice_refinement', root), { source: 'qoder', modelId: 'asr-polish' }, 'the call-time reader returns the saved identity');
    kvSet('feature_models.voice_refinement', 'broken legacy value', root);
    assertEqual(readFeatureModelReference('voice_refinement', root), null, 'the call-time reader folds an invalid value to unset');
  });

  h.test('Feature model settings fence only engine-bound slot changes', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), changed: string[] = [];
    registerModelFeatureHandlers(registry, { configRoot: root, onSettingsChanged: key => { changed.push(key); } });
    const invoke = async (channel: string, payload?: Json) => {
      const handler = registry.lookup(channel); assert(handler, 'handler exists');
      return handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] });
    };
    assertEqual(object(await invoke('settings:feature-models:set', { title: 'opus' })).ok, false, 'invalid write is rejected');
    assertDeepEqual(changed, [], 'a rejected write does not publish');
    assertEqual(object(await invoke('settings:feature-models:set', { title: 'codex:gpt-5' })).ok, true, 'qualified write succeeds');
    assertDeepEqual(changed, ['feature_models'], 'an engine-bound slot republishes inference');
    assertEqual(object(await invoke('settings:feature-models:set', { title: 'codex:gpt-5' })).ok, true, 'rewriting the same value succeeds');
    assertDeepEqual(changed, ['feature_models'], 'an unchanged engine-bound value does not republish');
    assertEqual(object(await invoke('settings:feature-models:set', { voiceRefinement: 'qoder:asr-polish' })).ok, true, 'the speech refinement pick saves');
    assertDeepEqual(changed, ['feature_models'], 'a voice-only change never republishes inference');
    const reply = await invoke('settings:feature-models:get');
    assertDeepEqual(object(reply).settings, { title: 'codex:gpt-5', prediction: '', memory: '', voiceRefinement: 'qoder:asr-polish' }, 'the read returns all four normalized slots');
    assertEqual(object(await invoke('settings:feature-models:set', { title: '', prediction: 'custom:small' })).ok, true, 'one patch can clear and set slots together');
    assertDeepEqual(changed, ['feature_models', 'feature_models'], 'the engine-bound change in the patch republishes once');
  });

  h.test('Feature settings read failure becomes unavailable without exposing database details', () => {
    const root = freshRoot();
    withSettingsDb(root, db => db.exec("CREATE TRIGGER fail_feature_migration BEFORE INSERT ON settings WHEN NEW.key='image_generation.selection' BEGIN SELECT RAISE(ABORT,'private-database-detail'); END"));
    const targets = resolveFeatureTargets(root);
    assertEqual(object(targets.title).code, 'FEATURE_MODEL_SETTINGS_UNAVAILABLE', 'storage failure is isolated from the main provider');
    assertEqual(object(targets.memory).code, 'FEATURE_MODEL_SETTINGS_UNAVAILABLE', 'every engine-bound slot degrades together');
    assert(!JSON.stringify(targets).includes('private-database-detail'), 'raw storage diagnostics stay out of runtime status');
  });
}

if (require.main === module) {
  const h = new Harness(), roots: string[] = [];
  registerFeatureModelTargetTests(h, () => { const root = mkdtempSync(join(tmpdir(), 'klaus-feature-models-')); roots.push(root); return root; });
  void h.finish(join(__dirname, 'feature-model-targets-result.json'), 'feature-model-targets').then(code => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    process.exitCode = code;
  });
}
