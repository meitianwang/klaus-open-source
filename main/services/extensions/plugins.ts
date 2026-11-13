import { valid } from 'semver';
import type { Json } from '../../ipc/contract';
import { IpcHandlerError } from '../../ipc/registry';
import { Cancelled, checkCancelled } from '../download';
import { errorMessage, object, requiredString, SerialMutations, string, type JsonObject } from '../service-types';
import { OFFICIAL_MARKETPLACE, type OfficialPackageProgress } from './official-plugins';
import { newerPluginVersion, pluginManifest, PluginCatalog, type PluginCatalogDeps, type PluginCatalogSnapshot } from './plugin-catalog';
import { PluginSources, type PluginSourceDeps } from './plugin-sources';
import { RuntimeViewService, type DesiredPlugin, type RuntimeViewDeps } from './runtime-view';

export type PluginInstallStage = 'downloading' | 'verifying' | 'extracting' | 'installing';
export type PluginProgressEvent = {
  id: string;
  action: 'install' | 'update';
  stage: PluginInstallStage;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  cancellable: boolean;
};

const PROGRESS_INTERVAL_MS = 150;
const SPEED_SMOOTHING_ALPHA = 0.3;
const DOWNLOAD_PROGRESS_CEILING = 82;
const STAGE_PERCENT: Record<Exclude<PluginInstallStage, 'downloading'>, number> = {
  verifying: 86,
  extracting: 92,
  installing: 97,
};

interface ActiveAcquisition {
  id: string;
  controller: AbortController;
  cancellable: boolean;
  cancelledByUser: boolean;
}

export interface PluginDeps extends PluginCatalogDeps, PluginSourceDeps, RuntimeViewDeps {
  /** Returns the named terminal field, not the submission ACK. */
  requestAcknowledged: (method: string, params: JsonObject, field: string) => Promise<unknown>;
  onChanged: (change: PluginChange) => void | Promise<void>;
  updateCheck?: () => JsonObject;
  /**
   * Make an official marketplace plugin's package present locally before it is
   * staged. Official plugins are published one package each and fetched on
   * demand, so the manifest can name a plugin whose bytes are not on disk yet.
   * Returns false when the name is not one this host downloads.
   */
  ensurePackage?: (name: string, signal: AbortSignal, onProgress?: (progress: OfficialPackageProgress) => void) => Promise<boolean>;
  onProgress?: (event: PluginProgressEvent) => void;
  progressIntervalMs?: number;
  now?: () => number;
  /**
   * Persist one machine-readable failure record so a later conversation can
   * diagnose it. Returns the log path to echo in the failure receipt.
   */
  failureLog?: (info: JsonObject) => string | undefined;
}
export interface PluginChange {
  method: string;
  id: string;
  /** The confirmed engine outcome, including its endpoint activation contract. */
  mutation: JsonObject;
}
const desired = (rows: JsonObject[]): DesiredPlugin[] => rows.map(row => ({ id: string(row.id), name: string(row.name), enabled: row.enabled === true }));

