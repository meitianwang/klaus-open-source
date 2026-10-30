import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, Menu, globalShortcut, powerMonitor, screen, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { DEFAULT_PET_SETTINGS, type PetCatalogEntry, type PetDragPoint, type PetElementLayout, type PetImportRequest, type PetRect, type PetSettings, type PetState, type PetTask, type PetVoiceState } from '../../contracts/desktop-pet';
import { PetCatalog } from '../pets/catalog';
import { clamp, clampPet, containsPoint, layoutPetWindow, petPlacement, resolutionKey, snapPet, restorePetPosition, canStashPet, petWindowOriginBounds, PET_MOTION, type PetPoint } from '../pets/geometry';
import { normalizePetSettings } from '../pets/settings';

export interface DesktopPetDependencies {
  createWindow(): BrowserWindow;
  focusWindow?(window: BrowserWindow, active: boolean): boolean;
  activateApplication?(): void;
  pageUrl: string;
  dataDirectory: string;
  builtIns: PetCatalogEntry[];
  broadcast(state: PetState): void;
  emit?(channel: string, payload: unknown): void;
  readShortcut?(): string;
  writeShortcut?(value: string): Promise<void>;
  openMain(): void | Promise<void>;
  openSettings(): void | Promise<void>;
  openTask(id: string): void | Promise<void>;
  ownsConversation?(id: string): boolean;
  submit?(text: string): Promise<void>;
  respondTask?(taskId: string, requestId: string, response: unknown): Promise<unknown>;
  voice?: {
    state(ownerId?: number): PetVoiceState | Promise<PetVoiceState>;
    start(ownerId: number): Promise<PetVoiceState>;
    stop(ownerId: number): Promise<PetVoiceState>;
    microphone(ownerId: number, muted: boolean): Promise<PetVoiceState>;
    speaker(ownerId: number, muted: boolean): Promise<PetVoiceState>;
  };
  pickFile?(): Promise<string | undefined>;
  createPet?(upgradeDirectoryPath?: string): void | Promise<void>;
  openDirectory?(directory: string): void | Promise<void>;
  acknowledgeTask?(id: string): void;
  dismissTask?(id: string): void;
  observeOutsideClicks?(listener: (point: PetPoint) => void, window: BrowserWindow): () => void;
  captureActiveApplication?(): string | undefined;
  restoreActiveApplication?(token: string): boolean | Promise<boolean>;
  isSessionReserved?(): boolean;
  startNativeDrag?(window: BrowserWindow, point: PetPoint, listener: (event: { windowX: number; windowY: number; ended: boolean; altKey: boolean }) => void, originBounds: PetRect): (() => void) | undefined;
  registerShortcut?(accelerator: string, callback: () => void): () => void;
  registerOwner?(window: BrowserWindow): void;
  unregisterOwner?(ownerId: number): void;
  visibilityChanged?(ownerId: number, visible: boolean): void;
  log?(message: string): void;
  platform?: NodeJS.Platform;
  fetchImage?: typeof fetch;
}
interface Position extends PetPoint { displayId: number; displayBounds: PetRect; placement?: string }
function validPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false;
  const position = value as Position;
  return [position.x, position.y, position.displayId, position.displayBounds?.x, position.displayBounds?.y, position.displayBounds?.width, position.displayBounds?.height].every(Number.isFinite) && position.displayBounds.width > 0 && position.displayBounds.height > 0;
}
interface Saved { settings?: unknown; position?: Position; byDisplay?: Record<string, Position>; byResolution?: Record<string, Position>; mutedTasks?: Record<string, string> }
interface Drag { offset: PetPoint; last: PetPoint; lastAt: number; velocity: PetPoint; moved: boolean }

/** Owns one independent floating companion and its durable local preferences. */
export class DesktopPetRuntime {
  private window: BrowserWindow | undefined;
  private ready = false;
  private lastVisibility: { ownerId: number; visible: boolean } | undefined;
  private layoutReady = false;
  private measuredLayout: PetElementLayout | undefined;
  private quitting = false;
  private suspended = false;
  private hiddenOnDemand = false;
  private menuOpen = false;
  private stashedEdge: 'left' | 'right' | null = null;
  private state: PetState = {
    settings: { ...DEFAULT_PET_SETTINGS }, visible: false, menuOpen: false, stashedEdge: null,
    tasks: [], catalog: [], layout: { pet: { x: 164, y: 16, width: 112, height: 121 }, viewport: { width: 440, height: 440 }, placement: 'top-end' }, revision: 0,
  };
  private saved: Saved = {};
  private readonly mutedTasks = new Map<string, string>();
  private anchor: PetPoint = { x: 0, y: 0 };
  private pendingLayoutAnchor: PetPoint | undefined;
  private stashRestoreAnchor: PetPoint | undefined;
  private readonly interactionReservations = new Map<number, number>();
  private activeDisplayId: number | undefined;
  private detachedPosition: Position | undefined;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  private drag: Drag | undefined;
  private nativeDragStop: (() => void) | undefined;
  private nativeDragStart: PetPoint | undefined;
  private suppressNextRendererThrow = false;
  private deferredDragLayout = false;
  private momentum: NodeJS.Timeout | undefined;
  private stashAnimating = false;
  private fadeTimer: NodeJS.Timeout | undefined;
  private fadeResolve: ((completed: boolean) => void) | undefined;
  private hidingAnimation = false;
  private hiddenCleanup: NodeJS.Timeout | undefined;
  private proximity: NodeJS.Timeout | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  private regions: PetRect[] = [];
  private passThrough: boolean | undefined;
  private forwarding: boolean | undefined;
  private stopOutside: (() => void) | undefined;
  private stopShortcut: (() => void) | undefined;
  private keyboard = false;
  private composerFocused = false;
  private pendingFocus: { requestId: number; hasLayout: boolean; layoutRevision?: number; wasHidden: boolean } | undefined;
  private visibilitySequence = 0;
  private previousApplication: string | undefined;
  private layoutRevision = 0;
  private inputShapeApplied = false;
  private lastPointer: PetPoint | undefined;
  private activeDisplayBounds: PetRect | undefined;
  private detachedTimer: NodeJS.Timeout | undefined;
  private previousWindow: BrowserWindow | null = null;
  private readonly catalog: PetCatalog;
  private readonly settingsPath: string;
  private readonly displayChanged = () => this.reconcileDisplays();
  private readonly suspend = () => { void this.persist().catch(error => this.report(error)); this.suspended = true; this.cancelNativeDrag(); this.drag = undefined; this.cancelMomentum(); this.window?.hide(); if (this.window) this.notifyVisibility(this.window.webContents.id, false); this.publish(); };
  private readonly resume = () => { this.suspended = false; this.reconcileDisplays(); this.reconcileVisibility(); };

