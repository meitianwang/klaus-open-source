import { createHash } from 'node:crypto';
import { constants, createReadStream, lstatSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep, isAbsolute } from 'node:path';

// Path guards shared with the retired local-model tree: downloads land inside
// an owner directory that must not be escaped or redirected through symlinks.
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function safeSegment(value: string): boolean {
  return !!value && value !== '.' && value !== '..' && !/[\x00-\x1f\x7f\\/:*?"<>|]/.test(value) && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}
function assetName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048 || !value.split('/').every(safeSegment)) throw new Error('Invalid asset path');
  return value;
}
export function ownedPath(root: string, name: string): string {
  assetName(name);
  const target = resolve(root, name);
  if (!inside(root, target)) throw new Error('Asset path escaped its owner');
  try { if (lstatSync(root).isSymbolicLink()) throw new Error('Asset owner is a symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let current = root;
  for (const part of name.split('/')) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Asset path is a symlink'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}

export class Cancelled extends Error { constructor() { super('cancelled'); } }
export function networkFailure(error: unknown, phase: string, url: string): Error {
  const cause = error instanceof Error && error.cause && typeof error.cause === 'object' ? error.cause as { code?: unknown } : {};
  const code = typeof cause.code === 'string' && /^[A-Z0-9_]+$/.test(cause.code) ? ` (${cause.code})` : '';
  return new Error(`${phase} at ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}${code}`);
}
export function checkCancelled(signal: AbortSignal): void { if (signal.aborted) throw new Cancelled(); }
export async function withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  checkCancelled(signal);
  let cancel: () => void = () => {};
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { cancel = () => reject(new Cancelled()); signal.addEventListener('abort', cancel, { once: true }); })]); }
  finally { signal.removeEventListener('abort', cancel); }
}
export async function fileHash(path: string, signal: AbortSignal): Promise<string> {
  checkCancelled(signal);
  const hash = createHash('sha256'), stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  const cancel = (): void => { stream.destroy(new Cancelled()); };
  signal.addEventListener('abort', cancel, { once: true });
  try { for await (const chunk of stream) { checkCancelled(signal); hash.update(chunk); } checkCancelled(signal); return hash.digest('hex'); }
  finally { signal.removeEventListener('abort', cancel); stream.destroy(); }
}
export interface DownloadProgress { receivedBytes: number; totalBytes: number }
export interface DownloadOptions {
  fetch?: typeof fetch;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  progress: (progress: DownloadProgress) => void;
}
class HttpFailure extends Error { constructor(readonly status: number) { super(`Download failed: HTTP ${status}`); } }
export function partialPath(target: string): string { return target.slice(0, target.length - extname(target).length) + '.part'; }
async function regularSize(path: string): Promise<number | undefined> {
  ownedPath(dirname(path), path.slice(dirname(path).length + 1));
  try { const info = await stat(path); if (!info.isFile() || info.nlink !== 1) throw new Error('Download target must be an owned regular file'); return info.size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
/** Keeps the existing .part naming and resume behavior, but validates every range. */
export async function download(urls: string[], target: string, signal: AbortSignal, options: DownloadOptions): Promise<number> {
  checkCancelled(signal);
  const existing = await regularSize(target);
  if (existing !== undefined) { options.progress({ receivedBytes: existing, totalBytes: existing }); return existing; }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const partial = partialPath(target);
  let last: unknown = new Error('No download URL is available');
  for (const url of urls) for (let attempt = 0; attempt < (options.attempts ?? 3); attempt++) {
    checkCancelled(signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(), cancel = (): void => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const arm = (ms: number): void => { if (timer) clearTimeout(timer); timer = setTimeout(cancel, ms); };
    try {
      const offset = await regularSize(partial) ?? 0;
      arm(options.headerTimeoutMs ?? 15_000);
      const response = await (options.fetch ?? fetch)(url, { headers: { 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-` } : {}) }, signal: controller.signal });
      if (response.status === 416 && offset) { await response.body?.cancel(); await rm(partial, { force: true }); throw new Error('Partial download no longer matches the remote file'); }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new HttpFailure(response.status); }
      const range = response.headers.get('content-range'), sizeHeader = response.headers.get('content-length');
      const length = sizeHeader && /^\d+$/.test(sizeHeader) ? Number(sizeHeader) : undefined;
      if (length !== undefined && !Number.isSafeInteger(length)) { await response.body.cancel(); throw new Error('Download size exceeds supported file offsets'); }
      let received = 0, total = length ?? 0, remaining = length;
      if (response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range ?? '');
        const start = Number(match?.[1]), end = Number(match?.[2]), full = Number(match?.[3]);
        if (!match || start !== offset || !Number.isSafeInteger(full) || full <= end || end < start || length !== undefined && length !== end - start + 1) {
          await response.body.cancel(); await rm(partial, { force: true }); throw new Error('Invalid Content-Range for partial download');
        }
        received = offset; total = full; remaining = end - start + 1;
      } else if (response.status !== 200 || range) { await response.body.cancel(); throw new Error('Unexpected download response range'); }
      if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') { await response.body.cancel(); throw new Error('Encoded model download cannot be resumed safely'); }
      const handle = await open(partial, constants.O_WRONLY | constants.O_CREAT | (response.status === 206 ? constants.O_APPEND : constants.O_TRUNC) | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1) throw new Error('Partial download is not an owned regular file');
        reader = response.body.getReader();
        for (;;) {
          checkCancelled(signal); arm(options.idleTimeoutMs ?? 30_000);
          const next = await reader.read(); if (next.done) break;
          if (remaining !== undefined) { remaining -= next.value.length; if (remaining < 0) throw new Error('Downloaded bytes exceed the declared response length'); }
          let written = 0;
          while (written < next.value.length) { const result = await handle.write(next.value, written, next.value.length - written); if (!result.bytesWritten) throw new Error('Download write made no progress'); written += result.bytesWritten; }
          received += next.value.length; options.progress({ receivedBytes: received, totalBytes: total });
        }
        if (remaining !== undefined && remaining !== 0 || total && received !== total) throw new Error('Download ended before the declared length');
        checkCancelled(signal); await handle.sync();
      } finally { await handle.close(); }
      checkCancelled(signal); await rename(partial, target); options.progress({ receivedBytes: received, totalBytes: total || received }); return received;
    } catch (error) {
      checkCancelled(signal); last = networkFailure(error, 'Download failed', url);
      if (error instanceof HttpFailure && error.status >= 400 && error.status < 500) throw error;
      if (attempt + 1 < (options.attempts ?? 3)) await withCancellation(new Promise(resolve => setTimeout(resolve, options.retryDelayMs ?? 250)), signal);
    } finally {
      if (timer) clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.abort();
      try { await reader?.cancel(); } catch { /* A failed response is already closed. */ }
    }
  }
  throw last;
}
