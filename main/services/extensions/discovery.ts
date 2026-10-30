import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { Json } from '../../ipc/contract';
import { object, string, type JsonObject } from '../service-types';
import { kvGet, isFailure } from '../settings';
import { pathInside } from '../workspaces';
import { BUILTIN_SKILLS, BUNDLED_COMMANDS } from './builtins';
import { directoryNames, managedPath, optionalDocument, readDocument } from './file-store';
import { argumentNames, description, effort, fmBoolean, fmString, frontmatter, scalar, toolList } from './frontmatter';
import { hookInitFromRow, type HookRow } from './hooks-state';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'Notification', 'SubagentStart', 'Setup', 'TaskCreated', 'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove'];
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions', 'dontAsk'];
export interface DiscoveryDeps {
  configRoot: string;
  /** Read-only application skills; user and project definitions keep precedence. */
  bundledSkillRoots?: string[];
  skillPreviewRoots?: () => string[];
  pluginCommandSources?: () => Promise<string[]>;
  mcpPromptRows?: () => JsonObject[];
  diagnostic?: (path: string, error: unknown) => void;
  /** Trust gate for lifecycle hooks; absent means every declaration is inert. */
  hookTrust?: HookTrustGate;
}
/** The slice of the trust ledger session injection consults. */
export interface HookTrustGate {
  rows(scope: 'global' | 'project', filePath: string, declarations: HookDeclaration[]): Promise<HookRow[]>;
}
export interface FileCommand {
  name: string; description: string; argumentHint?: string; argumentNames: string[]; body: string;
  scope: 'project' | 'global'; source: 'commands' | 'plugin'; path: string;
}
function assign(object: JsonObject, key: string, value: Json | undefined): void { if (value !== undefined) object[key] = value; }
function skillPaths(value: unknown): string[] | undefined {
  const source = typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const parts: string[] = [];
  for (const input of source) {
    let part = '', depth = 0;
    for (const char of input) {
      if (char === '{') depth++; else if (char === '}') depth--;
      if (char === ',' && depth === 0) { if (part.trim()) parts.push(part.trim()); part = ''; } else part += char;
    }
    if (part.trim()) parts.push(part.trim());
  }
  const pending = [...parts], expanded: string[] = []; let budget = 4096;
  while (pending.length) {
    if (--budget < 0) throw new Error('Skill paths expand to too many patterns');
    const part = pending.shift()!, open = part.indexOf('{'), close = part.indexOf('}', open);
    if (open < 0 || close < 0) expanded.push(part.replace(/\/\*\*$/, ''));
    else pending.unshift(...part.slice(open + 1, close).split(',').map(value => part.slice(0, open) + value.trim() + part.slice(close + 1)));
  }
  const result = expanded.filter(Boolean); return result.length && !result.every(value => value === '**') ? result : undefined;
}
const LEGACY_AGENT_TOOL_NAMES: Record<string, string> = {
  Read: 'read',
  Glob: 'glob',
  Grep: 'grep',
};
function engineAgentTools(value: unknown): string[] | undefined {
  const tools = toolList(value, 'flat');
  if (tools?.length === 1 && tools[0] === '*') return undefined;
  if (tools !== undefined) return tools.map(tool => LEGACY_AGENT_TOOL_NAMES[tool] ?? tool);
  // The engine distinguishes an explicit empty allowlist (no tools) from a
  // missing allowlist (inherit all tools), so the host must preserve [].
  return Array.isArray(value) ? [] : undefined;
}
export function skillFromMarkdown(raw: string, path: string, fallbackName: string): JsonObject | undefined {
  const { data, body } = frontmatter(raw);
  if (data.context !== undefined && data.context !== 'inline' && data.context !== 'fork') return undefined;
  const skill: JsonObject = { name: fmString(data.name) ?? fallbackName, description: scalar(data.description)?.trim() || description(body, 'Skill') };
  assign(skill, 'whenToUse', fmString(data.when_to_use) ?? fmString(data['when-to-use']));
  assign(skill, 'argumentHint', fmString(data['argument-hint'])); assign(skill, 'allowedTools', toolList(data['allowed-tools']));
  const model = fmString(data.model); if (model !== 'inherit') assign(skill, 'model', model);
  assign(skill, 'effort', effort(data.effort)); assign(skill, 'context', data.context); assign(skill, 'agent', fmString(data.agent));
  const names = argumentNames(data.arguments); if (names.length) skill.arguments = names;
  skill.userInvocable = fmBoolean(data['user-invocable'], true); skill.disableModelInvocation = fmBoolean(data['disable-model-invocation'], false);
  assign(skill, 'paths', skillPaths(data.paths)); assign(skill, 'shell', fmString(data.shell));
  skill.body = body; skill.path = path; return skill;
}
export function agentFromMarkdown(raw: string, fileName: string): JsonObject | undefined {
  const { data, body } = frontmatter(raw), name = string(data.name).trim() || fileName.replace(/\.(?:md|MD)$/, '');
  if (!name) return undefined;
  const agent: JsonObject = { name, description: string(data.description).trim() };
  assign(agent, 'tools', engineAgentTools(data.tools ?? data['allowed-tools']));
  assign(agent, 'disallowedTools', toolList(data.disallowedTools ?? data['disallowed-tools'], 'flat'));
  if (string(data.model).trim()) agent.model = string(data.model).trim();
  const mode = string(data.permissionMode).trim(); if (PERMISSION_MODES.includes(mode)) agent.permissionMode = mode;
  assign(agent, 'effort', effort(data.effort));
  const memory = string(data.memory).trim(); if (['user', 'project', 'local'].includes(memory)) agent.memory = memory;
  if (body.trim()) agent.prompt = body.trim();
  const reminder = string(data.criticalSystemReminder).trim() || string(data['critical-system-reminder']).trim();
  if (reminder) agent.criticalSystemReminder = reminder;
  if (string(data.isolation).trim() === 'worktree') agent.isolation = 'worktree';
  const turns = typeof data.maxTurns === 'number' ? data.maxTurns : Number.parseInt(string(data.maxTurns).trim(), 10);
  if (Number.isSafeInteger(turns) && turns > 0) agent.maxTurns = turns;
  if (data.background === true || string(data.background).trim() === 'true') agent.background = true;
  return agent;
}
/** One command-hook declaration with its address in the hooks file (event + group + hook index). */
export interface HookDeclaration {
  event: string;
  groupIndex: number;
  hookIndex: number;
  command: string;
  matcher?: string;
  timeoutMs?: number;
  isAsync: boolean;
}

