import { chmod, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { readFileSync, watch } from 'node:fs';
import { basename, join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry, IpcHandlerError } from '../main/ipc/registry';
import { registerFileHandlers, FILE_CHANNELS } from '../main/ipc/handlers/files';
import { registerWorkspaceHandlers, WORKSPACE_CHANNELS } from '../main/ipc/handlers/workspaces';
import type { FileDeps } from '../main/services/files';
import { normalizeProjectPath, WorkspaceStore } from '../main/services/workspaces';
import { kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { object } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor, sleep } from './harness';

async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'registered ' + channel);
  return handler({ role: 'main', senderId: 1, channel, args: payload === undefined ? [] : [payload] });
}
async function fixture(root: string, extra: Partial<FileDeps> = {}) {
  const registry = new ChannelRegistry(), pushes: Json[] = [], changed: string[] = [], actions: Array<{ kind: string; path: string }> = [];
  const previewWindows: unknown[] = [], requestCalls: unknown[] = [];
  const workspaces = registerWorkspaceHandlers(registry, {
    configRoot: root, push: (_channel, payload) => pushes.push(payload),
    onSessionWorkdirChanged: id => { changed.push(id); }, isSessionKnown: id => id === 'live', pickDirectory: async () => null,
  });
  const files = registerFileHandlers(registry, {
    workspaces, push: (_channel, payload) => pushes.push(payload), watch: false,
    openPath: async path => { actions.push({ kind: 'open', path }); },
    revealPath: path => { actions.push({ kind: 'reveal', path }); },
    trashPath: async path => { await mkdir(join(root, 'fixture-trash'), { recursive: true }); await rename(path, join(root, 'fixture-trash', 'deleted')); },
    openPreviewWindow: async options => { previewWindows.push(options); },
    requestSession: async (sessionId, method, params) => { requestCalls.push({ sessionId, method, params }); return { fileChanges: [] }; },
    ...extra,
  });
  const dir = join(root, 'project'); await mkdir(dir);
  workspaces.bindSession('s', { workdir: dir });
  return { registry, workspaces, files, pushes, changed, dir, actions, previewWindows, requestCalls };
}

