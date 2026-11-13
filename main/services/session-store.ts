import { classifyRuntimePolicy, decodeRuntimePolicy, isLegacyPermissionPreset, presetRuntimePolicy, type RuntimePolicy, type PermissionPreset } from '../../contracts/runtime-settings';
import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withSettingsDb, withSettingsTransaction } from './settings';
import { IpcHandlerError } from '../ipc/registry';
import { fastModePreferenceKey, isRequestFastSource } from '../../shared/model-fast-mode';

export interface SessionModelPreference { mode: string; source: string }

export const MODEL_SOURCES = ['subscription', 'custom', 'codex', 'cursor', 'qoder', 'qwenwork', 'workbuddy', 'antigravity', 'trae', 'kiro', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark'];

/**
 * The local reasoning and orchestration choices, kept here rather than in
 * `session-init.ts` because that module imports THIS one: defining the ladder on
 * the import side would be a cycle. `session-init.ts` re-reads it from here so
 * there is one list, not two that can drift.
 */
export const THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
/** What a conversation with no stored level of its own gets. */
export const DEFAULT_THINKING_LEVEL = 'medium';

export function validThinkingLevel(value: unknown): value is string {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function modelSource(mode: string): string | undefined {
  return MODEL_SOURCES.find(source => mode.startsWith(source + ':'));
}

export function validModelSelection(mode: string): boolean {
  return ['auto', 'high', 'medium', 'low'].includes(mode)
    || MODEL_SOURCES.some(source => mode.startsWith(source + ':') && mode.length > source.length + 1);
}

// A source keeps the last concrete model and reasoning choices the user made
// while it was active. Switching sources restores that snapshot instead of
// falling back to the source's built-in default every time.
const LAST_SOURCE_MODEL_PREFIX = 'composer.last_model:';
const LAST_SOURCE_THINKING_PREFIX = 'composer.last_thinking_level:';
const LAST_SOURCE_ULTRA_PREFIX = 'composer.last_ultra_mode:';

function lastSourceModelKey(source: string): string {
  return LAST_SOURCE_MODEL_PREFIX + source;
}

function lastSourceThinkingKey(source: string): string {
  return LAST_SOURCE_THINKING_PREFIX + source;
}

function lastSourceUltraKey(source: string): string {
  return LAST_SOURCE_ULTRA_PREFIX + source;
}

export function readLastSourceModel(db: DatabaseSync, source: string): string | undefined {
  const mode = get(db, lastSourceModelKey(source));
  if (typeof mode !== 'string' || !validModelSelection(mode) || mode === 'auto') return undefined;
  return modelSource(mode) === source ? mode : undefined;
}

function writeLastSourceModel(db: DatabaseSync, source: string, mode: string): void {
  if (!validModelSelection(mode) || mode === 'auto' || modelSource(mode) !== source) return;
  put(db, lastSourceModelKey(source), mode);
}

export function readLastSourceThinkingLevel(db: DatabaseSync, source: string): string | undefined {
  const level = get(db, lastSourceThinkingKey(source));
  return validThinkingLevel(level) ? level : undefined;
}

// The built-in default is stored explicitly: an absent row means "never chosen
// on this source", and a source switch must restore an explicit medium pick.
function writeLastSourceThinkingLevel(db: DatabaseSync, source: string, level: string): void {
  if (!validThinkingLevel(level)) return;
  put(db, lastSourceThinkingKey(source), level);
}

export function readLastSourceUltraMode(db: DatabaseSync, source: string): boolean | undefined {
  const value = get(db, lastSourceUltraKey(source));
  if (value === '1') return true;
  if (value === '0') return false;
  return undefined;
}

function writeLastSourceUltraMode(db: DatabaseSync, source: string, enabled: boolean): void {
  put(db, lastSourceUltraKey(source), enabled ? '1' : '0');
}

function get(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return typeof row?.value === 'string' ? row.value : undefined;
}

function put(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function defaultModelPreference(db: DatabaseSync): SessionModelPreference {
  const mode = get(db, 'composer.main_model') || 'auto';
  return { mode, source: modelSource(mode) ?? authModeIn(db) };
}

function authModeIn(db: DatabaseSync): string {
  const auth = get(db, 'auth_mode') ?? 'custom';
  return MODEL_SOURCES.includes(auth) ? auth : 'custom';
}

function historicalSessionIds(configRoot: string): Set<string> {
  const ids = new Set<string>();
  const entries = (path: string): string[] => {
    try { return readdirSync(path); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return [];
      throw error;
    }
  };
  for (const project of entries(join(configRoot, 'projects'))) {
    for (const file of entries(join(configRoot, 'projects', project))) {
      if (/\.jsonl(?:\.zst)?$/.test(file)) ids.add(file.replace(/\.jsonl(?:\.zst)?$/, ''));
    }
  }
  for (const file of entries(join(configRoot, 'sessions'))) {
    if (/\.jsonl(?:\.zst)?$/.test(file)) ids.add(file.replace(/\.jsonl(?:\.zst)?$/, '').replace(/^\d{10,}-/, ''));
  }
  return ids;
}

function ensureTables(db: DatabaseSync, configRoot: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS session_main_models (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, source TEXT NOT NULL DEFAULT \'\', updated_at INTEGER NOT NULL)');
  if (!db.prepare('PRAGMA table_info(session_main_models)').all().some(column => column.name === 'source')) {
    db.exec("ALTER TABLE session_main_models ADD COLUMN source TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE TABLE IF NOT EXISTS session_chat_modes (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_thinking_levels (session_id TEXT PRIMARY KEY, level TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_ultra_modes (session_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_orchestration_modes (session_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_fast_modes (session_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_source_fast_modes (session_id TEXT NOT NULL, source TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, source))');
  db.exec('CREATE TABLE IF NOT EXISTS session_permission_modes (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_runtime_policies (session_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  if (!get(db, 'migrated.collaboration_permission_v1')) {
    // A legacy planning policy does not retain enough information to grant edits.
    // Seed collaboration separately and preserve the strict approval policy.
    db.exec("INSERT INTO session_chat_modes (session_id, mode, updated_at) SELECT session_id, 'plan', updated_at FROM session_permission_modes WHERE mode = 'plan' ON CONFLICT(session_id) DO NOTHING");
    db.prepare("INSERT INTO session_runtime_policies(session_id,policy_json,updated_at) SELECT session_id, ?, updated_at FROM session_permission_modes WHERE mode='plan' ON CONFLICT(session_id) DO NOTHING").run(JSON.stringify({ policy: presetRuntimePolicy('default') }));
    db.exec("DELETE FROM session_permission_modes WHERE mode='plan'");
    if (get(db, 'composer.permission_mode') === 'plan') {
      db.prepare('DELETE FROM settings WHERE key=?').run('composer.permission_mode');
    }
    put(db, 'migrated.collaboration_permission_v1', '1');
  }

  if (!get(db, 'migrated.composer_session_thinking_v1')) {
    // Freeze the CURRENT global level into every conversation that already exists.
    //
    // Without this the first per-session read of an old conversation would capture
    // whatever the global happens to be at THAT moment, which is exactly the
    // behaviour being removed: a level chosen in conversation A would then reach a
    // conversation B that had never been opened since. Freezing once up front makes
    // "a conversation keeps the level it had" true for conversations that predate
    // per-session storage, not just for ones created after it.
    const level = get(db, 'composer.thinking_level');
    const frozen = validThinkingLevel(level) ? level : DEFAULT_THINKING_LEVEL;
    const ids = historicalSessionIds(configRoot);
    const insert = db.prepare('INSERT OR IGNORE INTO session_thinking_levels (session_id, level, updated_at) VALUES (?, ?, ?)');
    for (const id of ids) if (id) insert.run(id, frozen, Date.now());
    put(db, 'migrated.composer_session_thinking_v1', '1');
  }
  if (!get(db, 'migrated.composer_ultra_mode_v1')) {
    // Ultra used to ride the reasoning ladder as a stored level. It is now an
    // independent orchestration switch, so legacy rows keep their orchestration
    // grant while the native rung falls back to the level the engine clamp
    // applied at the provider boundary. The native pick that preceded Ultra was
    // never recorded, so it cannot be restored.
    const now = Date.now();
    const legacy = db.prepare("SELECT session_id, updated_at FROM session_thinking_levels WHERE level = 'ultra'").all() as Array<{ session_id: string; updated_at: number }>;
    for (const row of legacy) {
      db.prepare("UPDATE session_thinking_levels SET level = 'xhigh', updated_at = ? WHERE session_id = ? AND level = 'ultra'").run(Math.max(now, row.updated_at + 1), row.session_id);
      db.prepare('INSERT INTO session_ultra_modes (session_id, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(session_id) DO NOTHING')
        .run(row.session_id, now);
    }
    db.prepare('INSERT OR IGNORE INTO session_ultra_modes(session_id, enabled, updated_at) SELECT session_id, 0, ? FROM session_thinking_levels').run(now);
    if (get(db, 'composer.thinking_level') === 'ultra') {
      put(db, 'composer.thinking_level', 'xhigh');
      if (get(db, 'composer.ultra_mode') === undefined) put(db, 'composer.ultra_mode', '1');
    }
    put(db, 'migrated.composer_ultra_mode_v1', '1');
  }
  if (!get(db, 'migrated.composer_session_source_v3')) {
    const fallback = defaultModelPreference(db), ids = historicalSessionIds(configRoot);
    const insert = db.prepare('INSERT OR IGNORE INTO session_main_models (session_id, mode, source, updated_at) VALUES (?, ?, ?, ?)');
    for (const id of ids) if (id) insert.run(id, fallback.mode, fallback.source, Date.now());
    put(db, 'migrated.composer_global_v1', '1');
    put(db, 'migrated.composer_session_model_v2', '1');
    put(db, 'migrated.composer_session_source_v3', '1');
  }
  // Freeze every legacy row before a new default changes its source, including unopened conversations.
  const fallback = authModeIn(db);
  const rows = db.prepare("SELECT session_id, mode FROM session_main_models WHERE source = ''").all();
  const update = db.prepare('UPDATE session_main_models SET source = ? WHERE session_id = ?');
  for (const row of rows) {
    update.run(modelSource(String(row.mode)) ?? fallback, String(row.session_id));
  }
  if (!get(db, 'migrated.composer_retired_sources_v1')) {
    // The official cloud and on-device sources were retired. Rows still naming
    // them would fail every later read once the source list no longer knows
    // them, so old conversations would throw instead of opening at "model
    // unavailable". Rewriting them to the remembered default keeps the
    // conversation openable; the picker then reports the pick as unavailable.
    const fallback = authModeIn(db);
    const staleDefault = get(db, 'composer.main_model');
    if (typeof staleDefault === 'string' && (staleDefault.startsWith('klaus:') || staleDefault.startsWith('local:'))) {
      db.prepare('DELETE FROM settings WHERE key = ?').run('composer.main_model');
    }
    const storedAuth = get(db, 'auth_mode');
    if (storedAuth === 'klaus' || storedAuth === 'local') put(db, 'auth_mode', fallback);
    const defaultMode = get(db, 'composer.main_model') ?? 'auto';
    const stale = db.prepare("SELECT session_id FROM session_main_models WHERE source = 'klaus' OR source = 'local'").all();
    const update = db.prepare('UPDATE session_main_models SET mode = ?, source = ?, updated_at = ? WHERE session_id = ?');
    for (const row of stale) update.run(defaultMode, fallback, Date.now(), String(row.session_id));
    // Global tier mappings can still reference the retired sources; a dangling
    // reference would fail tier resolution for every conversation.
    const mappingRaw = get(db, 'model_tiers:global');
    if (mappingRaw) {
      try {
        const mapping: Record<string, unknown> = JSON.parse(mappingRaw);
        let changed = false;
        for (const tier of ['high', 'medium', 'low']) {
          const ref = mapping[tier] as { source?: string } | null | undefined;
          if (ref && (ref.source === 'klaus' || ref.source === 'local')) { mapping[tier] = null; changed = true; }
        }
        if (changed) put(db, 'model_tiers:global', JSON.stringify(mapping));
      } catch { /* a corrupt row is left for the reader to reject */ }
    }
    put(db, 'migrated.composer_retired_sources_v1', '1');
  }
  if (!get(db, 'migrated.composer_retired_sources_v2')) {
    // The QoderWork subscription source was retired when the service stopped
    // operating. Rows still naming it would fail every later read once the
    // source list no longer knows it, so old conversations would throw instead
    // of opening at "model unavailable". Rewriting them to the remembered
    // default keeps the conversation openable; the picker then reports the
    // pick as unavailable.
    const fallback = authModeIn(db);
    const staleDefault = get(db, 'composer.main_model');
    if (typeof staleDefault === 'string' && staleDefault.startsWith('qoderwork:')) {
      db.prepare('DELETE FROM settings WHERE key = ?').run('composer.main_model');
    }
    const storedAuth = get(db, 'auth_mode');
    if (storedAuth === 'qoderwork') put(db, 'auth_mode', fallback);
    const defaultMode = get(db, 'composer.main_model') ?? 'auto';
    const stale = db.prepare("SELECT session_id FROM session_main_models WHERE source = 'qoderwork'").all();
    const update = db.prepare('UPDATE session_main_models SET mode = ?, source = ?, updated_at = ? WHERE session_id = ?');
    for (const row of stale) update.run(defaultMode, fallback, Date.now(), String(row.session_id));
    // Global tier mappings can still reference the retired source; a dangling
    // reference would fail tier resolution for every conversation.
    const mappingRaw = get(db, 'model_tiers:global');
    if (mappingRaw) {
      try {
        const mapping: Record<string, unknown> = JSON.parse(mappingRaw);
        let changed = false;
        for (const tier of ['high', 'medium', 'low']) {
          const ref = mapping[tier] as { source?: string } | null | undefined;
          if (ref && ref.source === 'qoderwork') { mapping[tier] = null; changed = true; }
        }
        if (changed) put(db, 'model_tiers:global', JSON.stringify(mapping));
      } catch { /* a corrupt row is left for the reader to reject */ }
    }
    put(db, 'migrated.composer_retired_sources_v2', '1');
  }
  if (!get(db, 'migrated.composer_session_fast_v1')) {
    // Existing conversations start in Standard mode, including unopened history.
    db.prepare('INSERT OR IGNORE INTO session_fast_modes (session_id, enabled, updated_at) SELECT session_id, 0, ? FROM session_main_models')
      .run(Date.now());
    const insert = db.prepare('INSERT OR IGNORE INTO session_fast_modes (session_id, enabled, updated_at) VALUES (?, 0, ?)');
    for (const id of historicalSessionIds(configRoot)) if (id) insert.run(id, Date.now());
    put(db, 'migrated.composer_session_fast_v1', '1');
  }
  if (!get(db, 'migrated.composer_fast_source_scoped_v1')) {
    // Earlier revisions seeded every conversation's Fast row from the remembered
    // default with no source check, so conversations that never ran on a Codex
    // subscription carry an enabled flag they cannot use. Nothing reads those rows
    // while the conversation stays on another source, but the flag outlives the
    // source it was meaningless for. Clear them so the stored state matches the
    // rule the writers now enforce: a non-Codex conversation is never Fast.
    db.prepare(`
      UPDATE session_fast_modes SET enabled = 0, updated_at = ?
      WHERE enabled = 1 AND session_id NOT IN (
        SELECT session_id FROM session_main_models WHERE source = ?
      )
    `).run(Date.now(), CODEX_SOURCE);
    put(db, 'migrated.composer_fast_source_scoped_v1', '1');
  }
  if (!get(db, 'migrated.composer_native_fast_sources_v1')) {
    // Adding a new native capability cannot opt existing conversations into it.
    db.prepare(`INSERT OR IGNORE INTO session_source_fast_modes (session_id, source, enabled, updated_at)
      SELECT session_id, source, 0, ? FROM session_main_models WHERE source IN ('subscription', 'qoder', 'qoderwork')`)
      .run(Date.now());
    put(db, 'migrated.composer_native_fast_sources_v1', '1');
  }
}

/** The original Codex table and default remain the migration source for that account. */
const CODEX_SOURCE = 'codex';

/**
 * The remembered default, applied only to a conversation that can actually use it.
 *
 * A conversation on any other source gets a cleared row. Without this check the
 * remembered default spreads to conversations that cannot use it, and the flag
 * then sits there waiting for the source to change — at which point a
 * conversation the user never configured would start spending the higher-usage
 * tier on its own.
 */
function fastModeDefaultFor(db: DatabaseSync, source: string): number {
  const key = fastModePreferenceKey(source);
  return key && get(db, key) === 'true' ? 1 : 0;
}
function seedFastMode(db: DatabaseSync, sessionId: string, source: string): void {
  if (isRequestFastSource(source) && source !== CODEX_SOURCE) {
    db.prepare('INSERT OR IGNORE INTO session_source_fast_modes (session_id, source, enabled, updated_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, source, fastModeDefaultFor(db, source), Date.now());
  } else {
    db.prepare('INSERT OR IGNORE INTO session_fast_modes (session_id, enabled, updated_at) VALUES (?, ?, ?)')
      .run(sessionId, source === CODEX_SOURCE ? fastModeDefaultFor(db, source) : 0, Date.now());
  }
}
function writeFastMode(db: DatabaseSync, sessionId: string, source: string, enabled: boolean): void {
  if (source === CODEX_SOURCE) {
    db.prepare('INSERT INTO session_fast_modes (session_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
      .run(sessionId, enabled ? 1 : 0, Date.now());
  } else {
    db.prepare('INSERT INTO session_source_fast_modes (session_id, source, enabled, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, source) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
      .run(sessionId, source, enabled ? 1 : 0, Date.now());
  }
}

/** The source a conversation is bound to, for callers holding only its id. */
function sessionSourceIn(db: DatabaseSync, sessionId: string): string | undefined {
  const row = db.prepare('SELECT source FROM session_main_models WHERE session_id = ?').get(sessionId) as { source?: unknown } | undefined;
  return typeof row?.source === 'string' && row.source ? row.source : undefined;
}

function preferenceIn(db: DatabaseSync, sessionId: string, fallback: SessionModelPreference): SessionModelPreference {
  if (!sessionId) return fallback;
  ultraModeIn(db, sessionId);
  const row = db.prepare('SELECT mode, source FROM session_main_models WHERE session_id = ?').get(sessionId);
  if (!row) {
    db.prepare('INSERT INTO session_main_models (session_id, mode, source, updated_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, fallback.mode, fallback.source, Date.now());
    seedFastMode(db, sessionId, fallback.source);
    return fallback;
  }
  const mode = typeof row.mode === 'string' && row.mode ? row.mode : fallback.mode;
  const source = typeof row.source === 'string' && row.source ? row.source : modelSource(mode) ?? fallback.source;
  if (!MODEL_SOURCES.includes(source) || (modelSource(mode) !== undefined && modelSource(mode) !== source)) {
    throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'The saved model source does not match the selection');
  }
  return { mode, source };
}

/** Freeze the default once; an existing conversation keeps its own source. */
export function sessionModelPreference(
  sessionId: string, fallback: SessionModelPreference, configRoot: string,
): SessionModelPreference {
  if (!sessionId) return fallback;
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    return preferenceIn(db, sessionId, fallback);
  });
}

/** Read and initialize the session preference in the same SQLite snapshot as its default. */
export function readSessionModel(sessionId: string, configRoot: string): SessionModelPreference {
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    return preferenceIn(db, sessionId, defaultModelPreference(db));
  });
}

/** Snapshot a parent's composer preferences without changing future defaults. */
export function inheritSessionComposerPreferences(parentId: string, sessionId: string, configRoot: string): void {
  sessionRuntimePolicy(parentId, configRoot);
  withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    const model = preferenceIn(db, parentId, defaultModelPreference(db));
    const thinking = thinkingLevelIn(db, parentId);
    const ultra = ultraModeIn(db, parentId);
    const orchestration = orchestrationModeIn(db, parentId);
    const fast = fastModeIn(db, parentId, model.source);
    const now = Date.now();
    db.prepare('INSERT INTO session_main_models (session_id, mode, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET mode = excluded.mode, source = excluded.source, updated_at = excluded.updated_at')
      .run(sessionId, model.mode, model.source, now);
    db.prepare('INSERT INTO session_thinking_levels (session_id, level, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at')
      .run(sessionId, thinking, now);
    db.prepare('INSERT INTO session_ultra_modes (session_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
      .run(sessionId, ultra ? 1 : 0, now);
    db.prepare('INSERT INTO session_orchestration_modes (session_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
      .run(sessionId, orchestration ? 1 : 0, now);
    if (isRequestFastSource(model.source)) writeFastMode(db, sessionId, model.source, fast);
    db.prepare('INSERT INTO session_runtime_policies (session_id, policy_json, updated_at) SELECT ?, policy_json, ? FROM session_runtime_policies WHERE session_id = ? ON CONFLICT(session_id) DO UPDATE SET policy_json=excluded.policy_json, updated_at=excluded.updated_at').run(sessionId, now, parentId);
  });
}
/** Pin a host-owned conversation without changing the composer's future default. */
export function pinSessionModel(configRoot: string, sessionId: string, mode: string): void {
  if (!validModelSelection(mode)) throw new IpcHandlerError('INVALID_MODEL', 'Select a valid model');
  const previous = readSessionModel(sessionId, configRoot), source = modelSource(mode) ?? previous.source;
  withSettingsTransaction(configRoot, db => {
    db.prepare('UPDATE session_main_models SET mode = ?, source = ?, updated_at = ? WHERE session_id = ?')
      .run(mode, source, Date.now(), sessionId);
  });
}

/** A model pick changes this conversation and the future default, never other conversations. */
export function setSessionModel(
  sessionId: string, mode: string, requestedSource: string | undefined, configRoot: string,
  options: { thinkingLevel?: string; ultraMode?: boolean; fastMode?: boolean; updateDefaults?: boolean } = {},
): void {
  if (options.thinkingLevel !== undefined && !validThinkingLevel(options.thinkingLevel)) throw new IpcHandlerError('BAD_REQUEST', 'invalid level');
  if (options.fastMode !== undefined && typeof options.fastMode !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'invalid Fast mode');
  if (options.updateDefaults === false && !sessionId) throw new IpcHandlerError('BAD_REQUEST', 'Session-only initialization requires a session id');
  if (!validModelSelection(mode)) throw new IpcHandlerError('BAD_REQUEST', 'invalid mode');
  const explicit = modelSource(mode);
  if ((requestedSource !== undefined && !MODEL_SOURCES.includes(requestedSource))
    || (explicit !== undefined && requestedSource !== undefined && explicit !== requestedSource)) {
    throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'The model source does not match the selection');
  }
  withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    if (sessionId) ultraModeIn(db, sessionId);
    const previous = sessionId
      ? db.prepare('SELECT source FROM session_main_models WHERE session_id = ?').get(sessionId) as { source?: string } | undefined
      : undefined;
    const source = requestedSource ?? explicit
      ?? (typeof previous?.source === 'string' && previous.source ? previous.source : authModeIn(db));
    if (!MODEL_SOURCES.includes(source)) throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'Select a supported model source');
    if (options.fastMode !== undefined && !isRequestFastSource(source)) throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'Fast mode is unavailable for this model source');
    // A source switch restores the last concrete model and its reasoning
    // configuration the user chose while that source was active. An explicit
    // selection in this call always wins.
    const previousSource = sessionId
      ? (typeof previous?.source === 'string' && previous.source ? previous.source : authModeIn(db))
      : authModeIn(db);
    const sourceChanged = requestedSource !== undefined && requestedSource !== previousSource;
    const rememberedModel = sourceChanged ? readLastSourceModel(db, source) : undefined;
    const selectedMode = mode === 'auto' && rememberedModel ? rememberedModel : mode;
    const thinkingLevel = options.thinkingLevel ?? (sourceChanged ? readLastSourceThinkingLevel(db, source) : undefined);
    const ultraMode = options.ultraMode ?? (sourceChanged ? readLastSourceUltraMode(db, source) : undefined);
    if (options.updateDefaults !== false) {
      if (selectedMode === 'auto') db.prepare('DELETE FROM settings WHERE key = ?').run('composer.main_model');
      else put(db, 'composer.main_model', selectedMode);
      put(db, 'auth_mode', source);
      if (ultraMode !== undefined) put(db, 'composer.ultra_mode', ultraMode ? '1' : '0');
      if (thinkingLevel !== undefined) {
        if (thinkingLevel === DEFAULT_THINKING_LEVEL) db.prepare('DELETE FROM settings WHERE key = ?').run('composer.thinking_level');
        else put(db, 'composer.thinking_level', thinkingLevel);
      }
      if (options.fastMode !== undefined) {
        const key = fastModePreferenceKey(source)!;
        if (options.fastMode) put(db, key, 'true');
        else db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      }
      if (selectedMode !== 'auto') writeLastSourceModel(db, source, selectedMode);
      if (thinkingLevel !== undefined) writeLastSourceThinkingLevel(db, source, thinkingLevel);
      if (ultraMode !== undefined) writeLastSourceUltraMode(db, source, ultraMode);
    }
    if (sessionId) {
      db.prepare('INSERT INTO session_main_models (session_id, mode, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET mode = excluded.mode, source = excluded.source, updated_at = excluded.updated_at')
        .run(sessionId, selectedMode, source, Date.now());
      // Each source snapshots its own default once; switching accounts cannot
      // carry a higher-usage preference into another provider.
      if (ultraMode !== undefined) db.prepare('INSERT INTO session_ultra_modes(session_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at').run(sessionId, ultraMode ? 1 : 0, Date.now());
      seedFastMode(db, sessionId, source);
      if (options.fastMode !== undefined) writeFastMode(db, sessionId, source, options.fastMode);
      if (thinkingLevel !== undefined) db.prepare('INSERT INTO session_thinking_levels (session_id, level, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at')
        .run(sessionId, thinkingLevel, Date.now());
    }
  });
}

