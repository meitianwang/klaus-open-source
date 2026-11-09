import { captureScreenshot } from './page-capture';
import type { WebContents } from 'electron';
import { FrameRouteTracker, injectFrameRouteParams } from './frame-routes';
import { BrowserError, message, object, type BrowserObject } from './types';
import { consoleArgumentsText, consoleLevel } from './event-shapes';

const eventTime = (value: unknown): number => {
  const time = Number(value);
  return Number.isFinite(time) ? time < 100_000_000_000 ? time * 1000 : time : Date.now();
};

/** One debugger belongs to one page. Sibling tabs always get another instance. */
export class PageDebugger {
  private ready: Promise<void> | undefined;
  private disposed = false;
  private activityUsers = 0;
  private activityReady: Promise<void> | undefined;
  private previousThrottling = true;
  private readonly frames = new Map<string, string>();
  /** Routing table for frames that share this page's process (no child target). */
  private readonly tracker = new FrameRouteTracker();
  private readonly listeners = new Set<(method: string, params: BrowserObject, frame?: string) => void>();
  readonly console: BrowserObject[] = [];
  readonly network: BrowserObject[] = [];
  readonly events: BrowserObject[] = [];
  readonly evicted = { console: 0, network: 0, events: 0 };
  private eventSequence = 0;
  /** Desired document-start scripts, re-applied after every debugger attach. */
  private readonly documentScripts = new Map<string, string>();
  /** Registered script identifiers per key and session ('' is the root). */
  private readonly documentScriptIds = new Map<string, Map<string, string>>();
  targetId = '';

  constructor(readonly contents: WebContents) {
    contents.debugger.on('message', this.onMessage);
    contents.debugger.on('detach', this.onDetach);
  }