export class PluginService {
  readonly catalog: PluginCatalog;
  readonly runtime: RuntimeViewService;
  private readonly sources: PluginSources;
  private readonly mutations = new SerialMutations();
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly acquisitions = new Set<ActiveAcquisition>();
  constructor(private readonly deps: PluginDeps) { this.catalog = new PluginCatalog(deps); this.sources = new PluginSources(deps); this.runtime = new RuntimeViewService(deps); }
  private check(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The plugin service is closed'); }
  /**
   * Failure receipts stay user-quiet: the message travels to a dialog, while
   * the diagnostic record (including the engine error and update-check state)
   * is written to a log a later conversation can read.
   */
  private failureReceipt(action: string, name: string, id: string, error: unknown, extra: JsonObject = {}): JsonObject {
    const message = errorMessage(error);
    const info: JsonObject = { at: new Date().toISOString(), action, id, error: message, ...extra };
    if (error instanceof Error && error.stack) info.stack = error.stack;
    if (this.deps.updateCheck) info.updateCheck = this.deps.updateCheck();
    let diagnosticLog: string | undefined;
    try { diagnosticLog = this.deps.failureLog?.(info); } catch { diagnosticLog = undefined; }
    this.deps.diagnostic?.(`Plugin ${action} failed for ${id}: ${message}`);
    return { ok: false, name, error: message, ...(diagnosticLog ? { diagnosticLog } : {}) };
  }
  private track<T>(action: () => Promise<T>): Promise<T> {
    try { this.check(); } catch (error) { return Promise.reject(error); }
    const pending = action(); this.pending.add(pending); return pending.finally(() => { this.pending.delete(pending); });
  }
  /** Marketplace replacements cannot race a plugin source copy into the engine install staging. */
  withMutation<T>(action: () => Promise<T>): Promise<T> { return this.track(() => this.mutations.run(async () => { this.check(); return action(); })); }
  private mutate(action: () => Promise<Json>): Promise<Json> { return this.withMutation(action); }
  private async marketRows(state: PluginCatalogSnapshot): Promise<JsonObject> {
    const rows = state.rows.map(row => ({ ...row })), roots = await this.catalog.roots(state);
    if (roots.length) {
      try {
        const answer = object(await this.deps.requestAcknowledged('session/pluginCatalog', { roots: roots.map(root => ({ ...root })) }, 'pluginCatalog'));
        if (!Array.isArray(answer.entries)) throw new Error('Plugin catalog result has no entries array');
        const contributions = new Map(answer.entries.map(value => { const entry = object(value); return [string(entry.id), entry.contributions]; }));
        for (const row of rows) { const contribution = contributions.get(string(row.id)); if (contribution != null) row.contributions = contribution; }
      } catch (error) { this.deps.diagnostic?.('Plugin contribution catalog unavailable: ' + errorMessage(error)); }
    }
    return { plugins: rows.filter(row => row.installed === true || string(row.id).endsWith('@builtin') || string(row.id).endsWith('@klaus-official')), restartRequired: this.deps.endpointRestartRequired?.() === true, ...(this.deps.updateCheck ? { updateCheck: this.deps.updateCheck() } : {}), marketplaces: state.marketplaces.map(market => ({ name: market.name, installLocation: market.installLocation,
      lastUpdated: market.lastUpdated, seeded: market.seeded || Boolean(market.installLocation?.includes('plugins-seed')) })) };
  }
  market(): Promise<Json> { return this.track(async () => this.marketRows(await this.catalog.snapshot())); }
  list(payload: JsonObject): Promise<Json> {
    return this.track(async () => {
      const state = await this.catalog.snapshot(), rows = state.rows.filter(row => row.installed === true);
      const view = await this.runtime.view(string(payload.sessionId), desired(rows));
      const runtimes = new Map((view.plugins as Json[]).map(value => { const row = object(value); return [string(row.pluginId), row]; }));
      return rows.map(row => ({ ...row, ...(runtimes.has(string(row.id)) ? { runtime: runtimes.get(string(row.id))! } : {}) }));
    });
  }
  runtimeView(payload: JsonObject): Promise<Json> {
    return this.track(async () => this.runtime.view(string(payload.sessionId), desired((await this.catalog.snapshot()).rows.filter(row => row.installed === true))));
  }
  private async mutation(method: string, params: JsonObject, name: string, id = name): Promise<JsonObject> {
    const result = object(await this.deps.requestAcknowledged(method, params, 'pluginMutation'));
    if (result.error != null) throw new IpcHandlerError('PLUGIN_MUTATION_FAILED', errorMessage(result.error));
    if (result.persisted !== true) throw new IpcHandlerError('PLUGIN_MUTATION_FAILED', 'The engine did not persist the plugin change');
    let warning: string | undefined;
    try { await this.deps.onChanged({ method, id, mutation: structuredClone(result) }); }
    catch (error) {
      warning = errorMessage(error);
      this.deps.diagnostic?.('Plugin change was persisted, but refreshing its projection failed: ' + warning);
    }
    return { ok: true, name, restartRequired: result.restartRequired === true,
      ...(typeof result.activationScope === 'string' ? { activationScope: result.activationScope } : {}),
      ...(typeof result.appliedToCurrentSession === 'boolean' ? { appliedToCurrentSession: result.appliedToCurrentSession } : {}),
      ...(warning ? { warning, warningCode: 'PLUGIN_PROJECTION_REFRESH_FAILED' } : {}) };
  }
  toggle(payload: JsonObject): Promise<Json> {
    return this.mutate(async () => {
      const id = requiredString(payload.id, 'id'); if (typeof payload.enabled !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'enabled must be a boolean');
      try { return await this.mutation('session/setInstalledPluginEnabled', { name: id, enabled: payload.enabled }, id); }
      catch (error) { return this.failureReceipt('toggle', id, id, error, { enabled: payload.enabled }); }
    });
  }
  uninstall(payload: JsonObject): Promise<Json> {
    return this.mutate(async () => {
      const id = requiredString(payload.id, 'id');
      try { return { ...await this.mutation('session/uninstallPlugin', { name: id, removeFiles: true }, id), removed: true }; }
      catch (error) { return this.failureReceipt('uninstall', id, id, error); }
    });
  }
  /** Install a shipped workflow through the engine-owned plugin registry. */
  ensureBundled(name: string, sourceDir: string): Promise<Json> {
    return this.mutate(async () => {
      const manifest = await pluginManifest(sourceDir), version = string(manifest?.version), id = name + '@builtin';
      if (manifest?.name !== name || !version) throw new IpcHandlerError('PLUGIN_PACKAGE_INVALID', 'The bundled workflow package is invalid');
      const installed = object((await this.catalog.snapshot()).installed[id]);
      if (!Object.keys(installed).length || installed.version !== version) {
        const staged = await this.sources.stage({ source: '.' }, sourceDir);
        try {
          const params: JsonObject = { marketplace: 'builtin', sourceDir: staged.sourceDir, version };
          if (typeof installed.version === 'string') params.expectedInstalledVersion = installed.version;
          await this.mutation('session/installPlugin', params, name, id);
        } finally { await staged.cleanup(); }
      }
      const confirmed = object((await this.catalog.snapshot()).installed[id]);
      if (confirmed.enabled === false) await this.mutation('session/setInstalledPluginEnabled', { name: id, enabled: true }, name, id);
      const active = object((await this.catalog.snapshot()).installed[id]);
      if (!Object.keys(active).length || active.version !== version || active.enabled === false) throw new IpcHandlerError('PLUGIN_UPDATE_FAILED', 'The desktop pet workflow could not be activated');
      return { ok: true, name: id, version };
    });
  }
  /** Provision an offline official package without changing its identity or user preferences. */
  ensureBundledOfficial(name: string, sourceDir: string): Promise<Json> {
    return this.mutate(async () => {
      const manifest = await pluginManifest(sourceDir), version = string(manifest?.version), id = name + '@' + OFFICIAL_MARKETPLACE;
      if (manifest?.name !== name || !valid(version)) throw new IpcHandlerError('PLUGIN_PACKAGE_INVALID', 'The bundled official plugin package is invalid');
      const installed = (await this.catalog.snapshot()).installed[id], previous = object(installed), installedVersion = string(previous.version);
      // Unknown revisions cannot be safely ordered, so leave them under user control.
      if (installed !== undefined && !newerPluginVersion(version, installedVersion)) {
        return { ok: true, name: id, version: installedVersion, enabled: previous.enabled !== false };
      }
      const staged = await this.sources.stage({ name, source: '.', version }, sourceDir, { excludedPaths: ['runtime/target', 'runtime/.tools'] });
      try {
        if (staged.version !== version) throw new IpcHandlerError('PLUGIN_PACKAGE_INVALID', 'The bundled official plugin changed during staging');
        const current = (await this.catalog.snapshot()).installed[id];
        if ((current === undefined) !== (installed === undefined) || object(current).version !== previous.version || object(current).enabled !== previous.enabled) {
          throw new IpcHandlerError('PLUGIN_UPDATE_FAILED', 'Installed plugin changed during offline provisioning');
        }
        const params: JsonObject = { marketplace: OFFICIAL_MARKETPLACE, sourceDir: staged.sourceDir, version };
        if (installed !== undefined) params.expectedInstalledVersion = installedVersion;
        await this.mutation('session/installPlugin', params, name, id);
      } finally { await staged.cleanup(); }
      const confirmed = (await this.catalog.snapshot()).installed[id], active = object(confirmed);
      if (confirmed === undefined || active.version !== version || (installed !== undefined && (active.enabled !== false) !== (previous.enabled !== false))) {
        throw new IpcHandlerError('PLUGIN_UPDATE_FAILED', 'The engine did not confirm the bundled official plugin installation');
      }
      return { ok: true, name: id, version, enabled: active.enabled !== false };
    });
  }
  install(payload: JsonObject): Promise<Json> {
    return this.acquire(payload, false);
  }
  update(payload: JsonObject): Promise<Json> {
    return this.acquire(payload, true);
  }
  cancel(payload: JsonObject): Json {
    this.check();
    const id = requiredString(payload.id, 'id');
    const matching = [...this.acquisitions].filter(entry => entry.id === id);
    const cancellable = matching.filter(entry => entry.cancellable);
    for (const entry of cancellable) {
      entry.cancelledByUser = true;
      entry.controller.abort();
    }
    return { ok: cancellable.length > 0, id, cancelled: cancellable.length > 0, active: matching.length > 0 };
  }
  private acquire(payload: JsonObject, updating: boolean): Promise<Json> {
    let targetId = typeof payload.id === 'string' ? payload.id.trim() : '';
    const active: ActiveAcquisition = { id: targetId, controller: new AbortController(), cancellable: true, cancelledByUser: false };
    this.acquisitions.add(active);
    const action: 'install' | 'update' = updating ? 'update' : 'install';
    const clock = this.deps.now ?? (() => Date.now());
    const interval = this.deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
    let lastSampleAt: number | undefined;
    let lastSampleBytes: number | undefined;
    let smoothedSpeed: number | undefined;
    let lastEmittedAt: number | undefined;
    let knownTotal = 0;
    const emitProgress = (stage: PluginInstallStage, transferred: number, total: number, cancellable: boolean): void => {
      if (this.closed || !active.id || active.cancelledByUser) return;
      if (total > 0) knownTotal = total;
      if (stage === 'downloading') {
        const at = clock();
        if (lastSampleAt !== undefined && lastSampleBytes !== undefined) {
          const elapsed = at - lastSampleAt, delta = transferred - lastSampleBytes;
          if (delta < 0) {
            smoothedSpeed = undefined;
          } else if (elapsed > 0 && delta > 0) {
            const instant = (delta / elapsed) * 1000;
            smoothedSpeed = smoothedSpeed === undefined ? instant : smoothedSpeed * (1 - SPEED_SMOOTHING_ALPHA) + instant * SPEED_SMOOTHING_ALPHA;
          }
        }
        lastSampleAt = at;
        lastSampleBytes = transferred;
        const ratio = total > 0 ? Math.max(0, Math.min(1, transferred / total)) : 0;
        const complete = total > 0 && transferred >= total;
        if (!complete && lastEmittedAt !== undefined && at - lastEmittedAt < interval) return;
        lastEmittedAt = at;
        this.deps.onProgress?.({
          id: active.id,
          action,
          stage,
          percent: ratio * DOWNLOAD_PROGRESS_CEILING,
          transferred,
          total,
          bytesPerSecond: smoothedSpeed ?? 0,
          cancellable,
        });
        return;
      }
      this.deps.onProgress?.({
        id: active.id,
        action,
        stage,
        percent: STAGE_PERCENT[stage],
        transferred: knownTotal || transferred,
        total: knownTotal || total,
        bytesPerSecond: 0,
        cancellable,
      });
    };
    return this.mutate(async () => {
      const id = requiredString(payload.id, 'id'), at = id.lastIndexOf('@'), name = id.slice(0, at), marketplace = id.slice(at + 1);
      targetId = id;
      active.id = id;
      if (active.cancelledByUser) return { ok: false, name: name || id, cancelled: true };
      const state = await this.catalog.snapshot(), market = state.marketplaces.find(item => item.name === marketplace);
      const entry = at > 0 ? market?.entries.find(item => item.name === name) : undefined;
      if (!entry || !market?.installLocation) return this.failureReceipt(action, id, id, 'Plugin not found');
      try {
        checkCancelled(active.controller.signal);
        const record = state.installed[id], installedVersion = string(object(record).version);
        const target = state.rows.find(row => row.id === id), availableVersion = string(target?.availableVersion);
        if (updating) {
          if (!record || object(record).source === 'builtin') throw new Error('Plugin is not an updatable installation');
          if (!newerPluginVersion(availableVersion, installedVersion)) throw new Error('No newer plugin release is available');
          if (requiredString(payload.version, 'version') !== availableVersion) throw new Error('Plugin release changed; refresh the marketplace before updating');
          if (payload.installedVersion !== undefined && payload.installedVersion !== installedVersion) throw new Error('Installed plugin changed; refresh the marketplace before updating');
        }
        // An official plugin whose package has not been fetched yet exists in
        // the manifest but not on disk, so staging it would fail with a missing
        // source. Fetch first, and only for a marketplace that publishes this way.
        let reportedPackageProgress = false;
        if (marketplace === OFFICIAL_MARKETPLACE && this.deps.ensurePackage) {
          const downloaded = await this.deps.ensurePackage(name, active.controller.signal, progress => {
            reportedPackageProgress = true;
            emitProgress(progress.stage, progress.transferred, progress.total, true);
          });
          if (!downloaded) throw new Error('Plugin package is not available for download: ' + name);
        }
        if (!reportedPackageProgress) emitProgress('extracting', 0, 0, true);
        const staged = await this.sources.stage(entry, market.installLocation, { signal: active.controller.signal });
        let outcome: JsonObject | undefined;
        try {
          if (updating) {
            if (staged.version !== availableVersion || !newerPluginVersion(staged.version, installedVersion)) throw new Error('Plugin package version changed; refresh the marketplace before updating');
            const current = (await this.catalog.snapshot()).installed[id];
            if (!current || string(object(current).version) !== installedVersion || object(current).enabled !== object(record).enabled) throw new Error('Installed plugin changed; refresh the marketplace before updating');
          }
          checkCancelled(active.controller.signal);
          active.cancellable = false;
          emitProgress('installing', knownTotal, knownTotal, false);
          const params: JsonObject = { marketplace, sourceDir: staged.sourceDir, version: staged.version };
          if (updating) params.expectedInstalledVersion = installedVersion;
          this.check(); const result = await this.mutation('session/installPlugin', params, name, id);
          outcome = { ...result, version: staged.version };
          if (updating) outcome.updated = true;
          return outcome;
        } finally {
          try { await staged.cleanup(); }
          catch (error) {
            if (!outcome?.ok) throw error;
            outcome.warning = errorMessage(error);
            outcome.warningCode = 'PLUGIN_STAGING_CLEANUP_FAILED';
            this.deps.diagnostic?.('Plugin change was persisted, but removing its staging files failed: ' + errorMessage(error));
          }
        }
      } catch (error) {
        if (active.cancelledByUser && (error instanceof Cancelled || active.controller.signal.aborted)) {
          return { ok: false, name, cancelled: true };
        }
        return this.failureReceipt(action, name, id, error,
          ...(typeof payload.version === 'string' ? [{ requestedVersion: payload.version }] : []));
      }
    }).finally(() => {
      this.acquisitions.delete(active);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const active of this.acquisitions) active.controller.abort();
    await this.sources.close();
    await Promise.allSettled([...this.pending]);
  }
}