/**
 * The level a conversation uses, falling back to the global default ONCE.
 *
 * Mirrors {@link readSessionModel} exactly: the first read of a conversation with
 * no row of its own captures the current global default into that row, so a later
 * change to the default cannot reach it. That freeze-on-first-read is what makes
 * "changing one conversation leaves every other conversation alone" true.
 *
 * An empty sessionId means "the default for future conversations", which is the
 * same contract the model path uses when no session is named.
 */
export function readSessionThinkingLevel(sessionId: string, configRoot: string): string {
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    return thinkingLevelIn(db, sessionId);
  });
}

function thinkingLevelIn(db: DatabaseSync, sessionId: string): string {
  const fallback = defaultThinkingLevel(db);
  if (!sessionId) return fallback;
  ultraModeIn(db, sessionId);
  const row = db.prepare('SELECT level FROM session_thinking_levels WHERE session_id = ?').get(sessionId);
  if (!row) {
    db.prepare('INSERT INTO session_thinking_levels (session_id, level, updated_at) VALUES (?, ?, ?)')
      .run(sessionId, fallback, Date.now());
    return fallback;
  }
  // Older builds or manual settings edits can leave an unsupported value.
  return validThinkingLevel(row.level) ? row.level : fallback;
}

/**
 * A thinking-level pick changes THIS conversation and the future default, never
 * other conversations — the same rule {@link setSessionModel} applies to models.
 *
 * The global row is still written because it is the default new conversations
 * inherit. Writing it must not be read as "applies everywhere": the per-session
 * rows above are what every existing conversation reads, and each one was frozen
 * when it was first read.
 */
