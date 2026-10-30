import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import type { DatabaseSync } from 'node:sqlite';
import type { ManagedWorktreeRecord, WorktreeStorageList, WorktreeStorageSettingsPatch } from '../../contracts/worktree-storage';
import type { Json } from '../ipc/contract';
import type { GitService } from './git';
import { gitError } from './git-process';
import { object, string } from './service-types';
import { withSettingsDb, withSettingsTransaction } from './settings';
import { readWorktreeStorageSettings, writeWorktreeStorageSettings } from './worktree-storage-settings';
import { pathInside, type WorkspaceStore } from './workspaces';

export interface WorktreeStorageDeps {
  configRoot: string;
  git: GitService;
  workspaces: WorkspaceStore;
  /** Reserve the directory until the returned release function is called. */
  beforeRemove(path: string): Promise<void | (() => void)>;
  onRemoved(path: string): void | Promise<void>;
  /** Fresh, complete active catalog, with host working/pinned metadata overlaid. */
  sessionRows(): Promise<Json[]>;
  archiveSession(id: string): Promise<Json>;
  packaged: boolean;
  log(message: string): void;
}

interface Origin { path: string; repo_root: string; git_common_dir: string; created_at: number }
interface Context { path: string; repoRoot: string; common: string; origin?: Origin }
type SnapshotEntry =
  | { type: 'directory'; path: string; mode: number }
  | { type: 'link'; path: string; target: string }
  | { type: 'file'; path: string; mode: number; size: number; blob: string; digest: string };
interface Snapshot {
  version: 2;
  id: string;
  path: string;
  repoRoot: string;
  common: string;
  createdAt: number;
  worktreeCreatedAt: number;
  head: string;
  branch: string;
  ref: string;
  digest: string;
  sharedIndex: string;
  indexDigest: string;
  manifestDigest: string;
  sessions: string[];
  state: 'prepared' | 'removing' | 'removed' | 'complete' | 'failed' | 'restored';
  error?: string;
}

