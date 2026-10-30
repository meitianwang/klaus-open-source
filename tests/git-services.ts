import { access, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerGitHandlers, GIT_CHANNELS } from '../main/ipc/handlers/git';
import { GitProcess } from '../main/services/git-process';
import type { GitDeps, LastTurnChanges } from '../main/services/git';
import { WorkspaceStore } from '../main/services/workspaces';
import { object } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, waitFor } from './harness';

async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'registered ' + channel);
  return handler({ role: 'main', senderId: 1, channel, args: payload === undefined ? [] : [payload] });
}
async function fixture(root: string, extra: Partial<GitDeps> = {}) {
  root = await realpath(root);
  const dir = join(root, 'project'); await mkdir(dir); await writeFile(join(dir, 'source.txt'), 'one\ntwo\n');
  const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
  workspaces.bindSession('s', { workdir: dir });
  const registry = new ChannelRegistry(), pushes: Json[] = [], prompts: unknown[] = [], opened: string[] = [];
  const options = { env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CEILING_DIRECTORIES: root } };
  const git = registerGitHandlers(registry, { workspaces, processOptions: options,
    openPath: async path => { opened.push(path); }, revealPath: path => { opened.push(path); },
    push: (_channel, payload) => pushes.push(payload),
    sideQuestion: async (sessionId, question) => { prompts.push({ sessionId, question }); return { response: '```text\nfeat: improve files\n```' }; }, ...extra });
  const init = await invoke(registry, 'git:init', { workdir: dir }); assertEqual(object(init).ok, true, 'real repo initialized: ' + JSON.stringify(init));
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgSign', 'false']]) {
    assertEqual((await git.process.run(dir, ['config', key!, value!])).code, 0, 'local fixture config');
  }
  return { root, dir, registry, git, workspaces, pushes, prompts, opened };
}

