// The existing settings.db remains in the resolved Klaus business-data directory.
// Node's SQLite implementation preserves its schema, WAL transactions and busy timeout.
// Startup takes a consistent snapshot before this store can apply migrations. Each
// operation owns a short connection; product mutations use an explicit transaction.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { configRootFrom } from './config-root';
import { AUTH_MODES, DEFAULT_AUTH_MODE } from './model-sources';

/**
 * Preserve the existing KV schema. Other services create their own tables when needed.
 */
const SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

/** Absolute path of the settings database for a config root. */
export function settingsDbPath(configRoot: string = configRootFrom()): string {
  return join(configRoot, 'settings.db');
}

/** What went wrong, as a code the renderer already understands. */
export type SettingsFailure =
  | { code: 'SETTINGS_DB_OPEN_FAILED'; message: string }
  | { code: 'SETTINGS_DB_READ_FAILED'; message: string }
  | { code: 'SETTINGS_DB_WRITE_FAILED'; message: string }
  | { code: 'BAD_REQUEST'; message: string };

/**
 * Configure bounded contention with the engine's independent database connections.
 * The application-instance guard separately prevents concurrent old and new clients.
 */
function open(configRoot: string): DatabaseSync {
  const path = settingsDbPath(configRoot);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SETTINGS_DDL);
    for (const retiredSearchKey of ['klaus.webSearch.brave.apiKey', 'klaus.webSearch.custom.authorization']) {
      if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(retiredSearchKey)) {
        db.prepare('DELETE FROM settings WHERE key = ?').run(retiredSearchKey);
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withSettingsDb<T>(configRoot: string, operation: (db: DatabaseSync) => T): T {
  const db = open(configRoot);
  try { return operation(db); } finally { db.close(); }
}

/** Keep each product mutation atomic; callbacks must stay synchronous. */
export function withSettingsTransaction<T>(configRoot: string, operation: (db: DatabaseSync) => T): T {
  return withSettingsDb(configRoot, db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `kv_opt` (`settings.rs:~140-145`): one bound SELECT, `None` when no row matches.
 *
 * A missing key and a malformed key are the same outcome — no row — which is exactly what
 * the dispatch arm's comment relies on (`main.rs:5195-5200`: "a missing or non-string key
 * simply matches no row and the handler answers undefined → null. Rejecting here made every
 * caller that reads a not-yet-written key see a thrown error where a plain empty value is
 * owed").
 */
export function kvOpt(key: string, configRoot: string = configRootFrom()): string | undefined | SettingsFailure {
  let db: DatabaseSync | undefined;
  try {
    db = open(configRoot);
    if (key === 'model_tiers:local') migrateLocalModelTiers(db);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string | number | bigint | Uint8Array | null }
      | undefined;
    if (row === undefined || row.value === null) return undefined;
    // The column is declared TEXT NOT NULL, but node:sqlite can hand back a number or
    // Buffer for a value another writer stored differently. Coercing to string matches the
    // Rust, which types the column as String and would have failed the read otherwise.
    return typeof row.value === 'string' ? row.value : String(row.value);
  } catch (error) {
    return { code: 'SETTINGS_DB_READ_FAILED', message: describe(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a database that failed to open is not a second error worth reporting.
    }
  }
}

/** The bridge maps this channel's null result to an absent setting. */
export function kvGet(key: string, configRoot: string = configRootFrom()): string | null | SettingsFailure {
  const found = kvOpt(key, configRoot);
  if (found !== undefined && typeof found === 'object') return found;
  return found ?? null;
}

/** `kv_put` (`settings.rs:~147-155`): an upsert on the primary key. */
function kvPut(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

/** An explicit map, including an empty or malformed one, wins over retired keys. */
function migrateLocalModelTiers(db: DatabaseSync, createEmpty = true): void {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  if (get.get('model_tiers:local')) return;
  if (!createEmpty && !['opus', 'sonnet', 'haiku'].some(role => get.get(`local_model_role:${role}`))) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!get.get('model_tiers:local')) {
      const tiers: Record<string, string> = {};
      for (const [role, tier] of [['opus', 'high'], ['sonnet', 'medium'], ['haiku', 'low']] as const) {
        const value = get.get(`local_model_role:${role}`)?.value;
        if (typeof value === 'string' && value.trim()) tiers[tier] = value.trim();
      }
      kvPut(db, 'model_tiers:local', JSON.stringify(tiers));
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** `kv_del` (`settings.rs:~204-208`). */
export function kvDel(key: string, configRoot: string = configRootFrom()): true | SettingsFailure {
  let db: DatabaseSync | undefined;
  try {
    db = open(configRoot);
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return true;
  } catch (error) {
    return { code: 'SETTINGS_DB_WRITE_FAILED', message: describe(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // As above.
    }
  }
}

/**
 * Public preference writes normalize model sources at the storage boundary.
 * Invalid auth modes resolve to the default source.
 */
export function kvSet(key: string, value: string, configRoot: string = configRootFrom()): true | SettingsFailure {
  let stored = value;
  if (key === 'auth_mode') {
    const source = AUTH_MODES.some(mode => mode === value) ? value : DEFAULT_AUTH_MODE;
    // Store the normalized source: a retired or unknown value must not reach
    // the settings row, or every later read would reject the stored mode.
    stored = source;
  }
  let db: DatabaseSync | undefined;
  try {
    db = open(configRoot);
    kvPut(db, key, stored);
    return true;
  } catch (error) {
    return { code: 'SETTINGS_DB_WRITE_FAILED', message: describe(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // As above.
    }
  }
}

/**
 * `kv_snapshot` (`settings.rs:~184-200`): every stored row, for the one-time migration that
 * hands this profile's preferences to the engine.
 *
 * Not used by P1 boot, but it is the reader the engine-handoff path needs and it shares this
 * module's connection discipline, so it is ported with the rest rather than re-derived later
 * against a different open/close policy.
 */
export function kvSnapshot(configRoot: string = configRootFrom()): Record<string, string> | SettingsFailure {
  let db: DatabaseSync | undefined;
  try {
    db = open(configRoot);
    migrateLocalModelTiers(db, false);
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string | number | bigint | Uint8Array;
      value: string | number | bigint | Uint8Array;
    }>;
    const out: Record<string, string> = {};
    for (const row of rows) {
      out[String(row.key)] = typeof row.value === 'string' ? row.value : String(row.value);
    }
    return out;
  } catch (error) {
    return { code: 'SETTINGS_DB_READ_FAILED', message: describe(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // As above.
    }
  }
}

/** Is this a failure envelope rather than a value? */
export function isFailure(value: unknown): value is SettingsFailure {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}
