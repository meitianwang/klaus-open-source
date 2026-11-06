import { createHash, randomUUID } from 'node:crypto';
import type { BrowserImportHistoryEntry } from '../../contracts/browser-import';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BROWSER_HISTORY_PAGE_SIZE,
  BROWSER_HISTORY_REMOVE_LIMIT,
  type BrowserDownloadEntry,
  type BrowserDownloadPage,
  type BrowserDownloadQuery,
  type BrowserDownloadStatus,
  type BrowserHistoryEntry,
  type BrowserHistoryPage,
  type BrowserHistoryQuery,
  type BrowserHistorySource,
  type BrowserVisitSource,
} from '../../contracts/browser-history';
import { BrowserError, string, type BrowserObject } from './types';

const DATABASE_FILE = 'browser-data.db';
const PROCESS_BOOT_ID = randomUUID();
const SEARCH_LIMIT = 512;
const VISIT_DEDUPE_MS = 1_500;
const TERMINAL_DOWNLOADS = new Set<BrowserDownloadStatus>(['completed', 'failed', 'canceled']);

interface VisitRow {
  id: string;
  url: string;
  title: string | null;
  visited_at: number;
  source: string;
  favicon_data_url: string | null;
}

interface DownloadRow {
  id: string;
  url: string;
  filename: string;
  path: string | null;
  bytes: number | bigint;
  total_bytes: number | bigint;
  started_at: number;
  finished_at: number | null;
  status: string;
  source: string;
  error: string | null;
  boot_id: string;
}

export interface BrowserVisitInput {
  sessionId: string;
  url: string;
  title: string;
  source: BrowserVisitSource;
  visitedAt?: number;
  faviconDataUrl?: string;
}

export interface BrowserDownloadInput {
  id: string;
  sessionId: string;
  url: string;
  filename: string;
  source: BrowserVisitSource;
  path?: string;
  bytes?: number;
  totalBytes?: number;
  startedAt: number;
  status?: BrowserDownloadStatus;
}

export interface BrowserDownloadPatch {
  filename?: string;
  path?: string;
  bytes?: number;
  totalBytes?: number;
  status?: BrowserDownloadStatus;
  finishedAt?: number;
  error?: string;
}

