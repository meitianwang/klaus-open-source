import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitDiffReader, type GitDiffSource } from '../main/services/git-diff';
import { GitProcess } from '../main/services/git-process';
import { applyGitReviewAction, type GitReviewAction, type GitReviewReader } from '../main/services/git-review-actions';
import { Harness } from './harness';

const h = new Harness();
process.exitCode = 1;
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'klaus-review-actions-'));
  const root = join(temporary, 'repository'); await mkdir(root);
  const process = new GitProcess({ env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: temporary } });
  const git = async (...args: string[]) => {
    const result = await process.run(root, args); equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  const original = Array.from({ length: 60 }, (_, index) => `line ${index + 1}\n`).join('');
  await writeFile(join(root, 'source.txt'), original); await git('add', '-A'); await git('commit', '-m', 'baseline');
  const reader: GitReviewReader = new GitDiffReader(process);
  const comparisons = new GitDiffReader(process);
  const select = async (source: GitDiffSource, filePath?: string, previousPath?: string) => {
    const comparison = await comparisons.comparison(root, source, source === 'branch' ? 'main' : undefined);
    if (comparison.type !== 'success') throw new Error('Fixture comparison unavailable.');
    const summary = await reader.summaryWithSnapshots(root, comparison, source);
    const snapshot = filePath ? summary.files.find(file => file.path === filePath && file.previousPath === previousPath)?.snapshotId : summary.snapshotId;
    ok(snapshot, 'Fixture must have a complete snapshot.');
    return { context: { root, source, comparison, process, reader }, expectedSnapshotId: snapshot };
  };
  const apply = async (source: GitDiffSource, action: GitReviewAction, filePath?: string, hunkIndex?: number, previousPath?: string) => {
    const selected = await select(source, filePath, previousPath);
    return applyGitReviewAction(selected.context, { action, expectedSnapshotId: selected.expectedSnapshotId, filePath, previousPath, hunkIndex });
  };
  const close = async () => { await process.close(); await rm(temporary, { recursive: true, force: true }); };
  const injectBeforeApply = (callback: () => Promise<void>) => {
    const run = process.run.bind(process); let injected = false;
    process.run = async (cwd, args, options) => {
      if (!injected && args[0] === 'apply' && !args.includes('--check')) { injected = true; await callback(); }
      return run(cwd, args, options);
    };
    return () => injected;
  };
  return { root, process, git, original, select, apply, close, injectBeforeApply };
}

h.test('file stage and unstage preserve other paths and all actions use only displayed files', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'replacement\n'); await writeFile(join(f.root, 'other.txt'), 'other\n');
    await f.apply('uncommitted', 'stage', 'source.txt');
    equal(await f.git('diff', '--cached', '--name-only'), 'source.txt');
    equal(await f.git('show', ':source.txt'), 'replacement');
    await f.apply('staged', 'unstage', 'source.txt');
    equal(await f.git('diff', '--cached', '--name-only'), '');
    await f.apply('unstaged', 'stage');
    deepEqual((await f.git('diff', '--cached', '--name-only')).split('\n').sort(), ['other.txt', 'source.txt']);
    await f.apply('staged', 'unstage');
    equal(await f.git('diff', '--cached', '--name-only'), '');
    equal(await readFile(join(f.root, 'other.txt'), 'utf8'), 'other\n');
  } finally { await f.close(); }
});

h.test('hunk stage, unstage and revert affect one separated edit', async () => {
  const f = await fixture();
  try {
    const changed = f.original.replace('line 5\n', 'first edit\n').replace('line 45\n', 'second edit\n');
    await writeFile(join(f.root, 'source.txt'), changed);
    await f.apply('unstaged', 'stage', 'source.txt', 0);
    const staged = await f.git('show', ':source.txt'); ok(staged.includes('first edit')); ok(!staged.includes('second edit'));
    await f.apply('staged', 'unstage', 'source.txt', 0);
    equal(await f.git('diff', '--cached', '--name-only'), '');
    await f.apply('unstaged', 'revert', 'source.txt', 1);
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), f.original.replace('line 5\n', 'first edit\n'));
  } finally { await f.close(); }
});

