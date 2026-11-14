import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { Json } from '../../ipc/contract';
import { checkCancelled, fileHash } from '../download';
import { errorMessage, object, string, type JsonObject, type EngineRequest } from '../service-types';
import { downloadExtension, extractExtensionZip, fetchExtensionText, PendingAcquisitions, replaceExtensionDirectory, SavedExtensionError } from './acquisition';
import { atomicDocument, managedPath, optionalDocument } from './file-store';
import type { SkillMarketEndpoint } from '../../skills-market/service';
import { pluginIconDataUrl } from './plugin-icons';

export const OFFICIAL_MARKETPLACE = 'klaus-official';
export type OfficialPackageStage = 'downloading' | 'verifying' | 'extracting';
export type OfficialPackageProgress = { stage: OfficialPackageStage; transferred: number; total: number };

/** Where the catalog scanner looks for the marketplace manifest. */
const MANIFEST_RELATIVE = '.claude-plugin/marketplace.json';
/**
 * Per-plugin download bookkeeping, kept OUTSIDE the marketplace directory.
 *
 * The engine copies a plugin's directory into its own install store when it
 * installs one, so anything written inside `plugins/<name>/` would be carried
 * into that store and become part of what the user has installed.
 */
const DOWNLOAD_STATE_RELATIVE = '.official-downloads.json';
// The catalog can include artwork; leave room above its 4 MiB transport limit
// for mirrored metadata and download bookkeeping without widening other files.
const CATALOG_CACHE_LIMIT = 8 * 1024 * 1024;

/** One published plugin, as named by the server's per-plugin catalog. */
interface OfficialPluginItem {
  name: string;
  version: string;
  packageFile: string;
  sha256: string;
  platformPackages?: Record<string, { packageFile: string; sha256: string }>;
  description?: string;
  category?: string;
  author?: { name?: string };
  iconDataUrl?: string;
  readme?: string;
  releaseNotes?: string;
  homepage?: string;
  compatibility?: string;
}
interface OfficialPluginCatalog { revision: string; items: OfficialPluginItem[] }

export interface OfficialPluginsDeps {
  configRoot: string;
  request: EngineRequest;
  endpoint: () => SkillMarketEndpoint | undefined | Promise<SkillMarketEndpoint | undefined>;
  onChanged: () => void | Promise<void>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  diagnostic?: (message: string) => void;
}

/**
 * Mirrors our own plugin marketplace from the market server into the profile
 * marketplace cache, the same shape as the third-party official mirror:
 * `plugins/latest` names the revision, `plugins/<sha>.zip` carries the tree.
 * On first reach it asks the engine to retire a legacy bundled Diagram
 * record in favor of an engine-owned copy of the official package.
 */
export class OfficialPluginsService {
  private readonly pending = new PendingAcquisitions();
  constructor(private readonly deps: OfficialPluginsDeps) {}
  private async snapshot(): Promise<{ values: JsonObject; version: string }> {
    const reply = object(await this.deps.request('config/read', {}));
    if (reply.error != null) throw reply.error;
    if (!reply.values || typeof reply.values !== 'object' || Array.isArray(reply.values) || typeof reply.version !== 'string') throw new Error('Invalid engine plugin config snapshot');
    return { values: object(reply.values), version: string(reply.version) };
  }
  private async write(snapshot: { values: JsonObject; version: string }, edits: Array<{ keyPath: string; value?: Json; mergeStrategy: string }>): Promise<void> {
    const reply = object(await this.deps.request('config/batchWrite', { edits, expectedVersion: snapshot.version }));
    if (reply.error != null) throw reply.error;
    if (!reply.values || typeof reply.values !== 'object') throw new Error('Engine did not confirm the plugin config write');
  }
  private async cacheLocation(): Promise<string> {
    const root = await managedPath(this.deps.configRoot, 'plugins/marketplaces', true);
    return managedPath(root, OFFICIAL_MARKETPLACE, true);
  }
  private async stage(): Promise<string> {
    const base = await managedPath(this.deps.configRoot, 'plugins/staging', true); await mkdir(base, { recursive: true, mode: 0o700 });
    return mkdtemp(join(base, 'official-'));
  }
  /** Which catalog revision is mirrored, and which plugin hashes are on disk. */
  private async readCatalogState(): Promise<{ revision: string; items: OfficialPluginItem[]; downloaded: Record<string, string> } | undefined> {
    const raw = await optionalDocument(await managedPath(this.deps.configRoot, join('plugins/marketplaces', DOWNLOAD_STATE_RELATIVE)), CATALOG_CACHE_LIMIT);
    if (raw === undefined) return undefined;
    try {
      const parsed = object(JSON.parse(raw));
      const revision = string(parsed.revision), items = parsed.items, downloaded = parsed.downloaded;
      if (!/^[a-f0-9]{64}$/.test(revision) || !Array.isArray(items)) return undefined;
      const map: Record<string, string> = {};
      if (downloaded && typeof downloaded === 'object' && !Array.isArray(downloaded)) {
        for (const [name, hash] of Object.entries(object(downloaded))) if (typeof hash === 'string') map[name] = hash;
      }
      return { revision, items: items.map(value => object(value)) as unknown as OfficialPluginItem[], downloaded: map };
    } catch (error) {
      // A garbled ledger costs at most one re-download, so it is not fatal.
      this.deps.diagnostic?.('Official plugin download ledger unreadable: ' + errorMessage(error));
      return undefined;
    }
  }
  private async writeCatalogState(state: { revision: string; items: OfficialPluginItem[]; downloaded: Record<string, string> }): Promise<void> {
    await atomicDocument(this.deps.configRoot, join('plugins/marketplaces', DOWNLOAD_STATE_RELATIVE), JSON.stringify(state), false, CATALOG_CACHE_LIMIT);
  }

