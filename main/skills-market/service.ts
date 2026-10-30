import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { Json } from '../ipc/contract';
import { decodeBinary } from '../ipc/binary';
import { IpcHandlerError } from '../ipc/registry';
import { checkCancelled } from '../services/download';
import { errorMessage, object, string, type JsonObject } from '../services/service-types';
import { withSettingsTransaction } from '../services/settings';
import { copyExtensionTree, downloadExtension, extractExtensionZip, fetchExtensionText, PendingAcquisitions, replaceExtensionDirectory, SavedExtensionError } from '../services/extensions/acquisition';
import { atomicDocument, directoryNames, managedPath, missing, optionalDocument } from '../services/extensions/file-store';
import { frontmatter, scalar } from '../services/extensions/frontmatter';
import type { SkillService } from '../services/extensions/skills';

export interface SkillMarketEndpoint { baseUrl: string; direct: boolean; token?: string }
export interface SkillMarketDeps {
  skills: SkillService;
  endpoint: () => SkillMarketEndpoint | undefined | Promise<SkillMarketEndpoint | undefined>;
  onChanged: () => void | Promise<void>;
  /** Test/ops override only: the shipped client has no bundled free catalog, the server hosts it. */
  marketDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
}
/**
 * Credential lookup belongs to the existing account owner; this helper never
 * reads a file. The market is public read-and-install, so a guest without any
 * stored credential still resolves the cloud endpoint — only the optional
 * bearer token is absent.
 */
