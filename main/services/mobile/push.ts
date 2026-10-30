import { createHash } from 'node:crypto';
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type MobilePushKind = 'done' | 'failed' | 'permission' | 'elicitation' | 'question';
export interface MobilePushNotice { eventId: string; sessionId: string; kind: MobilePushKind; occurredAt: number; resolved?: true }
const MAX_PENDING = 128;
const MAX_OUTBOX_BYTES = 256 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;

/** An account-scoped, bounded outbox survives relay outages until durable server acceptance. */
export class MobilePushOutbox {
  private pending = new Map<string, MobilePushNotice>();
  private tail = Promise.resolve();
  readonly ready: Promise<void>;
  private readonly file: string;
  constructor(root: string, accountId: string, private readonly log: (event: string) => void = () => {}) {
    this.file = join(root, 'mobile-push', createHash('sha256').update(accountId).digest('hex') + '.json');
    this.ready = this.load();
  }
  private async load(): Promise<void> {
    try {
      const handle = await open(this.file, 'r');
      let text: string;
      try {
        if ((await handle.stat()).size > MAX_OUTBOX_BYTES) throw new Error('Outbox exceeds limit');
        const buffer = Buffer.alloc(MAX_OUTBOX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break; length += bytesRead;
        }
        if (length > MAX_OUTBOX_BYTES) throw new Error('Outbox exceeds limit');
        text = buffer.subarray(0, length).toString('utf8');
      } finally { await handle.close(); }
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return;
      for (const value of parsed.slice(-MAX_PENDING)) if (valid(value) && value.occurredAt > Date.now() - MAX_AGE_MS) this.pending.set(value.eventId, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log('push_outbox_load_failed');
    }
  }
  enqueue(notice: MobilePushNotice): Promise<void> {
    return this.change(() => {
      if (!valid(notice) || this.pending.has(notice.eventId) && !notice.resolved) return;
      this.prune();
      if (this.pending.size >= MAX_PENDING) {
        this.pending.delete(this.pending.keys().next().value!); this.log('push_outbox_overflow');
      }
      this.pending.set(notice.eventId, notice);
    });
  }
  acknowledge(eventId: string, resolved = false): Promise<void> { return this.change(() => {
    if (Boolean(this.pending.get(eventId)?.resolved) === resolved) this.pending.delete(eventId);
  }); }
  notices(): MobilePushNotice[] { this.prune(); return [...this.pending.values()]; }
  private prune(): void {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [id, row] of this.pending) if (row.occurredAt <= cutoff) this.pending.delete(id);
  }
  private change(change: () => void): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.ready; change();
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.tmp';
      await writeFile(temporary, JSON.stringify([...this.pending.values()]), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.tail = operation.catch(() => { this.log('push_outbox_save_failed'); });
    return operation;
  }
  flush(): Promise<void> { return this.tail; }
}
function valid(value: unknown): value is MobilePushNotice {
  if (!value || typeof value !== 'object') return false;
  const row = value as MobilePushNotice;
  return typeof row.eventId === 'string' && row.eventId.length > 0 && row.eventId.length <= 512
    && typeof row.sessionId === 'string' && row.sessionId.length > 0 && row.sessionId.length <= 512
    && ['done', 'failed', 'permission', 'elicitation', 'question'].includes(row.kind)
    && Number.isFinite(row.occurredAt) && row.occurredAt > 0 && row.occurredAt <= Date.now() + 300_000;
}
