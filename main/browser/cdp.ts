import { captureScreenshot } from './page-capture';
import type { WebContents } from 'electron';
import { BrowserError, message, object, type BrowserObject } from './types';
import { consoleArgumentsText, consoleLevel } from './event-shapes';
import { ElectronPageTransport, isPageTransport, type PageActivityLease, type PageTransport } from './page-transport';

const eventTime = (value: unknown): number => {
  const time = Number(value);
  return Number.isFinite(time) ? time < 100_000_000_000 ? time * 1000 : time : Date.now();
};

/** Release a lease without letting a synchronous throw escape teardown. */
function releaseLease(lease: PageActivityLease): Promise<void> {
  return Promise.resolve().then(() => lease.release()).catch(() => {});
}

/** One debugger belongs to one page. Sibling tabs always get another instance. */
export class PageDebugger {
  private readonly transport: PageTransport;
  private ready: Promise<void> | undefined;
  private disposed = false;
  private activityUsers = 0;
  private activityGeneration = 0;
  private activityReady: Promise<void> | undefined;
  private activityLease: PageActivityLease | undefined;
  private readonly frames = new Map<string, string>();
  private readonly listeners = new Set<(method: string, params: BrowserObject, frame?: string) => void>();
  readonly console: BrowserObject[] = [];
  readonly network: BrowserObject[] = [];
  readonly events: BrowserObject[] = [];
  readonly evicted = { console: 0, network: 0, events: 0 };
  private eventSequence = 0;
  targetId = '';

  /**
   * Existing Electron callers may pass WebContents directly; native callers
   * pass a PageTransport. The union keeps old construction explicit while
   * ensuring a native handle is never treated as a WebContents.
   */
  constructor(page: WebContents | PageTransport) {
    this.transport = isPageTransport(page) ? page : new ElectronPageTransport(page as WebContents);
    this.transport.debugger.on('message', this.onMessage);
    this.transport.debugger.on('detach', this.onDetach);
  }

  private readonly onDetach = (): void => {
    this.ready = undefined;
    this.frames.clear();
  };