export function hookDeclarationsFromDocument(document: unknown): HookDeclaration[] {
  const declarations: HookDeclaration[] = [];
  for (const [event, groups] of Object.entries(object(document))) {
    if (!HOOK_EVENTS.includes(event) || !Array.isArray(groups)) continue;
    groups.forEach((item, groupIndex) => {
      const group = object(item); if (!Array.isArray(group.hooks)) return;
      group.hooks.forEach((value, hookIndex) => {
        const entry = object(value); if (entry.type !== 'command' || typeof entry.command !== 'string') return;
        const declaration: HookDeclaration = { event, groupIndex, hookIndex, command: entry.command, isAsync: entry.async === true };
        if (typeof group.matcher === 'string') declaration.matcher = group.matcher;
        if (typeof entry.timeout === 'number' && Number.isFinite(entry.timeout)) declaration.timeoutMs = Math.trunc(entry.timeout * 1000);
        declarations.push(declaration);
      });
    });
  }
  return declarations;
}

export function hooksFromDocument(document: unknown): JsonObject[] {
  return hookDeclarationsFromDocument(document).map(declaration => {
    const hook: JsonObject = { event: declaration.event, command: declaration.command };
    if (declaration.matcher !== undefined) hook.matcher = declaration.matcher;
    if (declaration.timeoutMs !== undefined) hook.timeoutMs = declaration.timeoutMs;
    if (declaration.isAsync) hook.isAsync = true;
    return hook;
  });
}