export function setSessionThinkingLevel(sessionId: string, level: string, configRoot: string): string {
  return applySessionThinkingSelection(sessionId, level, configRoot).level;
}

/** Persist reasoning, its optional native selection, mode and permission together. */
export function applySessionThinkingSelection(
  sessionId: string, level: string, configRoot: string, permissionPolicy?: RuntimePolicy,
  options: { model?: SessionModelPreference; ultraMode?: false; updateThinking?: boolean; updateDefaults?: boolean; updateUltraDefault?: boolean; updateModelDefault?: boolean } = {},
): { level: string; rollback(): void } {
  const { model, updateThinking = true, updateDefaults = true } = options;
  // The Ultra default for future chats keeps its own write scope.
  const updateUltraDefault = options.updateUltraDefault ?? updateDefaults;
  const updateModelDefault = options.updateModelDefault ?? updateDefaults;
  if (!updateDefaults && !sessionId) throw new IpcHandlerError('BAD_REQUEST', 'Session-only preferences require a session id');
  if (!validThinkingLevel(level)) throw new IpcHandlerError('BAD_REQUEST', 'invalid level');
  if (permissionPolicy !== undefined && !decodeRuntimePolicy(permissionPolicy)) throw new IpcHandlerError('BAD_REQUEST', 'invalid permission policy');
  if (model && (!validModelSelection(model.mode) || !MODEL_SOURCES.includes(model.source) || modelSource(model.mode) !== model.source)) {
    throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'The model source does not match the selection');
  }
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    if (sessionId) ultraModeIn(db, sessionId);
    const keys = [...(updateThinking && updateDefaults ? ['composer.thinking_level'] : []),
      ...(options.ultraMode === false && updateUltraDefault ? ['composer.ultra_mode'] : []),
      ...(model && updateModelDefault ? ['composer.main_model', 'auth_mode'] : [])];
    const previous = keys.map(key => ({ key, value: get(db, key) }));
    const session = sessionId ? db.prepare('SELECT level, updated_at FROM session_thinking_levels WHERE session_id = ?').get(sessionId) : undefined;
    const previousUltra = sessionId && options.ultraMode === false
      ? db.prepare('SELECT enabled, updated_at FROM session_ultra_modes WHERE session_id = ?').get(sessionId) : undefined;
    const previousModel = sessionId && model ? db.prepare('SELECT mode, source, updated_at FROM session_main_models WHERE session_id = ?').get(sessionId) : undefined;
    const previousPermission = sessionId && permissionPolicy !== undefined ? db.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id = ?').get(sessionId) : undefined;
    if (updateThinking && updateDefaults) {
      if (level === DEFAULT_THINKING_LEVEL) db.prepare('DELETE FROM settings WHERE key = ?').run('composer.thinking_level');
      else put(db, 'composer.thinking_level', level);
    }
    if (options.ultraMode === false && updateUltraDefault) db.prepare('DELETE FROM settings WHERE key = ?').run('composer.ultra_mode');
    const now = Math.max(Date.now(), Number(session?.updated_at ?? 0) + 1, Number(previousUltra?.updated_at ?? 0) + 1,
      Number(previousModel?.updated_at ?? 0) + 1, Number(previousPermission?.updated_at ?? 0) + 1);
    const permissionJson = permissionPolicy ? JSON.stringify({ policy: permissionPolicy }) : undefined;
    if (sessionId && permissionJson) db.prepare('INSERT INTO session_runtime_policies (session_id, policy_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at').run(sessionId, permissionJson, now);
    if (sessionId && updateThinking) db.prepare('INSERT INTO session_thinking_levels (session_id, level, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at')
      .run(sessionId, level, now);
    if (sessionId && options.ultraMode === false) db.prepare('UPDATE session_ultra_modes SET enabled = 0, updated_at = ? WHERE session_id = ?').run(now, sessionId);
    if (model) {
      if (updateModelDefault) {
        put(db, 'composer.main_model', model.mode);
        put(db, 'auth_mode', model.source);
      }
      if (sessionId) db.prepare('INSERT INTO session_main_models (session_id, mode, source, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET mode = excluded.mode, source = excluded.source, updated_at = excluded.updated_at')
        .run(sessionId, model.mode, model.source, now);
    }
    // Source-scoped memory records what the user last chose on this source,
    // whether or not the pick also becomes the default for future conversations.
    const source = model?.source ?? (sessionId
      ? (db.prepare('SELECT source FROM session_main_models WHERE session_id = ?').get(sessionId) as { source?: string } | undefined)?.source
      : (modelSource(get(db, 'composer.main_model') ?? '') ?? authModeIn(db)));
    if (typeof source === 'string' && MODEL_SOURCES.includes(source)) {
      if (model) writeLastSourceModel(db, source, model.mode);
      if (updateThinking) writeLastSourceThinkingLevel(db, source, level);
    }
    const written = keys.map(key => ({ key, value: get(db, key) }));
    return { level, rollback: () => withSettingsTransaction(configRoot, current => {
      // Restore each owned row independently. A different session may update
      // the future default while the permission publication is awaiting I/O.
      const ownsModelDefault = !model || written.filter(row => row.key === 'composer.main_model' || row.key === 'auth_mode')
        .every(row => get(current, row.key) === row.value);
      const latestUltra = sessionId && options.ultraMode === false
        ? current.prepare('SELECT enabled, updated_at FROM session_ultra_modes WHERE session_id = ?').get(sessionId) : undefined;
      const ownsUltra = options.ultraMode === false && (!sessionId || latestUltra?.enabled === 0 && latestUltra.updated_at === now);
      for (let i = 0; i < previous.length; i++) {
        const row = previous[i]!;
        if (!ownsModelDefault && (row.key === 'composer.main_model' || row.key === 'auth_mode')) continue;
        if (row.key === 'composer.ultra_mode' && !ownsUltra) continue;
        if (get(current, row.key) !== written[i]!.value) continue;
        if (row.value === undefined) current.prepare('DELETE FROM settings WHERE key = ?').run(row.key);
        else put(current, row.key, row.value);
      }
      if (sessionId) {
        if (ownsUltra && previousUltra) {
          current.prepare('UPDATE session_ultra_modes SET enabled = ?, updated_at = ? WHERE session_id = ?')
            .run(previousUltra.enabled ?? null, previousUltra.updated_at ?? null, sessionId);
        }
        const latestPermission = permissionPolicy !== undefined ? current.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id = ?').get(sessionId) : undefined;
        if (permissionPolicy !== undefined && latestPermission?.policy_json === permissionJson && latestPermission?.updated_at === now) {
          if (previousPermission) current.prepare('UPDATE session_runtime_policies SET policy_json = ?, updated_at = ? WHERE session_id = ?')
            .run(previousPermission.policy_json ?? null, previousPermission.updated_at ?? null, sessionId);
          else current.prepare('DELETE FROM session_runtime_policies WHERE session_id = ?').run(sessionId);
        }
        const latest = current.prepare('SELECT level, updated_at FROM session_thinking_levels WHERE session_id = ?').get(sessionId);
        if (updateThinking && latest?.level === level && latest.updated_at === now) {
          if (session) current.prepare('UPDATE session_thinking_levels SET level = ?, updated_at = ? WHERE session_id = ?').run(session.level ?? null, session.updated_at ?? null, sessionId);
          else current.prepare('DELETE FROM session_thinking_levels WHERE session_id = ?').run(sessionId);
        }
        if (model) {
          const latestModel = current.prepare('SELECT mode, source, updated_at FROM session_main_models WHERE session_id = ?').get(sessionId);
          if (latestModel?.mode === model.mode && latestModel.source === model.source && latestModel.updated_at === now) {
            if (previousModel) current.prepare('UPDATE session_main_models SET mode = ?, source = ?, updated_at = ? WHERE session_id = ?')
              .run(previousModel.mode ?? null, previousModel.source ?? null, previousModel.updated_at ?? null, sessionId);
            else current.prepare('DELETE FROM session_main_models WHERE session_id = ?').run(sessionId);
          }
        }
      }
    }) };
  });
}

