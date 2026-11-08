import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { MessagePortMain } from 'electron';
import { inside, message, record, type Data } from '../visuals/data';
import { verifyPptRuntime } from './package';
import { PptStore, PPT_ASSET_LIMITS } from './store';

const SHELL = 'klaus-app://app';
const CONTENT_SUFFIX = '.ppt-content';
const TEXT = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json)|image\/svg\+xml)/;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.wasm': 'application/wasm' };
interface Connection { owner: string; id: string; port: MessagePortMain; sockets: Map<string, string>; closed: boolean }
const html = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const scriptJson = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
const bytes = (value: unknown): Uint8Array => typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array();

/** Adapts the editor's browser protocol to Klaus-owned documents and local assets. */
export class PptRuntime {
  private readonly epoch = randomUUID();
  private readonly secret = randomBytes(32);
  private readonly connections = new Set<Connection>();
  private cachedRoot = '';
  private assets = new Set<string>();
  private manifest: Data = {};
  private runtimeManifest: Data = {};
  constructor(readonly store: PptStore, private readonly pluginRoot: () => string | undefined, private readonly log: (event: string, data: Data) => void = () => {}, private readonly language: () => string = () => 'en-US') {}
  private root(): string {
    const plugin = this.pluginRoot();
    if (!plugin) throw new Error('The PPT plugin is not installed.');
    const root = realpathSync(join(plugin, 'runtime'));
    if (root !== this.cachedRoot) {
      verifyPptRuntime(root);
      const manifest = record(JSON.parse(readFileSync(join(root, 'runtime-manifest.json'), 'utf8')));
      this.assets = new Set((manifest.assets as string[]) ?? []);
      this.manifest = manifest;
      const shell = record(JSON.parse(readFileSync(join(root, 'shell/shell-manifest.json'), 'utf8')));
      this.runtimeManifest = record(JSON.parse(readFileSync(join(root, 'common/_runtime', String(record(shell.runtime).hash)), 'utf8')));
      this.cachedRoot = root;
    }
    return root;
  }
  private asset(path: string): Uint8Array {
    const root = this.root();
    if (!this.assets.has(path)) throw new Error('The presentation runtime asset was not found.');
    const resolved = realpathSync(join(root, path));
    if (!inside(root, resolved)) throw new Error('The presentation runtime asset escaped its package.');
    return new Uint8Array(readFileSync(resolved));
  }
  private source(path: string): string { return new TextDecoder().decode(this.asset(path)); }
  /** Packaged files the runtime inventory does not list, read with the same containment check. */
  private packageRoot(): string {
    const plugin = this.pluginRoot();
    if (!plugin) throw new Error('The PPT plugin is not installed.');
    return realpathSync(plugin);
  }
  private packaged(path: string): Uint8Array {
    const root = this.packageRoot();
    const resolved = realpathSync(join(root, path));
    if (!inside(root, resolved)) throw new Error('The presentation runtime asset escaped its package.');
    return new Uint8Array(readFileSync(resolved));
  }
  /** The client ships two locales; the isolated editor UI follows the application language. */
  private locale(): string { return /^zh(?:[-_]|$)/i.test(this.language()) ? 'zh-Hans' : 'en-US'; }
  private shellCatalog: { key: string; hash: string } | undefined;
  private shellCatalogHash(): string | undefined {
    try {
      const stat = statSync(join(this.packageRoot(), 'i18n/frame-shell/zh-Hans.json'));
      const key = `${stat.size}:${stat.mtimeMs}`;
      if (this.shellCatalog?.key !== key) this.shellCatalog = { key, hash: createHash('sha256').update(this.packaged('i18n/frame-shell/zh-Hans.json')).digest('hex').slice(0, 12) };
      return this.shellCatalog.hash;
    }
    catch { this.shellCatalog = undefined; return undefined; }
  }
  private editorCatalog: { key: string; source: string } | undefined;
  /** Serve the editor script with its user-visible strings replaced by the application language catalog. */
  private localizedEditor(): string {
    const source = this.source('dist/artifact-type/app.js');
    let entries: { match: string; zh: string }[] = [];
    let catalogKey = 'missing';
    try {
      const stat = statSync(join(this.packageRoot(), 'i18n/editor/zh-Hans.json'));
      catalogKey = `${stat.size}:${stat.mtimeMs}`;
      const parsed: unknown = JSON.parse(new TextDecoder().decode(this.packaged('i18n/editor/zh-Hans.json')));
      if (Array.isArray(parsed)) entries = parsed as { match: string; zh: string }[];
    }
    catch { entries = []; }
    const key = `${source.length}:${catalogKey}`;
    if (this.editorCatalog?.key === key) return this.editorCatalog.source;
    let out = source;
    for (const entry of entries) {
      if (!entry || typeof entry.match !== 'string' || typeof entry.zh !== 'string' || entry.match.length < 3) continue;
      const quote = entry.match[0];
      if ((quote !== '"' && quote !== "'") || entry.match[entry.match.length - 1] !== quote || !out.includes(entry.match)) continue;
      let escaped = '';
      for (const ch of entry.zh) {
        if (ch === '\\') escaped += '\\\\';
        else if (ch === quote) escaped += `\\${quote}`;
        else if (ch === '\n') escaped += '\\n';
        else if (ch === '\r') escaped += '\\r';
        else if (ch === '\t') escaped += '\\t';
        else if (ch === '\u2028') escaped += '\\u2028';
        else if (ch === '\u2029') escaped += '\\u2029';
        else escaped += ch;
      }
      out = out.split(entry.match).join(`${quote}${escaped}${quote}`);
    }
    this.editorCatalog = { key, source: out };
    return out;
  }
  private identity(owner: string): { account: string; organization: string; viewer: string } {
    const digest = createHash('sha256').update(owner).digest();
    const uuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return { account: uuid(digest.toString('hex')), organization: uuid(createHash('sha256').update('workspace:' + owner).digest('hex')), viewer: 'u_' + digest.subarray(0, 16).toString('base64url') };
  }
  private token(owner: string, id: string, capability: string): string { return createHash('sha256').update(this.secret).update(owner).update(id).update(capability).digest('base64url'); }
  private boot(owner: string, id: string): Data {
    const document = this.store.get(owner, id), identity = this.identity(owner);
    const assetToken = `${randomBytes(18).toString('base64url')}.${identity.organization}.${identity.account}.${Math.floor(Date.now() / 1000) + 86400}`;
    return { kind: 'authed', ver: document.version, live: document.version, liveEntry: 'page', seq: document.seq,
      assetToken, wsToken: this.token(owner, id, 'live'), title: document.title, favicon: '', created_at: document.createdAt, updated_at: document.updatedAt,
      runtime: { contract: '0.0.0', changes: [] }, hot: true, typeInstance: true, type: { slug: 'slides' }, typeSlug: 'slides', typeTitle: 'PPT',
      singleUser: true, exportSurface: true, artifactFilesEnabled: true, downloadsExtendedTypes: true,
      permissionsEnabled: true, reportEnabled: true, tokenExchangeEnabled: false, pregrantEnabled: false,
      perm: { role: 'owner', mode: 'owner', users: [], version: 1, assignableReadModes: ['owner'] }, author: { account: identity.account, name: 'You' },
      viewer: { id: identity.viewer, owner: true, can_edit: true, account: identity.account, profile: true, email: false, peers: false, role: 'owner', can: ['assets.write', 'data.write', 'files.write'] },
      consent: {}, capabilities: {
        self: { config: {}, policy: 'none', token: this.token(owner, id, 'self') }, downloads: { config: {}, policy: 'per-use-confirm' },
        assets: { config: {}, policy: 'none', token: this.token(owner, id, 'assets') }, room: { config: {}, policy: 'none' },
        user: { config: { scopes: ['profile'] }, policy: 'none', token: this.token(owner, id, 'user') },
      } };
  }
  private response(body: string | Uint8Array | null, status = 200, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}): Response {
    return new Response(body as ConstructorParameters<typeof Response>[0], { status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
  }
  private json(value: unknown, status = 200): Response { return this.response(JSON.stringify(value), status, 'application/json'); }
  private content(): string {
    this.root();
    const manifest = this.runtimeManifest;
    const preamble = { v: 1, cred: 'query', origins: [SHELL], capabilities: manifest.capabilities, transforms: manifest.transforms, comments: manifest.comments, translate: manifest.translate, ldx: manifest.ldx };
    const inject = `<script>window.__FRAME_PREAMBLE=${scriptJson(preamble)}</script><script src="/_runtime/${html(String(manifest.kernel))}"></script>`;
    return this.source('dist/index.html').replace('<html lang="en"', `<html lang="${this.locale()}"`).replace('<!-- frame-runtime -->', `<!-- frame-runtime -->${inject}`);
  }
  private shellPage(owner: string, id: string): string {
    const nonce = randomBytes(18).toString('base64');
    const attrs = ` data-frame-uuid="${id}" data-frame-uchost="${id}${CONTENT_SUFFIX}"`;
    const hash = this.shellCatalogHash();
    const meta = `<meta name="frame-shell-i18n" data-shipped="en-US${hash ? ',zh-Hans' : ''}"${hash ? ` data-catalogs="zh-Hans:${hash}"` : ''}>`;
    const seed = `<script>try{localStorage.setItem("spa:locale",${scriptJson(this.locale())})}catch(error){}</script>`;
    return this.source('shell/frame-shell.html').replace('<head>', `<head>${meta}${seed}`).replace('<html lang="en">', `<html lang="en"${attrs}>`).replace('<div id="frame-slot">', `<div id="frame-slot"${attrs}>`).replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`).replace('<title>Artifact</title>', `<title>${html(this.store.get(owner, id).title)}</title>`);
  }
  async page(owner: string, id: string, request: Request): Promise<Response> {
    try {
      this.store.get(owner, id); this.root();
      const url = new URL(request.url), shell = url.origin === SHELL || `${url.protocol}//${url.host}` === SHELL;
      if (url.username || url.password || url.port || !['app', `${id}${CONTENT_SUFFIX}`].includes(url.host)) return this.response('Forbidden', 403);
      const path = url.pathname;
      if (shell && path === `/code/artifact/${id}`) return this.response(this.shellPage(owner, id), 200, 'text/html; charset=utf-8', { 'Content-Security-Policy': `default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src klaus-app://${id}${CONTENT_SUFFIX}; object-src 'none'; base-uri 'none'; form-action 'none'` });
      if (shell && path.startsWith('/assets/')) return this.static('shell/' + path.slice('/assets/'.length));
      if (shell && (path.startsWith('/api/') || path.startsWith('/edge-api/'))) return this.call(owner, id, request.method, path + url.search, [...request.headers], request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer());
      if (shell && path.startsWith('/i18n/frame-shell/')) {
        const name = path.slice('/i18n/frame-shell/'.length);
        if (/^[\w-]+\.json$/.test(name)) return this.response(this.packaged(`i18n/frame-shell/${name}`), 200, 'application/json; charset=utf-8');
      }
      if (shell) return this.response('Not found', 404);
      if (path === '/_warmup') return this.response('<!doctype html><html><head></head><body></body></html>', 200, 'text/html');
      if (path === '/_t') {
        const version = url.searchParams.get('v') ?? this.store.get(owner, id).version;
        this.store.files(owner, id, version);
        return this.response(null, 302, 'text/plain', { Location: `/_f/${version}/index.html${url.search}` });
      }
      if (path.startsWith('/_runtime/')) return this.static('common' + path);
      if (path.startsWith('/_/claude:')) {
        const [cap, contract] = path.slice('/_/claude:'.length).split('@');
        if (cap === 'use') return this.static('common/_runtime/' + String(this.runtimeManifest.use));
        if (cap === 'hot') return this.response('export default globalThis.claude?.hot;', 200, 'text/javascript');
        if (!Object.hasOwn(record(this.runtimeManifest.capabilities), cap!)) return this.response('Unknown capability', 404);
        return this.response(`import { at } from '/_/claude:use'; export default at(${JSON.stringify(cap)}${contract ? ', {contract:' + JSON.stringify(contract) + '}' : ''});`, 200, 'text/javascript');
      }
      const versioned = /^\/_f\/(v[1-9]\d*)\/(.*)$/.exec(path);
      if (path === '/' || path === '/index.html') return this.response(null, 302, 'text/plain', { Location: `/_f/${this.store.get(owner, id).version}/index.html` });
      const relative = versioned ? versioned[2]! : path.slice(1), version = versioned?.[1];
      if ((relative === 'index.html' || relative === '') && version) return this.response(this.content(), 200, 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; media-src 'self' blob: data:; font-src 'self' data: blob: https:; connect-src 'self' https: wss:; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'" });
      if (relative === '_files.json' && version) {
        const files = Object.fromEntries(this.store.files(owner, id, version).map(file => [file.path, { sha256: file.sha256, size: file.size, contentType: file.contentType }]));
        // The runtime entry exists before any slide files are published. Listing it
        // lets the editor open an empty document and receive the first live update.
        const entry = Buffer.from(this.content());
        files['index.html'] = { sha256: createHash('sha256').update(entry).digest('hex'), size: entry.length, contentType: 'text/html; charset=utf-8' };
        return this.json({ ver: version, files });
      }
      if (relative.startsWith('artifact-type/')) {
        if (relative === 'artifact-type/app.js' && this.locale() === 'zh-Hans') return this.response(this.localizedEditor(), 200, 'text/javascript; charset=utf-8');
        return this.static('dist/' + relative);
      }
      if (relative.startsWith('_blob/')) {
        const asset = this.store.asset(owner, id, relative.slice('_blob/'.length));
        return this.response(asset.bytes, 200, asset.type);
      }
      if (!version) return this.response('Not found', 404);
      const contentPath = relative.split('/').map(part => decodeURIComponent(part)).join('/');
      const entry = this.store.files(owner, id, version).find(file => file.path === contentPath);
      if (!entry) return this.response('Not found', 404);
      return this.response(this.store.read(owner, id, contentPath, version), 200, entry.contentType);
    } catch (error) { this.log('ppt-resource-error', { error: message(error), url: request.url }); return this.response(message(error), 404); }
  }
  private static(path: string): Response { return this.response(this.asset(path), 200, MIME[extname(path)] ?? 'application/octet-stream', { 'Access-Control-Allow-Origin': SHELL, 'Cross-Origin-Resource-Policy': 'cross-origin' }); }
  private decodeJson(body: unknown): Data {
    const value = bytes(body);
    if (value.byteLength > 350 * 1024 * 1024) throw new Error('The presentation request is too large.');
    return value.length ? record(JSON.parse(new TextDecoder().decode(value))) : {};
  }
  async call(owner: string, id: string, method: string, target: string, headers: string[][] = [], body?: unknown): Promise<Response> {
    try {
      const document = this.store.get(owner, id), url = new URL(target, SHELL), path = url.pathname;
      if (url.origin !== new URL(SHELL).origin || !target.startsWith('/') || target.startsWith('//')) return this.response('Forbidden', 403);
      if (method === 'GET' && path === `/api/frame/${id}`) return this.json(this.boot(owner, id));
      const identity = this.identity(owner);
      if (method === 'GET' && path === '/api/account') return this.json({ uuid: identity.account, full_name: 'You', display_name: 'You', memberships: [{ organization: { uuid: identity.organization, name: 'Local workspace', capabilities: [] }, role: 'admin' }] });
      if (method === 'GET' && path.startsWith(`/api/organizations/${identity.organization}/members`)) return this.json([{ uuid: identity.account, account: { uuid: identity.account, full_name: 'You', display_name: 'You' }, full_name: 'You', display_name: 'You' }]);
      if (method === 'POST' && ['/api/frame/track', '/api/frame/telemetry', `/api/frame/page-health/${id}`].includes(path)) return this.response(null, 204);
      if (method === 'POST' && path === `/api/frame/self/${id}`) {
        const args = this.decodeJson(body);
        if (args.token !== this.token(owner, id, 'self')) return this.json({ error: 'not_writer' }, 403);
        if (args.mode !== 'patch' || typeof args.baseVersion !== 'string') return this.json({ error: 'invalid_request' }, 400);
        const manifest = record(args.manifest), writes: { path: string; bytes: Uint8Array; contentType: string }[] = [], remove: string[] = [];
        for (const [path, input] of Object.entries(manifest)) {
          if (input === null) { remove.push(path); continue; }
          const file = record(input);
          if (typeof file.content !== 'string' || typeof file.contentType !== 'string') return this.json({ error: 'invalid_manifest' }, 400);
          const value = TEXT.test(file.contentType) ? new TextEncoder().encode(file.content) : Buffer.from(file.content, 'base64');
          writes.push({ path, bytes: value, contentType: file.contentType });
        }
        const result = this.store.publish(owner, id, { baseVersion: args.baseVersion, writes, remove });
        this.changed(owner, id);
        return this.json(result);
      }
      if (method === 'POST' && path === `/api/frame/retitle/${id}`) {
        const args = this.decodeJson(body);
        if (typeof args.title !== 'string') return this.json({ error: 'invalid_title' }, 400);
        if (typeof args.if_title === 'string' && args.if_title !== document.title || typeof args.if_unnamed === 'string' && args.if_unnamed !== document.title) return this.json({ error: 'title_kept' }, 412);
        const updated = this.store.retitle(owner, id, args.title); this.changed(owner, id);
        return this.json({ title: updated.title, version: updated.version });
      }
      const blobPrefix = `/api/frame/blob/${id}/`;
      if (method === 'POST' && path.startsWith(blobPrefix)) {
        if (new Headers(headers).get('X-Frame-Blobs-Token') !== this.token(owner, id, 'assets')) return this.json({ error: 'not_writer' }, 403);
        const action = path.slice(blobPrefix.length);
        if (action === 'upload') {
          const contentType = new Headers(headers).get('Content-Type')?.split(';')[0] ?? 'application/octet-stream';
          const value = bytes(body), asset = this.store.putAsset(owner, id, value, contentType, 'Asset');
          return this.json({ opaque_id: asset.id, size_bytes: asset.sizeBytes, content_type: contentType, url: asset.url, sha256: createHash('sha256').update(value).digest('hex'), created_at: new Date().toISOString() });
        }
        if (action === 'list') {
          const assets = this.store.assets(owner, id);
          return this.json({ assets: assets.map(asset => ({ opaque_id: asset.id, size_bytes: asset.sizeBytes, content_type: asset.type, created_at: new Date(asset.createdAt ?? Date.now()).toISOString() })), usage: { files: assets.length, bytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0), max_files: PPT_ASSET_LIMITS.files, max_bytes: PPT_ASSET_LIMITS.bytes } });
        }
        const deleted = /^([0-9a-f]{32})\/delete$/.exec(action);
        if (deleted) { this.store.deleteAsset(owner, id, deleted[1]!); return this.json({ deleted: true }); }
      }
      if (path.startsWith('/api/frame/mcp/') || path.includes('/comments')) return this.json({ error: 'capability_disabled' }, 403);
      return this.response('Not found', 404);
    } catch (error) {
      const fields = error as { code?: string; live?: string; paths?: unknown };
      const conflict = fields.code === 'conflict';
      return this.json({ error: message(error), ...(conflict ? { conflict: true, live: fields.live, paths: fields.paths } : {}) }, conflict ? 409 : 400);
    }
  }
  connect(owner: string, id: string, port: MessagePortMain): void {
    this.root(); this.store.get(owner, id);
    const connection: Connection = { owner, id, port, sockets: new Map(), closed: false };
    this.connections.add(connection);
    const send = (value: unknown) => { if (!connection.closed) port.postMessage(value); };
    const live = (sid: string) => send({ kind: 'socket.onmessage', sid, data: JSON.stringify({ ver: this.store.get(owner, id).version }) });
    port.on('message', event => {
      const request = record(event.data);
      if (request.kind === 'call' && typeof request.id === 'string' && typeof request.url === 'string' && ['GET', 'POST', 'DELETE', 'PATCH', 'HEAD'].includes(String(request.method))) {
        void this.call(owner, id, String(request.method), request.url, Array.isArray(request.headers) ? request.headers as string[][] : [], request.body).then(async response => {
          const body = new Uint8Array(await response.arrayBuffer());
          send({ kind: 'reply', id: request.id, status: response.status, statusText: response.statusText, headers: [...response.headers], body, end: true });
        }, error => send({ kind: 'reply', id: request.id, status: 500, headers: [], body: message(error), end: true }));
      } else if (request.kind === 'socket.make' && typeof request.sid === 'string') {
        const path = `/edge-api/frame-live/${id}/ws`, protocols = Array.isArray(request.protocols) ? request.protocols : [];
        if (typeof request.url !== 'string' || request.url.split('?')[0] !== path || !protocols.includes(this.token(owner, id, 'live')) || connection.sockets.size >= 8) { send({ kind: 'socket.onclose', sid: request.sid, code: 1008, wasClean: true }); return; }
        connection.sockets.set(request.sid, path); send({ kind: 'socket.onopen', sid: request.sid }); live(request.sid);
      } else if (request.kind === 'socket.send' && typeof request.sid === 'string' && connection.sockets.has(request.sid)) {
        if (request.data === 'ping') send({ kind: 'socket.onmessage', sid: request.sid, data: 'pong' });
      } else if (request.kind === 'socket.close' && typeof request.sid === 'string') { connection.sockets.delete(request.sid); send({ kind: 'socket.onclose', sid: request.sid, code: 1000, wasClean: true }); }
    });
    port.on('close', () => { connection.closed = true; this.connections.delete(connection); });
    port.start(); send({ kind: 'ready', v: 1, epoch: this.epoch, build: String(this.manifest.version) });
  }
  changed(owner: string, id: string): void {
    const document = this.store.get(owner, id);
    for (const connection of this.connections) if (!connection.closed && connection.owner === owner && connection.id === id) for (const sid of connection.sockets.keys()) connection.port.postMessage({ kind: 'socket.onmessage', sid, data: JSON.stringify({ ver: document.version }) });
  }
  release(owner?: string, id?: string): void {
    for (const connection of [...this.connections]) if ((owner === undefined || connection.owner === owner) && (id === undefined || connection.id === id)) { connection.closed = true; this.connections.delete(connection); connection.port.close(); }
  }
}
