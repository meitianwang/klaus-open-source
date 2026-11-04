import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserVisitSource } from '../../contracts/browser-history';

export type NativeNavigationOrigin = BrowserVisitSource;

/** The CDP surface the native navigation gate needs. PageDebugger satisfies it. */
export interface NativeNavigationCdp {
  command(method: string, params?: BrowserObject, frame?: string): Promise<BrowserObject>;
  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void;
}

export interface NativeNavigationLease {
  readonly sessionId: string;
  readonly source: NativeNavigationOrigin;
  readonly signal: AbortSignal;
  release(): void;
}

export interface NativeNavigationLeaseSource {
  current(sessionId: string): NativeNavigationLease | undefined;
}

interface LeaseRecord {
  lease: NativeNavigationLease;
  parent?: AbortSignal;
  onParentAbort?: () => void;
}

/**
 * Stacked operation leases for one conversation. The newest lease is the
 * operation source; releasing it reveals the previous lease. There is no
 * time-based attribution window.
 */
export class NativeNavigationLeases implements NativeNavigationLeaseSource {
  private readonly stacks = new Map<string, LeaseRecord[]>();

  begin(sessionId: string, source: NativeNavigationOrigin, signal?: AbortSignal): NativeNavigationLease {
    if (!sessionId) throw new BrowserError('invalid_request', 'A browser session id is required.');
    if (signal?.aborted) throw new BrowserError('cancelled', 'The navigation lease was cancelled.');
    const controller = new AbortController();
    let record: LeaseRecord | undefined;
    let released = false;
    const remove = (): void => {
      if (released) return;
      released = true;
      if (record?.onParentAbort) signal?.removeEventListener('abort', record.onParentAbort);
      const stack = this.stacks.get(sessionId);
      if (!stack || !record) return;
      const index = stack.indexOf(record);
      if (index >= 0) stack.splice(index, 1);
      if (!stack.length) this.stacks.delete(sessionId);
    };
    const lease: NativeNavigationLease = {
      sessionId,
      source,
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
    const stack = this.stacks.get(sessionId) ?? [];
    stack.push(record);
    this.stacks.set(sessionId, stack);
    return lease;
  }

  current(sessionId: string): NativeNavigationLease | undefined {
    const stack = this.stacks.get(sessionId);
    return stack?.[stack.length - 1]?.lease;
  }
}

export interface NativeNavigationGateOptions {
  sessionId: string;
  cdp: NativeNavigationCdp;
  leases: NativeNavigationLeaseSource;
  assertNavigation(url: unknown): string;
  authorize?(
    sessionId: string,
    url: string,
    resource: 'browsing',
    signal: AbortSignal,
  ): Promise<void> | void;
}

type FailReason = 'Aborted' | 'BlockedByClient';

interface PausedNavigation {
  requestId: string;
  frame?: string;
  controller: AbortController;
  settled: boolean;
  cleanup(): void;
  fail(reason: FailReason): Promise<void>;
}

const MAX_VISIT_SOURCES = 128;

/**
 * Pauses main-frame Document requests at the CDP Fetch request stage. Each hop
 * is authorized against the current operation lease. The original request is
 * continued without URL, method, postData or header overrides, so POST bodies
 * and redirect method semantics stay browser-owned.
 */
export class NativeNavigationGate {
  private enabled = false;
  private starting: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private mainFrameId = '';
  private readonly pending = new Map<string, PausedNavigation>();
  private readonly visitSources = new Map<string, NativeNavigationOrigin>();

  constructor(private readonly options: NativeNavigationGateOptions) {}

  start(): Promise<void> {
    if (this.enabled) return Promise.resolve();
    if (this.starting) return this.starting;
    const promise = this.startInternal();
    this.starting = promise;
    const clear = (): void => { if (this.starting === promise) this.starting = undefined; };
    promise.then(clear, clear);
    return promise;
  }

  private async startInternal(): Promise<void> {
    this.unsubscribe = this.options.cdp.onEvent((method, params, frame) => {
      if (method === 'Fetch.requestPaused') void this.onPaused(params, frame).catch(() => {});
    });
    try {
      const tree = object((await this.options.cdp.command('Page.getFrameTree')).frameTree);
      this.mainFrameId = String(object(tree.frame).id ?? '');
      if (!this.mainFrameId) throw new BrowserError('host_error', 'The native page returned no main frame id.');
      await this.options.cdp.command('Fetch.enable', {
        patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
      });
      this.enabled = true;
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.mainFrameId = '';
      throw error;
    }
  }

  /** Release paused requests without disabling the gate (navigation stop). */
  async abortPending(): Promise<void> {
    const records = [...this.pending.values()];
    await Promise.all(records.map(record => record.fail('Aborted')));
  }

  /** Release paused requests and disable Fetch (page close/dispose). */
  async stop(): Promise<void> {
    this.enabled = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.abortPending();
    this.visitSources.clear();
    this.mainFrameId = '';
    try { await this.options.cdp.command('Fetch.disable'); } catch { /* the page may already be closing */ }
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

  private async onPaused(params: BrowserObject, frame?: string): Promise<void> {
    if (!this.unsubscribe) return;
    const requestId = typeof params.requestId === 'string' ? params.requestId : '';
    if (!requestId) return;
    const resourceType = typeof params.resourceType === 'string' ? params.resourceType : '';
    if (resourceType && resourceType !== 'Document') {
      await this.continueRequest(requestId, frame);
      return;
    }
    if (String(params.frameId ?? '') !== this.mainFrameId) {
      await this.continueRequest(requestId, frame);
      return;
    }
    const request = object(params.request);
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

    const lease = this.options.leases.current(this.options.sessionId);
    const source = lease?.source ?? 'other';
    const controller = new AbortController();
    const parent = lease?.signal;
    let record: PausedNavigation;
    const onLeaseAbort = (): void => {
      controller.abort(parent?.reason);
      void record.fail('Aborted');
    };
    record = {
      requestId,
      ...(frame === undefined ? {} : { frame }),
      controller,
      settled: false,
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
      if (source === 'agent' && this.options.authorize) {
        await this.options.authorize(this.options.sessionId, url, 'browsing', signal);
      }
      signal.throwIfAborted();
      if (record.settled) return;
      await this.options.cdp.command('Fetch.continueRequest', { requestId }, frame);
      if (record.settled) return;
      record.settled = true;
      this.pending.delete(requestId);
      record.cleanup();
      this.rememberVisit(url, source);
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
