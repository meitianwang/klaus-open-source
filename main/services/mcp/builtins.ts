import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Json } from '../../ipc/contract';
import type { SkillMarketEndpoint } from '../../skills-market/service';
import { fetchExtensionText, PendingAcquisitions } from '../extensions/acquisition';
import { atomicDocument, managedPath, optionalDocument } from '../extensions/file-store';
import { object, errorMessage, type JsonObject } from '../service-types';
import { enabled, serverConfig, validServerName } from './entries';
import type { McpConfigurationService } from './configuration';

export interface McpBuiltinDependencies {
  configRoot: string; mcp: McpConfigurationService;
  endpoint(): SkillMarketEndpoint | undefined | Promise<SkillMarketEndpoint | undefined>;
  deviceClientId?(id: string, catalog: JsonObject[]): string | Promise<string>;
  fetch?: typeof fetch; seed?: readonly JsonObject[];
  environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  log(message: string): void;
}
const cacheName = 'mcp-market-catalog.json';
function clean(raw: unknown): JsonObject | undefined {
  const entry = object(raw), id = entry.id;
  if (typeof id !== 'string' || !validServerName(id) || id.length > 128 || !serverConfig(id, entry.config)) return undefined;
  for (const key of ['category', 'nameZh', 'nameEn', 'descZh', 'descEn', 'iconSvg', 'link', 'auth']) {
    if (entry[key] != null && (typeof entry[key] !== 'string' || String(entry[key]).length > 32_768)) return undefined;
  }
  if (entry.envKeys !== undefined && (!Array.isArray(entry.envKeys) || entry.envKeys.length > 64 || entry.envKeys.some(raw => {
    const field = object(raw); return typeof field.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(field.key)
      || (field.label !== undefined && (typeof field.label !== 'string' || field.label.length > 512))
      || (field.secret !== undefined && typeof field.secret !== 'boolean');
  }))) return undefined;
  return structuredClone(entry);
}
/** Config is owned by McpConfigurationService; this service only acquires catalog metadata. */
export class McpBuiltinService {
  private readonly pending = new PendingAcquisitions();
  private refreshFlight?: Promise<void>;
  constructor(private readonly deps: McpBuiltinDependencies) {}
  private refresh(signal: AbortSignal): Promise<void> {
    if (this.refreshFlight) return this.refreshFlight;
    const flight = (async () => {
      const endpoint = await this.deps.endpoint(); signal.throwIfAborted(); if (!endpoint) return;
      const url = endpoint.baseUrl.replace(/\/+$/, '') + (endpoint.direct ? '/api/v1/mcp' : '/api/market/mcp');
      const response = object(JSON.parse(await fetchExtensionText(url, signal, { fetch: this.deps.fetch, token: endpoint.token, timeoutMs: 5000, maxBytes: 1024 * 1024 })));
      if (!Array.isArray(response.items) || response.items.length > 512) throw new Error('Invalid MCP catalog response');
      const items = response.items.map(clean).filter((row): row is JsonObject => !!row).map(row => {
        // Remote markup never executes inside the privileged settings page.
        delete row.iconSvg; return row;
      });
      signal.throwIfAborted(); await atomicDocument(this.deps.configRoot, cacheName, JSON.stringify({ items, approvedCatalog: true }));
    })();
    this.refreshFlight = flight;
    void flight.finally(() => { if (this.refreshFlight === flight) this.refreshFlight = undefined; }).catch(() => {});
    return flight;
  }
  async catalog(): Promise<JsonObject[]> {
    // The connector catalog is fully server-hosted now (content/mcp-catalog.json
    // on the web service); the client ships no compiled seed, so an unreachable
    // server means an empty connector market, same trade as the skills market.
    // deps.seed stays a test/ops override and wins over cached remote rows.
    const rows = (this.deps.seed ?? []).map(clean).filter((row): row is JsonObject => !!row);
    const ids = new Set(rows.map(row => row.id));
    try {
      const text = await optionalDocument(await managedPath(this.deps.configRoot, cacheName));
      const cached = text === undefined ? {} : object(JSON.parse(text));
      if (cached.approvedCatalog === true && Array.isArray(cached.items) && cached.items.length <= 512) {
        for (const raw of cached.items) {
          const row = clean(raw); if (!row || ids.has(row.id)) continue;
          delete row.iconSvg; ids.add(row.id); rows.push(row);
        }
      }
    } catch (error) { this.deps.log('MCP catalog cache unavailable: ' + (error instanceof SyntaxError ? 'Invalid JSON' : errorMessage(error))); }
    return rows;
  }
  list(): Promise<Json> {
    return this.pending.run(async signal => {
      try { await this.refresh(signal); } catch (error) { this.deps.log('MCP catalog refresh unavailable: ' + (error instanceof SyntaxError ? 'Invalid JSON' : errorMessage(error))); }
      signal.throwIfAborted();
      const [catalog, installed] = await Promise.all([this.catalog(), this.deps.mcp.list()]);
      const servers = new Map((Array.isArray(installed) ? installed : []).map(row => [object(row).name, object(row).config]));
      return Promise.all(catalog.map(async entry => {
        const row: JsonObject = { id: entry.id!, envKeys: entry.envKeys ?? [], installed: servers.has(entry.id), enabled: servers.has(entry.id) && enabled(servers.get(entry.id)),
          needsUv: (this.deps.platform ?? process.platform) === 'win32' && ['uv', 'uvx'].includes(String(object(entry.config).command)) };
        for (const key of ['category', 'nameZh', 'nameEn', 'descZh', 'descEn', 'iconSvg', 'link', 'auth']) row[key] = entry[key] ?? null;
        const device = object(entry.deviceAuth);
        if (device.provider === 'github') row.deviceAuth = { provider: device.provider, registerUrl: device.registerUrl ?? null,
          ready: !!await this.deps.deviceClientId?.(String(entry.id), catalog) };
        return row;
      }));
    });
  }
  install(payload: JsonObject, outerSignal?: AbortSignal): Promise<Json> {
    return this.pending.run(async signal => {
      const active = outerSignal ? AbortSignal.any([signal, outerSignal]) : signal; active.throwIfAborted();
      if (typeof payload.id !== 'string' || !validServerName(payload.id)) return { ok: false, error: 'Invalid builtin MCP identity' };
      if (payload.env !== undefined && (payload.env === null || typeof payload.env !== 'object' || Array.isArray(payload.env))) return { ok: false, error: 'Catalog environment values must be an object' };
      const entry = (await this.catalog()).find(row => row.id === payload.id); active.throwIfAborted();
      if (!entry) return { ok: false, error: 'Unknown built-in id: ' + payload.id };
      return this.deps.mcp.installBuiltin(payload.id, entry, object(payload.env), active);
    });
  }
  uvCheck(): Promise<Json> {
    return this.pending.run(async signal => {
      const windows = (this.deps.platform ?? process.platform) === 'win32', env = this.deps.environment ?? process.env;
      const path = Object.entries(env).find(([key]) => windows ? key.toLowerCase() === 'path' : key === 'PATH')?.[1] ?? '';
      for (const directory of path.split(windows ? ';' : delimiter).filter(Boolean).slice(0, 256)) {
        signal.throwIfAborted();
        for (const name of windows ? ['uvx.exe', 'uvx.cmd', 'uvx.bat', 'uvx'] : ['uvx']) {
          const candidate = join(directory.replace(/^"|"$/g, ''), name);
          try { if (!(await stat(candidate)).isFile()) continue; await access(candidate, windows ? constants.F_OK : constants.X_OK); return { available: true }; }
          catch { /* Continue looking through the configured executable path. */ }
        }
      }
      return { available: false };
    });
  }
  close(): Promise<void> { return this.pending.close(); }
}
