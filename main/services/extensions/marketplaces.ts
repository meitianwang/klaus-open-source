import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../../ipc/contract';
import { checkCancelled } from '../download';
import { GitProcess, gitError, type GitProcessOptions } from '../git-process';
import { errorMessage, object, string, type EngineRequest, type JsonObject } from '../service-types';
import { pathInside, type WorkspaceStore } from '../workspaces';
import { downloadExtension, extractExtensionZip, fetchExtensionText, PendingAcquisitions, replaceExtensionDirectory, SavedExtensionError, UnconfirmedExtensionError } from './acquisition';
import { DirectoryMutations } from './directory-mutations';
import { managedPath, missing, optionalDocument } from './file-store';
import type { PluginService } from './plugins';

const OFFICIAL = 'claude-plugins-official', REPO = 'anthropics/claude-plugins-official';
const MIRROR = 'https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official';
const PREFIX = 'marketplaces/claude-plugins-official/';
export interface PluginMarketplaceDeps {
  workspaces: WorkspaceStore;
  plugins: Pick<PluginService, 'market' | 'withMutation'>;
  request: EngineRequest;
  seedDir?: string;
  /**
   * Refresh of our own first-party marketplace mirror (klaus-official). It is a
   * dependency and not an import to keep the two services independently
   * constructible; runtime.ts wires OfficialPluginsService in here so the UI
   * refresh button picks up newly published official plugins without an app
   * restart. Absent (tests, older call sites) the mirror only syncs at startup.
   */
  klausOfficial?: {
    refresh: (signal: AbortSignal) => Promise<string | undefined>;
    migrateBundledRecords: (signal: AbortSignal) => Promise<Json>;
  };
  onChanged: () => void | Promise<void>;
  onCheckChanged?: () => void;
  shouldRefreshOfficial?: () => Promise<boolean>;
  now?: () => number;
  refreshMaxAgeMs?: number;
  refreshRetryMs?: number;
  refreshIntervalMs?: number;
  environment?: NodeJS.ProcessEnv;
  gitOptions?: GitProcessOptions;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  diagnostic?: (message: string) => void;
}
interface Snapshot { values: JsonObject; version: string }
interface Source { kind: 'local' | 'git' | 'github'; value: string; descriptor: JsonObject }
interface Content { directory: string; cleanup: () => Promise<void>; sha?: string }
const failed = (error: unknown): JsonObject => ({ ok: false, error: errorMessage(error),
  ...(error instanceof SavedExtensionError ? { saved: true, reloadRequired: true } : {}),
  ...(error instanceof UnconfirmedExtensionError ? { commitUnknown: true, reloadRequired: true } : {}) });
function gitUrl(raw: string): string {
  if (!raw || /[\x00-\x1f]/.test(raw) || raw.startsWith('-')) throw new Error('Invalid marketplace git URL');
  if (/^git@[^\s/:]+:[^\s]+$/.test(raw)) return raw;
  const url = new URL(raw);
  if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol) || url.username && url.protocol !== 'ssh:' || url.password) throw new Error('Unsupported marketplace URL or embedded credential');
  return raw;
}

