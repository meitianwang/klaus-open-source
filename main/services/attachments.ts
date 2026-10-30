import { mediaInputMime, MEDIA_INPUT_FILE_LIMIT } from '../../shared/media-input';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import type { Json } from '../ipc/contract';
import { BINARY_KEY, decodeBinary } from '../ipc/binary';
import { IpcHandlerError } from '../ipc/registry';
import { expandHomePrefix } from '../paths';
import { managedPath } from './extensions/file-store';
import { object, string, type JsonObject } from './service-types';
import type { WorkspaceStore } from './workspaces';

export const IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const FILE_UPLOAD_LIMIT = 45 * 1024 * 1024;
const INLINE_TOTAL_LIMIT = 45 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const IMAGE_ALIASES: Record<string, string> = { 'image/jpg': 'image/jpeg', 'image/x-png': 'image/png' };
const TEXT_EXTENSIONS = new Set('md markdown txt log json jsonl csv tsv xml html htm js ts tsx jsx py rs java c cpp h yaml yml toml sh css'.split(' '));
const mimeBase = (mime: string): string => mime.split(';', 1)[0]!.trim().toLowerCase();
const extension = (name: string): string => extname(name.split(/[/\\]/).at(-1) ?? '').slice(1).toLowerCase();
const imageMime = (mime: string): string | undefined => IMAGE_ALIASES[mime] ?? (Object.values(IMAGE_TYPES).includes(mime) ? mime : undefined);
export function uploadMime(name: string, declared = ''): string {
  const type = mimeBase(declared);
  if (type && type !== 'application/octet-stream') return type;
  const ext = extension(name);
  if (type) return IMAGE_TYPES[ext] ?? type;
  return IMAGE_TYPES[ext] ?? ({ svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', log: 'text/plain',
    json: 'application/json', csv: 'text/csv', html: 'text/html', htm: 'text/html', xml: 'application/xml' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
export function uploadLimit(name: string, mime: string): number {
  const type = mimeBase(mime);
  return (type ? imageMime(type) : IMAGE_TYPES[extension(name)]) ? IMAGE_UPLOAD_LIMIT : FILE_UPLOAD_LIMIT;
}
function textLike(name: string, mime: string): boolean {
  const type = mimeBase(mime);
  return type.startsWith('text/') || ['application/json', 'application/xml'].includes(type) || TEXT_EXTENSIONS.has(extension(name));
}
function countLines(bytes: Uint8Array, previous: number): number {
  for (const byte of bytes) if (byte === 10) previous++;
  return previous;
}
function localPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new IpcHandlerError('BAD_REQUEST', 'A local file path is required');
  return resolve(expandHomePrefix(value.trim(), homedir())!);
}
async function regularFile(path: string): Promise<FileHandle> {
  const file = await open(await realpath(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try { if (!(await file.stat()).isFile()) throw new Error('not_file'); return file; }
  catch (error) { await file.close(); throw error; }
}
async function readInline(path: string, limit: number): Promise<Buffer> {
  const file = await regularFile(path);
  try {
    const before = await file.stat();
    if (!before.size || before.size > limit) throw new Error(`Attachment must contain 1 to ${limit} bytes`);
    const chunks: Buffer[] = []; let size = 0;
    while (size <= limit) {
      const chunk = Buffer.alloc(Math.min(256 * 1024, limit + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break; size += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (size > limit || before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Attachment changed while being read');
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}

/** A single invalid attachment rejects the entire message before any turn is submitted. */
export async function buildMessageInput(text: string, media: Json[], mediaInputMimeTypes: readonly string[] = []): Promise<Json> {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new IpcHandlerError('BAD_REQUEST', 'The message is too large');
  if (!media.length) return text;
  if (media.length > 20) throw new IpcHandlerError('UNSUPPORTED_ATTACHMENT', 'At most 20 inline attachments are supported');
  const parts: Json[] = text ? [{ type: 'text', text }] : [];
  let total = 0;
  for (const item of media) {
    const file = object(item), name = string(file.name) || string(file.fileName) || basename(string(file.path)) || 'attachment';
    try {
      const declaredMedia = mediaInputMime(name, string(file.mimeType) || string(file.type));
      if (file.type === 'media') {
        if (!declaredMedia) throw new Error('Invalid audio or video MIME type');
        // The path reference stays in the request when this model cannot consume the bytes.
        if (!mediaInputMimeTypes.includes(declaredMedia)) continue;
        const bytes = await readInline(localPath(file.path), Math.min(MEDIA_INPUT_FILE_LIMIT, INLINE_TOTAL_LIMIT - total));
        total += bytes.length;
        parts.push({ type: 'media', base64: bytes.toString('base64'), mimeType: declaredMedia, filename: name });
        continue;
      }
      const declared = mimeBase(string(file.mimeType) || string(file.type)), ext = extension(name);
      const pdf = declared === 'application/pdf' || ext === 'pdf', mime = pdf ? 'application/pdf' : imageMime(declared) ?? IMAGE_TYPES[ext];
      if (!mime) throw new Error('Use JPEG, PNG, GIF, WebP or PDF for inline content; attach other files as path references');
      const bytes = await readInline(localPath(file.path), Math.min(pdf ? 20 * 1024 * 1024 : 25 * 1024 * 1024, INLINE_TOTAL_LIMIT - total));
      total += bytes.length;
      parts.push({ type: pdf ? 'document' : 'image', base64: bytes.toString('base64'), mimeType: mime, ...(pdf ? { filename: name } : {}) });
    } catch (error) { throw new IpcHandlerError('UNSUPPORTED_ATTACHMENT', `Cannot attach ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return parts.length === (text ? 1 : 0) ? text : parts;
}

/** Upload caches are host-owned, bounded and only published after a complete write. */
export class AttachmentService {
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly workspaces: WorkspaceStore) {}
  private run<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new IpcHandlerError('SERVICE_CLOSED', 'Attachment service is closed'));
    if (this.pending.size >= 4) return Promise.reject(new IpcHandlerError('BUSY', 'Too many attachment operations are in progress'));
    const pending = this.workspaces.withDirectoryOperation(async () => [...paths, join(this.workspaces.configRoot, 'uploads')], operation);
    this.pending.add(pending); return pending.finally(() => { this.pending.delete(pending); });
  }
  input(text: string, media: Json[], mediaInputMimeTypes: readonly string[] = []): Promise<Json> {
    return this.run(media.map(value => localPath(object(value).path)), () => buildMessageInput(text, media, mediaInputMimeTypes));
  }
  async answerAttachments(groups: JsonObject): Promise<JsonObject> {
    const entries = Object.entries(groups);
    if (entries.length > 4 || entries.some(([, files]) => !Array.isArray(files))) throw new IpcHandlerError('BAD_REQUEST', 'Invalid question attachments');
    const files = entries.flatMap(([question, rows]) => (rows as Json[]).map(value => ({ question, file: object(value) })));
    if (files.length > 20) throw new IpcHandlerError('BAD_REQUEST', 'At most 20 question attachments are supported');
    const paths = files.map(({ file }) => localPath(file.path));
    return this.run(paths, async () => {
      const root = await realpath(join(this.workspaces.configRoot, 'uploads'));
      const images: Array<{ question: string; file: JsonObject }> = [];
      for (const { question, file } of files) {
        const path = await realpath(localPath(file.path));
        if (resolve(root, basename(path)) !== path) throw new IpcHandlerError('BAD_REQUEST', 'Question attachments must be uploaded first');
        const name = string(file.name) || basename(path), declared = mimeBase(string(file.type) || string(file.mimeType));
        const mime = imageMime(uploadMime(name, declared));
        const source = await regularFile(path);
        try {
          const size = (await source.stat()).size;
          if (size > (mime ? IMAGE_UPLOAD_LIMIT : FILE_UPLOAD_LIMIT)) throw new IpcHandlerError('UPLOAD_TOO_LARGE', 'file_too_large');
        } finally { await source.close(); }
        if (mime) images.push({ question, file: { path, name, mimeType: mime } });
      }
      if (!images.length) return {};
      const parts = await buildMessageInput('', images.map(row => row.file)) as Json[];
      return Object.fromEntries(entries.flatMap(([question]) => {
        const media = images.flatMap((row, index) => row.question === question ? [parts[index]!] : []);
        return media.length ? [[question, media]] : [];
      }));
    });
  }
  private async store(name: string, mime: string, source: Uint8Array | FileHandle): Promise<JsonObject> {
    const limit = uploadLimit(name, mime), dir = await managedPath(this.workspaces.configRoot, 'uploads', true);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID(), ext = extension(name), fallback = Object.entries(IMAGE_TYPES).find(([, type]) => type === imageMime(mimeBase(mime)))?.[0] ?? (mimeBase(mime) === 'application/pdf' ? 'pdf' : '');
    const suffix = /^[\p{L}\p{N}_-]{1,24}$/u.test(ext) ? '.' + ext : fallback ? '.' + fallback : '';
    const path = join(dir, id + suffix), temporary = join(dir, '.' + id + '.tmp'), output = await open(temporary, 'wx', 0o600);
    let size = 0, lines = 0, last: number | undefined;
    const textual = textLike(name, mime);
    try {
      const before = source instanceof Uint8Array ? undefined : await source.stat();
      if (before && before.size > limit) throw new IpcHandlerError('UPLOAD_TOO_LARGE', 'file_too_large');
      let offset = 0;
      while (true) {
        let bytes: Uint8Array;
        if (source instanceof Uint8Array) {
          bytes = source.subarray(offset, offset + 256 * 1024); offset += bytes.length;
        } else {
          const chunk = Buffer.alloc(256 * 1024), result = await source.read(chunk, 0, chunk.length, null);
          bytes = chunk.subarray(0, result.bytesRead);
        }
        if (!bytes.length) break;
        size += bytes.length; if (size > limit) throw new IpcHandlerError('UPLOAD_TOO_LARGE', 'file_too_large');
        if (textual) lines = countLines(bytes, lines); last = bytes.at(-1);
        await output.writeFile(bytes);
      }
      if (before && !(source instanceof Uint8Array)) {
        const after = await source.stat();
        if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new IpcHandlerError('UPLOAD_CHANGED', 'The source file changed while uploading');
      }
      await output.sync(); await output.close(); await rename(temporary, path);
      return { path, id, name, type: mime, size, lineCount: textual ? size ? lines + (last === 10 ? 0 : 1) : 0 : null };
    } finally { await output.close(); await rm(temporary, { force: true }); }
  }
  upload(payload: JsonObject): Promise<Json> {
    const name = string(payload.name) || 'upload', mime = uploadMime(name, string(payload.type)), limit = uploadLimit(name, mime);
    if (name.length > 1024 || mime.length > 256) throw new IpcHandlerError('BAD_REQUEST', 'Invalid attachment name or MIME type');
    const value = payload.buffer, encoded = typeof value === 'string' ? value : object(value)[BINARY_KEY];
    if (typeof encoded === 'string' && encoded.length > Math.ceil(limit / 3) * 4 || Array.isArray(value) && value.length > limit) throw new IpcHandlerError('UPLOAD_TOO_LARGE', 'file_too_large');
    return this.run([], async () => {
      const bytes = decodeBinary(value, limit);
      if (!bytes) throw new IpcHandlerError('BAD_REQUEST', 'A valid binary buffer within the upload limit is required');
      return this.store(name, mime, bytes);
    });
  }
  async uploadPath(payload: JsonObject): Promise<Json> {
    try {
      const path = localPath(payload.path);
      return await this.run([path], async () => {
        const source = await regularFile(path);
        try { return { ok: true, ...await this.store(basename(path), uploadMime(path), source) }; }
        finally { await source.close(); }
      });
    } catch (error) { return { ok: false, error: error instanceof IpcHandlerError && error.code === 'UPLOAD_TOO_LARGE' ? 'file_too_large' : error instanceof Error ? error.message : String(error) }; }
  }
  async close(): Promise<void> { this.closed = true; await Promise.allSettled([...this.pending]); }
}
