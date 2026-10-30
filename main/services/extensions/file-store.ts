import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathInside } from '../workspaces';

export const DOCUMENT_LIMIT = 1024 * 1024;
export const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
export async function readDocument(path: string, limit = DOCUMENT_LIMIT): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat(); if (!info.isFile()) throw new Error('not-a-file');
    if (info.size > limit) throw new Error('Extension file is too large');
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > limit) throw new Error('Extension file is too large');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
export async function optionalDocument(path: string, limit = DOCUMENT_LIMIT): Promise<string | undefined> {
  try { return await readDocument(path, limit); } catch (error) { if (missing(error)) return undefined; throw error; }
}
export async function directoryNames(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); } catch (error) { if (missing(error)) return []; throw error; }
}
/** Validate every existing ancestor before creating any directories or replacing a file. */
export async function managedPath(root: string, relative: string, create = false): Promise<string> {
  if (!relative || relative.includes('\0') || isAbsolute(relative)) throw new Error('path-escape');
  const path = resolve(root, relative), base = resolve(root);
  if (path === base || !pathInside(path, base)) throw new Error('path-escape');
  if (create) await mkdir(base, { recursive: true });
  let canonical: string;
  try { canonical = await realpath(base); } catch (error) { if (missing(error) && !create) return path; throw error; }
  let probe = path;
  for (;;) {
    try {
      const resolved = await realpath(probe);
      if (!pathInside(resolved, canonical)) throw new Error('path-escape');
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      // A broken symlink must not become a write target through its missing referent.
      try { if ((await lstat(probe)).isSymbolicLink()) throw new Error('path-escape'); } catch (entryError) { if (!missing(entryError)) throw entryError; }
      const parent = dirname(probe); if (parent === probe) throw error; probe = parent;
    }
  }
  if (create) await mkdir(dirname(path), { recursive: true });
  return path;
}
export async function atomicDocument(root: string, relative: string, content: string, exclusive = false, limit = DOCUMENT_LIMIT): Promise<string> {
  if (Buffer.byteLength(content) > limit) throw new Error('Extension file is too large');
  const path = await managedPath(root, relative, true);
  let mode = 0o600;
  try { mode = (await stat(path)).mode & 0o777; } catch (error) { if (!missing(error)) throw error; }
  const temp = join(dirname(path), '.klaus-write-' + randomBytes(8).toString('hex'));
  const handle = await open(temp, 'wx', mode);
  try { await handle.writeFile(content); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(temp); throw error; }
  await handle.close();
  try {
    await managedPath(root, relative);
    if (exclusive) { await link(temp, path); await unlink(temp); }
    else await rename(temp, path);
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  return path;
}
