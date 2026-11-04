import { BaseWindow, BrowserWindow, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PageDebugger } from './cdp';
import { NativeDialogs } from './native-dialogs';
import { NativeDownloads } from './native-downloads';
import { BrowserDataStore } from './history-store';
import type { BrowserCdp } from './page-operations';
import { permissionCommand } from './page-advanced';
import { NativeTaskPermissions, type NativePermissionSetting } from './native-permissions';
import { NATIVE_SETTINGS_ROUTES, NativeSettingsHistory, nativeSettingsUrl, nativeSettingsTitleScript, nativeSettingsBackScript } from './native-settings';
import { waitForNativeSettings } from './native-settings-readiness';
import { nativeImportTarget } from './native-import';
import type { BrowserImportTarget } from '../../contracts/browser-import';
import { browserBounds, navigationUrl } from './policy';
import { BrowserError, json, message, object, string, type BrowserBounds, type BrowserObject, type BrowserScope, type BrowserState } from './types';
import type { Json } from '../ipc/contract';
import { navigateForRead } from './task-operations';
import { BROWSER_PANEL_OPEN_ACK_TIMEOUT_MS } from './panel-contract';
import { boundedTabFavicon, cachedTabFaviconScript } from './tab-favicon';
import type { BrowserDataKind, BrowserDownloadAction, BrowserDownloadQuery, BrowserHistorySource, BrowserVisitSource } from '../../contracts/browser-history';
import { loadNativeBrowserBinding, NativePageTransport, NativeProfileDownloadNetwork, type NativeBrowserBinding, type NativeBrowserHandle, type NativePopupInfo, type NativeProfileHandle } from './native-page';
import { NativeNavigationGate, NativeNavigationLeases, type NativeNavigationLease } from './native-navigation';

export interface BrowserPage {
  readonly handle: number;
  readonly id: string;
  readonly owner: string;
  readonly native: NativeBrowserHandle;
  readonly cdp: PageDebugger;
  readonly navigation: NativeNavigationGate;
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
interface ManagementView {
  window: BrowserWindow;
  surface: string;
  viewId: string;
  initialUrl: string;
  bounds: BrowserBounds;
  native?: NativeBrowserHandle;
  cdp?: PageDebugger;
  history: NativeSettingsHistory;
  stateRevision: number;
  ready?: Promise<BrowserObject>;
  dispose(): void;
}
interface PanelOpenWaiter {
  sessionId: string;
  focusRevision: number;
  targetId?: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve(opened: boolean): void;
}
export interface BrowserPermissionRequest { sessionId: string; permission: string; origin: string; pageUrl: string }
const AGENT_INPUT_OPERATIONS = new Set(['click', 'type', 'form_input', 'computer', 'locator', 'press', 'file_upload', 'set_checked', 'select_option']);
const AGENT_NAVIGATION_OPERATIONS = new Set(['navigate', 'back', 'forward', 'reload']);
export type BrowserAuthorizationResource = 'browsing' | 'downloads' | 'uploads' | 'siteTools' | 'debug';
export interface BrowserDownloadPathRequest { defaultPath: string; filename: string; url: string }
export interface BrowserManagerOptions {
  window: BrowserWindow;
  configRoot: string;
  emit: (channel: string, payload: Json) => void;
  emitToWindow?: (window: BrowserWindow, channel: string, payload: Json) => void;
  /** Agent/plugin authorization. Manual browser surfaces do not depend on it. */
  enabled?: () => boolean;
  /** Manual built-in browser availability. Runtime shutdown clears this. */
  available?: () => boolean;
  navigationAllowed?: (url: string) => boolean;
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
  initializeProfile?(profile: NativeProfileHandle): void;
}

export type BrowserOperationLease = (() => void) & { readonly signal: AbortSignal };

/** Owns every IAB page; the renderer and MCP server only refer to these pages. */
export class BrowserManager {
  readonly profilePath: string;
  readonly dialogs: NativeDialogs;
  private readonly parking: BaseWindow;
  private readonly binding: NativeBrowserBinding | undefined;
  private profileReady: Promise<NativeProfileHandle> | undefined;
  private readonly leases = new NativeNavigationLeases();
  private readonly operationPageLeases = new Map<AbortController, Map<number, NativeNavigationLease>>();
  private readonly operationMetadataPages = new Map<AbortController, Map<number, boolean>>();
  private readonly controlledDownloads = new Set<number>();
  private readonly popupActors = new Set<number>();
  private readonly managementViews = new Map<number, ManagementView>();
  private readonly pages = new Map<number, BrowserPage>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly permissions = new NativeTaskPermissions(() => this.pages.values());
  private readonly activeOperations = new Map<string, { turnId: string; source: string; initiator: string }>();
  private readonly operationSignals = new Map<string, AbortSignal | undefined>();
  private readonly operationControllers = new Map<string, Set<AbortController>>();
  private readonly navigationSerials = new Map<number, number>();
  private lastAgentEnabled = true;
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
    this.profilePath = resolve(options.configRoot, 'electron', 'native-browser', 'Default');
    mkdirSync(this.downloadDirectory, { recursive: true });
    try { this.binding = loadNativeBrowserBinding(); }
    catch { this.binding = undefined; }
    this.data = new BrowserDataStore(options.configRoot);
    this.downloads = new NativeDownloads({
      fetch: async (url, init) => new NativeProfileDownloadNetwork(await this.profile()).fetch(url, init),
    }, {
      directory: () => this.downloadDirectory,
      assertUrl: url => this.assertNavigation(url),
      history: this.data,
      ...(options.promptForUserDownloads ? { promptForUserDownloads: options.promptForUserDownloads } : {}),
      ...(options.chooseDownloadPath ? { chooseDownloadPath: options.chooseDownloadPath } : {}),
      authorize: (sessionId, url, resource, signal) => {
        const operation = this.operationSignals.get(sessionId);
        const pending = signal && operation ? AbortSignal.any([signal, operation]) : signal ?? operation;
        return this.authorize(sessionId, url, resource, this.agentControlSignal(pending));
      },
      changed: event => options.emit('browser-use:downloads-changed', json(event)),
    });
    this.dialogs = new NativeDialogs();
    // The same native Browser moves between host windows. The parking parent
    // has no renderer and keeps background tabs independent of the visible panel.
    this.parking = new BaseWindow({ width: 1280, height: 800, show: false, frame: false, focusable: false, skipTaskbar: true, hiddenInMissionControl: true });
    this.bindWindow();
    this.lastAgentEnabled = this.isEnabled();
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
    this.detach();
    if (!previous.isDestroyed()) this.options.emit('browser-use:state', json({ ...this.state(), presentationTransferred: true }));
    for (const [event, handler] of this.windowListeners) previous.removeListener(event as 'resize', handler);
    this.windowListeners.length = 0;
    this.settlePanelOpenWaiters(false); this.revision += 1; this.presentationRevision += 1;
    const saved = this.presentations.get(window.webContents.id);
    this.options.window = window; this.current = saved?.current ?? 'manual';
    this.bounds = saved?.bounds ?? { x: 0, y: 54, width: 800, height: 600 };
    this.wantedVisible = saved?.wantedVisible ?? false;
    this.bindWindow(); this.present(); this.publish();
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
  isAvailable(): boolean { return !this.disposed && !!this.binding && (this.options.available?.() ?? true); }

