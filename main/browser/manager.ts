import { BaseWindow, Menu, WebContentsView, session as electronSession, type BrowserWindow, type Session, type WebContents } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PageDebugger } from './cdp';
import { BrowserDialogs } from './dialogs';
import { NativeDownloads } from './native-downloads';
import type { BrowserCdp } from './page-operations';
import { permissionCommand } from './page-advanced';
import { BrowserPermissionDecisions } from './permission-requests';
import { browserBounds, navigationUrl } from './policy';
import { BrowserError, json, message, object, type BrowserBounds, type BrowserObject, type BrowserScope, type BrowserState } from './types';
import type { Json } from '../ipc/contract';
import { navigateForRead } from './task-operations';
import { BROWSER_PANEL_OPEN_ACK_TIMEOUT_MS } from './panel-contract';
import { boundedTabFavicon, cachedTabFaviconScript } from './tab-favicon';

export interface BrowserPage {
  readonly handle: number;
  readonly id: string;
  readonly owner: string;
  readonly view: WebContentsView;
  /**
   * The WebContents id captured at creation. Once the contents is destroyed,
   * Electron's `WebContentsView.webContents` getter answers undefined, so the id
   * needed to release dialogs must not be re-read from the view.
   */
  readonly contentsId: number;
  readonly cdp: PageDebugger;
  ready: Promise<void>;
  lastOpened?: number;
  faviconUrl?: string;
  faviconSource?: string;
  error?: string;
  /** Intrinsic CSS content width from the last layout probe; 0 = fits or unknown. */
  contentWidth?: number;
  /** Bumped on every completed layout probe so the renderer sees each round. */
  contentRevision?: number;
}
interface Conversation { tabs: number[]; active?: number }
interface PanelOpenWaiter {
  sessionId: string;
  focusRevision: number;
  targetId?: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve(opened: boolean): void;
}
export interface BrowserPermissionRequest { sessionId: string; permission: string; origin: string; pageUrl: string }
export interface BrowserManagerOptions {
  window: BrowserWindow;
  configRoot: string;
  emit: (channel: string, payload: Json) => void;
  enabled?: () => boolean;
  navigationAllowed?: (url: string) => boolean;
  requestPermission?: (request: BrowserPermissionRequest) => Promise<boolean>;
  dialogTimeoutMs?: number;
  /** Runtime owns registered main windows and their lifetime. */
  managedWindows?: boolean;
}

/** Owns every IAB page; the renderer and MCP server only refer to these pages. */
export class BrowserManager {
  readonly browserSession: Session;
  readonly profilePath: string;
  readonly dialogs: BrowserDialogs;
  private readonly parking: BaseWindow;
  private readonly dialogPreloadId: string;
  private readonly pages = new Map<number, BrowserPage>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly decisions = new BrowserPermissionDecisions();
  private readonly activeOperations = new Map<string, { turnId: string; source: string; initiator: string }>();
  private readonly panelOpenWaiters = new Set<PanelOpenWaiter>();
  private readonly downloads: NativeDownloads;
  private readonly windowListeners: Array<[string, () => void]> = [];
  private nextHandle = 1;
  private contentProbeTimer: ReturnType<typeof setTimeout> | undefined;
  private current = 'manual';
  private revision = 0;
  private presentationRevision = 0;
  private wantedVisible = false;
  private shown: BrowserPage | undefined;
  private bounds: BrowserBounds = { x: 0, y: 54, width: 800, height: 600 };
  private disposed = false;
  private readonly presentations = new Map<number, { window: BrowserWindow; current: string; bounds: BrowserBounds; wantedVisible: boolean }>();

  constructor(private readonly options: BrowserManagerOptions) {
    // Do not open an old standalone Chromium profile concurrently or reinterpret it.
    this.profilePath = resolve(options.configRoot, 'electron', 'browser-profile');
    mkdirSync(this.profilePath, { recursive: true });
    mkdirSync(this.downloadDirectory, { recursive: true });
    this.browserSession = electronSession.fromPath(this.profilePath);
    this.downloads = new NativeDownloads(this.browserSession, this.downloadDirectory, url => this.assertNavigation(url));
    this.dialogPreloadId = this.browserSession.registerPreloadScript({ type: 'frame', filePath: join(__dirname, 'dialog-preload.js') });
    this.dialogs = new BrowserDialogs({ window: options.window, isEnabled: () => this.isEnabled(), isPresented: page => this.shown?.handle === page.handle && options.window.isVisible() && !options.window.isMinimized(), navigationAllowed: url => this.assertNavigation(url), timeoutMs: options.dialogTimeoutMs });
    // A native parent keeps background tabs capturable. BaseWindow adds no
    // renderer; the same WebContentsView moves to the visible panel on demand.
    this.parking = new BaseWindow({ width: 1280, height: 800, show: false, frame: false, focusable: false, skipTaskbar: true, hiddenInMissionControl: true });
    this.installPermissions();
    this.browserSession.on('will-download', this.onDownload);
    this.bindWindow();
  }

