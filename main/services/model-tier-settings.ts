import type { DatabaseSync } from 'node:sqlite';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { defaultModelPreference, MODEL_SOURCES } from './session-store';
import { kvOpt, withSettingsTransaction } from './settings';
import type { EngineSettings } from './engine-settings';
import { migrateProviderRolesToTiers } from './model-tier-migration';
import { isCursorModelAlias } from './model-sources';

export const GLOBAL_MODEL_TIERS_KEY = 'model_tiers:global';
export const MODEL_TIERS = ['high', 'medium', 'low'] as const;
export type ModelTier = typeof MODEL_TIERS[number];
export interface ModelReference { source: string; modelId: string }
export interface ModelTierMapping {
  version: 1;
  revision: number;
  high: ModelReference | null;
  medium: ModelReference | null;
  low: ModelReference | null;
  migration?: { source?: string; warning?: string };
}

function get(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return typeof row?.value === 'string' ? row.value : undefined;
}
function put(db: DatabaseSync, mapping: ModelTierMapping): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(GLOBAL_MODEL_TIERS_KEY, JSON.stringify(mapping));
}
export function modelReference(value: unknown): ModelReference | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcHandlerError('BAD_REQUEST', 'Select a model source and model');
  const ref = value as Record<string, unknown>;
  if (typeof ref.source !== 'string' || !MODEL_SOURCES.includes(ref.source)
    || typeof ref.modelId !== 'string' || !ref.modelId.trim() || ref.modelId !== ref.modelId.trim()
    || ref.modelId.length > 1024 || /[\u0000-\u001f\u007f]/.test(ref.modelId)
    || ref.source === 'cursor' && isCursorModelAlias(ref.modelId)) {
    throw new IpcHandlerError('BAD_REQUEST', 'Select a valid model source and model');
  }
  return { source: ref.source, modelId: ref.modelId };
}
function tierReference(value: unknown): ModelReference | null {
  // A stored global mapping can still name a source this build retired. Failing
  // the whole read would lock every conversation out of its tier settings, so
  // the retired reference degrades to "unset" while the rest of the map lives.
  if (value === null || value === undefined) return null;
  try { return modelReference(value); } catch { return null; }
}
function parseMapping(raw: string): ModelTierMapping {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const parsed = value as Record<string, unknown>;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || Number(parsed.revision) < 0) throw new Error();
    const mapping: ModelTierMapping = {
      version: 1, revision: Number(parsed.revision),
      high: tierReference(parsed.high), medium: tierReference(parsed.medium), low: tierReference(parsed.low),
    };
    const info = parsed.migration;
    if (info && typeof info === 'object' && !Array.isArray(info)) {
      const { source, warning } = info as Record<string, unknown>;
      mapping.migration = {
        ...(typeof source === 'string' && MODEL_SOURCES.includes(source) ? { source } : {}),
        ...(typeof warning === 'string' ? { warning } : {}),
      };
    }
    return mapping;
  } catch {
    throw new IpcHandlerError('MODEL_TIER_MAPPING_INVALID', 'The saved model tier configuration is invalid; it has not been overwritten');
  }
}
function mappingIn(db: DatabaseSync): ModelTierMapping {
  const existing = get(db, GLOBAL_MODEL_TIERS_KEY);
  if (existing !== undefined) return parseMapping(existing);
  const source = defaultModelPreference(db).source;
  const mapping: ModelTierMapping = { version: 1, revision: 0, high: null, medium: null, low: null, migration: { source } };
  const legacy = get(db, 'model_tiers:' + source);
  if (legacy !== undefined) {
    try {
      const values: unknown = JSON.parse(legacy);
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error();
      for (const tier of MODEL_TIERS) {
        const id = (values as Record<string, unknown>)[tier];
        if (typeof id === 'string' && id.trim()) mapping[tier] = tierReference({ source, modelId: id.trim() });
      }
    } catch {
      mapping.high = mapping.medium = mapping.low = null;
      mapping.migration!.warning = 'invalid_legacy_mapping';
    }
  }
  put(db, mapping);
  return mapping;
}
/** Preserve retired rows, including malformed values, as read-only migration evidence. */
export function readModelTierMapping(configRoot = configRootFrom()): ModelTierMapping {
  return withSettingsTransaction(configRoot, mappingIn);
}
export async function initializeModelTierMapping(engine: Pick<EngineSettings, 'providers' | 'request'>, configRoot = configRootFrom()): Promise<ModelTierMapping> {
  const existing = kvOpt(GLOBAL_MODEL_TIERS_KEY, configRoot);
  if (existing && typeof existing === 'object') throw new IpcHandlerError(existing.code, existing.message);
  if (existing === undefined) await migrateProviderRolesToTiers(engine, configRoot);
  return readModelTierMapping(configRoot);
}
export function setModelTierMapping(tier: unknown, target: unknown, expectedRevision: unknown, configRoot = configRootFrom()): ModelTierMapping {
  if (typeof tier !== 'string' || !(MODEL_TIERS as readonly string[]).includes(tier)) throw new IpcHandlerError('BAD_REQUEST', 'Select a valid model tier');
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new IpcHandlerError('BAD_REQUEST', 'The model tier revision is required');
  const reference = modelReference(target);
  readModelTierMapping(configRoot);
  return withSettingsTransaction(configRoot, db => {
    const previous = mappingIn(db);
    if (previous.revision !== expectedRevision) throw new IpcHandlerError('MODEL_TIER_REVISION_CONFLICT', 'The model tiers changed in another window. Reload them before saving');
    if (previous.revision === Number.MAX_SAFE_INTEGER) throw new IpcHandlerError('MODEL_TIER_REVISION_EXHAUSTED', 'The model tier revision cannot be advanced');
    const next: ModelTierMapping = { ...previous, [tier]: reference, revision: previous.revision + 1 };
    put(db, next);
    return next;
  });
}
