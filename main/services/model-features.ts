import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { isCursorModelAlias } from './model-sources';
import { withSettingsTransaction } from './settings';
import { MODEL_SOURCES } from './session-store';
import { configuredMediaModel, mediaPreferenceFields, SUBSCRIPTION_IMAGE_SOURCES, SUBSCRIPTION_MUSIC_SOURCES, SUBSCRIPTION_VIDEO_SOURCES } from '../../contracts/effective-media-models';
import { type JsonObject, object, string, errorMessage } from './service-types';

function get(db: DatabaseSync, key: string): string | undefined { return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value as string | undefined; }
function put(db: DatabaseSync, key: string, value: string): void { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
function decoded(value: string | undefined): JsonObject { try { return object(JSON.parse(value ?? '{}')); } catch { return {}; } }
export type AdvisorTarget = null | ({ type: 'source'; source: string; modelId: string } & JsonObject)
  | ({ type: 'unavailable'; source: string; modelId: string; code: string; message: string } & JsonObject);

/** Stored model references normalize the retired sentinel words to "unset". */
function normalizedModelValue(value: string): string { return ['off', 'unset'].includes(value.trim()) ? '' : value.trim(); }
/** One shared identity rule for every source-qualified model pick. */
function qualifiedModelReference(model: string): { source: string; modelId: string } | undefined {
  const separator = model.indexOf(':');
  if (separator < 1) return;
  const source = model.slice(0, separator), modelId = model.slice(separator + 1);
  if (!MODEL_SOURCES.includes(source) || !modelId || modelId !== modelId.trim() || modelId.length > 1024 || /[\u0000-\u001f\u007f]/u.test(modelId)
    || source === 'cursor' && isCursorModelAlias(modelId)) return;
  return { source, modelId };
}
function advisor(db: DatabaseSync): JsonObject {
  const model = normalizedModelValue(get(db, 'advisor.model') ?? '');
  const flag = get(db, 'advisor.enabled'), enabled = flag === undefined ? Boolean(model) : flag === '1';
  const reference = qualifiedModelReference(model);
  // This is configuration activation, not proof of credentials or a live request.
  // The engine resolves readiness per target and reports failures without a fallback.
  // An enabled pick without a model is inert: it behaves exactly like a disabled
  // one, so it carries no error and publishes no runtime target.
  const live = enabled && Boolean(reference);
  return { enabled, model, providerSupported: true, active: live, activeScope: 'configuration',
    readiness: 'unchecked', status: !enabled || !model ? 'disabled' : reference ? 'configured' : 'unavailable',
    ...(!enabled || !model || reference ? {} : { error: 'advisor_model_invalid',
      message: 'Choose an Advisor model with an explicit supported source (source:model). No other model will be substituted.' }) };
}
function advisorTarget(db: DatabaseSync): AdvisorTarget {
  const settings = advisor(db);
  if (!settings.enabled || !string(settings.model)) return null;
  const model = string(settings.model), reference = qualifiedModelReference(model);
  if (reference) return { type: 'source', ...reference };
  const separator = model.indexOf(':');
  return { type: 'unavailable', source: separator > 0 ? model.slice(0, separator) : 'unknown',
    modelId: (separator > 0 ? model.slice(separator + 1) : model) || 'unset',
    code: 'ADVISOR_MODEL_INVALID', message: string(settings.message) };
}
function orchestrator(db: DatabaseSync): JsonObject {
  const model = normalizedModelValue(get(db, 'orchestrator.model') ?? '');
  const fallbackToMain = get(db, 'orchestrator.fallback_to_main') === '1';
  const reference = qualifiedModelReference(model);
  return {
    mode: model ? 'custom' : 'use_medium',
    model,
    fallbackToMain,
    providerSupported: true,
    status: !model ? 'use_medium' : reference ? 'configured' : 'unavailable',
    ...(!model || reference ? {} : {
      error: 'orchestrator_model_invalid',
      message: 'Choose an execution model with an explicit supported source (source:model), or reuse the shared Medium tier.',
    }),
  };
}
function orchestratorTarget(db: DatabaseSync): AdvisorTarget {
  const settings = orchestrator(db);
  const model = string(settings.model);
  if (!model) return null;
  const reference = qualifiedModelReference(model);
  if (reference) return { type: 'source', ...reference };
  const separator = model.indexOf(':');
  return {
    type: 'unavailable',
    source: separator > 0 ? model.slice(0, separator) : 'unknown',
    modelId: (separator > 0 ? model.slice(separator + 1) : model) || 'unset',
    code: 'ORCHESTRATOR_MODEL_INVALID',
    message: string(settings.message),
  };
}
// Auxiliary feature models: one optional source-qualified pick per background
// capability (title generation, message predictions, memory and dream upkeep,
// speech refinement). An empty slot follows the session's main model. The
// engine resolves credentials for a configured target and degrades an
// unavailable one back to the main model instead of failing the maintenance
// path; the speech refinement slot is host-owned and read at call time.
export const FEATURE_MODEL_SLOTS = ['title', 'prediction', 'memory', 'voice_refinement'] as const;
export type FeatureModelSlot = typeof FEATURE_MODEL_SLOTS[number];
/** Bridge field names for the four slots; only the first three cross the facade. */
export const FEATURE_MODEL_FIELDS = { title: 'title', prediction: 'prediction', memory: 'memory', voiceRefinement: 'voice_refinement' } as const;
export type FeatureModelField = keyof typeof FEATURE_MODEL_FIELDS;
export type FeatureModelView = Record<FeatureModelField, string>;
export type FeatureTargets = { title: AdvisorTarget; prediction: AdvisorTarget; memory: AdvisorTarget };
function featureKey(slot: FeatureModelSlot): string { return `feature_models.${slot}`; }
function featureModels(db: DatabaseSync): FeatureModelView {
  return { title: normalizedModelValue(get(db, featureKey('title')) ?? ''),
    prediction: normalizedModelValue(get(db, featureKey('prediction')) ?? ''),
    memory: normalizedModelValue(get(db, featureKey('memory')) ?? ''),
    voiceRefinement: normalizedModelValue(get(db, featureKey('voice_refinement')) ?? '') };
}
function featureTarget(db: DatabaseSync, slot: FeatureModelSlot): AdvisorTarget {
  const value = normalizedModelValue(get(db, featureKey(slot)) ?? '');
  if (!value) return null;
  const reference = qualifiedModelReference(value);
  if (reference) return { type: 'source', ...reference };
  const separator = value.indexOf(':');
  return { type: 'unavailable', source: separator > 0 ? value.slice(0, separator) : 'unknown',
    modelId: (separator > 0 ? value.slice(separator + 1) : value) || 'unset',
    code: 'FEATURE_MODEL_INVALID', message: 'Choose an auxiliary model with an explicit supported source (source:model). The chat model runs this task until the pick is fixed.' };
}
/** Call-time read for host-owned routes: an invalid or unreadable value means "unset". */
export function readFeatureModelReference(slot: FeatureModelSlot, configRoot = configRootFrom()): { source: string; modelId: string } | null {
  try {
    return withSettingsTransaction(configRoot, db => {
      const value = normalizedModelValue(get(db, featureKey(slot)) ?? '');
      return value ? qualifiedModelReference(value) ?? null : null;
    });
  } catch { return null; }
}
// One-time fold of the per-source advisor picks into the single global pick:
// the first source (in migration order) holding either advisor row wins. The
// advisor is one model for the whole app — a chat's source no longer decides
// which advisor row is in force.
function migrateAdvisorConfig(db: DatabaseSync): void {
  const order = [...IMAGE_MIGRATION_ORDER, 'kimi', 'bailian', 'local'];
  const qualify = (model: string, source: string): string => {
    const value = normalizedModelValue(model);
    const separator = value.indexOf(':');
    const qualified = separator > 0 && [...MODEL_SOURCES, 'local', 'klaus'].includes(value.slice(0, separator));
    return !value || qualified ? value : `${source}:${value}`;
  };
  const saved = get(db, 'advisor.model');
  if (get(db, 'advisor.enabled') !== undefined || saved !== undefined) {
    // Earlier global migrations kept a bare model. Only unique historical
    // ownership can recover its source; the current chat/default is not evidence.
    const model = normalizedModelValue(saved ?? '');
    if (model && !model.includes(':')) {
      const owners = order.filter(source => normalizedModelValue(get(db, 'advisor.model.' + source) ?? '') === model);
      if (owners.length === 1) put(db, 'advisor.model', qualify(model, owners[0]!));
    }
    return;
  }
  for (const source of order) {
    const model = get(db, 'advisor.model.' + source), flag = get(db, 'advisor.enabled.' + source);
    if (model === undefined && flag === undefined) continue;
    if (model !== undefined) put(db, 'advisor.model', qualify(model, source));
    if (flag !== undefined) put(db, 'advisor.enabled', flag);
    return;
  }
}
function imageProvider(value: Json | undefined): string | undefined {
  const provider = string(value).trim();
  if (['google-gemini', 'google-imagen'].includes(provider)) return 'google';
  return ['openai-compatible', 'doubao-ark', 'google'].includes(provider) ? provider : undefined;
}
/**
 * Which speech protocol a stored audio row speaks.
 *
 * Three, because the platforms that actually publish an audio API disagree on its
 * shape and none of them is a superset of another: an OpenAI-compatible body, the
 * platform's own nested `input` protocol, or MiniMax's hex-inlined one. An unknown
 * value falls back to the compatible route rather than rejecting the row, so a saved
 * config from an older build keeps working.
 */
function audioProvider(value: Json | undefined): string | undefined {
  const provider = string(value).trim();
  return ['openai-compatible', 'dashscope', 'minimax', 'zhipu', 'bailian'].includes(provider) ? provider : undefined;
}
type MediaKind = 'image' | 'video' | 'audio' | 'music';
function mediaKey(kind: MediaKind, selected: string): string { return `${kind}_generation.model_config:${selected}`; }
// Image generation is one global choice: a selection (which backend runs) plus
// one custom endpoint configuration. Other media kinds keep independent global choices.
const IMAGE_CONFIG_KEY = 'image_generation.model_config';
const IMAGE_SELECTION_KEY = 'image_generation.selection';
export const IMAGE_SELECTION_SOURCES = ['none', ...SUBSCRIPTION_IMAGE_SOURCES] as const;
export type ImageSelection = typeof IMAGE_SELECTION_SOURCES[number];
// Video generation is one global choice too, and independent of the language
// source: which video route runs generate_video for every chat. The list holds
// only subscription products whose video route was verified once during
// integration and recorded in the shared registry; a configurable endpoint is
// not a video source. Every listed source stays visible and selectable even
// before its account is connected, because an unconnected subscription is a
// state the user needs to see and act on, with a connection notice beside the
// choice, not a backend that silently cannot run.
const VIDEO_SELECTION_KEY = 'video_generation.selection';
export const VIDEO_SELECTION_SOURCES = ['none', ...SUBSCRIPTION_VIDEO_SOURCES] as const;
export type VideoSelection = typeof VIDEO_SELECTION_SOURCES[number];
// The global video endpoint slot. It reuses the key name the legacy unsuffixed
// video row had: that row was already global in effect (the old per-source rows
// were never read by the video route once the source-scoped experiment ended), so
// keeping the name makes the migration a no-op for anyone who configured it.
const VIDEO_CONFIG_KEY = 'video_generation.model_config';
// Audio generation is the third global media choice, with the same shape as video:
// which audio route runs generate_audio for every chat, independent of the language
// source. Speech generation uses subscription routes only. Retired custom
// endpoint settings stay inert and cannot become an active selection.
const AUDIO_SELECTION_KEY = 'audio_generation.selection';
export const AUDIO_SELECTION_SOURCES = ['none', 'cursor', 'minimax', 'bailian', 'workbuddy'] as const;
export type AudioSelection = typeof AUDIO_SELECTION_SOURCES[number];
const MUSIC_SELECTION_KEY = 'music_generation.selection';
export const MUSIC_SELECTION_SOURCES = ['none', ...SUBSCRIPTION_MUSIC_SOURCES] as const;
// The global audio endpoint slot, keyed exactly like the image and video ones.
const AUDIO_CONFIG_KEY = 'audio_generation.model_config';
// Migration order: the first source holding a saved custom configuration wins
// the global slot; with none saved, the first source whose own image API could
// be followed wins the selection.
const IMAGE_MIGRATION_ORDER = ['custom', 'subscription', 'qoder', 'qwenwork', 'workbuddy', 'codex'] as const;
function media(db: DatabaseSync, kind: MediaKind): JsonObject {
  if (kind === 'music') return nativeMedia(db, kind, 'qwenwork');
  // Custom endpoint configuration is global and never contains native model preferences.
  const configKey = kind === 'image' ? IMAGE_CONFIG_KEY : kind === 'video' ? VIDEO_CONFIG_KEY : AUDIO_CONFIG_KEY;
  const parsed = decoded(get(db, configKey));
  // Preserve retired choices for an unavailable notice, without a local writer.
  if (parsed.provider === 'local') {
    const localModel = string(parsed.localModel).trim();
    return { provider: 'local', ...(localModel ? { localModel } : {}) };
  }
  const result: JsonObject = {};
  // `voice` is audio-only: it names the timbre a speech route must be told to use,
  // and no image or video row ever carries one.
  for (const key of kind === 'audio' ? ['baseUrl', 'apiKey', 'model', 'voice'] : ['baseUrl', 'apiKey', 'model']) {
    const value = parsed[key];
    if (typeof value !== 'string' || kind !== 'image' && !value || kind === 'image' && key === 'model' && value.trim() === 'auto') continue;
    result[key] = value;
  }
  const inferred = Object.values(result).some(Boolean) ? 'openai-compatible' : undefined;
  // Audio keeps its protocol choice, because the three speech routes speak three
  // incompatible shapes and the dispatcher needs the stored value. Image keeps its
  // provider for the same reason; video's single OpenAI-compatible route never reads
  // one, so only image and audio resolve a provider here.
  const provider = kind === 'image' ? imageProvider(parsed.provider) ?? inferred
    : kind === 'audio' ? audioProvider(parsed.provider) ?? inferred
    : inferred;
  if (provider) result.provider = provider;
  return result;
}
/** Native model preferences never share a custom endpoint or credential slot. */
function nativeMedia(db: DatabaseSync, kind: MediaKind, selected: string): JsonObject {
  const config = decoded(get(db, `${kind}_generation.native_model:${selected}`));
  return { source: selected, ...Object.fromEntries((mediaPreferenceFields(kind, selected) ?? []).flatMap(key => typeof config[key] === 'string' ? [[key, config[key]]] : [])) };
}

/** Called in the same transaction as the backend write, after all fields validate. */
function selectMediaModels(db: DatabaseSync, kind: MediaKind, source: string, payload: JsonObject): string | null {
  if (payload.imageEditModel !== undefined) return 'media_model_invalid';
  const supplied = ['model'].filter(field => payload[field] !== undefined);
  if (!supplied.length) return null;
  if (supplied.some(field => typeof payload[field] !== 'string' || string(payload[field]).length > 512 || /[\u0000-\u001f\u007f]/u.test(string(payload[field])))) return 'media_model_invalid';
  const fields = mediaPreferenceFields(kind, source);
  if (fields) {
    if (supplied.some(field => !fields.includes(field) && string(payload[field]) !== '')) return 'media_model_invalid';
    const config = nativeMedia(db, kind, source);
    delete config.source;
    for (const field of supplied) if (fields.includes(field)) {
      const value = string(payload[field]).trim();
      if (value) config[field] = value; else delete config[field];
    }
    put(db, `${kind}_generation.native_model:${source}`, JSON.stringify(config));
  } else if (source === 'custom') {
    const key = kind === 'image' ? IMAGE_CONFIG_KEY : kind === 'video' ? VIDEO_CONFIG_KEY : AUDIO_CONFIG_KEY;
    const config = decoded(get(db, key));
    config.model = string(payload.model).trim();
    put(db, key, JSON.stringify(config));
  } else if (string(payload.model) !== configuredMediaModel(kind, source, {})) return 'media_model_invalid';
  return null;
}

/** Generation owns the shared image model; promote an edit-only legacy preference once. */
function migrateUnifiedImageModel(db: DatabaseSync): void {
  for (const source of ['qwenwork', 'workbuddy']) {
    const key = `image_generation.native_model:${source}`;
    const config = decoded(get(db, key));
    if (!Object.hasOwn(config, 'imageEditModel')) continue;
    if (config.model === undefined && typeof config.imageEditModel === 'string' && config.imageEditModel.trim()) config.model = config.imageEditModel;
    delete config.imageEditModel;
    put(db, key, JSON.stringify(config));
  }
}

/** Preserve the previous plan model once, then stop coupling it to custom endpoints. */
function migrateSubscriptionMediaModels(db: DatabaseSync): void {
  for (const [kind, sources] of [['video', ['minimax']], ['audio', ['minimax', 'bailian']]] as const) {
    for (const source of sources) {
      const key = `${kind}_generation.native_model:${source}`;
      if (get(db, key) !== undefined) continue;
      const legacy = media(db, kind);
      put(db, key, JSON.stringify(Object.fromEntries((mediaPreferenceFields(kind, source) ?? []).flatMap(field => typeof legacy[field] === 'string' ? [[field, legacy[field]]] : []))));
    }
  }
}
function hasImageConfig(config: JsonObject): boolean {
  return Boolean(string(config.provider)) || Boolean(string(config.baseUrl)) || Boolean(string(config.apiKey)) || Boolean(string(config.model));
}
/** The custom backend is selectable only with a stored API key: every shipped
 *  image provider is a cloud endpoint, and a keyless row would offer a
 *  dropdown choice that cannot generate. Migrated local rows keep the global
 *  slot but stay unselectable until re-saved with a key. */
export function customImageReady(config: JsonObject): boolean {
  if (config.provider === 'local') return false;
  return Boolean(string(config.provider)) && Boolean(string(config.apiKey));
}
function imageSelection(db: DatabaseSync): string {
  const stored = string(get(db, IMAGE_SELECTION_KEY)).trim();
  return IMAGE_SELECTION_SOURCES.some(source => source === stored) ? stored : 'none';
}
function videoSelection(db: DatabaseSync): string {
  const stored = string(get(db, VIDEO_SELECTION_KEY)).trim();
  return VIDEO_SELECTION_SOURCES.some(source => source === stored) ? stored : 'none';
}
function audioSelection(db: DatabaseSync): string {
  const stored = string(get(db, AUDIO_SELECTION_KEY)).trim();
  return AUDIO_SELECTION_SOURCES.some(source => source === stored) ? stored : 'none';
}
function musicSelection(db: DatabaseSync): string {
  return get(db, MUSIC_SELECTION_KEY) === 'qwenwork' ? 'qwenwork' : 'none';
}
/** Preserve music intent without activating an unselected speech credential. */
function migrateMusicConfig(db: DatabaseSync): void {
  const legacyMusicSelected = get(db, AUDIO_SELECTION_KEY) === 'qwenwork';
  if (get(db, MUSIC_SELECTION_KEY) === undefined) {
    const legacyModel = get(db, 'audio_generation.native_model:qwenwork');
    if (legacyModel !== undefined && get(db, 'music_generation.native_model:qwenwork') === undefined) {
      put(db, 'music_generation.native_model:qwenwork', legacyModel);
    }
    put(db, MUSIC_SELECTION_KEY, legacyMusicSelected ? 'qwenwork' : 'none');
  }
  if (legacyMusicSelected) put(db, AUDIO_SELECTION_KEY, 'none');
}
// One-time fold of the per-source image configurations into the global slot:
// the first source (in migration order) holding a saved configuration becomes
// the global custom configuration and the selection points at custom; with no
// saved configuration anywhere, the first source whose own image API can be
// followed becomes the selection. Old per-source rows stay in place as inert
// evidence; reads never consult them again.
// One-time fold of the per-source video configurations into the global slot,
// mirroring the image migration: a saved endpoint row is preserved as inert
// evidence while the selection moves to the disabled state, because video no
// longer offers a configurable endpoint source. The legacy per-source rows stay
// in place; reads never consult them again.
const VIDEO_MIGRATION_ORDER = ['custom', 'minimax', 'subscription', 'qoder', 'qwenwork', 'workbuddy', 'kimi', 'bailian'] as const;
function migrateVideoConfig(db: DatabaseSync): void {
  if (get(db, VIDEO_SELECTION_KEY) !== undefined) return;
  // The selection follows whichever per-source row wins the fold, because that row
  // is the user's prior intent: they configured video for that subscription. A
  // source this list does not carry keeps its endpoint row as inert evidence and
  // leaves video disabled instead of claiming a backend the user never chose.
  let winner = 'none';
  for (const source of VIDEO_MIGRATION_ORDER) {
    const parsed = decoded(get(db, mediaKey('video', source)));
    // Retired local rows migrate too, exactly as the image migration does: the
    // global slot then answers with the same unavailable notice the per-source
    // slot used to, instead of silently pretending nothing was ever configured.
    if (parsed.provider === 'local') {
      const localModel = string(parsed.localModel).trim();
      const row: JsonObject = { provider: 'local', ...(localModel ? { localModel } : {}) };
      if (get(db, VIDEO_CONFIG_KEY) === undefined) put(db, VIDEO_CONFIG_KEY, JSON.stringify(row));
      break;
    }
    const result: JsonObject = {};
    for (const key of ['baseUrl', 'apiKey', 'model']) {
      const value = parsed[key];
      if (typeof value !== 'string' || !value) continue;
      result[key] = value;
    }
    if (Object.values(result).some(Boolean)) {
      if (get(db, VIDEO_CONFIG_KEY) === undefined) put(db, VIDEO_CONFIG_KEY, JSON.stringify(result));
      // Historical endpoint rows never opt users into a newly added native service.
      winner = source === 'minimax' ? source : 'none';
      break;
    }
  }
  put(db, VIDEO_SELECTION_KEY, winner);
}
/** A stored video backend that no longer exists must not keep spending its endpoint. */
function migrateRetiredVideoSelection(db: DatabaseSync): void {
  const stored = string(get(db, VIDEO_SELECTION_KEY)).trim();
  if (stored === 'custom' || stored === 'cursor') put(db, VIDEO_SELECTION_KEY, 'none');
}
function migrateImageConfig(db: DatabaseSync): void {
  if (get(db, IMAGE_SELECTION_KEY) !== undefined) return;
  const legacyImageConfig = (source: string): JsonObject => {
    const parsed = decoded(get(db, mediaKey('image', source)));
    if (parsed.provider === 'local') {
      const localModel = string(parsed.localModel).trim();
      return { provider: 'local', ...(localModel ? { localModel } : {}) };
    }
    const result: JsonObject = {};
    for (const key of ['baseUrl', 'apiKey', 'model']) {
      const value = parsed[key];
      if (typeof value !== 'string' || (key === 'model' && value.trim() === 'auto')) continue;
      result[key] = value;
    }
    const inferred = Object.values(result).some(Boolean) ? 'openai-compatible' : undefined;
    const provider = imageProvider(parsed.provider) ?? inferred;
    if (provider) result.provider = provider;
    return result;
  };
  for (const source of IMAGE_MIGRATION_ORDER) {
    const config = legacyImageConfig(source);
    if (hasImageConfig(config)) {
      // Retired local rows migrate too: the global slot then answers with the
      // same unavailable notice the per-source slot used to, instead of
      // silently pretending nothing was ever configured.
      put(db, IMAGE_CONFIG_KEY, JSON.stringify(config));
      put(db, IMAGE_SELECTION_KEY, 'custom');
      return;
    }
  }
  // Nothing saved anywhere: the neutral default is the custom endpoint, whose
  // notice tells the user where to configure it. Claiming a subscription here
  // would pick a backend the user never chose.
  put(db, IMAGE_SELECTION_KEY, 'custom');
}

/** Source-scoped settings read by host tools at call time; this class owns no tool runtime. */
export class ModelFeatureSettings {
  constructor(readonly configRoot = configRootFrom()) {}
  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    try {
      return withSettingsTransaction(this.configRoot, db => {
        // The unsuffixed video key is the GLOBAL video configuration now, exactly
        // like the image one, so it must not be folded away or deleted here. The
        // legacy rows are the per-source ones, and they fold in once, below.
        migrateImageConfig(db);
        migrateVideoConfig(db);
        migrateRetiredVideoSelection(db);
        migrateMusicConfig(db);
        migrateSubscriptionMediaModels(db);
        migrateUnifiedImageModel(db);
        migrateAdvisorConfig(db);
        return operation(db);
      });
    } catch (error) { throw new IpcHandlerError('SETTINGS_DB_WRITE_FAILED', errorMessage(error)); }
  }
  getAdvisor(): Json { return this.transaction(db => advisor(db)); }
  getAdvisorTarget(): AdvisorTarget { return this.transaction(db => advisorTarget(db)); }
  setAdvisor(payload: JsonObject): Json {
    return this.transaction((db): Json => {
      const previous = advisor(db), enabled = payload.enabled === undefined ? previous.enabled === true : payload.enabled === true;
      const supplied = Object.hasOwn(payload, 'model');
      if (supplied && typeof payload.model !== 'string') return { ok: false, error: 'advisor_model_invalid', settings: previous };
      const model = supplied ? normalizedModelValue(string(payload.model)) : string(previous.model);
      // Enabling without a model is accepted: the flag is stored as given and
      // the pick stays inert until a model is chosen, exactly like a disabled one.
      if ((enabled || supplied && model !== previous.model) && model && !qualifiedModelReference(model)) return { ok: false, error: 'advisor_model_invalid', settings: previous };
      put(db, 'advisor.enabled', enabled ? '1' : '0'); put(db, 'advisor.model', model);
      return { ok: true, settings: advisor(db) };
    });
  }
  getOrchestrator(): Json { return this.transaction(db => orchestrator(db)); }
  getOrchestratorTarget(): AdvisorTarget { return this.transaction(db => orchestratorTarget(db)); }
  getOrchestratorFallbackToMain(): boolean { return this.transaction(db => get(db, 'orchestrator.fallback_to_main') === '1'); }
  setOrchestrator(payload: JsonObject): Json {
    return this.transaction((db): Json => {
      const previous = orchestrator(db);
      const suppliedModel = Object.hasOwn(payload, 'model');
      if (suppliedModel && typeof payload.model !== 'string') return { ok: false, error: 'orchestrator_model_invalid', settings: previous };
      const suppliedFallback = Object.hasOwn(payload, 'fallbackToMain');
      if (suppliedFallback && typeof payload.fallbackToMain !== 'boolean') return { ok: false, error: 'orchestrator_fallback_invalid', settings: previous };
      const model = suppliedModel ? normalizedModelValue(string(payload.model)) : string(previous.model);
      if (model && !qualifiedModelReference(model)) return { ok: false, error: 'orchestrator_model_invalid', settings: previous };
      const fallbackToMain = suppliedFallback ? Boolean(payload.fallbackToMain) : Boolean(previous.fallbackToMain);
      if (model) put(db, 'orchestrator.model', model);
      else db.prepare('DELETE FROM settings WHERE key = ?').run('orchestrator.model');
      put(db, 'orchestrator.fallback_to_main', fallbackToMain ? '1' : '0');
      return { ok: true, settings: orchestrator(db) };
    });
  }
  getFeatureModels(): Json { return this.transaction(db => ({ ok: true, settings: featureModels(db) })); }
  getFeatureTargets(): FeatureTargets {
    return this.transaction(db => ({ title: featureTarget(db, 'title'), prediction: featureTarget(db, 'prediction'), memory: featureTarget(db, 'memory') }));
  }
  setFeatureModels(payload: JsonObject): Json {
    return this.transaction((db): Json => {
      const previous = featureModels(db), next: FeatureModelView = { ...previous };
      for (const field of Object.keys(FEATURE_MODEL_FIELDS) as FeatureModelField[]) {
        if (!Object.hasOwn(payload, field)) continue;
        const raw = payload[field];
        if (typeof raw !== 'string') return { ok: false, error: 'feature_model_invalid', settings: previous };
        const value = normalizedModelValue(raw);
        // An empty value is the follow-the-chat-model default; anything else
        // must be a fully qualified identity, exactly like the advisor pick.
        if (value && !qualifiedModelReference(value)) return { ok: false, error: 'feature_model_invalid', settings: previous };
        next[field] = value;
      }
      for (const [field, slot] of Object.entries(FEATURE_MODEL_FIELDS) as Array<[FeatureModelField, FeatureModelSlot]>) {
        if (next[field] !== previous[field]) put(db, featureKey(slot), next[field]);
      }
      return { ok: true, settings: featureModels(db) };
    });
  }
  getMedia(kind: MediaKind, payload: JsonObject = {}): Json {
    return this.transaction(db => {
      if (kind === 'audio' && payload.source === 'qwenwork' || kind !== 'image' && payload.source === 'antigravity') return {};
      if (payload.source === 'trae' && kind !== 'image' && kind !== 'video') return {};
      const source = string(payload.source);
      if (!mediaPreferenceFields(kind, source)) return media(db, kind);
      const config = nativeMedia(db, kind, source);
      // Plan model choices are independent; the existing shared voice preference stays unchanged.
      if (kind === 'audio' && ['minimax', 'bailian'].includes(source)) {
        const voice = media(db, kind).voice;
        if (typeof voice === 'string') config.voice = voice;
      }
      return config;
    });
  }
  getImageSelection(): Json { return this.transaction(db => ({ ok: true, selection: imageSelection(db), config: media(db, 'image') })); }
  setImageSelection(payload: JsonObject): Json {
    return this.transaction((db): Json => {
      const requested = string(payload.selection).trim();
      if (!IMAGE_SELECTION_SOURCES.some(source => source === requested)) return { ok: false, error: 'image_selection_unknown', selection: imageSelection(db) };
      const invalid = selectMediaModels(db, 'image', requested, payload); if (invalid) return { ok: false, error: invalid };
      put(db, IMAGE_SELECTION_KEY, requested);
      return { ok: true, selection: imageSelection(db) };
    });
  }
  setMedia(kind: MediaKind, payload: JsonObject): Json {
    return this.transaction((db): Json => {
      if (kind === 'image' && payload.imageEditModel !== undefined) return { ok: false, error: 'media_model_invalid' };
      if (kind === 'music' && payload.source !== 'qwenwork' || kind === 'audio' && payload.source === 'qwenwork' || kind !== 'image' && payload.source === 'antigravity') return { ok: false, error: 'media_source_unsupported' };
      if (payload.source === 'trae' && kind !== 'image' && kind !== 'video') return { ok: false, error: 'media_source_unsupported' };
      if (mediaPreferenceFields(kind, string(payload.source))) {
        const selected = string(payload.source);
        const fields = mediaPreferenceFields(kind, selected)!;
        if (Object.keys(payload).some(key => key !== 'source' && !fields.includes(key)) || fields.some(key => payload[key] !== undefined && (typeof payload[key] !== 'string' || string(payload[key]).length > 512 || /[\u0000-\u001f\u007f]/u.test(string(payload[key]))))) return { ok: false, error: 'native_media_config_invalid' };
        const previous = nativeMedia(db, kind, selected);
        const config = Object.fromEntries(fields.flatMap(key => { const value = payload[key] ?? previous[key]; return typeof value === 'string' && value.trim() ? [[key, value.trim()]] : []; }));
        put(db, `${kind}_generation.native_model:${selected}`, JSON.stringify(config));
        return { ok: true, config: nativeMedia(db, kind, selected) };
      }
      const clean: JsonObject = {};
      for (const field of kind === 'audio' ? ['baseUrl', 'apiKey', 'model', 'voice'] : ['baseUrl', 'apiKey', 'model']) {
        const value = string(payload[field]).trim();
        if (value && !(kind === 'image' && field === 'model' && value === 'auto')) clean[field] = value;
      }
      if (Object.keys(clean).length > 0) clean.provider = kind === 'image' ? imageProvider(payload.provider) ?? 'openai-compatible'
        : kind === 'audio' ? audioProvider(payload.provider) ?? 'openai-compatible'
        : 'openai-compatible';
      put(db, kind === 'image' ? IMAGE_CONFIG_KEY : kind === 'video' ? VIDEO_CONFIG_KEY : AUDIO_CONFIG_KEY, JSON.stringify(clean));
      return { ok: true, config: media(db, kind) };
    });
  }
  getVideoSelection(): Json { return this.transaction(db => ({ ok: true, selection: videoSelection(db), config: media(db, 'video') })); }
  setVideoSelection(payload: JsonObject): Json {
    return this.transaction((db): Json => {
      const requested = string(payload.selection).trim();
      if (!VIDEO_SELECTION_SOURCES.some(source => source === requested)) return { ok: false, error: 'video_selection_unknown', selection: videoSelection(db) };
      const invalid = selectMediaModels(db, 'video', requested, payload); if (invalid) return { ok: false, error: invalid };
      put(db, VIDEO_SELECTION_KEY, requested);
      return { ok: true, selection: videoSelection(db) };
    });
  }
  getAudioSelection(): Json { return this.transaction(db => ({ ok: true, selection: audioSelection(db), config: media(db, 'audio') })); }
  getMusicSelection(): Json { return this.transaction(db => ({ ok: true, selection: musicSelection(db) })); }
  setMusicSelection(payload: JsonObject): Json {
    return this.transaction((db): Json => {
      const requested = string(payload.selection).trim();
      if (!MUSIC_SELECTION_SOURCES.some(source => source === requested)) return { ok: false, error: 'music_selection_unknown', selection: musicSelection(db) };
      const invalid = selectMediaModels(db, 'music', requested, payload); if (invalid) return { ok: false, error: invalid };
      put(db, MUSIC_SELECTION_KEY, requested);
      return { ok: true, selection: musicSelection(db) };
    });
  }
  setAudioSelection(payload: JsonObject): Json {
    return this.transaction((db): Json => {
      const requested = string(payload.selection).trim();
      if (!AUDIO_SELECTION_SOURCES.some(source => source === requested)) return { ok: false, error: 'audio_selection_unknown', selection: audioSelection(db) };
      const invalid = selectMediaModels(db, 'audio', requested, payload); if (invalid) return { ok: false, error: invalid };
      put(db, AUDIO_SELECTION_KEY, requested);
      return { ok: true, selection: audioSelection(db) };
    });
  }
}
