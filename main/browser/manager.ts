import { BaseWindow, Menu, WebContentsView, session as electronSession, shell, type BrowserWindow, type Session, type WebContents } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PageDebugger } from './cdp';
import { BrowserDialogs } from './dialogs';
import { NativeDownloads } from './native-downloads';
import { BrowserDataStore } from './history-store';
import type { BrowserCdp } from './page-operations';
import { permissionCommand } from './page-advanced';
import { BrowserPermissionDecisions } from './permission-requests';
import { browserBounds, navigationUrl } from './policy';
import { BrowserError, json, message, object, string, type BrowserBounds, type BrowserObject, type BrowserScope, type BrowserState } from './types';
import type { Json } from '../ipc/contract';
import { navigateForRead } from './task-operations';
import { BROWSER_PANEL_OPEN_ACK_TIMEOUT_MS } from './panel-contract';
import { boundedTabFavicon, cachedTabFaviconScript } from './tab-favicon';
import type { BrowserDataKind, BrowserDownloadAction, BrowserDownloadQuery, BrowserHistorySource, BrowserVisitSource } from '../../contracts/browser-history';

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
const AGENT_INPUT_OPERATIONS = new Set(['click', 'type', 'form_input', 'computer', 'locator', 'press', 'file_upload']);
const AGENT_NAVIGATION_OPERATIONS = new Set(['navigate']);
const AGENT_POPUP_OPERATIONS = new Set([...AGENT_INPUT_OPERATIONS, 'eval', 'navigate']);
export type BrowserAuthorizationResource = 'browsing' | 'downloads' | 'uploads' | 'siteTools' | 'debug';
export interface BrowserDownloadPathRequest { defaultPath: string; filename: string; url: string }
export interface BrowserManagerOptions {
  window: BrowserWindow;
  configRoot: string;
  emit: (channel: string, payload: Json) => void;
  /** Agent/plugin authorization. Manual browser surfaces do not depend on it. */
  enabled?: () => boolean;
  /** Manual built-in browser availability. Runtime shutdown clears this. */
  available?: () => boolean;
  navigationAllowed?: (url: string) => boolean;
  /**
   * Persistent origin policy. The manager consults this before task-scoped
   * permission decisions; undefined means the page should ask.
   */
  sitePermission?: (origin: string, permission: string) => 'granted' | 'denied' | undefined;
  /**
   * Access check for agent operations and native downloads. Task-owned
   * navigation itself stays on the normal host path; the operation layer calls
   * authorize for each resource it actually consumes.
   */
  authorize?: (sessionId: string, url: string, resource: BrowserAuthorizationResource, signal?: AbortSignal) => Promise<void> | void;
  requestPermission?: (request: BrowserPermissionRequest) => Promise<boolean>;
  downloadDirectory?: () => string;
  promptForUserDownloads?: () => boolean;
  chooseDownloadPath?: (request: BrowserDownloadPathRequest) => Promise<string | null | undefined>;
  openDownloadPath?: (path: string) => Promise<string> | string;
  revealDownloadPath?: (path: string) => void;
  dialogTimeoutMs?: number;
  /** Runtime owns registered main windows and their lifetime. */
  managedWindows?: boolean;
}

