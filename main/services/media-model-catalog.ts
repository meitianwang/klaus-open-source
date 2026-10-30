import { configuredMediaModel, mediaPreferenceFields, SUBSCRIPTION_MEDIA_MODELS, type EffectiveMediaModelCatalog, type EffectiveMediaModelOption, type MediaModelKind } from '../../contracts/effective-media-models';
import { providerCapabilities, type ProviderCapabilities } from '../../contracts/provider-capabilities';
import { ModelFeatureSettings, IMAGE_SELECTION_SOURCES, VIDEO_SELECTION_SOURCES, AUDIO_SELECTION_SOURCES, MUSIC_SELECTION_SOURCES } from './model-features';
import { object, string, type JsonObject } from './service-types';

/** Project only public model identities; account keys and endpoints never enter catalog rows. */
export async function mediaModelCatalog(kind: MediaModelKind, features: ModelFeatureSettings, deps: {
  signedIn(source: string): Promise<boolean>;
  capabilities(source: string): Promise<ProviderCapabilities>;
}): Promise<EffectiveMediaModelCatalog & { availability: Record<string, boolean>; config?: unknown }> {
  const stored = object(kind === 'image' ? features.getImageSelection() : kind === 'video' ? features.getVideoSelection() : kind === 'audio' ? features.getAudioSelection() : features.getMusicSelection());
  const selection = string(stored.selection);
  const sources = kind === 'image' ? IMAGE_SELECTION_SOURCES : kind === 'video' ? VIDEO_SELECTION_SOURCES : kind === 'audio' ? AUDIO_SELECTION_SOURCES : MUSIC_SELECTION_SOURCES;
  const availability: Record<string, boolean> = {};
  const options: EffectiveMediaModelOption[] = [];
  const currentBySource: Record<string, EffectiveMediaModelCatalog['current']> = {};
  let current = { source: selection, modelId: '' };
  if (kind === 'music' || kind === 'image' || kind === 'video') {
    const registry = kind === 'image' ? SUBSCRIPTION_MEDIA_MODELS.image : kind === 'video' ? SUBSCRIPTION_MEDIA_MODELS.video : SUBSCRIPTION_MEDIA_MODELS.music;
    const registeredSources = Object.keys(registry);
    const rows = await Promise.all(['none', ...registeredSources].map(async source => {
      const connected = source === 'none' || await deps.signedIn(source);
      const models: readonly string[] = source === 'none' ? [''] : (registry as Record<string, readonly string[]>)[source]!;
      const saved = source === 'none' || !mediaPreferenceFields(kind, source) ? models[0]! : string(object(features.getMedia(kind, { source })).model) || models[0]!;
      return { source, connected, models, saved };
    }));
    for (const { source, connected, models, saved } of rows) {
      availability[source] = connected;
      currentBySource[source] = { source, modelId: saved };
      for (const modelId of models) options.push({ source, modelId, available: connected, selectable: true, connected });
      if (!models.some(model => model === saved)) options.push({ source, modelId: saved, available: false, selectable: false, connected });
    }
    current = currentBySource[selection] ?? { source: selection, modelId: '' };
    return { ok: true, selection, current, currentBySource, options, availability };
  }
  // Each source probe is independent. Keep the source order for the returned
  // catalog, but do not make the page wait for one account/status request before
  // starting the next one.
  const rows = await Promise.all(sources.map(async source => {
    const config = object(features.getMedia(kind, { source }));
    const connected = source === 'none' || await deps.signedIn(source);
    const native = source === 'workbuddy' || source === 'qwenwork' || source === 'antigravity' || source === 'trae';
    let capabilities = providerCapabilities({});
    // Public local metadata keeps function-level choices stable before sign-in.
    if (native && (source === 'qwenwork' || connected || source === selection)) {
      try { capabilities = await deps.capabilities(source); } catch { /* Retain the saved identity when metadata cannot be read. */ }
    }
    const capability = capabilities[kind];
    const available = connected && (!native || capability.available);
    const modelId = native ? string(config.model) || capability.defaultModel || capability.models?.[0]?.id || '' : configuredMediaModel(kind, source, config);
    const sourceOptions: EffectiveMediaModelOption[] = [];
    const append = (saved: string, candidates: Array<{ id: string; label: string }>, ready: boolean) => {
      for (const model of candidates) sourceOptions.push({ source, modelId: model.id, label: model.label, available: ready });
      if (!candidates.some(model => model.id === saved)) sourceOptions.push({ source, modelId: saved, available: ready && !saved });
    };
    if (native) append(modelId, capability.models ?? [], available);
    else {
      const planModels: readonly string[] | undefined = kind === 'audio' && source === 'minimax' ? SUBSCRIPTION_MEDIA_MODELS.audio.minimax
        : kind === 'audio' && source === 'bailian' ? SUBSCRIPTION_MEDIA_MODELS.audio.bailian : undefined;
      if (planModels) {
        // Verified speech-plan routes follow the image/video/music contract:
        // they stay selectable and save their model before the account
        // connects, while `available` still reports readiness.
        append(modelId, planModels.map(id => ({ id, label: id })), available);
        for (const option of sourceOptions) if (option.source === source) { option.selectable = true; option.connected = connected; }
      }
      else sourceOptions.push({ source, modelId, available, connected });
    }
    return { source, available, modelId, options: sourceOptions };
  }));
  for (const row of rows) {
    availability[row.source] = row.available;
    currentBySource[row.source] = { source: row.source, modelId: row.modelId };
    options.push(...row.options);
    if (row.source === selection) current = { source: row.source, modelId: row.modelId };
  }
  if (!options.some(option => option.source === current.source && option.modelId === current.modelId)) options.push({ ...current, available: false });
  currentBySource[current.source] = current;
  return { ok: true, selection, current, currentBySource, options, availability, ...(stored.config ? { config: stored.config as JsonObject } : {}) };
}
