import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitDiffReader, parseGitDiffHunks, type GitDiffResolvedComparison, type GitDiffSource } from '../main/services/git-diff';
import { GitProcess } from '../main/services/git-process';
import { GitService, type LastTurnChanges } from '../main/services/git';
import { createTwoFilesPatch } from 'diff';
import { Harness } from './harness';

const h = new Harness(), roots: string[] = [];
process.exitCode = 1;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-git-diff-')); roots.push(root);
  const dir = join(root, 'repo'); await mkdir(dir);
  const process = new GitProcess({ env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: root } });
  const git = async (args: string[], cwd = dir) => {
    const result = await process.run(cwd, args);
    equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`); return result.stdout.trim();
  };
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['config', 'commit.gpgSign', 'false']); await writeFile(join(dir, 'source.txt'), 'one\ntwo\n');
  await git(['add', '-A']); await git(['commit', '-m', 'base']);
  const base = await git(['rev-parse', 'HEAD']), reader = new GitDiffReader(process);
  const compare = async (source: GitDiffSource, branch?: string, sha?: string) => {
    const result = await reader.comparison(dir, source, branch, sha);
    equal(result.type, 'success', JSON.stringify(result)); return result as GitDiffResolvedComparison;
  };
  const remote = async (name: string, branch = 'main', sha = base, symbolic = true) => {
    await git(['remote', 'add', name, join(root, 'missing-local-remote-' + name)]);
    await git(['update-ref', `refs/remotes/${name}/${branch}`, sha]);
    if (symbolic) await git(['symbolic-ref', `refs/remotes/${name}/HEAD`, `refs/remotes/${name}/${branch}`]);
  };
  return { root, dir, process, reader, git, base, compare, remote };
}

h.test('optional Git stdin preserves bytes and command failures, including SHA-256 object repositories when supported', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 1, 2, 10, 255, 128]);
    const hashed = await f.process.run(f.dir, ['hash-object', '--stdin'], { stdin: bytes });
    equal(hashed.code, 0); equal(hashed.stdout.trim(), '4d46c956493c65f8012038f5c90899d12528c81e'); equal(hashed.truncated, false);
    const stored = await f.process.run(f.dir, ['hash-object', '-w', '--stdin'], { stdin: bytes }); equal(stored.code, 0);
    const raw = await f.process.run(f.dir, ['cat-file', 'blob', stored.stdout.trim()], { rawStdout: true });
    deepEqual(raw.stdoutBytes, bytes); equal(raw.stdout, bytes.toString('utf8'));
    const ordinary = await f.process.run(f.dir, ['cat-file', 'blob', stored.stdout.trim()]); equal(ordinary.stdoutBytes, undefined);
    const rejected = await f.process.run(f.dir, ['hash-object', '--not-a-git-option'], { stdin: Buffer.alloc(1024 * 1024) });
    ok(rejected.code > 0); ok(rejected.stderr.includes('unknown option')); ok(!rejected.stderr.includes('git stdin failed'));
    equal(f.process.activeCount(), 0);
    const sha256 = join(f.root, 'sha256'); await mkdir(sha256);
    const initialized = await f.process.run(sha256, ['init', '--object-format=sha256', '-b', 'main']);
    if (initialized.code !== 0 && /unknown option.*object-format|unsupported.*sha256/i.test(initialized.stderr)) {
      h.info('SHA-256 Git object fixture unavailable', initialized.stderr.trim()); return;
    }
    equal(initialized.code, 0, initialized.stderr);
    const strongHash = await f.process.run(sha256, ['hash-object', '--stdin'], { stdin: bytes });
    equal(strongHash.code, 0); equal(strongHash.stdout.trim(), 'c43651e3c2d9fb02bf34a29628e019b38695deed6436ab4c3bf21fe6956a3cff');
  } finally { await f.process.close(); }
});

h.test('branch includes committed and working changes from the common ancestor, with an explicit local base preserved', async () => {
  const f = await fixture();
  try {
    await f.remote('upstream'); await f.remote('origin', 'release/v2');
    await f.git(['switch', '-c', 'feature']); await writeFile(join(f.dir, 'committed.txt'), 'committed\n');
    await f.git(['add', '-A']); await f.git(['commit', '-m', 'feature']);
    const feature = await f.git(['rev-parse', 'HEAD']);
    await f.git(['update-ref', 'refs/heads/main', feature]);
    await writeFile(join(f.dir, 'source.txt'), 'one\nworking\n');
    const metadata = await f.reader.metadata(f.dir);
    equal(metadata.currentBranch, 'feature'); equal(metadata.defaultBaseBranch, 'origin/release/v2');
    ok(metadata.baseBranches.includes('main')); ok(metadata.baseBranches.includes('refs/remotes/origin/release/v2'));
    equal(metadata.commits[0]?.subject, 'feature'); equal(metadata.commits[0]?.sha, feature);
    const branch = await f.compare('branch'); equal(branch.baseRevision, f.base);
    const summary = await f.reader.summary(f.dir, branch, 'branch');
    deepEqual(summary.files.map(file => file.path).sort(), ['committed.txt', 'source.txt']);
    deepEqual(summary.stats, { filesCount: 2, linesAdded: 2, linesRemoved: 1 });
    const local = await f.compare('branch', 'main'); equal(local.baseRevision, feature);
    deepEqual((await f.reader.summary(f.dir, local, 'branch')).files.map(file => file.path), ['source.txt']);
    await f.git(['branch', 'origin/release/v2', feature]);
    const collision = await f.reader.metadata(f.dir);
    ok(collision.baseBranches.includes('origin/release/v2')); ok(collision.baseBranches.includes('refs/remotes/origin/release/v2'));
    equal((await f.compare('branch')).baseRevision, f.base, 'automatic base stays in the remote namespace');
    equal((await f.compare('branch', 'origin/release/v2')).baseRevision, feature, 'explicit local ref remains local');
    equal((await f.compare('branch', 'refs/remotes/origin/release/v2')).baseRevision, f.base, 'explicit remote ref remains remote');
    await f.git(['branch', '-D', 'main']); await f.git(['update-ref', 'refs/remotes/origin/main', f.base]);
    equal((await f.compare('branch', 'main')).baseRevision, f.base, 'unresolvable short base resolves through ordered remotes');
    await rejects(f.reader.comparison(f.dir, 'branch', '--all'), /invalid comparison reference/);
  } finally { await f.process.close(); }
});

h.test('default remote discovery tries origin before other remotes, including local fallback main and master refs', async () => {
  const f = await fixture();
  try {
    await f.remote('aaa', 'develop'); await f.remote('origin', 'master', f.base, false);
    equal((await f.reader.metadata(f.dir)).defaultBaseBranch, 'origin/master');
    await f.git(['remote', 'remove', 'origin']);
    equal((await f.reader.metadata(f.dir)).defaultBaseBranch, 'aaa/develop');
    await f.git(['remote', 'remove', 'aaa']);
    deepEqual(await f.reader.comparison(f.dir, 'branch'), { type: 'expected', reason: 'default_branch_unavailable', baseBranch: null, headRevision: f.base });
    deepEqual((await f.reader.metadata(f.dir)).baseBranches, ['main']);
  } finally { await f.process.close(); }
});

h.test('a missing or unrelated comparison base reports an unavailable state without a HEAD fallback', async () => {
  const f = await fixture();
  try {
    await f.remote('origin');
    const missing = await f.reader.comparison(f.dir, 'branch', 'origin/missing');
    equal(missing.type, 'expected'); if (missing.type === 'expected') equal(missing.reason, 'merge_base_unavailable');
    await f.git(['switch', '--orphan', 'unrelated']);
    await writeFile(join(f.dir, 'other.txt'), 'other\n'); await f.git(['add', '-A']); await f.git(['commit', '-m', 'unrelated']);
    const unrelated = await f.reader.comparison(f.dir, 'branch');
    equal(unrelated.type, 'expected'); if (unrelated.type === 'expected') equal(unrelated.reason, 'merge_base_unavailable');
  } finally { await f.process.close(); }
});

h.test('a staged comparison pins its old revision across a later soft reset', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'source.txt'), 'one\nhead-side\n'); await f.git(['add', 'source.txt']); await f.git(['commit', '-m', 'head side']);
    const head = await f.git(['rev-parse', 'HEAD']);
    await writeFile(join(f.dir, 'source.txt'), 'one\nindex-side\n'); await f.git(['add', 'source.txt']);
    const comparison = await f.compare('staged'); deepEqual(comparison.args, ['--cached', head]);
    const before = await f.reader.summaryWithSnapshots(f.dir, comparison, 'staged');
    await f.git(['reset', '--soft', f.base]);
    const contents = await f.reader.contents(f.dir, comparison, 'staged', 'source.txt');
    equal(contents.oldContent, 'one\nhead-side\n'); equal(contents.newContent, 'one\nindex-side\n');
    const detail = await f.reader.hunks(f.dir, comparison, 'staged', 'source.txt');
    ok(detail.patch?.includes('-head-side\n+index-side\n')); ok(!detail.patch?.includes('-two\n'));
    const after = await f.reader.summaryWithSnapshots(f.dir, comparison, 'staged');
    deepEqual(after, before); equal(contents.snapshotId, after.files[0]?.snapshotId);
    const fresh = await f.compare('staged');
    ok((await f.reader.summaryWithSnapshots(f.dir, fresh, 'staged')).snapshotId !== before.snapshotId);
    equal((await f.reader.contents(f.dir, fresh, 'staged', 'source.txt')).oldContent, 'one\ntwo\n');
  } finally { await f.process.close(); }
});

h.test('staged, unstaged, uncommitted and commit comparisons preserve their distinct file sets', async () => {
  const f = await fixture();
  try {
    await f.remote('origin');
    await writeFile(join(f.dir, 'staged.txt'), 'staged\n'); await f.git(['add', 'staged.txt']);
    await writeFile(join(f.dir, 'source.txt'), 'one\nworking\n'); await writeFile(join(f.dir, 'new.txt'), 'new\n');
    const paths = async (source: GitDiffSource, sha?: string) => (await f.reader.summary(f.dir, await f.compare(source, undefined, sha), source)).files.map(file => file.path).sort();
    deepEqual(await paths('staged'), ['staged.txt']); deepEqual(await paths('unstaged'), ['new.txt', 'source.txt']);
    deepEqual(await paths('uncommitted'), ['new.txt', 'source.txt', 'staged.txt']);
    deepEqual(await paths('commit', f.base), ['source.txt']);
    deepEqual((await f.reader.summary(f.dir, await f.compare('commit', undefined, f.base), 'commit')).stats,
      { filesCount: 1, linesAdded: 2, linesRemoved: 0 });
    await rejects(f.reader.comparison(f.dir, 'commit', undefined, '--all'), /invalid comparison reference/);
    await rejects(f.reader.comparison(f.dir, 'commit', undefined, 'unavailable'), /comparison commit is unavailable/);
  } finally { await f.process.close(); }
});

h.test('an unborn checkout compares staged and uncommitted files against the empty tree', async () => {
  const f = await fixture();
  try {
    await f.git(['update-ref', '-d', 'refs/heads/main']);
    const metadata = await f.reader.metadata(f.dir); equal(metadata.currentBranch, 'main'); deepEqual(metadata.commits, []);
    const comparison = await f.compare('uncommitted'); equal(comparison.headRevision, null);
    deepEqual((await f.reader.summary(f.dir, comparison, 'uncommitted')).stats, { filesCount: 1, linesAdded: 2, linesRemoved: 0 });
    deepEqual((await f.reader.summary(f.dir, await f.compare('staged'), 'staged')).files.map(file => file.path), ['source.txt']);
  } finally { await f.process.close(); }
});

h.test('same-path tracked deletion and untracked recreation share one working-file comparison while staging retains the deletion', async () => {
  const f = await fixture();
  try {
    await f.remote('origin');
    await f.git(['rm', '--cached', 'source.txt']);
    await writeFile(join(f.dir, 'source.txt'), 'changed\nrecreated\n');
    for (const source of ['branch', 'uncommitted', 'unstaged'] as const) {
      const comparison = await f.compare(source), summary = await f.reader.summary(f.dir, comparison, source);
      deepEqual(summary.files, [{ path: 'source.txt', additions: 2, deletions: 0, changes: 2, isBinary: false, isUntracked: true }]);
      deepEqual(summary.stats, { filesCount: 1, linesAdded: 2, linesRemoved: 0 });
      deepEqual((await f.reader.hunks(f.dir, comparison, source, 'source.txt')).hunks[0]?.lines, ['+changed', '+recreated']);
    }
    const staged = await f.compare('staged'), summary = await f.reader.summary(f.dir, staged, 'staged');
    deepEqual(summary.files, [{ path: 'source.txt', additions: 0, deletions: 2, changes: 2, isBinary: false, isUntracked: false }]);
    deepEqual(summary.stats, { filesCount: 1, linesAdded: 0, linesRemoved: 2 });
    deepEqual((await f.reader.hunks(f.dir, staged, 'staged', 'source.txt')).hunks[0]?.lines, ['-one', '-two']);
  } finally { await f.process.close(); }
});

h.test('an identical recreated working file retains a zero-line relation to its original path', async () => {
  const f = await fixture();
  try {
    await f.remote('origin'); await f.git(['rm', '--cached', 'source.txt']);
    for (const source of ['branch', 'uncommitted'] as const) {
      const comparison = await f.compare(source), summary = await f.reader.summary(f.dir, comparison, source);
      deepEqual(summary.files, [{ path: 'source.txt', previousPath: 'source.txt', additions: 0, deletions: 0, changes: 0,
        isBinary: false, isUntracked: false }]);
      deepEqual(summary.stats, { filesCount: 1, linesAdded: 0, linesRemoved: 0 });
      deepEqual((await f.reader.hunks(f.dir, comparison, source, 'source.txt', 'source.txt')).hunks, []);
    }
    const unstaged = await f.compare('unstaged');
    deepEqual((await f.reader.summary(f.dir, unstaged, 'unstaged')).stats, { filesCount: 1, linesAdded: 2, linesRemoved: 0 });
    const staged = await f.compare('staged');
    deepEqual((await f.reader.hunks(f.dir, staged, 'staged', 'source.txt')).hunks[0]?.lines, ['-one', '-two']);
  } finally { await f.process.close(); }
});

h.test('a moved untracked file matches one deleted object and details compare the original blob to its current content', async () => {
  const f = await fixture();
  try {
    await f.remote('origin'); await rename(join(f.dir, 'source.txt'), join(f.dir, 'moved.txt'));
    for (const source of ['branch', 'uncommitted', 'unstaged'] as const) {
      const comparison = await f.compare(source), summary = await f.reader.summary(f.dir, comparison, source);
      deepEqual(summary.files, [{ path: 'moved.txt', previousPath: 'source.txt', additions: 0, deletions: 0, changes: 0,
        isBinary: false, isUntracked: false }]);
      deepEqual(summary.stats, { filesCount: 1, linesAdded: 0, linesRemoved: 0 });
      deepEqual((await f.reader.hunks(f.dir, comparison, source, 'moved.txt', 'source.txt')).hunks, []);
    }
    await writeFile(join(f.dir, 'moved.txt'), 'one\nchanged\n');
    deepEqual((await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'moved.txt', 'source.txt')).hunks[0]?.lines,
      [' one', '-two', '+changed']);
    deepEqual((await f.reader.summary(f.dir, await f.compare('staged'), 'staged')).files, []);
  } finally { await f.process.close(); }
});

h.test('an inferred move supersedes a deleted destination with its last working-file relation', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'A.txt'), 'alpha\n'); await writeFile(join(f.dir, 'B.txt'), 'beta\n');
    await f.git(['add', 'A.txt', 'B.txt']); await f.git(['commit', '-m', 'distinct object baselines']);
    await f.remote('origin', 'main', await f.git(['rev-parse', 'HEAD']));
    await f.git(['rm', '--cached', 'A.txt', 'B.txt']); await rm(join(f.dir, 'A.txt'));
    await writeFile(join(f.dir, 'B.txt'), 'alpha\n');
    for (const source of ['branch', 'uncommitted'] as const) {
      const comparison = await f.compare(source), summary = await f.reader.summary(f.dir, comparison, source);
      // Destination matching precedes last-wins deduplication, including the deleted destination row.
      deepEqual(summary.files, [{ path: 'B.txt', previousPath: 'A.txt', additions: 0, deletions: 0, changes: 0,
        isBinary: false, isUntracked: false }]);
      deepEqual(summary.stats, { filesCount: 1, linesAdded: 0, linesRemoved: 0 });
      deepEqual((await f.reader.hunks(f.dir, comparison, source, 'B.txt', 'A.txt')).hunks, []);
    }
    deepEqual((await f.reader.summary(f.dir, await f.compare('unstaged'), 'unstaged')).files,
      [{ path: 'B.txt', additions: 1, deletions: 0, changes: 1, isBinary: false, isUntracked: true }]);
    const staged = await f.compare('staged'), summary = await f.reader.summary(f.dir, staged, 'staged');
    deepEqual(summary.files.map(file => file.path), ['A.txt', 'B.txt']);
    deepEqual(summary.stats, { filesCount: 2, linesAdded: 0, linesRemoved: 2 });
    deepEqual((await f.reader.hunks(f.dir, staged, 'staged', 'B.txt')).hunks[0]?.lines, ['-beta']);
  } finally { await f.process.close(); }
});

h.test('object matching requires one deleted candidate and does not consume it when multiple working files match', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'twin.txt'), 'one\ntwo\n'); await f.git(['add', 'twin.txt']); await f.git(['commit', '-m', 'same content']);
    await rename(join(f.dir, 'source.txt'), join(f.dir, 'moved.txt')); await rm(join(f.dir, 'twin.txt'));
    const comparison = await f.compare('uncommitted');
    const ambiguous = await f.reader.summary(f.dir, comparison, 'uncommitted');
    equal(ambiguous.files.length, 3); ok(ambiguous.files.every(file => file.previousPath == null));
    deepEqual(ambiguous.stats, { filesCount: 3, linesAdded: 2, linesRemoved: 4 });
    await writeFile(join(f.dir, 'twin.txt'), 'one\ntwo\n'); await writeFile(join(f.dir, 'second-copy.txt'), 'one\ntwo\n');
    const matched = await f.reader.summary(f.dir, comparison, 'uncommitted');
    deepEqual(matched.files.map(file => ({ path: file.path, previousPath: file.previousPath })).sort((a, b) => a.path.localeCompare(b.path)),
      [{ path: 'moved.txt', previousPath: 'source.txt' }, { path: 'second-copy.txt', previousPath: 'source.txt' }]);
    deepEqual(matched.stats, { filesCount: 2, linesAdded: 0, linesRemoved: 0 });
  } finally { await f.process.close(); }
});

if (process.platform !== 'win32') h.test('blob comparisons keep unusual option-looking paths literal and mode-only relations have no content hunks', async () => {
  const f = await fixture();
  try {
    const previousPath = '-old:*name\t\n.txt', path = '-new:*name\t\n.txt';
    await writeFile(join(f.dir, previousPath), 'literal content\n'); await chmod(join(f.dir, previousPath), 0o755);
    await f.git(['add', '--', previousPath]); await f.git(['commit', '-m', 'literal executable']);
    await rename(join(f.dir, previousPath), join(f.dir, path)); await chmod(join(f.dir, path), 0o644);
    const comparison = await f.compare('uncommitted'), summary = await f.reader.summary(f.dir, comparison, 'uncommitted');
    deepEqual(summary.files, [{ path, previousPath, additions: 0, deletions: 0, changes: 0, isBinary: false, isUntracked: false }]);
    deepEqual((await f.reader.hunks(f.dir, comparison, 'uncommitted', path, previousPath)).hunks, []);
    await writeFile(join(f.dir, path), 'literal changed\n');
    deepEqual((await f.reader.hunks(f.dir, comparison, 'uncommitted', path, previousPath)).hunks[0]?.lines,
      ['-literal content', '+literal changed']);
    equal(await f.git(['diff', '--cached', '--name-only']), '', 'identity and blob comparisons leave the index untouched');
  } finally { await f.process.close(); }
});

if (process.platform !== 'win32') h.test('exact moves preserve binary, symlink and embedded-repository object identities', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'secret.txt'); await writeFile(outside, 'external bytes\n');
    await symlink(outside, join(f.dir, 'old-link')); await writeFile(join(f.dir, 'old.bin'), Buffer.from([0, 1, 2]));
    const embedded = join(f.dir, 'old-repository'); await mkdir(embedded);
    await f.git(['init', '-b', 'main'], embedded);
    await f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'embedded'], embedded);
    await f.git(['add', '-A']); await f.git(['commit', '-m', 'object kinds']);
    await rename(join(f.dir, 'old-link'), join(f.dir, 'new-link'));
    await rename(join(f.dir, 'old.bin'), join(f.dir, 'new.bin'));
    await rename(embedded, join(f.dir, 'new-repository'));
    const comparison = await f.compare('uncommitted'), summary = await f.reader.summary(f.dir, comparison, 'uncommitted');
    deepEqual(summary.files.map(file => ({ path: file.path, previousPath: file.previousPath })).sort((a, b) => a.path.localeCompare(b.path)),
      [{ path: 'new-link', previousPath: 'old-link' }, { path: 'new-repository', previousPath: 'old-repository' }, { path: 'new.bin', previousPath: 'old.bin' }]);
    deepEqual(summary.stats, { filesCount: 3, linesAdded: 0, linesRemoved: 0 }); equal(summary.statsIncomplete, false);
    for (const file of summary.files) deepEqual((await f.reader.hunks(f.dir, comparison, 'uncommitted', file.path, file.previousPath)).hunks, []);
    ok(!JSON.stringify(summary).includes('external bytes'));
  } finally { await f.process.close(); }
});

h.test('untracked text has exact content and line counts, binary values stay unknown, ignored files stay absent', async () => {
  const f = await fixture();
  try {
    await f.remote('origin'); await writeFile(join(f.dir, '.gitignore'), 'ignored.txt\n');
    await f.git(['add', '.gitignore']); await f.git(['commit', '-m', 'ignore']);
    const literal = process.platform === 'win32' ? 'odd name.txt' : 'odd\t*name\n.txt';
    await writeFile(join(f.dir, literal), 'alpha\nbeta'); await writeFile(join(f.dir, 'blob.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(f.dir, 'ignored.txt'), 'hidden\n'); await writeFile(join(f.dir, 'empty.txt'), '');
    const comparison = await f.compare('uncommitted'), summary = await f.reader.summary(f.dir, comparison, 'uncommitted');
    deepEqual(summary.files.map(file => file.path).sort(), ['blob.bin', 'empty.txt', literal].sort());
    const text = summary.files.find(file => file.path === literal)!;
    equal(text.additions, 2); equal(text.deletions, 0); equal(text.isUntracked, true);
    const binary = summary.files.find(file => file.path === 'blob.bin')!;
    equal(binary.additions, null); equal(binary.deletions, null); equal(binary.isBinary, true);
    equal(summary.stats.linesAdded, null); equal(summary.stats.linesRemoved, null); equal(summary.statsIncomplete, true);
    deepEqual((await f.reader.hunks(f.dir, comparison, 'uncommitted', literal)).hunks[0]?.lines,
      ['+alpha', '+beta', '\\ No newline at end of file']);
    equal((await f.reader.hunks(f.dir, comparison, 'uncommitted', 'blob.bin')).isBinary, true);
    deepEqual((await f.reader.hunks(f.dir, comparison, 'uncommitted', 'empty.txt')).hunks, []);
    equal(await f.git(['diff', '--cached', '--name-only']), '', 'reading never stages untracked files');
    equal(await readFile(join(f.dir, literal), 'utf8'), 'alpha\nbeta');
  } finally { await f.process.close(); }
});

if (process.platform !== 'win32') h.test('untracked symlinks and embedded repositories display Git content without reading external targets', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'external target bytes\n');
    await symlink(join(outside, 'secret.txt'), join(f.dir, 'link.txt'));
    await symlink(outside, join(f.dir, 'redirect'));
    const embedded = join(f.dir, 'embedded'); await mkdir(embedded);
    await f.git(['init', '-b', 'main'], embedded); await f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'nested'], embedded);
    const comparison = await f.compare('uncommitted'), summary = await f.reader.summary(f.dir, comparison, 'uncommitted');
    equal(summary.files.find(file => file.path === 'embedded')?.additions, 1);
    const link = await f.reader.hunks(f.dir, comparison, 'uncommitted', 'link.txt');
    deepEqual(link.hunks[0]?.lines, ['+' + join(outside, 'secret.txt'), '\\ No newline at end of file']);
    ok(!JSON.stringify(link).includes('external target bytes'));
    const nested = await f.reader.hunks(f.dir, comparison, 'uncommitted', 'embedded');
    ok(nested.hunks[0]?.lines[0]?.startsWith('+Subproject commit '));
    await rejects(f.reader.hunks(f.dir, comparison, 'uncommitted', 'redirect/secret.txt'), /path outside git repository/);
    await rejects(f.reader.hunks(f.dir, comparison, 'uncommitted', '../outside/secret.txt'), /path outside git repository/);
  } finally { await f.process.close(); }
});

h.test('patches retain more than 400 lines and explicitly report output truncation', async () => {
  const f = await fixture();
  try {
    const comparison = await f.compare('uncommitted');
    await writeFile(join(f.dir, 'source.txt'), Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n') + '\n');
    const patch = await f.reader.hunks(f.dir, comparison, 'uncommitted', 'source.txt');
    equal(patch.detailsTruncated, false); equal(patch.hunks.reduce((count, hunk) => count + hunk.lines.length, 0), 602);
    await writeFile(join(f.dir, 'large.txt'), 'large'.repeat(250_000));
    deepEqual(await f.reader.hunks(f.dir, comparison, 'uncommitted', 'large.txt'), { hunks: [], isBinary: false, detailsTruncated: true });
  } finally { await f.process.close(); }
});

h.test('missing final newline notes remain in the patch without changing hunk ranges', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'source.txt'), 'one\ntwo'); await f.git(['add', 'source.txt']); await f.git(['commit', '-m', 'no final newline']);
    await writeFile(join(f.dir, 'source.txt'), 'one\nthree');
    const patch = await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'source.txt');
    deepEqual(patch.hunks, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2,
      lines: [' one', '-two', '\\ No newline at end of file', '+three', '\\ No newline at end of file'] }]);
  } finally { await f.process.close(); }
});

h.test('rename statistics carry the original path and literal wildcard paths never include siblings', async () => {
  const f = await fixture();
  try {
    const literal = process.platform === 'win32' ? 'star space.txt' : 'star*.txt';
    await writeFile(join(f.dir, literal), 'literal\n'); await writeFile(join(f.dir, 'starA.txt'), 'sibling\n');
    await f.git(['add', '-A']); await f.git(['commit', '-m', 'literal paths']);
    await f.git(['mv', 'source.txt', 'renamed.txt']); await writeFile(join(f.dir, 'renamed.txt'), 'one\ntwo\nthree\n');
    await writeFile(join(f.dir, literal), 'literal changed\n'); await writeFile(join(f.dir, 'starA.txt'), 'sibling changed\n');
    const comparison = await f.compare('uncommitted'), summary = await f.reader.summary(f.dir, comparison, 'uncommitted');
    equal(summary.files.find(file => file.path === 'renamed.txt')?.previousPath, 'source.txt');
    const renamed = await f.reader.hunks(f.dir, comparison, 'uncommitted', 'renamed.txt', 'source.txt');
    ok(JSON.stringify(renamed).includes('+three'));
    const patch = await f.reader.hunks(f.dir, comparison, 'uncommitted', literal);
    ok(JSON.stringify(patch).includes('+literal changed')); ok(!JSON.stringify(patch).includes('sibling changed'));
  } finally { await f.process.close(); }
});

h.test('excess untracked files are explicitly omitted as one set without claiming zero line totals', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 513 }, (_, index) => writeFile(join(f.dir, `new-${index}.txt`), 'new\n')));
    const summary = await f.reader.summary(f.dir, await f.compare('uncommitted'), 'uncommitted');
    deepEqual(summary.untrackedFilesOmitted, { count: 513, limit: 512 }); equal(summary.statsIncomplete, true);
    deepEqual(summary.stats, { filesCount: 513, linesAdded: null, linesRemoved: null }); deepEqual(summary.files, []);
  } finally { await f.process.close(); }
});

h.test('detached linked worktrees use their own files and the shared remote baseline', async () => {
  const f = await fixture();
  try {
    await f.remote('origin'); const worktree = join(f.root, 'worktree');
    await f.git(['worktree', 'add', '--detach', worktree, f.base]);
    await writeFile(join(f.dir, 'original-only.txt'), 'original\n'); await writeFile(join(worktree, 'worktree-only.txt'), 'worktree\n');
    const metadata = await f.reader.metadata(worktree); equal(metadata.currentBranch, null); equal(metadata.defaultBaseBranch, 'origin/main');
    const comparison = await f.reader.comparison(worktree, 'branch'); equal(comparison.type, 'success');
    const summary = await f.reader.summary(worktree, comparison as GitDiffResolvedComparison, 'branch');
    deepEqual(summary.files.map(file => file.path), ['worktree-only.txt']); equal(summary.stats.linesAdded, 1);
  } finally { await f.process.close(); }
});

h.test('complete comparison contents preserve merge-base, HEAD, index, selected commit and working text independently', async () => {
  const f = await fixture();
  try {
    await f.remote('origin');
    await writeFile(join(f.dir, 'source.txt'), 'committed\n'); await f.git(['add', '-A']); await f.git(['commit', '-m', 'change']);
    const commit = await f.git(['rev-parse', 'HEAD']);
    await writeFile(join(f.dir, 'source.txt'), 'index\r\n'); await f.git(['add', 'source.txt']);
    const working = '\ufeffworking\r\nlast'; await writeFile(join(f.dir, 'source.txt'), working);
    const expected: Array<[GitDiffSource, string, string]> = [
      ['branch', 'one\ntwo\n', working], ['uncommitted', 'committed\n', working],
      ['unstaged', 'index\r\n', working], ['staged', 'committed\n', 'index\r\n'],
      ['commit', 'one\ntwo\n', 'committed\n'],
    ];
    for (const [source, oldContent, newContent] of expected) {
      const comparison = await f.compare(source, undefined, source === 'commit' ? commit : undefined);
      const result = await f.reader.contents(f.dir, comparison, source, 'source.txt');
      equal(result.oldContent, oldContent, source); equal(result.newContent, newContent, source);
      equal(result.contentsUnavailable, undefined); ok(result.snapshotId);
    }
    const initial = await f.reader.contents(f.dir, await f.compare('commit', undefined, f.base), 'commit', 'source.txt');
    equal(initial.oldContent, ''); equal(initial.newContent, 'one\ntwo\n');
  } finally { await f.process.close(); }
});

h.test('complete sides preserve creation, deletion, rename relations and same-path untracked recreation', async () => {
  const f = await fixture();
  try {
    const comparison = await f.compare('uncommitted');
    await rename(join(f.dir, 'source.txt'), join(f.dir, 'moved.txt'));
    const renamed = await f.reader.contents(f.dir, comparison, 'uncommitted', 'moved.txt', 'source.txt');
    equal(renamed.oldContent, 'one\ntwo\n'); equal(renamed.newContent, 'one\ntwo\n');
    const deleted = await f.reader.contents(f.dir, comparison, 'uncommitted', 'source.txt');
    equal(deleted.oldContent, 'one\ntwo\n'); equal(deleted.newContent, '');
    await writeFile(join(f.dir, 'source.txt'), 'replacement'); await f.git(['rm', '--cached', 'source.txt']);
    const recreated = await f.reader.contents(f.dir, comparison, 'uncommitted', 'source.txt');
    equal(recreated.oldContent, ''); equal(recreated.newContent, 'replacement');
    const staged = await f.reader.contents(f.dir, await f.compare('staged'), 'staged', 'source.txt');
    equal(staged.oldContent, 'one\ntwo\n'); equal(staged.newContent, '');
  } finally { await f.process.close(); }
});

if (process.platform !== 'win32') h.test('snapshot symlinks describe their link text and gitlinks describe object identities without external target reads', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'external secret');
    await symlink(outside, join(f.dir, 'link'));
    const added = await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', 'link');
    equal(added.oldContent, ''); equal(added.newContent, outside); ok(!added.newContent?.includes('external secret'));
    const linkPatch = await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'link');
    ok(linkPatch.patch?.includes('new file mode 120000\n')); ok(linkPatch.patch?.includes(`+${outside}\n`));
    equal((await f.process.run(f.dir, ['apply', '--reverse', '--check', '-'], { stdin: linkPatch.patch! })).code, 0);
    await f.git(['add', 'link']); await f.git(['commit', '-m', 'link']);
    await rm(join(f.dir, 'link')); await symlink('missing-target', join(f.dir, 'link'));
    const changed = await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', 'link');
    equal(changed.oldContent, outside); equal(changed.newContent, 'missing-target');
    const nested = join(f.dir, 'nested'); await mkdir(nested);
    await f.git(['init', '-b', 'main'], nested); await f.git(['config', 'user.name', 'Fixture'], nested);
    await f.git(['config', 'user.email', 'fixture@example.invalid'], nested);
    await f.git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'nested'], nested);
    const oid = await f.git(['rev-parse', 'HEAD'], nested);
    const gitlink = await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', 'nested');
    equal(gitlink.oldContent, ''); equal(gitlink.newContent, `Subproject commit ${oid}\n`);
    await f.git(['add', 'nested']); await f.git(['commit', '-m', 'gitlink']);
    await writeFile(join(nested, 'dirty.txt'), 'dirty\n');
    const dirty = await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', 'nested');
    equal(dirty.oldContent, `Subproject commit ${oid}\n`); equal(dirty.newContent, `Subproject commit ${oid}-dirty\n`);
  } finally { await f.process.close(); }
});

h.test('binary, oversized and invalidly encoded contents remain unavailable while usable Unicode stays exact', async () => {
  const f = await fixture();
  try {
    const comparison = await f.compare('uncommitted');
    await writeFile(join(f.dir, 'binary'), Buffer.from([1, 0, 255]));
    await writeFile(join(f.dir, 'large'), 'x'.repeat(1024 * 1024 + 1));
    await writeFile(join(f.dir, 'invalid'), Buffer.from([255, 254, 253]));
    await writeFile(join(f.dir, 'unicode'), 'replacement \ufffd\n');
    for (const [path, reason] of [['binary', 'binary'], ['large', 'too-large'], ['invalid', 'unsupported-encoding']]) {
      const value = await f.reader.contents(f.dir, comparison, 'uncommitted', path!);
      equal(value.contentsUnavailable, reason); equal(value.oldContent, ''); equal(value.newContent, undefined); ok(value.snapshotId);
    }
    await f.git(['add', 'unicode', 'invalid']); await f.git(['commit', '-m', 'encoding']);
    await writeFile(join(f.dir, 'unicode'), 'next \ufffd'); await writeFile(join(f.dir, 'invalid'), 'readable');
    const unicode = await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', 'unicode');
    equal(unicode.oldContent, 'replacement \ufffd\n'); equal(unicode.newContent, 'next \ufffd');
    const invalid = await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', 'invalid');
    equal(invalid.contentsUnavailable, 'unsupported-encoding');
  } finally { await f.process.close(); }
});

h.test('bounded image, SVG and PDF snapshots preserve exact Git and working bytes with verified media types', async () => {
  const f = await fixture();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfcAAAAASUVORK5CYII=', 'base64');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%'), Buffer.from([226, 227, 207, 211]), Buffer.from('\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')]);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>\n';
    await writeFile(join(f.dir, 'image.png'), png); await writeFile(join(f.dir, 'document.pdf'), pdf); await writeFile(join(f.dir, 'vector.svg'), svg);
    await f.git(['add', '-A']); await f.git(['commit', '-m', 'media']);
    const nextPng = Buffer.concat([png, Buffer.from('\n')]), nextPdf = Buffer.concat([pdf, Buffer.from('% changed\n')]);
    const nextSvg = svg.replace('width="1"', 'width="2"');
    await writeFile(join(f.dir, 'image.png'), nextPng); await writeFile(join(f.dir, 'document.pdf'), nextPdf); await writeFile(join(f.dir, 'vector.svg'), nextSvg);
    const service = serviceFor(f);
    for (const [path, before, after, mime] of [
      ['image.png', png, nextPng, 'image/png'], ['document.pdf', pdf, nextPdf, 'application/pdf'],
      ['vector.svg', Buffer.from(svg), Buffer.from(nextSvg), 'image/svg+xml'],
    ] as const) {
      const result: any = await service.hunks({ sessionId: 'fixture', source: 'uncommitted', filePath: path, includeContents: true });
      equal(result.ok, true); equal(result.files[0].oldDataUrl, `data:${mime};base64,${before.toString('base64')}`);
      equal(result.files[0].newDataUrl, `data:${mime};base64,${after.toString('base64')}`);
      if (path === 'vector.svg') { equal(result.files[0].oldContent, svg); equal(result.files[0].newContent, nextSvg); }
    }
    await writeFile(join(f.dir, 'fake.png'), 'not an image'); await writeFile(join(f.dir, 'fake.svg'), '<html>not svg</html>');
    for (const path of ['fake.png', 'fake.svg']) equal((await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', path)).newDataUrl, undefined);
    await writeFile(join(f.dir, 'huge.png'), Buffer.concat([png, Buffer.alloc(1024 * 1024)]));
    const huge = await f.reader.contents(f.dir, await f.compare('uncommitted'), 'uncommitted', 'huge.png');
    equal(huge.contentsUnavailable, 'too-large'); equal(huge.newDataUrl, undefined);
  } finally { await f.process.close(); }
});

h.test('raw details retain executable binary patches, pure rename headers, file modes and missing newline markers', async () => {
  const f = await fixture();
  try {
    await f.git(['mv', 'source.txt', 'moved.txt']);
    const renamed = await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'moved.txt', 'source.txt');
    ok(renamed.patch?.includes('rename from source.txt\n')); ok(renamed.patch?.includes('rename to moved.txt\n'));
    deepEqual(renamed.hunks, []);
    equal((await f.process.run(f.dir, ['apply', '--reverse', '--check', '-'], { stdin: renamed.patch! })).code, 0);
    await f.git(['reset', '--hard', 'HEAD']);
    await writeFile(join(f.dir, 'source.txt'), 'changed without final newline');
    const text = await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'source.txt');
    ok(text.patch?.includes('\\ No newline at end of file'));
    equal((await f.process.run(f.dir, ['apply', '--reverse', '--check', '-'], { stdin: text.patch! })).code, 0);
    await writeFile(join(f.dir, 'source.txt'), Buffer.from([0, 1, 255, 128]));
    const binary = await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'source.txt');
    equal(binary.isBinary, true); ok(binary.patch?.includes('GIT binary patch\n'));
    equal((await f.process.run(f.dir, ['apply', '--reverse', '--check', '-'], { stdin: binary.patch! })).code, 0);
    if (process.platform !== 'win32') {
      await f.git(['reset', '--hard', 'HEAD']); await f.git(['config', 'core.filemode', 'true']); await chmod(join(f.dir, 'source.txt'), 0o755);
      const mode = await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'source.txt');
      ok(mode.patch?.includes('old mode 100644\n')); ok(mode.patch?.includes('new mode 100755\n')); deepEqual(mode.hunks, []);
    }
  } finally { await f.process.close(); }
});

function serviceFor(f: Awaited<ReturnType<typeof fixture>>, readLastTurn?: () => Promise<LastTurnChanges>) {
  return new GitService({ process: f.process,
    workspaces: { sessionDirectory: async () => f.dir, sessionRoots: () => [f.dir] } as any,
    openPath: async () => {}, revealPath: () => {}, sideQuestion: async () => ({ response: '' }), push: () => {}, readLastTurn });
}

h.test('summary identities reject same-count working and index edits before detail hydration', async () => {
  const f = await fixture();
  try {
    const service = serviceFor(f);
    await writeFile(join(f.dir, 'source.txt'), 'one\nfirst\n');
    const summary: any = await service.summary({ sessionId: 'fixture', source: 'uncommitted' });
    equal(summary.ok, true); ok(summary.snapshotId); ok(summary.files[0].snapshotId);
    const options = { sessionId: 'fixture', source: 'uncommitted', filePath: 'source.txt', expectedSnapshotId: summary.files[0].snapshotId, includeContents: true };
    const initial: any = await service.hunks(options); equal(initial.ok, true); equal(initial.files[0].newContent, 'one\nfirst\n');
    await writeFile(join(f.dir, 'source.txt'), 'one\nlater\n');
    const stale: any = await service.hunks(options); equal(stale.ok, false); equal(stale.code, 'DIFF_SNAPSHOT_CHANGED');
    await f.git(['add', 'source.txt']);
    const staged: any = await service.summary({ sessionId: 'fixture', source: 'staged' });
    await writeFile(join(f.dir, 'source.txt'), 'one\nunrelated working\n');
    const stillStaged: any = await service.hunks({ ...options, source: 'staged', expectedSnapshotId: staged.files[0].snapshotId });
    equal(stillStaged.ok, true); equal(stillStaged.files[0].newContent, 'one\nlater\n');
    await f.git(['add', 'source.txt']);
    const staleIndex: any = await service.hunks({ ...options, source: 'staged', expectedSnapshotId: staged.files[0].snapshotId });
    equal(staleIndex.ok, false); equal(staleIndex.code, 'DIFF_SNAPSHOT_CHANGED');
    const fresh = await f.reader.summaryWithSnapshots(f.dir, await f.compare('uncommitted'), 'uncommitted');
    await writeFile(join(f.dir, 'extra'), 'extra');
    const extra = await f.reader.summaryWithSnapshots(f.dir, await f.compare('uncommitted'), 'uncommitted');
    ok(fresh.snapshotId); ok(extra.snapshotId); ok(fresh.snapshotId !== extra.snapshotId);
  } finally { await f.process.close(); }
});

h.test('recorded hydration uses provable saved sides and never replaces missing historical context with live text', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'source.txt'), 'unrelated live text\n');
    let record: LastTurnChanges = { turnId: 'saved', files: [{ path: join(f.dir, 'source.txt'), kind: 'modify', added: 1, removed: 1,
      turnDiff: createTwoFilesPatch('before', 'after', 'old\n', 'saved\n') }] };
    const service = serviceFor(f, async () => record);
    const request = { sessionId: 'fixture', source: 'last-turn', turnId: 'saved', repositoryRoot: f.dir, filePath: 'source.txt', includeContents: true };
    const partial: any = await service.hunks(request); equal(partial.ok, true);
    equal(partial.files[0].contentsUnavailable, 'recorded-context-unavailable'); equal(partial.files[0].newContent, undefined);
    ok(partial.files[0].hunks[0].lines.includes('+saved'));
    ok(partial.files[0].patch.includes('--- "a/source.txt"\n+++ "b/source.txt"\n'));
    deepEqual(partial.files[0].hunks, parseGitDiffHunks(record.files[0]!.turnDiff!));
    const summary: any = await service.summary({ sessionId: 'fixture', source: 'last-turn', turnId: 'saved' });
    const previousSnapshot = summary.files[0].snapshotId; ok(previousSnapshot);
    for (const [kind, before, after] of [['create', '', 'saved\nlast'], ['delete', 'deleted\nlast', ''], ['modify', 'old', 'saved']]) {
      record = { turnId: 'saved', files: [{ path: join(f.dir, 'source.txt'), kind: kind!, added: 1, removed: 1,
        turnDiff: createTwoFilesPatch('before', 'after', before!, after!) }] };
      const complete: any = await service.hunks(request); equal(complete.ok, true);
      equal(complete.files[0].oldContent, before); equal(complete.files[0].newContent, after);
      equal(complete.files[0].contentsUnavailable, undefined);
    }
    const stale: any = await service.hunks({ ...request, expectedSnapshotId: previousSnapshot });
    equal(stale.ok, false); equal(stale.code, 'DIFF_SNAPSHOT_CHANGED');
  } finally { await f.process.close(); }
});

h.test('generated metadata uses one literal attribute batch and preserves false, unknown counts and special paths', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, '.gitattributes'), [
      '* generated', 'manual.txt -generated', 'false.txt generated=false',
      'primary-false.txt linguist-generated=false', 'primary-true.txt linguist-generated=true -generated',
      'unknown.generated.txt !generated !linguist-generated', 'unknown-value.txt linguist-generated=automatic',
      'unknown.bin !generated !linguist-generated', '',
    ].join('\n'));
    const special = process.platform === 'win32' ? ['-dash.txt', 'space name.txt']
      : ['-dash.txt', 'space name.txt', '[brackets]*?.txt', 'line\nbreak.txt', 'tab\tname.txt', 'quote"name.txt', 'back\\slash.txt'];
    const names = ['ordinary.txt', 'manual.txt', 'false.txt', 'primary-false.txt', 'primary-true.txt', 'unknown.generated.txt', 'unknown-value.txt', ...special];
    for (const name of names) await writeFile(join(f.dir, name), 'content\n');
    await writeFile(join(f.dir, 'unknown.bin'), Buffer.from([0, 1, 255]));
    const calls: Array<{ args: string[]; stdin: string | Buffer | undefined }> = [], originalRun = f.process.run.bind(f.process);
    f.process.run = (cwd, args, options = {}) => {
      if (args.includes('check-attr')) calls.push({ args: [...args], stdin: options.stdin });
      return originalRun(cwd, args, options);
    };
    const comparison = await f.compare('uncommitted'), summary = await f.reader.summary(f.dir, comparison, 'uncommitted');
    const metadata = new Map(summary.files.map(file => [file.path, file.isGenerated]));
    equal(summary.generatedAttributesUnavailable, undefined); equal(calls.length, 1);
    ok(calls[0]!.args.includes('-z')); ok(calls[0]!.args.includes('--stdin'));
    const paths = String(calls[0]!.stdin).split('\0'); equal(paths.pop(), '');
    deepEqual([...paths].sort(), summary.files.map(file => file.path).sort());
    for (const path of ['ordinary.txt', 'primary-true.txt', ...special]) equal(metadata.get(path), true, path);
    for (const path of ['manual.txt', 'false.txt', 'primary-false.txt']) equal(metadata.get(path), false, path);
    for (const path of ['unknown.generated.txt', 'unknown-value.txt', 'unknown.bin']) equal(metadata.get(path), undefined, path);
    equal(summary.stats.linesAdded, null); equal(summary.stats.linesRemoved, null); equal(summary.stats.filesCount, summary.files.length);
    f.process.run = (cwd, args, options = {}) => args.includes('check-attr')
      ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: fixture attributes failed', truncated: false }) : originalRun(cwd, args, options);
    const failed = await f.reader.summary(f.dir, comparison, 'uncommitted');
    equal(failed.generatedAttributesUnavailable, 'fatal: fixture attributes failed'); deepEqual(failed.stats, summary.stats);
    deepEqual(failed.files, summary.files.map(({ isGenerated: _generated, ...file }) => file));
  } finally { await f.process.close(); }
});

h.test('staged generated metadata reads index attributes and commit comparisons never borrow working attributes', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, '.gitattributes'), '* generated\n'); await writeFile(join(f.dir, 'new.txt'), 'new\n');
    await f.git(['add', '.gitattributes', 'new.txt']); await writeFile(join(f.dir, '.gitattributes'), '* -generated\n');
    const calls: string[][] = [], originalRun = f.process.run.bind(f.process);
    f.process.run = (cwd, args, options = {}) => {
      if (args.includes('check-attr')) calls.push([...args]);
      return originalRun(cwd, args, options);
    };
    const staged = await f.reader.summary(f.dir, await f.compare('staged'), 'staged');
    equal(staged.files.find(file => file.path === 'new.txt')?.isGenerated, true); ok(calls[0]?.includes('--cached'));
    const working = await f.reader.summary(f.dir, await f.compare('uncommitted'), 'uncommitted');
    equal(working.files.find(file => file.path === 'new.txt')?.isGenerated, false); ok(!calls.at(-1)?.includes('--cached'));
    calls.length = 0;
    const commit = await f.reader.summary(f.dir, await f.compare('commit', undefined, f.base), 'commit');
    equal(commit.files.find(file => file.path === 'source.txt')?.isGenerated, undefined); equal(calls.length, 0);
  } finally { await f.process.close(); }
});

h.test('attribute command failures remain visible without discarding a coherent comparison snapshot', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.dir, 'source.txt'), 'changed\n');
    const originalRun = f.process.run.bind(f.process); let failures = 0;
    f.process.run = (cwd, args, options = {}) => args.includes('check-attr')
      ? Promise.resolve({ code: 128, stdout: '', stderr: `fatal: fixture attribute failure ${++failures}`, truncated: false }) : originalRun(cwd, args, options);
    const summary = await f.reader.summaryWithSnapshots(f.dir, await f.compare('uncommitted'), 'uncommitted');
    equal(summary.generatedAttributesUnavailable, 'fatal: fixture attribute failure 2');
    equal(summary.files.length, 1); equal(summary.files[0]?.path, 'source.txt'); ok(summary.snapshotId); ok(summary.files[0]?.snapshotId);
    f.process.run = (cwd, args, options = {}) => args.includes('check-attr')
      ? Promise.resolve({ code: -1, stdout: '', stderr: 'git output exceeded its size limit', truncated: true }) : originalRun(cwd, args, options);
    const bounded = await f.reader.summary(f.dir, await f.compare('uncommitted'), 'uncommitted');
    equal(bounded.generatedAttributesUnavailable, 'git output exceeded its size limit'); equal(bounded.files.length, 1);
  } finally { await f.process.close(); }
});

h.test('recorded copy transport binds placeholder, absolute and hunk-only patches to exact special filenames', async () => {
  const f = await fixture();
  try {
    let record: LastTurnChanges = { turnId: 'saved', files: [] };
    const service = serviceFor(f, async () => record), before = 'one\ntwo\n', after = 'one\nrecorded without final newline';
    const basePatch = createTwoFilesPatch('before', 'after', before, after);
    const cases = [
      ['source.txt', basePatch],
      ['source.txt', createTwoFilesPatch(join(f.dir, 'source.txt'), join(f.dir, 'source.txt'), before, after)],
      ['source.txt', createTwoFilesPatch('legacy-file', 'legacy-file', before, after)],
      ['source.txt', basePatch.slice(basePatch.indexOf('@@ '))],
    ];
    const special = process.platform === 'win32' ? ['-option.txt', 'space name.txt'] : ['-option.txt', 'space "quote".txt', 'back\\slash.txt', 'line\nbreak-\u0001-\u00e9.txt'];
    for (const path of special) { await writeFile(join(f.dir, path), before); cases.push([path, basePatch]); }
    for (const [path, raw] of cases) {
      record = { turnId: 'saved', files: [{ path: join(f.dir, path!), kind: 'modify', added: 1, removed: 1, turnDiff: raw! }] };
      const result: any = await service.hunks({ sessionId: 'fixture', source: 'last-turn', turnId: 'saved', repositoryRoot: f.dir, filePath: path!, includeContents: true });
      equal(result.ok, true); const detail = result.files[0]; ok(detail.patch, detail.patchCopyUnavailable);
      equal(detail.patchCopyUnavailable, undefined); deepEqual(detail.hunks, parseGitDiffHunks(raw!));
      equal(detail.patch.slice(detail.patch.indexOf('@@ ')), raw!.slice(raw!.indexOf('@@ ')));
      const checked = await f.process.run(f.dir, ['apply', '--check', '-'], { stdin: detail.patch });
      equal(checked.code, 0, `${path}: ${checked.stderr}\n${detail.patch}`);
    }
  } finally { await f.process.close(); }
});

h.test('recorded copy transport retains existence, executable mode, object IDs and binary payload metadata', async () => {
  const f = await fixture();
  try {
    let record: LastTurnChanges = { turnId: 'saved', files: [] };
    const service = serviceFor(f, async () => record);
    await writeFile(join(f.dir, 'delete.txt'), 'deleted\n'); await writeFile(join(f.dir, 'empty-deleted.txt'), '');
    await writeFile(join(f.dir, 'mode.txt'), 'same\n'); await writeFile(join(f.dir, 'mode-content.txt'), 'before\n');
    const cases = [
      { path: 'added.txt', kind: 'create', raw: 'new file mode 100755\n' + createTwoFilesPatch('before', 'after', '', 'added\n'), marker: 'new file mode 100755\n' },
      { path: 'delete.txt', kind: 'delete', raw: 'deleted file mode 100644\n' + createTwoFilesPatch('before', 'after', 'deleted\n', ''), marker: 'deleted file mode 100644\n' },
      { path: 'empty-added.txt', kind: 'create', raw: 'new file mode 100644\n--- before\n+++ after\n', marker: 'new file mode 100644\n' },
      { path: 'empty-deleted.txt', kind: 'delete', raw: 'deleted file mode 100644\n--- before\n+++ after\n', marker: 'deleted file mode 100644\n' },
    ];
    if (process.platform !== 'win32') {
      cases.push({ path: 'mode.txt', kind: 'modify', raw: 'diff --git a/mode.txt b/mode.txt\nold mode 100644\nnew mode 100755\n', marker: 'old mode 100644\nnew mode 100755\n' });
      cases.push({ path: 'mode-content.txt', kind: 'modify', raw: 'old mode 100644\nnew mode 100755\n' + createTwoFilesPatch('before', 'after', 'before\n', 'after\n'), marker: 'old mode 100644\nnew mode 100755\n' });
      cases.push({ path: 'added-link', kind: 'create', raw: 'new file mode 120000\n' + createTwoFilesPatch('before', 'after', '', '/does-not-exist'), marker: 'new file mode 120000\n' });
    }
    const oldOid = await f.git(['rev-parse', 'HEAD:source.txt']);
    const newOid = (await f.process.run(f.dir, ['hash-object', '--stdin'], { stdin: 'next\n' })).stdout.trim();
    const index = `index ${oldOid}..${newOid} 100644\n`;
    cases.push({ path: 'source.txt', kind: 'modify', raw: index + createTwoFilesPatch('before', 'after', 'one\ntwo\n', 'next\n'), marker: index });
    await writeFile(join(f.dir, 'source.txt'), Buffer.from([0, 1, 255, 128]));
    const binary = await f.reader.hunks(f.dir, await f.compare('uncommitted'), 'uncommitted', 'source.txt'); ok(binary.patch);
    await writeFile(join(f.dir, 'source.txt'), 'one\ntwo\n');
    cases.push({ path: 'source.txt', kind: 'modify', raw: binary.patch, marker: 'GIT binary patch\n' });
    for (const item of cases) {
      record = { turnId: 'saved', files: [{ path: join(f.dir, item.path), kind: item.kind, added: null, removed: null, turnDiff: item.raw }] };
      const result: any = await service.hunks({ sessionId: 'fixture', source: 'last-turn', turnId: 'saved', repositoryRoot: f.dir, filePath: item.path, includeContents: true });
      equal(result.ok, true); const detail = result.files[0]; ok(detail.patch, detail.patchCopyUnavailable); ok(detail.patch.includes(item.marker));
      deepEqual(detail.hunks, parseGitDiffHunks(item.raw));
      const checked = await f.process.run(f.dir, ['apply', '--check', '-'], { stdin: detail.patch });
      equal(checked.code, 0, `${item.path}: ${checked.stderr}\n${detail.patch}`);
      if (item.marker === 'GIT binary patch\n') { equal(detail.contentsUnavailable, 'binary'); equal(detail.newDataUrl, undefined); }
    }
  } finally { await f.process.close(); }
});

h.test('unprovable recorded copy metadata is unavailable without replacing recorded hunks or live content', async () => {
  const f = await fixture();
  try {
    let record: LastTurnChanges = { turnId: 'saved', files: [] };
    const service = serviceFor(f, async () => record), raw = createTwoFilesPatch('before', 'after', 'one\ntwo\n', 'saved\n');
    const cases = [
      raw + createTwoFilesPatch('other', 'other', 'other\n', 'changed\n'),
      'diff --git a/old.txt b/source.txt\nsimilarity index 100%\nrename from old.txt\nrename to source.txt\n',
      createTwoFilesPatch('old/path.txt', 'new/path.txt', 'one\ntwo\n', 'saved\n'),
      'Binary files before and after differ\n',
      'Index: ' + 'x'.repeat(64 * 1024) + '\n' + raw,
      'new file mode 100644\n' + raw,
    ];
    for (const patch of cases) {
      record = { turnId: 'saved', files: [{ path: join(f.dir, 'source.txt'), kind: 'modify', added: 1, removed: 2, turnDiff: patch }] };
      const result: any = await service.hunks({ sessionId: 'fixture', source: 'last-turn', turnId: 'saved', repositoryRoot: f.dir, filePath: 'source.txt', includeContents: true });
      equal(result.ok, true); const detail = result.files[0]; equal(detail.patch, undefined); ok(detail.patchCopyUnavailable);
      equal(detail.patchUnavailable, undefined); deepEqual(detail.hunks, parseGitDiffHunks(patch));
      ok(detail.newContent === undefined || detail.newContent !== 'one\ntwo\n');
    }
  } finally { await f.process.close(); }
});

h.test('bounded verified media snapshots remain readable when binary patch encoding exceeds the patch limit', async () => {
  const f = await fixture();
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfcAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(f.dir, 'image.png'), png); await f.git(['add', 'image.png']); await f.git(['commit', '-m', 'image']);
    const noise = Buffer.alloc(900 * 1024); let seed = 0x12345678;
    for (let index = 0; index < noise.length; index++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; noise[index] = seed >>> 24; }
    const next = Buffer.concat([png, noise]); ok(next.length < 1024 * 1024); await writeFile(join(f.dir, 'image.png'), next);
    const result: any = await serviceFor(f).hunks({ sessionId: 'fixture', source: 'uncommitted', filePath: 'image.png', includeContents: true });
    equal(result.ok, true); equal(result.detailsTruncated, true);
    equal(result.files[0].contentsUnavailable, 'too-large'); equal(result.files[0].patch, undefined);
    equal(result.files[0].oldDataUrl, `data:image/png;base64,${png.toString('base64')}`);
    equal(result.files[0].newDataUrl, `data:image/png;base64,${next.toString('base64')}`);
  } finally { await f.process.close(); }
});

h.test('complete recorded SVG sides use recorded media bytes while incomplete and binary history never borrow live previews', async () => {
  const f = await fixture();
  try {
    let record: LastTurnChanges = { turnId: 'saved', files: [] };
    const service = serviceFor(f, async () => record);
    const before = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
    const after = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1"/></svg>';
    await writeFile(join(f.dir, 'saved.svg'), '<svg><text>unrelated live</text></svg>');
    const request = { sessionId: 'fixture', source: 'last-turn', turnId: 'saved', repositoryRoot: f.dir, filePath: 'saved.svg', includeContents: true };
    for (const [kind, oldContent, newContent] of [['create', '', after + '\n'], ['modify', before, after], ['delete', before + '\n', '']]) {
      record = { turnId: 'saved', files: [{ path: join(f.dir, 'saved.svg'), kind: kind!, added: 1, removed: 1,
        turnDiff: createTwoFilesPatch('before', 'after', oldContent!, newContent!) }] };
      const result: any = await service.hunks(request); equal(result.ok, true); const detail = result.files[0];
      equal(detail.oldContent, oldContent); equal(detail.newContent, newContent);
      equal(detail.oldDataUrl, oldContent ? `data:image/svg+xml;base64,${Buffer.from(oldContent).toString('base64')}` : undefined);
      equal(detail.newDataUrl, newContent ? `data:image/svg+xml;base64,${Buffer.from(newContent).toString('base64')}` : undefined);
    }
    record = { turnId: 'saved', files: [{ path: join(f.dir, 'saved.svg'), kind: 'modify', added: 1, removed: 1,
      turnDiff: createTwoFilesPatch('before', 'after', before + '\n', after + '\n') }] };
    const partial: any = await service.hunks(request);
    equal(partial.files[0].contentsUnavailable, 'recorded-context-unavailable'); equal(partial.files[0].oldDataUrl, undefined); equal(partial.files[0].newDataUrl, undefined);
    for (const path of ['saved.png', 'saved.pdf']) {
      await writeFile(join(f.dir, path), path.endsWith('.pdf') ? '%PDF-1.4\n%%EOF\n' : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      record = { turnId: 'saved', files: [{ path: join(f.dir, path), kind: 'modify', added: null, removed: null, turnDiff: 'Binary files before and after differ\n' }] };
      const binary: any = await service.hunks({ ...request, filePath: path });
      equal(binary.files[0].contentsUnavailable, 'binary'); equal(binary.files[0].oldDataUrl, undefined); equal(binary.files[0].newDataUrl, undefined);
    }
  } finally { await f.process.close(); }
});

h.test('reader patch paths and three-line hunk boundaries ignore repository diff presentation settings', async () => {
  const f = await fixture();
  try {
    const before = Array.from({ length: 80 }, (_, index) => `line ${index}\n`).join('');
    await writeFile(join(f.dir, 'source.txt'), before); await f.git(['add', 'source.txt']); await f.git(['commit', '-m', 'context']);
    for (const [key, value] of [['diff.noprefix', 'true'], ['diff.mnemonicprefix', 'true'], ['diff.srcPrefix', 'wrong-old/'],
      ['diff.dstPrefix', 'wrong-new/'], ['diff.context', '40'], ['diff.interHunkContext', '100'], ['diff.algorithm', 'histogram']]) {
      await f.git(['config', key!, value!]);
    }
    await writeFile(join(f.dir, 'source.txt'), before.replace('line 10\n', 'first\n').replace('line 65\n', 'second\n'));
    const comparison = await f.compare('uncommitted'), summary = await f.reader.summary(f.dir, comparison, 'uncommitted');
    deepEqual(summary.stats, { filesCount: 1, linesAdded: 2, linesRemoved: 2 });
    const detail = await f.reader.hunks(f.dir, comparison, 'uncommitted', 'source.txt');
    ok(detail.patch?.startsWith('diff --git a/source.txt b/source.txt\n'));
    ok(detail.patch?.includes('--- a/source.txt\n+++ b/source.txt\n')); equal(detail.hunks.length, 2);
    deepEqual(detail.hunks.map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]), [[8, 7, 8, 7], [63, 7, 63, 7]]);
  } finally { await f.process.close(); }
});

void (async () => {
  try { process.exitCode = await h.finish(join(__dirname, 'git-diff-result.json'), 'git-diff'); }
  finally { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); process.stdout.write('git-diff-fixture-cleanup: removed\n'); }
})();