/** Reads only host-owned init declarations. Plugin command sources are UI/expansion inputs only. */
export class ExtensionDiscovery {
  private readonly skillCache = new Map<string, Promise<JsonObject[]>>();
  /** Invalidated promises are detached before a replacement scan can start. */
  invalidateSkills(): void { this.skillCache.clear(); }
  constructor(readonly deps: DiscoveryDeps) {}
  private async names(root: string, relative: string): Promise<string[]> {
    try { return await directoryNames(await managedPath(root, relative)); }
    catch (error) { this.deps.diagnostic?.(join(root, relative), error); return []; }
  }
  private async document(root: string, relative: string): Promise<string | undefined> {
    try { return await optionalDocument(await managedPath(root, relative)); }
    catch (error) { this.deps.diagnostic?.(join(root, relative), error); return undefined; }
  }
  async skills(cwd: string, includeBuiltins = true, extraRoots: string[] = [], forceReload = false): Promise<JsonObject[]> {
    const projectRoots = [...new Set([cwd, ...extraRoots].filter(root => root && !root.includes('://')).map(root => resolve(root)))];
    const key = JSON.stringify([resolve(this.deps.configRoot), projectRoots, includeBuiltins]);
    if (forceReload) this.invalidateSkills();
    let pending = this.skillCache.get(key);
    if (!pending) {
      pending = this.loadSkills(projectRoots, includeBuiltins);
      this.skillCache.set(key, pending);
      const owned = pending;
      void pending.catch(() => { if (this.skillCache.get(key) === owned) this.skillCache.delete(key); });
    }
    return structuredClone(await pending);
  }
  private async loadSkills(projectRoots: string[], includeBuiltins: boolean): Promise<JsonObject[]> {
    const result: JsonObject[] = [], seen = new Set<string>();
    for (const [root, relative] of [...projectRoots.map(root => [root, '.klaus/skills'] as const), [this.deps.configRoot, 'skills'] as const]) {
      for (const name of await this.names(root, relative)) {
        const relativePath = join(relative, name, 'SKILL.md'), raw = await this.document(root, relativePath);
        if (raw === undefined) continue;
        let skill: JsonObject | undefined;
        try { skill = skillFromMarkdown(raw, join(root, relativePath), name); }
        catch (error) { this.deps.diagnostic?.(join(root, relativePath), error); continue; }
        if (skill && !seen.has(string(skill.name))) { result.push(skill); seen.add(string(skill.name)); }
      }
    }
    if (includeBuiltins) for (const skill of [...(await this.bundledSkills()).filter(skill => this.skillEnabled(skill)), ...BUILTIN_SKILLS]) if (!seen.has(string(skill.name))) { result.push(structuredClone(skill)); seen.add(string(skill.name)); }
    return result;
  }
  async bundledSkills(): Promise<JsonObject[]> {
    const result: JsonObject[] = [];
    for (const root of this.deps.bundledSkillRoots ?? []) {
      let names: string[];
      try { names = await directoryNames(root); }
      catch (error) { this.deps.diagnostic?.(root, error); continue; }
      for (const name of names) {
        const relativePath = join(name, 'SKILL.md'), raw = await this.document(root, relativePath);
        if (raw === undefined) continue;
        try {
          const skill = skillFromMarkdown(raw, join(root, relativePath), name);
          if (skill && !result.some(row => row.name === skill.name)) result.push(skill);
        } catch (error) { this.deps.diagnostic?.(join(root, relativePath), error); }
      }
    }
    return result;
  }
  private skillEnabled(skill: JsonObject): boolean {
    const keys = new Set([string(skill.name), ...(typeof skill.path === 'string' ? [basename(dirname(skill.path))] : [])]);
    for (const key of keys) {
      const value = kvGet('skill:' + key, this.deps.configRoot);
      if (value === null || isFailure(value)) continue;
      try { if (object(JSON.parse(value)).enabled === false) return false; }
      catch { if (value === 'off') return false; }
    }
    return true;
  }
  async sessionSkills(cwd: string, extraRoots: string[] = []): Promise<JsonObject[]> {
    return (await this.skills(cwd, true, extraRoots)).filter(skill => this.skillEnabled(skill));
  }
  async agents(): Promise<JsonObject[]> {
    const result: JsonObject[] = [];
    for (const file of await this.names(this.deps.configRoot, 'agents')) {
      if (!file.endsWith('.md')) continue;
      const raw = await this.document(this.deps.configRoot, join('agents', file)); if (raw === undefined) continue;
      const agent = agentFromMarkdown(raw, file); if (agent) result.push(agent);
    }
    return result;
  }
  async commandHooks(cwd: string, extraRoots: string[] = []): Promise<JsonObject[]> {
    const declarations: Array<{ scope: 'global' | 'project'; filePath: string; items: HookDeclaration[] }> = [];
    const projectRoots = [...(cwd && !cwd.startsWith('ssh://') ? [cwd] : []), ...extraRoots.filter(root => root && !root.startsWith('ssh://'))];
    for (const [scope, root, relative] of [
      ['global', this.deps.configRoot, 'hooks.json'] as const,
      ...projectRoots.map(project => ['project', project, '.klaus/hooks.json'] as const),
    ]) {
      const raw = await this.document(root, relative); if (raw === undefined) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch (error) { this.deps.diagnostic?.(join(root, relative), error); continue; }
      try { declarations.push({ scope, filePath: join(root, relative), items: hookDeclarationsFromDocument(parsed) }); }
      catch (error) { this.deps.diagnostic?.(join(root, relative), error); }
    }
    // Trust gate: only declarations the user trusted in their
    // current form reach a session. Untrusted or changed hooks stay inert until reviewed
    // in Settings → Hooks, so a vendor updater rewriting its telemetry hooks cannot run
    // code on the strength of an old approval — or of none at all.
    const gate = this.deps.hookTrust;
    const hooks: JsonObject[] = [];
    for (const file of declarations) {
      // No gate wired (unit tests, non-desktop consumers): declarations run as declared.
      const rows = gate
        ? await gate.rows(file.scope, file.filePath, file.items)
        : file.items.map(item => ({ ...item, key: '', filePath: file.filePath, scope: file.scope, hash: '', status: 'trusted' as const }));
      for (const row of rows) if (row.status === 'trusted') hooks.push(hookInitFromRow(row));
    }
    return hooks;
  }
  async sessionExtensions(cwd: string, extraRoots: string[] = []): Promise<JsonObject> {
    const [agents, skills, commandHooks] = await Promise.all([this.agents(), this.sessionSkills(cwd, extraRoots), this.commandHooks(cwd, extraRoots)]);
    const fields: JsonObject = {};
    for (const [key, value] of Object.entries({ agents, skills, commandHooks })) if (value.length) fields[key] = value;
    return fields;
  }
  async commands(cwd: string, extraRoots: string[] = []): Promise<FileCommand[]> {
    const commands: FileCommand[] = [];
    const sources: Array<{ root: string; relative: string; scope: 'project' | 'global'; source: 'commands' | 'plugin' }> = [];
    for (const root of [...(cwd && !cwd.startsWith('ssh://') ? [cwd] : []), ...extraRoots.filter(item => item && !item.startsWith('ssh://'))]) {
      sources.push({ root, relative: '.klaus/commands', scope: 'project', source: 'commands' });
    }
    sources.push({ root: this.deps.configRoot, relative: 'commands', scope: 'global', source: 'commands' });
    for (const path of await this.deps.pluginCommandSources?.() ?? []) sources.push({ root: path, relative: '.', scope: 'global', source: 'plugin' });
    for (const source of sources) {
      const path = source.relative === '.' ? source.root : await managedPath(source.root, source.relative);
      let paths: string[];
      if (source.source === 'plugin' && extname(path).toLowerCase() === '.md') paths = [path];
      else paths = (await directoryNames(path)).filter(name => name.toLowerCase().endsWith('.md')).map(name => join(path, name));
      for (const file of paths) {
        try {
          if (source.source !== 'plugin') await managedPath(source.root, join(source.relative, basename(file)));
          const raw = await readDocument(file), { data, body } = frontmatter(raw), name = basename(file).slice(0, -3);
          if (!name) continue;
          const row: FileCommand = { name, description: scalar(data.description)?.trim() || description(body, 'Custom command'), body,
            argumentNames: argumentNames(data.arguments), scope: source.scope, source: source.source, path: file };
          if (typeof data['argument-hint'] === 'string' && data['argument-hint']) row.argumentHint = data['argument-hint'];
          commands.push(row);
        } catch (error) { this.deps.diagnostic?.(file, error); }
      }
    }
    return commands;
  }
  private canPreviewSkill(path: unknown, projectRoots: () => string[]): boolean {
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    const roots = [join(this.deps.configRoot, 'skills'), ...(this.deps.bundledSkillRoots ?? [])];
    return roots.some(root => pathInside(path, root))
      || projectRoots().some(root => pathInside(path, join(root, '.klaus/skills')));
  }
  async slashCommands(cwd: string, promptRows?: JsonObject[], extraRoots: string[] = []): Promise<JsonObject[]> {
    const rows: JsonObject[] = [], names = new Set<string>();
    // Preview authority is a request snapshot, refreshed on the next catalog
    // read so project registration changes never leave stale permissions.
    let previewRoots: string[] | undefined;
    const projectPreviewRoots = () => previewRoots ??= this.deps.skillPreviewRoots?.() ?? [];
    const add = (row: JsonObject) => { const name = string(row.name); if (name && !names.has(name)) { rows.push(row); names.add(name); } };
    for (const skill of await this.skills(cwd, false, extraRoots)) {
      if (skill.userInvocable === false || !this.skillEnabled(skill)) continue;
      const row: JsonObject = { name: skill.name!, displayName: skill.name!, description: skill.description!, scope: [cwd, ...extraRoots].some(root => root && !root.startsWith('ssh://') && pathInside(string(skill.path), join(root, '.klaus/skills'))) ? 'project' : 'global', type: 'prompt', source: 'skills' };
      assign(row, 'argumentHint', skill.argumentHint); assign(row, 'path', skill.path); row.definitionPreview = this.canPreviewSkill(skill.path, projectPreviewRoots); add(row);
    }
    for (const command of await this.commands(cwd, extraRoots)) {
      const row: JsonObject = { name: command.name, displayName: command.name, description: command.description, scope: command.scope, type: 'prompt', source: command.source };
      assign(row, 'argumentHint', command.argumentHint); add(row);
    }
    for (const row of promptRows ?? this.deps.mcpPromptRows?.() ?? []) add(structuredClone(row));
    for (const [name, text, hint] of [['compact', 'Clear conversation history but keep a summary in context.', '<optional custom summarization instructions>'], ['init', 'Initialize KLAUS.md for this project.', ''], ['init-verifiers', 'Create verifier skills for automated code-change checks.', '']]) {
      const row: JsonObject = { name: name!, displayName: name!, description: text!, scope: 'global', type: 'local' }; if (hint) row.argumentHint = hint; add(row);
    }
    for (const skill of await this.bundledSkills()) {
      if (skill.userInvocable === false || !this.skillEnabled(skill)) continue;
      const row: JsonObject = { name: skill.name!, displayName: skill.name!, description: skill.description ?? '', scope: 'global', type: 'prompt', source: 'builtin-skill' };
      assign(row, 'argumentHint', skill.argumentHint); assign(row, 'path', skill.path); row.definitionPreview = this.canPreviewSkill(skill.path, projectPreviewRoots); add(row);
    }
    for (const command of BUNDLED_COMMANDS) {
      const row: JsonObject = { name: command.name!, displayName: command.name!, description: command.description ?? '', scope: 'global', type: command.type ?? 'prompt', source: command.loadedFrom ?? 'builtin-skill' };
      if (command.argumentHint) row.argumentHint = command.argumentHint; add(row);
    }
    return rows.sort((a, b) => string(a.name).localeCompare(string(b.name)));
  }
  async expandSlashCommand(cwd: string, input: string): Promise<string | undefined> {
    const match = /^\/([A-Za-z0-9][^\s]*)(?:\s+([\s\S]*))?$/.exec(input); if (!match) return undefined;
    const name = match[1]!, args = match[2] ?? '';
    const bundled = /^[A-Za-z0-9][\w:-]*$/.test(name) ? BUNDLED_COMMANDS.find(command => command.name === name) : undefined;
    if (bundled && typeof bundled.prompt === 'string') return bundled.prompt + (args.trim() ? '\n\n## User Request\n\n' + args.trim() : '');
    if ((await this.skills(cwd)).some(skill => skill.name === name && skill.userInvocable !== false)) return undefined;
    const command = (await this.commands(cwd)).find(command => command.name === name);
    return command ? substituteArguments(command.body, args, command.argumentNames) : undefined;
  }
}
function parseArguments(args: string): string[] {
  const output: string[] = []; let current = '', quote = '', started = false;
  for (let i = 0; i < args.length; i++) {
    const char = args[i]!;
    if (char === '\\' && quote !== "'") { if (++i === args.length) return args.split(/\s+/).filter(Boolean); current += args[i]; started = true; }
    else if (char === '"' || char === "'") {
      if (quote === char) quote = ''; else if (quote) { current += char; started = true; } else { quote = char; started = true; }
    } else if (/\s/.test(char) && !quote) { if (started) output.push(current); current = ''; started = false; }
    else { current += char; started = true; }
  }
  if (quote) return args.split(/\s+/).filter(Boolean); if (started) output.push(current); return output;
}
export function substituteArguments(body: string, args: string, argumentNames: string[]): string {
  const parsed = parseArguments(args); let result = body;
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp('\\$' + name + '(?![\\p{L}\\p{N}_\\[])', 'gu'), () => parsed[i] ?? '');
  }
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_match, index: string) => parsed[Number(index)] ?? '');
  result = result.replace(/\$(\d+)(?![\p{L}\p{N}_])/gu, (_match, index: string) => parsed[Number(index)] ?? '');
  result = result.replace(/\$ARGUMENTS/g, () => args);
  return result === body && args ? result + '\n\nARGUMENTS: ' + args : result;
}
