import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserVisitSource } from '../../contracts/browser-history';

export type NativeNavigationOrigin = BrowserVisitSource;

/** The CDP surface the native navigation gate needs. PageDebugger satisfies it. */
export interface NativeNavigationCdp {
  command(method: string, params?: BrowserObject, frame?: string): Promise<BrowserObject>;
  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void;
  ownedFrameTargets?(): string[];
}

export interface NativeNavigationLease {
  readonly sessionId: string;
  readonly pageHandle: number;
  readonly source: NativeNavigationOrigin;
  readonly requiresAuthorization?: boolean;
  readonly signal: AbortSignal;
  release(): void;
}

export interface NativeNavigationLeaseSource {
  current(sessionId: string, pageHandle: number): NativeNavigationLease | undefined;
}

interface LeaseRecord {
  lease: NativeNavigationLease;
  parent?: AbortSignal;
  onParentAbort?: () => void;
}

function validPageHandle(pageHandle: number): boolean {
  return Number.isSafeInteger(pageHandle) && pageHandle > 0;
}

function leaseKey(sessionId: string, pageHandle: number): string {
  return `${sessionId}\u0000${pageHandle}`;
}

/**
 * Stacked operation leases scoped to one session and one page handle. The
 * newest lease is the operation source; releasing it reveals the previous
 * lease. A lease for a sibling tab in the same conversation never applies.
 */
export class NativeNavigationLeases implements NativeNavigationLeaseSource {
  private readonly stacks = new Map<string, LeaseRecord[]>();

  begin(
    sessionId: string,
    pageHandle: number,
    source: NativeNavigationOrigin,
    signal?: AbortSignal,
    requiresAuthorization = source === 'agent',
  ): NativeNavigationLease {
    if (!sessionId) throw new BrowserError('invalid_request', 'A browser session id is required.');
    if (!validPageHandle(pageHandle)) throw new BrowserError('invalid_request', 'pageHandle must be a positive integer.');
    if (signal?.aborted) throw new BrowserError('cancelled', 'The navigation lease was cancelled.');
    const controller = new AbortController();
    let record: LeaseRecord | undefined;
    let released = false;
    const remove = (): void => {
      if (released) return;
      released = true;
      if (record?.onParentAbort) signal?.removeEventListener('abort', record.onParentAbort);
      const stack = this.stacks.get(leaseKey(sessionId, pageHandle));
      if (!stack || !record) return;
      const index = stack.indexOf(record);
      if (index >= 0) stack.splice(index, 1);
      if (!stack.length) this.stacks.delete(leaseKey(sessionId, pageHandle));
    };
    const lease: NativeNavigationLease = {
      sessionId,
      pageHandle,
      source, requiresAuthorization,
      signal: controller.signal,
      release: (): void => {
        if (released) return;
        controller.abort(new BrowserError('cancelled', 'The navigation lease was released.'));
        remove();
      },
    };
    record = { lease, parent: signal };
    record.onParentAbort = (): void => {
      controller.abort(signal?.reason);
      remove();
    };
    signal?.addEventListener('abort', record.onParentAbort, { once: true });
    const key = leaseKey(sessionId, pageHandle);
    const stack = this.stacks.get(key) ?? [];
    stack.push(record);
    this.stacks.set(key, stack);
    return lease;
  }

  current(sessionId: string, pageHandle: number): NativeNavigationLease | undefined {
    if (!sessionId || !validPageHandle(pageHandle)) return undefined;
    const stack = this.stacks.get(leaseKey(sessionId, pageHandle));
    return stack?.[stack.length - 1]?.lease;
  }
}

export interface NativeNavigationGateOptions {
  sessionId: string;
  pageHandle: number;
  cdp: NativeNavigationCdp;
  leases: NativeNavigationLeaseSource;
  assertNavigation(url: unknown): string;
  mainFrameId?(): string;
  authorize?(
    sessionId: string,
    url: string,
    resource: 'browsing' | 'uploads',
    signal: AbortSignal,
  ): Promise<void> | void;
}

type FailReason = 'Aborted' | 'BlockedByClient';

interface PausedNavigation {
  requestId: string;
  frame?: string;
  controller: AbortController;
  settled: boolean;
  resource: 'browsing' | 'uploads';
  cleanup(): void;
  fail(reason: FailReason): Promise<void>;
}

const MAX_VISIT_SOURCES = 128;

/**
 * Pauses main-frame Document requests at the CDP Fetch request stage. Each hop
 * is authorized against the current page-scoped operation lease. The original
 * request is continued without URL, method, postData or header overrides, so
 * POST bodies and redirect method semantics stay browser-owned.
 *
 * Lifecycle work is serialized: a stop queued during startup runs after the
 * startup finishes and disables Fetch, so a late Fetch.enable cannot survive.
 * If startup fails, tracked paused requests are failed and Fetch is disabled.
 */