  private bindWindow(): void {
    const options = this.options;
    for (const event of ['resize', 'show', 'hide', 'minimize', 'restore']) {
      const handler = (): void => { this.present(); this.publish(); };
      options.window.on(event as 'resize', handler);
      this.windowListeners.push([event, handler]);
    }
    const closed = (): void => { if (!options.managedWindows) this.dispose(); };
    options.window.on('closed', closed);
    this.windowListeners.push(['closed', closed]);
  }

  /** Move the shared native tab presentation while retaining each main window's intent. */
  adoptWindow(window: BrowserWindow): void {
    if (this.disposed || window.isDestroyed()) throw new BrowserError('unavailable', 'The browser window is unavailable.');
    if (window === this.options.window) return;
    const previous = this.options.window;
    if (!previous.isDestroyed()) {
      this.presentations.set(previous.webContents.id, { window: previous, current: this.current, bounds: this.bounds, wantedVisible: this.wantedVisible });
    }
    this.detach(); this.dialogs.present();
    if (!previous.isDestroyed()) this.options.emit('browser-use:state', json({ ...this.state(), presentationTransferred: true }));
    for (const [event, handler] of this.windowListeners) previous.removeListener(event as 'resize', handler);
    this.windowListeners.length = 0;
    this.settlePanelOpenWaiters(false); this.revision += 1; this.presentationRevision += 1;
    const saved = this.presentations.get(window.webContents.id);
    this.options.window = window; this.current = saved?.current ?? 'manual';
    this.bounds = saved?.bounds ?? { x: 0, y: 54, width: 800, height: 600 };
    this.wantedVisible = saved?.wantedVisible ?? false;
    this.bindWindow(); this.dialogs.setWindow(window); this.present(); this.publish();
  }

  /** Passive updates from an unfocused renderer must not steal the native child view. */
  passiveWindowRequest(window: BrowserWindow, channel: string, fields: BrowserObject): Json | undefined {
    if (window === this.options.window) return undefined;
    const id = window.webContents.id;
    let saved = this.presentations.get(id);
    if (!saved) { saved = { window, current: 'manual', bounds: { x: 0, y: 54, width: 800, height: 600 }, wantedVisible: false }; this.presentations.set(id, saved); }
    if (channel === 'browser-use:set-conversation') {
      if (typeof fields.conversationId !== 'string' || !fields.conversationId || fields.conversationId.length > 256) throw new BrowserError('invalid_request', 'conversationId is required.');
      if (saved.current !== fields.conversationId) saved.wantedVisible = false;
      saved.current = fields.conversationId;
    } else if (channel === 'browser-use:set-bounds') saved.bounds = browserBounds(fields.bounds);
    else if (channel === 'browser-use:hide') saved.wantedVisible = false;
    else if (channel !== 'browser-use:state' && channel !== 'browser-use:view-available') return undefined;
    if (channel === 'browser-use:view-available') return { available: this.isEnabled(), rendering: 'native' };
    const state = json({ ...this.state(saved.current), visible: false, presentationTransferred: true });
    return channel === 'browser-use:state' ? state : { ok: true, state };
  }

  forgetWindow(id: number): void { this.presentations.delete(id); }

  get configRoot(): string { return this.options.configRoot; }
  get windowId(): number { return this.options.window.webContents.id; }
  get conversationId(): string { return this.current; }
  get focusRevision(): number { return this.revision; }
  get downloadDirectory(): string { return resolve(this.options.configRoot, 'browser-downloads'); }
  isEnabled(): boolean { return !this.disposed && (this.options.enabled?.() ?? true); }

  private requireEnabled(): void {
    if (this.disposed) throw new BrowserError('unavailable', 'The browser manager has shut down.');
    if (!this.isEnabled()) throw new BrowserError('unavailable', 'Browser Use is disabled. Enable the Browser plugin to use it.');
  }

  private conversation(id: string): Conversation {
    let conversation = this.conversations.get(id);
    if (!conversation) { conversation = { tabs: [] }; this.conversations.set(id, conversation); }
    return conversation;
  }

