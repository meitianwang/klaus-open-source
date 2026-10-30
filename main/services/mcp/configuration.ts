import { isAbsolute, resolve } from 'node:path';
import type { Json } from '../../ipc/contract';
import { IpcHandlerError } from '../../ipc/registry';
import { DirectoryMutations } from '../extensions/directory-mutations';
import { atomicDocument, managedPath, optionalDocument } from '../extensions/file-store';
import { registeredRoots } from '../extensions/scopes';
import { errorMessage, object, string, type EngineRequest, type JsonObject } from '../service-types';
import type { WorkspaceStore } from '../workspaces';
import { carryEnabled, enabled, resolveServerTables, serverConfig, setEnabled, setToolEnabled, validServerName, type McpDeclarations } from './entries';
import { installBuiltinEntry } from './builtin-config';

export interface McpConfigurationDeps {
  workspaces: WorkspaceStore;
  request: EngineRequest;
  /** Reload live declarations and mark other sessions stale after the durable write. */
  onChanged: (cwd?: string) => void | Promise<void>;
  /** Read the existing renderer thread's cwd without activating another session. */
  resolveCwd?: (sessionId: string) => Promise<string>;
  diagnostic?: (path: string, error: unknown) => void;
}
interface ConfigSnapshot { values: JsonObject; version: string }
type Scope = 'project' | 'local';
type Mutation = 'create' | 'update' | 'toggle' | 'remove';
const NAME_ERROR = 'Invalid name: only letters, numbers, hyphens, underscores';
const record = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const rows = (servers: JsonObject, user = false): JsonObject[] => Object.entries(servers).map(([name, config]) => ({ name, config, ...(user ? { enabled: enabled(config) } : {}) }));
class SavedConfigurationError extends Error { constructor(error: unknown) { super('MCP configuration was saved, but reloading the live session failed: ' + errorMessage(error)); } }
const failed = (error: unknown): JsonObject => ({ ok: false, error: errorMessage(error), ...(error instanceof SavedConfigurationError ? { saved: true, reloadRequired: true } : {}) });
const missingServer = (name: string): Error => new Error('MCP server "' + name + '" not found');
const own = (target: JsonObject, key: string, value: Json): void => { Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true }); };
const quote = (key: string): string => '"' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
function table(value: unknown, label: string): JsonObject {
  if (value === undefined) return {};
  if (!record(value)) throw new Error('Invalid ' + label + ' object');
  return structuredClone(value);
}

