import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, win32 } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { withSettingsDb } from '../settings';
import { currentDesktopEdition, loadedDesktopEditions } from '../desktop-edition';
import type { DesktopEdition } from '../../../shared/desktop-edition';
import { MANAGED_COMPUTER_USE_UNREADABLE, type ManagedPolicySnapshot } from './managed-policy';
import { COMPUTER_USE_TELEMETRY_EVENTS, type ComputerUseTelemetrySink } from './telemetry';

const ENABLED = 'computer_use.enabled';
const ALLOWED = 'computer_use.allowed_apps';
const DENIED = 'computer_use.denied_apps';
const AUTO_UNLOCK = 'computer_use.auto_unlock';
export const DEFAULT_COMPUTER_USE_ALLOWED_APP = 'app:self';
type ObjectValue = Record<string, unknown>;

export interface ComputerUseSettings {
  enabled: boolean;
  availableOnThisPlatform: boolean;
  allowedApps: string[];
  deniedApps: string[];
  /** True while an admin-provisioned managed policy blocks Computer Use entirely. */
  managedDisabled: boolean;
}
export interface ComputerUseApp {
  input: string;
  name?: string;
  bundleId?: string;
  path?: string;
  pid?: number;
}
export interface ComputerUseApprovalContext {
  /** The host authenticates this identity before invoking a connector tool. */
  sessionId: string;
  signal: AbortSignal;
  /** The tool whose call triggered the approval question; recorded in the usage ledger. */
  toolName?: string;
  elicit(request: ObjectValue, signal: AbortSignal): Promise<unknown>;
}
export interface ComputerUseOperation {
  readonly resourceId: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly app: Readonly<ComputerUseApp>;
  readonly signal: AbortSignal;
}
export interface ComputerUsePolicyDependencies {
  configRoot: string;
  /** Report the actual loaded backend; platform names alone do not prove availability. */
  availability(): { available: boolean; error?: string };
  /** Reconcile the host-managed MCP server after a durable enabled-state write. */
  enabledChanged(enabled: boolean, signal: AbortSignal): Promise<void>;
  loginPassword?: ComputerUsePasswordStore;
  taskScope?(sessionId: string): ComputerUseTaskScope | undefined;
  /** Admin-provisioned enterprise policy; absent means no organization management. */
  managedPolicy?(): ManagedPolicySnapshot;
  /** Local usage ledger; approvals are recorded through this sink when present. */
  telemetry?: ComputerUseTelemetrySink;
}
export interface ComputerUseTaskScope { active: boolean; apps: string[] }
export interface ComputerUsePasswordStore {
  available(): boolean;
  hasPassword(signal: AbortSignal): Promise<boolean>;
  prompt(signal: AbortSignal): Promise<{ cancelled: boolean; created: boolean; discard(): Promise<void> }>;
  remove(signal: AbortSignal): Promise<void>;
}
interface Owner {
  resourceId: string;
  generation: number;
  closing: boolean;
  policy: string;
  approvals: Set<string>;
  controllers: Set<AbortController>;
  pending: Set<Promise<unknown>>;
  leases: Set<ComputerUseOperation>;
  taskRestricted: boolean;
}
interface LeaseState {
  owner: Owner;
  controller: AbortController;
  policy: string;
  taskScope: string;
  dispose(): void;
}

/**
 * System UI and authentication surfaces that are never operated, plus the
 * native helper itself. These are platform facts about macOS system processes.
 */
