import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathInside } from '../services/workspaces';
import { EscapedLinkError, UnreadableSourceError } from '../services/extensions/acquisition';
import { missing } from '../services/extensions/file-store';
import { object, type JsonObject } from '../services/service-types';
import { checkCancelled } from '../services/download';

export async function present(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
export async function directory(path: unknown): Promise<string | undefined> {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) return undefined;
  try { return (await stat(path)).isDirectory() ? resolve(path) : undefined; } catch { return undefined; }
}
export async function names(path: string): Promise<string[]> { try { return (await readdir(path)).sort(); } catch { return []; } }
export async function withinSource(path: string, root: string): Promise<string> {
  let canonical: string;
  try { canonical = await realpath(path); } catch (error) { if (missing(error)) throw new UnreadableSourceError('External source is a link without a target: ' + path); throw error; }
  const base = await realpath(root);
  if (!pathInside(canonical, base)) throw new EscapedLinkError('External source contains a link outside its declared root: ' + path);
  return canonical;
}
/** Read one bounded regular file through a stable descriptor, never a FIFO or device. */
export async function sourceBytes(path: string, limit: number, signal: AbortSignal, root?: string): Promise<Buffer> {
  checkCancelled(signal);
  const canonical = root ? await withinSource(path, root) : await realpath(path);
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat(); if (!before.isFile() || before.size > limit) throw new UnreadableSourceError('External source is not a regular file within the size limit');
    const chunks: Buffer[] = []; let length = 0;
    while (length <= limit) {
      checkCancelled(signal); const chunk = Buffer.alloc(Math.min(256 * 1024, limit + 1 - length));
      const row = await handle.read(chunk, 0, chunk.length, null); if (!row.bytesRead) break;
      length += row.bytesRead; chunks.push(chunk.subarray(0, row.bytesRead));
    }
    const after = await handle.stat();
    if (length > limit || length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new UnreadableSourceError('External source changed while reading');
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}
export async function sourceJson(path: string, signal: AbortSignal, root?: string): Promise<JsonObject | undefined> {
  try {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(await sourceBytes(path, 8 * 1024 ** 2, signal, root));
    const value: unknown = JSON.parse(raw); if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined; return object(value);
  } catch { checkCancelled(signal); return undefined; }
}
export const unique = <T>(values: T[]): T[] => [...new Set(values)];
