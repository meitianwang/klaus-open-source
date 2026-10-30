import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { gt, valid } from 'semver';
import { IpcHandlerError } from '../../ipc/registry';
import { errorMessage, object, string, type EngineRequest, type JsonObject } from '../service-types';
import { pathInside } from '../workspaces';
import { directoryNames, managedPath, missing, optionalDocument } from './file-store';
import { pluginIconDataUrl, readPluginIcon } from './plugin-icons';

export interface PluginCatalogDeps { request: EngineRequest; seedDir?: string; diagnostic?: (message: string) => void }
export interface Marketplace { name: string; installLocation: string | null; lastUpdated: string | null; seeded: boolean; entries: JsonObject[] }
export interface PluginCatalogSnapshot { installed: JsonObject; marketplaces: Marketplace[]; rows: JsonObject[] }
export interface CatalogRoot { marketplace: string; dir: string }

/** Unknown revisions cannot safely be ordered as releases. Build metadata is ignored by SemVer. */
export function newerPluginVersion(available: string, installed: string): boolean {
  return Boolean(valid(available) && valid(installed) && gt(available, installed));
}

export async function localPluginSource(location: string, source: string): Promise<string> {
  if (source && !source.includes('\0') && !isAbsolute(source) && resolve(location, source) === resolve(location)) return resolve(location);
  return managedPath(location, source);
}

