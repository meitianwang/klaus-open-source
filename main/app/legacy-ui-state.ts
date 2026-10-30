import {
  constants, fstatSync, lstatSync, mkdtempSync, openSync, closeSync, opendirSync,
  readSync, realpathSync, rmSync, writeFileSync, type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isLegacyUiStateKey, LEGACY_UI_STATE_KV_KEY, LEGACY_UI_STATE_LIMITS,
  validLegacyUiStateEntries, type LegacyUiStateSnapshot,
} from '../../contracts/legacy-ui-state';
import { kvGet, settingsDbPath, withSettingsTransaction } from '../services/settings';

export const WEBKIT_UI_STATE_LIMITS = { directoryEntries: 512, rows: 4096, sourceBytes: 64 * 1024 * 1024 } as const;

// WebKit serializes the top-level and client origins. This exact encoding is
// tauri://localhost twice, without a port; HTTP/dev/embedded-page origins differ.
const MAIN_ORIGIN = Buffer.from('0500000001746175726909000000016c6f63616c686f7374000500000001746175726909000000016c6f63616c686f737400', 'hex');

export type LegacyUiStateStageResult =
  | { status: 'skipped' | 'missing' | 'existing' }
  | { status: 'staged'; entries: number }
  | { status: 'failed'; reason: 'unsafe-source' | 'limit-exceeded' | 'source-changed' | 'read-failed' | 'settings-failed' };

class MigrationFailure extends Error {
  constructor(readonly reason: Extract<LegacyUiStateStageResult, { status: 'failed' }>['reason']) { super(reason); }
}

function stat(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function directory(path: string): boolean {
  const info = stat(path);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MigrationFailure('unsafe-source');
  return true;
}

function sameFile(a: Stats | undefined, b: Stats | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined
    && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && !b.isSymbolicLink();
}

function readBounded(path: string, limit: number): { bytes: Buffer; info: Stats } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new MigrationFailure('unsafe-source');
    if (info.size > limit) throw new MigrationFailure('limit-exceeded');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new MigrationFailure('source-changed');
      offset += read;
    }
    if (!sameFile(info, fstatSync(fd)) || !sameFile(info, stat(path))) throw new MigrationFailure('source-changed');
    return { bytes, info };
  } finally { closeSync(fd); }
}

function sourceDatabase(homeDir: string): string | undefined {
  let root = homeDir;
  for (const name of ['Library', 'WebKit', 'ai.klaus.desktop', 'WebsiteData', 'Default']) {
    root = join(root, name);
    if (!directory(root)) return undefined;
  }
  let remaining = WEBKIT_UI_STATE_LIMITS.directoryEntries;
  function children(path: string): string[] {
    const result: string[] = [], dir = opendirSync(path);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (--remaining < 0) throw new MigrationFailure('limit-exceeded');
        if (entry.isDirectory() && !entry.isSymbolicLink()) result.push(join(path, entry.name));
      }
    } finally { dir.closeSync(); }
    return result.sort();
  }
  const matches: string[] = [];
  for (const top of children(root)) {
    if (!directory(top)) continue;
    for (const client of children(top)) {
      if (!directory(client)) continue;
      const origin = join(client, 'origin'), info = stat(origin);
      if (!info || info.isSymbolicLink() || !info.isFile() || info.size !== MAIN_ORIGIN.length) continue;
      if (!readBounded(origin, MAIN_ORIGIN.length).bytes.equals(MAIN_ORIGIN)) continue;
      const local = join(client, 'LocalStorage');
      if (!directory(local)) continue;
      const path = join(local, 'localstorage.sqlite3'), database = stat(path);
      if (!database) continue;
      if (!database.isFile() || database.isSymbolicLink()) throw new MigrationFailure('unsafe-source');
      matches.push(path);
      if (matches.length > 1) throw new MigrationFailure('unsafe-source');
    }
  }
  return matches[0];
}

