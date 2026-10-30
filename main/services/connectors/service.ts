import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { IpcHandlerError } from '../../ipc/registry';
import { withSettingsDb, withSettingsTransaction } from '../settings';
import { mcpToolRequiresApproval } from '../mcp/runtime';
import type { PermissionRules } from '../permission-rules';
import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from './catalog';

export interface ConnectorCapability {
  serverName: string;
  tools: Array<{ name: string; readOnly: boolean; destructive: boolean }>;
}
export interface ConnectorServiceDeps {
  configRoot: string;
  userHome: string;
  platform?: NodeJS.Platform;
  catalog?: readonly ConnectorCatalogEntry[];
  /** Describe an actually available serving implementation without starting it or requesting OS permission. */
  capability: (id: string) => Promise<ConnectorCapability | undefined>;
  permissionRules: () => Promise<PermissionRules>;
  /** Whether a current engine session exists to provide meaningful live status. */
  runtimeActive?: () => Promise<boolean>;
  runtimeStatus: () => Promise<unknown>;
  onChanged: () => void | Promise<void>;
  photosReadWriteStatus?: () => Promise<'authorized' | 'limited' | 'denied' | 'restricted' | 'not-determined' | 'unavailable'>;
}
const enabledKey = (id: string): string => 'connector:' + id + ':enabled';
const toolsKey = (id: string): string => 'connector:' + id + ':disabled-tools';
const disabled = (value: string | undefined): string[] => [...new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean))];
const unavailable = (id: string): string => 'Connector runtime unavailable: ' + id + ' has no serving implementation in this build';

