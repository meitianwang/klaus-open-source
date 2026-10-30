import { object, string, type JsonObject } from '../service-types';
import { badRequest, MobileError, required, type MobileCall } from './protocol';

export interface MobileNewChatTarget { workdir: string | null; workspaceId: string | null }
export interface MobileNewChatRun { mode: 'local' | 'worktree'; baseRef: string | null; includeUncommitted: boolean }
export type KnownMobileTarget = (call: MobileCall, path: string | null, workspaceId?: string | null) => Promise<void>;

/** Client choices cannot turn arbitrary host paths or revision expressions into Git operations. */
export function mobileBranch(value: unknown, field = 'branch'): string {
  const branch = required(value, field).trim();
  if (Buffer.byteLength(branch) > 256 || branch.startsWith('-') || /[\s\0~^:?*\[\\]/u.test(branch)
    || branch.includes('..') || branch.includes('@{') || branch.includes('//')
    || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) {
    throw badRequest(field + ' must be a valid branch name');
  }
  return branch;
}
function optionalBoolean(value: unknown, field: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw badRequest(field + ' must be a boolean');
  return value;
}
export function mobileNewChatRun(payload: JsonObject): MobileNewChatRun {
  const mode = payload.runMode ?? 'local';
  if (mode !== 'local' && mode !== 'worktree') throw badRequest('runMode must be local or worktree');
  const baseRef = payload.baseRef === undefined || payload.baseRef === null || payload.baseRef === ''
    ? null : mobileBranch(payload.baseRef, 'baseRef');
  const includeUncommitted = optionalBoolean(payload.includeUncommitted, 'includeUncommitted');
  if (mode === 'local' && (baseRef !== null || includeUncommitted)) throw badRequest('Worktree options require worktree mode');
  return { mode, baseRef, includeUncommitted };
}
function currentBranch(info: JsonObject, branches: string[]): string | null {
  const current = string(info.current).trim();
  return current && (current !== 'HEAD' || branches.length > 0) ? current : null;
}
function branchNames(info: JsonObject): string[] {
  return Array.isArray(info.branches) ? info.branches.filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
}

export async function mobileNewChatContext(call: MobileCall, target: MobileNewChatTarget, known: KnownMobileTarget): Promise<JsonObject> {
  await known(call, target.workdir, target.workspaceId);
  const kind = target.workspaceId ? 'workspace' : target.workdir ? 'project' : 'none';
  const base: JsonObject = { target: kind, isGit: false, current: null, branches: [], gitRoot: null, dirty: false, changes: 0, worktreeEnabled: false,
    worktreeDisabledReason: kind === 'workspace' ? 'workspace' : kind === 'none' ? 'no_project' : 'not_git' };
  if (kind !== 'project') return base;
  let info: JsonObject;
  try { info = object(await call('git:branches', { workdir: target.workdir })); }
  catch (error) {
    // Only the named Git service's explicit classification is a non-repository. Connection,
    // permission and process failures remain errors, rather than silently disabling a capability.
    if (error instanceof MobileError && error.code === 'not a git repository') return base;
    throw error;
  }
  const branches = branchNames(info), current = currentBranch(info, branches), gitRoot = string(info.gitRoot) || target.workdir;
  if (!current) return { ...base, isGit: true, gitRoot, branches, worktreeDisabledReason: 'no_branch' };
  const pending = object(await call('git:uncommitted', { workdir: target.workdir }));
  return { ...base, isGit: true, current, branches, gitRoot, dirty: pending.dirty === true,
    changes: typeof pending.changes === 'number' && Number.isSafeInteger(pending.changes) && pending.changes >= 0 ? pending.changes : 0,
    worktreeEnabled: true, worktreeDisabledReason: null };
}

export async function mobileNewChatBranch(call: MobileCall, target: MobileNewChatTarget, payload: JsonObject, known: KnownMobileTarget): Promise<JsonObject> {
  if (!target.workdir || target.workspaceId) throw badRequest('Branch selection requires a project');
  const branch = mobileBranch(payload.branch), create = optionalBoolean(payload.create, 'create');
  const commitConflicts = optionalBoolean(payload.commitConflicts, 'commitConflicts');
  if (payload.files !== undefined || payload.paths !== undefined) throw badRequest('Conflict paths are computed by the desktop');
  const message = payload.commitMessage === undefined ? '' : required(payload.commitMessage, 'commitMessage').trim();
  if (Buffer.byteLength(message) > 20_000) throw badRequest('commitMessage is too long');
  if (commitConflicts && !message) throw badRequest('commitMessage is required to commit conflicts');
  await known(call, target.workdir);
  const context = await mobileNewChatContext(call, target, known);
  if (!context.isGit || !context.current) throw new MobileError(409, 'branch_unavailable', 'This project has no current Git branch');
  if (!create && branch !== context.current && !(context.branches as string[]).includes(branch)) throw badRequest('branch is not a known local branch');
  // New branches start at HEAD and carry the current edits; existing branches must be checked
  // again on every confirmed retry because files can change while the phone displays its sheet.
  const pending = object(await call('git:uncommitted', { workdir: target.workdir, ...(create ? {} : { branch }) }));
  const files = (Array.isArray(pending.files) ? pending.files : []).map(object).filter(file => string(file.path)).map(file => ({
    path: string(file.path), additions: Number(file.additions) || 0, deletions: Number(file.deletions) || 0, isBinary: file.isBinary === true,
  }));
  if (files.length && !commitConflicts) return { ok: false, needsCommit: true, current: context.current, branch, files };
  if (files.length) await call('git:commit-paths', { workdir: target.workdir, paths: files.map(file => file.path), message });
  await call('git:checkout', { workdir: target.workdir, branch, create });
  const refreshed = object(await call('git:branches', { workdir: target.workdir }));
  const branches = branchNames(refreshed);
  return { ok: true, current: currentBranch(refreshed, branches), branches };
}
