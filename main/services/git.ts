import { access, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parsePatch } from 'diff';
import type { Json } from '../ipc/contract';
import { errorMessage, string, type JsonObject, type ServicePush, SerialMutations } from './service-types';
import { pathInside, WorkspaceStore } from './workspaces';
import { GitProcess, gitError, type GitProcessOptions, type GitResult } from './git-process';
import { GitDiffReader, gitPatchPath, mediaDataUrl, parseGitDiffHunks, type GitDiffSource } from './git-diff';

export interface LastTurnFileChange {
  path: string;
  kind: string;
  added: number | null;
  removed: number | null;
  turnDiff: string | null;
  entryId?: string;
}
export interface LastTurnChanges { turnId: string | null; files: LastTurnFileChange[]; unavailableReason?: string }
export type DiffSource = GitDiffSource | 'last-turn';
interface Repository extends JsonObject { root: string; name: string }
interface DiffContext {
  root: string;
  gitRoot?: string;
  repositoryRoot: string | null;
  repositories: Repository[];
  gitRoots: string[];
  roots: string[];
  source: DiffSource;
  lastTurn?: LastTurnChanges;
}
export interface GitDeps {
  workspaces: WorkspaceStore;
  openPath: (path: string) => Promise<void>;
  revealPath: (path: string) => void | Promise<void>;
  sideQuestion: (sessionId: string, question: string) => Promise<{ response: string }>;
  readLastTurn?: (sessionId: string, turnId?: string) => Promise<LastTurnChanges>;
  push: ServicePush;
  process?: GitProcess;
  processOptions?: GitProcessOptions;
}
interface Stats { filesCount: number; linesAdded: number; linesRemoved: number }
const emptyStats = (): Stats => ({ filesCount: 0, linesAdded: 0, linesRemoved: 0 });
const DIFF_FILE_LIMIT = 50, PATCH_BYTE_LIMIT = 1024 * 1024;
const exists = async (path: string): Promise<boolean> => { try { await access(path); return true; } catch (error) {
  if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error;
} };
const jsonStats = (stats: Stats): JsonObject => ({ ...stats });
const recordedSnapshotId = (turnId: string | null, file: LastTurnFileChange): string =>
  createHash('sha256').update(JSON.stringify([turnId, file.path, file.kind, file.entryId, file.added, file.removed, file.turnDiff])).digest('hex');