  private profile(): Promise<NativeProfileHandle> {
    this.requireAvailable();
    if (!this.profileReady) {
      const pending = this.binding!.createProfile().then(profile => {
        if (this.disposed) { profile.dispose(); throw new BrowserError('unavailable', 'The browser manager has shut down.'); }
        try {
          this.options.initializeProfile?.(profile);
          this.downloads.setNativeController(profile);
          profile.on('download-created', (_event, snapshot) => this.downloads.nativeCreated(snapshot));
          profile.on('download-updated', (_event, snapshot) => this.downloads.nativeUpdated(snapshot));
          profile.on('download-removed', (_event, id) => this.downloads.nativeRemoved(id));
          profile.on('download-target', (_event, target) => { void this.downloads.resolveNativeTarget(target).catch(() => {}); });
          for (const snapshot of profile.startObserving()) this.downloads.nativeCreated(snapshot);
          return profile;
        } catch (error) {
          profile.removeAllListeners();
          this.downloads.setNativeController(undefined);
          profile.dispose();
          throw error;
        }
      });
      this.profileReady = pending;
      void pending.catch(() => { if (this.profileReady === pending) this.profileReady = undefined; });
    }
    return this.profileReady;
  }

  /** Trusted settings actions embed the Profile's real management surfaces. */
  async openManager(surface: string, fields: BrowserObject = {}, window = this.options.window): Promise<BrowserObject> {
    if (!Object.hasOwn(NATIVE_SETTINGS_ROUTES, surface)) throw new BrowserError('invalid_request', 'Unknown browser management surface.');
    const kind = surface as keyof typeof NATIVE_SETTINGS_ROUTES;
    const url = this.binding?.managementUrl(kind) ?? NATIVE_SETTINGS_ROUTES[kind];
    if (!nativeSettingsUrl(kind, url)) throw new BrowserError('unavailable', 'The native browser returned an invalid management URL.');
    const action = String(fields.action ?? 'open');
    if (!['open', 'bounds', 'close', 'navigate', 'back', 'forward', 'theme'].includes(action)) throw new BrowserError('invalid_request', 'Unknown browser management action.');
    const viewId = string(fields.viewId, 'viewId');
    if (viewId.length > 128) throw new BrowserError('invalid_request', 'The browser management view id is too long.');
    if (window.isDestroyed()) return { ok: true, closed: true };
    const owner = window.webContents.id;
    const current = this.managementViews.get(owner);
    const matches = current?.surface === surface && current.viewId === viewId;
    if (action === 'close') {
      if (matches) current.dispose();
      return { ok: true, surface };
    }
    this.requireAvailable();
    if (action !== 'open' && !matches) return { ok: true, surface, stale: true };
    if (matches) {
      if (action === 'bounds' || action === 'open') {
        current.bounds = browserBounds(fields.bounds);
        if (current.native && !current.native.isDestroyed()) this.positionManagementView(current.native, window, current.bounds);
        return action === 'bounds' ? { ok: true, surface } : current.ready!;
      }
      await current.ready;
      if (this.managementViews.get(owner) !== current) return { ok: true, surface, stale: true };
      if (action === 'theme') await this.setManagementTheme(current, fields.theme);
      else {
        const native = current.native!, cdp = current.cdp!;
        let target: string | undefined;
        if (action === 'navigate') target = string(fields.url, 'url');
        else if (kind === 'siteSettings') target = current.history.step(action === 'back' ? -1 : 1);
        else {
          const state = await cdp.command('Page.getNavigationHistory');
          const entries = Array.isArray(state.entries) ? state.entries : [];
          const index = Number(state.currentIndex) + (action === 'back' ? -1 : 1);
          const entry = object(entries[index]);
          if (typeof entry.id === 'number' && typeof entry.url === 'string' && nativeSettingsUrl(kind, entry.url)) {
            await cdp.command('Page.navigateToHistoryEntry', { entryId: entry.id });
            this.publishManagementState(current);
            return { ok: true, surface };
          }
        }
        if (target !== undefined) {
          if (!nativeSettingsUrl(kind, target)) throw new BrowserError('refused_by_policy', 'This URL is outside the selected browser settings surface.');
          const useRouter = kind === 'siteSettings' && target === url && native.getURL().startsWith(url + '/');
          if (!useRouter || await cdp.evaluate(nativeSettingsBackScript) !== true) native.loadURL(target);
        }
      }
      this.publishManagementState(current);
      return { ok: true, surface };
    }
    const bounds = browserBounds(fields.bounds);
    current?.dispose();
    if (window === this.options.window) this.hide();
    let closed = false;
    const entry: ManagementView = { window, surface, viewId, initialUrl: url, bounds, history: new NativeSettingsHistory(url), stateRevision: 0, dispose: () => {
      if (closed) return;
      closed = true;
      if (this.managementViews.get(owner) === entry) this.managementViews.delete(owner);
      window.removeListener('resize', resized);
      window.removeListener('closed', entry.dispose);
      entry.cdp?.dispose();
      if (entry.native && !entry.native.isDestroyed()) entry.native.close();
    } };
    const resized = (): void => { if (entry.native && !entry.native.isDestroyed()) this.positionManagementView(entry.native, window, entry.bounds); };
    window.on('resize', resized);
    window.once('closed', entry.dispose);
    this.managementViews.set(owner, entry);
    entry.ready = (async () => {
      try {
        await this.profile();
        const native = await this.binding!.create({ parent: window, bounds, url, visible: false });
        if (closed || this.disposed || window.isDestroyed() || this.managementViews.get(owner) !== entry) {
          native.close(); throw new BrowserError('cancelled', 'The browser management request was superseded.');
        }
        entry.native = native;
        native.on('destroyed', entry.dispose);
        native.on('popup-created', (_event, child, info) => {
          const sessionId = window === this.options.window ? this.current : this.presentations.get(owner)?.current ?? 'manual';
          void this.adoptPopup(sessionId, native, child, info).then(() => {
            const page = this.listPages(sessionId).find(candidate => candidate.native === child);
            if (!page || info.disposition === 4 || closed || window.isDestroyed()) return;
            const value = json({ sessionId, targetId: page.id, ...(window === this.options.window ? { focusRevision: this.revision } : {}) });
            if (this.options.emitToWindow) this.options.emitToWindow(window, 'browser-use:open-panel', value);
            else if (window === this.options.window) this.options.emit('browser-use:open-panel', value);
          });
        });
        const changed = (): void => this.publishManagementState(entry);
        native.on('did-navigate', changed);
        native.on('did-navigate-in-page', changed);
        native.on('page-title-updated', changed);
        native.on('did-stop-loading', () => this.publishManagementState(entry, true));
        entry.cdp = new PageDebugger(new NativePageTransport(native));
        await entry.cdp.initialize();
        if (closed) throw new BrowserError('cancelled', 'The browser management request was superseded.');
        if (fields.theme !== undefined) await this.setManagementTheme(entry, fields.theme);
        this.positionManagementView(native, window, entry.bounds);
        native.setVisible(true);
        if (native.getState().loading) await new Promise<void>((resolveLoaded, reject) => {
          const finish = (error?: Error): void => {
            clearTimeout(timer);
            native.removeListener('did-stop-loading', loaded);
            native.removeListener('destroyed', gone);
            native.removeListener('render-process-gone', gone);
            if (error) reject(error); else resolveLoaded();
          };
          const loaded = (): void => finish();
          const gone = (): void => finish(new BrowserError('unavailable', 'The browser management page closed while loading.'));
          const timer = setTimeout(() => finish(new BrowserError('timeout', 'The browser management page did not finish loading.')), 30_000);
          native.on('did-stop-loading', loaded);
          native.on('destroyed', gone);
          native.on('render-process-gone', gone);
          if (!native.getState().loading) loaded();
        });
        if (closed || this.managementViews.get(owner) !== entry) throw new BrowserError('cancelled', 'The browser management request was superseded.');
        await waitForNativeSettings(entry.cdp, kind, () => !closed && this.managementViews.get(owner) === entry && !native.isDestroyed());
        this.publishManagementState(entry, true);
        return { ok: true, surface };
      } catch (error) { entry.dispose(); throw error; }
    })();
    return entry.ready;
  }