export class NativeNavigationGate {
  private enabled = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private generation = 0;
  private unsubscribe: (() => void) | undefined;
  private mainFrameId = '';
  private readonly pending = new Map<string, PausedNavigation>();
  private readonly visitSources = new Map<string, NativeNavigationOrigin>();
  private uploadSignal: AbortSignal | undefined;
  private readonly uploadChains = new Set<string>();
  private readonly uploadAborted = (): void => { void this.setUploadLease(); };

  constructor(private readonly options: NativeNavigationGateOptions) {
    if (!options.sessionId) throw new BrowserError('invalid_request', 'A browser session id is required.');
    if (!validPageHandle(options.pageHandle)) throw new BrowserError('invalid_request', 'pageHandle must be a positive integer.');
  }

  start(): Promise<void> {
    return this.queue(() => this.startInternal());
  }

  /** Queue a serialized teardown; a start already in flight finishes first. */
  stop(): Promise<void> {
    this.enabled = false;
    return this.queue(() => this.stopInternal());
  }

  /** Release paused requests without disabling the gate (navigation stop). */
  async abortPending(): Promise<void> {
    const records = [...this.pending.values()];
    await Promise.all(records.map(record => record.fail('Aborted')));
  }

  /**
   * Consume the operation source recorded for one authorized URL. The manager
   * calls this when the final navigation commits; a missing entry means the
   * visit is human/other.
   */
  takeVisitSource(url: string): NativeNavigationOrigin | undefined {
    let key = url;
    try { key = this.options.assertNavigation(url); } catch { /* fall back to the exact key */ }
    const source = this.visitSources.get(key);
    if (source === undefined) return undefined;
    this.visitSources.delete(key);
    return source;
  }

  /** Intercept file-bearing requests only while selected files belong to agent input. */
  setUploadLease(signal?: AbortSignal): Promise<void> {
    this.uploadSignal?.removeEventListener('abort', this.uploadAborted);
    this.uploadSignal = signal?.aborted ? undefined : signal;
    this.uploadSignal?.addEventListener('abort', this.uploadAborted, { once: true });
    if (!this.uploadSignal) this.uploadChains.clear();
    const cancelled = this.uploadSignal ? Promise.resolve()
      : Promise.all([...this.pending.values()].filter(record => record.resource === 'uploads').map(record => record.fail('Aborted'))).then(() => {});
    return cancelled.then(() => this.queue(async () => {
      if (!this.enabled) return;
      await this.configureRequests();
    }));
  }

  private async configureRequests(frame?: string): Promise<void> {
    const patterns = [{ resourceType: 'Document', requestStage: 'Request' }];
    if (this.uploadSignal) patterns.push(
      { resourceType: 'XHR', requestStage: 'Request' },
      { resourceType: 'Fetch', requestStage: 'Request' },
    );
    await this.options.cdp.command('Fetch.enable', { patterns }, frame);
    if (frame === undefined && this.uploadSignal) {
      await Promise.all((this.options.cdp.ownedFrameTargets?.() ?? []).map(target => this.configureRequests(target)));
    } else if (frame === undefined) {
      await Promise.all((this.options.cdp.ownedFrameTargets?.() ?? []).map(target =>
        this.options.cdp.command('Fetch.disable', {}, target).catch(() => {})));
    }
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(work);
    this.lifecycle = run.then(() => {}, () => {});
    return run;
  }

