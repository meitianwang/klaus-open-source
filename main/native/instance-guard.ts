import { parseDeepLink, teamIssueDeepLink } from '../app/deep-links';
import { loadNativeAddon, type NativeInstanceGuardBinding } from './binding';
import { isDesktopProtocol } from '../../shared/desktop-edition';

export interface InstanceActivation { deepLink?: string }
export interface InstanceGuardOptions {
  /** The trusted application identity is independent of data-profile overrides. */
  identity: string;
  protocol?: string;
  argv: string[];
  addon?: string;
  timeoutMs?: number;
}
export interface InstanceCallbacks {
  onActivation(event: InstanceActivation): void;
  /** Notification only: stop admission, schedule shutdown with an error handler,
   * and close all data owners before releasing the surviving native guard.
   */
  onLost(error: Error): void;
}
export interface InstanceReport { acquired: boolean; held: boolean; complete: boolean; error: string | null }
export type InstanceAcquisition = { acquired: true; guard: DesktopInstanceGuard }
  | { acquired: false; forwarded: boolean; acknowledged: boolean };

/** Activation only: arguments cannot select a profile, read a cwd, or execute a command. */
export function instanceActivation(argv: unknown, protocol = 'klaus'): InstanceActivation {
  if (!isDesktopProtocol(protocol)) throw new Error('INSTANCE_INVALID_PROTOCOL');
  if (!Array.isArray(argv) || argv.length > 64) throw new Error('INSTANCE_INVALID_MESSAGE');
  for (const raw of argv) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096 || raw.includes('\0')) throw new Error('INSTANCE_INVALID_MESSAGE');
  }
  for (const raw of argv as string[]) {
    const action = parseDeepLink(raw, protocol);
    if (!action) continue;
    if (action.kind === 'open') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(action.sessionId)) continue;
      return { deepLink: `${protocol}://open/${encodeURIComponent(action.sessionId)}` };
    }
    // A friend invite carries its payload in the query string, so forwarding
    // the canonical verb-only form would drop the email the link exists for.
    if (action.kind === 'friend') return { deepLink: raw };
    if (action.kind === 'issue') return { deepLink: teamIssueDeepLink(action.projectId, action.issueId, protocol) };
    return { deepLink: `${protocol}://${action.kind}` };
  }
  return {};
}

function object(raw: string): Record<string, unknown> {
  // A bounded 32 KiB native message can expand sixfold when JSON escapes controls.
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('INSTANCE_INVALID_RESPONSE');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INSTANCE_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

/** Native construction is synchronous and never waits for a JavaScript callback.
 * Call acquireSync and Windows profile-key preparation before the first await.
 * The listener may be attached later; native activation buffering is bounded.
 */
export class DesktopInstanceGuard {
  private closing = false;
  private pump: Promise<void> | undefined;
  private constructor(private readonly binding: NativeInstanceGuardBinding, private readonly protocol: string) {}

  static acquireSync(options: InstanceGuardOptions): InstanceAcquisition {
    const addonPath = options.addon;
    if (!addonPath) throw new Error('INSTANCE_ADDON_PATH_REQUIRED');
    return this.acquireWithBinding(options, raw => {
      const addon = loadNativeAddon(addonPath);
      if (typeof addon.NativeInstanceGuard !== 'function') throw new Error('INSTANCE_NATIVE_CAPABILITY_MISSING');
      return new addon.NativeInstanceGuard(raw);
    });
  }

  /** An explicit adapter seam for protocol fixtures; production always loads the packaged addon. */
  static acquireWithBinding(options: InstanceGuardOptions, create: (raw: string) => NativeInstanceGuardBinding): InstanceAcquisition {
    if (!/^[a-zA-Z0-9._-]{1,72}$/.test(options.identity)) throw new Error('INSTANCE_INVALID_IDENTITY');
    const activation = instanceActivation(options.argv, options.protocol);
    // cwd is intentionally empty. The legacy callback only receives a focus /
    // deep-link request, never a new working directory or arbitrary CLI flags.
    const binding = create(JSON.stringify({ identity: options.identity, cwd: '', args: ['Klaus', ...(activation.deepLink ? [activation.deepLink] : [])], timeoutMs: options.timeoutMs ?? 2000 }));
    try {
      const result = object(binding.acquisition());
      if (typeof result.acquired !== 'boolean' || typeof result.forwarded !== 'boolean' || typeof result.acknowledged !== 'boolean') throw new Error('INSTANCE_INVALID_RESPONSE');
      if (!result.acquired) {
        const report = object(binding.closeSync(2000));
        if (report.complete !== true) throw new Error('INSTANCE_CLOSE_INCOMPLETE');
        return { acquired: false, forwarded: result.forwarded, acknowledged: result.acknowledged };
      }
      binding.assertHeld();
      return { acquired: true, guard: new DesktopInstanceGuard(binding, options.protocol ?? 'klaus') };
    } catch (error) {
      // This startup path owns no database yet. Native cleanup is synchronous.
      binding.closeSync(2000);
      throw error;
    }
  }

  assertHeld(): void {
    if (this.closing) throw new Error('INSTANCE_NOT_HELD');
    this.binding.assertHeld();
  }

  listen(callbacks: InstanceCallbacks): void {
    this.assertHeld();
    if (this.pump) throw new Error('INSTANCE_LISTENER_EXISTS');
    this.pump = this.read(callbacks);
  }

  private async read(callbacks: InstanceCallbacks): Promise<void> {
    try {
      while (!this.closing) {
        const raw = await this.binding.readEvent();
        if (this.closing) return;
        if (raw === null) throw new Error('INSTANCE_RECEIVER_CLOSED');
        const event = object(raw);
        if (event.kind === 'lost') throw new Error('INSTANCE_ENDPOINT_LOST');
        if (event.kind !== 'activation' || typeof event.cwd !== 'string') throw new Error('INSTANCE_INVALID_EVENT');
        this.assertHeld();
        callbacks.onActivation(instanceActivation(event.args, this.protocol));
      }
    } catch (error) {
      if (!this.closing) {
        try { callbacks.onLost(error instanceof Error ? error : new Error('INSTANCE_RECEIVER_FAILED')); }
        catch { /* The guard remains held until the application closes its data owners. */ }
      }
    }
  }

  closeSync(timeoutMs = 2000): InstanceReport {
    this.closing = true;
    const report = object(this.binding.closeSync(timeoutMs));
    if (typeof report.acquired !== 'boolean' || typeof report.held !== 'boolean' || typeof report.complete !== 'boolean'
      || (report.error !== null && typeof report.error !== 'string')) throw new Error('INSTANCE_INVALID_RESPONSE');
    if (!report.complete) throw new Error('INSTANCE_CLOSE_INCOMPLETE');
    return report as unknown as InstanceReport;
  }

  async close(timeoutMs = 2000): Promise<InstanceReport> {
    const report = this.closeSync(timeoutMs);
    await this.pump;
    return report;
  }
}