/** Only marketplace content/config lives here; plugin installation remains an engine mutation. */
export class PluginMarketplaceService {
  private readonly pending = new PendingAcquisitions();
  private readonly mutations: DirectoryMutations;
  private readonly git: GitProcess;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly configRoot: string;
  private refreshing: Promise<Json> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private lastRefresh: JsonObject | undefined;
  private lastAttemptAt: number | undefined;
  private checkedAt: number | undefined;
  private refreshError: string | undefined;
  private closed = false;
  constructor(private readonly deps: PluginMarketplaceDeps) {
    this.configRoot = deps.workspaces.configRoot;
    this.environment = deps.environment ?? process.env;
    const configured = Number(this.environment.CLAUDE_CODE_PLUGIN_GIT_TIMEOUT_MS);
    this.git = new GitProcess({ env: this.environment, timeoutMs: Number.isFinite(configured) && configured > 0 ? configured : 120_000, ...deps.gitOptions });
    this.mutations = new DirectoryMutations(deps.workspaces);
  }
  private run(operation: (signal: AbortSignal) => Promise<Json>): Promise<Json> {
    return this.pending.run(signal => this.deps.plugins.withMutation(() => this.mutations.run(() => { checkCancelled(signal); return operation(signal); })));
  }
  private async snapshot(): Promise<Snapshot> {
    const reply = object(await this.deps.request('config/read', {}));
    if (reply.error != null) throw reply.error;
    if (!reply.values || typeof reply.values !== 'object' || Array.isArray(reply.values) || typeof reply.version !== 'string') throw new Error('Invalid engine marketplace config snapshot');
    return { values: object(reply.values), version: reply.version };
  }
  private async write(snapshot: Snapshot, name: string, entry: JsonObject): Promise<void> {
    try {
      const reply = object(await this.deps.request('config/batchWrite', { edits: [{ keyPath: 'marketplaces.' + JSON.stringify(name), value: entry, mergeStrategy: 'replace' }], expectedVersion: snapshot.version }));
      if (reply.error != null) throw reply.error;
      if (!reply.values || typeof reply.values !== 'object' || Array.isArray(reply.values) || typeof reply.version !== 'string') throw new Error('Engine did not confirm the marketplace config write');
      const confirmed = object(object(reply.values).marketplaces);
      if (!Object.hasOwn(confirmed, name) || !isDeepStrictEqual(confirmed[name], entry)) throw new Error('Engine marketplace config reply did not contain the saved entry');
    } catch (error) {
      let current: Snapshot;
      try { current = await this.snapshot(); }
      catch { throw new UnconfirmedExtensionError('Marketplace config write outcome could not be confirmed: ' + errorMessage(error)); }
      const now = object(current.values.marketplaces)[name], before = object(snapshot.values.marketplaces)[name];
      if (isDeepStrictEqual(now, entry)) return;
      if (isDeepStrictEqual(now, before)) throw error;
      throw new UnconfirmedExtensionError('Marketplace config changed during an unconfirmed write: ' + errorMessage(error));
    }
  }
  private async changed(): Promise<void> {
    try { await this.deps.onChanged(); }
    catch (error) { throw new SavedExtensionError('Marketplace was saved, but refreshing live configuration failed: ' + errorMessage(error)); }
  }
  private async cacheLocation(value?: string): Promise<string> {
    const root = await managedPath(this.configRoot, 'plugins/marketplaces', true);
    const location = value === undefined ? join(root, OFFICIAL) : value;
    if (!isAbsolute(location) || resolve(location) === root || !pathInside(resolve(location), root)) throw new Error('Marketplace installLocation is outside the profile marketplace cache');
    const path = await managedPath(root, relative(root, location), true);
    try { if (!(await lstat(path)).isDirectory()) throw new Error('Marketplace cache must be a regular directory'); }
    catch (error) { if (!missing(error)) throw error; }
    return path;
  }
  private async stage(): Promise<string> {
    const base = await managedPath(this.configRoot, 'plugins/staging', true); await mkdir(base, { recursive: true, mode: 0o700 });
    return mkdtemp(join(base, 'marketplace-'));
  }
  private async name(directory: string): Promise<string> {
    for (const folder of ['.claude-plugin', '.codex-plugin']) {
      const raw = await optionalDocument(await managedPath(directory, folder + '/marketplace.json'), 8 * 1024 ** 2);
      if (raw === undefined) continue;
      const data = object(JSON.parse(raw)), name = string(data.name).trim();
      if (!name || name.length > 128 || name.includes('..') || /[/\\@\x00-\x1f]/.test(name)) throw new Error('Marketplace manifest declares an invalid name');
      if (!Array.isArray(data.plugins)) throw new Error('Marketplace manifest has no plugins array');
      return name;
    }
    throw new Error('No .claude-plugin/marketplace.json or .codex-plugin/marketplace.json found');
  }
  private async source(input: string): Promise<Source> {
    const raw = input.trim(); if (!raw) throw new Error('A marketplace source is required (owner/repo, a git URL, or a directory)');
    if (/[\x00-\x1f]/.test(raw)) throw new Error('Invalid marketplace source');
    const home = this.environment.HOME || this.environment.USERPROFILE;
    const expanded = raw.startsWith('~/') && home ? join(home, raw.slice(2)) : raw;
    if (isAbsolute(expanded) || raw.startsWith('./') || raw.startsWith('~/')) {
      if (!isAbsolute(expanded)) throw new Error('Use an absolute path for a local marketplace');
      let info; try { info = await lstat(expanded); } catch (error) { if (missing(error)) throw new Error('No marketplace directory at ' + expanded); throw error; }
      if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error('Marketplace source is not a directory');
      return { kind: 'local', value: resolve(expanded), descriptor: { source: 'file', path: resolve(expanded) } };
    }
    if (raw.includes('://') || raw.startsWith('git@')) return { kind: 'git', value: gitUrl(raw), descriptor: { source: 'git', url: raw } };
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw) && raw.split('/').every(part => part !== '.' && part !== '..')) {
      const repo = raw.replace(/\.git$/, ''); return { kind: 'github', value: repo, descriptor: { source: 'github', repo } };
    }
    throw new Error('Unrecognised marketplace source; use owner/repo, a git URL, or an absolute directory');
  }
  private urls(source: Source): string[] {
    if (source.kind === 'git') return [source.value];
    const https = 'https://github.com/' + source.value + '.git';
    return ['1', 'true', 'yes', 'on'].includes(string(this.environment.CLAUDE_CODE_REMOTE)) ? [https] : [https, 'git@github.com:' + source.value + '.git'];
  }
  private async command(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
    checkCancelled(signal);
    const result = await this.git.run(cwd, ['-c', 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes', ...args], { maxBytes: 1024 ** 2 });
    checkCancelled(signal); if (result.code !== 0) throw new Error(gitError(result, 'Marketplace git operation failed')); return result.stdout.trim();
  }
  private async clone(source: Source, signal: AbortSignal): Promise<Content> {
    const temporary = await this.stage(), directory = join(temporary, 'repository');
    let last: unknown = new Error('No marketplace git URL');
    try {
      for (const url of this.urls(source)) {
        checkCancelled(signal);
        try {
          await this.command(temporary, ['clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules', '--', url, directory], signal);
          await this.name(directory);
          const sha = await this.command(directory, ['rev-parse', 'HEAD'], signal);
          if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('Marketplace git returned an invalid commit');
          return { directory, sha, cleanup: () => rm(temporary, { recursive: true, force: true }) };
        } catch (error) { checkCancelled(signal); last = error; await rm(directory, { recursive: true, force: true }); }
      }
      throw last;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  private entry(source: JsonObject, location: string, sha?: string): JsonObject {
    return { source, installLocation: location, lastUpdated: new Date().toISOString(), autoUpdate: false, ...(sha ? { gcsSha: sha } : {}) };
  }
  private collision(snapshot: Snapshot, name: string, location: string, source: JsonObject): boolean {
    const entries = object(snapshot.values.marketplaces), existing = Object.hasOwn(entries, name) ? object(entries[name]) : undefined;
    if (existing && (existing.installLocation !== location || existing.source != null && !isDeepStrictEqual(existing.source, source))) throw new Error('Marketplace name is already added from another source: ' + name);
    for (const [other, value] of Object.entries(entries)) if (other !== name && object(value).installLocation === location) throw new Error('Marketplace cache is already occupied by ' + other);
    return existing !== undefined;
  }
  add(payload: JsonObject): Promise<Json> {
    return this.run(async signal => {
      let content: Content | undefined;
      try {
        const source = await this.source(string(payload.source)); checkCancelled(signal);
        content = source.kind === 'local' ? { directory: source.value, cleanup: async () => {} } : await this.clone(source, signal);
        const name = await this.name(content.directory), snapshot = await this.snapshot(); checkCancelled(signal);
        const last = source.value.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/\\:]/).at(-1) ?? 'marketplace';
        const cacheName = last.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'marketplace';
        const location = source.kind === 'local' ? source.value : await this.cacheLocation(join(this.configRoot, 'plugins/marketplaces', cacheName));
        const alreadyAdded = this.collision(snapshot, name, location, source.descriptor), entry = this.entry(source.descriptor, location);
        if (source.kind === 'local') await this.write(snapshot, name, entry);
        else await replaceExtensionDirectory(this.configRoot, relative(this.configRoot, location), content.directory, signal, () => this.write(snapshot, name, entry));
        await this.changed(); return { ok: true, name, installLocation: location, alreadyAdded };
      } catch (error) { return failed(error); }
      finally { await content?.cleanup(); }
    });
  }
  private async mirror(location: string, signal: AbortSignal): Promise<Content> {
    const base = string(this.environment.KLAUS_PLUGIN_GCS_BASE).trim().replace(/\/+$/, '') || MIRROR;
    const sha = (await fetchExtensionText(base + '/latest', signal, { fetch: this.deps.fetch, maxBytes: 256, timeoutMs: this.deps.requestTimeoutMs ?? 10_000 })).trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Official marketplace returned an invalid latest commit');
    const sentinel = await optionalDocument(await managedPath(location, '.gcs-sha'));
    if (sentinel?.trim() === sha) {
      if (await this.name(location) !== OFFICIAL) throw new Error('Cached official marketplace has a mismatched name');
      return { directory: location, sha, cleanup: async () => {} };
    }
    const temporary = await this.stage(), directory = join(temporary, 'content'); await mkdir(directory, { mode: 0o700 });
    try {
      const archive = join(temporary, 'marketplace.zip');
      await downloadExtension(base + '/' + sha + '.zip', archive, signal, { fetch: this.deps.fetch });
      await extractExtensionZip(archive, directory, signal, PREFIX);
      if (await this.name(directory) !== OFFICIAL) throw new Error('Official marketplace archive has a mismatched name');
      await writeFile(join(directory, '.gcs-sha'), sha, { mode: 0o600 });
      return { directory, sha, cleanup: () => rm(temporary, { recursive: true, force: true }) };
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  private async refreshOfficial(signal: AbortSignal): Promise<JsonObject> {
    const snapshot = await this.snapshot(), entries = object(snapshot.values.marketplaces);
    const entry = Object.hasOwn(entries, OFFICIAL) ? object(entries[OFFICIAL]) : undefined;
    const registered = entry === undefined ? undefined : string(entry.installLocation);
    // Historical installs can retain a seed path from a previous app location.
    // Package-managed content is read-only and does not need a network refresh.
    if (registered && (this.deps.seedDir && pathInside(resolve(registered), resolve(this.deps.seedDir))
      || /(?:^|[/\\])plugins-seed[/\\]marketplaces[/\\]claude-plugins-official[/\\]*$/.test(registered))) {
      return { ok: true, skipped: true, reason: 'seed-managed' };
    }
    const location = await this.cacheLocation(registered);
    for (const [name, value] of Object.entries(entries)) {
      if (name !== OFFICIAL && object(value).installLocation === location) throw new Error('Official marketplace cache is already occupied by ' + name);
    }
    let content: Content | undefined, fromMirror = true;
    try {
      try { content = await this.mirror(location, signal); }
      catch (error) {
        checkCancelled(signal); fromMirror = false;
        this.deps.diagnostic?.('Official marketplace mirror failed; attempting git: ' + errorMessage(error));
        const override = string(this.environment.KLAUS_PLUGIN_OFFICIAL_GIT_URL).trim();
        content = await this.clone(override ? { kind: 'git', value: gitUrl(override), descriptor: {} } : { kind: 'github', value: REPO, descriptor: {} }, signal);
      }
      if (await this.name(content.directory) !== OFFICIAL) throw new Error('Official marketplace has a mismatched name');
      const updated = this.entry({ source: 'github', repo: REPO }, location, fromMirror ? content.sha : undefined);
      if (content.directory === location) await this.write(snapshot, OFFICIAL, updated);
      else await replaceExtensionDirectory(this.configRoot, relative(this.configRoot, location), content.directory, signal, () => this.write(snapshot, OFFICIAL, updated));
      await this.changed(); return { ok: true, sha: content.sha! };
    } finally { await content?.cleanup(); }
  }
  updateCheck(): JsonObject {
    return { checking: this.refreshing !== undefined, ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}), ...(this.refreshError ? { error: this.refreshError } : {}) };
  }
  /** Checks only discover releases; they never install or enable a package. */
  startUpdateChecks(): void {
    if (this.closed || this.refreshTimer) return;
    const check = (): void => { void this.refresh({ ifStale: true }).catch(error => this.deps.diagnostic?.('Plugin update check failed: ' + errorMessage(error))); };
    check();
    this.refreshTimer = setInterval(check, this.deps.refreshIntervalMs ?? 30 * 60_000);
    this.refreshTimer.unref?.();
  }
  refresh(payload: JsonObject = {}): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('Plugin marketplace service is closed'));
    if (payload.ifStale !== undefined && typeof payload.ifStale !== 'boolean') return Promise.reject(new Error('ifStale must be a boolean'));
    if (this.refreshing) return this.refreshing;
    const now = this.deps.now?.() ?? Date.now();
    const maxAge = this.refreshError ? (this.deps.refreshRetryMs ?? 60_000) : (this.deps.refreshMaxAgeMs ?? 5 * 60_000);
    if (payload.ifStale === true && this.lastAttemptAt !== undefined && now - this.lastAttemptAt < maxAge && this.lastRefresh) {
      return Promise.resolve({ ...this.lastRefresh, cached: true, updateCheck: this.updateCheck() });
    }
    this.lastAttemptAt = now;
    const refresh = this.performRefresh().then(result => {
      const value = object(result), failures = [
        value.klausOfficial && object(value.klausOfficial).ok === false ? 'Klaus: ' + string(object(value.klausOfficial).error) : '',
        value.official && object(value.official).ok === false ? OFFICIAL + ': ' + string(object(value.official).error) : '',
      ].filter(Boolean);
      this.refreshError = failures.join('\n') || undefined;
      if (!this.refreshError) this.checkedAt = this.deps.now?.() ?? Date.now();
      this.lastRefresh = value;
      return { ...value, updateCheck: { ...this.updateCheck(), checking: false } };
    }).catch(error => {
      this.refreshError = errorMessage(error);
      this.lastRefresh = { ok: false, error: this.refreshError };
      throw error;
    }).finally(() => {
      this.refreshing = undefined;
      this.deps.onCheckChanged?.();
    });
    this.refreshing = refresh;
    this.deps.onCheckChanged?.();
    return refresh;
  }
  private performRefresh(): Promise<Json> {
    return this.run(async signal => {
      // Our own mirror first: the catalog read below must already include
      // whatever was just published to klaus-official.
      let klausOfficial: JsonObject | undefined;
      if (this.deps.klausOfficial) {
        try {
          const sha = await this.deps.klausOfficial.refresh(signal);
          klausOfficial = { ok: true, sha: sha ?? null };
        } catch (error) { klausOfficial = failed(error); }
        checkCancelled(signal);
        // A cached package can finish a legacy migration while discovery is offline.
        try { klausOfficial.migration = await this.deps.klausOfficial.migrateBundledRecords(signal); }
        catch (error) {
          if (klausOfficial.ok === true) klausOfficial = failed(error);
          else this.deps.diagnostic?.('Cached plugin migration unavailable: ' + errorMessage(error));
        }
        checkCancelled(signal);
      }
      let official: JsonObject;
      try {
        official = this.deps.shouldRefreshOfficial && !await this.deps.shouldRefreshOfficial()
          ? { ok: true, skipped: true, reason: 'no-installed-plugins' }
          : await this.refreshOfficial(signal);
      } catch (error) { official = failed(error); }
      checkCancelled(signal);
      const catalog = object(await this.deps.plugins.market());
      if (!Array.isArray(catalog.plugins) || !Array.isArray(catalog.marketplaces)) throw new Error('Invalid plugin catalog after refresh');
      return { ok: true, plugins: catalog.plugins.length, marketplaces: catalog.marketplaces, official, ...(klausOfficial ? { klausOfficial } : {}) };
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = undefined; }
    this.pending.abort(); await this.git.close(); await this.pending.close(); await this.mutations.close();
  }
}
