import { captureScreenshot } from './page-capture';
import { randomUUID } from 'node:crypto';
import { ChromeRelay } from './chrome-relay';
import { FrameRouteTracker, injectFrameRouteParams } from './frame-routes';
import { BrowserError, object, type BrowserObject } from './types';
import { navigationUrl } from './policy';
import type { BrowserCdp } from './page-operations';
import { consoleArgumentsText, consoleLevel } from './event-shapes';

const eventTime = (value: unknown): number => {
  const time = Number(value);
  return Number.isFinite(time) ? time < 100_000_000_000 ? time * 1000 : time : Date.now();
};

/** The extension owns debugger attachment; this adapter owns one task's page. */
export class ChromePageDebugger implements BrowserCdp {
  readonly console: BrowserObject[] = [];
  readonly network: BrowserObject[] = [];
  readonly events: BrowserObject[] = [];
  readonly evicted = { console: 0, network: 0, events: 0 };
  private eventSequence = 0;
  /**
   * Identity keys of console entries already buffered. The extension detaches
   * the debugger at turn end; the next turn re-enables Runtime/Log and Chrome
   * replays its cached console entries with their original timestamps, so the
   * same event would otherwise accumulate once per turn. Genuinely repeated
   * messages carry fresh timestamps and are kept.
   */
  private readonly consoleReplayKeys = new Set<string>();
  targetId = '';
  dialog: BrowserObject | null = null;
  private readonly frames = new Map<string, string>();
  /** Routing table for frames that share a process with an attached page or child target. */
  private readonly tracker = new FrameRouteTracker();
  /**
   * Raw Fetch patterns the task enabled, kept across debugger re-attachments
   * so a paused-request workflow survives the per-operation attach cycle:
   * the next attach re-applies them merged with the host-reserved Document
   * pattern. Keyed by child target id; 'main' is the page's own session.
   * Cleared by Fetch.enable with an empty patterns array, by a child target
   * detaching, or by dispose.
   */
  private readonly rawFetchPatterns = new Map<string, BrowserObject[]>();
  private readonly listeners = new Set<(method: string, params: BrowserObject, frame?: string) => void>();
  private ready: Promise<void> | undefined;
  private viewportOverride: BrowserObject | undefined;
  private touchOverride: BrowserObject | undefined;
  private closed = false;
  turnId: string = randomUUID();

  constructor(readonly relay: ChromeRelay, readonly sessionId: string, readonly tabId: number, private readonly allowed: () => boolean = () => true,
    private readonly navigationAllowed: (url: unknown) => string = navigationUrl,
    private readonly authorizeNavigation?: (url: string) => Promise<void>) {

  }