function defaultThinkingLevel(db: DatabaseSync): string {
  const raw = get(db, 'composer.thinking_level');
  return validThinkingLevel(raw) ? raw : DEFAULT_THINKING_LEVEL;
}

/** The orchestration mode a conversation runs with, falling back to the global
 *  default ONCE, mirroring {@link thinkingLevelIn}'s freeze-on-first-read. */
function ultraModeIn(db: DatabaseSync, sessionId: string): boolean {
  const fallback = get(db, 'composer.ultra_mode') === '1';
  if (!sessionId) return fallback;
  const row = db.prepare('SELECT enabled FROM session_ultra_modes WHERE session_id = ?').get(sessionId) as { enabled: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO session_ultra_modes (session_id, enabled, updated_at) VALUES (?, ?, ?)').run(sessionId, fallback ? 1 : 0, Date.now());
    return fallback;
  }
  return row.enabled === 1;
}

export function readSessionUltraMode(sessionId: string, configRoot: string): boolean {
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    return ultraModeIn(db, sessionId);
  });
}

/** Persist the orchestration switch and its optional permission choice together,
 *  with the same rollback contract {@link applySessionThinkingSelection} uses. */
export function applySessionUltraSelection(
  sessionId: string, enabled: boolean, configRoot: string, permissionPolicy?: RuntimePolicy,
  options: { updateDefaults?: boolean } = {},
): { enabled: boolean; rollback(): void } {
  const { updateDefaults = true } = options;
  if (!updateDefaults && !sessionId) throw new IpcHandlerError('BAD_REQUEST', 'Session-only preferences require a session id');
  if (permissionPolicy !== undefined && !decodeRuntimePolicy(permissionPolicy)) throw new IpcHandlerError('BAD_REQUEST', 'invalid permission policy');
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    const keys = updateDefaults ? ['composer.ultra_mode'] : [];
    const previous = keys.map(key => ({ key, value: get(db, key) }));
    const session = sessionId
      ? db.prepare('SELECT enabled, updated_at FROM session_ultra_modes WHERE session_id = ?').get(sessionId) as { enabled: number; updated_at: number } | undefined
      : undefined;
    const previousPermission = sessionId && permissionPolicy !== undefined
      ? db.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id = ?').get(sessionId) as { policy_json: string; updated_at: number } | undefined
      : undefined;
    if (updateDefaults) {
      if (enabled) put(db, 'composer.ultra_mode', '1');
      else db.prepare('DELETE FROM settings WHERE key = ?').run('composer.ultra_mode');
    }
    // Source-scoped memory records the last orchestration choice on this source,
    // independent of whether the pick also updates the default for future chats.
    const source = sessionId
      ? (db.prepare('SELECT source FROM session_main_models WHERE session_id = ?').get(sessionId) as { source?: string } | undefined)?.source
      : (modelSource(get(db, 'composer.main_model') ?? '') ?? authModeIn(db));
    if (typeof source === 'string' && MODEL_SOURCES.includes(source)) writeLastSourceUltraMode(db, source, enabled);
    const now = Math.max(Date.now(), Number(session?.updated_at ?? 0) + 1, Number(previousPermission?.updated_at ?? 0) + 1);
    const permissionJson = permissionPolicy ? JSON.stringify({ policy: permissionPolicy }) : undefined;
    if (sessionId && permissionJson) db.prepare('INSERT INTO session_runtime_policies (session_id, policy_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at').run(sessionId, permissionJson, now);
    if (sessionId) {
      db.prepare('INSERT INTO session_ultra_modes (session_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
        .run(sessionId, enabled ? 1 : 0, now);
      if (enabled) {
        db.prepare('INSERT INTO session_orchestration_modes (session_id, enabled, updated_at) VALUES (?, 0, ?) ON CONFLICT(session_id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at')
          .run(sessionId, now);
      }
    }
    if (updateDefaults && enabled) {
      db.prepare('DELETE FROM settings WHERE key = ?').run('composer.orchestration_mode');
    }
    const written = keys.map(key => ({ key, value: get(db, key) }));
    return { enabled, rollback: () => withSettingsTransaction(configRoot, current => {
      for (let i = 0; i < previous.length; i++) {
        const row = previous[i]!;
        if (get(current, row.key) !== written[i]!.value) continue;
        if (row.value === undefined) current.prepare('DELETE FROM settings WHERE key = ?').run(row.key);
        else put(current, row.key, row.value);
      }
      if (sessionId) {
        const latestPermission = permissionPolicy !== undefined
          ? current.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id = ?').get(sessionId) as { policy_json: string; updated_at: number } | undefined
          : undefined;
        if (permissionPolicy !== undefined && latestPermission?.policy_json === permissionJson && latestPermission?.updated_at === now) {
          if (previousPermission) current.prepare('UPDATE session_runtime_policies SET policy_json = ?, updated_at = ? WHERE session_id = ?')
            .run(previousPermission.policy_json ?? null, previousPermission.updated_at ?? null, sessionId);
          else current.prepare('DELETE FROM session_runtime_policies WHERE session_id = ?').run(sessionId);
        }
        const latest = current.prepare('SELECT enabled, updated_at FROM session_ultra_modes WHERE session_id = ?').get(sessionId) as { enabled: number; updated_at: number } | undefined;
        if (latest?.enabled === (enabled ? 1 : 0) && latest.updated_at === now) {
          if (session) current.prepare('UPDATE session_ultra_modes SET enabled = ?, updated_at = ? WHERE session_id = ?')
            .run(session.enabled ?? null, session.updated_at ?? null, sessionId);
          else current.prepare('DELETE FROM session_ultra_modes WHERE session_id = ?').run(sessionId);
        }
      }
    }) };
  });
}

