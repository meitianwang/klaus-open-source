import type { DownloadItem } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { DownloadChangeCoalescer, DownloadStore, aborted, downloadFilename, saveDownload, suggestedFilename, withAbort } from './downloads';
import { downloadPageMedia, namesMedia } from './page-download';
import { BrowserError, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';
import type { BrowserDataStore } from './history-store';
import type { BrowserDownloadChangedEvent, BrowserDownloadEntry, BrowserDownloadQuery, BrowserVisitSource } from '../../contracts/browser-history';

export type NativeDownloadAuthorize = (
  sessionId: string,
  url: string,
  resource: 'downloads' | 'uploads',
  signal?: AbortSignal,
) => Promise<void> | void;

/**
 * The network surface NativeDownloads needs. Electron's Session.fetch is
 * source-compatible, and a native profile adapter can implement the same
 * narrow contract without pretending to be an Electron Session.
 */
export interface BrowserDownloadNetwork {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface NativeDownloadOptions {
  /** Resolved when a download starts so a changed preference applies immediately. */
  directory(): string;
  assertUrl(url: unknown): string;
  history: BrowserDataStore;
  promptForUserDownloads?(): boolean;
  chooseDownloadPath?(request: { defaultPath: string; filename: string; url: string }): Promise<string | null | undefined>;
  authorize?: NativeDownloadAuthorize;
  changed?(event: BrowserDownloadChangedEvent): void;
}

interface NativeItemMeta {
  owner: string;
  sessionId: string;
  source: BrowserVisitSource;
}

const PROGRESS_WRITE_INTERVAL_MS = 1_000;

function statusOf(value: BrowserObject): string {
  return typeof value.status === 'string' ? value.status : 'failed';
}

function safeSuffix(filename: string, index: number): string {
  if (!index) return filename;
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem} (${index})${extension}`;
}

/** Never overwrite a file that a previous download left in the chosen folder. */
export function uniqueDownloadPath(directory: string, filename: string): string {
  const safe = downloadFilename(filename);
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = join(directory, safeSuffix(safe, index));
    if (!existsSync(candidate)) return candidate;
  }
  throw new BrowserError('download_limit', 'The download folder already contains too many files with this name.');
}

/** Electron supplies the exact WebContents for human and page downloads. */
export class NativeDownloads {
  readonly store: DownloadStore;
  private readonly items = new Map<string, DownloadItem>();
  private readonly itemMeta = new Map<string, NativeItemMeta>();
  private readonly changes: DownloadChangeCoalescer;
  private closed = false;

  constructor(private readonly network: BrowserDownloadNetwork, private readonly options: NativeDownloadOptions) {
    this.changes = new DownloadChangeCoalescer(event => this.options.changed?.(event));
    this.store = new DownloadStore(() => options.directory(), {
      created: (id, owner, url, value, meta) => {
        const source = meta.source === 'agent' ? 'agent' : 'other';
        const sessionId = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : owner;
        try {
          this.options.history.createDownload({
            id, sessionId, url, source,
            filename: typeof value.filename === 'string' && value.filename ? value.filename : suggestedFilename(url),
            ...(typeof value.path === 'string' && value.path ? { path: value.path } : {}),
            bytes: typeof value.bytes === 'number' ? value.bytes : 0,
            startedAt: typeof value.startedAt === 'number' ? value.startedAt : Date.now(),
            status: 'in_progress',
          });
        } finally {
          this.publishChange(url, value, meta);
        }
      },
      changed: (id, _owner, url, value, meta) => {
        const status = statusOf(value) as BrowserDownloadEntry['state'];
        const finished = status === 'completed' || status === 'failed' || status === 'canceled';
        try {
          this.options.history.updateDownload(id, {
            ...(typeof value.filename === 'string' && value.filename ? { filename: value.filename } : {}),
            ...(typeof value.path === 'string' && value.path ? { path: value.path } : {}),
            ...(typeof value.bytes === 'number' ? { bytes: value.bytes } : {}),
            ...(status === 'in_progress' || status === 'paused' || finished ? { status } : {}),
            ...(finished ? { finishedAt: typeof value.finishedAt === 'number' ? value.finishedAt : Date.now() } : {}),
            ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
          });
        } finally {
          this.publishChange(url, value, meta);
        }
      },
    });
    // A process restart cannot resume Chromium downloads from a previous
    // process, so those rows remain inspectable but no longer look live.
    this.options.history.recoverInterruptedDownloads();
  }

  private publishChange(url: string, value: BrowserObject, meta: BrowserObject): void {
    const path = typeof value.path === 'string' && value.path ? value.path : undefined;
    this.changes.push({
      id: String(value.id ?? ''),
      sessionId: typeof meta.sessionId === 'string' ? meta.sessionId : '',
      url,
      filename: typeof value.filename === 'string' ? value.filename : suggestedFilename(url),
      ...(path ? { path } : {}),
      state: statusOf(value) as BrowserDownloadEntry['state'],
      receivedBytes: typeof value.bytes === 'number' ? value.bytes : 0,
      totalBytes: typeof value.totalBytes === 'number' ? value.totalBytes : 0,
      ...(path ? { exists: existsSync(path) } : {}),
    });
  }

  /**
   * Adopt a user/page download that Electron created. The item is paused while
   * access and the optional save location are decided, so bytes cannot race the
   * decision or land in an unintended file.
   */
  async accept(
    owner: string,
    sessionId: string,
    item: DownloadItem,
    source: BrowserVisitSource,
    initiatorUrl: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed) { item.cancel(); return; }
    try { item.pause(); } catch { /* A zero-byte download may already be past pausing. */ }
    signal?.throwIfAborted();
    try {
      await this.options.authorize?.(sessionId, initiatorUrl, 'downloads', signal);
      signal?.throwIfAborted();
    } catch {
      try { item.cancel(); } catch { /* already terminal */ }
      return;
    }
    const filename = suggestedFilename(item.getURL(), `filename*=UTF-8''${encodeURIComponent(item.getFilename())}`);
    const directory = this.options.directory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = this.store.create(owner, item.getURL(), { filename, startedAt: Date.now() }, { sessionId, source, filename });
    this.items.set(entry.id, item);
    this.itemMeta.set(entry.id, { owner, sessionId, source });
    const cancelForSignal = (): void => {
      try { item.cancel(); } catch { /* already terminal */ }
      this.store.cancel(entry.id);
    };
    if (signal?.aborted) { cancelForSignal(); return; }
    signal?.addEventListener('abort', cancelForSignal, { once: true });
    let path = '';
    try {
      const prompt = source === 'other' && this.options.promptForUserDownloads?.() === true && !!this.options.chooseDownloadPath;
      if (prompt) {
        const chosen = await this.options.chooseDownloadPath?.({ defaultPath: join(directory, filename), filename, url: item.getURL() });
        if (!chosen) {
          signal?.removeEventListener('abort', cancelForSignal);
          item.cancel(); this.store.cancel(entry.id); return;
        }
        path = chosen;
        mkdirSync(dirname(path), { recursive: true });
      } else {
        path = uniqueDownloadPath(directory, filename);
      }
      const existed = existsSync(path);
      this.store.update(entry.id, { path, filename, status: 'in_progress' });
      item.setSavePath(path);
      let lastWrite = 0;
      item.on('updated', () => {
        const now = Date.now();
        if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
        lastWrite = now;
        this.store.update(entry.id, { bytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() });
      });
      item.once('done', (_event, state) => {
        signal?.removeEventListener('abort', cancelForSignal);
        this.items.delete(entry.id);
        this.itemMeta.delete(entry.id);
        const bytes = item.getReceivedBytes();
        if (state === 'completed') {
          entry.finish({ path, filePath: path, filename, bytes, totalBytes: item.getTotalBytes(), url: item.getURL(), via: 'native-download' });
          return;
        }
        if (!existed) void rm(path, { force: true }).catch(() => {});
        if (state === 'cancelled') {
          this.store.cancel(entry.id);
          return;
        }
        entry.finish(new BrowserError('download_failed', `Download ${state}.`));
      });
      item.resume();
    } catch (error) {
      this.items.delete(entry.id);
      this.itemMeta.delete(entry.id);
      item.cancel();
      this.store.cancel(entry.id);
      throw error;
    }
  }

  async download(
    owner: string,
    sessionId: string,
    cdp: BrowserCdp,
    fields: BrowserObject,
    timeout: number,
    signal?: AbortSignal,
    initiatorUrl?: string,
  ): Promise<BrowserObject> {
    const action = fields.action ?? 'download';
    if (!['download', 'wait', 'list', 'cancel'].includes(String(action))) throw new BrowserError('invalid_request', 'Download action must be download, wait, list or cancel.');
    if (action === 'list') return { downloads: this.store.list(owner) };
    if (action === 'cancel' || action === 'wait' || fields.waitOnly === true || fields.downloadId !== undefined || !fields.url && !namesMedia(fields)) return this.store.wait(owner, fields, timeout);
    if (fields.filename !== undefined || fields.saveAs !== undefined) downloadFilename(fields.filename ?? fields.saveAs);
    const meta = { sessionId, source: 'agent' };
    const authorizeInitiator = async (pageSignal: AbortSignal): Promise<void> => {
      const url = initiatorUrl || String(fields.url ?? '');
      if (/^https?:/u.test(url)) await this.options.authorize?.(sessionId, url, 'downloads', pageSignal);
      pageSignal.throwIfAborted();
    };
    const authorizeTarget = async (target: string, pageSignal: AbortSignal): Promise<void> => {
      if (/^https?:/u.test(target)) await this.options.authorize?.(sessionId, target, 'downloads', pageSignal);
      pageSignal.throwIfAborted();
    };
    if (namesMedia(fields)) {
      const fallback = suggestedFilename(String(fields.url ?? ''), '');
      return this.store.run(owner, String(fields.url ?? ''), timeout, async (id, pageSignal) => {
        await authorizeInitiator(pageSignal);
        return downloadPageMedia(cdp, fields, this.store.directory, id, pageSignal, this.options.assertUrl, authorizeTarget);
      }, meta, signal)
        .then(result => {
          if (typeof result.path === 'string') this.store.update(String(result.id), { path: result.path, filename: typeof result.filename === 'string' ? result.filename : fallback });
          return result;
        });
    }
    const url = this.options.assertUrl(fields.url);
    if (!/^https?:/u.test(url)) throw new BrowserError('invalid_request', 'A direct download requires an HTTP or HTTPS URL.');
    return this.store.run(owner, url, timeout, async (id, pageSignal) => {
      let current = url;
      await authorizeInitiator(pageSignal);
      for (let redirect = 0; redirect <= 10; redirect += 1) {
        aborted(pageSignal);
        await authorizeTarget(current, pageSignal);
        aborted(pageSignal);
        const response = await this.network.fetch(current, { credentials: 'include', redirect: 'manual', signal: pageSignal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirect === 10) throw new BrowserError('download_failed', 'Download redirect limit or missing Location.');
          current = this.options.assertUrl(new URL(location, current).href);
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new BrowserError('download_failed', `Download returned HTTP ${response.status}.`); }
        const reader = response.body?.getReader();
        if (!reader) throw new BrowserError('download_failed', 'The download returned no readable body.');
        async function* chunks(): AsyncGenerator<Uint8Array> {
          try { for (;;) { const next = await withAbort(reader!.read(), pageSignal); if (next.done) break; yield next.value; } }
          finally { await reader!.cancel().catch(() => {}); }
        }
        const filename = downloadFilename(fields.filename ?? fields.saveAs, suggestedFilename(current, response.headers.get('content-disposition')));
        this.store.update(id, { filename });
        let lastWrite = 0;
        const saved = await saveDownload(this.store.directory, id, filename, chunks(), pageSignal, bytes => {
          const now = Date.now();
          if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
          lastWrite = now;
          this.store.update(id, { bytes });
        });
        this.store.update(id, { filename, path: String(saved.path ?? ''), bytes: Number(saved.bytes ?? 0) });
        return { ...saved, url: current, via: 'session-fetch' };
      }
      throw new BrowserError('download_failed', 'Download redirect limit.');
    }, meta, signal);
  }

  history(query: BrowserDownloadQuery = {}): BrowserObject {
    const page = this.options.history.downloadHistory(query);
    return {
      items: page.items.map(entry => {
        const live = this.store.get(entry.id);
        return {
          ...entry,
          ...(live ? {
            receivedBytes: typeof live.bytes === 'number' ? live.bytes : entry.receivedBytes,
            ...(typeof live.totalBytes === 'number' && live.totalBytes > 0 ? { totalBytes: live.totalBytes } : {}),
          } : {}),
          canPause: entry.state === 'in_progress' && this.items.has(entry.id),
          canResume: entry.state === 'paused' && this.items.has(entry.id) && this.items.get(entry.id)?.canResume() === true,
          canCancel: (entry.state === 'in_progress' || entry.state === 'paused') && (this.items.has(entry.id) || live !== undefined),
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  pause(id: string): BrowserObject {
    const item = this.items.get(id);
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (!item || entry.state !== 'in_progress') throw new BrowserError('unavailable', 'Only an active download can be paused.');
    if (!item.isPaused()) item.pause();
    this.store.update(id, { status: 'paused' });
    return this.entry(id);
  }

  resume(id: string): BrowserObject {
    const item = this.items.get(id);
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (!item || !item.canResume()) throw new BrowserError('unavailable', 'This download cannot be resumed.');
    item.resume();
    this.store.update(id, { status: 'in_progress' });
    return this.entry(id);
  }

  cancel(id: string): BrowserObject {
    const item = this.items.get(id);
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (entry.state !== 'in_progress' && entry.state !== 'paused') throw new BrowserError('unavailable', 'Only an active download can be canceled.');
    try { item?.cancel(); } catch { /* The item may have reached a terminal state. */ }
    this.store.cancel(id);
    return { ...entry, state: 'canceled' };
  }

  remove(id: string): BrowserObject {
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (entry.state === 'in_progress' || entry.state === 'paused') throw new BrowserError('invalid_request', 'An active download cannot be removed from history.');
    this.options.history.removeDownload(id);
    this.store.remove(id);
    return { removed: true };
  }

  clearTerminal(): { removed: number; memoryRemoved: number } {
    const removed = this.options.history.clearTerminalDownloads().removed;
    return { removed, memoryRemoved: this.store.clearSettled() };
  }

  record(id: string): BrowserDownloadEntry | undefined {
    return this.options.history.download(id);
  }

  private entry(id: string): BrowserObject {
    const record = this.options.history.download(id);
    if (!record) return {};
    return {
      ...record,
      canPause: record.state === 'in_progress' && this.items.has(record.id),
      canResume: record.state === 'paused' && this.items.get(record.id)?.canResume() === true,
      canCancel: (record.state === 'in_progress' || record.state === 'paused')
        && (this.items.has(record.id) || this.store.get(record.id) !== undefined),
    };
  }

  release(owner: string): void {
    for (const [id, item] of this.items) {
      if (this.itemMeta.get(id)?.owner !== owner) continue;
      try { if (item.getState() === 'progressing') item.cancel(); } catch { /* already terminal */ }
      this.items.delete(id); this.itemMeta.delete(id);
    }
    this.store.release(owner);
  }

  dispose(): void {
    this.closed = true;
    for (const item of this.items.values()) {
      try { if (item.getState() === 'progressing') item.cancel(); } catch { /* already terminal */ }
    }
    this.items.clear(); this.itemMeta.clear();
    this.changes.dispose();
    this.store.dispose();
  }
}