export function registerGitServiceTests(h: Harness, freshRoot: () => string): void {
  h.test('uncommitted reports the exact file set a branch switch would refuse, and carries the rest', async () => {
    const f = await fixture(freshRoot());
    try {
      // The target branch differs from main in a.txt and u.txt. Locally: a.txt and
      // d/c.txt are edited (d/c.txt was added on main after the target branched, so
      // it counts as "also differs on the target" — verified against git, which
      // refuses it too), u.txt is an untracked file the target already tracks, and
      // fresh.txt is brand new.
      assertEqual(object(await invoke(f.registry, 'git:checkout', { workdir: f.dir, branch: 'other', create: true })).ok, true, 'target branch');
      await writeFile(join(f.dir, 'a.txt'), 'on other\n'); await writeFile(join(f.dir, 'u.txt'), 'tracked on other\n');
      assertEqual(object(await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'other' })).ok, true, 'target content');
      assertEqual(object(await invoke(f.registry, 'git:checkout', { workdir: f.dir, branch: 'main' })).ok, true, 'back to main');
      await mkdir(join(f.dir, 'd'), { recursive: true });
      await writeFile(join(f.dir, 'd', 'c.txt'), 'new tracked\n');
      assertEqual(object(await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'main adds d' })).ok, true, 'main content');
      await writeFile(join(f.dir, 'a.txt'), 'locally edited\n'); await writeFile(join(f.dir, 'd', 'c.txt'), 'locally too\n');
      await writeFile(join(f.dir, 'u.txt'), 'locally new\n'); await writeFile(join(f.dir, 'fresh.txt'), 'brand new\n');

      const reply = object(await invoke(f.registry, 'git:uncommitted', { workdir: f.dir, branch: 'other' }));
      assertEqual(reply.ok, true, 'read ok: ' + JSON.stringify(reply));
      assertEqual(reply.dirty, true, 'dirty working tree');
      assertEqual(reply.changes, 4, 'counts every reported change (Qoder: workingTree + index)');
      const files = (reply.files as Json[]).map(row => object(row).path);
      assertDeepEqual(files.sort(), ['a.txt', 'd/c.txt', 'u.txt'], 'exactly the files git refuses (tracked conflicts + colliding untracked)');
      // Non-conflicting edits carry across silently; that is why no confirmation is
      // shown when this set is empty.
      assertEqual(object(await invoke(f.registry, 'git:checkout', { workdir: f.dir, branch: 'other' })).ok, false, 'git really refuses');
      assertEqual((await f.git.process.run(f.dir, ['branch', '--show-current'])).stdout.trim(), 'main', 'still on main');
      const noTarget = object(await invoke(f.registry, 'git:uncommitted', { workdir: f.dir }));
      assertDeepEqual(noTarget.files, [], 'no target branch asked, so nothing is listed');
      const sameBranch = object(await invoke(f.registry, 'git:uncommitted', { workdir: f.dir, branch: 'main' }));
      assertDeepEqual(sameBranch.files, [], 'current branch needs no confirmation');
    } finally { await f.git.close(); }
  });
  h.test('commit-paths commits only the named files and leaves the rest of the working tree alone', async () => {
    const f = await fixture(freshRoot());
    try {
      await writeFile(join(f.dir, 'a.txt'), 'committed\n');
      await writeFile(join(f.dir, 'left-behind.txt'), 'still working\n');
      const reply = object(await invoke(f.registry, 'git:commit-paths', { workdir: f.dir, paths: ['a.txt'], message: 'only a.txt' }));
      assertEqual(reply.ok, true, 'real commit: ' + JSON.stringify(reply));
      assertEqual((await f.git.process.run(f.dir, ['show', 'HEAD:a.txt'])).stdout, 'committed\n', 'named file committed');
      assertEqual((await f.git.process.run(f.dir, ['status', '--porcelain'])).stdout.trim(), '?? left-behind.txt', 'other work untouched and uncommitted');
      assertEqual((await f.git.process.run(f.dir, ['log', '-1', '--format=%s'])).stdout.trim(), 'only a.txt', 'literal message');
      // Jail and validation: traversal, the repo root itself, and empty input are refused.
      assertEqual(object(await invoke(f.registry, 'git:commit-paths', { workdir: f.dir, paths: ['../escape'], message: 'x' })).ok, false, 'traversal refused');
      assertEqual(object(await invoke(f.registry, 'git:commit-paths', { workdir: f.dir, paths: ['.'], message: 'x' })).ok, false, 'repository root refused');
      assertEqual(object(await invoke(f.registry, 'git:commit-paths', { workdir: f.dir, paths: [], message: 'x' })).ok, false, 'empty path list refused');
      assertEqual(object(await invoke(f.registry, 'git:commit-paths', { workdir: f.dir, paths: ['a.txt'], message: '   ' })).ok, false, 'blank message refused');
    } finally { await f.git.close(); }
  });
  h.test('git registrar exposes eleven actual channels and init creates a usable main commit without global identity writes', async () => {
    const f = await fixture(freshRoot());
    try {
      assertDeepEqual(f.registry.channels(), [...GIT_CHANNELS].sort(), 'actual git channels');
      const nested = join(f.dir, 'nested'); await mkdir(nested);
      const branches = object(await invoke(f.registry, 'git:branches', { workdir: nested }));
      assertEqual(branches.current, 'main', 'main exists after init'); assertEqual(branches.gitRoot, f.dir, 'nested project resolves repo');
      assertDeepEqual(branches.branches, ['main'], 'branch list');
      assert((await f.git.process.run(f.dir, ['show', 'HEAD:source.txt'])).stdout.includes('one'), 'initial files committed');
      assertDeepEqual(await invoke(f.registry, 'git:init', { workdir: nested }), { ok: true, alreadyRepo: true }, 'does not create nested repo');
    } finally { await f.git.close(); }
  });
  h.test('git checkout rejects options and preserves dirty edits when git refuses a branch switch', async () => {
    const f = await fixture(freshRoot());
    try {
      assertEqual(object(await invoke(f.registry, 'git:checkout', { workdir: f.dir, branch: '--detach' })).error, 'invalid branch name', 'no option injection');
      assertEqual(object(await invoke(f.registry, 'git:checkout', { workdir: f.dir, branch: 'feature', create: true })).ok, true, 'created feature');
      await writeFile(join(f.dir, 'source.txt'), 'feature\n');
      assertEqual(object(await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'fixture feature' })).ok, true, 'feature commit');
      await invoke(f.registry, 'git:checkout', { workdir: f.dir, branch: 'main' }); await writeFile(join(f.dir, 'source.txt'), 'uncommitted\n');
      const refusal = object(await invoke(f.registry, 'git:checkout', { workdir: f.dir, branch: 'feature' }));
      assertEqual(refusal.ok, false, 'checkout blocked by dirty worktree'); assert(String(refusal.error).includes('overwritten'), 'git refusal preserved');
      assertEqual(await readFile(join(f.dir, 'source.txt'), 'utf8'), 'uncommitted\n', 'uncommitted bytes preserved');
      assertEqual((await f.git.process.run(f.dir, ['branch', '--show-current'])).stdout.trim(), 'main', 'branch unchanged');
    } finally { await f.git.close(); }
  });
  h.test('diff summary preserves binary and unusual filenames with complete untracked file counts', async () => {
    const f = await fixture(freshRoot());
    try {
      const binary = join(f.dir, 'blob.bin'); await writeFile(binary, Buffer.from([0, 1, 2, 3]));
      await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'fixture binary' });
      await writeFile(binary, Buffer.from([0, 2, 2, 3])); await writeFile(join(f.dir, 'source.txt'), 'one\nthree\n');
      const odd = process.platform === 'win32' ? 'odd name.txt' : 'odd\tname\n.txt'; await writeFile(join(f.dir, odd), 'new');
      const first = object(await invoke(f.registry, 'diff:summary', { source: 'uncommitted', sessionId: 's' })), rows = first.files as Json[];
      assertDeepEqual(first.stats, { filesCount: 3, linesAdded: null, linesRemoved: null }, 'binary line volume is unknown, never zero');
      assertEqual(object(rows.find(row => object(row).path === 'blob.bin')).isBinary, true, 'binary flag');
      assertEqual(object(rows.find(row => object(row).path === odd)).isUntracked, true, 'NUL-delimited filename');
      await Promise.all(Array.from({ length: 60 }, (_, i) => writeFile(join(f.dir, 'new-' + i), 'untracked')));
      const large = object(await invoke(f.registry, 'diff:summary', { source: 'uncommitted', sessionId: 's' }));
      assertEqual((large.files as Json[]).length, 63, 'complete file list includes every untracked path');
      assertEqual(object(large.stats).filesCount, 63, 'totals include every untracked file');
    } finally { await f.git.close(); }
  });
  h.test('diff hunk paths are literal, jailed and retain every changed line', async () => {
    const f = await fixture(freshRoot());
    try {
      const literal = process.platform === 'win32' ? 'star space.txt' : 'star*.txt';
      await writeFile(join(f.dir, literal), 'original\n'); await writeFile(join(f.dir, 'starA.txt'), 'untouched\n');
      await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'fixture filenames' });
      await writeFile(join(f.dir, literal), Array.from({ length: 600 }, (_, i) => 'literal ' + i).join('\n') + '\n');
      await writeFile(join(f.dir, 'starA.txt'), 'must not match a wildcard\n');
      const reply = object(await invoke(f.registry, 'diff:hunks', { source: 'uncommitted', sessionId: 's', filePath: literal }));
      const row = object((reply.files as Json[])[0]), changes = row.hunks as Json[];
      assertEqual(row.path, literal, 'caller path echoed'); assertEqual(object(changes[0]).newLines, 600, 'full hunk range');
      assertEqual(changes.reduce<number>((total, hunk) => total + (object(hunk).lines as Json[]).length, 0), 601, 'every removed and added line is retained');
      assert(!JSON.stringify(changes).includes('must not match'), 'literal pathspec cannot select another file');
      assertEqual(object(await invoke(f.registry, 'diff:hunks', { source: 'uncommitted', sessionId: 's', filePath: '../escape' })).error, 'path outside git repository', 'traversal refused');
      await writeFile(join(f.dir, literal), 'a'.repeat(1_100_000));
      const huge = object(await invoke(f.registry, 'diff:hunks', { source: 'uncommitted', sessionId: 's', filePath: literal }));
      assertEqual(huge.detailsTruncated, true, 'patch output capped before materializing large response');
      assertDeepEqual(object((huge.files as Json[])[0]).hunks, [], 'no incomplete hunk advertised');
    } finally { await f.git.close(); }
  });
  h.test('uncommitted file recreation has one untracked row while staged deletion stays inspectable', async () => {
    const f = await fixture(freshRoot());
    try {
      assertEqual((await f.git.process.run(f.dir, ['rm', '--cached', 'source.txt'])).code, 0, 'tracked file removed from index');
      await writeFile(join(f.dir, 'source.txt'), 'recreated\nnew content\n');
      const uncommitted = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'uncommitted' }));
      assertEqual(uncommitted.ok, true, 'uncommitted comparison readable');
      assertEqual((uncommitted.files as Json[]).length, 1, 'one file row for the recreated path');
      const row = object((uncommitted.files as Json[])[0]);
      assertEqual(row.path, 'source.txt', 'recreated filename');
      assertEqual(row.isUntracked, true, 'recreated file retains untracked identity');
      assertDeepEqual(uncommitted.stats, { filesCount: 1, linesAdded: 2, linesRemoved: 0 }, 'totals match the surviving untracked content');
      const detail = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'uncommitted', filePath: 'source.txt' }));
      assertEqual(detail.ok, true, 'recreated content readable');
      assertDeepEqual(object((object((detail.files as Json[])[0]).hunks as Json[])[0]).lines,
        ['+recreated', '+new content'], 'detail matches the recreated file row');
      const staged = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'staged' }));
      assertEqual((staged.files as Json[]).length, 1, 'index deletion remains separately inspectable');
      assertEqual(object((staged.files as Json[])[0]).isUntracked, false, 'staged row is tracked');
      assertDeepEqual(staged.stats, { filesCount: 1, linesAdded: 0, linesRemoved: 2 }, 'staged totals retain the deletion');
      const deletion = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'staged', filePath: 'source.txt' }));
      assertEqual(deletion.ok, true, 'index deletion detail readable');
      assertDeepEqual(object((object((deletion.files as Json[])[0]).hunks as Json[])[0]).lines,
        ['-one', '-two'], 'staged detail retains the original removed content');
    } finally { await f.git.close(); }
  });
  h.test('large tracked diffs retain complete file lists and exact totals', async () => {
    const f = await fixture(freshRoot());
    try {
      const paths = Array.from({ length: 501 }, (_, i) => join(f.dir, 'bulk-' + i));
      await Promise.all(paths.map(path => writeFile(path, 'before\n')));
      assertEqual(object(await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'fixture bulk' })).ok, true, 'bulk baseline commit');
      await Promise.all(paths.map(path => writeFile(path, 'after\n')));
      const reply = object(await invoke(f.registry, 'diff:summary', { source: 'uncommitted', sessionId: 's' }));
      assertEqual(reply.detailsTruncated, false, '501 ordinary files fit the response budget'); assertEqual((reply.files as Json[]).length, 501, 'no arbitrary per-file row cutoff');
      assertDeepEqual(reply.stats, { filesCount: 501, linesAdded: 501, linesRemoved: 501 }, 'totals stay exact');
    } finally { await f.git.close(); }
  });
  h.test('diff transient state blocks commits before staging and reports the panel state', async () => {
    const f = await fixture(freshRoot());
    try {
      const head = (await f.git.process.run(f.dir, ['rev-parse', 'HEAD'])).stdout.trim();
      await writeFile(join(f.dir, '.git', 'MERGE_HEAD'), head + '\n'); await writeFile(join(f.dir, 'source.txt'), 'pending\n');
      assertEqual(object(await invoke(f.registry, 'diff:summary', { source: 'uncommitted', sessionId: 's' })).transient, true, 'transient summary');
      assertEqual(object(await invoke(f.registry, 'diff:hunks', { source: 'uncommitted', sessionId: 's', filePath: 'source.txt' })).transient, true, 'transient hunks');
      assertEqual(object(await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'unsafe' })).ok, false, 'commit blocked');
      assertEqual((await f.git.process.run(f.dir, ['diff', '--cached', '--name-only'])).stdout, '', 'nothing staged');
      assertEqual((await f.git.process.run(f.dir, ['rev-parse', 'HEAD'])).stdout.trim(), head, 'HEAD unchanged');
    } finally { await f.git.close(); }
  });
  h.test('diff commit preserves a multiline literal message and publishes a real hash after staging changes', async () => {
    const f = await fixture(freshRoot());
    try {
      await writeFile(join(f.dir, 'source.txt'), 'changed\n'); await writeFile(join(f.dir, 'new.txt'), 'new\n');
      const message = 'fix: keep $(touch NEVER_CREATED) literal\n\n- Preserve `backticks` too';
      const reply = object(await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message }));
      assertEqual(reply.ok, true, 'real commit'); assert(/^[0-9a-f]{7,}$/.test(String(reply.sha)), 'real short hash');
      assertEqual((await f.git.process.run(f.dir, ['log', '-1', '--format=%B'])).stdout.trim(), message, 'argv preserves exact message');
      assertEqual((await f.git.process.run(f.dir, ['status', '--porcelain'])).stdout, '', 'all displayed changes committed');
      assertEqual(f.pushes.at(-1) && object(f.pushes.at(-1)).type, 'workspace:invalidated', 'commit refresh push');
      try { await access(join(f.dir, 'NEVER_CREATED')); throw new Error('shell interpolation occurred'); } catch (error) { assertEqual((error as NodeJS.ErrnoException).code, 'ENOENT', 'no shell executed'); }
      const noChange = object(await invoke(f.registry, 'diff:commit', { source: 'uncommitted', sessionId: 's', message: 'empty' }));
      assertEqual(noChange.ok, false, 'empty commit not reported successful');
    } finally { await f.git.close(); }
  });
  h.test('commit message generation waits for response and strips fences without changing the transcript or index', async () => {
    const f = await fixture(freshRoot());
    try {
      await writeFile(join(f.dir, 'source.txt'), 'described change\n'); await writeFile(join(f.dir, 'new.txt'), 'not read into prompt');
      assertDeepEqual(await invoke(f.registry, 'diff:generateCommitMessage', { source: 'uncommitted', sessionId: 's' }), { ok: true, message: 'feat: improve files' }, 'response unwrapped');
      assertEqual(f.prompts.length, 1, 'one side question');
      const prompt = object(f.prompts[0]); assertEqual(prompt.sessionId, 's', 'same session context');
      assert(String(prompt.question).includes('described change'), 'patch excerpt included'); assert(String(prompt.question).includes('Untracked files:\nnew.txt'), 'untracked names included');
      assert(!String(prompt.question).includes('not read into prompt'), 'untracked content was not read');
      assertEqual((await f.git.process.run(f.dir, ['diff', '--cached', '--name-only'])).stdout, '', 'generation does not stage');
    } finally { await f.git.close(); }
    const ack = await fixture(freshRoot(), { sideQuestion: async () => ({ submissionId: 'ack' } as unknown as { response: string }) });
    try {
      await writeFile(join(ack.dir, 'new'), 'new');
      const response = object(await invoke(ack.registry, 'diff:generateCommitMessage', { source: 'uncommitted', sessionId: 's' }));
      assertEqual(response.ok, false, 'submission ACK rejected');
      assertEqual(response.error, 'commit message generation returned no response', 'ACK not treated as text');
    } finally { await ack.git.close(); }
  });
  h.test('git context distinguishes plain folders from failures and cannot inherit a redirected GIT_DIR', async () => {
    const root = freshRoot(), f = await fixture(root);
    try {
      const plain = join(root, 'plain'); await mkdir(plain);
      const summary = object(await invoke(f.registry, 'diff:summary', { workdir: plain }));
      assertEqual(summary.isGit, false, 'non repository is a valid panel state');
      assertEqual(object(await invoke(f.registry, 'git:branches', { workdir: plain })).ok, false, 'branch action fails for plain folder');
      const runner = new GitProcess({ env: { GIT_DIR: join(root, 'bogus'), GIT_WORK_TREE: plain } });
      try { assertEqual((await runner.run(f.dir, ['rev-parse', '--show-toplevel'])).stdout.trim(), await import('node:fs/promises').then(fs => fs.realpath(f.dir)), 'explicit cwd is authoritative'); }
      finally { await runner.close(); }
      const missing = new GitProcess({ executable: join(root, 'missing-git') });
      try { assertEqual((await missing.run(f.dir, ['status'])).code, -1, 'spawn failure returned'); } finally { await missing.close(); }
      const path = join(f.dir, 'source.txt'); await invoke(f.registry, 'diff:open', { sessionId: 's', filePath: 'source.txt' });
      assertDeepEqual(f.opened, [path], 'OS action gets repo absolute file');
    } finally { await f.git.close(); }
  });
  h.test('branch is the default source and keeps committed changes against the remote default', async () => {
    const f = await fixture(freshRoot());
    try {
      const base = (await f.git.process.run(f.dir, ['rev-parse', 'HEAD'])).stdout.trim();
      await f.git.process.run(f.dir, ['remote', 'add', 'origin', join(f.root, 'unused-origin')]);
      await f.git.process.run(f.dir, ['update-ref', 'refs/remotes/origin/main', base]);
      await f.git.process.run(f.dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
      await writeFile(join(f.dir, 'source.txt'), 'one\ncommitted change\n');
      assertEqual(object(await invoke(f.registry, 'diff:commit', { sessionId: 's', source: 'uncommitted', message: 'committed ahead' })).ok, true, 'local commit');
      await writeFile(join(f.dir, 'fresh.txt'), 'first\nsecond\n');
      assertEqual((await f.git.process.run(f.dir, ['branch', 'origin/main'])).code, 0, 'local branch shadows remote short name');
      const branch = object(await invoke(f.registry, 'diff:summary', { sessionId: 's' }));
      assertEqual(branch.source, 'branch', 'remote branch comparison is default');
      assertEqual(branch.defaultBaseBranch, 'origin/main', 'default remote baseline');
      assertEqual(object(branch.comparison).baseRevision, base, 'automatic remote baseline ignores same-named local branch');
      assert((branch.baseBranches as Json[]).includes('refs/remotes/origin/main'), 'remote options use canonical refs');
      const tracked = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', filePath: 'source.txt' }));
      assertEqual(object(tracked.comparison).baseRevision, base, 'summary and detail share remote baseline');
      assert(JSON.stringify(tracked).includes('+committed change'), 'remote detail includes committed changes');
      assertDeepEqual((branch.files as Json[]).map(row => object(row).path).sort(), ['fresh.txt', 'source.txt'], 'committed changes remain visible');
      assertDeepEqual(branch.stats, { filesCount: 2, linesAdded: 3, linesRemoved: 1 }, 'untracked contents contribute exact line counts');
      const uncommitted = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'uncommitted' }));
      assertDeepEqual((uncommitted.files as Json[]).map(row => object(row).path), ['fresh.txt'], 'uncommitted is a separate source');
      const fresh = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', filePath: 'fresh.txt' }));
      assertDeepEqual(object((object((fresh.files as Json[])[0]).hunks as Json[])[0]).lines, ['+first', '+second'], 'new-file contents render as additions');
      const commit = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'commit' }));
      assertEqual(commit.ok, true, 'cold commit view chooses latest commit');
      assertEqual(commit.commitSha, object((commit.commits as Json[])[0]).sha, 'selected commit ID returned for detail requests');
      assertDeepEqual((commit.files as Json[]).map(row => object(row).path), ['source.txt'], 'commit source excludes current untracked contents');
      const committed = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'commit', filePath: 'source.txt', commitSha: commit.commitSha! }));
      assert(JSON.stringify(committed).includes('+committed change'), 'commit detail uses same selected commit');
      const headRevision = (await f.git.process.run(f.dir, ['rev-parse', 'HEAD'])).stdout.trim();
      const guarded = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'branch', filePath: 'source.txt',
        expectedBaseRevision: base, expectedHeadRevision: headRevision }));
      assertEqual(guarded.ok, true, 'matching summary snapshot loads details');
      const stale = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'branch', filePath: 'source.txt',
        expectedBaseRevision: headRevision, expectedHeadRevision: headRevision }));
      assertEqual(stale.code, 'DIFF_SNAPSHOT_CHANGED', 'mismatched summary baseline cannot produce a mixed comparison');

      assertEqual(object(await invoke(f.registry, 'diff:commit', { sessionId: 's', source: 'commit', message: 'historical' })).ok, false, 'commit view cannot stage current edits');
      const shadow = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', baseBranch: 'origin/main' }));
      assertDeepEqual((shadow.files as Json[]).map(row => object(row).path), ['fresh.txt'], 'explicit same-named local choice remains local');
      const local = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', baseBranch: 'main' }));
      assertEqual(object(local.comparison).baseBranch, 'main', 'explicit local baseline remains local');
      assertDeepEqual((local.files as Json[]).map(row => object(row).path), ['fresh.txt'], 'local main points at the new commit');
    } finally { await f.git.close(); }
  });
  h.test('an unavailable remote default is explicit and never silently becomes uncommitted', async () => {
    const f = await fixture(freshRoot());
    try {
      await writeFile(join(f.dir, 'source.txt'), 'pending\n');
      const summary = object(await invoke(f.registry, 'diff:summary', { sessionId: 's' }));
      assertEqual(summary.ok, true, 'expected no-base state is readable');
      assertEqual(object(summary.comparison).reason, 'default_branch_unavailable', 'comparison reason is explicit');
      assertDeepEqual(summary.files, [], 'no hidden HEAD comparison fallback');
      const explicit = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'uncommitted' }));
      assertEqual(object(explicit.stats).filesCount, 1, 'user may explicitly request uncommitted');
    } finally { await f.git.close(); }
  });
  h.test('workspace repository selection scopes summary, hunks, open, generate and commit', async () => {
    const f = await fixture(freshRoot());
    try {
      const second = join(f.root, 'other', 'project'); await mkdir(second, { recursive: true }); await writeFile(join(second, 'source.txt'), 'second before\n');
      assertEqual(object(await invoke(f.registry, 'git:init', { workdir: second })).ok, true, 'second repository initialized');
      for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid']]) await f.git.process.run(second, ['config', key!, value!]);
      const workspace = object(f.workspaces.save({ roots: [f.dir, second], name: 'Both repositories' }));
      f.workspaces.bindSession('s', { workspaceId: String(workspace.id) });
      await writeFile(join(f.dir, 'source.txt'), 'primary pending\n');
      await writeFile(join(second, 'source.txt'), 'second pending\n');
      const summary = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'uncommitted', repositoryRoot: second }));
      assertDeepEqual((summary.repositories as Json[]).map(row => object(row).root), [f.dir, second], 'workspace repositories preserve order');
      assertEqual(new Set((summary.repositories as Json[]).map(row => object(row).name)).size, 2, 'same-named repositories have distinct inline labels');
      assertEqual(summary.repositoryRoot, second, 'selected checkout returned');
      assertEqual(object((summary.files as Json[])[0]).repositoryRoot, second, 'file identity carries its repository');
      const detail = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'uncommitted', repositoryRoot: second, filePath: 'source.txt' }));
      assert(JSON.stringify(detail).includes('+second pending'), 'hunks read selected checkout');
      assert(!JSON.stringify(detail).includes('primary pending'), 'other checkout does not leak into detail');
      assertEqual(object(await invoke(f.registry, 'diff:open', { sessionId: 's', repositoryRoot: second, filePath: 'source.txt' })).ok, true, 'selected file opens');
      assertDeepEqual(f.opened, [join(second, 'source.txt')], 'selected repository used by OS action');
      assertEqual(object(await invoke(f.registry, 'diff:generateCommitMessage', { sessionId: 's', source: 'uncommitted', repositoryRoot: second })).ok, true, 'selected repository message');
      assert(String(object(f.prompts[0]).question).includes('second pending'), 'selected diff describes message');
      assert(!String(object(f.prompts[0]).question).includes('primary pending'), 'primary changes not described');
      assertEqual(object(await invoke(f.registry, 'diff:commit', { sessionId: 's', source: 'uncommitted', repositoryRoot: second, message: 'second only' })).ok, true, 'selected repository committed');
      assertEqual((await f.git.process.run(second, ['status', '--porcelain'])).stdout, '', 'second clean');
      assertEqual((await f.git.process.run(f.dir, ['status', '--porcelain'])).stdout.trim(), 'M source.txt', 'primary remains dirty');
      const foreign = join(f.root, 'foreign'); await mkdir(foreign); await invoke(f.registry, 'git:init', { workdir: foreign });
      for (const channel of ['diff:summary', 'diff:hunks', 'diff:open', 'diff:reveal', 'diff:generateCommitMessage', 'diff:commit']) {
        const rejected = object(await invoke(f.registry, channel, { sessionId: 's', source: 'uncommitted', workdir: foreign,
          repositoryRoot: foreign, filePath: 'source.txt', message: 'forbidden' }));
        assertEqual(rejected.error, 'repository is outside this conversation', channel + ' rejects renderer-invented repo');
      }
    } finally { await f.git.close(); }
  });
  h.test('worktree changes retain checkout identity and never read the project origin files', async () => {
    const f = await fixture(freshRoot());
    try {
      const worktree = join(f.root, 'worktree');
      assertEqual((await f.git.process.run(f.dir, ['worktree', 'add', '-b', 'parallel', worktree])).code, 0, 'real worktree');
      f.workspaces.bindSession('wt', { workdir: worktree, projectRoot: f.dir });
      await writeFile(join(f.dir, 'source.txt'), 'origin pending\n');
      await writeFile(join(worktree, 'source.txt'), 'worktree pending\n');
      const summary = object(await invoke(f.registry, 'diff:summary', { sessionId: 'wt', source: 'uncommitted' }));
      assertEqual(summary.root, worktree, 'actual session cwd');
      assertEqual(summary.repositoryRoot, worktree, 'worktree root, never common Git dir');
      assertDeepEqual((summary.repositories as Json[]).map(row => object(row).root), [worktree], 'origin membership is not a selectable checkout');
      const detail = object(await invoke(f.registry, 'diff:hunks', { sessionId: 'wt', source: 'uncommitted', filePath: 'source.txt' }));
      assert(JSON.stringify(detail).includes('+worktree pending'), 'own worktree patch');
      assert(!JSON.stringify(detail).includes('origin pending'), 'origin edits excluded');
      assertEqual(object(await invoke(f.registry, 'diff:summary', { sessionId: 'wt', source: 'uncommitted', repositoryRoot: f.dir })).ok, false, 'origin path not implicit authority');
    } finally { await f.git.close(); }
  });
  h.test('last turn aggregates authored repository patches and rejects stale or unavailable snapshots', async () => {
    const f = await fixture(freshRoot());
    try {
      const second = join(f.root, 'second'); await mkdir(second); await writeFile(join(second, 'source.txt'), 'second disk\n');
      await invoke(f.registry, 'git:init', { workdir: second });
      const patch = '--- before\n+++ after\n@@ -1,1 +1,1 @@\n-old\n+latest turn\n';
      let snapshot: LastTurnChanges = { turnId: 'turn-available', files: [
        { path: join(f.dir, 'source.txt'), kind: 'modify', added: 1, removed: 1, turnDiff: patch },
        { path: join(second, 'source.txt'), kind: 'modify', added: 2, removed: 1, turnDiff: patch.replace('+latest turn', '+second turn\n+more') },
        { path: join(f.dir, 'unknown.txt'), kind: 'modify', added: null, removed: null, turnDiff: null },
        { path: join(f.dir, 'reverted.txt'), kind: 'modify', added: 0, removed: 0, turnDiff: '' },
      ] };
      const registry = new ChannelRegistry();
      const git = registerGitHandlers(registry, { workspaces: f.workspaces, process: f.git.process, push: () => {},
        openPath: async () => {}, revealPath: () => {}, sideQuestion: async () => ({ response: 'unused' }), readLastTurn: async () => snapshot });
      // Discovery includes repositories referenced by trusted engine edits even
      // when the renderer has not configured that second folder as a workspace.
      await writeFile(join(f.dir, 'source.txt'), 'later disk bytes unrelated to saved turn\n');
      const summary = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'last-turn' }));
      assertEqual(summary.repositoryRoot, null, 'all repositories by default');
      assertDeepEqual((summary.repositories as Json[]).map(row => object(row).root), [f.dir, second], 'authored repository discovered');
      assertEqual((summary.files as Json[]).length, 3, 'net-zero reverted file omitted, unavailable file retained');
      assertEqual(summary.turnId, 'turn-available', 'authoritative available turn selected');
      assertEqual(summary.canCommit, false, 'historical turn never offers commit');
      assertEqual(object(summary.stats).linesAdded, null, 'unknown patch count stays unknown');
      const detail = object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: f.dir, filePath: 'source.txt', turnId: 'turn-available' }));
      assertDeepEqual(object((object((detail.files as Json[])[0]).hunks as Json[])[0]).lines, ['-old', '+latest turn'], 'saved cumulative turn patch, not branch or live diff');
      assert(!JSON.stringify(detail).includes('later disk bytes'), 'current disk not substituted for turn output');
      const secondOnly = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'last-turn', repositoryRoot: second }));
      assertDeepEqual((secondOnly.files as Json[]).map(row => object(row).repositoryRoot), [second], 'last turn repository filter');
      const unavailable = object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: f.dir, filePath: 'unknown.txt', turnId: 'turn-available' }));
      assertEqual(object((unavailable.files as Json[])[0]).patchUnavailable, true, 'old records explicitly lack exact patch');
      assertEqual(object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: f.dir, filePath: 'source.txt', turnId: 'old-turn' })).ok, false, 'stale turn ID rejected');
      assertEqual(object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: f.dir, filePath: 'source.txt', turnId: null })).ok, false, 'an explicitly empty old snapshot is also rejected');
      assertEqual(object(await invoke(registry, 'diff:commit', { sessionId: 's', source: 'last-turn', repositoryRoot: f.dir, message: 'wrong scope' })).ok, false, 'historical scope cannot stage live changes');
      const ordinary = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'uncommitted', repositoryRoot: second }));
      assertEqual(ordinary.ok, true, 'authored discovered repo available in ordinary selector too');
      snapshot = { turnId: 'historical', files: [
        { path: join(f.dir, 'source.txt'), kind: 'modify', added: 1, removed: 1, turnDiff: patch, entryId: 'edit-1' },
        { path: join(f.dir, 'source.txt'), kind: 'modify', added: 1, removed: 1, turnDiff: patch.replace('+latest turn', '+second event'), entryId: 'edit-2' },
      ] };
      const historical = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'last-turn' }));
      assertDeepEqual((historical.files as Json[]).map(row => object(row).entryId), ['edit-1', 'edit-2'], 'separate historical events retain identities');
      const event = object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: f.dir,
        filePath: 'source.txt', turnId: 'historical', entryId: 'edit-2' }));
      assert(JSON.stringify(event).includes('+second event'), 'specific historical event selected');
      assert(!JSON.stringify(event).includes('+latest turn'), 'other same-path patch not substituted');
      assertEqual(object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: f.dir,
        filePath: 'source.txt', turnId: 'historical' })).ok, false, 'ambiguous historical patch requires entry ID');
      snapshot = { turnId: null, files: [] };
      const empty = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'last-turn' }));
      assertDeepEqual(empty.files, [], 'no recorded turn does not borrow branch modifications');
      assertEqual(empty.turnId, null, 'no available turn remains null');
      // Both service wrappers share the same owned process, which fixture cleanup
      // closes after all these read-only and refused operations finish.
      void git;
    } finally { await f.git.close(); }
  });
  h.test('live Git scopes survive unavailable history and retain trusted authored repository discovery', async () => {
    let unavailable = true, snapshot: LastTurnChanges = { turnId: null, files: [] };
    const f = await fixture(freshRoot(), { readLastTurn: async () => {
      if (unavailable) throw new Error('saved turn inspection is unavailable');
      return snapshot;
    } });
    try {
      const base = (await f.git.process.run(f.dir, ['rev-parse', 'HEAD'])).stdout.trim();
      await f.git.process.run(f.dir, ['remote', 'add', 'origin', join(f.root, 'unused-origin')]);
      await f.git.process.run(f.dir, ['update-ref', 'refs/remotes/origin/main', base]);
      await f.git.process.run(f.dir, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
      await writeFile(join(f.dir, 'source.txt'), 'live pending\n');
      for (const source of ['branch', 'uncommitted']) {
        const summary = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source }));
        assertEqual(summary.ok, true, source + ' does not require engine history');
        assertEqual(summary.repositoryRoot, f.dir, 'declared repository remains available');
        assertDeepEqual((summary.files as Json[]).map(row => object(row).path), ['source.txt'], 'live changes remain visible');
        const detail = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source, filePath: 'source.txt' }));
        assertEqual(detail.ok, true, source + ' detail remains readable');
        assert(JSON.stringify(detail).includes('+live pending'), 'detail comes from Git, independent of history');
      }
      const failed = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'last-turn' }));
      assertEqual(failed.error, 'saved turn inspection is unavailable', 'Last turn reports missing engine inspection');
      const second = join(f.root, 'authored-repository'); await mkdir(second); await writeFile(join(second, 'source.txt'), 'second before\n');
      await invoke(f.registry, 'git:init', { workdir: second });
      await writeFile(join(second, 'source.txt'), 'second pending\n');
      unavailable = false;
      snapshot = { turnId: 'available-turn', files: [{ path: join(second, 'source.txt'), kind: 'modify', added: 1, removed: 1,
        turnDiff: '--- before\n+++ after\n@@ -1,1 +1,1 @@\n-second before\n+second pending\n' }] };
      const loaded = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'last-turn' }));
      assertEqual(loaded.ok, true, 'successful engine inspection seeds discovery');
      assertDeepEqual((loaded.repositories as Json[]).map(row => object(row).root), [f.dir, second], 'engine-authored extra repository discovered');
      unavailable = true;
      const cached = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'uncommitted', repositoryRoot: second }));
      assertEqual(cached.ok, true, 'cached authored repository remains selectable');
      assertEqual(cached.repositoryRoot, second, 'selection remains on the authored repository');
      const detail = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'uncommitted', repositoryRoot: second, filePath: 'source.txt' }));
      assert(JSON.stringify(detail).includes('+second pending'), 'cached authority still reads current Git data');
      const stale = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: second,
        filePath: 'source.txt', turnId: 'available-turn' }));
      assertEqual(stale.error, 'saved turn inspection is unavailable', 'cached discovery never becomes a stale Last turn patch');
    } finally { await f.git.close(); }
  });
  h.test('aliased cwd and deleted authored paths share one canonical repository identity', async () => {
    let snapshot: LastTurnChanges = { turnId: null, files: [] };
    const f = await fixture(freshRoot(), { readLastTurn: async () => snapshot });
    try {
      const alias = join(f.root, 'project-alias'); await symlink(f.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
      f.workspaces.bindSession('s', { workdir: alias });
      const patch = '--- before\n+++ after\n@@ -1,1 +1,1 @@\n-old\n+new\n';
      snapshot = { turnId: 'alias-turn', files: [
        { path: join(alias, 'source.txt'), kind: 'modify', added: 1, removed: 1, turnDiff: patch },
        { path: join(alias, 'removed-directory', 'deleted.txt'), kind: 'delete', added: 0, removed: 1,
          turnDiff: '--- before\n+++ after\n@@ -1,1 +0,0 @@\n-gone\n' },
      ] };
      const summary = object(await invoke(f.registry, 'diff:summary', { sessionId: 's', source: 'last-turn' }));
      assertEqual(summary.root, alias, 'session cwd remains the user binding');
      assertDeepEqual((summary.repositories as Json[]).map(row => object(row).root), [f.dir], 'alias is not a second plain repository');
      assertDeepEqual((summary.files as Json[]).map(row => object(row).path), ['source.txt', join('removed-directory', 'deleted.txt')], 'existing and deleted paths resolve to their checkout');
      const detail = object(await invoke(f.registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: alias,
        filePath: join('removed-directory', 'deleted.txt'), turnId: 'alias-turn' }));
      assertEqual(detail.ok, true, 'missing file parents do not prevent a stored patch read');
      assertDeepEqual(object((object((detail.files as Json[])[0]).hunks as Json[])[0]).lines, ['-gone'], 'deleted bytes stay available');
    } finally { await f.git.close(); }
  });
  h.test('an unborn repository reports commit unavailable and still offers explicit uncommitted files', async () => {
    const root = await realpath(freshRoot()), dir = join(root, 'unborn'); await mkdir(dir); await writeFile(join(dir, 'new.txt'), 'new\n');
    const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
    workspaces.bindSession('s', { workdir: dir });
    const registry = new ChannelRegistry(), git = registerGitHandlers(registry, { workspaces, push: () => {}, openPath: async () => {},
      revealPath: () => {}, sideQuestion: async () => ({ response: '' }) });
    try {
      assertEqual((await git.process.run(dir, ['init', '-b', 'main'])).code, 0, 'real unborn Git repository');
      const summary = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'commit' }));
      assertEqual(summary.ok, true, 'no commits is a readable empty state');
      assertEqual(object(summary.comparison).reason, 'commit_unavailable', 'reason is explicit');
      const detail = object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'commit', filePath: 'new.txt' }));
      assertEqual(object(detail.comparison).reason, 'commit_unavailable', 'detail does not manufacture a commit');
      const dirty = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'uncommitted' }));
      assertDeepEqual((dirty.files as Json[]).map(row => object(row).path), ['new.txt'], 'initial new file is still viewable');
    } finally { await git.close(); }
  });
  h.test('last turn renders and opens files in a plain workspace without manufacturing a Git comparison', async () => {
    const root = await realpath(freshRoot()), dir = join(root, 'plain'); await mkdir(dir); await writeFile(join(dir, 'artifact.txt'), 'written\n');
    const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, onSessionWorkdirChanged: () => {}, pickDirectory: async () => null });
    workspaces.bindSession('s', { workdir: dir });
    const registry = new ChannelRegistry(), opened: string[] = [];
    const git = registerGitHandlers(registry, { workspaces, push: () => {}, openPath: async path => { opened.push(path); }, revealPath: () => {},
      sideQuestion: async () => ({ response: '' }), readLastTurn: async () => ({ turnId: 'plain-turn', files: [{ path: join(dir, 'artifact.txt'), kind: 'create',
        added: 1, removed: 0, turnDiff: '--- before\n+++ after\n@@ -0,0 +1,1 @@\n+written\n' }] }) });
    try {
      const summary = object(await invoke(registry, 'diff:summary', { sessionId: 's', source: 'last-turn' }));
      assertEqual((summary.files as Json[]).length, 1, 'plain authored file visible');
      assertEqual(summary.gitRoot, null, 'no Git root fabricated');
      assertEqual(summary.isGit, true, 'last turn is usable for existing Changes renderer');
      const detail = object(await invoke(registry, 'diff:hunks', { sessionId: 's', source: 'last-turn', repositoryRoot: dir, filePath: 'artifact.txt', turnId: 'plain-turn' }));
      assertDeepEqual(object((object((detail.files as Json[])[0]).hunks as Json[])[0]).lines, ['+written'], 'plain artifact has stored patch');
      assertEqual(object(await invoke(registry, 'diff:open', { sessionId: 's', source: 'last-turn', repositoryRoot: dir, filePath: 'artifact.txt' })).ok, true, 'plain authored artifact can open');
      assertDeepEqual(opened, [join(dir, 'artifact.txt')], 'correct plain path');
    } finally { await git.close(); }
  });
  if (process.platform !== 'win32') h.test('git timeout and service close reap a real command group without leaving pending operations', async () => {
    const root = freshRoot();
    // Exercise a real git-owned shell and child without executing a new fixture file.
    const args = ['-c', 'alias.klaus-fixture-slow=!trap "" TERM; printf "%s\\n" "$$" > "$KLAUS_FIXTURE_GIT_PID"; sleep 30 & printf "%s\\n" "$!" > "$KLAUS_FIXTURE_GIT_CHILD"; wait', 'klaus-fixture-slow'];
    const readPid = async (path: string): Promise<number> => {
      try { return Number((await readFile(path, 'utf8')).trim()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
    };
    for (const mode of ['timeout', 'close'] as const) {
      const paths = [join(root, `${mode}-pid`), join(root, `${mode}-child`)];
      const env = { KLAUS_FIXTURE_GIT_PID: paths[0], KLAUS_FIXTURE_GIT_CHILD: paths[1], GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
      const runner = new GitProcess({ env, timeoutMs: mode === 'timeout' ? 2000 : 60_000 });
      let exited: Awaited<ReturnType<GitProcess['run']>> | undefined;
      const pending = runner.run(root, args).then(result => { exited = result; return result; });
      try {
        await waitFor(async () => {
          const ids = await Promise.all(paths.map(readPid));
          if (ids.every(id => id > 0)) return true;
          if (exited) throw new Error(`${mode} fixture exited before readiness: ${JSON.stringify(exited)}`);
          return false;
        }, 3000, `${mode} command and child started`);
        assertEqual(exited, undefined, 'the owned command group is running before cancellation');
        if (mode === 'close') await runner.close();
        const result = await pending;
        assertEqual(result.code, -1, `${mode} is failure`);
        assertEqual(result.stderr, mode === 'timeout' ? 'git command timed out' : 'git command cancelled', `${mode} reason`);
        assertEqual(runner.activeCount(), 0, `${mode} request released`);
        for (const path of paths) {
          const id = await readPid(path);
          await waitFor(() => { try { process.kill(id, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } }, 2000, `${mode} owned process exited`);
        }
      } finally { await runner.close(); }
    }
  });
}