  private readonly onDetach = (): void => {
    this.ready = undefined;
    this.frames.clear();
    this.tracker.clear();
    // Registrations die with the debugger attachment; the desired scripts stay
    // and are re-applied by the next initialize.
    this.documentScriptIds.clear();
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
      if (this.disposed || this.frames.get(targetId) !== sessionId) return;
      // Frames inside this child's process are only visible on its own session.
      const childTree = object(await this.send('Page.getFrameTree', {}, sessionId));
      this.tracker.seedFrameTree(object(childTree.frameTree), undefined);
      for (const [key, source] of this.documentScripts) await this.applyDocumentScriptOn(key, source, sessionId);
    } catch {
      if (this.frames.get(targetId) !== sessionId) return;
      this.frames.delete(targetId);
      if (!this.disposed) await this.send('Target.detachFromTarget', { sessionId }, undefined).catch(() => {});
    }
  }

  private readonly onMessage = (_event: Electron.Event, method: string, params: unknown, sessionId?: string): void => {
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
      if (typeof data.sessionId === 'string') this.tracker.clearSession(data.sessionId);
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
    this.tracker.onEvent(method, data, sessionId);
    for (const listener of this.listeners) listener(method, data, frame);
  };

  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  async initialize(): Promise<void> {
    if (this.disposed || this.contents.isDestroyed()) throw new BrowserError('stale_tab', 'The browser page is closed.');
    if (this.ready) return this.ready;
    const starting = (async () => {
      if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
      const info = object(await this.send('Target.getTargetInfo'));
      this.targetId = String(object(info.targetInfo).targetId ?? '');
      if (!this.targetId) throw new BrowserError('host_error', 'The page did not return its CDP target id.');
      await this.send('Page.enable');
      await this.send('Runtime.enable');
      await this.send('Log.enable');
      await this.send('Network.enable', { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 256 * 1024, maxPostDataSize: 16 * 1024 });
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      const tree = object(await this.send('Page.getFrameTree'));
      const frameTree = object(tree.frameTree);
      this.tracker.seedFrameTree(frameTree);
      const rootFrameId = String(object(frameTree.frame).id ?? '');
      if (rootFrameId) this.tracker.rootFrameId = rootFrameId;
      for (const [key, source] of this.documentScripts) await this.applyDocumentScriptOn(key, source, undefined);
    })();
    this.ready = starting;
    try { await starting; } catch (error) { if (this.ready === starting) this.ready = undefined; throw error; }
  }

  private async send(method: string, params: BrowserObject = {}, sessionId?: string): Promise<BrowserObject> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return object(await Promise.race([
        this.contents.debugger.sendCommand(method, params, sessionId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BrowserError('timeout', `${method} timed out.`)), 30_000);
        }),
      ]));
    } catch (error) {
      if (error instanceof BrowserError) throw error;
      throw new BrowserError('cdp_error', `${method}: ${message(error)}`);
    } finally { clearTimeout(timer); }
  }

  /**
   * Register a script that runs at document start in the page's main world and
   * in every attached iframe target. Registration survives a debugger
   * re-attach; call it once the page reports ready.
   */
  async registerDocumentScript(key: string, source: string): Promise<void> {
    this.documentScripts.set(key, source);
    await this.updateDocumentScript(key, source);
  }

  /** Replace a registered document-start script everywhere it is installed. */
  async updateDocumentScript(key: string, source: string): Promise<void> {
    this.documentScripts.set(key, source);
    if (this.disposed || this.contents.isDestroyed() || !this.ready) return;
    try { await this.ready; } catch { return; }
    if (this.disposed || this.contents.isDestroyed()) return;
    this.clearDocumentScriptIds(key);
    for (const sessionId of [undefined, ...this.frames.values()]) {
      await this.applyDocumentScriptOn(key, source, sessionId);
    }
  }

  private clearDocumentScriptIds(key: string): void {
    const identifiers = this.documentScriptIds.get(key);
    this.documentScriptIds.delete(key);
    if (!identifiers) return;
    for (const [sessionId, identifier] of identifiers) {
      // Identifiers are unique per registration, so a late removal of the old
      // script can never drop the replacement.
      void this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId || undefined).catch(() => {});
    }
  }

  private async applyDocumentScriptOn(key: string, source: string, sessionId: string | undefined): Promise<void> {
    if (this.disposed || this.contents.isDestroyed()) return;
    try {
      const result = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
      const identifier = String(object(result).identifier ?? '');
      if (!identifier) return;
      const identifiers = this.documentScriptIds.get(key) ?? new Map<string, string>();
      this.documentScriptIds.set(key, identifiers);
      identifiers.set(sessionId ?? '', identifier);
    } catch {
      // A child target can detach between enablement and registration; the
      // next attach re-applies every registered script.
    }
  }

  async command(method: string, params: BrowserObject = {}, frameTarget?: string): Promise<BrowserObject> {
    await this.initialize();
    let sessionId: string | undefined;
    let routed = params;
    if (frameTarget && frameTarget !== this.targetId) {
      sessionId = this.frames.get(frameTarget);
      if (!sessionId) {
        // A frame in this page's own process has no child target; its default
        // context routes the call. Anything else was never reported as part of
        // this page, and an arbitrary Target.attachToTarget would cross the
        // conversation boundary.
        const route = this.tracker.contexts.get(frameTarget);
        if (!route) throw new BrowserError('stale_target', 'The iframe is not attached to this page. Refresh the page snapshot.');
        sessionId = route.session;
        routed = injectFrameRouteParams(method, params, frameTarget, route.contextId);
      }
    }
    return this.send(method, routed, sessionId);
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
      this.activityReady = (async () => {
        await this.initialize();
        this.previousThrottling = this.contents.getBackgroundThrottling();
        this.contents.setBackgroundThrottling(false);
        await this.command('Emulation.setFocusEmulationEnabled', { enabled: true });
        // A detached view needs a compositor turn before hit-testing a first click.
        await this.evaluate('Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))),new Promise(r=>setTimeout(r,250))])');
      })();
    }
    this.activityUsers += 1;
    try { await this.activityReady; return await work(); }
    finally {
      this.activityUsers -= 1;
      if (this.activityUsers === 0 && !this.disposed && !this.contents.isDestroyed()) {
        try {
          if (this.contents.debugger.isAttached()) await this.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        } catch {
          // Navigation/DevTools may detach the debugger while the call unwinds.
        } finally { if (!this.disposed && !this.contents.isDestroyed()) this.contents.setBackgroundThrottling(this.previousThrottling); }
        this.activityReady = undefined;
      }
    }
  }

  async screenshot(options: BrowserObject = {}): Promise<BrowserObject> {
    return captureScreenshot(this, options, async (format, quality) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const image = await Promise.race([
        this.contents.capturePage(undefined, { stayHidden: true }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserError('timeout', 'Browser capture timed out.')), 15_000); }),
      ]).finally(() => clearTimeout(timer));
      if (image.isEmpty()) throw new BrowserError('host_error', 'The browser returned an empty screenshot.');
      return (format === 'jpeg' ? image.toJPEG(quality) : image.toPNG()).toString('base64');
    });
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

  async printToPDF(): Promise<BrowserObject> {
    if (this.disposed || this.contents.isDestroyed()) throw new BrowserError('stale_tab', 'The browser page is closed.');
    const pdf = await this.contents.printToPDF({ printBackground: true });
    if (!pdf.length) throw new BrowserError('host_error', 'Electron returned an empty PDF.');
    return { data: pdf.toString('base64') };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A destroyed WebContents throws on every property getter, `.debugger`
    // included, so the listener teardown must be skipped wholesale.
    if (!this.contents.isDestroyed()) {
      this.contents.debugger.removeListener('message', this.onMessage);
      this.contents.debugger.removeListener('detach', this.onDetach);
      if (this.contents.debugger.isAttached()) this.contents.debugger.detach();
    }
    this.frames.clear();
    this.tracker.clear();
    this.listeners.clear();
    this.console.length = 0;
    this.network.length = 0;
    this.events.length = 0;
  }
}
