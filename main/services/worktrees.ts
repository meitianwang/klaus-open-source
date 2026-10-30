import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Json } from '../ipc/contract';
import { GitService } from './git';
import { gitError } from './git-process';
import { errorMessage, object, string, type JsonObject } from './service-types';
import { pathInside, WorkspaceStore } from './workspaces';
import { withSettingsDb, withSettingsTransaction } from './settings';
import { managedWorktreeRoot, readWorktreeStorageSettings } from './worktree-storage-settings';
import type { DatabaseSync } from 'node:sqlite';

export interface WorktreeDeps {
  git: GitService;
  workspaces: WorkspaceStore;
  openPath: (path: string) => Promise<void>;
  beforeRemove: (path: string) => Promise<void | (() => void)>;
  onRemoved: (path: string) => void | Promise<void>;
}
interface WorktreeContext { path: string; realPath: string; repoRoot: string }
function slug(): string {
  const date = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) + '-'
    + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds()) + '-' + randomBytes(4).toString('hex');
}
function ensureOrigins(db: DatabaseSync): void {
  // Separate git dirs do not retain the main checkout path in worktree list.
  // Keep that host association outside both the git working tree and project registry.
  db.exec('CREATE TABLE IF NOT EXISTS managed_worktree_origins (path TEXT PRIMARY KEY, repo_root TEXT NOT NULL, git_common_dir TEXT NOT NULL, created_at INTEGER NOT NULL)');
}

