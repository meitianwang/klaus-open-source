import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { settingsDbPath, withSettingsDb, withSettingsTransaction } from './settings';
import { object, string, type JsonObject, type ServicePush } from './service-types';
import { DirectoryLeases } from './directory-leases';
import { splitSshWorkdir, type SshWorkdir } from './ssh-files';
import { isFriendScratchWorkdir } from './friend-directory';
import { managedWorktreeRoot } from './worktree-storage-settings';

export interface WorkspaceGroup { id: string; name: string; roots: string[] }
export interface WorkspaceDeps {
  configRoot?: string;
  isSessionKnown?: (sessionId: string) => boolean | Promise<boolean>;
  onSessionWorkdirChanged: (sessionId: string) => void | Promise<void>;
  /** Called after a group is deleted with `deleteSessions`, so the host can drop the transcripts. */
  onDeleteWorkspaceSessions?: (sessionIds: string[]) => void | Promise<void>;
  push: ServicePush;
  /** Restore a missing managed working copy only when storage owns a saved snapshot. */
  restoreStorageWorkdir?: (path: string) => Promise<void>;
  pickDirectory: () => Promise<string | null>;
  /** Multi-select variant of `pickDirectory`; an empty array means the user cancelled. Defaults to wrapping `pickDirectory`. */
  pickDirectories?: () => Promise<string[]>;
}

export function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')));
}

export function normalizeProjectPath(input: unknown): string | undefined {
  const path = string(input).trim();
  if (!path || path.includes('\0')) return undefined;
  if (path.startsWith('ssh://')) return path;
  if (!isAbsolute(path) && !win32.isAbsolute(path)) return undefined;
  const trimmed = path.replace(/[/\\]+$/, '');
  return /^[a-zA-Z]:$/.test(trimmed) ? win32.parse(path).root : trimmed || '/';
}