h.test('stale file and aggregate selections fail before touching the index or working files', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'shown\n');
    const file = await f.select('uncommitted', 'source.txt'); const all = await f.select('uncommitted');
    await writeFile(join(f.root, 'source.txt'), 'newer\n');
    await rejects(applyGitReviewAction(file.context, { action: 'revert', filePath: 'source.txt', expectedSnapshotId: file.expectedSnapshotId }), { code: 'DIFF_SNAPSHOT_CHANGED' });
    await rejects(applyGitReviewAction(all.context, { action: 'stage', expectedSnapshotId: all.expectedSnapshotId }), { code: 'DIFF_SNAPSHOT_CHANGED' });
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'newer\n'); equal(await f.git('diff', '--cached', '--name-only'), '');
    const refreshed = await f.select('uncommitted'); await writeFile(join(f.root, 'later.txt'), 'unseen\n');
    await rejects(applyGitReviewAction(refreshed.context, { action: 'stage', expectedSnapshotId: refreshed.expectedSnapshotId }), { code: 'DIFF_SNAPSHOT_CHANGED' });
    equal(await f.git('diff', '--cached', '--name-only'), '');
  } finally { await f.close(); }
});

h.test('binary and empty untracked files stage and revert without reading binary bytes as text', async () => {
  const f = await fixture();
  try {
    const binary = Buffer.from([0, 1, 255, 7, 0, 128]);
    await writeFile(join(f.root, 'binary.bin'), binary); await writeFile(join(f.root, 'empty.txt'), '');
    await f.apply('unstaged', 'stage');
    equal(await f.git('diff', '--cached', '--name-only'), 'binary.bin\nempty.txt');
    await f.apply('staged', 'unstage');
    await f.apply('unstaged', 'revert', 'binary.bin'); await f.apply('unstaged', 'revert', 'empty.txt');
    await rejects(readFile(join(f.root, 'binary.bin')), { code: 'ENOENT' }); await rejects(readFile(join(f.root, 'empty.txt')), { code: 'ENOENT' });
  } finally { await f.close(); }
});

h.test('reverting a recreated untracked file preserves the separate staged deletion', async () => {
  const f = await fixture();
  try {
    await f.git('rm', '--cached', '--', 'source.txt'); await writeFile(join(f.root, 'source.txt'), 'recreated\n');
    await f.apply('staged', 'unstage', 'source.txt', 0);
    equal(await f.git('diff', '--cached', '--name-only'), '');
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'recreated\n');
    await f.git('rm', '--cached', '--', 'source.txt');
    await f.apply('uncommitted', 'revert', 'source.txt');
    await rejects(readFile(join(f.root, 'source.txt')), { code: 'ENOENT' });
    equal(await f.git('diff', '--cached', '--name-status'), 'D\tsource.txt');
  } finally { await f.close(); }
});

h.test('revert preserves other files and refuses staged content with undisplayed working edits', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'source.txt'), 'staged\n'); await f.git('add', '--', 'source.txt');
    await writeFile(join(f.root, 'source.txt'), 'unstaged\n');
    await rejects(f.apply('staged', 'revert', 'source.txt'), { code: 'REVIEW_ACTION_CONFLICT' });
    equal(await f.git('show', ':source.txt'), 'staged'); equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'unstaged\n');
    await writeFile(join(f.root, 'source.txt'), 'staged\n');
    await f.apply('staged', 'revert', 'source.txt'); equal(await f.git('diff', '--cached', '--name-only'), '');
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), f.original);
    await writeFile(join(f.root, 'source.txt'), 'changed\n'); await writeFile(join(f.root, 'other.txt'), 'keep\n');
    await f.apply('uncommitted', 'revert', 'source.txt');
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), f.original); equal(await readFile(join(f.root, 'other.txt'), 'utf8'), 'keep\n');
  } finally { await f.close(); }
});

