import type { Json } from '../contract';
import { providerCapabilities, type ProviderCapabilities } from '../../../contracts/provider-capabilities';
import { ChannelRegistry } from '../registry';
import { SUBSCRIPTION_MEDIA_MODELS, type MediaModelKind } from '../../../contracts/effective-media-models';
import { mediaModelCatalog } from '../../services/media-model-catalog';
import { ModelFeatureSettings } from '../../services/model-features';
import { object, string, type JsonObject, type EngineRequest } from '../../services/service-types';

export const MODEL_FEATURE_CHANNELS = [
  'settings:advisor:get', 'settings:advisor:set',
  'settings:feature-models:get', 'settings:feature-models:set', 'settings:image-gen:get',
  'settings:image-gen:set', 'settings:video-gen:get', 'settings:video-gen:set',
  'settings:audio-gen:get', 'settings:audio-gen:set',
  'settings:music-gen:get', 'settings:music-gen:set',
  'settings:music-selection:get', 'settings:music-selection:set',
  'settings:image-selection:get', 'settings:image-selection:set',
  'settings:video-selection:get', 'settings:video-selection:set',
  'settings:audio-selection:get', 'settings:audio-selection:set',
] as const;
export function registerModelFeatureHandlers(registry: ChannelRegistry, deps: {
  configRoot?: string;
  features?: ModelFeatureSettings;
  onSettingsChanged: (key: string) => void | Promise<void>;
  /** Connection status affects readiness, independently of supported choices. */
  request?: EngineRequest;
  sourceStatus?: (source: string) => Promise<unknown>;
}): ModelFeatureSettings {
  const features = deps.features ?? new ModelFeatureSettings(deps.configRoot);
  const signedIn = async (source: string): Promise<boolean> => {
    if (!deps.sourceStatus) return false;
    try {
      const state = object(await deps.sourceStatus(source));
      if (state.needsLogin === true || state.needsReimport === true) return false;
      return state.loggedIn === true || state.logged_in === true || state.authenticated === true;
    } catch { return false; }
  };
  const nativeCapabilities = async (source: string) => providerCapabilities(await deps.request?.(`${source}/capabilities`, {}));
  const subscriptionModelValid = (kind: 'image' | 'video' | 'music', source: string, model: unknown): boolean => {
    if (kind === 'image' && source === 'custom') return true;
    if (model === undefined) return true;
    if (source === 'none') return false;
    const registry = SUBSCRIPTION_MEDIA_MODELS[kind];
    return Object.entries(registry).some(([value, models]) => value === source && (models as readonly string[]).some(id => id === model));
  };
  const readMedia = async (kind: 'image' | 'video' | 'audio' | 'music', payload: JsonObject): Promise<Json> => {
    if (payload.source === 'trae' && kind !== 'image' && kind !== 'video') return { error: 'This source does not offer the requested media operation.' };
    if (kind === 'music' && payload.source !== 'qwenwork' || kind === 'audio' && payload.source === 'qwenwork' || kind !== 'image' && payload.source === 'antigravity') return { error: 'This source does not offer the requested media operation.' };
    if (kind === 'video' && (payload.source === 'custom' || payload.source === 'cursor')) return { error: 'This source does not offer the requested media operation.' };
    const config = features.getMedia(kind, payload);
    if (!(kind === 'image' && ['workbuddy', 'qwenwork', 'antigravity'].includes(string(payload.source)) || payload.source === 'trae' && (kind === 'image' || kind === 'video'))) return config;
    try { return { ...object(config), capabilities: await nativeCapabilities(string(payload.source)) } as unknown as Json; }
    catch { return { ...object(config), error: 'Native media capabilities are unavailable. Reconnect the account or retry.' }; }
  };
  const writeMedia = async (kind: 'image' | 'video' | 'audio' | 'music', payload: JsonObject): Promise<Json> => {
    if (payload.source === 'trae' && kind !== 'image' && kind !== 'video') return { ok: false, error: 'This source does not offer the requested media operation.' };
    if (kind === 'music' && payload.source !== 'qwenwork' || kind === 'audio' && payload.source === 'qwenwork' || kind !== 'image' && payload.source === 'antigravity') return { ok: false, error: 'This source does not offer the requested media operation.' };
    if (kind === 'video' && (payload.source === 'custom' || payload.source === 'cursor')) return { ok: false, error: 'This source does not offer the requested media operation.' };
    if (kind === 'music' || kind === 'image' || kind === 'video') {
      if (!subscriptionModelValid(kind, string(payload.source), payload.model)) return { ok: false, error: 'The selected media model is unavailable.' };
    } else if (['workbuddy', 'qwenwork', 'antigravity'].includes(string(payload.source))) {
      const source = string(payload.source), name = source === 'workbuddy' ? 'WorkBuddy' : source === 'antigravity' ? 'Antigravity' : 'QwenWork';
      if (!(await signedIn(source))) return { ok: false, error: `Sign in to ${name} before selecting a media model.` };
      const capabilities = await nativeCapabilities(source);
      for (const field of ['model']) {
        if (payload[field] === undefined || payload[field] === '') continue;
        const capability = capabilities[kind];
        if (!capability.available || !capability.models?.some(model => model.id === payload[field])) return { ok: false, error: `The selected ${name} media model is unavailable.` };
      }
    }
    const result = features.setMedia(kind, payload);
    if (object(result).ok === true) await deps.onSettingsChanged(`${kind}_generation.model_config`);
    return result;
  };

  // Account and capability probes fan out across every media catalog read, and
  // each settings load or change-event reload repeats them. A short shared
  // cache keeps repeated reads off the engine round trips; writes validate
  // against fresh probes so a just-changed account is never misjudged.
  const PROBE_TTL_MS = 20_000
  const probes = new Map<string, { at: number; promise: Promise<unknown> }>()
  const cachedProbe = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const hit = probes.get(key)
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.promise as Promise<T>
    const promise = read().catch((error: unknown) => { probes.delete(key); throw error })
    probes.set(key, { at: Date.now(), promise })
    return promise
  }
  const cachedSignedIn = (source: string): Promise<boolean> => cachedProbe(`status:${source}`, () => signedIn(source))
  const cachedCapabilities = (source: string): Promise<ProviderCapabilities> => cachedProbe(`capabilities:${source}`, () => nativeCapabilities(source))
  const catalog = (kind: MediaModelKind, fresh = false) => mediaModelCatalog(kind, features, fresh
    ? { signedIn, capabilities: nativeCapabilities }
    : { signedIn: cachedSignedIn, capabilities: cachedCapabilities })
  const readSelection = async (kind: MediaModelKind): Promise<Json> => await catalog(kind) as unknown as Json;
  const writeSelection = async (kind: MediaModelKind, payload: JsonObject): Promise<Json> => {
    const requested = string(payload.selection).trim();
    const choices = await catalog(kind, true);
    if (payload.imageEditModel !== undefined) return { ok: false, error: 'Choose one image model for generation and editing.' };
    const selectable = (option: { available: boolean; selectable?: boolean }) => option.available || option.selectable === true;
    if (!choices.options.some(option => option.source === requested && selectable(option))) return { ok: false, error: requested === 'custom' ? 'Configure the custom endpoint before selecting its model.' : 'Sign in to a supported source before selecting its model.' };
    if (payload.model !== undefined && !choices.options.some(option => option.source === requested && option.modelId === payload.model && selectable(option))) return { ok: false, error: 'The selected media model is unavailable.' };
    const result = kind === 'image' ? features.setImageSelection(payload) : kind === 'video' ? features.setVideoSelection(payload) : kind === 'audio' ? features.setAudioSelection(payload) : features.setMusicSelection(payload);
    if (object(result).ok === true) await deps.onSettingsChanged(`${kind}_generation.selection`);
    return result;
  };

  registry.register('settings:advisor:get', () => features.getAdvisor(), 'settings');
  registry.register('settings:advisor:set', async ctx => {
    const result = features.setAdvisor(object(ctx.args[0]));
    if (object(result).ok === true) await deps.onSettingsChanged('advisor');
    return result;
  }, 'settings');
  registry.register('settings:feature-models:get', () => features.getFeatureModels(), 'settings');
  registry.register('settings:feature-models:set', async ctx => {
    const before = object(object(features.getFeatureModels()).settings);
    const result = features.setFeatureModels(object(ctx.args[0]));
    // Only the engine-bound slots republish inference; the voice runtime reads
    // the speech refinement pick at call time, so it needs no fence.
    if (object(result).ok === true) {
      const after = object(object(result).settings);
      if (['title', 'prediction', 'memory'].some(field => before[field] !== after[field])) await deps.onSettingsChanged('feature_models');
    }
    return result;
  }, 'settings');
  registry.register('settings:image-gen:get', ctx => readMedia('image', object(ctx.args[0])), 'settings');
  registry.register('settings:video-gen:get', ctx => readMedia('video', object(ctx.args[0])), 'settings');
  registry.register('settings:audio-gen:get', ctx => readMedia('audio', object(ctx.args[0])), 'settings');
  registry.register('settings:music-gen:get', ctx => readMedia('music', object(ctx.args[0])), 'settings');
  registry.register('settings:music-gen:set', ctx => writeMedia('music', object(ctx.args[0])), 'settings');
  registry.register('settings:image-gen:set', async ctx => {
    return writeMedia('image', object(ctx.args[0]));
  }, 'settings');
  registry.register('settings:video-gen:set', async ctx => {
    return writeMedia('video', object(ctx.args[0]));
  }, 'settings');
  registry.register('settings:audio-gen:set', async ctx => {
    return writeMedia('audio', object(ctx.args[0]));
  }, 'settings');
  registry.register('settings:image-selection:get', () => readSelection('image'), 'settings');
  registry.register('settings:image-selection:set', ctx => writeSelection('image', object(ctx.args[0])), 'settings');
  registry.register('settings:video-selection:get', () => readSelection('video'), 'settings');
  registry.register('settings:video-selection:set', ctx => writeSelection('video', object(ctx.args[0])), 'settings');
  registry.register('settings:audio-selection:get', () => readSelection('audio'), 'settings');
  registry.register('settings:audio-selection:set', ctx => writeSelection('audio', object(ctx.args[0])), 'settings');
  registry.register('settings:music-selection:get', () => readSelection('music'), 'settings');
  registry.register('settings:music-selection:set', ctx => writeSelection('music', object(ctx.args[0])), 'settings');
  return features;
}
