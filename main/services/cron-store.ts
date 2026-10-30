import { randomBytes } from 'node:crypto';
import { LEGACY_CRON_STOP_ERRORS } from '../../contracts/cron-runs';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { withSettingsDb, withSettingsTransaction } from './settings';
import { type JsonObject, object, string, errorMessage } from './service-types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cron_tasks (
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT, description TEXT,
  schedule TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  thinking TEXT, light_context INTEGER DEFAULT 0, timeout_seconds INTEGER,
  delete_after_run INTEGER DEFAULT 0, timezone TEXT, deliver TEXT, webhook_url TEXT,
  webhook_token TEXT, failure_alert TEXT, channel_binding TEXT, created_by TEXT, engine_mode TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, task_name TEXT NOT NULL,
  session_id TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, finished_at INTEGER,
  duration_ms INTEGER, trigger_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', error TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_task ON cron_runs(task_id);
`;
const TASK_COLUMNS = 'id,name,description,schedule,prompt,enabled,thinking,timeout_seconds,delete_after_run,timezone,channel_binding,created_by,notification_policy,model,workdir,created_at,updated_at';
// Pre-notification-policy databases miss the column; CREATE TABLE IF NOT EXISTS
// cannot add it, so every operation migrates first (cheap PRAGMA check).
function ensureColumns(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(cron_tasks)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'notification_policy')) {
    db.exec("ALTER TABLE cron_tasks ADD COLUMN notification_policy TEXT");
  }
  // The model and project-directory picks landed after the table did; older
  // databases keep running with both absent until migrated here.
  if (!columns.some(column => column.name === 'model')) {
    db.exec("ALTER TABLE cron_tasks ADD COLUMN model TEXT");
  }
  if (!columns.some(column => column.name === 'workdir')) {
    db.exec("ALTER TABLE cron_tasks ADD COLUMN workdir TEXT");
  }
  const migration = 'migrated.cron_stopped_runs_v1';
  if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get(migration)) {
    db.prepare("UPDATE cron_runs SET status='stopped',error=NULL WHERE status IN ('failed','success') AND error IN (?,?)")
      .run(...LEGACY_CRON_STOP_ERRORS);
    db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,'1')").run(migration);
  }
}
function integer(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
function optional(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function binding(raw: unknown): Json {
  if (typeof raw !== 'string') return null;
  try { const value = object(JSON.parse(raw)); return Object.hasOwn(value, 'channelId') && Object.hasOwn(value, 'targetId') ? value : null; }
  catch { return null; }
}
function task(row: Record<string, unknown>): JsonObject {
  const policy = optional(row.notification_policy);
  return {
    id: string(row.id), name: optional(row.name), description: optional(row.description),
    schedule: string(row.schedule), prompt: string(row.prompt), enabled: row.enabled === 1,
    thinking: optional(row.thinking), timeoutSeconds: integer(row.timeout_seconds) ?? null,
    deleteAfterRun: row.delete_after_run === 1, timezone: optional(row.timezone),
    channelBinding: binding(row.channel_binding), createdBy: optional(row.created_by),
    notificationPolicy: policy === 'all_runs' ? 'all_runs' : 'failed_runs_only',
    model: optional(row.model), workdir: optional(row.workdir),
    createdAt: integer(row.created_at) ?? 0, updatedAt: integer(row.updated_at) ?? 0,
  };
}
function run(row: Record<string, unknown>): JsonObject {
  return { id: Number(row.id), taskId: string(row.task_id), taskName: string(row.task_name), sessionId: string(row.session_id),
    startedAt: Number(row.started_at), finishedAt: integer(row.finished_at) ?? null, durationMs: integer(row.duration_ms) ?? null,
    triggerType: string(row.trigger_type), status: string(row.status), error: optional(row.error) };
}

/** Scheduler persistence only. The TS scheduler owns clocks, sessions and cancellation. */
export class CronStore {
  constructor(readonly configRoot = configRootFrom()) {}
  private operation<T>(write: boolean, fn: (db: DatabaseSync) => T): T {
    try {
      return (write ? withSettingsTransaction : withSettingsDb)(this.configRoot, db => { db.exec(SCHEMA); ensureColumns(db); return fn(db); });
    } catch (error) {
      if (error instanceof IpcHandlerError) throw error;
      throw new IpcHandlerError(write ? 'SETTINGS_DB_WRITE_FAILED' : 'SETTINGS_DB_READ_FAILED', errorMessage(error));
    }
  }
  listTasks(): JsonObject[] { return this.operation(false, db => db.prepare(`SELECT ${TASK_COLUMNS} FROM cron_tasks ORDER BY created_at ASC`).all().map(task)); }
  toolTasks(): JsonObject[] { return this.operation(false, db => db.prepare(`SELECT ${TASK_COLUMNS} FROM cron_tasks WHERE user_id='desktop' ORDER BY created_at ASC`).all().map(task)); }
  deleteToolTask(id: string): boolean {
    return this.operation(true, db => {
      if (!db.prepare("SELECT 1 FROM cron_tasks WHERE id=? AND user_id='desktop'").get(id)) return false;
      db.prepare('DELETE FROM cron_runs WHERE task_id=?').run(id);
      return db.prepare("DELETE FROM cron_tasks WHERE id=? AND user_id='desktop'").run(id).changes > 0;
    });
  }
  recoverInterruptedRuns(): number {
    return this.operation(true, db => Number(db.prepare("UPDATE cron_runs SET status='failed',finished_at=?,duration_ms=MAX(0,?-started_at),error='interrupted (app restart)' WHERE status='running'").run(Date.now(), Date.now()).changes));
  }
  getTask(id: string): JsonObject | null {
    return this.operation(false, db => { const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM cron_tasks WHERE id=?`).get(id); return row ? task(row) : null; });
  }
  upsertTask(payload: JsonObject): void {
    this.operation(true, db => {
      const id = string(payload.id);
      if (!id) throw new IpcHandlerError('BAD_REQUEST', 'task id required');
      const existing = db.prepare('SELECT channel_binding,created_by FROM cron_tasks WHERE id=?').get(id), now = Date.now();
      const retainedBinding = binding(existing?.channel_binding);
      const channelBinding = payload.channelBinding !== undefined && payload.channelBinding !== null ? JSON.stringify(payload.channelBinding) : retainedBinding !== null ? JSON.stringify(retainedBinding) : null;
      db.prepare(`INSERT INTO cron_tasks (id,user_id,name,description,schedule,prompt,enabled,thinking,timeout_seconds,delete_after_run,timezone,channel_binding,created_by,notification_policy,model,workdir,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,description=excluded.description,schedule=excluded.schedule,prompt=excluded.prompt,
        enabled=excluded.enabled,thinking=excluded.thinking,timeout_seconds=excluded.timeout_seconds,
        delete_after_run=excluded.delete_after_run,timezone=excluded.timezone,notification_policy=excluded.notification_policy,
        model=excluded.model,workdir=excluded.workdir,updated_at=excluded.updated_at`).run(
        id, optional(payload.userId), optional(payload.name), optional(payload.description), string(payload.schedule), string(payload.prompt), Number(payload.enabled === true), optional(payload.thinking),
        integer(payload.timeoutSeconds) ?? null, Number(payload.deleteAfterRun === true), optional(payload.timezone), channelBinding,
        optional(payload.createdBy) ?? optional(existing?.created_by) ?? 'manual',
        payload.notificationPolicy === 'all_runs' ? 'all_runs' : 'failed_runs_only',
        optional(payload.model), optional(payload.workdir),
        integer(payload.createdAt) || now, now,
      );
    });
  }
  deleteTask(id: string): Json {
    return this.operation(true, db => {
      const sessionCount = Number(db.prepare("SELECT COUNT(*) AS count FROM cron_runs WHERE task_id=? AND session_id!='' AND session_id NOT LIKE 'cron-run-%'").get(id)!.count);
      db.prepare('DELETE FROM cron_runs WHERE task_id=?').run(id);
      const deleted = db.prepare('DELETE FROM cron_tasks WHERE id=?').run(id).changes > 0;
      return { deleted, sessionCount };
    });
  }
  listRuns(filters: JsonObject = {}): JsonObject[] {
    return this.operation(false, db => {
      const where: string[] = [], values: SQLInputValue[] = [];
      const taskId = string(filters.taskId), status = string(filters.status);
      if (taskId) { where.push('task_id=?'); values.push(taskId); }
      if (status === 'failed') where.push("(status='failed' OR (status='success' AND COALESCE(error,'')!=''))");
      else if (status === 'success') where.push("status='success' AND COALESCE(error,'')=''");
      else if (status) { where.push('status=?'); values.push(status); }
      values.push(Math.max(1, Math.min(1000, integer(filters.limit) ?? 200)), Math.max(0, integer(filters.offset) ?? 0));
      return db.prepare(`SELECT id,task_id,task_name,session_id,started_at,finished_at,duration_ms,trigger_type,status,error FROM cron_runs${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?`).all(...values).map(run);
    });
  }
  pruneRuns(filters: JsonObject = {}): Json {
    return this.operation(true, db => {
      const values: SQLInputValue[] = [integer(filters.before) ?? Date.now()], id = string(filters.taskId);
      const where = "status!='running' AND started_at<?" + (id ? ' AND task_id=?' : '');
      if (id) values.push(id);
      const sessionCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM cron_runs WHERE ${where} AND session_id!=''`).get(...values)!.count);
      const pruned = Number(db.prepare(`DELETE FROM cron_runs WHERE ${where}`).run(...values).changes);
      return { pruned, sessionCount };
    });
  }
  createRun(taskId: string, taskName: string, trigger: string): { runId: number; sessionId: string } {
    return this.operation(true, db => {
      const now = Date.now(), sessionId = `cron-run-${taskId}-${now}-${randomBytes(3).toString('hex')}`;
      const row = db.prepare("INSERT INTO cron_runs(task_id,task_name,session_id,started_at,trigger_type,status) VALUES(?,?,?,?,?,'running')").run(taskId, taskName, sessionId, now, trigger);
      return { runId: Number(row.lastInsertRowid), sessionId };
    });
  }
  bindSession(runId: number, sessionId: string): void { this.operation(true, db => { db.prepare('UPDATE cron_runs SET session_id=? WHERE id=?').run(sessionId, runId); }); }
  finishRun(runId: number, status: string, durationMs: number, error: string | null = null): void {
    this.operation(true, db => { db.prepare('UPDATE cron_runs SET finished_at=?,duration_ms=?,status=?,error=? WHERE id=?').run(Date.now(), durationMs, status, error, runId); });
  }
  reapStaleRuns(now = Date.now()): number {
    return this.operation(true, db => Number(db.prepare("UPDATE cron_runs SET status='failed',finished_at=started_at,duration_ms=0,error='interrupted (app restart)' WHERE status='running' AND started_at<?").run(now - 24 * 60 * 60_000).changes));
  }
  disableTask(id: string): void { this.operation(true, db => { db.prepare('UPDATE cron_tasks SET enabled=0,updated_at=? WHERE id=?').run(Date.now(), id); }); }
  sessionSources(): JsonObject[] {
    return this.operation(false, db => db.prepare("SELECT id,task_id,task_name,session_id,trigger_type FROM cron_runs WHERE session_id!='' AND session_id NOT LIKE 'cron-run-%' ORDER BY started_at ASC,id ASC").all().map(row => ({ runId: Number(row.id), taskId: string(row.task_id), taskName: string(row.task_name), sessionId: string(row.session_id), triggerType: string(row.trigger_type) })));
  }
}