/** Bind a single recorded patch to its recorded file without rebuilding its body or metadata. */
function recordedApplyPatch(file: LastTurnFileChange, path: string): JsonObject {
  const unavailable = (reason: string): JsonObject => ({ patchCopyUnavailable: reason });
  const patch = file.turnDiff;
  if (patch == null) return unavailable('Recorded patch content is unavailable.');
  if (Buffer.byteLength(patch, 'utf8') > PATCH_BYTE_LIMIT) return unavailable('Recorded patch exceeded its size limit.');
  if (patch.includes('\0')) return unavailable('Recorded patch contains unsupported binary data.');
  const lines = patch.split('\n'), bodyIndex = lines.findIndex(line => line.startsWith('@@ ') || line === 'GIT binary patch');
  const metadata = lines.slice(0, bodyIndex < 0 ? lines.length : bodyIndex);
  if (Buffer.byteLength(metadata.join('\n'), 'utf8') > 64 * 1024) return unavailable('Recorded patch metadata exceeded its size limit.');
  if (lines.filter(line => line.startsWith('diff --git ')).length > 1) return unavailable('Recorded patch contains multiple files.');
  if (metadata.filter(line => line.startsWith('--- ')).length > 1 || metadata.filter(line => line.startsWith('+++ ')).length > 1) return unavailable('Recorded patch contains multiple file headers.');
  if (metadata.some(line => /^(?:rename (?:from|to)|copy (?:from|to)) /.test(line))) return unavailable('Recorded rename or copy paths cannot be proven.');
  const created = file.kind === 'create' || file.kind === 'add', deleted = file.kind === 'delete';
  if (!created && !deleted && file.kind !== 'modify' && file.kind !== 'update') return unavailable('Recorded file operation is unsupported.');
  let parsed;
  try { parsed = parsePatch(patch); } catch { return unavailable('Recorded patch structure is invalid.'); }
  if (parsed.length !== 1) return unavailable('Recorded patch must describe one file.');
  const original = parsed[0]!, oldName = original.oldFileName, newName = original.newFileName;
  const stripPrefix = (name: string) => name.replace(/^[ab]\//, '');
  if (!created && !deleted && oldName !== undefined && newName !== undefined
    && !(stripPrefix(oldName) === 'before' && stripPrefix(newName) === 'after') && stripPrefix(oldName) !== stripPrefix(newName)) {
    return unavailable('Recorded previous file path cannot be proven.');
  }
  if ((created && original.hunks.some(hunk => hunk.oldLines !== 0)) || (deleted && original.hunks.some(hunk => hunk.newLines !== 0))) {
    return unavailable('Recorded patch contradicts its file operation.');
  }
  const preserved: string[] = [];
  let oldMode = false, newMode = false, existenceMode = false, hasIndex = false;
  for (const line of metadata) {
    if (!line || /^diff --git /.test(line) || /^(?:---|\+\+\+|Index:) /.test(line) || /^=+$/.test(line)) continue;
    if (/^(?:old|new) mode (?:100644|100755|120000|160000)$/.test(line)) {
      if (created || deleted) return unavailable('Recorded mode metadata contradicts its file operation.');
      if (line.startsWith('old mode')) {
        if (oldMode) return unavailable('Recorded patch has duplicate old mode metadata.');
        oldMode = true;
      } else {
        if (newMode) return unavailable('Recorded patch has duplicate new mode metadata.');
        newMode = true;
      }
    } else if (/^(?:new file|deleted file) mode (?:100644|100755|120000|160000)$/.test(line)) {
      if (existenceMode || (line.startsWith('new file') ? !created : !deleted)) return unavailable('Recorded existence metadata contradicts its file operation.');
      existenceMode = true;
    } else if (/^index [0-9a-f]{4,64}\.\.[0-9a-f]{4,64}(?: (?:100644|100755|120000|160000))?$/.test(line)) {
      if (hasIndex) return unavailable('Recorded patch has duplicate object metadata.');
      hasIndex = true;
    } else if (!/^(?:similarity|dissimilarity) index (?:100|[0-9]{1,2})%$/.test(line)) return unavailable('Recorded patch metadata is unsupported.');
    preserved.push(line);
  }
  if (oldMode !== newMode) return unavailable('Recorded mode metadata is incomplete.');
  const binary = bodyIndex >= 0 && lines[bodyIndex] === 'GIT binary patch';
  if (binary && !hasIndex) return unavailable('Recorded binary patch lacks object metadata.');
  if (bodyIndex < 0 && !existenceMode && !oldMode) return unavailable('Recorded patch has no applicable changes.');
  const target = path.split(sep).join('/'), before = gitPatchPath('a/' + target), after = gitPatchPath('b/' + target);
  const header = `diff --git ${before} ${after}\n` + (preserved.length ? preserved.join('\n') + '\n' : '');
  const fileHeaders = !binary && bodyIndex >= 0 ? `--- ${created ? '/dev/null' : before}\n+++ ${deleted ? '/dev/null' : after}\n` : '';
  const body = bodyIndex < 0 ? '' : lines.slice(bodyIndex).join('\n');
  const result = header + fileHeaders + body + (body && !body.endsWith('\n') ? '\n' : '');
  return Buffer.byteLength(result, 'utf8') <= PATCH_BYTE_LIMIT ? { patch: result } : unavailable('Recorded patch transport exceeded its size limit.');
}

/** Recover full recorded sides only when absent sides or explicit EOF markers prove completeness. */
function recordedContents(file: LastTurnFileChange): JsonObject {
  const patch = file.turnDiff;
  if (patch == null) return { contentsUnavailable: 'recorded-context-unavailable' };
  if (Buffer.byteLength(patch, 'utf8') > PATCH_BYTE_LIMIT) return { contentsUnavailable: 'too-large' };
  if (/^(?:Binary files .* differ|GIT binary patch)$/m.test(patch)) return { contentsUnavailable: 'binary' };
  const hunks = parseGitDiffHunks(patch);
  if (!hunks.length) return { contentsUnavailable: 'recorded-context-unavailable' };
  const created = file.kind === 'create' || file.kind === 'add', deleted = file.kind === 'delete';
  let oldCount = 0, newCount = 0, oldContent = '', newContent = '', oldEOF = created, newEOF = deleted;
  for (const hunk of hunks) {
    if ((hunk.oldLines && hunk.oldStart !== oldCount + 1) || (hunk.newLines && hunk.newStart !== newCount + 1)) return { contentsUnavailable: 'recorded-context-unavailable' };
    let oldLines = 0, newLines = 0;
    for (const [index, line] of hunk.lines.entries()) {
      if (line.startsWith('\\')) continue;
      if ((created && !line.startsWith('+')) || (deleted && !line.startsWith('-'))) return { contentsUnavailable: 'recorded-context-unavailable' };
      const noNewline = hunk.lines[index + 1] === '\\ No newline at end of file';
      const value = line.slice(1) + (noNewline ? '' : '\n');
      if (!line.startsWith('+')) {
        if (oldEOF) return { contentsUnavailable: 'recorded-context-unavailable' };
        oldContent += value; oldLines++; oldEOF = noNewline;
      }
      if (!line.startsWith('-')) {
        if (newEOF) return { contentsUnavailable: 'recorded-context-unavailable' };
        newContent += value; newLines++; newEOF = noNewline;
      }
    }
    if (oldLines !== hunk.oldLines || newLines !== hunk.newLines) return { contentsUnavailable: 'recorded-context-unavailable' };
    oldCount += oldLines; newCount += newLines;
  }
  if (created || deleted || (oldEOF && newEOF)) {
    const oldDataUrl = extname(file.path).toLowerCase() === '.svg' ? mediaDataUrl(file.path, Buffer.from(oldContent, 'utf8')) : undefined;
    const newDataUrl = extname(file.path).toLowerCase() === '.svg' ? mediaDataUrl(file.path, Buffer.from(newContent, 'utf8')) : undefined;
    return { oldContent, newContent, ...(oldDataUrl ? { oldDataUrl } : {}), ...(newDataUrl ? { newDataUrl } : {}) };
  }
  return { contentsUnavailable: 'recorded-context-unavailable' };
}
function assertGit(result: GitResult, fallback: string): string {
  if (result.code !== 0) throw new Error(gitError(result, fallback)); return result.stdout;
}
/** A tracked change in the composer's branch-switch conflict list.
 *  The Changes surface uses GitDiffReader's separate scoped comparison model. */
interface NumstatFile extends JsonObject { path: string; additions: number; deletions: number; changes: number; isBinary: boolean; isUntracked: boolean }
function numstat(text: string): { stats: Stats; files: NumstatFile[] } {
  const fields = text.split('\0'), stats = emptyStats(), files: NumstatFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] ?? ''; if (!record) continue;
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(record); if (!match) continue;
    let path = match[3]!;
    if (!path) { i++; path = fields[++i] ?? ''; }
    if (!path) continue;
    const isBinary = match[1] === '-' || match[2] === '-';
    const additions = isBinary ? 0 : Number.parseInt(match[1]!, 10) || 0;
    const deletions = isBinary ? 0 : Number.parseInt(match[2]!, 10) || 0;
    stats.filesCount++; stats.linesAdded += additions; stats.linesRemoved += deletions;
    if (files.length < DIFF_FILE_LIMIT) files.push({ path, additions, deletions, changes: additions + deletions, isBinary, isUntracked: false });
  }
  return { stats, files };
}
async function canonicalDirectory(path: string): Promise<string> {
  let directory = resolve(path); const missing: string[] = [];
  for (;;) {
    try { return resolve(await realpath(directory), ...missing.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(directory);
      if (parent === directory) return resolve(path);
      missing.push(basename(directory)); directory = parent;
    }
  }
}
async function authoredPath(root: string, path: string): Promise<string> {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  // A Git symlink is itself a file; canonicalize its parents, never its target.
  return join(await canonicalDirectory(dirname(absolute)), basename(absolute));
}
function repositoryLabels(directories: string[]): Repository[] {
  const parts = directories.map(directory => directory.split(/[/\\]/).filter(Boolean));
  return directories.map((root, index) => {
    const segments = parts[index]!; let depth = 1;
    while (depth < segments.length && parts.some((other, otherIndex) => otherIndex !== index
      && other.slice(-depth).join('/') === segments.slice(-depth).join('/'))) depth++;
    return { root, name: segments.slice(-depth).join('/') || root };
  });
}
function diffSource(value: Json | undefined): DiffSource {
  if (value == null) return 'branch';
  if (value === 'branch' || value === 'uncommitted' || value === 'staged' || value === 'unstaged' || value === 'commit' || value === 'last-turn') return value;
  throw new Error('invalid comparison source');
}
function lineCount(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** One `git status --porcelain -z` record. A rename/copy is followed by a second
 *  token holding the original path, which is not an entry of its own. */
function porcelainEntries(text: string): Array<{ status: string; path: string }> {
  const tokens = text.split('\0'), entries: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? ''; if (token.length < 4) continue;
    const status = token.slice(0, 2);
    entries.push({ status, path: token.slice(3) });
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return entries;
}

/** Git panel operations are serialized per repository when they mutate it. */
export class GitService {
  readonly process: GitProcess;
  private readonly reader: GitDiffReader;
  private readonly authoredPathCache = new Map<string, string[]>();
  private readonly mutations = new Map<string, { queue: SerialMutations; users: number }>();
  private closed = false;
  constructor(private readonly deps: GitDeps) {
    this.process = deps.process ?? new GitProcess(deps.processOptions);
    this.reader = new GitDiffReader(this.process);
  }
  private async run(operation: () => Promise<Json>): Promise<Json> {
    try { if (this.closed) throw new Error('The git service is closed'); return await operation(); }
    catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async withRepositoryMutation(root: string, operation: () => Promise<Json>): Promise<Json> {
    const common = await this.process.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const key = common.code === 0 ? await realpath(common.stdout.trim()) : join(await realpath(root), '.git');
    let entry = this.mutations.get(key);
    if (!entry) { entry = { queue: new SerialMutations(), users: 0 }; this.mutations.set(key, entry); }
    entry.users++;
    try { return await entry.queue.run(async () => { if (this.closed) throw new Error('The git service is closed'); return operation(); }); }
    finally { entry.users--; if (!entry.users) this.mutations.delete(key); }
  }
  private workdir(payload: JsonObject): string | undefined {
    const raw = string(payload.workdir).trim();
    return raw && !raw.includes('\0') && !raw.startsWith('ssh://') ? resolve(raw) : undefined;
  }
  async findRoot(start: string): Promise<string | undefined> {
    const ceilings = (this.deps.processOptions?.env?.GIT_CEILING_DIRECTORIES ?? process.env.GIT_CEILING_DIRECTORIES ?? '').split(delimiter).filter(Boolean).map(path => resolve(path));
    let dir = resolve(start);
    for (;;) {
      if (ceilings.includes(dir)) return undefined;
      if (await exists(join(dir, '.git'))) return dir;
      const parent = dirname(dir); if (parent === dir) return undefined; dir = parent;
    }
  }
  private async context(payload: JsonObject): Promise<DiffContext> {
    const sessionId = string(payload.sessionId);
    const root = sessionId ? await this.deps.workspaces.sessionDirectory(sessionId) : this.workdir(payload);
    if (!root) throw new Error('invalid sessionId');
    // A remote workspace has no Git view on this computer: the engine's own
    // change ledger describes its local scratch directory, not the remote
    // root, so surfacing it here would mix two machines into one Changes pane.
    if (root.startsWith('ssh://')) {
      return { root, gitRoot: undefined, repositoryRoot: null, repositories: [], gitRoots: [], roots: [], source: diffSource(payload.source) };
    }
    const source = diffSource(payload.source);
    const roots = [...new Set(await Promise.all([root, ...(sessionId ? this.deps.workspaces.sessionRoots(sessionId) : [])]
      .filter(path => !path.startsWith('ssh://')).map(path => canonicalDirectory(path))))];
    let lastTurn: LastTurnChanges | undefined;
    if (sessionId && this.deps.readLastTurn) {
      try {
        const recorded = await this.deps.readLastTurn(sessionId, string(payload.turnId) || undefined);
        lastTurn = { ...recorded, files: await Promise.all(recorded.files.map(async file =>
          ({ ...file, path: await authoredPath(root, file.path) }))) };
        // Repository discovery needs only authored paths, so the cache never
        // retains large turn patches after their individual request finishes.
        this.authoredPathCache.set(sessionId, lastTurn.files.map(file => file.path));
      } catch (error) {
        // Live Git state stays readable while saved conversation inspection is
        // unavailable. Last turn must report that failure instead of old data.
        if (source === 'last-turn') throw error;
      }
    }
    const authoredPaths = lastTurn?.files.map(file => file.path) ?? this.authoredPathCache.get(sessionId) ?? [];
    const gitRoots: string[] = [];
    for (const directory of [...roots, ...authoredPaths.map(path => dirname(path))]) {
      if (directory.startsWith('ssh://')) continue;
      const found = await this.findRoot(directory);
      if (!found) continue;
      const canonical = await realpath(found);
      if (!gitRoots.includes(canonical)) gitRoots.push(canonical);
    }
    const plainRoots: string[] = [];
    if (source === 'last-turn') {
      for (const path of authoredPaths) {
        if (gitRoots.some(repository => pathInside(path, repository))) continue;
        const declared = roots.filter(directory => pathInside(path, directory)).sort((a, b) => b.length - a.length)[0];
        const directory = declared ?? dirname(path);
        if (!plainRoots.includes(directory)) plainRoots.push(directory);
      }
      // A plain latest turn with no edits is still a usable Changes surface.
      if (!gitRoots.length && !plainRoots.length && roots[0]) plainRoots.push(roots[0]);
    }
    const repositories = repositoryLabels([...gitRoots, ...plainRoots]);
    const selected = payload.repositoryRoot;
    let repositoryRoot: string | null = source === 'last-turn' ? null : repositories[0]?.root ?? null;
    if (selected != null) {
      if (typeof selected !== 'string' || !selected || selected.includes('\0') || !isAbsolute(selected)) throw new Error('invalid repositoryRoot');
      let canonical = resolve(selected);
      try { canonical = await realpath(canonical); } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      if (!repositories.some(repository => repository.root === canonical)) throw new Error('repository is outside this conversation');
      repositoryRoot = canonical;
    }
    return { root, gitRoot: repositoryRoot && gitRoots.includes(repositoryRoot) ? repositoryRoot : undefined,
      repositoryRoot, repositories, gitRoots, roots, source, ...(lastTurn ? { lastTurn } : {}) };
  }
  private async mutationContext(payload: JsonObject): Promise<DiffContext & { gitRoot: string }> {
    const context = await this.context(payload);
    if (context.source === 'last-turn' || context.source === 'commit') throw new Error('historical changes cannot be committed');
    if (!context.gitRoot) throw new Error('not a git repository');
    return { ...context, gitRoot: context.gitRoot };
  }
  private lastTurnFiles(context: DiffContext): JsonObject[] {
    if (!context.lastTurn) throw new Error('last turn changes are unavailable');
    return context.lastTurn.files.flatMap(file => {
      // Empty is an authoritative net-zero patch; null is an unavailable patch.
      if (file.turnDiff === '') return [];
      const absolute = isAbsolute(file.path) ? resolve(file.path) : resolve(context.root, file.path);
      const repositoryRoot = context.repositories.filter(repository => pathInside(absolute, repository.root))
        .sort((a, b) => b.root.length - a.root.length)[0]?.root;
      if (!repositoryRoot || (context.repositoryRoot && repositoryRoot !== context.repositoryRoot)) return [];
      const additions = lineCount(file.added), deletions = lineCount(file.removed);
      return [{ path: relative(repositoryRoot, absolute), repositoryRoot, kind: file.kind, additions, deletions,
        changes: additions === null || deletions === null ? null : additions + deletions,
        isBinary: typeof file.turnDiff === 'string' && /^(?:Binary files .* differ|GIT binary patch)$/m.test(file.turnDiff),
        isUntracked: file.kind === 'create', patchUnavailable: file.turnDiff === null,
        snapshotId: recordedSnapshotId(context.lastTurn!.turnId, file),
        ...(file.entryId ? { entryId: file.entryId } : {}) }];
    });
  }
  async isTransient(root: string): Promise<boolean> {
    const value = assertGit(await this.process.run(root, ['rev-parse', '--absolute-git-dir']), 'git directory lookup failed').trim();
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      if (await exists(join(value, marker))) return true;
    }
    return false;
  }
  private changed(payload: JsonObject): void {
    if (!this.closed && string(payload.sessionId)) this.deps.push('chat:event', { type: 'workspace:invalidated', sessionId: payload.sessionId! });
  }
  branches(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const dir = this.workdir(payload); if (!dir) throw new Error('invalid workdir');
      const root = await this.findRoot(dir); if (!root) throw new Error('not a git repository');
      const branches = assertGit(await this.process.run(root, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads/']), 'git branch listing failed')
        .split('\n').map(line => line.trim()).filter(Boolean);
      const current = await this.process.run(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
      // A valid initialized repository with no commit is a Git target, but has no selectable
      // branch yet. Keep process failures visible when refs exist instead of classifying them
      // as a non-repository and silently hiding the composer's controls.
      const unborn = !branches.length && current.code !== 0 && /unknown revision or path not in the working tree/u.test(current.stderr);
      if (current.code !== 0 && !unborn) throw new Error(gitError(current, 'git current branch lookup failed'));
      return { ok: true, current: current.code === 0 ? current.stdout.trim() : '', branches, gitRoot: root };
    });
  }
  init(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const dir = this.workdir(payload); if (!dir) throw new Error('invalid workdir');
      if (!await exists(dir)) throw new Error('directory does not exist: ' + dir);
      if (!(await stat(dir)).isDirectory()) throw new Error('not a directory: ' + dir);
      return this.withRepositoryMutation(dir, async (): Promise<Json> => {
        if (await this.findRoot(dir)) return { ok: true, alreadyRepo: true };
        let result = await this.process.run(dir, ['init', '-b', 'main']);
        if (result.code !== 0 && /unknown option|invalid/i.test(result.stderr)) {
          result = await this.process.run(dir, ['init']);
          if (result.code === 0) assertGit(await this.process.run(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']), 'initial branch setup failed');
        }
        assertGit(result, 'git init failed'); assertGit(await this.process.run(dir, ['add', '-A']), 'git add failed');
        let commit = await this.process.run(dir, ['commit', '-m', 'Initial commit', '--allow-empty']);
        if (commit.code !== 0 && /user\.name|user\.email|please tell me who you are/i.test(commit.stderr + commit.stdout)) {
          commit = await this.process.run(dir, ['-c', 'user.name=Klaus', '-c', 'user.email=klaus@local', 'commit', '-m', 'Initial commit', '--allow-empty']);
        }
        assertGit(commit, 'git commit failed'); this.changed(payload); return { ok: true, branch: 'main' };
      });
    });
  }
  /**
   * The working-tree state the composer needs before a branch action.
   *
   * Two questions the composer's branch selector asks:
   *  - `changes`: how many uncommitted changes exist (working tree + index, counted
   *    the way git status counts them). The selector labels its
   *    "include uncommitted" toggle with this number.
   *  - `files`: which of them checking out `branch` would REFUSE to carry. Git
   *    rejects a switch when a locally edited tracked file also differs on the
   *    target branch, or when an untracked file already exists in the target tree.
   *    We compute that set instead of parsing git's refusal, so the confirmation
   *    can list the files and their line stats before anything is attempted.
   *
   * An empty `files` means the switch carries every edit along, which git does
   * silently — that is the common case and takes no confirmation.
   */
  uncommitted(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const dir = this.workdir(payload); if (!dir) throw new Error('invalid workdir');
      const branch = string(payload.branch).trim();
      if (branch && (branch.startsWith('-') || /[\s\0]/.test(branch))) throw new Error('invalid branch name');
      const root = await this.findRoot(dir); if (!root) throw new Error('not a git repository');
      const current = assertGit(await this.process.run(root, ['rev-parse', '--abbrev-ref', 'HEAD']), 'not a git repository').trim();
      const base = { gitRoot: root, current, branch: branch || current };
      const status = assertGit(await this.process.run(root, ['--no-optional-locks', 'status', '--porcelain', '-z']), 'git status failed');
      const entries = porcelainEntries(status);
      // The count is working-tree plus index entries, and an untracked file counts
      // as a working-tree change — so this is every entry `git status --porcelain`
      // reports. It is also exactly what `worktree:create`
      // carries over when the switch is on (tracked edits via the snapshot commit,
      // untracked files copied), so the number the user reads is the number that
      // moves.
      const changes = entries.length;
      if (!entries.length) return { ok: true, ...base, dirty: false, changes: 0, files: [] };
      // Only a switch to a DIFFERENT existing branch can be refused. `checkout -b`
      // never is (the new branch starts at HEAD, so every edit carries), and
      // re-checking out the current branch is a no-op.
      if (!branch || branch === current) return { ok: true, ...base, dirty: true, changes, files: [] };
      if ((await this.process.run(root, ['check-ref-format', '--branch', branch])).code !== 0) throw new Error('invalid branch name: ' + branch);
      const exists = (await this.process.run(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', branch + '^{commit}'])).code === 0;
      if (!exists) return { ok: true, ...base, dirty: true, changes, files: [] };
      const tracked = numstat(assertGit(await this.process.run(root, ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--numstat', '-z']), 'git diff failed')).files;
      const target = new Set(assertGit(await this.process.run(root, ['--no-optional-locks', 'diff', '--name-only', '-z', 'HEAD', branch, '--']), 'git diff failed').split('\0').filter(Boolean));
      const files: JsonObject[] = tracked
        .filter(file => target.has(String(file.path)))
        .map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions, isBinary: file.isBinary }));
      const untracked = assertGit(await this.process.run(root, ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z']), 'untracked file listing failed').split('\0').filter(Boolean);
      if (untracked.length) {
        const inTarget = new Set(assertGit(await this.process.run(root, ['ls-tree', '-r', '--name-only', '-z', branch]), 'git tree listing failed').split('\0').filter(Boolean));
        for (const path of untracked) if (inTarget.has(path)) files.push({ path, additions: 0, deletions: 0, isBinary: false });
      }
      return { ok: true, ...base, dirty: true, changes, files };
    });
  }
  checkout(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const dir = this.workdir(payload); if (!dir) throw new Error('invalid workdir');
      const branch = string(payload.branch).trim();
      if (!branch || branch.startsWith('-') || /[\s\0]/.test(branch)) throw new Error('invalid branch name');
      const root = await this.findRoot(dir); if (!root) throw new Error('not a git repository');
      return this.withRepositoryMutation(root, async () => {
        if ((await this.process.run(root, ['check-ref-format', '--branch', branch])).code !== 0) throw new Error('invalid branch name: ' + branch);
        assertGit(await this.process.run(root, payload.create === true ? ['checkout', '-b', branch] : ['checkout', branch]), 'git checkout failed');
        this.changed(payload); return { ok: true, branch };
      });
    });
  }
  summary(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const context = await this.context(payload);
      const { root, gitRoot, repositoryRoot, repositories, source } = context;
      const base = { root, gitRoot: gitRoot ?? null, repositoryRoot, repositories, source,
        isGit: Boolean(gitRoot) || source === 'last-turn', canCommit: false };
      if (source === 'last-turn') {
        if (!context.lastTurn) return { ok: true, ...base, isGit: false, turnId: null, currentBranch: null, defaultBaseBranch: null,
          baseBranches: [], commits: [], comparison: null, stats: jsonStats(emptyStats()), files: [], statsIncomplete: false, detailsTruncated: false };
        const files = this.lastTurnFiles(context);
        const count = (key: 'additions' | 'deletions'): number | null => {
          let total = 0;
          for (const file of files) {
            if (file[key] === null || !Number.isSafeInteger(total + Number(file[key]))) return null;
            total += Number(file[key]);
          }
          return total;
        };
        return { ok: true, ...base, turnId: context.lastTurn!.turnId, currentBranch: null, defaultBaseBranch: null,
          baseBranches: [], commits: [], comparison: { type: 'last-turn', turnId: context.lastTurn!.turnId,
            ...(context.lastTurn!.unavailableReason ? { reason: context.lastTurn!.unavailableReason } : {}) },
          stats: { filesCount: files.length, linesAdded: count('additions'), linesRemoved: count('deletions') }, files,
          statsIncomplete: files.some(file => file.additions === null || file.deletions === null), detailsTruncated: false };
      }
      if (!gitRoot) return { ok: true, ...base, currentBranch: null, defaultBaseBranch: null, baseBranches: [], commits: [],
        comparison: null, stats: jsonStats(emptyStats()), files: [] };
      const metadata = await this.reader.metadata(gitRoot);
      if (await this.isTransient(gitRoot)) return { ok: true, ...base, ...metadata, comparison: null,
        transient: true, stats: jsonStats(emptyStats()), files: [] };
      const commitSha = source === 'commit' ? (payload.commitSha == null ? metadata.commits[0]?.sha : string(payload.commitSha)) : undefined;
      if (source === 'commit' && !commitSha) return { ok: true, ...base, ...metadata, commitSha: null,
        comparison: { type: 'expected', reason: 'commit_unavailable' }, stats: jsonStats(emptyStats()), files: [] };
      const comparison = source === 'branch' && payload.baseBranch == null && metadata.defaultBaseBranch === null
        ? { type: 'expected' as const, reason: 'default_branch_unavailable', baseBranch: null, headRevision: null }
        : await this.reader.comparison(gitRoot, source,
          payload.baseBranch == null ? undefined : string(payload.baseBranch), commitSha);
      if (comparison.type === 'expected') return { ok: true, ...base, ...metadata, commitSha: commitSha ?? null, comparison: { ...comparison }, stats: jsonStats(emptyStats()), files: [] };
      const summary = await this.reader.summaryWithSnapshots(gitRoot, comparison, source);
      const status = assertGit(await this.process.run(gitRoot, ['--no-optional-locks', 'status', '--porcelain', '-z']), 'git status failed');
      return { ok: true, ...base, ...metadata, commitSha: commitSha ?? null, comparison: { ...comparison }, stats: { ...summary.stats },
        ...(summary.snapshotId ? { snapshotId: summary.snapshotId } : {}),
        files: summary.files.map(file => ({ ...file, repositoryRoot: gitRoot })), detailsTruncated: summary.detailsTruncated,
        statsIncomplete: summary.statsIncomplete, ...(summary.generatedAttributesUnavailable ? { generatedAttributesUnavailable: summary.generatedAttributesUnavailable } : {}), ...(summary.untrackedFilesOmitted ? { untrackedFilesOmitted: { ...summary.untrackedFilesOmitted } } : {}),
        canCommit: source !== 'commit' && Boolean(status) };
    });
  }
  private filePath(root: string, value: unknown, allowRoot = false): { absolute: string; relative: string } {
    const file = string(value); if (!file || file.includes('\0')) throw new Error('invalid filePath');
    const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
    if (!pathInside(absolute, root) || (!allowRoot && absolute === resolve(root))) throw new Error('path outside git repository');
    return { absolute, relative: relative(root, absolute) };
  }
  hunks(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const context = await this.context(payload);
      const { root, gitRoot, repositoryRoot, source } = context;
      const base = { root, gitRoot: gitRoot ?? null, repositoryRoot, source, isGit: Boolean(gitRoot) || source === 'last-turn' };
      const requested = string(payload.filePath ?? payload.path);
      if (source === 'last-turn') {
        if (!context.lastTurn) throw new Error('last turn changes are unavailable');
        if (Object.prototype.hasOwnProperty.call(payload, 'turnId') && payload.turnId !== context.lastTurn.turnId) throw new Error('last turn changed while its diff was loading');
        if (!repositoryRoot) throw new Error('repositoryRoot is required for a last turn file');
        const selected = this.filePath(repositoryRoot, requested);
        const entries = context.lastTurn.files.filter(file => (isAbsolute(file.path) ? resolve(file.path) : resolve(root, file.path)) === selected.absolute);
        if (payload.entryId == null && entries.length > 1) throw new Error('entryId is required for multiple recorded patches');
        const file = entries.find(file => payload.entryId == null || file.entryId === payload.entryId);
        if (!file) throw new Error('file was not changed in the latest turn');
        const snapshotId = recordedSnapshotId(context.lastTurn.turnId, file);
        if (payload.expectedSnapshotId != null && payload.expectedSnapshotId !== snapshotId) return {
          ok: false, ...base, code: 'DIFF_SNAPSHOT_CHANGED', error: 'Comparison changed; refresh the changes view.' };
        if (file.turnDiff === null) return { ok: true, ...base, turnId: context.lastTurn.turnId,
          files: [{ path: requested, repositoryRoot, snapshotId, hunks: [], patchUnavailable: true,
            ...(payload.includeContents === true ? { contentsUnavailable: 'recorded-context-unavailable' } : {}), ...(file.entryId ? { entryId: file.entryId } : {}) }] };
        const truncated = Buffer.byteLength(file.turnDiff, 'utf8') > PATCH_BYTE_LIMIT;
        return { ok: true, ...base, turnId: context.lastTurn.turnId,
          files: [{ path: requested, repositoryRoot, snapshotId, hunks: truncated ? [] : parseGitDiffHunks(file.turnDiff).map(hunk => ({ ...hunk })),
            ...recordedApplyPatch(file, selected.relative),
            ...(payload.includeContents === true ? recordedContents(file) : {}),
            isBinary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(file.turnDiff), ...(file.entryId ? { entryId: file.entryId } : {}) }], detailsTruncated: truncated };
      }
      if (!gitRoot) return { ok: true, ...base, files: [] };
      if (await this.isTransient(gitRoot)) return { ok: true, ...base, transient: true, files: [] };
      let commitSha = payload.commitSha == null ? undefined : string(payload.commitSha);
      if (source === 'commit' && !commitSha) {
        const head = await this.process.run(gitRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        if (head.code !== 0) return { ok: true, ...base, commitSha: null, comparison: { type: 'expected', reason: 'commit_unavailable' }, files: [] };
        commitSha = head.stdout.trim();
      }
      const comparison = await this.reader.comparison(gitRoot, source,
        payload.baseBranch == null ? undefined : string(payload.baseBranch), commitSha);
      if ((Object.prototype.hasOwnProperty.call(payload, 'expectedBaseRevision') &&
        (comparison.type !== 'success' || payload.expectedBaseRevision !== comparison.baseRevision)) ||
        (Object.prototype.hasOwnProperty.call(payload, 'expectedHeadRevision') && payload.expectedHeadRevision !== comparison.headRevision)) {
        return { ok: false, ...base, code: 'DIFF_SNAPSHOT_CHANGED', error: 'Comparison changed; refresh the changes view.' };
      }
      if (comparison.type === 'expected') return { ok: true, ...base, comparison: { ...comparison }, files: [] };
      const previousPath = payload.previousPath == null ? undefined : string(payload.previousPath);
      const before = await this.reader.contents(gitRoot, comparison, source, requested, previousPath, undefined, payload.includeContents === true);
      if (payload.expectedSnapshotId != null && payload.expectedSnapshotId !== before.snapshotId) return {
        ok: false, ...base, code: 'DIFF_SNAPSHOT_CHANGED', error: 'Comparison changed; refresh the changes view.' };
      const detail = await this.reader.hunks(gitRoot, comparison, source, requested,
        previousPath);
      const after = await this.reader.contents(gitRoot, comparison, source, requested, previousPath, undefined, false);
      if (before.snapshotId !== after.snapshotId) return { ok: false, ...base, code: 'DIFF_SNAPSHOT_CHANGED', error: 'Comparison changed; refresh the changes view.' };
      const contents: JsonObject = payload.includeContents !== true ? {}
        : { ...(!detail.detailsTruncated && before.oldContent !== undefined ? { oldContent: before.oldContent } : {}),
          ...(!detail.detailsTruncated && before.newContent !== undefined ? { newContent: before.newContent } : {}),
          ...(before.oldDataUrl ? { oldDataUrl: before.oldDataUrl } : {}), ...(before.newDataUrl ? { newDataUrl: before.newDataUrl } : {}),
          ...(detail.detailsTruncated ? { contentsUnavailable: 'too-large' }
            : detail.isBinary || before.contentsUnavailable ? { contentsUnavailable: detail.isBinary ? 'binary' : before.contentsUnavailable! } : {}) };
      return { ok: true, ...base, commitSha: commitSha ?? null, comparison: { ...comparison },
        files: [{ path: requested, repositoryRoot, ...(before.snapshotId ? { snapshotId: before.snapshotId } : {}), ...contents,
          ...(detail.patch !== undefined ? { patch: detail.patch } : {}),
          hunks: detail.hunks.map(hunk => ({ ...hunk })), isBinary: detail.isBinary }], detailsTruncated: detail.detailsTruncated };
    });
  }
  open(payload: JsonObject, reveal = false): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const context = await this.context(payload), repositoryRoot = context.repositoryRoot;
      if (!repositoryRoot) throw new Error('repositoryRoot is required to open a file');
      if (!context.gitRoot && context.source !== 'last-turn') throw new Error('not a git repository');
      const { absolute } = this.filePath(repositoryRoot, payload.filePath ?? payload.path, true);
      if (context.source === 'last-turn' && absolute !== repositoryRoot && !context.lastTurn?.files.some(file =>
        (isAbsolute(file.path) ? resolve(file.path) : resolve(context.root, file.path)) === absolute)) throw new Error('file was not changed in the latest turn');
      if (!await exists(absolute)) throw new Error('file not found');
      if (!pathInside(await realpath(absolute), await realpath(repositoryRoot))) throw new Error('path outside git repository');
      await (reveal ? this.deps.revealPath(absolute) : this.deps.openPath(absolute)); return { ok: true, path: absolute };
    });
  }
  commit(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const { gitRoot } = await this.mutationContext(payload);
      return this.withRepositoryMutation(gitRoot, async () => {
        if (await this.isTransient(gitRoot)) throw new Error('repository is in a transient state (merge/rebase in progress)');
        const message = string(payload.message).trim(); if (!message) throw new Error('empty commit message');
        if (Buffer.byteLength(message) > 20_000) throw new Error('commit message too long');
        assertGit(await this.process.run(gitRoot, ['add', '-A']), 'git add failed');
        assertGit(await this.process.run(gitRoot, ['commit', '-m', message]), 'git commit failed');
        const sha = assertGit(await this.process.run(gitRoot, ['rev-parse', '--short', 'HEAD']), 'commit hash lookup failed').trim();
        this.changed(payload); return { ok: true, sha };
      });
    });
  }
  /**
   * Commit a named set of paths.
   *
   * This is the composer's "Commit & Switch Branch" step: it commits the files
   * the checkout would refuse, not the whole working tree — the rest of the user's
   * in-progress work deliberately stays uncommitted. `commit` above is the other
   * operation: it stages everything the Diff view is showing.
   */
  commitPaths(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const dir = this.workdir(payload); if (!dir) throw new Error('invalid workdir');
      const message = string(payload.message).trim(); if (!message) throw new Error('empty commit message');
      if (Buffer.byteLength(message) > 20_000) throw new Error('commit message too long');
      const requested = Array.isArray(payload.paths) ? payload.paths.map(entry => string(entry).trim()).filter(Boolean) : [];
      if (!requested.length) throw new Error('no paths to commit');
      const root = await this.findRoot(dir); if (!root) throw new Error('not a git repository');
      return this.withRepositoryMutation(root, async () => {
        if (await this.isTransient(root)) throw new Error('repository is in a transient state (merge/rebase in progress)');
        const paths: string[] = [];
        for (const entry of requested) {
          if (entry.startsWith('-') || entry.includes('\0')) throw new Error('invalid path: ' + entry);
          const target = isAbsolute(entry) ? resolve(entry) : resolve(root, entry);
          if (!pathInside(target, root) || target === resolve(root)) throw new Error('path outside git repository');
          paths.push(relative(root, target));
        }
        // `--` keeps the paths literal on top of the runner's --literal-pathspecs.
        assertGit(await this.process.run(root, ['add', '--', ...paths]), 'git add failed');
        assertGit(await this.process.run(root, ['commit', '-m', message, '--', ...paths]), 'git commit failed');
        const sha = assertGit(await this.process.run(root, ['rev-parse', '--short', 'HEAD']), 'commit hash lookup failed').trim();
        this.changed(payload); return { ok: true, sha };
      });
    });
  }
  generateCommitMessage(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const sessionId = string(payload.sessionId); if (!sessionId) throw new Error('invalid sessionId');
      const { gitRoot } = await this.mutationContext(payload);
      if (await this.isTransient(gitRoot)) throw new Error('repository is in a transient state (merge/rebase in progress)');
      const stats = assertGit(await this.process.run(gitRoot, ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--stat=120']), 'git diff failed').trim();
      const untracked = assertGit(await this.process.run(gitRoot, ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z']), 'untracked listing failed').split('\0').filter(Boolean).slice(0, 50);
      if (!stats && !untracked.length) throw new Error('no changes to describe');
      const patch = await this.process.run(gitRoot, ['--no-optional-locks', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--unified=1'], { maxBytes: 12_000 });
      if (patch.code !== 0 && !patch.truncated) throw new Error(gitError(patch, 'git diff failed'));
      const log = assertGit(await this.process.run(gitRoot, ['--no-optional-locks', 'log', '--oneline', '-5']), 'git log failed');
      const question = [
        'Write a git commit message for the following working tree changes.', 'Requirements:',
        '- Follow the style of the recent commits shown below (language, prefix conventions).',
        '- First line: concise summary (max ~72 chars). Then a blank line and short bullet points if the change is non-trivial.',
        '- Describe only what actually changed. No speculation, no issue numbers you cannot see.',
        '- Output ONLY the commit message text. No code fences, no explanations.', '', 'Recent commits (style reference):', log.trim() || '(none)',
        '', 'Change stats:', stats || '(no tracked changes)', untracked.length ? '\nUntracked files:\n' + untracked.join('\n') : '',
        '', 'Diff:', patch.stdout ? patch.stdout + (patch.truncated ? '\n…(diff truncated)…' : '') : '(binary or untracked-only changes)',
      ].join('\n');
      const answer = await this.deps.sideQuestion(sessionId, question);
      if (this.closed) throw new Error('The git service is closed');
      if (typeof answer?.response !== 'string') throw new Error('commit message generation returned no response');
      const message = answer.response.trim().replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '').trim();
      if (!message) throw new Error('empty message generated'); return { ok: true, message };
    });
  }
  reviewAction(payload: JsonObject): Promise<Json> {
    return this.run(async () => {
      const { applyGitReviewAction, GitReviewActionError } = await import('./git-review-actions');
      const { gitRoot, source } = await this.mutationContext(payload);
      return this.withRepositoryMutation(gitRoot, async () => {
        try {
          if (await this.isTransient(gitRoot)) throw new GitReviewActionError('REVIEW_ACTION_CONFLICT', 'Resolve the current merge or rebase before modifying changes.');
          const comparison = await this.reader.comparison(gitRoot, source as GitDiffSource,
            payload.baseBranch == null ? undefined : string(payload.baseBranch));
          if (comparison.type !== 'success') throw new GitReviewActionError('REVIEW_ACTION_UNAVAILABLE', 'The selected comparison is unavailable.');
          const result = await applyGitReviewAction({ root: gitRoot, source: source as GitDiffSource, comparison,
            process: this.process, reader: this.reader }, {
            action: string(payload.action) as import('./git-review-actions').GitReviewAction,
            expectedSnapshotId: string(payload.expectedSnapshotId),
            ...(payload.filePath == null ? {} : { filePath: string(payload.filePath) }),
            ...(payload.previousPath == null ? {} : { previousPath: string(payload.previousPath) }),
            ...(payload.hunkIndex == null ? {} : { hunkIndex: payload.hunkIndex as number }),
          });
          this.changed(payload);
          return result;
        } catch (error) {
          if (error instanceof GitReviewActionError) return { ok: false, code: error.code, error: error.message };
          throw error;
        }
      });
    });
  }
  async close(): Promise<void> { this.closed = true; this.authoredPathCache.clear(); await this.process.close(); }
}
