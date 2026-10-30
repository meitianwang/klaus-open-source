import type { BrowserWindow, Rectangle } from 'electron';
import type { VoiceChatLevels, VoiceChatOverlayState, VoiceChatPresentation, VoiceChatState } from '../../contracts/voice-chat';
import { IpcHandlerError } from '../ipc/registry';

export interface VoiceChatPresentationDependencies {
  createWindow(): BrowserWindow;
  register(window: BrowserWindow): void;
  unregister(ownerId: number): void;
  pageUrl(): string;
  workArea(): Rectangle;
  send(window: BrowserWindow, state: VoiceChatOverlayState): void;
  ownerEligible(ownerId: number): boolean;
  preferences(): Pick<VoiceChatOverlayState, 'language' | 'dark'>;
  position?(): { x: number; y: number } | undefined;
  savePosition?(position: { x: number; y: number }): void;
  action(ownerId: number, action: 'microphone' | 'speaker' | 'stop', muted?: boolean): Promise<VoiceChatState>;
  open(ownerId: number, sessionId: string): Promise<void>;
  log(message: string): void;
}

/** Moves presentation between the conversation and a narrow native call surface. */
export class VoiceChatPresentationRuntime {
  private window?: BrowserWindow;
  private ownerId?: number;
  private state: VoiceChatState | null = null;
  private levels: VoiceChatLevels = { microphone: 0, output: 0 };
  private readonly views = new Map<number, VoiceChatPresentation>();
  private timer?: ReturnType<typeof setTimeout>;
  private pendingPresentation?: 'conversation' | 'floating';
  private ready = false;
  private drag?: { x: number; y: number; originX: number; originY: number; moved: boolean };
  private closed = false;
  private notice?: string;
  private noticePlacement: 'above' | 'below' = 'above';
  private noticeTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly deps: VoiceChatPresentationDependencies) {}
  owns(id: number): boolean { return this.window?.webContents.id === id && !this.window.isDestroyed(); }
  snapshot(): VoiceChatOverlayState { return { state: this.state ? { ...this.state, transcript: [] } : null, levels: { ...this.levels }, notice: this.notice, noticePlacement: this.noticePlacement, ...this.deps.preferences() }; }
  update(ownerId: number, state: VoiceChatState): void {
    if (state.phase === 'connecting' && this.state?.phase !== 'connecting') { this.notice = undefined; clearTimeout(this.noticeTimer); }
    this.ownerId = ownerId; this.state = state;
    if (state.phase === 'inactive') this.levels = { microphone: 0, output: 0 };
    this.send(); this.reconcile();
  }
  present(ownerId: number, value: VoiceChatPresentation): void {
    const previous = this.views.get(ownerId); this.views.set(ownerId, value);
    if (ownerId === this.ownerId && value.notice && value.notice !== previous?.notice && !this.eligible()) this.showNotice(value.notice);
    this.reconcile();
  }
  private showNotice(message: string): void {
    clearTimeout(this.noticeTimer); this.notice = message; this.send(); this.reconcile();
    this.noticeTimer = setTimeout(() => { this.notice = undefined; this.send(); this.reconcile(); }, 4000);
  }
  audioLevels(ownerId: number, value: VoiceChatLevels): void { if (ownerId !== this.ownerId) return; this.levels = value; this.send(); }
  changed(): void { this.reconcile(); }
  releaseOwner(ownerId: number): void { this.views.delete(ownerId); if (this.ownerId === ownerId) { this.state = null; this.ownerId = undefined; this.notice = undefined; clearTimeout(this.noticeTimer); this.reconcile(); } }
  private layoutNotice(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getBounds(), area = this.deps.workArea();
    this.noticePlacement = this.notice && area.y + area.height - (bounds.y + 320) >= 128 ? 'below' : 'above';
    const height = this.notice && this.noticePlacement === 'below' ? 448 : 320;
    if (bounds.width !== 356 || bounds.height !== height) this.window.setSize(356, height);
  }
  private send(): void { this.layoutNotice(); if (this.ready && this.window && !this.window.isDestroyed()) this.deps.send(this.window, this.snapshot()); }
  private eligible(): boolean {
    const ownerId = this.ownerId, view = ownerId === undefined ? undefined : this.views.get(ownerId);
    return ownerId !== undefined && !!view?.eligible && view.sessionId === this.state?.sessionId && this.deps.ownerEligible(ownerId);
  }
  private reconcile(): void {
    if (this.closed) return;
    if (!this.state || this.state.phase === 'inactive' && !this.notice) { clearTimeout(this.timer); this.pendingPresentation = undefined; this.window?.hide(); return; }
    const desired = this.eligible() ? 'conversation' : 'floating';
    if (this.pendingPresentation === desired) return;
    clearTimeout(this.timer); this.pendingPresentation = desired;
    if (desired === 'conversation') { this.timer = setTimeout(() => { this.pendingPresentation = undefined; if (this.eligible()) this.window?.hide(); }, 250); return; }
    if (this.window?.isVisible()) return;
    this.timer = setTimeout(() => { this.pendingPresentation = undefined; if (!this.closed && this.state && (this.state.phase !== 'inactive' || this.notice) && !this.eligible()) void this.show().catch(error => this.deps.log(String(error))); }, 50);
  }
  private async show(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      const window = this.deps.createWindow(); this.window = window; this.ready = false;
      this.deps.register(window);
      window.setSize(356, 320);
      const area = this.deps.workArea(), size = window.getBounds();
      const saved = this.deps.position?.();
      window.setPosition(Math.round(saved?.x ?? area.x + area.width - size.width - 24), Math.round(saved?.y ?? area.y + area.height - size.height - 24));
      window.setIgnoreMouseEvents(true, { forward: true });
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      const id = window.webContents.id;
      window.on('closed', () => { this.deps.unregister(id); if (this.window === window) { this.window = undefined; this.ready = false; this.pendingPresentation = undefined; } });
      window.webContents.on('render-process-gone', () => { if (!window.isDestroyed()) window.destroy(); });
      await window.loadURL(this.deps.pageUrl());
      if (this.closed || this.window !== window || window.isDestroyed()) return;
    }
    if (this.state && (this.state.phase !== 'inactive' || this.notice) && !this.eligible()) { this.window.showInactive(); this.send(); }
  }
  rendererReady(ownerId: number): VoiceChatOverlayState {
    if (!this.owns(ownerId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice presentation');
    this.ready = true; this.layoutNotice(); return this.snapshot();
  }
  interaction(ownerId: number, interactive: boolean): void {
    if (!this.owns(ownerId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice presentation');
    this.window!.setIgnoreMouseEvents(!interactive && !this.drag, { forward: true });
  }
  async move(ownerId: number, phase: string, x: number, y: number): Promise<void> {
    if (!this.owns(ownerId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Unknown voice presentation');
    const window = this.window!;
    if (phase === 'start') { const bounds = window.getBounds(); this.drag = { x, y, originX: bounds.x, originY: bounds.y, moved: false }; return; }
    const drag = this.drag; if (!drag) return;
    const dx = x - drag.x, dy = y - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (phase === 'move' && drag.moved) {
      const area = this.deps.workArea(), bounds = window.getBounds();
      window.setPosition(Math.round(Math.min(area.x + area.width - 100, Math.max(area.x - bounds.width + 100, drag.originX + dx))), Math.round(Math.min(area.y + area.height - 100, Math.max(area.y, drag.originY + dy))));
      this.send();
    }
    if (phase === 'end' || phase === 'cancel') {
      this.drag = undefined;
      if (drag.moved) { const bounds = window.getBounds(); this.deps.savePosition?.({ x: bounds.x, y: bounds.y }); }
      else if (phase === 'end' && this.ownerId !== undefined && this.state?.sessionId) await this.deps.open(this.ownerId, this.state.sessionId);
    }
  }
  async control(ownerId: number, action: string, generation: number): Promise<void> {
    if (!this.owns(ownerId) || this.ownerId === undefined || !this.state || generation !== this.state.generation || this.state.phase === 'inactive') throw new IpcHandlerError('VOICE_EXPIRED', 'The voice presentation changed');
    if (action === 'open') { if (this.state.sessionId) await this.deps.open(this.ownerId, this.state.sessionId); return; }
    if (action === 'end') {
      const id = this.ownerId;
      try { const state = await this.deps.action(id, 'stop'); this.update(id, state); }
      catch (error) { this.showNotice('Unable to stop voice chat'); throw error; }
      return;
    }
    if (action !== 'microphone' && action !== 'speaker') throw new IpcHandlerError('BAD_REQUEST', 'Unknown voice presentation action');
    await this.deps.action(this.ownerId, action, !(action === 'microphone' ? this.state.microphoneMuted : this.state.speakerMuted));
  }
  close(): void { this.closed = true; clearTimeout(this.timer); clearTimeout(this.noticeTimer); if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.views.clear(); }
}