function get(db: DatabaseSync, key: string): string | undefined {
  const value = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  return typeof value === 'string' ? value : undefined;
}
function put(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function json(raw: string | undefined): unknown {
  try { return JSON.parse(raw ?? 'null'); } catch { return null; }
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function roots(value: unknown): string[] {
  return [...new Set(strings(value).map(normalizeProjectPath).filter((item): item is string => item !== undefined))];
}
function groups(db: DatabaseSync): WorkspaceGroup[] {
  const value = json(get(db, 'workspace.groups'));
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const row = object(raw), id = string(row.id).trim(), paths = roots(row.roots);
    return id && paths.length ? [{ id, name: string(row.name).trim(), roots: paths }] : [];
  });
}
function ensureTables(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS session_workdirs (session_id TEXT PRIMARY KEY, workdir TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS session_workspaces (session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  // A session's project membership is its own record, independent
  // of the directory the session runs in. A worktree session keeps the worktree
  // path as its cwd while this row pins it to the origin repository's project.
  db.exec('CREATE TABLE IF NOT EXISTS session_project_assignments (session_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, updated_at INTEGER NOT NULL)');
}
function assignmentOf(db: DatabaseSync, sessionId: string): string | undefined {
  const value = db.prepare('SELECT project_root FROM session_project_assignments WHERE session_id = ?').get(sessionId)?.project_root;
  return typeof value === 'string' && value ? value : undefined;
}
function managedWorktreeOrigin(db: DatabaseSync, path: string): string | undefined {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_worktree_origins'").get()) return undefined;
  const value = db.prepare('SELECT repo_root FROM managed_worktree_origins WHERE path = ?').get(path)?.repo_root;
  return typeof value === 'string' && value ? value : undefined;
}
/** One-time cleanup of managed worktree paths that older builds registered as projects. */
function migrateWorktreeProjects(db: DatabaseSync, isManaged: (path: string) => boolean): void {
  if (get(db, 'workspace.worktree_projects_separated.v1') === '1') return;
  const saved = projectState(db);
  const keptRoots = saved.roots.filter(root => !isManaged(root));
  const keptOrder = saved.order.filter(root => !isManaged(root));
  const staleLabels = Object.keys(saved.labels).filter(root => isManaged(root));
  if (keptRoots.length !== saved.roots.length || keptOrder.length !== saved.order.length || staleLabels.length) {
    saved.roots = keptRoots; saved.order = keptOrder;
    for (const root of staleLabels) delete saved.labels[root];
    writeProjectState(db, saved, true);
  }
  if (saved.active && isManaged(saved.active)) put(db, 'workspace.active_root', '');
  put(db, 'workspace.worktree_projects_separated.v1', '1');
}

/**
 * Friendship scratch directories that reached the registry before the bind guard
 * existed: drop them from the registry, the dragged sidebar order and the session
 * assignments that filed conversations under the scratch path. The shared space is
 * a product-owned conversation home, never a project identity.
 */
function migrateFriendHomeProjects(db: DatabaseSync, isFriendHome: (path: string) => boolean): void {
  if (get(db, 'workspace.friend_home_projects_separated.v1') === '1') return;
  ensureTables(db);
  const saved = projectState(db);
  const homes = new Set(saved.roots.filter(isFriendHome));
  for (const key of saved.order) if (isFriendHome(key)) homes.add(key);
  const assigned = db.prepare('SELECT session_id, project_root FROM session_project_assignments').all()
    .map(row => ({ sessionId: string(row.session_id), root: string(row.project_root) }))
    .filter(row => isFriendHome(row.root));
  const activeIsHome = saved.active !== null && isFriendHome(saved.active);
  if (homes.size || assigned.length || activeIsHome) {
    saved.roots = saved.roots.filter(root => !homes.has(root));
    saved.order = saved.order.filter(key => !homes.has(key));
    for (const root of homes) delete saved.labels[root];
    if (activeIsHome) { saved.active = null; put(db, 'workspace.active_root', ''); }
    writeProjectState(db, saved, true);
    put(db, 'workspace.sidebar_project_order', JSON.stringify(sidebarProjectOrder(db).filter(key => !homes.has(key))));
    for (const row of assigned) db.prepare('DELETE FROM session_project_assignments WHERE session_id = ?').run(row.sessionId);
  }
  put(db, 'workspace.friend_home_projects_separated.v1', '1');
}
/** Roots owned by workspace groups: member folders live inside their container. */
function workspaceMemberRoots(db: DatabaseSync): Set<string> {
  return new Set(groups(db).flatMap(group => group.roots));
}
function projectState(db: DatabaseSync) {
  return {
    roots: strings(json(get(db, 'workspace.roots'))),
    order: strings(json(get(db, 'workspace.project_order'))),
    labels: Object.fromEntries(Object.entries(object(json(get(db, 'workspace.labels')))).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    active: get(db, 'workspace.active_root')?.trim() || null,
  };
}

/**
 * The sidebar's Projects-section order, dragged by the user.
 *
 * This row covers MORE than the project registry: the section also holds
 * multi-folder workspace containers (`ws:<id>`) and friend groups
 * (`friend:<id>`), neither of which is a registered root. It is therefore kept
 * as its own row rather than folded into `workspace.project_order`, whose keys
 * are registry paths and which every other host consumer (the project picker,
 * worktree registration, the mobile projection) reads as exactly that.
 *
 * The two rows are written together and kept consistent: the registry order is
 * derived from this one, so the picker lists projects in the order the sidebar
 * shows them. See `projectsReorder`.
 */
function sidebarProjectOrder(db: DatabaseSync): string[] {
  return strings(json(get(db, 'workspace.sidebar_project_order')));
}
function writeProjectState(db: DatabaseSync, saved: ReturnType<typeof projectState>, labels: boolean): void {
  put(db, 'workspace.roots', JSON.stringify(saved.roots));
  put(db, 'workspace.project_order', JSON.stringify(saved.order));
  if (labels) put(db, 'workspace.labels', JSON.stringify(saved.labels));
}

/** The existing one-time cleanup preserves explicitly labelled or independently used projects. */
function migrateMembers(db: DatabaseSync): void {
  if (get(db, 'workspace.project_members_separated.v1') === '1') return;
  ensureTables(db);
  const members = new Set(groups(db).flatMap(group => group.roots));
  if (members.size) {
    const standalone = new Set(db.prepare('SELECT sw.workdir FROM session_workdirs sw LEFT JOIN session_workspaces ws ON ws.session_id = sw.session_id WHERE ws.session_id IS NULL').all().map(row => row.workdir));
    const saved = projectState(db), before = { roots: [...saved.roots], projectOrder: [...saved.order], activeRoot: saved.active };
    saved.roots = saved.roots.filter(root => !members.has(root) || Object.hasOwn(saved.labels, root) || standalone.has(root));
    saved.order = saved.order.filter(root => saved.roots.includes(root));
    if (saved.active && !saved.roots.includes(saved.active)) { saved.active = null; put(db, 'workspace.active_root', ''); }
    if (JSON.stringify(before) !== JSON.stringify({ roots: saved.roots, projectOrder: saved.order, activeRoot: saved.active })) {
      put(db, 'workspace.project_members_separated.backup.v1', JSON.stringify(before));
    }
    writeProjectState(db, saved, false);
  }
  put(db, 'workspace.project_members_separated.v1', '1');
}
function registerProject(db: DatabaseSync, path: string, label?: string): void {
  migrateMembers(db);
  const saved = projectState(db);
  saved.roots = [path, ...saved.roots.filter(root => root !== path)];
  saved.order = [path, ...saved.order.filter(root => root !== path)];
  const cleanLabel = label?.trim();
  if (cleanLabel) saved.labels[path] = cleanLabel;
  writeProjectState(db, saved, Boolean(cleanLabel));
}

/** Owns workspace preferences, never the engine or the lifetime of user folders. */
export class WorkspaceStore {
  readonly configRoot: string;
  private readonly scratch = new Map<string, string>();
  private readonly invalidationListeners = new Set<(sessionId: string) => void>();
  private readonly directoryLeases = new DirectoryLeases();
  private readonly directoryReservations = new Map<symbol, string[]>();
  constructor(private readonly deps: WorkspaceDeps) { this.configRoot = deps.configRoot ?? configRootFrom(); }

  isManagedWorktree(path: string): boolean {
    const roots = [join(this.configRoot, 'worktrees'), managedWorktreeRoot(this.configRoot)];
    if (roots.some(root => resolve(path) !== resolve(root) && pathInside(path, root))) return true;
    return this.readExistingSettings(false, db => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_worktree_origins'").get()) return false;
      return db.prepare('SELECT 1 FROM managed_worktree_origins WHERE path = ?').get(resolve(path)) !== undefined;
    });
  }
  customWorkdir(sessionId: string): string | undefined {
    return withSettingsDb(this.configRoot, db => {
      ensureTables(db);
      const value = db.prepare('SELECT workdir FROM session_workdirs WHERE session_id = ?').get(sessionId)?.workdir;
      return typeof value === 'string' && value ? value : undefined;
    });
  }
  workspaceId(sessionId: string): string | undefined {
    return withSettingsDb(this.configRoot, db => {
      ensureTables(db);
      const value = db.prepare('SELECT workspace_id FROM session_workspaces WHERE session_id = ?').get(sessionId)?.workspace_id;
      return typeof value === 'string' && value ? value : undefined;
    });
  }
  /** Decorate a complete metadata page without opening settings.db per row. */
  decorateSessionRows(rows: Json[], database?: DatabaseSync): Json[] {
    if (!rows.length) return [];
    const decorate = (db: DatabaseSync): Json[] => {
      ensureTables(db);
      const ids = rows.map(row => object(row).id).filter((id): id is string => typeof id === 'string');
      const bindings = new Map(db.prepare(`SELECT s.session_id, d.workdir, w.workspace_id, p.project_root FROM (SELECT value AS session_id FROM json_each(?)) s
        LEFT JOIN session_workdirs d ON d.session_id = s.session_id
        LEFT JOIN session_workspaces w ON w.session_id = s.session_id
        LEFT JOIN session_project_assignments p ON p.session_id = s.session_id`).all(JSON.stringify(ids))
        .map(row => [String(row.session_id), row]));
      const paths = rows.map(row => normalizeProjectPath(object(row).workdir)).filter((path): path is string => Boolean(path)).map(path => resolve(path));
      const origins = new Map(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'managed_worktree_origins'").get()
        ? db.prepare('SELECT path, repo_root FROM managed_worktree_origins WHERE path IN (SELECT value FROM json_each(?))')
          .all(JSON.stringify(paths)).map(row => [String(row.path), row.repo_root]) : []);
      const managedRoots = [join(this.configRoot, 'worktrees'), managedWorktreeRoot(this.configRoot, db)];
      const projectRoots = new Map<string, string | null>();
      return rows.map(row => {
        const value = object(row), id = value.id;
        if (typeof id !== 'string') return row;
        const bound = bindings.get(id);
        const managedSession = normalizeProjectPath(value.workdir) === normalizeProjectPath(join(this.configRoot, 'sessions', id));
        let projectRoot = typeof bound?.project_root === 'string' && bound.project_root ? bound.project_root : null;
        if (!projectRoot && !managedSession && typeof value.workdir === 'string' && value.workdir) {
          const path = normalizeProjectPath(value.workdir);
          if (path) {
            if (!projectRoots.has(path)) {
              const managed = origins.has(resolve(path)) || managedRoots.some(root => resolve(path) !== resolve(root) && pathInside(path, root));
              const root = managed ? origins.get(resolve(path)) : path;
              projectRoots.set(path, typeof root === 'string' && root ? root : null);
            }
            projectRoot = projectRoots.get(path) ?? null;
          }
        }
        return { ...value,
          workdir: typeof bound?.workdir === 'string' && bound.workdir ? bound.workdir : managedSession ? null : value.workdir ?? null,
          workspaceId: typeof bound?.workspace_id === 'string' && bound.workspace_id ? bound.workspace_id : null,
          projectRoot,
        };
      });
    };
    return database ? decorate(database) : withSettingsDb(this.configRoot, decorate);
  }
  workspaceRoots(workspaceId: string): string[] {
    return withSettingsDb(this.configRoot, db => groups(db).find(group => group.id === workspaceId)?.roots ?? []);
  }
  extraRoots(sessionId: string): string[] { return this.workspaceRoots(this.workspaceId(sessionId) ?? '').slice(1); }
  contextNote(sessionId: string): string | undefined {
    const paths = this.workspaceRoots(this.workspaceId(sessionId) ?? '');
    if (paths.length < 2) return undefined;
    return 'You are working in a multi-folder workspace. The current working directory is the primary folder; the other folders below are part of the same workspace and are readable, writable, and searched by default. Use absolute paths to read, edit, or run commands in any of them.\n\nWorkspace folders:\n'
      + paths.map((path, i) => '- ' + path + (i === 0 ? ' (primary, current working directory)' : '') + '\n').join('')
      + '\nFile search (grep/glob) spans every folder above by default; pass an explicit path to narrow the search to one folder.';
  }
  rememberScratchWorkdir(sessionId: string, path: string): void { this.scratch.set(sessionId, path); }
  private readExistingSettings<T>(absent: T, operation: (db: DatabaseSync) => T): T {
    const path = settingsDbPath(this.configRoot);
    try { statSync(path); } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return absent;
      throw error;
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000');
      return operation(db);
    } finally { db.close(); }
  }
  private readCustomWorkdir(sessionId: string): string | undefined {
    return this.readExistingSettings<string | undefined>(undefined, db => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_workdirs'").get()) return undefined;
      const value = db.prepare('SELECT workdir FROM session_workdirs WHERE session_id = ?').get(sessionId)?.workdir;
      return typeof value === 'string' && value ? value : undefined;
    });
  }
  /** Read scope authority without migrations or mkdir while an operation awaits admission. */
  registeredProjectRoots(): string[] {
    return this.readExistingSettings<string[]>([], db => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
      const saved = tables.has('settings') ? projectState(db) : { roots: [], active: null };
      // The Projects registry alone. Session workdir bindings and workspace
      // memberships are separate registries with their own lifetimes; deriving
      // project identity from them made removal of one surface resurrect or
      // erase the other.
      const paths = [...saved.roots, ...(saved.active ? [saved.active] : [])]
        .filter(path => !pathInside(path, join(this.configRoot, 'sessions')) && !this.isManagedWorktree(path));
      return [...new Set(paths.filter(path => !path.startsWith('ssh://') && isAbsolute(path)).map(path => resolve(path)))];
    });
  }
  /** Every root the user explicitly owns: registered projects plus workspace member folders. Extension scopes validate against this, never against session bindings. */
  scopeRoots(): string[] {
    return this.readExistingSettings<string[]>([], db => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
      const saved = tables.has('settings') ? projectState(db) : { roots: [], active: null };
      const paths = [...saved.roots, ...(saved.active ? [saved.active] : []),
        ...(tables.has('settings') ? groups(db).flatMap(group => group.roots) : [])];
      // A managed worktree a session actually runs in stays a writable
      // extension scope (its own cwd) while remaining absent from Projects.
      if (tables.has('session_workdirs')) {
        const members = new Set(tables.has('session_workspaces') ? db.prepare('SELECT session_id FROM session_workspaces').all().map(row => String(row.session_id)) : []);
        const directories = new Set(db.prepare('SELECT session_id,workdir FROM session_workdirs').all()
          .filter(row => !members.has(String(row.session_id))).map(row => String(row.workdir)));
        const managedRoots = [join(this.configRoot, 'worktrees'), ...(tables.has('settings') ? [managedWorktreeRoot(this.configRoot, db)] : [])];
        const origins = new Set(tables.has('managed_worktree_origins')
          ? db.prepare('SELECT path FROM managed_worktree_origins').all().map(row => String(row.path)) : []);
        // Classify distinct directories against this snapshot without opening a
        // settings connection for every historical session binding.
        for (const path of directories) {
          if (origins.has(resolve(path)) || managedRoots.some(root => resolve(path) !== resolve(root) && pathInside(path, root))) paths.push(path);
        }
      }
      const filtered = paths.filter(path => !pathInside(path, join(this.configRoot, 'sessions')));
      return [...new Set(filtered.filter(path => !path.startsWith('ssh://') && isAbsolute(path)).map(path => resolve(path)))];
    });
  }
  /** The roots a session's extensions span: its workspace's member folders, else its own workdir. */
  sessionRoots(sessionId: string): string[] {
    return this.readExistingSettings<string[]>([], db => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
      if (!tables.has('session_workdirs')) return [];
      const workdir = db.prepare('SELECT workdir FROM session_workdirs WHERE session_id = ?').get(sessionId)?.workdir;
      const workspaceId = tables.has('session_workspaces')
        ? db.prepare('SELECT workspace_id FROM session_workspaces WHERE session_id = ?').get(sessionId)?.workspace_id : undefined;
      if (typeof workspaceId === 'string' && workspaceId) {
        const roots = groups(db).find(group => group.id === workspaceId)?.roots;
        if (roots?.length) return roots.map(path => resolve(path));
      }
      return typeof workdir === 'string' && workdir ? [resolve(workdir)] : [];
    });
  }
  /** A live chat owns its managed worktree until the chat is deleted or rebound. */
  sessionsInDirectory(root: string): string[] {
    const bound = this.readExistingSettings<string[]>([], db => {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_workdirs'").get()) return [];
      return db.prepare('SELECT session_id, workdir FROM session_workdirs').all()
        .filter(row => pathInside(String(row.workdir), root))
        .map(row => String(row.session_id));
    });
    return [...new Set([...bound, ...[...this.scratch].filter(([, path]) => pathInside(path, root)).map(([id]) => id)])];
  }
  /** Resolve the binding without creating its cwd, for lease acquisition and cleanup. */
  resolveSessionDirectory(sessionId: string): string {
    if (!sessionId || sessionId.includes('\0')) throw new IpcHandlerError('BAD_REQUEST', 'invalid sessionId');
    return this.readCustomWorkdir(sessionId) ?? (sessionId.startsWith('__')
      ? join(this.configRoot, 'sessions', '__klaus__')
      : this.scratch.get(sessionId) ?? join(this.configRoot, 'sessions', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')));
  }
  /** The SSH target and remote root when this session's binding is remote, else null. */
  remoteBinding(sessionId: string): SshWorkdir | null {
    return splitSshWorkdir(this.resolveSessionDirectory(sessionId));
  }
  /** Local-only consumers refuse remote bindings loudly instead of misreading the URL as a path. */
  requireLocalSessionDirectory(sessionId: string): string {
    const path = this.resolveSessionDirectory(sessionId);
    if (path.startsWith('ssh://')) throw new IpcHandlerError('REMOTE_WORKSPACE', 'This surface does not support remote workspaces yet');
    return path;
  }
  async sessionDirectory(sessionId: string): Promise<string> {
    const path = this.resolveSessionDirectory(sessionId);
    if (path.startsWith('ssh://')) return path;
    await this.deps.restoreStorageWorkdir?.(path);
    return this.withDirectoryOperation(async () => [path], async () => {
      if (this.readCustomWorkdir(sessionId)) {
        let directory;
        try { directory = await stat(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IpcHandlerError('WORKDIR_MISSING', 'This chat’s working directory no longer exists');
          throw error;
        }
        if (!directory.isDirectory()) throw new IpcHandlerError('WORKDIR_MISSING', 'This chat’s working directory is not a directory');
        if (this.isManagedWorktree(path)) {
          try { if (!(await stat(join(path, '.git'))).isFile()) throw new IpcHandlerError('WORKTREE_MISSING', 'This chat’s worktree no longer exists'); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IpcHandlerError('WORKTREE_MISSING', 'This chat’s worktree no longer exists');
            throw error;
          }
        }
        return path;
      }
      await mkdir(path, { recursive: true }); return path;
    });
  }
  withDirectoryOperation<T>(roots: () => Promise<string[]>, operation: () => T | Promise<T>): Promise<T> {
    return this.directoryLeases.run(roots, operation);
  }
  async quiesceDirectory(root: string, drain: (roots: string[]) => void | Promise<void> = () => {}): Promise<() => void> {
    const id = Symbol('workspace-directory');
    try {
      const release = await this.directoryLeases.quiesce(root, async roots => {
        this.directoryReservations.set(id, roots); await drain(roots);
      });
      return () => { this.directoryReservations.delete(id); release(); };
    } catch (error) { this.directoryReservations.delete(id); throw error; }
  }
  directoryOverlaps(paths: string[], roots: string[]): Promise<boolean> { return this.directoryLeases.overlaps(paths, roots); }

  /** Clear durable and scratch references after removal, while its reservation is held. */
  async detachDirectory(root: string): Promise<string[]> {
    const target = resolve(root), canonical = [...new Set([target, ...[...this.directoryReservations.values()].filter(paths => paths.includes(target)).flat()])];
    const snapshot = (db: DatabaseSync) => {
      ensureTables(db);
      return {
        workdirs: db.prepare('SELECT session_id, workdir FROM session_workdirs ORDER BY session_id').all(),
        memberships: db.prepare('SELECT session_id, workspace_id FROM session_workspaces ORDER BY session_id').all(),
        groups: groups(db), projects: projectState(db), scratch: [...this.scratch],
        sidebarOrder: sidebarProjectOrder(db),
      };
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = withSettingsDb(this.configRoot, snapshot), removed = new Set<string>();
      const candidates = [...before.workdirs.map(row => String(row.workdir)), ...before.groups.flatMap(group => group.roots), ...before.projects.roots,
        ...before.projects.order, ...Object.keys(before.projects.labels), ...(before.projects.active ? [before.projects.active] : []), ...before.scratch.map(([, path]) => path)];
      for (const path of [...new Set(candidates)]) if (await this.directoryLeases.overlaps([path], canonical)) removed.add(path);
      const affectedGroups = new Set(before.groups.filter(group => group.roots.some(path => removed.has(path))).map(group => group.id));
      const ids = new Set(before.workdirs.filter(row => removed.has(String(row.workdir))).map(row => String(row.session_id)));
      for (const row of before.memberships) if (affectedGroups.has(String(row.workspace_id))) ids.add(String(row.session_id));
      for (const [id, path] of before.scratch) if (removed.has(path)) ids.add(id);
      const committed = withSettingsTransaction(this.configRoot, db => {
        if (JSON.stringify(snapshot(db)) !== JSON.stringify(before)) return false;
        for (const id of ids) {
          db.prepare('DELETE FROM session_workdirs WHERE session_id = ?').run(id);
          db.prepare('DELETE FROM session_workspaces WHERE session_id = ?').run(id);
          db.prepare('DELETE FROM session_project_assignments WHERE session_id = ?').run(id);
        }
        const keptGroups = before.groups.map(group => ({ ...group, roots: group.roots.filter(path => !removed.has(path)) })).filter(group => group.roots.length);
        if (affectedGroups.size) put(db, 'workspace.groups', JSON.stringify(keptGroups));
        const saved = before.projects;
        saved.roots = saved.roots.filter(path => !removed.has(path)); saved.order = saved.order.filter(path => !removed.has(path));
        for (const path of removed) delete saved.labels[path];
        writeProjectState(db, saved, true);
        // A detached directory also loses its dragged sidebar slot; the row keeps
        // workspace and friend keys, which are not paths and so are unaffected.
        put(db, 'workspace.sidebar_project_order', JSON.stringify(before.sidebarOrder.filter(key => !removed.has(key))));
        if (saved.active && removed.has(saved.active)) put(db, 'workspace.active_root', '');
        return true;
      });
      if (!committed) continue;
      for (const [id, path] of before.scratch) if (removed.has(path)) this.scratch.delete(id);
      const detached = [...ids].sort();
      // Resource cleanup happens after the DB commit. Avoid rebuilding engines in this hook.
      for (const id of detached) {
        for (const listener of this.invalidationListeners) listener(id);
        this.deps.push('chat:event', { type: 'workspace:invalidated', sessionId: id });
      }
      return detached;
    }
    throw new IpcHandlerError('WORKSPACE_BUSY', 'Workspace bindings changed while removing the directory');
  }
  async getWorkdir(payload: JsonObject): Promise<Json> {
    const id = string(payload.sessionId);
    const known = (await this.deps.isSessionKnown?.(id)) || await this.hasTranscript(id);
    return { custom: this.customWorkdir(id) ?? null, hasMessages: known };
  }
  async getResolvedWorkdir(payload: JsonObject): Promise<Json> {
    const id = string(payload.sessionId);
    return { workdir: id ? await this.sessionDirectory(id) : null };
  }
  private async hasTranscript(id: string): Promise<boolean> {
    if (!id || /[/\\\0]/.test(id)) return false;
    const exists = async (path: string) => { try { return (await stat(path)).size > 0; } catch { return false; } };
    try {
      const root = join(this.configRoot, 'projects');
      const dirs = await readdir(root);
      // One project directory accumulates per workdir ever seen, which reaches
      // tens of thousands of entries; a sequential stat per directory made
      // every historical-session open pay seconds inside session:get-workdir.
      // Probe in parallel chunks and stop at the first hit instead.
      for (let i = 0; i < dirs.length; i += 512) {
        const hits = await Promise.all(dirs.slice(i, i + 512).map(dir => exists(join(root, dir, id + '.jsonl'))));
        if (hits.some(hit => hit)) return true;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      for (const file of await readdir(join(this.configRoot, 'sessions'))) {
        if (file.replace(/^\d{10,}-/, '') === id + '.jsonl' && await exists(join(this.configRoot, 'sessions', file))) return true;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return false;
  }

  /** Used by session creation/import before an engine session exists. */
  bindSession(sessionId: string, context: { workdir?: string; workspaceId?: string; projectRoot?: string }): void {
    if (!sessionId) throw new IpcHandlerError('BAD_REQUEST', 'invalid sessionId');
    withSettingsTransaction(this.configRoot, db => {
      ensureTables(db);
      const paths = context.workspaceId ? groups(db).find(group => group.id === context.workspaceId)?.roots : undefined;
      if (context.workspaceId && !paths?.length) throw new IpcHandlerError('BAD_REQUEST', 'unknown workspace');
      const path = paths?.[0] ?? normalizeProjectPath(context.workdir);
      if (!path) throw new IpcHandlerError('BAD_REQUEST', 'invalid dir');
      db.prepare('INSERT INTO session_workdirs (session_id, workdir, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET workdir = excluded.workdir, updated_at = excluded.updated_at').run(sessionId, path, Date.now());
      if (context.workspaceId) {
        db.prepare('INSERT INTO session_workspaces (session_id, workspace_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET workspace_id = excluded.workspace_id, updated_at = excluded.updated_at').run(sessionId, context.workspaceId, Date.now());
      } else {
        db.prepare('DELETE FROM session_workspaces WHERE session_id = ?').run(sessionId);
        // A friendship's shared directory is a product-owned conversation home,
        // not a user project: binding a session there must neither register it
        // into the project registry nor steal the default project for new chats.
        // A workspace member folder is never a bare project: binding an
        // unbound session there must not register it nor steal the default.
        if (!this.isManagedWorktree(path) && !isFriendScratchWorkdir(this.configRoot, path) && !workspaceMemberRoots(db).has(path)) { registerProject(db, path); put(db, 'workspace.active_root', path); }
      }
      // Project membership is locked at bind time and never follows the cwd: a
      // workspace session belongs to no bare project, a managed worktree session
      // belongs to the origin repository, and an explicit projectRoot (passed at
      // creation) wins over inference so the assignment survives later rebinds.
      const explicit = normalizeProjectPath(context.projectRoot);
      const assignment = context.workspaceId ? undefined
        : explicit ?? (this.isManagedWorktree(path) ? managedWorktreeOrigin(db, path)
          : isFriendScratchWorkdir(this.configRoot, path) ? undefined : normalizeProjectPath(path));
      if (assignment) {
        db.prepare('INSERT INTO session_project_assignments (session_id, project_root, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project_root = excluded.project_root, updated_at = excluded.updated_at').run(sessionId, assignment, Date.now());
      } else {
        db.prepare('DELETE FROM session_project_assignments WHERE session_id = ?').run(sessionId);
      }
    });
  }
  forgetSession(sessionId: string): void {
    withSettingsTransaction(this.configRoot, db => {
      ensureTables(db);
      db.prepare('DELETE FROM session_workdirs WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM session_workspaces WHERE session_id = ?').run(sessionId);
      db.prepare('DELETE FROM session_project_assignments WHERE session_id = ?').run(sessionId);
    });
  }
  /** The project a session belongs to, independent of the directory it runs in. */
  projectAssignment(sessionId: string): string | undefined {
    return withSettingsDb(this.configRoot, db => {
      ensureTables(db);
      return assignmentOf(db, sessionId);
    });
  }
  /** Origin repository of a managed worktree path; undefined for anything else. */
  resolveProjectRoot(path: string): string | undefined {
    const normalized = normalizeProjectPath(path);
    if (!normalized) return undefined;
    return withSettingsDb(this.configRoot, db => {
      ensureTables(db);
      if (!this.isManagedWorktree(normalized)) return normalized;
      return managedWorktreeOrigin(db, normalized);
    });
  }
  private async changed(sessionId: string): Promise<void> {
    for (const listener of this.invalidationListeners) listener(sessionId);
    try { await this.deps.onSessionWorkdirChanged(sessionId); }
    finally { this.deps.push('chat:event', { type: 'workspace:invalidated', sessionId }); }
  }
  onInvalidated(listener: (sessionId: string) => void): () => void {
    this.invalidationListeners.add(listener); return () => { this.invalidationListeners.delete(listener); };
  }
  async setWorkdir(payload: JsonObject, assertCurrent?: () => void): Promise<Json> {
    const id = string(payload.sessionId), dir = normalizeProjectPath(payload.dir);
    if (!id) return { error: 'invalid sessionId' };
    if (!dir) return { error: 'invalid dir' };
    return this.withDirectoryOperation(async () => [dir], async () => {
      assertCurrent?.();
      if (!dir.startsWith('ssh://')) {
        const directory = await stat(dir).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IpcHandlerError('WORKDIR_MISSING', 'The selected working directory no longer exists');
          throw error;
        });
        if (!directory.isDirectory()) throw new IpcHandlerError('WORKDIR_MISSING', 'The selected working directory is not a directory');
      }
      this.bindSession(id, { workdir: dir }); await this.changed(id); return { ok: true };
    });
  }
  async clearWorkdir(payload: JsonObject): Promise<Json> {
    const id = string(payload.sessionId); if (!id) return { error: 'invalid sessionId' };
    this.forgetSession(id); await this.changed(id); return { ok: true };
  }
  async setWorkspace(payload: JsonObject): Promise<Json> {
    const id = string(payload.sessionId).trim(), workspaceId = string(payload.workspaceId).trim();
    if (!id) return { error: 'invalid sessionId' };
    if (!workspaceId) return this.clearWorkdir({ sessionId: id });
    const paths = this.workspaceRoots(workspaceId);
    if (!paths.length) return { error: 'unknown workspace' };
    return this.withDirectoryOperation(async () => paths, async () => {
      if (JSON.stringify(this.workspaceRoots(workspaceId)) !== JSON.stringify(paths)) {
        throw new IpcHandlerError('WORKSPACE_CHANGED', 'Workspace folders changed; select the workspace again');
      }
      this.bindSession(id, { workspaceId }); await this.changed(id); return { ok: true };
    });
  }
  async pickWorkdir(): Promise<Json> { return { path: await this.deps.pickDirectory() }; }
  async pickWorkdirs(): Promise<Json> {
    const pick = this.deps.pickDirectories ?? (async () => {
      const one = await this.deps.pickDirectory();
      return one ? [one] : [];
    });
    return { paths: [...new Set(strings(await pick()))] };
  }
  list(): Json {
    return withSettingsTransaction(this.configRoot, db => { migrateMembers(db); return { workspaces: groups(db).map(group => ({ ...group })) }; });
  }
  save(payload: JsonObject): Json {
    const paths = roots(payload.roots);
    if (!paths.length) return { error: 'a workspace needs at least one folder' };
    return withSettingsTransaction(this.configRoot, db => {
      migrateMembers(db);
      const id = string(payload.id).trim() || randomUUID(), name = string(payload.name).trim() || basename(paths[0]!);
      const saved = groups(db), index = saved.findIndex(group => group.id === id), group = { id, name, roots: paths };
      if (index < 0) saved.push(group); else saved[index] = group;
      put(db, 'workspace.groups', JSON.stringify(saved)); return { id, workspaces: saved.map(item => ({ ...item })) };
    });
  }
  delete(payload: JsonObject): Json {
    const id = string(payload.id).trim(); if (!id) return { error: 'invalid id' };
    return withSettingsTransaction(this.configRoot, db => {
      migrateMembers(db);
      const sessionIds = db.prepare('SELECT session_id FROM session_workspaces WHERE workspace_id = ?').all(id).map(row => String(row.session_id));
      const saved = groups(db).filter(group => group.id !== id);
      for (const sessionId of sessionIds) {
        // A deleted group must never strand its sessions: without this the
        // membership row points at a group that no longer exists and the
        // sidebar has no partition left to show the conversation in.
        db.prepare('DELETE FROM session_workspaces WHERE session_id = ?').run(sessionId);
        if (payload.deleteSessions === true) {
          // The user chose to take the conversations with the group; unbinding
          // every durable row here lets the host delete their transcripts.
          db.prepare('DELETE FROM session_workdirs WHERE session_id = ?').run(sessionId);
          db.prepare('DELETE FROM session_project_assignments WHERE session_id = ?').run(sessionId);
        }
      }
      put(db, 'workspace.groups', JSON.stringify(saved));
      // Drop this container's slot from the dragged sidebar order in the same
      // transaction, so a deleted workspace cannot keep a reserved position.
      put(db, 'workspace.sidebar_project_order', JSON.stringify(sidebarProjectOrder(db).filter(key => key !== `ws:${id}`)));
      return { workspaces: saved.map(group => ({ ...group })), deletedSessions: sessionIds };
    });
  }
  projectsList(): Json {
    return withSettingsTransaction(this.configRoot, db => {
      migrateMembers(db); migrateWorktreeProjects(db, path => this.isManagedWorktree(path)); migrateFriendHomeProjects(db, path => isFriendScratchWorkdir(this.configRoot, path)); ensureTables(db);
      const saved = projectState(db), counts = new Map<string, number>(), members = workspaceMemberRoots(db);
      const touch = (path: string, count = 0) => {
        // Friendship scratch homes belong to their friend group, never to the
        // project rows: registry residue from older builds stays invisible
        // instead of resurfacing as a UUID-named row.
        if (!path.trim() || pathInside(path, join(this.configRoot, 'sessions')) || this.isManagedWorktree(path)
          || isFriendScratchWorkdir(this.configRoot, path)) return;
        // Workspace member folders stay inside their container: a registry row
        // left behind for one (the one-time separation cleanup kept members
        // with orphan session bindings) must not render as a bare project.
        if (members.has(path) && !Object.hasOwn(saved.labels, path)) return;
        counts.set(path, (counts.get(path) ?? 0) + count);
      };
      saved.roots.forEach(path => touch(path));
      // Only the explicit registry feeds this list. Deriving projects from
      // unbound session workdirs resurrected directories whose sessions were
      // long deleted (their orphan binding rows outlive the transcript), and
      // promoted workspace member folders to bare projects the user never
      // registered — both invisible to projectsRemove, which only edits the
      // registry, so the row came back on the next read.
      if (saved.active) touch(saved.active);
      const sidebarOrder = sidebarProjectOrder(db);
      const order = sidebarOrder.length ? sidebarOrder : saved.order;
      const paths = [...counts].sort(([a], [b]) => {
        const ar = order.indexOf(a), br = order.indexOf(b);
        return (ar < 0 ? Infinity : ar) - (br < 0 ? Infinity : br) || basename(a).localeCompare(basename(b));
      });
      return { roots: paths.map(([path, conversationCount]) => ({ path, updatedAt: 0, conversationCount,
        ...(Object.hasOwn(saved.labels, path) ? { label: saved.labels[path]! } : {}) })), activeRoot: saved.active, labels: saved.labels,
        sidebarOrder };
    });
  }
  /**
   * Persist the user's drag order for the sidebar's Projects section.
   *
   * `keys` is the section's complete top-to-bottom key list: workspace
   * containers (`ws:<id>`), friend groups (`friend:<id>`) and project paths
   * interleaved exactly as the user left them. The whole list is authoritative,
   * so this rewrites the row rather than moving one entry — a partial write
   * would leave two rows that each claim an order.
   *
   * The registry's own order row is derived from the same drag in the same
   * transaction: only keys that are registered roots become registry entries, so
   * a project row that came from a session's unregistered working directory stays
   * a sidebar fact without silently registering a project. Roots that are
   * registered but absent from the drag keep their previous relative order at the
   * end, so this can never drop one.
   */
  projectsReorder(payload: JsonObject): Json {
    const keys = [...new Set(strings(payload.keys).map(key => key.trim()).filter(Boolean))];
    if (!keys.length) return { error: 'invalid keys' };
    withSettingsTransaction(this.configRoot, db => {
      migrateMembers(db); const saved = projectState(db);
      const dragged = keys
        .map(key => normalizeProjectPath(key))
        .filter((path): path is string => path !== undefined && saved.roots.includes(path));
      const draggedSet = new Set(dragged);
      saved.order = [...dragged, ...saved.order.filter(path => !draggedSet.has(path) && saved.roots.includes(path))];
      writeProjectState(db, saved, false);
      put(db, 'workspace.sidebar_project_order', JSON.stringify(keys));
    });
    return this.projectsList();
  }
  projectsAdd(payload: JsonObject): Json {
    const path = normalizeProjectPath(payload.path); if (!path) return { error: 'invalid path' };
    withSettingsTransaction(this.configRoot, db => registerProject(db, path, string(payload.label)));
    return this.projectsList();
  }
  projectsRemove(payload: JsonObject): Json {
    const path = normalizeProjectPath(payload.path); if (!path) return { error: 'invalid path' };
    withSettingsTransaction(this.configRoot, db => {
      migrateMembers(db); const saved = projectState(db);
      saved.roots = saved.roots.filter(root => root !== path); saved.order = saved.order.filter(root => root !== path);
      delete saved.labels[path]; writeProjectState(db, saved, true);
      // The dragged sidebar order names this row too; leaving it behind would keep
      // a slot reserved for a project that is gone.
      put(db, 'workspace.sidebar_project_order', JSON.stringify(sidebarProjectOrder(db).filter(key => key !== path)));
      if (saved.active === path) put(db, 'workspace.active_root', '');
    });
    return this.projectsList();
  }
  projectsSetActive(payload: JsonObject): Json {
    const raw = payload.path, path = raw == null || raw === '' ? '' : normalizeProjectPath(raw);
    if (path === undefined) return { error: 'invalid path' };
    withSettingsTransaction(this.configRoot, db => {
      migrateMembers(db); migrateWorktreeProjects(db, candidate => this.isManagedWorktree(candidate));
      migrateFriendHomeProjects(db, candidate => isFriendScratchWorkdir(this.configRoot, candidate));
      // A managed worktree is never a project identity: activating one selects
      // its origin repository instead of registering the scratch directory.
      // A friendship scratch home is never one either: activating it keeps the
      // previous default project instead of registering the shared home, which
      // would add a UUID row to the sidebar and hijack new-chat defaults.
      if (path && (isFriendScratchWorkdir(this.configRoot, path) || workspaceMemberRoots(db).has(path))) return;
      const project = path ? (this.isManagedWorktree(path) ? managedWorktreeOrigin(db, path) : path) : '';
      if (project) { registerProject(db, project); put(db, 'workspace.active_root', project); }
      else put(db, 'workspace.active_root', '');
    });
    return this.projectsList();
  }
  /** Map a cwd (possibly a managed worktree) to the project it belongs to. */
  projectsResolveRoot(payload: JsonObject): Json {
    const path = string(payload.path);
    if (!path.trim()) return { root: null };
    return { root: this.resolveProjectRoot(path) ?? null };
  }
}