  private async startInternal(): Promise<void> {
    if (this.enabled && this.unsubscribe) return;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const generation = ++this.generation;
    const unsubscribe = this.options.cdp.onEvent((method, params, frame) => {
      if (generation !== this.generation || this.unsubscribe !== unsubscribe) return;
      if (method === 'Fetch.requestPaused') void this.onPaused(params, frame).catch(() => {});
      else if (method === 'Target.attachedToTarget' && this.uploadSignal && object(params.targetInfo).type === 'iframe') {
        const target = object(params.targetInfo).targetId;
        if (typeof target === 'string') void this.configureRequests(target).catch(() => {});
      }
    });
    this.unsubscribe = unsubscribe;
    try {
      const tree = this.options.mainFrameId ? undefined : object((await this.options.cdp.command('Page.getFrameTree')).frameTree);
      const mainFrameId = this.options.mainFrameId?.() ?? String(object(tree?.frame).id ?? '');
      if (!mainFrameId) throw new BrowserError('host_error', 'The native page returned no main frame id.');
      this.mainFrameId = mainFrameId;
      await this.configureRequests();
      if (generation !== this.generation || this.unsubscribe !== unsubscribe) return;
      this.enabled = true;
    } catch (error) {
      this.enabled = false;
      this.unsubscribe?.();
      if (this.unsubscribe === unsubscribe) this.unsubscribe = undefined;
      this.generation += 1;
      this.mainFrameId = '';
      await this.abortPending();
      this.visitSources.clear();
      try { await this.options.cdp.command('Fetch.disable'); } catch { /* the page may be closing */ }
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    this.uploadSignal?.removeEventListener('abort', this.uploadAborted);
    this.uploadSignal = undefined;
    this.uploadChains.clear();
    this.enabled = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.generation += 1;
    await this.abortPending();
    this.visitSources.clear();
    this.mainFrameId = '';
    try { await this.options.cdp.command('Fetch.disable'); } catch { /* the page may already be closing */ }
    await Promise.all((this.options.cdp.ownedFrameTargets?.() ?? []).map(target =>
      this.options.cdp.command('Fetch.disable', {}, target).catch(() => {})));
  }

  private async onPaused(params: BrowserObject, frame?: string): Promise<void> {
    if (!this.unsubscribe) return;
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    if (!requestId) return;
    const resourceType = typeof params.resourceType === 'string' ? params.resourceType : '';
    const request = object(params.request);
    const mainDocument = (!resourceType || resourceType === 'Document') && String(params.frameId ?? '') === this.mainFrameId;
    const redirect = typeof params.redirectedRequestId === 'string' && this.uploadChains.has(params.redirectedRequestId);
    const upload = !!this.uploadSignal && !this.uploadSignal.aborted && (
      resourceType === 'Document' || request.hasPostData === true || redirect ||
      ['POST', 'PUT', 'PATCH'].includes(String(request.method).toUpperCase()));
    if (!mainDocument && !upload) {
      await this.continueRequest(requestId, frame);
      return;
    }
    if (upload) this.uploadChains.add(requestId);
    const rawUrl = typeof request.url === 'string' ? request.url : '';
    if (!rawUrl) {
      await this.failRequest(requestId, frame, 'BlockedByClient');
      return;
    }
    let url: string;
    try { url = this.options.assertNavigation(rawUrl); }
    catch {
      await this.failRequest(requestId, frame, 'BlockedByClient');
      return;
    }

    const lease = this.options.leases.current(this.options.sessionId, this.options.pageHandle);
    const source = lease?.source ?? (upload ? 'agent' : 'other');
    const resource = upload ? 'uploads' : 'browsing';
    const controller = new AbortController();
    const parent = lease?.signal ?? (upload ? this.uploadSignal : undefined);
    let record: PausedNavigation;
    const onLeaseAbort = (): void => {
      controller.abort(parent?.reason);
      void record.fail('Aborted');
    };
    record = {
      requestId,
      ...(frame === undefined ? {} : { frame }),
      controller,
      settled: false, resource,
      cleanup: () => { parent?.removeEventListener('abort', onLeaseAbort); },
      fail: reason => this.failRecord(record, reason),
    };
    this.pending.set(requestId, record);
    if (parent?.aborted) {
      onLeaseAbort();
      return;
    }
    parent?.addEventListener('abort', onLeaseAbort, { once: true });
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    try {
      if (record.settled) return;
      signal.throwIfAborted();
      if ((upload || (lease?.requiresAuthorization ?? source === 'agent')) && this.options.authorize) {
        await this.options.authorize(this.options.sessionId, url, resource, signal);
      }
      signal.throwIfAborted();
      if (record.settled) return;
      await this.options.cdp.command('Fetch.continueRequest', { requestId }, frame);
      if (record.settled) return;
      record.settled = true;
      this.pending.delete(requestId);
      record.cleanup();
      if (mainDocument) this.rememberVisit(url, source);
    } catch {
      await record.fail('BlockedByClient');
    }
  }

  private async failRecord(record: PausedNavigation, reason: FailReason): Promise<void> {
    if (record.settled) return;
    record.settled = true;
    record.controller.abort(new BrowserError('cancelled', 'The native navigation request was released.'));
    this.pending.delete(record.requestId);
    record.cleanup();
    await this.failRequest(record.requestId, record.frame, reason);
  }

  private async continueRequest(requestId: string, frame?: string): Promise<void> {
    try { await this.options.cdp.command('Fetch.continueRequest', { requestId }, frame); }
    catch { /* the page may already be closing */ }
  }

  private async failRequest(requestId: string, frame: string | undefined, reason: FailReason): Promise<void> {
    try { await this.options.cdp.command('Fetch.failRequest', { requestId, errorReason: reason }, frame); }
    catch { /* already released or the page is closing */ }
  }

  private rememberVisit(url: string, source: NativeNavigationOrigin): void {
    this.visitSources.delete(url);
    this.visitSources.set(url, source);
    while (this.visitSources.size > MAX_VISIT_SOURCES) {
      const oldest = this.visitSources.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.visitSources.delete(oldest);
    }
  }
}
