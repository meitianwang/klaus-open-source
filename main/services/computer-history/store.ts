import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ComputerHistoryEntry } from './types';

export const COMPUTER_HISTORY_RETENTION_MS = 48 * 60 * 60 * 1000;
export const COMPUTER_HISTORY_MAX_ENTRIES = 20_000;
export const COMPUTER_HISTORY_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
export const COMPUTER_HISTORY_SUBDIRECTORY = 'computer-history';

export type ClearInterval = 'all' | 'last-day' | 'last-hour';
const CLEAR_INTERVAL_MS: Record<ClearInterval, number> = { all: 0, 'last-day': 24 * 60 * 60 * 1000, 'last-hour': 60 * 60 * 1000 };

function entry(value: unknown): ComputerHistoryEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.kind !== 'app' && row.kind !== 'window') return undefined;
  if (typeof row.at !== 'number' || !Number.isFinite(row.at) || row.at <= 0) return undefined;
  const text = (input: unknown): string | undefined => typeof input === 'string' && input.length > 0 && input.length <= 4096 && !input.includes('\n') ? input : undefined;
  const result: ComputerHistoryEntry = { kind: row.kind, at: row.at };
  const bundleId = text(row.bundleId), name = text(row.name), title = text(row.title), url = text(row.url);
  if (bundleId) result.bundleId = bundleId;
  if (name) result.name = name;
  if (title) result.title = title;
  if (url) result.url = url;
  return result;
}

/**
 * The local timeline store: one bounded JSONL file under the config root, with
 * a 48-hour retention window, an entry cap, periodic pruning and a per-day
 * Markdown digest that keeps the recorded environment reviewable. Everything
 * is local; nothing is uploaded and a write failure never throws upward.
 */
export class ComputerHistoryStore {
  private cachedCount = 0;
  constructor(private readonly root: string, private readonly now: () => number = Date.now) {}

  private get directory(): string { return join(this.root, COMPUTER_HISTORY_SUBDIRECTORY); }
  private get path(): string { return join(this.directory, 'events.jsonl'); }
  private get memoryDirectory(): string { return join(this.directory, 'memory'); }

  append(candidate: ComputerHistoryEntry): boolean {
    const value = entry(candidate);
    if (!value) return false;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(value)}\n`);
      this.cachedCount++;
      return true;
    } catch { return false; }
  }

  /** Parse the ledger, skipping corrupt lines; a broken file never throws. */
  readAll(): ComputerHistoryEntry[] {
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); }
    catch { this.cachedCount = 0; return []; }
    const entries: ComputerHistoryEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const parsed = entry(JSON.parse(line)); if (parsed) entries.push(parsed); }
      catch { /* a corrupt line is dropped, never fatal */ }
    }
    this.cachedCount = entries.length;
    return entries;
  }

  count(): number {
    if (this.cachedCount > 0) return this.cachedCount;
    try { return statSync(this.path).size > 0 ? this.readAll().length : 0; }
    catch { return 0; }
  }

  /** Newest-last page of the timeline, optionally before an epoch-ms cursor. */
  entries(limit = 200, before?: number): ComputerHistoryEntry[] {
    const max = Math.max(1, Math.min(500, Math.floor(limit) || 200));
    const all = this.readAll();
    const filtered = before === undefined ? all : all.filter(item => item.at < before);
    return filtered.slice(Math.max(0, filtered.length - max));
  }

  private rewrite(entries: readonly ComputerHistoryEntry[]): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, entries.map(item => JSON.stringify(item)).join(entries.length ? '\n' : '') + (entries.length ? '\n' : ''));
    renameSync(temporary, this.path);
    this.cachedCount = entries.length;
  }

  /** Enforce the retention window and the entry cap; regenerates the digest. */
  prune(): { removed: number } {
    const cutoff = this.now() - COMPUTER_HISTORY_RETENTION_MS;
    const all = this.readAll();
    const kept = all.filter(item => item.at >= cutoff).slice(-COMPUTER_HISTORY_MAX_ENTRIES);
    const removed = all.length - kept.length;
    if (removed > 0) this.rewrite(kept);
    this.exportDigest();
    return { removed };
  }

  clear(interval: ClearInterval = 'all'): { removed: number } {
    if (interval !== 'all' && interval !== 'last-day' && interval !== 'last-hour') throw new Error('Unknown Computer History clear interval');
    const all = this.readAll();
    if (interval === 'all') { this.rewrite([]); this.exportDigest(); return { removed: all.length }; }
    const cutoff = this.now() - CLEAR_INTERVAL_MS[interval];
    const kept = all.filter(item => item.at < cutoff);
    const removed = all.length - kept.length;
    this.rewrite(kept);
    this.exportDigest();
    return { removed };
  }

  /** Rewrite today's Markdown digest from the live ledger; idempotent. */
  exportDigest(): string | undefined {
    const now = this.now();
    const day = new Date(now);
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const lines = this.readAll().filter(item => item.at >= start && item.at <= now).map(item => {
      const at = new Date(item.at);
      const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      if (item.kind === 'app') return `- ${time}  ${item.name ?? item.bundleId ?? 'Application'} (activated)`;
      const source = item.url ? new URL(item.url).hostname : undefined;
      return `- ${time}  ${item.name ?? item.bundleId ?? 'Application'} — ${item.title ?? ''}${source ? ` (${source})` : ''}`.trimEnd();
    });
    const label = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    try {
      mkdirSync(this.memoryDirectory, { recursive: true, mode: 0o700 });
      const path = join(this.memoryDirectory, `${label}.md`);
      writeFileSync(path, `# Computer History — ${label}\n\n${lines.length ? lines.join('\n') : '_No observations recorded today._'}\n`);
      return path;
    } catch { return undefined; }
  }
}