const NEWBORN_MS = 60 * 60 * 1000;
const BATCH_LIMIT = 20;
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function ensureTables(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS managed_worktree_origins (path TEXT PRIMARY KEY, repo_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, created_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS managed_worktree_snapshots (id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL)');
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); }
}
async function syncDirectory(path: string): Promise<void> {
  // Windows does not expose directory fsync through Node's file handles.
  if (process.platform !== 'win32') await syncFile(path);
}
async function writeDurable(path: string, value: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}
/** Hash actual files and links without following links; unsupported entries block deletion. */
async function treeDigest(root: string, sync = false, skipGit = true): Promise<string> {
  const hash = createHash('sha256');
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) { hash.update(JSON.stringify(['link', relative, await readlink(path)])); return; }
    if (info.isDirectory()) {
      hash.update(JSON.stringify(['directory', relative, info.mode & 0o777]));
      for (const name of (await readdir(path)).sort()) {
        if (!relative && skipGit && name === '.git') continue;
        await visit(join(path, name), relative ? relative + '/' + name : name);
      }
      if (sync) await syncDirectory(path);
      return;
    }
    if (!info.isFile()) throw new Error('Cannot snapshot special filesystem entry: ' + path);
    hash.update(JSON.stringify(['file', relative, info.mode & 0o777, info.size]));
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (sync) await syncFile(path);
  }
  await visit(root, ''); return hash.digest('hex');
}
/** Each payload is independently streamed and compressed; no full-sized staging copy is needed. */
async function compressTree(root: string, directory: string): Promise<{ digest: string; manifestDigest: string }> {
  const entries: SnapshotEntry[] = [], blobs = join(directory, 'files');
  await mkdir(blobs, { mode: 0o700 });
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) { entries.push({ type: 'link', path: relative, target: await readlink(path) }); return; }
    if (info.isDirectory()) {
      entries.push({ type: 'directory', path: relative, mode: info.mode & 0o777 });
      for (const name of (await readdir(path)).sort()) {
        if (!relative && name === '.git') continue;
        await visit(join(path, name), relative ? relative + '/' + name : name);
      }
      return;
    }
    if (!info.isFile()) throw new Error('Cannot snapshot special filesystem entry: ' + path);
    const blob = entries.length + '.gz', digest = createHash('sha256'); let size = 0;
    await pipeline(createReadStream(path), async function* (source) {
      for await (const chunk of source) { const bytes = chunk as Buffer; digest.update(bytes); size += bytes.length; yield bytes; }
    }, createGzip({ level: 9 }), createWriteStream(join(blobs, blob), { flags: 'wx', mode: 0o600 }));
    if (size !== info.size) throw new Error('Worktree changed during compression');
    await syncFile(join(blobs, blob));
    entries.push({ type: 'file', path: relative, mode: info.mode & 0o777, size, blob, digest: digest.digest('hex') });
  }
  await visit(root, ''); await syncDirectory(blobs);
  const manifest = JSON.stringify({ version: 1, entries });
  await writeDurable(join(directory, 'files.json'), manifest);
  return { digest: await compressedTreeDigest(directory, entries), manifestDigest: createHash('sha256').update(manifest).digest('hex') };
}
async function readEntries(directory: string, expectedDigest: string): Promise<SnapshotEntry[]> {
  const bytes = await readFile(join(directory, 'files.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw new Error('Snapshot manifest is damaged');
  const manifest = JSON.parse(bytes.toString('utf8')) as { version: number; entries: SnapshotEntry[] };
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error('Invalid snapshot manifest');
  const seen = new Set<string>(), directories = new Set<string>();
  for (const [index, entry] of manifest.entries.entries()) {
    const parts = typeof entry.path === 'string' ? entry.path.split('/') : [];
    const parent = parts.slice(0, -1).join('/');
    if (!parts.length || seen.has(entry.path) || (index === 0 ? entry.path !== '' || entry.type !== 'directory'
      : parts.some(part => !part || part === '.' || part === '..') || parts[0] === '.git'
        || isAbsolute(entry.path) || !pathInside(resolve(directory, entry.path), directory) || !directories.has(parent))
      || (process.platform === 'win32' && entry.path.includes('\\'))) throw new Error('Invalid snapshot entry path');
    seen.add(entry.path);
    if (entry.type === 'directory') directories.add(entry.path);
    else if (entry.type === 'link') { if (typeof entry.target !== 'string' || entry.target.includes('\0')) throw new Error('Invalid snapshot link'); }
    else if (entry.type !== 'file' || entry.blob !== index + '.gz' || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error('Invalid snapshot file');
    if (entry.type !== 'link' && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) throw new Error('Invalid snapshot mode');
  }
  if (!manifest.entries.length) throw new Error('Empty snapshot manifest');
  return manifest.entries;
}
async function compressedTreeDigest(directory: string, entries: SnapshotEntry[]): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of entries) {
    if (entry.type === 'directory') { hash.update(JSON.stringify(['directory', entry.path, entry.mode])); continue; }
    if (entry.type === 'link') { hash.update(JSON.stringify(['link', entry.path, entry.target])); continue; }
    hash.update(JSON.stringify(['file', entry.path, entry.mode, entry.size]));
    const digest = createHash('sha256'); let size = 0;
    await pipeline(createReadStream(join(directory, 'files', entry.blob)), createGunzip(), new Writable({
      write(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > entry.size) { done(new Error('Snapshot payload exceeds its recorded size')); return; }
        hash.update(chunk); digest.update(chunk); done();
      },
    }));
    if (size !== entry.size || digest.digest('hex') !== entry.digest) throw new Error('Snapshot payload is damaged');
  }
  return hash.digest('hex');
}
async function expandTree(directory: string, root: string, entries: SnapshotEntry[]): Promise<void> {
  for (const entry of entries) {
    const path = join(root, entry.path);
    if (entry.type === 'directory') { if (entry.path) await mkdir(path, { mode: 0o700 }); continue; }
    if (entry.type === 'link') { await symlink(entry.target, path); continue; }
    await pipeline(createReadStream(join(directory, 'files', entry.blob)), createGunzip(), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    await chmod(path, entry.mode);
  }
  // Apply restrictive parent permissions only after all of their children exist.
  for (const entry of [...entries].reverse()) if (entry.type === 'directory') await chmod(join(root, entry.path), entry.mode);
}
function timestamp(value: unknown): number {
  const number = Number(value); if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  return typeof value === 'string' ? Date.parse(value) || 0 : 0;
}

/** Storage deletion is independent of the strict, session-bound worktree:remove capability. */
export class WorktreeStorageService {
  private cleanup: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly deps: WorktreeStorageDeps) {}
  private assertOpen(): void { if (this.closed) throw new Error('The worktree storage service is closed'); }
  private origins(): Origin[] {
    return withSettingsDb(this.deps.configRoot, db => { ensureTables(db); return db.prepare('SELECT * FROM managed_worktree_origins').all() as unknown as Origin[]; });
  }
  private async command(root: string, args: string[]): Promise<string> {
    const result = await this.deps.git.process.run(root, args);
    if (result.code !== 0 || result.truncated) throw new Error(gitError(result, 'Git command failed: ' + args[0]));
    return result.stdout.trim();
  }
  async list(): Promise<WorktreeStorageList> {
    this.assertOpen();
    const settings = readWorktreeStorageSettings(this.deps.configRoot), origins = this.origins();
    const found = new Map<string, ManagedWorktreeRecord>();
    const originByPath = new Map(origins.map(row => [resolve(row.path), row]));
    for (const root of new Set([settings.defaultRoot, settings.root].filter(Boolean))) {
      let realRoot: string;
      try { realRoot = await realpath(root); } catch (error) { if (missing(error)) continue; throw error; }
      for (const entry of await readdir(realRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = join(realRoot, entry.name), real = await realpath(path);
        if (dirname(real) !== realRoot) continue;
        const origin = originByPath.get(real), info = await stat(real);
        found.set(real, { path: real, repoRoot: origin?.repo_root ?? null, createdAt: origin?.created_at || Math.round(info.birthtimeMs || info.mtimeMs) });
      }
    }
    // Origins use canonical paths at creation, so a later symlink cannot grant a new directory ownership.
    for (const origin of origins) {
      if (!isAbsolute(origin.path)) throw new Error('Invalid managed worktree origin');
      let info;
      try { info = await lstat(origin.path); } catch (error) { if (missing(error)) continue; throw error; }
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const real = await realpath(origin.path);
      if (real !== resolve(origin.path)) continue;
      found.set(real, { path: real, repoRoot: origin.repo_root, createdAt: origin.created_at });
    }
    return { settings, worktrees: [...found.values()].sort((a, b) => b.createdAt - a.createdAt || a.path.localeCompare(b.path)) };
  }
  async configure(patch: WorktreeStorageSettingsPatch): Promise<{ ok: true; settings: WorktreeStorageList['settings'] }> {
    this.assertOpen(); return { ok: true, settings: writeWorktreeStorageSettings(this.deps.configRoot, patch) };
  }
  private async context(value: string): Promise<Context> {
    this.assertOpen();
    if (!value || value.includes('\0') || !isAbsolute(value)) throw new Error('Not a managed worktree');
    const info = await lstat(value);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Not a managed worktree');
    const path = await realpath(value), inventory = await this.list();
    if (!inventory.worktrees.some(row => row.path === path)) throw new Error('Not a managed worktree');
    const origin = this.origins().find(row => row.path === path);
    const marker = await lstat(join(path, '.git'));
    if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Not a linked worktree');
    const common = await realpath(await this.command(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const output = await this.command(path, ['worktree', 'list', '--porcelain', '-z']);
    const records = output.split('\0\0').filter(Boolean).map(record => record.split('\0'));
    const paths = records.map(record => record.find(line => line.startsWith('worktree '))?.slice(9) ?? '');
    const listed = await Promise.all(paths.map(item => canonical(item)));
    if (!listed.includes(path) || listed[0] === path || records[0]?.includes('bare')) throw new Error('Not a managed linked worktree');
    if (origin && await realpath(origin.git_common_dir) !== common) throw new Error('Managed worktree repository changed');
    const candidates = [origin?.repo_root, ...this.origins().filter(row => row.git_common_dir === common).map(row => row.repo_root), paths[0]];
    for (const candidate of [...new Set(candidates)]) {
      if (!candidate) continue;
      let root: string;
      try { root = await realpath(candidate); } catch (error) { if (missing(error)) continue; throw error; }
      const result = await this.deps.git.process.run(root, ['rev-parse', '--absolute-git-dir']);
      if (result.code !== 0 || result.truncated) continue;
      if (await realpath(result.stdout.trim()) === common && root !== common && !pathInside(root, common)) return { path, common, repoRoot: root, origin };
    }
    throw new Error('Cannot resolve main repository');
  }
  private async owners(path: string): Promise<Array<Record<string, Json>>> {
    const rows = await this.deps.sessionRows();
    if (!Array.isArray(rows)) throw new Error('Incomplete active session catalog');
    const owners: Array<Record<string, Json>> = [];
    for (const value of rows) {
      const row = object(value), id = string(row.id || row.threadId);
      if (!id) throw new Error('Invalid active session catalog row');
      if (row.archived === true) continue;
      const directories = new Set([string(row.cwd), string(row.workdir), this.deps.workspaces.resolveSessionDirectory(id)].filter(Boolean));
      for (const directory of directories) {
        if (directory.startsWith('ssh://')) continue;
        if (!isAbsolute(directory)) throw new Error('Invalid active session working directory');
        if (pathInside(await canonical(directory), path)) { owners.push({ ...row, id }); break; }
      }
    }
    return owners;
  }
  private ownerSignature(rows: Array<Record<string, Json>>): string {
    return JSON.stringify(rows.map(row => [string(row.id), timestamp(row.updatedAt ?? row.updated_at ?? row.createdAt)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  }
  private assertUnprotected(rows: Array<Record<string, Json>>): void {
    for (const row of rows) {
      const metadata = object(row.hostMetadata ?? row.host_metadata);
      if (row.pinned === true || Number(row.sidebarPinnedAt ?? metadata.sidebarPinnedAt) > 0) throw new Error('worktree-pinned');
      if (row.isWorking === true) throw new Error('worktree-in-use');
    }
  }
  private async protectedRoot(path: string): Promise<boolean> {
    // Registry projection performs migrations, so protection reads the durable bindings directly.
    const { active, groups } = withSettingsDb(this.deps.configRoot, db => {
      const get = (key: string) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
      const groups = get('workspace.groups');
      return { active: get('workspace.active_root'), groups: typeof groups === 'string' ? JSON.parse(groups) as unknown : [] };
    });
    const roots = [typeof active === 'string' ? active : ''];
    if (Array.isArray(groups)) for (const group of groups) {
      const entries = object(group).roots;
      if (Array.isArray(entries)) roots.push(...entries.map(entry => string(entry)));
    }
    for (const root of roots.filter(Boolean)) {
      if (root.startsWith('ssh://')) continue;
      const real = await canonical(root);
      if (pathInside(real, path) || pathInside(path, real)) return true;
    }
    return false;
  }
  private snapshotDirectory(id: string): string { return join(this.deps.configRoot, 'worktree-snapshots', id); }
  private async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await writeDurable(join(this.snapshotDirectory(snapshot.id), 'snapshot.json'), JSON.stringify(snapshot, null, 2));
    withSettingsTransaction(this.deps.configRoot, db => {
      ensureTables(db);
      db.prepare('INSERT INTO managed_worktree_snapshots (id, path, created_at, state, record) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, record = excluded.record')
        .run(snapshot.id, snapshot.path, snapshot.createdAt, snapshot.state, JSON.stringify(snapshot));
    });
  }
  private async snapshot(context: Context, owners: Array<Record<string, Json>>): Promise<Snapshot> {
    const id = randomUUID(), directory = this.snapshotDirectory(id);
    if (pathInside(await canonical(directory), context.path)) throw new Error('Snapshot directory is inside the worktree');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await syncDirectory(dirname(directory)); await syncDirectory(this.deps.configRoot);
    const head = await this.command(context.path, ['rev-parse', '--verify', 'HEAD']);
    const branch = await this.command(context.path, ['branch', '--show-current']);
    // This creates objects only. The source index and working files remain untouched.
    const stash = await this.command(context.path, ['stash', 'create']);
    const ref = 'refs/klaus/worktree-storage/' + id;
    await this.command(context.path, ['update-ref', ref, stash || head]);
    const bundle = join(directory, 'history.bundle');
    await this.command(context.path, ['bundle', 'create', bundle, ref]);
    await this.command(context.path, ['bundle', 'verify', bundle]); await syncFile(bundle);
    const index = await this.command(context.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    await copyFile(index, join(directory, 'index')); await syncFile(join(directory, 'index'));
    const sharedPath = await this.command(context.path, ['rev-parse', '--shared-index-path']);
    const sharedIndex = sharedPath ? basename(sharedPath) : '';
    if (sharedIndex) { await copyFile(resolve(context.path, sharedPath), join(directory, sharedIndex)); await syncFile(join(directory, sharedIndex)); }
    const { digest, manifestDigest } = await compressTree(context.path, directory);
    if (await treeDigest(context.path) !== digest) throw new Error('Worktree changed during snapshot');
    const snapshot: Snapshot = { version: 2, id, path: context.path, repoRoot: context.repoRoot, common: context.common, createdAt: Date.now(),
      worktreeCreatedAt: context.origin?.created_at ?? Date.now(), head, branch, ref, digest, sharedIndex,
      indexDigest: createHash('sha256').update(await readFile(join(directory, 'index'))).digest('hex'), manifestDigest, sessions: owners.map(row => string(row.id)), state: 'prepared' };
    await this.saveSnapshot(snapshot); return snapshot;
  }
  async deleteManaged(path: string): Promise<{ ok: true }> { return this.remove(path, false); }
  private async remove(path: string, automatic: boolean, expectedOwners?: string): Promise<{ ok: true }> {
    const initial = await this.context(path);
    this.assertUnprotected(await this.owners(initial.path));
    // Reservations must be acquired before Git's mutex: draining existing readers may need it.
    const release = await this.deps.beforeRemove(initial.path);
    try {
      const result = await this.deps.git.withRepositoryMutation(initial.repoRoot, async (): Promise<Json> => {
        const current = await this.context(initial.path);
        if (current.path !== initial.path || current.repoRoot !== initial.repoRoot || current.common !== initial.common) throw new Error('Worktree changed during removal');
        const owners = await this.owners(current.path); this.assertUnprotected(owners);
        if (automatic) {
          const settings = readWorktreeStorageSettings(this.deps.configRoot), inventory = await this.list();
          const row = inventory.worktrees.find(item => item.path === current.path)!;
          if (expectedOwners !== undefined && this.ownerSignature(owners) !== expectedOwners) throw new Error('Worktree owners changed since cleanup selection');
          if (!this.deps.packaged || !settings.autoCleanupEnabled || inventory.worktrees.length <= settings.keepCount
            || Date.now() - row.createdAt < NEWBORN_MS || await this.protectedRoot(current.path)) throw new Error('Worktree is protected from automatic deletion');
        }
        const snapshot = await this.snapshot(current, owners);
        try {
          // Read again after the durable copy; archive only owners that are still active.
          const fresh = await this.owners(current.path); this.assertUnprotected(fresh);
          snapshot.sessions = [...new Set([...snapshot.sessions, ...fresh.map(owner => string(owner.id))])];
          await this.saveSnapshot(snapshot);
          for (const owner of fresh) {
            this.assertUnprotected(await this.owners(current.path));
            const archived = object(await this.deps.archiveSession(string(owner.id)));
            if (archived.ok !== true) throw new Error('Failed to archive conversation: ' + string(owner.id) + (archived.error ? ': ' + String(archived.error) : ''));
          }
          const remaining = await this.owners(current.path); this.assertUnprotected(remaining);
          if (remaining.length) throw new Error('Active conversations changed during worktree removal');
          if (automatic && await this.protectedRoot(current.path)) throw new Error('Worktree became a protected root');
          const final = await this.context(current.path);
          if (final.repoRoot !== current.repoRoot || final.common !== current.common || await this.command(final.path, ['rev-parse', 'HEAD']) !== snapshot.head
            || await this.command(final.path, ['branch', '--show-current']) !== snapshot.branch
            || await treeDigest(final.path) !== snapshot.digest) throw new Error('Worktree changed after snapshot');
          const index = await this.command(final.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
          if (!(await readFile(index)).equals(await readFile(join(this.snapshotDirectory(snapshot.id), 'index')))) throw new Error('Worktree index changed after snapshot');
          snapshot.state = 'removing'; await this.saveSnapshot(snapshot);
          await this.command(current.repoRoot, ['worktree', 'remove', '--force', current.path]);
          snapshot.state = 'removed'; await this.saveSnapshot(snapshot);
          await this.deps.onRemoved(current.path);
          withSettingsTransaction(this.deps.configRoot, db => { ensureTables(db); db.prepare('DELETE FROM managed_worktree_origins WHERE path = ?').run(current.path); });
          snapshot.state = 'complete'; await this.saveSnapshot(snapshot);
          return { ok: true };
        } catch (error) {
          snapshot.state = 'failed'; snapshot.error = message(error);
          try { await this.saveSnapshot(snapshot); } catch (saveError) { this.deps.log('worktree-snapshot-save-failed: ' + message(saveError)); }
          throw error;
        }
      });
      if (object(result).ok !== true) throw new Error('Worktree removal failed');
      return { ok: true };
    } finally { release?.(); }
  }
  private savedSnapshot(path: string): unknown {
    return withSettingsDb(this.deps.configRoot, db => {
      ensureTables(db);
      return db.prepare('SELECT record FROM managed_worktree_snapshots WHERE path = ? ORDER BY created_at DESC LIMIT 1').get(resolve(path))?.record;
    });
  }
  /** Locate the working copy retained for an archived owner without changing it. */
  async snapshotForSession(sessionId: string): Promise<{ path: string; repoRoot: string } | null> {
    this.assertOpen();
    const saved = withSettingsDb(this.deps.configRoot, db => {
      ensureTables(db);
      return db.prepare("SELECT s.record FROM managed_worktree_snapshots s WHERE EXISTS (SELECT 1 FROM json_each(s.record, '$.sessions') owners WHERE owners.value = ?) ORDER BY s.created_at DESC LIMIT 1").get(sessionId)?.record;
    });
    if (typeof saved !== 'string') return null;
    const snapshot = JSON.parse(saved) as Snapshot;
    if (snapshot.version !== 2 || typeof snapshot.path !== 'string' || typeof snapshot.repoRoot !== 'string' || !isAbsolute(snapshot.path) || !isAbsolute(snapshot.repoRoot)) throw new Error('Invalid saved worktree identity');
    return { path: snapshot.path, repoRoot: snapshot.repoRoot };
  }
  /** Resume callers must leave the existing gone behavior intact when this returns false. */
  async hasSnapshot(path: string): Promise<boolean> {
    this.assertOpen(); return typeof this.savedSnapshot(path) === 'string';
  }
  /** Restore a saved copy before resuming its chat; call only after hasSnapshot returns true. */
  async restore(path: string): Promise<{ ok: true; path: string }> {
    this.assertOpen();
    const saved = this.savedSnapshot(path);
    if (typeof saved !== 'string') throw new Error('No saved worktree snapshot');
    const snapshot = JSON.parse(saved) as Snapshot;
    if (snapshot.version !== 2) throw new Error('Unsupported worktree snapshot version');
    await this.deps.git.withRepositoryMutation(snapshot.repoRoot, async (): Promise<Json> => {
      if (await exists(snapshot.path)) throw new Error('Restore path already exists');
      if (await canonical(snapshot.path) !== snapshot.path || await realpath(snapshot.common) !== snapshot.common) throw new Error('Snapshot path changed');
      const common = await realpath(await this.command(snapshot.repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      if (common !== snapshot.common) throw new Error('Snapshot repository changed');
      const directory = this.snapshotDirectory(snapshot.id);
      const entries = await readEntries(directory, snapshot.manifestDigest);
      if (await compressedTreeDigest(directory, entries) !== snapshot.digest
        || createHash('sha256').update(await readFile(join(directory, 'index'))).digest('hex') !== snapshot.indexDigest) throw new Error('Snapshot files are damaged');
      await this.command(snapshot.repoRoot, ['bundle', 'verify', join(directory, 'history.bundle')]);
      await this.command(snapshot.repoRoot, ['fetch', '--no-tags', join(directory, 'history.bundle'), snapshot.ref + ':' + snapshot.ref]);
      let args: string[];
      if (snapshot.branch) {
        const existing = await this.deps.git.process.run(snapshot.repoRoot, ['show-ref', '--verify', '--hash', 'refs/heads/' + snapshot.branch]);
        if (existing.code === 0 && existing.stdout.trim() !== snapshot.head) throw new Error('Saved branch has moved');
        if (existing.code !== 0 && existing.code !== 1 && existing.code !== 128) throw new Error(gitError(existing, 'Cannot inspect saved branch'));
        args = existing.code === 0 ? ['worktree', 'add', snapshot.path, snapshot.branch] : ['worktree', 'add', '-b', snapshot.branch, snapshot.path, snapshot.head];
      } else args = ['worktree', 'add', '--detach', snapshot.path, snapshot.head];
      await this.command(snapshot.repoRoot, args);
      for (const name of await readdir(snapshot.path)) if (name !== '.git') await rm(join(snapshot.path, name), { recursive: true, force: true });
      await expandTree(directory, snapshot.path, entries);
      const index = await this.command(snapshot.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
      await copyFile(join(directory, 'index'), index);
      if (snapshot.sharedIndex) await copyFile(join(directory, snapshot.sharedIndex), join(dirname(index), snapshot.sharedIndex));
      if (await treeDigest(snapshot.path) !== snapshot.digest) throw new Error('Restored files failed verification');
      withSettingsTransaction(this.deps.configRoot, db => {
        ensureTables(db);
        db.prepare('INSERT OR REPLACE INTO managed_worktree_origins (path, repo_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)')
          .run(snapshot.path, snapshot.repoRoot, snapshot.common, snapshot.worktreeCreatedAt);
      });
      snapshot.state = 'restored'; await this.saveSnapshot(snapshot); return { ok: true };
    });
    return { ok: true, path: snapshot.path };
  }
  /** Coalesce triggers into one bounded round; errors are logged and remain observable to callers. */
  scheduleCleanup(): Promise<void> {
    this.assertOpen();
    if (!this.cleanup) {
      this.cleanup = this.cleanupRound().catch(error => { this.deps.log('worktree-cleanup-failed: ' + message(error)); throw error; })
        .finally(() => { this.cleanup = undefined; });
    }
    return this.cleanup;
  }
  private async cleanupRound(): Promise<void> {
    if (!this.deps.packaged) return;
    const inventory = await this.list();
    if (!inventory.settings.autoCleanupEnabled || inventory.worktrees.length <= inventory.settings.keepCount) return;
    const candidates: Array<ManagedWorktreeRecord & { ownerUpdatedAt: number; owned: boolean; owners: string }> = [];
    for (const row of inventory.worktrees) {
      const owners = await this.owners(row.path);
      if (Date.now() - row.createdAt < NEWBORN_MS || await this.protectedRoot(row.path)) continue;
      if (owners.some(owner => owner.isWorking === true || owner.pinned === true || Number(owner.sidebarPinnedAt ?? object(owner.hostMetadata ?? owner.host_metadata).sidebarPinnedAt) > 0)) continue;
      candidates.push({ ...row, owned: owners.length > 0, owners: this.ownerSignature(owners), ownerUpdatedAt: Math.max(0, ...owners.map(owner => timestamp(owner.updatedAt ?? owner.updated_at ?? owner.createdAt))) });
    }
    candidates.sort((a, b) => Number(a.owned) - Number(b.owned) || a.ownerUpdatedAt - b.ownerUpdatedAt || a.createdAt - b.createdAt || a.path.localeCompare(b.path));
    let deleted = 0;
    for (const candidate of candidates.slice(0, BATCH_LIMIT)) {
      if (this.closed || deleted >= inventory.worktrees.length - inventory.settings.keepCount) break;
      try { await this.remove(candidate.path, true, candidate.owners); deleted++; }
      catch (error) { this.deps.log('worktree-cleanup-skipped ' + candidate.path + ': ' + message(error)); }
    }
  }
  close(): void { this.closed = true; }
}
