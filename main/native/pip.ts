import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { loadNativeAddon } from './binding';

export interface PipNativeEvent { resourceId: string; generation: number; sequence: number; eventJson: string }
export interface PipNativeReport {
  resourceId: string; generation: number; closing: boolean; complete: boolean; pending: number;
  lastSequence: number; error?: string | null; native?: Record<string, unknown>;
}
export interface PipBinding {
  command(operationId: string, commandJson: string): string;
  waitForEvents(): Promise<boolean>;
  drainEvents(): PipNativeEvent[];
  beginClose(): void;
  report(force: boolean): string;
}
export interface PipPort {
  command(command: Record<string, unknown>): void;
  close(deadlineMs?: number): Promise<{ complete: boolean; error?: string }>;
}
export interface PipAddon {
  pipSupported(): boolean;
  NativePip: new (resourceId: string, handle: Buffer, helperPath: string) => PipBinding;
}
export interface PipPortCallbacks {
  onEvent(event: Record<string, unknown>): void | Promise<void>;
  onError(error: Error): void;
}

/** Only trusted main-process code may provide a BrowserWindow native handle. */
export class NativePipResource implements PipPort {
  readonly resourceId = randomUUID();
  private readonly binding: PipBinding;
  private readonly generation: number;
  private sequence = 0;

  private delivery?: Promise<void>;
  private closing = false;
  private closeFlight?: Promise<{ complete: boolean; error?: string }>;
  private failure?: string;

  static supported(addonPath?: string): boolean {
    if (process.platform !== 'darwin') return false;
    if (!addonPath) return false;
    const addon = loadNativeAddon(addonPath) as unknown as Partial<PipAddon>;
    return typeof addon.pipSupported === 'function' && addon.pipSupported();
  }
  constructor(options: PipPortCallbacks & { handle: Buffer; helperPath: string; addonPath?: string; addon?: PipAddon; diagnosticPath?: string }) {
    this.callbacks = options;
    const addon = options.addon ?? (options.addonPath ? loadNativeAddon(options.addonPath) as unknown as PipAddon : undefined);
    if (!addon) throw new Error('PIP_ADDON_REQUIRED');
    if (!addon.pipSupported?.()) throw new Error('Native picture-in-picture is unavailable on this platform');
    this.binding = new addon.NativePip(this.resourceId, options.handle, options.helperPath);
    this.generation = this.report().generation;
    if (options.diagnosticPath) this.command({ type: 'diagnostics', path: options.diagnosticPath });
    this.startReading();
  }
  private readonly callbacks: PipPortCallbacks;
  report(force = false): PipNativeReport {
    const report = JSON.parse(this.binding.report(force)) as PipNativeReport;
    if (report.resourceId !== this.resourceId || (this.generation !== undefined && report.generation !== this.generation)) {
      throw new Error('Native preview report identity mismatch');
    }
    return report;
  }
  command(command: Record<string, unknown>): void {
    if (this.closing) throw new Error('Native preview owner is closing');
    const operationId = randomUUID();
    const response = JSON.parse(this.binding.command(operationId, JSON.stringify(command)));
    if (response.operationId !== operationId || response.resourceId !== this.resourceId || response.generation !== this.generation || response.accepted !== true) {
      this.fail(new Error('Native preview command acknowledgement mismatch'));
      throw new Error(this.failure);
    }
  }
  private startReading(): void {
    const delivery = (async () => {
      while (!this.closing) {
        if (!await this.binding.waitForEvents()) {
          if (!this.closing) throw new Error('Native preview event producer ended before close');
          break;
        }
        if (!this.closing) await this.pump();
      }
    })();
    this.delivery = delivery;
    void delivery.catch(error => this.fail(error)).finally(() => {
      if (this.delivery === delivery) this.delivery = undefined;
    });
  }
  private async pump(): Promise<void> {
    const events = this.binding.drainEvents();
    if (events.length > 64) throw new Error('Native preview exceeded its event batch limit');
    for (const event of events) {
      if (this.closing) break;
      if (event.resourceId !== this.resourceId || event.generation !== this.generation || event.sequence !== this.sequence + 1) {
        throw new Error('Native preview event identity or sequence mismatch');
      }
      this.sequence = event.sequence;
      const value = JSON.parse(event.eventJson) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Native preview returned an invalid event');
      if (value.type === 'ownerClosed') this.beginClose();
      await this.callbacks.onEvent(value);
    }
  }
  private fail(error: unknown): void {
    if (this.failure || this.closing) return;
    this.failure = error instanceof Error ? error.message : String(error);
    this.beginClose();
    try { this.callbacks.onError(new Error(this.failure)); } catch { /* The owner is already revoked. */ }
  }
  private beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    this.binding.beginClose();
  }
  close(deadlineMs = 5000): Promise<{ complete: boolean; error?: string }> {
    this.beginClose();
    if (this.closeFlight) return this.closeFlight;
    this.closeFlight = this.drain(Math.max(0, Math.min(30_000, Number.isFinite(deadlineMs) ? deadlineMs : 5000)))
      .finally(() => { this.closeFlight = undefined; });
    return this.closeFlight;
  }
  private async drain(deadlineMs: number): Promise<{ complete: boolean; error?: string }> {
    const deadline = performance.now() + deadlineMs, forceAt = performance.now() + Math.min(1000, deadlineMs / 2);
    do {
      const report = this.report(performance.now() >= forceAt);
      if (report.complete && !this.delivery) return { complete: true, ...(this.failure ? { error: this.failure } : {}) };
      if (performance.now() >= deadline) return { complete: false, error: this.failure ?? 'Native preview producer or callback has not finished' };
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
  }
}
