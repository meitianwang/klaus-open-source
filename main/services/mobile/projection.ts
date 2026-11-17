import { pickAntigravityModelMetadata } from '../../../shared/antigravity-model-catalog';
import { isKiroRoutingAlias, pickKiroModelMetadata } from '../../../shared/kiro-model-catalog';
import { pickFastModeMetadata } from '../../../shared/model-fast-mode';
import type { Json } from '../../ipc/contract';
import { isHiddenBuiltinSlashCommand } from '../../../contracts/slash-command-visibility';
import { object, string, type JsonObject } from '../service-types';
import { FOLLOW_UP_MODE_KEY } from './follow-ups';
import { MOBILE_AUTH_MODES, MOBILE_FEATURES, nonempty, optionText, pathBase, type MobileCall } from './protocol';
import { modelOptionsForValue, pickCursorModelMetadata } from '../../../shared/cursor-model-catalog';

const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
export function projectRows(sessions: JsonObject[], workspace: JsonObject): JsonObject[] {
  const projects = new Map<string, JsonObject>();
  for (const row of rows(workspace.roots)) {
    const path = nonempty(row.path); if (!path) continue;
    projects.set(path, { workdir: path, label: optionText(row.label) || pathBase(path), updatedAt: integer(row.updatedAt), conversationCount: integer(row.conversationCount) });
  }
  for (const row of sessions) {
    // A session belongs to its ORIGIN project, not to the directory it runs in. Worktree sessions
    // carry `projectRoot` (`sessions/service.ts:1828`); keying them by `workdir` gave every worktree
    // its own phantom project on the phone, and made "new chat in project" impossible for the real
    // project. Worktree directories are never project identities.
    const path = nonempty(row.projectRoot) ?? nonempty(row.workdir); if (!path || nonempty(row.workspaceId)) continue;
    const entry = projects.get(path);
    if (entry) { entry.updatedAt = Math.max(integer(entry.updatedAt), integer(row.updatedAt)); entry.conversationCount = integer(entry.conversationCount) + 1; }
    else projects.set(path, { workdir: path, label: nonempty(object(workspace.labels)[path]) || pathBase(path), updatedAt: integer(row.updatedAt), conversationCount: 1 });
  }
  return [...projects.values()].sort((a, b) => integer(b.updatedAt) - integer(a.updatedAt));
}
/**
 * Multi-folder workspace groups (`workspaces:list`), the identity the desktop sidebar shows for
 * sessions bound to a workspace. `projectRows` deliberately skips those sessions, so without this
 * projection a phone never sees the group — nor the conversations inside it — at all.
 */
