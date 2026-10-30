import type { DatabaseSync } from 'node:sqlite';

import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { withSettingsDb, withSettingsTransaction } from './settings';

export type SessionListScope = 'active' | 'archived';

function ensureTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_list_snapshots (
    scope TEXT PRIMARY KEY,
    rows_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function normalizedRows(value: unknown): Json[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: Json[] = [];
  for (const item of value) {
    const row = object(item);
    if (!row || typeof row.id !== 'string' || !row.id.trim()) return undefined;
    rows.push({ ...row, isWorking: false });
  }
  return rows;
}

/** Read only a complete, previously validated sidebar snapshot. */
export function readSessionListSnapshot(scope: SessionListScope, configRoot: string): Json[] | undefined {
  return withSettingsDb(configRoot, db => {
    ensureTable(db);
    const value = db.prepare('SELECT rows_json FROM session_list_snapshots WHERE scope = ?').get(scope)?.rows_json;
    if (typeof value !== 'string') return undefined;
    try { return normalizedRows(JSON.parse(value)); } catch { return undefined; }
  });
}

/** Persist a non-running copy so a restart never resurrects a stale spinner. */
export function writeSessionListSnapshot(scope: SessionListScope, rows: Json[], configRoot: string): void {
  const normalized = normalizedRows(rows);
  if (!normalized) throw new Error('Cannot cache an invalid conversation snapshot');
  withSettingsTransaction(configRoot, db => {
    ensureTable(db);
    db.prepare(`INSERT INTO session_list_snapshots (scope, rows_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET rows_json = excluded.rows_json, updated_at = excluded.updated_at`)
      .run(scope, JSON.stringify(normalized), Date.now());
  });
}