export function resolveSkillMarketEndpoint(options: { serverUrl: string; token?: string; environment?: NodeJS.ProcessEnv }): SkillMarketEndpoint | undefined {
  const env = options.environment ?? process.env;
  const direct = string(env.KLAUS_MARKET_UPSTREAM_URL ?? env.KLAUS_MARKET_UPSTREAM_BASE_URL).trim().replace(/\/+$/, '');
  if (direct) return { baseUrl: direct, direct: true, ...(env.KLAUS_MARKET_UPSTREAM_TOKEN?.trim() ? { token: env.KLAUS_MARKET_UPSTREAM_TOKEN } : {}) };
  return { baseUrl: options.serverUrl.replace(/\/+$/, ''), direct: false, ...(options.token ? { token: options.token } : {}) };
}
const validName = (value: string): boolean => Boolean(
  value
  && [...value].length <= 128
  && value !== '.'
  && value !== '..'
  && !value.startsWith('.')
  && !/[\s/\\\x00-\x1f<>:"|?*]/u.test(value)
  && !/[. ]$/.test(value)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
);
const failed = (error: unknown, name?: string): JsonObject => ({ ok: false, ...(name === undefined ? {} : { name }), error: errorMessage(error),
  ...(error instanceof SavedExtensionError ? { installed: true, reloadRequired: true } : {}) });
const dependencies = (value: { missingBins: string[]; missingEnv: string[]; unsupported: boolean }): JsonObject => ({
  dependencyStatus: value.unsupported ? 'unsupported' : value.missingBins.length ? 'missing' : value.missingEnv.length ? 'config' : 'ready',
  missingBins: value.missingBins, missingEnv: value.missingEnv,
});

/** Acquires skill content, while the existing SkillService serializes every skill mutation. */
export class SkillMarketService {
  private readonly pending = new PendingAcquisitions();
  private readonly configRoot: string;
  constructor(private readonly deps: SkillMarketDeps) { this.configRoot = deps.skills.configRoot; }
  private mutate(operation: (signal: AbortSignal) => Promise<Json>): Promise<Json> {
    return this.pending.run(signal => this.deps.skills.withMutation(() => { checkCancelled(signal); return operation(signal); }));
  }
  // The free catalog moved to the server-hosted market; the shipped client has
  // no bundled copy to fall back to. Only an explicit absolute directory (test
  // fixtures, ops overrides) still feeds local items.
  private async localDirectory(): Promise<string | undefined> {
    const explicit = this.deps.marketDirectory ?? (this.deps.environment ?? process.env).KLAUS_SKILLS_MARKET_DIR;
    if (!explicit) return undefined;
    if (!isAbsolute(explicit)) throw new Error('The skills market directory must be absolute');
    return explicit;
  }
  private async installed(): Promise<string[]> {
    const root = await managedPath(this.configRoot, 'skills');
    const result: string[] = [];
    for (const name of await directoryNames(root)) {
      if (!validName(name)) continue;
      try { if ((await lstat(await managedPath(root, name))).isDirectory()) result.push(name); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return result;
  }
  private async versions(): Promise<Map<string, string>> {
    try {
      const raw = await optionalDocument(await managedPath(this.configRoot, 'skills/.install-records.json'));
      const rows = object(raw ? JSON.parse(raw) : {}).records;
      return new Map(Array.isArray(rows) ? rows.flatMap(value => { const item = object(value); return typeof item.slug === 'string' ? [[item.slug, string(item.version)] as const] : []; }) : []);
    } catch { return new Map(); }
  }
  private async localItems(installed: string[]): Promise<JsonObject[]> {
    const directory = await this.localDirectory(), result: JsonObject[] = [];
    if (!directory) return result;
    for (const name of await directoryNames(directory)) {
      if (!validName(name)) continue;
      try {
        const path = await managedPath(directory, name);
        if (!(await lstat(path)).isDirectory()) continue;
        const raw = await optionalDocument(await managedPath(path, 'SKILL.md'));
        let meta: JsonObject = {}, parseError: string | undefined;
        if (raw !== undefined) { const parsed = frontmatter(raw); meta = parsed.data; parseError = parsed.error; }
        else parseError = 'Skill catalog entry has no SKILL.md';
        const metadata = object(meta.metadata), nested = object(metadata.klaus ?? metadata.openclaw ?? metadata.clawdbot ?? metadata);
        result.push({ name: scalar(meta.name)?.trim() || name, description: scalar(meta.description)?.trim().split(/\s+/).join(' ') || '',
          source: 'market', userInvocable: true, userEnabled: false, installed: installed.includes(name), dirName: name,
          ...(parseError ? { dependencyStatus: 'invalid', missingBins: [], missingEnv: [], error: parseError } : dependencies(await this.deps.skills.missingDependencies(meta))),
          ...(typeof nested.emoji === 'string' ? { emoji: nested.emoji } : {}),
          ...(meta.tags != null ? { tags: meta.tags } : {}) });
      } catch {
        result.push({ name, description: '', source: 'market', userInvocable: false, userEnabled: false,
          installed: installed.includes(name), dirName: name, dependencyStatus: 'invalid', missingBins: [], missingEnv: [],
          error: 'Skill catalog entry could not be read' });
      }
    }
    return result;
  }
  private filterLocalItems(items: JsonObject[], query: unknown): JsonObject[] {
    const tokens = string(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return items;
    return items.filter(item => {
      const haystack = [item.name, item.description, item.dirName, item.tags].map(value => typeof value === 'string' ? value : JSON.stringify(value ?? '')).join(' ').toLocaleLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
  }
  private async remoteItem(item: JsonObject, installed: string[], versions: Map<string, string>): Promise<JsonObject> {
    const slug = string(item.slug), local = versions.get(slug), latest = object(item.latestVersion).version;
    let metadata: JsonObject = {}; if (typeof item.metadata === 'string') try { metadata = object(JSON.parse(item.metadata)); } catch { /* A missing declaration has no executable dependency to test. */ }
    const declared = object(metadata.klaus ?? metadata.openclaw ?? metadata.clawdbot ?? metadata)
    return { name: string(item.nameCn) || string(item.displayName) || slug, description: string(item.descriptionCn) || string(item.summary),
      source: 'market', userInvocable: true, userEnabled: false, installed: installed.includes(slug), dirName: slug, upstreamSlug: slug,
      hasUpdate: installed.includes(slug) && typeof latest === 'string' && Boolean(latest) && Boolean(local) && local !== latest,
      ...dependencies(await this.deps.skills.missingDependencies({ metadata })),
      ...(local === undefined ? {} : { version: local }), ...(typeof latest === 'string' ? { latestVersion: latest } : {}),
      // Server-side iconography: the catalog's own icon URL and the skill's
      // self-declared emoji travel with the listing so the client can brand
      // market rows without shipping per-skill assets in a release.
      ...(typeof item.icon === 'string' && item.icon.trim() ? { icon: item.icon.trim() } : {}),
      ...(typeof declared.emoji === 'string' && declared.emoji.trim() ? { emoji: declared.emoji.trim() } : {}),
      ...(item.tags && typeof item.tags === 'object' && !Array.isArray(item.tags) && Object.keys(item.tags).length ? { tags: item.tags } : {}) };
  }
  private url(endpoint: SkillMarketEndpoint, path: string): URL {
    return new URL(endpoint.baseUrl.replace(/\/+$/, '') + (endpoint.direct ? '/api/v1/' : '/api/market/') + path);
  }
  market(payload: JsonObject): Promise<Json> {
    return this.pending.run(async (signal): Promise<Json> => {
      const installed = await this.installed(), local = this.filterLocalItems(await this.localItems(installed), payload.query);
      try {
        const endpoint = await this.deps.endpoint(); checkCancelled(signal);
        if (!endpoint) return { items: local, nextCursor: null, isRemote: false };
        const url = this.url(endpoint, 'skills');
        if (typeof payload.query === 'string' && payload.query) url.searchParams.set('query', payload.query);
        url.searchParams.set('limit', String(Number.isSafeInteger(payload.limit) ? Math.max(1, Math.min(100, Number(payload.limit))) : 15));
        if (typeof payload.cursor === 'string' && payload.cursor) url.searchParams.set('cursor', payload.cursor);
        url.searchParams.set('nonSuspiciousOnly', 'true');
        const remote = object(JSON.parse(await fetchExtensionText(url.href, signal, { fetch: this.deps.fetch, token: endpoint.token, timeoutMs: this.deps.requestTimeoutMs })));
        if (!Array.isArray(remote.items)) throw new Error('Skill market response has no items array');
        const versions = await this.versions(), rows: JsonObject[] = [];
        for (const item of remote.items) {
          checkCancelled(signal);
          const row = object(item);
          if (!validName(string(row.slug))) continue;
          rows.push(await this.remoteItem(row, installed, versions));
        }
        const seen = new Set(rows.map(row => string(row.dirName)));
        return { items: [...rows, ...local.filter(row => !seen.has(string(row.dirName)))], nextCursor: remote.nextCursor ?? null, total: remote.total ?? null, isRemote: true };
      } catch (error) { checkCancelled(signal); return { items: local, nextCursor: null, isRemote: false, error: errorMessage(error) }; }
    });
  }
  private async staging(): Promise<string> {
    const root = await managedPath(this.configRoot, 'skills', true); await mkdir(root, { recursive: true, mode: 0o700 });
    return mkdtemp(join(root, '.staging-'));
  }
  private async record(name: string, version: string, source: string, enable: boolean): Promise<void> {
    const relative = 'skills/.install-records.json', path = await managedPath(this.configRoot, relative), old = await optionalDocument(path);
    const parsed = old === undefined ? { version: 1, records: [] } : object(JSON.parse(old));
    if (!Array.isArray(parsed.records)) throw new Error('Invalid skill install records');
    const next = { ...parsed, records: [...parsed.records.filter(value => object(value).slug !== name), { slug: name, version, source, installedAt: new Date().toISOString() }] };
    await atomicDocument(this.configRoot, relative, JSON.stringify(next, null, 2) + '\n');
    if (enable) {
      try {
        withSettingsTransaction(this.configRoot, db => {
          const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get('skill:' + name)?.value;
          let previous: JsonObject = {}; if (typeof raw === 'string') try { previous = object(JSON.parse(raw)); } catch { /* Replace a legacy preference. */ }
          db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('skill:' + name, JSON.stringify({ ...previous, enabled: true }));
        });
      } catch (error) {
        try { if (old === undefined) await rm(path); else await atomicDocument(this.configRoot, relative, old); }
        catch (restoreError) { throw new AggregateError([error, restoreError], 'Skill preference write failed and install records could not be restored'); }
        throw error;
      }
    }
  }
  private async changed(): Promise<void> {
    try { await this.deps.onChanged(); }
    catch (error) { throw new SavedExtensionError('Skill was saved, but reloading live sessions failed: ' + errorMessage(error)); }
  }
  private async installArchive(name: string, version: string, url: string, signal: AbortSignal, endpoint?: SkillMarketEndpoint, recordSource = 'upstream'): Promise<JsonObject> {
    const stage = await this.staging();
    try {
      const archive = join(stage, 'skill.zip'), extracted = join(stage, 'content'); await mkdir(extracted, { mode: 0o700 });
      await downloadExtension(url, archive, signal, { fetch: this.deps.fetch, token: endpoint?.token, timeoutMs: this.deps.downloadTimeoutMs });
      await extractExtensionZip(archive, extracted, signal);
      let root = extracted;
      if (await optionalDocument(join(root, 'SKILL.md')) === undefined) {
        const entries = await readdir(root, { withFileTypes: true });
        if (entries.length === 1 && entries[0]!.isDirectory()) root = join(root, entries[0]!.name);
      }
      const document = await optionalDocument(await managedPath(root, 'SKILL.md'));
      if (document === undefined) throw new Error('Downloaded skill archive has no SKILL.md');
      const parsed = frontmatter(document);
      if (parsed.error) throw new Error('Invalid SKILL.md frontmatter: ' + parsed.error);
      const meta = parsed.data;
      const deps = await this.deps.skills.missingDependencies(meta);
      if (deps.unsupported) throw new Error('This skill is not supported on this operating system');
      await replaceExtensionDirectory(this.configRoot, 'skills/' + name, root, signal, () => this.record(name, version, recordSource, Boolean(endpoint)));
      await this.changed();
      return { ok: true, name, missingBins: deps.missingBins, missingEnv: deps.missingEnv };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  private async remoteInstall(name: string, version: string, endpoint: SkillMarketEndpoint, signal: AbortSignal): Promise<JsonObject> {
    const url = this.url(endpoint, 'download'); url.searchParams.set('slug', name); if (version) url.searchParams.set('version', version);
    return this.installArchive(name, version || 'latest', url.href, signal, endpoint);
  }
  private async localInstall(payload: JsonObject, name: string, signal: AbortSignal): Promise<JsonObject> {
    const directory = await this.localDirectory(); if (!directory) return failed('Skill not found', name);
    const source = await managedPath(directory, name), raw = await optionalDocument(await managedPath(source, 'SKILL.md'));
    if (raw === undefined) return failed('Skill not found', name);
    const parsed = frontmatter(raw);
    if (parsed.error) return failed('Invalid SKILL.md frontmatter: ' + parsed.error, name);
    const deps = await this.deps.skills.missingDependencies(parsed.data);
    if (deps.unsupported) return failed('This skill is not supported on this operating system', name);
    if (deps.missingBins.length && payload.installMissing !== true && payload.skipDependencyInstall !== true) return { ok: false, name, needsDependencyInstall: true,
      canAutoInstall: false, missingBins: deps.missingBins, missingEnv: deps.missingEnv, installCommands: [], error: 'Missing dependencies: ' + deps.missingBins.join(', ') };
    const stage = await this.staging();
    try {
      const copy = join(stage, 'content'); await copyExtensionTree(source, copy, signal);
      await replaceExtensionDirectory(this.configRoot, 'skills/' + name, copy, signal, () => this.record(name, '', 'local', true));
      await this.changed();
      return { ok: true, name, missingBins: deps.missingBins, missingEnv: deps.missingEnv, installedDependencies: [], dependencyWarnings: [] };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  install(payload: JsonObject): Promise<Json> {
    return this.mutate(async signal => {
      const name = string(payload.name); if (!validName(name)) return failed('Invalid skill name', typeof payload.name === 'string' ? name : undefined);
      let remoteError: unknown;
      try {
        const endpoint = await this.deps.endpoint(); checkCancelled(signal);
        if (endpoint) try { return await this.remoteInstall(name, string(payload.version), endpoint, signal); }
        catch (error) { checkCancelled(signal); if (error instanceof SavedExtensionError) return failed(error, name); remoteError = error; }
        const local = await this.localInstall(payload, name, signal);
        return local.ok === false && local.error === 'Skill not found' && remoteError !== undefined ? failed('Remote install failed: ' + errorMessage(remoteError), name) : local;
      } catch (error) { return failed(error, name); }
    });
  }
  update(payload: JsonObject): Promise<Json> {
    return this.mutate(async signal => {
      const name = string(payload.slug); if (!name) return failed('slug required'); if (!validName(name)) return failed('Invalid skill name', name);
      try {
        const endpoint = await this.deps.endpoint(); checkCancelled(signal);
        if (!endpoint) return failed('skill market is not configured (no desktop token / upstream URL)', name);
        return await this.remoteInstall(name, string(payload.version), endpoint, signal);
      } catch (error) { return failed(error, name); }
    });
  }
  installFromSource(payload: JsonObject): Promise<Json> {
    return this.mutate(async signal => {
      const spec = string(payload.spec).trim(); if (!spec) return failed('spec required');
      if (string(payload.ref).trim() || string(payload.subpath).trim()) return failed('Branch, tag and subpath options are not supported for direct ZIP sources');
      let sourceUrl: URL;
      try { sourceUrl = new URL(spec); } catch { return failed('Only direct HTTP(S) .zip skill sources are supported'); }
      if (!/^https?:$/.test(sourceUrl.protocol) || !/\.zip$/i.test(sourceUrl.pathname)) return failed('Only direct HTTP(S) .zip skill sources are supported');
      let inferred = sourceUrl.pathname.slice(sourceUrl.pathname.lastIndexOf('/') + 1).replace(/\.zip$/i, '');
      try { inferred = decodeURIComponent(inferred); } catch { return failed('Invalid skill source URL'); }
      inferred = inferred.trim().replace(/\s+/gu, '-');
      const name = typeof payload.name === 'string' ? payload.name : inferred;
      if (!validName(name)) return failed('Invalid skill name', name);
      try {
        const target = await managedPath(this.configRoot, 'skills/' + name);
        try {
          await lstat(target);
          if (payload.force !== true) return failed('Skill is already installed; enable overwrite to replace it', name);
        } catch (error) { if (!missing(error)) throw error; }
        return await this.installArchive(name, 'source', sourceUrl.href, signal, undefined, 'source');
      }
      catch (error) { return failed(error, name); }
    });
  }
  upload(payload: JsonObject): Promise<Json> {
    if (typeof payload.name !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'name required');
    return this.mutate(async signal => {
      const name = string(payload.name), stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
      const slug = stem.trim().replace(/\s+/gu, '-');
      if (!validName(slug) || basename(name) !== name || /[\\\x00-\x1f<>:"|?*]/u.test(name) || /[. ]$/.test(name)) return failed('invalid name');
      const lowerName = name.toLowerCase();
      if (!lowerName.endsWith('.md') && !lowerName.endsWith('.zip')) return failed('Only ZIP archives and Markdown skill documents are supported', slug);
      const bytes = typeof payload.buffer === 'string' ? Buffer.from(payload.buffer, 'utf8') : decodeBinary(payload.buffer, 64 * 1024 ** 2);
      if (!bytes || bytes.byteLength > 64 * 1024 ** 2) return failed('invalid buffer');
      const target = await managedPath(this.configRoot, 'skills/' + slug);
      try {
        await lstat(target);
        if (payload.force !== true) return { ok: false, name: slug, needsOverwrite: true, error: 'Skill is already installed' };
      } catch (error) { if (!missing(error)) return failed(error, slug); }
      const stage = await this.staging();
      try {
        let source: string;
        if (lowerName.endsWith('.zip')) {
          const archive = join(stage, 'skill.zip'), extracted = join(stage, 'content');
          await mkdir(extracted, { mode: 0o700 }); await writeFile(archive, bytes, { mode: 0o600 });
          await extractExtensionZip(archive, extracted, signal); source = extracted;
          if (await optionalDocument(join(source, 'SKILL.md')) === undefined) {
            const entries = await readdir(source, { withFileTypes: true });
            if (entries.length === 1 && entries[0]!.isDirectory()) source = join(source, entries[0]!.name);
          }
        } else {
          source = join(stage, 'content');
          try { await lstat(target); await copyExtensionTree(target, source, signal); }
          catch (error) { if (!missing(error)) throw error; await mkdir(source, { mode: 0o700 }); }
          await writeFile(await managedPath(source, 'SKILL.md', true), bytes, { mode: 0o600 });
        }
        const document = await optionalDocument(await managedPath(source, 'SKILL.md'));
        if (document === undefined) throw new Error('Uploaded skill has no SKILL.md');
        const parsed = frontmatter(document);
        if (parsed.error) throw new Error('Invalid SKILL.md frontmatter: ' + parsed.error);
        const meta = parsed.data, deps = await this.deps.skills.missingDependencies(meta);
        if (deps.unsupported) throw new Error('This skill is not supported on this operating system');
        await replaceExtensionDirectory(this.configRoot, 'skills/' + slug, source, signal, () => this.record(slug, '', 'upload', false));
        await this.changed(); return { ok: true, name: slug, missingBins: deps.missingBins, missingEnv: deps.missingEnv };
      } catch (error) { return failed(error, slug); }
      finally { await rm(stage, { recursive: true, force: true }); }
    });
  }
  close(): Promise<void> { return this.pending.close(); }
}
