import type { BrowserWindow } from 'electron';
import { IpcHandlerError } from '../ipc/registry';
import type { RecordingState } from '../services/recording/store';
import type { RecordingResult, RecordingService } from '../services/recording/service';

interface Panel { window: BrowserWindow; id: number; recordingId: string; ready: Promise<void>; retired: boolean; dispose(): void }
export interface RecorderPanelDependencies {
  /** Create the existing recorder window and begin loading recorder.html. */
  createWindow(): BrowserWindow;
  registerOwner(window: BrowserWindow): void;
  unregisterOwner(id: number): void;
  log(message: string): void;
  deadlineMs?: number;
}
/** Every panel is permanently bound to one recording, including across reload and closure. */
export class RecorderPanel {
  private panel?: Panel;
  private service?: RecordingService;
  private closing = false;
  constructor(private readonly deps: RecorderPanelDependencies) {}
  bind(service: RecordingService): void { if (this.service) throw new Error('recorder-panel-already-bound'); this.service = service; }
  async show(state: RecordingState): Promise<void> {
    if (this.closing || !this.service) throw new Error('recorder-panel-closed-or-unbound');
    if (this.panel) {
      if (this.panel.recordingId !== state.id || this.panel.retired) throw new Error('recorder-panel-busy');
      return this.panel.ready;
    }
    const window = this.deps.createWindow();
    let resolve!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void ready.catch(() => {});
    const panel: Panel = { window, id: window.webContents.id, recordingId: state.id, ready, retired: false, dispose: () => {} };
    this.panel = panel;
    let loaded = false, navigationSeen = false;
    const timer = setTimeout(() => fail('recorder-panel-load-timeout'), this.deps.deadlineMs ?? 10_000);
    const dispose = () => {
      clearTimeout(timer); panel.retired = true; this.deps.unregisterOwner(panel.id);
      window.removeListener('closed', closed); window.removeListener('hide', hidden);
      window.webContents.removeListener('did-finish-load', loadedPage);
      window.webContents.removeListener('did-start-navigation', navigation);
      window.webContents.removeListener('render-process-gone', gone);
      window.webContents.removeListener('did-fail-load', failedLoad);
      if (this.panel === panel) this.panel = undefined;
    };
    const fail = (reason: string) => {
      if (panel.retired) return;
      reject(new Error(reason)); dispose(); if (!window.isDestroyed()) window.destroy();
      void this.service!.stop(panel.recordingId, 'stop').catch(error => this.deps.log(error instanceof Error ? error.message : 'recorder-stop-failed'));
    };
    const loadedPage = () => { loaded = true; clearTimeout(timer); resolve(); };
    const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (loaded || navigationSeen) fail('recorder-panel-navigated'); else navigationSeen = true;
    };
    const gone = () => fail('recorder-panel-renderer-exited');
    const failedLoad = () => fail('recorder-panel-load-failed');
    const hidden = () => { if (!window.isVisible()) fail('recorder-panel-hidden'); };
    const closed = () => { if (!panel.retired) fail('recorder-panel-window-closed'); };
    try { this.deps.registerOwner(window); }
    catch (error) { dispose(); window.destroy(); throw error; }
    window.webContents.on('did-finish-load', loadedPage); window.webContents.on('did-start-navigation', navigation);
    window.webContents.on('render-process-gone', gone); window.webContents.on('did-fail-load', failedLoad);
    window.on('closed', closed); window.on('hide', hidden);
    // Programmatic closure removes all callbacks before destroying this window.
    panel.dispose = () => { reject(new Error('recorder-panel-closed')); dispose(); };
    await ready;
  }
  private owner(id: number): Panel {
    if (this.closing || !this.panel || this.panel.retired || this.panel.id !== id) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Recorder caller does not own this recording');
    return this.panel;
  }
  status(id: number) { return this.service!.status(this.owner(id).recordingId); }
  stop(id: number, mode: 'stop' | 'discard'): Promise<RecordingResult> { return this.service!.stop(this.owner(id).recordingId, mode); }
  close(recordingId: string): void {
    const panel = this.panel;
    if (!panel || panel.recordingId !== recordingId) return;
    panel.dispose();
    if (!panel.window.isDestroyed()) panel.window.destroy();
  }
  async shutdown(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closing = true;
    const result = await this.service?.close(deadlineMs) ?? { complete: true };
    if (this.panel) this.close(this.panel.recordingId);
    return result;
  }
}
