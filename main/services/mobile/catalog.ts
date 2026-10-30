import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { setImmediate as yieldPage } from 'node:timers/promises';
import { object, string, type JsonObject } from '../service-types';
import { MobileError } from './protocol';

export interface CatalogSourcePage {
  rows: JsonObject[];
  nextCursor?: string;
  sourceWatermarks: Record<string, number>;
  membershipFingerprint?: string;
  metadataFingerprint?: string;
}
export interface CatalogCursor { streamId: string; revision: number }
interface Entry { row: JsonObject; updatedAt: number; encoded: string; bytes: number }
interface Change { revision: number; rows: JsonObject[]; removed: string[]; bytes: number }
interface CatalogSource {
  page(cursor: string | undefined, signal: AbortSignal): Promise<CatalogSourcePage>;
  row(id: string, signal: AbortSignal): Promise<JsonObject | null>;
  visible(id: string): boolean;
}
interface CatalogOptions {
  path?: string; now?: () => number; changed?: () => void;
  error?: (error: unknown) => void;
  active?: () => boolean;
}
const PAGE_SIZE = 100;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const FRESH_MS = 30_000;
const BACKOFF_MS = 10_000;
const DEBOUNCE_MS = 250;
const MAX_DEBOUNCE_MS = 1_000;
const MAX_PAGES = 10_000;
const MAX_CHANGES = 512;
const MAX_CHANGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

export function catalogCursor(value: unknown): CatalogCursor | undefined {
  if (value === undefined || value === null) return;
  const row = object(value);
  if (typeof row.streamId !== 'string' || !row.streamId || row.streamId.length > 128
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) {
    throw new MobileError(400, 'invalid_catalog_cursor', 'Invalid catalog cursor');
  }
  return { streamId: row.streamId, revision: Number(row.revision) };
}

/**
 * Metadata catalog, independent of transport replay and transcript hydration.
 * Only completed scans replace the published cut. A source membership digest
 * detects external deletion/archive even below the incremental watermark.
 */
export class MobileCatalog {
  private readonly controller = new AbortController();
  private readonly loaded: Promise<void>;
  private readonly now: () => number;
  private entries = new Map<string, Entry>();
  private streamId: string = randomUUID();
  private revision = 0;
  private watermark: number | null = null;
  private membership?: string;
  private metadata?: string;
  private complete = false;
  private lastSourceSuccess = -Infinity;
  private lastFailure = -Infinity;
  private failure?: unknown;
  private generation = 0;
  private dirty = new Map<string, number>();
  private fullGeneration = 0;
  private reconciledFullGeneration = -1;
  private inFlight?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private queuedAt?: number;
  private changes: Change[] = [];
  private changeBytes = 0;
  private persistGeneration = 0;
  private persistedGeneration = 0;
  private writer?: Promise<void>;
  private persistFailed = false;
  private readonly rowBytes = new WeakMap<JsonObject, number>();
  private readonly maintenance?: NodeJS.Timeout;

  constructor(private readonly source: CatalogSource, private readonly options: CatalogOptions = {}) {
    this.now = options.now ?? Date.now;
    this.loaded = this.restore();
    if (options.active) {
      this.maintenance = setInterval(() => {
        if (options.active?.()) void this.refresh().catch(error => this.options.error?.(error));
      }, FRESH_MS);
      this.maintenance.unref();
    }
  }

  async cached(): Promise<JsonObject[]> {
    await this.loaded;
    return this.visibleRows();
  }

  private visibleRows(): JsonObject[] {
    return [...this.entries].filter(([id]) => this.source.visible(id)).map(([, value]) => value.row);
  }

