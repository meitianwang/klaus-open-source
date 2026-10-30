import { stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Json } from '../../ipc/contract';
import { errorMessage, object, string, type EngineRequest, type JsonObject } from '../service-types';
import type { WorkspaceStore } from '../workspaces';
import { atomicDocument, directoryNames, managedPath, missing, optionalDocument, readDocument } from './file-store';
import { frontmatter, parseManagedCommand, serializeManagedCommand, toolList } from './frontmatter';
import { ExtensionDiscovery, type DiscoveryDeps } from './discovery';
import { DirectoryMutations } from './directory-mutations';

export interface FileExtensionDeps extends Omit<DiscoveryDeps, 'configRoot'> {
  configRoot?: string;
  workspaces: WorkspaceStore;
  trashPath: (path: string) => Promise<void>;
  onChanged: (kind: 'commands' | 'agents', projectRoot?: string) => Promise<void>;
  resolveCommandSession?: (sessionId: string) => Promise<string>;
  commandPromptRows?: (sessionId: string, cwd: string) => JsonObject[];
  prepareCommandRefresh?: () => Promise<void>;
  /** Engine facade access for rosters the binary owns (built-in agents). */
  request?: EngineRequest;
}
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'];
function commandName(raw: unknown): string {
  const value = string(raw).trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) throw new Error('Invalid command name: ' + JSON.stringify(string(raw)) + ' (expected /^[a-z0-9][a-z0-9_-]{0,63}$/i)');
  return value;
}
function agentId(raw: unknown): string {
  const value = string(raw).trim().replace(/(?:\.md)+$/, '');
  if (!value || value.includes('\0') || /[/\\]/.test(value) || value === '.' || value === '..' || Buffer.byteLength(value) > 160) throw new Error('invalid agent file');
  return value;
}
function validateAgent(content: string, reservedNames: ReadonlySet<string>): string {
  if (!content.trim()) throw new Error('empty content');
  if (Buffer.byteLength(content) > 256 * 1024) throw new Error('agent file is too large');
  const { data, body } = frontmatter(content), name = string(data.name).trim();
  if (!name) throw new Error('missing frontmatter name');
  if (!/^[A-Za-z0-9][\w:.@-]{0,119}$/.test(name)) throw new Error('invalid agent name');
  // A user definition may never take a built-in agent's name: the roster has no
  // override state to show, so the collision is refused at creation time instead.
  if (reservedNames.has(name)) throw new Error(`agent name "${name}" is reserved by a built-in agent`);
  if (!string(data.description).trim()) throw new Error('missing frontmatter description');
  if (!body.trim()) throw new Error('missing agent prompt'); return name;
}
function listedAgentTools(value: unknown): string[] | undefined {
  const tools = toolList(value, 'comma');
  if (tools?.length === 1 && tools[0] === '*') return undefined;
  if (tools !== undefined) return tools;
  // `tools: []` is an explicit no-tools policy. Keep it distinct from an
  // omitted tools field, which inherits the complete parent tool set.
  return Array.isArray(value) ? [] : undefined;
}
function agentRow(raw: string, path: string, fileName: string, baseDir: string): JsonObject | undefined {
  const { data } = frontmatter(raw), name = string(data.name);
  if (!name) return undefined;
  if (!string(data.description)) throw new Error('Missing required "description" field in frontmatter');
  const id = fileName.slice(0, -3);
  const row: JsonObject = { agentType: name, whenToUse: string(data.description).replace(/\\n/g, '\n'), source: 'userSettings', baseDir, filename: id, filePath: path, editableId: id, skills: toolList(data.skills, 'comma') ?? [] };
  const color = string(data.color); if (['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'].includes(color)) row.color = color;
  const model = string(data.model).trim(); if (model) row.model = model.toLowerCase() === 'inherit' ? 'inherit' : model;
  const tools = listedAgentTools(data.tools); if (tools !== undefined) row.tools = tools;
  const denied = toolList(data.disallowedTools ?? data['disallowed-tools'], 'comma'); if (denied) row.disallowedTools = denied;
  const effort = data.effort;
  if ((typeof effort === 'string' && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort.trim())) || (typeof effort === 'number' && Number.isSafeInteger(effort))) row.effort = typeof effort === 'string' ? effort.trim() : effort;
  if (PERMISSION_MODES.includes(string(data.permissionMode))) row.permissionMode = data.permissionMode!;
  const turns = typeof data.maxTurns === 'number' ? data.maxTurns : /^[+-]?\d+$/.test(string(data.maxTurns).trim()) ? Number(data.maxTurns) : NaN;
  if (Number.isSafeInteger(turns) && turns > 0) row.maxTurns = turns;
  if (data.background === true || data.background === 'true') row.background = true;
  if (['user', 'project', 'local'].includes(string(data.memory))) row.memory = data.memory!;
  if (data.isolation === 'worktree') row.isolation = 'worktree'; return row;
}

