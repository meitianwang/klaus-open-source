import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { withSettingsTransaction } from './settings';

function ensureTable(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS session_recency (session_id TEXT PRIMARY KEY, sort_at INTEGER NOT NULL)');
}

function timestamp(value: Json | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Preserve the existing conversation clock across rollout, title and configuration writes. */
export function applySessionRecency(rows: Json[], configRoot: string): Json[] {
  if (!rows.length) return [];
  return withSettingsTransaction(configRoot, db => applySessionRecencyIn(rows, db));
}

/** Reuse the catalog's single database transaction for the entire page. */
export function applySessionRecencyIn(rows: Json[], db: DatabaseSync): Json[] {
  ensureTable(db);
  const ids = rows.map(row => object(row)?.id).filter((id): id is string => typeof id === 'string' && Boolean(id));
  const previousRows = new Map(db.prepare('SELECT session_id, sort_at FROM session_recency WHERE session_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)).map(row => [String(row.session_id), row.sort_at]));
  const seed = db.prepare('INSERT INTO session_recency (session_id, sort_at) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING');
  return rows.map(row => {
    const value = object(row);
    if (!value || typeof value.id !== 'string' || !value.id) return row;
    const previous = previousRows.get(value.id);
    const baseline = timestamp(value.updatedAt ?? value.updated_at ?? value.modified)
      ?? timestamp(value.createdAt ?? value.created_at ?? value.created) ?? 0;
    const sortAt = typeof previous === 'number' ? previous : baseline;
    if (previous === undefined) seed.run(value.id, sortAt);
    return { ...value, updatedAt: sortAt };
  }).sort((a, b) => Number(object(b)?.updatedAt ?? 0) - Number(object(a)?.updatedAt ?? 0));
}

/** A newly created conversation starts at its creation time, before any rollout exists. */
export function recordInitialSessionRecency(sessionId: string, createdAt: number, configRoot: string): void {
  if (!sessionId || !Number.isSafeInteger(createdAt) || createdAt <= 0) return;
  withSettingsTransaction(configRoot, db => {
    ensureTable(db);
    db.prepare('INSERT INTO session_recency (session_id, sort_at) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING')
      .run(sessionId, createdAt);
  });
}

/** Only a completed final reply advances this clock; wall-clock adjustments cannot rewind it. */
export function recordCompletedSessionReply(sessionId: string, completedAt: number, configRoot: string): void {
  if (!sessionId || !Number.isSafeInteger(completedAt) || completedAt <= 0) return;
  withSettingsTransaction(configRoot, db => {
    ensureTable(db);
    db.prepare('INSERT INTO session_recency (session_id, sort_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET sort_at = MAX(sort_at, excluded.sort_at)')
      .run(sessionId, completedAt);
  });
}