  /** Enable the owned child target's own Page/Runtime/Log/Network agents. */
  private async enableChild(targetId: string): Promise<void> {
    const session = this.frames.get(targetId);
    if (!session) return;
    try {
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, targetId);
      if (this.closed || this.frames.get(targetId) !== session) return;
      await Promise.all([
        this.send('Page.enable', {}, targetId),
        this.send('Runtime.enable', {}, targetId),
        this.send('Log.enable', {}, targetId),
        this.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 256 * 1024, maxPostDataSize: 16 * 1024 }, targetId),
      ]);
      if (!this.closed && this.frames.get(targetId) === session) await this.send('Fetch.enable', { patterns: this.hostFetchPatterns(targetId) }, targetId);
      if (!this.closed && this.frames.get(targetId) === session) {
        // Frames inside this child's process are only visible on its own session.
        const childTree = object(await this.send('Page.getFrameTree', {}, targetId));
        this.tracker.seedFrameTree(object(childTree.frameTree));
      }
    } catch {
      if (this.frames.get(targetId) !== session) return;
      this.frames.delete(targetId);
      if (!this.closed) await this.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    }
  }

  /** The host-reserved Document pattern merged with any raw patterns stored for a session key. */
  private hostFetchPatterns(key: string): BrowserObject[] {
    return [{ resourceType: 'Document', requestStage: 'Request' }, ...(this.rawFetchPatterns.get(key) ?? [])];
  }

  /** True while the task holds raw Fetch interception on any session of this page. */
  rawFetchActive(): boolean { return this.rawFetchPatterns.size > 0; }

  acceptNotification(notification: BrowserObject): void {
    if (this.closed) return;
    if (notification.method !== 'onCDPEvent') return;
    const event = object(notification.params); const source = object(event.source);
    if (source.tabId !== this.tabId && !(typeof source.targetId === 'string' && this.frames.has(source.targetId))) return;
    const params = object(event.params);
    const frame = typeof source.sessionId === 'string' ? [...this.frames].find(([, id]) => id === source.sessionId)?.[0] : undefined;
    // Late events from a detached child must not be attributed to the root page.
    if (typeof source.sessionId === 'string' && !frame) {
      if (event.method === 'Target.detachedFromTarget') {
        for (const [target, session] of this.frames) if (session === params.sessionId) { this.frames.delete(target); this.rawFetchPatterns.delete(target); }
        if (typeof params.sessionId === 'string') this.tracker.clearSession(params.sessionId);
      }
      return;
    }
    this.events.push({ sequence: ++this.eventSequence, method: String(event.method), params, timestamp: Date.now(), frameTargetId: frame ?? null });
    if (this.events.length > 1000) { this.events.shift(); this.evicted.events += 1; }
    if (event.method === 'Target.attachedToTarget' && object(params.targetInfo).type === 'iframe' && typeof params.sessionId === 'string') {
      const id = String(object(params.targetInfo).targetId);
      this.frames.set(id, params.sessionId);
      void this.enableChild(id);
    } else if (event.method === 'Target.detachedFromTarget') {
      for (const [target, session] of this.frames) if (session === params.sessionId) { this.frames.delete(target); this.rawFetchPatterns.delete(target); }
      if (typeof params.sessionId === 'string') this.tracker.clearSession(params.sessionId);
    } else if (event.method === 'Fetch.requestPaused') {
      if (params.resourceType !== 'Document') {
        // Non-Document pauses belong to a task that enabled raw Fetch patterns
        // on this session. The event is already buffered above; the task reads
        // it through cdp events and answers with a raw Fetch.continueRequest,
        // continueResponse or fulfillRequest call.
        const sessionKey = frame ?? 'main';
        if (!this.rawFetchPatterns.has(sessionKey)) {
          // Defensive: no raw interception is active on this session, so
          // nothing else will answer the pause. Continue it instead of
          // stalling the request forever.
          void this.send('Fetch.continueRequest', { requestId: params.requestId ?? '' }, frame).catch(() => {});
        }
      } else {
        let allowed = this.allowed();
        try { this.navigationAllowed(object(params.request).url); } catch { allowed = false; }
        void (async () => {
          if (allowed) {
            try { await this.authorizeNavigation?.(String(object(params.request).url)); } catch { allowed = false; }
          }
          allowed = allowed && this.allowed();
          await this.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: params.requestId ?? '', ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, frame);
        })().catch(() => {});
      }
    } else if (event.method === 'Runtime.consoleAPICalled') {
      this.pushConsole({ source: 'console', level: consoleLevel(params.type), text: consoleArgumentsText(params.args), args: params.args ?? [], timestamp: eventTime(params.timestamp), targetId: source.targetId ?? this.targetId, frameTargetId: frame ?? null });
    } else if (event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded') {
      const entry = object(params.entry ?? params.exceptionDetails);
      this.pushConsole({ ...entry, source: event.method === 'Log.entryAdded' ? entry.source ?? 'browser' : 'exception', level: consoleLevel(event.method === 'Log.entryAdded' ? entry.level ?? 'info' : 'error'), text: entry.text ?? object(entry.exception).description ?? (event.method === 'Runtime.exceptionThrown' ? 'Uncaught exception' : ''), timestamp: eventTime(entry.timestamp ?? params.timestamp), frameTargetId: frame ?? null });
    } else if (event.method === 'Network.requestWillBeSent') {
      const id = params.requestId ?? '', scope = frame ?? null;
      const row = this.network.findLast(entry => entry.id === id && entry.frameTargetId === scope);
      const next = { id, ...object(params.request), resourceType: params.type ?? null, timestamp: Date.now(), frameTargetId: scope };
      if (row) Object.assign(row, next); else { this.network.push(next); if (this.network.length > 500) { this.network.shift(); this.evicted.network += 1; } }
    } else if (event.method === 'Network.responseReceived') {
      const row = this.network.findLast(entry => entry.id === params.requestId && entry.frameTargetId === (frame ?? null));
      if (row) { row.response = params.response ?? null; row.resourceType = params.type ?? row.resourceType ?? null; }
    } else if (event.method === 'Network.loadingFailed' || event.method === 'Network.loadingFinished') {
      const row = this.network.findLast(entry => entry.id === params.requestId && entry.frameTargetId === (frame ?? null));
      if (row) {
        row.endedAtMs = Date.now();
        if (event.method === 'Network.loadingFailed') { row.error = params.errorText ?? 'Request failed'; row.canceled = params.canceled === true; }
        else {
          // Capture bounded bodies before turnEnded detaches the debugger and
          // evicts its response buffer. Each task retains at most 500 * 16 KiB.
          void this.send('Network.getResponseBody', { requestId: params.requestId! }, frame).then(body => {
            if (this.closed) return; const text = String(body.body ?? ''); row.body = text.slice(0,4000); row.base64Encoded = body.base64Encoded ?? false; row.bodyTruncated = text.length > 4000;
          }).catch(error => { if (!this.closed) row.bodyError = String(error); });
        }
      }
    } else if (event.method === 'Page.javascriptDialogOpening') this.dialog = { ...params, id: randomUUID(), tabId: this.tabId };
    else if (event.method === 'Page.javascriptDialogClosed') this.dialog = null;
    this.tracker.onEvent(String(event.method), params, typeof source.sessionId === 'string' ? source.sessionId : undefined);
    for (const listener of this.listeners) listener(String(event.method), params, frame);
  }

  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  extension(method: string, params: BrowserObject = {}): Promise<BrowserObject> {
    if (this.closed || !this.allowed()) return Promise.reject(new BrowserError('stale_tab', 'The Chrome task capability was released.'));
    return this.relay.request(method, { ...params, tabId: this.tabId, session_id: this.sessionId, turn_id: this.turnId }).then(object);
  }

  private sendSession(method: string, params: BrowserObject = {}, sessionId?: string, topLevel = false): Promise<BrowserObject> {
    if (this.closed || !this.allowed()) return Promise.reject(new BrowserError('stale_tab', 'The external Chrome page connection is closed.'));
    return this.relay.request('executeCdp', {
      session_id: this.sessionId, turn_id: this.turnId, tabId: this.tabId,
      ...(sessionId ? { sessionId } : {}), method, commandParams: params,
    }).then(value => {
      // Chrome resets emulation when the per-operation debugger is detached.
      // Retain successful top-level settings for this task's next attachment.
      if (topLevel) {
        if (method === 'Emulation.setDeviceMetricsOverride') this.viewportOverride = { ...params };
        else if (method === 'Emulation.clearDeviceMetricsOverride') this.viewportOverride = undefined;
        else if (method === 'Emulation.setTouchEmulationEnabled') this.touchOverride = params.enabled === true ? { ...params } : undefined;
      }
      return object(value);
    });
  }

  private send(method: string, params: BrowserObject = {}, frameTarget?: string): Promise<BrowserObject> {
    return this.sendSession(method, params, frameTarget ? this.frames.get(frameTarget) : undefined, frameTarget === undefined);
  }

  async initialize(): Promise<void> {
    if (this.closed || !this.allowed()) throw new BrowserError('stale_tab', 'The external Chrome page connection is closed.');
    if (this.ready) return this.ready;
    const ready = (async () => {
      await this.relay.request('attach', { session_id: this.sessionId, turn_id: this.turnId, tabId: this.tabId });
      const info = await this.send('Target.getTargetInfo');
      this.targetId = String(object(info.targetInfo).targetId ?? '');
      if (!this.targetId) throw new BrowserError('chrome_error', 'Chrome did not return this page target id.');
      for (const method of ['Page.enable', 'Runtime.enable', 'Log.enable']) await this.send(method);
      await this.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 256 * 1024, maxPostDataSize: 16 * 1024 });
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const tree = object(await this.send('Page.getFrameTree'));
      const frameTree = object(tree.frameTree);
      this.tracker.seedFrameTree(frameTree);
      const rootFrameId = String(object(frameTree.frame).id ?? '');
      if (rootFrameId) this.tracker.rootFrameId = rootFrameId;
      await this.send('Fetch.enable', { patterns: this.hostFetchPatterns('main') });
      if (this.viewportOverride) await this.send('Emulation.setDeviceMetricsOverride', this.viewportOverride);
      if (this.touchOverride) await this.send('Emulation.setTouchEmulationEnabled', this.touchOverride);
    })();
    this.ready = ready;
    try { await ready; } catch (error) { if (this.ready === ready) this.ready = undefined; throw error; }
  }

  /** Only child iframe sessions emitted by this page attachment are addressable. */
  async refreshFrames(): Promise<void> { await this.initialize(); }

  async command(method: string, params: BrowserObject = {}, frameTarget?: string): Promise<BrowserObject> {
    await this.initialize();
    if (!frameTarget || frameTarget === this.targetId) {
      if (method === 'Fetch.enable') return this.enableRawFetch(params, 'main', undefined, true);
      return this.sendSession(method, params, undefined, true);
    }
    const session = this.frames.get(frameTarget);
    if (session) {
      if (method === 'Fetch.enable') return this.enableRawFetch(params, frameTarget, session);
      return this.sendSession(method, params, session);
    }
    // A frame in this page's own process has no child target; its default
    // context routes the call inside the owning session.
    const route = this.tracker.contexts.get(frameTarget);
    if (!route) throw new BrowserError('stale_target', 'This iframe is not owned by the selected Chrome page. Refresh the snapshot.');
    if (method === 'Fetch.enable') {
      const owner = route.session ? [...this.frames].find(([, id]) => id === route.session)?.[0] ?? 'main' : 'main';
      return this.enableRawFetch(params, owner, route.session);
    }
    return this.sendSession(method, injectFrameRouteParams(method, params, frameTarget, route.contextId), route.session);
  }

  /**
   * Merge a raw Fetch.enable with the host-reserved Document pattern instead
   * of letting it replace the single per-session interception configuration,
   * so managed navigation authorization keeps working while the task
   * intercepts other resource types. Omitted patterns keep the
   * intercept-everything meaning; an empty patterns array restores the
   * host-only configuration and clears the stored raw patterns.
   */
  private async enableRawFetch(params: BrowserObject, key: string, sessionId: string | undefined, topLevel = false): Promise<BrowserObject> {
    const userPatterns: BrowserObject[] = Array.isArray(params.patterns)
      ? (params.patterns as BrowserObject[])
      : [{ requestStage: 'Request' }];
    const merged: BrowserObject[] = [{ resourceType: 'Document', requestStage: 'Request' }, ...userPatterns];
    const result = await this.sendSession('Fetch.enable', { ...params, patterns: merged }, sessionId, topLevel);
    if (userPatterns.length) this.rawFetchPatterns.set(key, userPatterns); else this.rawFetchPatterns.delete(key);
    return result;
  }

  /** Buffer one console entry unless it is a replay of an already-buffered event. */
  private pushConsole(entry: BrowserObject): void {
    const key = `${String(entry.source)}:${String(entry.level)}:${String(entry.timestamp)}:${String(entry.text)}`;
    if (this.consoleReplayKeys.has(key)) return;
    this.consoleReplayKeys.add(key);
    if (this.consoleReplayKeys.size > 1000) {
      const oldest = this.consoleReplayKeys.values().next();
      if (!oldest.done) this.consoleReplayKeys.delete(oldest.value);
    }
    this.console.push(entry);
    if (this.console.length > 500) { this.console.shift(); this.evicted.console += 1; }
  }

  async evaluate(expression: string, frameTarget?: string): Promise<unknown> {
    const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, frameTarget);
    if (result.exceptionDetails) {
      const exception = object(result.exceptionDetails);
      throw new BrowserError('evaluation_error', String(object(exception.exception).description ?? exception.text ?? 'Chrome evaluation failed.'));
    }
    return object(result.result).value ?? null;
  }

  screenshot(options: BrowserObject = {}): Promise<BrowserObject> { return captureScreenshot(this, options); }

  async activity<T>(work: () => Promise<T>): Promise<T> {
    await this.initialize();
    try {
      await this.command('Emulation.setFocusEmulationEnabled', { enabled: true });
      await this.command('Page.setWebLifecycleState', { state: 'active' });
      await this.evaluate('Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),new Promise(r=>setTimeout(r,250))])');
      return await work();
    } finally {
      if (!this.closed) await this.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    }
  }

  async detached(): Promise<void> {
    this.ready = undefined;
    this.frames.clear();
    this.tracker.clear();
    // rawFetchPatterns deliberately survives: the next attach re-applies them.
  }

  frameTargets(): string[] { return [...this.frames.keys()]; }

  remoteFrameIds(): string[] {
    const out = [...this.frames.keys()];
    for (const frameId of this.tracker.contexts.keys()) {
      if (frameId === this.tracker.rootFrameId || this.frames.has(frameId)) continue;
      if (this.tracker.isRemoteFrame(frameId)) out.push(frameId);
    }
    return out;
  }

  frameParent(frameId: string): string | undefined { return this.tracker.parents.get(frameId); }

  frameRouteKey(frameId: string): string {
    const session = this.frames.get(frameId) ?? this.tracker.contexts.get(frameId)?.session;
    return session ? `session:${session}` : 'main';
  }

  rootFrameId(): string { return this.tracker.rootFrameId || this.targetId; }

  printToPDF(): Promise<BrowserObject> { return this.command('Page.printToPDF', { printBackground: true, transferMode: 'ReturnAsBase64' }); }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.dialog = null;
    this.viewportOverride = undefined;
    this.touchOverride = undefined;
    this.listeners.clear();
    this.frames.clear(); this.tracker.clear(); this.rawFetchPatterns.clear(); this.console.length = 0; this.network.length = 0; this.events.length = 0;
  }
}