function open(databasePath: string): DatabaseSync {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_visits (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      visited_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      favicon_data_url TEXT
    );
    CREATE INDEX IF NOT EXISTS browser_visits_order ON browser_visits(visited_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS browser_visits_session_url ON browser_visits(session_id, url, visited_at DESC);
    CREATE TABLE IF NOT EXISTS browser_downloads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      url TEXT NOT NULL,
      filename TEXT NOT NULL,
      path TEXT,
      bytes INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      error TEXT,
      boot_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS browser_downloads_order ON browser_downloads(started_at DESC, id DESC);
  `);
  const downloadColumns = db.prepare('PRAGMA table_info(browser_downloads)').all() as Array<{ name?: string }>;
  if (!downloadColumns.some(column => column.name === 'total_bytes')) {
    db.exec('ALTER TABLE browser_downloads ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0');
  }
  if (!downloadColumns.some(column => column.name === 'boot_id')) {
    db.exec("ALTER TABLE browser_downloads ADD COLUMN boot_id TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

function withDatabase<T>(databasePath: string, work: (db: DatabaseSync) => T): T {
  const db = open(databasePath);
  try { return work(db); } finally { db.close(); }
}

function boundedLimit(value: unknown): number {
  if (value === undefined) return BROWSER_HISTORY_PAGE_SIZE;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new BrowserError('invalid_request', 'limit must be a positive integer.');
  }
  return Math.min(value, BROWSER_HISTORY_PAGE_SIZE);
}

function boundedSearch(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new BrowserError('invalid_request', 'query must be a string.');
  const query = value.trim();
  if (query.length > SEARCH_LIMIT) throw new BrowserError('invalid_request', 'The history search is too long.');
  return query;
}

function source(value: unknown): BrowserHistorySource {
  if (value === undefined) return 'all';
  if (value === 'all' || value === 'agent' || value === 'other') return value;
  throw new BrowserError('invalid_request', 'source must be all, agent or other.');
}

function visitSource(value: unknown): BrowserVisitSource {
  if (value === 'agent' || value === 'other') return value;
  throw new BrowserError('invalid_request', 'A browser visit source must be agent or other.');
}

function encodeCursor(timestamp: number, id: string): string {
  return Buffer.from(JSON.stringify([timestamp, id]), 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): { timestamp: number; id: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 512) throw new BrowserError('invalid_request', 'cursor is invalid.');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('shape');
    const timestamp = parsed[0];
    const id = parsed[1];
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 || typeof id !== 'string' || !id) throw new Error('values');
    return { timestamp, id };
  } catch {
    throw new BrowserError('invalid_request', 'cursor is invalid.');
  }
}

function visitEntry(row: VisitRow): BrowserHistoryEntry {
  return {
    id: row.id,
    url: row.url,
    title: row.title || row.url,
    visitTime: Number(row.visited_at),
    isActorVisit: row.source === 'agent',
    ...(row.favicon_data_url ? { faviconDataUrl: row.favicon_data_url } : {}),
  };
}

function downloadEntry(row: DownloadRow): BrowserDownloadEntry {
  const status = (['in_progress', 'paused', 'completed', 'failed', 'canceled'].includes(row.status)
    ? row.status : 'failed') as BrowserDownloadStatus;
  const path = row.path || undefined;
  const exists = path ? existsSync(path) : undefined;
  return {
    id: row.id,
    url: row.url,
    filename: row.filename,
    ...(path ? { path } : {}),
    state: status,
    receivedBytes: Number(row.bytes),
    totalBytes: Number(row.total_bytes),
    startedAt: Number(row.started_at),
    canPause: false,
    canResume: false,
    canCancel: false,
    ...(exists === undefined ? {} : { exists }),
  };
}

/**
 * Local-only visit and download metadata for the built-in browser.
 *
 * SQLite is opened for one bounded operation at a time, matching the settings
 * store's locking discipline. Queries use a keyset cursor so inserts and
 * removals cannot duplicate or skip a page while the user is scrolling.
 */
export class BrowserDataStore {
  readonly databasePath: string;
  private readonly pendingVisitUpdates = new Map<string, {
    sessionId: string;
    url: string;
    title?: string;
    faviconDataUrl?: string;
  }>();
  private visitFlushTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(configRoot: string) {
    this.databasePath = join(configRoot, DATABASE_FILE);
  }

  recordVisit(input: BrowserVisitInput): BrowserHistoryEntry {
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new BrowserError('invalid_request', 'A browser session id is required.');
    const url = input.url.trim();
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('scheme');
    } catch { throw new BrowserError('invalid_request', 'Only HTTP or HTTPS pages belong in browsing history.'); }
    const title = String(input.title || parsedHost(url) || url).slice(0, 2_048);
    const visitedAt = input.visitedAt ?? Date.now();
    if (!Number.isSafeInteger(visitedAt) || visitedAt < 0) throw new BrowserError('invalid_request', 'visitedAt is invalid.');
    const sourceName = visitSource(input.source);
    const favicon = input.faviconDataUrl && input.faviconDataUrl.length <= 1_000_000 ? input.faviconDataUrl : undefined;
    return withDatabase(this.databasePath, db => {
      const recent = db.prepare(`SELECT id,url,title,visited_at,source,favicon_data_url FROM browser_visits
        WHERE session_id=? AND url=? ORDER BY visited_at DESC, id DESC LIMIT 1`).get(sessionId, url) as VisitRow | undefined;
      if (recent && recent.source === sourceName
        && visitedAt - Number(recent.visited_at) <= VISIT_DEDUPE_MS && visitedAt >= Number(recent.visited_at)) {
        db.prepare('UPDATE browser_visits SET title=?, visited_at=?, source=?, favicon_data_url=? WHERE id=?')
          .run(title, visitedAt, sourceName, favicon ?? recent.favicon_data_url, recent.id);
        return visitEntry({ ...recent, title, visited_at: visitedAt, source: sourceName, favicon_data_url: favicon ?? recent.favicon_data_url });
      }
      const id = randomUUID();
      db.prepare('INSERT INTO browser_visits (id,session_id,url,title,visited_at,source,favicon_data_url) VALUES (?,?,?,?,?,?,?)')
        .run(id, sessionId, url, title, visitedAt, sourceName, favicon ?? null);
      return visitEntry({ id, url, title, visited_at: visitedAt, source: sourceName, favicon_data_url: favicon ?? null });
    });
  }

  /** Import stable visit identities in bounded transactions without agent attribution. */
  async importVisits(sourceKey: string, rows: readonly BrowserImportHistoryEntry[], signal?: AbortSignal): Promise<{ applied: number; skipped: number }> {
    if (!sourceKey || sourceKey.length > 1024 || rows.length > 50_000) throw new BrowserError('invalid_request', 'The history import is invalid.');
    let applied = 0;
    let skipped = 0;
    for (let offset = 0; offset < rows.length; offset += 500) {
      if (signal?.aborted) break;
      const batch = rows.slice(offset, offset + 500);
      applied += withDatabase(this.databasePath, db => {
        const insert = db.prepare('INSERT OR IGNORE INTO browser_visits (id,session_id,url,title,visited_at,source) VALUES (?,?,?,?,?,?)');
        db.exec('BEGIN IMMEDIATE');
        let changed = 0;
        try {
          for (const row of batch) {
            let url: URL;
            try { url = new URL(row.url); } catch { continue; }
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
              || !Number.isSafeInteger(row.visitedAt) || row.visitedAt < 0) continue;
            const id = createHash('sha256').update(JSON.stringify([sourceKey, row.url, row.visitedAt])).digest('hex');
            const writes = Number(insert.run(id, `import:${sourceKey}`, row.url, String(row.title || url.host).slice(0, 2048), row.visitedAt, 'other').changes);
            changed += writes;
            if (!writes) skipped++;
          }
          db.exec('COMMIT');
          return changed;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      // Close the SQLite connection before yielding, so other host operations
      // cannot invalidate a transaction's POSIX locks through another handle.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return { applied, skipped };
  }

  updateLatestVisit(sessionId: string, url: string, fields: { title?: string; faviconDataUrl?: string }): void {
    if (!sessionId || !url) return;
    const updates: string[] = [];
    const values: Array<string> = [];
    if (fields.title !== undefined) { updates.push('title=?'); values.push(fields.title.slice(0, 2_048)); }
    if (fields.faviconDataUrl !== undefined && fields.faviconDataUrl.length <= 1_000_000) {
      updates.push('favicon_data_url=?'); values.push(fields.faviconDataUrl);
    }
    if (!updates.length) return;
    withDatabase(this.databasePath, db => {
      const row = db.prepare('SELECT id FROM browser_visits WHERE session_id=? AND url=? ORDER BY visited_at DESC, id DESC LIMIT 1')
        .get(sessionId, url) as { id?: string } | undefined;
      if (row?.id) db.prepare(`UPDATE browser_visits SET ${updates.join(',')} WHERE id=?`).run(...values, row.id);
    });
  }

  /** Coalesce title/favicon churn into one write per page and idle window. */
  queueVisitUpdate(sessionId: string, url: string, fields: { title?: string; faviconDataUrl?: string }): void {
    if (!sessionId || !url) return;
    const key = `${sessionId}\u0000${url}`;
    const previous = this.pendingVisitUpdates.get(key);
    this.pendingVisitUpdates.set(key, {
      sessionId,
      url,
      ...(fields.title !== undefined || previous?.title !== undefined ? { title: fields.title ?? previous?.title } : {}),
      ...(fields.faviconDataUrl !== undefined || previous?.faviconDataUrl !== undefined
        ? { faviconDataUrl: fields.faviconDataUrl ?? previous?.faviconDataUrl }
        : {}),
    });
    if (!this.visitFlushTimer) {
      this.visitFlushTimer = setTimeout(() => { this.flushVisitUpdates(); }, 100);
    }
  }

  flushVisitUpdates(): number {
    if (this.visitFlushTimer) {
      clearTimeout(this.visitFlushTimer);
      this.visitFlushTimer = undefined;
    }
    if (!this.pendingVisitUpdates.size) return 0;
    const pending = [...this.pendingVisitUpdates.values()];
    this.pendingVisitUpdates.clear();
    for (const update of pending) {
      this.updateLatestVisit(update.sessionId, update.url, {
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.faviconDataUrl === undefined ? {} : { faviconDataUrl: update.faviconDataUrl }),
      });
    }
    return pending.length;
  }

  history(input: BrowserHistoryQuery = {}): BrowserHistoryPage {
    const query = boundedSearch(input.query);
    const sourceName = source(input.source);
    const limit = boundedLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    return withDatabase(this.databasePath, db => {
      const clauses: string[] = [];
      const values: Array<string | number> = [];
      if (sourceName !== 'all') { clauses.push('source=?'); values.push(sourceName); }
      if (query) {
        clauses.push('(instr(lower(title), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0)');
        values.push(query, query);
      }
      if (cursor) {
        clauses.push('(visited_at < ? OR (visited_at = ? AND id < ?))');
        values.push(cursor.timestamp, cursor.timestamp, cursor.id);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT id,url,title,visited_at,source,favicon_data_url FROM browser_visits${where}
        ORDER BY visited_at DESC, id DESC LIMIT ?`).all(...values, limit + 1) as unknown as VisitRow[];
      const items = rows.slice(0, limit).map(visitEntry);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeCursor(last.visitTime, last.id) : null,
      };
    });
  }

  removeVisits(ids: unknown): { removed: number } {
    if (!Array.isArray(ids) || !ids.length || ids.length > BROWSER_HISTORY_REMOVE_LIMIT) {
      throw new BrowserError('invalid_request', `ids must contain 1 to ${BROWSER_HISTORY_REMOVE_LIMIT} history entries.`);
    }
    const unique = [...new Set(ids.map(id => string(id, 'id')))];
    return withDatabase(this.databasePath, db => {
      const marks = unique.map(() => '?').join(',');
      const result = db.prepare(`DELETE FROM browser_visits WHERE id IN (${marks})`).run(...unique);
      return { removed: Number(result.changes) };
    });
  }

  clearVisits(): { removed: number } {
    return withDatabase(this.databasePath, db => ({ removed: Number(db.prepare('DELETE FROM browser_visits').run().changes) }));
  }

  createDownload(input: BrowserDownloadInput): BrowserDownloadEntry {
    const id = string(input.id, 'id');
    const url = string(input.url, 'url');
    const filename = string(input.filename, 'filename');
    const status = input.status ?? 'in_progress';
    const sourceName = visitSource(input.source);
    withDatabase(this.databasePath, db => {
      db.prepare(`INSERT INTO browser_downloads
        (id,session_id,url,filename,path,bytes,total_bytes,started_at,finished_at,status,source,error,boot_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?)
        ON CONFLICT(id) DO UPDATE SET url=excluded.url, filename=excluded.filename, path=excluded.path,
          bytes=excluded.bytes, total_bytes=excluded.total_bytes, status=excluded.status, source=excluded.source`)
        .run(id, input.sessionId, url, filename, input.path ?? null, Math.max(0, Math.trunc(input.bytes ?? 0)),
          Math.max(0, Math.trunc(input.totalBytes ?? 0)), input.startedAt, null, status, sourceName, PROCESS_BOOT_ID);
    });
    return this.download(id)!;
  }

  updateDownload(id: string, patch: BrowserDownloadPatch): BrowserDownloadEntry | undefined {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.filename !== undefined) { sets.push('filename=?'); values.push(string(patch.filename, 'filename')); }
    if (patch.path !== undefined) { sets.push('path=?'); values.push(patch.path); }
    if (patch.bytes !== undefined) { sets.push('bytes=?'); values.push(Math.max(0, Math.trunc(patch.bytes))); }
    if (patch.totalBytes !== undefined) { sets.push('total_bytes=?'); values.push(Math.max(0, Math.trunc(patch.totalBytes))); }
    if (patch.status !== undefined) { sets.push('status=?'); values.push(patch.status); }
    if (patch.finishedAt !== undefined) { sets.push('finished_at=?'); values.push(patch.finishedAt); }
    if (patch.error !== undefined) { sets.push('error=?'); values.push(patch.error); }
    if (!sets.length) return this.download(id);
    withDatabase(this.databasePath, db => {
      db.prepare(`UPDATE browser_downloads SET ${sets.join(',')} WHERE id=?`).run(...values, id);
    });
    return this.download(id);
  }

  download(id: string): BrowserDownloadEntry | undefined {
    return withDatabase(this.databasePath, db => {
      const row = db.prepare('SELECT * FROM browser_downloads WHERE id=?').get(id) as DownloadRow | undefined;
      return row ? downloadEntry(row) : undefined;
    });
  }

  downloadHistory(input: BrowserDownloadQuery = {}): BrowserDownloadPage {
    const query = boundedSearch(input.query);
    const limit = boundedLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    return withDatabase(this.databasePath, db => {
      const clauses: string[] = [];
      const values: Array<string | number> = [];
      if (query) {
        clauses.push('(instr(lower(filename), lower(?)) > 0 OR instr(lower(url), lower(?)) > 0)');
        values.push(query, query);
      }
      if (cursor) {
        clauses.push('(started_at < ? OR (started_at = ? AND id < ?))');
        values.push(cursor.timestamp, cursor.timestamp, cursor.id);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM browser_downloads${where}
        ORDER BY started_at DESC, id DESC LIMIT ?`).all(...values, limit + 1) as unknown as DownloadRow[];
      const items = rows.slice(0, limit).map(downloadEntry);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last ? encodeCursor(last.startedAt, last.id) : null,
      };
    });
  }

  removeDownload(id: string): { removed: boolean } {
    const entry = this.download(id);
    if (!entry) return { removed: false };
    if (!TERMINAL_DOWNLOADS.has(entry.state)) throw new BrowserError('invalid_request', 'An active download cannot be removed from history.');
    withDatabase(this.databasePath, db => { db.prepare('DELETE FROM browser_downloads WHERE id=?').run(id); });
    return { removed: true };
  }

  clearTerminalDownloads(): { removed: number } {
    return withDatabase(this.databasePath, db => ({
      removed: Number(db.prepare(`DELETE FROM browser_downloads WHERE status IN ('completed','failed','canceled')`).run().changes),
    }));
  }

  recoverInterruptedDownloads(): { recovered: number } {
    return withDatabase(this.databasePath, db => {
      const result = db.prepare(`UPDATE browser_downloads
        SET status='failed', finished_at=?, error='Download interrupted before it finished.'
        WHERE status IN ('in_progress','paused') AND boot_id<>?`).run(Date.now(), PROCESS_BOOT_ID);
      return { recovered: Number(result.changes) };
    });
  }
}

function parsedHost(url: string): string | undefined {
  try { return new URL(url).hostname || undefined; } catch { return undefined; }
}
