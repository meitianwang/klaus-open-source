import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitProcess, gitError, type GitResult } from './git-process';
import { gitlinkPatch } from './git-diff';
import type { GitDiffFile, GitDiffResolvedComparison, GitDiffSource, GitDiffSummary } from './git-diff';

export type GitReviewAction = 'stage' | 'unstage' | 'revert';
export interface GitReviewActionRequest {
  action: GitReviewAction;
  expectedSnapshotId: string;
  filePath?: string;
  previousPath?: string;
  hunkIndex?: number;
}
interface ReviewFile extends GitDiffFile { snapshotId?: string }
interface ReviewSummary extends GitDiffSummary { snapshotId?: string; files: ReviewFile[] }
export interface GitReviewReader {
  summaryWithSnapshots(root: string, comparison: GitDiffResolvedComparison, source: GitDiffSource): Promise<ReviewSummary>;
  filePath(root: string, path: string): Promise<string>;
}
export class GitReviewActionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
interface ReviewContext {
  root: string;
  source: GitDiffSource;
  comparison: GitDiffResolvedComparison;
  process: GitProcess;
  reader: GitReviewReader;
}
const PATCH_BYTES = 16 * 1024 * 1024;
const PATCH_FLAGS = ['--no-ext-diff', '--no-textconv', '--find-renames', '--no-color', '--no-relative',
  '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--inter-hunk-context=0', '--diff-algorithm=myers', '--no-indent-heuristic', '--binary', '--full-index', '--submodule=short', '--ignore-submodules=dirty'];
const unavailable = (message: string): never => { throw new GitReviewActionError('REVIEW_ACTION_UNAVAILABLE', message); };
const noChanges = (): never => { throw new GitReviewActionError('REVIEW_ACTION_NO_CHANGES', 'There are no applicable changes in this selection.'); };
const stale = (): never => { throw new GitReviewActionError('DIFF_SNAPSHOT_CHANGED', 'The displayed changes have changed. Refresh before applying this action.'); };
function output(result: GitResult, fallback: string, accepted = [0]): string {
  if (result.truncated || !accepted.includes(result.code)) throw new GitReviewActionError('REVIEW_ACTION_CONFLICT', gitError(result, fallback));
  return result.stdout;
}

/** Keep one original hunk, including its exact newline markers and file header. */
export function selectReviewHunk(patch: string, index: number): string {
  const files = patch.split(/(?=^diff --git )/m).filter(Boolean);
  if (files.length !== 1) return unavailable('This file contains several patch relations. Apply the action to the whole file.');
  const source = files[0]!;
  const starts = [...source.matchAll(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@[^\n]*(?:\n|$)/gm)].map(match => match.index!);
  if (!starts.length) return unavailable('This change has no text hunks. Apply the action to the whole file.');
  if (index >= starts.length) return stale();
  return source.slice(0, starts[0]) + source.slice(starts[index], starts[index + 1] ?? source.length);
}

/** Mutate only host-selected paths and patches from the displayed comparison.
 * The caller holds the repository mutation queue for this entire operation. */