  /**
   * Make one plugin's package present on disk, downloading it only if needed.
   *
   * The server's catalog is the authority on which file and hash belong to a
   * plugin: the caller names a plugin, this resolves it against the catalog that
   * is currently mirrored, and the bytes that arrive must hash to the catalog's
   * sha256 or they are discarded. A package already on disk at that hash is left
   * alone, so installing twice does not re-download.
   */
  async ensureDownloaded(name: string, signal: AbortSignal, onProgress?: (progress: OfficialPackageProgress) => void): Promise<boolean> {
    return this.pending.run(async ownedSignal => {
      const requestSignal = AbortSignal.any([signal, ownedSignal]);
      checkCancelled(requestSignal);
      const state = await this.readCatalogState();
      if (!state) return false;
      const item = state.items.find(candidate => candidate.name === name);
      if (!item) return false;
      // A platform package, when the catalog offers one for this machine, replaces
      // both the download URL and the hash the bytes must match.
      const platformPick = item.platformPackages?.[`${process.platform}-${process.arch}`];
      const packageFile = platformPick?.packageFile ?? item.packageFile;
      const expectedSha = platformPick?.sha256 ?? item.sha256;
      const location = await this.cacheLocation();
      const target = await managedPath(location, join('plugins', name), true);
      if (state.downloaded[name] === expectedSha && await optionalDocument(await managedPath(target, 'plugin.json'))) return true;

      const endpoint = await this.deps.endpoint(); checkCancelled(requestSignal);
      if (!endpoint) return false;
      const base = endpoint.baseUrl.replace(/\/+$/, '') + (endpoint.direct ? '/api/v1' : '/api/market') + '/plugins/';
      const downloadsDir = await managedPath(this.deps.configRoot, 'plugins/downloads', true);
      await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
      const archive = await managedPath(downloadsDir, `${name}-${expectedSha}.zip`, true);
      const temporary = await this.stage(), directory = join(temporary, 'content'); await mkdir(directory, { mode: 0o700 });
      let totalBytes = 0;
      try {
        await downloadExtension(base + packageFile, archive, requestSignal, {
          fetch: this.deps.fetch,
          token: endpoint.token,
          maxBytes: 512 * 1024 ** 2,
          onProgress: ({ receivedBytes, totalBytes: declared }) => {
            totalBytes = declared || receivedBytes;
            onProgress?.({ stage: 'downloading', transferred: receivedBytes, total: declared });
          },
        });
        onProgress?.({ stage: 'verifying', transferred: totalBytes, total: totalBytes });
        const hash = await fileHash(archive, requestSignal);
        // The catalog named the hash this package must have; bytes that do not
        // match are discarded rather than installed, so a truncated or swapped
        // download cannot become a plugin the manifest vouches for.
        if (hash !== expectedSha) {
          await rm(archive, { force: true });
          throw new SavedExtensionError(`Official plugin package does not match its catalog hash: ${name}`);
        }
        onProgress?.({ stage: 'extracting', transferred: totalBytes, total: totalBytes });
        // The package is rooted at the plugin's own directory, so it extracts
        // straight into `plugins/<name>/` with no prefix to strip.
        await extractExtensionZip(archive, directory, requestSignal, '');
        if (!(await optionalDocument(await managedPath(directory, 'plugin.json')))) throw new Error('Official plugin package has no plugin.json at its root: ' + name);
        checkCancelled(requestSignal);
        // In place, not `replaceExtensionDirectory`: only this plugin's own
        // directory is touched, so the manifest and every other plugin's
        // downloaded package survive.
        await rm(target, { recursive: true, force: true });
        await mkdir(dirname(target), { recursive: true });
        await rename(directory, target);
        await this.writeCatalogState({ ...state, downloaded: { ...state.downloaded, [name]: expectedSha } });
        await rm(archive, { force: true });
        return true;
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }
  /** Pull the official marketplace into the cache; returns the revision or undefined when the server publishes none. */
  refresh(signal: AbortSignal): Promise<string | undefined> {
    return this.pending.run(async ownedSignal => {
      const requestSignal = AbortSignal.any([signal, ownedSignal]);
      checkCancelled(requestSignal);
      const endpoint = await this.deps.endpoint(); checkCancelled(requestSignal);
      if (!endpoint) return undefined;
      const base = endpoint.baseUrl.replace(/\/+$/, '') + (endpoint.direct ? '/api/v1' : '/api/market') + '/plugins/';
      // The per-plugin catalog is the current shape; the aggregate archive is the
      // fallback for a server that does not publish one yet.
      const catalog = await this.fetchCatalog(base, requestSignal, endpoint);
      if (catalog) return this.refreshFromCatalog(base, catalog, requestSignal, endpoint);
      return this.refreshFromAggregate(base, requestSignal, endpoint);
    });
  }

  /**
   * Fetch the per-plugin catalog, or undefined when the server publishes none.
   *
   * Every field used later to build a URL or a path is validated here, so a
   * hostile or truncated catalog cannot turn into a path escape downstream.
   */
  private async fetchCatalog(base: string, signal: AbortSignal, endpoint: NonNullable<SkillMarketEndpoint>): Promise<OfficialPluginCatalog | undefined> {
    let raw: string;
    try {
      raw = await fetchExtensionText(base + 'catalog', signal, { fetch: this.deps.fetch, token: endpoint.token, timeoutMs: this.deps.requestTimeoutMs ?? 10_000, maxBytes: 4 * 1024 * 1024 });
    } catch (error) {
      if (errorMessage(error).includes('HTTP 404')) return undefined;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Official plugin catalog is not an object');
    const document = object(parsed);
    const revision = string(document.revision);
    if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Official plugin catalog returned an invalid revision');
    if (!Array.isArray(document.items)) throw new Error('Official plugin catalog has no items array');
    const items: OfficialPluginItem[] = [];
    for (const value of document.items as unknown[]) {
      const item = object(value);
      const name = string(item.name), version = string(item.version), sha256 = string(item.sha256), packageFile = string(item.packageFile);
      // The name becomes a directory and the packageFile becomes a URL path
      // segment, so both are pinned to one exact shape rather than merely
      // screened for traversal.
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('Official plugin catalog has an invalid plugin name: ' + name);
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Official plugin catalog has an invalid package hash for ' + name);
      if (packageFile !== `packages/${name}-${sha256}.zip`) throw new Error('Official plugin catalog package file does not match its name and hash: ' + name);
      // Platform packages carry bundled native payloads (the pinned rendering
      // browser) for one platform each; every entry is pinned to the same exact
      // filename shape as the neutral package.
      let platformPackages: OfficialPluginItem['platformPackages'];
      if (item.platformPackages !== undefined) {
        const rawPlatforms = object(item.platformPackages);
        const platformKeys = Object.keys(rawPlatforms);
        if (platformKeys.length > 8) throw new Error('Official plugin catalog lists too many platform packages for ' + name);
        platformPackages = {};
        for (const key of platformKeys) {
          if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(key)) throw new Error(`Official plugin catalog has an invalid platform key for ${name}: ${key}`);
          const entry = object(rawPlatforms[key]);
          const platformSha = string(entry.sha256);
          if (!/^[a-f0-9]{64}$/.test(platformSha)) throw new Error('Official plugin catalog has an invalid platform package hash for ' + name);
          const platformFile = string(entry.packageFile);
          if (platformFile !== `packages/${name}-${platformSha}.zip`) throw new Error('Official plugin catalog platform package file does not match its name and hash: ' + name);
          platformPackages[key] = { packageFile: platformFile, sha256: platformSha };
        }
      }
      items.push({
        name, version, packageFile, sha256,
        ...(platformPackages ? { platformPackages } : {}),
        description: typeof item.description === 'string' ? item.description : undefined,
        category: typeof item.category === 'string' ? item.category : undefined,
        author: item.author && typeof item.author === 'object' && !Array.isArray(item.author)
          ? { name: typeof object(item.author).name === 'string' ? string(object(item.author).name) : undefined }
          : undefined,
        iconDataUrl: pluginIconDataUrl(item.iconDataUrl),
        ...Object.fromEntries(['readme', 'releaseNotes', 'homepage', 'compatibility'].flatMap(field =>
          typeof item[field] === 'string' && item[field].length <= 64 * 1024 ? [[field, item[field]]] : [])),
      });
    }
    if (!items.length) throw new Error('Official plugin catalog published no plugins');
    return { revision, items };
  }

  /**
   * Mirror the catalog into the cache without downloading any plugin.
   *
   * The marketplace manifest is written in place, deliberately not through
   * `replaceExtensionDirectory`: that swaps the whole directory, which would
   * delete every plugin package already downloaded on demand. Nothing here
   * removes content, so a partially populated cache stays usable.
   */
  private async refreshFromCatalog(base: string, catalog: OfficialPluginCatalog, signal: AbortSignal, endpoint: NonNullable<SkillMarketEndpoint>): Promise<string> {
    const location = await this.cacheLocation();
    const state = await this.readCatalogState();

    // Entries mirror what the server's marketplace.json carried, so the catalog
    // scanner downstream sees the same shape it always has. Only plugins the
    // server names are listed; their directories appear when downloaded.
    const manifest = {
      name: OFFICIAL_MARKETPLACE,
      plugins: catalog.items.map(item => ({
        name: item.name,
        description: item.description ?? '',
        version: item.version,
        author: { name: item.author?.name ?? 'Klaus' },
        category: item.category ?? 'other',
        source: './plugins/' + item.name,
        ...(item.iconDataUrl ? { iconDataUrl: item.iconDataUrl } : {}),
        ...Object.fromEntries(['readme', 'releaseNotes', 'homepage', 'compatibility'].flatMap(field =>
          typeof item[field as keyof OfficialPluginItem] === 'string' ? [[field, item[field as keyof OfficialPluginItem]]] : [])),
      })),
    };
    const manifestText = JSON.stringify(manifest, null, 2) + '\n';
    if (state?.revision === catalog.revision && await optionalDocument(await managedPath(location, MANIFEST_RELATIVE), CATALOG_CACHE_LIMIT) === manifestText) return catalog.revision;
    await atomicDocument(location, MANIFEST_RELATIVE, manifestText, false, CATALOG_CACHE_LIMIT);
    checkCancelled(signal);

    const snapshot = await this.snapshot(); checkCancelled(signal);
    const entries = object(snapshot.values.marketplaces), existing = object(entries[OFFICIAL_MARKETPLACE]);
    const entry: JsonObject = { source: { source: 'klaus-official' }, installLocation: location, lastUpdated: new Date().toISOString(), autoUpdate: false, officialRevision: catalog.revision };
    const edits = [{ keyPath: 'marketplaces.' + JSON.stringify(OFFICIAL_MARKETPLACE), value: entry, mergeStrategy: 'replace' }];
    for (const [name, value] of Object.entries(entries)) if (name !== OFFICIAL_MARKETPLACE && string(object(value).installLocation) === location) throw new Error('Official plugin cache is already occupied by ' + name);
    if (existing.installLocation !== undefined && string(existing.installLocation) !== location) throw new Error('Official marketplace is registered at another location: ' + string(existing.installLocation));
    await this.write(snapshot, edits);
    await this.writeCatalogState({ revision: catalog.revision, items: catalog.items, downloaded: state?.downloaded ?? {} });
    return catalog.revision;
  }

  /** The legacy whole-market archive path, kept for a server that publishes no catalog. */
  private async refreshFromAggregate(base: string, requestSignal: AbortSignal, endpoint: NonNullable<SkillMarketEndpoint>): Promise<string | undefined> {
    let latest: string;
    try {
      latest = (await fetchExtensionText(base + 'latest', requestSignal, { fetch: this.deps.fetch, token: endpoint.token, timeoutMs: this.deps.requestTimeoutMs ?? 10_000, maxBytes: 256 })).trim();
    } catch (error) {
      // No official plugins published (404) is a normal deployment state.
      if (errorMessage(error).includes('HTTP 404')) return undefined;
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(latest)) throw new Error('Official plugin marketplace returned an invalid revision');
    const location = await this.cacheLocation();
    const sentinel = await optionalDocument(await managedPath(location, '.official-sha'));
    if (sentinel?.trim() === latest) return latest;
    const temporary = await this.stage(), directory = join(temporary, 'content'); await mkdir(directory, { mode: 0o700 });
    try {
      const archive = join(temporary, 'official.zip');
      await downloadExtension(base + latest + '.zip', archive, requestSignal, { fetch: this.deps.fetch, token: endpoint.token });
      // The archive carries the marketplace cache prefix; strip it so the
      // mirror lands as the marketplace directory itself.
      await extractExtensionZip(archive, directory, requestSignal, 'marketplaces/' + OFFICIAL_MARKETPLACE + '/');
      await writeFile(join(directory, '.official-sha'), latest, { mode: 0o600 });
      const snapshot = await this.snapshot(); checkCancelled(requestSignal);
      const entries = object(snapshot.values.marketplaces), existing = object(entries[OFFICIAL_MARKETPLACE]);
      const entry: JsonObject = { source: { source: 'klaus-official' }, installLocation: location, lastUpdated: new Date().toISOString(), autoUpdate: false, officialSha: latest };
      const edits = [{ keyPath: 'marketplaces.' + JSON.stringify(OFFICIAL_MARKETPLACE), value: entry, mergeStrategy: 'replace' }];
      // A different marketplace squatting the cache path would make our
      // write lie about what is installed there.
      for (const [name, value] of Object.entries(entries)) if (name !== OFFICIAL_MARKETPLACE && string(object(value).installLocation) === location) throw new Error('Official plugin cache is already occupied by ' + name);
      if (existing.installLocation !== undefined && string(existing.installLocation) !== location) throw new Error('Official marketplace is registered at another location: ' + string(existing.installLocation));
      await replaceExtensionDirectory(this.deps.configRoot, relative(this.deps.configRoot, location), directory, requestSignal, () => this.write(snapshot, edits));
      return latest;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  /** Retire bundled-plugin ledger records in favour of the mirrored official copy, keeping enablement. */
  migrateBundledRecords(signal: AbortSignal): Promise<Json> {
    return this.pending.run(async ownedSignal => {
      const requestSignal = AbortSignal.any([signal, ownedSignal]);
      checkCancelled(requestSignal);
      checkCancelled(requestSignal);
      const ledgerReply = object(await this.deps.request('session/installedPlugins', {}));
      if (ledgerReply.error != null) throw ledgerReply.error;
      const ledger = object(ledgerReply.installedPlugins ?? ledgerReply);
      const builtin = object(object(ledger.plugins)['digram@builtin']);
      if (string(builtin.source) !== 'builtin') return { ok: true, migrated: [] };
      const sourceDir = join(await this.cacheLocation(), 'plugins', 'digram');
      if (!(await optionalDocument(await managedPath(sourceDir, 'plugin.json')))) {
        throw new Error('Official Diagram package is missing its manifest');
      }
      const reply = object(await this.deps.request('session/migrateBundledDiagram', { sourceDir }));
      if (reply.error != null) throw reply.error;
      if (typeof reply.migrated !== 'boolean') throw new Error('Engine did not confirm Diagram migration');
      checkCancelled(requestSignal);
      if (!reply.migrated) return { ok: true, migrated: [] };
      try { await this.deps.onChanged(); }
      catch (error) { throw new SavedExtensionError('Official plugin records were written, but reloading live sessions failed: ' + errorMessage(error)); }
      return { ok: true, migrated: ['digram'] };
    });
  }
  /** Background startup pass: use a cached package for migration even if the server is offline. */
  async initialize(): Promise<void> {
    const controller = new AbortController();
    try {
      await this.refresh(controller.signal);
    } catch (error) {
      this.deps.diagnostic?.('Official plugin marketplace unavailable: ' + errorMessage(error));
    }
    try {
      const sourceDir = join(await this.cacheLocation(), 'plugins', 'digram');
      if (!(await optionalDocument(await managedPath(sourceDir, 'plugin.json')))) return;
      await this.migrateBundledRecords(controller.signal);
    } catch (error) {
      this.deps.diagnostic?.('Official Diagram migration failed: ' + errorMessage(error));
    }
  }
  async close(): Promise<void> { this.pending.abort(); await this.pending.close(); }
}