function orchestrationModeIn(db: DatabaseSync, sessionId: string): boolean {
  const fallback = get(db, 'composer.orchestration_mode') === '1';
  if (!sessionId) return fallback;
  const row = db.prepare('SELECT enabled FROM session_orchestration_modes WHERE session_id = ?').get(sessionId) as { enabled: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO session_orchestration_modes (session_id, enabled, updated_at) VALUES (?, ?, ?)').run(sessionId, fallback ? 1 : 0, Date.now());
    return fallback;
  }
  return row.enabled === 1;
}

export function readSessionOrchestrationMode(sessionId: string, configRoot: string): boolean {
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    return orchestrationModeIn(db, sessionId);
  });
}

export function applySessionOrchestrationSelection(
  sessionId: string, enabled: boolean, configRoot: string, permissionPolicy?: RuntimePolicy,
  options: { updateDefaults?: boolean } = {},
): { enabled: boolean; rollback(): void } {
  const { updateDefaults = true } = options;
  if (!updateDefaults && !sessionId) throw new IpcHandlerError('BAD_REQUEST', 'Session-only preferences require a session id');
  if (permissionPolicy !== undefined && !decodeRuntimePolicy(permissionPolicy)) throw new IpcHandlerError('BAD_REQUEST', 'invalid permission policy');
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    const keys = updateDefaults ? ['composer.orchestration_mode', ...(enabled ? ['composer.ultra_mode'] : [])] : [];
    const previous = keys.map(key => ({ key, value: get(db, key) }));
    const session = sessionId
      ? db.prepare('SELECT enabled, updated_at FROM session_orchestration_modes WHERE session_id = ?').get(sessionId) as { enabled: number; updated_at: number } | undefined
      : undefined;
    const previousUltra = sessionId && enabled
      ? db.prepare('SELECT enabled, updated_at FROM session_ultra_modes WHERE session_id = ?').get(sessionId) as { enabled: number; updated_at: number } | undefined
      : undefined;
    const previousPermission = sessionId && permissionPolicy !== undefined
      ? db.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id = ?').get(sessionId) as { policy_json: string; updated_at: number } | undefined
      : undefined;
    if (updateDefaults) {
      if (enabled) {
        put(db, 'composer.orchestration_mode', '1');
        db.prepare('DELETE FROM settings WHERE key = ?').run('composer.ultra_mode');
      } else {
        db.prepare('DELETE FROM settings WHERE key = ?').run('composer.orchestration_mode');
      }
    }
    const now = Math.max(
      Date.now(),
      Number(session?.updated_at ?? 0) + 1,
      Number(previousUltra?.updated_at ?? 0) + 1,
      Number(previousPermission?.updated_at ?? 0) + 1,
    );
    const permissionJson = permissionPolicy ? JSON.stringify({ policy: permissionPolicy }) : undefined;
    if (sessionId && permissionJson) {
      db.prepare('INSERT INTO session_runtime_policies (session_id, policy_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at')
        .run(sessionId, permissionJson, now);
    }
    if (sessionId) {
      db.prepare('INSERT INTO session_orchestration_modes (session_id, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at')
        .run(sessionId, enabled ? 1 : 0, now);
      if (enabled) {
        db.prepare('INSERT INTO session_ultra_modes (session_id, enabled, updated_at) VALUES (?, 0, ?) ON CONFLICT(session_id) DO UPDATE SET enabled = 0, updated_at = excluded.updated_at')
          .run(sessionId, now);
      }
    }
    const written = keys.map(key => ({ key, value: get(db, key) }));
    return {
      enabled,
      rollback: () => withSettingsTransaction(configRoot, current => {
        for (let i = 0; i < previous.length; i++) {
          const row = previous[i]!;
          if (get(current, row.key) !== written[i]!.value) continue;
          if (row.value === undefined) current.prepare('DELETE FROM settings WHERE key = ?').run(row.key);
          else put(current, row.key, row.value);
        }
        if (sessionId) {
          const latestPermission = permissionPolicy !== undefined
            ? current.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id = ?').get(sessionId) as { policy_json: string; updated_at: number } | undefined
            : undefined;
          if (permissionPolicy !== undefined && latestPermission?.policy_json === permissionJson && latestPermission?.updated_at === now) {
            if (previousPermission) current.prepare('UPDATE session_runtime_policies SET policy_json = ?, updated_at = ? WHERE session_id = ?')
              .run(previousPermission.policy_json ?? null, previousPermission.updated_at ?? null, sessionId);
            else current.prepare('DELETE FROM session_runtime_policies WHERE session_id = ?').run(sessionId);
          }
          const latest = current.prepare('SELECT enabled, updated_at FROM session_orchestration_modes WHERE session_id = ?').get(sessionId) as { enabled: number; updated_at: number } | undefined;
          if (latest?.enabled === (enabled ? 1 : 0) && latest.updated_at === now) {
            if (session) current.prepare('UPDATE session_orchestration_modes SET enabled = ?, updated_at = ? WHERE session_id = ?')
              .run(session.enabled ?? null, session.updated_at ?? null, sessionId);
            else current.prepare('DELETE FROM session_orchestration_modes WHERE session_id = ?').run(sessionId);
          }
          if (enabled) {
            const latestUltra = current.prepare('SELECT enabled, updated_at FROM session_ultra_modes WHERE session_id = ?').get(sessionId) as { enabled: number; updated_at: number } | undefined;
            if (latestUltra?.enabled === 0 && latestUltra.updated_at === now) {
              if (previousUltra) current.prepare('UPDATE session_ultra_modes SET enabled = ?, updated_at = ? WHERE session_id = ?')
                .run(previousUltra.enabled ?? null, previousUltra.updated_at ?? null, sessionId);
              else current.prepare('DELETE FROM session_ultra_modes WHERE session_id = ?').run(sessionId);
            }
          }
        }
      }),
    };
  });
}

