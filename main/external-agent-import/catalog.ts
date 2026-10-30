import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Json } from '../ipc/contract';
import { checkCancelled } from '../services/download';
import { serverConfig, validServerName } from '../services/mcp/entries';
import { object, string, type JsonObject } from '../services/service-types';
import { pathInside } from '../services/workspaces';
import { codexMcpSource, codexProjectTrusted } from './codex-mcp';
import { directory, names, present, sourceJson, unique, withinSource } from './files';
import { loadImportLedger, refreshImportedSource, sourceStates } from './ledger';
import { externalProviders, mcpPaths, type ExternalProvider } from './providers';
import { discoverSkills } from './skills';
import { readExternalTranscript, importedThreadId, sourceTitles } from './transcripts';

export function sourceMcpServers(provider: ExternalProvider, source: JsonObject | undefined): JsonObject {
  const servers: JsonObject = {};
  for (const [name, raw] of Object.entries(object(source?.mcpServers))) {
    if (!validServerName(name) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const config = structuredClone(raw) as JsonObject;
    if (provider.id === 'claude-code' && typeof config.url === 'string' && !config.type) continue;
    if (!config.type && typeof config.url === 'string') config.type = 'http';
    if (typeof config.url === 'string') {
      try { if (!['http:', 'https:'].includes(new URL(config.url).protocol)) continue; } catch { continue; }
    }
    if (config.disabled === true) { config.enabled = false; delete config.disabled; }
    if (!serverConfig(name, config)) continue;
    Object.defineProperty(servers, name, { value: config, enumerable: true, configurable: true, writable: true });
  }
  return servers;
}
export async function sourceMcpDocument(provider: ExternalProvider, path: string, signal: AbortSignal, strict = false): Promise<JsonObject | undefined> {
  if (provider.id !== 'codex') return sourceJson(path, signal, dirname(path));
  try { return await codexMcpSource(path, signal); }
  catch (error) { if (strict || signal.aborted) throw error; return undefined; }
}
export interface CatalogOptions { home: string; configRoot: string; platform?: NodeJS.Platform; appData?: string; now?: () => number; knownProjects?: () => string[] }
const named = (values: string[]): Json[] => values.slice(0, 80).map(name => ({ name }));
export class ExternalImportCatalog {
  readonly providers: ExternalProvider[];
  readonly approvedProjects = new Set<string>();
  constructor(readonly options: CatalogOptions) { this.providers = externalProviders(options.home, options); }
  provider(id: string): ExternalProvider {
    const provider = this.providers.find(provider => provider.id === id); if (!provider) throw new Error('Unsupported external provider: ' + id); return provider;
  }
  async mcpPath(provider: ExternalProvider, cwd: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    if (provider.id === 'codex' && cwd && !await codexProjectTrusted(this.options.home, cwd, this.options.knownProjects?.() ?? [], signal)) return undefined;
    for (const path of mcpPaths(provider, this.options.home, cwd)) if (await present(path)) return path;
    return undefined;
  }
  async mcpSource(provider: ExternalProvider, cwd: string | undefined, signal: AbortSignal, strict = false): Promise<{ path: string; servers: JsonObject }> {
    const path = await this.mcpPath(provider, cwd, signal);
    const source = path ? await sourceMcpDocument(provider, path, signal, strict) : undefined;
    const servers = sourceMcpServers(provider, source), paths = path ? [path] : [];
    if (provider.id === 'claude-code' && cwd && this.options.knownProjects?.().includes(cwd)) {
      const localPath = join(this.options.home, '.claude.json');
      const local = await sourceJson(localPath, signal, dirname(localPath));
      const project = object(object(local?.projects)[cwd]);
      const localServers = sourceMcpServers(provider, { mcpServers: object(project.mcpServers) });
      if (Object.keys(localServers).length) {
        for (const [name, config] of Object.entries(localServers)) {
          Object.defineProperty(servers, name, { value: config, enumerable: true, configurable: true, writable: true });
        }
        paths.push(localPath + ' (local scope)');
      }
    }
    return { path: paths.join(' + '), servers };
  }
  private item(provider: ExternalProvider, itemType: string, description: string, cwd: string | undefined, details: JsonObject): JsonObject {
    return { providerId: provider.id, providerName: provider.name, itemType, description, cwd: cwd ?? null, details };
  }
  private async listedSkills(provider: ExternalProvider, cwd: string | undefined, signal: AbortSignal): Promise<string[]> {
    const found = await discoverSkills(provider, this.options.home, cwd, this.options.knownProjects?.() ?? [], signal);
    return found.skills.map(skill => skill.name);
  }
  async detectRoot(provider: ExternalProvider, cwd: string | undefined, signal: AbortSignal): Promise<JsonObject[]> {
    const result: JsonObject[] = [];
    const mcp = await this.mcpSource(provider, cwd, signal);
    const servers = Object.keys(mcp.servers);
    if (servers.length) result.push(this.item(provider, 'MCP_SERVER_CONFIG', 'Migrate ' + provider.name + ' MCP servers from ' + mcp.path, cwd, { mcpServers: named(servers) }));
    const skills = await this.listedSkills(provider, cwd, signal);
    if (skills.length) result.push(this.item(provider, 'SKILLS', 'Migrate ' + provider.name + ' skills', cwd, { skills: named(skills) }));
    return result;
  }
  async recentSessions(provider: ExternalProvider, signal: AbortSignal): Promise<JsonObject[]> {
    if (!provider.format) return [];
    const titles = await sourceTitles(provider, this.options.home, signal);
    const ledgerRows = await loadImportLedger(this.options.configRoot);
    const states = sourceStates(ledgerRows);
    const extension = '.jsonl', files: Array<{ path: string; mtime: number }> = [];
    const walk = async (root: string, path: string, depth: number): Promise<void> => {
      for (const name of await names(path)) {
        checkCancelled(signal); if (files.length >= 1000) break;
        const child = join(path, name);
        try {
          const canonical = await withinSource(child, root); const info = await stat(canonical);
          if (info.isDirectory() && depth < provider.maxDepth) await walk(root, canonical, depth + 1);
          else if (info.isFile() && name.endsWith(extension)) files.push({ path: canonical, mtime: info.mtimeMs });
        } catch { checkCancelled(signal); }
      }
    };
    for (const root of provider.sessionRoots) if (await directory(root)) await walk(root, root, 0);
    const now = (this.options.now ?? Date.now)();
    // Sources whose recorded import already matches the current file state are not offered again.
    const candidates = files
      .filter(file => provider.maxAgeMs === undefined || !file.mtime || now - file.mtime <= provider.maxAgeMs)
      .filter(file => {
        const state = states.get(file.path);
        return !(state && (state.sourceModifiedAtMs === file.mtime || (state.sourceModifiedAtMs === undefined && file.mtime <= state.importedAtMs)));
      })
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path)).slice(0, 50), summaries = [];
    for (const file of candidates) {
      try {
        const parsed = await readExternalTranscript(provider, file.path, { ...this.options, providers: this.providers, knownProjects: this.options.knownProjects?.(), titles }, signal);
        if (provider.maxAgeMs !== undefined && now - parsed.latestTimestampMs > provider.maxAgeMs) continue;
        if (states.has(parsed.path)) {
          const hash = createHash('sha256').update(parsed.bytes).digest('hex');
          if (ledgerRows.some(row => row.source_path === parsed.path && row.content_sha256 === hash)) {
            await refreshImportedSource(this.options.configRoot, parsed.path, hash, file.mtime);
            continue;
          }
        }
        summaries.push(parsed);
      } catch { checkCancelled(signal); }
    }
    return summaries.sort((a, b) => b.latestTimestampMs - a.latestTimestampMs || a.path.localeCompare(b.path)).slice(0, 50).map(parsed => ({
      path: parsed.path, ...(parsed.project ? { cwd: parsed.project } : {}), ...(parsed.sourceCwd ? { sourceCwd: parsed.sourceCwd } : {}), ...(parsed.title ? { title: parsed.title } : {}),
    }));
  }
  async detect(payload: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const items: JsonObject[] = [], unsupported: string[] = [];
    this.approvedProjects.clear();
    const registered = unique(this.options.knownProjects?.() ?? []);
    for (const provider of this.providers) {
      checkCancelled(signal);
      const sessions = payload.includeHome === false ? [] : await this.recentSessions(provider, signal);
      if (payload.includeHome !== false) {
        items.push(...await this.detectRoot(provider, undefined, signal));
        if (sessions.length) items.push(this.item(provider, 'SESSIONS', 'Migrate recent chat sessions from ' + provider.name, undefined, { sessions }));
      }
      const roots = unique([...registered, ...sessions.map(session => string(session.sourceCwd)).filter(root => registered.some(project => pathInside(root, project)))]);
      for (const raw of roots) {
        const root = await directory(raw); if (!root) continue;
        this.approvedProjects.add(root);
        items.push(...await this.detectRoot(provider, root, signal));
      }
    }
    for (const raw of Array.isArray(payload.workspaceRoots) ? payload.workspaceRoots : []) {
      if (typeof raw !== 'string') continue;
      const root = await directory(raw); if (!root) { unsupported.push(raw); continue; }
      this.approvedProjects.add(root);
      for (const provider of this.providers) {
        checkCancelled(signal); const sourceItems = await this.detectRoot(provider, root, signal);
        items.push(...sourceItems);
        if (!sourceItems.length) continue;
        const registeredAncestor = registered.some(project => pathInside(root, project));
        const existing = items.some(item => item.providerId === provider.id && item.itemType === 'PROJECTS' && (object(item.details).projectRoots as Json[]).includes(root));
        if (!registeredAncestor && !existing) items.push(this.item(provider, 'PROJECTS', 'Use existing ' + provider.name + ' project folders', root, { projectRoots: [root] }));
      }
    }
    const seen = new Set<string>(), deduped = items.filter(item => {
      const key = JSON.stringify({ providerId: item.providerId, itemType: item.itemType, cwd: item.cwd, details: item.details });
      if (seen.has(key)) return false; seen.add(key); return true;
    });
    return { items: deduped, providers: this.providers.flatMap(provider => {
      const count = deduped.filter(item => item.providerId === provider.id).length;
      return count ? [{ id: provider.id, name: provider.name, accent: provider.accent, itemCount: count }] : [];
    }), unsupportedProjects: unsupported };
  }
}
