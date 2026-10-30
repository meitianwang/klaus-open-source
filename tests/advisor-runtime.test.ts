import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerModelFeatureHandlers } from '../main/ipc/handlers/model-features';
import { ModelFeatureSettings } from '../main/services/model-features';
import { buildSessionInit, buildSessionInitAsync } from '../main/services/session-init';
import { resolveAdvisorTarget } from '../main/services/session-provider';
import { setSessionModel } from '../main/services/session-store';
import { kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { object } from '../main/services/service-types';
import { configuredInference, replaceInferenceInit } from '../main/sessions/inference';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';

const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/advisor-runtime-vectors.json'), 'utf8')) as {
  cases: Array<{ name: string; main: string; model: string; enabled: boolean; target?: Json; error?: string }>;
};

export function registerAdvisorRuntimeTests(h: Harness, freshRoot: () => string): void {
  for (const row of vectors.cases) h.test(`Advisor routing: ${row.name}`, async () => {
    const root = freshRoot(), calls: string[] = [];
    const mainSource = row.main.slice(0, row.main.indexOf(':'));
    setSessionModel('thread', row.main, mainSource, root);
    kvSet('advisor.model', row.model, root); kvSet('advisor.enabled', row.enabled ? '1' : '0', root);
    const built = await buildSessionInitAsync({ rendererId: 'thread', cwd: root, configRoot: root }, {
      request: async (method, params) => {
        calls.push(method);
        assertEqual(method, 'model/selection/resolve', 'only the main identity is resolved in the host');
        assertEqual(object(params).selection, row.main, 'the advisor cannot replace the main selection');
        return { source: mainSource, selection: row.main };
      },
    });
    assert(built.ok, 'a bad or signed-out advisor cannot prevent main setup');
    assertEqual(built.init.modelSelection, row.main, 'main model is retained');
    assertDeepEqual(calls, ['model/selection/resolve'], 'no credential, source status or rank query');
    if (row.error) {
      assertEqual(object(built.init.advisorTarget).type, 'unavailable', 'invalid identity is explicit');
      assertEqual(object(built.init.advisorTarget).code, row.error, 'invalid identity is diagnosable');
      assertEqual(object(new ModelFeatureSettings(root).getAdvisor()).active, false, 'invalid target is not active');
    } else assertDeepEqual(built.init.advisorTarget, row.target, 'source-qualified target crosses the facade');
    assertEqual(kvGet('advisor.model', root), row.model, 'the stored choice never silently drifts');
    assertDeepEqual(buildSessionInit({ rendererId: 'thread', cwd: root, configRoot: root }).ok, true, 'sync init remains available');
    const inference = configuredInference(built.init, {}, {});
    assertDeepEqual(inference.advisorTarget, built.init.advisorTarget, 'full inference publication retains the advisor target');
    const cleared = replaceInferenceInit(built.init, { ...inference, advisorTarget: null });
    assertEqual(cleared.advisorTarget, null, 'an explicit null clears the old target');
  });

  h.test('Advisor source migration uses historical ownership and never the current source', () => {
    const root = freshRoot(); kvSet('auth_mode', 'custom', root);
    kvSet('advisor.model.qoder', 'legacy', root); kvSet('advisor.enabled.qoder', '1', root);
    const features = new ModelFeatureSettings(root);
    assertEqual(object(features.getAdvisor()).model, 'qoder:legacy', 'bare legacy model is qualified by its original row');
    assertEqual(kvGet('advisor.model.qoder', root), 'legacy', 'historical evidence remains intact');
    kvSet('auth_mode', 'codex', root);
    assertDeepEqual(features.getAdvisorTarget(), { type: 'source', source: 'qoder', modelId: 'legacy' }, 'changing the chat source does not move the advisor');
    const folded = freshRoot(); kvSet('advisor.model', 'legacy', folded); kvSet('advisor.model.kimi', 'legacy', folded);
    assertEqual(object(new ModelFeatureSettings(folded).getAdvisor()).model, 'kimi:legacy', 'a unique prior source recovers a previously folded bare choice');
    const ambiguous = freshRoot(); kvSet('advisor.model', 'legacy', ambiguous);
    kvSet('advisor.model.codex', 'legacy', ambiguous); kvSet('advisor.model.qoder', 'legacy', ambiguous);
    assertEqual(object(new ModelFeatureSettings(ambiguous).getAdvisor()).model, 'legacy', 'ambiguous ownership is never guessed');
    assertEqual(object(resolveAdvisorTarget(ambiguous)).type, 'unavailable', 'ambiguous ownership produces an unavailable target');
    const broken = new ModelFeatureSettings(ambiguous);
    assertEqual(object(broken.setAdvisor({ enabled: false, model: 'legacy' })).ok, true, 'a panel can disable the invalid choice it already displays');
    assertEqual(broken.getAdvisorTarget(), null, 'disabling a bad choice still clears the runtime target');
    assertEqual(object(broken.setAdvisor({ enabled: true })).error, 'advisor_model_invalid', 'invalid preserved choice cannot be re-enabled');
    const retired = freshRoot(); kvSet('advisor.model.local', 'local:old', retired); kvSet('advisor.enabled.local', '1', retired);
    assertEqual(object(new ModelFeatureSettings(retired).getAdvisor()).model, 'local:old', 'retired qualified identity is not prefixed twice');
  });

  h.test('Advisor disable preserves its choice while explicit clear and re-enable stay atomic', () => {
    const root = freshRoot(), features = new ModelFeatureSettings(root);
    features.setAdvisor({ enabled: true, model: 'subscription:opus' });
    assertEqual(object(features.setAdvisor({ enabled: false })).ok, true, 'disable succeeds without a new model');
    assertEqual(object(features.getAdvisor()).model, 'subscription:opus', 'disable preserves choice');
    assertEqual(features.getAdvisorTarget(), null, 'disable publishes null');
    assertEqual(object(features.setAdvisor({ enabled: true })).ok, true, 're-enable reuses the explicit stored choice');
    assertDeepEqual(features.getAdvisorTarget(), { type: 'source', source: 'subscription', modelId: 'opus' }, 're-enable restores the same route');
    features.setAdvisor({ enabled: false, model: '' });
    assertEqual(object(features.getAdvisor()).model, '', 'explicit clear removes the choice');
    assertEqual(object(features.setAdvisor({ enabled: true })).ok, true, 'enabling without a model is accepted');
    assertEqual(object(features.getAdvisor()).enabled, true, 'the flag stores as given');
    assertEqual(object(features.getAdvisor()).active, false, 'an enabled pick without a model stays inert');
    assertEqual(features.getAdvisorTarget(), null, 'an enabled pick without a model publishes no runtime target');
    for (const model of ['opus', 'unknown:opus', 'custom:', 'custom: model', 'custom:model\ninside', 'custom:' + 'x'.repeat(1025), 'cursor:auto', 'cursor:default@max', 'cursor:high']) {
      assertEqual(object(features.setAdvisor({ enabled: true, model })).error, 'advisor_model_invalid', 'invalid identity is rejected');
      assertEqual(object(features.getAdvisor()).model, '', 'failed validation preserves the saved choice');
    }
  });

  h.test('Advisor settings publish only successful writes and expose no credential readiness claim', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), changed: string[] = [];
    registerModelFeatureHandlers(registry, { configRoot: root, onSettingsChanged: key => { changed.push(key); },
      sourceStatus: async () => { throw new Error('The advisor source is resolved by the engine, not the settings bridge'); } });
    const invoke = async (channel: string, payload?: Json) => {
      const handler = registry.lookup(channel); assert(handler, 'handler exists');
      return handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] });
    };
    await invoke('settings:advisor:set', { enabled: true, model: 'opus' });
    assertEqual(changed.length, 0, 'rejected selection does not publish');
    await invoke('settings:advisor:set', { enabled: true, model: 'custom:small', apiKey: 'private-fixture-secret' });
    const settings = await invoke('settings:advisor:get');
    assertEqual(object(settings).providerSupported, true, 'runtime support is advertised');
    assertEqual(object(settings).activeScope, 'configuration', 'active does not claim credentials are ready');
    assertEqual(object(settings).readiness, 'unchecked', 'runtime availability is explicitly not verified by this getter');
    assert(!JSON.stringify(settings).includes('private-fixture-secret'), 'arbitrary credentials never enter the settings result');
    await invoke('settings:advisor:set', { enabled: false });
    await invoke('settings:advisor:set', { enabled: true });
    await invoke('settings:advisor:set', { enabled: false, model: '' });
    assertDeepEqual(changed, ['advisor', 'advisor', 'advisor', 'advisor'], 'set, disable, enable and clear publish');
  });

  h.test('Advisor settings read failure becomes unavailable without exposing database details', () => {
    const root = freshRoot();
    withSettingsDb(root, db => db.exec("CREATE TRIGGER fail_advisor_migration BEFORE INSERT ON settings WHEN NEW.key='image_generation.selection' BEGIN SELECT RAISE(ABORT,'private-database-detail'); END"));
    const target = resolveAdvisorTarget(root);
    assertEqual(object(target).code, 'ADVISOR_SETTINGS_UNAVAILABLE', 'storage failure is isolated from the main provider');
    assert(!JSON.stringify(target).includes('private-database-detail'), 'raw storage diagnostics stay out of runtime status');
  });
}

if (require.main === module) {
  const h = new Harness(), roots: string[] = [];
  registerAdvisorRuntimeTests(h, () => { const root = mkdtempSync(join(tmpdir(), 'klaus-advisor-')); roots.push(root); return root; });
  void h.finish(join(__dirname, 'advisor-runtime-result.json'), 'advisor-runtime').then(code => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    process.exitCode = code;
  });
}