function readSnapshot(source: string): Record<string, string> {
  // SQLite can create or update -shm even for a read-only WAL connection. Open
  // only a private copy so the original WebKit database is never given to SQLite.
  const temporary = mkdtempSync(join(tmpdir(), 'klaus-webkit-ui-state-'));
  let db: DatabaseSync | undefined;
  try {
    const files = ['', '-wal', '-journal'].map(suffix => ({ suffix, info: stat(source + suffix) }));
    let remaining = WEBKIT_UI_STATE_LIMITS.sourceBytes;
    for (const file of files) {
      if (!file.info) continue;
      if (!file.info.isFile() || file.info.isSymbolicLink()) throw new MigrationFailure('unsafe-source');
      const read = readBounded(source + file.suffix, remaining);
      if (!sameFile(file.info, read.info)) throw new MigrationFailure('source-changed');
      remaining -= read.bytes.length;
      writeFileSync(join(temporary, 'source.sqlite3' + file.suffix), read.bytes, { mode: 0o600, flag: 'wx' });
    }
    for (const file of files) {
      if (!sameFile(file.info, stat(source + file.suffix))) throw new MigrationFailure('source-changed');
    }
    db = new DatabaseSync(join(temporary, 'source.sqlite3'), { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 250');
    if (db.prepare("SELECT type FROM sqlite_schema WHERE name = 'ItemTable'").get()?.type !== 'table') {
      throw new MigrationFailure('read-failed');
    }
    const rows = db.prepare('SELECT rowid AS id, substr(key, 1, 256) AS key, length(key) AS key_chars, typeof(value) AS value_type, length(value) AS value_bytes FROM ItemTable LIMIT ?')
      .all(WEBKIT_UI_STATE_LIMITS.rows + 1);
    if (rows.length > WEBKIT_UI_STATE_LIMITS.rows) throw new MigrationFailure('limit-exceeded');
    const get = db.prepare('SELECT value FROM ItemTable WHERE rowid = ?');
    const entries: Record<string, string> = Object.create(null);
    let chars = 0, count = 0;
    for (const row of rows) {
      if (typeof row.key !== 'string' || row.key.length !== row.key_chars || !isLegacyUiStateKey(row.key)) continue;
      if (row.value_type !== 'blob' || typeof row.value_bytes !== 'number' || row.value_bytes % 2 !== 0) {
        throw new MigrationFailure('read-failed');
      }
      chars += row.key.length + row.value_bytes / 2;
      if (++count > LEGACY_UI_STATE_LIMITS.entries || row.value_bytes / 2 > LEGACY_UI_STATE_LIMITS.valueChars
        || chars > LEGACY_UI_STATE_LIMITS.totalChars) throw new MigrationFailure('limit-exceeded');
      const value = get.get(row.id!)?.value;
      if (!(value instanceof Uint8Array)) throw new MigrationFailure('read-failed');
      entries[row.key] = Buffer.from(value).toString('utf16le');
    }
    if (!validLegacyUiStateEntries(entries)) throw new MigrationFailure('read-failed');
    return entries;
  } finally {
    try { db?.close(); } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

/** Stage once for the default macOS profile; failures remain eligible next start. */
export function stageLegacyUiState(configRoot: string, homeDir: string | undefined, platform: NodeJS.Platform): LegacyUiStateStageResult {
  if (platform !== 'darwin' || !homeDir || resolve(configRoot) !== resolve(homeDir, '.klaus')) return { status: 'skipped' };
  try {
    const canonicalHome = realpathSync(homeDir), profile = join(canonicalHome, '.klaus');
    if (stat(configRoot) && (!directory(configRoot) || realpathSync(configRoot) !== profile)) return { status: 'skipped' };
    const settings = stat(settingsDbPath(configRoot));
    if (settings) {
      if (!settings.isFile() || settings.isSymbolicLink()) throw new MigrationFailure('unsafe-source');
      const existing = kvGet(LEGACY_UI_STATE_KV_KEY, configRoot);
      if (existing !== null && typeof existing !== 'string') throw new MigrationFailure('settings-failed');
      if (existing !== null) return { status: 'existing' };
    }
    const source = sourceDatabase(canonicalHome);
    if (!source) return { status: 'missing' };
    const entries = readSnapshot(source);
    const snapshot: LegacyUiStateSnapshot = { version: 1, state: 'staged', entries };
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > LEGACY_UI_STATE_LIMITS.jsonChars) throw new MigrationFailure('limit-exceeded');
    try {
      return withSettingsTransaction(configRoot, database => {
        const inserted = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
          .run(LEGACY_UI_STATE_KV_KEY, serialized);
        return inserted.changes ? { status: 'staged', entries: Object.keys(entries).length } : { status: 'existing' };
      });
    } catch { throw new MigrationFailure('settings-failed'); }
  } catch (error) {
    return { status: 'failed', reason: error instanceof MigrationFailure ? error.reason : 'read-failed' };
  }
}
