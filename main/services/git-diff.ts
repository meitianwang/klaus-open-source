import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { GitProcess, gitError, type GitResult } from './git-process';

export type GitDiffSource = 'branch' | 'uncommitted' | 'unstaged' | 'staged' | 'commit';
export interface GitDiffMetadata {
  currentBranch: string | null;
  defaultBaseBranch: string | null;
  baseBranches: string[];
  commits: Array<{ sha: string; subject: string }>;
}
export interface GitDiffResolvedComparison {
  type: 'success';
  args: string[];
  baseBranch: string | null;
  baseRevision: string | null;
  headRevision: string | null;
}
export type GitDiffComparison = GitDiffResolvedComparison | {
  type: 'expected';
  reason: 'default_branch_unavailable' | 'merge_base_unavailable';
  baseBranch: string | null;
  headRevision: string | null;
};
export interface GitDiffFile {
  path: string;
  previousPath?: string;
  additions: number | null;
  deletions: number | null;
  changes: number | null;
  isBinary: boolean;
  isUntracked: boolean;
  snapshotId?: string;
  isGenerated?: boolean;
}
export interface GitDiffStats { filesCount: number; linesAdded: number | null; linesRemoved: number | null }
export interface GitDiffSummary {
  snapshotId?: string;
  generatedAttributesUnavailable?: string;
  stats: GitDiffStats;
  files: GitDiffFile[];
  detailsTruncated: boolean;
  statsIncomplete: boolean;
  untrackedFilesOmitted?: { count: number; limit: number };
}
export interface GitDiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface GitDiffHunks { hunks: GitDiffHunk[]; isBinary: boolean; detailsTruncated: boolean; patch?: string }
export interface GitDiffContents {
  snapshotId?: string;
  oldContent?: string;
  newContent?: string;
  oldDataUrl?: string;
  newDataUrl?: string;
  contentsUnavailable?: 'binary' | 'too-large' | 'unsupported-encoding' | 'unavailable';
}
interface SnapshotSide { identity: string; content?: string; dataUrl?: string; unavailable?: GitDiffContents['contentsUnavailable'] }

const SUMMARY_BYTES = 8 * 1024 * 1024;
const PATCH_BYTES = 1024 * 1024;
const UNTRACKED_LIMIT = 512;
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--find-renames', '--no-color', '--no-relative',
  '--src-prefix=a/', '--dst-prefix=b/', '--diff-algorithm=myers', '--no-indent-heuristic'];
const PATCH_FLAGS = [...DIFF_FLAGS, '--unified=3', '--inter-hunk-context=0', '--submodule=short'];
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const missingSide = (): SnapshotSide => ({ identity: 'missing', content: '' });

export function gitPatchPath(path: string): string {
  let quoted = '"';
  for (const byte of Buffer.from(path, 'utf8')) {
    if (byte === 34 || byte === 92) quoted += '\\' + String.fromCharCode(byte);
    else if (byte < 32 || byte >= 127) quoted += '\\' + byte.toString(8).padStart(3, '0');
    else quoted += String.fromCharCode(byte);
  }
  return quoted + '"';
}

/** Describe a captured embedded repository pointer without reading its working files. */
export function gitlinkPatch(path: string, oldOid: string | null, newOid: string | null): string {
  const oid = newOid ?? oldOid;
  if (!oid || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)
    || [oldOid, newOid].some(value => value != null && (value.length !== oid.length || !/^[0-9a-f]+$/.test(value)))) {
    throw new Error('invalid embedded repository object id');
  }
  if (oldOid === newOid) return '';
  const before = gitPatchPath('a/' + path), after = gitPatchPath('b/' + path);
  return `diff --git ${before} ${after}\n`
    + (oldOid == null ? 'new file mode 160000\n' : newOid == null ? 'deleted file mode 160000\n' : '')
    + `index ${oldOid ?? '0'.repeat(oid.length)}..${newOid ?? '0'.repeat(oid.length)}${oldOid && newOid ? ' 160000' : ''}\n`
    + `--- ${oldOid == null ? '/dev/null' : before}\n+++ ${newOid == null ? '/dev/null' : after}\n`
    + `@@ -${oldOid ? '1' : '0,0'} +${newOid ? '1' : '0,0'} @@\n`
    + (oldOid ? `-Subproject commit ${oldOid}\n` : '') + (newOid ? `+Subproject commit ${newOid}\n` : '');
}

