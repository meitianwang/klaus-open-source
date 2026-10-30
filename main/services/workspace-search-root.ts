import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { IpcHandlerError } from '../ipc/registry';
import { expandHomePrefix } from '../paths';

/** An explicit draft workspace never falls back to a different directory. */
export function explicitWorkspaceSearchRoot(root: unknown, sessionId: string, channel: string): string | undefined {
  if (root === undefined) return undefined;
  if (sessionId || channel !== 'engine:workspaceFileSearchSessionStart') {
    throw new IpcHandlerError('INVALID_ROOT', 'An explicit search root requires an unbound file picker');
  }
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) throw new IpcHandlerError('INVALID_ROOT', 'A search root must be a local directory');
  if (root.startsWith('ssh://')) throw new IpcHandlerError('REMOTE_WORKSPACE', 'File search for a remote workspace requires remote workspace tools');
  const expanded = expandHomePrefix(root, homedir());
  if (!expanded || !isAbsolute(expanded)) throw new IpcHandlerError('INVALID_ROOT', 'A search root must be an absolute directory');
  const directory = resolve(expanded);
  try { if (statSync(directory).isDirectory()) return directory; } catch { /* Report the selected root, never a fallback. */ }
  throw new IpcHandlerError('INVALID_ROOT', 'The selected workspace directory is unavailable');
}
