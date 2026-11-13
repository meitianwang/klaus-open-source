import { antigravityModelThinkingLevel } from './antigravity-model-options';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { pinSessionModel, readSessionModel, readSessionThinkingLevel, modelSource, sourceTierSelections, validModelSelection } from './session-store';
import { type EngineRequest, type JsonObject, object, string, errorMessage } from './service-types';
import { MODEL_TIERS, readModelTierMapping } from './model-tier-settings';
import { ModelFeatureSettings, type AdvisorTarget, type FeatureTargets } from './model-features';

export type ProviderResolution =
  | { kind: 'engineModel'; selection: string; source: string; supportsFastMode?: boolean; nativeThinkingLevel?: string; modelTierTargets?: Json; modelTierRevision?: number; advisorTarget?: AdvisorTarget; featureTargets?: FeatureTargets }
  | { kind: 'unavailable'; code: string; message: string };
export interface SessionProviderDeps {
  configRoot?: string;
  changeId?: string;
  request: EngineRequest;
  log?: (event: string, detail: string) => void;
}
async function resolveMainProvider(sessionId: string, deps: SessionProviderDeps): Promise<ProviderResolution> {
  const root = deps.configRoot ?? configRootFrom();
  try {
    const stored = readSessionModel(sessionId, root);
    const saved = { ...stored };
    const params: JsonObject = { source: saved.source, selection: saved.mode };
    if (['high', 'medium', 'low'].includes(saved.mode)) params.modelTierSelections = sourceTierSelections(saved.source, root);
    const resolved = object(await deps.request('model/selection/resolve', params)), selection = string(resolved.selection);
    if (!validModelSelection(selection) || modelSource(selection) !== saved.source || resolved.source !== saved.source) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The engine did not resolve the saved model source');
    const ensureUnchanged = (): void => {
      const latest = readSessionModel(sessionId, root);
      if (latest.mode !== saved.mode || latest.source !== saved.source) throw new IpcHandlerError('MODEL_SELECTION_CHANGED', 'The model selection changed while the session was starting. Try again.');
    };
    ensureUnchanged();
    if (['high', 'medium', 'low'].includes(saved.mode)) {
      pinSessionModel(root, sessionId, selection);
      saved.mode = selection;
    }
    if (saved.source === 'qoder' || saved.source === 'qwenwork') {
      // This provider takes the reasoning level as side-channel state, so it has to
      // be pushed per conversation. Reading the global default here would push one
      // conversation's pick into another's provider session.
      const level = readSessionThinkingLevel(sessionId, root);
      try { await deps.request(`${saved.source}/setThinkingLevel`, { level }); }
      catch (error) { deps.log?.(`${saved.source}-thinking-level`, errorMessage(error)); }
      ensureUnchanged();
    }
    let nativeThinkingLevel: string | undefined;
    if (saved.source === 'antigravity') {
      const catalog = object(await deps.request('antigravity/models', { read: 'cached' }));
      ensureUnchanged();
      const entries = Array.isArray(catalog.models) ? catalog.models.map(object) : [];
      const entry = entries.find(entry => `antigravity:${string(entry.key)}` === selection);
      if (entry) nativeThinkingLevel = antigravityModelThinkingLevel(entry);
    }
    return { kind: 'engineModel', selection, source: saved.source, ...(nativeThinkingLevel ? { nativeThinkingLevel } : {}) };
  } catch (error) {
    return { kind: 'unavailable', code: error instanceof IpcHandlerError ? error.code : 'MODEL_PROVIDER_UNAVAILABLE', message: errorMessage(error) };
  }
}

/** Resolve auxiliary routes without reselecting or preparing the main provider. */
export async function resolveModelTierTargets(sessionId: string, deps: Pick<SessionProviderDeps, 'configRoot'>): Promise<{ revision: number; targets: JsonObject }> {
  const root = deps.configRoot ?? configRootFrom();
  const mapping = readModelTierMapping(root), targets: JsonObject = {};
  await Promise.all(MODEL_TIERS.map(async tier => {
    const reference = mapping[tier];
    if (!reference) { targets[tier] = null; return; }
    targets[tier] = { type: 'source', source: reference.source, modelId: reference.modelId };
    return;
  }));
  if (readModelTierMapping(root).revision !== mapping.revision) throw new IpcHandlerError('MODEL_SELECTION_CHANGED', 'The shared model tiers changed while preparing their routes. Retry.');
  return { revision: mapping.revision, targets };
}

/** Advisor routing never derives from the main model, tier mapping or credentials. */
export function resolveAdvisorTarget(configRoot = configRootFrom()): AdvisorTarget {
  try { return new ModelFeatureSettings(configRoot).getAdvisorTarget(); }
  catch {
    // A broken auxiliary preference must not prevent the main chat from starting.
    // Do not forward database/credential details through a public runtime failure.
    return { type: 'unavailable', source: 'unknown', modelId: 'unavailable', code: 'ADVISOR_SETTINGS_UNAVAILABLE',
      message: 'The Advisor settings could not be read. Re-save the Advisor configuration before using it.' };
  }
}

/** Auxiliary feature routing never derives from the main model, tier mapping or credentials. */
export function resolveFeatureTargets(configRoot = configRootFrom()): FeatureTargets {
  try { return new ModelFeatureSettings(configRoot).getFeatureTargets(); }
  catch {
    // A broken auxiliary preference must not prevent the main chat from starting.
    // Do not forward database/credential details through a public runtime failure.
    const unavailable: AdvisorTarget = { type: 'unavailable', source: 'unknown', modelId: 'unavailable',
      code: 'FEATURE_MODEL_SETTINGS_UNAVAILABLE', message: 'The auxiliary model settings could not be read. The chat model runs these tasks until the settings are re-saved.' };
    return { title: unavailable, prediction: unavailable, memory: unavailable };
  }
}

/** A tier always carries its entire provider identity, never just a replacement model name. */
export async function resolveSessionProvider(sessionId: string, deps: SessionProviderDeps): Promise<ProviderResolution> {
  const main = await resolveMainProvider(sessionId, deps);
  if (main.kind === 'unavailable') return main;
  const root = deps.configRoot ?? configRootFrom();
  try {
    const preference = readSessionModel(sessionId, root);
    const { revision, targets } = await resolveModelTierTargets(sessionId, deps);
    const latest = readSessionModel(sessionId, root);
    if (latest.source !== main.source || latest.mode !== preference.mode) {
      throw new IpcHandlerError('MODEL_SELECTION_CHANGED', 'The model configuration changed while the session was starting. Try again.');
    }
    return { ...main, modelTierTargets: targets, modelTierRevision: revision, advisorTarget: resolveAdvisorTarget(root), featureTargets: resolveFeatureTargets(root) };
  } catch (error) {
    return { kind: 'unavailable', code: error instanceof IpcHandlerError ? error.code : 'MODEL_PROVIDER_UNAVAILABLE', message: errorMessage(error) };
  }
}