export function mediaDataUrl(path: string, bytes: Buffer): string | undefined {
  if (bytes.length > PATCH_BYTES) return undefined;
  const extension = extname(path).toLowerCase(), ascii = (start: number, end: number) => bytes.subarray(start, end).toString('ascii');
  const mime = extension === '.png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : ['.jpg', '.jpeg'].includes(extension) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : extension === '.gif' && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)) ? 'image/gif'
    : extension === '.webp' && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' ? 'image/webp'
    : extension === '.bmp' && ascii(0, 2) === 'BM' ? 'image/bmp'
    : extension === '.ico' && bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) ? 'image/x-icon'
    : extension === '.avif' && ascii(4, 8) === 'ftyp' && /avif|avis/.test(ascii(8, 64)) ? 'image/avif'
    : extension === '.pdf' && ascii(0, 5) === '%PDF-' ? 'application/pdf'
    : extension === '.svg' && /^(?:\ufeff)?\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg[^>]*>)\s*)*<svg(?:\s|>)/i.test(bytes.toString('utf8')) ? 'image/svg+xml' : undefined;
  return mime ? `data:${mime};base64,${bytes.toString('base64')}` : undefined;
}

function bytesSide(identity: string, path: string, bytes: Buffer): SnapshotSide {
  const dataUrl = mediaDataUrl(path, bytes), media = dataUrl ? { dataUrl } : {};
  if (bytes.includes(0)) return { identity, ...media, unavailable: 'binary' };
  try { return { identity, ...media, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { return { identity, ...media, unavailable: dataUrl ? 'binary' : 'unsupported-encoding' }; }
}

function expect(result: GitResult, fallback: string, accepted = [0]): string {
  if (result.truncated || !accepted.includes(result.code)) throw new Error(gitError(result, fallback));
  return result.stdout;
}
function ref(value: string): string {
  const result = value.trim();
  if (!result || result.startsWith('-') || /[\0\r\n]/.test(result)) throw new Error('invalid comparison reference');
  return result;
}
function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
}
function parseNumstat(text: string, untracked = false): GitDiffFile[] {
  const fields = text.split('\0'), files: GitDiffFile[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(field);
    if (!match) throw new Error('invalid git diff statistics');
    let path = match[3]!, previousPath: string | undefined;
    if (!path) { previousPath = fields[++index]; path = fields[++index] ?? ''; }
    if (!path || previousPath === '') throw new Error('missing git diff path');
    const additions = match[1] === '-' ? null : Number(match[1]);
    const deletions = match[2] === '-' ? null : Number(match[2]);
    files.push({ path, ...(previousPath && !untracked ? { previousPath } : {}), additions, deletions,
      changes: additions == null || deletions == null ? null : additions + deletions,
      isBinary: additions == null || deletions == null, isUntracked: untracked });
  }
  return files;
}
interface RawChange { path: string; previousPath?: string; status: string; oldOid: string }
function parseRawChanges(text: string): RawChange[] {
  const fields = text.split('\0'), changes: RawChange[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const match = /^:[0-7]{6} [0-7]{6} ([0-9a-f]{40}|[0-9a-f]{64}) (?:[0-9a-f]{40}|[0-9a-f]{64}) ([A-Z])\d*$/.exec(field);
    if (!match) throw new Error('invalid raw git diff metadata');
    let path = fields[++index], previousPath: string | undefined;
    if (match[2] === 'R' || match[2] === 'C') { previousPath = path; path = fields[++index]; }
    if (!path || previousPath === '') throw new Error('missing raw git diff path');
    changes.push({ path, ...(previousPath ? { previousPath } : {}), status: match[2]!, oldOid: match[1]! });
  }
  return changes;
}
function sum(files: GitDiffFile[], key: 'additions' | 'deletions'): number | null {
  return files.some(file => file[key] == null) ? null : files.reduce((total, file) => total + (file[key] ?? 0), 0);
}
export function parseGitDiffHunks(text: string): GitDiffHunk[] {
  const output: GitDiffHunk[] = [];
  let current: GitDiffHunk | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) current = undefined;
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1), newStart: Number(header[3]),
        newLines: Number(header[4] ?? 1), lines: [] };
      output.push(current);
    } else if (current && (/^[+\- ]/.test(line) || line === '\\ No newline at end of file')) current.lines.push(line);
  }
  return output;
}
async function concurrently<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    for (;;) {
      const position = index++;
      if (position >= items.length) return;
      output[position] = await read(items[position]!);
    }
  }));
  return output;
}

