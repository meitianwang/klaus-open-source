import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';
import { checkCancelled, download } from '../download';
import { pathInside } from '../workspaces';
import { managedPath, missing } from './file-store';

export const MAX_ARCHIVE_BYTES = 256 * 1024 ** 2;
export const MAX_EXTRACT_BYTES = 512 * 1024 ** 2;
export class SavedExtensionError extends Error {
  constructor(message: string) { super(message); this.name = 'SavedExtensionError'; }
}
/** A copied tree contained a link whose target lies outside the source root; the caller may skip it. */
export class EscapedLinkError extends Error {
  constructor(message: string) { super(message); this.name = 'EscapedLinkError'; }
}
/** A source exceeded its copy safety limits or holds unreadable entries; the caller may skip it. */
export class UnreadableSourceError extends Error {
  constructor(message: string) { super(message); this.name = 'UnreadableSourceError'; }
}
export class UnconfirmedExtensionError extends Error {
  constructor(message: string) { super(message); this.name = 'UnconfirmedExtensionError'; }
}

/** Tracks requests before they enter a shared mutation queue and aborts them on shutdown. */
export class PendingAcquisitions {
  private closed = false;
  private readonly pending = new Map<Promise<unknown>, AbortController>();
  run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Extension acquisition is closed'));
    const controller = new AbortController();
    const pending = Promise.resolve().then(() => { checkCancelled(controller.signal); return operation(controller.signal); });
    this.pending.set(pending, controller);
    return pending.finally(() => { this.pending.delete(pending); });
  }
  abort(): void { this.closed = true; for (const controller of this.pending.values()) controller.abort(); }
  async close(): Promise<void> { this.abort(); await Promise.allSettled([...this.pending.keys()]); }
}

function httpUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('An HTTP(S) URL without embedded credentials is required');
  return url;
}
export interface AcquisitionHttpOptions { fetch?: typeof fetch; token?: string; timeoutMs?: number; maxBytes?: number }
function guardedFetch(options: AcquisitionHttpOptions): typeof fetch {
  return async (input, init) => {
    let url = httpUrl(String(input));
    const headers = new Headers(init?.headers);
    if (options.token) headers.set('authorization', 'Bearer ' + options.token);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await (options.fetch ?? fetch)(url, { ...init, headers, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > (options.maxBytes ?? MAX_ARCHIVE_BYTES))) {
          await response.body?.cancel(); throw new Error('Extension response exceeds its download limit');
        }
        return response;
      }
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Invalid or excessive extension download redirects');
      const next = httpUrl(new URL(location, url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('Extension download refused an HTTPS downgrade');
      if (next.origin !== url.origin) headers.delete('authorization');
      url = next;
    }
    throw new Error('Extension redirect limit exceeded');
  };
}
async function deadline<T>(signal: AbortSignal, ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  checkCancelled(signal); const controller = new AbortController(), cancel = (): void => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, ms);
  try { return await operation(controller.signal); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
export async function fetchExtensionText(url: string, signal: AbortSignal, options: AcquisitionHttpOptions = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? 8 * 1024 ** 2;
  return deadline(signal, options.timeoutMs ?? 30_000, async requestSignal => {
    const response = await guardedFetch({ ...options, maxBytes })(url, { signal: requestSignal });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        checkCancelled(requestSignal); const item = await reader.read(); if (item.done) break;
        size += item.value.length; if (size > maxBytes) throw new Error('Extension response exceeds its download limit');
        chunks.push(item.value);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  });
}
export async function downloadExtension(url: string, target: string, signal: AbortSignal, options: AcquisitionHttpOptions = {}): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  await deadline(signal, options.timeoutMs ?? 120_000, async requestSignal => {
    await download([url], target, requestSignal, { fetch: guardedFetch({ ...options, maxBytes }), attempts: 1,
      progress: progress => { if (progress.receivedBytes > maxBytes || progress.totalBytes > maxBytes) throw new Error('Extension archive exceeds its download limit'); } });
  });
}

