import { pickAntigravityModelMetadata } from '../../../shared/antigravity-model-catalog';
import { isTraeNativeEffort, pickTraeModelMetadata, traeThinkingLevels, traeThinkingLevel, traeVariantForThinking } from '../../../shared/trae-model-catalog';
import { isKiroNativeEffort, pickKiroModelMetadata, kiroThinkingLevels, kiroThinkingLevel, kiroVariantForThinking } from '../../../shared/kiro-model-catalog';
import { pickFastModeMetadata } from '../../../shared/model-fast-mode';
import type { Json } from '../../ipc/contract';
import { MODEL_SOURCES, THINKING_LEVELS, modelSource } from '../session-store';
import { object, string, type JsonObject } from '../service-types';
import { authMode, badRequest, mainModel, MobileError, nonempty, optionText, thinking, type MobileCall } from './protocol';
import { cursorVariantForFast, cursorVariantForThinkingAndFast, modelOptionForValue, modelOptionHasValue, modelOptionIsSelectable, modelOptionsForValue, pickCursorModelMetadata } from '../../../shared/cursor-model-catalog';

const SOURCE_ROWS = [
  ['subscription', 'Claude Subscription', 'auth:status'], ['codex', 'Codex', 'codex-auth:status'],
  ['cursor', 'Cursor', 'cursor-auth:status'],
  ['qoder', 'Qoder', 'qoder-auth:status'], ['qwenwork', 'QwenWork', 'qwenwork-auth:status'],
  ['workbuddy', 'WorkBuddy', 'workbuddy-auth:status'], ['antigravity', 'Antigravity', 'antigravity-auth:status'], ['trae', 'TRAE CN', 'trae-auth:status'], ['kiro', 'Kiro', 'kiro-auth:status'], ['kimi', 'Kimi', 'kimi-auth:status'],
  ['bailian', 'Bailian Token Plan', 'bailian-auth:status'], ['minimax', 'MiniMax M Plan', 'minimax-auth:status'],
  ['zhipu', 'Zhipu Coding Plan', 'zhipu-auth:status'], ['ark', 'Ark Coding Plan', 'ark-auth:status'], ['custom', 'Custom', 'settings:models:list'],
] as const;
const LEVELS: readonly string[] = THINKING_LEVELS;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_MODELS = 500;

export interface MobileModelPreference { source: string; selection: string; thinkingLevel: string; ultraMode?: boolean; fastMode?: boolean }
export interface MobileModelUpdate { sessionId: string | null; source?: string; selection?: string; thinkingLevel?: string; ultraMode?: boolean; fastMode?: boolean }