export function registerFileWorkspaceTests(h: Harness, freshRoot: () => string): void {
  const loading = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/workspace-directory-loading.json'), 'utf8')) as {
    deepPath: string; fileName: string; directoryEntryLimit: number; browseIncludes: string[];
    unloaded: { childrenLoaded: boolean; truncated: boolean }; oversized: { childrenLoaded: boolean; truncated: boolean };
  };
  h.test('deep folders advertise unloaded children and a scoped child request reaches their real files', async () => {
    const f = await fixture(freshRoot());
    try {
      const dir = join(f.dir, loading.deepPath); await mkdir(dir, { recursive: true }); await writeFile(join(dir, loading.fileName), '<h1>fixture</h1>');
      let rows = object(await invoke(f.registry, 'workspace:list', { sessionId: 's' })).tree as Json[];
      let node: ReturnType<typeof object> = {};
      let directory = f.dir;
      for (const name of loading.deepPath.split('/')) {
        node = object(rows.find(row => object(row).name === name));
        assertEqual(node.childrenLoaded, false, 'each directory starts unloaded');
        directory = join(directory, name);
        rows = object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath: directory })).tree as Json[];
      }
      assertEqual(node.childrenLoaded, loading.unloaded.childrenLoaded, 'depth cutoff is not an empty folder');
      assertEqual(node.truncated, loading.unloaded.truncated, 'unloaded directory can be fully loaded');
      const children = object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath: dir }));
      assertEqual(children.childrenLoaded, true, 'child request completes one directory');
      assertEqual(children.truncated, false, 'small folder is complete');
      assertDeepEqual((children.tree as Json[]).map(row => object(row).name), [loading.fileName], 'deep file is reachable');
    } finally { f.files.close(); }
  });
  h.test('oversized directory reports its bounded listing and child requests preserve exclusion and scope', async () => {
    const f = await fixture(freshRoot());
    try {
      const dir = join(f.dir, 'many'); await mkdir(dir);
      for (let index = 0; index <= loading.directoryEntryLimit; index++) await writeFile(join(dir, `file-${index}.txt`), 'fixture');
      const listed = object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath: dir }));
      assertEqual((listed.tree as Json[]).length, loading.directoryEntryLimit, 'bounded number of entries');
      assertEqual(listed.truncated, loading.oversized.truncated, 'overflow is visible');
      assertEqual(listed.childrenLoaded, loading.oversized.childrenLoaded, 'listing was attempted');
      const outside = join(f.workspaces.configRoot, 'outside'); await mkdir(outside);
      await symlink(outside, join(f.dir, 'escape'), 'dir');
      await mkdir(join(f.dir, 'node_modules'));
      assertEqual(object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath: join(f.dir, 'node_modules') })).childrenLoaded, true, 'generated directories are browsable');
      for (const filePath of [outside, join(f.dir, 'escape')]) {
        assert(typeof object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath })).error === 'string', 'forbidden lazy directory is rejected');
      }
      await invoke(f.registry, 'workspace:set-excludes', { patterns: ['many'] });
      assertEqual(object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath: dir })).error, 'directory is excluded', 'user exclusions apply to lazy loads');
      const nested = join(dir, 'nested'); await mkdir(nested);
      assertEqual(object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath: nested })).error, 'directory is excluded', 'a direct child request cannot bypass an excluded ancestor');
    } finally { f.files.close(); }
  });
  h.test('filename filtering includes hidden generated and deep files while preserving exclusions and root boundaries', async () => {
    const f = await fixture(freshRoot());
    try {
      for (const name of ['.git', 'node_modules', 'dist', 'hidden', 'deep/a/b/c/d/e/f']) {
        await mkdir(join(f.dir, name), { recursive: true });
        await writeFile(join(f.dir, name, 'match.ts'), 'fixture');
      }
      const outside = join(f.workspaces.configRoot, 'outside-search'); await mkdir(outside);
      await writeFile(join(outside, 'match-secret.ts'), 'secret'); await symlink(outside, join(f.dir, 'escape'), 'dir');
      await invoke(f.registry, 'workspace:set-excludes', { patterns: ['hidden'] });
      const result = object(await invoke(f.registry, 'workspace:search', { sessionId: 's', query: 'match' }));
      const hits = (result.hits as Json[]).map(row => String(object(row).rel));
      assertEqual(result.truncated, false, 'small workspace is complete');
      assertDeepEqual(hits, ['.git/match.ts', 'deep/a/b/c/d/e/f/match.ts', 'dist/match.ts', 'node_modules/match.ts'].map(name => join(f.dir, name)), 'browse and filter enumerate the same file set');
      await invoke(f.registry, 'workspace:set-excludes', { patterns: ['dist'] });
      const refreshed = object(await invoke(f.registry, 'workspace:search', { sessionId: 's', query: 'match' }));
      const paths = (refreshed.hits as Json[]).map(row => String(object(row).rel));
      assert(paths.includes(join(f.dir, 'hidden/match.ts')) && !paths.includes(join(f.dir, 'dist/match.ts')), 'changing exclusions invalidates the search snapshot');
    } finally { f.files.close(); }
  });
  h.test('files/workspaces register 34 real channels and enforce duplicate ownership', async () => {
    const f = await fixture(freshRoot());
    try {
      assertDeepEqual(f.registry.channels(), [...FILE_CHANNELS, ...WORKSPACE_CHANNELS].sort(), 'actual registrations');
      assertEqual(f.registry.size(), 34, 'registered channels');
      assertDeepEqual(await invoke(f.registry, 'session:pick-workdir'), { path: null }, 'cancelled picker');
      assertDeepEqual(await invoke(f.registry, 'session:pick-workdirs'), { paths: [] }, 'cancelled multi picker');
      assertDeepEqual(await invoke(f.registry, 'workspace:list', {}), { error: 'invalid sessionId' }, 'invalid arguments reach service');
      assert(await assertRejects(async () => f.registry.register('workspace:list', () => ({}), 'duplicate'), 'duplicate refused') instanceof Error, 'duplicate error');
    } finally { f.files.close(); }
  });
  h.test('pickWorkdirs deduplicates the multi picker selection and falls back to the single picker', async () => {
    const root = freshRoot();
    const multi = new WorkspaceStore({
      configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {},
      pickDirectory: async () => join(root, 'one'),
      pickDirectories: async () => [join(root, 'a'), join(root, 'a'), join(root, 'b'), 42 as unknown as string],
    });
    assertDeepEqual(await multi.pickWorkdirs(), { paths: [join(root, 'a'), join(root, 'b')] }, 'deduplicated string selection');
    const single = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => join(root, 'one') });
    assertDeepEqual(await single.pickWorkdirs(), { paths: [join(root, 'one')] }, 'single picker wrapped as a list');
    const cancelled = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
    assertDeepEqual(await cancelled.pickWorkdirs(), { paths: [] }, 'cancelled single picker yields no paths');
  });

  h.test('workspace binding writes existing tables atomically and retains projectless scratch identity', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      const second = join(root, 'other'); await mkdir(second);
      const group = object(await invoke(f.registry, 'workspaces:save', { name: 'Set', roots: [f.dir, second, second, 'relative'] }));
      await invoke(f.registry, 'session:set-workspace', { sessionId: 's', workspaceId: group.id! });
      assertEqual(f.workspaces.customWorkdir('s'), f.dir, 'primary root stored');
      assertDeepEqual(f.workspaces.extraRoots('s'), [second], 'additional roots in order');
      assert(f.workspaces.contextNote('s')?.includes(second), 'developer note contains extra folder');
      const rows = withSettingsDb(root, db => db.prepare('SELECT workdir, workspace_id FROM session_workdirs JOIN session_workspaces USING(session_id) WHERE session_id = ?').get('s'));
      assertEqual(rows?.workspace_id, String(group.id), 'same schema workspace row');
      assertDeepEqual(await invoke(f.registry, 'session:set-workspace', { sessionId: 's', workspaceId: 'missing' }), { error: 'unknown workspace' }, 'unknown group refused');
      assertEqual(f.workspaces.customWorkdir('s'), f.dir, 'failed mutation kept prior binding');
      await invoke(f.registry, 'session:set-workdir', { sessionId: 's', dir: second });
      assertEqual(f.workspaces.workspaceId('s'), undefined, 'plain folder clears workspace id');
      const scratch = join(root, 'sessions', 'engine-scratch'); f.workspaces.rememberScratchWorkdir('s', scratch);
      await invoke(f.registry, 'session:clear-workdir', { sessionId: 's' });
      assertEqual(await f.workspaces.sessionDirectory('s'), scratch, 'scratch remains same as engine init');
      assertEqual(f.changed.length, 3, 'each successful mutation invalidates live binding once');
      assertEqual(f.pushes.filter(row => object(row).type === 'workspace:invalidated').length, 3, 'each mutation pushes refresh');
      assertDeepEqual(await invoke(f.registry, 'session:get-workdir', { sessionId: 'live' }), { custom: null, hasMessages: true }, 'live empty session locked');
      await mkdir(join(root, 'projects', 'p'), { recursive: true }); await writeFile(join(root, 'projects', 'p', 'old.jsonl'), '{}\n');
      assertEqual(object(await invoke(f.registry, 'session:get-workdir', { sessionId: 'old' })).hasMessages, true, 'persisted transcript known');
    } finally { f.files.close(); }
  });
  h.test('managed session directories never become sidebar project identities', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      const scratch = join(root, 'sessions', 'imported-thread'); await mkdir(scratch, { recursive: true });
      const row = object(f.workspaces.decorateSessionRows([{ id: 'imported-thread', workdir: scratch, title: 'Imported' }])[0]);
      assertEqual(row.workdir, null, 'projectless engine cwd is not a user project workdir');
      assertEqual(row.projectRoot, null, 'projectless engine cwd does not create a sidebar row');
      await invoke(f.registry, 'session:set-workdir', { sessionId: 'imported-thread', dir: f.dir });
      const bound = object(f.workspaces.decorateSessionRows([{ id: 'imported-thread', workdir: scratch }])[0]);
      assertEqual(bound.workdir, f.dir, 'explicit project binding overrides the managed cwd');
      assertEqual(bound.projectRoot, f.dir, 'explicit project binding still groups the imported session');
      const project = object(f.workspaces.decorateSessionRows([{ id: 'project-thread', workdir: f.dir }])[0]);
      assertEqual(project.workdir, f.dir, 'ordinary project cwd remains visible');
      assertEqual(project.projectRoot, f.dir, 'ordinary project cwd retains grouping');
    } finally { f.files.close(); }
  });
  h.test('workspace group save never promotes its folders and migration keeps intentional projects', async () => {
    const root = freshRoot(), a = join(root, 'a'), b = join(root, 'b'), c = join(root, 'c');
    kvSet('workspace.groups', JSON.stringify([{ id: 'old', name: 'Old', roots: [a, b, c] }]), root);
    kvSet('workspace.roots', JSON.stringify([a, b, c]), root); kvSet('workspace.project_order', JSON.stringify([c, b, a]), root);
    kvSet('workspace.labels', JSON.stringify({ [b]: 'Label' }), root); kvSet('workspace.active_root', a, root);
    withSettingsDb(root, db => {
      db.exec('CREATE TABLE session_workdirs (session_id TEXT PRIMARY KEY, workdir TEXT NOT NULL, updated_at INTEGER NOT NULL)');
      db.exec('CREATE TABLE session_workspaces (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO session_workdirs VALUES (?, ?, ?)').run('standalone', c, 1);
    });
    const store = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
    const state = object(store.projectsList());
    assertDeepEqual((state.roots as Json[]).map(row => object(row).path), [b], 'member-only root removed, labelled kept, standalone-used member registered but never rendered');
    assertEqual(state.activeRoot, null, 'orphan active root cleared');
    assertEqual(kvGet('workspace.project_members_separated.v1', root), '1', 'migration marker retained');
    assertDeepEqual(JSON.parse(String(kvGet('workspace.project_members_separated.backup.v1', root))), { roots: [a, b, c], projectOrder: [c, b, a], activeRoot: a }, 'backup before cleanup');
    store.delete({ id: 'old' });
    const saved = object(store.save({ roots: [a], name: 'Only group' }));
    assertEqual((object(store.projectsList()).roots as Json[]).length, 2, 'save did not register group member');
    store.delete({ id: saved.id! });
    assertEqual((object(store.projectsList()).roots as Json[]).length, 2, 'delete kept independent projects');
    store.projectsAdd({ path: a }); assertEqual((object(store.projectsList()).roots as Json[]).length, 3, 'explicit add survives one-time migration');
  });
  h.test('workspace member folders never re-enter the registry through bind or activate', () => {
    const root = freshRoot(), member = join(root, 'member'), plain = join(root, 'plain');
    kvSet('workspace.groups', JSON.stringify([{ id: 'g1', name: 'G', roots: [member] }]), root);
    kvSet('workspace.project_members_separated.v1', '1', root);
    const store = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
    const roots = () => (object(store.projectsList()).roots as Json[]).map(row => object(row).path);
    store.bindSession('direct-member', { workdir: member });
    assertDeepEqual(roots(), [], 'binding a session inside a member folder registers nothing');
    assertEqual(kvGet('workspace.active_root', root) ?? '', '', 'the member folder does not steal the default project');
    store.projectsSetActive({ path: plain });
    assertDeepEqual(roots(), [plain], 'an ordinary folder still becomes the active project');
    store.projectsSetActive({ path: member });
    assertDeepEqual(roots(), [plain], 'activating a member folder registers nothing');
    assertEqual(kvGet('workspace.active_root', root), plain, 'the previous default project survives member activation');
    kvSet('workspace.roots', JSON.stringify([member, plain]), root);
    kvSet('workspace.project_order', JSON.stringify([member, plain]), root);
    assertDeepEqual(roots(), [plain], 'registry residue for a member folder stays hidden');
  });
  h.test('project list never derives projects from session workdir bindings', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      // An unbound binding row whose transcript is gone (orphan) and one whose
      // session is live: neither may surface as a registered project, and a
      // workspace member folder must not become a bare project either.
      const orphan = join(root, 'orphan'), member = join(root, 'member');
      withSettingsDb(root, db => {
        db.exec('CREATE TABLE IF NOT EXISTS session_workdirs (session_id TEXT PRIMARY KEY, workdir TEXT NOT NULL, updated_at INTEGER NOT NULL)');
        db.prepare('INSERT INTO session_workdirs VALUES (?, ?, ?)').run('gone', orphan, 1);
      });
      const group = object(f.workspaces.save({ id: 'ws', name: 'Space', roots: [member, join(root, 'second')] }));
      f.workspaces.bindSession('ws-session', { workspaceId: String(group.id) });
      const state = object(f.workspaces.projectsList());
      assertDeepEqual((state.roots as Json[]).map(row => object(row).path), [f.dir], 'only the fixture-registered project lists');
      f.workspaces.projectsAdd({ path: orphan });
      const listed = object(f.workspaces.projectsList());
      assertDeepEqual((listed.roots as Json[]).map(row => object(row).path), [orphan, f.dir], 'only explicit registration lists');
      await invoke(f.registry, 'projects:remove', { path: orphan });
      assertDeepEqual((object(f.workspaces.projectsList()).roots as Json[]).map(row => object(row).path), [f.dir], 'removal sticks without resurrection');
      assertEqual(f.workspaces.customWorkdir('gone'), orphan, 'binding row itself survives removal');
    } finally { f.files.close(); }
  });
  h.test('deleting a workspace never strands its sessions and can take them along', async () => {
    const root = freshRoot(), f = await fixture(root);
    const primary = join(root, 'ws-a'), secondary = join(root, 'ws-b');
    try {
      const group = object(f.workspaces.save({ id: 'ws', name: 'Space', roots: [primary, secondary] }));
      f.workspaces.bindSession('kept', { workspaceId: String(group.id) });
      f.workspaces.bindSession('gone', { workspaceId: String(group.id) });
      const plain = object(f.workspaces.delete({ id: String(group.id) }));
      assertDeepEqual([...plain.deletedSessions as string[]].sort(), ['gone', 'kept'], 'deletion reports every bound session');
      assertEqual(f.workspaces.workspaceId('kept'), undefined, 'membership unbound');
      assertEqual(f.workspaces.customWorkdir('kept'), primary, 'workdir survives so the session stays visible');
      const again = object(f.workspaces.save({ id: 'ws2', name: 'Space2', roots: [primary] }));
      f.workspaces.bindSession('doomed', { workspaceId: String(again.id) });
      const withSessions = object(f.workspaces.delete({ id: String(again.id), deleteSessions: true }));
      assertDeepEqual(withSessions.deletedSessions, ['doomed'], 'explicit flag reports the same ids');
      assertEqual(f.workspaces.customWorkdir('doomed'), undefined, 'bindings cleared for host transcript deletion');
      assertDeepEqual(object(f.workspaces.list()).workspaces, [], 'group registry empty after both deletions');
    } finally { f.files.close(); }
  });
  h.test('workspace session file list spans every member folder with absolute-path operations', async () => {
    const root = freshRoot(), f = await fixture(root);
    const primary = join(root, 'ws-a'), secondary = join(root, 'ws-b');
    try {
      const group = object(f.workspaces.save({ id: 'ws', name: 'Space', roots: [primary, secondary] }));
      f.workspaces.bindSession('s', { workspaceId: String(group.id) });
      await mkdir(primary); await mkdir(secondary);
      await writeFile(join(primary, 'a.txt'), 'a'); await writeFile(join(secondary, 'b.txt'), 'b');
      const list = object(await invoke(f.registry, 'workspace:list', { sessionId: 's' }));
      const names = (list.tree as Json[]).map(row => object(row).name);
      assert(names.includes(basename(primary)) || names.includes('a.txt'), 'primary content listed');
      assert(names.includes(basename(secondary)), 'secondary folder appears as a top-level node');
      const read = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: join(secondary, 'b.txt') }));
      assertEqual(read.error, undefined, 'member file readable');
      const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 's');
      const refused = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: join(outside, 'secret') }));
      assert(refused.error, 'paths outside every member root stay refused');
    } finally { f.files.close(); }
  });
  h.test('workspace database failure rolls back cwd and membership together before invalidation', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      const group = object(f.workspaces.save({ id: 'new', roots: [join(root, 'new-root')] }));
      withSettingsDb(root, db => db.exec("CREATE TRIGGER refuse_membership BEFORE INSERT ON session_workspaces BEGIN SELECT RAISE(ABORT, 'fixture membership failure'); END"));
      await assertRejects(() => invoke(f.registry, 'session:set-workspace', { sessionId: 's', workspaceId: group.id! }), 'failed second row');
      assertEqual(f.workspaces.customWorkdir('s'), f.dir, 'cwd write rolled back');
      assertEqual(f.workspaces.workspaceId('s'), undefined, 'membership remained absent');
      assertEqual(f.changed.length, 0, 'failed transaction did not stale session');
      assertEqual(f.pushes.length, 0, 'failed transaction emitted no success event');
    } finally { f.files.close(); }
  });
  h.test('project roots preserve ordering, labels and managed worktree isolation', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      const extra = join(root, 'b'); await invoke(f.registry, 'projects:add', { path: extra + '/', label: ' Bee ' });
      const state = object(await invoke(f.registry, 'projects:set-active', { path: extra }));
      assertEqual(object((state.roots as Json[])[0]).label, 'Bee', 'label preserved when activating');
      assertEqual(state.activeRoot, extra, 'normalized active root');
      const managed = join(root, 'worktrees', 'task'); f.workspaces.bindSession('task', { workdir: managed });
      assert(!(object(f.workspaces.projectsList()).roots as Json[]).some(row => object(row).path === managed), 'managed task not a project');
      await invoke(f.registry, 'projects:remove', { path: extra });
      assertEqual(object(f.workspaces.projectsList()).activeRoot, null, 'remove clears active root');
      assertEqual(object(await invoke(f.registry, 'projects:add', { path: 'relative' })).error, 'invalid path', 'relative root refused');
      assertEqual(normalizeProjectPath('C:\\'), 'C:\\', 'Windows drive root stays absolute');
      assertEqual(normalizeProjectPath('/'), '/', 'filesystem root stays absolute');
    } finally { f.files.close(); }
  });
  h.test('a dragged Projects order persists whole, keeps unregistered keys out of the registry and survives removal', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      const bee = join(root, 'b'), cat = join(root, 'c');
      await invoke(f.registry, 'projects:add', { path: bee });
      await invoke(f.registry, 'projects:add', { path: cat });
      assertEqual((object(f.workspaces.projectsList()).roots as Json[]).length, 3, 'three registered roots');

      // A workspace container and a friend group are part of the section's order
      // but are NOT registered roots, so they must reach the sidebar row without
      // ever entering the project registry.
      const dragged = ['ws:group-1', cat, 'friend:7', bee, f.dir];
      const state = object(await invoke(f.registry, 'projects:reorder', { keys: dragged }));
      assertDeepEqual(state.sidebarOrder, dragged, 'the whole dragged list is stored, kinds and all');
      assertDeepEqual((state.roots as Json[]).map(row => object(row).path), [cat, bee, f.dir], 'the registry order mirrors the project subset');
      assertEqual((state.roots as Json[]).length, 3, 'no workspace or friend key became a project');

      // A registered root absent from the drag keeps its relative order at the
      // tail instead of vanishing from the picker.
      const partial = object(await invoke(f.registry, 'projects:reorder', { keys: [bee, 'ws:group-1'] }));
      assertDeepEqual((partial.roots as Json[]).map(row => object(row).path), [bee, cat, f.dir], 'undragged roots keep their relative order');
      assertDeepEqual(partial.sidebarOrder, [bee, 'ws:group-1'], 'the sidebar row records exactly what was dragged');

      // Duplicates collapse rather than reserving two slots for one row.
      assertDeepEqual(object(await invoke(f.registry, 'projects:reorder', { keys: [cat, cat, bee] })).sidebarOrder, [cat, bee], 'duplicate keys collapse');
      assertEqual(object(await invoke(f.registry, 'projects:reorder', { keys: [] })).error, 'invalid keys', 'an empty drag is refused');
      assertEqual(object(await invoke(f.registry, 'projects:reorder', { keys: ['', '  '] })).error, 'invalid keys', 'blank keys are refused');

      // Removal drops the row's reserved slot from BOTH rows.
      await invoke(f.registry, 'projects:remove', { path: cat });
      const afterRemove = object(await invoke(f.registry, 'projects:list'));
      assert(!(afterRemove.sidebarOrder as string[]).includes(cat), 'removal clears the sidebar slot');
      assertDeepEqual((afterRemove.roots as Json[]).map(row => object(row).path).sort(), [bee, f.dir].sort(), 'removal clears the registry slot');

      // Deleting a workspace container clears its `ws:` slot too. The order row is
      // whatever the last drag left, so re-establish one that names the container
      // before asserting its slot goes away.
      await invoke(f.registry, 'workspaces:save', { id: 'group-1', name: 'Group', roots: [f.dir, bee] });
      await invoke(f.registry, 'projects:reorder', { keys: ['ws:group-1', bee, 'friend:7'] });
      assertDeepEqual(object(await invoke(f.registry, 'projects:list')).sidebarOrder, ['ws:group-1', bee, 'friend:7'], 'the container slot is stored');
      await invoke(f.registry, 'workspaces:delete', { id: 'group-1' });
      assertDeepEqual(object(await invoke(f.registry, 'projects:list')).sidebarOrder, [bee, 'friend:7'], 'deleting the container clears only its slot');

      // A detached directory loses its slot the same way, while non-path keys
      // (which are never directories) are untouched.
      await invoke(f.registry, 'projects:reorder', { keys: [bee, 'friend:7', f.dir] });
      await f.workspaces.detachDirectory(bee);
      assertDeepEqual(object(await invoke(f.registry, 'projects:list')).sidebarOrder, ['friend:7', f.dir], 'detaching a directory clears its slot');
    } finally { f.files.close(); }
  });
  h.test('the dragged Projects order reaches other windows through its own broadcast key', async () => {
    const root = freshRoot();
    const registry = new ChannelRegistry(), broadcasts: Json[] = [];
    registerWorkspaceHandlers(registry, {
      configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null,
      onProjectOrderChanged: () => { broadcasts.push({ key: 'sidebar.project_order' }); },
    });
    const handler = registry.lookup('projects:reorder'); assert(handler, 'projects:reorder registered');
    await handler({ role: 'main', senderId: 1, channel: 'projects:reorder', args: [{ keys: ['a', 'b'] }] });
    assertEqual(broadcasts.length, 1, 'a stored order is broadcast once');
    assertDeepEqual(broadcasts[0], { key: 'sidebar.project_order' }, 'the broadcast names the order key');
    // A rejected order is an error envelope, not a throw, so the caller can roll
    // back — and it must not claim success to the other windows.
    await handler({ role: 'main', senderId: 1, channel: 'projects:reorder', args: [{ keys: [] }] });
    assertEqual(broadcasts.length, 1, 'a refused order broadcasts nothing');
  });
  h.test('managed worktree sessions stay filed under their origin project', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      const managed = join(root, 'worktrees', 'klaus-20260917-154132-4159aee3');
      await mkdir(managed, { recursive: true });
      withSettingsDb(root, db => {
        db.exec('CREATE TABLE IF NOT EXISTS managed_worktree_origins (path TEXT PRIMARY KEY, repo_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, created_at INTEGER NOT NULL)');
        db.prepare('INSERT INTO managed_worktree_origins (path, repo_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)').run(managed, f.dir, join(f.dir, '.git'), 1);
      });
      f.workspaces.bindSession('wt', { workdir: managed, projectRoot: f.dir });
      assertEqual(f.workspaces.projectAssignment('wt'), f.dir, 'membership locked to origin at creation');
      assert(!(object(f.workspaces.projectsList()).roots as Json[]).some(row => object(row).path === managed), 'worktree never registered as a project');
      const state = object(await invoke(f.registry, 'projects:set-active', { path: managed }));
      assertEqual(state.activeRoot, f.dir, 'activating a worktree selects its origin');
      assert(!(state.roots as Json[]).some(row => object(row).path === managed), 'activation did not register the worktree');
      withSettingsDb(root, db => db.prepare("UPDATE settings SET value = ? WHERE key = 'workspace.roots'").run(JSON.stringify([managed, f.dir])));
      const migrated = object(await invoke(f.registry, 'projects:list'));
      assert(!(migrated.roots as Json[]).some(row => object(row).path === managed), 'legacy worktree root stripped on migration');
      f.workspaces.bindSession('wt', { workdir: managed });
      assertEqual(f.workspaces.projectAssignment('wt'), f.dir, 'membership survives cwd rebind');
      f.workspaces.forgetSession('wt');
      assertEqual(f.workspaces.projectAssignment('wt'), undefined, 'forget clears membership');
    } finally { f.files.close(); }
  });
  h.test('workspace explorer lists directories first with excludes, depth and symlink boundaries', async () => {
    const f = await fixture(freshRoot());
    try {
      await mkdir(join(f.dir, 'folder')); await writeFile(join(f.dir, 'z.txt'), 'z');
      for (const name of loading.browseIncludes) {
        if (name === '.DS_Store') await writeFile(join(f.dir, name), 'metadata');
        else await mkdir(join(f.dir, name));
      }
      await writeFile(join(f.dir, 'hide.txt'), 'hide'); await symlink(f.dir, join(f.dir, 'folder', 'loop'), 'dir');
      const outside = join(f.workspaces.configRoot, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'secret');
      await symlink(outside, join(f.dir, 'escape'), 'dir');
      await invoke(f.registry, 'workspace:set-excludes', { patterns: [' hide.txt ', '', 3] });
      const reply = object(await invoke(f.registry, 'workspace:list', { sessionId: 's' }));
      assertDeepEqual((reply.tree as Json[]).map(row => object(row).name), ['.git', '.pytest_cache', 'dist', 'folder', 'node_modules', '.DS_Store', 'z.txt'], 'hidden and generated entries remain browsable; user exclusions and scope are enforced');
      assert((reply.tree as Json[]).filter(row => object(row).isDir).every(row => object(row).childrenLoaded === false), 'root listing never recursively scans folders');
      const folder = object(await invoke(f.registry, 'workspace:list', { sessionId: 's', filePath: join(f.dir, 'folder') }));
      assertEqual((folder.tree as Json[]).length, 1, 'an in-scope symlink remains bounded and lazy');
      assertDeepEqual(await invoke(f.registry, 'workspace:get-excludes'), { patterns: ['hide.txt'] }, 'user layer only');
      assertEqual(reply.root, f.dir, 'workspace root unchanged');
    } finally { f.files.close(); }
  });
  h.test('artifact preview handles UTF-16 and binary data with bounded bytes and full response metadata', async () => {
    const f = await fixture(freshRoot());
    try {
      const path = join(f.dir, 'wide.txt'); await writeFile(path, Buffer.from('\ufeffHello 中', 'utf16le')); await chmod(path, 0o444);
      const wide = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: path }));
      assertEqual(wide.content, 'Hello 中', 'UTF-16 decoded'); assertEqual(wide.encoding, 'utf16le', 'encoding published');
      assertEqual(wide.readonly, false, 'mode bits no longer gate the panel'); assertEqual(wide.fileName, 'wide.txt', 'preview name');
      assertEqual(wide.mtimeMs, (await stat(path)).mtimeMs, 'preview revision accompanies its content');
      const binary = join(f.dir, 'blob'); await writeFile(binary, Buffer.from([1, 0, 0, 2]));
      const blob = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: binary }));
      assertEqual(blob.binary, true, 'real binary detected'); assertEqual(blob.content, '', 'no binary mojibake');
      const mid = join(f.dir, 'mid'); await writeFile(mid, Buffer.alloc(1024 * 1024 + 9, 97));
      const midRead = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: mid }));
      assertEqual(String(midRead.content).length, 1024 * 1024 + 9, 'text below the editor bound reads complete'); assertEqual(midRead.truncated, false, 'no truncation below the bound');
      const large = join(f.dir, 'large'); await writeFile(large, Buffer.alloc(10 * 1024 * 1024 + 9, 97));
      const limited = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: large }));
      assertEqual(String(limited.content).length, 10 * 1024 * 1024, 'ten MiB bound'); assertEqual(limited.truncated, true, 'truncation published');
      assertEqual(limited.readonly, true, 'oversized files open read-only');
    } finally { f.files.close(); }
  });
  h.test('file actions refuse traversal and symlink escape before invoking system actions', async () => {
    const f = await fixture(freshRoot());
    try {
      const outside = join(f.workspaces.configRoot, 'outside.txt'); await writeFile(outside, 'outside');
      const escape = join(f.dir, 'escape.txt'); await symlink(outside, escape);
      for (const path of [join(f.dir, '..', 'outside.txt'), escape]) {
        const payload = { sessionId: 's', filePath: path, content: 'damage', newName: 'moved' };
        for (const channel of ['workspace:write', 'workspace:open', 'workspace:rename', 'workspace:delete', 'artifacts:read', 'artifacts:file-url']) {
          assert(String(object(await invoke(f.registry, channel, payload)).error).startsWith('path outside'), 'scope refusal ' + channel);
        }
      }
      assertEqual(await readFile(outside, 'utf8'), 'outside', 'outside bytes unchanged'); assertEqual(f.actions.length, 0, 'no external open');
      assertEqual(object(await invoke(f.registry, 'workspace:delete', { sessionId: 's', filePath: f.dir + '/.' })).error, 'cannot delete workspace root', 'normalized root cannot be deleted');
      assertEqual(object(await invoke(f.registry, 'artifacts:read', {})).error, 'invalid path', 'invalid path ordering');
      assertEqual(object(await invoke(f.registry, 'artifacts:file-url', { sessionId: 's', filePath: join(f.dir, 'missing') })).error, 'file not found', 'missing path ordering');
    } finally { f.files.close(); }
  });
  h.test('workspace saves retain file mode, refuse media/binary/oversize and emit exact refresh path', async () => {
    const f = await fixture(freshRoot());
    try {
      const path = join(f.dir, 'source'); await writeFile(path, 'a longer initial value'); await chmod(path, 0o755);
      const saved = object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: path, content: 'ok' }));
      assertDeepEqual(saved, { ok: true, path, mtimeMs: (await stat(path)).mtimeMs }, 'saved path and revision');
      assertEqual(await readFile(path, 'utf8'), 'ok', 'short save truncates old bytes'); assertEqual((await stat(path)).mode & 0o777, 0o755, 'executable mode kept');
      assertDeepEqual(f.pushes.at(-1), { type: 'workspace:changed', sessionId: 's', events: [{ kind: 'change', path, isDir: false }] }, 'save event');
      const image = join(f.dir, 'PHOTO.PNG'); await writeFile(image, 'not decoded');
      assertEqual(object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: image, content: 'bad' })).error, 'file is preview-only', 'media readonly');
      await writeFile(path, Buffer.from([0, 0, 1, 2]));
      assertEqual(object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: path, content: 'bad' })).error, 'file seems to be binary', 'binary refused');
      await writeFile(path, 'original');
      assertEqual(object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: path, content: '中'.repeat(4 * 1024 * 1024) })).error, 'file too large', 'UTF-8 byte bound');
      assertEqual(await readFile(path, 'utf8'), 'original', 'failed saves kept bytes');
    } finally { f.files.close(); }
  });
  h.test('everything the panel opens as text is editable; only oversize stays read-only', async () => {
    const root = freshRoot(); const f = await fixture(root, { producedBySession: (p: string) => basename(p) === 'artifact.md' });
    try {
      const uploads = join(root, 'uploads'); await mkdir(uploads, { recursive: true });
      const resume = join(uploads, 'resume.md'); await writeFile(resume, '# draft');
      const read = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: resume }));
      assertEqual(read.readonly, false, 'uploads files are editable in the panel');
      const saved = object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: resume, content: '# saved' }));
      assertEqual(saved.ok, true, 'panel save commits: ' + JSON.stringify(saved));
      assertEqual(await readFile(resume, 'utf8'), '# saved', 'saved bytes land on disk');
      const artifact = join(root, 'artifact.md'); await writeFile(artifact, 'produced');
      assertEqual(object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: artifact })).readonly, false, 'session-produced files outside roots are editable');
      assertEqual(object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: artifact, content: 'edited' })).ok, true, 'session-produced files commit');
      const locked = join(f.dir, 'locked.md'); await writeFile(locked, 'x'); await chmod(locked, 0o444);
      assertEqual(object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: locked })).readonly, false, 'mode bits no longer decide read-only');
      const lockedWrite = object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: locked, content: 'y' }));
      assert(lockedWrite.ok !== true && typeof lockedWrite.error === 'string', 'unwritable mode fails at the OS instead: ' + JSON.stringify(lockedWrite));
      const loose = join(root, 'loose.md'); await writeFile(loose, 'x');
      assertEqual(object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: loose, content: 'y' })).error, 'path outside preview scope', 'write scope stays bounded to the preview scope');
    } finally { f.files.close(); }
  });
  const writeVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/workspace-file-write.json'), 'utf8')) as {
    diskContent: string; diskMtimeMs: number; newContent: string;
    cases: Array<{ id: string; options: { expectedMtimeMs?: number | null; force?: boolean }; ok: boolean; conflict?: boolean; error?: string }>;
  };
  for (const vector of writeVectors.cases) h.test(`workspace guarded save: ${vector.id}`, async () => {
    const f = await fixture(freshRoot());
    try {
      const path = join(f.dir, 'document.md'); await writeFile(path, writeVectors.diskContent);
      await utimes(path, writeVectors.diskMtimeMs / 1000, writeVectors.diskMtimeMs / 1000);
      const result = object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: path, content: writeVectors.newContent, ...vector.options }));
      assertEqual(result.ok, vector.ok, 'committed save outcome');
      assertEqual(result.conflict, vector.conflict, 'conflict is explicit');
      assertEqual(result.error, vector.error, 'conflict has a stable error');
      assertEqual(await readFile(path, 'utf8'), vector.ok ? writeVectors.newContent : writeVectors.diskContent, 'conflicting saves leave disk unchanged');
      assertEqual(result.mtimeMs, (await stat(path)).mtimeMs, 'reply publishes the current revision');
      if (!vector.ok) {
        assertEqual(result.content, writeVectors.diskContent, 'conflict publishes recoverable disk content');
        assertEqual(result.truncated, false, 'complete conflict content is identified');
        assertEqual(f.pushes.length, 0, 'conflicts never emit successful change events');
      }
    } finally { f.files.close(); }
  });
  h.test('concurrent guarded saves serialize aliases and reject the losing revision', async () => {
    const f = await fixture(freshRoot());
    try {
      const path = join(f.dir, 'document.md'), alias = join(f.dir, 'alias.md');
      await writeFile(path, 'Original'); await utimes(path, 1700000000, 1700000000); await symlink(path, alias);
      const revision = (await stat(path)).mtimeMs;
      const results = await Promise.all([
        invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: path, content: 'First edit', expectedMtimeMs: revision }),
        invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: alias, content: 'Second edit', expectedMtimeMs: revision }),
      ]);
      const successes = results.map(object).filter(result => result.ok === true), conflicts = results.map(object).filter(result => result.conflict === true);
      assertEqual(successes.length, 1, 'only one request can consume the disk revision');
      assertEqual(conflicts.length, 1, 'the later request observes the new revision');
      assertEqual(conflicts[0]?.content, await readFile(path, 'utf8'), 'the losing save can recover the winning content');
      assertEqual(f.pushes.length, 1, 'only one change event is emitted');
    } finally { f.files.close(); }
  });
  h.test('remote saves expose the current revision and preserve stale disk content', async () => {
    let disk = Buffer.from('Remote original'), mtimeMs = 2000, writes = 0;
    const sshFiles = {
      stat: async () => ({ isFile: true, size: disk.length, mtimeMs }),
      read: async (_sender: number, _workdir: unknown, _path: string, offset: number, length: number) => ({ content: disk.subarray(offset, offset + length), size: disk.length, complete: offset + length >= disk.length }),
      write: async (_sender: number, _workdir: unknown, _path: string, content: Buffer) => { disk = Buffer.from(content); mtimeMs += 1000; writes++; },
    } as unknown as NonNullable<FileDeps['sshFiles']>;
    const f = await fixture(freshRoot(), { sshFiles, sshOwner: () => 1 });
    try {
      f.workspaces.bindSession('s', { workdir: 'ssh://user@example.test/home/user/project' });
      const filePath = '/home/user/project/document.md';
      const read = object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath }));
      assertEqual(read.mtimeMs, 2000, 'remote reads publish their revision');
      const conflict = object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath, content: 'Local edit', expectedMtimeMs: 1000 }));
      assertEqual(conflict.conflict, true, 'stale remote save conflicts');
      assertEqual(conflict.content, 'Remote original', 'conflict carries current remote content');
      assertEqual(writes, 0, 'stale save never writes remotely');
      const saved = object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath, content: 'Local edit', expectedMtimeMs: 2000 }));
      assertEqual(saved.ok, true, 'current remote revision saves');
      assertEqual(saved.mtimeMs, 3000, 'remote save publishes its resulting revision');
      assertEqual(disk.toString(), 'Local edit', 'remote content is saved exactly');
    } finally { f.files.close(); }
  });
  h.test('rename refuses collisions and trash delegates a recoverable move', async () => {
    const f = await fixture(freshRoot());
    try {
      const path = join(f.dir, 'before'), collision = join(f.dir, 'taken'); await writeFile(path, 'mine'); await writeFile(collision, 'theirs');
      assertEqual(object(await invoke(f.registry, 'workspace:rename', { sessionId: 's', filePath: path, newName: 'taken' })).error, 'target already exists', 'no overwrite');
      assertEqual(object(await invoke(f.registry, 'workspace:rename', { sessionId: 's', filePath: path, newName: '../bad' })).error, 'invalid name', 'no path rename');
      const newPath = join(f.dir, 'after');
      assertDeepEqual(await invoke(f.registry, 'workspace:rename', { sessionId: 's', filePath: path, newName: 'after' }), { ok: true, path: newPath, name: 'after' }, 'new label returned');
      await invoke(f.registry, 'workspace:delete', { sessionId: 's', filePath: newPath });
      assertEqual(await readFile(join(f.workspaces.configRoot, 'fixture-trash', 'deleted'), 'utf8'), 'mine', 'trash retains file');
      assertEqual(await readFile(collision, 'utf8'), 'theirs', 'collision file untouched');
    } finally { f.files.close(); }
  });
  h.test('upload previews materialize safely before invoking the real window dependency', async () => {
    const f = await fixture(freshRoot());
    try {
      const upload = join(f.workspaces.configRoot, 'uploads', 'hash.dat'); await mkdir(join(f.workspaces.configRoot, 'uploads')); await writeFile(upload, 'attachment');
      const reply = object(await invoke(f.registry, 'artifacts:open-window', { sessionId: 's', filePath: upload, displayName: '../../Report.txt' }));
      const path = join(f.dir, '.klaus-upload-previews', 'hash.dat', 'Report.txt');
      assertDeepEqual(reply, { ok: true, path }, 'materialized path reply');
      assertEqual(await readFile(path, 'utf8'), 'attachment', 'copied bytes');
      assertDeepEqual(f.previewWindows, [{ kind: 'artifact', sessionId: 's', filePath: path, displayName: 'Report.txt' }], 'window receives scoped copy');
      await invoke(f.registry, 'artifacts:reveal', { filePath: path }); assertEqual(f.actions.at(-1)?.kind, 'reveal', 'standalone reveal needs no session');
      await invoke(f.registry, 'artifacts:open-workspace', { sessionId: 's' }); assertEqual(f.actions.at(-1)?.path, f.dir, 'open actual workspace');
      assert(String(object(await invoke(f.registry, 'artifacts:file-url', { sessionId: 's', filePath: path })).url).startsWith('file:///'), 'valid local file URL');
      const outside = join(f.workspaces.configRoot, 'outside-previews'); await mkdir(outside);
      await symlink(outside, join(f.dir, '.klaus-upload-previews', 'second.dat'), 'dir');
      const second = join(f.workspaces.configRoot, 'uploads', 'second.dat'); await writeFile(second, 'private');
      assertEqual(object(await invoke(f.registry, 'artifacts:open-window', { sessionId: 's', filePath: second })).error, 'invalid preview path', 'materialization cannot escape through existing parent symlink');
      assertEqual(f.previewWindows.length, 1, 'refused materialization did not open another window');
    } finally { f.files.close(); }
  });
  h.test('artifact windows admit stored pastes and every bound workspace root without widening scope', async () => {
    const root = freshRoot(), f = await fixture(root), second = join(root, 'second');
    try {
      await mkdir(second);
      f.workspaces.save({ id: 'group', name: 'Group', roots: [f.dir, second] });
      f.workspaces.bindSession('group-session', { workspaceId: 'group' });
      const pasted = join(root, 'pasted-text', 'stored.txt'), extra = join(second, 'notes.txt');
      await mkdir(join(root, 'pasted-text')); await writeFile(pasted, 'full paste'); await writeFile(extra, 'extra root');
      for (const filePath of [pasted, extra]) {
        assertDeepEqual(await invoke(f.registry, 'artifacts:open-window', { sessionId: 'group-session', filePath }), { ok: true }, 'admitted preview opens directly');
      }
      assertDeepEqual(f.previewWindows, [pasted, extra].map(filePath => ({ kind: 'artifact', filePath, sessionId: 'group-session', displayName: undefined })), 'preview retains its owning session and original file');
      const outside = join(root, 'private.txt'); await writeFile(outside, 'private');
      assertEqual(object(await invoke(f.registry, 'artifacts:open-window', { sessionId: 'group-session', filePath: outside })).error, 'path outside preview scope', 'unbound file refused');
      assertEqual(object(await invoke(f.registry, 'artifacts:open-window', { sessionId: 's', filePath: extra })).error, 'path outside preview scope', 'another session cannot borrow an extra root');
      const link = join(root, 'pasted-text', 'escape.txt'); await symlink(outside, link);
      assertEqual(object(await invoke(f.registry, 'artifacts:open-window', { sessionId: 'group-session', filePath: link })).error, 'path outside preview scope', 'paste symlink cannot escape its admitted root');
      assertEqual(f.previewWindows.length, 2, 'refusals open no windows');
    } finally { f.files.close(); }
  });
  h.test('artifact window and OS operation failures never become successful replies', async () => {
    const f = await fixture(freshRoot(), { openPreviewWindow: async () => { throw new Error('window unavailable'); }, openPath: async () => { throw new Error('open failed'); }, trashPath: async () => { throw new Error('trash failed'); } });
    try {
      const path = join(f.dir, 'file'); await writeFile(path, 'still here');
      assertEqual(object(await invoke(f.registry, 'artifacts:open-window', { sessionId: 's', filePath: path })).error, 'window unavailable', 'window failure visible');
      assertEqual(object(await invoke(f.registry, 'workspace:open', { sessionId: 's', filePath: path })).error, 'open failed', 'OS open failure visible');
      assertEqual(object(await invoke(f.registry, 'workspace:delete', { sessionId: 's', filePath: path })).error, 'trash failed', 'trash failure visible');
      assertEqual(await readFile(path, 'utf8'), 'still here', 'failed trash preserves file');
    } finally { f.files.close(); }
  });
  h.test('file-change projection keeps unknown counts null and calls only the named scoped facade', async () => {
    const root = freshRoot(), paths = [join(root, 'project', 'a.ts'), join(root, 'outside.ts')], calls: unknown[] = [];
    const f = await fixture(root, { requestSession: async (sessionId, method, params) => {
      calls.push({ sessionId, method, params }); return { fileChanges: [{ turnId: 'turn', files: [{ path: paths[0], kind: 'modify', added: 2, removed: 1 }, { path: paths[1], kind: 'add', added: null, removed: 0 }] }] };
    } });
    try {
      const reply = object(await invoke(f.registry, 'session:file-changes', { sessionId: 's' }));
      const turn = object((reply.turns as Json[])[0]);
      assertDeepEqual(turn.stats, { filesCount: 2, linesAdded: null, linesRemoved: 1 }, 'unknown is not zero');
      assertEqual(object((turn.files as Json[])[0]).relativePath, 'a.ts', 'workspace file relative');
      assertEqual(object((turn.files as Json[])[1]).relativePath, paths[1], 'outside edits reported honestly');
      assertDeepEqual(calls, [{ sessionId: 's', method: 'session/fileChanges', params: {} }], 'one named facade');
    } finally { f.files.close(); }
  });
  h.test('file-change facade errors and malformed replies reject instead of presenting empty history', async () => {
    for (const reply of [{ error: 'session missing' }, {}]) {
      const f = await fixture(freshRoot(), { requestSession: async () => reply });
      try { assert(await assertRejects(() => invoke(f.registry, 'session:file-changes', { sessionId: 's' }), 'facade failure') instanceof IpcHandlerError, 'typed rejection'); }
      finally { f.files.close(); }
    }
  });
  h.test('real file watcher pushes external edits and releases on workspace switch and close', async () => {
    const started = Date.now(), trace: unknown[] = [];
    const marker = 'native-watch-ready.txt';
    let observedMarker = false, armed = false;
    const f = await fixture(freshRoot(), { watch: true, watchDebounceMs: 10,
      createWatcher: (root, listener) => {
        trace.push({ at: Date.now() - started, start: root });
        return watch(root, { recursive: true, persistent: false }, (kind, file) => {
          trace.push({ at: Date.now() - started, kind, file });
          if (String(file) === marker) { observedMarker = true; return; }
          if (armed) listener(kind, file);
        });
      }, log: message => { trace.push({ at: Date.now() - started, message }); },
    });
    try {
      const path = join(f.dir, 'watched.txt'); await writeFile(path, 'before');
      await invoke(f.registry, 'workspace:list', { sessionId: 's' }); assertEqual(f.files.watcherCount(), 1, 'watcher owns root');
      // libuv registers macOS FSEvents on its CF thread after watch() returns.
      // Establish native readiness with a separate file before the one edit under test.
      const deadline = Date.now() + 3000;
      while (!observedMarker && Date.now() < deadline) {
        await writeFile(join(f.dir, marker), String(Date.now())); await sleep(25);
      }
      assert(observedMarker, 'the native stream observed the independent readiness marker'); armed = true;
      await writeFile(path, 'external');
      await waitFor(() => f.pushes.some(raw => (object(raw).events as Json[] | undefined)?.some(event => object(event).path === path || object(event).path === f.dir)), 3000, 'external edit push');
      assertEqual(object(await invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: path })).content, 'external', 'refreshed preview reads external bytes');
      const next = join(f.workspaces.configRoot, 'next'); await mkdir(next);
      await invoke(f.registry, 'session:set-workdir', { sessionId: 's', dir: next }); assertEqual(f.files.watcherCount(), 0, 'old watcher closed');
      await invoke(f.registry, 'workspace:list', { sessionId: 's' }); assertEqual(f.files.watcherCount(), 1, 'new watcher created');
      f.files.close(); assertEqual(f.files.watcherCount(), 0, 'close removes all watchers');
      const count = f.pushes.length; await writeFile(join(next, 'late'), 'late'); await sleep(80);
      assertEqual(f.pushes.length, count, 'no events after close');
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; watcher trace=${JSON.stringify(trace)}; pushes=${JSON.stringify(f.pushes)}`);
    } finally { f.files.close(); }
  });
  h.test('late watcher callbacks and errors cannot affect a replacement for the same root', async () => {
    const watchers: Array<{ emitter: EventEmitter; change: (kind: string, file: string | Buffer | null) => void; closed: number }> = [];
    const f = await fixture(freshRoot(), { watch: true, watchDebounceMs: 1, createWatcher: (_root, change) => {
      const entry = { emitter: new EventEmitter(), change, closed: 0 }; watchers.push(entry);
      return Object.assign(entry.emitter, { close: () => { entry.closed++; } });
    } });
    try {
      const path = join(f.dir, 'changed.txt'); await writeFile(path, 'before');
      await invoke(f.registry, 'workspace:list', { sessionId: 's' });
      f.files.stopWatching('s');
      await invoke(f.registry, 'workspace:list', { sessionId: 's' });
      assertEqual(watchers[0]!.closed, 1, 'old native resource closed');
      const count = f.pushes.length;
      watchers[0]!.change('change', 'changed.txt');
      watchers[0]!.emitter.emit('error', new Error('late old watcher error'));
      await sleep(30);
      assertEqual(f.files.watcherCount(), 1, 'replacement retains ownership');
      assertEqual(watchers[1]!.closed, 0, 'late error cannot close replacement');
      assertEqual(f.pushes.length, count, 'late event cannot write through replacement');
      await writeFile(path, 'after'); watchers[1]!.change('change', 'changed.txt');
      await waitFor(() => f.pushes.length > count, 1000, 'replacement still delivers actual file change');
    } finally { f.files.close(); }
  });
  h.test('passive workspace resolution does not create a profile or session directory', async () => {
    const root = join(freshRoot(), 'uncreated');
    const workspaces = new WorkspaceStore({ configRoot: root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null });
    assertEqual(workspaces.resolveSessionDirectory('s'), join(root, 'sessions/s'), 'deterministic scratch path');
    let exists = true; try { await stat(root); } catch { exists = false; }
    assertEqual(exists, false, 'passive resolver has no filesystem writes');
  });
  h.test('directory removal waits for actual file actions and blocks reads writes mkdir and new watchers', async () => {
    let entered = false, continueAction!: () => void;
    const blocked = new Promise<void>(resolve => { continueAction = resolve; });
    const f = await fixture(freshRoot(), { watch: true, openPath: async () => { entered = true; await blocked; } });
    let opened: Promise<Json> | undefined, closing: Promise<() => void> | undefined, release: (() => void) | undefined;
    try {
      const path = join(f.dir, 'file.txt'); await writeFile(path, 'original');
      await invoke(f.registry, 'workspace:list', { sessionId: 's' }); assertEqual(f.files.watcherCount(), 1, 'watcher started');
      opened = invoke(f.registry, 'workspace:open', { sessionId: 's', filePath: path });
      await waitFor(() => entered, 1000, 'actual OS operation entered');
      let quiesced = false; closing = f.files.quiesceDirectory(f.dir).then(value => { quiesced = true; return value; });
      const refusal = await assertRejects(() => invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: path, content: 'wrong' }), 'new writes refused');
      assert(refusal instanceof IpcHandlerError && refusal.code === 'DIRECTORY_BUSY', 'typed directory-busy refusal');
      assertEqual(quiesced, false, 'quiesce waits for the entered OS operation');
      continueAction(); await opened; release = await closing;
      assertEqual(f.files.watcherCount(), 0, 'watchers closed before removal');
      for (const operation of [
        () => f.workspaces.sessionDirectory('s'),
        () => invoke(f.registry, 'workspace:list', { sessionId: 's' }),
        () => invoke(f.registry, 'artifacts:read', { sessionId: 's', filePath: path }),
        () => invoke(f.registry, 'session:set-workdir', { sessionId: 'new', dir: f.dir }),
      ]) await assertRejects(operation, 'lease excludes directory activity');
      assertEqual(await readFile(path, 'utf8'), 'original', 'refused write preserves bytes');
      release(); release = undefined;
      assertEqual(object(await invoke(f.registry, 'workspace:write', { sessionId: 's', filePath: path, content: 'after release' })).ok, true, 'failed removal can resume operations');
    } finally { continueAction(); await opened; release?.(); if (!release && closing) (await closing)(); f.files.close(); }
  });
  h.test('successful removal detaches unopened durable bindings scratch aliases and workspace members atomically', async () => {
    const root = freshRoot(), f = await fixture(root), alias = join(root, 'alias'), other = join(root, 'other');
    await mkdir(other); await symlink(f.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    f.workspaces.bindSession('closed', { workdir: f.dir }); f.workspaces.bindSession('aliased', { workdir: alias });
    f.workspaces.bindSession('unrelated', { workdir: other }); f.workspaces.rememberScratchWorkdir('scratch', f.dir);
    f.workspaces.save({ id: 'group', name: 'Group', roots: [other, f.dir] }); f.workspaces.bindSession('group-session', { workspaceId: 'group' });
    f.workspaces.projectsAdd({ path: alias, label: 'Alias' });
    const release = await f.files.quiesceDirectory(f.dir);
    try {
      await rm(f.dir, { recursive: true });
      await assertRejects(() => f.workspaces.sessionDirectory('closed'), 'deleted cwd cannot be recreated during lease');
      await assertRejects(() => f.workspaces.sessionDirectory('aliased'), 'dangling alias cannot recreate cwd');
      const detached = await f.workspaces.detachDirectory(f.dir);
      assertDeepEqual(detached, ['aliased', 'closed', 'group-session', 's', 'scratch'], 'all affected ids returned for host resource cleanup');
      const reopened = new WorkspaceStore({ configRoot: root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null });
      for (const id of detached) { assertEqual(reopened.customWorkdir(id), undefined, 'durable cwd removed'); assertEqual(reopened.workspaceId(id), undefined, 'durable membership removed'); }
      assertEqual(reopened.customWorkdir('unrelated'), other, 'unrelated session remains bound');
      assertDeepEqual(reopened.workspaceRoots('group'), [other], 'surviving workspace folder retained');
      const projects = object(reopened.projectsList()).roots as Json[];
      assertEqual(projects.some(row => [f.dir, alias].includes(String(object(row).path))), false, 'deleted project and alias removed');
      assertEqual(f.workspaces.resolveSessionDirectory('scratch'), join(root, 'sessions/scratch'), 'scratch map no longer points at deleted cwd');
      assertEqual(f.changed.length, 0, 'detach never rebuilds an engine inside the removal lease');
    } finally { release(); f.files.close(); }
    let exists = true; try { await stat(f.dir); } catch { exists = false; } assertEqual(exists, false, 'cleanup did not resurrect removed directory');
  });
  h.test('failed detach rolls back every durable reference and keeps scratch bindings for retry', async () => {
    const root = freshRoot(), f = await fixture(root);
    f.workspaces.save({ id: 'group', roots: [f.dir] }); f.workspaces.bindSession('group-session', { workspaceId: 'group' });
    f.workspaces.rememberScratchWorkdir('scratch', f.dir);
    const release = await f.files.quiesceDirectory(f.dir);
    try {
      withSettingsDb(root, db => db.exec("CREATE TRIGGER refuse_detach BEFORE DELETE ON session_workspaces BEGIN SELECT RAISE(FAIL, 'fixture detach failure'); END"));
      await assertRejects(() => f.workspaces.detachDirectory(f.dir), 'transaction failure surfaces');
      assertEqual(f.workspaces.customWorkdir('group-session'), f.dir, 'earlier cwd delete rolled back');
      assertEqual(f.workspaces.workspaceId('group-session'), 'group', 'membership retained');
      assertDeepEqual(f.workspaces.workspaceRoots('group'), [f.dir], 'group retained');
      assertEqual(f.workspaces.resolveSessionDirectory('scratch'), f.dir, 'scratch retained after transaction failure');
      assertEqual(f.pushes.length, 0, 'failed commit emits no invalidation');
      withSettingsDb(root, db => db.exec('DROP TRIGGER refuse_detach'));
      assertDeepEqual(await f.workspaces.detachDirectory(f.dir), ['group-session', 's', 'scratch'], 'same lease permits successful cleanup retry');
    } finally { release(); f.files.close(); }
  });
  h.test('workspace folders changed during pending admission cannot bind an unchecked directory', async () => {
    const root = freshRoot(), f = await fixture(root), removing = join(root, 'removing'); await mkdir(removing);
    f.workspaces.save({ id: 'changing', roots: [f.dir] });
    const release = await f.workspaces.quiesceDirectory(removing);
    try {
      const setting = f.workspaces.setWorkspace({ sessionId: 'new', workspaceId: 'changing' });
      f.workspaces.save({ id: 'changing', roots: [removing] });
      const failure = await assertRejects(() => setting, 'changed roots refused before binding');
      assert(failure instanceof IpcHandlerError && failure.code === 'WORKSPACE_CHANGED', 'refusal explains stale selection');
      assertEqual(f.workspaces.customWorkdir('new'), undefined, 'no unchecked cwd saved');
      assertEqual(f.workspaces.workspaceId('new'), undefined, 'no unchecked membership saved');
      assertEqual(f.changed.length, 0, 'no engine invalidation from refused selection');
    } finally { release(); f.files.close(); }
  });
}
