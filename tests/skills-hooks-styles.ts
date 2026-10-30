import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerSkillHandlers, SKILL_CHANNELS } from '../main/ipc/handlers/skills';
import { registerHookStyleHandlers, HOOK_STYLE_CHANNELS } from '../main/ipc/handlers/hooks-styles';
import { SkillService, type SkillDeps } from '../main/services/extensions/skills';
import { HookStyleService, type HookStyleDeps } from '../main/services/extensions/hooks-styles';
import { WorkspaceStore } from '../main/services/workspaces';
import { object, type JsonObject, type EngineRequest } from '../main/services/service-types';
import { kvGet, kvSet } from '../main/services/settings';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

async function put(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
async function present(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'registered ' + channel);
  return handler({ role: 'main', senderId: 1, channel, args: payload === undefined ? [] : [payload] });
}
function workspace(root: string): WorkspaceStore { return new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null }); }
function facade(root: string) {
  const calls: Array<{ method: string; params: JsonObject }> = [], values: JsonObject = {};
  let failure: unknown;
  const request: EngineRequest = async (method, params) => {
    const data = object(params); calls.push({ method, params: data }); if (failure) throw failure;
    if (method === 'hooks/read' || method === 'hooks/write') {
      const path = typeof data.filePath === 'string' ? data.filePath : join(root, 'hooks.json');
      if (method === 'hooks/write') await put(path, JSON.stringify(data.hooks));
      let hooks: Json = {}; try { hooks = JSON.parse(await readFile(path, 'utf8')); } catch { /* Empty fixture store. */ }
      return { hooks, path, events: ['PreToolUse', 'Stop'] };
    }
    if (method === 'engine/builtinSkills') return { builtinSkills: [{ name: 'engine-only', description: 'Compiled skill', userInvocable: false }] };
    if (method === 'config/read') return { values: structuredClone(values) };
    if (method === 'config/batchWrite') {
      for (const value of data.edits as Json[]) { const edit = object(value); if (edit.value === null) delete values[String(edit.keyPath)]; else values[String(edit.keyPath)] = edit.value!; }
      return { values: structuredClone(values) };
    }
    throw new Error('Unexpected facade method ' + method);
  };
  return { calls, values, request, fail: (value: unknown) => { failure = value; } };
}
async function fixture(root: string, skillExtra: Partial<SkillDeps> = {}, hooksExtra: Partial<HookStyleDeps> = {}) {
  const registry = new ChannelRegistry(), workspaces = workspace(root), engine = facade(root), previews: unknown[] = [], changes: unknown[] = [];
  const skills = registerSkillHandlers(registry, { workspaces, request: engine.request, onChanged: async root => { changes.push({ kind: 'skills', root }); },
    openPreviewWindow: async value => { previews.push(value); }, environment: async () => ({ PATH: '', FIXTURE_EMPTY: '' }), ...skillExtra });
  const hooks = registerHookStyleHandlers(registry, { workspaces, request: engine.request, onChanged: async (kind, root) => { changes.push({ kind, root }); }, ...hooksExtra });
  return { root, registry, skills, hooks, workspaces, engine, previews, changes, close: async () => { await skills.close(); await hooks.close(); } };
}