export const COMPUTER_USE_SAFETY_FORBIDDEN_BUNDLE_IDS: readonly string[] = [
  'com.klaus.computer-use-helper',
  'com.apple.WindowManager',
  'com.apple.controlcenter',
  'com.apple.dock',
  'com.apple.notificationcenterui',
  'com.apple.UserNotificationCenter',
  'com.apple.LocalAuthentication.UIAgent',
  'com.apple.LocalAuthenticationRemoteService',
  'com.apple.SecurityAgent',
];
/** Governance refusal wording; pinned by the governance contract vectors. */
export const COMPUTER_USE_GOVERNANCE_MESSAGES = {
  organizationDisabled: "Computer Use is blocked by your organization's policy.",
  organizationBlockedApp: (app: string) => `Computer Use is blocked from using the app '${app}' by your organization's policy.`,
  safetyForbiddenApp: (app: string) => `Computer Use is not allowed to use the app '${app}' for safety reasons.`,
};
/** Safety refusal matches bundle identities, including an explicit `bundle:` selector. */
export function computerUseSafetyForbidden(app: { input: string; bundleId?: string }): boolean {
  const targets = [app.bundleId, app.input.replace(/^bundle:/i, '')]
    .filter((value): value is string => !!value).map(normalizeComputerUseApp);
  return COMPUTER_USE_SAFETY_FORBIDDEN_BUNDLE_IDS.some(id => targets.includes(normalizeComputerUseApp(id)));
}
function record(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Computer Use arguments must be an object');
  return value as ObjectValue;
}
function appString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) throw new Error(`${label} must be a non-empty app name or identifier`);
  return value.trim();
}
export function normalizeComputerUseApp(value: string): string {
  return value.trim().replace(/[\\/]+$/, '').toLowerCase();
}
function sameSelfPath(actual: string, expected: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const path = value.replace(/[\\/]+$/, '');
    return platform === 'win32' ? path.replace(/^\\\\\?\\/, '').toLowerCase() : path;
  };
  return normalize(actual) === normalize(expected);
}
export function computerUseSelfAppMatches(app: ComputerUseApp, executable: string, platform: NodeJS.Platform, edition: Pick<DesktopEdition, 'application' | 'productName'> = currentDesktopEdition()): boolean {
  const ownPath = platform === 'darwin' ? executable.replace(/\/Contents\/MacOS\/[^/]+$/, '') : executable;
  return !!app.path && sameSelfPath(app.path, ownPath, platform)
    && (platform === 'darwin' ? app.bundleId === edition.application : app.name === edition.productName);
}
export function computerUseAppMatches(app: ComputerUseApp, entries: readonly string[]): boolean {
  const targets = [app.input, app.name, app.bundleId, app.path].filter((value): value is string => !!value).map(normalizeComputerUseApp).filter(Boolean);
  return entries.some(entry => {
    const rule = entry.trim().toLowerCase();
    if (rule === DEFAULT_COMPUTER_USE_ALLOWED_APP)
      return computerUseSelfAppMatches(app, realpathSync.native(process.execPath), process.platform);
    if (rule.startsWith('bundle:')) return !!app.bundleId && normalizeComputerUseApp(app.bundleId) === normalizeComputerUseApp(entry.slice(7));
    if (rule.startsWith('path:')) return !!app.path && exactPath(app.path, entry.slice(5));
    if (rule.startsWith('name:')) return !!app.name && normalizeComputerUseApp(app.name) === normalizeComputerUseApp(entry.slice(5));
    const needle = normalizeComputerUseApp(entry);
    return !!needle && targets.some(target => target.includes(needle));
  });
}
function exactPath(actual: string, expected: string): boolean {
  const canonical = (value: string) => { try { return realpathSync.native(value); } catch { return value; } };
  return sameSelfPath(canonical(actual), expected, process.platform);
}
/** Task grants use only complete bundle identifiers or canonical paths, never broad names. */
export function computerUseTaskAppMatches(app: ComputerUseApp, entries: readonly string[]): boolean {
  return entries.some(entry => entry.startsWith('bundle:')
    ? !!app.bundleId && app.bundleId.toLowerCase() === entry.slice(7).toLowerCase()
    : entry.startsWith('path:') && !!app.path && exactPath(app.path, entry.slice(5)));
}
/** Klaus itself in any loaded edition, its helpers, or this exact process; friend tasks may never operate it. */
export function isHostProductApp(app: ComputerUseApp): boolean {
  const executable = realpathSync.native(process.execPath);
  const application = process.platform === 'darwin' ? executable.replace(/\/Contents\/MacOS\/[^/]+$/, '') : executable;
  const bundle = app.bundleId?.toLowerCase(), input = app.input.toLowerCase();
  // Every loaded edition, its helpers and its nested bundles are the host product.
  const editions = Object.values(loadedDesktopEditions());
  return app.pid === process.pid
    || editions.some(edition => {
      const application = edition.application.toLowerCase();
      return bundle === application || bundle?.startsWith(application + '.') === true || bundle === edition.helperApplication.toLowerCase()
        || input === edition.productName.toLowerCase() || input === edition.executableName.toLowerCase() || input === application;
    })
    || !!app.path && (exactPath(app.path, application) || exactPath(app.path, executable))
    || (isAbsolute(app.input) || win32.isAbsolute(app.input)) && (exactPath(app.input, application) || exactPath(app.input, executable));
}
function list(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${label} must be an array of app names`);
  if (value.length > 4096) throw new Error(`${label} exceeds the app policy limit`);
  const result: string[] = [];
  for (const item of value as string[]) {
    if (item.length > 4096 || item.includes('\0')) throw new Error(`${label} contains an invalid app name`);
    const text = item.trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}
function read(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return undefined;
  if (typeof row.value !== 'string') throw new Error(`Computer Use setting ${key} is not readable text`);
  return row.value;
}
function readList(db: DatabaseSync, key: string): string[] {
  const raw = read(db, key);
  if (raw === undefined) return [];
  try { return list(JSON.parse(raw), key); }
  catch { throw new Error(`Computer Use policy ${key} is unreadable; app access is blocked until it is repaired`); }
}
function write(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = operation(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function policyIdentity(settings: ComputerUseSettings): string {
  return JSON.stringify([settings.enabled, settings.allowedApps, settings.deniedApps, settings.managedDisabled]);
}
function identity(app: ComputerUseApp): string {
  if (app.bundleId) return `bundle:${normalizeComputerUseApp(app.bundleId)}`;
  if (app.path) return `path:${normalizeComputerUseApp(app.path)}`;
  if (app.pid) return `pid:${app.pid}`;
  return `input:${normalizeComputerUseApp(app.input)}`;
}
function validatedApp(input: ComputerUseApp): ComputerUseApp {
  const app: ComputerUseApp = { input: appString(input.input, 'app') };
  for (const key of ['name', 'bundleId', 'path'] as const) if (input[key] !== undefined) app[key] = appString(input[key], key);
  if (input.pid !== undefined) {
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || input.pid > 0x7fffffff) throw new Error('Invalid Computer Use process identity');
    app.pid = input.pid;
  }
  return app;
}

/** Standing policy and approval ownership only; this module never activates or inspects an app. */
export class ComputerUsePolicyService {
  private readonly owners = new Map<string, Owner>();
  private readonly leases = new WeakMap<ComputerUseOperation, LeaseState>();
  private readonly mutations = new Set<Promise<unknown>>();
  private readonly mutationControllers = new Set<AbortController>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private passwordController?: AbortController;
  private passwordRevision = 0;
  private closed = false;
  constructor(private readonly deps: ComputerUsePolicyDependencies) {}

  private managed(): ManagedPolicySnapshot {
    try { return this.deps.managedPolicy?.() ?? { status: 'absent' }; }
    catch { return { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE }; }
  }
  private managedBlocksEverything(managed: ManagedPolicySnapshot): boolean {
    return managed.status === 'unreadable' || (managed.status === 'active' && !managed.policy.computerUseEnabled);
  }
  /** The organization-policy refusal wording for the current managed snapshot, if it blocks. */
  private managedRefusal(managed: ManagedPolicySnapshot): string | undefined {
    if (managed.status === 'unreadable') return managed.error;
    if (managed.status === 'active' && !managed.policy.computerUseEnabled) return COMPUTER_USE_GOVERNANCE_MESSAGES.organizationDisabled;
    return undefined;
  }
  private settings(db: DatabaseSync): ComputerUseSettings {
    const enabled = read(db, ENABLED);
    // Saved entries waive the app question; they never restrict other local apps.
    const allowedApps = readList(db, ALLOWED);
    const managed = this.managed();
    const managedDisabled = this.managedBlocksEverything(managed);
    return { enabled: enabled !== '0' && !managedDisabled, availableOnThisPlatform: this.deps.availability().available,
      allowedApps, deniedApps: readList(db, DENIED), managedDisabled };
  }
  get(): ComputerUseSettings { return withSettingsDb(this.deps.configRoot, db => this.settings(db)); }
  taskScope(sessionId: string): ComputerUseTaskScope | undefined {
    const owner = this.owners.get(sessionId);
    const invalid = (error: unknown): never => {
      if (owner) {
        owner.taskRestricted = true; owner.approvals.clear();
        for (const controller of owner.controllers) controller.abort(new Error('Computer Use task authorization is invalid'));
      }
      throw error;
    };
    let scope: ComputerUseTaskScope | undefined;
    try { scope = this.deps.taskScope?.(sessionId); } catch (error) { return invalid(error); }
    if (scope === undefined) return owner?.taskRestricted ? { active: false, apps: [] } : undefined;
    if (owner) owner.taskRestricted = true;
    try {
      if (!scope || typeof scope.active !== 'boolean' || !Array.isArray(scope.apps) || scope.apps.length > 4096) throw new Error('Computer Use task scope is invalid');
      const apps = [...new Set(scope.apps.map(app => {
        const value = appString(app, 'Task application selector');
        if (value.startsWith('bundle:') && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value.slice(7))) return value;
        if (value.startsWith('path:') && (isAbsolute(value.slice(5)) || win32.isAbsolute(value.slice(5)))) return value;
        throw new Error('Computer Use task apps require exact bundle or path selectors');
      }))].sort();
      return { active: scope.active, apps };
    } catch (error) { return invalid(error); }
  }
  taskScopeIdentity(sessionId: string): string { return JSON.stringify(this.taskScope(sessionId) ?? null); }
  sessionSettings(sessionId: string): ComputerUseSettings {
    const scope = this.taskScope(sessionId);
    if (!scope) return this.get();
    return withSettingsDb(this.deps.configRoot, db => {
      const managedDisabled = this.managedBlocksEverything(this.managed());
      return { enabled: scope.active && scope.apps.length > 0 && !managedDisabled,
        availableOnThisPlatform: this.deps.availability().available, allowedApps: scope.apps,
        deniedApps: readList(db, DENIED), managedDisabled };
    });
  }
  guardSession(sessionId: string): ComputerUseSettings { this.owner(sessionId); return this.availableSettings(sessionId); }
  assertTaskScopeCurrent(sessionId: string, expected: string): void {
    const owner = this.owner(sessionId);
    if (this.taskScopeIdentity(sessionId) !== expected) {
      owner.approvals.clear();
      for (const controller of owner.controllers) controller.abort(new Error('Computer Use task authorization changed'));
      throw new Error('Computer Use task authorization changed');
    }
    if (owner.taskRestricted) this.guardSession(sessionId);
  }
  guardResolvedApp(sessionId: string, app: ComputerUseApp): void { this.enforce(validatedApp(app), this.guardSession(sessionId), sessionId); }
  async describeSessionPolicy(sessionId: string, signal: AbortSignal): Promise<string> {
    const scope = this.taskScope(sessionId);
    if (!scope) return this.describePolicy(signal);
    signal.throwIfAborted(); this.guardSession(sessionId);
    return `Task-authorized applications: ${scope.apps.join(', ')}\nAccess is limited to this task. Lock-screen auto-unlock: disabled.`;
  }
  autoUnlockEnabled(): boolean { return !this.closed && withSettingsDb(this.deps.configRoot, db => read(db, AUTO_UNLOCK) === '1'); }
  setEnabled(payload: unknown): Promise<{ ok: boolean; settings: ComputerUseSettings; error?: string }> {
    const enabled = record(payload).enabled;
    if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (this.closed) throw new Error('Computer Use policy service is closed');
    if (!enabled) { this.passwordRevision++; this.passwordController?.abort(new Error('Computer Use was disabled')); }
    if (this.mutations.size >= 32) throw new Error('Computer Use settings update queue is full');
    const task = this.mutationQueue.then(async () => {
      if (this.closed) throw new Error('Computer Use policy service is closed');
      // An organization policy wins over the local preference: enabling is refused outright.
      const managed = this.managed(), refusal = enabled ? this.managedRefusal(managed) : undefined;
      if (refusal) return { ok: false, settings: this.get(), error: refusal };
      const settings = withSettingsDb(this.deps.configRoot, db => transaction(db, () => {
        write(db, ENABLED, enabled ? '1' : '0'); return this.settings(db);
      }));
      this.invalidateApprovals(settings);
      const controller = new AbortController(); this.mutationControllers.add(controller);
      try {
        await this.deps.enabledChanged(enabled, controller.signal);
        if (controller.signal.aborted) throw new Error('Computer Use runtime update was cancelled');
        return { ok: true, settings };
      } catch (error) {
        return { ok: false, settings, error: `Computer Use preference was saved, but runtime synchronization failed: ${String(error)}` };
      } finally { this.mutationControllers.delete(controller); }
    });
    this.mutationQueue = task.catch(() => {});
    this.mutations.add(task);
    void task.finally(() => this.mutations.delete(task)).catch(() => {});
    return task;
  }
  addAllowedApp(payload: unknown): { ok: true; settings: ComputerUseSettings } {
    if (this.closed) throw new Error('Computer Use policy service is closed');
    const app = appString(record(payload).app, 'app');
    if (computerUseSafetyForbidden({ input: app })) throw new Error(COMPUTER_USE_GOVERNANCE_MESSAGES.safetyForbiddenApp(app));
    const settings = withSettingsDb(this.deps.configRoot, db => transaction(db, () => {
      const current = this.settings(db);
      if (!current.allowedApps.includes(app)) current.allowedApps.push(app);
      if (current.allowedApps.length > 4096) throw new Error('Computer Use app policy limit exceeded');
      write(db, ALLOWED, JSON.stringify(current.allowedApps)); return this.settings(db);
    }));
    this.invalidateApprovals(settings); return { ok: true, settings };
  }
  removeAllowedApp(payload: unknown): { ok: true; settings: ComputerUseSettings } {
    if (this.closed) throw new Error('Computer Use policy service is closed');
    const app = appString(record(payload).app, 'app');
    const settings = withSettingsDb(this.deps.configRoot, db => transaction(db, () => {
      const current = this.settings(db);
      write(db, ALLOWED, JSON.stringify(current.allowedApps.filter(entry => entry !== app)));
      return this.settings(db);
    }));
    this.invalidateApprovals(settings);
    return { ok: true, settings };
  }
  /** The connector policy tool passes snake_case fields; omitted/null fields leave lists alone. */
  setAppPolicy(payload: unknown, signal: AbortSignal = new AbortController().signal): Promise<{ ok: true; settings: ComputerUseSettings; notes: string[] }> {
    if (this.closed) throw new Error('Computer Use policy service is closed');
    const value = record(payload);
    for (const key of Object.keys(value)) if (!['blocked_apps', 'always_allowed_apps', 'restricted_to_apps', 'auto_unlock'].includes(key)) throw new Error(`Unknown Computer Use policy field: ${key}`);
    if (value.always_allowed_apps != null && value.restricted_to_apps != null) throw new Error('Supply only one saved app list');
    const unlock = value.auto_unlock == null ? undefined : value.auto_unlock;
    if (unlock !== undefined && typeof unlock !== 'boolean') throw new Error('auto_unlock must be true or false');
    if (unlock !== undefined && !this.deps.loginPassword?.available()) throw new Error('Lock-screen auto-unlock is macOS-only and requires the current native helper');
    const blocked = value.blocked_apps == null ? undefined : list(value.blocked_apps, 'blocked_apps');
    // Accept the old wire member for in-flight sessions; saved entries now waive approval.
    const rawAllowed = value.always_allowed_apps ?? value.restricted_to_apps;
    const allowed = rawAllowed == null ? undefined : list(rawAllowed, 'always_allowed_apps');
    if (allowed !== undefined) for (const entry of allowed) if (computerUseSafetyForbidden({ input: entry })) throw new Error(COMPUTER_USE_GOVERNANCE_MESSAGES.safetyForbiddenApp(entry));
    signal.throwIfAborted();
    if (this.mutations.size >= 32) throw new Error('Computer Use settings update queue is full');
    const revision = unlock === undefined ? undefined : ++this.passwordRevision;
    if (unlock !== undefined) this.passwordController?.abort(new Error(unlock ? 'Auto-unlock configuration changed' : 'Auto-unlock was disarmed'));
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    this.mutationControllers.add(controller);
    const check = () => {
      controller.signal.throwIfAborted(); if (this.closed) throw new Error('Computer Use policy service is closed');
      if (revision !== undefined && revision !== this.passwordRevision) throw new Error('Auto-unlock update was superseded');
    };
    const task = this.mutationQueue.then(async () => {
      check(); const notes: string[] = [];
      let settings = withSettingsDb(this.deps.configRoot, db => transaction(db, () => {
        if (blocked !== undefined) write(db, DENIED, JSON.stringify(blocked));
        if (allowed !== undefined) write(db, ALLOWED, JSON.stringify(allowed));
        return this.settings(db);
      }));
      if (blocked !== undefined || allowed !== undefined) { this.invalidateApprovals(settings); notes.push('App policy updated.'); }
      if (unlock !== undefined) {
        const store = this.deps.loginPassword!; this.passwordController = controller;
        if (!unlock) {
          check(); withSettingsDb(this.deps.configRoot, db => write(db, AUTO_UNLOCK, '0'));
          this.invalidateApprovals(settings, true);
          await store.remove(controller.signal); check();
          notes.push('Auto-unlock disarmed, and the stored login password was deleted.');
        } else {
          const existing = await store.hasPassword(controller.signal); check();
          const receipt = existing ? undefined : await store.prompt(controller.signal);
          let armed = false;
          try {
            check();
            if (receipt?.cancelled) notes.push('The user cancelled the password dialog, so the auto-unlock preference was left unchanged.');
            else {
              withSettingsDb(this.deps.configRoot, db => write(db, AUTO_UNLOCK, '1')); armed = true;
              this.invalidateApprovals(settings, true);
              notes.push(existing || !receipt?.created ? 'Auto-unlock armed with the password already in the keychain.'
                : 'Auto-unlock armed; the user typed the login password into a native dialog and it went straight to the keychain.');
            }
          } finally { if (!armed && receipt?.created) await receipt.discard(); }
        }
      }
      check(); settings = this.get(); if (!notes.length) notes.push('Nothing to change; the policy is unchanged.');
      return { ok: true as const, settings, notes };
    }).finally(() => {
      if (this.passwordController === controller) this.passwordController = undefined;
      signal.removeEventListener('abort', abort); this.mutationControllers.delete(controller); this.mutations.delete(task);
    });
    this.mutationQueue = task.catch(() => {}); this.mutations.add(task); return task;
  }
  async describePolicy(signal: AbortSignal = new AbortController().signal): Promise<string> {
    signal.throwIfAborted();
    const store = this.deps.loginPassword;
    const hasPassword = store?.available() ? await store.hasPassword(signal).catch(() => undefined) : undefined;
    signal.throwIfAborted();
    return withSettingsDb(this.deps.configRoot, db => {
      const settings = this.settings(db);
      const armed = read(db, AUTO_UNLOCK) === '1';
      const managed = this.managed();
      const organization = managed.status === 'unreadable' ? `Organization policy: ${managed.error}`
        : managed.status === 'active' && !managed.policy.computerUseEnabled ? `Organization policy: ${COMPUTER_USE_GOVERNANCE_MESSAGES.organizationDisabled}`
          : managed.status === 'active' && managed.policy.blockedApps.length ? `Organization-blocked apps (never operated): ${managed.policy.blockedApps.join(', ')}` : '';
      const unlock = !store?.available() ? 'unavailable on this platform or with this native helper'
        : !armed ? 'off' : hasPassword === true ? 'armed, login password stored in the keychain'
          : hasPassword === false ? 'armed but no login password is stored, so a locked screen still asks the user'
            : 'armed but login password presence could not be confirmed, so a locked screen may still ask the user';
      return `${organization ? `${organization}\n` : ''}Blocked apps (never operated): ${settings.deniedApps.join(', ') || 'none'}\n` +
        `Always-allowed apps (skip the app question): ${settings.allowedApps.join(', ') || 'none'}\n` +
        `Other local apps may be used after approval. Saved app entries do not restrict access to other apps.\n` +
        `Lock-screen auto-unlock: ${unlock}`;
    });
  }
  private invalidateApprovals(settings: ComputerUseSettings, force = false): void {
    for (const [sessionId, owner] of this.owners) {
      let policy: string;
      try { policy = policyIdentity(owner.taskRestricted ? this.sessionSettings(sessionId) : settings); }
      catch { policy = 'invalid'; }
      owner.approvals.clear(); owner.policy = '';
      for (const lease of owner.leases) {
        const state = this.leases.get(lease);
        if (state && (force && !owner.taskRestricted || state.policy !== policy)) state.controller.abort(new Error('Computer Use policy changed'));
      }
    }
  }
  attachSession(sessionId: string): void {
    appString(sessionId, 'sessionId');
    if (this.closed) throw new Error('Computer Use policy service is closed');
    if (this.owners.has(sessionId)) throw new Error('Previous Computer Use session owner must finish detaching');
    if (this.owners.size >= 256) throw new Error('Computer Use session capacity exceeded');
    this.owners.set(sessionId, { resourceId: randomUUID(), generation: ++this.generation, closing: false,
      approvals: new Set(), policy: '', controllers: new Set(), pending: new Set(), leases: new Set(), taskRestricted: this.taskScope(sessionId) !== undefined });
  }
  /** This preflight precedes even a non-activating native metadata lookup. */
  guardInput(sessionId: string, input: string): void {
    this.owner(sessionId);
    const app = { input: appString(input, 'app') }, settings = this.availableSettings(sessionId);
    if (computerUseSafetyForbidden(app)) throw new Error(COMPUTER_USE_GOVERNANCE_MESSAGES.safetyForbiddenApp(app.input));
    const managed = this.managed();
    if (managed.status === 'active' && computerUseAppMatches(app, managed.policy.blockedApps)) throw new Error(COMPUTER_USE_GOVERNANCE_MESSAGES.organizationBlockedApp(app.input));
    if (this.taskScope(sessionId) && isHostProductApp(app)) throw new Error('Friend tasks cannot operate Klaus or the host process');
    if (computerUseAppMatches(app, settings.deniedApps)) throw new Error(`Computer Use is blocked for app: ${app.input}`);
  }
  private owner(sessionId: string): Owner {
    const owner = this.owners.get(sessionId);
    if (this.closed || !owner || owner.closing) throw new Error('Computer Use session owner is unavailable');
    return owner;
  }
  private availableSettings(sessionId: string): ComputerUseSettings {
    const settings = this.sessionSettings(sessionId);
    const refusal = this.managedRefusal(this.managed());
    if (refusal) throw new Error(refusal);
    if (!settings.enabled) throw new Error(this.taskScope(sessionId) ? 'Computer Use task authorization is inactive or has no approved applications' : 'Computer Use is disabled');
    if (!settings.availableOnThisPlatform) throw new Error(this.deps.availability().error ?? 'Computer Use is unavailable on this platform');
    return settings;
  }
  private enforce(app: ComputerUseApp, settings: ComputerUseSettings, sessionId: string): void {
    const label = app.name || app.input;
    if (computerUseSafetyForbidden(app)) throw new Error(COMPUTER_USE_GOVERNANCE_MESSAGES.safetyForbiddenApp(label));
    const managed = this.managed();
    if (managed.status === 'active' && computerUseAppMatches(app, managed.policy.blockedApps)) throw new Error(COMPUTER_USE_GOVERNANCE_MESSAGES.organizationBlockedApp(label));
    if (computerUseAppMatches(app, settings.deniedApps)) throw new Error(`Computer Use is blocked for app: ${label}`);
    const scoped = this.taskScope(sessionId) !== undefined;
    if (scoped && isHostProductApp(app)) throw new Error('Friend tasks cannot operate Klaus or the host process');
    if (scoped && !computerUseTaskAppMatches(app, settings.allowedApps)) throw new Error(`Computer Use is only allowed for configured apps. Blocked app: ${label}`);
  }
  /** Resolve metadata without activation first, then approve the exact resolved app. */
  approve(input: ComputerUseApp, context: ComputerUseApprovalContext): Promise<ComputerUseOperation> {
    const app = validatedApp(input), owner = this.owner(context.sessionId);
    const taskScope = this.taskScopeIdentity(context.sessionId);
    if (context.signal.aborted) return Promise.reject(new Error('Computer Use operation was cancelled'));
    if (owner.controllers.size >= 32 || [...this.owners.values()].reduce((sum, value) => sum + value.controllers.size, 0) >= 256) throw new Error('Computer Use operation capacity exceeded');
    const controller = new AbortController(); owner.controllers.add(controller);
    const abort = () => controller.abort(context.signal.reason); context.signal.addEventListener('abort', abort, { once: true });
    const dispose = () => { context.signal.removeEventListener('abort', abort); owner.controllers.delete(controller); };
    let retained = false;
    const task = Promise.resolve().then(async () => {
      const check = () => {
        if (controller.signal.aborted || this.owner(context.sessionId) !== owner) throw new Error('Computer Use operation was cancelled');
        this.assertTaskScopeCurrent(context.sessionId, taskScope);
        const settings = this.availableSettings(context.sessionId); this.enforce(app, settings, context.sessionId);
        const key = policyIdentity(settings);
        if (owner.policy !== key) { owner.policy = key; owner.approvals.clear(); }
        return settings;
      };
      let settings = check();
      const key = identity(app);
      if (!owner.taskRestricted && !owner.approvals.has(key) && !computerUseAppMatches(app, settings.allowedApps)) {
        const approval = { app: app.input, ...(app.bundleId ? { bundleIdentifier: app.bundleId } : {}),
          ...(context.toolName ? { toolName: context.toolName } : {}), sessionId: context.sessionId };
        this.deps.telemetry?.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.appApprovalRequested, ...approval });
        let response: ObjectValue;
        try {
          response = record(await context.elicit({
            _meta: { persist: ['always'], klaus: { computerUseApp: app.input } },
            message: `Allow Klaus to use ${app.input}?`, requestedSchema: { properties: {}, type: 'object' },
          }, controller.signal));
        } catch (error) {
          this.deps.telemetry?.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.appApprovalResolved, approvalResult: 'cancelled', ...approval });
          throw error;
        }
        const accepted = response.action === 'accept';
        this.deps.telemetry?.record({ event: COMPUTER_USE_TELEMETRY_EVENTS.appApprovalResolved,
          approvalResult: accepted ? 'accepted' : typeof response.action === 'string' && response.action ? response.action : 'declined', ...approval });
        settings = check();
        if (!accepted) throw new Error(`Computer Use access to ${app.input} was ${typeof response.action === 'string' ? response.action : 'cancelled'}`);
      }
      settings = check();
      owner.approvals.add(key);
      if (owner.approvals.size > 256) owner.approvals.delete(owner.approvals.values().next().value!);
      const lease: ComputerUseOperation = Object.freeze({ resourceId: owner.resourceId, operationId: randomUUID(),
        sessionId: context.sessionId, generation: owner.generation, app: Object.freeze(app), signal: controller.signal });
      this.leases.set(lease, { owner, controller, policy: policyIdentity(settings), taskScope, dispose });
      owner.leases.add(lease); retained = true;
      return lease;
    }).finally(() => { owner.pending.delete(task); if (!retained) dispose(); });
    owner.pending.add(task); return task;
  }
  /** Check immediately before each native action and again after every awaited native result. */
  assertCurrent(lease: ComputerUseOperation): void {
    const state = this.leases.get(lease);
    if (!state || state.controller.signal.aborted || this.owner(lease.sessionId) !== state.owner) throw new Error('Computer Use operation lease is unavailable');
    this.assertTaskScopeCurrent(lease.sessionId, state.taskScope);
    const settings = this.availableSettings(lease.sessionId); this.enforce(lease.app, settings, lease.sessionId);
    if (policyIdentity(settings) !== state.policy) throw new Error('Computer Use policy changed; request fresh app state before continuing');
  }
  /** Only release after the actual native work and any entered callbacks have settled. */
  release(lease: ComputerUseOperation): void {
    const state = this.leases.get(lease); if (!state) return;
    this.leases.delete(lease); state.owner.leases.delete(lease); state.dispose();
  }
  async detachSession(sessionId: string, deadlineMs = 5000): Promise<{ complete: boolean }> {
    const owner = this.owners.get(sessionId); if (!owner) return { complete: true };
    owner.closing = true; owner.approvals.clear();
    for (const controller of owner.controllers) controller.abort(new Error('Computer Use session detached'));
    const deadline = performance.now() + Math.max(0, Math.min(30_000, Number.isFinite(deadlineMs) ? deadlineMs : 5000));
    while ((owner.pending.size || owner.leases.size) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    const complete = !owner.pending.size && !owner.leases.size;
    if (complete && this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    return { complete };
  }
  async close(deadlineMs = 5000): Promise<{ complete: boolean }> {
    this.closed = true;
    const duration = Math.max(0, Math.min(30_000, Number.isFinite(deadlineMs) ? deadlineMs : 5000)), deadline = performance.now() + duration;
    for (const controller of this.mutationControllers) controller.abort(new Error('Computer Use policy service closed'));
    const owners = await Promise.all([...this.owners.keys()].map(session => this.detachSession(session, duration)));
    while (this.mutations.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    return { complete: owners.every(owner => owner.complete) && this.mutations.size === 0 };
  }
}
