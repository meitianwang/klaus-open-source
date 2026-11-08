import { withSettingsDb } from '../settings';
import type { ComputerUseHelperCommand } from '../../native/computer-use';
import { MANAGED_COMPUTER_USE_UNREADABLE, type ManagedPolicySnapshot } from '../computer-use/managed-policy';
import { ComputerHistoryStore, COMPUTER_HISTORY_PRUNE_INTERVAL_MS, COMPUTER_HISTORY_RETENTION_MS, type ClearInterval } from './store';
import { COMPUTER_HISTORY_ENABLED_KEY, COMPUTER_HISTORY_POLICY_KEY, isPrivateWindowTitle, parseObservationPolicy,
  removeObservationEntry as removeEntry, serializeObservationPolicy, shouldObserve, upsertObservationEntry,
  validateObservationEntry, type ObservationEntry } from './observation-policy';
import { ComputerHistoryWatcher } from './watcher';
import type { ComputerHistoryFrame, ComputerHistoryStatus } from './types';

/** Organization-policy refusal wording; pinned by the computer-history vectors. */
export const COMPUTER_HISTORY_ORGANIZATION_BLOCKED = "Computer History is blocked by your organization's policy.";
export const COMPUTER_HISTORY_UNAVAILABLE_PLATFORM = 'Computer History is available only on macOS';
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 60_000;

export interface ComputerHistoryServiceDeps {
  configRoot: string;
  command?: ComputerUseHelperCommand;
  /** Report the actual observation availability; defaults to the macOS surface. */
  available?(): boolean;
  managedPolicy?(): ManagedPolicySnapshot;
  log(message: string): void;
  now?(): number;
}

export interface ComputerHistorySnapshot {
  status: ComputerHistoryStatus;
  settings: { enabled: boolean; policy: ObservationEntry[]; managedDisabled: boolean };
}

/**
 * The environment-history service: one serialized lifecycle over a long-lived
 * native observation child, a bounded local timeline store and an include/
 * exclude observation policy. Failures roll the desired state back instead of
 * pretending to run, and an organization policy wins over every local switch.
 */