/** Fast mode belongs to one conversation and source; defaults are for future chats. */
export function readSessionFastMode(sessionId: string, configRoot: string, requestedSource?: string): boolean {
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    return fastModeIn(db, sessionId, requestedSource ?? sessionSourceIn(db, sessionId));
  });
}

/** A source-scoped preference is effective only for a request Fast source.
 * Model eligibility is checked against the engine catalog by the composer. */
function fastModeIn(db: DatabaseSync, sessionId: string, source: string | undefined): boolean {
  const selectedSource = source ?? CODEX_SOURCE;
  if (!isRequestFastSource(selectedSource)) return false;
  const remembered = fastModeDefaultFor(db, selectedSource) === 1;
  if (!sessionId) return remembered;
  seedFastMode(db, sessionId, selectedSource);
  const row = selectedSource === CODEX_SOURCE
    ? db.prepare('SELECT enabled FROM session_fast_modes WHERE session_id = ?').get(sessionId)
    : db.prepare('SELECT enabled FROM session_source_fast_modes WHERE session_id = ? AND source = ?').get(sessionId, selectedSource);
  return row?.enabled === 1;
}

/** An omitted source preserves the legacy Codex writer contract. */
export function setSessionFastMode(sessionId: string, enabled: boolean, configRoot: string, source = CODEX_SOURCE, updateDefaults = true): void {
  const key = fastModePreferenceKey(source);
  if (!key) throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'Fast mode is unavailable for this model source');
  withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    if (updateDefaults) {
      if (enabled) put(db, key, 'true');
      else db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    }
    if (sessionId) writeFastMode(db, sessionId, source, enabled);
  });
}