  constructor(private readonly deps: DesktopPetDependencies) {
    this.catalog = new PetCatalog(deps.dataDirectory, deps.builtIns, deps.fetchImage);
    this.settingsPath = path.join(deps.dataDirectory, 'desktop-pet.json');
  }
  async initialize(): Promise<void> {
    if (this.quitting) return;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeInternal(); return this.initializePromise;
  }
  private async initializeInternal(): Promise<void> {
    try { const saved: unknown = JSON.parse(await fs.readFile(this.settingsPath, 'utf8')); this.saved = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Saved : {}; } catch { this.saved = {}; }
    if (this.quitting) return;
    const muted = this.saved.mutedTasks;
    if (muted && typeof muted === 'object' && !Array.isArray(muted)) for (const [id, title] of Object.entries(muted)) if (id && typeof title === 'string') this.mutedTasks.set(id, title);
    const defaults = { ...DEFAULT_PET_SETTINGS, shortcut: (this.deps.platform ?? process.platform) === 'darwin' ? 'Alt+Space' : 'Super+Alt+P' };
    this.state.settings = normalizePetSettings(this.saved.settings, defaults);
    if (this.deps.readShortcut) this.state.settings.shortcut = this.deps.readShortcut();
    this.state.layout.pet.width = this.state.settings.size; this.state.layout.pet.height = Math.round(this.state.settings.size * 208 / 192);
    this.state.catalog = await this.catalog.list();
    if (this.quitting) return;
    this.reconcileSelection(); this.initialized = true;
    const displays = screen.getAllDisplays();
    const display = displays.find(item => item.id === this.saved.position?.displayId) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const restored = [this.saved.byDisplay?.[String(display.id)], this.saved.byResolution?.[resolutionKey(display.bounds)], this.saved.position].find(validPosition);
    this.activeDisplayId = display.id;
    this.anchor = restored ? clampPet(restorePetPosition(restored, display.bounds), this.state.layout.pet, display.workArea) : snapPet({ x: display.workArea.x + display.workArea.width, y: display.workArea.y + display.workArea.height }, this.state.layout.pet, display.workArea);
    screen.on('display-added', this.displayChanged); screen.on('display-removed', this.displayChanged); screen.on('display-metrics-changed', this.displayChanged);
    powerMonitor.on('suspend', this.suspend); powerMonitor.on('resume', this.resume); powerMonitor.on('lock-screen', this.suspend); powerMonitor.on('unlock-screen', this.resume);
    this.syncShortcut(); this.reconcileVisibility(); this.publish();
  }
  snapshot(): PetState { return structuredClone({ ...this.state, tasks: this.state.tasks.filter(task => !this.mutedTasks.has(task.id)), mutedTaskIds: [...this.mutedTasks.keys()], visible: Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible()), menuOpen: this.menuOpen, stashedEdge: this.stashedEdge }); }
  ownsWebContents(id: number): boolean { return Boolean(this.window && !this.window.isDestroyed() && this.window.webContents.id === id); }
  private requireOwner(id: number): BrowserWindow {
    if (!this.ownsWebContents(id) || this.quitting) throw new Error('Desktop pet caller does not own this window');
    return this.window!;
  }
  private publish(): void {
    if (this.quitting) return;
    this.state.revision++;
    this.deps.broadcast(this.snapshot());
  }
  private report(error: unknown): void { this.deps.log?.(error instanceof Error ? error.message : String(error)); }
  async updateSettings(value: unknown): Promise<PetState> {
    await this.initialize();
    const previous = this.state.settings, next = normalizePetSettings(value, previous);
    if (next.selectedPetId && !this.state.catalog.some(pet => pet.id === next.selectedPetId)) throw new Error('Selected pet is unavailable');
    if (next.selectedPetId && next.selectedPetId !== previous.selectedPetId) next.showPet = true;
    if (next.shortcut !== previous.shortcut && this.deps.writeShortcut) await this.deps.writeShortcut(next.shortcut);
    this.state.settings = next;
    if (next.size !== previous.size) {
      this.cancelMomentum(); const ratio = this.state.layout.pet.height / this.state.layout.pet.width;
      this.state.layout.pet.width = next.size; this.state.layout.pet.height = Math.round(next.size * ratio);
      this.reconcileDisplays();
    }
    if (next.visibility !== previous.visibility || next.enabled !== previous.enabled) this.hiddenOnDemand = next.visibility === 'on-demand' && !this.interactionReserved();
    if (!next.enabled) this.hiddenOnDemand = true;
    if (next.shortcut !== previous.shortcut) this.syncShortcut();
    this.reconcileVisibility(); await this.persist(); this.publish(); return this.snapshot();
  }
  private reconcileSelection(): void {
    const selected = this.state.settings.selectedPetId;
    if (selected && !this.state.catalog.some(pet => pet.id === selected)) this.state.settings.selectedPetId = this.state.catalog[0]?.id ?? null;
  }
  private syncShortcut(): void {
    this.stopShortcut?.(); this.stopShortcut = undefined;
    const accelerator = this.state.settings.shortcut; if (this.deps.readShortcut || !accelerator || this.quitting) return;
    try {
      const callback = () => { void this.toggleFromShortcut().catch(error => this.report(error)); };
      if (this.deps.registerShortcut) this.stopShortcut = this.deps.registerShortcut(accelerator, callback);
      else {
        if (!globalShortcut.register(accelerator, callback)) throw new Error('Desktop pet shortcut is already in use');
        this.stopShortcut = () => globalShortcut.unregister(accelerator);
      }
    } catch (error) { this.report(error); }
  }
  async show(): Promise<PetState> { await this.initialize(); this.cancelFocus(); this.cancelFade(); this.clearHiddenCleanup(); this.restoreStashedPosition(); this.state.settings.enabled = true; this.hiddenOnDemand = false; this.reconcileVisibility(); await this.persist(); this.publish(); return this.snapshot(); }
  async hide(): Promise<PetState> {
    await this.initialize(); this.cancelFocus(); this.cancelNativeDrag(); this.drag = undefined; this.setKeyboard(undefined, false);
    this.state.settings.enabled = false; this.hiddenOnDemand = true; this.cancelMomentum(); this.updateOutsideClicks(); this.publish();
    const sequence = this.visibilitySequence;
    const win = this.window; this.hidingAnimation = Boolean(win && win.isVisible() && typeof win.setOpacity === 'function');
    if (win && this.hidingAnimation) await this.fadeWindow(win, 0, 120);
    if (sequence !== this.visibilitySequence) return this.snapshot();
    this.hidingAnimation = false;
    if (!this.shouldShow()) { this.reconcileVisibility(); this.scheduleHiddenCleanup(); }
    await this.persist(); this.publish(); return this.snapshot();
  }
  async toggle(): Promise<PetState> { await this.initialize(); return this.snapshot().visible ? this.hide() : this.show(); }
  async toggleFromShortcut(): Promise<void> {
    await this.initialize();
    if (this.quitting || this.interactionReserved()) return;
    if (this.stashedEdge || this.hidingAnimation || (!this.snapshot().visible && !this.pendingFocus)) await this.show();
    else await this.hide();
  }
  async focusInput(): Promise<void> {
    await this.initialize();
    const wasHidden = !this.snapshot().visible;
    const wasStashed = this.stashedEdge !== null;
    this.cancelFade(); this.clearHiddenCleanup(); this.cancelFocus();
    this.restoreStashedPosition();
    const requestId = ++this.visibilitySequence;
    this.pendingFocus = { requestId, hasLayout: false, wasHidden };
    this.state.settings.enabled = true; this.hiddenOnDemand = false;
    this.reconcileVisibility();
    this.report(`focus-request ${JSON.stringify({ requestId, ready: this.ready, layoutReady: this.layoutReady, wasHidden, wasStashed })}`);
    this.requestRendererFocus();
    await this.persist(); this.publish();
  }
  private requestRendererFocus(): void {
    if (this.ready && this.pendingFocus) this.deps.emit?.('desktop-pet:focus', { type: 'focus-input', requestId: this.pendingFocus.requestId, wasHidden: this.pendingFocus.wasHidden });
  }
  private cancelFocus(): void {
    const pending = this.pendingFocus; this.pendingFocus = undefined; this.visibilitySequence++;
    if (pending) this.deps.emit?.('desktop-pet:focus', { type: 'cancel-focus', requestId: pending.requestId });
  }
  completeFocus(id: number, requestId: number, layoutRevision: number): boolean {
    const win = this.requireOwner(id), pending = this.pendingFocus;
    if (!pending || pending.requestId !== requestId || requestId !== this.visibilitySequence || !pending.hasLayout || pending.layoutRevision !== layoutRevision || this.layoutRevision !== layoutRevision || !this.ready || !this.layoutReady || !this.shouldShow()) {
      this.report(`focus-rejected ${JSON.stringify({ requestId, pendingRequestId: pending?.requestId, layoutRevision, currentLayoutRevision: this.layoutRevision, ready: this.ready, layoutReady: this.layoutReady, shouldShow: this.shouldShow() })}`);
      return false;
    }
    this.pendingFocus = undefined; this.reconcileVisibility(); this.setKeyboard(id, true);
    const visible = !win.isDestroyed() && win.isVisible();
    this.report(`focus-completed ${JSON.stringify({ requestId, layoutRevision, visible, focused: !win.isDestroyed() && win.isFocused(), keyboard: this.keyboard })}`);
    return visible;
  }
  private interactionReserved(): boolean { return Boolean(this.deps.isSessionReserved?.()) || [...this.interactionReservations.values()].some(count => count > 0); }
  private shouldShow(): boolean { return this.initialized && this.state.settings.enabled && !this.hiddenOnDemand && !this.quitting && !this.suspended; }
  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = this.deps.createWindow(), ownerId = win.webContents.id; this.window = win; this.ready = false; this.layoutReady = false; this.measuredLayout = undefined; this.passThrough = undefined; this.forwarding = undefined; this.inputShapeApplied = false; this.lastPointer = undefined;
    this.deps.registerOwner?.(win);
    this.notifyVisibility(ownerId, false);
    win.on('show', () => { this.notifyVisibility(ownerId, true); this.updatePointerTracking(); });
    win.on('hide', () => {
      if (this.quitting || this.window !== win || win.isDestroyed()) return;
      this.cancelFocus(); this.cancelNativeDrag(); this.drag = undefined; this.cancelMomentum(); this.setKeyboard(ownerId, false); this.notifyVisibility(ownerId, false); this.updatePointerTracking(); this.updateOutsideClicks();
    });
    win.setAlwaysOnTop(true, 'floating'); win.setMenuBarVisibility(false);
    win.setVisibleOnAllWorkspaces(true, (this.deps.platform ?? process.platform) === 'darwin' ? { visibleOnFullScreen: true, skipTransformProcessType: true } : undefined);
    win.setFocusable(false);
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('before-input-event', (_event, input) => {
      const primaryModifier = (this.deps.platform ?? process.platform) === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
      const digit = ['Digit0', 'Digit1', 'Numpad0', 'Numpad1'].includes(input.code) || input.key === '0' || input.key === '1';
      win.webContents.setIgnoreMenuShortcuts(this.keyboard && this.composerFocused && primaryModifier && !input.alt && !input.shift && digit);
    });
    win.on('blur', () => {
      if (this.quitting || this.window !== win || win.isDestroyed()) return;
      this.setKeyboard(ownerId, false);
    });
    win.on('close', event => { if (!this.quitting) { event.preventDefault(); void this.hide().catch(error => this.report(error)); } });
    win.on('closed', () => { this.interactionReservations.delete(ownerId); this.notifyVisibility(ownerId, false); this.deps.unregisterOwner?.(ownerId); if (this.window === win) { this.cancelFocus(); this.cancelNativeDrag(); this.drag = undefined; this.cancelMomentum(); this.keyboard = false; this.composerFocused = false; this.previousWindow = null; this.previousApplication = undefined; this.window = undefined; this.ready = false; this.layoutReady = false; this.stopPointer(); } });
    win.webContents.on('did-start-loading', () => { this.ready = false; this.layoutReady = false; win.hide(); this.notifyVisibility(ownerId, false); });
    win.webContents.on('render-process-gone', () => { this.notifyVisibility(ownerId, false); this.ready = false; this.report('Desktop pet renderer exited'); if (!win.isDestroyed()) win.destroy(); });
    this.positionWindow();
    void win.loadURL(this.deps.pageUrl).catch(error => { this.report(error); if (!win.isDestroyed()) win.destroy(); });
    return win;
  }
  rendererReady(id: number): PetState { this.requireOwner(id); this.ready = true; this.reconcileVisibility(); this.requestRendererFocus(); this.publish(); return this.snapshot(); }
  private reconcileVisibility(): void {
    if (!this.shouldShow()) { if (this.pendingFocus) this.cancelFocus(); this.setKeyboard(undefined, false); if (!this.hidingAnimation) this.window?.hide(); this.updatePointerTracking(); this.updateOutsideClicks(); this.updatePointer(); if (this.window) this.notifyVisibility(this.window.webContents.id, false); this.window?.webContents.setBackgroundThrottling(true); this.publish(); return; }
    const win = this.ensureWindow();
    win.webContents.setBackgroundThrottling(false);
    if (this.ready && this.layoutReady && !this.pendingFocus) {
      this.positionWindow();
      if (!win.isVisible()) {
        if (typeof win.setOpacity === 'function') win.setOpacity(0.01);
        win.showInactive(); void this.fadeWindow(win, 1, 300);
      }
      this.notifyVisibility(win.webContents.id, true);
    }
    this.updatePointerTracking(); this.updateOutsideClicks(); this.updatePointer();
  }
  private updateOutsideClicks(): void {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible() || !this.shouldShow() || this.state.settings.visibility !== 'on-demand' || this.interactionReserved()) { this.stopOutside?.(); this.stopOutside = undefined; return; }
    if (this.stopOutside) return;
    this.stopOutside = this.deps.observeOutsideClicks?.(point => {
      if (this.menuOpen || this.drag || this.interactionReserved() || !win.isVisible()) return;
      const bounds = win.getBounds();
      if (this.regions.some(region => containsPoint({ ...region, x: region.x + bounds.x, y: region.y + bounds.y }, point))) return;
      this.cancelFocus(); this.setKeyboard(undefined, false);
    }, win);
  }
  setLayout(id: number, value: PetElementLayout): PetState {
    this.requireOwner(id);
    const { width, height, pet } = value;
    if (![width, height, pet?.x, pet?.y, pet?.width, pet?.height].every(number => typeof number === 'number' && Number.isFinite(number)) || width < 1 || height < 1 || width > 4000 || height > 4000 || pet.width < 1 || pet.height < 1 || pet.x < 0 || pet.y < 0 || pet.x + pet.width > width || pet.y + pet.height > height) throw new Error('Invalid desktop pet layout');
    if (value.accessories && (![value.accessories.x, value.accessories.y, value.accessories.width, value.accessories.height].every(Number.isFinite) || value.accessories.width < 0 || value.accessories.height < 0 || value.accessories.width > 4000 || value.accessories.height > 4000)) throw new Error('Invalid desktop pet accessories');
    this.measuredLayout = { width: Math.ceil(width), height: Math.ceil(height), pet: { x: Math.round(pet.x), y: Math.round(pet.y), width: Math.round(pet.width), height: Math.round(pet.height) }, accessories: value.accessories ? { ...value.accessories } : undefined };
    if (!this.nativeDragStop) { this.state.layout.viewport = { width: this.measuredLayout.width, height: this.measuredLayout.height }; this.state.layout.pet = { ...this.measuredLayout.pet }; }
    this.layoutReady = true; this.state.layout.revision = ++this.layoutRevision;
    if (this.pendingFocus && value.focusRequestId === this.pendingFocus.requestId) { this.pendingFocus.hasLayout = true; this.pendingFocus.layoutRevision = this.layoutRevision; }
    if (this.nativeDragStop) {
      this.deferredDragLayout = true;
      if (this.measuredLayout.accessories) {
        const measured = this.measuredLayout, display = screen.getDisplayNearestPoint(this.anchor);
        const draw = layoutPetWindow(this.anchor, measured.pet, measured, display.workArea, null, false, measured.accessories);
        this.state.layout.contentOffset = { x: this.state.layout.pet.x - measured.pet.x, y: this.state.layout.pet.y - measured.pet.y };
        this.state.layout.accessoryOffset = draw.accessoryOffset; this.publish();
      }
      return this.snapshot();
    }
    this.positionWindow(); this.reconcileVisibility(); this.publish(); return this.snapshot();
  }
  setRegions(id: number, regions: PetRect[]): void {
    this.requireOwner(id);
    if (!Array.isArray(regions) || regions.length > 100 || regions.some(rect => ![rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0)) throw new Error('Invalid pointer regions');
    this.regions = regions;
    const win = this.window as BrowserWindow & { setInputShape?(rectangles: PetRect[]): boolean };
    try { this.inputShapeApplied = win.setInputShape?.(regions.map(rect => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) }))) === true; } catch (error) { this.report(error); }
    this.updatePointer();
  }
  setComposerFocused(id: number, focused: boolean): void {
    const win = this.requireOwner(id); this.composerFocused = focused;
    if (!focused) win.webContents.setIgnoreMenuShortcuts(false);
  }
  setKeyboard(id: number | undefined, active: boolean): void {
    const win = id === undefined ? this.window : this.requireOwner(id); if (!win || win.isDestroyed()) return;
    if (active && (!this.shouldShow() || !this.ready || !this.layoutReady || this.pendingFocus)) return;
    if (!active) {
      this.composerFocused = false; win.webContents.setIgnoreMenuShortcuts?.(false);
      if (!this.keyboard) { this.updatePointer(); return; }
    }
    if (active && !this.keyboard) { this.previousWindow = BrowserWindow.getFocusedWindow(); const application = this.deps.captureActiveApplication?.(); this.previousApplication = this.previousWindow ? undefined : application; }
    const restorePrevious = !active && win.isFocused();
    this.keyboard = active;
    // Present the nonactivating panel before assigning its native key window.
    if (active && this.deps.focusWindow) { win.showInactive(); this.notifyVisibility(win.webContents.id, true); }
    const nativeFocusHandled = this.deps.focusWindow?.(win, active) === true;
    if (nativeFocusHandled) {
      if (active) win.webContents.focus();
    } else {
      win.setFocusable(active);
      if (active) { win.show(); this.notifyVisibility(win.webContents.id, true); if ((this.deps.platform ?? process.platform) === 'darwin') this.deps.activateApplication?.(); win.focus(); win.webContents.focus(); }
    }
    if (!active) {
      if (restorePrevious && this.previousWindow && this.previousWindow !== win && !this.previousWindow.isDestroyed()) this.previousWindow.focus();
      else if (restorePrevious && this.previousApplication) { const result = this.deps.restoreActiveApplication?.(this.previousApplication); if (result instanceof Promise) void result.catch(error => this.report(error)); }
      this.previousWindow = null; this.previousApplication = undefined;
    }
    this.updatePointer();
  }
  private updatePointerTracking(): void {
    const win = this.window;
    if (!win || win.isDestroyed() || !win.isVisible() || !this.ready) { if (this.proximity) clearInterval(this.proximity); this.proximity = undefined; this.lastPointer = undefined; return; }
    if (!this.proximity) { this.proximity = setInterval(() => this.updatePointer(), 32); this.proximity.unref(); }
  }
  private updatePointer(): void {
    const win = this.window; if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) { if (this.passThrough !== true || this.forwarding !== false) win.setIgnoreMouseEvents(true, { forward: false }); this.passThrough = true; this.forwarding = false; this.lastPointer = undefined; return; }
    const pointer = screen.getCursorScreenPoint(), bounds = win.getBounds();
    const local = { x: pointer.x - bounds.x, y: pointer.y - bounds.y };
    const interactive = Boolean(this.drag || this.menuOpen || this.regions.some(rect => containsPoint(rect, local)));
    const ignore = this.inputShapeApplied ? false : !interactive;
    if (ignore !== this.passThrough || this.forwarding !== ignore) { win.setIgnoreMouseEvents(ignore, { forward: ignore }); this.passThrough = ignore; this.forwarding = ignore; }
    if (this.ready && (this.lastPointer?.x !== local.x || this.lastPointer?.y !== local.y)) { this.lastPointer = local; this.deps.emit?.('desktop-pet:pointer', local); }
  }
  private positionWindow(): void {
    const win = this.window; if (!win || win.isDestroyed() || this.nativeDragStop) return;
    const measured = this.measuredLayout;
    // Defer native surface sizing until this renderer supplies its first real layout.
    if (!measured) return;
    const pet = measured.pet, viewport = { width: measured.width, height: measured.height };
    const requestedAnchor = this.pendingLayoutAnchor ?? this.anchor;
    const display = (this.stashedEdge || this.stashAnimating) && screen.getAllDisplays().find(item => item.id === this.activeDisplayId) || screen.getDisplayNearestPoint({ x: Math.round(requestedAnchor.x + pet.width / 2), y: Math.round(requestedAnchor.y + pet.height / 2) });
    this.state.layout.workArea = { ...display.workArea };
    const placement = petPlacement(requestedAnchor, display.workArea);
    // Keep room for the compact controls and desktop margin before hover reveals them.
    const visibleAnchor = this.state.settings.showPet && !this.stashedEdge ? clampPet(requestedAnchor, { width: pet.width, height: pet.height + 40 + 4 + 16 }, display.workArea) : requestedAnchor;
    const draw = layoutPetWindow(visibleAnchor, pet, viewport, display.workArea, this.stashedEdge, this.stashAnimating, measured?.accessories);
    const { bounds, anchor } = draw;
    this.state.layout.pet = draw.pet ?? { ...pet }; this.state.layout.viewport = { width: bounds.width, height: bounds.height };
    this.state.layout.contentOffset = draw.contentOffset; this.state.layout.accessoryOffset = draw.accessoryOffset;
    this.anchor = anchor;
    // Preserve the requested corner until the renderer has moved its local pet rectangle.
    this.pendingLayoutAnchor = !this.stashedEdge && petPlacement(anchor, display.workArea) !== placement ? requestedAnchor : undefined;
    this.activeDisplayId = display.id; this.activeDisplayBounds = { ...display.bounds };
    this.state.layout.placement = placement;
    const centerOffset = this.anchor.x + pet.width / 2 - (display.bounds.x + display.bounds.width / 2);
    const nearestEdge = Math.abs(centerOffset) <= 0.5 ? undefined : centerOffset < 0 ? 'left' : 'right';
    this.state.layout.stashEdges = (['left', 'right'] as const).filter(edge => canStashPet(edge, display.bounds, display.workArea) && (!nearestEdge || edge === nearestEdge));
    if (this.nativeDragStop) return;
    const current = win.getBounds();
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height) win.setBounds(bounds);
    const origin = win.getContentBounds?.() ?? bounds;
    this.state.layout.origin = { x: origin.x, y: origin.y };
  }
  private point(value?: PetDragPoint): PetPoint { return value && Number.isFinite(value.screenX) && Number.isFinite(value.screenY) ? { x: value.screenX!, y: value.screenY! } : screen.getCursorScreenPoint(); }
  startDrag(id: number, value: PetDragPoint): void {
    this.requireOwner(id); this.cancelNativeDrag(); this.suppressNextRendererThrow = false; this.clearDetachedPosition(); this.cancelMomentum(); this.pendingLayoutAnchor = undefined; const point = this.point(value); this.stashedEdge = null; this.stashRestoreAnchor = undefined;
    this.nativeDragStart = this.deps.startNativeDrag && (this.deps.platform ?? process.platform) === 'darwin' && screen.getAllDisplays().length === 1 ? point : undefined;
    this.drag = { offset: { x: point.x - this.anchor.x, y: point.y - this.anchor.y }, last: point, lastAt: Date.now(), velocity: { x: 0, y: 0 }, moved: false }; this.updatePointer();
  }
  moveDrag(id: number, value?: PetDragPoint): void {
    this.requireOwner(id); const drag = this.drag; if (!drag) return;
    if (this.nativeDragStop) return;
    const point = this.point(value), now = Date.now(), elapsed = Math.max(1, now - drag.lastAt);
    drag.velocity = { x: (point.x - drag.last.x) * 1000 / elapsed, y: (point.y - drag.last.y) * 1000 / elapsed };
    drag.moved ||= Math.hypot(point.x - drag.last.x, point.y - drag.last.y) > 1;
    drag.last = point; drag.lastAt = now;
    if (drag.moved && this.nativeDragStart) {
      const start = this.nativeDragStart; this.nativeDragStart = undefined;
      try { this.nativeDragStop = this.deps.startNativeDrag?.(this.requireOwner(id), start, event => {
        if (!this.drag || !this.nativeDragStop) return;
        this.anchor = { x: event.windowX + this.state.layout.pet.x, y: event.windowY + this.state.layout.pet.y };
        const display = screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) }); this.activeDisplayId = display.id; this.activeDisplayBounds = { ...display.bounds };
        if (this.measuredLayout?.accessories) {
          const natural = this.measuredLayout, bounds = this.requireOwner(id).getBounds();
          this.state.layout.origin = { x: bounds.x, y: bounds.y };
          const local = { ...natural.pet, x: this.state.layout.pet.x, y: this.state.layout.pet.y };
          const draw = layoutPetWindow(this.anchor, natural.pet, natural, display.workArea, null, false, natural.accessories);
          this.state.layout.accessoryOffset = draw.accessoryOffset;
          this.state.layout.contentOffset = { x: local.x - natural.pet.x, y: local.y - natural.pet.y };
          this.anchor = { x: bounds.x + local.x, y: bounds.y + local.y }; this.state.layout.placement = petPlacement(this.anchor, display.workArea); this.publish();
        }
        if (event.ended) this.endDrag(id, undefined, event.altKey);
      }, petWindowOriginBounds(this.state.layout.pet, screen.getDisplayNearestPoint(start).workArea)); } catch (error) { this.report(error); }
      if (this.nativeDragStop) return;
    }
    const previousPlacement = this.state.layout.placement;
    this.pendingLayoutAnchor = undefined;
    this.anchor = { x: point.x - drag.offset.x, y: point.y - drag.offset.y }; this.positionWindow();
    if (this.measuredLayout?.accessories || previousPlacement !== this.state.layout.placement) this.publish();
  }
  endDrag(id: number, value?: PetDragPoint, altKey = false): void {
    this.requireOwner(id); if (!this.drag) return;
    const native = Boolean(this.nativeDragStop);
    if (native) { const bounds = this.requireOwner(id).getBounds(); this.anchor = { x: bounds.x + this.state.layout.pet.x, y: bounds.y + this.state.layout.pet.y }; this.cancelNativeDrag(); }
    else { this.nativeDragStart = undefined; this.moveDrag(id, value); }
    const drag = this.drag; this.drag = undefined; this.nativeDragStart = undefined; this.deferredDragLayout = false; this.suppressNextRendererThrow = native || (altKey && drag.moved);
    if (altKey && drag.moved) { this.pendingLayoutAnchor = undefined; const display = screen.getDisplayNearestPoint(this.point(value)); this.animateAnchor(snapPet(this.anchor, this.state.layout.pet, display.workArea), display.displayFrequency || 60); this.updatePointer(); this.publish(); return; }
    this.positionWindow(); this.schedulePersist(); this.updatePointer(); this.publish();
  }
  throw(id: number, velocityX: number, velocityY: number, bounce = false): void {
    this.requireOwner(id);
    const suppressed = this.suppressNextRendererThrow; this.suppressNextRendererThrow = false; if (suppressed && !bounce) return;
    if (![velocityX, velocityY].every(Number.isFinite)) throw new Error('Invalid throw velocity');
    this.cancelMomentum(); let vx = clamp(velocityX, -6000, 6000), vy = clamp(velocityY, -6000, 6000), last = Date.now(), started = last;
    const tick = () => {
      const win = this.window; if (!win || win.isDestroyed() || !win.isVisible()) { this.cancelMomentum(); return; }
      const now = Date.now(), elapsed = Math.min(PET_MOTION.maximumStepMs, Math.max(0, now - last)); last = now;
      const proposed = { x: this.anchor.x + vx * elapsed / 1000, y: this.anchor.y + vy * elapsed / 1000 };
      const display = screen.getDisplayNearestPoint({ x: Math.round(proposed.x), y: Math.round(proposed.y) });
      const next = clampPet(proposed, this.state.layout.pet, display.workArea);
      if (next.x !== Math.round(proposed.x)) vx = bounce ? -vx * PET_MOTION.bounce : 0;
      if (next.y !== Math.round(proposed.y)) vy = bounce ? -vy * PET_MOTION.bounce : 0;
      const friction = Math.pow(PET_MOTION.decay, elapsed / PET_MOTION.intervalMs); vx *= friction; vy *= friction;
      const previousPlacement = this.state.layout.placement;
      this.pendingLayoutAnchor = undefined; this.anchor = next; this.positionWindow(); if (this.measuredLayout?.accessories || previousPlacement !== this.state.layout.placement) this.publish();
      if (Math.hypot(vx, vy) < PET_MOTION.minimumSpeed || now - started >= PET_MOTION.maximumDurationMs) { this.cancelMomentum(); this.schedulePersist(); return; }
      this.momentum = setTimeout(tick, 16);
    }; this.momentum = setTimeout(tick, 16);
  }
  private cancelNativeDrag(): void { this.nativeDragStop?.(); this.nativeDragStop = undefined; this.nativeDragStart = undefined; }
  private animateAnchor(target: PetPoint | (() => PetPoint), frequency = 60, settled?: () => void): void {
    this.cancelMomentum(); let vx = 0, vy = 0, last = Date.now(), started = last; const interval = 1000 / frequency;
    const destination = () => typeof target === 'function' ? target() : target;
    const tick = () => {
      const win = this.window; if (!win || win.isDestroyed() || !win.isVisible()) { this.cancelMomentum(); return; }
      const now = Date.now(), elapsed = Math.min(PET_MOTION.maximumStepMs, Math.max(0, now - last)) / 1000, goal = destination(); last = now;
      vx += (PET_MOTION.spring * (goal.x - this.anchor.x) - PET_MOTION.damping * vx) * elapsed;
      vy += (PET_MOTION.spring * (goal.y - this.anchor.y) - PET_MOTION.damping * vy) * elapsed;
      const placement = this.state.layout.placement; this.anchor = { x: this.anchor.x + vx * elapsed, y: this.anchor.y + vy * elapsed }; this.positionWindow(); if (this.measuredLayout?.accessories || placement !== this.state.layout.placement) this.publish();
      if (now - started >= 1000 || Math.hypot(goal.x - this.anchor.x, goal.y - this.anchor.y) <= 0.5 && Math.hypot(vx, vy) < 10) { this.anchor = goal; this.cancelMomentum(); this.positionWindow(); settled?.(); this.schedulePersist(); this.publish(); return; }
      this.momentum = setTimeout(tick, interval);
    }; this.momentum = setTimeout(tick, interval);
  }
  stash(id: number, edge: 'left' | 'right' | null): void {
    this.requireOwner(id); if (this.drag || this.stashedEdge === edge) return; this.cancelMomentum();
    const display = screen.getAllDisplays().find(item => item.id === this.activeDisplayId) ?? screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) });
    const centerOffset = this.anchor.x + this.state.layout.pet.width / 2 - (display.bounds.x + display.bounds.width / 2);
    const nearestEdge = Math.abs(centerOffset) <= 0.5 ? undefined : centerOffset < 0 ? 'left' : 'right';
    if (edge && (!canStashPet(edge, display.bounds, display.workArea) || nearestEdge && edge !== nearestEdge)) return;
    if (edge) { this.cancelFocus(); this.setKeyboard(undefined, false); if (!this.stashedEdge) this.stashRestoreAnchor = { ...this.anchor }; }
    const restore = this.stashRestoreAnchor ?? { ...this.anchor };
    this.pendingLayoutAnchor = undefined; this.stashedEdge = edge;
    this.animateAnchor(() => edge ? { x: edge === 'left' ? display.workArea.x - this.state.layout.pet.width + 24 : display.workArea.x + display.workArea.width - 24, y: restore.y } : clampPet(restore, this.state.layout.pet, display.workArea), display.displayFrequency || 60, () => { if (!edge) this.stashRestoreAnchor = undefined; });
    this.stashAnimating = true; this.publish();
  }
  private clearDetachedPosition(): void { if (this.detachedTimer) clearTimeout(this.detachedTimer); this.detachedTimer = undefined; this.detachedPosition = undefined; }
  private reconcileDisplays(): void {
    if (!this.initialized || this.quitting || this.suspended || this.drag) return;
    this.cancelMomentum();
    const displays = screen.getAllDisplays();
    const returning = this.detachedPosition && displays.find(display => display.id === this.detachedPosition?.displayId || JSON.stringify(display.bounds) === JSON.stringify(this.detachedPosition?.displayBounds));
    let display = displays.find(item => item.id === this.activeDisplayId);
    if (returning && this.detachedPosition) { this.anchor = restorePetPosition(this.detachedPosition, returning.bounds); display = returning; this.clearDetachedPosition(); }
    else if (!display && this.activeDisplayId !== undefined && !this.detachedPosition && this.activeDisplayBounds) {
      this.detachedPosition = { ...this.anchor, displayId: this.activeDisplayId, displayBounds: this.activeDisplayBounds };
      this.detachedTimer = setTimeout(() => this.clearDetachedPosition(), 10_000); this.detachedTimer.unref();
    } else if (display && this.activeDisplayBounds && JSON.stringify(display.bounds) !== JSON.stringify(this.activeDisplayBounds)) {
      const saved = this.saved.byDisplay?.[String(display.id)] ?? this.saved.byResolution?.[resolutionKey(display.bounds)];
      this.anchor = saved ? restorePetPosition(saved, display.bounds) : restorePetPosition({ ...this.anchor, displayBounds: this.activeDisplayBounds }, display.bounds);
    }
    display ??= screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) });
    if (this.stashedEdge && !canStashPet(this.stashedEdge, display.bounds, display.workArea)) { this.stashedEdge = null; if (this.stashRestoreAnchor) this.anchor = this.stashRestoreAnchor; this.stashRestoreAnchor = undefined; }
    this.anchor = clampPet(this.anchor, this.state.layout.pet, display.workArea);
    this.positionWindow(); this.schedulePersist(); this.publish();
  }
  private schedulePersist(): void { if (this.persistTimer) clearTimeout(this.persistTimer); this.persistTimer = setTimeout(() => { this.persistTimer = undefined; void this.persist().catch(error => this.report(error)); }, 150); }
  private persist(): Promise<void> {
    const display = screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) });
    const position: Position = { ...(this.stashRestoreAnchor ?? this.anchor), displayId: display.id, displayBounds: display.bounds, placement: this.state.layout.placement };
    this.saved = { settings: this.state.settings, position, byDisplay: { ...this.saved.byDisplay, [String(display.id)]: position }, byResolution: { ...this.saved.byResolution, [resolutionKey(display.bounds)]: position }, mutedTasks: Object.fromEntries(this.mutedTasks) };
    const data = JSON.stringify(this.saved, null, 2);
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => { await fs.mkdir(this.deps.dataDirectory, { recursive: true }); const temporary = `${this.settingsPath}.tmp`; await fs.writeFile(temporary, data, { mode: 0o600 }); await fs.rename(temporary, this.settingsPath); });
    return this.saveQueue;
  }
  setTasks(tasks: PetTask[]): void {
    this.state.tasks = tasks.map(task => ({ ...task }));
    for (const task of tasks) if (this.mutedTasks.has(task.id) && this.mutedTasks.get(task.id) !== task.title) { this.mutedTasks.set(task.id, task.title); this.schedulePersist(); }
    this.publish();
  }
  async setTaskMuted(id: string, muted: boolean): Promise<PetState> {
    await this.initialize();
    if (this.quitting) throw new Error('Task is unavailable');
    const task = this.state.tasks.find(item => item.id === id);
    if (!task && !this.mutedTasks.has(id)) throw new Error('Task is unavailable');
    if (muted) this.mutedTasks.set(id, task?.title ?? this.mutedTasks.get(id)!); else this.mutedTasks.delete(id);
    await this.persist(); this.publish(); return this.snapshot();
  }
  asset(id: string): Promise<{ bytes: Uint8Array; mime: string }> { return this.catalog.asset(id); }
  acknowledgeTask(id: string): void { this.deps.acknowledgeTask?.(id); this.state.tasks = this.state.tasks.map(task => task.id === id ? { ...task, unread: false } : task); this.publish(); }
  async openTask(id: string): Promise<void> {
    if (this.quitting) throw new Error('Task is unavailable');
    const task = this.state.tasks.find(item => item.id === id);
    if (!task && this.deps.ownsConversation?.(id)) {
      const win = this.window; if (!win || win.isDestroyed()) throw new Error('Task is unavailable'); this.requireOwner(win.webContents.id);
    } else if (!task) {
      const win = this.window;
      if (!win || win.isDestroyed() || !this.deps.voice) throw new Error('Task is unavailable');
      const ownerId = win.webContents.id;
      this.requireOwner(ownerId);
      const voice = await this.deps.voice.state(ownerId);
      if (this.quitting || this.window !== win || !this.ownsWebContents(ownerId) || voice.sessionId !== id) throw new Error('Task is unavailable');
    }
    if (task) this.acknowledgeTask(id);
    await this.deps.openTask(id);
  }
  dismissTask(id: string): void { this.deps.dismissTask?.(id); this.state.tasks = this.state.tasks.filter(task => task.id !== id); this.publish(); }
  clearCompleted(): void { for (const task of this.state.tasks) if (task.status === 'completed' || task.status === 'failed') this.deps.dismissTask?.(task.id); this.state.tasks = this.state.tasks.filter(task => task.status === 'running' || task.status === 'waiting'); this.publish(); }
  async openMain(): Promise<void> { await this.deps.openMain(); }
  async openSettings(): Promise<void> { await this.deps.openSettings(); }
  async submit(id: number, text: string): Promise<void> { this.requireOwner(id); if (!text.trim() || text.length > 8000) throw new Error('Enter a message of at most 8000 characters'); if (!this.deps.submit) throw new Error('Quick chat is unavailable'); await this.deps.submit(text.trim()); }
  async withInteraction<T>(ownerId: number, operation: () => Promise<T>): Promise<T> {
    const win = this.requireOwner(ownerId);
    if (!win.isVisible()) throw new Error('Desktop pet is not visible');
    const restoreKeyboard = this.keyboard;
    this.interactionReservations.set(ownerId, (this.interactionReservations.get(ownerId) ?? 0) + 1); this.updateOutsideClicks();
    try { return await operation(); }
    finally {
      const remaining = (this.interactionReservations.get(ownerId) ?? 1) - 1;
      if (remaining > 0) this.interactionReservations.set(ownerId, remaining); else this.interactionReservations.delete(ownerId);
      if (!this.quitting && this.window === win && !win.isDestroyed() && win.isVisible() && this.shouldShow()) {
        if (!remaining && restoreKeyboard) this.setKeyboard(ownerId, true);
        this.updateOutsideClicks(); this.updatePointer();
      }
    }
  }
  async voiceState(ownerId?: number): Promise<PetVoiceState> {
    if (ownerId !== undefined) this.requireOwner(ownerId);
    return this.deps.voice?.state(ownerId) ?? { available: false, phase: 'inactive', microphoneMuted: false, speakerMuted: false, unavailableReason: 'Realtime voice is not available for this model source.' };
  }
  async voiceAction(ownerId: number, action: 'start' | 'stop' | 'microphone' | 'speaker', muted = false): Promise<PetVoiceState> {
    if (!this.requireOwner(ownerId).isVisible()) throw new Error('Desktop pet is not visible');
    if (!this.deps.voice) return this.voiceState(ownerId);
    if (action === 'microphone' || action === 'speaker') return this.deps.voice[action](ownerId, muted);
    return this.deps.voice[action](ownerId);
  }
  private readonly responding = new Set<string>();
  async respondTask(ownerId: number, value: { taskId: string; requestId: string; response: unknown }): Promise<unknown> {
    const win = this.requireOwner(ownerId);
    if (!win.isVisible()) throw new Error('Desktop pet is not visible');
    const task = this.state.tasks.find(item => item.id === value.taskId);
    if (!task || task.status !== 'waiting' || task.attention?.id !== value.requestId) throw new Error('Task request is no longer active');
    if (value.response && typeof value.response === 'object' && (value.response as { kind?: unknown }).kind === 'open' && task.attention.kind !== 'mcp-url') throw new Error('Only a URL request can be opened');
    if (!this.deps.respondTask) throw new Error('Task responses are unavailable');
    const key = `${value.taskId}\u0000${value.requestId}`;
    if (this.responding.has(key)) throw new Error('Task response is already in progress');
    this.responding.add(key);
    try { return await this.deps.respondTask(value.taskId, value.requestId, value.response); }
    finally { this.responding.delete(key); }
  }
  async refreshCatalog(): Promise<PetState> { await this.initialize(); this.state.catalog = await this.catalog.list(); this.reconcileSelection(); this.publish(); return this.snapshot(); }
  async importFile(value: { name?: string; description?: string; spriteVersion?: 1 | 2 } = {}): Promise<PetState> {
    if (!this.deps.pickFile) throw new Error('Pet file picker is unavailable'); const filename = await this.deps.pickFile(); if (!filename) return this.snapshot();
    const pet = await this.catalog.importFile(filename, value.name, value.description, value.spriteVersion); await this.refreshCatalog(); await this.updateSettings({ selectedPetId: pet.id, showPet: true }); return this.snapshot();
  }
  async previewUrl(request: PetImportRequest) { return this.catalog.previewUrl(request); }
  async importUrl(request: PetImportRequest): Promise<PetState> { const pet = await this.catalog.importUrl(request); await this.refreshCatalog(); await this.updateSettings({ selectedPetId: pet.id, showPet: true }); return this.snapshot(); }
  async deletePet(id: string): Promise<PetState> { await this.catalog.delete(id); await this.refreshCatalog(); await this.persist(); return this.snapshot(); }
  async openDirectory(id?: string): Promise<void> {
    const directory = id ? this.state.catalog.find(pet => pet.id === id && !pet.builtIn)?.directoryPath : path.join(this.deps.dataDirectory, 'pets');
    if (!directory) throw new Error('Pet directory is unavailable'); await fs.mkdir(directory, { recursive: true });
    if (this.deps.openDirectory) await this.deps.openDirectory(directory); else { const error = await shell.openPath(directory); if (error) throw new Error(error); }
  }
  async createPet(id?: string): Promise<void> { if (!this.deps.createPet) throw new Error('Pet creation is unavailable'); const directory = id ? this.state.catalog.find(pet => pet.id === id && !pet.builtIn)?.directoryPath : undefined; if (id && !directory) throw new Error('Pet is unavailable'); await this.deps.createPet(directory); }
  contextMenu(id: number, taskId?: string): void {
    const win = this.requireOwner(id), zh = this.state.settings.language === 'zh', label = (en: string, cn: string) => zh ? cn : en;
    const task = taskId === undefined ? undefined : this.state.tasks.find(item => item.id === taskId);
    if (taskId !== undefined && !task) throw new Error('Task is unavailable');
    if (this.deps.isSessionReserved?.()) return;
    let closed = false, selected: (() => void) | undefined;
    const afterClose = (action: () => void) => { if (closed) action(); else selected = action; };
    const actions: MenuItemConstructorOptions[] = task ? [
      { label: label('Mute chat', '静音聊天'), click: () => { void this.setTaskMuted(task.id, true).catch(error => this.report(error)); } },
    ] : [
      { label: label('Settings', '设置'), click: () => afterClose(() => { void this.openSettings(); }) },
      { label: label('Hide Mini', '隐藏 Mini'), click: () => { void this.hide(); } },
    ];
    this.menuOpen = true; this.updatePointer(); this.publish();
    Menu.buildFromTemplate(actions).popup({ window: win, callback: () => { closed = true; this.menuOpen = false; this.updatePointer(); this.publish(); selected?.(); } });
  }
  private notifyVisibility(ownerId: number, visible: boolean): void {
    if (this.lastVisibility?.ownerId === ownerId && this.lastVisibility.visible === visible) return;
    this.lastVisibility = { ownerId, visible }; this.deps.visibilityChanged?.(ownerId, visible);
  }
  private restoreStashedPosition(): void {
    if (!this.stashedEdge) return;
    this.cancelMomentum(); this.stashedEdge = null; this.pendingLayoutAnchor = undefined;
    if (this.stashRestoreAnchor) this.anchor = { ...this.stashRestoreAnchor };
    this.stashRestoreAnchor = undefined;
  }
  private cancelMomentum(): void { if (this.momentum) clearTimeout(this.momentum); this.momentum = undefined; if (this.stashAnimating && !this.stashedEdge && this.stashRestoreAnchor) { this.anchor = this.stashRestoreAnchor; this.stashRestoreAnchor = undefined; } this.stashAnimating = false; }
  private clearHiddenCleanup(): void { if (this.hiddenCleanup) clearTimeout(this.hiddenCleanup); this.hiddenCleanup = undefined; }
  private scheduleHiddenCleanup(): void {
    this.clearHiddenCleanup(); if (this.quitting || this.shouldShow() || this.interactionReserved() || !this.window || this.window.isVisible()) return;
    this.hiddenCleanup = setTimeout(() => { this.hiddenCleanup = undefined; const win = this.window; if (!this.shouldShow() && !this.interactionReserved() && win && !win.isDestroyed() && !win.isVisible()) win.destroy(); }, 600_000); this.hiddenCleanup.unref();
  }
  private cancelFade(resetOpacity = true): void {
    if (this.fadeTimer) clearTimeout(this.fadeTimer); this.fadeTimer = undefined; this.fadeResolve?.(false); this.fadeResolve = undefined; this.hidingAnimation = false;
    const win = this.window; if (resetOpacity && win && !win.isDestroyed() && typeof win.setOpacity === 'function') win.setOpacity(1);
  }
  private fadeWindow(win: BrowserWindow, target: number, duration: number): Promise<boolean> {
    this.cancelFade(false); this.hidingAnimation = target === 0; if (win.isDestroyed() || !win.isVisible() || typeof win.setOpacity !== 'function') return Promise.resolve(false);
    const from = win.getOpacity(), started = Date.now();
    return new Promise(resolve => {
      this.fadeResolve = resolve;
      const tick = () => {
        if (win.isDestroyed() || !win.isVisible()) { this.fadeResolve = undefined; resolve(false); return; }
        const progress = Math.min(1, (Date.now() - started) / duration); win.setOpacity(from + (target - from) * (1 - (1 - progress) ** 3));
        if (progress === 1) { this.fadeTimer = undefined; this.fadeResolve = undefined; resolve(true); return; }
        this.fadeTimer = setTimeout(tick, Math.min(16, duration - (Date.now() - started)));
      }; tick();
    });
  }
  private stopPointer(): void { if (this.proximity) clearInterval(this.proximity); this.proximity = undefined; this.stopOutside?.(); this.stopOutside = undefined; }
  async shutdown(): Promise<void> {
    if (this.quitting) return; this.cancelFocus(); this.cancelNativeDrag(); this.setKeyboard(undefined, false); this.clearDetachedPosition(); this.cancelFade(); this.clearHiddenCleanup(); this.quitting = true; this.cancelMomentum(); this.stopPointer(); this.stopShortcut?.(); this.stopShortcut = undefined;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    screen.removeListener('display-added', this.displayChanged); screen.removeListener('display-removed', this.displayChanged); screen.removeListener('display-metrics-changed', this.displayChanged);
    powerMonitor.removeListener('suspend', this.suspend); powerMonitor.removeListener('resume', this.resume); powerMonitor.removeListener('lock-screen', this.suspend); powerMonitor.removeListener('unlock-screen', this.resume);
    if (this.initialized) await this.persist(); if (this.window && !this.window.isDestroyed()) { this.notifyVisibility(this.window.webContents.id, false); this.window.destroy(); } this.window = undefined;
  }
}
