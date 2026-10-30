import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_APP_SHOT_SETTINGS, type PetAppshotSettings, type PetAppshotState } from '../../contracts/desktop-pet-appshot';
import { ChannelRegistry } from '../ipc/registry';
import type { Json } from '../ipc/contract';

export interface AppshotDependencies {
  filename: string;
  platform?: NodeJS.Platform;
  observe?(shortcut: PetAppshotSettings['shortcut'], callback: () => void): (() => void) | undefined;
  capture(settings: PetAppshotSettings, signal: AbortSignal): Promise<void>;
  failed(message: string): void;
  log(message: string): void;
}
function normalized(value: unknown, previous: PetAppshotSettings): PetAppshotSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Application capture settings must be an object');
  const row = value as Record<string, unknown>, result = { ...previous };
  if (Object.hasOwn(row, 'shortcut')) {
    if (row.shortcut !== null && (typeof row.shortcut !== 'string' || !row.shortcut.trim() || row.shortcut.length > 100 || /[\x00-\x1f\x7f]/u.test(row.shortcut))) throw new Error('Unsupported application capture shortcut');
    result.shortcut = row.shortcut === null ? null : row.shortcut.trim();
  }
  for (const key of ['alwaysSendToMini', 'soundEnabled'] as const) if (Object.hasOwn(row, key)) { if (typeof row[key] !== 'boolean') throw new Error('Invalid application capture setting'); result[key] = row[key]; }
  if (Object.hasOwn(row, 'destination')) { if (!['automatic', 'last-chat', 'new-chat'].includes(String(row.destination))) throw new Error('Invalid application capture destination'); result.destination = row.destination as PetAppshotSettings['destination']; }
  return result;
}

/** Snapshot the capture source separately from external application restoration. */
export function appshotCaptureApplication(value: { ownedWindowFocused: boolean; companionFocused: boolean; previousApplication?: string; captureExternalApplication(): string | undefined }): string {
  if (value.companionFocused) {
    if (!value.previousApplication) throw new Error('Select an application before capturing it.');
    return value.previousApplication;
  }
  if (value.ownedWindowFocused) return String(process.pid);
  const application = value.captureExternalApplication();
  if (!application) throw new Error('The foreground application is unavailable. Select an application before capturing it.');
  return application;
}

/** Owns the global capture chord and serializes captures before changing application focus. */
export class AppshotRuntime {
  private settings: PetAppshotSettings;
  private initialized: Promise<void> | undefined;
  private stopObserver: (() => void) | undefined;
  private unavailableReason: string | undefined;
  private capture: Promise<void> | undefined;
  private closed = false;
  private saving: Promise<void> = Promise.resolve();
  private observationGeneration = 0;
  private readonly abort = new AbortController();
  constructor(private readonly deps: AppshotDependencies) { this.settings = { ...DEFAULT_APP_SHOT_SETTINGS, shortcut: (deps.platform ?? process.platform) === 'win32' ? 'DoubleAlt' : 'DoubleCommand' }; }
  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      try { this.settings = normalized(JSON.parse(await fs.readFile(this.deps.filename, 'utf8')), this.settings); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log(String(error)); }
      if (!this.closed) this.observe();
    })();
  }
  snapshot(): PetAppshotState {
    const platform = this.deps.platform ?? process.platform, supported = (platform === 'darwin' || platform === 'win32') && Boolean(this.deps.observe);
    return { settings: { ...this.settings }, supported, active: Boolean(this.stopObserver), ...(!supported ? { unavailableReason: 'Application capture shortcuts are unavailable on this platform.' } : this.unavailableReason ? { unavailableReason: this.unavailableReason } : {}) };
  }
  private observe(): void {
    const generation = ++this.observationGeneration;
    this.stopObserver?.(); this.stopObserver = undefined; this.unavailableReason = undefined;
    if (this.closed || !this.settings.shortcut) return;
    if (!['darwin', 'win32'].includes(this.deps.platform ?? process.platform)) return;
    try {
      this.stopObserver = this.deps.observe?.(this.settings.shortcut, () => { if (generation === this.observationGeneration && !this.closed) this.trigger(); });
      if (!this.stopObserver) this.unavailableReason = 'Allow keyboard observation in system settings to use the application capture shortcut.';
    } catch (error) { this.unavailableReason = error instanceof Error ? error.message : String(error); this.deps.log(this.unavailableReason); }
  }
  private trigger(): void {
    if (this.closed || this.capture) return;
    const settings = { ...this.settings };
    const capture = this.deps.capture(settings, this.abort.signal).catch(error => { if (this.closed) return; const message = error instanceof Error ? error.message : String(error); this.deps.log(message); this.deps.failed(message); }).finally(() => { if (this.capture === capture) this.capture = undefined; });
    this.capture = capture;
  }
  async update(value: unknown): Promise<PetAppshotState> {
    await this.initialize(); if (this.closed) throw new Error('Application capture is shutting down');
    const saving = this.saving.catch(() => {}).then(async () => {
      if (this.closed) throw new Error('Application capture is shutting down');
      const next = normalized(value, this.settings), data = JSON.stringify(next, null, 2) + '\n';
      await fs.mkdir(dirname(this.deps.filename), { recursive: true });
      const temporary = this.deps.filename + '.tmp';
      try { await fs.writeFile(temporary, data, { mode: 0o600 }); await fs.rename(temporary, this.deps.filename); }
      catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
      if (!this.closed) { this.settings = next; this.observe(); }
    });
    this.saving = saving; await saving; return this.snapshot();
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; this.observationGeneration++; this.abort.abort(); this.stopObserver?.(); this.stopObserver = undefined; await Promise.allSettled([this.saving, this.capture]); }
}

export function registerAppshotHandlers(registry: ChannelRegistry, runtime: AppshotRuntime): void {
  registry.register('desktop-pet:appshot-settings', async () => { await runtime.initialize(); return runtime.snapshot() as unknown as Json; }, 'appshot');
  registry.register('desktop-pet:update-appshot-settings', async context => await runtime.update(context.args[0]) as unknown as Json, 'appshot');
}