  /**
   * An iframe target has its own Page/Runtime/Log/Network agents. The root
   * initialize only enables the root agent; each owned child must be enabled
   * before its console, exception and network events can reach the page.
   */
  private async enableChild(targetId: string, sessionId: string): Promise<void> {
    try {
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
      if (this.disposed || this.frames.get(targetId) !== sessionId) return;
      await Promise.all([
        this.send('Page.enable', {}, sessionId),
        this.send('Runtime.enable', {}, sessionId),
        this.send('Log.enable', {}, sessionId),
        this.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 256 * 1024, maxPostDataSize: 16 * 1024 }, sessionId),
      ]);
    } catch {
      if (this.frames.get(targetId) !== sessionId) return;
      this.frames.delete(targetId);
      if (!this.disposed) await this.send('Target.detachFromTarget', { sessionId }, undefined).catch(() => {});
    }
  }

  private readonly onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string): void => {
    const data = object(params);
    const frame = sessionId ? [...this.frames].find(([, id]) => id === sessionId)?.[0] : undefined;
    // A detached child can still emit late events. They must not be recorded as
    // root events merely because the child session is no longer in the map.
    if (sessionId && !frame) {
      if (method === 'Target.detachedFromTarget') {
        for (const [target, id] of this.frames) if (id === data.sessionId) this.frames.delete(target);
      }
      return;
    }
    this.events.push({ sequence: ++this.eventSequence, method, params: data, timestamp: Date.now(), frameTargetId: frame ?? null });
    if (this.events.length > 1000) { this.events.shift(); this.evicted.events += 1; }
    if (method === 'Target.attachedToTarget' && object(data.targetInfo).type === 'iframe') {
      const targetId = String(object(data.targetInfo).targetId);
      const childSession = String(data.sessionId);
      this.frames.set(targetId, childSession);
      void this.enableChild(targetId, childSession);
    } else if (method === 'Target.detachedFromTarget') {
      for (const [target, id] of this.frames) if (id === data.sessionId) this.frames.delete(target);
    } else if (method === 'Runtime.consoleAPICalled') {
      this.console.push({ source: 'console', level: consoleLevel(data.type), text: consoleArgumentsText(data.args), args: data.args ?? [], timestamp: eventTime(data.timestamp), sessionId: sessionId ?? null, frameTargetId: frame ?? null });
      if (this.console.length > 500) { this.console.shift(); this.evicted.console += 1; }
    } else if (method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded') {
      const entry = object(data.entry ?? data.exceptionDetails);
      this.console.push({ ...entry, source: method === 'Log.entryAdded' ? entry.source ?? 'browser' : 'exception', level: consoleLevel(method === 'Log.entryAdded' ? entry.level ?? 'info' : 'error'), text: entry.text ?? object(entry.exception).description ?? (method === 'Runtime.exceptionThrown' ? 'Uncaught exception' : ''), timestamp: eventTime(entry.timestamp ?? data.timestamp), frameTargetId: frame ?? null });
      if (this.console.length > 500) { this.console.shift(); this.evicted.console += 1; }
    } else if (method === 'Network.requestWillBeSent') {
      const id = data.requestId ?? '', scope = frame ?? null;
      const row = this.network.findLast(entry => entry.id === id && entry.frameTargetId === scope);
      const next = { id, ...object(data.request), resourceType: data.type ?? null, timestamp: Date.now(), frameTargetId: scope };
      if (row) Object.assign(row, next); else { this.network.push(next); if (this.network.length > 500) { this.network.shift(); this.evicted.network += 1; } }
    } else if (method === 'Network.responseReceived') {
      const row = this.network.findLast(entry => entry.id === data.requestId && entry.frameTargetId === (frame ?? null));
      if (row) { row.response = data.response ?? null; row.resourceType = data.type ?? row.resourceType ?? null; }
    } else if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
      const row = this.network.findLast(entry => entry.id === data.requestId && entry.frameTargetId === (frame ?? null));
      if (row) {
        row.endedAtMs = Date.now();
        if (method === 'Network.loadingFailed') { row.error = data.errorText ?? 'Request failed'; row.canceled = data.canceled === true; }
      }
    }
    for (const listener of this.listeners) listener(method, data, frame);
  };

  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async initialize(): Promise<void> {
    if (this.disposed || this.transport.isDestroyed()) throw new BrowserError('stale_tab', 'The browser page is closed.');
    if (this.ready) return this.ready;
    const starting = (async () => {
      const channel = this.transport.debugger;
      if (!channel.isAttached()) channel.attach('1.3');
      const info = object(await this.send('Target.getTargetInfo'));
      this.targetId = String(object(info.targetInfo).targetId ?? '');
      if (!this.targetId) throw new BrowserError('host_error', 'The page did not return its CDP target id.');
      await this.send('Page.enable');
      await this.send('Runtime.enable');
      await this.send('Log.enable');
      await this.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 256 * 1024, maxPostDataSize: 16 * 1024 });
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    })();
    this.ready = starting;
    try { await starting; } catch (error) { if (this.ready === starting) this.ready = undefined; throw error; }
  }

  private async send(method: string, params: BrowserObject = {}, sessionId?: string): Promise<BrowserObject> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return object(await Promise.race([
        this.transport.debugger.sendCommand(method, params, sessionId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BrowserError('timeout', `${method} timed out.`)), 30_000);
        }),
      ]));
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('cdp_error', `${method}: ${message(error)}`);
    } finally { clearTimeout(timer); }
  }

  async command(method: string, params: BrowserObject = {}, frameTarget?: string): Promise<BrowserObject> {
    await this.initialize();
    let sessionId: string | undefined;
    if (frameTarget && frameTarget !== this.targetId) {
      sessionId = this.frames.get(frameTarget);
      if (!sessionId) {
        // Only an iframe already reported as a child of this page may be addressed.
        // Arbitrary Target.attachToTarget would cross the conversation boundary.
        throw new BrowserError('stale_target', 'The iframe is not attached to this page. Refresh the page snapshot.');
      }
    }
    return this.send(method, params, sessionId);
  }

  async evaluate(expression: string, frameTarget?: string): Promise<unknown> {
    const answer = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, frameTarget);
    if (answer.exceptionDetails) {
      const detail = object(answer.exceptionDetails);
      throw new BrowserError('evaluation_error', String(object(detail.exception).description ?? detail.text ?? 'JavaScript evaluation failed.'));
    }
    return object(answer.result).value ?? null;
  }

  /** Keep a background page renderable only while an agent operation is running. */
  async activity<T>(work: () => Promise<T>): Promise<T> {
    if (this.activityUsers === 0) {
      this.activityGeneration += 1;
      this.activityReady = this.startActivity(this.activityGeneration);
    }
    this.activityUsers += 1;
    try {
      await this.activityReady;
      return await work();
    } finally {
      this.activityUsers = Math.max(0, this.activityUsers - 1);
      if (this.activityUsers === 0) await this.stopActivity(this.activityGeneration);
    }
  }

  private async startActivity(generation: number): Promise<void> {
    await this.initialize();
    const lease = await this.transport.acquireActivity();
    if (this.disposed || generation !== this.activityGeneration) {
      await releaseLease(lease);
      return;
    }
    this.activityLease = lease;
    await this.command('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (this.disposed || generation !== this.activityGeneration) return;
    // A detached view needs a compositor turn before hit-testing a first click.
    await this.evaluate('Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),new Promise(r=>setTimeout(r,250))])');
  }

  private async stopActivity(generation: number): Promise<void> {
    const lease = this.activityLease;
    if (this.activityGeneration === generation) this.activityLease = undefined;
    // Yield so a new activity that starts during teardown can register itself
    // before we decide whether to turn focus emulation off.
    await Promise.resolve();
    try {
      if (this.activityGeneration === generation && !this.disposed && !this.transport.isDestroyed() && this.transport.debugger.isAttached()) {
        await this.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      }
    } catch {
      // Navigation/DevTools may detach the debugger while the call unwinds.
    } finally {
      if (lease) await releaseLease(lease);
      if (this.activityGeneration === generation) this.activityReady = undefined;
    }
  }

  async screenshot(options: BrowserObject = {}): Promise<BrowserObject> {
    return captureScreenshot(this, options, this.transport.captureViewport
      ? (format, quality) => this.transport.captureViewport!(format, quality)
      : undefined);
  }

  frameTargets(): string[] { return [...this.frames.keys()]; }

  async printToPDF(): Promise<BrowserObject> {
    if (this.disposed || this.transport.isDestroyed()) throw new BrowserError('stale_tab', 'The browser page is closed.');
    if (this.transport.printToPDF) {
      const pdf = await this.transport.printToPDF();
      if (!pdf.length) throw new BrowserError('host_error', 'The browser returned an empty PDF.');
      return { data: Buffer.from(pdf).toString('base64') };
    }
    const result = await this.command('Page.printToPDF', { printBackground: true });
    const data = String(result.data ?? '');
    if (!data) throw new BrowserError('host_error', 'The browser returned an empty PDF.');
    return { data };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const lease = this.activityLease;
    this.activityLease = undefined;
    if (lease) void releaseLease(lease);
    this.activityReady = undefined;
    // A destroyed page throws on every property getter, so the listener
    // teardown must be skipped wholesale.
    if (!this.transport.isDestroyed()) {
      const channel = this.transport.debugger;
      channel.removeListener('message', this.onMessage);
      channel.removeListener('detach', this.onDetach);
      if (channel.isAttached()) channel.detach();
    }
    this.frames.clear();
    this.listeners.clear();
    this.console.length = 0;
    this.network.length = 0;
    this.events.length = 0;
  }
}