export async function applyGitReviewAction(context: ReviewContext, request: GitReviewActionRequest): Promise<{ ok: true; files: number }> {
  const { root, source, comparison, process: git, reader } = context;
  if (!['branch', 'uncommitted', 'unstaged', 'staged'].includes(source)) return unavailable('Historical changes cannot be modified.');
  if (!['stage', 'unstage', 'revert'].includes(request.action)) return unavailable('Unknown review action.');
  if (typeof request.expectedSnapshotId !== 'string' || !request.expectedSnapshotId || request.expectedSnapshotId.length > 256) return stale();
  if (request.hunkIndex !== undefined && (!Number.isSafeInteger(request.hunkIndex) || request.hunkIndex < 0 || !request.filePath)) {
    return unavailable('A hunk action requires one file and a non-negative hunk index.');
  }
  if (request.action === 'unstage' && source !== 'staged') return unavailable('Select staged changes before unstaging.');
  if (request.action === 'stage' && source === 'staged') return unavailable('These changes are already staged.');
  if (request.action === 'revert' && source === 'staged' && !request.filePath) return unavailable('Revert staged changes one file at a time.');
  const requested = request.filePath === undefined ? undefined : await reader.filePath(root, request.filePath);
  const previous = request.previousPath === undefined ? undefined : await reader.filePath(root, request.previousPath);
  const summary = await reader.summaryWithSnapshots(root, comparison, source);
  const selected = requested === undefined ? summary.files : summary.files.filter(file => file.path === requested && file.previousPath === previous);
  if (!selected.length) return noChanges();
  if (requested !== undefined && selected.length !== 1) return unavailable('Select a single file relation before applying this action.');
  const snapshot = requested === undefined ? summary.snapshotId : selected[0]?.snapshotId;
  if (!snapshot) return unavailable('The complete displayed snapshot is unavailable. Refresh or choose a readable file.');
  if (snapshot !== request.expectedSnapshotId) return stale();
  const paths = [...new Set(selected.flatMap(file => [file.path, ...(file.previousPath ? [file.previousPath] : [])]))];
  for (const path of paths) await reader.filePath(root, path);
  const untracked = new Set(source === 'staged' ? [] : output(await git.run(root, ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z']), 'Unable to list untracked files.').split('\0').filter(Boolean).map(path => path.replace(/\/$/, '')));
  const checkSnapshot = async () => {
    const current = await reader.summaryWithSnapshots(root, comparison, source);
    const actual = requested === undefined ? current.snapshotId : current.files.find(file => file.path === requested && file.previousPath === previous)?.snapshotId;
    if (actual !== request.expectedSnapshotId) return stale();
  };
  if (request.hunkIndex !== undefined && selected[0]?.previousPath && untracked.has(selected[0].path)) {
    return unavailable('This move has not been recorded in the index. Apply the action to the whole file.');
  }
  if (request.hunkIndex !== undefined && selected[0]?.isBinary) {
    return unavailable('Binary changes have no text hunks. Apply the action to the whole file.');
  }
  // Index-only actions capture pointers; reverting nested working content requires
  // a separate checkout operation that must not discard local files.
  const embedded = new Map<string, string>();
  for (const file of selected) {
    try {
      const absolute = resolve(root, file.path);
      if (!(await lstat(absolute)).isDirectory()) continue;
      if (request.action === 'revert') return unavailable('Revert this change inside the embedded repository. Its working files have not been modified.');
      if (untracked.has(file.path)) {
        const nestedRoot = output(await git.run(absolute, ['rev-parse', '--show-toplevel']), 'Unable to locate the embedded repository.').replace(/\r?\n$/, '');
        if (await realpath(nestedRoot) !== await realpath(absolute)) return unavailable('This directory is not an embedded repository.');
        const oid = output(await git.run(absolute, ['rev-parse', '--verify', 'HEAD^{commit}']), 'Unable to read the embedded repository pointer.').trim();
        embedded.set(file.path, oid);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const trackedPaths = [...new Set(selected.flatMap(file => [
    ...(!untracked.has(file.path) ? [file.path] : []), ...(file.previousPath ? [file.previousPath] : []),
  ]))];
  // Whole-file staging uses the current index as its preimage, even when the
  // displayed comparison starts at a branch or HEAD. Apply the captured patch
  // to the index instead of letting git add reread newer working bytes.
  const patchComparison = request.action === 'stage' && request.hunkIndex === undefined ? [] : comparison.args;
  let patch = trackedPaths.length ? output(await git.run(root, ['--no-optional-locks', 'diff', ...PATCH_FLAGS, ...patchComparison, '--', ...trackedPaths], { maxBytes: PATCH_BYTES }), 'Unable to read the selected patch.') : '';
  for (const file of selected) {
    if (!untracked.has(file.path)) continue;
    if (embedded.has(file.path)) { patch += gitlinkPatch(file.path, null, embedded.get(file.path)!); continue; }
    patch += output(await git.run(root, ['diff', ...PATCH_FLAGS, '--no-index', '--', '/dev/null', file.path], { maxBytes: PATCH_BYTES }), 'Unable to read the untracked patch.', [0, 1]);
  }
  if (Buffer.byteLength(patch, 'utf8') > PATCH_BYTES) return unavailable('The selected patch is too large to apply safely. Select a smaller set of files.');
  if (!patch) return noChanges();
  if (request.action === 'revert' && /^(?:index [^\n]+ 160000|(?:new file|deleted file|old|new) mode 160000)$/m.test(patch)) {
    return unavailable('Revert this change inside the embedded repository. Its working files have not been modified.');
  }
  if (request.hunkIndex !== undefined) patch = selectReviewHunk(patch, request.hunkIndex);
  const args = ['apply', '-p1', '--whitespace=nowarn', ...(request.action === 'revert' || request.action === 'unstage' ? ['--reverse'] : []),
    ...(request.action === 'stage' || request.action === 'unstage' ? ['--cached'] : source === 'staged' ? ['--index'] : [])];
  if (request.action === 'revert' && source === 'staged') {
    // Refresh Git's stat cache. A byte-identical file rewritten by an
    // editor must remain eligible, while --index still rejects different bytes.
    // Positional paths are deliberately absent: update-index would process
    // them as content updates after refreshing, silently staging working edits.
    output(await git.run(root, ['update-index', '--refresh']), 'Unable to refresh the index stat cache.', [0, 1]);
  }
  await checkSnapshot();
  output(await git.run(root, [...args, '--check'], { stdin: patch, maxBytes: PATCH_BYTES }), 'The selected patch conflicts with current file or index content.');
  output(await git.run(root, args, { stdin: patch, maxBytes: PATCH_BYTES }), 'Unable to apply the selected patch.');
  return { ok: true, files: selected.length };
}