  invalidate(id?: string): void {
    if (this.controller.signal.aborted) return;
    const generation = ++this.generation;
    if (id) this.dirty.set(id, generation); else this.fullGeneration = generation;
    this.queuedAt ??= this.now();
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_DEBOUNCE_MS - (this.now() - this.queuedAt)));
    this.timer = setTimeout(() => {
      this.timer = undefined; this.queuedAt = undefined;
      void this.refresh().catch(error => this.options.error?.(error));
    }, delay);
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    await this.loaded;
    this.controller.signal.throwIfAborted();
    for (const id of this.entries.keys()) if (!this.source.visible(id)) this.dirty.set(id, ++this.generation);
    if (this.inFlight) return this.inFlight;
    if (this.now() - this.lastFailure < BACKOFF_MS) throw this.failure;
    if (this.complete && !this.dirty.size && this.fullGeneration === this.reconciledFullGeneration
      && this.now() - this.lastSourceSuccess < FRESH_MS) return;
    this.inFlight = this.synchronize().then(() => {
      this.lastFailure = -Infinity; this.failure = undefined;
    }, error => {
      this.lastFailure = this.now(); this.failure = error; throw error;
    }).finally(() => {
      this.inFlight = undefined;
      // Changes arriving after the scan cut remain dirty and get their own pass.
      if (!this.controller.signal.aborted && (this.dirty.size || this.fullGeneration !== this.reconciledFullGeneration)) {
        if (this.timer) clearTimeout(this.timer);
        const delay = Math.max(DEBOUNCE_MS, BACKOFF_MS - (this.now() - this.lastFailure));
        this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch(error => this.options.error?.(error)); }, delay);
        this.timer.unref();
      }
    });
    return this.inFlight;
  }

  private entry(row: JsonObject, updatedAt: number): Entry {
    if (typeof row.id !== 'string' || !row.id || !Number.isFinite(updatedAt)) throw new Error('Invalid source catalog row');
    const encoded = JSON.stringify({ row, updatedAt });
    const bytes = Buffer.byteLength(encoded);
    if (bytes > 1024 * 1024) throw new Error('Catalog summary is too large');
    this.rowBytes.set(row, bytes);
    return { row, updatedAt, encoded, bytes };
  }

  private async synchronize(): Promise<void> {
    const signal = this.controller.signal, cut = this.generation, fullCut = this.fullGeneration;
    let next = new Map(this.entries), membership = this.membership, metadata = this.metadata, watermark = this.watermark;
    const bulkDirty = this.dirty.size >= PAGE_SIZE;
    let reconciledAll = false;
    const scanSource = bulkDirty || !this.complete || fullCut !== this.reconciledFullGeneration || this.now() - this.lastSourceSuccess >= FRESH_MS;
    if (scanSource) {
      let accepted = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        signal.throwIfAborted();
        const first = await this.source.page(undefined, signal);
        const full = bulkDirty || !this.complete || fullCut !== this.reconciledFullGeneration
          || !first.membershipFingerprint || first.membershipFingerprint !== this.membership
          || !first.metadataFingerprint || first.metadataFingerprint !== this.metadata;
        next = full ? new Map() : new Map(this.entries);
        const anchors = new Map<string, number>(), cursors = new Set<string>();
        let page = first, count = 0, highest = this.watermark;
        const accept = (value: CatalogSourcePage): void => {
          for (const row of value.rows) {
            const id = string(row.id), updated = value.sourceWatermarks[id];
            if (!Number.isFinite(updated)) throw new Error('Missing source catalog watermark');
            anchors.set(id, updated!); highest = Math.max(highest ?? -Infinity, updated!);
            if (this.source.visible(id)) next.set(id, this.entry(row, updated!)); else next.delete(id);
          }
        };
        for (;;) {
          signal.throwIfAborted();
          if (++count > MAX_PAGES) throw new Error('Catalog pagination exceeded its safety bound');
          if (page.membershipFingerprint !== first.membershipFingerprint || page.metadataFingerprint !== first.metadataFingerprint) throw new Error('Catalog snapshot changed during pagination');
          accept(page);
          const crossedWatermark = !full && this.watermark !== null && Object.values(page.sourceWatermarks).some(value => value < this.watermark!);
          if (!page.nextCursor || crossedWatermark) break;
          if (cursors.has(page.nextCursor)) throw new Error('Catalog cursor did not advance');
          cursors.add(page.nextCursor);
          await yieldPage(); page = await this.source.page(page.nextCursor, signal);
        }
        // Reconcile the head against overlap anchors: pages may have taken time
        // while the source changed. A changed membership requires a fresh cut.
        let head = await this.source.page(undefined, signal), retry = false;
        const headCursors = new Set<string>();
        for (;;) {
          signal.throwIfAborted();
          if (++count > MAX_PAGES) throw new Error('Catalog head reconciliation exceeded its safety bound');
          if (head.membershipFingerprint !== first.membershipFingerprint || head.metadataFingerprint !== first.metadataFingerprint) { retry = true; break; }
          const overlap = head.rows.some(row => anchors.get(string(row.id)) === head.sourceWatermarks[string(row.id)]);
          accept(head);
          if (overlap || !head.nextCursor) break;
          if (headCursors.has(head.nextCursor)) throw new Error('Catalog head cursor did not advance');
          headCursors.add(head.nextCursor);
          await yieldPage(); head = await this.source.page(head.nextCursor, signal);
        }
        if (retry) { await yieldPage(); continue; }
        membership = first.membershipFingerprint; metadata = first.metadataFingerprint; watermark = highest; reconciledAll = full; accepted = true; break;
      }
      if (!accepted) throw new Error('Catalog membership did not settle; retry later');
    }
    for (const [id, generation] of this.dirty) {
      if (generation > cut || reconciledAll) continue;
      signal.throwIfAborted();
      const row = await this.source.row(id, signal);
      if (row && this.source.visible(id)) next.set(id, this.entry(row, next.get(id)?.updatedAt ?? 0));
      else next.delete(id);
      await yieldPage();
    }
    signal.throwIfAborted();
    for (const id of next.keys()) if (!this.source.visible(id)) next.delete(id);
    const rows: JsonObject[] = [], removed: string[] = []; let bytes = 0, totalBytes = 0;
    for (const [id, entry] of next) {
      totalBytes += entry.bytes;
      if (this.entries.get(id)?.encoded !== entry.encoded) { rows.push(entry.row); bytes += entry.bytes; }
    }
    if (totalBytes > MAX_CACHE_BYTES - 4096) throw new Error('Catalog metadata exceeded its safety bound');
    for (const id of this.entries.keys()) if (!next.has(id)) { removed.push(id); bytes += Buffer.byteLength(JSON.stringify(id)); }
    this.entries = next; this.membership = membership; this.metadata = metadata; this.watermark = watermark; this.complete = true;
    if (scanSource) this.lastSourceSuccess = this.now();
    this.reconciledFullGeneration = fullCut;
    for (const [id, generation] of this.dirty) if (generation <= cut) this.dirty.delete(id);
    if (rows.length || removed.length) {
      this.revision++;
      this.changes.push({ revision: this.revision, rows, removed, bytes }); this.changeBytes += bytes;
      while (this.changes.length > MAX_CHANGES || this.changeBytes > MAX_CHANGE_BYTES) this.changeBytes -= this.changes.shift()!.bytes;
      this.options.changed?.();
    }
    this.persistGeneration++; this.persist();
  }

  async *pages(requestId: string, cursor?: CatalogCursor, signal?: AbortSignal): AsyncGenerator<JsonObject> {
    await this.refresh(); signal?.throwIfAborted();
    const revision = this.revision, streamId = this.streamId;
    const valid = cursor?.streamId === streamId && cursor.revision <= revision
      && (cursor.revision === revision || (this.changes[0]?.revision ?? Infinity) <= cursor.revision + 1);
    const reset = !valid, rows = new Map<string, JsonObject>(), removed = new Set<string>();
    if (reset) for (const row of this.visibleRows()) rows.set(string(row.id), row);
    else for (const change of this.changes) if (change.revision > cursor!.revision) {
      for (const row of change.rows) { const id = string(row.id); if (this.source.visible(id)) { rows.set(id, row); removed.delete(id); } else { rows.delete(id); removed.add(id); } }
      for (const id of change.removed) { rows.delete(id); removed.add(id); }
    }
    const entries = [...rows.values()], deleted = [...removed];
    let offset = 0, removedOffset = 0;
    do {
      signal?.throwIfAborted(); this.controller.signal.throwIfAborted();
      const envelope = { type: 'catalog_page', requestId, streamId, baseRevision: reset ? null : cursor!.revision, revision, reset };
      const sessions: JsonObject[] = [], removedSessionIds: string[] = [];
      let count = 0, bytes = Buffer.byteLength(JSON.stringify({ ...envelope, sessions, removedSessionIds, done: false }));
      // A captured cut is immutable, but access can be revoked while a slow
      // peer drains an earlier page. Never publish newly hidden metadata.
      while (offset < entries.length && count < PAGE_SIZE) {
        const row = entries[offset]!, id = string(row.id), visible = this.source.visible(id);
        const rowBytes = visible ? this.rowBytes.get(row)! : reset ? 0 : Buffer.byteLength(JSON.stringify(id));
        if (count && bytes + rowBytes + 1 > MAX_PAGE_BYTES) break;
        offset++; count++; bytes += rowBytes + 1;
        if (visible) sessions.push(row);
        else { this.invalidate(id); if (!reset) removedSessionIds.push(id); }
      }
      while (removedOffset < deleted.length && count < PAGE_SIZE) {
        const id = deleted[removedOffset]!, rowBytes = Buffer.byteLength(JSON.stringify(id));
        if (count && bytes + rowBytes + 1 > MAX_PAGE_BYTES) break;
        removedOffset++; count++; bytes += rowBytes + 1; removedSessionIds.push(id);
      }
      yield { ...envelope, sessions, removedSessionIds, done: offset >= entries.length && removedOffset >= deleted.length };
      await yieldPage();
    } while (offset < entries.length || removedOffset < deleted.length);
  }

  async close(): Promise<void> {
    this.controller.abort(); if (this.timer) clearTimeout(this.timer);
    if (this.maintenance) clearInterval(this.maintenance);
    await this.loaded; await this.inFlight?.catch(() => {});
    while (this.writer || (this.options.path && !this.persistFailed && this.persistedGeneration < this.persistGeneration)) {
      if (!this.writer) this.persist();
      await this.writer;
    }
  }

  private async restore(): Promise<void> {
    if (!this.options.path) return;
    try {
      const input = createReadStream(this.options.path, { encoding: 'utf8' });
      const reader = createInterface({ input, crlfDelay: Infinity });
      const entries = new Map<string, Entry>(); let metadata: JsonObject | undefined, bytes = 0;
      try {
        for await (const line of reader) {
          bytes += Buffer.byteLength(line); if (bytes > MAX_CACHE_BYTES) throw new Error('Catalog cache is too large');
          const value = object(JSON.parse(line));
          if (!metadata) { metadata = value; continue; }
          const row = object(value.row), entry = this.entry(row, Number(value.updatedAt));
          if (entries.has(string(row.id))) throw new Error('Duplicate cached catalog row');
          entries.set(string(row.id), entry);
          if (entries.size % PAGE_SIZE === 0) await yieldPage();
        }
      } finally { reader.close(); input.destroy(); }
      if (!metadata || metadata.version !== 1 || typeof metadata.streamId !== 'string'
        || !Number.isSafeInteger(metadata.revision) || Number(metadata.revision) < 0
        || metadata.count !== entries.size || typeof metadata.membership !== 'string'
        || !(metadata.watermark === null || typeof metadata.watermark === 'number' && Number.isFinite(metadata.watermark))) throw new Error('Invalid catalog cache');
      this.entries = entries; this.streamId = metadata.streamId; this.revision = Number(metadata.revision);
      this.membership = metadata.membership; this.metadata = typeof metadata.metadata === 'string' ? metadata.metadata : undefined; this.watermark = metadata.watermark as number | null;
      this.complete = true; this.reconciledFullGeneration = this.fullGeneration;
      // Runtime ownership is not durable. Revalidate previously working rows
      // even when their canonical metadata/recency has not changed on disk.
      for (const [id, entry] of entries) if (entry.row.isWorking === true) this.dirty.set(id, ++this.generation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.error?.(error);
    }
  }

  private persist(): void {
    if (!this.options.path || this.writer || this.persistedGeneration >= this.persistGeneration) return;
    this.persistFailed = false;
    this.writer = (async () => {
      while (this.persistedGeneration < this.persistGeneration) {
        const generation = this.persistGeneration, entries = [...this.entries.values()];
        const header = JSON.stringify({ version: 1, streamId: this.streamId, revision: this.revision,
          watermark: this.watermark, membership: this.membership ?? '', metadata: this.metadata ?? '', count: entries.length });
        const path = this.options.path!, temporary = path + '.tmp-' + randomUUID();
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(header + '\n');
          for (let index = 0; index < entries.length; index += PAGE_SIZE) {
            await handle.writeFile(entries.slice(index, index + PAGE_SIZE).map(entry => entry.encoded + '\n').join(''));
            await yieldPage();
          }
          await handle.sync(); await handle.close(); await rename(temporary, path);
          this.persistedGeneration = generation;
        } catch (error) { await handle.close().catch(() => {}); await rm(temporary, { force: true }); throw error; }
      }
    })().catch(error => { this.persistFailed = true; this.options.error?.(error); }).finally(() => {
      this.writer = undefined;
      // A synchronization can publish another generation after the loop has
      // settled but before this finalizer releases the single-writer slot.
      // Retry only successful writes; storage failures must not spin on close.
      if (!this.persistFailed && this.persistedGeneration < this.persistGeneration) this.persist();
    });
  }
}

export const catalogAccountKey = (accountId: string): string => createHash('sha256').update('klaus-mobile-catalog-v1\0' + accountId).digest('hex');