export function modelConfigSession(value: unknown, required = false): string | null {
  if ((value === undefined && !required) || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw badRequest('sessionId must be a session id or null');
  return value;
}

export function modelConfigUpdate(payload: JsonObject, sourceHint?: string): MobileModelUpdate {
  if (Object.keys(payload).some(key => !['sessionId', 'source', 'selection', 'thinkingLevel', 'ultraMode', 'fastMode'].includes(key))) throw badRequest('Unknown model configuration field');
  if (!Object.hasOwn(payload, 'sessionId')) throw badRequest('sessionId must be explicit');
  const sessionId = modelConfigSession(payload.sessionId, true);
  const source = payload.source === undefined ? undefined : authMode(payload.source);
  const selection = payload.selection === undefined ? undefined : mainModel(payload.selection);
  const thinkingSource = source ?? (selection ? modelSource(selection) : undefined) ?? sourceHint;
  const thinkingLevel = payload.thinkingLevel === undefined ? undefined
    : (thinkingSource === 'trae' && isTraeNativeEffort(payload.thinkingLevel)
      || thinkingSource === 'kiro' && isKiroNativeEffort(payload.thinkingLevel)) ? payload.thinkingLevel : thinking(payload.thinkingLevel);
  if (payload.fastMode !== undefined && typeof payload.fastMode !== 'boolean') throw badRequest('fastMode must be a boolean');
  const fastMode = payload.fastMode;
  if (payload.ultraMode !== undefined && typeof payload.ultraMode !== 'boolean') throw badRequest('ultraMode must be a boolean');
  const ultraMode = payload.ultraMode;
  if (selection && selection.length > 1024) throw badRequest('selection is too long');
  if (source === undefined && selection === undefined && thinkingLevel === undefined && ultraMode === undefined && fastMode === undefined) throw badRequest('Provide a model configuration change');
  if (source && selection && modelSource(selection) && modelSource(selection) !== source) throw badRequest('The model does not belong to this source');
  return { sessionId, ...(source === undefined ? {} : { source }), ...(selection === undefined ? {} : { selection }), ...(thinkingLevel === undefined ? {} : { thinkingLevel }), ...(fastMode === undefined ? {} : { fastMode }), ...(ultraMode === undefined ? {} : { ultraMode }) };
}

export function modelPreference(value: Json | undefined): MobileModelPreference | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('modelPreference must be an object');
  const row = object(value);
  if (!['source', 'selection', 'thinkingLevel'].every(key => Object.hasOwn(row, key))) throw badRequest('modelPreference must include source, selection and thinkingLevel');
  if (Object.keys(row).some(key => !['source', 'selection', 'thinkingLevel', 'ultraMode', 'fastMode'].includes(key))) throw badRequest('Unknown modelPreference field');
  const update = modelConfigUpdate({ ...row, sessionId: null });
  return { source: update.source!, selection: update.selection!, thinkingLevel: update.thinkingLevel!, ...(update.fastMode === undefined ? {} : { fastMode: update.fastMode }), ...(update.ultraMode === undefined ? {} : { ultraMode: update.ultraMode }) };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MobileError(503, 'model_catalog_unavailable', 'The model catalog is unavailable')), QUERY_TIMEOUT_MS); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** One bounded discovery batch can serve multiple explicitly scoped snapshots. */
export class MobileModelConfigProjection {
  private sourceRows?: Promise<JsonObject[]>;
  private readonly catalogs = new Map<string, Promise<JsonObject[]>>();
  constructor(private readonly call: MobileCall, private readonly revision: () => number = () => 0) {}

  sources(): Promise<JsonObject[]> {
    return this.sourceRows ??= Promise.all(SOURCE_ROWS.map(async ([value, label, channel]) => {
      try {
        const answer = await bounded(this.call(channel));
        const needsReimport = value === 'cursor' && object(answer).needsReimport === true;
        const available = value === 'custom' ? Array.isArray(answer) && answer.length > 0 : object(answer).loggedIn === true && !needsReimport && object(answer).needsLogin !== true;
        return { value, label, available, ...(available ? {} : { reason: needsReimport ? 'Import the current local Cursor login again on this device.' : value === 'custom' ? 'No custom models are configured on this device.' : 'Sign in to this source on this device.' }) };
      } catch { return { value, label, available: false, reason: 'The source status is unavailable. Retry on this device.' }; }
    }));
  }

