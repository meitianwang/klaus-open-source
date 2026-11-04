import type { DownloadItem } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
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

export type NativeDownloadState = 'in_progress' | 'paused' | 'completed' | 'failed' | 'canceled';

/** Native Profile download snapshot; ids are stable GUIDs owned by the profile. */
export interface NativeDownloadSnapshot {
  id: string;
  url: string;
  urlChain: string[];
  filename: string;
  path?: string;
  state: NativeDownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  sessionId?: string;
  pageId?: string;
  isActorVisit?: boolean;
  /** Agent/resource gate intent, independent from history attribution. */
  requiresAuthorization?: boolean;
}

/** A native target is paused by the profile until the host authorizes a path. */
export interface NativeDownloadTarget {
  requestId: string;
  id: string;
  url: string;
  urlChain: string[];
  filename: string;
  suggestedPath: string;
  sessionId?: string;
  pageId?: string;
  isActorVisit?: boolean;
  /** Agent/resource gate intent, independent from history attribution. */
  requiresAuthorization?: boolean;
}

export type NativeDownloadAction = 'pause' | 'resume' | 'cancel' | 'remove';

export interface NativeProfileDownloadController {
  downloadAction(id: string, action: NativeDownloadAction): void;
  resolveDownloadTarget(requestId: string, decision: { allow: boolean; path?: string }): void;
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
  /** Profile bridge used by nativeCreated/nativeUpdated/resolveNativeTarget. */
  nativeController?: NativeProfileDownloadController;
  /** Opt in only when the host knows interrupted Electron downloads cannot resume. */
  recoverInterruptedDownloads?: boolean;
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
  private readonly nativeRecords = new Map<string, { owner: string; sessionId: string; source: BrowserVisitSource; requiresAuthorization?: boolean }>();
  private readonly nativeSnapshots = new Map<string, NativeDownloadSnapshot>();
  private readonly pendingTargets = new Map<string, { id: string; owner: string; controller: AbortController; settle(allow: boolean, path?: string): void }>();
  private readonly removedNative = new Set<string>();
  private nativeController: NativeProfileDownloadController | undefined;
  private closed = false;

