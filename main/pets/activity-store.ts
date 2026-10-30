import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PET_TASK_RETENTION_MS, type PetActivityRecord } from './activity';

interface Dependencies { now?: () => number; onError?: (error: unknown) => void }

/** Durable terminal notifications. Live activity and pending approvals remain engine-owned. */
export class PetActivityStore {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queued = Promise.resolve();
  private pending: string | undefined;
  private written: string | undefined;
  constructor(private readonly filename: string, private readonly deps: Dependencies = {}) {}

  async load(): Promise<PetActivityRecord[]> {
    try {
      const stat = await fs.stat(this.filename);
      if (stat.size > 2 * 1024 * 1024) return [];
      const value: unknown = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      return this.normalize(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.onError?.(error);
      return [];
    }
  }

  save(records: readonly PetActivityRecord[]): void {
    const serialized = JSON.stringify(this.normalize(records));
    if (serialized === this.pending || serialized === this.written && this.pending === undefined) return;
    this.pending = serialized;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(error => this.deps.onError?.(error)); }, 150);
    this.timer.unref?.();
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const data = this.pending;
    this.pending = undefined;
    if (data === undefined) return this.queued;
    this.queued = this.queued.catch(() => {}).then(async () => {
      if (data === this.written) return;
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      const temporary = `${this.filename}.tmp`;
      try {
        await fs.writeFile(temporary, data, { mode: 0o600 });
        await fs.rename(temporary, this.filename);
        this.written = data;
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        if (this.pending === undefined) this.pending = data;
        throw error;
      }
    });
    return this.queued;
  }

  private normalize(value: unknown): PetActivityRecord[] {
    if (!Array.isArray(value)) return [];
    const now = this.deps.now?.() ?? Date.now(), records = new Map<string, PetActivityRecord>();
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (typeof row.id !== 'string' || !row.id || row.id.length > 512
        || row.status !== 'completed' && row.status !== 'failed'
        || row.status === 'completed' && row.unread === false
        || typeof row.updatedAt !== 'number' || !Number.isFinite(row.updatedAt) || row.updatedAt < 0
        || now >= row.updatedAt + PET_TASK_RETENTION_MS[row.status]) continue;
      const record: PetActivityRecord = { id: row.id, status: row.status, updatedAt: row.updatedAt, unread: row.unread !== false };
      if (typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) && row.startedAt >= 0) record.startedAt = row.startedAt;
      for (const key of ['title', 'cwd', 'projectName', 'summary', 'turnId'] as const) if (typeof row[key] === 'string') record[key] = row[key].slice(0, key === 'summary' ? 2_000 : 4_096);
      const previous = records.get(record.id);
      if (!previous || previous.updatedAt <= record.updatedAt) records.set(record.id, record);
    }
    return [...records.values()].sort((left, right) => (right.startedAt ?? right.updatedAt) - (left.startedAt ?? left.updatedAt) || left.id.localeCompare(right.id)).slice(0, 2_000);
  }
}
