import { createHash } from 'node:crypto';
import { constants, watch } from 'node:fs';
import { copyFile, lstat, mkdir, open, opendir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { isFailure, kvGet, kvSet } from './settings';
import { object, string, errorMessage, type JsonObject, type ServicePush } from './service-types';
import { pathInside, WorkspaceStore } from './workspaces';
import { sessionVisualizationsDir } from './visualizations';
import { readInlineVisPage } from './inline-vis-read';
import { containRemote, type SshFileService, type SshWorkdir } from './ssh-files';

export const BASE_WORKSPACE_EXCLUDES = [
  '**/.git/**', '**/.git/objects/**', '**/.git/subtree-cache/**', '**/.hg/**', '**/.hg/store/**',
  '**/.git', '**/.svn', '**/.svn/**', '**/.hg', '**/.DS_Store', '**/Thumbs.db',
  '**/node_modules', '**/node_modules/**', '**/dist', '**/dist/**', '**/build', '**/build/**',
  '**/.next', '**/.next/**', '**/.turbo', '**/.turbo/**', '**/__pycache__', '**/__pycache__/**',
  '**/.pytest_cache', '**/.pytest_cache/**', '**/target', '**/target/**',
] as const;
const READONLY_EXTENSIONS = new Set('svg png jpg jpeg gif webp bmp ico avif pdf mp3 wav m4a aac flac ogg oga opus mp4 webm mov m4v ogv'.split(' '));
const WRITE_LIMIT = 10 * 1024 * 1024, PREVIEW_LIMIT = 10 * 1024 * 1024, REMOTE_PREVIEW_LIMIT = 1024 * 1024;
class FileRefusal extends Error {}
interface WorkspaceWatcher { close(): void; on(event: 'error', listener: (error: Error) => void): unknown }

export interface FileDeps {
  workspaces: WorkspaceStore;
  push: ServicePush;
  openPath: (path: string) => Promise<void>;
  revealPath: (path: string) => void | Promise<void>;
  trashPath: (path: string) => Promise<void>;
  openPreviewWindow: (options: { kind: 'artifact'; filePath: string; sessionId: string; displayName?: string }) => Promise<void>;
  /** Native save dialog for `artifacts:save-copy`; resolves undefined when cancelled. */
  saveCopyDialog?: (senderId: number, defaultName: string) => Promise<string | undefined>;
  requestSession: (sessionId: string, method: 'session/fileChanges', params: JsonObject) => Promise<unknown>;
  toFileUrl?: (path: string, sessionId: string) => string | Promise<string>;
  toHtmlPreviewUrl?: (path: string, sessionId: string, scopeRoot: string) => string | Promise<string>;
  toWidgetUrl?: (path: string, sessionId: string, scopeRoot: string) => string | Promise<string>;
  widgetSnapshot?: (sessionId: string, widgetId: string, revision: number, path: string) => Promise<{ path: string; root: string; currentRevision: number }>;
  /** The same read authority used by klaus-media for images, audio, video and PDFs. */
  mediaScope?: (path: string, sessionId: string) => Promise<boolean>;
  /**
   * Whether this conversation produced, read or explicitly selected this exact path. Consulted
   * only by the PREVIEW scope: a deliverable the agent wrote outside its roots
   * (a cover image in ~/Downloads, a page under .klaus/) is still a file this
   * conversation owns, and refusing to show it back is what made the user open
   * it by hand. Editing and listing stay root-scoped — this widens nothing
   * writable, and it is one exact path, never a directory.
   */
  producedBySession?: (path: string, sessionId: string) => boolean;
  /** Admit one canonical file selected in the trusted file viewer for preview reads. */
  authorizePreviewPath?: (path: string, sessionId: string) => void;
  log?: (message: string) => void;
  watch?: boolean;
  watchDebounceMs?: number;
  createWatcher?: (root: string, listener: (kind: string, file: string | Buffer | null) => void) => WorkspaceWatcher;
  /** Remote workspace support: file operations over SSH for ssh:// session bindings. */
  sshFiles?: SshFileService;
  /** Which renderer owns the SSH connection a session's remote binding uses. */
  sshOwner?: (sessionId: string) => number | null;
}
interface WatchEntry { root: string; watcher: WorkspaceWatcher; patterns: string[]; timer?: NodeJS.Timeout; changes: Map<string, string> }

export function workspaceExcluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => {
    if (pattern.startsWith('**/')) {
      const rest = pattern.slice(3);
      if (rest.endsWith('/**')) { const name = rest.slice(0, -3); return path.split('/').includes(name) && path.includes(name + '/'); }
      return path.split('/').at(-1) === rest;
    }
    return pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -3)) : path === pattern;
  });
}
export function decodeWorkspacePreview(buffer: Buffer): { content: string; binary: boolean; encoding: string } {
  let encoding = 'utf8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf16le';
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf16be';
  else {
    let le = true, be = true, zero = false;
    for (let i = 0; i < Math.min(buffer.length, 512); i++) {
      const isZero = buffer[i] === 0, odd = i % 2 === 1; zero ||= isZero;
      if ((odd && !isZero) || (!odd && isZero)) le = false;
      if ((odd && isZero) || (!odd && !isZero)) be = false;
      if (isZero && !le && !be) break;
    }
    if (zero && !le && !be) return { content: '', binary: true, encoding };
    if (zero) encoding = le ? 'utf16le' : 'utf16be';
  }
  if (encoding === 'utf8') return { content: buffer.toString('utf8'), binary: false, encoding };
  const even = Buffer.from(buffer.subarray(0, buffer.length - buffer.length % 2));
  if (encoding === 'utf16be') even.swap16();
  return { content: even.toString('utf16le').replace(/^\ufeff/, ''), binary: false, encoding };
}
async function readHead(path: string, size: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(size); let offset = 0;
    while (offset < size) { const result = await file.read(buffer, offset, size - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}
function validBasename(name: string): boolean {
  return Boolean(name.trim()) && Buffer.byteLength(name.trim()) <= 255 && !/[/\\\0]/.test(name) && name !== '.' && name !== '..';
}

/** Async disk I/O and bounded, disposable workspace watchers. No engine process ownership. */
export class FileService {
  private closed = false;
  private readonly searchSnapshots = new Map<string, { key: string; created: number; promise: Promise<{ hits: JsonObject[]; truncated: boolean }> }>();
  private readonly watchers = new Map<string, WatchEntry>();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private readonly remoteWrites = new Map<string, Map<string, { added: number | null; removed: number | null }>>();
  private readonly unlisten: () => void;
  constructor(private readonly deps: FileDeps) { this.unlisten = deps.workspaces.onInvalidated(id => this.stopWatching(id)); }
  private async run(payload: JsonObject, operation: () => Promise<Json>): Promise<Json> {
    if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The file service is closed');
    try {
      return await this.deps.workspaces.withDirectoryOperation(async () => {
        const roots: string[] = [], id = string(payload.sessionId), file = string(payload.filePath);
        if (id) roots.push(this.deps.workspaces.resolveSessionDirectory(id), ...this.deps.workspaces.extraRoots(id));
        if (file && !file.includes('\0') && isAbsolute(file)) {
          roots.push(file);
          const name = string(payload.newName).trim(); if (validBasename(name)) roots.push(join(dirname(file), name));
        }
        return roots;
      }, async () => {
        if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The file service is closed');
        return operation();
      });
    } catch (error) {
      if (error instanceof IpcHandlerError) throw error;
      return { error: errorMessage(error) };
    }
  }
  private patterns(): string[] {
    const value = kvGet('workspace.excludes', this.deps.workspaces.configRoot);
    if (isFailure(value)) throw new IpcHandlerError(value.code, value.message);
    try {
      const parsed: unknown = JSON.parse(value ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [];
    } catch { return []; }
  }
  private async checked(payload: JsonObject, preview = false): Promise<{ root: string; scopeRoot: string; path: string; realPath: string; sessionId: string }> {
    const sessionId = string(payload.sessionId), path = string(payload.filePath);
    if (!sessionId) throw new FileRefusal(preview ? 'invalid path' : 'invalid sessionId');
    if (!path || path.includes('\0') || !isAbsolute(path)) throw new FileRefusal('invalid path');
    const root = await this.deps.workspaces.sessionDirectory(sessionId), configRoot = this.deps.workspaces.configRoot;
    // Every folder the session's workspace spans is in scope; a plain session
    // has exactly one.
    const roots = [root, ...this.deps.workspaces.extraRoots(sessionId)];
    if (preview) {
      roots.push(join(configRoot, 'uploads'));
      // Stored large pastes reopen through the same preview surface as uploads.
      roots.push(join(configRoot, 'pasted-text'));
      if (path.endsWith('.digram.json')) roots.push(join(configRoot, 'digram'));
      // The conversation's own visualization directory: the
      // whitelist surface for `::klaus-inline-vis` pages. Containment here is
      // by RAW path (the declared shape); the shared projection read
      // (services/inline-vis-read.ts) re-checks with real paths, where a
      // symlink planted inside the directory dies.
      if (pathInside(path, sessionVisualizationsDir(configRoot, sessionId))) roots.push(sessionVisualizationsDir(configRoot, sessionId));
    }
    const scopeError = preview ? 'path outside preview scope' : 'path outside session workspace';
    const allowed = roots.filter(candidate => pathInside(path, candidate));
    let recordedOnly = false;
    const sharedMedia = preview && READONLY_EXTENSIONS.has(extname(path).slice(1).toLowerCase()) ? this.deps.mediaScope : undefined;
    // A file this conversation itself produced but outside its roots is still
    // showable — see `producedBySession`. Listing stays root-scoped; reading
    // and writing share the preview scope, so everything the panel can open
    // as text is exactly what a save can commit.
    if (!allowed.length && preview && this.deps.producedBySession?.(resolve(path), sessionId)) {
      // The HTML preview is a DIRECTORY capability, so it needs a root to bound
      // the token; the file's own directory is the tightest honest one. This
      // widens nothing by itself: every request through the token is re-checked
      // against the session scope (media-files.ts respond), and the ledger is
      // per-FILE, so a sibling in that directory is served only if the
      // conversation also wrote that sibling. A self-contained page previews in
      // full, and a multi-file page previews as far as its own written assets go.
      allowed.push(dirname(resolve(path)));
      recordedOnly = true;
    }
    if (!allowed.length && !sharedMedia) throw new FileRefusal(scopeError);
    let realPath: string;
    try { realPath = await realpath(path); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new FileRefusal('file not found');
      throw error;
    }
    if (recordedOnly && !this.deps.producedBySession?.(realPath, sessionId)) throw new FileRefusal(scopeError);
    if (sharedMedia) {
      if (!await sharedMedia(realPath, sessionId)) throw new FileRefusal(scopeError);
      // These file types use a single-file capability, so no HTML directory
      // capability is derived from this fallback root.
      return { root, scopeRoot: dirname(realPath), path: resolve(path), realPath, sessionId };
    }
    let scopeRoot: string | undefined;
    for (const candidate of allowed) {
      try { if (pathInside(realPath, await realpath(candidate))) { scopeRoot = candidate; break; } } catch { /* Missing optional roots grant no access. */ }
    }
    if (!scopeRoot) throw new FileRefusal(scopeError);
    return { root, scopeRoot, path: resolve(path), realPath, sessionId };
  }
  private changed(sessionId: string, events: Json[]): void {
    this.searchSnapshots.delete(sessionId);
    if (!this.closed) this.deps.push('chat:event', { type: 'workspace:changed', sessionId, events });
  }
  /** Check the revision and write under one queue, including aliases of the same file. */
  private async serializeWrite(key: string, operation: () => Promise<Json>): Promise<Json> {
    const previous = this.pendingWrites.get(key) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    this.pendingWrites.set(key, pending);
    await previous;
    try {
      if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The file service is closed');
      return await operation();
    } finally {
      release();
      if (this.pendingWrites.get(key) === pending) this.pendingWrites.delete(key);
    }
  }
  private writeRevisionMismatch(payload: JsonObject, mtimeMs: number): boolean {
    return payload.force !== true && typeof payload.expectedMtimeMs === 'number' && payload.expectedMtimeMs !== mtimeMs;
  }
  private validWriteOptions(payload: JsonObject): boolean {
    return (payload.expectedMtimeMs == null || typeof payload.expectedMtimeMs === 'number' && Number.isFinite(payload.expectedMtimeMs) && payload.expectedMtimeMs >= 0)
      && (payload.force == null || typeof payload.force === 'boolean');
  }
  /** The remote binding and owning renderer for this session, when the file service can serve it. */
  private remoteOf(payload: JsonObject): { workdir: SshWorkdir; senderId: number } | null {
    if (!this.deps.sshFiles) return null;
    const sessionId = string(payload.sessionId);
    if (!sessionId) return null;
    const workdir = this.deps.workspaces.remoteBinding(sessionId);
    if (!workdir) return null;
    const senderId = this.deps.sshOwner?.(sessionId) ?? null;
    if (senderId == null) return null;
    return { workdir, senderId };
  }
  /** One remote round trip per expanded directory; deeper levels load on demand. */
  private async remoteList(remote: { workdir: SshWorkdir; senderId: number }, requested: string): Promise<Json> {
    const { workdir, senderId } = remote, files = this.deps.sshFiles!;
    const directory = requested ? containRemote(workdir.path, requested) : workdir.path;
    const patterns = this.patterns();
    const segments = relative(workdir.path, directory).replaceAll('\\', '/').split('/').filter(Boolean);
    if (segments.some((_, index) => workspaceExcluded(segments.slice(0, index + 1).join('/'), patterns))) return { error: 'directory is excluded' };
    const { nodes, truncated } = await files.listDir(senderId, workdir, directory);
    const tree: JsonObject[] = [];
    for (const node of nodes) {
      if (workspaceExcluded(relative(workdir.path, node.path).replaceAll('\\', '/'), patterns)) continue;
      tree.push({ name: node.name, path: node.path, isDir: node.isDir, mtimeMs: node.mtimeMs,
        ...(node.isDir ? { children: [], childrenLoaded: false, truncated: false } : { size: node.size }) });
    }
    return { root: workdir.path, roots: [workdir.path], directory, tree, childrenLoaded: true, truncated, remote: true };
  }
  private async remoteRead(remote: { workdir: SshWorkdir; senderId: number }, payload: JsonObject): Promise<Json> {
    const checked = await this.remoteChecked(remote, payload, true);
    const info = await this.deps.sshFiles!.stat(remote.senderId, remote.workdir, checked);
    if (!info?.isFile) return { error: 'not a file' };
    const { content, size, complete } = await this.deps.sshFiles!.read(remote.senderId, remote.workdir, checked, 0, REMOTE_PREVIEW_LIMIT);
    const preview = decodeWorkspacePreview(content);
    return { filePath: checked, fileName: basename(checked), size, mtimeMs: info.mtimeMs, truncated: !complete, readonly: false, remote: true, ...preview };
  }
  private remoteChecked(remote: { workdir: SshWorkdir; senderId: number }, payload: JsonObject, preview: boolean): Promise<string> {
    const path = string(payload.filePath);
    if (!path || path.includes('\0') || !path.startsWith('/')) return Promise.reject(new FileRefusal('invalid path'));
    const contained = containRemote(remote.workdir.path, path);
    const rel = relative(remote.workdir.path, contained).replaceAll('\\', '/');
    if (preview) return Promise.resolve(contained);
    const patterns = [...BASE_WORKSPACE_EXCLUDES, ...this.patterns()];
    if (workspaceExcluded(rel, patterns)) return Promise.reject(new FileRefusal('path outside session workspace'));
    return Promise.resolve(contained);
  }
  private async remoteWrite(remote: { workdir: SshWorkdir; senderId: number }, payload: JsonObject): Promise<Json> {
    const checked = await this.remoteChecked(remote, payload, false);
    if (typeof payload.content !== 'string') return { error: 'invalid content' };
    const buffer = Buffer.from(payload.content, 'utf8');
    if (buffer.length > WRITE_LIMIT) return { error: 'file too large' };
    if (READONLY_EXTENSIONS.has(extname(checked).slice(1).toLowerCase())) return { error: 'file is preview-only' };
    if (!this.validWriteOptions(payload)) return { error: 'invalid write options' };
    const key = `remote:${JSON.stringify(remote.workdir.target)}:${checked}`;
    return this.serializeWrite(key, async (): Promise<Json> => {
      const files = this.deps.sshFiles!;
      const info = await files.stat(remote.senderId, remote.workdir, checked);
      if (!info?.isFile) return { error: 'not a file' };
      const probe = await files.read(remote.senderId, remote.workdir, checked, 0, 512);
      if (decodeWorkspacePreview(probe.content).binary) return { error: 'file seems to be binary' };
      if (this.writeRevisionMismatch(payload, info.mtimeMs)) {
        const current = await files.read(remote.senderId, remote.workdir, checked, 0, WRITE_LIMIT);
        return { ok: false, error: 'file changed on disk', conflict: true, content: decodeWorkspacePreview(current.content).content,
          mtimeMs: info.mtimeMs, truncated: !current.complete, remote: true };
      }
      await files.write(remote.senderId, remote.workdir, checked, buffer);
      const saved = await files.stat(remote.senderId, remote.workdir, checked);
      this.recordRemoteWrite(string(payload.sessionId), checked);
      this.changed(string(payload.sessionId), [{ kind: 'change', path: checked, isDir: false }]);
      return { ok: true, path: checked, mtimeMs: saved?.mtimeMs ?? info.mtimeMs, remote: true };
    });
  }
  /** The engine's change ledger only sees its local scratch; remote writes join the panel from this log. */
  private recordRemoteWrite(sessionId: string, path: string): void {
    let session = this.remoteWrites.get(sessionId);
    if (!session) { session = new Map(); this.remoteWrites.set(sessionId, session); }
    if (session.size < 500) session.set(path, { added: null, removed: null });
  }
  private async remoteRename(remote: { workdir: SshWorkdir; senderId: number }, payload: JsonObject): Promise<Json> {
    const checked = await this.remoteChecked(remote, payload, false), name = string(payload.newName).trim();
    if (!validBasename(name)) return { error: 'invalid name' };
    if (checked === remote.workdir.path) return { error: 'path outside session workspace' };
    const target = await this.deps.sshFiles!.rename(remote.senderId, remote.workdir, checked, name);
    this.changed(string(payload.sessionId), [{ kind: 'change', path: checked, isDir: false }, { kind: 'change', path: target, isDir: false }]);
    return { ok: true, path: target };
  }
  private async remoteDelete(remote: { workdir: SshWorkdir; senderId: number }, payload: JsonObject): Promise<Json> {
    const checked = await this.remoteChecked(remote, payload, false);
    if (checked === remote.workdir.path) return { error: 'path outside session workspace' };
    await this.deps.sshFiles!.remove(remote.senderId, remote.workdir, checked);
    this.changed(string(payload.sessionId), [{ kind: 'delete', path: checked }]);
    return { ok: true, path: checked };
  }

  async search(payload: JsonObject): Promise<Json> {
    if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The file service is closed');
    const sessionId = string(payload.sessionId), query = string(payload.query).trim().toLowerCase();
    if (!sessionId) return { error: 'invalid sessionId' };
    if (!query) return { hits: [], truncated: false };
    const root = await this.deps.workspaces.sessionDirectory(sessionId);
    const key = JSON.stringify([root, this.deps.workspaces.extraRoots(sessionId), this.patterns()]);
    let snapshot = this.searchSnapshots.get(sessionId);
    if (!snapshot || snapshot.key !== key || Date.now() - snapshot.created > 10000) {
      snapshot = { key, created: Date.now(), promise: this.fileSearchSnapshot(sessionId) };
      this.searchSnapshots.set(sessionId, snapshot);
      if (this.searchSnapshots.size > 4) this.searchSnapshots.delete(this.searchSnapshots.keys().next().value!);
      const current = snapshot;
      snapshot.promise.then(() => { current.created = Date.now(); }, () => { if (this.searchSnapshots.get(sessionId) === current) this.searchSnapshots.delete(sessionId); });
    }
    const { hits, truncated } = await snapshot.promise;
    const remote = this.remoteOf(payload);
    const searchRoots = (remote ? [remote.workdir.path] : [root, ...this.deps.workspaces.extraRoots(sessionId)])
      .map(path => path.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '')).sort((a, b) => b.length - a.length);
    const score = (hit: JsonObject): number => {
      const name = string(hit.name).toLowerCase(), absolute = string(hit.rel).replaceAll('\\', '/').toLowerCase();
      const owner = searchRoots.find(path => absolute.startsWith(path + '/'));
      const path = owner === undefined ? name : absolute.slice(owner.length + 1);
      if (name === query) return 0;
      if (name.includes(query)) return 1;
      if (path.includes(query)) return 2;
      let offset = 0;
      for (const letter of query.replaceAll(' ', '')) { const index = path.indexOf(letter, offset); if (index < 0) return -1; offset = index + 1; }
      return 3;
    };
    return { hits: hits.map(hit => ({ hit, rank: score(hit) })).filter(row => row.rank >= 0)
      .sort((a, b) => a.rank - b.rank || string(a.hit.rel).localeCompare(string(b.hit.rel))).map(row => row.hit), truncated };
  }
  /** The browser and its filter enumerate the same bounded, root-scoped file set. */
  private async fileSearchSnapshot(sessionId: string): Promise<{ hits: JsonObject[]; truncated: boolean }> {
    const first = object(await this.list({ sessionId }));
    if (first.error || !Array.isArray(first.tree)) throw new IpcHandlerError('WORKSPACE_UNAVAILABLE', string(first.error) || 'Workspace unavailable');
    if (!first.remote) {
      const roots = Array.isArray(first.roots) ? first.roots.map(value => string(value)) : [string(first.root)];
      return this.deps.workspaces.withDirectoryOperation(async () => roots, () => this.localFileSearchSnapshot(roots));
    }
    const pending: JsonObject[] = first.tree.map(object), hits: JsonObject[] = [], seen = new Set<string>();
    const deadline = Date.now() + 15000;
    let truncated = first.truncated === true;
    let cursor = 0;
    while (cursor < pending.length && !this.closed) {
      if (hits.length >= 20000 || Date.now() >= deadline) { truncated = true; break; }
      const node = pending[cursor++]!, path = string(node.path);
      hits.push({ rel: path, name: string(node.name), isDir: node.isDir === true });
      if (!node.isDir) continue;
      const identity = first.remote ? path : await realpath(path).catch(() => path);
      if (seen.has(identity)) continue;
      seen.add(identity);
      const children = object(await this.list({ sessionId, filePath: path }));
      if (children.error || !Array.isArray(children.tree)) { truncated = true; continue; }
      truncated ||= children.truncated === true;
      pending.push(...children.tree.map(object));
    }
    return { hits, truncated };
  }
  private async localFileSearchSnapshot(roots: string[]): Promise<{ hits: JsonObject[]; truncated: boolean }> {
    const hits: JsonObject[] = [], patterns = this.patterns(), seen = new Set<string>();
    const pending: { path: string; root: string; realRoot: string }[] = [];
    let truncated = false, pathBytes = 0;
    const deadline = Date.now() + 15000;
    const limited = () => this.closed || hits.length >= 200000 || pathBytes >= 32 * 1024 * 1024 || Date.now() >= deadline;
    const add = (path: string, isDir: boolean) => {
      pathBytes += Buffer.byteLength(path);
      hits.push({ rel: path, name: basename(path), isDir });
    };
    for (const [index, root] of roots.entries()) {
      try {
        pending.push({ path: root, root, realRoot: await realpath(root) });
        if (index > 0) add(root, true);
      } catch { truncated = true; }
    }
    while (pending.length && !limited()) {
      const batch = pending.splice(0, 16);
      await Promise.all(batch.map(async directory => {
        try {
          const identity = await realpath(directory.path);
          if (!pathInside(identity, directory.realRoot) || seen.has(identity)) return;
          seen.add(identity);
          for await (const entry of await opendir(directory.path, { bufferSize: 256 })) {
            if (limited()) { truncated = true; break; }
            const path = join(directory.path, entry.name);
            if (workspaceExcluded(relative(directory.root, path).replaceAll('\\', '/'), patterns)) continue;
            let isDir = entry.isDirectory(), isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
              try {
                const real = await realpath(path);
                if (!pathInside(real, directory.realRoot)) continue;
                const info = await stat(real); isDir = info.isDirectory(); isFile = info.isFile();
              } catch { continue; }
            }
            if (!isDir && !isFile) continue;
            add(path, isDir);
            if (isDir) pending.push({ ...directory, path });
          }
        } catch { truncated = true; }
      }));
    }
    return { hits, truncated: truncated || pending.length > 0 };
  }
  list(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const id = string(payload.sessionId); if (!id) return { error: 'invalid sessionId' };
      const remote = this.remoteOf(payload);
      if (remote) return this.remoteList(remote, string(payload.filePath));
      const root = await this.deps.workspaces.sessionDirectory(id), realRoot = await realpath(root);
      // A workspace session lists every member folder as a top-level node; a
      // plain session lists its own root alone.
      const extra = (await Promise.all(this.deps.workspaces.extraRoots(id).map(async path => {
        try { return { path, real: await realpath(path) }; } catch { return null; }
      }))).filter((entry): entry is { path: string; real: string } => entry !== null);
      const roots = [{ path: root, real: realRoot }, ...extra];
      const patterns = this.patterns();
      const requested = string(payload.filePath);
      const checked = requested ? await this.checked(payload) : null;
      if (requested && !checked) return { error: 'path outside session workspace' };
      // Exclusions are relative to the member folder that owns the request, so
      // a pattern never matches across folder boundaries.
      const owner = checked ? roots.find(candidate => pathInside(checked.path, candidate.path))! : roots[0]!;
      const directory = checked ? checked.path : root;
      const segments = relative(owner.path, directory).replaceAll('\\', '/').split('/').filter(Boolean);
      if (segments.some((_, index) => workspaceExcluded(segments.slice(0, index + 1).join('/'), patterns))) return { error: 'directory is excluded' };
      // Start before the snapshot so mutations during the scan are observable.
      // The watcher stays single-root per session by design; member folders
      // refresh on session switch and manual reload.
      this.startWatching(id, root);
      const seenDirs = new Set<string>(); let count = 0;
      const scan = async (dir: string, depth: number, base: string, realBase: string): Promise<{ tree: JsonObject[]; childrenLoaded: boolean; truncated: boolean }> => {
        if (depth > 0 || count >= 3000) return { tree: [], childrenLoaded: false, truncated: false };
        const realDir = await realpath(dir);
        if (!pathInside(realDir, realBase) || seenDirs.has(realDir)) return { tree: [], childrenLoaded: false, truncated: false };
        seenDirs.add(realDir);
        const candidates: string[] = []; let scanned = 0, truncated = false;
        for await (const entry of await opendir(dir)) {
          if (scanned >= 500 || count >= 3000) { truncated = true; break; }
          scanned++; count++;
          const path = join(dir, entry.name);
          if (!workspaceExcluded(relative(base, path).replaceAll('\\', '/'), patterns)) candidates.push(path);
        }
        const nodes: JsonObject[] = [];
        for (const path of candidates) {
          try {
            const realFile = await realpath(path);
            if (!pathInside(realFile, realBase)) continue;
            const info = await stat(realFile), node = { name: basename(path), path, isDir: info.isDirectory(), mtimeMs: Math.floor(info.mtimeMs) };
            if (info.isDirectory()) {
              const children = await scan(path, depth + 1, base, realBase);
              nodes.push({ ...node, children: children.tree, childrenLoaded: children.childrenLoaded, truncated: children.truncated });
            }
            else if (info.isFile()) nodes.push({ ...node, size: info.size });
          } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        }
        return { tree: nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || string(a.name).toLowerCase().localeCompare(string(b.name).toLowerCase())), childrenLoaded: true, truncated };
      };
      if (checked) {
        // A scoped request lists exactly the requested directory, bounded by
        // the member folder that owns it.
        return { root: owner.path, roots: roots.map(candidate => candidate.path), directory, ...await scan(directory, 0, owner.path, owner.real) };
      }
      const tree: JsonObject[] = [];
      let truncated = false;
      for (const [index, candidate] of roots.entries()) {
        const result = await scan(candidate.path, 0, candidate.path, candidate.real);
        if (index === 0) { tree.push(...result.tree); truncated = result.truncated; }
        else tree.push({ name: basename(candidate.path), path: candidate.path, isDir: true, mtimeMs: 0, children: result.tree, childrenLoaded: result.childrenLoaded, truncated: result.truncated });
        truncated = truncated || result.truncated;
      }
      return { root, roots: roots.map(candidate => candidate.path), directory, tree, childrenLoaded: true, truncated };
    });
  }
  open(payload: JsonObject, reveal = false): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      if (this.remoteOf(payload)) throw new IpcHandlerError('REMOTE_WORKSPACE', 'This file lives on another computer; it cannot be opened by this one’s Finder.');
      const checked = await this.checked(payload, reveal);
      await (reveal ? this.deps.revealPath(checked.path) : this.deps.openPath(checked.path));
      return { ok: true, path: checked.path };
    });
  }
  rename(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const remote = this.remoteOf(payload);
      if (remote) return this.remoteRename(remote, payload);
      const checked = await this.checked(payload), name = string(payload.newName).trim();
      if (!validBasename(name)) return { error: 'invalid name' };
      if (resolve(checked.path) === resolve(checked.root)) return { error: 'path outside session workspace' };
      const target = join(dirname(checked.path), name);
      try {
        const [oldInfo, targetInfo] = await Promise.all([lstat(checked.path), lstat(target)]);
        if (checked.path.toLowerCase() !== target.toLowerCase() || oldInfo.dev !== targetInfo.dev || oldInfo.ino !== targetInfo.ino) return { error: 'target already exists' };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const info = await stat(checked.realPath);
      await rename(checked.path, target);
      this.changed(checked.sessionId, [{ kind: 'unlink', path: checked.path, isDir: info.isDirectory() }, { kind: 'add', path: target, isDir: info.isDirectory() }]);
      return { ok: true, path: target, name };
    });
  }
  delete(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const remote = this.remoteOf(payload);
      if (remote) return this.remoteDelete(remote, payload);
      const checked = await this.checked(payload);
      if (resolve(checked.path) === resolve(checked.root)) return { error: 'cannot delete workspace root' };
      const info = await stat(checked.realPath);
      await this.deps.trashPath(checked.path);
      this.changed(checked.sessionId, [{ kind: 'unlink', path: checked.path, isDir: info.isDirectory() }]); return { ok: true };
    });
  }
  write(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const remote = this.remoteOf(payload);
      if (remote) return this.remoteWrite(remote, payload);
      const checked = await this.checked(payload, true);
      if (typeof payload.content !== 'string') return { error: 'invalid content' };
      if (Buffer.byteLength(payload.content) > WRITE_LIMIT) return { error: 'file too large' };
      if (!(await stat(checked.realPath)).isFile()) return { error: 'not a file' };
      if (READONLY_EXTENSIONS.has(extname(checked.path).slice(1).toLowerCase())) return { error: 'file is preview-only' };
      if (!this.validWriteOptions(payload)) return { error: 'invalid write options' };
      // Capture bytes before queueing; the caller cannot change a pending save.
      const buffer = Buffer.from(payload.content, 'utf8');
      return this.serializeWrite(`local:${checked.realPath}`, async (): Promise<Json> => {
        const file = await open(checked.realPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        let mtimeMs: number;
        try {
          const info = await file.stat(); if (!info.isFile()) return { error: 'not a file' };
          const probe = Buffer.alloc(Math.min(info.size, 512));
          const read = await file.read(probe, 0, probe.length, 0);
          if (decodeWorkspacePreview(probe.subarray(0, read.bytesRead)).binary) return { error: 'file seems to be binary' };
          if (this.writeRevisionMismatch(payload, info.mtimeMs)) {
            const current = Buffer.alloc(Math.min(info.size, WRITE_LIMIT));
            let offset = 0;
            while (offset < current.length) {
              const result = await file.read(current, offset, current.length - offset, offset);
              if (!result.bytesRead) break;
              offset += result.bytesRead;
            }
            return { ok: false, error: 'file changed on disk', conflict: true, content: decodeWorkspacePreview(current.subarray(0, offset)).content,
              mtimeMs: info.mtimeMs, truncated: info.size > WRITE_LIMIT };
          }
          // The editor saves UTF-8 even when the preview detected UTF-16.
          let offset = 0;
          while (offset < buffer.length) { const result = await file.write(buffer, offset, buffer.length - offset, offset); offset += result.bytesWritten; }
          await file.truncate(buffer.length);
          mtimeMs = (await file.stat()).mtimeMs;
        } finally { await file.close(); }
        this.changed(checked.sessionId, [{ kind: 'change', path: checked.path, isDir: false }]);
        return { ok: true, path: checked.path, mtimeMs };
      });
    });
  }
  getExcludes(): Json { return { patterns: this.patterns() }; }
  setExcludes(payload: JsonObject): Json {
    if (!Array.isArray(payload.patterns)) return { error: 'invalid patterns' };
    const patterns = payload.patterns.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
    const saved = kvSet('workspace.excludes', JSON.stringify(patterns), this.deps.workspaces.configRoot);
    if (isFailure(saved)) throw new IpcHandlerError(saved.code, saved.message);
    this.searchSnapshots.clear();
    for (const [sessionId, entry] of this.watchers) {
      entry.patterns = [...BASE_WORKSPACE_EXCLUDES, ...patterns];
      this.deps.push('chat:event', { type: 'workspace:invalidated', sessionId });
    }
    return { ok: true, patterns };
  }
  readArtifact(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const remote = this.remoteOf(payload);
      if (remote) return this.remoteRead(remote, payload);
      const checked = await this.checked(payload, true), info = await stat(checked.realPath);
      if (!info.isFile()) return { error: 'not a file' };
      const preview = decodeWorkspacePreview(await readHead(checked.realPath, Math.min(info.size, PREVIEW_LIMIT)));
      return { filePath: checked.path, fileName: basename(checked.path), size: info.size, mtimeMs: info.mtimeMs, truncated: info.size > PREVIEW_LIMIT,
        readonly: info.size > PREVIEW_LIMIT, ...preview };
    });
  }
  /** A selected file is a single-file read grant, independent of how it was created. */
  authorizeArtifactPreview(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const remote = this.remoteOf(payload);
      if (remote) return { ok: true, filePath: await this.remoteChecked(remote, payload, true) };
      const sessionId = string(payload.sessionId), path = string(payload.filePath);
      if (!sessionId || !path || path.includes('\0') || !isAbsolute(path)) throw new FileRefusal('invalid path');
      await this.deps.workspaces.sessionDirectory(sessionId);
      let canonical: string;
      try { canonical = await realpath(path); } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new FileRefusal('file not found');
        throw error;
      }
      if (!(await stat(canonical)).isFile()) throw new FileRefusal('not a file');
      if (!this.deps.authorizePreviewPath) throw new FileRefusal('preview authorization unavailable');
      this.deps.authorizePreviewPath(canonical, sessionId);
      return { ok: true, filePath: canonical };
    });
  }
  /** Remote media and pages preview through a bounded local cache copy; the copy is per-session and rewritten on every grant. */
  private async remoteArtifactUrl(remote: { workdir: SshWorkdir; senderId: number }, payload: JsonObject): Promise<Json> {
    const checked = await this.remoteChecked(remote, payload, true);
    const info = await this.deps.sshFiles!.stat(remote.senderId, remote.workdir, checked);
    if (!info?.isFile) return { error: 'not a file' };
    if (info.size > REMOTE_PREVIEW_LIMIT) return { error: 'file too large to preview remotely' };
    const { content } = await this.deps.sshFiles!.read(remote.senderId, remote.workdir, checked, 0, PREVIEW_LIMIT);
    const cacheRoot = join(this.deps.workspaces.configRoot, 'remote-previews', string(payload.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_'));
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const key = createHash('sha256').update(checked).digest('hex').slice(0, 16);
    const localPath = join(cacheRoot, `${key}-${basename(checked).replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    await writeFile(localPath, content, { mode: 0o600 });
    const url = /\.(?:html?|xhtml)$/iu.test(checked) ? await this.deps.toHtmlPreviewUrl?.(localPath, string(payload.sessionId), cacheRoot)
      : await this.deps.toFileUrl?.(localPath, string(payload.sessionId));
    return { ok: true, url: url ?? pathToFileURL(localPath).href, remote: true };
  }
  artifactFileUrl(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const remote = this.remoteOf(payload);
      if (remote) return this.remoteArtifactUrl(remote, payload);
      const checked = await this.checked(payload, true);
      if (!(await stat(checked.realPath)).isFile()) return { error: 'not a file' };
      const preview = /\.(?:html?|xhtml)$/iu.test(checked.path) ? this.deps.toHtmlPreviewUrl : undefined;
      const url = await (preview?.(checked.path, checked.sessionId, checked.scopeRoot)
        ?? this.deps.toFileUrl?.(checked.path, checked.sessionId)) ?? pathToFileURL(checked.path).href;
      return { ok: true, url };
    });
  }
  /**
   * A bounded self-contained page for remote clients.
   *
   * The desktop renderer no longer reads pages through this service: history
   * projection carries the content (services/inline-vis-read.ts). Remote
   * clients still ask by path, and they get the SAME one read path, so the
   * whitelist has exactly one implementation.
   */
  inlineVisualizationContent(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const sessionId = string(payload.sessionId), path = string(payload.filePath);
      if (!sessionId) throw new FileRefusal('invalid sessionId');
      if (!path || path.includes('\0') || !isAbsolute(path)) throw new FileRefusal('invalid filePath');
      const fragment = await readInlineVisPage(this.deps.workspaces.configRoot, sessionId, path);
      if (!fragment) throw new FileRefusal('invalid visualization file name');
      if (fragment.contents === null) throw new FileRefusal(fragment.readError ?? 'read refused');
      return { ok: true, sessionId, html: fragment.contents };
    });
  }

  widgetUrl(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const sessionId = string(payload.sessionId), widgetId = string(payload.widgetId), path = string(payload.filePath);
      const revision = payload.revision;
      if (!sessionId || !widgetId || !path || typeof revision !== 'number'
        || !this.deps.widgetSnapshot || !this.deps.toWidgetUrl) throw new FileRefusal('invalid widget request');
      await this.deps.workspaces.sessionDirectory(sessionId);
      const snapshot = await this.deps.widgetSnapshot(sessionId, widgetId, revision, path);
      return { ok: true, url: await this.deps.toWidgetUrl(snapshot.path, sessionId, snapshot.root), currentRevision: snapshot.currentRevision };
    });
  }
  revealArtifact(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const path = string(payload.filePath);
      if (!path || path.includes('\0') || !isAbsolute(path)) return { error: 'invalid filePath' };
      try { await stat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { error: 'file not found' }; throw error;
      }
      await this.deps.revealPath(path); return { ok: true };
    });
  }
  /**
   * Copy a session-scoped file to a user-chosen destination.
   *
   * The inline media player's "save a copy" action: the media capability URL is
   * a renderer-side token the host cannot hand to a save dialog, so the copy
   * happens here, behind the SAME scope check as the preview (a file the
   * conversation neither owns nor produced is not copyable through this
   * surface). The dialog is the host's; a cancelled dialog reports ok:false
   * rather than an error, because "the user changed their mind" is not a
   * failure the card should toast about.
   */
  /**
   * The canonical path of a local file the conversation may preview, or a
   * refusal. Turn-end resource actions (open in an application, reveal,
   * download a copy) act only on what this admits.
   */
  async previewFilePath(sessionId: string, filePath: string): Promise<string> {
    const result = await this.run({ sessionId, filePath }, async (): Promise<Json> => {
      if (this.remoteOf({ sessionId, filePath })) return { error: 'This file lives on another computer.' };
      const checked = await this.checked({ sessionId, filePath }, true);
      if (!(await stat(checked.realPath)).isFile()) return { error: 'not a file' };
      return { ok: true, filePath: checked.realPath };
    });
    const value = result as { ok?: boolean; filePath?: string; error?: string };
    if (value.ok !== true || !value.filePath) throw new IpcHandlerError('FILE_REFUSED', value.error || 'file refused');
    return value.filePath;
  }
  saveArtifactCopy(payload: JsonObject, senderId: number): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      if (!this.deps.saveCopyDialog) return { error: 'save dialog unavailable' };
      const checked = await this.checked(payload, true);
      const info = await stat(checked.realPath);
      if (!info.isFile()) return { error: 'not a file' };
      if (info.size > PREVIEW_LIMIT) return { error: 'file too large to copy' };
      const destination = await this.deps.saveCopyDialog(senderId, basename(checked.path));
      if (!destination) return { ok: false, cancelled: true };
      await copyFile(checked.realPath, destination);
      return { ok: true, filePath: destination };
    });
  }
  openWorkspace(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const id = string(payload.sessionId); if (!id) return { error: 'invalid sessionId' };
      const path = await this.deps.workspaces.sessionDirectory(id); await this.deps.openPath(path); return { ok: true, path };
    });
  }
  openArtifactWindow(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      if (!string(payload.sessionId) || !string(payload.filePath)) return { error: 'invalid args' };
      const checked = await this.checked(payload, true), uploads = join(this.deps.workspaces.configRoot, 'uploads');
      const inWorkspace = pathInside(checked.path, checked.root), inUploads = pathInside(checked.path, uploads);
      // Scope and symlink containment were validated above. Only uploads need
      // a display-named copy; other admitted files preview in their own location.
      let path = checked.path, displayName = typeof payload.displayName === 'string' ? payload.displayName : undefined;
      if (inUploads && !inWorkspace) {
        if (!(await stat(checked.realPath)).isFile()) return { error: 'not a file' };
        const key = basename(path).replace(/[^a-zA-Z0-9._-]/g, '_');
        const candidate = (displayName?.trim() ?? '').split(/[/\\]/).at(-1) ?? '';
        displayName = validBasename(candidate) ? candidate : basename(path);
        const previewRoot = join(checked.root, '.klaus-upload-previews');
        await mkdir(previewRoot, { recursive: true });
        const realRoot = await realpath(checked.root);
        if (!pathInside(await realpath(previewRoot), realRoot)) return { error: 'invalid preview path' };
        const dir = join(previewRoot, key); await mkdir(dir, { recursive: true });
        if (!pathInside(await realpath(dir), realRoot)) return { error: 'invalid preview path' };
        path = join(dir, displayName);
        try { if ((await lstat(path)).isSymbolicLink()) return { error: 'invalid preview path' }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await copyFile(checked.realPath, path);
      }
      await this.deps.openPreviewWindow({ kind: 'artifact', filePath: path, sessionId: checked.sessionId, displayName });
      return inUploads && !inWorkspace ? { ok: true, path } : { ok: true };
    });
  }
  fileChanges(payload: JsonObject): Promise<Json> {
    return this.run(payload, async (): Promise<Json> => {
      const sessionId = string(payload.sessionId);
      if (!sessionId) throw new IpcHandlerError('BAD_REQUEST', 'sessionId required');
      const reply = object(await this.deps.requestSession(sessionId, 'session/fileChanges', {}));
      if (reply.error != null) throw new IpcHandlerError('ENGINE_REQUEST_FAILED', typeof reply.error === 'string' ? reply.error : errorMessage(reply.error));
      if (!Array.isArray(reply.fileChanges)) throw new IpcHandlerError('ENGINE_REPLY_INVALID', 'session/fileChanges did not return fileChanges');
      const root = await this.deps.workspaces.sessionDirectory(sessionId);
      const remote = this.deps.workspaces.remoteBinding(sessionId);
      const remoteFiles = remote ? [...(this.remoteWrites.get(sessionId) ?? new Map()).entries()].map(([path, counts]) => ({
        path, relativePath: pathInside(path, root) && path !== root ? relative(root, path) : path,
        name: path.split(/[/\\]/).at(-1) ?? path, kind: 'remote-write', added: counts.added, removed: counts.removed, turnDiff: null,
      })) : [];
      const turns: Array<{ turnId: Json; stats: { filesCount: number; linesAdded: number | null; linesRemoved: number | null }; files: Array<{ path: string; relativePath: string; name: string; kind: Json; added: number | null; removed: number | null; turnDiff: string | null }> }> = reply.fileChanges.map(raw => {
        const group = object(raw); let added: number | null = 0, removed: number | null = 0;
        const files = (Array.isArray(group.files) ? group.files : []).flatMap(rawFile => {
          const row = object(rawFile), path = string(row.path); if (!path) return [];
          const count = (value: Json | undefined) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
          const plus = count(row.added), minus = count(row.removed);
          added = plus !== null && added !== null && Number.isSafeInteger(plus + added) ? plus + added : null;
          removed = minus !== null && removed !== null && Number.isSafeInteger(minus + removed) ? minus + removed : null;
          return [{ path, relativePath: pathInside(path, root) && path !== root ? relative(root, path) : path,
            name: path.split(/[/\\]/).at(-1) ?? path, kind: row.kind ?? null, added: plus, removed: minus,
            turnDiff: typeof row.turnDiff === 'string' ? row.turnDiff : null }];
        });
        return { turnId: group.turnId ?? null, stats: { filesCount: files.length, linesAdded: added, linesRemoved: removed }, files };
      });
      if (remoteFiles.length) turns.push({ turnId: 'remote-writes', stats: { filesCount: remoteFiles.length, linesAdded: null, linesRemoved: null }, files: remoteFiles });
      return { ok: true, root, turns };
    });
  }
  private startWatching(sessionId: string, root: string): void {
    if (this.closed || this.deps.watch === false) return;
    const old = this.watchers.get(sessionId);
    if (old?.root === root) { this.watchers.delete(sessionId); this.watchers.set(sessionId, old); return; }
    this.stopWatching(sessionId);
    while (this.watchers.size >= 32) this.stopWatching(this.watchers.keys().next().value!);
    try {
      const patterns = [...BASE_WORKSPACE_EXCLUDES, ...this.patterns()];
      let owned: WatchEntry | undefined;
      const create = this.deps.createWatcher ?? ((root, listener) => watch(root, { recursive: true, persistent: false }, listener));
      const watcher = create(root, (kind, file) => {
        if (this.closed || !owned || this.watchers.get(sessionId) !== owned) return;
        // A missing native filename invalidates the whole tree.
        const path = file ? resolve(root, String(file)) : root, entry = owned;
        if (!pathInside(path, root) || workspaceExcluded(relative(root, path).replaceAll('\\', '/'), entry.patterns)) return;
        if (entry.changes.size < 1000) entry.changes.set(path, kind); else entry.changes.set(root, 'rename');
        if (!entry.timer) {
          entry.timer = setTimeout(() => { entry.timer = undefined; void this.flushChanges(sessionId, entry); }, this.deps.watchDebounceMs ?? 75);
          entry.timer.unref();
        }
      });
      watcher.on('error', error => {
        if (!owned || this.watchers.get(sessionId) !== owned) return;
        this.deps.log?.('Workspace watch failed: ' + errorMessage(error)); this.stopWatching(sessionId);
      });
      owned = { root, watcher, patterns, changes: new Map() };
      this.watchers.set(sessionId, owned);
    } catch (error) { this.deps.log?.('Workspace watch unavailable: ' + errorMessage(error)); }
  }
  private async flushChanges(sessionId: string, entry: WatchEntry): Promise<void> {
    const pending = [...entry.changes]; entry.changes.clear();
    try {
      await this.deps.workspaces.withDirectoryOperation(async () => [entry.root, ...pending.map(([path]) => path)], async () => {
        const events: Json[] = [];
        for (const [path, kind] of pending) {
          try {
            const real = await realpath(path);
            if (!pathInside(real, await realpath(entry.root))) continue;
            events.push({ kind: kind === 'change' ? 'change' : 'add', path, isDir: (await stat(real)).isDirectory() });
          } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
              // FSEvents can name the watched root itself, rather than a child.
              // Interpreting that as a deleted child would not refresh an open file.
              if (dirname(path) === entry.root && basename(path) === basename(entry.root)) events.push({ kind: 'change', path: entry.root, isDir: true });
              else events.push({ kind: 'unlink', path, isDir: false });
            }
            else this.deps.log?.('Workspace change read failed: ' + errorMessage(error));
          }
        }
        if (!this.closed && this.watchers.get(sessionId) === entry && events.length) this.changed(sessionId, events);
      });
    } catch (error) {
      if (!(error instanceof IpcHandlerError && error.code === 'DIRECTORY_BUSY')) this.deps.log?.('Workspace change read failed: ' + errorMessage(error));
    }
  }
  /** Uses the same lease as cwd creation so removal cannot race a file request's mkdir. */
  quiesceDirectory(root: string): Promise<() => void> {
    return this.deps.workspaces.quiesceDirectory(root, async roots => {
      for (const [id, entry] of this.watchers) if (await this.deps.workspaces.directoryOverlaps([entry.root], roots)) this.stopWatching(id);
    });
  }
  stopWatching(sessionId: string): void {
    const entry = this.watchers.get(sessionId); if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer); entry.watcher.close(); this.watchers.delete(sessionId);
  }
  watcherCount(): number { return this.watchers.size; }
  close(): void { this.closed = true; this.searchSnapshots.clear(); this.unlisten(); for (const id of this.watchers.keys()) this.stopWatching(id); }
}
