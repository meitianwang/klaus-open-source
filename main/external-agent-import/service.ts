import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Json } from '../ipc/contract';
import { checkCancelled } from '../services/download';
import { EscapedLinkError, PendingAcquisitions, UnreadableSourceError, copyExtensionTree } from '../services/extensions/acquisition';
import { DirectoryMutations } from '../services/extensions/directory-mutations';
import { managedPath } from '../services/extensions/file-store';
import type { HookStyleService } from '../services/extensions/hooks-styles';
import type { SkillService } from '../services/extensions/skills';
import type { PluginService } from '../services/extensions/plugins';
import type { McpConfigurationService } from '../services/mcp/configuration';
import { bindSessionWorkdir } from '../services/session-store';
import { errorMessage, object, string, type EngineRequest, type JsonObject } from '../services/service-types';
import type { WorkspaceStore } from '../services/workspaces';
import { ExternalImportCatalog, type CatalogOptions } from './catalog';
import { directory, present, unique } from './files';
import type { ExternalProvider } from './providers';
import { discoverSkills } from './skills';
import { loadImportLedger, recordCompletedImport } from './ledger';
import { readExternalTranscript, importedThreadId, sourceTitles } from './transcripts';

export interface ExternalAgentImportDeps extends Omit<CatalogOptions, 'configRoot'> {
  workspaces: WorkspaceStore;
  request: EngineRequest;
  skills: Pick<SkillService, 'withMutation'>;
  hooks: Pick<HookStyleService, 'withMutation'>;
  mcp: Pick<McpConfigurationService, 'importJson' | 'scopeList' | 'scopeMutate'>;
  plugins: Pick<PluginService, 'install' | 'toggle'>;
  onChanged: () => void | Promise<void>;
}
const record = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Converts ecosystem files into named engine requests; it never writes an engine rollout or plugin ledger. */
export class ExternalAgentImportService {
  readonly catalog: ExternalImportCatalog;
  private readonly pending = new PendingAcquisitions();
  private readonly mutations: DirectoryMutations;
  constructor(private readonly deps: ExternalAgentImportDeps) {
    this.catalog = new ExternalImportCatalog({ ...deps, configRoot: deps.workspaces.configRoot, knownProjects: () => deps.workspaces.registeredProjectRoots() });
    this.mutations = new DirectoryMutations(deps.workspaces);
  }
  detect(payload: JsonObject): Promise<Json> { return this.pending.run(signal => this.catalog.detect(payload, signal)); }
  private async request(method: string, params: Json): Promise<JsonObject> {
    const reply = await this.deps.request(method, params);
    if (!record(reply)) throw new Error('Invalid engine reply: ' + method);
    if (reply.error != null) throw reply.error; return reply;
  }
  private async cwd(raw: unknown): Promise<string | undefined> {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const path = await directory(raw); if (!path) throw new Error('The import project must be an existing absolute directory');
    const allowed = [...this.catalog.approvedProjects, ...this.deps.workspaces.scopeRoots()];
    if (!allowed.includes(path)) throw new Error('Detect or register the project before importing into it');
    return path;
  }
  private async copySkills(provider: ExternalProvider, cwd: string | undefined, signal: AbortSignal, saved: () => void, skipped: (message: string) => void): Promise<void> {
    return this.deps.skills.withMutation(async () => {
      const targetRoot = cwd ?? this.deps.workspaces.configRoot, prefix = cwd ? '.klaus/' : '';
      const found = await discoverSkills(provider, this.deps.home, cwd, this.deps.workspaces.registeredProjectRoots(), signal);
      for (const message of found.skipped) skipped(message);
      for (const skill of found.skills) {
        try {
          checkCancelled(signal);
          const targetRelative = prefix + 'skills/' + skill.folder, target = await managedPath(targetRoot, targetRelative, true);
          if (await present(target)) { skipped(provider.name + ' skills/' + skill.folder + ': destination already exists'); continue; }
          const stage = await mkdtemp(join(dirname(target), '.external-import-'));
          try {
            const copy = join(stage, 'content');
            await copyExtensionTree(skill.source, copy, signal);
            checkCancelled(signal); await managedPath(targetRoot, targetRelative);
            if (await present(target)) { skipped(provider.name + ' skills/' + skill.folder + ': destination already exists'); continue; }
            await rename(copy, target);
            saved();
          } finally { await rm(stage, { recursive: true, force: true }); }
        } catch (error) {
          checkCancelled(signal);
          if (error instanceof EscapedLinkError || error instanceof UnreadableSourceError) skipped(provider.name + ' skills/' + skill.folder + ': ' + error.message);
          else throw error;
        }
      }
    });
  }
  status(): Promise<Json> {
    return this.pending.run(async () => { const rows = await loadImportLedger(this.deps.workspaces.configRoot); return { importedSessionCount: rows.length, latestImportedAtMs: rows.length ? Math.max(...rows.map(row => row.imported_at)) * 1000 : null }; });
  }
  private async sessions(provider: ExternalProvider, details: JsonObject, signal: AbortSignal, projectRoots: Set<string>, saved: (count: number) => void, failed: (error: unknown) => void): Promise<void> {
    const selected = Array.isArray(details.sessions) ? details.sessions : [];
    if (selected.length > 200) throw new Error('Too many selected external sessions');
    const titles = await sourceTitles(provider, this.deps.home, signal);
    for (const row of selected) {
      try {
        checkCancelled(signal); const path = string(object(row).path);
        const parsed = await readExternalTranscript(provider, path, { ...this.catalog.options, providers: this.catalog.providers, knownProjects: this.deps.workspaces.registeredProjectRoots(), titles }, signal);
        const hash = createHash('sha256').update(parsed.bytes).digest('hex'), threadId = importedThreadId(parsed.path, hash), rows = await loadImportLedger(this.deps.workspaces.configRoot);
        // Legacy records prove a past compatibility-file import, not a current engine rollout.
        if (rows.some(row => row.source_path === parsed.path && row.content_sha256 === hash && row.engine_import === true && row.imported_thread_id === threadId)) continue;
        const cwd = parsed.project ?? await managedPath(this.deps.workspaces.configRoot, 'sessions/' + threadId, true);
        if (!parsed.project) await mkdir(cwd, { recursive: true, mode: 0o700 });
        const params: JsonObject = { threadId, cwd, ...(parsed.title ? { title: parsed.title } : {}),
          source: { providerId: provider.id, format: provider.format!, path: parsed.path, contentSha256: hash }, messages: parsed.messages as unknown as Json,
          hostMetadata: { externalImport: { providerId: provider.id, projectless: !parsed.project,
            ...(parsed.sourceCwd ? { sourceCwd: parsed.sourceCwd } : {}), ...(parsed.sourceSessionId ? { sourceSessionId: parsed.sourceSessionId } : {}) } } };
        if (Buffer.byteLength(JSON.stringify(params)) > 16 * 1024 ** 2) throw new Error('Normalized external session exceeds the engine request limit');
        checkCancelled(signal);
        // A lost reply leaves no host receipt. A retry resends the exact identity/content for engine idempotency.
        const reply = await this.deps.workspaces.withDirectoryOperation(async () => [cwd], () => this.request('engine/importExternalSession', params));
        if (reply.threadId !== threadId || reply.persisted !== true || typeof reply.alreadyImported !== 'boolean' || reply.messageCount !== parsed.messages.length) throw new Error('The engine did not confirm external session persistence');
        saved(1);
        if (parsed.project) { bindSessionWorkdir(threadId, cwd, this.deps.workspaces.configRoot); projectRoots.add(parsed.project); }
        await recordCompletedImport(this.deps.workspaces.configRoot, { source_path: parsed.path, content_sha256: hash, imported_thread_id: threadId,
          imported_at: Math.floor((this.deps.now ?? Date.now)() / 1000), source_modified_at: parsed.sourceModifiedAtMs, ...(parsed.title ? { title: parsed.title } : {}), engine_import: true });
      } catch (error) { failed(error); if (signal.aborted) break; }
    }
  }
  import(payload: JsonObject): Promise<Json> {
    return this.pending.run(signal => this.mutations.run(async () => {
      const imported: JsonObject = {}, errors: string[] = [], skipped: string[] = [], projectRoots = new Set<string>(); let mcpChanged = false;
      const add = (type: string, count: number): void => { if (count) Object.defineProperty(imported, type, { value: Number(imported[type] ?? 0) + count, enumerable: true, configurable: true, writable: true }); };
      const items = payload.items;
      if (!Array.isArray(items) || items.length > 1000) return { ok: false, imported, errors: ['An array of at most 1000 import items is required'], skipped, projectRoots: [], changed: false, mcpChanged: false };
      for (const raw of items) {
        const item = object(raw), type = string(item.itemType);
        try {
          checkCancelled(signal); const provider = this.catalog.provider(string(item.providerId)), cwd = await this.cwd(item.cwd), details = object(item.details);
          if (type === 'CONFIG') throw new Error('No supported cross-client settings conversion for ' + provider.name);
          else if (type === 'HOOKS') throw new Error('No supported cross-client hook conversion for ' + provider.name);
          else if (['COMMANDS', 'SUBAGENTS', 'AGENTS_MD', 'PLUGINS'].includes(type)) throw new Error('No verified source-to-Klaus adapter for ' + type + ' from ' + provider.name);
          else if (type === 'SKILLS') await this.copySkills(provider, cwd, signal, () => add(type, 1), message => skipped.push(message));
          else if (type === 'MCP_SERVER_CONFIG') {
            const source = await this.catalog.mcpSource(provider, cwd, signal, true);
            if (provider.id === 'codex' && cwd && !source.path) throw new Error('Codex project MCP requires a trusted, registered project');
            if (!source.path) throw new Error('No supported MCP configuration found for ' + provider.name);
            const servers = source.servers;
            if (!Object.keys(servers).length) throw new Error('No supported MCP servers found for ' + provider.name);
            if (cwd) {
              const current = await this.deps.mcp.scopeList('project', { cwd });
              if (!Array.isArray(current)) throw new Error(errorMessage(object(current).error) || 'Project MCP scope is unavailable');
              const existing = new Set(current.map(row => string(object(row).name)));
              let count = 0;
              for (const [name, config] of Object.entries(servers)) {
                if (existing.has(name)) continue;
                const result = object(await this.deps.mcp.scopeMutate('project', 'create', { cwd, name, config }));
                if (result.ok === true) { count++; existing.add(name); }
                else errors.push(provider.name + ' MCP ' + name + ': ' + errorMessage(result.error));
              }
              if (count) { add(type, 1); mcpChanged = true; }
            } else {
              const result = object(await this.deps.mcp.importJson({ json: JSON.stringify({ mcpServers: servers }) }));
              if (!Array.isArray(result.imported) || !Array.isArray(result.errors) || typeof result.ok !== 'boolean') throw new Error('Invalid MCP import result');
              if (result.imported.length) { add(type, 1); mcpChanged = true; }
              if (result.ok === false) errors.push(...result.errors.map(error => provider.name + ' MCP: ' + errorMessage(error)));
            }
          } else if (type === 'PROJECTS') {
            const roots = Array.isArray(details.projectRoots) ? details.projectRoots : [];
            const registered = new Set(this.deps.workspaces.registeredProjectRoots());
            for (const value of unique(roots.filter((value): value is string => typeof value === 'string'))) {
              const root = await this.cwd(value); if (!root) continue;
              projectRoots.add(root);
              if (registered.has(root)) continue;
              const added = object(this.deps.workspaces.projectsAdd({ path: root }));
              if (added.error) throw new Error(errorMessage(added.error));
              registered.add(root); add(type, 1);
            }
          } else if (type === 'SESSIONS') await this.sessions(provider, details, signal, projectRoots, count => add(type, count), error => errors.push(provider.name + ' session: ' + errorMessage(error)));
          else throw new Error('Unsupported import item: ' + type);
        } catch (error) { errors.push(string(item.providerId) + ' ' + type + ': ' + errorMessage(error)); if (signal.aborted) break; }
      }
      const changed = Object.keys(imported).length > 0;
      if (changed) try { await this.deps.onChanged(); } catch (error) { errors.push('Imported content was saved, but reloading failed: ' + errorMessage(error)); }
      return { ok: !errors.length, imported, errors, skipped, projectRoots: [...projectRoots].sort(), changed, mcpChanged };
    }, async () => [this.deps.workspaces.configRoot, ...await Promise.all((Array.isArray(payload.items) ? payload.items : []).map(item => this.cwd(object(item).cwd))).then(paths => paths.filter((path): path is string => Boolean(path)))]));
  }
  async close(): Promise<void> { this.pending.abort(); await this.mutations.close(); await this.pending.close(); }
}