h.test('rename file actions retain both relation paths and literal filenames cannot select siblings', async () => {
  const f = await fixture();
  try {
    await rename(join(f.root, 'source.txt'), join(f.root, 'renamed.txt'));
    await f.apply('uncommitted', 'stage', 'renamed.txt', undefined, 'source.txt');
    equal(await f.git('diff', '--cached', '--name-status'), 'R100\tsource.txt\trenamed.txt');
    await f.apply('staged', 'unstage', 'renamed.txt', undefined, 'source.txt');
    await f.apply('uncommitted', 'revert', 'renamed.txt', undefined, 'source.txt');
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), f.original); await rejects(readFile(join(f.root, 'renamed.txt')), { code: 'ENOENT' });
    await writeFile(join(f.root, '[wild].txt'), 'literal\n'); await writeFile(join(f.root, 'w.txt'), 'sibling\n');
    await f.apply('unstaged', 'stage', '[wild].txt'); equal(await f.git('diff', '--cached', '--name-only'), '[wild].txt');
    const selection = await f.select('unstaged', 'w.txt');
    await rejects(applyGitReviewAction(selection.context, { action: 'revert', expectedSnapshotId: selection.expectedSnapshotId, filePath: '../outside.txt' }), /invalid file path|outside git repository/);
  } finally { await f.close(); }
});

h.test('committed action vectors reject historical scopes, incomplete snapshots and inapplicable actions', async () => {
  const f = await fixture();
  try {
    const vectors = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/git-review-actions.json'), 'utf8'));
    await writeFile(join(f.root, 'source.txt'), 'changed\n');
    const selected = await f.select('uncommitted', 'source.txt');
    for (const vector of vectors.rejectedScopes) {
      await rejects(applyGitReviewAction({ ...selected.context, source: vector.source }, {
        action: vector.action, filePath: vector.filePath, expectedSnapshotId: selected.expectedSnapshotId,
      }), { code: 'REVIEW_ACTION_UNAVAILABLE' });
    }
    const incomplete = { filePath: (root: string, path: string) => selected.context.reader.filePath(root, path), summaryWithSnapshots: async () => ({
      ...(await selected.context.reader.summaryWithSnapshots(f.root, selected.context.comparison, 'uncommitted')), snapshotId: undefined,
    }) };
    await rejects(applyGitReviewAction({ ...selected.context, reader: incomplete }, {
      action: 'stage', expectedSnapshotId: selected.expectedSnapshotId,
    }), { code: vectors.missingSnapshotCode });
    equal(await f.git('diff', '--cached', '--name-only'), ''); equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'changed\n');
  } finally { await f.close(); }
});

h.test('a recorded rename hunk reverses its relation while preserving the other edit', async () => {
  const f = await fixture();
  try {
    await rename(join(f.root, 'source.txt'), join(f.root, 'renamed.txt'));
    const changed = f.original.replace('line 5\n', 'first edit\n').replace('line 45\n', 'second edit\n');
    await writeFile(join(f.root, 'renamed.txt'), changed); await f.git('add', '-A');
    await f.apply('staged', 'revert', 'renamed.txt', 0, 'source.txt');
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), f.original.replace('line 45\n', 'second edit\n'));
    await rejects(readFile(join(f.root, 'renamed.txt')), { code: 'ENOENT' });
    equal(await f.git('diff', '--cached', '--name-status'), 'M\tsource.txt');
  } finally { await f.close(); }
});