  models(source: string): Promise<JsonObject[]> {
    if (!MODEL_SOURCES.includes(source)) throw badRequest('source is invalid');
    const existing = this.catalogs.get(source); if (existing) return existing;
    const pending = bounded(this.call('session:get-main-model-options', { source })).then(answer => {
      const rows = object(answer).options, seen = new Set<string>(), models: JsonObject[] = [];
      if (!Array.isArray(rows)) throw new MobileError(503, 'model_catalog_unavailable', 'The model catalog is unavailable');
      for (const raw of rows) {
        const row = object(raw), value = nonempty(row.value);
        if (!value || modelSource(value) !== source || seen.has(value)) continue;
        if (models.length >= MAX_MODELS) throw new MobileError(503, 'model_catalog_too_large', 'The model catalog exceeds the mobile limit');
        seen.add(value); const model: JsonObject = { value, label: optionText(row.label) || value };
        const description = optionText(row.description); if (description && source !== 'antigravity' && source !== 'trae' && source !== 'kiro') model.description = description;
        if (Array.isArray(row.supportedThinkingLevels)) model.supportedThinkingLevels = LEVELS.filter(level => (row.supportedThinkingLevels as Json[]).includes(level));
        if (typeof row.defaultThinkingLevel === 'string' && LEVELS.includes(row.defaultThinkingLevel)) model.defaultThinkingLevel = row.defaultThinkingLevel;
        const traeMetadata = pickTraeModelMetadata(row);
        const kiroMetadata = pickKiroModelMetadata(row);
        Object.assign(model, pickCursorModelMetadata(row), pickAntigravityModelMetadata(row), traeMetadata, kiroMetadata, pickFastModeMetadata(row));
        if (source === 'kiro' && kiroMetadata.kiroVariants?.length) {
          model.supportedThinkingLevels = kiroThinkingLevels(kiroMetadata);
          const native = kiroThinkingLevel(kiroMetadata, value);
          if (native) model.defaultThinkingLevel = native;
        }
        if (source === 'trae' && traeMetadata.traeVariants?.length) {
          model.supportedThinkingLevels = traeThinkingLevels(traeMetadata);
          const native = traeThinkingLevel(traeMetadata, value);
          if (native !== undefined) model.defaultThinkingLevel = native;
        }
        if (typeof row.available === 'boolean') model.available = row.available;
        if (typeof row.reason === 'string') model.reason = row.reason;
        models.push(model);
      }
      return models;
    });
    this.catalogs.set(source, pending); return pending;
  }