/** Managed worktree directories belong to the configured profile, while branches stay in git. */
export class WorktreeService {
  private closed = false;
  constructor(private readonly deps: WorktreeDeps) {}
  private async run(operation: () => Promise<Json>): Promise<Json> {
    try { if (this.closed) throw new Error('The worktree service is closed'); return await operation(); }
    catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  private async command(root: string, args: string[], fallback: string): Promise<string> {
    const result = await this.deps.git.process.run(root, args);
    if (result.code !== 0) throw new Error(gitError(result, fallback)); return result.stdout.trim();
  }
  private forgetOrigin(path: string): void {
    withSettingsDb(this.deps.workspaces.configRoot, db => { ensureOrigins(db); db.prepare('DELETE FROM managed_worktree_origins WHERE path = ?').run(path); });
  }
  private origin(path: string): string | undefined {
    return withSettingsDb(this.deps.workspaces.configRoot, db => {
      ensureOrigins(db);
      const root = db.prepare('SELECT repo_root FROM managed_worktree_origins WHERE path = ?').get(path)?.repo_root;
      return typeof root === 'string' ? root : undefined;
    });
  }
  private async mainCheckout(path: string, common: string, listed?: string): Promise<string> {
    const saved = withSettingsDb(this.deps.workspaces.configRoot, db => {
      ensureOrigins(db);
      return db.prepare('SELECT repo_root FROM managed_worktree_origins WHERE git_common_dir = ? ORDER BY created_at DESC LIMIT 1').get(common)?.repo_root;
    });
    const core = await this.deps.git.process.run(path, ['config', '--path', '--get', 'core.worktree']);
    const candidates = [path, typeof saved === 'string' ? saved : '', listed ?? '', core.code === 0 ? resolve(common, core.stdout.trim()) : ''];
    const projects = object(this.deps.workspaces.projectsList()).roots;
    if (Array.isArray(projects)) candidates.push(...projects.map(project => string(object(project).path)));
    const groups = object(this.deps.workspaces.list()).workspaces;
    if (Array.isArray(groups)) for (const group of groups) {
      const roots = object(group).roots; if (Array.isArray(roots)) candidates.push(...roots.map(root => string(root)));
    }
    for (const candidate of [...new Set(candidates)].filter(value => value && !value.startsWith('ssh://'))) {
      try { if (!(await stat(candidate)).isDirectory()) continue; } catch { continue; }
      const gitDir = await this.deps.git.process.run(candidate, ['rev-parse', '--absolute-git-dir']);
      if (gitDir.code !== 0) continue;
      let actual: string;
      try { actual = await realpath(gitDir.stdout.trim()); } catch { continue; }
      if (actual !== common) continue;
      const top = await this.deps.git.process.run(candidate, ['rev-parse', '--show-toplevel']);
      if (top.code !== 0) continue;
      const root = await realpath(top.stdout.trim());
      if (root !== common && !pathInside(root, common)) return root;
    }
    throw new Error('cannot resolve main repository');
  }
  private async context(value: unknown): Promise<WorktreeContext> {
    const path = string(value);
    if (!path || path.includes('\0') || !isAbsolute(path) || !this.deps.workspaces.isManagedWorktree(path)) throw new Error('not a managed worktree');
    const realRoot = await realpath(dirname(path)), realPath = await realpath(path);
    if (realPath === realRoot || !pathInside(realPath, realRoot)) throw new Error('not a managed worktree');
    const output = await this.command(realPath, ['worktree', 'list', '--porcelain', '-z'], 'not a git worktree');
    const records = output.split('\0\0').filter(Boolean).map(record => record.split('\0'));
    const paths = records.map(record => record.find(line => line.startsWith('worktree '))?.slice(9)).filter((item): item is string => Boolean(item));
    const main = paths[0]; if (!main) throw new Error('cannot resolve main repository');
    const canonical = await Promise.all(paths.map(async listed => { try { return await realpath(listed); } catch { return undefined; } }));
    if (!canonical.includes(realPath) || canonical[0] === realPath || records[0]?.includes('bare')) throw new Error('not a managed worktree');
    const common = await realpath(await this.command(realPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'cannot resolve main repository'));
    return { path: resolve(path), realPath, repoRoot: await this.mainCheckout(realPath, common, main) };
  }
  private async statusIn(context: WorktreeContext): Promise<{ branch: string; dirty: boolean }> {
    const branch = await this.command(context.realPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 'not a git worktree');
    const status = await this.command(context.realPath, ['status', '--porcelain', '-z'], 'git status failed');
    return { branch, dirty: Boolean(status) };
  }
  /**
   * Carry the main checkout's uncommitted work into a freshly created worktree.
   *
   * This backs the "Include N uncommitted changes" toggle. The mechanism has to be
   * two steps: `git stash create` snapshots tracked edits and
   * deletions only — it silently ignores untracked files (verified against git
   * 2.50: `stash create -u` produces a two-parent commit with no third parent),
   * while `stash push -u` would REMOVE the files from the main checkout. So the
   * tracked state moves through a snapshot commit applied in the worktree, and
   * untracked files are copied across by hand. Ignored files are not part of the
   * set `git ls-files --others --exclude-standard` reports, so they stay put.
   *
   * Nothing here mutates the main checkout: the snapshot is created, never
   * dropped, so the user's edits remain exactly where they were.
   */
  private async carryUncommitted(repoRoot: string, target: string): Promise<void> {
    const snapshot = (await this.deps.git.process.run(repoRoot, ['stash', 'create']));
    const sha = snapshot.code === 0 ? snapshot.stdout.trim() : '';
    if (sha) {
      const applied = await this.deps.git.process.run(target, ['stash', 'apply', sha]);
      // A failure here leaves the worktree at the clean base commit, which is a
      // usable session — but the user asked for their work to come along, so the
      // refusal is surfaced instead of silently dropping it.
      if (applied.code !== 0) throw new Error(gitError(applied, 'git stash apply failed'));
    }
    const untracked = await this.deps.git.process.run(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.code !== 0) throw new Error(gitError(untracked, 'untracked file listing failed'));
    for (const relative of untracked.stdout.split('\0').filter(Boolean)) {
      if (relative.includes('\0') || isAbsolute(relative)) throw new Error('invalid untracked path: ' + relative);
      const source = join(repoRoot, relative), destination = join(target, relative);
      if (!pathInside(source, repoRoot)) throw new Error('untracked path outside repository: ' + relative);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }
  create(payload: JsonObject, assertCurrent?: () => void): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      assertCurrent?.();
      const raw = string(payload.workdir).trim();
      if (raw.includes('\0') || raw.startsWith('ssh://')) throw new Error('invalid workdir');
      const base = raw ? resolve(raw) : string(payload.sessionId) ? await this.deps.workspaces.sessionDirectory(string(payload.sessionId)) : undefined;
      if (!base) throw new Error('invalid workdir');
      let info; try { info = await stat(base); } catch { throw new Error('workdir does not exist'); }
      if (!info.isDirectory()) throw new Error('workdir is not a directory');
      const top = await this.deps.git.process.run(base, ['rev-parse', '--show-toplevel']);
      if (top.code !== 0) throw new Error('not a git repository');
      const repoRoot = top.stdout.trim();
      return this.deps.git.withRepositoryMutation(repoRoot, async (): Promise<Json> => {
        if (this.closed) throw new Error('The worktree service is closed');
        assertCurrent?.();
        if (readWorktreeStorageSettings(this.deps.workspaces.configRoot).upstreamRefreshMode === 'best-effort') {
          await this.deps.git.process.run(repoRoot, ['fetch', '--all', '--prune'], { timeoutMs: 60_000 });
          assertCurrent?.();
        }
        const head = await this.deps.git.process.run(repoRoot, ['rev-parse', '--verify', 'HEAD']);
        if (head.code !== 0) throw new Error('repository has no commits yet');
        const baseRef = string(payload.baseRef).trim(); let commit = head.stdout.trim();
        if (baseRef) {
          const result = await this.deps.git.process.run(repoRoot, ['rev-parse', '--verify', '--quiet', '--end-of-options', baseRef + '^{commit}']);
          if (result.code !== 0) throw new Error('unknown base ref: ' + baseRef); commit = result.stdout.trim();
        }
        const key = slug(), branch = 'klaus/wt-' + key, managedRoot = managedWorktreeRoot(this.deps.workspaces.configRoot);
        await mkdir(managedRoot, { recursive: true });
        const path = join(managedRoot, basename(repoRoot) + '-' + key);
        const common = await realpath(await this.command(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'cannot resolve main repository'));
        const mainRoot = await this.mainCheckout(repoRoot, common), originPath = join(await realpath(managedRoot), basename(path));
        withSettingsTransaction(this.deps.workspaces.configRoot, db => {
          ensureOrigins(db); db.prepare('INSERT INTO managed_worktree_origins (path, repo_root, git_common_dir, created_at) VALUES (?, ?, ?, ?)').run(originPath, mainRoot, common, Date.now());
        });
        try {
          assertCurrent?.();
          await this.command(repoRoot, ['worktree', 'add', '-b', branch, path, commit], 'git worktree add failed');
          // Only when the base IS the checkout's own HEAD: carrying a dirty tree onto
          // an explicitly chosen other commit or branch would mix two states, and the
          // composer only offers the toggle for "start from where I am now".
          if (payload.includeUncommitted === true && commit === head.stdout.trim()) await this.carryUncommitted(repoRoot, path);
          // A caller can stop or lose its engine while Git is creating this owned directory.
          // Check inside the rollback scope before the path leaves the service, so the router's
          // later ownership fence cannot turn a rejected creation into an orphaned worktree.
          assertCurrent?.();
        } catch (error) {
          this.forgetOrigin(originPath);
          await this.deps.git.process.run(repoRoot, ['worktree', 'remove', '--force', path]).catch(() => {});
          throw error;
        }
        return { ok: true, path, branch, repoRoot };
      });
    });
  }
  status(payload: JsonObject): Promise<Json> {
    return this.run(async () => {
      const path = string(payload.path);
      if (this.deps.workspaces.isManagedWorktree(path)) {
        const managedRoot = await realpath(dirname(path));
        const repoRoot = this.origin(join(managedRoot, basename(path)));
        if (repoRoot) {
          try { if (!(await stat(join(path, '.git'))).isFile()) throw new Error('not a managed worktree'); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              const origin = await stat(repoRoot).catch(() => null);
              return { ok: true, state: 'gone', ...(origin?.isDirectory() ? { repoRoot } : {}) };
            }
            throw error;
          }
          if (payload.availabilityOnly === true) return { ok: true, state: 'available' };
        }
      }
      const context = await this.context(path), status = await this.statusIn(context);
      return { ok: true, state: 'available', ...status, repoRoot: context.repoRoot };
    });
  }
  remove(payload: JsonObject): Promise<Json> {
    return this.run(async (): Promise<Json> => {
      const context = await this.context(payload.path);
      if (this.deps.workspaces.sessionsInDirectory(context.path).length) throw new Error('worktree-in-use');
      // Quiesce users of this cwd before taking the git mutation lock.
      const release = await this.deps.beforeRemove(context.path);
      try {
        return await this.deps.git.withRepositoryMutation(context.repoRoot, async (): Promise<Json> => {
          if (this.closed) throw new Error('The worktree service is closed');
          const current = await this.context(context.path);
          if (current.realPath !== context.realPath || current.repoRoot !== context.repoRoot) throw new Error('worktree changed during removal');
          if (this.deps.workspaces.sessionsInDirectory(context.path).length) throw new Error('worktree-in-use');
          await this.command(context.repoRoot, ['worktree', 'remove', '--force', context.realPath], 'git worktree remove failed');
          this.forgetOrigin(context.realPath);
          await this.deps.onRemoved(context.path); return { ok: true };
        });
      } finally { release?.(); }
    });
  }
  reveal(payload: JsonObject): Promise<Json> {
    return this.run(async () => {
      const context = await this.context(payload.path); await this.deps.openPath(context.path); return { ok: true };
    });
  }
  /** The shared GitService owns command shutdown; this only stops new worktree actions. */
  close(): void { this.closed = true; }
}