  assertNavigation(input: unknown): string {
    const url = navigationUrl(input);
    if (this.options.navigationAllowed?.(url) === false) throw new BrowserError('refused_by_policy', 'This origin is blocked in browser settings.');
    return url;
  }

  private scope(request: BrowserScope = {}): { sessionId: string; focusRevision: number } {
    const scope = { sessionId: request.sessionId ?? this.current, focusRevision: request.focusRevision ?? this.revision };
    if (scope.sessionId !== this.current || scope.focusRevision !== this.revision) throw new BrowserError('stale_scope', 'The browser request belongs to a task that is no longer visible.');
    return scope;
  }

  setConversation(sessionId: string): BrowserObject {
    if (!sessionId || sessionId.length > 256) throw new BrowserError('invalid_request', 'conversationId is required.');
    if (sessionId !== this.current) {
      this.settlePanelOpenWaiters(false);
      this.current = sessionId;
      this.revision += 1;
      this.hide();
    }
    this.publish();
    return this.ok();
  }

  /**
   * Whether the page's WebContents still exists. A destroyed contents makes
   * Electron's `WebContentsView.webContents` getter answer undefined, so every
   * reader must go through this guard instead of touching the getter directly.
   */
  private alive(page: BrowserPage): boolean {
    const contents = page.view.webContents;
    return !!contents && !contents.isDestroyed();
  }

  state(sessionId = this.current): BrowserState {
    const conversation = this.conversation(sessionId);
    const active = conversation.active === undefined ? undefined : this.pages.get(conversation.active);
    const live = active && this.alive(active) ? active.view.webContents : undefined;
    return {
      enabled: this.isEnabled(), visible: sessionId === this.current && !!this.shown && this.isEnabled(),
      conversationId: sessionId, focusRevision: this.revision,
      ...(active ? { tabId: active.id } : {}), url: live?.getURL() || 'about:blank', title: live?.getTitle() || '',
      loading: live?.isLoading() ?? false,
      canGoBack: live?.navigationHistory.canGoBack() ?? false,
      canGoForward: live?.navigationHistory.canGoForward() ?? false,
      contentWidth: active?.contentWidth ?? 0,
      contentRevision: active?.contentRevision ?? 0,
      browserUseActive: this.activeOperations.has(sessionId),
      ...this.activeOperations.get(sessionId),
      tabs: this.listPages(sessionId).map(page => ({ id: page.id, active: page.handle === conversation.active,
        url: page.view.webContents.getURL() || 'about:blank', title: page.view.webContents.getTitle(), loading: page.view.webContents.isLoading() })),
    };
  }

  ok(sessionId = this.current): BrowserObject { return { ok: true, state: json(this.state(sessionId)) }; }
  publish(): void { if (!this.disposed) this.options.emit('browser-use:state', json(this.state())); }
  publishTabInventoryChange(): void { if (!this.disposed) this.options.emit('browser-use:state', json({ ...this.state(), tabInventoryChanged: true })); }

  beginOperation(sessionId: string, name: string): () => void {
    const route = { turnId: randomUUID(), source: 'agent', initiator: name };
    this.activeOperations.set(sessionId, route); this.publish();
    return () => {
      if (this.activeOperations.get(sessionId) === route) this.activeOperations.delete(sessionId);
      this.publish();
    };
  }

  listPages(sessionId: string): BrowserPage[] {
    return this.conversation(sessionId).tabs.map(id => this.pages.get(id)).filter((page): page is BrowserPage => !!page && this.alive(page));
  }

  private find(sessionId: string, handle?: number | string): BrowserPage | undefined {
    return handle === undefined
      ? this.pages.get(this.conversation(sessionId).active ?? -1)
      : [...this.pages.values()].find(entry => entry.handle === handle || entry.id === handle || entry.cdp.targetId === handle);
  }

  page(sessionId: string, handle?: number | string): BrowserPage {
    const page = this.find(sessionId, handle);
    if (!page || !this.alive(page)) throw new BrowserError('stale_tab', 'The tab is no longer open. Call tabs to obtain current handles.');
    if (page.owner !== sessionId) throw new BrowserError('refused_by_policy', 'The tab belongs to another task.');
    return page;
  }

  async ensurePage(sessionId: string): Promise<BrowserPage> {
    this.requireEnabled();
    const active = this.conversation(sessionId).active;
    if (active !== undefined) { const page = this.page(sessionId, active); await page.ready; return page; }
    return this.createTab(sessionId, 'about:blank');
  }