export async function pluginManifest(dir: string): Promise<JsonObject | undefined> {
  for (const path of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']) {
    const raw = await optionalDocument(await managedPath(dir, path));
    if (raw !== undefined) {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin manifest must be an object');
      return object(value);
    }
  }
  return undefined;
}
export function pluginBrand(value: string): string {
  return value.replace(/\bClaude Code\b/gi, 'Klaus').replace(/\bClaude-Code\b/gi, 'Klaus').replace(/\bclaude-code\b/g, 'klaus')
    .replace(/\bClaude\b/g, 'Klaus').replace(/\bclaude\b/g, 'klaus').replace(/\bCLAUDE\b/g, 'KLAUS').replace(/\bAnthropic\b/gi, 'Klaus');
}
function category(value: unknown): string {
  const name = string(value).trim().toLowerCase(); if (['development', 'dev'].includes(name)) return 'dev';
  return ['productivity', 'database', 'monitoring', 'security', 'design'].includes(name) ? name : 'other';
}
function detailMetadata(entry: JsonObject): JsonObject {
  const result: JsonObject = {};
  for (const field of ['readme', 'releaseNotes', 'homepage', 'compatibility']) {
    if (typeof entry[field] === 'string' && entry[field].length <= 64 * 1024) result[field] = entry[field];
  }
  return result;
}
function row(entry: JsonObject, marketplace: string, installed: JsonObject): JsonObject {
  const id = string(entry.name) + '@' + marketplace, record = installed[id], commands: string[] = [], extensions: string[] = [];
  for (const value of Object.values(object(entry.lspServers))) {
    const server = object(value), command = string(server.command); if (command && !commands.includes(command)) commands.push(command);
    for (const extension of Object.keys(object(server.extensionToLanguage))) if (!extensions.includes(extension)) extensions.push(extension);
  }
  const badges: string[] = [];
  for (const [field, badge] of [['mcpServers', 'MCP'], ['commands', 'Commands'], ['skills', 'Skills'], ['agents', 'Agents'], ['hooks', 'Hooks'], ['outputStyles', 'Output']]) {
    if (entry[field!] != null) badges.push(badge!);
  }
  if (commands.length) badges.push('LSP');
  if (!badges.length && typeof entry.category === 'string') badges.push(entry.category);
  const author = pluginBrand(string(object(entry.author).name));
  const installedVersion = string(object(record).version), availableVersion = string(entry.version);
  return { id, name: pluginBrand(string(entry.name)).replace(/\bKlaus\b/g, 'klaus').replace(/\bKLAUS\b/g, 'klaus'),
    description: pluginBrand(string(entry.description)), category: commands.length ? 'lsp' : category(entry.category),
    installed: record !== undefined, enabled: record === undefined ? false : object(record).enabled !== false,
    hasLsp: commands.length > 0, lspCommands: commands, lspExtensions: extensions, badges: badges.slice(0, 4),
    ...(author ? { author } : {}), ...detailMetadata(entry),
    ...(pluginIconDataUrl(entry.iconDataUrl) ? { iconDataUrl: entry.iconDataUrl } : {}),
    ...(availableVersion ? { version: availableVersion, availableVersion } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    updateAvailable: record !== undefined && object(record).source !== 'builtin' && newerPluginVersion(availableVersion, installedVersion) };
}

/** Reads engine-owned config and read-only marketplace content; never writes a plugin ledger. */
export class PluginCatalog {
  constructor(private readonly deps: PluginCatalogDeps) {}
  private async icon(dir: string, manifest: JsonObject): Promise<string | undefined> {
    try { return await readPluginIcon(dir, manifest); }
    catch (error) { this.deps.diagnostic?.('Plugin icon unavailable: ' + errorMessage(error)); return undefined; }
  }
  private async entries(location: string | null): Promise<JsonObject[]> {
    if (!location) return [];
    for (const folder of ['.claude-plugin', '.codex-plugin']) {
      try {
        const raw = await optionalDocument(await managedPath(location, folder + '/marketplace.json'), 8 * 1024 * 1024);
        if (raw === undefined) continue;
        const manifest = object(JSON.parse(raw));
        if (!Array.isArray(manifest.plugins)) throw new Error('Marketplace manifest has no plugins array');
        const entries = manifest.plugins.flatMap(value => { const entry = object(value); return typeof entry.name === 'string' && entry.name.length ? [entry] : []; });
        return Promise.all(entries.map(async entry => {
          if (typeof entry.source !== 'string') return entry;
          try {
            const directory = await localPluginSource(location, entry.source);
            const packageManifest = await pluginManifest(directory);
            if (!packageManifest || packageManifest.name !== entry.name) return entry;
            const iconDataUrl = pluginIconDataUrl(entry.iconDataUrl) ?? await this.icon(directory, packageManifest);
            // Official packages download on demand; an older cache must not hide a newly published release.
            if (manifest.name === 'klaus-official' && newerPluginVersion(string(entry.version), string(packageManifest.version))) return { ...entry, ...(iconDataUrl ? { iconDataUrl } : {}) };
            return { ...entry, ...detailMetadata(packageManifest), ...(typeof packageManifest.version === 'string' ? { version: packageManifest.version } : {}),
              ...(typeof packageManifest.description === 'string' ? { description: packageManifest.description } : {}),
              ...(iconDataUrl ? { iconDataUrl } : {}) };
          } catch (error) { this.deps.diagnostic?.('Plugin package metadata unavailable: ' + errorMessage(error)); return entry; }
        }));
      } catch (error) { this.deps.diagnostic?.('Marketplace read failed: ' + errorMessage(error)); }
    }
    return [];
  }
  async snapshot(): Promise<PluginCatalogSnapshot> {
    const answer = object(await this.deps.request('config/read', {}));
    if (answer.error != null) throw new IpcHandlerError('ENGINE_REQUEST_FAILED', errorMessage(answer.error));
    if (!answer.values || typeof answer.values !== 'object' || Array.isArray(answer.values)) throw new IpcHandlerError('ENGINE_REPLY_INVALID', 'Plugin config snapshot has no values object');
    const values = object(answer.values);
    const ledgerReply = object(await this.deps.request('session/installedPlugins', {}));
    if (ledgerReply.error != null) throw new IpcHandlerError('ENGINE_REQUEST_FAILED', errorMessage(ledgerReply.error));
    const ledger = object(ledgerReply.installedPlugins ?? ledgerReply);
    const installed = Object.keys(ledger).length ? object(ledger.plugins) : object(values.plugins), marketplaces: Marketplace[] = [];
    for (const [name, value] of Object.entries(object(values.marketplaces))) {
      const source = object(value), location = typeof source.installLocation === 'string' && isAbsolute(source.installLocation) ? source.installLocation : null;
      marketplaces.push({ name, installLocation: location, lastUpdated: typeof source.lastUpdated === 'string' ? source.lastUpdated : null, seeded: false, entries: await this.entries(location) });
    }
    if (this.deps.seedDir) {
      try {
        const raw = await optionalDocument(join(this.deps.seedDir, 'known_marketplaces.json'));
        for (const [name, value] of Object.entries(object(raw === undefined ? null : JSON.parse(raw)))) {
          const current = marketplaces.findIndex(item => item.name === name); if (current >= 0 && marketplaces[current]!.entries.length) continue;
          const source = object(value), prefix = '/__klaus__/plugins-seed', rawLocation = string(source.installLocation);
          if (rawLocation !== prefix && !rawLocation.startsWith(prefix + '/')) continue;
          const location = resolve(this.deps.seedDir, '.' + rawLocation.slice(prefix.length));
          if (!pathInside(location, this.deps.seedDir)) continue;
          const entry: Marketplace = { name, installLocation: location, lastUpdated: typeof source.lastUpdated === 'string' ? source.lastUpdated : null, seeded: true, entries: await this.entries(location) };
          if (current >= 0) marketplaces[current] = entry; else marketplaces.push(entry);
        }
      } catch (error) { this.deps.diagnostic?.('Bundled marketplace read failed: ' + errorMessage(error)); }
    }
    const rows = marketplaces.flatMap(market => market.entries.map(entry => row(entry, market.name, installed))), seen = new Set(rows.map(row => string(row.id)));
    for (const info of rows) {
      const path = string(object(installed[string(info.id)]).installPath);
      if (info.iconDataUrl || !path || !isAbsolute(path)) continue;
      try {
        const iconDataUrl = await this.icon(path, await pluginManifest(path) ?? {});
        if (iconDataUrl) info.iconDataUrl = iconDataUrl;
      } catch (error) { this.deps.diagnostic?.('Installed plugin icon unavailable: ' + errorMessage(error)); }
    }
    for (const [id, value] of Object.entries(installed)) {
      if (seen.has(id)) continue;
      const record = object(value), path = string(record.installPath), builtin = id.endsWith('@builtin');
      let manifest: JsonObject = {}, skills: string[] = [];
      if (path && isAbsolute(path)) {
        try {
          manifest = await pluginManifest(path) ?? {};
          for (const name of await directoryNames(join(path, 'skills'))) if ((await stat(await managedPath(path, 'skills/' + name))).isDirectory()) skills.push(name);
        }
        catch (error) { this.deps.diagnostic?.('Installed plugin manifest read failed: ' + errorMessage(error)); }
      }
      const name = string(record.name) || id.slice(0, id.lastIndexOf('@')) || id, marketplace = id.slice(id.lastIndexOf('@') + 1);
      const info = row({ ...manifest, name }, marketplace, installed);
      const iconDataUrl = path && isAbsolute(path) ? await this.icon(path, manifest) : undefined;
      if (iconDataUrl) info.iconDataUrl = iconDataUrl;
      delete info.availableVersion;
      if (typeof record.version === 'string') info.version = record.version;
      rows.push({ ...info, id, enabled: record.enabled !== false, installed: true, updateAvailable: false,
        source: builtin ? 'builtin' : string(record.source, 'installed'),
        ...(builtin ? { category: string(object(manifest.interface).category, 'other').toLowerCase(), contributions: { skills, mcpServers: Object.keys(object(manifest.mcpServers)) } } : {}) });
    }
    rows.sort((a, b) => Number(b.installed === true) - Number(a.installed === true) || Number(b.hasLsp === true) - Number(a.hasLsp === true) || string(a.name).localeCompare(string(b.name)));
    return { installed, marketplaces, rows };
  }
  async roots(snapshot?: PluginCatalogSnapshot): Promise<CatalogRoot[]> {
    const state = snapshot ?? await this.snapshot(), roots: CatalogRoot[] = [], seen = new Set<string>();
    const add = async (marketplace: string, dir: string): Promise<void> => {
      if (!isAbsolute(dir)) return; const key = marketplace + '\0' + resolve(dir); if (seen.has(key)) return;
      try { if ((await stat(dir)).isDirectory()) { seen.add(key); roots.push({ marketplace, dir }); } }
      catch (error) { if (!missing(error)) this.deps.diagnostic?.('Plugin catalog root unavailable: ' + errorMessage(error)); }
    };
    for (const [id, value] of Object.entries(state.installed)) {
      const path = string(object(value).installPath); if (path) await add(id.slice(id.lastIndexOf('@') + 1), path);
    }
    for (const market of state.marketplaces) for (const entry of market.entries) {
      if (market.installLocation && typeof entry.source === 'string') {
        try {
          const source = await localPluginSource(market.installLocation, entry.source);
          await add(market.name, source === resolve(market.installLocation) ? source : dirname(source));
        }
        catch (error) { this.deps.diagnostic?.('Plugin source unavailable: ' + errorMessage(error)); }
      }
    }
    return roots;
  }
  async commandSources(): Promise<string[]> {
    const state = await this.snapshot(), paths: string[] = [];
    for (const value of Object.values(state.installed)) {
      const record = object(value), path = string(record.installPath); if (record.enabled === false || !isAbsolute(path)) continue;
      try {
        const manifest = await pluginManifest(path), declared = manifest?.commands, name = string(manifest?.name);
        if (!name || name.startsWith('.') || name.includes('..') || /[/\\]/.test(name)) continue;
        const sources = Array.isArray(declared) ? declared.filter((value): value is string => typeof value === 'string') : typeof declared === 'string' ? [declared] : ['commands'];
        for (const source of sources) paths.push(await managedPath(path, source));
      } catch (error) { this.deps.diagnostic?.('Plugin commands unavailable: ' + errorMessage(error)); }
    }
    return [...new Set(paths)];
  }
}
