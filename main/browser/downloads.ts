import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BrowserError, message, type BrowserObject } from './types';
import type { BrowserDownloadChangedEvent, BrowserDownloadStatus } from '../../contracts/browser-history';

export function downloadFilename(input: unknown, fallback = 'download'): string {
  if (input === undefined || input === null || input === '') return downloadFilename(fallback, 'download');
  if (typeof input !== 'string' || input.trim() !== input || Buffer.byteLength(input)>200 || /[\\/:*?"<>|\u0000-\u001f]/u.test(input) || /[. ]$/u.test(input) || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(input)) throw new BrowserError('invalid_request', 'filename must be a safe basename within 200 UTF-8 bytes, without folders or reserved characters.');
  return input;
}

export function suggestedFilename(url: string, header?: string | null): string {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(header ?? '')?.[1];
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(header ?? '');
  let proposed = plain?.[1] ?? plain?.[2];
  try { if (encoded) proposed = decodeURIComponent(encoded); proposed ||= decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch {}
  let name=basename(String(proposed || 'download').replace(/\\/gu, '/')).replace(/[/:*?"<>|\u0000-\u001f]/gu, '_').trim().replace(/[. ]+$/u, '') || 'download';
  while(Buffer.byteLength(name)>180)name=Array.from(name).slice(0,-1).join('');
  try{return downloadFilename(name);}catch{return `_${name}`;}
}

export function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new BrowserError('download_canceled', 'The download was canceled.');
}

export async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  aborted(signal);
  let onAbort: (() => void) | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { onAbort = () => { try { aborted(signal); } catch (error) { reject(error); } }; signal.addEventListener('abort', onAbort, { once: true }); })]); }
  finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

export async function saveDownload(
  directory: string,
  id: string,
  filename: string,
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  onProgress?: (bytes: number) => void,
): Promise<BrowserObject> {
  const folder = join(directory, id); const path = join(folder, downloadFilename(filename)); const partial = join(folder, '.partial');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = await open(partial, 'wx', 0o600); let bytes = 0; let completed = false;
  try {
    for await (const chunk of chunks) {
      aborted(signal);
      await file.writeFile(chunk);
      bytes += chunk.byteLength;
      onProgress?.(bytes);
    }
    aborted(signal); await file.close(); await rename(partial, path); aborted(signal); completed = true;
    return { path, filePath: path, filename, bytes };
  } finally { await file.close().catch(() => {}); if (!completed) await rm(folder, { recursive: true, force: true }); }
}

interface DownloadEntry {
  id: string; owner: string; value: BrowserObject; controller: AbortController;
  settled: boolean; promise: Promise<BrowserObject>; finish(value: BrowserObject | Error): void;
}

export interface DownloadObserver {
  created?(id: string, owner: string, url: string, value: BrowserObject, meta: BrowserObject): void;
  changed?(id: string, owner: string, url: string, value: BrowserObject, meta: BrowserObject): void;
}

/** The owner includes the exact page identity. URL matching never crosses it. */
export class DownloadStore {
  private readonly entries = new Map<string, DownloadEntry>();
  private readonly meta = new Map<string, BrowserObject>();
  private readonly released = new Set<string>();
  private closed = false;
  private readonly directorySource: string | (() => string);
  constructor(directory: string | (() => string), private readonly observer: DownloadObserver = {}) {
    this.directorySource = directory;
  }

  get directory(): string { return typeof this.directorySource === 'string' ? this.directorySource : this.directorySource(); }

  private active(owner: string): void { if (this.closed || this.released.has(owner)) throw new BrowserError('stale_tab', 'The download page was released.'); }

  private notify(kind: 'created' | 'changed', entry: DownloadEntry): void {
    const meta = this.meta.get(entry.id) ?? {};
    try {
      if (kind === 'created') this.observer.created?.(entry.id, entry.owner, String(entry.value.url ?? ''), { ...entry.value }, { ...meta });
      else this.observer.changed?.(entry.id, entry.owner, String(entry.value.url ?? ''), { ...entry.value }, { ...meta });
    }
    catch { /* History bookkeeping must not change download completion semantics. */ }
  }

