import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DirectoryMutations } from '../main/services/extensions/directory-mutations';
import { FileExtensionService } from '../main/services/extensions/management';
import { SkillService } from '../main/services/extensions/skills';
import { HookStyleService } from '../main/services/extensions/hooks-styles';
import { registeredRoots } from '../main/services/extensions/scopes';
import { WorkspaceStore } from '../main/services/workspaces';
import { object, string } from '../main/services/service-types';
import { withSettingsDb } from '../main/services/settings';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function workspace(root: string): WorkspaceStore { return new WorkspaceStore({ configRoot: root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null }); }
async function present(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function put(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }

export function registerExtensionDirectoryTests(h: Harness, freshRoot: () => string): void {
  h.test('extension scope authority is read-only and includes durable standalone and group roots', async () => {
    const root = join(freshRoot(), 'uncreated'), store = workspace(root);
    assertDeepEqual(registeredRoots(store), [], 'fresh authority has no registered roots');
    assertEqual(await present(root), false, 'scope checks never create profile or settings database');
    const standalone = join(root, 'standalone'), member = join(root, 'member'), orphan = join(root, 'orphan');
    store.bindSession('standalone', { workdir: standalone }); store.save({ id: 'group', roots: [member] });
    assertDeepEqual(registeredRoots(store).sort(), [standalone, member].sort(), 'session creation still registers its own project; group members join authority');
    withSettingsDb(root, db => {
      db.exec('CREATE TABLE IF NOT EXISTS session_workdirs (session_id TEXT PRIMARY KEY, workdir TEXT NOT NULL, updated_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO session_workdirs VALUES (?, ?, ?)').run('orphan', orphan, 1);
    });
    assertEqual(registeredRoots(store).includes(orphan), false, 'a bare binding row grants no scope authority');
    const worktree = join(root, 'worktrees', 'task');
    store.bindSession('worktree', { workdir: worktree });
    assert(registeredRoots(store).includes(worktree), 'a bound managed worktree stays a writable scope');
  });
  h.test('command writes reserve before async scope resolution and cannot recreate a leased removed project', async () => {
    const root = freshRoot(), project = join(root, 'project'), store = workspace(root); await mkdir(project);
    const service = new FileExtensionService({ workspaces: store, onChanged: async () => {}, trashPath: async () => {} });
    const saving = service.commandsSave({ scope: 'project', projectRoot: project, name: 'pending', body: 'must not write' });
    const closing = store.quiesceDirectory(project), reply = object(await saving), release = await closing;
    try {
      assertEqual(reply.ok, false, 'scope resolution rechecks the already installed lease');
      assertEqual(await present(join(project, '.klaus')), false, 'pending save never reached mkdir');
      await rm(project, { recursive: true });
      assertEqual(object(await service.commandsSave({ scope: 'project', projectRoot: project, name: 'late', body: 'late' })).ok, false, 'removed project save refused');
      assertEqual(await present(project), false, 'project remains removed');
    } finally { release(); await service.close(); }
  });
  h.test('command quiescence waits for committed save callbacks and blocks alias writes and global agent writes', async () => {
    const root = freshRoot(), project = join(root, 'project'), alias = join(root, 'alias'), store = workspace(root), ready = deferred();
    await mkdir(project); await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir'); let entered = false;
    const service = new FileExtensionService({ workspaces: store, onChanged: async () => { entered = true; await ready.promise; }, trashPath: async () => {} });
    const saving = service.commandsSave({ scope: 'project', projectRoot: project, name: 'first', body: 'persisted' });
    let closing: Promise<() => void> | undefined, release: (() => void) | undefined;
    try {
      await waitFor(() => entered, 1000, 'save invalidation callback entered'); let drained = false;
      closing = store.quiesceDirectory(project).then(value => { drained = true; return value; });
      assertEqual(object(await service.commandsSave({ scope: 'project', projectRoot: alias, name: 'second', body: 'wrong' })).ok, false, 'alias cannot enter after lease');
      assertEqual(drained, false, 'removal waits for the actual save callback'); ready.resolve(); await saving; release = await closing;
      assertEqual(await readFile(join(project, '.klaus/commands/first.md'), 'utf8'), 'persisted\n', 'admitted save bytes kept');
      release(); release = undefined;
      const rootRelease = await store.quiesceDirectory(root);
      try { assertEqual(object(await service.agentsSave({ content: '---\nname: a\ndescription: a\n---\nPrompt\n' })).ok, false, 'global agent write uses the same authority'); assertEqual(await present(join(root, 'agents')), false, 'agent mkdir blocked'); }
      finally { rootRelease(); }
    } finally { ready.resolve(); await saving; release?.(); if (closing) (await closing)(); await service.close(); }
  });
  h.test('hook facade writes remain leased until their real file completion and cannot recreate a removed project', async () => {
    const root = freshRoot(), project = join(root, 'project'), store = workspace(root), ready = deferred(); await mkdir(project); store.projectsAdd({ path: project });
    let writes = 0, entered = false;
    const hooks = new HookStyleService({ workspaces: store, onChanged: async () => {}, request: async (method, params) => {
      assertEqual(method, 'hooks/write', 'named hook store'); writes++; entered = true; await ready.promise;
      const value = object(params), path = string(value.filePath); await put(path, JSON.stringify(value.hooks)); return { hooks: value.hooks, path, events: ['Stop'] };
    } });
    const writing = hooks.hooksSet({ projectRoot: project, hooks: { Stop: [] } }); let closing: Promise<() => void> | undefined;
    try {
      await waitFor(() => entered, 1000, 'actual facade write entered'); let drained = false;
      closing = store.quiesceDirectory(project).then(value => { drained = true; return value; });
      assertEqual(object(await hooks.hooksSet({ projectRoot: project, hooks: {} })).ok, false, 'second hook write refused');
      assertEqual(writes, 1, 'no second facade write'); assertEqual(drained, false, 'quiesce waits for file completion');
      ready.resolve(); await writing; const release = await closing;
      try {
        assertEqual(await readFile(join(project, '.klaus/hooks.json'), 'utf8'), '{"Stop":[]}', 'first facade write completed');
        await rm(project, { recursive: true });
        assertEqual(object(await hooks.hooksSet({ projectRoot: project, hooks: {} })).ok, false, 'stale durable project cannot resurrect through engine hooks writer');
        assertEqual(await present(project), false, 'no recreated hooks directory');
      } finally { release(); }
    } finally { ready.resolve(); await writing; if (closing) (await closing)(); await hooks.close(); }
  });
  h.test('skill removal holds its directory until invalidation completes and refuses later deletions', async () => {
    const root = freshRoot(), project = join(root, 'project'), store = workspace(root), ready = deferred();
    await put(join(project, '.klaus/skills/first/SKILL.md'), 'first'); await put(join(project, '.klaus/skills/second/SKILL.md'), 'second'); store.projectsAdd({ path: project });
    let entered = false;
    const skills = new SkillService({ workspaces: store, request: async () => { throw new Error('Unexpected RPC'); }, openPreviewWindow: async () => {}, onChanged: async () => { entered = true; await ready.promise; } });
    const removing = skills.uninstall({ projectRoot: project, name: 'first' }); let closing: Promise<() => void> | undefined;
    try {
      await waitFor(() => entered, 1000, 'skill removed before invalidation'); let drained = false;
      closing = store.quiesceDirectory(project).then(value => { drained = true; return value; });
      await assertRejects(() => skills.uninstall({ projectRoot: project, name: 'second' }), 'new skill mutation refused');
      assertEqual(await readFile(join(project, '.klaus/skills/second/SKILL.md'), 'utf8'), 'second', 'refused skill remains untouched');
      assertEqual(drained, false, 'pending invalidation still holds directory'); ready.resolve(); assertEqual(await removing, true, 'first removal completed');
      (await closing)();
    } finally { ready.resolve(); await removing; if (closing) (await closing)(); await skills.close(); }
  });
  h.test('asynchronous scope resolution preserves invocation order and close waits for pending admission', async () => {
    const root = freshRoot(), store = workspace(root), queue = new DirectoryMutations(store), ready = deferred(), path = join(root, 'value');
    const first = queue.run(async () => { await writeFile(path, 'first'); }, async () => { await ready.promise; return [root]; });
    const second = queue.run(async () => { await writeFile(path, 'second'); });
    try { ready.resolve(); await first; await second; assertEqual(await readFile(path, 'utf8'), 'second', 'later save remains last even if its scope resolves first'); }
    finally { ready.resolve(); await queue.close(); }
    const closingQueue = new DirectoryMutations(store), pendingScope = deferred(); let wrote = false;
    const pending = closingQueue.run(async () => { wrote = true; }, async () => { await pendingScope.promise; return [root]; });
    const refused = assertRejects(() => pending, 'close refuses the late admission'); let closed = false;
    const closing = closingQueue.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assertEqual(closed, false, 'close waits for outstanding scope lookup');
    pendingScope.resolve(); await refused; await closing; assertEqual(wrote, false, 'no callback after close');
  });
}