export class ComputerHistoryService {
  private readonly store: ComputerHistoryStore;
  private readonly watcher: ComputerHistoryWatcher;
  private readonly now: () => number;
  private desired: ComputerHistoryStatus['state'] = 'stopped';
  private unavailableReason?: string;
  private policy: ObservationEntry[] = [];
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private pruneTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private restartDelayMs = RESTART_BASE_MS;
  private closing = false;
  constructor(private readonly deps: ComputerHistoryServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.store = new ComputerHistoryStore(deps.configRoot, this.now);
    this.watcher = new ComputerHistoryWatcher({ command: deps.command, log: deps.log,
      onFrame: frame => this.frame(frame),
      onStarted: () => { this.restartDelayMs = RESTART_BASE_MS; },
      onExit: unexpected => this.exited(unexpected) });
    try {
      this.policy = withSettingsDb(deps.configRoot, db => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(COMPUTER_HISTORY_POLICY_KEY) as { value?: unknown } | undefined;
        return parseObservationPolicy(typeof row?.value === 'string' ? row.value : undefined);
      });
    } catch (error) { this.policy = []; deps.log(`observation policy reset: ${String(error)}`); }
  }

  private available(): boolean { return this.deps.available?.() ?? process.platform === 'darwin'; }
  private managedRefusal(): string | undefined {
    let snapshot: ManagedPolicySnapshot | undefined;
    try { snapshot = this.deps.managedPolicy?.(); } catch { return MANAGED_COMPUTER_USE_UNREADABLE; }
    if (!snapshot || snapshot.status === 'absent') return undefined;
    if (snapshot.status === 'unreadable') return snapshot.error;
    return snapshot.policy.computerHistoryEnabled ? undefined : COMPUTER_HISTORY_ORGANIZATION_BLOCKED;
  }
  private managedDisabled(): boolean {
    try {
      const snapshot = this.deps.managedPolicy?.();
      return !!snapshot && (snapshot.status === 'unreadable' || (snapshot.status === 'active' && !snapshot.policy.computerHistoryEnabled));
    } catch { return true; }
  }
  private writeEnabled(enabled: boolean): void {
    withSettingsDb(this.deps.configRoot, db => db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(COMPUTER_HISTORY_ENABLED_KEY, enabled ? '1' : '0'));
  }
  private writePolicy(): void {
    const serialized = serializeObservationPolicy(this.policy);
    withSettingsDb(this.deps.configRoot, db => db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(COMPUTER_HISTORY_POLICY_KEY, serialized));
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(task, task);
    this.mutationQueue = run.then(() => {}, () => {});
    return run;
  }

  /** Resume the persisted enabled state at startup; best-effort, never throws. */
  autostart(): void {
    if (this.closing) return;
    let enabled = false;
    try {
      enabled = withSettingsDb(this.deps.configRoot, db => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(COMPUTER_HISTORY_ENABLED_KEY) as { value?: unknown } | undefined;
        return row?.value === '1';
      });
    } catch { return; }
    if (!enabled || this.managedRefusal() || !this.available()) return;
    void this.setEnabled({ enabled: true }).catch(error => this.deps.log(`history autostart failed: ${String(error)}`));
  }

  status(): ComputerHistoryStatus {
    const status: ComputerHistoryStatus = { state: this.desired, entryCount: this.store.count(),
      retentionMs: COMPUTER_HISTORY_RETENTION_MS, managedDisabled: this.managedDisabled() };
    if (this.unavailableReason) status.unavailableReason = this.unavailableReason;
    return status;
  }
  getSettings(): ComputerHistorySnapshot['settings'] {
    let enabled = false;
    try {
      enabled = withSettingsDb(this.deps.configRoot, db => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(COMPUTER_HISTORY_ENABLED_KEY) as { value?: unknown } | undefined;
        return row?.value === '1';
      });
    } catch { enabled = false; }
    return { enabled: enabled && !this.managedDisabled(), policy: [...this.policy], managedDisabled: this.managedDisabled() };
  }
  snapshot(): ComputerHistorySnapshot { return { status: this.status(), settings: this.getSettings() }; }

  /** Reference-aligned method surface: start/stop are the durable enable switch. */
  setEnabled(payload: unknown): Promise<{ ok: boolean; status: ComputerHistoryStatus; error?: string }> {
    const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (typeof row.enabled !== 'boolean') return Promise.resolve({ ok: false, status: this.status(), error: 'enabled must be a boolean' });
    return this.enqueue(async () => {
      if (this.closing) return { ok: false, status: this.status(), error: 'Computer History is shutting down' };
      if (!row.enabled) { await this.stopObservation(); this.writeEnabled(false); return { ok: true, status: this.status() }; }
      const refusal = this.managedRefusal();
      if (refusal) return { ok: false, status: this.status(), error: refusal };
      if (!this.available()) return { ok: false, status: this.status(), error: this.deps.available ? 'Computer History observation is unavailable on this computer' : COMPUTER_HISTORY_UNAVAILABLE_PLATFORM };
      this.writeEnabled(true);
      const started = await this.startObservation();
      if (!started) { this.writeEnabled(false); this.desired = 'stopped'; return { ok: false, status: this.status(), error: this.unavailableReason ?? 'Computer History observation could not start' }; }
      return { ok: true, status: this.status() };
    });
  }
  start(): Promise<{ ok: boolean; status: ComputerHistoryStatus; error?: string }> { return this.setEnabled({ enabled: true }); }
  stop(): Promise<{ ok: boolean; status: ComputerHistoryStatus; error?: string }> { return this.setEnabled({ enabled: false }); }
  /** Reference-aligned UpdateSettings surface; today it carries the enable switch. */
  updateSettings(payload: unknown): Promise<{ ok: boolean; status: ComputerHistoryStatus; error?: string }> { return this.setEnabled(payload); }

  pause(): Promise<{ ok: boolean; status: ComputerHistoryStatus }> {
    return this.enqueue(async () => {
      if (this.desired !== 'running') return { ok: true, status: this.status() };
      this.desired = 'paused';
      this.clearTimers();
      await this.watcher.stop();
      return { ok: true, status: this.status() };
    });
  }
  resume(): Promise<{ ok: boolean; status: ComputerHistoryStatus; error?: string }> {
    return this.enqueue(async () => {
      if (this.desired !== 'paused') return { ok: true, status: this.status() };
      const refusal = this.managedRefusal();
      if (refusal) return { ok: false, status: this.status(), error: refusal };
      const started = await this.startObservation();
      if (!started) return { ok: false, status: this.status(), error: this.unavailableReason ?? 'Computer History observation could not resume' };
      return { ok: true, status: this.status() };
    });
  }

  updateObservationPolicy(payload: unknown): { ok: true; policy: ObservationEntry[] } {
    const entry = validateObservationEntry(payload);
    this.policy = upsertObservationEntry(this.policy, entry);
    this.writePolicy();
    return { ok: true, policy: [...this.policy] };
  }
  removeObservationEntry(payload: unknown): { ok: true; policy: ObservationEntry[] } {
    const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (row.scope !== 'app' && row.scope !== 'url') throw new Error('scope must be app or url');
    if (typeof row.target !== 'string' || !row.target.trim()) throw new Error('target must be a non-empty string');
    this.policy = removeEntry(this.policy, row.scope, row.target.trim().toLowerCase());
    this.writePolicy();
    return { ok: true, policy: [...this.policy] };
  }

  clearHistory(payload: unknown): { ok: true; removed: number; status: ComputerHistoryStatus } {
    const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const interval = (row.interval ?? 'all') as ClearInterval;
    const result = this.store.clear(interval);
    return { ok: true, removed: result.removed, status: this.status() };
  }
  entries(payload: unknown): { entries: Array<Record<string, unknown>> } {
    const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const limit = typeof row.limit === 'number' ? row.limit : 200;
    const before = typeof row.before === 'number' ? row.before : undefined;
    return { entries: this.store.entries(limit, before) as unknown as Array<Record<string, unknown>> };
  }

  async shutdown(): Promise<{ complete: boolean }> {
    this.closing = true;
    this.clearTimers();
    const closed = await this.watcher.close();
    let drained = true;
    const queue = this.mutationQueue.then(() => {}, () => {});
    drained = await Promise.race([queue.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 5000))]);
    return { complete: closed.complete && drained };
  }

  private async startObservation(): Promise<boolean> {
    this.unavailableReason = undefined;
    this.desired = 'running';
    if (!this.watcher.start()) {
      // A refused spawn may still be an unavailable frame already in flight; give
      // the frame pipeline no chance to run and report the failure directly.
      this.desired = 'stopped';
      return false;
    }
    // An enable is only real once the observation loop actually armed; a
    // degraded or exited child rolls the durable switch back instead of
    // pretending to run.
    const armed = await this.watcher.armResult(10_000);
    if (armed === 'started') { this.armPruneTimer(); return true; }
    await this.watcher.stop();
    this.desired = 'stopped';
    this.clearTimers();
    return false;
  }
  private async stopObservation(): Promise<void> {
    this.desired = 'stopped';
    this.unavailableReason = undefined;
    this.clearTimers();
    await this.watcher.stop();
  }
  private armPruneTimer(): void {
    this.clearPruneTimer();
    try { this.store.prune(); } catch (error) { this.deps.log(`history prune failed: ${String(error)}`); }
    this.pruneTimer = setInterval(() => {
      try { this.store.prune(); } catch (error) { this.deps.log(`history prune failed: ${String(error)}`); }
    }, COMPUTER_HISTORY_PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }
  private clearPruneTimer(): void { if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = undefined; } }
  private clearTimers(): void {
    this.clearPruneTimer();
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
  }

  private frame(frame: ComputerHistoryFrame): void {
    if (frame.event === 'unavailable') {
      this.unavailableReason = frame.reason ?? 'observation-unavailable';
      this.desired = 'stopped';
      this.clearTimers();
      // A failed enable rolls back durably: the switch must not promise a watch
      // that the platform refuses to arm.
      try { this.writeEnabled(false); } catch (error) { this.deps.log(`history rollback failed: ${String(error)}`); }
      return;
    }
    if (frame.event === 'stopped') return;
    const at = typeof frame.at === 'number' && Number.isFinite(frame.at) && frame.at > 0 ? frame.at : this.now();
    if (frame.event === 'windowTitle') {
      // Double-check the native private-browsing filter before anything is stored.
      if (isPrivateWindowTitle(frame.title, frame.url)) return;
      if (!shouldObserve({ bundleId: frame.bundleId, url: frame.url }, this.policy)) return;
      this.store.append({ kind: 'window', at, ...(frame.bundleId ? { bundleId: frame.bundleId } : {}),
        ...(frame.title ? { title: frame.title } : {}), ...(frame.url ? { url: frame.url } : {}) });
      return;
    }
    if (!shouldObserve({ bundleId: frame.bundleId }, this.policy)) return;
    this.store.append({ kind: 'app', at, ...(frame.bundleId ? { bundleId: frame.bundleId } : {}),
      ...(frame.name ? { name: frame.name } : {}) });
  }

  private exited(unexpected: boolean): void {
    if (!unexpected || this.desired !== 'running' || this.closing || this.unavailableReason) return;
    // Bounded backoff restart: the desired state is running, so an unexpected
    // exit is retried with a capped delay until the watch arms again.
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, RESTART_MAX_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.closing || this.desired !== 'running') return;
      if (this.watcher.running || this.watcher.start()) this.armPruneTimer();
      else this.exited(true);
    }, delay);
    this.restartTimer.unref?.();
  }
}