export type BrowserOperationLease = (() => void) & { readonly signal: AbortSignal };

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
  private readonly operationSignals = new Map<string, AbortSignal | undefined>();
  private readonly operationControllers = new Map<string, Set<AbortController>>();
  /** Invalidated whenever agent settings change; queued calls retain the old generation. */
  private control = new AbortController();
  private readonly agentVisits = new Map<number, Set<string>>();
  private readonly agentPageLeases = new Set<number>();
  private readonly agentInputPages = new Set<number>();
  private readonly approvedAgentNavigations = new Map<string, string[]>();
  private readonly pendingMainFrameAuthorizations = new Map<number, AbortSignal | undefined>();
  private readonly pendingNavigationCancels = new Set<() => void>();
  private readonly pendingVisits = new Map<number, string>();
  private readonly suppressedReloads = new Set<number>();
  private readonly panelOpenWaiters = new Set<PanelOpenWaiter>();
  private readonly data: BrowserDataStore;
  private readonly downloads: NativeDownloads;
  private readonly windowListeners: Array<[string, () => void]> = [];
  private nextHandle = 1;
  private contentProbeTimer: ReturnType<typeof setTimeout> | undefined;
  private current = 'manual';
  private revision = 0;
  private authorizationEpoch = 0;
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
    this.data = new BrowserDataStore(options.configRoot);
    this.downloads = new NativeDownloads(this.browserSession, {
      directory: () => this.downloadDirectory,
      assertUrl: url => this.assertNavigation(url),
      history: this.data,
      ...(options.promptForUserDownloads ? { promptForUserDownloads: options.promptForUserDownloads } : {}),
      ...(options.chooseDownloadPath ? { chooseDownloadPath: options.chooseDownloadPath } : {}),
      ...(options.authorize ? { authorize: (sessionId, url, resource, signal) => options.authorize!(sessionId, url, resource, signal) } : {}),
      changed: event => options.emit('browser-use:downloads-changed', json(event)),
    });
    this.dialogPreloadId = this.browserSession.registerPreloadScript({ type: 'frame', filePath: join(__dirname, 'dialog-preload.js') });
    this.dialogs = new BrowserDialogs({ window: options.window, isEnabled: () => this.isAvailable(), isPresented: page => this.shown?.handle === page.handle && options.window.isVisible() && !options.window.isMinimized(), navigationAllowed: url => this.assertNavigation(url), timeoutMs: options.dialogTimeoutMs });
    // A native parent keeps background tabs capturable. BaseWindow adds no
    // renderer; the same WebContentsView moves to the visible panel on demand.
    this.parking = new BaseWindow({ width: 1280, height: 800, show: false, frame: false, focusable: false, skipTaskbar: true, hiddenInMissionControl: true });
    this.installPermissions();
    this.installNavigationGate();
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
    if (channel === 'browser-use:view-available') return { available: this.isAvailable(), rendering: 'native' };
    const state = json({ ...this.state(saved.current), visible: false, presentationTransferred: true });
    return channel === 'browser-use:state' ? state : { ok: true, state };
  }

  forgetWindow(id: number): void { this.presentations.delete(id); }

  get configRoot(): string { return this.options.configRoot; }
  get windowId(): number { return this.options.window.webContents.id; }
  get conversationId(): string { return this.current; }
  get focusRevision(): number { return this.revision; }
  get downloadDirectory(): string {
    const configured = this.options.downloadDirectory?.();
    return configured && configured.trim() ? resolve(configured) : resolve(this.options.configRoot, 'browser-downloads');
  }
  /** Agent/plugin gate. Agent operations must reject when this is false. */
  isEnabled(): boolean { return !this.disposed && (this.options.enabled?.() ?? true); }

  /** Manual built-in browser availability. Plugin off keeps this true. */
  isAvailable(): boolean { return !this.disposed && (this.options.available?.() ?? true); }

  /** Persistent site policy; an undefined result means the page should ask. */
  sitePermission(origin: string, permission: string): 'granted' | 'denied' | undefined {
    try { return this.options.sitePermission?.(origin, permission); }
    catch { return undefined; }
  }

  /**
   * Ask the host's policy layer before an agent consumes a resource. Navigation
   * itself is gated by the operation that initiated it; this method records the
   * agent attribution used by browsing history and forwards the policy check.
   */
  async authorize(
    sessionId: string,
    input: unknown,
    resource: BrowserAuthorizationResource = 'browsing',
    signal?: AbortSignal,
  ): Promise<void> {
    this.requireEnabled();
    const url = this.assertNavigation(input);
    const epoch = this.authorizationEpoch;
    signal?.throwIfAborted();
    await this.options.authorize?.(sessionId, url, resource, signal);
    if (epoch !== this.authorizationEpoch || signal?.aborted) {
      throw new BrowserError('cancelled', 'Browser access approval was superseded.');
    }
    if (resource === 'browsing') {
      const approved = this.approvedAgentNavigations.get(sessionId) ?? [];
      approved.push(url);
      this.approvedAgentNavigations.set(sessionId, approved.slice(-32));
    }
  }

  /** Settings changes take effect for permission questions already remembered. */
  refreshPermissions(): void {
    this.control.abort();
    this.abortAgentOperations();
    this.control = new AbortController();
    this.authorizationEpoch++;
    this.decisions.clear();
    this.approvedAgentNavigations.clear();
    this.agentVisits.clear();
    this.agentPageLeases.clear();
    this.pendingMainFrameAuthorizations.clear();
    for (const cancel of [...this.pendingNavigationCancels]) cancel();
    this.pendingNavigationCancels.clear();
  }

  private markAgentVisit(page: BrowserPage, url: string): void {
    const visits = this.agentVisits.get(page.handle) ?? new Set<string>();
    visits.add(url);
    this.agentVisits.set(page.handle, visits);
  }

  private navigationSource(page: BrowserPage, url: string): BrowserVisitSource {
    const visits = this.agentVisits.get(page.handle);
    if (!visits?.delete(url)) return 'other';
    if (!visits.size) this.agentVisits.delete(page.handle);
    return 'agent';
  }

  private consumeApprovedNavigation(sessionId: string, url: string): boolean {
    const approved = this.approvedAgentNavigations.get(sessionId);
    if (!approved) return false;
    const index = approved.indexOf(url);
    if (index < 0) return false;
    approved.splice(index, 1);
    if (!approved.length) this.approvedAgentNavigations.delete(sessionId);
    return true;
  }

  /**
   * Main-frame requests are paused at the network layer while the host decides.
   * The callback lets the original request continue untouched, so method, body,
   * cookies and redirect semantics never pass through a replay.
   */
  private installNavigationGate(): void {
    this.browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'], types: ['mainFrame'] }, (details, callback) => {
      const page = [...this.pages.values()].find(entry => entry.contentsId === details.webContentsId);
      if (!page || !this.isAvailable()) { callback({ cancel: true }); return; }
      try { this.assertNavigation(details.url); }
      catch { callback({ cancel: true }); return; }
      const hasPageLease = this.agentPageLeases.has(page.handle) || this.pendingMainFrameAuthorizations.has(page.handle);
      const signal = this.pendingMainFrameAuthorizations.has(page.handle)
        ? this.pendingMainFrameAuthorizations.get(page.handle)
        : this.operationSignals.get(page.owner);
      if (this.consumeApprovedNavigation(page.owner, details.url)) {
        if (!this.isEnabled() || signal?.aborted) { callback({ cancel: true }); return; }
        this.agentPageLeases.add(page.handle);
        this.markAgentVisit(page, details.url);
        callback({});
        return;
      }
      const agentContext = this.agentInputPages.has(page.handle) || hasPageLease;
      // No lease/input means a human navigation. It remains available when the
      // agent is off. An owned agent surface, however, must obey the gate.
      if (!agentContext) { callback({}); return; }
      if (!this.isEnabled()) { callback({ cancel: true }); return; }
      if (signal?.aborted) { callback({ cancel: true }); return; }
      // Without a host policy callback the page is still an agent surface:
      // attribute the visit and let the navigation proceed. A configured
      // callback owns the decision below.
      if (!this.options.authorize) {
        this.markAgentVisit(page, details.url);
        callback({});
        return;
      }
      let settled = false;
      const finish = (cancel: boolean): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', aborted);
        this.pendingNavigationCancels.delete(cancelPending);
        callback(cancel ? { cancel: true } : {});
      };
      const aborted = (): void => finish(true);
      const cancelPending = (): void => finish(true);
      if (signal?.aborted) { finish(true); return; }
      signal?.addEventListener('abort', aborted, { once: true });
      this.pendingNavigationCancels.add(cancelPending);
      void Promise.resolve(this.options.authorize(page.owner, details.url, 'browsing', signal)).then(
        () => {
          if (this.disposed || !this.alive(page)) finish(true);
          else {
            this.agentPageLeases.add(page.handle);
            this.markAgentVisit(page, details.url);
            finish(false);
          }
        },
        () => finish(true),
      );
    });
  }

  private requireEnabled(): void {
    if (this.disposed) throw new BrowserError('unavailable', 'The browser manager has shut down.');
    if (!this.isEnabled()) throw new BrowserError('unavailable', 'Browser Use is disabled. Enable the Browser plugin to use it.');
  }

  private requireAvailable(): void {
    if (this.disposed) throw new BrowserError('unavailable', 'The browser runtime is unavailable.');
    if (!this.isAvailable()) throw new BrowserError('unavailable', 'The built-in browser is unavailable.');
  }

  /** Abort agent work only; manual pages, downloads and navigation stay alive. */
  abortAgentOperations(sessionId?: string): void {
    const ids = sessionId === undefined ? [...this.operationControllers.keys()] : [sessionId];
    for (const id of ids) for (const controller of [...(this.operationControllers.get(id) ?? [])]) controller.abort();
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
      enabled: this.isAvailable(), visible: sessionId === this.current && !!this.shown && this.isAvailable(),
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

  /** Capture the current agent-control generation before entering the queue. */
  agentControlSignal(signal?: AbortSignal): AbortSignal {
    if (signal?.aborted) return signal;
    return signal ? AbortSignal.any([signal, this.control.signal]) : this.control.signal;
  }

  beginOperation(sessionId: string, name: string, signal?: AbortSignal): BrowserOperationLease {
    this.requireEnabled();
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
    const route = { turnId: randomUUID(), source: 'agent', initiator: name };
    const activePage = this.conversation(sessionId).active;
    const inputPage = activePage !== undefined && AGENT_INPUT_OPERATIONS.has(name) ? activePage : undefined;
    const navigationPage = activePage !== undefined && AGENT_NAVIGATION_OPERATIONS.has(name) ? activePage : undefined;
    if (inputPage !== undefined) this.agentInputPages.add(inputPage);
    if (navigationPage !== undefined) this.agentPageLeases.add(navigationPage);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const controllers = this.operationControllers.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller); this.operationControllers.set(sessionId, controllers);
    const previousRoute = this.activeOperations.get(sessionId);
    const previousSignal = this.operationSignals.get(sessionId);
    if (!previousRoute) this.activeOperations.set(sessionId, route);
    this.operationSignals.set(sessionId, controller.signal);
    this.publish();
    const finish = (() => {
      signal?.removeEventListener('abort', abort);
      controllers.delete(controller);
      if (!controllers.size) this.operationControllers.delete(sessionId);
      if (this.activeOperations.get(sessionId) === route) this.activeOperations.delete(sessionId);
      if (this.operationSignals.get(sessionId) === controller.signal) {
        if (previousRoute && previousSignal !== undefined) this.operationSignals.set(sessionId, previousSignal);
        else this.operationSignals.delete(sessionId);
      }
      if (inputPage !== undefined) this.agentInputPages.delete(inputPage);
      if (navigationPage !== undefined) this.agentPageLeases.delete(navigationPage);
      this.approvedAgentNavigations.delete(sessionId);
      this.publish();
    }) as BrowserOperationLease;
    return Object.assign(finish, { signal: controller.signal });
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

  async ensurePage(sessionId: string, signal?: AbortSignal): Promise<BrowserPage> {
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
    this.requireAvailable();
    const active = this.conversation(sessionId).active;
    if (active !== undefined) { const page = this.page(sessionId, active); await page.ready; return page; }
    return this.createTab(sessionId, 'about:blank', true, signal);
  }

  private addPage(sessionId: string, contents?: WebContents, activate = true, keepInactive = false): BrowserPage {
    this.requireAvailable();
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

  async createTab(sessionId: string, input: unknown = 'about:blank', activate = true, signal?: AbortSignal): Promise<BrowserPage> {
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
    const url = this.assertNavigation(input);
    const page = this.addPage(sessionId, undefined, activate);
    try { await page.ready; if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.'); await this.navigate(page, url, {}, signal); return page; }
    catch (error) { this.closeTab(sessionId, page.handle); throw error; }
  }

  async createPreviewTab(sessionId: string): Promise<BrowserPage> {
    const page = this.addPage(sessionId, undefined, false, true);
    try { await page.ready; return page; }
    catch (error) { this.closeTab(sessionId, page.handle); throw error; }
  }

  async navigate(page: BrowserPage, input: unknown, fields: BrowserObject = {}, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
    this.requireAvailable();
    const url = this.assertNavigation(input);
    this.page(page.owner, page.handle);
    await page.ready;
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
    this.requireAvailable(); this.page(page.owner, page.handle);
    page.error = undefined;
    await navigateForRead(page.cdp, url, fields, signal);
    this.publish();
  }

  async historyAction(page: BrowserPage, action: 'back' | 'forward' | 'reload', signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
    this.requireAvailable();
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
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolveDone();
      };
      const loaded = (): void => finish();
      const closed = (): void => finish(new BrowserError('stale_tab', 'The page closed while navigating.'));
      const aborted = (): void => finish(new BrowserError('cancelled', 'The browser operation was cancelled.'));
      const timer = setTimeout(() => finish(new BrowserError('timeout', 'Browser navigation timed out.')), 30_000);
      contents.once('did-stop-loading', loaded);
      contents.once('destroyed', closed);
      signal?.addEventListener('abort', aborted, { once: true });
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
      if (page.faviconUrl?.startsWith('data:image/')) {
        this.data.queueVisitUpdate(page.owner, contents.getURL(), { faviconDataUrl: page.faviconUrl });
      }
      if (!source || page.faviconUrl) return;
      try { this.assertNavigation(source); } catch { return; }
      void contents.executeJavaScriptInIsolatedWorld(999, [{ code: cachedTabFaviconScript(source) }]).then(value => {
        if (!this.alive(page) || page.faviconSource !== source) return;
        page.faviconUrl = boundedTabFavicon(value); this.publish();
        if (page.faviconUrl?.startsWith('data:image/')) {
          this.data.queueVisitUpdate(page.owner, contents.getURL(), { faviconDataUrl: page.faviconUrl });
        }
      }).catch(() => {});
    });
    for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) {
      contents.on(event as 'did-start-loading', () => this.publish());
    }
    contents.on('page-title-updated', () => {
      const url = contents.getURL();
      if (!this.isHistoryUrl(url)) return;
      this.data.queueVisitUpdate(page.owner, url, { title: contents.getTitle() || url });
    });
    contents.on('did-navigate', (_event, url) => {
      this.pendingVisits.set(page.handle, url);
      this.publish();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      this.publish();
      if (isMainFrame) this.scheduleVisit(page, url);
    });
    // A finished load is the first moment the layout metrics describe the new
    // document; the probe itself debounces so redirect chains measure once.
    contents.on('did-stop-loading', () => {
      const pending = this.pendingVisits.get(page.handle);
      this.pendingVisits.delete(page.handle);
      if (this.isHistoryUrl(contents.getURL())) {
        this.agentPageLeases.delete(page.handle);
        this.pendingMainFrameAuthorizations.delete(page.handle);
      }
      if (!this.suppressedReloads.delete(page.handle)) this.scheduleVisit(page, pending || contents.getURL());
      this.scheduleContentProbe(page);
    });
    const guard = (event: Electron.Event, url: string): void => {
      try { this.assertNavigation(url); }
      catch (error) { event.preventDefault(); page.error = message(error); this.publish(); }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('render-process-gone', (_event, details) => { page.error = `Browser page stopped: ${details.reason}`; this.publish(); });
    contents.on('destroyed', () => this.forget(page));
    contents.setWindowOpenHandler(details => {
      try { this.assertNavigation(details.url); this.requireAvailable(); } catch { return { action: 'deny' }; }
      const agentPopup = this.activeOperations.has(page.owner)
        && AGENT_POPUP_OPERATIONS.has(this.activeOperations.get(page.owner)?.initiator ?? '');
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: { session: this.browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, webviewTag: false } },
        createWindow: options => {
          // Electron documents this adoption field in setWindowOpenHandler's
          // createWindow example; its constructor option type does not include it.
          const adopted = (options as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }).webContents;
          const child = this.addPage(page.owner, adopted, details.disposition !== 'background-tab');
          if (agentPopup) {
            this.pendingMainFrameAuthorizations.set(child.handle, this.operationSignals.get(page.owner));
            this.agentPageLeases.add(child.handle);
          }
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

  private isHistoryUrl(url: string): boolean {
    try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
  }

  private scheduleVisit(page: BrowserPage, url: string): void {
    if (!this.isHistoryUrl(url)) return;
    // A pushState page can update its title in the same task; recording on the
    // next turn captures that title without delaying navigation.
    setTimeout(() => {
      if (this.disposed || !this.alive(page) || page.view.webContents.getURL() !== url) return;
      const contents = page.view.webContents;
      this.data.recordVisit({
        sessionId: page.owner,
        url,
        title: contents.getTitle() || url,
        source: this.navigationSource(page, url),
        ...(page.faviconUrl?.startsWith('data:image/') ? { faviconDataUrl: page.faviconUrl } : {}),
      });
    }, 0);
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
    this.requireAvailable();
    const scope = this.scope(request);
    const generation = ++this.presentationRevision;
    const page = request.targetId ? this.page(scope.sessionId, request.targetId) : await this.ensurePage(scope.sessionId);
    await page.ready;
    this.requireAvailable(); this.page(scope.sessionId, page.handle);
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
    const window = this.options.window;
    // Keyboard focus stays with a WebContents after its view leaves the window.
    // Hand it back to the window's own page, or a dialog that took the browser's
    // place on screen never receives Enter or Escape.
    const focused = this.alive(page) && page.view.webContents.isFocused();
    if (!window.isDestroyed()) window.contentView.removeChildView(page.view);
    if (!this.disposed && !this.parking.isDestroyed() && this.alive(page)) {
      this.parking.contentView.addChildView(page.view);
      const bounds = page.view.getBounds();
      page.view.setBounds({ ...bounds, x: 0, y: 0 });
    }
    if (focused && !window.isDestroyed() && window.isFocused()) window.webContents.focus();
  }

  /**
   * A still image of the page that is on screen right now. The renderer lays it
   * under the native view before an HTML overlay asks the view to step aside, so
   * the panel dims with the rest of the window instead of turning blank. It reads
   * the view's own compositor output and never creates, selects or wakes a page.
   */
  async capturePresented(fields: BrowserObject = {}): Promise<BrowserObject> {
    const page = this.shown;
    const window = this.options.window;
    if (!page || !this.alive(page) || window.isDestroyed() || !window.isVisible() || window.isMinimized()) {
      throw new BrowserError('not_found', 'No browser page is on screen.');
    }
    const quality = typeof fields.quality === 'number' && Number.isInteger(fields.quality) && fields.quality >= 0 && fields.quality <= 100 ? fields.quality : 80;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const image = await Promise.race([
      page.view.webContents.capturePage(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserError('timeout', 'Browser capture timed out.')), 1500); }),
    ]).finally(() => clearTimeout(timer));
    if (this.shown !== page || !this.alive(page)) throw new BrowserError('stale_tab', 'The page left the screen while it was captured.');
    if (image.isEmpty()) throw new BrowserError('host_error', 'The browser returned an empty capture.');
    return { tabId: page.id, dataUrl: `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}` };
  }

  private present(): void {
    const window = this.options.window;
    const active = this.conversation(this.current).active;
    const page = active === undefined ? undefined : this.pages.get(active);
    if (this.disposed || !this.wantedVisible || !this.isAvailable() || window.isDestroyed() || !window.isVisible() || window.isMinimized() || !page || !this.alive(page)) {
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
    this.suppressedReloads.delete(page.handle);
    this.pendingVisits.delete(page.handle);
    page.contentWidth = width;
    page.contentRevision = (page.contentRevision ?? 0) + 1;
    this.publish();
  }

  async requestPanel(sessionId: string, page?: BrowserPage): Promise<boolean> {
    if (sessionId !== this.current || !this.isAvailable()) return false;
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
    if (!page || !this.isAvailable()) return undefined;
    try {
      const origin = new URL(this.assertNavigation(url)).origin;
      if (origin === 'null') return undefined;
      return JSON.stringify([page.owner, origin, permission]);
    } catch { return undefined; }
  }

  private installPermissions(): void {
    const namesFor = (permission: string, media: string[]): string[] => {
      if (permission !== 'media') return [permission];
      return media.length ? media.map(type => type === 'video' ? 'videoCapture' : type === 'audio' ? 'audioCapture' : 'media') : ['media'];
    };
    const keysFor = (contents: WebContents | null, permission: string, url: string, media: string[]): string[] => {
      return namesFor(permission, media).map(name => this.permissionKey(contents, name, url)).filter((key): key is string => key !== undefined);
    };
    this.browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const media = details.mediaType ? [details.mediaType] : [];
      const names = namesFor(permission, media);
      const policy = this.persistentPermission(requestingOrigin, names);
      if (policy !== undefined) return policy;
      const keys = keysFor(contents, permission, requestingOrigin, media);
      return this.decisions.granted(keys, permission);
    });
    this.browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestedUrl = details.requestingUrl || contents.getURL();
      let origin = '';
      try { origin = new URL(requestedUrl).origin; } catch { /* not a grantable page */ }
      const media = object(details).mediaTypes;
      const mediaTypes = Array.isArray(media) ? media.filter((value): value is string => typeof value === 'string') : [];
      const names = namesFor(permission, mediaTypes);
      const policy = origin ? this.persistentPermission(origin, names) : undefined;
      if (policy !== undefined) { callback(policy); return; }
      const key = this.permissionKey(contents, permission, requestedUrl);
      const page = [...this.pages.values()].find(entry => entry.view.webContents === contents);
      if (!key || !page) { callback(false); return; }
      const keys = keysFor(contents, permission, requestedUrl, mediaTypes);
      const request = { sessionId: page.owner, permission, origin, pageUrl: contents.getURL() };
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

  private persistentPermission(origin: string, names: string[]): boolean | undefined {
    try { origin = new URL(origin).origin; }
    catch { return undefined; }
    let granted = 0;
    for (const name of names) {
      const decision = this.sitePermission(origin, name);
      if (decision === 'denied') return false;
      if (decision === 'granted') granted += 1;
    }
    return granted === names.length && names.length > 0 ? true : undefined;
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
    if (!page || !this.isAvailable()) { event.preventDefault(); return; }
    const chain = item.getURLChain().filter(url => !/^(?:blob|data):/u.test(url));
    try { for (const url of chain) this.assertNavigation(url); }
    catch { event.preventDefault(); return; }
    const source = this.agentInputPages.has(page.handle) || this.agentPageLeases.has(page.handle) ? 'agent' : 'other';
    const initiatorUrl = page.view.webContents.getURL();
    const signal = source === 'agent' ? this.operationSignals.get(page.owner) : undefined;
    try { item.pause(); } catch { /* The item may already be terminal. */ }
    void this.downloads.accept(page.id, page.owner, item, source, initiatorUrl, signal).catch(() => {
      try { item.cancel(); } catch { /* already canceled */ }
    });
  };

  download(
    page: BrowserPage,
    fields: BrowserObject,
    waitMs: number,
    cdp: BrowserCdp = page.cdp,
    signal?: AbortSignal,
  ): Promise<BrowserObject> {
    this.requireAvailable(); this.page(page.owner,page.handle);
    return this.downloads.download(
      page.id, page.owner, cdp, fields, waitMs,
      signal,
      page.view.webContents.getURL(),
    );
  }

  history(fields: BrowserObject = {}): BrowserObject {
    return json(this.data.history({
      ...(typeof fields.query === 'string' ? { query: fields.query } : {}),
      ...(typeof fields.source === 'string' ? { source: fields.source as BrowserHistorySource } : {}),
      ...(typeof fields.cursor === 'string' ? { cursor: fields.cursor } : {}),
      ...(typeof fields.limit === 'number' ? { limit: fields.limit } : {}),
    })) as BrowserObject;
  }

  historyRemove(ids: unknown): BrowserObject {
    this.data.removeVisits(ids);
    return { ok: true };
  }

  downloadHistory(fields: BrowserObject = {}): BrowserObject {
    return this.downloads.history({
      ...(typeof fields.query === 'string' ? { query: fields.query } : {}),
      ...(typeof fields.cursor === 'string' ? { cursor: fields.cursor } : {}),
      ...(typeof fields.limit === 'number' ? { limit: fields.limit } : {}),
    });
  }

  async downloadAction(action: BrowserDownloadAction, id: string): Promise<BrowserObject> {
    const entryId = string(id, 'id');
    if (!['open', 'reveal', 'pause', 'resume', 'cancel', 'remove'].includes(action)) {
      throw new BrowserError('invalid_request', 'Unknown download action.');
    }
    if (action === 'pause') this.downloads.pause(entryId);
    else if (action === 'resume') this.downloads.resume(entryId);
    else if (action === 'cancel') this.downloads.cancel(entryId);
    else if (action === 'remove') this.downloads.remove(entryId);
    else {
      const entry = this.downloads.record(entryId);
      if (!entry?.path) throw new BrowserError('not_found', 'The downloaded file is not available.');
      if (entry.state !== 'completed') throw new BrowserError('unavailable', 'Only a completed download can be opened.');
      if (!existsSync(entry.path)) throw new BrowserError('not_found', 'The downloaded file no longer exists.');
      if (action === 'open') {
        const failure = await (this.options.openDownloadPath?.(entry.path) ?? shell.openPath(entry.path));
        if (failure) throw new BrowserError('host_error', failure);
      } else if (this.options.revealDownloadPath) this.options.revealDownloadPath(entry.path);
      else shell.showItemInFolder(entry.path);
    }
    return { ok: true };
  }

  async clearData(kind: string = 'all'): Promise<BrowserObject> {
    if (!['all', 'cache', 'cookies', 'siteData', 'downloads', 'history'].includes(kind)) {
      throw new BrowserError('invalid_request', 'clear-data kind must be all, cookies, siteData, cache, downloads or history.');
    }
    let visits = 0;
    let downloads = 0;
    if (kind === 'all' || kind === 'cache') await this.browserSession.clearCache();
    if (kind === 'all') {
      await this.browserSession.clearStorageData();
      this.decisions.clear();
      visits = this.data.clearVisits().removed;
      downloads = this.downloads.clearTerminal().removed;
    } else if (kind === 'cookies') {
      await this.browserSession.clearStorageData({ storages: ['cookies'] });
    } else if (kind === 'siteData') {
      await this.browserSession.clearStorageData({
        storages: ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'],
      });
    } else if (kind === 'history') {
      visits = this.data.clearVisits().removed;
    } else if (kind === 'downloads') {
      downloads = this.downloads.clearTerminal().removed;
    }
    this.browserSession.flushStorageData();
    let reloaded = 0;
    if (kind === 'all') {
      for (const page of this.pages.values()) this.suppressedReloads.add(page.handle);
      for (const page of [...this.pages.values()]) {
        if (!this.alive(page)) continue;
        try { page.view.webContents.reload(); reloaded += 1; } catch { /* closed while clearing */ }
      }
      // A failed or canceled reload must not suppress the user's next visit.
      setTimeout(() => {
        for (const handle of [...this.suppressedReloads]) {
          const page = this.pages.get(handle);
          if (!page || !this.alive(page) || !page.view.webContents.isLoading()) this.suppressedReloads.delete(handle);
        }
      }, 5_000);
    }
    return { ok: true, visits, downloads, reloaded };
  }

  releaseConversation(sessionId: string): void {
    this.abortAgentOperations(sessionId);
    this.operationControllers.delete(sessionId);
    this.settlePanelOpenWaiters(false, waiter => waiter.sessionId === sessionId);
    this.decisions.forget(key => (JSON.parse(key) as string[])[0] === sessionId);
    this.authorizationEpoch++;
    for (const cancel of [...this.pendingNavigationCancels]) cancel();
    this.pendingNavigationCancels.clear();
    this.approvedAgentNavigations.delete(sessionId);
    this.operationSignals.delete(sessionId);
    for (const page of this.listPages(sessionId)) {
      this.agentVisits.delete(page.handle);
      this.agentPageLeases.delete(page.handle);
      this.agentInputPages.delete(page.handle);
      this.pendingMainFrameAuthorizations.delete(page.handle);
    }
    this.data.flushVisitUpdates();
    for (const page of this.listPages(sessionId)) this.closeTab(sessionId, page.handle);
    this.conversations.delete(sessionId);
    this.activeOperations.delete(sessionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.control.abort();
    this.abortAgentOperations();
    this.operationControllers.clear();
    this.operationSignals.clear();
    this.settlePanelOpenWaiters(false);
    this.presentationRevision += 1;
    this.dialogs.dispose();
    this.browserSession.unregisterPreloadScript(this.dialogPreloadId);
    this.detach();
    for (const [event, handler] of this.windowListeners) this.options.window.removeListener(event as 'resize', handler);
    this.browserSession.removeListener('will-download', this.onDownload);
    this.browserSession.webRequest.onBeforeRequest(null);
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    for (const cancel of [...this.pendingNavigationCancels]) cancel();
    this.pendingNavigationCancels.clear();
    this.data.flushVisitUpdates();
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
