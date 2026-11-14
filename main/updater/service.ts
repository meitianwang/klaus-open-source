import { chmod, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseReleaseEnvelope, updateUrl, type UpdatePolicy, type VerifiedRelease } from './policy';
import { verifyMinisignFile } from './minisign';

/** Why an attempt failed, so the interface can name the real problem. */
export type UpdateFailure = 'check-unavailable' | 'check-rejected' | 'download-failed' | 'install-failed' | 'unsupported';
/** Installation milestones the platform installer reports as it reaches them. */
export type UpdateInstallPhase = 'preparing' | 'installing' | 'restarting';
/**
 * Transfer counters for the running operation. `percent` spans the whole
 * operation: the download owns 0-60 and installation owns 60-100, so one bar
 * advances across both phases instead of restarting at zero.
 */
export type UpdateProgress = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  installing: boolean;
};
export interface UpdateStatus {
  supported: boolean;
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  availableVersion: string | null;
  error: string | null;
  errorKind: UpdateFailure | null;
  /** True when a person asked for this attempt; only those get a result notice. */
  explicit: boolean;
  progress: UpdateProgress | null;
}
export interface InstallResult { ok: boolean; error?: string; started?: boolean }
export interface PendingUpdate { proof: VerifiedRelease; file: string }
export interface UpdateInstaller {
  /** Only called by the explicit install channel, after fresh metadata and file verification. */
  install(update: PendingUpdate, signal: AbortSignal, onPhase?: (phase: UpdateInstallPhase) => void): Promise<void>;
  dispose(): Promise<void>;
}
export interface UpdateServiceOptions {
  currentVersion: string;
  cacheRoot: string;
  policy?: UpdatePolicy;
  unavailableReason?: string;
  installer: UpdateInstaller;
  emit: (status: UpdateStatus) => void;
  /** Read on each check so toggling the preference takes effect without restarting. */
  autoDownload?: () => boolean;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  /** Progress push interval; a finished transfer always pushes immediately. */
  progressIntervalMs?: number;
  /** Injectable clock so progress pacing is testable without real waiting. */
  now?: () => number;
}

const PROGRESS_INTERVAL_MS = 200;
/** Exponential smoothing weight: keeps the reported speed readable, not jittery. */
const SPEED_SMOOTHING_ALPHA = 0.3;
/** Share of the bar the download owns; installation fills the remainder. */
const DOWNLOAD_PROGRESS_CEILING = 60;
const INSTALL_PHASE_PERCENT: Record<UpdateInstallPhase, number> = { preparing: 72, installing: 88, restarting: 97 };

/** Maps a thrown failure onto the phase that produced it. */
export function classifyUpdateFailure(message: string, phase: 'check' | 'download' | 'install'): UpdateFailure {
  if (phase === 'install') return 'install-failed';
  if (phase === 'download') return 'download-failed';
  // A feed that answered but failed its signature, identity or lifetime checks is
  // a rejected offer, not an unreachable service.
  const rejected = /signature|envelope|metadata|mismatch|expired|lifetime|proof|incomplete|newer compatible|not accepted|size limit|filename|Unsupported installed/i;
  return rejected.test(message) ? 'check-rejected' : 'check-unavailable';
}

/** Exactly one operation owns the status, its download and its abort controller. */
export class UpdateService {
  private status: UpdateStatus;
  private controller?: AbortController;
  private operation?: Promise<void>;
  private pending?: PendingUpdate;
  private directory?: string;
  private disposed = false;
  private handingOff = false;
  private first?: NodeJS.Timeout;
  private cadence?: NodeJS.Timeout;
  private queuedInstall?: NodeJS.Immediate;
  private releaseQueuedSignal?: () => void;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly progressIntervalMs: number;
  private lastProgressAt?: number;
  private lastProgressBytes?: number;
  private smoothedBytesPerSecond?: number;
  private lastEmittedProgressAt?: number;