  async snapshot(sessionId: string | null, previewSource?: string): Promise<JsonObject> {
    if (previewSource !== undefined) authMode(previewSource);
    const params: JsonObject = sessionId ? { sessionId } : {};
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.revision();
      const [mainRaw, levelRaw, fastRaw, ultraRaw, discovered] = await Promise.all([this.call('session:get-main-model', params), this.call('session:get-thinking-level', params), this.call('session:get-fast-mode', params), this.call('session:get-ultra-mode', params), this.sources()]);
      const fast = object(fastRaw);
      const main = object(mainRaw), source = nonempty(main.source);
      if (!source || !MODEL_SOURCES.includes(source)) throw new MobileError(500, 'invalid_model_config', 'Desktop returned an invalid model source');
      const selection = mainModel(main.mode), rawLevel = object(levelRaw).level;
      const thinkingLevel = source === 'trae' && isTraeNativeEffort(rawLevel) || source === 'kiro' && isKiroNativeEffort(rawLevel) ? rawLevel : thinking(rawLevel), catalogSource = previewSource ?? source;
      const sources = discovered.map(row => ({ ...row }));
      let models: JsonObject[] = [], catalogDefaultSelection: string | null = null;
      if (sources.some(row => row.value === catalogSource && row.available === true)) {
        const catalog = this.models(catalogSource).catch(() => {
          const row = sources.find(entry => entry.value === catalogSource)!;
          sources[sources.indexOf(row)] = { ...row, available: false, reason: 'The model catalog is unavailable. Retry on this device.' };
          return [];
        });
        const defaultSelection = previewSource === undefined ? Promise.resolve(null) : this.call('session:get-main-model', { ...params, previewSource }).then(value => nonempty(object(value).resolvedMode));
        [models, catalogDefaultSelection] = await Promise.all([catalog, defaultSelection]);
        if (catalogSource === source) models = modelOptionsForValue(models, selection);
      }
      // Discovery and model resolution can outlast a desktop or phone edit. Verify
      // persisted values again, so the response never combines separate epochs.
      const [latestMain, latestLevel, latestFastRaw, latestUltra] = await Promise.all([this.call('session:get-main-model', { ...params, resolve: false }), this.call('session:get-thinking-level', params), this.call('session:get-fast-mode', params), this.call('session:get-ultra-mode', params)]);
      const latestFast = object(latestFastRaw);
      if (revision !== this.revision() || object(latestMain).source !== source || object(latestMain).mode !== selection || object(latestLevel).level !== thinkingLevel
        || object(latestUltra).enabled !== object(ultraRaw).enabled || latestFast.enabled !== fast.enabled || latestFast.supported !== fast.supported || latestFast.billing !== fast.billing) {
        this.sourceRows = undefined; this.catalogs.clear(); continue;
      }
      return { sessionId, source, selection, resolvedSelection: nonempty(main.resolvedMode), thinkingLevel, ultraMode: object(ultraRaw).enabled === true, fastMode: fast.enabled === true, fastModeSupported: fast.supported === true,
        ...(fast.billing === 'extraCredits' ? { fastModeBilling: 'extraCredits' } : {}), catalogSource, sources, models,
        ...(previewSource === undefined ? {} : { catalogDefaultSelection }) };
    }
    throw new MobileError(409, 'model_configuration_changed', 'The model configuration changed during discovery. Retry on this device.');
  }

  async validate(preference: MobileModelPreference, includeThinking = true): Promise<void> {
    if (!(await this.sources()).some(row => row.value === preference.source && row.available === true)) throw new MobileError(409, 'model_source_unavailable', 'This model source is not configured on this device');
    const models = await this.models(preference.source);
    if (!models.length || preference.selection !== 'auto' && !models.some(row => (preference.source !== 'antigravity' || modelOptionIsSelectable(row, preference.source)) && modelOptionHasValue(row, preference.selection))) throw new MobileError(409, 'model_selection_unavailable', 'This model is not available on this device');
    if (includeThinking && preference.source === 'trae' && preference.thinkingLevel !== 'ultra') {
      const selection = preference.selection === 'auto'
        ? string(object(await this.call('session:get-main-model', { previewSource: preference.source })).resolvedMode) : preference.selection;
      const selected = modelOptionForValue(models, selection);
      const metadata = pickTraeModelMetadata(selected);
      if (traeThinkingLevels(metadata).length && !traeVariantForThinking(metadata, selection, preference.thinkingLevel)) {
        throw new MobileError(409, 'model_selection_unavailable', 'The selected reasoning level is unavailable');
      }
    }
    if (includeThinking && preference.source === 'kiro' && preference.thinkingLevel !== 'ultra') {
      const selection = preference.selection === 'auto'
        ? string(object(await this.call('session:get-main-model', { previewSource: preference.source })).resolvedMode) : preference.selection;
      const metadata = pickKiroModelMetadata(modelOptionForValue(models, selection));
      if (kiroThinkingLevels(metadata).length && !kiroVariantForThinking(metadata, selection, preference.thinkingLevel)) {
        throw new MobileError(409, 'model_selection_unavailable', 'The selected reasoning level is unavailable');
      }
    }
    if (preference.fastMode !== undefined) {
      const selection = preference.selection === 'auto'
        ? string(object(await this.call('session:get-main-model', { previewSource: preference.source })).resolvedMode) : preference.selection;
      const selected = modelOptionForValue(models, selection);
      const supported = preference.source === 'cursor'
        ? (includeThinking && preference.thinkingLevel !== 'ultra' ? cursorVariantForThinkingAndFast(selected, selection, preference.thinkingLevel, preference.fastMode)
          : cursorVariantForFast(selected, selection, preference.fastMode)) !== undefined : selected?.supportsFastMode === true;
      if (!supported) throw new MobileError(409, 'model_selection_unavailable', 'Fast mode is unavailable for this model');
    }
    // The persisted thinking level remains the user's preference. The model and
    // engine derive the supported effective level without overwriting that pick.
  }
}

export async function applyModelPreference(call: MobileCall, sessionId: string | null, preference: MobileModelPreference, updateDefaults = true, includeThinking = true): Promise<void> {
  const scope: JsonObject = sessionId ? { sessionId } : {};
  const check = (value: Json): void => {
    const row = object(value);
    if (row.ok !== true) throw new MobileError(409, 'model_configuration_rejected', string(row.error) || 'Desktop did not accept the model configuration');
  };
  const payload: JsonObject = { ...scope, mode: preference.selection, source: preference.source, updateDefaults };
  if (includeThinking) payload.thinkingLevel = preference.thinkingLevel;
  if (preference.fastMode !== undefined) payload.fastMode = preference.fastMode;
  if (preference.ultraMode !== undefined) payload.ultraMode = preference.ultraMode;
  check(await call('session:set-main-model', payload));
}
