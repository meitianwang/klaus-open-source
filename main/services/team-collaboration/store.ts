import type { CollaborationExecution, CollaborationRequest } from '../../../contracts/team-collaboration';
import { withSettingsDb } from '../settings';

export interface ExecutionJournal {
  accountId: string;
  key: string;
  projectId: string | null;
  fingerprint: string;
  createRequest: Extract<CollaborationRequest, { type: 'executions.create' }>;
  execution: CollaborationExecution | null;
  sessionId: string | null;
  turnId: string | null;
  status: CollaborationExecution['status'];
  syncPending: boolean;
  syncBlocked?: boolean;
  finalResponse?: string;
  cancellationFailed?: boolean;
}

/** No credentials or filesystem paths are part of execution records sent to the server. */
export class CollaborationStore {
  constructor(readonly root: string) {}
  private db<T>(work: Parameters<typeof withSettingsDb<T>>[1]): T {
    return withSettingsDb(this.root, db => {
      db.exec(`CREATE TABLE IF NOT EXISTS collaboration_local_bindings (
        account_id TEXT NOT NULL, project_id TEXT NOT NULL, local_folder TEXT NOT NULL,
        PRIMARY KEY (account_id, project_id));
        CREATE TABLE IF NOT EXISTS collaboration_event_cursors (
        account_id TEXT NOT NULL, project_id TEXT NOT NULL, cursor TEXT NOT NULL,
        PRIMARY KEY (account_id, project_id));
        CREATE TABLE IF NOT EXISTS collaboration_executions (
        account_id TEXT NOT NULL, request_key TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY (account_id, request_key));`);
      return work(db);
    });
  }
  binding(accountId: string, projectId: string): string | null {
    return this.db(db => {
      const row = db.prepare('SELECT local_folder FROM collaboration_local_bindings WHERE account_id = ? AND project_id = ?').get(accountId, projectId);
      return typeof row?.local_folder === 'string' ? row.local_folder : null;
    });
  }
  bind(accountId: string, projectId: string, folder: string | null): void {
    this.db(db => {
      if (folder === null) db.prepare('DELETE FROM collaboration_local_bindings WHERE account_id = ? AND project_id = ?').run(accountId, projectId);
      else db.prepare('INSERT INTO collaboration_local_bindings VALUES (?, ?, ?) ON CONFLICT(account_id, project_id) DO UPDATE SET local_folder = excluded.local_folder').run(accountId, projectId, folder);
    });
  }
  cursor(accountId: string, projectId: string): string {
    return this.db(db => String(db.prepare('SELECT cursor FROM collaboration_event_cursors WHERE account_id = ? AND project_id = ?').get(accountId, projectId)?.cursor ?? ''));
  }
  setCursor(accountId: string, projectId: string, cursor: string): void {
    this.db(db => db.prepare('INSERT INTO collaboration_event_cursors VALUES (?, ?, ?) ON CONFLICT(account_id, project_id) DO UPDATE SET cursor = excluded.cursor').run(accountId, projectId, cursor));
  }
  journal(accountId: string, key: string): ExecutionJournal | undefined {
    return this.db(db => {
      const record = db.prepare('SELECT record FROM collaboration_executions WHERE account_id = ? AND request_key = ?').get(accountId, key)?.record;
      return typeof record === 'string' ? JSON.parse(record) as ExecutionJournal : undefined;
    });
  }
  journals(accountId: string): ExecutionJournal[] {
    return this.db(db => db.prepare('SELECT record FROM collaboration_executions WHERE account_id = ?').all(accountId)
      .map(row => JSON.parse(String(row.record)) as ExecutionJournal));
  }
  save(row: ExecutionJournal): void {
    this.db(db => db.prepare('INSERT INTO collaboration_executions VALUES (?, ?, ?) ON CONFLICT(account_id, request_key) DO UPDATE SET record = excluded.record').run(row.accountId, row.key, JSON.stringify(row)));
  }
}