  constructor(private readonly network: BrowserDownloadNetwork, private readonly options: NativeDownloadOptions) {
    this.nativeController = options.nativeController;
    this.changes = new DownloadChangeCoalescer(event => this.options.changed?.(event));
    this.store = new DownloadStore(() => options.directory(), {
      created: (id, owner, url, value, meta) => {
        const source = meta.source === 'agent' ? 'agent' : 'other';
        const sessionId = typeof meta.sessionId === 'string' && meta.sessionId ? meta.sessionId : owner;
        try {
          const filename = typeof value.filename === 'string' && value.filename ? value.filename : suggestedFilename(url);
          const path = typeof value.path === 'string' && value.path ? value.path : undefined;
          const bytes = typeof value.bytes === 'number' ? value.bytes : 0;
          const totalBytes = typeof value.totalBytes === 'number' ? value.totalBytes : 0;
          const startedAt = typeof value.startedAt === 'number' ? value.startedAt : Date.now();
          const existing = this.options.history.download(id);
          if (existing) {
            this.options.history.updateDownload(id, {
              filename,
              ...(path ? { path } : {}),
              bytes,
              totalBytes,
              status: 'in_progress',
            });
          } else {
            this.options.history.createDownload({
              id, sessionId, url, source, filename,
              ...(path ? { path } : {}),
              bytes, totalBytes, startedAt, status: 'in_progress',
            });
          }
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
    // Native Chrome may recover its own DownloadManager items after restart.
    // Only an explicit host opt-in may rewrite interrupted rows as failed.
    if (options.recoverInterruptedDownloads === true) this.options.history.recoverInterruptedDownloads();
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
      ...(typeof value.canPause === 'boolean' ? { canPause: value.canPause } : {}),
      ...(typeof value.canResume === 'boolean' ? { canResume: value.canResume } : {}),
      ...(typeof value.canCancel === 'boolean' ? { canCancel: value.canCancel } : {}),
      ...(path ? { exists: existsSync(path) } : {}),
    });
  }

  setNativeController(controller: NativeProfileDownloadController | undefined): void {
    this.nativeController = controller;
  }

  private normalizeSnapshot(snapshot: NativeDownloadSnapshot): NativeDownloadSnapshot | null {
    if (this.closed || !snapshot || typeof snapshot.id !== 'string' || !snapshot.id.trim()) return null;
    if (typeof snapshot.url !== 'string' || !snapshot.url) return null;
    if (typeof snapshot.filename !== 'string' || !snapshot.filename) return null;
    if (!['in_progress', 'paused', 'completed', 'failed', 'canceled'].includes(snapshot.state)) return null;
    let filename: string;
    try { filename = downloadFilename(snapshot.filename); } catch { filename = suggestedFilename(snapshot.url); }
    const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
    const chain = Array.isArray(snapshot.urlChain) ? snapshot.urlChain.filter((url): url is string => typeof url === 'string' && url.length > 0) : [];
    return {
      id: snapshot.id,
      url: snapshot.url,
      urlChain: [...new Set([...chain, snapshot.url])],
      filename,
      ...(typeof snapshot.path === 'string' && snapshot.path ? { path: snapshot.path } : {}),
      state: snapshot.state,
      receivedBytes: number(snapshot.receivedBytes),
      totalBytes: number(snapshot.totalBytes),
      startedAt: typeof snapshot.startedAt === 'number' && Number.isFinite(snapshot.startedAt) && snapshot.startedAt >= 0 ? Math.trunc(snapshot.startedAt) : Date.now(),
      canPause: snapshot.canPause === true,
      canResume: snapshot.canResume === true,
      canCancel: snapshot.canCancel === true,
      ...(typeof snapshot.sessionId === 'string' && snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
      ...(typeof snapshot.pageId === 'string' && snapshot.pageId ? { pageId: snapshot.pageId } : {}),
      ...(typeof snapshot.isActorVisit === 'boolean' ? { isActorVisit: snapshot.isActorVisit } : {}),
      ...(typeof snapshot.requiresAuthorization === 'boolean' ? { requiresAuthorization: snapshot.requiresAuthorization } : {}),
    };
  }

  /** Accept a native Profile-created download snapshot. */
  nativeCreated(snapshot: NativeDownloadSnapshot): void {
    const normalized = this.normalizeSnapshot(snapshot);
    if (!normalized || this.removedNative.has(normalized.id)) return;
    const existingRecord = this.nativeRecords.get(normalized.id);
    const storeOwner = this.store.ownerOf(normalized.id);
    const owner = existingRecord?.owner ?? storeOwner ?? normalized.pageId ?? normalized.sessionId ?? `native:${normalized.id}`;
    const sessionId = existingRecord?.sessionId ?? normalized.sessionId ?? owner;
    const source = existingRecord?.source ?? (normalized.isActorVisit === true ? 'agent' : 'other');
    const requiresAuthorization = normalized.requiresAuthorization ?? existingRecord?.requiresAuthorization ?? normalized.isActorVisit;
    this.nativeRecords.set(normalized.id, { owner, sessionId, source, ...(requiresAuthorization === undefined ? {} : { requiresAuthorization }) });
    this.nativeSnapshots.set(normalized.id, normalized);
    if (!this.store.has(normalized.id)) {
      this.store.create(owner, normalized.url, {
        url: normalized.url,
        urlChain: normalized.urlChain,
        filename: normalized.filename,
        ...(normalized.path ? { path: normalized.path } : {}),
        status: 'in_progress',
        state: 'in_progress',
        startedAt: normalized.startedAt,
        bytes: normalized.receivedBytes,
        totalBytes: normalized.totalBytes,
        canPause: normalized.canPause,
        canResume: normalized.canResume,
        canCancel: normalized.canCancel,
      }, { sessionId, source, pageId: normalized.pageId ?? owner }, normalized.id);
    }
    this.nativeUpdated(normalized);
  }

  /** Accept a native Profile snapshot update without duplicating created writes. */
  nativeUpdated(snapshot: NativeDownloadSnapshot): void {
    const normalized = this.normalizeSnapshot(snapshot);
    if (!normalized || this.removedNative.has(normalized.id)) return;
    if (!this.nativeRecords.has(normalized.id) || !this.store.has(normalized.id)) {
      this.nativeCreated(normalized);
      return;
    }
    this.nativeSnapshots.set(normalized.id, normalized);
    const record = this.nativeRecords.get(normalized.id);
    if (record) {
      const requiresAuthorization = normalized.requiresAuthorization ?? record.requiresAuthorization ?? normalized.isActorVisit;
      record.requiresAuthorization = requiresAuthorization;
    }
    this.store.applyNative(normalized.id, {
      url: normalized.url,
      urlChain: normalized.urlChain,
      filename: normalized.filename,
      ...(normalized.path ? { path: normalized.path } : {}),
      status: normalized.state,
      state: normalized.state,
      bytes: normalized.receivedBytes,
      totalBytes: normalized.totalBytes,
      startedAt: normalized.startedAt,
      canPause: normalized.canPause,
      canResume: normalized.canResume,
      canCancel: normalized.canCancel,
    });
  }

  /** Reconcile a Profile removal without echoing a native remove action. */
  nativeRemoved(id: string): void {
    const normalized = typeof id === 'string' ? id.trim() : '';
    if (!normalized || this.removedNative.has(normalized)) return;
    this.removedNative.add(normalized);
    this.cancelNativeTargets({ id: normalized });
    if (this.store.has(normalized)) {
      if (!this.store.settled(normalized)) this.store.cancel(normalized);
      this.store.remove(normalized);
    }
    this.options.history.removeDownload(normalized);
    this.nativeRecords.delete(normalized);
    this.nativeSnapshots.delete(normalized);
  }

  /**
   * Authorize and choose a path for a native Profile target. The native side
   * owns the original request and bytes; this method only resolves the paused
   * target with allow/path or allow:false.
   */
  async resolveNativeTarget(target: NativeDownloadTarget): Promise<void> {
    const requestId = target && typeof target.requestId === 'string' ? target.requestId : '';
    const id = target && typeof target.id === 'string' ? target.id : '';
    const controller = this.nativeController;
    if (!requestId) return;
    if (!controller) throw new BrowserError('unavailable', 'The native profile download controller is not attached.');
    if (this.closed) { controller.resolveDownloadTarget(requestId, { allow: false }); return; }
    if (!id || typeof target.url !== 'string' || !target.url) { controller.resolveDownloadTarget(requestId, { allow: false }); return; }
    if (this.pendingTargets.has(requestId)) return;
    const existing = this.nativeRecords.get(id);
    const owner = existing?.owner ?? target.pageId ?? target.sessionId ?? `native:${id}`;
    const sessionId = existing?.sessionId ?? target.sessionId ?? owner;
    const source = existing?.source ?? (target.isActorVisit === true ? 'agent' : 'other');
    const requiresAuthorization = target.requiresAuthorization ?? existing?.requiresAuthorization ?? target.isActorVisit;
    this.nativeRecords.set(id, { owner, sessionId, source, ...(requiresAuthorization === undefined ? {} : { requiresAuthorization }) });
    const abort = new AbortController();
    let settled = false;
    const settle = (allow: boolean, path?: string): void => {
      if (settled) return;
      settled = true;
      this.pendingTargets.delete(requestId);
      try { controller.resolveDownloadTarget(requestId, { allow, ...(path ? { path } : {}) }); } catch { /* profile closed */ }
    };
    this.pendingTargets.set(requestId, { id, owner, controller: abort, settle });
    try {
      const actor = requiresAuthorization === true;
      if (actor) {
        const chain = [...new Set([target.urlChain?.[0] ?? target.url, ...(Array.isArray(target.urlChain) ? target.urlChain : []), target.url].filter((url): url is string => typeof url === 'string' && /^https?:/u.test(url)))];
        for (const url of chain) {
          await this.options.authorize?.(sessionId, url, 'downloads', abort.signal);
          abort.signal.throwIfAborted();
        }
      } else {
        this.options.assertUrl(target.url);
        for (const url of Array.isArray(target.urlChain) ? target.urlChain : []) this.options.assertUrl(url);
        abort.signal.throwIfAborted();
      }
      const directory = this.options.directory();
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const filename = downloadFilename(target.filename, suggestedFilename(target.url));
      const suggested = typeof target.suggestedPath === 'string' && isAbsolute(target.suggestedPath)
        ? target.suggestedPath
        : undefined;
      const manual = requiresAuthorization !== true && target.isActorVisit !== true;
      const prompt = manual && this.options.promptForUserDownloads?.() === true && !!this.options.chooseDownloadPath;
      let path: string;
      if (prompt) {
        const chosen = await withAbort(Promise.resolve(this.options.chooseDownloadPath!({ defaultPath: suggested ?? join(directory, filename), filename, url: target.url })), abort.signal);
        if (!chosen || !isAbsolute(chosen)) { settle(false); return; }
        path = chosen;
      } else {
        path = suggested ?? uniqueDownloadPath(directory, filename);
      }
      mkdirSync(dirname(path), { recursive: true });
      abort.signal.throwIfAborted();
      settle(true, path);
    } catch {
      settle(false);
    } finally {
      if (!settled) settle(false);
    }
  }

  private nativeAction(id: string, action: NativeDownloadAction): void {
    if (!this.nativeController) throw new BrowserError('unavailable', 'The native profile download controller is not attached.');
    const snapshot = this.nativeSnapshots.get(id);
    if (action === 'pause' && snapshot && !snapshot.canPause) throw new BrowserError('unavailable', 'This native download cannot be paused.');
    if (action === 'resume' && snapshot && !snapshot.canResume) throw new BrowserError('unavailable', 'This native download cannot be resumed.');
    if (action === 'cancel' && snapshot && !snapshot.canCancel) throw new BrowserError('unavailable', 'This native download cannot be canceled.');
    this.nativeController.downloadAction(id, action);
  }

  private cancelNativeTargets(filter: { owner?: string; id?: string } = {}): void {
    for (const pending of [...this.pendingTargets.values()]) {
      if (filter.owner && pending.owner !== filter.owner) continue;
      if (filter.id && pending.id !== filter.id) continue;
      pending.controller.abort(new BrowserError('download_canceled', 'The native download target was canceled.'));
      pending.settle(false);
    }
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
      if (source === 'agent') {
        const chain = [...new Set([initiatorUrl, ...item.getURLChain(), item.getURL()].filter((url): url is string => typeof url === 'string' && /^https?:/u.test(url)))];
        for (const url of chain) {
          await this.options.authorize?.(sessionId, url, 'downloads', signal);
          signal?.throwIfAborted();
        }
      } else {
        this.options.assertUrl(item.getURL());
        if (initiatorUrl) this.options.assertUrl(initiatorUrl);
        signal?.throwIfAborted();
      }
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
          ...this.capabilities(entry.id, entry.state),
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  pause(id: string): BrowserObject {
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (this.nativeRecords.has(id)) {
      if (entry.state !== 'in_progress') throw new BrowserError('unavailable', 'Only an active download can be paused.');
      this.nativeAction(id, 'pause');
      return this.entry(id);
    }
    const item = this.items.get(id);
    if (!item || entry.state !== 'in_progress') throw new BrowserError('unavailable', 'Only an active download can be paused.');
    if (!item.isPaused()) item.pause();
    this.store.update(id, { status: 'paused' });
    return this.entry(id);
  }

  resume(id: string): BrowserObject {
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (this.nativeRecords.has(id)) {
      const snapshot = this.nativeSnapshots.get(id);
      const resumable = entry.state === 'paused' || (entry.state === 'failed' && snapshot?.canResume === true);
      if (!resumable) throw new BrowserError('unavailable', 'This download cannot be resumed.');
      if (entry.state === 'failed') {
        const reopened = this.store.reopenNative(id, {
          status: 'in_progress',
          state: 'in_progress',
          canPause: snapshot?.canPause === true,
          canResume: true,
          canCancel: snapshot?.canCancel === true,
        });
        if (!reopened) throw new BrowserError('unavailable', 'This download cannot be resumed.');
        this.options.history.updateDownload(id, { status: 'in_progress', error: '' });
      }
      try { this.nativeAction(id, 'resume'); }
      catch (error) {
        this.store.applyNative(id, { status: 'failed', state: 'failed', error: error instanceof Error ? error.message : String(error), canResume: true });
        throw error;
      }
      if (entry.state === 'paused') {
        this.store.update(id, { status: 'in_progress', state: 'in_progress' });
        this.options.history.updateDownload(id, { status: 'in_progress', error: '' });
      }
      return this.entry(id);
    }
    const item = this.items.get(id);
    if (!item || !item.canResume()) throw new BrowserError('unavailable', 'This download cannot be resumed.');
    item.resume();
    this.store.update(id, { status: 'in_progress' });
    return this.entry(id);
  }

  cancel(id: string): BrowserObject {
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (this.nativeRecords.has(id)) {
      const snapshot = this.nativeSnapshots.get(id);
      const canCancel = entry.state === 'in_progress'
        || entry.state === 'paused'
        || (entry.state === 'failed' && snapshot?.canCancel === true);
      if (!canCancel) throw new BrowserError('unavailable', 'This download cannot be canceled.');
      this.cancelNativeTargets({ id });
      this.nativeAction(id, 'cancel');
      if (entry.state === 'failed') {
        this.store.update(id, { status: 'canceled', state: 'canceled', canPause: false, canResume: false, canCancel: false });
        this.options.history.updateDownload(id, { status: 'canceled', error: '', finishedAt: Date.now() });
      } else {
        this.store.cancel(id);
      }
      return this.entry(id);
    }
    if (entry.state !== 'in_progress' && entry.state !== 'paused') throw new BrowserError('unavailable', 'Only an active download can be canceled.');
    const item = this.items.get(id);
    try { item?.cancel(); } catch { /* The item may have reached a terminal state. */ }
    this.store.cancel(id);
    return { ...entry, state: 'canceled' };
  }

  remove(id: string): BrowserObject {
    const entry = this.options.history.download(id);
    if (!entry) throw new BrowserError('not_found', 'The download does not exist.');
    if (entry.state === 'in_progress' || entry.state === 'paused') throw new BrowserError('invalid_request', 'An active download cannot be removed from history.');
    if (this.nativeRecords.has(id)) {
      this.nativeAction(id, 'remove');
      this.options.history.removeDownload(id);
      this.store.remove(id);
      this.nativeRecords.delete(id);
      this.nativeSnapshots.delete(id);
      this.removedNative.add(id);
      return { removed: true };
    }
    this.options.history.removeDownload(id);
    this.store.remove(id);
    return { removed: true };
  }

  clearTerminal(): { removed: number; memoryRemoved: number } {
    const terminal = [...this.nativeSnapshots].filter(([, snapshot]) =>
      snapshot.state === 'completed' || snapshot.state === 'failed' || snapshot.state === 'canceled').map(([id]) => id);
    const removed = this.options.history.clearTerminalDownloads().removed;
    const memoryRemoved = this.store.clearSettled();
    for (const id of terminal) {
      this.nativeRecords.delete(id);
      this.nativeSnapshots.delete(id);
      this.removedNative.add(id);
    }
    return { removed, memoryRemoved };
  }

  record(id: string): BrowserDownloadEntry | undefined {
    return this.options.history.download(id);
  }

  private capabilities(id: string, state: BrowserDownloadEntry['state']): { canPause: boolean; canResume: boolean; canCancel: boolean } {
    const native = this.nativeSnapshots.get(id);
    if (native) {
      return {
        canPause: state === 'in_progress' && native.canPause,
        canResume: (state === 'paused' || state === 'failed') && native.canResume,
        canCancel: (state === 'in_progress' || state === 'paused' || state === 'failed') && native.canCancel,
      };
    }
    const item = this.items.get(id);
    const live = this.store.get(id);
    return {
      canPause: state === 'in_progress' && !!item,
      canResume: state === 'paused' && item?.canResume() === true,
      canCancel: (state === 'in_progress' || state === 'paused') && (!!item || live !== undefined),
    };
  }

  private entry(id: string): BrowserObject {
    const record = this.options.history.download(id);
    if (!record) return {};
    return { ...record, ...this.capabilities(record.id, record.state) };
  }

  release(owner: string): void {
    const keep = new Set([...this.nativeRecords].filter(([, record]) => record.owner === owner).map(([id]) => id));
    this.cancelNativeTargets({ owner });
    for (const [id, item] of this.items) {
      if (this.itemMeta.get(id)?.owner !== owner) continue;
      try { if (item.getState() === 'progressing') item.cancel(); } catch { /* already terminal */ }
      this.items.delete(id); this.itemMeta.delete(id);
    }
    this.store.release(owner, keep);
  }

  dispose(): void {
    this.closed = true;
    this.cancelNativeTargets();
    for (const item of this.items.values()) {
      try { if (item.getState() === 'progressing') item.cancel(); } catch { /* already terminal */ }
    }
    this.items.clear(); this.itemMeta.clear();
    this.nativeRecords.clear(); this.nativeSnapshots.clear(); this.pendingTargets.clear(); this.removedNative.clear();
    this.changes.dispose();
    this.store.dispose();
  }
}
