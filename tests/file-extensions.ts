import { access, chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { FILE_EXTENSION_CHANNELS, registerFileExtensionHandlers } from '../main/ipc/handlers/extensions';
import { FileExtensionService, type FileExtensionDeps } from '../main/services/extensions/management';
import { ExtensionDiscovery, agentFromMarkdown, hooksFromDocument, skillFromMarkdown, substituteArguments } from '../main/services/extensions/discovery';
import { frontmatter, parseManagedCommand } from '../main/services/extensions/frontmatter';
import { object } from '../main/services/service-types';
import { kvSet } from '../main/services/settings';
import { WorkspaceStore } from '../main/services/workspaces';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

async function put(path: string, text: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
async function present(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'registered ' + channel);
  return handler({ role: 'main', senderId: 1, channel, args: payload === undefined ? [] : [payload] });
}
async function fixture(root: string, extra: Partial<FileExtensionDeps> = {}) {
  const registry = new ChannelRegistry(), changes: Array<{ kind: string; root?: string }> = [], diagnostics: string[] = [];
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const service = registerFileExtensionHandlers(registry, { configRoot: root, workspaces, onChanged: async (kind, projectRoot) => { changes.push({ kind, root: projectRoot }); },
    trashPath: async path => { await mkdir(join(root, 'trash'), { recursive: true }); await rename(path, join(root, 'trash', basename(path))); },
    diagnostic: path => { diagnostics.push(path); },
    request: async method => (method === 'engine/builtinAgents' ? { builtinAgents: BUILTIN_AGENTS_ROSTER } : {}),
    ...extra });
  return { root, registry, service, changes, diagnostics, workspaces };
}
const AGENT = '---\nname: Review.Agent\ndescription: Review a bounded change\ntools: Read, Bash(git diff, --stat)\nskills: [review, 2]\nmodel: Inherit\nbackground: true\nisolation: worktree\n---\nReview the changed files.\n';
// Wire-shaped stand-in for the engine's compiled built-in agent roster: the
// host must project whatever `engine/builtinAgents` replies, so the fixture
// pins the projection against this shape rather than against a host-side copy.
const BUILTIN_AGENTS_ROSTER = [
  { name: 'general-purpose', description: 'General-purpose worker.' },
  { name: 'Explore', description: 'Read-only exploration.', model: 'low', disallowedTools: ['write', 'edit'] },
  { name: 'Plan', description: 'Architect agent.', model: 'high', disallowedTools: ['write', 'edit'] },
  { name: 'researcher', description: 'Web-research worker.', model: 'medium', effort: 'medium', tools: ['web_search', 'web_fetch', 'read', 'think'] },
];

export function registerFileExtensionTests(h: Harness, freshRoot: () => string): void {
  h.test('extension editors register their real channels and save commands before refreshing the engine binding', async () => {
    const f = await fixture(freshRoot());
    try {
      assertDeepEqual(f.registry.channels(), [...FILE_EXTENSION_CHANNELS].sort(), 'actual registration');
      const saved = object(await invoke(f.registry, 'commands:save', { name: 'review', description: 'A: careful review', argumentHint: '<file>', body: 'Read $file' }));
      assertEqual(saved.ok, true, 'command saved');
      assertEqual(await readFile(join(f.root, 'commands/review.md'), 'utf8'), '---\ndescription: "A: careful review"\nargument-hint: <file>\n---\nRead $file\n', 'exact compatible markdown');
      assertDeepEqual(f.changes, [{ kind: 'commands' }], 'refresh ran after commit');
      const list = object(await invoke(f.registry, 'commands:list'));
      assertEqual(object((list.commands as Json[])[0]).body, 'Read $file\n', 'reopened persisted body');
      assertDeepEqual(await invoke(f.registry, 'commands:delete', { name: 'review' }), { ok: true }, 'delete');
      assertEqual(await present(join(f.root, 'commands/review.md')), false, 'actual file deleted');
    } finally { await f.service.close(); }
  });
  h.test('slash command IPC returns a bare scoped array with current files and owner-specific MCP prompts', async () => {
    const root = freshRoot(), project = join(root, 'project');
    await put(join(root, 'commands/global.md'), '---\ndescription: Initial description\n---\nGlobal command');
    await put(join(project, '.klaus/commands/project.md'), 'Project command');
    const f = await fixture(root, { resolveCommandSession: async () => project,
      commandPromptRows: id => [{ name: 'mcp:fixture:' + id, source: 'mcp' }] });
    try {
      const global = await invoke(f.registry, 'engine:slashCommands') as Array<Record<string, Json>>;
      assert(Array.isArray(global), 'menu contract is a bare array');
      assert(global.some(row => row.name === 'global') && !global.some(row => row.name === 'project'), 'default scratch scope includes only global commands');
      const scoped = await invoke(f.registry, 'engine:slashCommands', { sessionId: 'owned' }) as Array<Record<string, Json>>;
      assert(scoped.some(row => row.name === 'project') && scoped.some(row => row.name === 'mcp:fixture:owned'), 'actual session directory and its MCP prompts');
      const page = await invoke(f.registry, 'engine:slashCommands', { root: project }) as Array<Record<string, Json>>;
      assert(page.some(row => row.name === 'project') && !page.some(row => row.source === 'mcp'), 'a project page has no other conversation prompts');
      assertEqual(object(await invoke(f.registry, 'engine:slashCommands', { root: 'relative' })).ok, false, 'relative root cannot silently resolve elsewhere');
      await put(join(root, 'commands/global.md'), '---\ndescription: Changed on disk\n---\nGlobal command');
      assertEqual(object(await invoke(f.registry, 'engine:refreshCommands')).ok, true, 'explicit refresh completes');
      const updated = await invoke(f.registry, 'engine:slashCommands') as Array<Record<string, Json>>;
      assertEqual(updated.find(row => row.name === 'global')?.description, 'Changed on disk', 'external edits are visible after refresh');
      assertDeepEqual(f.changes, [{ kind: 'commands' }], 'the existing engine invalidation hook owns refresh');
    } finally { await f.service.close(); }
  });
  h.test('a removed session checkout loses only its project skill while global skills remain available', async () => {
    const root = freshRoot(), worktree = join(root, 'worktrees', 'removed'), origin = join(root, 'origin');
    const pushSkill = '---\nname: push-code\ndescription: Push changes\n---\nPush';
    await put(join(worktree, '.klaus/skills/push-code/SKILL.md'), pushSkill);
    await put(join(origin, '.klaus/skills/push-code/SKILL.md'), pushSkill);
    await put(join(root, 'skills/global/SKILL.md'), '---\nname: global\ndescription: Global skill\n---\nGlobal');
    const f = await fixture(root);
    try {
      f.workspaces.bindSession('owned', { workdir: worktree });
      const before = await invoke(f.registry, 'engine:slashCommands', { sessionId: 'owned' }) as Array<Record<string, Json>>;
      assert(before.some(row => row.name === 'push-code') && before.some(row => row.name === 'global'), 'both project and global skills appear');
      await rm(worktree, { recursive: true });
      // This isolated service has no watcher; exercise the explicit cache invalidation path.
      const after = await invoke(f.registry, 'engine:slashCommands', { sessionId: 'owned', forceReload: true }) as Array<Record<string, Json>>;
      assert(!after.some(row => row.name === 'push-code') && after.some(row => row.name === 'global'), 'missing project root does not erase global skill');
      await assertRejects(() => f.workspaces.sessionDirectory('owned'), 'bound directory is not rebuilt as an empty shell');
      assertEqual(await present(worktree), false, 'discovery and directory lookup did not recreate it');
      assertDeepEqual(await f.workspaces.setWorkdir({ sessionId: 'owned', dir: origin }), { ok: true }, 'user explicitly switches this chat to the origin');
      const restored = await invoke(f.registry, 'engine:slashCommands', { sessionId: 'owned' }) as Array<Record<string, Json>>;
      assert(restored.some(row => row.name === 'push-code') && restored.some(row => row.name === 'global'), 'push-code recommendation returns in this chat');
    } finally { await f.service.close(); }
  });
  h.test('command refresh reports engine preparation failure and does not claim a completed refresh', async () => {
    const f = await fixture(freshRoot(), { prepareCommandRefresh: async () => { throw new Error('fixture engine unavailable'); } });
    try {
      const result = object(await invoke(f.registry, 'engine:refreshCommands'));
      assertEqual(result.ok, false, 'failed preparation is visible'); assertEqual(result.error, 'fixture engine unavailable', 'original failure retained');
      assertEqual(f.changes.length, 0, 'no false successful refresh');
    } finally { await f.service.close(); }
  });
  h.test('command editing preserves nested unmodelled frontmatter and refuses rename collisions', async () => {
    const f = await fixture(freshRoot());
    try {
      const path = join(f.root, 'commands/source.md');
      await put(path, '---\ndescription : >\n  Old description\nargument-hint: old\narguments: [file, target]\nallowed-tools: Read\nhooks:\n  PreToolUse:\n    - matcher: Write\n      hooks:\n        - type: command\n          command: echo keep\n---\nOld\n');
      await chmod(path, 0o640);
      assertEqual(object(await invoke(f.registry, 'commands:save', { name: 'source', body: 'New', description: 'New description' })).ok, true, 'edit saved');
      const raw = await readFile(path, 'utf8'), parsed = frontmatter(raw);
      assertDeepEqual(parsed.data.arguments, ['file', 'target'], 'named argument metadata retained');
      assertEqual(object((object(parsed.data.hooks).PreToolUse as Json[])[0]).matcher, 'Write', 'nested matcher retained');
      assertEqual((raw.match(/^description:/gm) ?? []).length, 1, 'modelled key written once');
      assertEqual(raw.includes('Old description'), false, 'old folded description removed');
      assertEqual((await stat(path)).mode & 0o777, 0o640, 'mode preserved');
      await put(join(f.root, 'commands/occupied.md'), 'other command\n');
      assertEqual(object(await invoke(f.registry, 'commands:save', { name: 'occupied', originalName: 'source', body: 'replacement' })).ok, false, 'rename collision refused');
      assertEqual(await readFile(join(f.root, 'commands/occupied.md'), 'utf8'), 'other command\n', 'unrelated command retained');
      assertEqual(await readFile(path, 'utf8'), raw, 'source retained on refusal');
      assertEqual(object(await invoke(f.registry, 'commands:save', { name: 'renamed', originalName: 'source', body: 'Renamed' })).ok, true, 'rename succeeds');
      assertEqual(await present(path), false, 'old file removed after new write');
      assertDeepEqual(frontmatter(await readFile(join(f.root, 'commands/renamed.md'), 'utf8')).data.arguments, ['file', 'target'], 'rename keeps extra fields');
    } finally { await f.service.close(); }
  });
  h.test('command scopes retain project precedence and invalid names cannot escape the command directory', async () => {
    const f = await fixture(freshRoot()), project = join(f.root, 'project'); await mkdir(project);
    try {
      await invoke(f.registry, 'commands:save', { name: 'same', body: 'global' });
      await invoke(f.registry, 'commands:save', { name: 'same', scope: 'project', projectRoot: project, body: 'project' });
      const list = object(await invoke(f.registry, 'commands:list', { projectRoot: project }));
      assertDeepEqual((list.commands as Json[]).map(row => object(row).scope), ['project', 'global'], 'scoped editor lists both');
      assertEqual((await f.service.discovery.commands(project))[0]?.body, 'project\n', 'runtime reads project first');
      const refused = object(await invoke(f.registry, 'commands:save', { name: ' ../escape ', body: 'bad' }));
      assertEqual(refused.error, 'Invalid command name: " ../escape " (expected /^[a-z0-9][a-z0-9_-]{0,63}$/i)', 'raw invalid name remains in error');
      assertEqual(await present(join(f.root, 'escape.md')), false, 'no escaped write');
      assertEqual(object(await invoke(f.registry, 'commands:save', { name: 'valid', scope: 'project', projectRoot: ' ', body: 'bad' })).ok, false, 'blank project refuses');
      assertEqual(f.changes.length, 2, 'refusals do not refresh sessions');
    } finally { await f.service.close(); }
  });
  h.test('workspace scope lists every member folder and writes land in the primary root', async () => {
    const f = await fixture(freshRoot());
    const primary = join(f.root, 'ws-a'), secondary = join(f.root, 'ws-b');
    await mkdir(primary); await mkdir(secondary);
    try {
      const group = object(f.workspaces.save({ id: 'ws', name: 'Space', roots: [primary, secondary] }));
      await invoke(f.registry, 'commands:save', { name: 'alpha', scope: 'project', projectRoot: primary, body: 'primary' });
      await invoke(f.registry, 'commands:save', { name: 'beta', scope: 'project', projectRoot: secondary, body: 'secondary' });
      await invoke(f.registry, 'commands:save', { name: 'shared', scope: 'project', projectRoot: primary, body: 'first' });
      await invoke(f.registry, 'commands:save', { name: 'shared', scope: 'project', projectRoot: secondary, body: 'shadowed' });
      const list = object(await invoke(f.registry, 'commands:list', { workspaceId: String(group.id) }));
      const rows = list.commands as Json[];
      const byName = new Map(rows.map(row => [String(object(row).name), object(row)]));
      assertEqual(byName.size, 3, 'member-folder commands deduplicated by name');
      assertEqual(object(byName.get('beta')).root, secondary, 'row carries its owning member root');
      assertEqual(object(byName.get('shared')).root, primary, 'duplicate name resolves to the earliest member root');
      assertEqual(object(byName.get('shared')).body, 'first\n', 'shadowed duplicate is not listed twice');
      const saved = object(await invoke(f.registry, 'commands:save', { name: 'gamma', scope: 'project', workspaceId: String(group.id), body: 'workspace write' }));
      assertEqual(saved.ok, true, 'workspace-scoped save accepted');
      assertEqual(await readFile(join(primary, '.klaus/commands/gamma.md'), 'utf8'), 'workspace write\n', 'write lands in the primary root');
      const removed = object(await invoke(f.registry, 'commands:delete', { name: 'beta', scope: 'project', projectRoot: secondary }));
      assertEqual(removed.ok, true, 'delete targets the owning member root');
      assertEqual(await present(join(secondary, '.klaus/commands/beta.md')), false, 'member file removed');
      assertEqual(object(await invoke(f.registry, 'commands:list', { workspaceId: 'missing' })).ok, true, 'unknown workspace degrades to the global list');
    } finally { await f.service.close(); }
  });
  h.test('file extension editors refuse existing and broken symlinks outside their owning root', async () => {
    const root = freshRoot(), outside = freshRoot(), f = await fixture(root);
    try {
      await put(join(outside, 'victim.md'), 'unchanged'); await mkdir(join(root, 'commands'));
      await symlink(join(outside, 'victim.md'), join(root, 'commands/escape.md'));
      await symlink(join(outside, 'missing.md'), join(root, 'commands/broken.md'));
      for (const name of ['escape', 'broken']) assertEqual(object(await invoke(f.registry, 'commands:save', { name, body: 'attack' })).error, 'path-escape', 'symlink write refused');
      assertEqual(await readFile(join(outside, 'victim.md'), 'utf8'), 'unchanged', 'outside content untouched');
      assertEqual(await present(join(outside, 'missing.md')), false, 'broken target not created');
      await symlink(outside, join(root, 'agents'));
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { content: AGENT })).error, 'path-escape', 'agent directory symlink refused');
      assertEqual(f.changes.length, 0, 'no mutation refresh');
    } finally { await f.service.close(); }
  });
  h.test('extension writes await invalidation and close prevents queued mutations from touching disk', async () => {
    let entered = false, release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(freshRoot(), { onChanged: async () => { entered = true; await blocker; } });
    let first: Promise<Json> | undefined, next: Promise<Json> | undefined, closing: Promise<void> | undefined;
    try {
      first = invoke(f.registry, 'commands:save', { name: 'first', body: 'kept' });
      await waitFor(() => entered, 1000, 'invalidation entered after write');
      assertEqual(await readFile(join(f.root, 'commands/first.md'), 'utf8'), 'kept\n', 'file precedes refresh');
      next = invoke(f.registry, 'commands:save', { name: 'next', body: 'not written' });
      closing = f.service.close(); release();
      assertEqual(object(await first).ok, true, 'in-flight write settles after refresh');
      assertEqual(object(await next).ok, false, 'queued write refuses close');
      await closing; assertEqual(await present(join(f.root, 'commands/next.md')), false, 'queued file absent');
    } finally { release(); await Promise.allSettled([first, next, closing]); await f.service.close(); }
  });
  h.test('agent definitions validate UTF-8 byte limits and atomically reject colliding new names', async () => {
    const f = await fixture(freshRoot());
    try {
      const replies = await Promise.all([invoke(f.registry, 'agents:definitions:save', { content: AGENT }), invoke(f.registry, 'agents:definitions:save', { content: AGENT })]);
      assertDeepEqual(replies.map(reply => object(reply).ok), [true, false], 'exactly one new definition wins');
      assertEqual(object(replies[1]).error, 'agent file already exists', 'conflict surfaced');
      const reopened = object(await invoke(f.registry, 'agents:definitions:read', { id: 'Review.Agent.md' }));
      assertEqual(reopened.content, AGENT, 'raw prompt and metadata retained');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { id: 'Review.Agent', content: AGENT + '界'.repeat(90_000) })).error, 'agent file is too large', 'byte limit');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { content: '---\nname: invalid space\ndescription: d\n---\nprompt' })).error, 'invalid agent name', 'wire name validated');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { content: '---\nname: valid\ndescription: d\n---\n' })).error, 'missing agent prompt', 'empty prompt refuses');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:read', { id: '../outside' })).error, 'invalid agent file', 'read traversal refuses');
      assertEqual((await stat(join(f.root, 'agents/Review.Agent.md'))).mode & 0o077, 0, 'new definition is private');
      assertEqual(f.changes.length, 1, 'only committed agent refreshed');
    } finally { await f.service.close(); }
  });
  h.test('agent roster reports bad files without losing builtins and carries no active flag', async () => {
    const f = await fixture(freshRoot());
    try {
      await put(join(f.root, 'agents/a.md'), AGENT.replace('Review.Agent', 'Shadow.Agent'));
      await put(join(f.root, 'agents/z.md'), AGENT.replace('Review.Agent', 'Shadow.Agent'));
      await put(join(f.root, 'agents/bad.md'), '---\nname: Bad\n---\nprompt');
      await put(join(f.root, 'agents/notes.md'), '# documentation');
      const roster = object(await invoke(f.registry, 'agents:definitions:list')), agents = roster.agents as Json[];
      const shadow = agents.map(object).filter(agent => agent.agentType === 'Shadow.Agent');
      assertDeepEqual(shadow.map(agent => agent.active), [undefined, undefined], 'roster no longer ranks overrides');
      assertDeepEqual(shadow.at(-1)?.skills, ['review'], 'typed tools and skill lists retain strings only');
      assertDeepEqual(shadow.at(-1)?.tools, ['Read', 'Bash(git diff, --stat)'], 'UI grant list preserves parentheses');
      assertEqual(shadow.at(-1)?.model, 'inherit', 'editor model sentinel normalized');
      assertEqual((roster.failedFiles as Json[]).length, 1, 'bad definition visible');
      const initAgents = await f.service.discovery.agents();
      assertEqual(initAgents.filter(agent => agent.name === 'Shadow.Agent').length, 2, 'engine still resolves pre-existing duplicates on disk');
      assert(initAgents.some(agent => agent.name === 'notes' && agent.prompt === '# documentation'), 'wire loader filename fallback preserved');
      assertEqual(initAgents.find(agent => agent.name === 'Shadow.Agent')?.model, 'Inherit', 'wire model remains the file value');
    } finally { await f.service.close(); }
  });
  h.test('agent roster projects the engine built-in roster verbatim and never invents one', async () => {
    const f = await fixture(freshRoot());
    try {
      const roster = object(await invoke(f.registry, 'agents:definitions:list')), agents = (roster.agents as Json[]).map(object);
      const explore = agents.find(agent => agent.agentType === 'Explore');
      const researcher = agents.find(agent => agent.agentType === 'researcher');
      const general = agents.find(agent => agent.agentType === 'general-purpose');
      assertEqual(explore?.source, 'built-in', 'engine rows keep the built-in source');
      assertEqual(explore?.model, 'low', 'declared tier reaches the card');
      assertEqual(researcher?.model, 'medium', 'declared tier reaches the card');
      assertEqual(researcher?.effort, 'medium', 'declared effort reaches the card');
      assertDeepEqual(researcher?.tools, ['web_search', 'web_fetch', 'read', 'think'], 'declared tool allowlist reaches the card');
      assertEqual(Object.hasOwn(general ?? {}, 'model'), false, 'a role with no declared tier carries no model field');
      assertEqual(roster.builtinAgentsError, null, 'healthy engine reports no roster error');
    } finally { await f.service.close(); }
    const offline = await fixture(freshRoot(), { request: undefined });
    try {
      const roster = object(await invoke(offline.registry, 'agents:definitions:list'));
      assertDeepEqual(roster.agents, [], 'no engine means no invented built-ins');
      assert(object(roster.builtinAgentsError).message !== undefined, 'the missing engine is surfaced, not hidden');
    } finally { await offline.service.close(); }
  });
  h.test('agent saves refuse built-in names and duplicate user names instead of shadowing', async () => {
    const f = await fixture(freshRoot());
    try {
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { content: AGENT.replace('Review.Agent', 'Explore') })).error,
        'agent name "Explore" is reserved by a built-in agent', 'built-in name refused at creation');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { content: AGENT })).ok, true, 'first definition saves');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { id: 'twin', content: AGENT })).error,
        'another agent file already defines the name "Review.Agent"', 'second file with the same name refused');
      assertEqual(await present(join(f.root, 'agents/twin.md')), false, 'refused twin left no file');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:save', { id: 'Review.Agent', content: AGENT.replace('Review a bounded change', 'Review a bounded change again') })).ok, true, 'editing the file under its own id still works');
    } finally { await f.service.close(); }
  });
  h.test('agent form tool modes preserve all, read-only and no-tools semantics through session init', async () => {
    const f = await fixture(freshRoot());
    try {
      await put(join(f.root, 'agents/all.md'), '---\nname: all-tools\ndescription: All tools\ntools: "*"\n---\nprompt\n');
      await put(join(f.root, 'agents/read.md'), '---\nname: read-tools\ndescription: Read tools\ntools:\n  - Read\n  - Glob\n  - Grep\n---\nprompt\n');
      await put(join(f.root, 'agents/none.md'), '---\nname: no-tools\ndescription: No tools\ntools: []\n---\nprompt\n');
      const roster = object(await invoke(f.registry, 'agents:definitions:list'));
      const rows = new Map((roster.agents as Json[]).map(value => { const row = object(value); return [row.agentType, row]; }));
      assertEqual(Object.hasOwn(rows.get('all-tools')!, 'tools'), false, 'all-tools card uses inherited-all display semantics');
      assertDeepEqual(rows.get('read-tools')?.tools, ['Read', 'Glob', 'Grep'], 'read-only card retains user-facing legacy labels');
      assertDeepEqual(rows.get('no-tools')?.tools, [], 'no-tools card remains visibly distinct from inherited all tools');
      const init = await f.service.discovery.sessionExtensions('');
      const agents = new Map((init.agents as Json[]).map(value => { const row = object(value); return [row.name, row]; }));
      assertEqual(Object.hasOwn(agents.get('all-tools')!, 'tools'), false, 'all tools is omitted so the engine inherits the complete set');
      assertDeepEqual(agents.get('read-tools')?.tools, ['read', 'glob', 'grep'], 'read-only aliases match Klaus engine tool names');
      assertDeepEqual(agents.get('no-tools')?.tools, [], 'empty allowlist reaches the engine as no tools');
    } finally { await f.service.close(); }
  });
  h.test('agent deletion uses the actual recoverable trash dependency and preserves failure', async () => {
    const f = await fixture(freshRoot());
    try {
      await invoke(f.registry, 'agents:definitions:save', { content: AGENT });
      assertDeepEqual(await invoke(f.registry, 'agents:definitions:delete', { id: 'Review.Agent' }), { ok: true }, 'delete settles');
      assertEqual(await readFile(join(f.root, 'trash/Review.Agent.md'), 'utf8'), AGENT, 'recoverable copy retained');
      assertEqual(await present(join(f.root, 'agents/Review.Agent.md')), false, 'active definition removed');
      assertEqual(object(await invoke(f.registry, 'agents:definitions:delete', { id: 'Review.Agent' })).error, 'file not found', 'missing delete refuses');
      const failed = new FileExtensionService({ configRoot: f.root, workspaces: f.workspaces, onChanged: async () => {}, trashPath: async () => { throw new Error('trash unavailable'); } });
      try {
        await failed.agentsSave({ content: AGENT });
        assertEqual(object(await failed.agentsDelete({ id: 'Review.Agent' })).error, 'trash unavailable', 'OS failure surfaced');
        assertEqual(await readFile(join(f.root, 'agents/Review.Agent.md'), 'utf8'), AGENT, 'failure leaves file intact');
      } finally { await failed.close(); }
    } finally { await f.service.close(); }
  });
  h.test('frontmatter keeps typed nested YAML and the distinct editor fence semantics', () => {
    const raw = '---\r\nname: agent\r\nbackground: true\r\nmaxTurns: 12\r\ntools: [Read, Write]\r\n---\r\n\r\n\r\n  body\r\n';
    assertDeepEqual(frontmatter(raw), { data: { name: 'agent', background: true, maxTurns: 12, tools: ['Read', 'Write'] }, body: '\n  body\n' }, 'whole-line parser consumes exactly one blank');
    assertEqual(parseManagedCommand(raw).body, 'body\r\n', 'editor consumes whitespace after fence');
    assertDeepEqual(frontmatter('---\nname: usable\nstray line\ntools:\n  - Read\n---\nprompt').data, { name: 'usable', tools: ['Read'] }, 'malformed YAML falls back to supported keys');
    const cyclic = frontmatter('---\nname: usable\ncycle: &cycle [*cycle]\n---\nbody');
    assertEqual(cyclic.data.name, 'usable', 'recursive alias does not overflow the parser');
  });
  h.test('engine declaration projection preserves typed skill and agent fields without invalid enum values', () => {
    const skill = skillFromMarkdown('---\nname: 42\ndescription: false\nshort-description: brief\nwhen_to_use: 0\nwhen-to-use: ignored\nallowed-tools: Read Bash(git diff, --stat)\nmodel: inherit\neffort: "1200"\ncontext: fork\narguments: target 1 extra\npaths: src/{a,b}/**, **\nuser-invocable: false\ndisable-model-invocation: "true"\n---\n\n# Body', '/root/s/SKILL.md', 'fallback');
    assertDeepEqual(skill, { name: '42', description: 'false', shortDescription: 'brief', whenToUse: '0', allowedTools: ['Read', 'Bash(git diff, --stat)'], effort: 1200, context: 'fork', arguments: ['target', 'extra'], userInvocable: false, disableModelInvocation: true, paths: ['src/a', 'src/b', '**'], body: '# Body', path: '/root/s/SKILL.md' }, 'complete skill wire vector');
    assertEqual(skillFromMarkdown('---\nname: s\nshort_description: underscore wins\nshort-description: ignored\n---\nbody', '/root/s/SKILL.md', 's')?.shortDescription, 'underscore wins', 'the underscore spelling wins over the hyphen form');
    assertEqual('shortDescription' in (skillFromMarkdown('---\nname: s\ndescription: d\n---\nbody', '/root/s/SKILL.md', 's') ?? {}), false, 'an undeclared short description adds no wire key');
    assertEqual(skillFromMarkdown('---\ncontext: bad\n---\nbody', '/root/s', 's'), undefined, 'invalid context drops unusable skill');
    const agent = agentFromMarkdown('---\nname: worker\ndescription: desc\neffort: xhigh\npermissionMode: nope\nmaxTurns: "12turns"\ncritical-system-reminder: remember\nmodel: inherit\nbackground: "true"\nisolation: arbitrary\n---\n\nPrompt\n', 'fallback.md');
    assertDeepEqual(agent, { name: 'worker', description: 'desc', model: 'inherit', effort: 'xhigh', maxTurns: 12, criticalSystemReminder: 'remember', background: true, prompt: 'Prompt' }, 'agent wire vector omits invalid optional enums');
  });
  h.test('discovery gives project skills precedence and excludes plugin components from every init list', async () => {
    const root = freshRoot(), project = join(root, 'project'), plugin = join(root, 'plugins/example');
    await put(join(root, 'skills/global/SKILL.md'), '---\nname: shared\n---\nglobal');
    await put(join(project, '.klaus/skills/project/SKILL.md'), '---\nname: shared\n---\nproject');
    await put(join(project, '.klaus/skills/.hidden/SKILL.md'), '---\nname: hidden\n---\nhidden');
    await put(join(root, 'agents/user.md'), '---\nname: user\ndescription: desc\n---\nuser prompt');
    await put(join(plugin, 'agents/plugin.md'), '---\nname: plugin-agent\n---\nplugin');
    await put(join(plugin, 'skills/plugin/SKILL.md'), '---\nname: plugin-skill\n---\nplugin');
    await put(join(plugin, 'commands/plugin.md'), '# Plugin command\nplugin prompt');
    await put(join(root, 'hooks.json'), JSON.stringify({ PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'global', timeout: 1.25, async: true }, { type: 'prompt', prompt: 'ignored' }] }], UnknownEvent: [{ hooks: [{ type: 'command', command: 'ignored' }] }] }));
    await put(join(project, '.klaus/hooks.json'), JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'project' }] }] }));
    await put(join(plugin, 'hooks/hooks.json'), JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'plugin' }] }] }));
    const discovery = new ExtensionDiscovery({ configRoot: root, pluginCommandSources: async () => [join(plugin, 'commands')] });
    const init = await discovery.sessionExtensions(project), skills = (init.skills as Json[]).map(object);
    assertEqual(skills.find(skill => skill.name === 'shared')?.body, 'project', 'project wins');
    assert(skills.some(skill => skill.name === 'hidden'), 'hidden skill directories retain discovery behavior');
    assert(skills.some(skill => skill.name === 'skill-creator'), 'packaged builtin prompt contributed');
    assertEqual(skills.some(skill => skill.name === 'plugin-skill'), false, 'plugin skills engine owned');
    assertEqual((init.agents as Json[]).some(agent => object(agent).name === 'plugin-agent'), false, 'plugin agents engine owned');
    assertDeepEqual(init.commandHooks, [{ event: 'PreToolUse', matcher: 'Read', command: 'global', timeoutMs: 1250, isAsync: true }, { event: 'PreToolUse', command: 'project' }], 'global then project hooks without duplicates');
    assert((await discovery.commands(project)).some(command => command.name === 'plugin' && command.source === 'plugin'), 'plugin command is a host expansion input');
    assertEqual(init.commands, undefined, 'commands do not create a second engine registry');
  });
  h.test('slash menu and expansion retain precedence, zero-based placeholders and literal shell text', async () => {
    const root = freshRoot(), project = join(root, 'project'), plugin = join(root, 'plugin');
    await put(join(root, 'commands/review.md'), '---\narguments: file target\n---\nReview $file / $target / $ARGUMENTS[1] / $0 / $1 / $1suffix / $ARGUMENTS\n!`never execute`');
    await put(join(project, '.klaus/commands/review.md'), 'project $ARGUMENTS');
    await put(join(root, 'commands/shared.md'), 'must not expand');
    await put(join(root, 'skills/shared/SKILL.md'), '---\nname: shared\n---\nskill');
    await put(join(plugin, 'single.md'), 'single $0');
    kvSet('skill:shared', JSON.stringify({ enabled: false }), root);
    const discovery = new ExtensionDiscovery({ configRoot: root, pluginCommandSources: async () => [join(plugin, 'single.md')], mcpPromptRows: () => [{ name: 'mcp:server:prompt', source: 'mcp' }] });
    const menu = await discovery.slashCommands(project);
    assertEqual(menu.find(row => row.name === 'review')?.scope, 'project', 'project command wins');
    assertEqual(menu.find(row => row.name === 'shared')?.source, 'commands', 'disabled menu skill permits file command row');
    assert(menu.some(row => row.name === 'single' && row.source === 'plugin'), 'single-file plugin command');
    assert(menu.some(row => row.name === 'mcp:server:prompt'), 'MCP prompt rows merge');
    assert(menu.some(row => row.name === 'compact' && row.type === 'local'), 'host action retained');
    assertEqual(await discovery.expandSlashCommand(project, '/review a b'), 'project a b', 'project command expansion');
    assertEqual(await discovery.expandSlashCommand(project, '/shared argument'), undefined, 'engine skill retains expansion ownership even when hidden from menu');
    assertEqual(await discovery.expandSlashCommand('', '/review "two words" next'), 'Review two words / next / next / two words / next / $1suffix / "two words" next\n!`never execute`', 'actual file expansion preserves shell markers');
    assertEqual(await discovery.expandSlashCommand('', '/single value'), 'single value', 'plugin single-file expansion');
    assertEqual(await discovery.expandSlashCommand('', '/unknown text'), undefined, 'unknown remains original input');
    assert((await discovery.expandSlashCommand('', '/slash-command-creator make a review'))?.endsWith('## User Request\n\nmake a review'), 'bundled prompt expands with user request');
    assertEqual(substituteArguments('literal', 'x y', []), 'literal\n\nARGUMENTS: x y', 'unused arguments are retained');
    assertEqual(substituteArguments('$file $filename $ARGUMENTS[9] $0', '"unterminated quote', ['file']), '"unterminated $filename  "unterminated', 'invalid quoting fallback and name boundary');
  });
  h.test('discovery bounds file reads and reports corrupt documents without touching unrelated files', async () => {
    const root = freshRoot(), outside = freshRoot(), diagnostics: string[] = [];
    await put(join(root, 'skills/too-large/SKILL.md'), 'x'.repeat(1024 * 1024 + 1));
    await put(join(root, 'agents/invalid.md'), 'placeholder'); await writeFile(join(root, 'agents/invalid.md'), Buffer.from([0xff, 0xfe]));
    await put(join(outside, 'secret.md'), 'outside'); await symlink(join(outside, 'secret.md'), join(root, 'agents/escape.md'));
    const discovery = new ExtensionDiscovery({ configRoot: root, diagnostic: path => { diagnostics.push(path); } });
    assertEqual((await discovery.skills('', false)).length, 0, 'oversized skill omitted');
    assertEqual((await discovery.agents()).length, 0, 'escaped and invalid UTF-8 agents omitted');
    assertEqual(diagnostics.length, 3, 'all unusable files diagnosed');
    assertEqual(await readFile(join(outside, 'secret.md'), 'utf8'), 'outside', 'outside bytes untouched');
    assertDeepEqual(hooksFromDocument({ Stop: [{ hooks: [{ type: 'command', command: 'one', async: false }, { type: 'http', url: 'not supported' }] }] }), [{ event: 'Stop', command: 'one' }], 'non-command hooks do not become declared executables');
  });
}