/** Tier preferences remain source-scoped in the existing model_tiers:<source> row. */
export function sourceTierSelections(source: string, configRoot: string): Record<string, string> {
  return withSettingsDb(configRoot, db => {
    try {
      const parsed: unknown = JSON.parse(get(db, 'model_tiers:' + source) ?? '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    } catch { return {}; }
  });
}

export function sessionSpecMode(sessionId: string, configRoot: string): { enabled: boolean; revision: number | null } {
  if (!sessionId) return { enabled: false, revision: null };
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    const row = db.prepare('SELECT mode, updated_at FROM session_chat_modes WHERE session_id = ?').get(sessionId);
    return { enabled: row?.mode === 'plan', revision: typeof row?.updated_at === 'number' ? row.updated_at : null };
  });
}

/** Derive the display preset from the frozen policy. */
export function sessionPermissionPreset(sessionId: string, configRoot: string): string | undefined {
  const saved = sessionRuntimePolicy(sessionId, configRoot);
  return saved ? classifyRuntimePolicy(decodeRuntimePolicy(saved.policy)!) ?? undefined : undefined;
}

function canonicalSessionPolicy(value: Record<string, Json>): Record<string, Json> {
  const policy = decodeRuntimePolicy(value.policy);
  if (!policy) throw new IpcHandlerError('SESSION_POLICY_INVALID', 'The saved conversation policy is invalid');
  return { policy: { ...policy } };
}

