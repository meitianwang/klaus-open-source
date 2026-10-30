import { access, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerWorktreeHandlers, WORKTREE_CHANNELS } from '../main/ipc/handlers/worktrees';
import { GitService } from '../main/services/git';
import { WorkspaceStore } from '../main/services/workspaces';
import { WorktreeService, type WorktreeDeps } from '../main/services/worktrees';
import { object } from '../main/services/service-types';
import { withSettingsDb } from '../main/services/settings';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, sleep, waitFor } from './harness';

async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'registered ' + channel);
  return handler({ role: 'main', senderId: 1, channel, args: payload === undefined ? [] : [payload] });
}
async function present(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
async function fixture(root: string, extra: Partial<WorktreeDeps> = {}) {
  const repo = join(root, 'repo'); await mkdir(repo); await writeFile(join(repo, 'a.txt'), 'one\n');
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('s', { workdir: repo });
  const git = new GitService({ workspaces, openPath: async () => {}, revealPath: () => {}, sideQuestion: async () => ({ response: '' }), push: () => {},
    processOptions: { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: root } } });
  const init = await git.init({ workdir: repo }); assertEqual(object(init).ok, true, 'repo init');
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgSign', 'false']]) {
    assertEqual((await git.process.run(repo, ['config', key!, value!])).code, 0, 'fixture identity');
  }
  const registry = new ChannelRegistry(), events: Array<{ kind: string; path: string }> = [];
  const worktrees = registerWorktreeHandlers(registry, { git, workspaces, openPath: async path => { events.push({ kind: 'open', path }); },
    beforeRemove: async path => { events.push({ kind: 'before', path }); }, onRemoved: path => { events.push({ kind: 'after', path }); }, ...extra });
  return { root, repo, registry, git, worktrees, workspaces, events, close: async () => { worktrees.close(); await git.close(); } };
}
async function create(f: Awaited<ReturnType<typeof fixture>>, extra: { [key: string]: Json } = {}) {
  const value = object(await invoke(f.registry, 'worktree:create-from-workdir', { workdir: f.repo, ...extra }));
  assertEqual(value.ok, true, 'worktree created: ' + JSON.stringify(value));
  return { path: String(value.path), branch: String(value.branch), repoRoot: String(value.repoRoot) };
}