h.test('fixed patch paths and hunk boundaries ignore repository diff prefix and context settings', async () => {
  for (const noPrefix of ['true', 'false']) {
    const f = await fixture();
    try {
      await mkdir(join(f.root, 'src')); await writeFile(join(f.root, 'src/file.txt'), f.original); await writeFile(join(f.root, 'file.txt'), f.original);
      await f.git('add', '-A'); await f.git('commit', '-m', 'nested files');
      for (const [key, value] of Object.entries({ 'diff.noprefix': noPrefix, 'diff.mnemonicPrefix': 'true',
        'diff.srcPrefix': 'custom/source/', 'diff.dstPrefix': 'custom/target/', 'diff.relative': 'true',
        'diff.context': '40', 'diff.interHunkContext': '40', 'diff.algorithm': 'histogram', 'diff.indentHeuristic': 'true' })) await f.git('config', key, value);
      const changed = f.original.replace('line 5\n', 'first edit\n').replace('line 45\n', 'second edit\n');
      await writeFile(join(f.root, 'src/file.txt'), changed); await writeFile(join(f.root, 'file.txt'), changed);
      await f.apply('unstaged', 'stage', 'src/file.txt', 1);
      equal(await f.git('show', ':src/file.txt'), f.original.replace('line 45\n', 'second edit\n').trim());
      equal(await f.git('show', ':file.txt'), f.original.trim());
      await f.apply('unstaged', 'revert', 'src/file.txt', 0);
      equal(await readFile(join(f.root, 'src/file.txt'), 'utf8'), f.original.replace('line 45\n', 'second edit\n'));
      equal(await readFile(join(f.root, 'file.txt'), 'utf8'), changed);
      await writeFile(join(f.root, 'src/file.txt'), changed); await f.apply('uncommitted', 'stage', 'src/file.txt');
      equal(await f.git('show', ':src/file.txt'), changed.trim()); equal(await f.git('show', ':file.txt'), f.original.trim());
      await f.apply('uncommitted', 'revert', 'src/file.txt');
      equal(await readFile(join(f.root, 'src/file.txt'), 'utf8'), f.original); equal(await readFile(join(f.root, 'file.txt'), 'utf8'), changed);
    } finally { await f.close(); }
  }
});

h.test('whole-file and aggregate staging apply captured bytes and preserve later working edits', async () => {
  const f = await fixture();
  try {
    const shown = f.original.replace('line 5\n', 'shown edit\n'), newer = f.original.replace('line 5\n', 'newer edit\n');
    await writeFile(join(f.root, 'source.txt'), shown);
    let injected = f.injectBeforeApply(() => writeFile(join(f.root, 'source.txt'), newer));
    await f.apply('uncommitted', 'stage', 'source.txt'); ok(injected());
    equal(await f.git('show', ':source.txt'), shown.trim()); equal(await readFile(join(f.root, 'source.txt'), 'utf8'), newer);
    await f.apply('staged', 'unstage');
    await writeFile(join(f.root, 'source.txt'), shown); await writeFile(join(f.root, 'new.txt'), 'shown new file\n');
    injected = f.injectBeforeApply(async () => { await writeFile(join(f.root, 'source.txt'), newer); await writeFile(join(f.root, 'new.txt'), 'newer new file\n'); });
    await f.apply('uncommitted', 'stage'); ok(injected());
    equal(await f.git('show', ':source.txt'), shown.trim()); equal(await f.git('show', ':new.txt'), 'shown new file');
    equal(await readFile(join(f.root, 'source.txt'), 'utf8'), newer); equal(await readFile(join(f.root, 'new.txt'), 'utf8'), 'newer new file\n');
  } finally { await f.close(); }
});

h.test('unstaging a captured aggregate refuses a concurrent index edit atomically', async () => {
  const f = await fixture();
  try {
    const shown = f.original.replace('line 5\n', 'shown edit\n'), newer = f.original.replace('line 5\n', 'newer staged edit\n');
    await writeFile(join(f.root, 'source.txt'), shown); await writeFile(join(f.root, 'binary.bin'), Buffer.from([0, 1, 255]));
    await f.git('add', '-A');
    const injected = f.injectBeforeApply(async () => { await writeFile(join(f.root, 'source.txt'), newer); await f.git('add', '--', 'source.txt'); });
    await rejects(f.apply('staged', 'unstage'), { code: 'REVIEW_ACTION_CONFLICT' }); ok(injected());
    equal(await f.git('show', ':source.txt'), newer.trim()); equal(await readFile(join(f.root, 'source.txt'), 'utf8'), newer);
    deepEqual((await f.git('diff', '--cached', '--name-only')).split('\n').sort(), ['binary.bin', 'source.txt']);
  } finally { await f.close(); }
});

