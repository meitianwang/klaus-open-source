import { captureScreenshot } from './page-capture';
import { randomUUID } from 'node:crypto';
import { ChromeRelay } from './chrome-relay';
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
  targetId = '';
  dialog: BrowserObject | null = null;
  private readonly frames = new Map<string, string>();
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

  acceptNotification(notification: BrowserObject): void {
    if (this.closed) return;
    if (notification.method !== 'onCDPEvent') return;
    const event = object(notification.params); const source = object(event.source);
    if (source.tabId !== this.tabId && !(typeof source.targetId === 'string' && this.frames.has(source.targetId))) return;
    const params = object(event.params);
    const frame = typeof source.sessionId === 'string' ? [...this.frames].find(([, id]) => id === source.sessionId)?.[0] : undefined;
    this.events.push({ sequence: ++this.eventSequence, method: String(event.method), params, timestamp: Date.now(), frameTargetId: frame ?? null });
    if (this.events.length > 1000) { this.events.shift(); this.evicted.events += 1; }
    if (event.method === 'Target.attachedToTarget' && object(params.targetInfo).type === 'iframe' && typeof params.sessionId === 'string') {
      const id = String(object(params.targetInfo).targetId);
      this.frames.set(id, params.sessionId);
      void this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, id).catch(() => {});
      void this.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, id).catch(() => {});
    } else if (event.method === 'Target.detachedFromTarget') {
      for (const [target, session] of this.frames) if (session === params.sessionId) this.frames.delete(target);
    } else if (event.method === 'Fetch.requestPaused') {
      let allowed = this.allowed();
      try { this.navigationAllowed(object(params.request).url); } catch { allowed = false; }
      const frame = typeof source.sessionId === 'string' ? [...this.frames].find(([, session]) => session === source.sessionId)?.[0] : undefined;
      void (async () => {
        if (allowed) {
          try { await this.authorizeNavigation?.(String(object(params.request).url)); } catch { allowed = false; }
        }
        allowed = allowed && this.allowed();
        await this.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: params.requestId ?? '', ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, frame);
      })().catch(() => {});
    } else if (event.method === 'Runtime.consoleAPICalled') {
      this.console.push({ source: 'console', level: consoleLevel(params.type), text: consoleArgumentsText(params.args), args: params.args ?? [], timestamp: eventTime(params.timestamp), targetId: source.targetId ?? this.targetId, frameTargetId: frame ?? null });
      if (this.console.length > 500) { this.console.shift(); this.evicted.console += 1; }
    } else if (event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded') {
      const entry = object(params.entry ?? params.exceptionDetails);
      this.console.push({ ...entry, source: event.method === 'Log.entryAdded' ? entry.source ?? 'browser' : 'exception', level: consoleLevel(event.method === 'Log.entryAdded' ? entry.level ?? 'info' : 'error'), text: entry.text ?? object(entry.exception).description ?? (event.method === 'Runtime.exceptionThrown' ? 'Uncaught exception' : ''), timestamp: eventTime(entry.timestamp ?? params.timestamp), frameTargetId: frame ?? null });
      if (this.console.length > 500) { this.console.shift(); this.evicted.console += 1; }
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
    for (const listener of this.listeners) listener(String(event.method), params, frame);
  }

  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  extension(method: string, params: BrowserObject = {}): Promise<BrowserObject> {
    if (this.closed || !this.allowed()) return Promise.reject(new BrowserError('stale_tab', 'The Chrome task capability was released.'));
    return this.relay.request(method, { ...params, tabId: this.tabId, session_id: this.sessionId, turn_id: this.turnId }).then(object);
  }

  private send(method: string, params: BrowserObject = {}, frameTarget?: string): Promise<BrowserObject> {
    if (this.closed || !this.allowed()) return Promise.reject(new BrowserError('stale_tab', 'The external Chrome page connection is closed.'));
    return this.relay.request('executeCdp', {
      session_id: this.sessionId, turn_id: this.turnId, tabId: this.tabId,
      ...(frameTarget ? { sessionId: this.frames.get(frameTarget) ?? '' } : {}), method, commandParams: params,
    }).then(value => {
      // Chrome resets emulation when the per-operation debugger is detached.
      // Retain successful top-level settings for this task's next attachment.
      if (!frameTarget) {
        if (method === 'Emulation.setDeviceMetricsOverride') this.viewportOverride = { ...params };
        else if (method === 'Emulation.clearDeviceMetricsOverride') this.viewportOverride = undefined;
        else if (method === 'Emulation.setTouchEmulationEnabled') this.touchOverride = params.enabled === true ? { ...params } : undefined;
      }
      return object(value);
    });
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
      await this.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
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
    if (frameTarget && frameTarget !== this.targetId && !this.frames.has(frameTarget)) throw new BrowserError('stale_target', 'This iframe is not owned by the selected Chrome page. Refresh the snapshot.');
    return this.send(method, params, frameTarget && frameTarget !== this.targetId ? frameTarget : undefined);
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
  }

  frameTargets(): string[] { return [...this.frames.keys()]; }

  printToPDF(): Promise<BrowserObject> { return this.command('Page.printToPDF', { printBackground: true, transferMode: 'ReturnAsBase64' }); }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.dialog = null;
    this.viewportOverride = undefined;
    this.touchOverride = undefined;
    this.listeners.clear();
    this.frames.clear(); this.console.length = 0; this.network.length = 0; this.events.length = 0;
  }
}