  private addPage(sessionId: string, contents?: WebContents, activate = true, keepInactive = false): BrowserPage {
    this.requireEnabled();
    const preferences: Electron.WebPreferences = {
      session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
      // With sandbox explicitly true this enables only the restricted preload
      // in child frames; it does not expose Node to any page/frame.
      nodeIntegrationInSubFrames: true, webviewTag: false, webSecurity: true, spellcheck: true,
    };
    const view = new WebContentsView(contents ? { webContents: contents } : { webPreferences: preferences });
    this.parking.contentView.addChildView(view);
    // Background pages retain a viewport without displaying a window.
    view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
    const handle = this.nextHandle++;
    const page: BrowserPage = { handle, id: `iab-${handle}`, owner: sessionId, view, contentsId: view.webContents.id, cdp: new PageDebugger(view.webContents), ready: Promise.resolve(), lastOpened: Date.now() };
    this.pages.set(handle, page);
    const conversation = this.conversation(sessionId);
    conversation.tabs.push(handle);
    if (activate || (!keepInactive && conversation.active === undefined)) conversation.active = handle;
    this.bindPage(page);
    // A fresh WebContents has no live document yet. Attaching then awaiting
    // Page.enable before loadURL deadlocks initialization on Electron 44.
    page.ready = (contents ? Promise.resolve() : view.webContents.loadURL('about:blank')).then(() => page.cdp.initialize());
    // A popup has no awaiting API caller. Keep its failed initialization observable.
    void page.ready.catch(error => { page.error = message(error); this.publish(); });
    this.present();
    this.publish();
    return page;
  }

  async createTab(sessionId: string, input: unknown = 'about:blank', activate = true): Promise<BrowserPage> {
    const url = this.assertNavigation(input);
    const page = this.addPage(sessionId, undefined, activate);
    try { await page.ready; await this.navigate(page, url); return page; }
    catch (error) { this.closeTab(sessionId, page.handle); throw error; }
  }

  async createPreviewTab(sessionId: string): Promise<BrowserPage> {
    const page = this.addPage(sessionId, undefined, false, true);
    try { await page.ready; return page; }
    catch (error) { this.closeTab(sessionId, page.handle); throw error; }
  }

  async navigate(page: BrowserPage, input: unknown, fields: BrowserObject = {}): Promise<void> {
    this.requireEnabled();
    const url = this.assertNavigation(input);
    this.page(page.owner, page.handle);
    await page.ready;
    this.requireEnabled(); this.page(page.owner, page.handle);
    page.error = undefined;
    await navigateForRead(page.cdp, url, fields);
    this.publish();
  }

