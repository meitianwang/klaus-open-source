import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../ipc/contract';

export type SystemPermissionStatus = 'granted' | 'denied' | 'unknown';
type Status = SystemPermissionStatus;
const PANES: Record<string, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  fullDiskAccess: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  notification: 'x-apple.systempreferences:com.apple.preference.notifications',
  location: 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices',
  photosLibrary: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Photos',
};
/** Domains whose consent can be requested in-app; everything else only has a settings pane. */
const REQUESTABLE: Record<string, string> = {
  automation: 'automation',
  photosLibrary: 'photos',
  notification: 'notification',
};
export interface SystemPermissionDependencies {
  preferences: Pick<Electron.SystemPreferences, 'isTrustedAccessibilityClient' | 'getMediaAccessStatus'>;
  openExternal(url: string): Promise<void>;
  platform?: NodeJS.Platform;
  /** Read-only TCC probe: the file is opened and closed without reading its content. */
  fullDiskAccess?(): Promise<Status>;
  /** Passive query from the Electron main process; never launches a target or requests consent. */
  automation?(): Promise<Status>;
  photosLibrary?(): Promise<Status>;
  location?(): Promise<Status>;
  notification?(): Promise<Status>;
  /** Presents the system consent dialog; only called from the settings grant button. */
  request?(domain: string): Promise<Status>;
}
async function fullDiskAccess(): Promise<Status> {
  try {
    const handle = await open(join(homedir(), 'Library', 'Messages', 'chat.db'), 'r');
    await handle.close(); return 'granted';
  } catch (error) {
    return ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'denied' : 'unknown';
  }
}
function safely(run: () => Status): Status { try { return run(); } catch { return 'unknown'; } }

/** Status checks never request authorization. Settings opening is a separate explicit call. */
export class SystemPermissions {
  constructor(private readonly deps: SystemPermissionDependencies) {}
  async check(): Promise<Json> {
    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'darwin') return { platform: platform === 'win32' ? 'windows' : platform, supported: false, permissions: {} };
    const disk = await (this.deps.fullDiskAccess ?? fullDiskAccess)().catch((): Status => 'unknown');
    const probe = async (read: (() => Promise<Status>) | undefined): Promise<Status> =>
      Promise.resolve().then(() => read?.() ?? 'unknown').catch((): Status => 'unknown');
    const [automation, photosLibrary, location, notification] = await Promise.all([
      probe(this.deps.automation), probe(this.deps.photosLibrary),
      probe(this.deps.location), probe(this.deps.notification),
    ]);
    return { platform: 'macos', supported: true, permissions: {
      fullDiskAccess: disk,
      accessibility: safely(() => this.deps.preferences.isTrustedAccessibilityClient(false) ? 'granted' : 'unknown'),
      screenRecording: safely(() => {
        const status = this.deps.preferences.getMediaAccessStatus('screen');
        return status === 'granted' ? 'granted' : status === 'denied' || status === 'restricted' ? 'denied' : 'unknown';
      }),
      automation, photosLibrary, location, notification,
    } };
  }
  /** Ask the system for consent on behalf of an explicit user action; resolves with the recorded status. */
  async request(kind: unknown): Promise<Json> {
    if ((this.deps.platform ?? process.platform) !== 'darwin') return { ok: false, error: 'unsupported platform' };
    const domain = typeof kind === 'string' ? REQUESTABLE[kind] : undefined;
    if (!domain) return { ok: false, error: 'unknown permission type' };
    try {
      const status = await (this.deps.request?.(domain) ?? Promise.resolve<Status>('unknown'));
      return { ok: true, status };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'permission-request-failed' }; }
  }
  async open(kind: unknown): Promise<Json> {
    const url = typeof kind === 'string' && Object.hasOwn(PANES, kind) ? PANES[kind] : undefined;
    if (!url) return { ok: false, error: 'unknown permission type' };
    if ((this.deps.platform ?? process.platform) !== 'darwin') return { ok: false, error: 'unsupported platform' };
    try {
      await this.deps.openExternal(url);
      return { ok: true, ...(kind === 'accessibility' ? { nativeStatus:
        safely(() => this.deps.preferences.isTrustedAccessibilityClient(false) ? 'granted' : 'unknown') === 'granted' ? 'authorized' : 'not determined' } : {}) };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'settings-open-failed' }; }
  }
}