export function registerSkillsHooksStyleTests(h: Harness, freshRoot: () => string): void {
  h.test('skills hooks and output-style registrars expose twelve real channels', async () => {
    const f = await fixture(freshRoot());
    try {
      assertDeepEqual(f.registry.channels(), [...SKILL_CHANNELS, ...HOOK_STYLE_CHANNELS].sort(), 'actual registrations');
      assertDeepEqual(await invoke(f.registry, 'skills:list'), [], 'fresh profile contains no user installs');
      const builtins = object(await invoke(f.registry, 'skills:builtin'));
      assertEqual(builtins.error, null, 'engine roster loaded');
      const engineOnly = (builtins.items as Json[]).map(object).find(item => item.name === 'engine-only');
      assertEqual(engineOnly?.userInvocable, false, 'engine invocation flag retained');
      assert((builtins.items as Json[]).some(item => object(item).name === 'slash-command-creator'), 'packaged skill command included');
      assertEqual(f.engine.calls[0]?.method, 'engine/builtinSkills', 'named engine roster only');
    } finally { await f.close(); }
  });
  h.test('skill list reports executable environment and platform dependencies instead of hardcoded readiness', async () => {
    const root = freshRoot(), bin = join(root, 'bin');
    await put(join(bin, 'present-tool'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'present-tool'), 0o700);
    await put(join(bin, 'not-executable'), 'data'); await chmod(join(bin, 'not-executable'), 0o600);
    const f = await fixture(root, { environment: async () => ({ PATH: bin, FIXTURE_EMPTY: '' }) });
    try {
      await put(join(root, 'skills/dependencies/SKILL.md'), '---\nname: 17\ndescription: >\n  Multiple lines\n  stay readable\ntags: { first: dev }\nmetadata:\n  klaus:\n    emoji: rocket\n    requires:\n      bins: [present-tool, not-executable, absent]\n      env: [FIXTURE_EMPTY, ABSENT]\n---\nbody');
      await put(join(root, 'skills/platform/SKILL.md'), '---\nmetadata: { openclaw: { os: [win32] } }\n---\nbody');
      await mkdir(join(root, 'skills/empty'));
      kvSet('skill:dependencies', 'off', root);
      const rows = (await invoke(f.registry, 'skills:list') as Json[]).map(object), item = rows.find(row => row.dirName === 'dependencies')!;
      assertEqual(item.name, '17', 'typed name coerced'); assertEqual(item.description, 'Multiple lines stay readable', 'folded description');
      assertDeepEqual(item.missingBins, ['not-executable', 'absent'], 'real execute mode detected');
      assertDeepEqual(item.missingEnv, ['ABSENT'], 'an empty but present environment variable counts present');
      assertEqual(item.dependencyStatus, 'missing', 'binary status takes precedence'); assertEqual(item.userEnabled, false, 'legacy off reader retained');
      assertDeepEqual(item.tags, { first: 'dev' }, 'object category tags');
      assertEqual(rows.find(row => row.dirName === 'platform')?.dependencyStatus, 'unsupported', 'platform restriction retained');
      assertEqual(rows.find(row => row.dirName === 'empty')?.dependencyStatus, 'invalid', 'global directory without SKILL.md remains manageable and visibly invalid');
      await put(join(root, 'skills/malformed/SKILL.md'), '---\nname: [\n---\nbody');
      await put(join(root, 'skills/unclosed/SKILL.md'), '---\nname: Unclosed\nbody');
      const malformed = (await invoke(f.registry, 'skills:list') as Json[]).map(object).find(row => row.dirName === 'malformed');
      assertEqual(malformed?.dependencyStatus, 'invalid', 'one malformed skill remains visible without hiding the list');
      assert(typeof malformed?.error === 'string', 'malformed skill exposes its parse failure');
      const unclosed = (await invoke(f.registry, 'skills:list') as Json[]).map(object).find(row => row.dirName === 'unclosed');
      assertEqual(unclosed?.dependencyStatus, 'invalid', 'an unclosed frontmatter fence is visible as invalid');
      const project = join(root, 'project'); await mkdir(join(project, '.klaus/skills/empty'), { recursive: true }); f.workspaces.projectsAdd({ path: project });
      assertDeepEqual(await invoke(f.registry, 'skills:list', { projectRoot: project }), [], 'project noise guard requires SKILL.md');
    } finally { await f.close(); }
  });
  h.test('skill toggles retain private preference fields and uninstall updates the compatible install record', async () => {
    const f = await fixture(freshRoot());
    try {
      await put(join(f.root, 'skills/remove-me/SKILL.md'), '# Installed');
      await put(join(f.root, 'skills/.install-records.json'), JSON.stringify({ version: 1, extra: true, records: [{ slug: 'remove-me', source: 'fixture' }, { slug: 'keep-me' }] }));
      kvSet('skill:remove-me', JSON.stringify({ encryptedApiKey: 'opaque-existing-value', extra: 1 }), f.root);
      assertEqual(await invoke(f.registry, 'skills:toggle', { name: 'remove-me', enabled: false }), null, 'void toggle contract');
      assertDeepEqual(JSON.parse(String(kvGet('skill:remove-me', f.root))), { encryptedApiKey: 'opaque-existing-value', extra: 1, enabled: false }, 'existing fields retained');
      assertEqual(await invoke(f.registry, 'skills:uninstall', { name: 'remove-me' }), true, 'actual directory removed');
      assertEqual(await present(join(f.root, 'skills/remove-me')), false, 'installed directory absent');
      assertEqual(kvGet('skill:remove-me', f.root), '', 'existing preference clearing shape');
      assertDeepEqual(JSON.parse(await readFile(join(f.root, 'skills/.install-records.json'), 'utf8')), { version: 1, extra: true, records: [{ slug: 'keep-me' }] }, 'record removed without losing envelope');
      assertEqual(f.changes.length, 2, 'toggle and uninstall both invalidate declarations');
      assertEqual(await invoke(f.registry, 'skills:uninstall', { name: '../escape' }), false, 'invalid directory name refused');
      await assertRejects(() => invoke(f.registry, 'skills:toggle', { name: '../escape', enabled: true }), 'invalid toggle name refused');
      await assertRejects(() => invoke(f.registry, 'skills:toggle', { name: 'valid', enabled: 'yes' }), 'non-boolean toggle state refused');
      assertEqual(kvGet('skill:../escape', f.root), null, 'invalid toggle writes no preference');
    } finally { await f.close(); }
  });
  h.test('saved toggle and uninstall results remain truthful when live reload fails', async () => {
    const root = freshRoot(), f = await fixture(root, { onChanged: async () => { throw new Error('reload fixture failure'); } });
    try {
      await put(join(root, 'skills/toggle-me/SKILL.md'), '# Toggle');
      await put(join(root, 'skills/remove-me/SKILL.md'), '# Remove');
      assertDeepEqual(await invoke(f.registry, 'skills:toggle', { name: 'toggle-me', enabled: false }), {
        ok: false, saved: true, reloadRequired: true,
        error: 'Skill preference was saved, but live sessions could not reload: reload fixture failure',
      }, 'toggle reports the durable preference');
      assertEqual(object(JSON.parse(String(kvGet('skill:toggle-me', root)))).enabled, false, 'toggle preference remains saved');
      assertDeepEqual(await invoke(f.registry, 'skills:uninstall', { name: 'remove-me' }), {
        ok: false, removed: true, reloadRequired: true,
        error: 'Skill was removed, but live sessions could not reload: reload fixture failure',
      }, 'uninstall reports the durable removal');
      assertEqual(await present(join(root, 'skills/remove-me')), false, 'removed skill stays removed');
    } finally { await f.close(); }
  });
  h.test('skill project operations accept multi-folder members and refuse unregistered roots and symlink escapes', async () => {
    const root = freshRoot(), project = join(root, 'project'), secondary = join(root, 'secondary'), unknown = join(root, 'unknown'), outside = freshRoot();
    for (const dir of [project, secondary, unknown]) await put(join(dir, '.klaus/skills/demo/SKILL.md'), 'content');
    const f = await fixture(root);
    try {
      f.workspaces.save({ id: 'group', name: 'Group', roots: [project, secondary] });
      await assertRejects(() => invoke(f.registry, 'skills:list', { projectRoot: unknown }), 'unregistered project list refused');
      assertEqual(await invoke(f.registry, 'skills:uninstall', { name: 'demo', projectRoot: unknown }), false, 'unregistered project refused');
      assertEqual(object(await invoke(f.registry, 'skills:open-window', { name: 'demo', projectRoot: unknown })).error, 'unknown-project-root', 'unregistered preview refused');
      assertEqual(object(await invoke(f.registry, 'skills:read-file', { filePath: join(secondary, '.klaus/skills/demo/SKILL.md') })).content, 'content', 'workspace member preview');
      assertEqual(await invoke(f.registry, 'skills:uninstall', { name: 'demo', projectRoot: secondary }), true, 'workspace member uninstall');
      await put(join(outside, 'secret.md'), 'private'); await symlink(join(outside, 'secret.md'), join(project, '.klaus/skills/demo/escape.md'));
      assertEqual(object(await invoke(f.registry, 'skills:read-file', { filePath: join(project, '.klaus/skills/demo/escape.md') })).error, 'path-escape', 'realpath boundary');
      assertEqual(object(await invoke(f.registry, 'skills:read-file', { filePath: '../settings.db' })).error, 'path-escape', 'relative traversal refused');
    } finally { await f.close(); }
  });
  h.test('workspace tabs list every member folder skill with its owning root', async () => {
    const root = freshRoot(), primary = join(root, 'ws-a'), secondary = join(root, 'ws-b');
    await put(join(primary, '.klaus/skills/alpha/SKILL.md'), '---\ndescription: A\n---\nalpha');
    await put(join(secondary, '.klaus/skills/beta/SKILL.md'), '---\ndescription: B\n---\nbeta');
    await put(join(secondary, '.klaus/skills/alpha/SKILL.md'), '---\ndescription: shadow\n---\nshadow');
    const f = await fixture(root);
    try {
      const group = object(f.workspaces.save({ id: 'ws', name: 'Space', roots: [primary, secondary] }));
      const rows = (await invoke(f.registry, 'skills:list', { workspaceId: String(group.id) })) as Json[];
      const byName = new Map(rows.map(row => [String(object(row).name), object(row)]));
      assertDeepEqual([...byName.keys()].sort(), ['alpha', 'beta'], 'both member folders contribute');
      assertEqual(object(byName.get('alpha')).root, primary, 'duplicate name resolves to the earliest member root');
      assertEqual(object(byName.get('beta')).root, secondary, 'row carries its owning member root');
      assertEqual(await invoke(f.registry, 'skills:uninstall', { name: 'beta', projectRoot: secondary }), true, 'uninstall targets the owning member root');
      assertEqual(await present(join(secondary, '.klaus/skills/beta/SKILL.md')), false, 'member skill removed');
      assertEqual(await present(join(primary, '.klaus/skills/alpha/SKILL.md')), true, 'other member untouched');
      assertDeepEqual(await invoke(f.registry, 'skills:list', { workspaceId: 'missing' }), [], 'unknown workspace yields the empty project list');
    } finally { await f.close(); }
  });
  h.test('hooks workspace scope reads every member file and writes the primary root', async () => {
    const root = freshRoot(), primary = join(root, 'ws-a'), secondary = join(root, 'ws-b');
    await put(join(primary, '.klaus/hooks.json'), JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'a' }] }] }));
    await put(join(secondary, '.klaus/hooks.json'), JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'b' }] }] }));
    const f = await fixture(root);
    try {
      const group = object(f.workspaces.save({ id: 'ws', name: 'Space', roots: [primary, secondary] }));
      const reply = object(await invoke(f.registry, 'klaus:hooks:get', { workspaceId: String(group.id) }));
      assertEqual(reply.ok, true, 'workspace hooks read succeeds');
      const events = new Set((reply.rows as Json[]).map(row => String(object(row).event)));
      assert(events.has('PreToolUse') && events.has('Stop'), 'both member declarations listed');
      const write = object(await invoke(f.registry, 'klaus:hooks:set', { workspaceId: String(group.id), hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'written' }] }] } }));
      assertEqual(write.ok, true, 'workspace hooks write succeeds');
      const written = JSON.parse(await readFile(join(primary, '.klaus/hooks.json'), 'utf8'));
      assertEqual(written.PreToolUse[0].hooks[0].command, 'written', 'write lands in the primary root');
      assertEqual(await present(join(secondary, '.klaus/hooks.json')), true, 'other member file untouched');
    } finally { await f.close(); }
  });
  h.test('skill preview bounds bytes and window failures stay visible even for stale file entries', async () => {
    const f = await fixture(freshRoot());
    try {
      await put(join(f.root, 'skills/large/SKILL.md'), 'x'.repeat(1024 * 1024 + 5));
      const read = object(await invoke(f.registry, 'skills:read-file', { filePath: 'large/SKILL.md' }));
      assertEqual(String(read.content).length, 1024 * 1024, 'preview cap'); assertEqual(read.size, 1024 * 1024 + 5, 'full metadata size'); assertEqual(read.truncated, true, 'truncation explicit');
      assertDeepEqual(await invoke(f.registry, 'skills:open-window', { name: 'stale' }), { ok: true }, 'stale row still opens preview to display read failure');
      assertDeepEqual(f.previews, [{ kind: 'skill', filePath: join(f.root, 'skills/stale/SKILL.md') }], 'actual window options');
      const failed = new SkillService({ workspaces: f.workspaces, request: f.engine.request, onChanged: async () => {}, openPreviewWindow: async () => { throw new Error('window creation failed'); } });
      try { assertEqual(object(await failed.openWindow({ name: 'stale' })).error, 'window creation failed', 'window failure retained'); }
      finally { await failed.close(); }
      f.engine.fail(new Error('engine unavailable'));
      const builtin = object(await invoke(f.registry, 'skills:builtin'));
      assertEqual(object(builtin.error).message, 'engine unavailable', 'partial builtin roster reports failure');
      assert((builtin.items as Json[]).length > 0, 'packaged builtin roster remains usable');
    } finally { await f.close(); }
  });
  h.test('hooks edits call the named engine store and preserve authoritative events with project path validation', async () => {
    const f = await fixture(freshRoot()), project = join(f.root, 'project'); await mkdir(project);
    try {
      f.workspaces.projectsAdd({ path: project });
      const hooks = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo fixture', timeout: 2 }] }] };
      const saved = object(await invoke(f.registry, 'settings:hooks:set', { hooks: { hooks } }));
      assertEqual(saved.ok, true, 'legacy wrapper reaches store'); assertDeepEqual(saved.events, ['PreToolUse', 'Stop'], 'events come from engine');
      assertDeepEqual(f.engine.calls.at(-1), { method: 'hooks/write', params: { hooks } }, 'only named engine write');
      assertDeepEqual(JSON.parse(await readFile(join(f.root, 'hooks.json'), 'utf8')), hooks, 'engine fixture owns actual file');
      const projectSaved = object(await invoke(f.registry, 'klaus:hooks:set', { projectRoot: project, hooks }));
      assertEqual(projectSaved.path, join(project, '.klaus/hooks.json'), 'project file passed by validated path');
      assertDeepEqual(f.changes, [{ kind: 'hooks' }, { kind: 'hooks', root: project }], 'reload context retained');
      const before = f.engine.calls.length;
      for (const projectRoot of [' ', 2, join(f.root, 'unregistered')]) assertEqual(object(await invoke(f.registry, 'klaus:hooks:set', { projectRoot, hooks })).ok, false, 'invalid or unknown root refused');
      assertEqual(f.engine.calls.length, before, 'refused paths never reach engine');
      assertEqual(object(await invoke(f.registry, 'settings:hooks:set', { hooks: {} })).ok, true, 'explicit empty hooks clears');
      assertDeepEqual(JSON.parse(await readFile(join(f.root, 'hooks.json'), 'utf8')), {}, 'clear reached actual engine file');
    } finally { await f.close(); }
  });
  h.test('hook validation failures and malformed engine replies never report a successful save', async () => {
    const f = await fixture(freshRoot());
    try {
      f.engine.fail({ message: 'Unsupported hook event' }); const hooks = { InventedEvent: [] };
      const reply = object(await invoke(f.registry, 'settings:hooks:set', { hooks }));
      assertEqual(reply.ok, false, 'engine refusal visible'); assertEqual(reply.error, 'Unsupported hook event', 'engine error text'); assertDeepEqual(reply.hooks, hooks, 'editor keeps attempted content');
      assertEqual(f.changes.length, 0, 'failed save never reloads'); assertEqual(await present(join(f.root, 'hooks.json')), false, 'host did not bypass the engine');
      const malformed = new HookStyleService({ workspaces: f.workspaces, request: async () => ({}), onChanged: async () => {} });
      try { assertEqual(object(await malformed.hooksGet()).ok, false, 'malformed successful RPC does not fabricate empty hooks'); }
      finally { await malformed.close(); }
    } finally { await f.close(); }
  });
  h.test('output-style settings read and write engine config while retaining user override and default absence', async () => {
    const f = await fixture(freshRoot());
    try {
      await put(join(f.root, 'output-styles/custom.md'), '---\nname: Explanatory\ndescription: local override\nkeep-coding-instructions: false\n---\nCustom body');
      await put(join(f.root, 'output-styles/other.md'), '---\nname: Other\nkeep-coding-instructions: unrecognized\n---\n# Useful description');
      f.engine.values.outputStyle = 'Explanatory'; f.engine.values.unrelated = 'kept';
      const list = object(await invoke(f.registry, 'settings:output-styles:list'));
      const rows = (list.styles as Json[]).map(object), explanatory = rows.find(row => row.id === 'Explanatory');
      assertEqual(explanatory?.source, 'userSettings', 'user override replaces builtin row'); assertEqual(explanatory?.active, true, 'engine current selection'); assertEqual(explanatory?.keepCodingInstructions, false, 'typed false retained');
      assertEqual(rows.find(row => row.id === 'Other')?.keepCodingInstructions, true, 'unrecognized coding flag inherits true');
      assertDeepEqual(await invoke(f.registry, 'settings:output-styles:set', { style: 'Other' }), { ok: true, current: 'Other' }, 'known user style selected');
      assertDeepEqual(f.engine.calls.at(-1), { method: 'config/batchWrite', params: { edits: [{ keyPath: 'outputStyle', value: 'Other', mergeStrategy: 'replace' }] } }, 'targeted config edit');
      assertDeepEqual(await invoke(f.registry, 'settings:output-styles:set', { style: 'default' }), { ok: true, current: 'default' }, 'default selected');
      assertEqual(f.engine.values.outputStyle, undefined, 'default is absence'); assertEqual(f.engine.values.unrelated, 'kept', 'other config retained');
      const before = f.engine.calls.length;
      assertEqual(object(await invoke(f.registry, 'settings:output-styles:set', { style: 'unknown' })).error, 'unknown_style', 'unknown style refused');
      assertEqual(f.engine.calls.length, before, 'no invalid write'); assertEqual(kvGet('outputStyle', f.root), null, 'no second SQLite setting');
    } finally { await f.close(); }
  });
  h.test('output-style init ships full prompts and stops ancestor discovery at the checkout boundary', async () => {
    const root = freshRoot(), checkout = join(root, 'outer/repo'), cwd = join(checkout, 'nested'); await mkdir(cwd, { recursive: true });
    await put(join(checkout, '.git'), 'gitdir: fixture');
    await put(join(root, 'output-styles/user.md'), '---\nname: Explanatory\n---\nuser');
    await put(join(cwd, '.klaus/output-styles/inner.md'), '---\nname: Explanatory\n---\ninner');
    await put(join(checkout, '.klaus/output-styles/root.md'), '---\nname: Explanatory\n---\nroot');
    await put(join(root, 'outer/.klaus/output-styles/leak.md'), '---\nname: MustNotLeak\n---\nwrong checkout');
    const f = await fixture(root);
    try {
      const fields = await f.hooks.sessionExtensions(cwd, { outputStyle: 'Explanatory' }), styles = (fields.outputStyles as Json[]).map(object);
      assertEqual(styles.find(style => style.name === 'Explanatory')?.body, 'root', 'outer checkout scope wins after inner');
      assertEqual(styles.some(style => style.name === 'MustNotLeak'), false, 'parent checkout excluded');
      assert(String(styles.find(style => style.name === 'Learning')?.body).length > 4000, 'packaged Learning prompt is real content');
      assertEqual(fields.selectedOutputStyle, 'Explanatory', 'selected style sent to engine');
      assertEqual((await f.hooks.sessionExtensions(cwd, {})).selectedOutputStyle, undefined, 'default stays omitted');
      assertEqual(f.engine.calls.length, 0, 'provided config snapshot avoids another config read');
    } finally { await f.close(); }
  });
  h.test('hooks and skill shutdown drain active updates while refusing queued changes', async () => {
    let entered = false, release!: () => void;
    const blocker = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(freshRoot(), { onChanged: async () => { entered = true; await blocker; } });
    let first: Promise<Json> | undefined, queued: Promise<Json> | undefined, closing: Promise<void> | undefined;
    try {
      first = f.skills.toggle({ name: 'first', enabled: true }); await waitFor(() => entered, 1000, 'active mutation enters refresh');
      queued = f.skills.toggle({ name: 'queued', enabled: true });
      const rejection = assertRejects(() => queued!, 'queued change must reject after close'); closing = f.skills.close(); release();
      await first; await rejection; await closing;
      assertEqual(kvGet('skill:queued', f.root), null, 'queued preference never written');
      await f.hooks.close(); assertEqual(object(await f.hooks.hooksSet({ hooks: {} })).ok, false, 'closed hook service refuses engine writes');
    } finally { release(); await Promise.allSettled([first, queued, closing]); await f.close(); }
  });
}