/** Read-only comparisons share one resolved base between file statistics and patches. */
export class GitDiffReader {
  constructor(private readonly process: GitProcess) {}

  private async revision(root: string, value: string): Promise<string | null> {
    const result = await this.process.run(root, ['rev-parse', '--verify', '--quiet', ref(value)]);
    if (result.code === 1 || result.code === 128) return null;
    const sha = expect(result, 'git reference lookup failed').trim();
    if (!sha) return null;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) throw new Error('invalid git object id');
    return sha;
  }

  private async emptyTree(root: string): Promise<string> {
    // Hashing the empty stdin writes no object and supports both Git object formats.
    return expect(await this.process.run(root, ['hash-object', '-t', 'tree', '--stdin']), 'empty git tree lookup failed').trim();
  }

  private async orderedRemotes(root: string): Promise<string[]> {
    const result = await this.process.run(root, ['remote']);
    if (result.code !== 0 || result.truncated) throw new Error(gitError(result, 'git remote listing failed'));
    const remotes = result.stdout.split('\n').map(value => value.trim()).filter(Boolean);
    return remotes.includes('origin') ? ['origin', ...remotes.filter(remote => remote !== 'origin')] : remotes;
  }

  private async defaultBase(root: string, remotes?: string[]): Promise<string | null> {
    for (const remote of remotes ?? await this.orderedRemotes(root)) {
      let branch: string | null = null;
      const symbolic = await this.process.run(root, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
      const prefix = `refs/remotes/${remote}/`;
      if (symbolic.code === 0 && symbolic.stdout.trim().startsWith(prefix)) branch = symbolic.stdout.trim().slice(prefix.length);
      if (!branch) {
        const shown = await this.process.run(root, ['remote', 'show', remote], { timeoutMs: 10_000 });
        const parsed = shown.code === 0 ? /HEAD branch:\s*(.+)/.exec(shown.stdout)?.[1]?.trim() : null;
        branch = parsed && parsed !== '(unknown)' ? parsed : null;
      }
      if (!branch) {
        for (const candidate of ['main', 'master']) {
          const exists = await this.process.run(root, ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`]);
          if (exists.code === 0) { branch = candidate; break; }
          if (exists.code !== 1 && exists.code !== 128) throw new Error(gitError(exists, 'remote branch lookup failed'));
        }
      }
      if (branch) return `${remote}/${branch}`;
    }
    return null;
  }

  async metadata(root: string): Promise<GitDiffMetadata> {
    const [current, refs, head, defaultBaseBranch] = await Promise.all([
      this.process.run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.process.run(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
      this.revision(root, 'HEAD'), this.defaultBase(root),
    ]);
    if (current.code !== 0 && current.code !== 1) throw new Error(gitError(current, 'current branch lookup failed'));
    const baseBranches = expect(refs, 'comparison branch listing failed').split('\n').flatMap(value => {
      const name = value.trim();
      if (name.startsWith('refs/heads/')) return [name.slice(11)];
      if (name.startsWith('refs/remotes/') && !name.endsWith('/HEAD')) return [name];
      return [];
    });
    if (defaultBaseBranch && !baseBranches.includes(`refs/remotes/${defaultBaseBranch}`)) baseBranches.unshift(`refs/remotes/${defaultBaseBranch}`);
    const log = head ? expect(await this.process.run(root, ['log', '-n', '30', '--format=%H%x00%s%x00']), 'commit listing failed') : '';
    const fields = log.split('\0'), commits: GitDiffMetadata['commits'] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const sha = fields[index]?.trim(); if (sha) commits.push({ sha, subject: fields[index + 1] ?? '' });
    }
    return { currentBranch: current.code === 0 ? current.stdout.trim() || null : null, defaultBaseBranch,
      baseBranches: [...new Set(baseBranches)], commits };
  }

  private async mergeBase(root: string, branch: string): Promise<string | null> {
    const direct = await this.process.run(root, ['merge-base', 'HEAD', ref(branch)]);
    if (direct.code !== 128) {
      if (direct.code === 1) return null;
      return expect(direct, 'git merge-base failed').trim() || null;
    }
    const [head, exact] = await Promise.all([this.revision(root, 'HEAD'), this.revision(root, branch)]);
    if (!head) return null;
    if (exact) return expect(await this.process.run(root, ['merge-base', 'HEAD', branch]), 'git merge-base failed').trim() || null;
    const [upstream, remotes] = await Promise.all([
      this.process.run(root, ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`]), this.orderedRemotes(root),
    ]);
    const candidates: string[] = [];
    const slash = branch.indexOf('/'), namedRemote = slash > 0 ? branch.slice(0, slash) : null;
    for (const remote of remotes) {
      if (namedRemote === remote) candidates.push(`refs/remotes/${remote}/${branch.slice(slash + 1)}`);
      else candidates.push(`${remote}/${branch}`, `refs/remotes/${remote}/${branch}`);
    }
    if (upstream.code === 0 && upstream.stdout.trim()) candidates.push(upstream.stdout.trim());
    for (const candidate of new Set(candidates)) {
      if (!await this.revision(root, candidate)) continue;
      const result = await this.process.run(root, ['merge-base', 'HEAD', candidate]);
      if (result.code === 1) return null;
      return expect(result, 'git merge-base failed').trim() || null;
    }
    return null;
  }

  async comparison(root: string, source: GitDiffSource, baseBranch?: string, commitSha?: string): Promise<GitDiffComparison> {
    const headRevision = await this.revision(root, 'HEAD');
    if (source === 'branch') {
      const base = baseBranch == null ? await this.defaultBase(root) : ref(baseBranch);
      if (!base) return { type: 'expected', reason: 'default_branch_unavailable', baseBranch: null, headRevision };
      const baseRevision = await this.mergeBase(root, baseBranch == null ? `refs/remotes/${base}` : base);
      return baseRevision ? { type: 'success', args: [baseRevision], baseBranch: base, baseRevision, headRevision }
        : { type: 'expected', reason: 'merge_base_unavailable', baseBranch: base, headRevision };
    }
    if (source === 'commit') {
      if (!commitSha) throw new Error('comparison commit is required');
      const sha = await this.revision(root, `${ref(commitSha)}^{commit}`);
      if (!sha) throw new Error('comparison commit is unavailable');
      const baseRevision = await this.revision(root, `${sha}^`) ?? await this.emptyTree(root);
      return { type: 'success', args: [baseRevision, sha], baseBranch: null, baseRevision, headRevision };
    }
    if (source === 'uncommitted') {
      const baseRevision = headRevision ?? await this.emptyTree(root);
      return { type: 'success', args: [baseRevision], baseBranch: null, baseRevision, headRevision };
    }
    if (source === 'staged') return { type: 'success', args: ['--cached', headRevision ?? await this.emptyTree(root)], baseBranch: null, baseRevision: headRevision, headRevision };
    if (source === 'unstaged') return { type: 'success', args: [], baseBranch: null, baseRevision: null, headRevision };
    throw new Error('invalid comparison source');
  }

  /** The final symlink is a Git file; its parents must resolve inside the selected checkout. */
  async filePath(root: string, path: string): Promise<string> {
    if (!path || path.includes('\0')) throw new Error('invalid file path');
    const absolute = resolve(root, path), canonicalRoot = await realpath(root);
    if (absolute === resolve(root) || !within(resolve(root), absolute)) throw new Error('path outside git repository');
    let parent = dirname(absolute);
    for (;;) {
      try {
        const actual = await realpath(parent);
        if (!within(canonicalRoot, actual)) throw new Error('path outside git repository');
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const next = dirname(parent); if (next === parent) throw new Error('path outside git repository'); parent = next;
    }
    return relative(resolve(root), absolute);
  }

  private async untracked(root: string, source: GitDiffSource): Promise<string[]> {
    if (source === 'staged' || source === 'commit') return [];
    const output = expect(await this.process.run(root, ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z']), 'untracked file listing failed');
    return output.split('\0').filter(Boolean).map(path => path.replace(/\/$/, ''));
  }

  private async untrackedFile(root: string, path: string): Promise<GitDiffFile> {
    const selected = await this.filePath(root, path), info = await lstat(resolve(root, selected));
    let additions: number | null = null, deletions: number | null = 0;
    if (info.isSymbolicLink()) {
      const target = await readlink(resolve(root, selected));
      additions = target.split('\n').length - 1 + Number(target.length > 0 && !target.endsWith('\n'));
    } else if (info.isDirectory()) {
      expect(await this.process.run(resolve(root, selected), ['rev-parse', '--verify', 'HEAD^{commit}']), 'embedded repository HEAD unavailable');
      additions = 1;
    } else {
      const output = expect(await this.process.run(root, ['diff', ...DIFF_FLAGS, '--no-index', '--numstat', '-z', '--', '/dev/null', selected]),
        'untracked file statistics failed', [0, 1]);
      const file = parseNumstat(output, true)[0];
      additions = file?.additions ?? (output ? null : 0); deletions = file?.deletions ?? (output ? null : 0);
    }
    return { path, additions, deletions, changes: additions == null || deletions == null ? null : additions + deletions,
      isBinary: additions == null || deletions == null, isUntracked: true };
  }

  private async workingOid(root: string, path: string): Promise<string> {
    const selected = await this.filePath(root, path), info = await lstat(resolve(root, selected));
    let result: GitResult;
    if (info.isSymbolicLink()) {
      const target = Buffer.from(await readlink(resolve(root, selected)), 'utf8');
      result = await this.process.run(root, ['hash-object', '--stdin'], { stdin: target });
    } else result = info.isDirectory()
        ? await this.process.run(resolve(root, selected), ['rev-parse', '--verify', 'HEAD^{commit}'])
        : await this.process.run(root, ['hash-object', '--', selected]);
    const oid = expect(result, 'working file object lookup failed').trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('invalid working file object id');
    return oid;
  }

  private async objectSide(root: string, path: string, revision: string | null, includeContents: boolean): Promise<SnapshotSide> {
    if (revision != null && revision === await this.emptyTree(root)) return missingSide();
    const result = revision == null
      ? await this.process.run(root, ['ls-files', '--stage', '-z', '--', path])
      : await this.process.run(root, ['ls-tree', '-z', revision, '--', path]);
    const entries = expect(result, 'comparison file lookup failed').split('\0').filter(Boolean);
    if (!entries.length) return missingSide();
    if (entries.length !== 1) throw new Error('comparison index is unresolved');
    const match = revision == null ? /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) 0\t/.exec(entries[0]!)
      : /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(entries[0]!);
    if (!match) throw new Error('comparison file has an unsupported object type');
    const mode = match[1]!, oid = match[2]!, identity = `${mode}:${oid}`;
    if (!includeContents) return { identity };
    if (mode === '160000') return { identity, content: `Subproject commit ${oid}\n` };
    const content = await this.process.run(root, ['cat-file', 'blob', oid], { maxBytes: PATCH_BYTES, rawStdout: true });
    if (content.truncated) return { identity, unavailable: 'too-large' };
    expect(content, 'comparison blob read failed');
    const side = bytesSide(identity, path, content.stdoutBytes!);
    if (mode === '120000') delete side.dataUrl;
    return side;
  }

  private async workingSide(root: string, path: string, submodule: boolean, includeContents: boolean): Promise<SnapshotSide> {
    const absolute = resolve(root, path);
    let info;
    try { info = await lstat(absolute, { bigint: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return missingSide();
      throw error;
    }
    const stamp = (value: typeof info) => [value.dev, value.ino, value.mode, value.size, value.mtimeNs, value.ctimeNs].join(':');
    const identity = stamp(info);
    if (info.isSymbolicLink()) {
      const content = await readlink(absolute);
      if (stamp(await lstat(absolute, { bigint: true })) !== identity) throw new Error('working file changed during snapshot read');
      return { identity: `symlink:${identity}:${digest(content)}`, ...(includeContents ? { content } : {}) };
    }
    if (info.isDirectory()) {
      const oid = await this.workingOid(root, path);
      const status = submodule ? expect(await this.process.run(absolute, ['--no-optional-locks', 'status', '--porcelain', '-z']), 'submodule status failed') : '';
      return { identity: `gitlink:${oid}:${digest(status)}`, ...(includeContents ? { content: `Subproject commit ${oid}${status ? '-dirty' : ''}\n` } : {}) };
    }
    if (!info.isFile()) throw new Error('comparison path is not a file');
    if (info.size > BigInt(PATCH_BYTES)) return { identity: `file:${identity}`, unavailable: 'too-large' };
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (stamp(await handle.stat({ bigint: true })) !== identity) throw new Error('working file changed during snapshot read');
      const buffer = Buffer.alloc(Number(info.size) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== Number(info.size) || stamp(await handle.stat({ bigint: true })) !== identity
        || stamp(await lstat(absolute, { bigint: true })) !== identity) throw new Error('working file changed during snapshot read');
      const bytes = buffer.subarray(0, offset), key = `file:${identity}:${digest(bytes)}`;
      return includeContents ? bytesSide(key, path, bytes) : { identity: key };
    } finally { await handle.close(); }
  }

  /** Read the two sides selected by the comparison; never follow a final symlink. */
  async contents(root: string, comparison: GitDiffResolvedComparison, source: GitDiffSource, path: string,
    previousPath?: string, isUntracked?: boolean, includeContents = true): Promise<GitDiffContents> {
    try {
      const selected = await this.filePath(root, path), previous = previousPath == null ? selected : await this.filePath(root, previousPath);
      const untracked = isUntracked ?? (previousPath == null && (await this.untracked(root, source)).includes(selected));
      const oldSide = untracked ? missingSide()
        : source === 'staged' && comparison.baseRevision == null ? missingSide()
        : await this.objectSide(root, previous, source === 'unstaged' ? null : comparison.baseRevision, includeContents);
      const newSide = source === 'commit' ? await this.objectSide(root, selected, comparison.args[1]!, includeContents)
        : source === 'staged' ? await this.objectSide(root, selected, null, includeContents)
        : await this.workingSide(root, selected, previousPath == null && oldSide.identity.startsWith('160000:'), includeContents);
      const snapshotId = digest(JSON.stringify([source, comparison.args, selected, previous, oldSide.identity, newSide.identity]));
      const contentsUnavailable = oldSide.unavailable ?? newSide.unavailable;
      return { snapshotId,
        ...(oldSide.content !== undefined ? { oldContent: oldSide.content } : {}),
        ...(newSide.content !== undefined ? { newContent: newSide.content } : {}),
        ...(oldSide.dataUrl ? { oldDataUrl: oldSide.dataUrl } : {}), ...(newSide.dataUrl ? { newDataUrl: newSide.dataUrl } : {}),
        ...(contentsUnavailable ? { contentsUnavailable } : {}) };
    } catch { return { contentsUnavailable: 'unavailable' }; }
  }

  /** Bracket statistics with file identities so counts and later details share a snapshot. */
  async summaryWithSnapshots(root: string, comparison: GitDiffResolvedComparison, source: GitDiffSource): Promise<GitDiffSummary> {
    const comparisonData = (value: GitDiffSummary) => {
      const { generatedAttributesUnavailable: _notice, ...summary } = value;
      return { ...summary, files: summary.files.map(({ isGenerated: _generated, ...file }) => file) };
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const first = await this.summary(root, comparison, source);
      const before = await concurrently(first.files, file => this.contents(root, comparison, source, file.path, file.previousPath, file.isUntracked, false));
      const summary = await this.summary(root, comparison, source);
      if (JSON.stringify(comparisonData(first)) !== JSON.stringify(comparisonData(summary))) continue;
      const after = await concurrently(summary.files, file => this.contents(root, comparison, source, file.path, file.previousPath, file.isUntracked, false));
      if (before.some((value, index) => value.snapshotId !== after[index]?.snapshotId)) continue;
      const files = summary.files.map((file, index) => ({ ...file, ...(after[index]?.snapshotId ? { snapshotId: after[index]!.snapshotId } : {}) }));
      const complete = !summary.detailsTruncated && !summary.untrackedFilesOmitted && files.every(file => file.snapshotId);
      const snapshotId = complete ? digest(JSON.stringify([source, comparison.args, summary.stats,
        files.map(file => [file.path, file.previousPath ?? '', file.snapshotId]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))])) : undefined;
      return { ...summary, files, ...(snapshotId ? { snapshotId } : {}) };
    }
    throw new Error('Comparison files changed while their summary was loading. Refresh the changes view.');
  }

  /** Generated-file labels come only from explicit repository attributes. */
  private async generatedFiles(root: string, source: GitDiffSource, files: GitDiffFile[]): Promise<Pick<GitDiffSummary, 'files' | 'generatedAttributesUnavailable'>> {
    if (source === 'commit' || !files.length) return { files };
    const paths = [...new Set(files.map(file => file.path))], stdin = paths.join('\0') + '\0';
    const unavailable = (message: string) => ({ files, generatedAttributesUnavailable: message });
    if (Buffer.byteLength(stdin, 'utf8') > SUMMARY_BYTES) return unavailable('Generated-file attribute input exceeded its size limit.');
    try {
      const result = await this.process.run(root, ['check-attr', '-z', '--stdin', ...(source === 'staged' ? ['--cached'] : []),
        'linguist-generated', 'generated'], { stdin, maxBytes: SUMMARY_BYTES });
      if (result.code !== 0 || result.truncated) return unavailable(gitError(result, 'Generated-file attributes are unavailable.'));
      const fields = result.stdout.split('\0');
      if (fields.pop() !== '' || fields.length !== paths.length * 6) return unavailable('Generated-file attribute response was incomplete.');
      const values = new Map<string, Map<string, string>>(), selected = new Set(paths);
      for (let index = 0; index < fields.length; index += 3) {
        const path = fields[index]!, attribute = fields[index + 1]!, value = fields[index + 2]!;
        if (!selected.has(path) || !['linguist-generated', 'generated'].includes(attribute)) return unavailable('Generated-file attribute response was invalid.');
        const row = values.get(path) ?? new Map<string, string>();
        if (row.has(attribute)) return unavailable('Generated-file attribute response contained duplicate values.');
        row.set(attribute, value); values.set(path, row);
      }
      return { files: files.map(file => {
        const row = values.get(file.path);
        const primary = row?.get('linguist-generated');
        const value = primary === 'unspecified' ? row?.get('generated') : primary;
        const isGenerated = value === 'set' || value === 'true' ? true : value === 'unset' || value === 'false' ? false : undefined;
        return isGenerated === undefined ? file : { ...file, isGenerated };
      }) };
    } catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
  }

  async summary(root: string, comparison: GitDiffResolvedComparison, source: GitDiffSource): Promise<GitDiffSummary> {
    const [tracked, paths] = await Promise.all([
      this.process.run(root, ['--no-optional-locks', 'diff', ...DIFF_FLAGS, '--numstat', '-z', ...comparison.args, '--'], { maxBytes: SUMMARY_BYTES }),
      this.untracked(root, source),
    ]);
    const omitted = paths.length > UNTRACKED_LIMIT ? { count: paths.length, limit: UNTRACKED_LIMIT } : undefined;
    const untracked = omitted ? [] : await concurrently(paths, path => this.untrackedFile(root, path));
    if (tracked.truncated) {
      const text = expect(await this.process.run(root, ['--no-optional-locks', 'diff', ...DIFF_FLAGS, '--shortstat', ...comparison.args, '--']), 'diff totals failed');
      return { stats: { filesCount: Number(/(\d+) files? changed/.exec(text)?.[1] ?? 0) + paths.length, linesAdded: null, linesRemoved: null },
        files: [], detailsTruncated: true, statsIncomplete: true, ...(omitted ? { untrackedFilesOmitted: omitted } : {}) };
    }
    let combined = [...parseNumstat(expect(tracked, 'git diff statistics failed')), ...untracked];
    if (untracked.length) {
      const raw = await this.process.run(root, ['--no-optional-locks', 'diff', ...DIFF_FLAGS, '--raw', '--no-abbrev', '-z', ...comparison.args, '--'], { maxBytes: SUMMARY_BYTES });
      if (raw.truncated) return { stats: { filesCount: combined.length, linesAdded: null, linesRemoved: null }, files: [],
        detailsTruncated: true, statsIncomplete: true };
      const deleted = parseRawChanges(expect(raw, 'raw git diff metadata failed')).filter(change => change.status === 'D' && change.previousPath == null);
      if (deleted.length) {
        const matches = new Map<string, string>();
        await concurrently(untracked, async file => {
          const oid = await this.workingOid(root, file.path);
          const candidates = deleted.filter(change => oid.startsWith(change.oldOid));
          if (candidates.length === 1) matches.set(file.path, candidates[0]!.path);
        });
        const previousPaths = new Set(matches.values());
        combined = combined.filter(file => file.previousPath != null || file.isUntracked || !previousPaths.has(file.path))
          .map(file => {
            const previousPath = file.previousPath == null ? matches.get(file.path) : undefined;
            return previousPath == null ? file : { ...file, previousPath, additions: 0, deletions: 0, changes: 0, isUntracked: false };
          });
      }
    }
    // The working file supersedes a same-path tracked deletion. Rename relations
    // retain their previous path so they remain separate comparisons.
    const files = [...new Map(combined
      .map(file => [`${file.previousPath ?? ''}\0${file.path}`, file])).values()];
    const generated = await this.generatedFiles(root, source, files);
    return { stats: { filesCount: files.length + (omitted?.count ?? 0), linesAdded: omitted ? null : sum(files, 'additions'),
      linesRemoved: omitted ? null : sum(files, 'deletions') }, ...generated, detailsTruncated: false,
      statsIncomplete: omitted != null || files.some(file => file.additions == null || file.deletions == null), ...(omitted ? { untrackedFilesOmitted: omitted } : {}) };
  }

  async hunks(root: string, comparison: GitDiffResolvedComparison, source: GitDiffSource, path: string, previousPath?: string): Promise<GitDiffHunks> {
    const selected = await this.filePath(root, path), previous = previousPath == null ? null : await this.filePath(root, previousPath);
    if (previous != null && (source === 'branch' || source === 'uncommitted' || source === 'unstaged')) {
      const scoped = await this.process.run(root, ['--no-optional-locks', 'diff', ...PATCH_FLAGS, '--full-index', '--binary', ...comparison.args,
        '--', previous, selected], { maxBytes: PATCH_BYTES });
      const raw = !scoped.truncated && scoped.code === 0 ? scoped.stdout : '';
      // Only an actual Git rename has an applicable whole-file rename patch.
      // An inferred untracked move has no such patch in the selected Git scope.
      const patch = (raw.match(/^diff --git /gm)?.length === 1 && /^rename from /m.test(raw) && /^rename to /m.test(raw)) ? raw : undefined;
      const original = `${source === 'unstaged' ? '' : comparison.args[0]}:${previous}`;
      const info = await lstat(resolve(root, selected));
      if (info.isDirectory()) {
        const oldOid = expect(await this.process.run(root, ['rev-parse', '--verify', original]), 'previous repository object lookup failed').trim();
        const newOid = await this.workingOid(root, selected);
        return { ...(patch ? { patch } : {}), hunks: oldOid === newOid ? [] : [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          lines: [`-Subproject commit ${oldOid}`, `+Subproject commit ${newOid}`] }], isBinary: false, detailsTruncated: false };
      }
      const result = await this.process.run(root, ['--no-optional-locks', 'diff', ...PATCH_FLAGS, '--full-index', '--binary', original, './' + selected], { maxBytes: PATCH_BYTES });
      if (result.truncated) return { hunks: [], isBinary: false, detailsTruncated: true };
      const text = expect(result, 'renamed file diff failed', [0, 1]);
      return { hunks: parseGitDiffHunks(text), ...(patch ? { patch } : {}), isBinary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(text), detailsTruncated: false };
    }
    if ((await this.untracked(root, source)).includes(selected)) {
      const info = await lstat(resolve(root, selected));
      if (info.isDirectory()) {
        const patch = gitlinkPatch(selected, null, await this.workingOid(root, selected));
        return { patch, hunks: parseGitDiffHunks(patch), isBinary: false, detailsTruncated: false };
      }
      const result = await this.process.run(root, ['diff', ...PATCH_FLAGS, '--full-index', '--binary', '--no-index', '--', '/dev/null', selected], { maxBytes: PATCH_BYTES });
      if (result.truncated) return { hunks: [], isBinary: false, detailsTruncated: true };
      const text = expect(result, 'untracked file diff failed', [0, 1]);
      return { hunks: parseGitDiffHunks(text), patch: text, isBinary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(text), detailsTruncated: false };
    }
    const result = await this.process.run(root, ['--no-optional-locks', 'diff', ...PATCH_FLAGS, '--full-index', '--binary', ...comparison.args, '--',
      ...previous ? [previous, selected] : [selected]], { maxBytes: PATCH_BYTES });
    if (result.truncated) return { hunks: [], isBinary: false, detailsTruncated: true };
    const text = expect(result, 'file diff failed');
    return { hunks: parseGitDiffHunks(text), patch: text, isBinary: /^(?:Binary files .* differ|GIT binary patch)$/m.test(text), detailsTruncated: false };
  }
}