/** User preferences remain compatible with settings.db; connected status always comes from the real MCP runtime. */
export class ConnectorService {
  private readonly mutations = new SerialMutations();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly catalog: readonly ConnectorCatalogEntry[];
  private readonly platform: NodeJS.Platform;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: ConnectorServiceDeps) { this.catalog = deps.catalog ?? CONNECTOR_CATALOG; this.platform = deps.platform ?? process.platform; }
  private active(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The connector service is closed'); }
  private track<T>(action: () => Promise<T>): Promise<T> {
    try { this.active(); } catch (error) { return Promise.reject(error); }
    const promise = action(); this.pending.add(promise); return promise.finally(() => { this.pending.delete(promise); });
  }
  private entry(id: string): ConnectorCatalogEntry { const entry = this.catalog.find(row => row.id === id); if (!entry) throw new Error('Unknown connector: ' + id); return entry; }
  private settings(): Map<string, string> {
    return withSettingsDb(this.deps.configRoot, db => new Map((db.prepare("SELECT key, value FROM settings WHERE key LIKE 'connector:%'").all() as Array<{ key: string; value: string }>).map(row => [row.key, row.value])));
  }
  private async capability(id: string): Promise<ConnectorCapability | undefined> {
    const value = await this.deps.capability(id);
    if (value && (!string(value.serverName).trim() || !Array.isArray(value.tools) || value.tools.some(tool => !string(tool?.name).trim() || typeof tool.readOnly !== 'boolean' || typeof tool.destructive !== 'boolean' || (tool.readOnly && tool.destructive)) || new Set(value.tools.map(tool => tool.name)).size !== value.tools.length)) throw new Error('Invalid connector runtime capability: ' + id);
    return value;
  }
  list(): Promise<JsonObject[]> {
    return this.track(async () => {
      const settings = this.settings(), rules = await this.deps.permissionRules();
      if (!Array.isArray(rules.ask) || rules.ask.some(rule => typeof rule !== 'string')) throw new Error('Invalid connector permission rule snapshot');
      return Promise.all(this.catalog.map(async entry => {
        const capability = await this.capability(entry.id), denied = disabled(settings.get(toolsKey(entry.id))), serverName = capability?.serverName ?? 'klaus-' + entry.id;
        return { ...entry, serverName, availableOnThisPlatform: entry.platform === this.platform, enabled: settings.get(enabledKey(entry.id)) === '1', runtimeAvailable: capability !== undefined,
          tools: entry.tools.map(tool => {
            const name = string(tool.name), effect = capability?.tools.find(row => row.name === name), fullName = 'mcp__' + serverName + '__' + name;
            return { ...tool, enabled: !denied.includes(name), fullName, approval: mcpToolRequiresApproval(rules.ask, fullName) ? 'ask' : 'auto', readOnly: effect?.readOnly ?? false, destructive: effect?.destructive ?? false };
          }),
        };
      }));
    });
  }
  private mutate(action: () => Promise<void>): Promise<JsonObject> {
    return this.track(() => this.mutations.run(async (): Promise<JsonObject> => {
      this.active(); await action();
      try { await this.deps.onChanged(); }
      catch (error) { return { ok: false, saved: true, reloadRequired: true, error: 'Connector settings were saved, but reloading the live session failed: ' + errorMessage(error) }; }
      return { ok: true };
    })).catch(error => ({ ok: false, error: errorMessage(error) }));
  }
  toggle(payload: JsonObject): Promise<JsonObject> {
    return this.mutate(async () => {
      const id = string(payload.id), entry = this.entry(id); if (typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      if (payload.enabled && entry.platform !== this.platform) throw new Error('Connector "' + id + '" is not available on ' + this.platform);
      if (payload.enabled && !await this.capability(id)) throw new Error(unavailable(id)); this.active();
      withSettingsTransaction(this.deps.configRoot, db => { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(enabledKey(id), payload.enabled ? '1' : ''); });
    });
  }
  setToolEnabled(payload: JsonObject): Promise<JsonObject> {
    return this.mutate(async () => {
      const id = string(payload.id), entry = this.entry(id), name = string(payload.toolName);
      if (!entry.tools.some(tool => tool.name === name)) throw new Error('Unknown tool "' + name + '" on ' + id);
      if (typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      withSettingsTransaction(this.deps.configRoot, db => {
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get(toolsKey(id)) as { value: string } | undefined;
        const previous = disabled(row?.value), next = payload.enabled ? previous.filter(tool => tool !== name) : previous.includes(name) ? previous : [...previous, name];
        db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(toolsKey(id), next.join(','));
      });
    });
  }
  /** The full managed-capability composer can read saved intent without starting a connector. */
  enabledConnectors(): Promise<Array<{ id: string; disabledTools: string[] }>> {
    return this.track(async () => { const settings = this.settings(); return this.catalog.filter(entry => entry.platform === this.platform && settings.get(enabledKey(entry.id)) === '1').map(entry => ({ id: entry.id, disabledTools: disabled(settings.get(toolsKey(entry.id))) })); });
  }
  status(): Promise<JsonObject[]> {
    return this.track(async () => {
      const settings = this.settings(), enabled = this.catalog.filter(entry => settings.get(enabledKey(entry.id)) === '1');
      if (!enabled.length) return [];
      const capabilities = await Promise.all(enabled.map(entry => this.capability(entry.id)));
      const hasServingCapability = capabilities.some((capability, index) => capability && enabled[index]!.platform === this.platform);
      const runtimeActive = hasServingCapability ? await (this.deps.runtimeActive?.() ?? true) : false;
      const value = runtimeActive ? await this.deps.runtimeStatus() : [];
      if (!Array.isArray(value) || value.some(row => !string(object(row).name) || !Array.isArray(object(row).tools) || !string(object(row).status) || (object(row).tools as unknown[]).some(tool => !string(object(tool).name))) || new Set(value.map(row => string(object(row).name))).size !== value.length) throw new Error('Invalid connector runtime snapshot');
      return enabled.map((entry, index): JsonObject => {
        const capability = capabilities[index], name = capability?.serverName ?? 'klaus-' + entry.id, live = (value as JsonObject[]).find(row => row.name === name);
        const failure = (error: string): JsonObject => ({ name, status: 'failed', toolCount: 0, tools: [], error });
        if (entry.platform !== this.platform) return failure('Connector "' + entry.id + '" is not available on ' + this.platform);
        if (!capability) return failure(unavailable(entry.id));
        if (!runtimeActive) return { name, status: 'configured', toolCount: 0, tools: [] };
        if (!live) return failure('Connector is enabled, but its server is not present in the current session runtime');
        const prefix = 'mcp__' + name + '__';
        const tools = (live.tools as JsonObject[]).map(tool => ({ ...tool, name: string(tool.name).startsWith(prefix) ? string(tool.name).slice(prefix.length) : string(tool.name) }));
        return { ...live, tools, toolCount: tools.length };
      });
    });
  }
  private async readable(paths: string[], missing: string, denied: string, failOnMissing: boolean): Promise<JsonObject> {
    for (const path of paths) {
      try { const handle = await open(path, 'r'); await handle.close(); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && !failOnMissing) continue;
        if (code === 'ENOENT') return { ok: false, error: missing };
        if (code === 'EACCES' || code === 'EPERM') return { ok: false, needsFullDiskAccess: true, error: denied };
        return { ok: false, error: errorMessage(error) };
      }
    }
    return { ok: true };
  }
  preflight(payload: JsonObject): Promise<JsonObject> {
    return this.track(async () => {
      const id = string(payload.id), entry = this.entry(id);
      const label = ({ 'macos-messages': 'Messages', 'macos-safari': 'Safari', 'macos-photos': 'Photos', 'macos-app-ui': 'App UI' } as Record<string, string>)[id];
      if (entry.platform !== this.platform) return { ok: false, error: label ? label + ' connector is only available on macOS.' : 'Connector "' + id + '" is not available on ' + this.platform };
      if (!await this.capability(id)) return { ok: false, error: unavailable(id) };
      this.active();
      if (id === 'macos-messages') return this.readable([join(this.deps.userHome, 'Library/Messages/chat.db')], 'Messages database was not found. Open Messages once, then try again.', 'Cannot read Messages database. Grant Klaus Full Disk Access, then restart Klaus.', true);
      if (id === 'macos-safari') return this.readable([join(this.deps.userHome, 'Library/Safari/Bookmarks.plist'), join(this.deps.userHome, 'Library/Safari/History.db')], '', 'Cannot read Safari bookmarks/history. Grant Klaus Full Disk Access, then restart Klaus.', false);
      if (id === 'macos-photos') {
        const status = await this.deps.photosReadWriteStatus?.() ?? 'unavailable';
        if (status === 'authorized' || status === 'limited') return { ok: true };
        return { ok: false, error: status === 'unavailable' ? 'Photos permission status is unavailable: PHPhotoLibrary could not be loaded.' : 'Photos read/write permission is not granted. Grant Photos access in Klaus Settings > System Authorization, then restart Klaus.' };
      }
      return { ok: true };
    }).catch(error => ({ ok: false, error: errorMessage(error) }));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true;
    return this.closing = (async () => { await Promise.allSettled([...this.pending]); await this.mutations.run(async () => {}); })();
  }
}