export function projectWorkspaceGroups(sessions: JsonObject[], groups: JsonObject[]): JsonObject[] {
  const out = new Map<string, JsonObject>();
  for (const group of groups) {
    const id = nonempty(group.id); if (!id) continue;
    const roots = (Array.isArray(group.roots) ? group.roots : []).map(nonempty).filter((root): root is string => root !== null);
    if (!roots.length) continue;
    out.set(id, { id, name: optionText(group.name) || pathBase(roots[0]!), roots, updatedAt: 0, conversationCount: 0 });
  }
  for (const row of sessions) {
    const id = nonempty(row.workspaceId); if (!id) continue;
    const entry = out.get(id); if (!entry) continue;
    entry.updatedAt = Math.max(integer(entry.updatedAt), integer(row.updatedAt));
    entry.conversationCount = integer(entry.conversationCount) + 1;
  }
  return [...out.values()].sort((a, b) => integer(b.updatedAt) - integer(a.updatedAt));
}
function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0; }
export function normalizeCommands(value: Json): JsonObject[] {
  const seen = new Set<string>(), commands: JsonObject[] = [];
  for (const raw of rows(value)) {
    const name = string(raw.name).trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/u.test(name) || seen.has(name)) continue;
    seen.add(name); const command: JsonObject = { name };
    for (const key of ['displayName', 'description', 'argumentHint', 'source', 'type']) {
      const text = optionText(raw[key]); if (text) command[key] = text;
    }
    commands.push(command); if (commands.length === 200) break;
  }
  return commands.sort((a, b) => string(a.name).localeCompare(string(b.name)));
}
function commandGroup(command: JsonObject): string {
  const source = string(command.source).toLowerCase(), type = string(command.type).toLowerCase();
  for (const [key, group] of [['skill', 'skills'], ['plugin', 'plugins'], ['mcp', 'mcp']] as const) {
    if (source.includes(key) || type.includes(key) || (key === 'mcp' && string(command.name).toLowerCase().includes(key))) return group;
  }
  return 'slash';
}
export function composerMenu(commands: JsonObject[], runtime: JsonObject): JsonObject {
  const grouped = (group: string): string[] => commands.filter(row => commandGroup(row) === group).map(row => string(row.name));
  const group = (id: string, title: string, subtitle: string, icon: string): JsonObject => {
    let names = grouped(id); if (id === 'slash' && !names.length) names = commands.map(row => string(row.name));
    return { id, kind: 'command_group', title, subtitle, icon, enabled: !!names.length, count: names.length, commandNames: names };
  };
  const styleCount = rows(runtime.outputStyleOptions).length;
  return { items: [
    { id: 'image', kind: 'attachment', title: 'Image', subtitle: 'Add an image to the current desktop conversation.', icon: 'photo', enabled: true },
    { id: 'file', kind: 'attachment', title: 'Add File', subtitle: 'Send a local file to the desktop composer.', icon: 'paperclip', enabled: true },
    group('skills', 'Skills', 'Run desktop skills exposed for remote control.', 'sparkles'),
    group('plugins', 'Plugins', 'Run desktop plugin commands exposed for remote control.', 'shippingbox'),
    group('mcp', 'MCP', 'Use desktop MCP command entry points.', 'square.grid.2x2'),
    group('slash', 'Slash Commands', 'Insert desktop-approved slash commands.', 'slash.circle'),
    { id: 'style', kind: 'desktop_managed', title: 'Use Style', subtitle: 'Change the desktop response style.', icon: 'paintbrush', enabled: styleCount > 0, count: styleCount, desktopManaged: true },
  ] };
}
export class MobileProjection {
  constructor(private readonly call: MobileCall, private readonly active: () => string | undefined, private readonly working: ReadonlySet<string>, private readonly awaiting: ReadonlySet<string>, private readonly catalogRows?: () => Promise<JsonObject[]>) {}
  async sessions(): Promise<JsonObject[]> { return (this.catalogRows ? await this.catalogRows() : rows(await this.call('session:list'))).map(row => ({ ...row, isWorking: this.working.has(string(row.id)) })); }
  async workspace(): Promise<JsonObject> { try { return object(await this.call('projects:list')); } catch { return {}; } }
  async workspaceGroups(): Promise<JsonObject[]> {
    try { return rows(object(await this.call('workspaces:list')).workspaces); } catch { return []; }
  }
  activeFor(sessions: JsonObject[]): string | null { const tracked = this.active(); return sessions.some(row => row.id === tracked) ? tracked! : nonempty(sessions[0]?.id); }
  private async authMode(): Promise<string> {
    let mode: Json; try { mode = await this.call('settings:kv:get', { key: 'auth_mode' }); } catch { mode = null; }
    return MOBILE_AUTH_MODES.includes(string(mode)) ? string(mode) : 'custom';
  }
  async desktopState(sessions?: JsonObject[]): Promise<JsonObject> {
    sessions ??= await this.sessions(); const id = this.activeFor(sessions), workspace = await this.workspace();
    const groups = await this.workspaceGroups();
    return { activeSessionId: id, activeWorkdir: nonempty(sessions.find(row => row.id === id)?.workdir) || nonempty(workspace.activeRoot),
      runningSessionIds: sessions.filter(row => row.isWorking === true).map(row => row.id!),
      awaitingInteractionSessionIds: sessions.map(row => string(row.id)).filter(id => id && this.awaiting.has(id)),
      projects: projectRows(sessions, workspace),
      workspaces: projectWorkspaceGroups(sessions, groups), authMode: await this.authMode() };
  }
  async commands(sessionId: string | null | undefined = this.active()): Promise<JsonObject[]> {
    // The phone has no manual compaction surface: context management is the
    // engine's automatic job, so the CLI-only compaction row never reaches it.
    return normalizeCommands(await this.call('engine:slashCommands', { ...(sessionId ? { sessionId } : {}), remoteControl: true }))
      .filter(command => !isHiddenBuiltinSlashCommand(command, 'mobile'));
  }
  async runtimeConfig(sessionId?: string | null): Promise<JsonObject> {
    const id = sessionId === undefined ? this.activeFor(await this.sessions()) : sessionId;
    const main = object(await this.call('session:get-main-model', id ? { sessionId: id } : {}));
    // Per-conversation like the model: reading the global default here would show
    // the phone a level the conversation it is displaying is not running with.
    const thinking = object(await this.call('session:get-thinking-level', id ? { sessionId: id } : {}));
    const fast = object(await this.call('session:get-fast-mode', id ? { sessionId: id } : {}));
    const styles = await this.outputStyles(), cursor = main.source === 'cursor' || string(main.mode).startsWith('cursor:');
    const kiro = main.source === 'kiro' || string(main.mode).startsWith('kiro:');
    const options: JsonObject[] = cursor || kiro ? [] : [{ value: 'auto', label: 'Auto' }], seen = new Set(options.map(option => string(option.value)));
    for (const channel of ['session:get-main-model-options', 'session:get-custom-main-model-options']) {
      const answer = object(await this.call(channel, {}));
      for (const row of rows(answer.options)) {
        const value = nonempty(row.value); if (!value || seen.has(value)) continue;
        if ((kiro && value === 'auto') || value.startsWith('kiro:') && isKiroRoutingAlias(value)) continue;
        seen.add(value); const option: JsonObject = { value, label: optionText(row.label) || value };
        const description = optionText(row.description); if (description) option.description = description;
        Object.assign(option, pickCursorModelMetadata(row), pickAntigravityModelMetadata(row), pickKiroModelMetadata(row), pickFastModeMetadata(row));
        options.push(option);
      }
    }
    const mode = await this.call('settings:kv:get', { key: FOLLOW_UP_MODE_KEY });
    return { followUpMode: mode === 'steer' ? 'steer' : 'queue', mainModel: nonempty(main.mode), thinkingLevel: nonempty(thinking.level), fastMode: fast.enabled === true, fastModeSupported: fast.supported === true,
      ...(fast.billing === 'extraCredits' ? { fastModeBilling: 'extraCredits' } : {}), authMode: await this.authMode(), outputStyle: styles.current,
      mainModelOptions: modelOptionsForValue(options, string(main.mode)), authModeOptions: MOBILE_AUTH_MODES.map(value => ({ value, label: ({ subscription: 'Claude Subscription', custom: 'Custom', codex: 'Codex', cursor: 'Cursor', qoder: 'Qoder', qwenwork: 'QwenWork', workbuddy: 'WorkBuddy', antigravity: 'Antigravity', trae: 'TRAE CN', kiro: 'Kiro', kimi: 'Kimi', bailian: 'Bailian Token Plan', minimax: 'MiniMax M Plan', zhipu: 'Zhipu Coding Plan', ark: 'Ark Coding Plan' } as Record<string, string>)[value] ?? value })), outputStyleOptions: styles.options };
  }
  private async outputStyles(): Promise<{ current: string | null; options: JsonObject[] }> {
    let answer: JsonObject; try { answer = object(await this.call('settings:output-styles:list', {})); } catch { return { current: null, options: [] }; }
    const defaultStyle = optionText(answer.defaultStyle) || 'default', current = optionText(answer.current) || defaultStyle, seen = new Set<string>();
    const options: JsonObject[] = [];
    for (const row of rows(answer.styles)) {
      const value = optionText(row.id); if (!value || seen.has(value)) continue;
      seen.add(value); const option: JsonObject = { value, label: value === defaultStyle ? 'Normal' : optionText(row.name) || value, active: row.active === true || value === current, isDefault: row.isDefault === true || value === defaultStyle };
      for (const key of ['description', 'source']) { const text = optionText(row[key]); if (text) option[key] = text; }
      options.push(option);
    }
    const rank = (row: JsonObject): number => row.value === defaultStyle || row.isDefault === true ? 0 : row.value === 'Learning' ? 1 : row.value === 'Explanatory' ? 2 : row.source === 'builtin' ? 3 : row.source === 'plugin' ? 4 : 5;
    options.sort((a, b) => rank(a) - rank(b) || string(a.label).toLowerCase().localeCompare(string(b.label).toLowerCase()));
    return { current, options };
  }
  async bootstrap(catalog = false, metadataOnly = false): Promise<JsonObject> {
    const sessions = await this.sessions(), activeSessionId = this.activeFor(sessions), desktopState = await this.desktopState(sessions);
    if (metadataOnly) return { protocolVersion: 3, features: { ...MOBILE_FEATURES, ...(catalog ? { catalogSync: 1 } : {}) }, sessions: catalog ? [] : sessions, activeSessionId, desktopState, projects: desktopState.projects! };
    const slashCommands = await this.commands(activeSessionId), runtimeConfig = await this.runtimeConfig(activeSessionId);
    return { protocolVersion: 3, features: { ...MOBILE_FEATURES, ...(catalog ? { catalogSync: 1 } : {}) }, sessions: catalog ? [] : sessions, activeSessionId, desktopState, projects: desktopState.projects!, runtimeConfig, slashCommands, composerAddMenu: composerMenu(slashCommands, runtimeConfig) };
  }
}