  create(owner: string, url: string, initial: BrowserObject = {}, meta: BrowserObject = {}, stableId?: string): DownloadEntry {
    this.active(owner);
    if (stableId !== undefined && (typeof stableId !== 'string' || !stableId.trim())) {
      throw new BrowserError('invalid_request', 'A stable download id must be a non-empty string.');
    }
    const id = stableId ?? randomUUID();
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.owner !== owner) throw new BrowserError('stale_download', 'The download belongs to another page.');
      return existing;
    }
    if ([...this.entries.values()].filter(entry => entry.owner === owner).length >= 100) throw new BrowserError('download_limit', 'This page reached its 100 download handle limit. Open another tab to continue.');
    const controller = new AbortController();
    let resolveResult!: (value: BrowserObject) => void; let reject!: (error: Error) => void;
    const promise = new Promise<BrowserObject>((resolve, fail) => { resolveResult = resolve; reject = fail; });
    // User clicks may complete or fail before a tool starts waiting for them.
    void promise.catch(() => {});
    const entry: DownloadEntry = { id, owner, value: { id, url, status: 'in_progress', startedAt: Date.now(), ...initial }, controller, settled: false, promise, finish: value => {
      if (entry.settled) return; entry.settled = true;
      if (value instanceof Error) {
        entry.value = { ...entry.value, status: controller.signal.aborted ? 'canceled' : 'failed', error: message(value), finishedAt: Date.now() };
        reject(value);
      } else {
        entry.value = { ...entry.value, ...value, id, status: 'completed', state: 'completed', finishedAt: Date.now() };
        resolveResult({ ...entry.value });
      }
      this.notify('changed', entry);
    } };
    controller.signal.addEventListener('abort', () => entry.finish(controller.signal.reason instanceof Error ? controller.signal.reason : new BrowserError('download_canceled', 'The download was canceled.')), { once: true });
    this.entries.set(id, entry); this.meta.set(id, { ...meta });
    this.notify('created', entry);
    return entry;
  }

  async run(
    owner: string,
    url: string,
    timeout: number,
    work: (id: string, signal: AbortSignal) => Promise<BrowserObject>,
    meta: BrowserObject = {},
    externalSignal?: AbortSignal,
  ): Promise<BrowserObject> {
    const entry = this.create(owner,url,{},meta);
    const abortExternal = (): void => {
      entry.controller.abort(externalSignal?.reason instanceof Error
        ? externalSignal.reason
        : new BrowserError('download_canceled', 'The download was canceled.'));
    };
    if (externalSignal?.aborted) abortExternal();
    else externalSignal?.addEventListener('abort', abortExternal, { once: true });
    const timer = setTimeout(() => entry.controller.abort(new BrowserError('timeout','Download timed out and was canceled.')), timeout);
    const pending=Promise.resolve().then(()=>work(entry.id,entry.controller.signal));
    try { entry.finish(await withAbort(pending, entry.controller.signal)); }
    catch (error) {
      entry.finish(error instanceof Error ? error : new Error(String(error)));
      // Keep the page transport alive until its abort script and partial-file
      // cleanup finish. The caller may detach CDP immediately after we return.
      let drainTimer:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([pending.catch(()=>{}),new Promise(resolve=>{drainTimer=setTimeout(resolve,1500);})]);}finally{clearTimeout(drainTimer);}
    }
    finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortExternal);
    }
    return entry.promise;
  }

  list(owner: string): BrowserObject[] { this.active(owner); return [...this.entries.values()].filter(entry => entry.owner === owner).map(entry => ({ ...entry.value })); }

  get(id: string): BrowserObject | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry.value } : undefined;
  }

  has(id: string): boolean { return this.entries.has(id); }

  ownerOf(id: string): string | undefined { return this.entries.get(id)?.owner; }

  settled(id: string): boolean { return this.entries.get(id)?.settled === true; }

  /**
   * Apply a native Profile snapshot to an existing entry. Paused/in-progress
   * states notify progress; terminal states settle the same promise waiters
   * use for local downloads. Late terminal snapshots never reopen an entry.
   */
  applyNative(id: string, patch: BrowserObject): BrowserObject | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.settled) return { ...entry.value };
    const state = String(patch.state ?? patch.status ?? '');
    if (state === 'completed') {
      entry.finish({ ...patch, id: entry.id, status: 'completed', state: 'completed', finishedAt: typeof patch.finishedAt === 'number' ? patch.finishedAt : Date.now() });
      return { ...entry.value };
    }
    if (state === 'failed') {
      entry.value = { ...entry.value, ...patch, id: entry.id };
      entry.finish(new BrowserError('download_failed', typeof patch.error === 'string' ? patch.error : 'Native download failed.'));
      return { ...entry.value };
    }
    if (state === 'canceled') {
      entry.value = { ...entry.value, ...patch, id: entry.id };
      entry.controller.abort(new BrowserError('download_canceled', 'The native download was canceled.'));
      return { ...entry.value };
    }
    if (state !== 'in_progress' && state !== 'paused') return { ...entry.value };
    entry.value = { ...entry.value, ...patch, id: entry.id, status: state, state };
    this.notify('changed', entry);
    return { ...entry.value };
  }

  /**
   * Reopen one native GUID for an explicit resume attempt. This is the only
   * path that may turn a settled native failure back into a live generation;
   * ordinary late snapshots still hit the settled guard in applyNative().
   */
  reopenNative(id: string, patch: BrowserObject): BrowserObject | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (!entry.settled) return { ...entry.value };
    const state = String(entry.value.state ?? entry.value.status ?? '');
    if (state !== 'failed') return { ...entry.value };
    const base: BrowserObject = { ...entry.value };
    delete base.error;
    delete base.finishedAt;
    const controller = new AbortController();
    let resolveResult!: (value: BrowserObject) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<BrowserObject>((resolve, fail) => { resolveResult = resolve; reject = fail; });
    void promise.catch(() => {});
    const next: DownloadEntry = {
      id,
      owner: entry.owner,
      value: { ...base, ...patch, id, status: 'in_progress', state: 'in_progress' },
      controller,
      settled: false,
      promise,
      finish: value => {
        if (next.settled) return;
        next.settled = true;
        if (value instanceof Error) {
          next.value = { ...next.value, status: controller.signal.aborted ? 'canceled' : 'failed', error: message(value), finishedAt: Date.now() };
          reject(value);
        } else {
          next.value = { ...next.value, ...value, id, status: 'completed', state: 'completed', finishedAt: Date.now() };
          resolveResult({ ...next.value });
        }
        this.notify('changed', next);
      },
    };
    controller.signal.addEventListener('abort', () => next.finish(controller.signal.reason instanceof Error ? controller.signal.reason : new BrowserError('download_canceled', 'The download was canceled.')), { once: true });
    this.entries.set(id, next);
    this.notify('changed', next);
    return { ...next.value };
  }

  update(id: string, patch: BrowserObject): BrowserObject | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.value = { ...entry.value, ...patch, id: entry.id };
    this.notify('changed', entry);
    return { ...entry.value };
  }

  setMeta(id: string, patch: BrowserObject): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.meta.set(id, { ...this.meta.get(id), ...patch });
    this.notify('changed', entry);
  }

  cancel(id: string): BrowserObject | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (!entry.settled) entry.controller.abort(new BrowserError('download_canceled', 'The download was canceled.'));
    return { ...entry.value };
  }

  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || !entry.settled) return false;
    this.entries.delete(id);
    this.meta.delete(id);
    return true;
  }

  clearSettled(): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (!entry.settled) continue;
      this.entries.delete(id);
      this.meta.delete(id);
      removed += 1;
    }
    return removed;
  }

  async wait(owner: string, fields: BrowserObject, timeout: number): Promise<BrowserObject> {
    this.active(owner); const until = Date.now() + timeout;
    for (;;) {
      this.active(owner);
      const candidates = this.list(owner).filter(item => fields.downloadId !== undefined ? item.id === String(fields.downloadId) : fields.url ? item.url === fields.url : true);
      if (candidates.length > 1) throw new BrowserError('ambiguous_download', 'Several downloads match this page. Use action:list and an exact downloadId.');
      const found = candidates[0];
      if (found) {
        const entry = this.entries.get(String(found.id))!;
        if (fields.action === 'cancel') { entry.controller.abort(new BrowserError('download_canceled', 'The download was canceled.')); return { ...entry.value }; }
        if (entry.settled) return entry.promise;
      }
      if (fields.downloadId !== undefined && !found) throw new BrowserError('stale_download', 'This downloadId does not belong to the active page.');
      if (Date.now() >= until) throw new BrowserError('timeout', 'No matching download completed before timeout.');
      await new Promise(resolve => setTimeout(resolve,25));
    }
  }

  release(owner: string, keep: ReadonlySet<string> = new Set()): void {
    // Native Profile downloads outlive a tab. Keeping any entry leaves the
    // owner reusable so a later native event can still be recorded.
    if (!keep.size) this.released.add(owner);
    for (const [id,entry] of this.entries) if (entry.owner === owner && !keep.has(id)) {
      if (!entry.settled) entry.controller.abort(new BrowserError('stale_tab', 'The download page was released.'));
      this.entries.delete(id);
      this.meta.delete(id);
    }
  }
  dispose(): void {
    this.closed = true;
    for (const entry of this.entries.values()) if (!entry.settled) entry.controller.abort(new BrowserError('unavailable', 'The browser shut down during the download.'));
    this.entries.clear(); this.meta.clear(); this.released.clear();
  }
}

/**
 * Progress events are coalesced into bounded windows; a terminal event always
 * bypasses the window and replaces any pending progress for that download.
 */
export class DownloadChangeCoalescer {
  private readonly pending = new Map<string, BrowserDownloadChangedEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly emit: (event: BrowserDownloadChangedEvent) => void,
    private readonly intervalMs = 200,
  ) {}

  push(event: BrowserDownloadChangedEvent): void {
    const terminal = event.state === 'completed' || event.state === 'failed' || event.state === 'canceled';
    if (terminal) {
      this.pending.delete(event.id);
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      this.emit(event);
      return;
    }
    this.pending.set(event.id, event);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.size) return;
    const events = [...this.pending.values()];
    this.pending.clear();
    for (const event of events) this.emit(event);
  }

  dispose(): void {
    this.flush();
  }
}
