import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { resolveRuntimePolicy, resolveWebSearchAccess } from '../../contracts/runtime-settings';
import { runtimeConfigValues } from '../services/runtime-config-values';

const INFERENCE_KEYS = ['provider', 'auth', 'modelSelection', 'modelTierSelections', 'modelTierTargets', 'advisorTarget', 'orchestratorTarget', 'orchestrationMode', 'orchestratorFallbackToMain', 'featureTargets', 'modelSource', 'capabilities', 'capabilitiesByModel', 'pricing'] as const;
const CONFIG_KEYS = ['model', 'modelTiers', 'effort', 'thinking', 'ultraMode', 'fastMode', 'contextWindow', 'maxOutputTokens', 'maxOutputRetryTokens', 'modelVerbosity', 'reasoningSummary', 'webSearch'] as const;

/** The named facade accepts a complete inference selection, never a session-init patch. */
export function inferenceInit(init: Record<string, Json>): Record<string, Json> {
  const selection: Record<string, Json> = {};
  for (const key of INFERENCE_KEYS) if (Object.hasOwn(init, key)) selection[key] = init[key]!;
  const config = object(init.config) ?? {}, selected: Record<string, Json> = {};
  for (const key of CONFIG_KEYS) if (Object.hasOwn(config, key)) selected[key] = config[key]!;
  selection.config = selected;
  return selection;
}

/** Reset omitted model fields while retaining the session's identity, resources and policy. */
export function replaceInferenceInit(previous: Json, selection: Record<string, Json>): Record<string, Json> {
  const init = { ...object(previous) }, config = { ...object(init.config) };
  for (const key of INFERENCE_KEYS) delete init[key];
  for (const key of CONFIG_KEYS) delete config[key];
  return { ...init, ...selection, config: { ...config, ...object(selection.config) } };
}

/** Preserve explicit profile/project pins, without pinning the old/default provider's model. */
export function configuredInference(init: Record<string, Json>, resolved: Record<string, Json>, sources: Record<string, Json>): Record<string, Json> {
  resolved = runtimeConfigValues({ resolved, sources });
  const selectedSource = typeof init.modelSelection === 'string' && init.modelSelection.length > 0;
  const pins: Record<string, Json> = {};
  for (const key of CONFIG_KEYS) {
    if (key === 'model' && selectedSource) continue;
    if (typeof sources[key] === 'string' && sources[key] !== 'defaults' && Object.hasOwn(resolved, key)) pins[key] = resolved[key]!;
  }
  const config = { ...pins, ...object(init.config) };
  config.modelVerbosity = ['low', 'medium', 'high'].includes(String(resolved.modelVerbosity)) ? resolved.modelVerbosity! : null;
  config.reasoningSummary = ['auto', 'concise', 'detailed', 'none'].includes(String(resolved.reasoningSummary)) ? resolved.reasoningSummary! : 'auto';
  config.webSearch = { access: resolveWebSearchAccess(resolved, resolveRuntimePolicy({ ...resolved, ...object(init.config) }).sandboxMode) };
  if (selectedSource) delete config.model;
  if (config.thinking === false) delete config.effort;
  return inferenceInit({ ...init, config });
}
