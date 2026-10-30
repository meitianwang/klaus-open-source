import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { IpcHandlerError } from '../ipc/registry';

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
export function persistentSessionIdentity(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,256}$/u.test(id) || id.startsWith('__')) throw new IpcHandlerError('BAD_REQUEST', 'A persistent conversation identity is required');
}
async function ownedDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new IpcHandlerError('UNSAFE_SESSION_DIRECTORY', 'The managed conversation directory was replaced');
    return true;
  } catch (error) { if (missing(error)) return false; throw error; }
}
/** A delete checkbox never authorizes removing a bound project or another profile directory. */
export async function scratchDirectory(configRoot: string, id: string): Promise<string> {
  persistentSessionIdentity(id);
  const root = join(configRoot, 'sessions'), path = join(root, id);
  if (await ownedDirectory(root)) await ownedDirectory(path);
  return path;
}
export async function removeScratchDirectory(configRoot: string, id: string): Promise<void> {
  const path = await scratchDirectory(configRoot, id);
  await rm(path, { recursive: true, force: true });
}
/** Remove migrated renderer sidecars only after the engine confirms deleting its own history. */
export async function removeSessionSidecars(configRoot: string, id: string): Promise<void> {
  persistentSessionIdentity(id);
  const projects = join(configRoot, 'projects');
  if (await ownedDirectory(projects)) {
    for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      for (const suffix of ['.jsonl', '.thinking.json', '.session-meta.json']) await rm(join(projects, entry.name, id + suffix), { force: true });
    }
  }
  const transcripts = join(configRoot, 'transcripts');
  if (await ownedDirectory(transcripts)) await rm(join(transcripts, id + '.jsonl'), { force: true });
}
