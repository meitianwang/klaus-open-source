import { writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { MediaFiles } from './media-files';
import { errorMessage, object, string, type JsonObject } from './service-types';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif', 'image/x-icon': 'ico' };
export interface ImageActionDeps {
  media: MediaFiles;
  saveDialog(name: string): Promise<string | undefined>;
  copyImage(bytes: Buffer): void | Promise<void>;
  reveal(path: string): void;
  diagnostic?(detail: Record<string, string | number>): void;
}
interface ImageSource { bytes: Buffer; mimeType: string; name: string; path?: string; grant?: string }

/** Image actions share the display capability, including revocation and realpath checks. */
export class ImageActions {
  constructor(private readonly deps: ImageActionDeps) {}
  private async source(args: JsonObject): Promise<ImageSource> {
    const path = string(args.filePath), sessionId = string(args.sessionId);
    if (path) {
      const grant = await this.deps.media.grant(path, sessionId);
      const response = await this.deps.media.respond(new Request(grant));
      if (!response.ok) throw new Error('The image is unavailable or outside this conversation');
      const mimeType = response.headers.get('content-type') || '';
      if (!EXTENSIONS[mimeType]) { await response.body?.cancel(); throw new Error('Unsupported image type'); }
      const size = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new Error('Image exceeds the 64 MiB limit'); }
      const bytes = Buffer.from(await response.arrayBuffer());
      const result = { bytes, mimeType, name: this.filename(string(args.name) || basename(path), mimeType), path, grant };
      await this.revalidate(result);
      return result;
    }
    const mimeType = string(args.mimeType), data = string(args.data);
    if (!EXTENSIONS[mimeType] || !data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Invalid image bytes');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data) throw new Error('Invalid image bytes');
    return { bytes, mimeType, name: this.filename(string(args.name), mimeType) };
  }
  private filename(name: string, mimeType: string): string {
    const clean = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'image';
    const suffix = EXTENSIONS[mimeType]!;
    const extension = extname(clean).slice(1).toLowerCase();
    return extension === suffix || mimeType === 'image/jpeg' && extension === 'jpeg' ? clean : clean.slice(0, clean.length - extname(clean).length) + '.' + suffix;
  }
  private async revalidate(source: ImageSource): Promise<void> {
    if (!source.grant) return;
    const response = await this.deps.media.respond(new Request(source.grant, { method: 'HEAD' }));
    if (!response.ok) throw new Error('The image permission was revoked');
  }
  private failureReason(error: unknown): string {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code || '')) return 'not-found';
    if (code === 'DIRECTORY_BUSY') return 'busy';
    if (['EACCES', 'EPERM'].includes(code || '') || /outside this conversation|revoked/.test(errorMessage(error))) return 'denied';
    return 'unavailable';
  }
  private async inspect(args: JsonObject): Promise<JsonObject> {
    const path = string(args.filePath), sessionId = string(args.sessionId);
    let reason = 'unavailable', status = 0;
    try {
      if (!path) throw new Error('This image has no local file');
      const url = await this.deps.media.grant(path, sessionId);
      const response = await this.deps.media.respond(new Request(url, { method: 'HEAD' }));
      status = response.status;
      if (!response.ok) {
        reason = status === 404 ? 'not-found' : status === 423 ? 'busy' : status === 403 || status === 410 ? 'denied' : 'unavailable';
        throw new Error('The image could not be read');
      }
      const mimeType = response.headers.get('content-type') || '';
      const size = Number(response.headers.get('content-length'));
      if (!EXTENSIONS[mimeType] || !Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) {
        reason = 'invalid'; throw new Error('Unsupported or empty image');
      }
      if (args.loadFailed === true) this.deps.diagnostic?.({ sessionId, path, reason: 'unavailable', status, error: 'Image load failed; scoped metadata inspection succeeded' });
      return { ok: true, url, mimeType, size, name: this.filename(string(args.name) || basename(path), mimeType) };
    } catch (error) {
      if (reason === 'unavailable') reason = this.failureReason(error);
      this.deps.diagnostic?.({ sessionId, path, reason, status, error: errorMessage(error) });
      return { ok: false, reason, error: errorMessage(error) };
    }
  }
  async read(args: JsonObject): Promise<JsonObject> {
    if (args.inspect === true) return this.inspect(args);
    try { const source = await this.source(args); return { ok: true, data: source.bytes.toString('base64'), mimeType: source.mimeType, name: source.name }; }
    catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async save(args: JsonObject): Promise<JsonObject> {
    try {
      const source = await this.source(args), destination = await this.deps.saveDialog(source.name);
      if (!destination) return { ok: true, cancelled: true };
      await this.revalidate(source);
      await writeFile(destination, source.bytes, { mode: 0o600 });
      return { ok: true, filePath: destination };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async copy(args: JsonObject): Promise<JsonObject> {
    try { const source = await this.source(args); await this.revalidate(source); await this.deps.copyImage(source.bytes); return { ok: true }; }
    catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
  async reveal(args: JsonObject): Promise<JsonObject> {
    try {
      const source = await this.source(args);
      if (!source.path) throw new Error('This image has no local file');
      await this.revalidate(source); this.deps.reveal(source.path); return { ok: true };
    } catch (error) { return { ok: false, error: errorMessage(error) }; }
  }
}