  private async setManagementTheme(entry: ManagementView, theme: Json | undefined): Promise<void> {
    if (theme !== 'light' && theme !== 'dark') throw new BrowserError('invalid_request', 'The browser management theme must be light or dark.');
    entry.native!.setTheme(theme);
    await entry.cdp!.command('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: theme }] });
  }

  private publishManagementState(entry: ManagementView, readTitle = false): void {
    if (this.disposed || entry.window.isDestroyed() || this.managementViews.get(entry.window.webContents.id) !== entry || !entry.native || entry.native.isDestroyed()) return;
    const state = entry.native.getState();
    if (!nativeSettingsUrl(entry.surface as keyof typeof NATIVE_SETTINGS_ROUTES, state.url)) return;
    entry.history.visit(state.url);
    const revision = ++entry.stateRevision;
    const send = (title: string | null): void => {
      const value = json({ surface: entry.surface, viewId: entry.viewId, initialUrl: entry.initialUrl, url: state.url, title,
        canGoBack: entry.surface === 'siteSettings' ? entry.history.canGoBack : state.canGoBack,
        canGoForward: entry.surface === 'siteSettings' ? entry.history.canGoForward : state.canGoForward });
      if (this.options.emitToWindow) this.options.emitToWindow(entry.window, 'settings:browser-use:manager-state', value);
      else this.options.emit('settings:browser-use:manager-state', value);
    };
    send(state.title || null);
    if (readTitle && entry.cdp) void entry.cdp.evaluate(nativeSettingsTitleScript).then(title => {
      if (typeof title === 'string' && title && entry.stateRevision === revision && this.managementViews.get(entry.window.webContents.id) === entry && !entry.window.isDestroyed()) send(title);
    }, () => {});
  }

  private positionManagementView(native: NativeBrowserHandle, window: BrowserWindow, bounds: BrowserBounds): void {
    const zoom = window.webContents.getZoomFactor();
    const size = window.getContentBounds();
    const x = Math.min(Math.round(bounds.x * zoom), Math.max(0, size.width - 1));
    const y = Math.min(Math.round(bounds.y * zoom), Math.max(0, size.height - 1));
    native.setBounds({ x, y, width: Math.max(1, Math.min(Math.round(bounds.width * zoom), size.width - x)), height: Math.max(1, Math.min(Math.round(bounds.height * zoom), size.height - y)) });
    native.setBubbleAnchor({ x: x + 8, y: Math.max(0, y - 28), width: 24, height: 24 });
  }

  async setSitePermission(fields: BrowserObject): Promise<BrowserObject> {
    const origin = string(fields.origin, 'origin');
    const permission = string(fields.permission, 'permission');
    const setting = fields.setting;
    if (!['granted', 'denied', 'prompt'].includes(String(setting)) || permission.length > 64) throw new BrowserError('invalid_request', 'Invalid persistent site permission.');
    return (await this.profile()).setSitePermission(origin, permission, setting as 'granted' | 'denied' | 'prompt');
  }

  async importTarget(signal: AbortSignal): Promise<BrowserImportTarget> {
    this.requireAvailable();
    signal.throwIfAborted();
    const profile = await this.profile();
    signal.throwIfAborted();
    return nativeImportTarget(profile, signal, rows => {
      for (const row of rows) this.data.recordVisit({ sessionId: 'browser-import',
        url: row.url, title: row.title, visitedAt: row.visitedAt, source: 'other' });
    });
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
    this.permissions.reset();
    this.approvedAgentNavigations.clear();
    this.agentVisits.clear();
    this.agentPageLeases.clear();
    this.pendingMainFrameAuthorizations.clear();
    for (const cancel of [...this.pendingNavigationCancels]) cancel();
    this.pendingNavigationCancels.clear();
    this.lastAgentEnabled = this.isEnabled();
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

  /** Reconcile an enablement change when the store did not emit its changed callback. */
  reconcileAgentEnabled(): void {
    if (this.isEnabled() !== this.lastAgentEnabled) this.refreshPermissions();
    else this.lastAgentEnabled = this.isEnabled();
  }

  private beginNavigation(page: BrowserPage): number {
    const serial = (this.navigationSerials.get(page.handle) ?? 0) + 1;
    this.navigationSerials.set(page.handle, serial);
    return serial;
  }

  private isCurrentNavigation(page: BrowserPage, serial: number): boolean {
    return this.navigationSerials.get(page.handle) === serial;
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

  private alive(page: BrowserPage): boolean { return !page.native.isDestroyed(); }

  state(sessionId = this.current): BrowserState {
    const conversation = this.conversation(sessionId);
    const active = conversation.active === undefined ? undefined : this.pages.get(conversation.active);
    const live = active && this.alive(active) ? active.native : undefined;
    const nativeState = live?.getState();
    return {
      enabled: this.isAvailable(), visible: sessionId === this.current && !!this.shown && this.isAvailable(),
      conversationId: sessionId, focusRevision: this.revision,
      ...(active ? { tabId: active.id } : {}), url: live?.getURL() || 'about:blank', title: live?.getTitle() || '',
      loading: nativeState?.loading ?? false,
      canGoBack: nativeState?.canGoBack ?? false,
      canGoForward: nativeState?.canGoForward ?? false,
      contentWidth: active?.contentWidth ?? 0,
      contentRevision: active?.contentRevision ?? 0,
      browserUseActive: this.activeOperations.has(sessionId),
      ...this.activeOperations.get(sessionId),
      tabs: this.listPages(sessionId).map(page => ({ id: page.id, active: page.handle === conversation.active,
        url: page.native.getURL() || 'about:blank', title: page.native.getTitle(), loading: page.native.getState().loading })),
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
    this.operationPageLeases.set(controller, new Map());
    this.operationMetadataPages.set(controller, new Map());
    controller.signal.addEventListener('abort', () => {
      for (const handle of this.operationMetadataPages.get(controller)?.keys() ?? []) {
        const page = this.pages.get(handle);
        if (page) this.refreshDownloadSource(page);
      }
    }, { once: true });
    const abort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const controllers = this.operationControllers.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller); this.operationControllers.set(sessionId, controllers);
    const previousRoute = this.activeOperations.get(sessionId);
    const previousSignal = this.operationSignals.get(sessionId);
    if (!previousRoute) this.activeOperations.set(sessionId, route);
    this.operationSignals.set(sessionId, controller.signal);
    if (activePage !== undefined) {
      const page = this.pages.get(activePage);
      if (page) this.bindOperationPage(page, name);
    }
    this.publish();
    const finish = (() => {
      for (const lease of this.operationPageLeases.get(controller)?.values() ?? []) lease.release();
      this.operationPageLeases.delete(controller);
      const metadataPages = this.operationMetadataPages.get(controller);
      this.operationMetadataPages.delete(controller);
      for (const handle of metadataPages?.keys() ?? []) {
        const page = this.pages.get(handle);
        if (page) this.refreshDownloadSource(page);
      }
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
      if (!controllers.size) for (const page of this.listPages(sessionId)) {
        this.agentInputPages.delete(page.handle);
        this.agentPageLeases.delete(page.handle);
      }
      this.approvedAgentNavigations.delete(sessionId);
      this.publish();
    }) as BrowserOperationLease;
    return Object.assign(finish, { signal: controller.signal });
  }

  listPages(sessionId: string): BrowserPage[] {
    return this.conversation(sessionId).tabs.map(id => this.pages.get(id)).filter((page): page is BrowserPage => !!page && this.alive(page));
  }

  private refreshDownloadSource(page: BrowserPage): void {
    if (!this.alive(page)) return;
    const actor = this.popupActors.has(page.handle) || [...this.operationMetadataPages].some(([controller, pages]) => !controller.signal.aborted && pages.get(page.handle) === true);
    page.native.setDownloadSourceMetadata({ sessionId: page.owner, pageId: page.id,
      isActorVisit: actor, requiresAuthorization: this.controlledDownloads.has(page.handle) });
  }

  /** Bind the active operation to its resolved target, including inactive tabs. */
  bindOperationPage(page: BrowserPage, name: string): void {
    if (!this.activeOperations.has(page.owner)) return;
    const controller = [...(this.operationControllers.get(page.owner) ?? [])]
      .find(controller => controller.signal === this.operationSignals.get(page.owner));
    if (!controller || controller.signal.aborted) return;
    const actor = AGENT_INPUT_OPERATIONS.has(name) || AGENT_NAVIGATION_OPERATIONS.has(name);
    const metadata = this.operationMetadataPages.get(controller);
    metadata?.set(page.handle, actor || metadata.get(page.handle) === true);
    this.controlledDownloads.add(page.handle);
    this.refreshDownloadSource(page);
    if (AGENT_INPUT_OPERATIONS.has(name)) this.agentInputPages.add(page.handle);
    if (AGENT_NAVIGATION_OPERATIONS.has(name)) this.agentPageLeases.add(page.handle);
    if (!actor) return;
    const leases = this.operationPageLeases.get(controller);
    if (leases && !leases.has(page.handle)) leases.set(page.handle, this.leases.begin(page.owner, page.handle, 'agent', controller.signal));
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

  private async addPage(sessionId: string, activate = true, keepInactive = false): Promise<BrowserPage> {
    this.requireAvailable();
    await this.profile();
    const native = await this.binding!.create({ parent: this.parking, bounds: { x: 0, y: 0, width: 1280, height: 800 }, url: 'about:blank', visible: false });
    return this.registerPage(sessionId, native, activate, keepInactive);
  }

  private registerPage(sessionId: string, native: NativeBrowserHandle, activate = true, keepInactive = false, bindOperation = true, deferRuntime = false): BrowserPage {
    if (this.disposed) { native.close(); throw new BrowserError('unavailable', 'The browser manager has shut down.'); }
    try { this.permissions.attach(sessionId, native); }
    catch (error) { native.close(); throw error; }
    native.setVisible(false);
    native.setParent(this.parking);
    const handle = this.nextHandle++;
    const cdp = new PageDebugger(new NativePageTransport(native));
    const navigation = new NativeNavigationGate({
      sessionId, pageHandle: handle, cdp: deferRuntime ? {
        command: (method, params, frame) => cdp.navigationCommand(method, params, frame),
        onEvent: listener => cdp.onEvent(listener), ownedFrameTargets: () => cdp.ownedFrameTargets(),
      } : cdp, leases: this.leases,
      assertNavigation: url => this.assertNavigation(url),
      mainFrameId: () => native.getMainFrameId(),
      authorize: (owner, url, resource, signal) => this.authorize(owner, url, resource, signal),
    });
    const page: BrowserPage = { handle, id: `iab-${handle}`, owner: sessionId, native, cdp, navigation, ready: Promise.resolve(), lastOpened: Date.now() };
    this.pages.set(handle, page);
    this.refreshDownloadSource(page);
    if (bindOperation) this.bindOperationPage(page, this.activeOperations.get(sessionId)?.initiator ?? '');
    const conversation = this.conversation(sessionId);
    conversation.tabs.push(handle);
    if (activate || (!keepInactive && conversation.active === undefined)) conversation.active = handle;
    this.bindPage(page);
    page.ready = (deferRuntime ? cdp.prepareNavigation() : cdp.initialize()).then(() => navigation.start());
    void page.ready.catch(error => { page.error = message(error); this.publish(); });
    this.present(); this.publish();
    return page;
  }

  /** Adopt the browser-owned popup and continue its original navigation. */
  private async adoptPopup(sessionId: string, source: NativeBrowserHandle, native: NativeBrowserHandle, info: NativePopupInfo): Promise<void> {
    let page: BrowserPage | undefined;
    let lease: NativeNavigationLease | undefined;
    let signal: AbortSignal | undefined;
    let resumed = false;
    const cleanup = (): void => {
      signal?.removeEventListener('abort', cancelled);
      native.removeListener('did-stop-loading', loaded);
      native.removeListener('destroyed', cleanup);
      lease?.release();
      lease = undefined;
      if (page) { this.popupActors.delete(page.handle); this.refreshDownloadSource(page); }
    };
    const cancelled = (): void => {
      cleanup();
      if (native.isDestroyed()) return;
      native.cancelPopup();
      if (page) this.closeTab(sessionId, page.handle); else native.close();
    };
    const loaded = (): void => {
      if (resumed && !native.isDestroyed() && native.getURL() !== 'about:blank' && !native.getState().loading) cleanup();
    };
    try {
      this.requireAvailable();
      if (source.isDestroyed() || native.isDestroyed()) throw new BrowserError('cancelled', 'The popup source has closed.');
      this.assertNavigation(info.url || 'about:blank');
      if (info.requiresAuthorization) {
        this.requireEnabled();
        signal = this.agentControlSignal(this.operationSignals.get(sessionId));
        signal.throwIfAborted();
      }
      const activate = info.disposition !== 4;
      page = this.registerPage(sessionId, native, activate, true, false, true);
      if (info.requiresAuthorization) this.controlledDownloads.add(page.handle);
      if (info.isActorVisit) this.popupActors.add(page.handle);
      this.refreshDownloadSource(page);
      lease = this.leases.begin(sessionId, page.handle, info.isActorVisit ? 'agent' : 'other', signal, info.requiresAuthorization);
      native.on('did-stop-loading', loaded);
      native.on('destroyed', cleanup);
      signal?.addEventListener('abort', cancelled, { once: true });
      const adopted = page;
      page.ready = page.ready.then(async () => {
        signal?.throwIfAborted();
        this.page(sessionId, adopted.handle);
        resumed = true;
        native.resumePopup();
        await adopted.cdp.initialize();
      });
      await page.ready;
      this.present(); this.publish();
    } catch {
      cancelled();
    }
  }

  async createTab(sessionId: string, input: unknown = 'about:blank', activate = true, signal?: AbortSignal): Promise<BrowserPage> {
    if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.');
    const url = this.assertNavigation(input);
    const page = await this.addPage(sessionId, activate);
    if (url !== 'about:blank') this.bindOperationPage(page, 'navigate');
    try { await page.ready; if (signal?.aborted) throw new BrowserError('cancelled', 'The browser operation was cancelled.'); await this.navigate(page, url, {}, signal); return page; }
    catch (error) { this.closeTab(sessionId, page.handle); throw error; }
  }

  async createPreviewTab(sessionId: string): Promise<BrowserPage> {
    const page = await this.addPage(sessionId, false, true);
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
    const serial = this.beginNavigation(page);
    await page.cdp.activity(() => navigateForRead(page.cdp, url, fields, signal, () => {
      if (this.isCurrentNavigation(page, serial)) void page.cdp.command('Page.stopLoading').catch(() => {});
    }));
    this.publish();
  }

  async stop(page: BrowserPage): Promise<void> {
    await page.navigation.abortPending();
    await page.cdp.command('Page.stopLoading');
  }

  async historyAction(page: BrowserPage, action: 'back' | 'forward' | 'reload', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.requireAvailable(); this.page(page.owner, page.handle);
    await page.ready;
    if (action === 'reload') {
      this.assertNavigation(page.native.getURL());
      await page.cdp.command('Page.reload');
    } else {
      const history = await page.cdp.command('Page.getNavigationHistory');
      const entries = Array.isArray(history.entries) ? history.entries : [];
      const index = Number(history.currentIndex) + (action === 'back' ? -1 : 1);
      const entry = object(entries[index]);
      if (typeof entry.id !== 'number') throw new BrowserError('not_found', `There is no ${action} history entry.`);
      this.assertNavigation(entry.url);
      await page.cdp.command('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    signal?.throwIfAborted();
    this.publish();
  }

  async beginUpload(page: BrowserPage, signal?: AbortSignal): Promise<void> {
    this.page(page.owner, page.handle);
    await page.navigation.setUploadLease(this.agentControlSignal(signal));
  }

  /** Retire agent ownership when the user takes over this page. */
  takeManualControl(page: BrowserPage): void {
    this.page(page.owner, page.handle);
    this.controlledDownloads.delete(page.handle);
    this.popupActors.delete(page.handle);
    void page.navigation.setUploadLease().catch(() => {});
    for (const [controller, pages] of this.operationMetadataPages) {
      if (!pages.has(page.handle)) continue;
      pages.set(page.handle, false);
      this.operationPageLeases.get(controller)?.get(page.handle)?.release();
      this.operationPageLeases.get(controller)?.delete(page.handle);
      controller.abort();
    }
    this.downloads.release(page.id);
    this.refreshDownloadSource(page);
  }

  private bindPage(page: BrowserPage): void {
    const native = page.native;
    this.dialogs.bind(page);
    native.on('manual-input', () => this.takeManualControl(page));
    native.on('popup-created', (_event, child, info) => { void this.adoptPopup(page.owner, native, child, info); });
    for (const event of ['did-start-loading', 'did-stop-loading'] as const) native.on(event, () => this.publish());
    native.on('page-title-updated', () => {
      this.publish();
      const url = native.getURL();
      if (this.isHistoryUrl(url)) this.data.queueVisitUpdate(page.owner, url, { title: native.getTitle() || url });
    });
    native.on('did-navigate', (_event, url) => { this.pendingVisits.set(page.handle, url); this.publish(); });
    native.on('did-navigate-in-page', (_event, url) => { this.scheduleVisit(page, url); this.publish(); });
    native.on('did-stop-loading', () => {
      if (native.getURL() !== 'about:blank') void page.navigation.setUploadLease().catch(() => {});
      const pending = this.pendingVisits.get(page.handle);
      this.pendingVisits.delete(page.handle);
      if (!this.suppressedReloads.delete(page.handle)) this.scheduleVisit(page, pending || native.getURL());
      this.scheduleContentProbe(page);
    });
    native.on('render-process-gone', (_event, status) => { page.error = `Browser page stopped: ${status}`; this.publish(); });
    native.on('destroyed', () => this.forget(page));
  }

  private isHistoryUrl(url: string): boolean {
    try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
  }

  private scheduleVisit(page: BrowserPage, url: string): void {
    if (!this.isHistoryUrl(url)) return;
    // A pushState page can update its title in the same task; recording on the
    // next turn captures that title without delaying navigation.
    setTimeout(() => {
      if (this.disposed || !this.alive(page) || page.native.getURL() !== url) return;
      const contents = page.native;
      this.data.recordVisit({
        sessionId: page.owner,
        url,
        title: contents.getTitle() || url,
        source: page.navigation.takeVisitSource(url) ?? 'other',
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
    if (this.alive(page)) page.native.close();
    return this.ok(sessionId);
  }

  private forget(page: BrowserPage): void {
    if (!this.pages.has(page.handle)) return;
    this.dialogs.release(page.handle);
    this.controlledDownloads.delete(page.handle);
    this.popupActors.delete(page.handle);
    for (const pages of this.operationMetadataPages.values()) pages.delete(page.handle);
    void page.navigation.stop().finally(() => page.cdp.dispose());
    this.downloads.release(page.id);
    this.navigationSerials.delete(page.handle);
    if (this.shown === page) this.detach();
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
    this.detach(); this.publish();
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
    // Return keyboard focus before a renderer overlay replaces the native page.
    const focused = this.alive(page) && page.native.isFocused();
    if (this.alive(page)) page.native.setVisible(false);
    if (!this.disposed && !this.parking.isDestroyed() && this.alive(page)) {
      page.native.setParent(this.parking);
      const bounds = page.native.getBounds();
      page.native.setBounds({ ...bounds, x: 0, y: 0 });
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
      page.cdp.command('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false, fromSurface: true }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BrowserError('timeout', 'Browser capture timed out.')), 1500); }),
    ]).finally(() => clearTimeout(timer));
    if (this.shown !== page || !this.alive(page)) throw new BrowserError('stale_tab', 'The page left the screen while it was captured.');
    if (typeof image.data !== 'string' || !image.data) throw new BrowserError('host_error', 'The browser returned an empty capture.');
    return { tabId: page.id, dataUrl: `data:image/jpeg;base64,${image.data}` };
  }

  private present(): void {
    const window = this.options.window;
    const active = this.conversation(this.current).active;
    const page = active === undefined ? undefined : this.pages.get(active);
    if (this.disposed || !this.wantedVisible || !this.isAvailable() || window.isDestroyed() || !window.isVisible() || window.isMinimized() || !page || !this.alive(page)) {
      this.detach(); return;
    }
    if (this.shown !== page) {
      this.detach();
      page.native.setParent(window); this.shown = page;
    }
    const zoom = window.webContents.getZoomFactor();
    const size = window.getContentBounds();
    const x = Math.min(Math.round(this.bounds.x * zoom), Math.max(0, size.width - 1));
    const y = Math.min(Math.round(this.bounds.y * zoom), Math.max(0, size.height - 1));
    page.native.setBounds({ x, y, width: Math.max(1, Math.min(Math.round(this.bounds.width * zoom), size.width - x)), height: Math.max(1, Math.min(Math.round(this.bounds.height * zoom), size.height - y)) });
    page.native.setBubbleAnchor({ x: x + 8, y: Math.max(0, y - 28), width: 24, height: 24 });
    page.native.setVisible(true);
    this.scheduleContentProbe(page);
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
    if (page.native.getState().loading) return;
    let width = 0;
    try {
      const metrics = object(await page.cdp.command('Page.getLayoutMetrics'));
      const size = object(metrics.cssContentSize ?? metrics.contentSize);
      const content = Number(size.width);
      const zoom = this.options.window.webContents.getZoomFactor() || 1;
      // The view bounds are physical pixels (they carry the window zoom); the
      // layout metrics are CSS pixels, so compare in CSS pixels.
      const viewport = page.native.getBounds().width / zoom;
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

  async setPermission(page: BrowserPage, fields: BrowserObject): Promise<BrowserObject> {
    this.requireEnabled(); this.page(page.owner, page.handle);
    const command = permissionCommand(fields);
    if (command.method === 'Browser.resetPermissions') {
      this.permissions.reset(page.owner);
      return { reset: true, scope: 'task' };
    }
    const origin = new URL(this.assertNavigation(command.params.origin)).origin;
    const asked = command.method === 'Browser.grantPermissions' ? command.params.permissions as Json[] : [object(command.params.permission).name!];
    const setting: NativePermissionSetting = command.method === 'Browser.grantPermissions' ? 'granted' : command.params.setting as NativePermissionSetting;
    const names = this.permissions.set(page.owner, origin, asked.map(String), setting);
    return { origin, permissions: names, setting, scope: 'task', note: 'Native site policy, device selection and operating-system permissions still apply.' };
  }

  download(
    page: BrowserPage,
    fields: BrowserObject,
    waitMs: number,
    cdp: BrowserCdp = page.cdp,
    signal?: AbortSignal,
  ): Promise<BrowserObject> {
    this.requireAvailable(); this.page(page.owner,page.handle);
    signal ??= this.operationSignals.get(page.owner);
    return this.downloads.download(
      page.id, page.owner, cdp, fields, waitMs,
      signal,
      page.native.getURL(),
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
    await (await this.profile()).clearData(kind as BrowserDataKind);
    if (kind === 'all') this.permissions.reset();
    if (kind === 'all' || kind === 'history') visits = this.data.clearVisits().removed;
    if (kind === 'all' || kind === 'downloads') downloads = this.downloads.clearTerminal().removed;
    let reloaded = 0;
    if (kind === 'all') {
      for (const page of this.pages.values()) this.suppressedReloads.add(page.handle);
      for (const page of [...this.pages.values()]) {
        if (!this.alive(page)) continue;
        try { await page.cdp.command('Page.reload'); reloaded += 1; } catch { /* closed while clearing */ }
      }
      // A failed or canceled reload must not suppress the user's next visit.
      setTimeout(() => {
        for (const handle of [...this.suppressedReloads]) {
          const page = this.pages.get(handle);
          if (!page || !this.alive(page) || !page.native.getState().loading) this.suppressedReloads.delete(handle);
        }
      }, 5_000);
    }
    return { ok: true, visits, downloads, reloaded };
  }

  releaseConversation(sessionId: string): void {
    this.abortAgentOperations(sessionId);
    this.operationControllers.delete(sessionId);
    this.settlePanelOpenWaiters(false, waiter => waiter.sessionId === sessionId);
    this.permissions.reset(sessionId);
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
    for (const view of [...this.managementViews.values()]) view.dispose();
    this.managementViews.clear();
    this.dialogs.dispose();
    this.detach();
    for (const [event, handler] of this.windowListeners) this.options.window.removeListener(event as 'resize', handler);
    for (const cancel of [...this.pendingNavigationCancels]) cancel();
    this.pendingNavigationCancels.clear();
    this.data.flushVisitUpdates();
    this.downloads.dispose();
    for (const page of [...this.pages.values()]) {
      void page.navigation.stop().finally(() => page.cdp.dispose());
      if (this.alive(page)) page.native.close();
    }
    if (!this.parking.isDestroyed()) this.parking.close();
    this.permissions.reset(); this.pages.clear(); this.conversations.clear(); this.activeOperations.clear();
    this.controlledDownloads.clear(); this.operationMetadataPages.clear();
    void this.profileReady?.then(profile => { profile.removeAllListeners(); profile.dispose(); }, () => {});
  }
}
