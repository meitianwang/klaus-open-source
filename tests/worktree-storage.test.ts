import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import type { Json } from '../main/ipc/contract';
import { GitService } from '../main/services/git';
import { GitProcess } from '../main/services/git-process';
import { withSettingsDb } from '../main/services/settings';
import { WorktreeStorageService, type WorktreeStorageDeps } from '../main/services/worktree-storage';
import { WorkspaceStore } from '../main/services/workspaces';

const OLD = Date.now() - 2 * 60 * 60 * 1000;
async function fixture(extra: Partial<WorktreeStorageDeps> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'klaus-worktree-storage-')));
  const configRoot = join(root, 'config'), repo = join(root, 'repo'); await mkdir(repo);
  const workspaces = new WorkspaceStore({ configRoot, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  const gitProcess = new GitProcess({ env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: root } });
  if (process.env.KLAUS_WORKTREE_STORAGE_GIT_LOG) {
    const run = gitProcess.run.bind(gitProcess), logPath = process.env.KLAUS_WORKTREE_STORAGE_GIT_LOG;
    gitProcess.run = async (cwd, args, options) => {
      const result = await run(cwd, args, options);
      await appendFile(logPath, JSON.stringify({ command: ['git', ...args], cwd, ...result }) + '\n'); return result;
    };
  }
  const git = new GitService({ workspaces, process: gitProcess, push: () => {}, openPath: async () => {}, revealPath: () => {}, sideQuestion: async () => ({ response: '' }) });
  async function command(args: string[], cwd = repo): Promise<string> {
    const result = await gitProcess.run(cwd, args);
    equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`); equal(result.truncated, false); return result.stdout.trim();
  }
  await command(['init', '-b', 'main']);
  await command(['config', 'user.name', 'Fixture']); await command(['config', 'user.email', 'fixture@example.invalid']);
  await command(['config', 'commit.gpgSign', 'false']); await command(['config', 'core.autocrlf', 'false']);
  await writeFile(join(repo, 'tracked.txt'), 'base\n'); await writeFile(join(repo, 'deleted.txt'), 'keep\n');
  await command(['add', '-A']); await command(['commit', '-m', 'base']);
  let rows: Json[] = [], calls = 0;
  const events: string[] = [], logs: string[] = [];
  const deps: WorktreeStorageDeps = { configRoot, git, workspaces, packaged: true,
    sessionRows: async () => { calls++; return structuredClone(rows); },
    archiveSession: async id => { events.push('archive:' + id); rows = rows.filter(row => (row as { id: string }).id !== id); return { ok: true }; },
    beforeRemove: async path => { events.push('before:' + path); return () => { events.push('release:' + path); }; },
    onRemoved: path => { events.push('removed:' + path); }, log: entry => { logs.push(entry); }, ...extra };
  const service = new WorktreeStorageService(deps);
  async function create(name: string, createdAt = OLD, managedRoot = join(configRoot, 'worktrees')) {
    await mkdir(managedRoot, { recursive: true });
    const path = join(await realpath(managedRoot), name), branch = 'klaus/wt-' + name;
    await command(['worktree', 'add', '-b', branch, path, 'HEAD']);
    const common = await realpath(await command(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    await service.list();
    withSettingsDb(configRoot, db => { db.prepare('INSERT INTO managed_worktree_origins VALUES (?, ?, ?, ?)').run(path, repo, common, createdAt); });
    return { path, branch, common };
  }
  return { root, repo, configRoot, git, service, workspaces, command, create, deps, events, logs,
    setRows(value: Json[]) { rows = value; }, getRows() { return rows; }, calls: () => calls,
    close: async () => { service.close(); await git.close(); await rm(root, { recursive: true, force: true }); } };
}

async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }

test('settings default to enabled/15 and root changes retain recorded historical worktrees', async () => {
  const f = await fixture();
  try {
    const initial = await f.service.list(); equal(initial.settings.autoCleanupEnabled, true); equal(initial.settings.keepCount, 15);
    const first = await f.create('default'); const alternate = join(f.root, 'alternate');
    await f.service.configure({ root: alternate, keepCount: 3, upstreamRefreshMode: 'best-effort' });
    const second = await f.create('alternate', OLD, alternate);
    await f.service.configure({ root: join(f.root, 'third') });
    const inventory = await f.service.list();
    deepEqual(inventory.worktrees.map(row => row.path).sort(), [first.path, second.path].sort());
    equal(inventory.worktrees.find(row => row.path === second.path)?.repoRoot, f.repo);
    equal(inventory.settings.keepCount, 3); equal(inventory.settings.upstreamRefreshMode, 'best-effort');
    await rejects(f.service.configure({ root: 'relative' }), /absolute/);
    await rejects(f.service.configure({ keepCount: 0 }), /positive/);
  } finally { await f.close(); }
});

test('inventory propagates filesystem errors and never follows a managed child or historical parent symlink', async () => {
  const f = await fixture();
  try {
    await f.service.configure({ root: join(f.root, 'regular-file') }); await writeFile(join(f.root, 'regular-file'), 'not a directory');
    await rejects(f.service.list(), /ENOTDIR/);
    await f.service.configure({ root: '' });
    const owned = await f.create('owned'); const external = join(f.root, 'external'); await mkdir(external);
    await symlink(external, join(dirname(owned.path), 'escape'), 'dir');
    equal((await f.service.list()).worktrees.some(row => row.path === external), false);
    await rejects(f.service.deleteManaged(join(dirname(owned.path), 'escape')), /managed/);
    const historicalRoot = join(f.root, 'historical'); const historical = await f.create('historical', OLD, historicalRoot);
    await rename(historicalRoot, historicalRoot + '-old'); await symlink(historicalRoot + '-old', historicalRoot, 'dir');
    equal((await f.service.list()).worktrees.some(row => row.path === historical.path), false);
    await rejects(f.service.deleteManaged(historical.path), /managed/);
    await rejects(f.service.deleteManaged(f.repo), /managed/);
  } finally { await f.close(); }
});

test('permission failures are surfaced instead of an empty inventory', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('POSIX permissions require an unprivileged process'); return; }
  const f = await fixture(); const locked = join(f.root, 'locked');
  try {
    await mkdir(locked); await f.service.configure({ root: locked }); await chmod(locked, 0);
    await rejects(f.service.list(), /EACCES|EPERM/);
  } finally { await chmod(locked, 0o700); await f.close(); }
});

test('manual deletion protects pinned and working active owners including nested cwd and host metadata', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('protected'); await mkdir(join(owned.path, 'subdir'));
    const protections: Record<string, Json>[] = [{ sidebarPinnedAt: Date.now() }, { pinned: true }, { isWorking: true }, { hostMetadata: { sidebarPinnedAt: Date.now() } }];
    for (const flags of protections) {
      f.setRows([{ id: 'owner', cwd: join(owned.path, 'subdir'), ...flags }]);
      await rejects(f.service.deleteManaged(owned.path), /worktree-pinned|worktree-in-use/);
      equal(await exists(owned.path), true);
    }
    equal(f.events.length, 0); ok(f.calls() >= 4);
  } finally { await f.close(); }
});

test('fresh metadata inside the Git mutex blocks a newly pinned owner', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('race');
    f.setRows([{ id: 'owner', cwd: owned.path }]);
    f.deps.beforeRemove = async () => { f.setRows([{ id: 'owner', cwd: owned.path, pinned: true }]); return () => { f.events.push('released'); }; };
    await rejects(f.service.deleteManaged(owned.path), /worktree-pinned/);
    equal(await exists(owned.path), true); deepEqual(f.events, ['released']);
  } finally { await f.close(); }
});

test('deletion snapshots branch, committed history, staged and unstaged bytes, removals, untracked, ignored files and links', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('dirty');
    await writeFile(join(owned.path, 'committed.txt'), 'unique commit\n'); await f.command(['add', '-A'], owned.path); await f.command(['commit', '-m', 'worktree commit'], owned.path);
    const head = await f.command(['rev-parse', 'HEAD'], owned.path);
    await writeFile(join(owned.path, 'tracked.txt'), 'staged\n'); await writeFile(join(owned.path, 'added.bin'), Buffer.from([0, 255, 3]));
    await f.command(['add', '-A'], owned.path); await writeFile(join(owned.path, 'tracked.txt'), 'unstaged\n');
    await rm(join(owned.path, 'deleted.txt')); await writeFile(join(owned.path, 'untracked.bin'), Buffer.from([255, 0, 254]));
    await writeFile(join(owned.path, '.gitignore'), 'ignored.txt\n'); await writeFile(join(owned.path, 'ignored.txt'), 'ignored but valuable\n');
    await symlink('tracked.txt', join(owned.path, 'link'));
    const status = await f.command(['status', '--porcelain=v1', '-z'], owned.path);
    const staged = await f.command(['diff', '--cached', '--binary'], owned.path);
    const unstaged = await f.command(['diff', '--binary'], owned.path);
    f.setRows([{ id: 'owner', cwd: owned.path }, { id: 'child', cwd: join(owned.path, 'missing-subdirectory') }]);
    deepEqual(await f.service.deleteManaged(owned.path), { ok: true }); equal(await exists(owned.path), false);
    equal(await f.command(['rev-parse', 'refs/heads/' + owned.branch]), head);
    const snapshots = withSettingsDb(f.configRoot, db => db.prepare('SELECT state, record FROM managed_worktree_snapshots').all());
    equal(snapshots.length, 1); equal(snapshots[0]?.state, 'complete');
    const saved = JSON.parse(String(snapshots[0]?.record)); equal(saved.head, head); equal(saved.branch, owned.branch);
    const bundle = join(f.configRoot, 'worktree-snapshots', saved.id, 'history.bundle');
    // Drop the retained ref and branch, then prune unreachable objects: the bundle must be sufficient.
    await f.command(['update-ref', '-d', saved.ref]); await f.command(['branch', '-D', owned.branch]);
    await f.command(['reflog', 'expire', '--expire=now', '--all']); await f.command(['gc', '--prune=now']);
    deepEqual(await f.service.restore(owned.path), { ok: true, path: owned.path });
    equal(await f.command(['rev-parse', 'HEAD'], owned.path), head); equal(await f.command(['branch', '--show-current'], owned.path), owned.branch);
    equal(await f.command(['status', '--porcelain=v1', '-z'], owned.path), status);
    equal(await f.command(['diff', '--cached', '--binary'], owned.path), staged); equal(await f.command(['diff', '--binary'], owned.path), unstaged);
    deepEqual(await readFile(join(owned.path, 'untracked.bin')), Buffer.from([255, 0, 254]));
    equal(await readFile(join(owned.path, 'ignored.txt'), 'utf8'), 'ignored but valuable\n'); equal(await readlink(join(owned.path, 'link')), 'tracked.txt');
    equal(await exists(bundle), true); equal((await f.service.list()).worktrees[0]?.repoRoot, f.repo);
    deepEqual(f.events, ['before:' + owned.path, 'archive:owner', 'archive:child', 'removed:' + owned.path, 'release:' + owned.path]);
  } finally { await f.close(); }
});

test('detached HEAD snapshots restore without creating a branch', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('detached'); await f.command(['checkout', '--detach'], owned.path);
    await writeFile(join(owned.path, 'untracked'), 'detached data');
    await f.service.deleteManaged(owned.path); await f.service.restore(owned.path);
    equal(await f.command(['branch', '--show-current'], owned.path), ''); equal(await readFile(join(owned.path, 'untracked'), 'utf8'), 'detached data');
  } finally { await f.close(); }
});

test('archive refusal preserves dirty worktree and its durable snapshot and reports failure', async () => {
  const f = await fixture({ archiveSession: async () => ({ ok: false, error: 'archive refused' }) });
  try {
    const owned = await f.create('archive-failure'); await writeFile(join(owned.path, 'tracked.txt'), 'valuable\n');
    f.setRows([{ id: 'owner', cwd: owned.path }]);
    await rejects(f.service.deleteManaged(owned.path), /archive refused/);
    equal(await readFile(join(owned.path, 'tracked.txt'), 'utf8'), 'valuable\n');
    const rows = withSettingsDb(f.configRoot, db => db.prepare('SELECT state, record FROM managed_worktree_snapshots').all());
    equal(rows[0]?.state, 'failed');
    const saved = JSON.parse(String(rows[0]?.record));
    const directory = join(f.configRoot, 'worktree-snapshots', saved.id);
    const manifest = JSON.parse(await readFile(join(directory, 'files.json'), 'utf8')) as { entries: Array<{ path: string; blob?: string }> };
    const tracked = manifest.entries.find(entry => entry.path === 'tracked.txt'); ok(tracked?.blob);
    equal(gunzipSync(await readFile(join(directory, 'files', tracked.blob))).toString('utf8'), 'valuable\n');
    equal(f.events.includes('removed:' + owned.path), false); equal(f.events.at(-1), 'release:' + owned.path);
  } finally { await f.close(); }
});

test('snapshot failure and edits during archive leave the original worktree untouched', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('changed'); f.setRows([{ id: 'owner', cwd: owned.path }]);
    f.deps.archiveSession = async () => { await writeFile(join(owned.path, 'late.txt'), 'late data'); f.setRows([]); return { ok: true }; };
    await rejects(f.service.deleteManaged(owned.path), /changed after snapshot/);
    equal(await readFile(join(owned.path, 'late.txt'), 'utf8'), 'late data');
    const blocked = await f.create('snapshot-failure');
    const snapshotRoot = join(f.configRoot, 'worktree-snapshots'); await rename(snapshotRoot, snapshotRoot + '-old'); await writeFile(snapshotRoot, 'blocked');
    await rejects(f.service.deleteManaged(blocked.path), /ENOTDIR|EEXIST/); equal(await exists(blocked.path), true);
  } finally { await f.close(); }
});

test('post-removal hook failure is rejected and the saved copy remains restorable', async () => {
  const f = await fixture({ onRemoved: async () => { throw new Error('cleanup hook failed'); } });
  try {
    const owned = await f.create('hook-failure'); await writeFile(join(owned.path, 'untracked'), 'saved');
    await rejects(f.service.deleteManaged(owned.path), /cleanup hook failed/); equal(await exists(owned.path), false);
    await f.service.restore(owned.path); equal(await readFile(join(owned.path, 'untracked'), 'utf8'), 'saved');
  } finally { await f.close(); }
});

test('automatic cleanup is disabled for development and follows the enabled setting', async () => {
  const f = await fixture({ packaged: false });
  try {
    await f.service.configure({ keepCount: 1 }); await f.create('a'); await f.create('b');
    await f.service.scheduleCleanup(); equal((await f.service.list()).worktrees.length, 2);
    f.deps.packaged = true; await f.service.configure({ autoCleanupEnabled: false });
    await f.service.scheduleCleanup(); equal((await f.service.list()).worktrees.length, 2);
  } finally { await f.close(); }
});

test('cleanup prefers ownerless paths then least recently updated owners and preserves protected roots and newborns', async () => {
  const f = await fixture();
  try {
    const ownerless = await f.create('ownerless', OLD + 3000), old = await f.create('old-owner', OLD + 2000);
    const recent = await f.create('recent-owner', OLD), pinned = await f.create('pinned'), working = await f.create('working');
    const newborn = await f.create('newborn', Date.now()), current = await f.create('current'), workspace = await f.create('workspace');
    withSettingsDb(f.configRoot, db => {
      db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run('workspace.active_root', current.path);
      db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run('workspace.groups', JSON.stringify([{ id: 'workspace', name: 'Fixture', roots: [join(workspace.path, 'nested')] }]));
    });
    f.setRows([{ id: 'old', cwd: old.path, updatedAt: OLD + 1000 }, { id: 'recent', cwd: recent.path, updatedAt: OLD + 9000 },
      { id: 'pin', cwd: pinned.path, pinned: true }, { id: 'run', cwd: working.path, isWorking: true }]);
    await writeFile(join(ownerless.path, 'dirty'), 'auto snapshot');
    await f.service.configure({ keepCount: 6 }); await f.service.scheduleCleanup();
    deepEqual(f.events.filter(event => event.startsWith('removed:')), ['removed:' + ownerless.path, 'removed:' + old.path]);
    const kept = (await f.service.list()).worktrees.map(row => row.path);
    for (const row of [recent, pinned, working, newborn, current, workspace]) ok(kept.includes(row.path), row.path);
    await f.service.restore(ownerless.path); equal(await readFile(join(ownerless.path, 'dirty'), 'utf8'), 'auto snapshot');
  } finally { await f.close(); }
});

test('cleanup coalesces triggers, rechecks each owner and caps each round at 20 attempts', async () => {
  const f = await fixture();
  try {
    const worktrees: Array<Awaited<ReturnType<typeof f.create>>> = [];
    for (let index = 0; index < 23; index++) worktrees.push(await f.create('batch-' + String(index).padStart(2, '0'), OLD + index));
    const later = worktrees[1]!;
    const original = f.deps.onRemoved;
    f.deps.onRemoved = async path => { await original(path); if (path === worktrees[0]!.path) f.setRows([{ id: 'newly-pinned', cwd: later.path, sidebarPinnedAt: Date.now() }]); };
    await f.service.configure({ keepCount: 1 });
    const first = f.service.scheduleCleanup(); equal(f.service.scheduleCleanup(), first); await first;
    equal(f.events.filter(event => event.startsWith('removed:')).length, 19);
    equal((await f.service.list()).worktrees.length, 4); equal(await exists(later.path), true);
    ok(f.logs.some(entry => entry.includes('worktree-pinned')));
    await f.service.scheduleCleanup(); equal((await f.service.list()).worktrees.length, 1); equal(await exists(later.path), true);
  } finally { await f.close(); }
});


test('split index and restricted worktree directory modes survive restoration', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('split-index');
    await f.command(['config', 'core.splitIndex', 'true'], owned.path);
    await writeFile(join(owned.path, 'tracked.txt'), 'staged split\n'); await f.command(['add', '-A'], owned.path);
    await f.command(['update-index', '--split-index'], owned.path);
    await writeFile(join(owned.path, 'tracked.txt'), 'unstaged split\n'); await chmod(owned.path, 0o700);
    const staged = await f.command(['diff', '--cached', '--binary'], owned.path);
    await f.service.deleteManaged(owned.path); await f.service.restore(owned.path);
    equal(await f.command(['diff', '--cached', '--binary'], owned.path), staged);
    equal(await readFile(join(owned.path, 'tracked.txt'), 'utf8'), 'unstaged split\n');
    equal((await lstat(owned.path)).mode & 0o777, 0o700);
  } finally { await f.close(); }
});

test('cleanup rechecks owner recency after earlier candidates are removed', async () => {
  const f = await fixture();
  try {
    const first = await f.create('ownerless-first'), changed = await f.create('changed-recency'), last = await f.create('stable-recency');
    f.setRows([{ id: 'changed', cwd: changed.path, updatedAt: OLD }, { id: 'stable', cwd: last.path, updatedAt: OLD + 1000 }]);
    const removed = f.deps.onRemoved;
    f.deps.onRemoved = async path => { await removed(path); if (path === first.path) f.setRows([{ id: 'changed', cwd: changed.path, updatedAt: Date.now() }, { id: 'stable', cwd: last.path, updatedAt: OLD + 1000 }]); };
    await f.service.configure({ keepCount: 1 }); await f.service.scheduleCleanup();
    equal(await exists(changed.path), true); equal(await exists(last.path), false);
    ok(f.logs.some(entry => entry.includes('owners changed')));
  } finally { await f.close(); }
});

test('workspace binding protects owners whose catalog cwd has not caught up', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('binding-owner'); await mkdir(join(owned.path, 'nested'));
    f.workspaces.bindSession('owner', { workdir: join(owned.path, 'nested') });
    f.setRows([{ id: 'owner', cwd: f.repo, isWorking: true }]);
    await rejects(f.service.deleteManaged(owned.path), /worktree-in-use/); equal(await exists(owned.path), true);
  } finally { await f.close(); }
});


async function diskUsage(root: string, excludeGit = false): Promise<{ bytes: number; allocated: number }> {
  const info = await lstat(root);
  if (!info.isDirectory()) return info.isFile() ? { bytes: info.size, allocated: info.blocks * 512 || info.size } : { bytes: 0, allocated: 0 };
  let bytes = 0, allocated = info.blocks * 512 || 0;
  for (const name of await readdir(root)) {
    if (excludeGit && name === '.git') continue;
    const entry = await diskUsage(join(root, name)); bytes += entry.bytes; allocated += entry.allocated;
  }
  return { bytes, allocated };
}

test('compressed snapshots reclaim compressible storage while restoring exact bytes, modes, links and index', async t => {
  const f = await fixture();
  try {
    const owned = await f.create('compressed'); await chmod(owned.path, 0o700);
    await writeFile(join(owned.path, 'tracked.txt'), 'staged content\n'); await f.command(['add', '-A'], owned.path);
    await writeFile(join(owned.path, 'tracked.txt'), 'unstaged content\n');
    await writeFile(join(owned.path, '.gitignore'), 'cache/\n');
    const cache = join(owned.path, 'cache'); await mkdir(cache, { mode: 0o750 }); await mkdir(join(cache, 'empty'), { mode: 0o710 });
    const content = Buffer.alloc(24 * 1024 * 1024, 0x61); content[0] = 0; content[content.length - 1] = 255;
    await writeFile(join(cache, 'large.bin'), content); await chmod(join(cache, 'large.bin'), 0o640);
    await writeFile(join(owned.path, 'untracked executable'), '#!/bin/sh\nprintf fixture\n'); await chmod(join(owned.path, 'untracked executable'), 0o751);
    await symlink('cache/large.bin', join(owned.path, 'large-link'));
    await symlink('../outside-that-is-not-copied', join(owned.path, 'outside-link'));
    const original = await diskUsage(owned.path, true);
    const head = await f.command(['rev-parse', 'HEAD'], owned.path), staged = await f.command(['diff', '--cached', '--binary'], owned.path);
    const unstaged = await f.command(['diff', '--binary'], owned.path);
    await f.service.deleteManaged(owned.path);
    equal(await exists(owned.path), false); equal(await f.service.hasSnapshot(owned.path), true);
    const savedRow = withSettingsDb(f.configRoot, db => db.prepare('SELECT record FROM managed_worktree_snapshots WHERE path = ?').get(owned.path));
    const saved = JSON.parse(String(savedRow?.record)); const directory = join(f.configRoot, 'worktree-snapshots', saved.id);
    const compressed = await diskUsage(directory);
    t.diagnostic(JSON.stringify({ original, compressed, byteRatio: compressed.bytes / original.bytes, allocatedRatio: compressed.allocated / original.allocated }));
    ok(compressed.bytes < original.bytes / 20, 'compressed snapshot must use less than 5% of the original file bytes');
    ok(compressed.allocated < original.allocated / 20, 'compressed snapshot must use less than 5% of the original allocated disk space');
    ok((await readdir(join(directory, 'files'))).every(name => name.endsWith('.gz')));
    equal(await exists(join(directory, 'files', 'cache', 'large.bin')), false);
    const indexBytes = await readFile(join(directory, 'index'));
    await f.service.restore(owned.path);
    const restoredIndex = await f.command(['rev-parse', '--path-format=absolute', '--git-path', 'index'], owned.path);
    deepEqual(await readFile(restoredIndex), indexBytes);
    deepEqual(await readFile(join(cache, 'large.bin')), content);
    equal(await f.command(['rev-parse', 'HEAD'], owned.path), head); equal(await f.command(['branch', '--show-current'], owned.path), owned.branch);
    equal(await f.command(['diff', '--cached', '--binary'], owned.path), staged); equal(await f.command(['diff', '--binary'], owned.path), unstaged);
    for (const [path, mode] of [[owned.path, 0o700], [cache, 0o750], [join(cache, 'empty'), 0o710], [join(cache, 'large.bin'), 0o640], [join(owned.path, 'untracked executable'), 0o751]] as const) {
      equal((await lstat(path)).mode & 0o777, mode);
    }
    equal(await readlink(join(owned.path, 'large-link')), 'cache/large.bin');
    equal(await readlink(join(owned.path, 'outside-link')), '../outside-that-is-not-copied');
  } finally { await f.close(); }
});

test('resume snapshot discovery leaves an ordinary missing worktree without a saved copy untouched', async () => {
  const f = await fixture();
  try {
    const absent = join(f.configRoot, 'worktrees', 'gone-without-snapshot');
    equal(await f.service.hasSnapshot(absent), false);
    await rejects(f.service.restore(absent), /No saved worktree snapshot/);
    equal(await exists(absent), false); deepEqual(f.events, []);
  } finally { await f.close(); }
});

test('corrupt compressed payload is rejected before recreating a removed worktree', async () => {
  const f = await fixture();
  try {
    const owned = await f.create('corrupt-compressed'); await writeFile(join(owned.path, 'untracked'), 'valuable payload');
    await f.service.deleteManaged(owned.path);
    const row = withSettingsDb(f.configRoot, db => db.prepare('SELECT record FROM managed_worktree_snapshots WHERE path = ?').get(owned.path));
    const saved = JSON.parse(String(row?.record)), directory = join(f.configRoot, 'worktree-snapshots', saved.id);
    const manifest = JSON.parse(await readFile(join(directory, 'files.json'), 'utf8')) as { entries: Array<{ path: string; blob?: string }> };
    const entry = manifest.entries.find(item => item.path === 'untracked'); ok(entry?.blob);
    await writeFile(join(directory, 'files', entry.blob), 'damaged gzip');
    await rejects(f.service.restore(owned.path), /header|gzip|Snapshot|compression/i);
    equal(await exists(owned.path), false);
  } finally { await f.close(); }
});


test('archived owners locate their saved working copy before restoration', async () => {
  const f = await fixture();
  try {
    const copy = await f.create('owner-restore');
    f.setRows([{ id: 'owner', workdir: copy.path, isWorking: false }]);
    await f.service.deleteManaged(copy.path);
    deepEqual(await f.service.snapshotForSession('owner'), { path: copy.path, repoRoot: f.repo });
    equal(await f.service.snapshotForSession('unrelated'), null);
    await f.service.restore(copy.path);
    equal(await readFile(join(copy.path, 'tracked.txt'), 'utf8'), 'base\n');
  } finally { await f.close(); }
});
