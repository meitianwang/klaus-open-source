import { mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { FRIEND_ID_PATTERN } from '../../shared/friends';

/**
 * The product-owned directory every friendship shares on the receiving computer.
 * Friend tasks start inside their own subdirectory of it, so a friend can exchange
 * files without the owner handing over any personal folder: the shared space is
 * created by the product, not granted by the owner.
 */
export function friendFilesRoot(configRoot: string): string {
  return join(configRoot, 'friends');
}

/** The one subdirectory a friendship works in; the friendship id is the folder name. */
export function friendFilesDir(configRoot: string, friendshipId: string): string {
  if (!FRIEND_ID_PATTERN.test(friendshipId)) throw new Error('Invalid friendship id for a shared directory');
  return join(friendFilesRoot(configRoot), friendshipId);
}

/** Create the friendship's shared directory; existing directories stay untouched. */
export function ensureFriendFilesDir(configRoot: string, friendshipId: string): string {
  const dir = friendFilesDir(configRoot, friendshipId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The roots a friend task session may always read and write, on top of whatever the
 * owner granted: the shared space itself plus this friendship's subdirectory. Kept
 * separate from the stored grant so revoking an owner-added directory never removes
 * the product directory, and a stored grant never has to name it.
 */
export function friendFilesRoots(configRoot: string, friendshipId: string): string[] {
  return [friendFilesRoot(configRoot), friendFilesDir(configRoot, friendshipId)];
}

/** Whether a conversation workdir is the product-owned friendship scratch space
 *  rather than a user project. Conversations that ran there before execution
 *  locations existed are ordinary task chats, so surfaces that group by project
 *  must not file them under the scratch path. */
export function isFriendScratchWorkdir(configRoot: string, workdir: string | null | undefined): boolean {
  if (!workdir) return false;
  const root = friendFilesRoot(configRoot);
  return workdir === root || workdir.startsWith(root + sep);
}

/** The friendship whose scratch directory a conversation workdir is, if any.
 *  Friend task conversations run inside their friendship's folder, which is what
 *  lets the sidebar file them under that friend instead of under a path. */
export function friendScratchFriendshipId(configRoot: string, workdir: string | null | undefined): string | null {
  if (!workdir || !isFriendScratchWorkdir(configRoot, workdir)) return null;
  const id = workdir.slice(friendFilesRoot(configRoot).length + sep.length).split(sep)[0] ?? '';
  return FRIEND_ID_PATTERN.test(id) ? id : null;
}
