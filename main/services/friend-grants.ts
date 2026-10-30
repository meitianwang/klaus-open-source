import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FriendTaskGrant, FriendAppsSnapshot, FriendExecutionTargets } from '../../shared/friends';
import { IpcHandlerError } from '../ipc/registry';

function invalid(message: string): never { throw new IpcHandlerError('INVALID_FRIEND_GRANT', message); }
function contains(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside === '' || !inside.startsWith('..') && !isAbsolute(inside);
}
/** The execution location a grant names must exist in this computer's registry:
 *  a stale or invented project/workspace must never bind a friend conversation. */
function validateTarget(value: unknown, targets: FriendExecutionTargets | null | undefined): FriendTaskGrant['target'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Choose a valid execution location');
  const row = value as Record<string, unknown>;
  if (row.kind === 'none') {
    if (Object.keys(row).length !== 1) return invalid('Choose a valid execution location');
    return { kind: 'none' };
  }
  if (row.kind === 'project') {
    if (Object.keys(row).length !== 2 || typeof row.root !== 'string' || !row.root.trim()) return invalid('Choose a valid execution location');
    if (targets && !targets.projects.some(project => project.root === row.root)) return invalid('The chosen project is no longer registered on this computer');
    return { kind: 'project', root: row.root };
  }
  if (row.kind === 'workspace') {
    if (Object.keys(row).length !== 2 || typeof row.id !== 'string' || !row.id.trim()) return invalid('Choose a valid execution location');
    if (targets && !targets.workspaces.some(workspace => workspace.id === row.id)) return invalid('The chosen workspace is no longer registered on this computer');
    return { kind: 'workspace', id: row.id };
  }
  return invalid('Choose a valid execution location');
}

/** Only local owner IPC reaches this validator; persisted templates are revalidated before use. */
export async function validateFriendGrant(value: unknown, deviceId: string, configRoot: string, apps: () => Promise<FriendAppsSnapshot>, pinnedRoots = false, targets?: FriendExecutionTargets | null): Promise<FriendTaskGrant> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Choose the permissions for this task');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['deviceId', 'mode', 'computerUse', 'apps', 'directories', 'remember', 'network', 'policy', 'target'].includes(key))) return invalid('The task grant contains an unknown permission');
  if (input.deviceId !== deviceId) return invalid('Authorize resources on the receiving computer');
  if (!['manual', 'auto-edit', 'scoped-auto'].includes(String(input.mode))) return invalid('Choose a valid execution mode');
  if (input.policy !== undefined && !['approve', 'auto', 'reject'].includes(String(input.policy))) return invalid('Choose a valid task policy');
  if (typeof input.computerUse !== 'boolean' || typeof input.remember !== 'boolean' || input.network !== undefined && typeof input.network !== 'boolean') return invalid('The permission choices are invalid');
  if (!Array.isArray(input.directories) || input.directories.length > 32 || !Array.isArray(input.apps) || input.apps.length > 64) return invalid('The resource list is too large');
  const protectedPaths = [resolve(configRoot), ...['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.config/gcloud'].map(name => resolve(homedir(), name))];
  const protectedRoots = await Promise.all(protectedPaths.map(path => realpath(path).catch(() => path)));
  const directories = new Map<string, 'read' | 'write'>();
  for (const raw of input.directories) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('A directory permission is invalid');
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some(key => !['path', 'access'].includes(key)) || typeof row.path !== 'string' || row.path.length > 4096 || row.path.includes('\0') || !isAbsolute(row.path) || !['read', 'write'].includes(String(row.access))) return invalid('Choose a valid local directory and access level');
    const path = await realpath(row.path).catch(() => invalid('The selected directory is unavailable: ' + row.path));
    // Check every saved root before deduplication can merge a changed alias into another grant.
    if (pinnedRoots && path !== row.path) return invalid('A saved directory changed identity; authorize its current location again');
    if (!(await stat(path)).isDirectory()) return invalid('A resource grant must name a directory');
    if (protectedRoots.some(secret => contains(path, secret) || contains(secret, path))) return invalid('The grant cannot include application credentials or private account storage');
    const access = row.access as 'read' | 'write';
    if (directories.get(path) !== 'write') directories.set(path, access);
  }
  let selected: string[] = [];
  if (input.computerUse) {
    const available = await apps();
    if (!available.available) return invalid(available.error || 'Computer Use is unavailable on this computer');
    const identities = new Set(available.apps.map(app => app.id));
    if (!input.apps.length || input.apps.some(app => typeof app !== 'string' || !identities.has(app))) return invalid('Select installed applications from this computer');
    selected = [...new Set(input.apps as string[])];
  } else if (input.apps.length) return invalid('Enable Computer Use before selecting applications');
  const target = validateTarget(input.target, targets);
  return { deviceId, mode: input.mode as FriendTaskGrant['mode'], computerUse: input.computerUse,
    apps: selected, directories: [...directories].map(([path, access]) => ({ path, access })), remember: input.remember, network: input.network === true,
    ...(input.policy === undefined ? {} : { policy: input.policy as FriendTaskGrant['policy'] }),
    ...(target === undefined ? {} : { target }) };
}

export async function revalidateFriendGrant(grant: FriendTaskGrant, deviceId: string, configRoot: string, apps: () => Promise<FriendAppsSnapshot>, targets?: FriendExecutionTargets | null): Promise<FriendTaskGrant> {
  const checked = await validateFriendGrant(grant, deviceId, configRoot, apps, true, targets);
  if (checked.directories.some(row => !grant.directories.some(previous => previous.path === row.path && previous.access === row.access))) return invalid('A saved directory changed identity; authorize its current location again');
  return checked;
}