  async historyAction(page: BrowserPage, action: 'back' | 'forward' | 'reload'): Promise<void> {
    this.requireEnabled();
    const contents = page.view.webContents;
    const history = contents.navigationHistory;
    if (action !== 'reload') {
      if (!(action === 'back' ? history.canGoBack() : history.canGoForward())) throw new BrowserError('not_found', `There is no ${action} history entry.`);
      this.assertNavigation(history.getAllEntries()[history.getActiveIndex() + (action === 'back' ? -1 : 1)]?.url);
    } else this.assertNavigation(contents.getURL());
    await new Promise<void>((resolveDone, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        contents.removeListener('did-stop-loading', loaded);
        contents.removeListener('destroyed', closed);
        if (error) reject(error); else resolveDone();
      };
      const loaded = (): void => finish();
      const closed = (): void => finish(new BrowserError('stale_tab', 'The page closed while navigating.'));
      const timer = setTimeout(() => finish(new BrowserError('timeout', 'Browser navigation timed out.')), 30_000);
      contents.once('did-stop-loading', loaded);
      contents.once('destroyed', closed);
      try {
        if (action === 'reload') contents.reload();
        else if (action === 'back') history.goBack();
        else history.goForward();
      } catch (error) { finish(new BrowserError('host_error', message(error))); }
    });
    this.publish();
  }

  private bindPage(page: BrowserPage): void {
    const contents = page.view.webContents;
    this.dialogs.bind(page);
    contents.on('page-favicon-updated', (_event, urls) => {
      const source = urls[0];
      page.faviconSource = source;
      page.faviconUrl = boundedTabFavicon(source);
      this.publish();
      if (!source || page.faviconUrl) return;
      try { this.assertNavigation(source); } catch { return; }
      void contents.executeJavaScriptInIsolatedWorld(999, [{ code: cachedTabFaviconScript(source) }]).then(value => {
        if (!this.alive(page) || page.faviconSource !== source) return;
        page.faviconUrl = boundedTabFavicon(value); this.publish();
      }).catch(() => {});
    });
    for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
      contents.on(event as 'did-start-loading', () => this.publish());
    }
    // A finished load is the first moment the layout metrics describe the new
    // document; the probe itself debounces so redirect chains measure once.
    contents.on('did-stop-loading', () => this.scheduleContentProbe(page));
    const guard = (event: Electron.Event, url: string): void => {
      try { this.assertNavigation(url); } catch (error) { event.preventDefault(); page.error = message(error); this.publish(); }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('render-process-gone', (_event, details) => { page.error = `Browser page stopped: ${details.reason}`; this.publish(); });
    contents.on('destroyed', () => this.forget(page));
    contents.setWindowOpenHandler(details => {
      try { this.assertNavigation(details.url); this.requireEnabled(); } catch { return { action: 'deny' }; }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webviewTag: false } },
        createWindow: options => {
          // Electron documents this adoption field in setWindowOpenHandler's
          // createWindow example; its constructor option type does not include it.
          const adopted = (options as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents;
          const child = this.addPage(page.owner, adopted, details.disposition !== 'background-tab');
          if (!adopted) void child.ready.then(() => this.navigate(child, details.url)).catch(error => { child.error = message(error); this.publish(); });
          if (page.owner === this.current && this.wantedVisible) this.present();
          return child.view.webContents;
        },
      };
    });
    contents.on('context-menu', (_event, params) => {
      if (this.shown !== page) return;
      const template: Electron.MenuItemConstructorOptions[] = [];
      if (params.isEditable) template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
      else if (params.selectionText) template.push({ role: 'copy' });
      if (template.length) Menu.buildFromTemplate(template).popup({ window: this.options.window });
    });
  }

  selectTab(sessionId: string, handle: number | string): BrowserObject {
    const page = this.page(sessionId, handle);
    page.lastOpened = Date.now();
    this.conversation(sessionId).active = page.handle;
    this.present(); this.publish();
    return this.ok(sessionId);
  }

  closeTab(sessionId: string, handle?: number | string): BrowserObject {
    const tracked = this.find(sessionId, handle);
    if (tracked && tracked.owner !== sessionId) throw new BrowserError('refused_by_policy', 'The tab belongs to another task.');
    // A page can destroy itself an instant before the user's close click lands
    // (window.close(), an OAuth popup tearing itself down). Closing what is
    // already gone is idempotent: retire the bookkeeping instead of reporting
    // a stale tab for an outcome the caller asked for.
    if (tracked && !this.alive(tracked)) {
      this.forget(tracked);
      tracked.cdp.dispose();
      return this.ok(sessionId);
    }
    if (!tracked && handle !== undefined) return this.ok(sessionId);
    const page = this.page(sessionId, handle);
    this.forget(page);
    page.cdp.dispose();
    const contents = page.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    return this.ok(sessionId);
  }

  private forget(page: BrowserPage): void {
    if (!this.pages.has(page.handle)) return;
    this.dialogs.release(page.contentsId);
    this.downloads.release(page.id);
    if (this.shown === page) this.detach();
    if (!this.parking.isDestroyed()) this.parking.contentView.removeChildView(page.view);
    this.pages.delete(page.handle);
    this.settlePanelOpenWaiters(false, waiter => waiter.sessionId === page.owner && waiter.targetId === page.id);
    const conversation = this.conversation(page.owner);
    const index = conversation.tabs.indexOf(page.handle);
    conversation.tabs = conversation.tabs.filter(handle => handle !== page.handle);
    if (conversation.active === page.handle) conversation.active = conversation.tabs[Math.min(index, conversation.tabs.length - 1)];
    if (!conversation.tabs.length && page.owner === this.current) { this.wantedVisible = false; this.presentationRevision += 1; }
    this.present(); this.publish();
  }

  async show(request: BrowserScope & { bounds?: unknown } = {}): Promise<BrowserObject> {
    this.requireEnabled();
    const scope = this.scope(request);
    const generation = ++this.presentationRevision;
    const page = request.targetId ? this.page(scope.sessionId, request.targetId) : await this.ensurePage(scope.sessionId);
    await page.ready;
    this.requireEnabled(); this.page(scope.sessionId, page.handle);
    this.scope(scope);
    if (generation !== this.presentationRevision) throw new BrowserError('stale_scope', 'The browser visibility request was superseded.');
    if (request.bounds !== undefined) this.bounds = browserBounds(request.bounds);
    this.conversation(scope.sessionId).active = page.handle;
    this.wantedVisible = true;
    this.present(); this.publish();
    if (this.shown === page && this.state(scope.sessionId).visible) {
      this.settlePanelOpenWaiters(true, waiter => waiter.sessionId === scope.sessionId
        && waiter.focusRevision === scope.focusRevision
        && (waiter.targetId === undefined || waiter.targetId === page.id));
    }
    return this.ok();
  }

  hide(): BrowserObject {
    this.presentationRevision += 1;
    this.wantedVisible = false;
    this.detach(); this.dialogs.present(); this.publish();
    return this.ok();
  }

  setBounds(bounds: unknown): BrowserObject {
    this.bounds = browserBounds(bounds);
    this.present();
    // The renderer resizes the panel to fit measured content; the viewport
    // change invalidates the previous measurement, so re-probe after it.
    const active = this.conversation(this.current).active;
    const shown = active === undefined ? undefined : this.pages.get(active);
    if (shown && this.shown === shown) this.scheduleContentProbe(shown);
    return this.ok();
  }

  private detach(): void {
    if (!this.shown) return;
    const page = this.shown;
    this.shown = undefined;
    if (!this.options.window.isDestroyed()) this.options.window.contentView.removeChildView(page.view);
    if (!this.disposed && !this.parking.isDestroyed() && this.alive(page)) {
      this.parking.contentView.addChildView(page.view);
      const bounds = page.view.getBounds();
      page.view.setBounds({ ...bounds, x: 0, y: 0 });
    }
  }

  private present(): void {
    const window = this.options.window;
    const active = this.conversation(this.current).active;
    const page = active === undefined ? undefined : this.pages.get(active);
    if (this.disposed || !this.wantedVisible || !this.isEnabled() || window.isDestroyed() || !window.isVisible() || window.isMinimized() || !page || !this.alive(page)) {
      this.detach(); this.dialogs.present(); return;
    }
    if (this.shown !== page) {
      this.detach();
      this.parking.contentView.removeChildView(page.view);
      window.contentView.addChildView(page.view); this.shown = page;
    }
    const zoom = window.webContents.getZoomFactor();
    const size = window.getContentBounds();
    const x = Math.min(Math.round(this.bounds.x * zoom), Math.max(0, size.width - 1));
    const y = Math.min(Math.round(this.bounds.y * zoom), Math.max(0, size.height - 1));
    page.view.setBounds({ x, y, width: Math.max(1, Math.min(Math.round(this.bounds.width * zoom), size.width - x)), height: Math.max(1, Math.min(Math.round(this.bounds.height * zoom), size.height - y)) });
    this.scheduleContentProbe(page);
    this.dialogs.present();
  }

  /**
   * Measure how wide the shown page's content really is so the renderer can
   * hand a horizontally overflowing page (a wide report table, a dashboard)
   * exactly that much panel width instead of clipping it behind a scrollbar.
   *
   * The measurement is self-stable rather than self-feeding: a fluid page
   * reports a content width equal to its viewport, which asks for exactly the
   * width it already has, while a fixed-width page reports its intrinsic
   * width until the viewport reaches it. Probes run after loads, attaches and
   * viewport changes — never on a timer — and are debounced so a redirect
   * chain or a drag settles before paying for one CDP round trip.
   */
  private scheduleContentProbe(page: BrowserPage): void {
    if (this.disposed || !this.alive(page)) return;
    if (this.contentProbeTimer) clearTimeout(this.contentProbeTimer);
    this.contentProbeTimer = setTimeout(() => {
      this.contentProbeTimer = undefined;
      void this.probeContentWidth(page);
    }, 350);
  }

  private async probeContentWidth(page: BrowserPage): Promise<void> {
    if (this.disposed || !this.alive(page) || this.shown !== page) return;
    const contents = page.view.webContents;
    if (contents.isLoading()) return;
    let width = 0;
    try {
      const metrics = object(await page.cdp.command('Page.getLayoutMetrics'));
      const size = object(metrics.cssContentSize ?? metrics.contentSize);
      const content = Number(size.width);
      const zoom = this.options.window.webContents.getZoomFactor() || 1;
      // The view bounds are physical pixels (they carry the window zoom); the
      // layout metrics are CSS pixels, so compare in CSS pixels.
      const viewport = page.view.getBounds().width / zoom;
      // A sub-pixel difference is rounding, not overflow: keep it at 0 so the
      // renderer never chases a fraction of a pixel.
      width = Number.isFinite(content) && content > viewport + 1 ? Math.ceil(content) : 0;
    } catch {
      return;
    }
    if (!this.alive(page)) return;
    page.contentWidth = width;
    page.contentRevision = (page.contentRevision ?? 0) + 1;
    this.publish();
  }

  async requestPanel(sessionId: string, page?: BrowserPage): Promise<boolean> {
    if (sessionId !== this.current || !this.isEnabled()) return false;
    const focusRevision = this.revision;
    const opened = new Promise<boolean>(resolve => {
      const waiter: PanelOpenWaiter = { sessionId, focusRevision, ...(page ? { targetId: page.id } : {}), resolve };
      waiter.timer = setTimeout(() => this.settlePanelOpenWaiters(false, candidate => candidate === waiter), BROWSER_PANEL_OPEN_ACK_TIMEOUT_MS);
      this.panelOpenWaiters.add(waiter);
    });
    this.options.emit('browser-use:open-panel', json({ sessionId, focusRevision, ...(page ? { targetId: page.id } : {}) }));
    this.publish();
    return opened;
  }

  private settlePanelOpenWaiters(opened: boolean, predicate: (waiter: PanelOpenWaiter) => boolean = () => true): void {
    for (const waiter of this.panelOpenWaiters) {
      if (!predicate(waiter)) continue;
      if (waiter.timer) clearTimeout(waiter.timer);
      this.panelOpenWaiters.delete(waiter);
      waiter.resolve(opened);
    }
  }

  surface(sessionId: string, page?: BrowserPage, screenshot?: BrowserObject): BrowserObject {
    const tabs = this.listPages(sessionId);
    const active = this.conversation(sessionId).active;
    const surface: BrowserObject = {
      kind: 'browserUse', backend: 'iab', browserId: 'iab', sessionId,
      openTabIds: tabs.map(tab => String(tab.handle)),
      ...(active === undefined ? {} : { activeTabId: String(active) }),
      ...(!tabs.length ? { sessionEnded: true } : {}),
    };
    if (page && this.pages.has(page.handle)) {
      surface.tabId = String(page.handle); surface.targetId = page.cdp.targetId;
      if (screenshot) surface.screenshot = { ...screenshot, tabId: String(page.handle) };
    }
    return surface;
  }

  private permissionKey(contents: WebContents | null, permission: string, url: string): string | undefined {
    const page = [...this.pages.values()].find(entry => entry.view.webContents === contents);
    if (!page || !this.isEnabled()) return undefined;
    try {
      const origin = new URL(this.assertNavigation(url)).origin;
      if (origin === 'null') return undefined;
      return JSON.stringify([page.owner, origin, permission]);
    } catch { return undefined; }
  }

  private installPermissions(): void {
    const keysFor = (contents: WebContents | null, permission: string, url: string, media: string[]): string[] => {
      const names = permission === 'media' ? media.length ? media.map(type => type === 'video' ? 'videoCapture' : type === 'audio' ? 'audioCapture' : 'media') : ['media'] : [permission];
      return names.map(name => this.permissionKey(contents, name, url)).filter((key): key is string => key !== undefined);
    };
    this.browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const keys = keysFor(contents, permission, requestingOrigin, details.mediaType ? [details.mediaType] : []);
      return this.decisions.granted(keys, permission);
    });
    this.browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestedUrl = details.requestingUrl || contents.getURL();
      const key = this.permissionKey(contents, permission, requestedUrl);
      const page = [...this.pages.values()].find(entry => entry.view.webContents === contents);
      if (!key || !page) { callback(false); return; }
      const media = object(details).mediaTypes;
      const keys = keysFor(contents, permission, requestedUrl, Array.isArray(media) ? media.filter((value): value is string => typeof value === 'string') : []);
      const request = { sessionId: page.owner, permission, origin: new URL(requestedUrl).origin, pageUrl: contents.getURL() };
      // Decided keys settle silently and an open question is shared, so a page
      // that re-asks on every visibility change cannot reopen the dialog.
      void this.decisions.resolve(keys,
        () => this.options.requestPermission?.(request) ?? Promise.resolve(false),
        () => !this.disposed && !contents.isDestroyed() && contents.getURL() === request.pageUrl && this.permissionKey(contents, permission, requestedUrl) === key && !this.decisions.denied(keys),
        permission,
      ).then(allowed => callback(allowed), () => callback(false));
    });
    this.browserSession.setDevicePermissionHandler(() => false);
  }

  async setPermission(page: BrowserPage, fields: BrowserObject): Promise<BrowserObject> {
    this.requireEnabled(); this.page(page.owner, page.handle);
    const command = permissionCommand(fields);
    if (command.method === 'Browser.resetPermissions') {
      this.decisions.forget(key => (JSON.parse(key) as string[])[0] === page.owner);
      return { reset: true, scope: 'task' };
    }
    const origin = new URL(this.assertNavigation(command.params.origin)).origin;
    const asked = command.method === 'Browser.grantPermissions' ? command.params.permissions as Json[] : [object(command.params.permission).name!];
    const aliases: Record<string, string> = { clipboardReadWrite: 'clipboard-read', clipboardSanitizedWrite: 'clipboard-sanitized-write', durableStorage: 'persistent-storage', midiSysex: 'midiSysex', pointerLock: 'pointerLock', audioCapture: 'audioCapture', videoCapture: 'videoCapture', camera: 'videoCapture', microphone: 'audioCapture' };
    const accepted = new Set(['geolocation','notifications','clipboard-read','clipboard-sanitized-write','persistent-storage','midi','midiSysex','pointerLock','fullscreen','audioCapture','videoCapture','sensors','idle-detection','local-fonts','screen-wake-lock']);
    const names = asked.map(name => aliases[String(name)] ?? String(name));
    if (names.some(name => !accepted.has(name))) throw new BrowserError('unavailable', `IAB does not implement these permission names: ${names.filter(name => !accepted.has(name)).join(', ')}.`);
    const setting = command.method === 'Browser.grantPermissions' ? 'granted' : String(command.params.setting);
    for (const name of names) {
      this.decisions.set([JSON.stringify([page.owner, origin, name])], setting);
    }
    return { origin, permissions: names, setting, scope: 'task', note: 'Chromium permission checks without an identifiable page remain denied. Device selection and operating-system permissions still apply.' };
  }

  private readonly onDownload = (event: Electron.Event, item: Electron.DownloadItem, contents: WebContents): void => {
    const page = [...this.pages.values()].find(entry => entry.view.webContents === contents);
    if (!page || !this.isEnabled()) { event.preventDefault(); return; }
    try { for (const url of item.getURLChain()) if (!/^(?:blob|data):/u.test(url)) this.assertNavigation(url); this.downloads.accept(page.id,item); }
    catch { event.preventDefault(); }
  };

  download(page: BrowserPage, fields: BrowserObject, waitMs: number, cdp: BrowserCdp = page.cdp): Promise<BrowserObject> {
    this.requireEnabled(); this.page(page.owner,page.handle);
    return this.downloads.download(page.id,cdp,fields,waitMs);
  }

  async clearData(kind = 'all'): Promise<BrowserObject> {
    if (!['all', 'cache', 'cookies'].includes(kind)) throw new BrowserError('invalid_request', 'clear-data kind must be all, cache or cookies.');
    if (kind === 'all' || kind === 'cache') await this.browserSession.clearCache();
    if (kind === 'all') { await this.browserSession.clearStorageData(); this.decisions.clear(); }
    if (kind === 'cookies') await this.browserSession.clearStorageData({ storages: ['cookies'] });
    this.browserSession.flushStorageData();
    return { ok: true };
  }

  releaseConversation(sessionId: string): void {
    this.settlePanelOpenWaiters(false, waiter => waiter.sessionId === sessionId);
    this.decisions.forget(key => (JSON.parse(key) as string[])[0] === sessionId);
    for (const page of this.listPages(sessionId)) this.closeTab(sessionId, page.handle);
    this.conversations.delete(sessionId);
    this.activeOperations.delete(sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settlePanelOpenWaiters(false);
    this.presentationRevision += 1;
    this.dialogs.dispose();
    this.browserSession.unregisterPreloadScript(this.dialogPreloadId);
    this.detach();
    for (const [event, handler] of this.windowListeners) this.options.window.removeListener(event as 'resize', handler);
    this.browserSession.removeListener('will-download', this.onDownload);
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.downloads.dispose();
    for (const page of [...this.pages.values()]) {
      if (!this.parking.isDestroyed()) this.parking.contentView.removeChildView(page.view);
      page.cdp.dispose();
      const contents = page.view.webContents;
      if (contents && !contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    }
    if (!this.parking.isDestroyed()) this.parking.close();
    this.pages.clear(); this.conversations.clear(); this.decisions.clear(); this.activeOperations.clear();
    this.browserSession.flushStorageData();
  }
}