/** File-backed editor writes settle only after their live-session invalidation hook. */
export class FileExtensionService {
  readonly configRoot: string;
  readonly discovery: ExtensionDiscovery;
  private readonly mutations: DirectoryMutations;
  private closed = false;
  constructor(private readonly deps: FileExtensionDeps) {
    this.configRoot = deps.workspaces.configRoot;
    if (deps.configRoot !== undefined && deps.configRoot !== this.configRoot) throw new Error('Extension and workspace config roots must match');
    this.mutations = new DirectoryMutations(deps.workspaces);
    this.discovery = new ExtensionDiscovery({ ...deps, configRoot: this.configRoot, skillPreviewRoots: () => deps.workspaces.scopeRoots() });
  }
  private async run(operation: () => Promise<Json>, mutate = false, roots?: () => Promise<string[]>): Promise<Json> {
    const execute = async () => { if (this.closed) throw new Error('The file extension service is closed'); return operation(); };
    try { return await (mutate ? this.mutations.run(execute, roots) : execute()); }
    catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  private async scope(payload: JsonObject): Promise<{ root: string; relative: string; scope: 'project' | 'global'; projectRoot?: string }> {
    if (payload.scope !== 'project') return { root: this.configRoot, relative: 'commands', scope: 'global' };
    // A workspace-scoped write lands in the group's primary folder: that is the
    // cwd every session of the workspace runs in, so `<root>/.klaus/commands`
    // is where its engine actually discovers the command.
    const workspaceId = string(payload.workspaceId).trim();
    const raw = string(payload.projectRoot).trim() || (workspaceId ? this.deps.workspaces.workspaceRoots(workspaceId)[0] ?? '' : '');
    if (!raw || raw.includes('\0') || raw.startsWith('ssh://')) throw new Error('Project scope requires an absolute projectRoot');
    const root = resolve(raw);
    try { if (!(await stat(root)).isDirectory()) throw new Error('Project root is not a directory: ' + root); }
    catch (error) { if (missing(error)) throw new Error('Project root does not exist: ' + root); throw error; }
    return { root, relative: '.klaus/commands', scope: 'project', projectRoot: root };
  }
  slashCommands(payload: JsonObject): Promise<Json> {
    const id = string(payload.sessionId).trim(), explicit = string(payload.root).trim();
    let cwd = '';
    return this.run(() => this.discovery.slashCommands(cwd, id ? this.deps.commandPromptRows?.(id, cwd) : [], id ? this.deps.workspaces.sessionRoots(id).slice(1) : []), true, async () => {
      if (payload.forceReload === true) this.discovery.invalidateSkills();
      if (explicit && (!isAbsolute(explicit) || explicit.includes('\0'))) throw new Error('Slash command root must be an absolute local directory');
      cwd = explicit || (id ? await this.deps.resolveCommandSession?.(id) ?? this.deps.workspaces.resolveSessionDirectory(id) : join(this.configRoot, 'sessions', '__klaus__'));
      return [cwd, this.configRoot];
    });
  }
  refreshCommands(): Promise<Json> {
    return this.run(async () => { this.discovery.invalidateSkills(); await this.deps.prepareCommandRefresh?.(); await this.deps.onChanged('commands'); return { ok: true }; }, true);
  }
  commandsList(payload: JsonObject): Promise<Json> {
    return this.run(async () => {
      const scopes = [await this.scope({})];
      // A workspace tab lists every member folder's commands: each root is a
      // real project directory with its own `.klaus/commands`, and `root`
      // tells the page which folder a row came from.
      const workspaceRoots = string(payload.workspaceId).trim() ? this.deps.workspaces.workspaceRoots(string(payload.workspaceId).trim()) : [];
      if (workspaceRoots.length) {
        for (const root of workspaceRoots) try { scopes.push(await this.scope({ scope: 'project', projectRoot: root })); } catch { /* An unavailable member folder does not hide the others. */ }
      } else if (string(payload.projectRoot).trim()) try { scopes.unshift(await this.scope({ ...payload, scope: 'project' })); } catch { /* An unavailable project does not hide global commands. */ }
      const commands: JsonObject[] = [];
      const seenProjectNames = new Set<string>();
      for (const scope of scopes) {
        const dir = await managedPath(scope.root, scope.relative);
        for (const file of await directoryNames(dir)) {
          if (!file.endsWith('.md') || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(file.slice(0, -3))) continue;
          const name = file.slice(0, -3);
          // Member folders of one workspace share a tab; a name present in
          // several of them is one command, owned by the earliest folder.
          if (scope.scope === 'project') { if (seenProjectNames.has(name)) continue; seenProjectNames.add(name); }
          const path = await managedPath(scope.root, join(scope.relative, file));
          let raw: string; try { raw = await readDocument(path); } catch (error) { this.deps.diagnostic?.(path, error); continue; }
          const parsed = parseManagedCommand(raw);
          commands.push({ name, description: parsed.description, argumentHint: parsed.argumentHint, body: parsed.body, filePath: path, scope: scope.scope, ...(scope.projectRoot ? { root: scope.projectRoot } : {}) });
        }
      }
      return { ok: true, commands };
    });
  }
  commandsSave(payload: JsonObject): Promise<Json> {
    let scope!: Awaited<ReturnType<FileExtensionService['scope']>>;
    return this.run(async () => {
      const name = commandName(payload.name);
      const original = string(payload.originalName).trim() ? commandName(payload.originalName) : name;
      const from = await managedPath(scope.root, join(scope.relative, original + '.md'));
      const previous = await optionalDocument(from);
      const command = { description: string(payload.description).trim(), argumentHint: string(payload.argumentHint).trim(), body: string(payload.body), extra: previous === undefined ? [] : parseManagedCommand(previous).extra };
      const path = await atomicDocument(scope.root, join(scope.relative, name + '.md'), serializeManagedCommand(command), original !== name);
      if (original !== name && previous !== undefined) await unlink(from);
      await this.deps.onChanged('commands', scope.projectRoot);
      return { ok: true, command: { name, description: command.description, argumentHint: command.argumentHint, body: command.body, filePath: path, scope: scope.scope } };
    }, true, async () => { scope = await this.scope(payload); return [scope.root]; });
  }
  commandsDelete(payload: JsonObject): Promise<Json> {
    let scope!: Awaited<ReturnType<FileExtensionService['scope']>>;
    return this.run(async () => {
      const name = commandName(payload.name), path = await managedPath(scope.root, join(scope.relative, name + '.md'));
      try { await unlink(path); } catch (error) { if (!missing(error)) throw error; }
      await this.deps.onChanged('commands', scope.projectRoot); return { ok: true };
    }, true, async () => { scope = await this.scope(payload); return [scope.root]; });
  }
  /** The engine's compiled built-in agent roster, projected to card rows. */
  private async builtinAgentRows(): Promise<{ rows: JsonObject[]; error: Json }> {
    if (!this.deps.request) return { rows: [], error: { message: 'engine unavailable' } };
    try {
      const reply = object(await this.deps.request('engine/builtinAgents', {}));
      if (!Array.isArray(reply.builtinAgents)) throw new Error('Invalid engine builtin agents reply');
      return {
        rows: reply.builtinAgents.map(value => {
          const row = object(value);
          const projected: JsonObject = {
            agentType: string(row.name),
            whenToUse: string(row.description),
            source: 'built-in',
          };
          if (typeof row.model === 'string' && row.model) projected.model = row.model;
          if (typeof row.effort === 'string' && row.effort) projected.effort = row.effort;
          if (Array.isArray(row.tools)) projected.tools = row.tools.map(tool => string(tool));
          if (Array.isArray(row.disallowedTools)) projected.disallowedTools = row.disallowedTools.map(tool => string(tool));
          return projected;
        }),
        error: null,
      };
    } catch (error) { return { rows: [], error: { message: errorMessage(error) } }; }
  }
  agentsList(): Promise<Json> {
    return this.run(async () => {
      const base = join(this.configRoot, 'agents'), users: JsonObject[] = [], failedFiles: JsonObject[] = [];
      for (const file of await directoryNames(await managedPath(this.configRoot, 'agents'))) {
        if (!file.endsWith('.md')) continue;
        const path = join(base, file);
        try {
          const row = agentRow(await readDocument(await managedPath(this.configRoot, join('agents', file))), path, file, base);
          if (row) users.push(row);
        } catch (error) { failedFiles.push({ path, error: errorMessage(error), editableId: file.slice(0, -3) }); }
      }
      const builtins = await this.builtinAgentRows();
      const agents = [...builtins.rows];
      users.forEach(agent => agents.push(agent));
      agents.sort((a, b) => string(a.agentType).localeCompare(string(b.agentType)));
      return { agents, failedFiles, userAgentsDir: base, builtinAgentsError: builtins.error };
    });
  }
  agentsRead(payload: JsonObject): Promise<Json> {
    return this.run(async () => {
      const id = agentId(payload.id), path = await managedPath(this.configRoot, join('agents', id + '.md'));
      try { return { ok: true, id, path, content: await readDocument(path, 256 * 1024) }; }
      catch (error) { if (missing(error)) throw new Error('file not found'); throw error; }
    });
  }
  agentsSave(payload: JsonObject): Promise<Json> {
    return this.run(async () => {
      const builtins = await this.builtinAgentRows();
      const reserved = new Set(builtins.rows.map(row => string(row.agentType)));
      const content = string(payload.content), name = validateAgent(content, reserved), given = string(payload.id).trim();
      const id = agentId(given || name.replace(/[^A-Za-z0-9._@:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'custom-agent');
      // Two user files claiming one name would leave the engine silently picking
      // one, so the second writer is refused instead of shadowing the first.
      const dir = await managedPath(this.configRoot, 'agents');
      for (const file of await directoryNames(dir)) {
        if (!file.endsWith('.md') || file.slice(0, -3) === id) continue;
        let other = '';
        try { other = string(frontmatter(await readDocument(await managedPath(this.configRoot, join('agents', file)))).data.name); } catch { continue; }
        if (other === name) throw new Error(`another agent file already defines the name "${name}"`);
      }
      let path: string;
      try { path = await atomicDocument(this.configRoot, join('agents', id + '.md'), content.trimEnd() + '\n', !given); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !given) throw new Error('agent file already exists'); throw error; }
      await this.deps.onChanged('agents'); return { ok: true, id, path };
    }, true);
  }
  agentsDelete(payload: JsonObject): Promise<Json> {
    return this.run(async () => {
      const id = agentId(payload.id), path = await managedPath(this.configRoot, join('agents', id + '.md'));
      try { await stat(path); } catch (error) { if (missing(error)) throw new Error('file not found'); throw error; }
      await this.deps.trashPath(path); await this.deps.onChanged('agents'); return { ok: true };
    }, true);
  }
  async close(): Promise<void> { this.closed = true; await this.mutations.close(); }
}
