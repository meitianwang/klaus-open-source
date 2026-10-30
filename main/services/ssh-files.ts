import { posix } from 'node:path';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import type { SshResult, SshTarget } from '../native/ssh';
import { parseSshTarget } from '../native/ssh';
import type { SshConnectionPool } from './ssh-pool';

export interface SshWorkdir { target: SshTarget; path: string }
export interface RemoteNode { name: string; path: string; isDir: boolean; isFile: boolean; size: number; mtimeMs: number }
export interface RemoteGrepHit { path: string; line: number; text: string }

const LIST_ENTRY_LIMIT = 2000, WALK_PATH_LIMIT = 5000, GREP_HIT_LIMIT = 200, GREP_BYTE_LIMIT = 512 * 1024;
const READ_CHUNK_BYTES = 512 * 1024, WRITE_CHUNK_CHARS = 20000, SEARCH_PATH_LIMIT = 5000;

/** Split an `ssh://user@host:port/abs/path` workdir into its transport target and remote root. */
export function splitSshWorkdir(workdir: unknown): SshWorkdir | null {
  if (typeof workdir !== 'string' || !workdir.startsWith('ssh://')) return null;
  const rest = workdir.slice('ssh://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const authority = rest.slice(0, slash), remotePath = rest.slice(slash);
  if (!remotePath.startsWith('/') || remotePath.includes('\0') || remotePath.length > 4096) return null;
  try { return { target: parseSshTarget(authority), path: posix.normalize(remotePath).replace(/\/+$/, '') || '/' }; }
  catch { return null; }
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
/** mtime in seconds via GNU or BSD stat; `word` must already be a quoted shell word. */
const mtimeExpr = (word: string): string => `$(stat -c %Y ${word} 2>/dev/null || stat -f %m ${word} 2>/dev/null || printf 0)`;
/** Reject anything that is not contained in the remote root after normalization. */
export function containRemote(root: string, requested: string): string {
  if (requested.includes('\0')) throw new IpcHandlerError('BAD_REQUEST', 'invalid remote path');
  const absolute = requested.startsWith('/') ? posix.normalize(requested) : posix.normalize(posix.join(root, requested));
  if (absolute !== root && !absolute.startsWith(root.endsWith('/') ? root : root + '/')) throw new IpcHandlerError('BAD_REQUEST', 'path outside remote workspace');
  return absolute;
}

/**
 * File operations over a pooled SSH transport. Every operation is one remote
 * command with a NUL-delimited, base64-carrying reply, so a directory listing
 * or a grep costs a single round trip instead of one per entry.
 */
export class SshFileService {
  constructor(private readonly deps: { pool: SshConnectionPool; log?: (message: string) => void }) {}

  private run(senderId: number, workdir: SshWorkdir, command: string, deadlineMs = 30_000): Promise<SshResult> {
    return this.deps.pool.execute(senderId, workdir.target, command, deadlineMs);
  }
  private require(result: SshResult): Buffer {
    if (!result.outputComplete || result.exitCode !== 0 || result.signal) {
      throw new IpcHandlerError('REMOTE_COMMAND_FAILED', result.stderr.toString('utf8').slice(0, 4096) || `remote command failed: ${result.signal ?? result.exitCode ?? 'unknown exit'}`);
    }
    return result.stdout;
  }

  async stat(senderId: number, workdir: SshWorkdir, requested: string): Promise<RemoteNode | null> {
    const path = containRemote(workdir.path, requested);
    const command = `p=${quote(path)}; if [ -d "$p" ]; then printf 'd\\0'; elif [ -f "$p" ]; then printf 'f\\0'; else printf 'x\\0'; exit 0; fi; wc -c < "$p" | tr -d ' \\n'; printf '\\0'; stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || printf 0`;
    const out = this.require(await this.run(senderId, workdir, command)).toString('utf8');
    const [kind, size, mtime] = out.split('\0');
    if (kind === 'x') return null;
    return { name: posix.basename(path), path, isDir: kind === 'd', isFile: kind === 'f', size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000 };
  }

  async listDir(senderId: number, workdir: SshWorkdir, requested: string): Promise<{ nodes: RemoteNode[]; truncated: boolean }> {
    const path = containRemote(workdir.path, requested);
    // Three glob passes and three forks no matter how many entries: names ride
    // one base64 blob, kinds one character each, and one xargs stat call
    // reports sizes and mtimes in argument order.
    const entries = `i=0; for e in ./* ./.[!.]* ./..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; i=$((i+1)); [ "$i" -gt ${LIST_ENTRY_LIMIT} ] && break;`;
    const statAll = `{ ${entries} printf '%s\\0' "$e"; done; } | xargs -0 stat`;
    const command = `cd ${quote(path)} || exit 3; c=0; for e in ./* ./.[!.]* ./..?*; do [ -e "$e" ] || [ -L "$e" ] || continue; c=$((c+1)); done; if [ "$c" -gt ${LIST_ENTRY_LIMIT} ]; then printf TRUNCATED >&2; fi; [ "$c" -eq 0 ] && exit 0; { ${entries} printf '%s\\0' "\${e#./}"; done; } | base64 | tr -d '\\n'; printf '\\0'; ${entries} if [ -d "$e" ]; then printf d; elif [ -f "$e" ]; then printf f; else printf o; fi; done; printf '\\0'; if stat -c %s /dev/null >/dev/null 2>&1; then ${statAll} -c '%s %Y' 2>/dev/null; else ${statAll} -f '%z %m' 2>/dev/null; fi; true`;
    const result = await this.run(senderId, workdir, command);
    const stdout = this.require(result).toString('utf8');
    const truncated = result.stderr.toString('utf8').includes('TRUNCATED');
    const [namesBlob, kinds, statText] = stdout.split('\0');
    const names = Buffer.from(namesBlob ?? '', 'base64').toString('utf8').split('\0').filter(Boolean);
    const stats = (statText ?? '').split('\n').filter(Boolean).map(line => line.trim().split(/\s+/u));
    // A file vanishing between the glob and the stat pass would shift line
    // order; rather than attribute one file's size to another, drop metadata.
    const aligned = stats.length === names.length;
    const nodes: RemoteNode[] = [];
    for (const [index, name] of names.entries()) {
      if (!name || name === '.' || name === '..' || name.includes('/')) continue;
      const kind = (kinds ?? '')[index] ?? 'o', [size, mtime] = aligned ? stats[index] ?? [] : [];
      if (kind === 'o') continue;
      nodes.push({ name, path: posix.join(path, name), isDir: kind === 'd', isFile: kind === 'f', size: Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000 });
    }
    nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { nodes, truncated };
  }

  async read(senderId: number, workdir: SshWorkdir, requested: string, offset = 0, limit = READ_CHUNK_BYTES): Promise<{ content: Buffer; size: number; complete: boolean }> {
    const path = containRemote(workdir.path, requested);
    const command = `p=${quote(path)}; [ -f "$p" ] || exit 4; total=$(wc -c < "$p" | tr -d ' \\n'); tail -c +$((1 + ${offset})) "$p" 2>/dev/null | head -c ${limit} | base64 | tr -d '\\n'; printf '\\0%s' "$total"`;
    const out = this.require(await this.run(senderId, workdir, command)).toString('utf8');
    const sep = out.lastIndexOf('\0');
    if (sep < 0) throw new IpcHandlerError('REMOTE_RESPONSE_INVALID', 'missing size terminator');
    const size = Number(out.slice(sep + 1)) || 0;
    const content = Buffer.from(out.slice(0, sep), 'base64');
    return { content, size, complete: offset + content.length >= size };
  }

  async write(senderId: number, workdir: SshWorkdir, requested: string, content: Buffer): Promise<void> {
    const path = containRemote(workdir.path, requested);
    const encoded = content.toString('base64');
    const parent = posix.dirname(path);
    let first = true;
    for (let index = 0; index < encoded.length || first; index += WRITE_CHUNK_CHARS) {
      first = false;
      const chunk = encoded.slice(index, index + WRITE_CHUNK_CHARS);
      const redirect = index === 0 ? '>' : '>>';
      const command = `mkdir -p ${quote(parent)} && printf '%s' ${quote(chunk)} | base64 -d ${redirect} ${quote(path)}`;
      this.require(await this.run(senderId, workdir, command));
    }
  }

  async createDirectory(senderId: number, workdir: SshWorkdir, requested: string): Promise<void> {
    const path = containRemote(workdir.path, requested);
    this.require(await this.run(senderId, workdir, `mkdir -p ${quote(path)}`));
  }

  async remove(senderId: number, workdir: SshWorkdir, requested: string): Promise<void> {
    const path = containRemote(workdir.path, requested);
    if (path === workdir.path) throw new IpcHandlerError('BAD_REQUEST', 'cannot remove the remote workspace root');
    this.require(await this.run(senderId, workdir, `[ -e ${quote(path)} ] || exit 4; rm -rf -- ${quote(path)}`));
  }

  async rename(senderId: number, workdir: SshWorkdir, requested: string, newName: string): Promise<string> {
    if (!newName || newName.includes('/') || newName === '.' || newName === '..' || newName.includes('\0')) throw new IpcHandlerError('BAD_REQUEST', 'invalid name');
    const from = containRemote(workdir.path, requested), to = posix.join(posix.dirname(from), newName);
    this.require(await this.run(senderId, workdir, `[ -e ${quote(from)} ] || exit 4; [ -e ${quote(to)} ] && exit 5; mv -- ${quote(from)} ${quote(to)}`));
    return to;
  }

  /** Content search in one round trip; hits carry root-relative paths. */
  async grep(senderId: number, workdir: SshWorkdir, requested: string, pattern: string, fixed = true): Promise<{ hits: RemoteGrepHit[]; truncated: boolean }> {
    const path = containRemote(workdir.path, requested);
    if (!pattern || pattern.includes('\0') || pattern.length > 512) throw new IpcHandlerError('BAD_REQUEST', 'invalid pattern');
    const flags = fixed ? '-F' : '-E';
    const command = `cd ${quote(path)} || exit 3; grep -rIn ${flags} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build -e ${quote(pattern)} . 2>/dev/null | head -c ${GREP_BYTE_LIMIT} | base64 | tr -d '\\n'`;
    const out = this.require(await this.run(senderId, workdir, command, 60_000)).toString('utf8');
    const text = Buffer.from(out, 'base64').toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    const hits: RemoteGrepHit[] = [];
    for (const line of lines.slice(0, GREP_HIT_LIMIT)) {
      const match = /^([^\0:]+):([0-9]+):(.*)$/u.exec(line);
      if (!match) continue;
      hits.push({ path: match[1]!.replace(/^\.\//u, ''), line: Number(match[2]), text: match[3]!.slice(0, 500) });
    }
    return { hits, truncated: lines.length > GREP_HIT_LIMIT || text.length >= GREP_BYTE_LIMIT };
  }

  /** Relative path enumeration for name search; pruning mirrors the local walker. */
  async walk(senderId: number, workdir: SshWorkdir, requested: string): Promise<{ paths: string[]; truncated: boolean }> {
    const path = containRemote(workdir.path, requested);
    const command = `cd ${quote(path)} || exit 3; find . -maxdepth 6 \\( -name .git -o -name node_modules -o -name dist -o -name build \\) -prune -o -type f -print 2>/dev/null | head -n $((1 + ${SEARCH_PATH_LIMIT})) | base64 | tr -d '\\n'`;
    const out = this.require(await this.run(senderId, workdir, command, 60_000)).toString('utf8');
    const lines = Buffer.from(out, 'base64').toString('utf8').split('\n').filter(Boolean).map(line => line.replace(/^\.\//u, ''));
    return { paths: lines.slice(0, SEARCH_PATH_LIMIT), truncated: lines.length > SEARCH_PATH_LIMIT };
  }

  /** Run one agent command in the remote root; stdout/stderr stay bounded by the transport. */
  async exec(senderId: number, workdir: SshWorkdir, command: string, deadlineMs = 120_000): Promise<SshResult> {
    if (!command || command.includes('\0')) throw new IpcHandlerError('BAD_REQUEST', 'invalid remote command');
    return this.run(senderId, workdir, `cd ${quote(workdir.path)} || exit 3; ${command}`, deadlineMs);
  }

  async home(senderId: number, workdir: SshWorkdir): Promise<string> {
    const result = await this.run(senderId, workdir, 'printf %s "$HOME"');
    return this.require(result).toString('utf8');
  }

  toJson(workdir: SshWorkdir): Json {
    return { authority: `${workdir.target.user ? `${workdir.target.user}@` : ''}${workdir.target.host}${workdir.target.port ? `:${workdir.target.port}` : ''}`, path: workdir.path };
  }
}
