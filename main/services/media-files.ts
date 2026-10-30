import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { DirectoryLeases } from './directory-leases';
import { pathInside } from './workspaces';
import { sniffMime } from './media';

export const MEDIA_SCHEME = 'klaus-media';
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg',
};
const HTML_TYPES: Record<string, string> = { html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml' };
const PREVIEW_TYPES: Record<string, string> = {
  ...TYPES, ...HTML_TYPES, css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', txt: 'text/plain', csv: 'text/csv',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
};
interface Grant { path: string; sessionId: string; preview?: { root: string; originalRoot: string; widget?: boolean } }
interface MediaAttempt { sessionId: string; cancelled: boolean }
interface PreviewRequest { token: string; grant: Grant; path: string; type: string }

function previewPolicy(token: string): string {
  const source = `${MEDIA_SCHEME}://preview/${token}/`;
  return `default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline' ${source}; style-src 'unsafe-inline' ${source}; img-src data: blob: ${source}; font-src data: ${source}; media-src blob: ${source}; connect-src ${source}; frame-src ${source}; base-uri 'none'; form-action 'none'`;
}

function widgetPolicy(): string {
  return "default-src 'none'; sandbox allow-scripts allow-forms; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
}

/** Capability URLs expose only an approved file and expire with its workspace binding. */
export class MediaFiles {
  private readonly grants = new Map<string, Grant>();
  private readonly directories = new DirectoryLeases();
  private readonly streams = new Map<Readable, string>();
  private readonly grantStreams = new Map<Readable, Grant>();
  private readonly attempts = new Set<MediaAttempt>();
  private closed = false;
  constructor(private readonly allowed: (path: string, sessionId: string) => Promise<boolean>) {}

  async grant(path: string, sessionId: string): Promise<string> {
    if (this.closed) throw new Error('The media service is closed');
    const attempt: MediaAttempt = { sessionId, cancelled: false };
    this.attempts.add(attempt);
    try {
    const canonical = await realpath(path);
    if (!await this.allowed(canonical, sessionId)) throw new Error('The file is outside this conversation');
    if (this.closed || attempt.cancelled) throw new Error('The media grant was revoked');
    for (const [token, grant] of this.grants) {
      if (!grant.preview && grant.path === canonical && grant.sessionId === sessionId) {
        this.grants.delete(token); this.grants.set(token, grant);
        return `${MEDIA_SCHEME}://file/${token}`;
      }
    }
    this.limitGrants();
    const token = randomBytes(24).toString('hex');
    this.grants.set(token, { path: canonical, sessionId });
    return `${MEDIA_SCHEME}://file/${token}`;
    } finally { this.attempts.delete(attempt); }
  }

  /** HTML gets a directory capability; each resource still requires current session scope. */
  async grantHtmlPreview(path: string, sessionId: string, scopeRoot: string, widget = false): Promise<string> {
    if (this.closed) throw new Error('The media service is closed');
    if (!isAbsolute(path) || !isAbsolute(scopeRoot) || !HTML_TYPES[extname(path).slice(1).toLowerCase()]) throw new Error('Invalid HTML preview path');
    const attempt: MediaAttempt = { sessionId, cancelled: false };
    this.attempts.add(attempt);
    try {
      return await this.directories.run(async () => [path, scopeRoot], async () => {
        const canonical = await realpath(path), root = await realpath(scopeRoot);
        if (!pathInside(resolve(path), resolve(scopeRoot)) || !pathInside(canonical, root) || !await this.allowed(canonical, sessionId)) throw new Error('The file is outside this conversation');
        if (!(await stat(canonical)).isFile()) throw new Error('The preview is not a file');
        if (this.closed || attempt.cancelled) throw new Error('The HTML preview was revoked');
        const originalRoot = resolve(scopeRoot), suffix = relative(originalRoot, resolve(path)).split(/[\\/]/u).map(encodeURIComponent).join('/');
        for (const [token, grant] of this.grants) {
          if (grant.path === canonical && grant.sessionId === sessionId && grant.preview?.root === root && grant.preview.originalRoot === originalRoot && !!grant.preview.widget === widget) {
            this.grants.delete(token); this.grants.set(token, grant);
            return `${MEDIA_SCHEME}://${widget ? 'widget' : 'preview'}/${token}/${suffix}`;
          }
        }
        this.limitGrants();
        const token = randomBytes(24).toString('hex');
        this.grants.set(token, { path: canonical, sessionId, preview: { root, originalRoot, widget } });
        return `${MEDIA_SCHEME}://${widget ? 'widget' : 'preview'}/${token}/${suffix}`;
      });
    } finally { this.attempts.delete(attempt); }
  }

  grantWidgetSnapshot(path: string, sessionId: string, scopeRoot: string): Promise<string> {
    return this.grantHtmlPreview(path, sessionId, scopeRoot, true);
  }

  private dropGrant(token: string): void {
    const grant = this.grants.get(token);
    this.grants.delete(token);
    if (grant) for (const [stream, owner] of this.grantStreams) if (owner === grant) stream.destroy();
  }
  private limitGrants(): void { while (this.grants.size >= 4096) this.dropGrant(this.grants.keys().next().value!); }

  revokeSession(sessionId: string): void {
    for (const attempt of this.attempts) if (attempt.sessionId === sessionId) attempt.cancelled = true;
    for (const [token, grant] of this.grants) if (grant.sessionId === sessionId) this.dropGrant(token);
    // Legacy path URLs have no ledger token but their active streams still have an owner.
    for (const [stream, grant] of this.grantStreams) if (grant.sessionId === sessionId) stream.destroy();
  }
  close(): void { this.closed = true; this.grants.clear(); for (const attempt of this.attempts) attempt.cancelled = true; for (const stream of this.streams.keys()) stream.destroy(); }
  quiesceDirectory(root: string): Promise<() => void> {
    return this.directories.quiesce(root, async roots => {
      for (const [stream, path] of this.streams) if (await this.directories.overlaps([path], roots) && !stream.closed) {
        await new Promise<void>(resolve => { stream.once('close', resolve); stream.destroy(); });
      }
    });
  }

  private legacy(url: URL): Grant | undefined {
    if (url.protocol !== `${MEDIA_SCHEME}:` || url.hostname !== 'localhost' || url.port || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some(key => key !== 's') || url.searchParams.getAll('s').length > 1) return undefined;
    const segment = url.pathname.slice(1);
    if (!segment || segment.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.toString('base64url') !== segment) return undefined;
    let path: string; try { path = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
    if (!isAbsolute(path) || path.includes('\0') || !TYPES[extname(path).slice(1).toLowerCase()]) return undefined;
    return { path, sessionId: url.searchParams.get('s') ?? '' };
  }

  private previewRequest(url: URL): PreviewRequest | undefined {
    if (url.protocol !== `${MEDIA_SCHEME}:` || !['preview', 'widget'].includes(url.hostname) || url.port || url.username || url.password || url.pathname.length > 32768) return undefined;
    const [token, ...parts] = url.pathname.slice(1).split('/');
    if (!token || !/^[a-f0-9]{48}$/u.test(token) || !parts.length) return undefined;
    const grant = this.grants.get(token);
    if (!grant?.preview || !!grant.preview.widget !== (url.hostname === 'widget')) return undefined;
    let decoded: string[];
    try { decoded = parts.map(decodeURIComponent); } catch { return undefined; }
    if (decoded.some(part => !part || part === '.' || part === '..' || /[\\/\0:]/u.test(part))) return undefined;
    const path = resolve(grant.preview.root, ...decoded), type = PREVIEW_TYPES[extname(path).slice(1).toLowerCase()];
    if (!pathInside(path, grant.preview.root) || !type || grant.preview.widget && resolve(path) !== resolve(grant.path)) return undefined;
    return { token, grant, path, type };
  }

  async respond(request: Request): Promise<Response> {
    if (this.closed) return new Response(null, { status: 410 });
    const url = new URL(request.url), origin = request.headers.get('origin');
    const preview = this.previewRequest(url);
    // Sandboxed scripts/modules use an opaque origin. A valid preview token grants
    // only these resources; ordinary media continues to refuse opaque origins.
    if (origin && origin !== 'klaus-app://app' && !(preview && origin === 'null')) return new Response(null, { status: 403 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const grant = preview?.grant ?? (url.protocol === `${MEDIA_SCHEME}:` && url.hostname === 'file' && !url.search && !url.hash && !url.port && !url.username && !url.password
      ? this.grants.get(url.pathname.slice(1)) : this.legacy(url));
    if (!grant || (grant.preview && !preview)) return new Response(null, { status: 404 });
    const attempt: MediaAttempt = { sessionId: grant.sessionId, cancelled: false };
    this.attempts.add(attempt);
    const token = preview?.token ?? (url.hostname === 'file' ? url.pathname.slice(1) : undefined);
    const revoked = (): boolean => this.closed || attempt.cancelled || (token !== undefined && this.grants.get(token) !== grant);
    try {
      const path = preview?.path ?? grant.path;
      return await this.directories.run(async () => [path], async () => {
      if (this.closed) return new Response(null, { status: 410 });
      const canonical = await realpath(path);
      if (preview && (this.grants.get(preview.token) !== grant || !grant.preview || !pathInside(canonical, grant.preview.root)
        || await realpath(grant.preview.originalRoot) !== grant.preview.root)) return new Response(null, { status: 403 });
      if (url.hostname === 'file' && canonical !== grant.path || !await this.allowed(canonical, grant.sessionId)) return new Response(null, { status: 403 });
      const expected = preview ? await stat(canonical) : undefined;
      const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let transferred = false;
      try {
        const info = await file.stat();
        if (!info.isFile()) return new Response(null, { status: 404 });
        if (preview && (this.closed || this.grants.get(preview.token) !== grant || info.ino !== expected!.ino || info.dev !== expected!.dev
          || await realpath(path) !== canonical || await realpath(grant.preview!.originalRoot) !== grant.preview!.root
          || !await this.allowed(canonical, grant.sessionId))) return new Response(null, { status: 403 });
        if (revoked()) return new Response(null, { status: 403 });
        let contentType = preview?.type ?? TYPES[extname(grant.path).slice(1).toLowerCase()] ?? 'application/octet-stream';
        if (contentType.startsWith('image/') && info.size) {
          // Keep path scope and extension restrictions, but prefer the actual image
          // signature for mislabeled captures. Positional reads preserve range offsets.
          const head = Buffer.alloc(Math.min(info.size, 32));
          const { bytesRead } = await file.read(head, 0, head.length, 0);
          const detected = sniffMime(head.subarray(0, bytesRead));
          if (detected?.startsWith('image/')) contentType = detected;
          if (revoked()) return new Response(null, { status: 403 });
        }
        const headers = new Headers({
          'Content-Type': contentType,
          'Content-Length': String(info.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': preview && origin === 'null' ? 'null' : 'klaus-app://app', 'Vary': 'Origin',
          'Content-Security-Policy': preview && HTML_TYPES[extname(path).slice(1).toLowerCase()] ? preview.grant.preview?.widget ? widgetPolicy() : previewPolicy(preview.token) : "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff', ...(preview ? { 'Referrer-Policy': 'no-referrer' } : {}),
        });
        if (preview?.grant.preview?.widget) {
          if (info.size > 256 * 1024) return new Response(null, { status: 403 });
          const bytes = await file.readFile();
          const match = /-([a-f0-9]{16})\.html$/.exec(basename(canonical));
          if (!match || createHash('sha256').update(bytes).digest('hex').slice(0, 16) !== match[1]) return new Response(null, { status: 403 });
          headers.delete('Accept-Ranges');
          return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { status: 200, headers });
        }
        let start = 0, end = info.size - 1, status = 200;
        const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || (!match[1] && !match[2]) || info.size === 0) {
            headers.set('Content-Range', `bytes */${info.size}`); headers.set('Content-Length', '0');
            return new Response(null, { status: 416, headers });
          }
          if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
            headers.set('Content-Range', `bytes */${info.size}`); headers.set('Content-Length', '0');
            return new Response(null, { status: 416, headers });
          }
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`);
          headers.set('Content-Length', String(end - start + 1));
        }
        if (request.method === 'HEAD' || !info.size) return new Response(null, { status, headers });
        const stream = file.createReadStream({ start, end, autoClose: true });
        this.streams.set(stream, canonical);
        this.grantStreams.set(stream, grant);
        const abort = (): void => { stream.destroy(); };
        request.signal.addEventListener('abort', abort, { once: true });
        stream.once('close', () => { this.streams.delete(stream); this.grantStreams.delete(stream); request.signal.removeEventListener('abort', abort); });
        if (request.signal.aborted) abort();
        transferred = true;
        return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
      } finally { if (!transferred) await file.close(); }
      });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return new Response(null, { status: 404 });
      if ((error as { code?: string }).code === 'DIRECTORY_BUSY') return new Response(null, { status: 423 });
      throw error;
    } finally { this.attempts.delete(attempt); }
  }
}
