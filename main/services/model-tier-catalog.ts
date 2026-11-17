import { pickAntigravityModelMetadata } from '../../shared/antigravity-model-catalog';
import { pickTraeModelMetadata } from '../../shared/trae-model-catalog';
import { pickKiroModelMetadata } from '../../shared/kiro-model-catalog';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { ComposerService } from './composer';
import type { EngineSettings } from './engine-settings';
import { MODEL_SOURCES } from './session-store';
import { MODEL_TIERS, type ModelTierMapping, type ModelReference } from './model-tier-settings';
import { type EngineRequest, type JsonObject, object, string, errorMessage } from './service-types';
import { modelOptionForValue, modelOptionIsSelectable, pickCursorModelMetadata } from '../../shared/cursor-model-catalog';

export interface TierCatalogDeps {
  configRoot: string;
  request: EngineRequest;
  engine: EngineSettings;
  sourceStatus?: (source: string) => Promise<Json>;
  catalogTimeoutMs?: number;
  /** Diagnostic timing sink; the catalog fans out across every source and the
   *  per-source split is the only way to tell a slow engine RPC from a slow
   *  credential read without guessing. */
  log?: (kind: string, detail: string) => void;
}
async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new IpcHandlerError('MODEL_CATALOG_TIMEOUT', 'The model source did not respond in time')), timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
export async function sourceTierCatalog(source: string, deps: TierCatalogDeps): Promise<JsonObject> {
  if (!MODEL_SOURCES.includes(source)) throw new IpcHandlerError('BAD_REQUEST', 'Unknown model source');
  const startedAt = Date.now();
  let statusMs = 0, optionsMs = 0;
  const work = async (): Promise<JsonObject> => {
    if (source !== 'custom') {
      if (!deps.sourceStatus) throw new IpcHandlerError('MODEL_SOURCE_STATUS_UNAVAILABLE', 'The model source login status is unavailable');
      const statusStartedAt = Date.now();
      const state = object(await deps.sourceStatus(source));
      statusMs = Date.now() - statusStartedAt;
      if (source === 'antigravity' && state.needsLogin === true) throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Reconnect the Antigravity account before using this source');
      if (source === 'trae' && state.needsLogin === true) throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Reconnect the TRAE CN account before using this source');
      if (source === 'kiro' && state.needsLogin === true) throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Reconnect the Kiro account before using this source');
      if (source === 'cursor' && state.needsLogin === true) {
        throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Sign in to Cursor again before using this source');
      }
      if (source === 'cursor' && state.needsReimport === true) {
        throw new IpcHandlerError('MODEL_SOURCE_NEEDS_REIMPORT', 'Import the current local Cursor login again before using this source');
      }
      if (state.loggedIn !== true && state.logged_in !== true && state.authenticated !== true) {
        throw new IpcHandlerError('MODEL_SOURCE_NOT_SIGNED_IN', 'Sign in to this model source before using it');
      }
    }
    const composer = new ComposerService({
      configRoot: deps.configRoot, request: deps.request, engineSettings: deps.engine,
      push: () => {}, onSessionConfigChanged: () => {},
    });
    const optionsStartedAt = Date.now();
    const rows = await composer.options(source, false, 'cached');
    optionsMs = Date.now() - optionsStartedAt;
    const options: JsonObject[] = [];
    for (const raw of rows) {
      const row = object(raw), prefix = source + ':', value = string(row.value);
      if (!value.startsWith(prefix) || value.length === prefix.length) continue;
      const modelId = value.slice(prefix.length);
      const item: JsonObject = { modelId, label: string(row.label) || modelId };
      if (typeof row.description === 'string') item.description = row.description;
      if (row.supportedThinkingLevels !== undefined) item.supportedThinkingLevels = row.supportedThinkingLevels;
      Object.assign(item, pickCursorModelMetadata(row), pickAntigravityModelMetadata(row), pickTraeModelMetadata(row), pickKiroModelMetadata(row));
      if (typeof row.available === 'boolean') item.available = row.available;
      if (typeof row.reason === 'string') item.reason = row.reason;
      options.push(item);
    }
    const ready = options.some(row => modelOptionIsSelectable(row, source));
    return { source, options, status: ready ? 'ready' : 'unavailable', ...(ready ? {} : options.length
      ? { reason: 'The model catalog contains no selectable entries', reasonCode: 'MODEL_SOURCE_UNAVAILABLE' }
      : { reason: 'No models are configured for this source', reasonCode: 'NO_MODELS_CONFIGURED' }) };
  };
  try { return await bounded(work(), deps.catalogTimeoutMs ?? 10_000); }
  catch (error) {
    const code = error instanceof IpcHandlerError ? error.code : '';
    return { source, options: [], status: ['MODEL_SOURCE_NOT_SIGNED_IN', 'MODEL_SOURCE_NEEDS_REIMPORT'].includes(code) ? 'unavailable' : 'error', reason: errorMessage(error), reasonCode: code };
  }
  finally {
    try {
      deps.log?.('model-tier-catalog', JSON.stringify({
        source, totalMs: Date.now() - startedAt, statusMs, optionsMs,
      }));
    } catch { /* Diagnostics cannot stall normal work. */ }
  }
}
export function modelSourceCatalog(deps: TierCatalogDeps): Promise<JsonObject[]> {
  return Promise.all(MODEL_SOURCES.map(source => sourceTierCatalog(source, deps)));
}
export async function modelTierCatalog(mappingInput: ModelTierMapping | Promise<ModelTierMapping>, deps: TierCatalogDeps): Promise<JsonObject> {
  // The source fan-out is the slow half (engine RPCs, credential reads); the
  // mapping read is a local sqlite row. Starting both together keeps the
  // mapping off the catalog's critical path.
  const sourcesPromise = modelSourceCatalog(deps);
  const [mapping, sources] = await Promise.all([Promise.resolve(mappingInput), sourcesPromise]);
  const tiers: JsonObject = {};
  for (const tier of MODEL_TIERS) {
    const target = mapping[tier];
    if (!target) { tiers[tier] = { status: 'inherit' }; continue; }
    const source = sources.find(row => row.source === target.source)!;
    const options = Array.isArray(source.options) ? source.options.map(object) : [];
    const found = modelOptionForValue(options, target.modelId);
    const reason = !found ? string(source.reason) || 'The selected model is no longer in this source catalog'
      : !modelOptionIsSelectable(found, target.source) ? string(found.reason) || 'The selected model is unavailable for this account' : '';
    tiers[tier] = { status: reason ? 'unavailable' : 'ready', label: string(found?.label) || target.modelId, ...(reason ? { reason } : {}) };
  }
  return { ok: true, revision: mapping.revision, sources, tiers };
}
export async function validateTierTarget(reference: ModelReference, deps: TierCatalogDeps): Promise<void> {
  const source = await sourceTierCatalog(reference.source, deps);
  const rows = Array.isArray(source.options) ? source.options.map(object) : [];
  const model = modelOptionForValue(rows, reference.modelId);
  if (source.status !== 'ready' || !modelOptionIsSelectable(model, reference.source)) {
    throw new IpcHandlerError('MODEL_TIER_TARGET_UNAVAILABLE', string(model?.reason) || string(source.reason) || 'The selected model is not available in this source');
  }
}
