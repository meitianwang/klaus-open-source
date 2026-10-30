import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { BrowserError, message, type BrowserObject } from './types';

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

export async function saveDownload(directory: string, id: string, filename: string, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<BrowserObject> {
  const folder = join(directory, id); const path = join(folder, downloadFilename(filename)); const partial = join(folder, '.partial');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = await open(partial, 'wx', 0o600); let bytes = 0; let completed = false;
  try {
    for await (const chunk of chunks) { aborted(signal); await file.writeFile(chunk); bytes += chunk.byteLength; }
    aborted(signal); await file.close(); await rename(partial, path); aborted(signal); completed = true;
    return { path, filePath: path, filename, bytes };
  } finally { await file.close().catch(() => {}); if (!completed) await rm(folder, { recursive: true, force: true }); }
}

interface DownloadEntry {
  id: string; owner: string; value: BrowserObject; controller: AbortController;
  settled: boolean; promise: Promise<BrowserObject>; finish(value: BrowserObject | Error): void;
}

/** The owner includes the exact page identity. URL matching never crosses it. */
export class DownloadStore {
  private readonly entries = new Map<string, DownloadEntry>();
  private readonly released = new Set<string>();
  private closed = false;
  constructor(readonly directory: string) {}

  private active(owner: string): void { if (this.closed || this.released.has(owner)) throw new BrowserError('stale_tab', 'The download page was released.'); }

  create(owner: string, url: string): DownloadEntry {
    this.active(owner);
    if ([...this.entries.values()].filter(entry => entry.owner === owner).length >= 100) throw new BrowserError('download_limit', 'This page reached its 100 download handle limit. Open another tab to continue.');
    const id = randomUUID(); const controller = new AbortController();
    let resolveResult!: (value: BrowserObject) => void; let reject!: (error: Error) => void;
    const promise = new Promise<BrowserObject>((resolve, fail) => { resolveResult = resolve; reject = fail; });
    // User clicks may complete or fail before a tool starts waiting for them.
    void promise.catch(() => {});
    const entry: DownloadEntry = { id, owner, value: { id, url, status: 'in_progress', startedAt: Date.now() }, controller, settled: false, promise, finish: value => {
      if (entry.settled) return; entry.settled = true;
      if (value instanceof Error) { entry.value = { ...entry.value, status: controller.signal.aborted ? 'canceled' : 'failed', error: message(value) }; reject(value); }
      else { entry.value = { ...entry.value, ...value, id, status: 'completed', state: 'completed' }; resolveResult({ ...entry.value }); }
    } };
    controller.signal.addEventListener('abort', () => entry.finish(controller.signal.reason instanceof Error ? controller.signal.reason : new BrowserError('download_canceled', 'The download was canceled.')), { once: true });
    this.entries.set(id, entry); return entry;
  }

  async run(owner: string, url: string, timeout: number, work: (id: string, signal: AbortSignal) => Promise<BrowserObject>): Promise<BrowserObject> {
    const entry = this.create(owner,url);
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
    finally { clearTimeout(timer); }
    return entry.promise;
  }

  list(owner: string): BrowserObject[] { this.active(owner); return [...this.entries.values()].filter(entry => entry.owner === owner).map(entry => ({ ...entry.value })); }

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

  release(owner: string): void {
    this.released.add(owner);
    for (const [id,entry] of this.entries) if (entry.owner === owner) { if (!entry.settled) entry.controller.abort(new BrowserError('stale_tab', 'The download page was released.')); this.entries.delete(id); }
  }
  dispose(): void { this.closed = true; for (const entry of this.entries.values()) if (!entry.settled) entry.controller.abort(new BrowserError('unavailable', 'The browser shut down during the download.')); this.entries.clear(); this.released.clear(); }
}