if (process.platform !== 'win32') h.test('captured whole-file patches preserve symlink modes and never read or modify their targets', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, '../outside.txt'); await writeFile(outside, 'private bytes\n');
    await symlink(outside, join(f.root, 'link.txt')); await f.apply('unstaged', 'stage', 'link.txt');
    ok((await f.git('ls-files', '--stage', '--', 'link.txt')).startsWith('120000 ')); equal(await f.git('show', ':link.txt'), outside);
    await f.apply('staged', 'unstage', 'link.txt'); equal(await readlink(join(f.root, 'link.txt')), outside);
    await f.apply('unstaged', 'revert', 'link.txt'); await rejects(readlink(join(f.root, 'link.txt')), { code: 'ENOENT' });
    equal(await readFile(outside, 'utf8'), 'private bytes\n');
  } finally { await f.close(); }
});


async function embeddedFixture(f: Awaited<ReturnType<typeof fixture>>, name = 'embedded') {
  const root = join(f.root, name); await mkdir(root);
  const git = async (...args: string[]) => {
    const result = await f.process.run(root, args); equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  const commits: string[] = [];
  for (const content of ['first\n', 'second\n', 'third\n']) {
    await writeFile(join(root, 'nested.txt'), content); await git('add', 'nested.txt'); await git('commit', '-m', content.trim());
    commits.push(await git('rev-parse', 'HEAD'));
  }
  const [original, shown, later] = commits as [string, string, string];
  await git('reset', '--hard', shown);
  await writeFile(join(root, 'nested.txt'), 'local tracked bytes\n'); await writeFile(join(root, 'untracked.txt'), 'local untracked bytes\n');
  const state = async () => ({ head: await git('rev-parse', 'HEAD'), tracked: await readFile(join(root, 'nested.txt'), 'utf8'),
    untracked: await readFile(join(root, 'untracked.txt'), 'utf8') });
  const track = async () => { await f.git('update-index', '--add', '--cacheinfo', `160000,${original},${name}`); await f.git('commit', '-m', 'embedded baseline'); };
  const index = () => f.git('ls-files', '--stage', '-z', '--', name);
  return { root, name, git, original, shown, later, state, track, index };
}

h.test('tracked gitlink staging and unstaging preserve dirty nested contents and unrelated parent files', async () => {
  const f = await fixture();
  try {
    const nested = await embeddedFixture(f); await nested.track(); const initial = await nested.state();
    await f.git('config', 'diff.submodule', 'log');
    await writeFile(join(f.root, 'source.txt'), 'unrelated parent bytes\n');
    await f.apply('uncommitted', 'stage', nested.name);
    ok((await nested.index()).startsWith(`160000 ${nested.shown} 0\t`)); deepEqual(await nested.state(), initial);
    equal(await f.git('show', ':source.txt'), f.original.trim()); equal(await readFile(join(f.root, 'source.txt'), 'utf8'), 'unrelated parent bytes\n');
    await f.apply('staged', 'unstage', nested.name);
    ok((await nested.index()).startsWith(`160000 ${nested.original} 0\t`)); deepEqual(await nested.state(), initial);
    await rejects(f.apply('uncommitted', 'revert', nested.name), { code: 'REVIEW_ACTION_UNAVAILABLE', message: /inside the embedded repository/ });
    deepEqual(await nested.state(), initial); ok((await nested.index()).startsWith(`160000 ${nested.original} 0\t`));
  } finally { await f.close(); }
});

h.test('untracked embedded pointers export applicable quoted patches and stage without nested file traversal', async () => {
  const f = await fixture();
  try {
    const nested = await embeddedFixture(f, 'embedded "雪\t\\\nrepo'); const initial = await nested.state();
    const selected = await f.select('unstaged', nested.name);
    const reader = new GitDiffReader(f.process);
    const detail = await reader.hunks(f.root, selected.context.comparison, 'unstaged', nested.name);
    ok(detail.patch?.includes('new file mode 160000')); ok(detail.patch?.includes(`+Subproject commit ${nested.shown}\n`));
    ok(detail.patch?.includes('\\351\\233\\252')); ok(!detail.patch?.includes('-dirty'));
    const check = await f.process.run(f.root, ['apply', '--cached', '--check'], { stdin: detail.patch }); equal(check.code, 0, check.stderr);
    await writeFile(join(f.root, 'other.txt'), 'unrelated untracked parent\n');
    await f.apply('unstaged', 'stage', nested.name);
    ok((await nested.index()).startsWith(`160000 ${nested.shown} 0\t`)); deepEqual(await nested.state(), initial);
    equal(await f.git('ls-files', '--', 'other.txt'), '');
    await f.apply('staged', 'unstage', nested.name); equal(await nested.index(), ''); deepEqual(await nested.state(), initial);
    const copied = await f.process.run(f.root, ['apply', '--cached'], { stdin: detail.patch }); equal(copied.code, 0, copied.stderr);
    ok((await nested.index()).startsWith(`160000 ${nested.shown} 0\t`)); deepEqual(await nested.state(), initial);
    await f.apply('staged', 'unstage', nested.name);
    await rejects(f.apply('unstaged', 'revert', nested.name), { code: 'REVIEW_ACTION_UNAVAILABLE' }); deepEqual(await nested.state(), initial);
  } finally { await f.close(); }
});

h.test('gitlink snapshots reject stale pointers before requests and during patch capture', async () => {
  const f = await fixture();
  try {
    const nested = await embeddedFixture(f); await nested.track();
    const selected = await f.select('uncommitted', nested.name);
    await nested.git('update-ref', 'HEAD', nested.later);
    await rejects(applyGitReviewAction(selected.context, { action: 'stage', filePath: nested.name, expectedSnapshotId: selected.expectedSnapshotId }), { code: 'DIFF_SNAPSHOT_CHANGED' });
    ok((await nested.index()).startsWith(`160000 ${nested.original} 0\t`));
    const refreshed = await f.select('uncommitted', nested.name);
    const run = f.process.run.bind(f.process); let injected = false;
    f.process.run = async (cwd, args, options) => {
      const result = await run(cwd, args, options);
      if (!injected && args.includes('diff') && args.includes('--full-index')) { injected = true; await nested.git('update-ref', 'HEAD', nested.shown); }
      return result;
    };
    await rejects(applyGitReviewAction(refreshed.context, { action: 'stage', filePath: nested.name, expectedSnapshotId: refreshed.expectedSnapshotId }), { code: 'DIFF_SNAPSHOT_CHANGED' });
    ok(injected); ok((await nested.index()).startsWith(`160000 ${nested.original} 0\t`));
    equal(await readFile(join(nested.root, 'nested.txt'), 'utf8'), 'local tracked bytes\n');
    equal(await readFile(join(nested.root, 'untracked.txt'), 'utf8'), 'local untracked bytes\n');
  } finally { await f.close(); }
});

h.test('late nested pointer changes preserve the captured staged pointer and current nested working contents', async () => {
  const f = await fixture();
  try {
    const nested = await embeddedFixture(f); await nested.track();
    const initial = await nested.state();
    const injected = f.injectBeforeApply(() => nested.git('update-ref', 'HEAD', nested.later).then(() => undefined));
    await f.apply('uncommitted', 'stage', nested.name); ok(injected());
    ok((await nested.index()).startsWith(`160000 ${nested.shown} 0\t`));
    deepEqual(await nested.state(), { ...initial, head: nested.later });
  } finally { await f.close(); }
});

h.test('unstaging a captured gitlink refuses a concurrent parent index pointer change', async () => {
  const f = await fixture();
  try {
    const nested = await embeddedFixture(f); await nested.track();
    await f.git('update-index', '--cacheinfo', `160000,${nested.shown},${nested.name}`);
    const initial = await nested.state();
    const injected = f.injectBeforeApply(() => f.git('update-index', '--cacheinfo', `160000,${nested.later},${nested.name}`).then(() => undefined));
    await rejects(f.apply('staged', 'unstage', nested.name), { code: 'REVIEW_ACTION_CONFLICT' }); ok(injected());
    ok((await nested.index()).startsWith(`160000 ${nested.later} 0\t`)); deepEqual(await nested.state(), initial);
  } finally { await f.close(); }
});

void h.finish(join(__dirname, 'git-review-actions-result.json'), 'git-review-actions').then(code => { process.exitCode = code; });