function archiveName(raw: string): string {
  const name = raw.replace(/\/$/, '');
  if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe extension archive path');
  return name;
}
/** Extract only regular files into a new private tree; no links, path aliases or special files. */
export async function extractExtensionZip(archive: string, root: string, signal: AbortSignal, prefix = ''): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error || !file ? reject(error ?? new Error('Cannot open extension archive')) : resolve(file)));
  let count = 0, bytes = 0; const names = new Map<string, boolean>();
  let writing: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void => { zip.close(); reject(error); };
      const cancel = (): void => fail(new Error('cancelled'));
      signal.addEventListener('abort', cancel, { once: true });
      zip.once('close', () => signal.removeEventListener('abort', cancel));
      zip.once('error', fail); zip.once('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        writing = (async () => {
          checkCancelled(signal);
          const entryName = entry.fileName.replace(/^(?:\.\/)+/, '');
          if (!entryName && entry.fileName.endsWith('/')) return;
          archiveName(entryName);
          if (++count > 20_000 || (bytes += entry.uncompressedSize) > MAX_EXTRACT_BYTES) throw new Error('Extension archive exceeds extraction limits');
          if (prefix && !entryName.startsWith(prefix)) return;
          const raw = prefix ? entryName.slice(prefix.length) : entryName;
          if (!raw) return;
          const relative = archiveName(raw), mode = entry.externalFileAttributes >>> 16, kind = mode & 0o170000;
          const directory = entry.fileName.endsWith('/'), key = relative.toLowerCase();
          if (kind && kind !== (directory ? 0o040000 : 0o100000)) throw new Error('Extension archive contains a link or special file');
          if (names.has(key)) { if (names.get(key) && directory) return; throw new Error('Extension archive contains a duplicate path'); }
          names.set(key, directory);
          const path = await managedPath(root, relative, true);
          if (directory) { await mkdir(path, { recursive: true, mode: 0o700 }); return; }
          const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error('Cannot read extension archive entry')) : resolve(stream)));
          let crc = 0;
          const checksum = new Transform({ transform(chunk: Buffer, _encoding, callback) { crc = crc32(chunk, crc); callback(null, chunk); } });
          await pipeline(stream, checksum, createWriteStream(path, { flags: 'wx', mode: mode & 0o111 ? 0o700 : 0o600 }), { signal });
          if (crc !== entry.crc32) throw new Error('Extension archive entry CRC-32 mismatch');
        })();
        void writing.then(() => { if (signal.aborted) cancel(); else zip.readEntry(); }, fail);
      });
      if (signal.aborted) cancel(); else zip.readEntry();
    });
  } finally { zip.close(); await writing?.catch(() => undefined); }
}

export async function copyExtensionTree(source: string, target: string, signal: AbortSignal): Promise<void> {
  const root = await realpath(source), ancestors = new Set<string>(); let count = 0, bytes = 0;
  if (pathInside(join(await realpath(dirname(target)), basename(target)), root)) throw new Error('Extension source contains its staging directory');
  const visit = async (from: string, to: string): Promise<void> => {
    checkCancelled(signal);
    let canonical: string;
    // A link whose target no longer exists carries no content; copying skips it instead of failing the tree.
    try { canonical = await realpath(from); } catch (error) { if (missing(error)) return; throw error; }
    const info = await stat(canonical);
    if (!pathInside(canonical, root)) throw new EscapedLinkError('Extension source contains an escaped link: ' + from);
    if (++count > 20_000) throw new UnreadableSourceError('Extension source has too many entries');
    if (info.isDirectory()) {
      if (ancestors.has(canonical)) throw new Error('Extension source contains a link cycle');
      ancestors.add(canonical); await mkdir(to, { recursive: true, mode: 0o700 });
      try { for (const name of await readdir(from)) await visit(join(from, name), join(to, name)); }
      finally { ancestors.delete(canonical); }
    } else if (info.isFile()) {
      if ((bytes += info.size) > MAX_EXTRACT_BYTES) throw new UnreadableSourceError('Extension source exceeds its copy limit');
      await copyFile(canonical, to);
    } else throw new UnreadableSourceError('Extension source contains a special file');
  };
  await visit(source, target);
}

/** Keep the old directory recoverable until the associated durable metadata write succeeds. */
export async function replaceExtensionDirectory(root: string, relative: string, source: string, signal: AbortSignal, commit: () => Promise<void>): Promise<void> {
  const target = await managedPath(root, relative, true), backup = join(dirname(target), '.klaus-backup-' + randomBytes(12).toString('hex'));
  let hadExisting = false, replaced = false;
  try { const info = await lstat(target); if (!info.isDirectory()) throw new Error('Extension destination must be a regular directory'); hadExisting = true; }
  catch (error) { if (!missing(error)) throw error; }
  checkCancelled(signal);
  if (hadExisting) await rename(target, backup);
  try { await rename(source, target); replaced = true; await commit(); }
  catch (error) {
    if (error instanceof UnconfirmedExtensionError) {
      if (hadExisting) error.message += '; previous content retained at ' + backup;
      throw error;
    }
    try { if (replaced) await rm(target, { recursive: true }); if (hadExisting) await rename(backup, target); }
    catch (restoreError) { throw new AggregateError([error, restoreError], 'Extension replacement failed; the prior directory could not be restored from ' + backup); }
    throw error;
  }
  if (hadExisting) {
    try { await rm(backup, { recursive: true }); }
    catch { throw new SavedExtensionError('Extension was saved, but its old backup could not be removed: ' + backup); }
  }
}
