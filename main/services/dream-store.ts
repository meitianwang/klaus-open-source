import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import { withSettingsDb } from './settings';
import { object, type JsonObject } from './service-types';

type Row = Record<string, string | number | null>;
const DREAM_DDL = `CREATE TABLE IF NOT EXISTS dream_runs (
  task_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
  status TEXT NOT NULL, phase TEXT NOT NULL, sessions_reviewing INTEGER NOT NULL DEFAULT 0,
  files_touched TEXT NOT NULL DEFAULT '[]', turns TEXT NOT NULL DEFAULT '[]', turn_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT, skill_review TEXT
); CREATE INDEX IF NOT EXISTS idx_dream_runs_started ON dream_runs(started_at DESC);`;
function parsed(value: unknown, fallback: Json): Json { try { return JSON.parse(String(value)) as Json; } catch { return fallback; } }
function project(row: Row): JsonObject {
  const turns = parsed(row.turns, []), result: JsonObject = {
    taskId: row.task_id!, startedAt: row.started_at!, status: row.status!, phase: row.phase!,
    sessionsReviewing: row.sessions_reviewing ?? 0, filesTouched: parsed(row.files_touched, []), turns,
    turnCount: row.turn_count ?? (Array.isArray(turns) ? turns.length : 0),
  };
  for (const [column, key] of [['ended_at', 'endedAt'], ['duration_ms', 'durationMs'], ['summary', 'summary']] as const) if (row[column] != null) result[key] = row[column]!;
  const review = parsed(row.skill_review, null); if (review && typeof review === 'object' && !Array.isArray(review)) result.skillReview = review;
  return result;
}
/** Preserve the existing settings.db history schema; only the engine performs consolidation. */
export class DreamStore {
  constructor(private readonly root: string) {}
  private withStore<T>(operation: (db: DatabaseSync) => T): T {
    return withSettingsDb(this.root, db => { db.exec(DREAM_DDL); return operation(db); });
  }
  reap(): number {
    return this.withStore(db => Number(db.prepare("UPDATE dream_runs SET status = 'failed', ended_at = started_at, duration_ms = 0 WHERE status = 'running'").run().changes));
  }
  save(snapshot: JsonObject): void {
    const turns = Array.isArray(snapshot.turns) ? snapshot.turns.slice(-6) : [], start = Number(snapshot.startedAt), end = snapshot.endedAt === undefined ? null : Number(snapshot.endedAt);
    if (typeof snapshot.taskId !== 'string' || !snapshot.taskId || !Number.isSafeInteger(start) || (end !== null && !Number.isSafeInteger(end))) throw new Error('Invalid dream lifecycle identity');
    this.withStore(db => db.prepare(`INSERT INTO dream_runs
      (task_id, started_at, ended_at, duration_ms, status, phase, sessions_reviewing, files_touched, turns, turn_count, summary, skill_review)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET ended_at=excluded.ended_at, duration_ms=excluded.duration_ms,
        status=excluded.status, phase=excluded.phase, sessions_reviewing=excluded.sessions_reviewing,
        files_touched=excluded.files_touched, turns=excluded.turns, turn_count=excluded.turn_count,
        summary=excluded.summary, skill_review=excluded.skill_review`).run(snapshot.taskId as string, start, end, end === null ? null : Math.max(0, end - start),
      String(snapshot.status ?? 'running'), String(snapshot.phase ?? 'starting'), Number(snapshot.sessionsReviewing ?? 0),
      JSON.stringify(snapshot.filesTouched ?? []), JSON.stringify(turns), Number(snapshot.turnCount ?? 0),
      typeof snapshot.summary === 'string' ? snapshot.summary : null, Object.keys(object(snapshot.skillReview)).length ? JSON.stringify(snapshot.skillReview) : null));
  }
  list(filters: JsonObject): JsonObject {
    const clauses: string[] = [], values: number[] = [];
    for (const [key, operator] of [['before', '<'], ['from', '>='], ['to', '<=']] as const) if (Number.isSafeInteger(filters[key])) { clauses.push(`started_at ${operator} ?`); values.push(Number(filters[key])); }
    const limit = Number.isSafeInteger(filters.limit) ? Math.max(1, Math.min(100, Number(filters.limit))) : 20;
    const rows = this.withStore(db => db.prepare(`SELECT * FROM dream_runs${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY started_at DESC, task_id DESC LIMIT ?`).all(...values, limit + 1)) as Row[];
    return { runs: rows.slice(0, limit).map(project), hasMore: rows.length > limit };
  }
  detail(id: unknown): Json {
    if (typeof id !== 'string' || !id || id.length > 512) return null;
    const row = this.withStore(db => db.prepare('SELECT * FROM dream_runs WHERE task_id = ?').get(id)) as Row | undefined;
    return row ? project(row) : null;
  }
  latest(): Json { return (this.list({ limit: 1 }).runs as Json[])[0] ?? null; }
}