export function sessionRuntimePolicy(sessionId: string, configRoot: string, initial?: Record<string, Json>): Record<string, Json> | undefined {
  if (!sessionId) return undefined;
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    const legacy = db.prepare('SELECT mode, updated_at FROM session_permission_modes WHERE session_id=?').get(sessionId);
    const existing = db.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id=?').get(sessionId);
    if (legacy && !isLegacyPermissionPreset(legacy.mode)) throw new IpcHandlerError('SESSION_POLICY_INVALID', 'The saved conversation permission preset is invalid');
    // Older builds saved later explicit picks separately from the frozen baseline.
    // A migration consumes the newer pick once; ties preserve the canonical policy.
    if (legacy && isLegacyPermissionPreset(legacy.mode) && (!existing || Number(legacy.updated_at) > Number(existing.updated_at))) {
      const json = JSON.stringify({ policy: presetRuntimePolicy(legacy.mode) });
      db.prepare('INSERT INTO session_runtime_policies(session_id,policy_json,updated_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET policy_json=excluded.policy_json,updated_at=excluded.updated_at').run(sessionId, json, legacy.updated_at ?? Date.now());
    } else if (!existing && initial) {
      db.prepare('INSERT INTO session_runtime_policies(session_id,policy_json,updated_at) VALUES(?,?,?)').run(sessionId, JSON.stringify(canonicalSessionPolicy(initial)), Date.now());
    }
    const raw = db.prepare('SELECT policy_json FROM session_runtime_policies WHERE session_id=?').get(sessionId)?.policy_json;
    if (typeof raw !== 'string') return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const canonical = canonicalSessionPolicy(value as Record<string, Json>), json = JSON.stringify(canonical);
        if (json !== raw) db.prepare('UPDATE session_runtime_policies SET policy_json=? WHERE session_id=?').run(json, sessionId);
        db.prepare('DELETE FROM session_permission_modes WHERE session_id=?').run(sessionId);
        return canonical;
      }
    } catch { /* An invalid durable policy must not acquire a fresh, potentially wider default. */ }
    throw new IpcHandlerError('SESSION_POLICY_INVALID', 'The saved conversation policy is invalid');
  });
}

/** Replace a thread's policy and discard its legacy selection in one owned transaction. */
export function applySessionRuntimePolicy(sessionId: string, value: Record<string, Json>, configRoot: string): { rollback(): void } {
  return withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    const previousMode = db.prepare('SELECT mode, updated_at FROM session_permission_modes WHERE session_id=?').get(sessionId);
    const storedPolicy = db.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id=?').get(sessionId);
    const previousPolicy = previousMode && isLegacyPermissionPreset(previousMode.mode) && (!storedPolicy || Number(previousMode.updated_at) > Number(storedPolicy.updated_at))
      ? { policy_json: JSON.stringify({ policy: presetRuntimePolicy(previousMode.mode) }), updated_at: previousMode.updated_at } : storedPolicy;
    const now = Math.max(Date.now(), Number(previousPolicy?.updated_at ?? 0) + 1, Number(previousMode?.updated_at ?? 0) + 1);
    const json = JSON.stringify(canonicalSessionPolicy(value));
    db.prepare('DELETE FROM session_permission_modes WHERE session_id=?').run(sessionId);
    db.prepare('INSERT INTO session_runtime_policies(session_id,policy_json,updated_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET policy_json=excluded.policy_json,updated_at=excluded.updated_at').run(sessionId, json, now);
    return { rollback: () => withSettingsTransaction(configRoot, current => {
      const mode = current.prepare('SELECT mode FROM session_permission_modes WHERE session_id=?').get(sessionId);
      const policy = current.prepare('SELECT policy_json, updated_at FROM session_runtime_policies WHERE session_id=?').get(sessionId);
      if (mode || policy?.updated_at !== now || policy.policy_json !== json) return;
      if (previousPolicy) current.prepare('UPDATE session_runtime_policies SET policy_json=?,updated_at=? WHERE session_id=?').run(previousPolicy.policy_json ?? null, previousPolicy.updated_at ?? null, sessionId);
      else current.prepare('DELETE FROM session_runtime_policies WHERE session_id=?').run(sessionId);
    }) };
  });
}

/** Compatibility entry for preset callers; persistence always stores a complete policy. */
export function setSessionPermissionPreset(sessionId: string, mode: PermissionPreset | undefined, configRoot: string): void {
  if (!sessionId) return;
  if (mode !== undefined && !['default', 'auto', 'bypassPermissions'].includes(mode)) throw new IpcHandlerError('BAD_REQUEST', 'invalid permission preset');
  if (mode !== undefined) { applySessionRuntimePolicy(sessionId, { policy: { ...presetRuntimePolicy(mode) } }, configRoot); return; }
  withSettingsTransaction(configRoot, db => {
    ensureTables(db, configRoot);
    db.prepare('DELETE FROM session_permission_modes WHERE session_id=?').run(sessionId);
    db.prepare('DELETE FROM session_runtime_policies WHERE session_id=?').run(sessionId);
  });
}

export function sessionWorkdir(sessionId: string, configRoot: string): string | undefined {
  return withSettingsDb(configRoot, db => {
    db.exec(`CREATE TABLE IF NOT EXISTS session_workdirs (
      session_id TEXT PRIMARY KEY, workdir TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const row = db.prepare('SELECT workdir FROM session_workdirs WHERE session_id = ?').get(sessionId);
    return typeof row?.workdir === 'string' && row.workdir ? row.workdir : undefined;
  });
}

export function bindSessionWorkdir(sessionId: string, workdir: string, configRoot: string): void {
  sessionWorkdir(sessionId, configRoot);
  withSettingsDb(configRoot, db => {
    db.prepare(`INSERT INTO session_workdirs (session_id, workdir, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET workdir = excluded.workdir, updated_at = excluded.updated_at`)
      .run(sessionId, workdir, Date.now());
  });
}

/** Called after deleting a persistent thread or disposing a registered ephemeral session. */
export function forgetEphemeralPreferences(sessionId: string, configRoot: string): void {
  withSettingsTransaction(configRoot, db => {
    for (const table of ['session_main_models', 'session_chat_modes', 'session_workdirs', 'session_workspaces', 'session_titles', 'session_thinking_levels', 'session_ultra_modes', 'session_orchestration_modes', 'session_fast_modes', 'session_source_fast_modes', 'session_permission_modes', 'session_runtime_policies', 'session_recency', 'session_agent_profiles']) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
    }
  });
}