export function registerWorktreeServiceTests(h: Harness, freshRoot: () => string): void {
  h.test('includeUncommitted carries tracked edits, deletions and untracked files into the worktree without touching the main checkout', async () => {
    const f = await fixture(freshRoot());
    try {
      await writeFile(join(f.repo, 'keep.txt'), 'keep\n'); await writeFile(join(f.repo, 'gone.txt'), 'gone\n');
      assertEqual(object(await f.git.commit({ workdir: f.repo, message: 'second' })).ok, true, 'baseline commit');
      // Local state: modify a tracked file, delete another, add an untracked file
      // (including one in a new directory), and leave an ignored file behind.
      await writeFile(join(f.repo, 'a.txt'), 'edited locally\n');
      await rm(join(f.repo, 'gone.txt'), { force: true });
      await mkdir(join(f.repo, 'nested'), { recursive: true });
      await writeFile(join(f.repo, 'nested', 'n.txt'), 'nested new\n');
      await writeFile(join(f.repo, '.gitignore'), 'skip.log\n');
      await writeFile(join(f.repo, 'skip.log'), 'ignored\n');

      const created = await create(f, { includeUncommitted: true });
      assertEqual(await readFile(join(created.path, 'a.txt'), 'utf8'), 'edited locally\n', 'tracked edit carried');
      assertEqual(await present(join(created.path, 'gone.txt')), false, 'deletion carried');
      assertEqual(await readFile(join(created.path, 'nested', 'n.txt'), 'utf8'), 'nested new\n', 'untracked file carried (stash create -u would have dropped it)');
      assertEqual(await present(join(created.path, 'skip.log')), false, 'ignored file deliberately stays out');
      assertEqual(await readFile(join(created.path, 'keep.txt'), 'utf8'), 'keep\n', 'untouched file present');

      // The origin must be exactly as the user left it: same edits, same index, no
      // stash entry, still on its own branch.
      assertEqual(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'edited locally\n', 'origin edit untouched');
      assertEqual(await present(join(f.repo, 'gone.txt')), false, 'origin deletion untouched');
      assertEqual(await readFile(join(f.repo, 'nested', 'n.txt'), 'utf8'), 'nested new\n', 'origin untracked file untouched');
      assertEqual((await f.git.process.run(f.repo, ['stash', 'list'])).stdout.trim(), '', 'no stash entry left behind');
      assertEqual((await f.git.process.run(f.repo, ['branch', '--show-current'])).stdout.trim(), 'main', 'origin branch unchanged');
      assertEqual((await f.git.process.run(created.path, ['branch', '--show-current'])).stdout.trim(), created.branch, 'worktree on its own managed branch');
    } finally { await f.close(); }
  });
  h.test('includeUncommitted is off by default and never mixes a dirty tree onto an explicit other base', async () => {
    const f = await fixture(freshRoot());
    try {
      await writeFile(join(f.repo, 'a.txt'), 'edited locally\n');
      const clean = await create(f);
      assertEqual(await readFile(join(clean.path, 'a.txt'), 'utf8'), 'one\n', 'default create keeps its own clean base');

      const head = (await f.git.process.run(f.repo, ['rev-parse', 'HEAD'])).stdout.trim();
      await writeFile(join(f.repo, 'a.txt'), 'edited again\n');
      const based = await create(f, { baseRef: 'main', includeUncommitted: true });
      assertEqual(await readFile(join(based.path, 'a.txt'), 'utf8'), 'edited again\n', 'same-HEAD base still carries the edits');
      await writeFile(join(f.repo, 'a.txt'), 'third edit\n');
      assertEqual(object(await f.git.commit({ workdir: f.repo, message: 'third' })).ok, true, 'new commit moves HEAD');
      const pinned = await create(f, { baseRef: head, includeUncommitted: true });
      assertEqual(await readFile(join(pinned.path, 'a.txt'), 'utf8'), 'one\n', 'explicit older base is never polluted by the current dirty tree');
      assertEqual(await present(join(pinned.path, 'third')), false, 'explicit base content honoured');
    } finally { await f.close(); }
  });
  h.test('managed worktrees register four real channels and preserve the create/status/remove lifecycle', async () => {
    const f = await fixture(freshRoot());
    try {
      assertDeepEqual(f.registry.channels(), [...WORKTREE_CHANNELS].sort(), 'actual worktree channels');
      const created = await create(f); assert(created.branch.startsWith('klaus/wt-'), 'managed branch name');
      assertEqual(await readFile(join(created.path, 'a.txt'), 'utf8'), 'one\n', 'initial committed bytes');
      const clean = object(await invoke(f.registry, 'worktree:status', { path: created.path }));
      assertEqual(clean.dirty, false, 'clean new worktree'); assertEqual(clean.repoRoot, await realpath(f.repo), 'main repository resolved');
      assertDeepEqual(await invoke(f.registry, 'worktree:status', { path: created.path, availabilityOnly: true }),
        { ok: true, state: 'available' }, 'lightweight availability probe avoids Git status');
      await invoke(f.registry, 'worktree:reveal', { path: created.path });
      assertDeepEqual(f.events.at(-1), { kind: 'open', path: created.path }, 'reveal opens the directory');
      await writeFile(join(created.path, 'untracked'), 'discarded with isolated worktree');
      assertDeepEqual(await invoke(f.registry, 'worktree:remove', { path: created.path }), { ok: true }, 'force remove authorized isolated worktree');
      assertEqual(await present(created.path), false, 'directory removed');
      assertEqual((await f.git.process.run(f.repo, ['show-ref', '--verify', 'refs/heads/' + created.branch])).code, 0, 'branch retained');
      assertDeepEqual(f.events.slice(-2), [{ kind: 'before', path: created.path }, { kind: 'after', path: created.path }], 'quiescence before removal cleanup');
    } finally { await f.close(); }
  });
  h.test('an active chat keeps its worktree, and external deletion stays visible without recreating an empty directory', async () => {
    const f = await fixture(freshRoot());
    try {
      const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/worktree-lifecycle-vectors.json'), 'utf8'));
      const created = await create(f);
      f.workspaces.bindSession('live', { workdir: created.path });
      assertDeepEqual(await invoke(f.registry, 'worktree:remove', { path: created.path }), vector.activeChatRemoval, 'host refuses to delete an active chat cwd');
      assertEqual(await present(created.path), true, 'refused removal preserves checkout');
      assertEqual(f.events.length, 0, 'refusal does not quiesce the active chat');
      assertEqual((await f.git.process.run(f.repo, ['worktree', 'remove', '--force', created.path])).code, 0, 'external Git deletion bypasses host');
      const missing = object(await invoke(f.registry, 'worktree:status', { path: created.path }));
      assertEqual(missing.state, vector.externalRemoval.state, 'status reports the missing worktree');
      assertEqual(missing.repoRoot, await realpath(f.repo), 'origin remains available for explicit recovery');
      await assertRejects(() => f.workspaces.sessionDirectory('live'), 'removed cwd is not recreated');
      assertEqual(await present(created.path), false, 'no empty shell was made at the removed path');
      assertEqual(f.workspaces.resolveSessionDirectory('live'), created.path, 'missing binding remains visible instead of silently falling back');
      await assertRejects(() => f.workspaces.setWorkdir({ sessionId: 'live', dir: created.path }), 'a missing checkout cannot be rebound');
      assertDeepEqual(await f.workspaces.setWorkdir({ sessionId: 'live', dir: f.repo }), { ok: true }, 'explicit rebind to origin succeeds');
      assertEqual(await f.workspaces.sessionDirectory('live'), f.repo, 'rebound chat uses real checkout');
    } finally { await f.close(); }
  });
  h.test('worktree creation validates repository and base-ref conditions before writing a managed directory', async () => {
    const f = await fixture(freshRoot());
    try {
      const plain = join(f.root, 'plain'); await mkdir(plain);
      assertEqual(object(await invoke(f.registry, 'worktree:create-from-workdir', { workdir: plain })).error, 'not a git repository', 'plain folder rejected');
      assertEqual((await f.git.process.run(plain, ['init'])).code, 0, 'unborn repo fixture');
      assertEqual(object(await invoke(f.registry, 'worktree:create-from-workdir', { workdir: plain })).error, 'repository has no commits yet', 'unborn repository rejected');
      assertEqual(object(await invoke(f.registry, 'worktree:create-from-workdir', { workdir: f.repo, baseRef: '--help' })).error, 'unknown base ref: --help', 'base ref cannot inject options');
      assertEqual(await present(join(f.root, 'worktrees')), false, 'failed validation created no managed directory');
      const original = (await f.git.process.run(f.repo, ['rev-parse', 'HEAD'])).stdout.trim();
      await writeFile(join(f.repo, 'later'), 'later'); await f.git.commit({ workdir: f.repo, message: 'later' });
      const created = await create(f, { baseRef: original });
      assertEqual(await present(join(created.path, 'later')), false, 'explicit commit selected');
    } finally { await f.close(); }
  });
  h.test('worktree path ownership rejects traversal, ordinary repositories and symlink escapes', async () => {
    const f = await fixture(freshRoot());
    try {
      await mkdir(join(f.root, 'worktrees')); const ordinary = join(f.root, 'worktrees', 'ordinary'); await mkdir(ordinary);
      await f.git.process.run(ordinary, ['init']);
      const escape = join(f.root, 'worktrees', 'escape'); await symlink(f.repo, escape, 'dir');
      for (const path of [f.repo, join(f.root, 'worktrees', '..', 'repo'), join(f.root, 'worktrees'), escape, ordinary]) {
        assertEqual(object(await invoke(f.registry, 'worktree:remove', { path })).ok, false, 'unowned path refused');
      }
      assertEqual(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'one\n', 'main repo remained');
      assertEqual(f.events.length, 0, 'quiescence callbacks not invoked for unowned paths');
    } finally { await f.close(); }
  });
  h.test('worktree removal refuses to proceed when its active resource shutdown fails', async () => {
    const f = await fixture(freshRoot(), { beforeRemove: async () => { throw new Error('engine still running'); } });
    try {
      const created = await create(f);
      assertDeepEqual(await invoke(f.registry, 'worktree:remove', { path: created.path }), { ok: false, error: 'engine still running' }, 'shutdown failure propagated');
      assertEqual(await present(created.path), true, 'worktree left intact');
      assertEqual(f.events.length, 0, 'afterRemove was not called');
    } finally { await f.close(); }
  });
  h.test('separate git directory worktrees resolve the actual main checkout and share its mutation lock', async () => {
    const f = await fixture(freshRoot());
    try {
      assertEqual((await f.git.process.run(f.repo, ['init', '--separate-git-dir', join(f.root, 'git-store')])).code, 0, 'separate metadata fixture');
      const created = await create(f);
      assertEqual(object(await invoke(f.registry, 'worktree:status', { path: created.path })).repoRoot, await realpath(f.repo), 'main checkout independent of metadata path');
      f.workspaces.forgetSession('s');
      const reopened = new WorktreeService({ git: f.git, workspaces: f.workspaces, openPath: async () => {}, beforeRemove: async () => {}, onRemoved: () => {} });
      try {
        assertEqual(object(await reopened.status({ path: created.path })).repoRoot, await realpath(f.repo), 'origin survives service restart without a session or project root');
        assertEqual(withSettingsDb(f.root, db => db.prepare('SELECT COUNT(*) AS count FROM managed_worktree_origins').get()?.count), 1, 'origin is stored outside the repository');
      } finally { reopened.close(); }
      const order: string[] = []; let release!: () => void;
      const blocker = new Promise<void>(resolve => { release = resolve; });
      const first = f.git.withRepositoryMutation(f.repo, async () => { order.push('main'); await blocker; return {}; });
      await waitFor(() => order.length === 1, 1000, 'first mutation entered');
      const second = f.git.withRepositoryMutation(created.path, async () => { order.push('worktree'); return {}; });
      try { await sleep(30); assertDeepEqual(order, ['main'], 'same common-dir lock'); }
      finally { release(); await Promise.all([first, second]); }
      assertDeepEqual(order, ['main', 'worktree'], 'worktree mutation follows main');
      assertDeepEqual(await invoke(f.registry, 'worktree:remove', { path: created.path }), { ok: true }, 'separate-git-dir worktree removed');
      assertEqual(withSettingsDb(f.root, db => db.prepare('SELECT COUNT(*) AS count FROM managed_worktree_origins').get()?.count), 0, 'removal clears the host association');
    } finally { await f.close(); }
  });
  h.test('worktree removal releases the resource lease after a real git refusal or host cleanup failure', async () => {
    let leased = false, releases = 0, cleanupFails = false;
    const f = await fixture(freshRoot(), {
      beforeRemove: async () => { leased = true; return () => { leased = false; releases++; }; },
      onRemoved: () => { assert(leased, 'lease covers post-delete cleanup'); if (cleanupFails) throw new Error('binding cleanup failed'); },
    });
    try {
      const created = await create(f);
      assertEqual((await f.git.process.run(f.repo, ['worktree', 'lock', created.path])).code, 0, 'locked worktree fixture');
      const refused = object(await invoke(f.registry, 'worktree:remove', { path: created.path }));
      assertEqual(refused.ok, false, 'git refuses locked worktree'); assert(String(refused.error).includes('locked'), 'real git error surfaced');
      assertEqual(await present(created.path), true, 'refused directory retained');
      assertEqual(leased, false, 'git failure releases lease'); assertEqual(releases, 1, 'exactly one release after git failure');
      assertEqual((await f.git.process.run(f.repo, ['worktree', 'unlock', created.path])).code, 0, 'unlock fixture');
      cleanupFails = true;
      assertDeepEqual(await invoke(f.registry, 'worktree:remove', { path: created.path }), { ok: false, error: 'binding cleanup failed' }, 'cleanup failure surfaced');
      assertEqual(await present(created.path), false, 'git deletion happened before cleanup');
      assertEqual(leased, false, 'cleanup failure releases lease'); assertEqual(releases, 2, 'exactly one release per operation');
    } finally { await f.close(); }
  });
  h.test('worktree close during a queued removal releases the lease without removing the directory', async () => {
    let leased = false, releases = 0, unlock!: () => void;
    const f = await fixture(freshRoot(), { beforeRemove: async () => { leased = true; return () => { leased = false; releases++; }; } });
    const blocker = new Promise<void>(resolve => { unlock = resolve; });
    let first: Promise<Json> | undefined, removal: Promise<Json> | undefined;
    try {
      const created = await create(f); let entered = false;
      first = f.git.withRepositoryMutation(f.repo, async () => { entered = true; await blocker; return {}; });
      await waitFor(() => entered, 1000, 'blocking mutation entered');
      removal = invoke(f.registry, 'worktree:remove', { path: created.path });
      await waitFor(() => leased, 3000, 'removal holds resource lease before waiting');
      f.worktrees.close(); unlock(); await first;
      assertDeepEqual(await removal, { ok: false, error: 'The worktree service is closed' }, 'queued removal sees close');
      assertEqual(await present(created.path), true, 'close retains directory');
      assertEqual(leased, false, 'close releases lease'); assertEqual(releases, 1, 'release happens once');
    } finally { unlock(); await Promise.allSettled([first, removal]); await f.close(); }
  });
}