/** Config ownership stays split: engine user/local sections and a project-owned JSON file. */
export class McpConfigurationService {
  private readonly mutations: DirectoryMutations;
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly deps: McpConfigurationDeps) { this.mutations = new DirectoryMutations(deps.workspaces); }
  private active(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The MCP configuration service is closed'); }
  private track<T>(action: () => Promise<T>): Promise<T> {
    try { this.active(); } catch (error) { return Promise.reject(error); }
    const pending = action(); this.pending.add(pending); return pending.finally(() => { this.pending.delete(pending); });
  }
  private async request(method: string, params: Json): Promise<ConfigSnapshot> {
    this.active(); const reply = object(await this.deps.request(method, params));
    if (reply.error != null) throw reply.error;
    if (!record(reply.values) || typeof reply.version !== 'string') throw new Error('Invalid engine config snapshot');
    return { values: reply.values, version: reply.version };
  }
  private snapshot(): Promise<ConfigSnapshot> { return this.request('config/read', {}); }
  private write(snapshot: ConfigSnapshot, edits: JsonObject[]): Promise<ConfigSnapshot> {
    return this.request('config/batchWrite', { edits, expectedVersion: snapshot.version });
  }
  private async refresh(cwd?: string): Promise<void> { try { await this.deps.onChanged(cwd); } catch (error) { throw new SavedConfigurationError(error); } }
  private run<T>(action: () => Promise<T>, roots?: () => Promise<string[]>): Promise<T> {
    return this.track(() => this.mutations.run(action, roots));
  }
  private cwd(value: unknown, registered = false): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('no project workdir');
    if (value.includes('\0') || value.startsWith('ssh://') || !isAbsolute(value)) throw new Error('invalid project workdir');
    const cwd = resolve(value);
    if (registered && !registeredRoots(this.deps.workspaces).includes(cwd)) throw new Error('unknown project workdir');
    return cwd;
  }
  private async project(cwd: string): Promise<JsonObject> {
    const path = await managedPath(cwd, '.klaus/mcp.json');
    try {
      const raw = await optionalDocument(path); if (raw === undefined) return {};
      const parsed: unknown = JSON.parse(raw); if (!record(parsed)) throw new Error('Invalid project MCP document');
      return table(parsed.mcpServers, 'mcpServers');
    } catch (error) { this.deps.diagnostic?.(path, error); throw error; }
  }
  private localProject(values: JsonObject, cwd: string): { key: string; entry: JsonObject; aliases: string[] } {
    const projects = table(values.projects, 'projects'), aliases = Object.keys(projects).filter(key => resolve(key) === cwd);
    const key = aliases[0] ?? cwd;
    return { key, aliases, entry: table(projects[key], 'project entry') };
  }
  private local(values: JsonObject, cwd: string): JsonObject { return table(this.localProject(values, cwd).entry.mcpServers, 'local mcpServers'); }
  list(): Promise<Json> { return this.track(async () => rows(table((await this.snapshot()).values.mcpServers, 'mcpServers'), true)); }
  installBuiltin(id: string, entry: JsonObject, environment: JsonObject, signal?: AbortSignal): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      try {
        signal?.throwIfAborted();
        if (!validServerName(id) || id.length > 128 || entry.id !== id) throw new Error('Invalid builtin MCP identity');
        const snapshot = await this.snapshot(), servers = table(snapshot.values.mcpServers, 'mcpServers');
        signal?.throwIfAborted();
        own(servers, id, installBuiltinEntry(id, Object.hasOwn(servers, id) ? servers[id] : undefined, entry, environment));
        await this.write(snapshot, [{ keyPath: 'mcpServers', value: servers, mergeStrategy: 'replace' }]);
        await this.refresh(); return { ok: true };
      } catch (error) { return failed(error); }
    }).catch((error): Json => failed(error));
  }
  create(payload: JsonObject): Promise<Json> {
    const name = string(payload.name);
    return this.run(async (): Promise<Json> => {
      try {
        if (!name) throw new Error('name is required'); if (!validServerName(name)) throw new Error(NAME_ERROR);
        const snapshot = await this.snapshot(), servers = table(snapshot.values.mcpServers, 'mcpServers');
        if (Object.hasOwn(servers, name)) throw new Error('MCP server "' + name + '" already exists');
        own(servers, name, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'name')));
        await this.write(snapshot, [{ keyPath: 'mcpServers', value: servers, mergeStrategy: 'replace' }]);
        await this.refresh(); return { ok: true, name };
      } catch (error) { return { ...failed(error), name }; }
    }).catch((error): Json => ({ ...failed(error), name }));
  }
  private edit(payload: JsonObject, transform: (entry: Json, servers: JsonObject, name: string) => void): Promise<Json> {
    return this.run(async () => {
      const name = string(payload.name), snapshot = await this.snapshot(), servers = table(snapshot.values.mcpServers, 'mcpServers');
      if (!Object.hasOwn(servers, name)) throw missingServer(name);
      transform(servers[name]!, servers, name);
      await this.write(snapshot, [{ keyPath: 'mcpServers', value: servers, mergeStrategy: 'replace' }]); await this.refresh(); return { ok: true };
    }).catch(failed);
  }
  update(payload: JsonObject): Promise<Json> {
    return this.edit(payload, (previous, servers, name) => { const next = structuredClone(payload.config === undefined ? {} : payload.config); carryEnabled(previous, next); own(servers, name, next); });
  }
  toggle(payload: JsonObject): Promise<Json> {
    if (typeof payload.enabled !== 'boolean') return Promise.resolve(failed('enabled must be a boolean'));
    return this.edit(payload, entry => { if (!record(entry)) throw new Error('Invalid MCP server object'); setEnabled(entry, payload.enabled === true); });
  }
  setToolEnabled(payload: JsonObject): Promise<Json> {
    if (!string(payload.toolName)) return Promise.resolve(failed('toolName is required'));
    if (typeof payload.enabled !== 'boolean') return Promise.resolve(failed('enabled must be a boolean'));
    return this.edit(payload, entry => { if (!record(entry)) throw new Error('Invalid MCP server object'); setToolEnabled(entry, string(payload.toolName), payload.enabled === true); });
  }
  remove(payload: JsonObject): Promise<Json> {
    return this.edit(payload, (_, servers, name) => { delete servers[name]; }).then(result => {
      if (object(result).saved === true) throw new IpcHandlerError('MCP_RELOAD_FAILED', string(object(result).error)); return object(result).ok === true;
    });
  }
  importJson(payload: JsonObject): Promise<Json> {
    const imported: string[] = [];
    return this.run(async () => {
      let parsed: unknown; try { parsed = JSON.parse(string(payload.json)); } catch { return { ok: false, imported: [], errors: ['Invalid JSON'] }; }
      const candidates = record(parsed) && Object.hasOwn(parsed, 'mcpServers') ? parsed.mcpServers : parsed;
      if (!record(candidates)) return { ok: false, imported: [], errors: ['Expected mcpServers object'] };
      const snapshot = await this.snapshot(), servers = table(snapshot.values.mcpServers, 'mcpServers'), errors: string[] = [];
      for (const [name, config] of Object.entries(candidates)) {
        if (!validServerName(name)) errors.push(name + ': invalid name');
        else if (Object.hasOwn(servers, name)) errors.push(name + ': already exists');
        else { own(servers, name, config); imported.push(name); }
      }
      if (imported.length) { await this.write(snapshot, [{ keyPath: 'mcpServers', value: servers, mergeStrategy: 'replace' }]); await this.refresh(); }
      return { ok: !errors.length, imported, errors };
    }).catch(error => ({ ok: false, imported: error instanceof SavedConfigurationError ? imported : [], errors: [errorMessage(error)], ...(error instanceof SavedConfigurationError ? { saved: true, reloadRequired: true } : {}) }));
  }
  scopeList(scope: Scope, payload: JsonObject): Promise<Json> {
    if (payload.cwd === undefined || payload.cwd === null || payload.cwd === '') return Promise.resolve([]);
    return this.track(async () => {
      const workspace = string(payload.workspaceId).trim();
      if (workspace) {
        // A workspace tab spans every member folder's project config; `root`
        // tells the page which folder declared each server.
        const out: JsonObject[] = [];
        for (const root of this.deps.workspaces.workspaceRoots(workspace)) {
          const cwd = this.cwd(root);
          const servers = scope === 'project' ? await this.project(cwd) : this.local((await this.snapshot()).values, cwd);
          for (const row of rows(servers)) if (!out.some(existing => string(existing.name) === string(row.name))) out.push({ ...row, root: cwd });
        }
        return out;
      }
      const cwd = this.cwd(payload.cwd);
      return rows(scope === 'project' ? await this.project(cwd) : this.local((await this.snapshot()).values, cwd));
    });
  }
  scopeMutate(scope: Scope, mutation: Mutation, payload: JsonObject): Promise<Json> {
    let cwd = '';
    return this.run(async () => {
      const name = string(payload.name), config = structuredClone(payload.config === undefined ? {} : payload.config);
      if (mutation === 'create') { if (!name) throw new Error('name is required'); if (!validServerName(name)) throw new Error(NAME_ERROR); }
      if (mutation === 'toggle' && typeof payload.enabled !== 'boolean') throw new Error('enabled must be a boolean');
      // A workspace-scoped mutation writes the group's primary folder, the same
      // root its sessions resolve their project config from.
      const workspace = string(payload.workspaceId).trim();
      if (workspace && !string(payload.cwd).trim()) {
        const primary = this.deps.workspaces.workspaceRoots(workspace)[0];
        if (!primary) throw new Error('unknown workspace');
        payload = { ...payload, cwd: primary };
      }
      const snapshot = scope === 'local' ? await this.snapshot() : undefined;
      const servers = snapshot ? this.local(snapshot.values, cwd) : await this.project(cwd);
      const present = Object.hasOwn(servers, name);
      if (mutation === 'create' && present) throw new Error('MCP server "' + name + '" already exists');
      if (mutation !== 'create' && !present) throw missingServer(name);
      if (mutation !== 'remove' && mutation !== 'toggle' && scope === 'local' && !serverConfig(name, config)) throw new Error('invalid MCP server "' + name + '": need a "command" (stdio) or "url" (http/sse) field');
      if (mutation === 'remove') delete servers[name];
      else if (mutation === 'toggle') {
        if (!record(servers[name])) throw new Error('Invalid MCP server object');
        setEnabled(servers[name] as JsonObject, payload.enabled === true);
      }
      else { if (mutation === 'update') carryEnabled(servers[name], config); own(servers, name, config); }
      if (snapshot) {
        const project = this.localProject(snapshot.values, cwd);
        if (project.aliases.length > 1) throw new Error('Duplicate local project keys resolve to the same directory');
        const edits: JsonObject[] = [];
        if (project.key !== cwd) {
          edits.push({ keyPath: 'projects.' + quote(project.key), value: null, mergeStrategy: 'delete' });
          edits.push({ keyPath: 'projects.' + quote(cwd), value: { ...project.entry, mcpServers: servers }, mergeStrategy: 'replace' });
        } else edits.push({ keyPath: 'projects.' + quote(cwd) + '.mcpServers', value: servers, mergeStrategy: 'replace' });
        await this.write(snapshot, edits);
      } else await atomicDocument(cwd, '.klaus/mcp.json', JSON.stringify({ mcpServers: servers }, null, 2));
      await this.refresh(cwd); return { ok: true };
    }, async () => { cwd = this.cwd(payload.cwd, true); await managedPath(cwd, '.klaus/mcp.json'); return [cwd, this.deps.workspaces.configRoot]; }).catch(failed);
  }
  sessionStatus(payload: JsonObject): Promise<Json> {
    return this.track(async () => {
      const workspace = string(payload.workspaceId).trim();
      let cwd = string(payload.cwd);
      if (!cwd && !workspace && string(payload.sessionId)) {
        if (!this.deps.resolveCwd) throw new Error('MCP session cwd resolver is unavailable');
        cwd = await this.deps.resolveCwd(string(payload.sessionId));
      }
      const extra = cwd && string(payload.sessionId) ? this.deps.workspaces.extraRoots(string(payload.sessionId)) : [];
      if (cwd) cwd = this.cwd(cwd);
      const roots = workspace ? this.deps.workspaces.workspaceRoots(workspace) : cwd ? [cwd, ...extra] : [];
      const values = (await this.snapshot()).values, user = table(values.mcpServers, 'mcpServers');
      const project = roots.length ? await this.mergedProject(roots) : {};
      const local = roots.length ? this.local(values, roots[0]!) : {};
      return [['user', user], ['project', project], ['local', local]].flatMap(([scope, servers]) => Object.entries(servers!).map(([name, config]) => ({
        name, scope, status: 'declared', enabled: enabled(config), transport: serverConfig(name, config)?.transport ?? 'invalid',
      }))) as Json;
    });
  }
  resolvedServerSet(cwd: string, configValues?: JsonObject, extraRoots: string[] = []): Promise<McpDeclarations> {
    return this.track(async () => {
      if (cwd) cwd = this.cwd(cwd);
      const values = configValues ?? (await this.snapshot()).values;
      const project = cwd ? await this.mergedProject([cwd, ...extraRoots]) : {};
      return resolveServerTables(table(values.mcpServers, 'mcpServers'), project, cwd ? this.local(values, cwd) : {});
    });
  }
  /** Project tables of every root the session spans; later member folders override earlier ones. A broken member file cannot hide the others, but the session's own root failing is authoritative. */
  private async mergedProject(roots: string[]): Promise<JsonObject> {
    const merged: JsonObject = {};
    for (const [index, root] of roots.entries()) {
      if (!root || root.startsWith('ssh://')) continue;
      try { Object.assign(merged, await this.project(this.cwd(root))); }
      catch (error) { if (index === 0) throw error; /* An unreadable member folder contributes nothing. */ }
    }
    return merged;
  }
  /** Explicit authorization uses the selected declaration even when that server is disabled. */
  oauthServerConfig(name: string, cwd: string, extraRoots: string[] = []): Promise<JsonObject | undefined> {
    return this.track(async () => {
      if (cwd) cwd = this.cwd(cwd);
      const values = (await this.snapshot()).values;
      let raw: Json | undefined;
      for (const source of [table(values.mcpServers, 'mcpServers'), cwd ? await this.mergedProject([cwd, ...extraRoots]) : {}, cwd ? this.local(values, cwd) : {}]) if (Object.hasOwn(source, name)) raw = source[name];
      const parsed = serverConfig(name, raw);
      return parsed && ['http', 'sse'].includes(string(parsed.transport)) ? parsed : undefined;
    });
  }
  async close(): Promise<void> { this.closed = true; await this.mutations.close(); await Promise.allSettled([...this.pending]); }
}