  constructor(private readonly options: UpdateServiceOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    this.status = {
      supported: Boolean(options.policy),
      state: options.unavailableReason ? 'error' : 'idle',
      currentVersion: options.currentVersion,
      availableVersion: null,
      error: options.unavailableReason ?? null,
      errorKind: options.unavailableReason ? 'unsupported' : null,
      explicit: false,
      progress: null,
    };
  }
  snapshot(): UpdateStatus { return { ...this.status, progress: this.status.progress ? { ...this.status.progress } : null }; }
  private publish(
    state: UpdateStatus['state'],
    error: string | null = null,
    version = this.status.availableVersion,
    extra: { errorKind?: UpdateFailure | null; progress?: UpdateProgress | null } = {},
  ): void {
    if (this.disposed) return;
    // A phase change clears stale transfer counters unless the caller supplies
    // the ones belonging to the new phase.
    this.status = {
      ...this.status,
      state,
      error,
      availableVersion: version,
      errorKind: extra.errorKind ?? (error ? this.status.errorKind : null),
      progress: extra.progress ?? null,
    };
    this.options.emit(this.snapshot());
  }
  /** Resets pacing so a new transfer never inherits the previous one's speed. */
  private resetProgressClock(): void {
    this.lastProgressAt = undefined; this.lastProgressBytes = undefined;
    this.smoothedBytesPerSecond = undefined; this.lastEmittedProgressAt = undefined;
  }
  private smoothedSpeed(transferred: number, at: number): number {
    const previousAt = this.lastProgressAt, previousBytes = this.lastProgressBytes;
    this.lastProgressAt = at; this.lastProgressBytes = transferred;
    if (previousAt === undefined || previousBytes === undefined) return this.smoothedBytesPerSecond ?? 0;
    const elapsed = at - previousAt, delta = transferred - previousBytes;
    if (elapsed <= 0 || delta < 0) return this.smoothedBytesPerSecond ?? 0;
    const instant = delta / elapsed * 1000, previous = this.smoothedBytesPerSecond;
    this.smoothedBytesPerSecond = previous === undefined ? instant : previous * (1 - SPEED_SMOOTHING_ALPHA) + instant * SPEED_SMOOTHING_ALPHA;
    return this.smoothedBytesPerSecond;
  }
  /**
   * Every chunk reaches disk, but only a throttled subset becomes an event, so a
   * fast link cannot flood the renderer while a slow one still shows movement.
   */
  private publishDownloadProgress(transferred: number, total: number): void {
    if (this.disposed || this.status.state !== 'downloading') return;
    const at = this.now();
    const speed = this.smoothedSpeed(transferred, at);
    const ratio = total > 0 ? Math.max(0, Math.min(1, transferred / total)) : 0;
    const complete = ratio >= 1;
    if (!complete && this.lastEmittedProgressAt !== undefined && at - this.lastEmittedProgressAt < this.progressIntervalMs) return;
    this.lastEmittedProgressAt = at;
    this.publish('downloading', null, this.status.availableVersion, {
      progress: { percent: ratio * DOWNLOAD_PROGRESS_CEILING, bytesPerSecond: speed, transferred, total, installing: false },
    });
  }
  private publishInstallPhase(phase: UpdateInstallPhase, total: number): void {
    if (this.disposed || this.handingOff) return;
    this.publish('installing', null, this.status.availableVersion, {
      progress: { percent: INSTALL_PHASE_PERCENT[phase], bytesPerSecond: 0, transferred: total, total, installing: true },
    });
  }
  start(): void {
    if (!this.status.supported || this.first || this.cadence || this.disposed) return;
    // One immediate startup check and a 15-minute cadence, so a
    // release published mid-session reaches an already-running app quickly.
    // Still unref'd: neither timer keeps the process alive on its own.
    this.first = setTimeout(() => { this.first = undefined; void this.check(); }, 5_000);
    this.cadence = setInterval(() => { void this.check(); }, 15 * 60_000);
    this.first.unref(); this.cadence.unref();
  }
  private async request(url: string, signal: AbortSignal, limit: number, consume?: (chunk: Uint8Array) => Promise<void>): Promise<Buffer | undefined> {
    const policy = this.options.policy!;
    updateUrl(url, policy);
    const response = await this.fetcher(url, { signal, redirect: 'manual', headers: { Accept: consume ? 'application/octet-stream' : 'application/json', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' } });
    if (response.status === 204 && !consume) return undefined;
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`Update request failed (HTTP ${response.status})`); }
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response.body?.cancel(); throw new Error('Encoded update responses are not accepted'); }
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) { await response.body?.cancel(); throw new Error('Update response exceeds its size limit'); }
    if (!response.body) throw new Error('Update response has no body');
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        signal.throwIfAborted();
        const value = await reader.read();
        if (value.done) break;
        size += value.value.length;
        if (size > limit) throw new Error('Update response exceeds its size limit');
        if (consume) await consume(value.value); else chunks.push(value.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    return consume ? Buffer.alloc(0) : Buffer.concat(chunks);
  }
  private async offer(signal: AbortSignal): Promise<VerifiedRelease | undefined> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000);
    const bytes = await this.request(this.options.policy!.feedUrl, AbortSignal.any([signal, timeout]), 128 * 1024);
    return bytes ? parseReleaseEnvelope(JSON.parse(bytes.toString('utf8')), this.options.policy!) : undefined;
  }
  private async clearPending(): Promise<void> {
    this.pending = undefined;
    const directory = this.directory; this.directory = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  /**
   * Returns after the feed response; transfer progress continues on
   * updater:status pushes. `explicit` marks a person-initiated attempt, which is
   * the only kind allowed to produce a visible result notice; `download` starts
   * transferring a found release even when automatic downloads are turned off.
   */
  async check(options: { explicit?: boolean; download?: boolean } = {}): Promise<UpdateStatus> {
    if (!this.status.supported || this.disposed || this.controller || this.handingOff || this.queuedInstall) return this.snapshot();
    const controller = new AbortController(); this.controller = controller;
    const explicit = options.explicit === true;
    const shouldDownload = options.download === true || (this.options.autoDownload ? this.options.autoDownload() : true);
    let checked!: () => void;
    const responseReady = new Promise<void>(resolve => { checked = resolve; });
    this.operation = (async () => {
      let phase: 'check' | 'download' = 'check';
      try {
        const silentAvailableRefresh = !explicit && !shouldDownload && this.status.state === 'available';
        this.status = { ...this.status, explicit };
        if (!silentAvailableRefresh) this.publish('checking');
        const proof = await this.offer(controller.signal);
        if (!proof) { await this.clearPending(); this.publish('idle', null, null); return; }
        if (this.pending?.proof.digest === proof.digest) {
          // A later timer must not download the same large installer again.
          // Recheck the private cache and preserve the explicit install choice.
          await this.verify(this.pending, controller.signal);
          this.publish('downloaded', null, proof.release.version);
          return;
        }
        await this.clearPending();
        if (!shouldDownload) {
          if (!silentAvailableRefresh || this.status.availableVersion !== proof.release.version) {
            this.publish('available', null, proof.release.version);
          }
          return;
        }
        const total = proof.release.artifact.size;
        this.resetProgressClock();
        phase = 'download';
        // The signed artifact size is known before the first byte, so the
        // interface can show a real total immediately instead of an unknown one.
        this.publish('downloading', null, proof.release.version, {
          progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total, installing: false },
        });
        checked();
        await mkdir(this.options.cacheRoot, { recursive: true, mode: 0o700 });
        const root = await lstat(this.options.cacheRoot);
        if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Update cache must be a private directory');
        await chmod(this.options.cacheRoot, 0o700);
        this.directory = await mkdtemp(join(this.options.cacheRoot, 'download-'));
        const file = join(this.directory, proof.release.artifact.kind === 'mac-zip' ? 'update.zip' : 'update.exe');
        const handle = await open(file, 'wx', 0o600);
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.downloadTimeoutMs ?? 20 * 60_000)]);
          let transferred = 0;
          await this.request(proof.release.artifact.url, signal, total, async chunk => {
            let offset = 0;
            while (offset < chunk.length) { signal.throwIfAborted(); const written = await handle.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw new Error('Unable to write update artifact'); offset += written.bytesWritten; }
            transferred += chunk.length;
            this.publishDownloadProgress(transferred, total);
          });
          await handle.sync();
        } finally { await handle.close(); }
        controller.signal.throwIfAborted();
        await this.verify({ proof, file }, controller.signal);
        await chmod(file, 0o400);
        controller.signal.throwIfAborted();
        this.pending = { proof, file };
        this.publish('downloaded');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.clearPending();
        this.publish('error', message, this.status.availableVersion, { errorKind: classifyUpdateFailure(message, phase) });
      } finally { checked(); if (this.controller === controller) this.controller = undefined; }
    })();
    await responseReady;
    return this.snapshot();
  }
  private async verify(update: PendingUpdate, signal: AbortSignal): Promise<void> {
    const stat = await lstat(update.file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Update cache file is not a regular file');
    await verifyMinisignFile(update.file, update.proof.release.artifact.signature, this.options.policy!.key, update.proof.release.artifact, signal);
  }
  /** Hand off a model-initiated install before shutdown drains that calling tool. */
  requestInstall(signal?: AbortSignal): { ok: boolean; error?: string; accepted?: true; phase?: 'verification-pending' } {
    if (signal?.aborted) return { ok: false, error: 'update_request_cancelled' };
    if (!this.status.supported) return { ok: false, error: this.status.error ?? 'updates_unavailable' };
    if (this.disposed || this.controller || this.handingOff || this.queuedInstall) return { ok: false, error: 'update_operation_in_progress' };
    if (!this.pending) return { ok: false, error: 'no_update_downloaded' };
    this.queuedInstall = setImmediate(() => {
      this.queuedInstall = undefined;
      this.releaseQueuedSignal?.(); this.releaseQueuedSignal = undefined;
      void this.install().then(result => {
        if (!result.ok) this.publish('error', result.error ?? 'update_install_interrupted', this.status.availableVersion, { errorKind: 'install-failed' });
      }).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.publish('error', message, this.status.availableVersion, { errorKind: 'install-failed' });
      });
    });
    if (signal) {
      const cancelQueued = (): void => this.clearQueuedInstall();
      signal.addEventListener('abort', cancelQueued, { once: true });
      this.releaseQueuedSignal = () => signal.removeEventListener('abort', cancelQueued);
    }
    return { ok: true, accepted: true, phase: 'verification-pending' };
  }
  private clearQueuedInstall(): void {
    if (this.queuedInstall) clearImmediate(this.queuedInstall);
    this.queuedInstall = undefined;
    this.releaseQueuedSignal?.(); this.releaseQueuedSignal = undefined;
  }
  async install(): Promise<InstallResult> {
    if (!this.status.supported) return { ok: false, error: this.status.error ?? 'updates_unavailable' };
    if (this.disposed || this.controller || this.handingOff || this.queuedInstall) return { ok: false, error: 'update_operation_in_progress' };
    const update = this.pending;
    if (!update) return { ok: false, error: 'no_update_downloaded' };
    const controller = new AbortController(); this.controller = controller;
    const total = update.proof.release.artifact.size;
    let result: InstallResult = { ok: false, error: 'update_install_interrupted' };
    this.operation = (async () => {
      try {
        // Installation is always a person's decision, so its notices are explicit.
        this.status = { ...this.status, explicit: true };
        // A withdrawn feed or reused version must not authorize a cached installer.
        const fresh = await this.offer(controller.signal);
        if (!fresh || fresh.digest !== update.proof.digest) throw new Error('Downloaded update is no longer the current signed release');
        await this.verify(update, controller.signal);
        // Re-verification passed: the bar leaves the download range and the
        // interface can explain that work is saved and a restart is coming.
        this.publishInstallPhase('preparing', total);
        await this.options.installer.install(update, controller.signal, phase => {
          this.publishInstallPhase(phase, total);
        });
        this.handingOff = true;
        result = { ok: true, started: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.clearPending();
        this.publish('error', message, this.status.availableVersion, { errorKind: 'install-failed' });
        result = { ok: false, error: message };
      } finally { if (this.controller === controller) this.controller = undefined; }
    })();
    await this.operation;
    return result;
  }
  /** There is no new renderer channel; shutdown and native cancel use this owner. */
  async cancel(): Promise<void> {
    this.clearQueuedInstall();
    this.controller?.abort(new Error('Update operation cancelled'));
    await this.operation;
    if (!this.handingOff) await this.clearPending();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.first); clearInterval(this.cadence);
    await this.cancel();
    await this.options.installer.dispose();
  }
}
