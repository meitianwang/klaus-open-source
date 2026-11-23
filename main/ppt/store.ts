import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const ASSET = /^[0-9a-f]{32}$/;
const VERSION = /^v([1-9]\d*)$/;
const MAX_JSON = 8 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_TEXT = 16 * 1024 * 1024;
const MAX_BINARY = 20 * 1024 * 1024;
export const PPT_ASSET_LIMITS = Object.freeze({ files: 1000, bytes: 1024 * 1024 * 1024 });
const MIME: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm' };

type ErrorCode = 'conflict' | 'not_found' | 'invalid_argument' | 'forbidden' | 'read_only_path' | 'too_large' | 'corrupt' | 'busy';
export class PptStoreError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly live?: string, readonly paths?: { path: string; expected: string | null; liveSha: string | null }[]) { super(message); this.name = 'PptStoreError'; }
}
export interface PptDocument { id: string; owner: string; title: string; version: string; seq: number; createdAt: string; updatedAt: string }
export interface PptFile { path: string; sha256: string; size: number; contentType: string }
export interface PptPublish { baseVersion?: string; writes: { path: string; bytes: Uint8Array; contentType?: string }[]; remove?: string[]; ifMatch?: Record<string, string | null> }
export interface PptPublishResult { version: string; seq: number; shas: Record<string, string>; changed: { path: string; sha256: string | null }[]; unchanged?: boolean }
export interface PptAuthoringIssue { path?: string; line?: number; col?: number; message: string; severity?: string }
export interface PptValidationRecord {
  version: string;
  contentHash?: string;
  shas: Record<string, string>;
  errors: PptAuthoringIssue[];
  warnings: PptAuthoringIssue[];
  slides?: unknown;
  at: string;
}
export interface PptCommentAnchor {
  path?: string;
  x?: number;
  y?: number;
  span?: { start: number; quote: string };
  pin?: { x: number; y: number };
  sig?: { v: number; tag: string; h?: string };
  doc?: { x: number; y: number };
  file?: string;
  file_sha?: string;
  label?: string;
  detail?: string;
  region?: { x0: number; y0: number; x1: number; y1: number; kids?: number[] };
  moved_at?: string;
  path_unreadable?: boolean;
}
export interface PptCommentItem {
  id: string;
  text: string;
  created_at: string;
  edited_at?: string;
  source?: string;
  to_claude_at?: string;
  sent_by_viewer?: boolean;
  author?: { account?: string; role?: string };
}
export interface PptCommentThread {
  id: string;
  created_at: string;
  resolved_at?: string;
  resolved_by?: 'claude';
  claude_activated_at?: string;
  claude_activated_by?: string;
  anchor?: PptCommentAnchor;
  comments: PptCommentItem[];
}
export interface PptCommentReads {
  threads: Record<string, string>;
  seen: string | null;
}
export interface PptCommentSentMark {
  threadId: string;
  commentId: string;
  hadActivatedAt?: string;
  hadActivatedBy?: string;
}
interface CommentLedger { threads: PptCommentThread[]; reads: Record<string, PptCommentReads> }
interface FileEntry { sha256: string; size: number; contentType: string }
interface AssetEntry extends FileEntry { name: string; createdAt?: number; deleted?: boolean }
interface Snapshot { schema: 1; document: PptDocument; files: Record<string, FileEntry> }
interface Manifest { schema: 1; document: PptDocument; revisions: Record<string, string>; assets: Record<string, AssetEntry> }

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fail = (code: ErrorCode, message: string): never => { throw new PptStoreError(code, message); };
function ownerKey(owner: string): string {
  if (typeof owner !== 'string' || !owner.trim() || owner.includes('\0') || Buffer.byteLength(owner) > 4096) return fail('invalid_argument', 'A valid presentation chat is required.');
  return hash(owner);
}
function filePath(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f\\:%;?#]/.test(value) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) return fail('invalid_argument', 'Invalid presentation file path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..') || value.endsWith('.cmekshadow')) return fail('invalid_argument', 'Presentation paths must be clean relative file names.');
  const first = parts[0]!.toLowerCase();
  if (first.startsWith('_') || first === 'artifact-type' || first === 'index.html' || first === 'skill.md') return fail('read_only_path', 'Presentation runtime paths are read-only.');
  return value;
}
function contentType(path: string, supplied?: string): string {
  const type = supplied ?? MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  if (typeof type !== 'string' || type.length > 256 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/i.test(type)) return fail('invalid_argument', 'Invalid presentation content type.');
  return type;
}
/** The content type the store assigns to a presentation path. */
export function presentationContentType(path: string): string { return contentType(path); }
function textType(type: string): boolean { return /^(?:text\/|application\/(?:json|javascript|xml)|image\/svg\+xml)/i.test(type); }
function checkedBytes(value: Uint8Array, type: string): Buffer {
  if (!(value instanceof Uint8Array)) return fail('invalid_argument', 'Presentation file bytes are required.');
  if (value.byteLength > (textType(type) ? MAX_TEXT : MAX_BINARY)) return fail('too_large', 'The presentation file exceeds its size limit.');
  const bytes = Buffer.from(value);
  if (textType(type)) try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('invalid_argument', 'Presentation text files must be valid UTF-8.'); }
  return bytes;
}
function titleText(value: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value) || value.length > 200) return fail('invalid_argument', 'A presentation title of at most 200 characters is required.');
  return value.trim();
}
function date(value: unknown): value is string { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
const SECONDS_DATE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,9})?Z$/;
const UUID_CI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COMMENTS_THREADS = 1000;
const MAX_COMMENTS_PER_THREAD = 200;
function isoSeconds(now = new Date()): string { return now.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function normalizeSeconds(value: unknown): string | undefined {
  const match = typeof value === 'string' ? SECONDS_DATE.exec(value) : null;
  if (!match || !Number.isFinite(Date.parse(`${match[1]}Z`))) return undefined;
  return `${match[1]}Z`;
}
function uuidId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_CI.test(value)) return fail('invalid_argument', `Invalid presentation ${label}.`);
  return value.toLowerCase();
}
function commentText(value: unknown): string {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) return fail('invalid_argument', 'Invalid presentation comment text.');
  const cleaned = value.replaceAll('\0', '').trim();
  if (!cleaned || cleaned.length > 8000) return fail('invalid_argument', 'A presentation comment of 1 to 8000 characters is required.');
  return cleaned;
}
function anchorFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('?') || value.includes('#')) return undefined;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return undefined;
  return value;
}
function commentAnchor(value: unknown): PptCommentAnchor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return fail('invalid_argument', 'Invalid presentation comment anchor.');
  const raw = value as Record<string, unknown>, out: PptCommentAnchor = {};
  if (typeof raw.path === 'string' && raw.path && raw.path.length <= 1024) out.path = raw.path;
  if (typeof raw.x === 'number' && Number.isFinite(raw.x)) out.x = raw.x;
  if (typeof raw.y === 'number' && Number.isFinite(raw.y)) out.y = raw.y;
  const span = object(raw.span);
  if (typeof span.start === 'number' && Number.isInteger(span.start) && span.start >= 0 && typeof span.quote === 'string' && span.quote && Buffer.byteLength(span.quote) <= 512) {
    out.span = { start: span.start, quote: span.quote };
  }
  const pin = object(raw.pin);
  if (typeof pin.x === 'number' && Number.isFinite(pin.x) && typeof pin.y === 'number' && Number.isFinite(pin.y)) out.pin = { x: pin.x, y: pin.y };
  const sig = object(raw.sig);
  if (typeof sig.v === 'number' && Number.isInteger(sig.v) && sig.v >= 1 && sig.v <= 8 && typeof sig.tag === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(sig.tag)) {
    out.sig = { v: sig.v, tag: sig.tag, ...(typeof sig.h === 'string' && /^[0-9a-f]{16}$/.test(sig.h) ? { h: sig.h } : {}) };
  }
  const doc = object(raw.doc);
  if (typeof doc.x === 'number' && Number.isFinite(doc.x) && doc.x >= 0 && doc.x <= 1048576 && typeof doc.y === 'number' && Number.isFinite(doc.y) && doc.y >= 0 && doc.y <= 1048576) {
    out.doc = { x: doc.x, y: doc.y };
  }
  const file = anchorFile(raw.file);
  if (file) out.file = file;
  if (typeof raw.file_sha === 'string' && raw.file_sha && raw.file_sha.length <= 128) out.file_sha = raw.file_sha;
  if (typeof raw.label === 'string' && raw.label.trim()) out.label = raw.label.trim().slice(0, 256);
  if (typeof raw.detail === 'string' && raw.detail.trim()) out.detail = raw.detail.trim().slice(0, 512);
  const region = object(raw.region);
  const coords = [region.x0, region.y0, region.x1, region.y1];
  if (coords.every(coord => typeof coord === 'number' && Number.isFinite(coord))) {
    const clamp = (coord: number) => Math.round(Math.min(1, Math.max(0, coord)) * 1000) / 1000;
    const [x0, y0, x1, y1] = (coords as number[]).map(clamp) as [number, number, number, number];
    if (x1 > x0 && y1 > y0) {
      let kids: number[] | undefined;
      if (Array.isArray(region.kids) && region.kids.length > 0 && region.kids.length <= 8) {
        let prev = -1;
        if (region.kids.every(item => { const ok = typeof item === 'number' && Number.isInteger(item) && item > prev && item < 4096; prev = typeof item === 'number' ? item : prev; return ok; })) {
          kids = region.kids as number[];
        }
      }
      out.region = { x0, y0, x1, y1, ...(kids ? { kids } : {}) };
    }
  }
  if (typeof raw.moved_at === 'string' && date(raw.moved_at)) out.moved_at = raw.moved_at;
  if (raw.path_unreadable === true) out.path_unreadable = true;
  return Object.keys(out).length ? out : undefined;
}
function cloneThreads(threads: PptCommentThread[]): PptCommentThread[] {
  return JSON.parse(JSON.stringify(threads)) as PptCommentThread[];
}
function versionNumber(value: unknown): number {
  const match = typeof value === 'string' ? VERSION.exec(value) : null;
  const number = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(number)) return fail('invalid_argument', 'Invalid presentation version.');
  return number;
}
function directory(parent: string, name: string, create = false): string {
  const path = join(parent, name);
  if (create && !lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return fail('not_found', 'The presentation directory does not exist.');
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) return fail('forbidden', 'Presentation storage cannot follow directory links.');
  return path;
}
function bytesAt(parent: string, name: string, max: number): Buffer {
  const path = join(parent, name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return fail('not_found', `The saved presentation file ${name} is missing.`);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) return fail('corrupt', 'A saved presentation file is invalid or oversized.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > max || realpathSync(path) !== path || opened.ino !== stat.ino || opened.dev !== stat.dev) return fail('corrupt', 'A saved presentation file changed while being read.');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function jsonAt(parent: string, name: string): unknown {
  try { return JSON.parse(bytesAt(parent, name, MAX_JSON).toString('utf8')); }
  catch (error) { if (error instanceof PptStoreError) throw error; return fail('corrupt', 'A saved presentation manifest is not valid JSON.'); }
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function atomicJson(parent: string, name: string, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_JSON) return fail('too_large', 'The presentation manifest exceeds its size limit.');
  const temp = `.${randomUUID()}.tmp`, path = join(parent, temp);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(path, join(parent, name)); syncDirectory(parent);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(path, { force: true }); }
}
function immutable(parent: string, name: string, bytes: Uint8Array): void {
  if (existsSync(join(parent, name))) {
    const current = bytesAt(parent, name, Math.max(MAX_JSON, MAX_BINARY));
    if (!current.equals(Buffer.from(bytes))) return fail('corrupt', 'A saved presentation content hash was reused with different bytes.');
    return;
  }
  const fd = openSync(join(parent, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(parent);
}
function document(value: unknown, owner: string, id: string): PptDocument {
  const row = object(value);
  if (row.id !== id || row.owner !== owner) return fail('forbidden', 'The presentation belongs to another chat.');
  if (typeof row.title !== 'string' || row.title.length > 200 || !date(row.createdAt) || !date(row.updatedAt) || !Number.isSafeInteger(row.seq) || Number(row.seq) < 1 || row.version !== `v${String(row.seq)}`) return fail('corrupt', 'The saved presentation identity is invalid.');
  return row as unknown as PptDocument;
}
function entry(value: unknown): FileEntry {
  const row = object(value);
  if (typeof row.sha256 !== 'string' || !HASH.test(row.sha256) || !Number.isSafeInteger(row.size) || Number(row.size) < 0 || Number(row.size) > MAX_BINARY || typeof row.contentType !== 'string') return fail('corrupt', 'The saved presentation file metadata is invalid.');
  return { sha256: row.sha256, size: Number(row.size), contentType: contentType('', row.contentType) };
}

/** The native host owns revisioned presentation files and their immutable content. */
export class PptStore {
  readonly root: string;
  private readonly lastBatch = new Map<string, PptCommentSentMark[]>();
  constructor(configRoot: string) {
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    this.root = directory(realpathSync(configRoot), 'ppt', true);
  }
  private ownerDirectory(owner: string, create = false): string { return directory(this.root, ownerKey(owner), create); }
  private documentDirectory(owner: string, id: string): string {
    if (typeof id !== 'string' || !UUID.test(id)) return fail('invalid_argument', 'Invalid presentation id.');
    return directory(this.ownerDirectory(owner), id);
  }
  private lock<T>(path: string, action: () => T): T {
    const lockPath = join(path, 'write.lock');
    const token = randomUUID();
    let fd: number;
    try { fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const old = object(jsonAt(path, 'write.lock'));
      if (!Number.isSafeInteger(old.pid) || Number(old.pid) < 1 || typeof old.token !== 'string' || !UUID.test(old.token)) return fail('busy', 'The presentation has an invalid write lock; its files were kept.');
      try { process.kill(Number(old.pid), 0); return fail('busy', 'The presentation is being saved by another operation.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      const again = object(jsonAt(path, 'write.lock'));
      if (again.token !== old.token) return fail('busy', 'The presentation write owner changed.');
      rmSync(lockPath); fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    }
    const held = fstatSync(fd);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); return action(); }
    finally {
      closeSync(fd);
      const current = lstatSync(lockPath, { throwIfNoEntry: false });
      if (current?.isFile() && !current.isSymbolicLink() && current.ino === held.ino && current.dev === held.dev) rmSync(lockPath);
    }
  }
  private parseManifest(value: unknown, owner: string, id: string): Manifest {
    const row = object(value);
    if (row.schema !== 1) return fail('corrupt', 'The presentation storage format is unsupported.');
    const doc = document(row.document, owner, id), revisions: Record<string, string> = Object.create(null), assets: Record<string, AssetEntry> = Object.create(null);
    for (const [version, value] of Object.entries(object(row.revisions))) {
      if (versionNumber(version) > doc.seq || typeof value !== 'string' || !HASH.test(value)) return fail('corrupt', 'The presentation revision index is invalid.');
      revisions[version] = value;
    }
    if (Object.keys(revisions).length !== doc.seq || !revisions[doc.version]) return fail('corrupt', 'The presentation revision history is incomplete.');
    for (const [assetId, value] of Object.entries(object(row.assets))) {
      const asset = object(value);
      if (!ASSET.test(assetId) || typeof asset.name !== 'string' || asset.name.length > 512) return fail('corrupt', 'The presentation asset metadata is invalid.');
      if (asset.createdAt !== undefined && (!Number.isSafeInteger(asset.createdAt) || Number(asset.createdAt) < 0) || asset.deleted !== undefined && typeof asset.deleted !== 'boolean') return fail('corrupt', 'The presentation asset state is invalid.');
      assets[assetId] = { ...entry(value), name: asset.name, ...(asset.createdAt !== undefined ? { createdAt: Number(asset.createdAt) } : {}), ...(asset.deleted === true ? { deleted: true } : {}) };
    }
    return { schema: 1, document: doc, revisions, assets };
  }
  private manifest(owner: string, id: string): Manifest {
    const path = this.documentDirectory(owner, id);
    if (!existsSync(join(path, 'document.json'))) return this.lock(path, () => {
      if (existsSync(join(path, 'document.json'))) return this.parseManifest(jsonAt(path, 'document.json'), owner, id);
      return this.importLegacy(path, owner, id);
    });
    return this.parseManifest(jsonAt(path, 'document.json'), owner, id);
  }
  private snapshot(path: string, state: Manifest, version = state.document.version): Snapshot {
    versionNumber(version);
    const sha = state.revisions[version];
    if (!sha) return fail('not_found', 'This presentation version does not exist.');
    const bytes = bytesAt(directory(path, 'revisions'), sha + '.json', MAX_JSON);
    if (hash(bytes) !== sha) return fail('corrupt', 'The saved presentation revision has changed or is damaged.');
    let row: Record<string, unknown>;
    try { row = object(JSON.parse(bytes.toString('utf8'))); } catch { return fail('corrupt', 'The saved presentation revision is invalid.'); }
    if (row.schema !== 1) return fail('corrupt', 'The presentation revision format is unsupported.');
    const doc = document(row.document, state.document.owner, state.document.id);
    if (doc.version !== version) return fail('corrupt', 'The presentation revision identity does not match.');
    const files: Record<string, FileEntry> = Object.create(null);
    let total = 0;
    for (const [name, value] of Object.entries(object(row.files))) { filePath(name); files[name] = entry(value); total += files[name]!.size; }
    if (total > MAX_TOTAL) return fail('corrupt', 'The presentation exceeds the stored file limit.');
    return { schema: 1, document: doc, files };
  }
  private saveSnapshot(path: string, snapshot: Snapshot): string {
    const bytes = Buffer.from(JSON.stringify(snapshot) + '\n');
    if (bytes.length > MAX_JSON) return fail('too_large', 'The presentation revision exceeds its metadata limit.');
    const sha = hash(bytes); immutable(directory(path, 'revisions', true), sha + '.json', bytes); return sha;
  }
  private readBlob(path: string, sha: string, size: number, folder = 'blobs'): Buffer {
    const bytes = bytesAt(directory(path, folder), sha, MAX_BINARY);
    if (bytes.length !== size || hash(bytes) !== sha) return fail('corrupt', 'The saved presentation content is missing or damaged.');
    return bytes;
  }
  open(owner: string, title: string): PptDocument {
    const parent = this.ownerDirectory(owner, true), id = randomUUID(), path = join(parent, id), now = new Date().toISOString();
    const doc: PptDocument = { id, owner, title: titleText(title), version: 'v1', seq: 1, createdAt: now, updatedAt: now };
    mkdirSync(path, { mode: 0o700 });
    try {
      directory(path, 'blobs', true);
      const revision = this.saveSnapshot(path, { schema: 1, document: doc, files: {} });
      atomicJson(path, 'document.json', { schema: 1, document: doc, revisions: { v1: revision }, assets: {} });
      return { ...doc };
    } catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
  }
  list(owner: string): PptDocument[] {
    ownerKey(owner);
    if (!existsSync(join(this.root, hash(owner)))) return [];
    const parent = this.ownerDirectory(owner);
    return readdirSync(parent).filter(name => UUID.test(name)).flatMap(id => {
      const path = directory(parent, id);
      if (!existsSync(join(path, 'document.json')) && !existsSync(join(path, 'desktop.json'))) return [];
      return [this.get(owner, id)];
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(owner: string, id: string): PptDocument { return { ...this.manifest(owner, id).document }; }
  files(owner: string, id: string, version?: string): PptFile[] {
    const state = this.manifest(owner, id), snapshot = this.snapshot(this.documentDirectory(owner, id), state, version);
    return Object.entries(snapshot.files).map(([path, value]) => ({ path, ...value })).sort((a, b) => a.path.localeCompare(b.path));
  }
  read(owner: string, id: string, path: string, version?: string): Uint8Array {
    filePath(path);
    const state = this.manifest(owner, id), directory = this.documentDirectory(owner, id), file = this.snapshot(directory, state, version).files[path];
    if (!file) return fail('not_found', 'The presentation file does not exist in this version.');
    return this.readBlob(directory, file.sha256, file.size);
  }
  publish(owner: string, id: string, request: PptPublish): PptPublishResult {
    // Load and migrate before taking the mutation lock.
    this.manifest(owner, id);
    const path = this.documentDirectory(owner, id);
    return this.lock(path, () => {
      const state = this.parseManifest(jsonAt(path, 'document.json'), owner, id), current = this.snapshot(path, state);
      if (!request || !Array.isArray(request.writes) || request.remove !== undefined && !Array.isArray(request.remove) || request.writes.length + (request.remove?.length ?? 0) > 256) return fail('invalid_argument', 'Publish at most 256 presentation files in one operation.');
      if (request.baseVersion !== undefined && (versionNumber(request.baseVersion), request.baseVersion !== state.document.version)) throw new PptStoreError('conflict', 'The presentation changed before these files were saved.', state.document.version);
      const names = new Set<string>(), writes = request.writes.map(write => {
        const name = filePath(write.path), type = contentType(name, write.contentType), bytes = checkedBytes(write.bytes, type);
        if (names.has(name)) return fail('invalid_argument', 'A presentation path was changed more than once.');
        names.add(name); return { path: name, type, bytes, sha256: hash(bytes) };
      });
      const remove = (request.remove ?? []).map(name => { filePath(name); if (names.has(name)) return fail('invalid_argument', 'A presentation path was changed more than once.'); names.add(name); return name; });
      const conflicts: { path: string; expected: string | null; liveSha: string | null }[] = [];
      if (request.ifMatch !== undefined && (request.ifMatch === null || typeof request.ifMatch !== 'object' || Array.isArray(request.ifMatch))) return fail('invalid_argument', 'Invalid presentation file preconditions.');
      for (const [name, expected] of Object.entries(request.ifMatch ?? {})) {
        filePath(name);
        if (!names.has(name) || expected !== null && (typeof expected !== 'string' || !HASH.test(expected))) return fail('invalid_argument', 'A file precondition must name a changed path and a content hash.');
        const liveSha = current.files[name]?.sha256 ?? null;
        if (expected !== liveSha) conflicts.push({ path: name, expected, liveSha });
      }
      if (conflicts.length) throw new PptStoreError('conflict', 'One or more presentation files changed before saving.', state.document.version, conflicts);
      const files = { ...current.files }, changed: PptPublishResult['changed'] = [], shas: Record<string, string> = Object.create(null);
      for (const write of writes) {
        shas[write.path] = write.sha256;
        if (files[write.path]?.sha256 !== write.sha256 || files[write.path]?.contentType !== write.type) changed.push({ path: write.path, sha256: write.sha256 });
        files[write.path] = { sha256: write.sha256, size: write.bytes.length, contentType: write.type };
      }
      for (const name of remove) if (Object.hasOwn(files, name)) { delete files[name]; changed.push({ path: name, sha256: null }); }
      if (Object.values(files).reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL || writes.reduce((sum, write) => sum + write.bytes.length, 0) > MAX_TOTAL) return fail('too_large', 'Presentation files exceed 256 MiB.');
      if (!changed.length) return { version: state.document.version, seq: state.document.seq, shas, changed, unchanged: true };
      if (!Number.isSafeInteger(state.document.seq + 1)) return fail('too_large', 'The presentation revision limit was reached.');
      const doc: PptDocument = { ...state.document, seq: state.document.seq + 1, version: `v${state.document.seq + 1}`, updatedAt: new Date().toISOString() };
      const blobDirectory = directory(path, 'blobs');
      for (const write of writes) immutable(blobDirectory, write.sha256, write.bytes);
      const sha = this.saveSnapshot(path, { schema: 1, document: doc, files });
      atomicJson(path, 'document.json', { ...state, document: doc, revisions: { ...state.revisions, [doc.version]: sha } });
      return { version: doc.version, seq: doc.seq, shas, changed };
    });
  }
  retitle(owner: string, id: string, title: string): PptDocument {
    const normalized = titleText(title); this.manifest(owner, id);
    const path = this.documentDirectory(owner, id);
    return this.lock(path, () => {
      const state = this.parseManifest(jsonAt(path, 'document.json'), owner, id);
      if (state.document.title === normalized) return { ...state.document };
      const doc = { ...state.document, title: normalized, updatedAt: new Date().toISOString() };
      atomicJson(path, 'document.json', { ...state, document: doc }); return { ...doc };
    });
  }
  putAsset(owner: string, id: string, value: Uint8Array, type: string, name: string): { id: string; url: string; sizeBytes: number } {
    const mime = contentType('', type), bytes = checkedBytes(value, mime);
    if (typeof name !== 'string' || name.length > 512 || /[\x00-\x1f\x7f]/.test(name)) return fail('invalid_argument', 'Invalid presentation asset name.');
    this.manifest(owner, id);
    const path = this.documentDirectory(owner, id);
    return this.lock(path, () => {
      const state = this.parseManifest(jsonAt(path, 'document.json'), owner, id), assetId = randomUUID().replaceAll('-', ''), sha256 = hash(bytes);
      const active = Object.values(state.assets).filter(asset => !asset.deleted);
      if (active.length >= PPT_ASSET_LIMITS.files || active.reduce((sum, asset) => sum + asset.size, bytes.length) > PPT_ASSET_LIMITS.bytes) return fail('too_large', 'Presentation assets exceed 1000 files or 1 GiB.');
      immutable(directory(path, 'blobs'), sha256, bytes);
      atomicJson(path, 'document.json', { ...state, assets: { ...state.assets, [assetId]: { sha256, size: bytes.length, contentType: mime, name, createdAt: Date.now() } } });
      return { id: assetId, url: `/_blob/${assetId}`, sizeBytes: bytes.length };
    });
  }
  assets(owner: string, id: string): { id: string; url: string; sizeBytes: number; type: string; name: string; sha256: string; createdAt?: number }[] {
    const state = this.manifest(owner, id);
    return Object.entries(state.assets).filter(([, asset]) => !asset.deleted).map(([assetId, asset]) => ({ id: assetId, url: `/_blob/${assetId}`, sizeBytes: asset.size, type: asset.contentType, name: asset.name, sha256: asset.sha256, ...(asset.createdAt !== undefined ? { createdAt: asset.createdAt } : {}) }));
  }
  /**
   * The last authoring result describes the exact file hashes it validated.
   * It is advisory metadata, not a revision: a later manual edit changes the
   * live hashes without invalidating the saved document.
   */
  recordValidation(owner: string, id: string, record: PptValidationRecord): void {
    this.manifest(owner, id);
    const path = this.documentDirectory(owner, id);
    this.lock(path, () => atomicJson(path, 'validation.json', record));
  }
  validation(owner: string, id: string): PptValidationRecord | undefined {
    this.manifest(owner, id);
    const parent = this.documentDirectory(owner, id), path = join(parent, 'validation.json');
    if (!existsSync(path)) return undefined;
    try {
      const row = object(jsonAt(parent, 'validation.json')), shas = object(row.shas);
      if (typeof row.version !== 'string' || !row.version || typeof row.at !== 'string' || !date(row.at)) return undefined;
      if (Object.values(shas).some(value => typeof value !== 'string' || !HASH.test(value))) return undefined;
      const list = (value: unknown) => Array.isArray(value) ? value.flatMap(item => {
        const issue = object(item), message = issue.message;
        if (typeof message !== 'string') return [];
        return [{ message, ...(typeof issue.path === 'string' ? { path: issue.path } : {}), ...(Number.isSafeInteger(issue.line) && Number(issue.line) > 0 ? { line: Number(issue.line) } : {}), ...(Number.isSafeInteger(issue.col) && Number(issue.col) > 0 ? { col: Number(issue.col) } : {}), ...(typeof issue.severity === 'string' ? { severity: issue.severity } : {}) }];
      }) : [];
      return {
        version: row.version,
        shas: shas as Record<string, string>,
        errors: list(row.errors),
        warnings: list(row.warnings),
        at: row.at,
        ...(typeof row.contentHash === 'string' ? { contentHash: row.contentHash } : {}),
        ...(row.slides !== undefined && row.slides !== null ? { slides: row.slides } : {}),
      };
    } catch { return undefined; }
  }
  deleteAsset(owner: string, id: string, assetId: string): void {
    if (typeof assetId !== 'string' || !ASSET.test(assetId)) return fail('invalid_argument', 'Invalid presentation asset id.');
    this.manifest(owner, id);
    const path = this.documentDirectory(owner, id);
    this.lock(path, () => {
      const state = this.parseManifest(jsonAt(path, 'document.json'), owner, id), asset = state.assets[assetId];
      if (!asset || asset.deleted) return;
      // Historical slides can still reference this content after it leaves the picker.
      atomicJson(path, 'document.json', { ...state, assets: { ...state.assets, [assetId]: { ...asset, deleted: true } } });
    });
  }
  asset(owner: string, id: string, assetId: string): { bytes: Uint8Array; type: string; name: string } {
    if (typeof assetId !== 'string' || !ASSET.test(assetId)) return fail('invalid_argument', 'Invalid presentation asset id.');
    const state = this.manifest(owner, id), value = state.assets[assetId];
    if (!value) return fail('not_found', 'The presentation asset does not exist.');
    return { bytes: this.readBlob(this.documentDirectory(owner, id), value.sha256, value.size), type: value.contentType, name: value.name };
  }
  private readCommentsLedger(path: string): CommentLedger {
    if (!existsSync(join(path, 'comments.json'))) return { threads: [], reads: Object.create(null) };
    const raw = object(jsonAt(path, 'comments.json'));
    if (raw.schema !== 1 || !Array.isArray(raw.threads)) return fail('corrupt', 'The presentation comment ledger is invalid.');
    const threads: PptCommentThread[] = [];
    for (const entryValue of raw.threads) {
      const row = object(entryValue);
      if (typeof row.id !== 'string' || !UUID_CI.test(row.id) || !Array.isArray(row.comments)) continue;
      const items: PptCommentItem[] = [];
      for (const itemValue of row.comments) {
        const item = object(itemValue);
        if (typeof item.id !== 'string' || !UUID_CI.test(item.id) || typeof item.text !== 'string' || !date(item.created_at)) continue;
        const author = object(item.author);
        items.push({
          id: item.id.toLowerCase(),
          text: item.text,
          created_at: item.created_at,
          ...(typeof item.edited_at === 'string' && date(item.edited_at) ? { edited_at: item.edited_at } : {}),
          ...(typeof item.source === 'string' ? { source: item.source } : {}),
          ...(typeof item.to_claude_at === 'string' && date(item.to_claude_at) ? { to_claude_at: item.to_claude_at } : {}),
          ...(typeof item.sent_by_viewer === 'boolean' ? { sent_by_viewer: item.sent_by_viewer } : {}),
          ...(typeof author.account === 'string' || typeof author.role === 'string'
            ? { author: { ...(typeof author.account === 'string' ? { account: author.account } : {}), ...(typeof author.role === 'string' ? { role: author.role } : {}) } }
            : {}),
        });
      }
      if (!items.length) continue;
      const anchor = row.anchor !== undefined ? commentAnchor(row.anchor) : undefined;
      threads.push({
        id: row.id.toLowerCase(),
        created_at: typeof row.created_at === 'string' && date(row.created_at) ? row.created_at : items[0]!.created_at,
        ...(typeof row.resolved_at === 'string' && date(row.resolved_at) ? { resolved_at: row.resolved_at } : {}),
        ...(row.resolved_by === 'claude' ? { resolved_by: 'claude' } : {}),
        ...(typeof row.claude_activated_at === 'string' && date(row.claude_activated_at) ? { claude_activated_at: row.claude_activated_at } : {}),
        ...(typeof row.claude_activated_by === 'string' ? { claude_activated_by: row.claude_activated_by } : {}),
        ...(anchor ? { anchor } : {}),
        comments: items,
      });
    }
    const reads: Record<string, PptCommentReads> = Object.create(null);
    for (const [account, value] of Object.entries(object(raw.reads))) {
      const recordValue = object(value), map: Record<string, string> = Object.create(null);
      for (const [threadId, stamp] of Object.entries(object(recordValue.threads))) {
        const normalized = normalizeSeconds(stamp);
        if (UUID_CI.test(threadId) && normalized) map[threadId.toLowerCase()] = normalized;
      }
      const seen = normalizeSeconds(recordValue.seen) ?? null;
      reads[account] = { threads: map, seen };
    }
    return { threads, reads };
  }
  private mutateComments<T>(owner: string, id: string, action: (ledger: CommentLedger) => { save?: boolean; result: T }): T {
    this.manifest(owner, id);
    const path = this.documentDirectory(owner, id);
    return this.lock(path, () => {
      const ledger = this.readCommentsLedger(path);
      const outcome = action(ledger);
      if (outcome.save !== false) atomicJson(path, 'comments.json', { schema: 1, threads: ledger.threads, reads: ledger.reads });
      return outcome.result;
    });
  }
  comments(owner: string, id: string): PptCommentThread[] {
    this.manifest(owner, id);
    return cloneThreads(this.readCommentsLedger(this.documentDirectory(owner, id)).threads);
  }
  commentReads(owner: string, id: string, account: string, update?: { threads?: unknown; seen?: unknown }): PptCommentReads {
    const who = uuidId(account, 'comment viewer');
    if (!update) {
      this.manifest(owner, id);
      const current = this.readCommentsLedger(this.documentDirectory(owner, id)).reads[who];
      return { threads: { ...(current?.threads ?? {}) }, seen: current?.seen ?? null };
    }
    return this.mutateComments(owner, id, ledger => {
      const prior = ledger.reads[who] ?? { threads: Object.create(null), seen: null };
      const merged: Record<string, string> = { ...prior.threads };
      if (update.threads !== undefined) {
        if (typeof update.threads !== 'object' || update.threads === null || Array.isArray(update.threads)) return fail('invalid_argument', 'Invalid presentation comment read map.');
        for (const [threadId, stamp] of Object.entries(update.threads as Record<string, unknown>)) {
          const normalized = normalizeSeconds(stamp);
          if (!UUID_CI.test(threadId) || !normalized) continue;
          const key = threadId.toLowerCase();
          if (!merged[key] || normalized > merged[key]!) merged[key] = normalized;
        }
      }
      let seen = prior.seen;
      if (update.seen !== undefined && update.seen !== null) {
        const normalized = normalizeSeconds(update.seen);
        if (!normalized) return fail('invalid_argument', 'Invalid presentation comment read timestamp.');
        if (!seen || normalized > seen) seen = normalized;
      }
      const next: PptCommentReads = { threads: merged, seen };
      ledger.reads[who] = next;
      return { result: { threads: { ...next.threads }, seen: next.seen } };
    });
  }
  addCommentThread(owner: string, id: string, input: { id?: unknown; text: unknown; anchor?: unknown; account: string; toAssistant?: boolean }): { threads: PptCommentThread[]; threadId: string; commentId: string; replayed?: boolean } {
    const account = uuidId(input.account, 'comment author');
    const body = commentText(input.text);
    const clientCommentId = input.id !== undefined ? uuidId(input.id, 'comment id') : undefined;
    const anchor = commentAnchor(input.anchor);
    return this.mutateComments<{ threads: PptCommentThread[]; threadId: string; commentId: string; replayed?: boolean }>(owner, id, ledger => {
      if (clientCommentId) {
        for (const existing of ledger.threads) {
          if (existing.comments.some(comment => comment.id === clientCommentId)) {
            return { save: false, result: { threads: cloneThreads(ledger.threads), threadId: existing.id, commentId: clientCommentId, replayed: true } };
          }
        }
      }
      if (ledger.threads.length >= MAX_COMMENTS_THREADS) return fail('too_large', 'Presentation comments exceed 1000 threads.');
      const now = isoSeconds(), threadId = randomUUID(), commentId = clientCommentId ?? randomUUID();
      const comment: PptCommentItem = {
        id: commentId,
        text: body,
        created_at: now,
        ...(input.toAssistant ? { to_claude_at: now, sent_by_viewer: true } : {}),
        author: { account },
      };
      const thread: PptCommentThread = {
        id: threadId,
        created_at: now,
        ...(input.toAssistant ? { claude_activated_at: now, claude_activated_by: account } : {}),
        ...(anchor ? { anchor } : {}),
        comments: [comment],
      };
      ledger.threads.push(thread);
      return { result: { threads: cloneThreads(ledger.threads), threadId, commentId } };
    });
  }
  replyCommentThread(owner: string, id: string, threadId: string, input: { id?: unknown; text: unknown; account?: string; role?: 'assistant'; source?: 'agent'; toAssistant?: boolean }): { threads: PptCommentThread[]; threadId: string; commentId: string; replayed?: boolean } {
    const targetId = uuidId(threadId, 'comment thread id');
    const body = commentText(input.text);
    const clientCommentId = input.id !== undefined ? uuidId(input.id, 'comment id') : undefined;
    const account = input.account !== undefined ? uuidId(input.account, 'comment author') : undefined;
    return this.mutateComments<{ threads: PptCommentThread[]; threadId: string; commentId: string; replayed?: boolean }>(owner, id, ledger => {
      const thread = ledger.threads.find(item => item.id === targetId);
      if (!thread) return fail('not_found', 'The presentation comment thread does not exist.');
      if (clientCommentId && thread.comments.some(comment => comment.id === clientCommentId)) {
        return { save: false, result: { threads: cloneThreads(ledger.threads), threadId: thread.id, commentId: clientCommentId, replayed: true } };
      }
      if (thread.comments.length >= MAX_COMMENTS_PER_THREAD) return fail('too_large', 'This presentation comment thread has reached its reply limit.');
      const now = isoSeconds(), commentId = clientCommentId ?? randomUUID();
      const comment: PptCommentItem = {
        id: commentId,
        text: body,
        created_at: now,
        ...(input.source ? { source: input.source } : {}),
        ...(input.toAssistant ? { to_claude_at: now, sent_by_viewer: true } : {}),
        author: { ...(account ? { account } : {}), ...(input.role ? { role: input.role } : {}) },
      };
      thread.comments.push(comment);
      if (input.toAssistant && account) {
        thread.claude_activated_at = now;
        thread.claude_activated_by = account;
      }
      return { result: { threads: cloneThreads(ledger.threads), threadId: thread.id, commentId } };
    });
  }
  resolveCommentThread(owner: string, id: string, threadId: string, resolved: boolean, byAssistant = false): { threads: PptCommentThread[]; threadId: string } {
    const targetId = uuidId(threadId, 'comment thread id');
    return this.mutateComments(owner, id, ledger => {
      const thread = ledger.threads.find(item => item.id === targetId);
      if (!thread) return fail('not_found', 'The presentation comment thread does not exist.');
      if (resolved) {
        thread.resolved_at = isoSeconds();
        if (byAssistant) thread.resolved_by = 'claude'; else delete thread.resolved_by;
      } else {
        delete thread.resolved_at;
        delete thread.resolved_by;
      }
      return { result: { threads: cloneThreads(ledger.threads), threadId: thread.id } };
    });
  }
  activateCommentThread(owner: string, id: string, threadId: string, activated: boolean, account: string): { threads: PptCommentThread[]; threadId: string } {
    const targetId = uuidId(threadId, 'comment thread id'), who = uuidId(account, 'comment author');
    return this.mutateComments(owner, id, ledger => {
      const thread = ledger.threads.find(item => item.id === targetId);
      if (!thread) return fail('not_found', 'The presentation comment thread does not exist.');
      if (activated) {
        thread.claude_activated_at = isoSeconds();
        thread.claude_activated_by = who;
      } else {
        delete thread.claude_activated_at;
        delete thread.claude_activated_by;
      }
      return { result: { threads: cloneThreads(ledger.threads), threadId: thread.id } };
    });
  }
  moveCommentThread(owner: string, id: string, threadId: string, anchorValue: unknown, account: string, toAssistant = false): { threads: PptCommentThread[]; threadId: string; commentId?: string } {
    const targetId = uuidId(threadId, 'comment thread id'), who = uuidId(account, 'comment author');
    const anchor = commentAnchor(anchorValue);
    if (!anchor) return fail('invalid_argument', 'A valid presentation comment anchor is required.');
    return this.mutateComments(owner, id, ledger => {
      const thread = ledger.threads.find(item => item.id === targetId);
      if (!thread) return fail('not_found', 'The presentation comment thread does not exist.');
      const now = isoSeconds();
      thread.anchor = { ...anchor, moved_at: now };
      let commentId: string | undefined;
      if (toAssistant) {
        const latest = [...thread.comments].reverse().find(item => item.author?.role !== 'assistant') ?? thread.comments.at(-1);
        if (latest) {
          latest.to_claude_at = now;
          latest.sent_by_viewer = true;
          commentId = latest.id;
        }
        thread.claude_activated_at = now;
        thread.claude_activated_by = who;
      }
      return { result: { threads: cloneThreads(ledger.threads), threadId: thread.id, ...(commentId ? { commentId } : {}) } };
    });
  }
  deleteCommentThread(owner: string, id: string, threadId: string): { threads: PptCommentThread[]; threadId: string } {
    const targetId = uuidId(threadId, 'comment thread id');
    return this.mutateComments(owner, id, ledger => {
      const index = ledger.threads.findIndex(item => item.id === targetId);
      if (index < 0) return fail('not_found', 'The presentation comment thread does not exist.');
      ledger.threads.splice(index, 1);
      return { result: { threads: cloneThreads(ledger.threads), threadId: targetId } };
    });
  }
  editComment(owner: string, id: string, threadId: string, commentId: string, textValue: unknown): { threads: PptCommentThread[]; threadId: string; commentId: string } {
    const targetThread = uuidId(threadId, 'comment thread id'), targetComment = uuidId(commentId, 'comment id');
    const body = commentText(textValue);
    return this.mutateComments(owner, id, ledger => {
      const thread = ledger.threads.find(item => item.id === targetThread);
      const comment = thread?.comments.find(item => item.id === targetComment);
      if (!thread || !comment) return fail('not_found', 'The presentation comment does not exist.');
      comment.text = body;
      comment.edited_at = isoSeconds();
      return { result: { threads: cloneThreads(ledger.threads), threadId: thread.id, commentId: comment.id } };
    });
  }
  deleteComment(owner: string, id: string, threadId: string, commentId: string): { threads: PptCommentThread[]; threadId: string } {
    const targetThread = uuidId(threadId, 'comment thread id'), targetComment = uuidId(commentId, 'comment id');
    return this.mutateComments(owner, id, ledger => {
      const threadIndex = ledger.threads.findIndex(item => item.id === targetThread);
      if (threadIndex < 0) return fail('not_found', 'The presentation comment thread does not exist.');
      const thread = ledger.threads[threadIndex]!;
      const commentIndex = thread.comments.findIndex(item => item.id === targetComment);
      if (commentIndex < 0) return fail('not_found', 'The presentation comment does not exist.');
      if (commentIndex === 0 || thread.comments.length === 1) ledger.threads.splice(threadIndex, 1);
      else thread.comments.splice(commentIndex, 1);
      return { result: { threads: cloneThreads(ledger.threads), threadId: targetThread } };
    });
  }
  markCommentSent(owner: string, id: string, threadId: string, commentId: string, sent: boolean, account: string): { threads: PptCommentThread[]; threadId: string; commentId: string } {
    const targetThread = uuidId(threadId, 'comment thread id'), targetComment = uuidId(commentId, 'comment id'), who = uuidId(account, 'comment author');
    return this.mutateComments(owner, id, ledger => {
      const thread = ledger.threads.find(item => item.id === targetThread);
      const comment = thread?.comments.find(item => item.id === targetComment);
      if (!thread || !comment) return fail('not_found', 'The presentation comment does not exist.');
      if (sent) {
        const now = isoSeconds();
        comment.to_claude_at = now;
        comment.sent_by_viewer = true;
        thread.claude_activated_at = now;
        thread.claude_activated_by = who;
      } else {
        delete comment.to_claude_at;
        delete comment.sent_by_viewer;
        if (!thread.comments.some(item => item.to_claude_at !== undefined)) {
          delete thread.claude_activated_at;
          delete thread.claude_activated_by;
        }
      }
      return { result: { threads: cloneThreads(ledger.threads), threadId: thread.id, commentId: comment.id } };
    });
  }
  markAllOpenCommentsSent(owner: string, id: string, account: string): { threads: PptCommentThread[]; count: number; open: number; at: string; marked: PptCommentSentMark[] } {
    const who = uuidId(account, 'comment author');
    return this.mutateComments(owner, id, ledger => {
      const now = isoSeconds();
      let open = 0, count = 0;
      const marked: PptCommentSentMark[] = [];
      for (const thread of ledger.threads) {
        if (thread.resolved_at) continue;
        open += 1;
        const latest = [...thread.comments].reverse().find(item => item.author?.role !== 'assistant');
        if (!latest || latest.to_claude_at !== undefined) continue;
        marked.push({ threadId: thread.id, commentId: latest.id, ...(thread.claude_activated_at ? { hadActivatedAt: thread.claude_activated_at } : {}), ...(thread.claude_activated_by ? { hadActivatedBy: thread.claude_activated_by } : {}) });
        latest.to_claude_at = now;
        latest.sent_by_viewer = true;
        thread.claude_activated_at = now;
        thread.claude_activated_by = who;
        count += 1;
      }
      this.lastBatch.set(`${ownerKey(owner)}:${id}`, marked);
      return { save: count > 0, result: { threads: cloneThreads(ledger.threads), count, open, at: now, marked } };
    });
  }
  rollbackLastOpenCommentsBatch(owner: string, id: string): PptCommentThread[] {
    const key = `${ownerKey(owner)}:${id}`;
    const marked = this.lastBatch.get(key) ?? [];
    this.lastBatch.delete(key);
    return this.rollbackCommentsSent(owner, id, marked);
  }
  rollbackThreadSummon(owner: string, id: string, threadId: string, commentId?: string): PptCommentThread[] {
    const targetThread = uuidId(threadId, 'comment thread id');
    const targetComment = commentId !== undefined && typeof commentId === 'string' && UUID_CI.test(commentId) ? commentId.toLowerCase() : undefined;
    return this.mutateComments(owner, id, ledger => {
      const thread = ledger.threads.find(item => item.id === targetThread);
      if (!thread) return { save: false, result: cloneThreads(ledger.threads) };
      const comment = targetComment
        ? thread.comments.find(item => item.id === targetComment)
        : [...thread.comments].reverse().find(item => item.author?.role !== 'assistant' && item.to_claude_at !== undefined);
      if (!comment || comment.to_claude_at === undefined) return { save: false, result: cloneThreads(ledger.threads) };
      delete comment.to_claude_at;
      delete comment.sent_by_viewer;
      if (!thread.comments.some(item => item.to_claude_at !== undefined)) {
        delete thread.claude_activated_at;
        delete thread.claude_activated_by;
      }
      return { result: cloneThreads(ledger.threads) };
    });
  }
  rollbackCommentsSent(owner: string, id: string, marked: readonly PptCommentSentMark[]): PptCommentThread[] {
    if (!marked.length) return this.comments(owner, id);
    return this.mutateComments(owner, id, ledger => {
      for (const entryMark of marked) {
        const thread = ledger.threads.find(item => item.id === entryMark.threadId);
        const comment = thread?.comments.find(item => item.id === entryMark.commentId);
        if (!thread || !comment) continue;
        delete comment.to_claude_at;
        delete comment.sent_by_viewer;
        if (entryMark.hadActivatedAt) thread.claude_activated_at = entryMark.hadActivatedAt;
        else if (!thread.comments.some(item => item.to_claude_at !== undefined)) delete thread.claude_activated_at;
        if (entryMark.hadActivatedBy) thread.claude_activated_by = entryMark.hadActivatedBy;
        else if (!thread.comments.some(item => item.to_claude_at !== undefined)) delete thread.claude_activated_by;
      }
      return { result: cloneThreads(ledger.threads) };
    });
  }
  private importLegacy(path: string, owner: string, id: string): Manifest {
    if (!existsSync(join(path, 'desktop.json'))) return fail('not_found', 'The presentation has no saved document record.');
    const metadata = object(jsonAt(path, 'desktop.json')), legacy = object(jsonAt(path, 'artifact.json'));
    if (metadata.format !== 1 || metadata.type !== 'slides' || typeof metadata.title !== 'string' || legacy.format !== 1 || !Array.isArray(legacy.versions) || !legacy.versions.length) return fail('corrupt', 'The saved presentation cannot be migrated safely. Its original files were kept.');
    const title = titleText(metadata.title), revisions: Record<string, string> = Object.create(null), assets: Record<string, AssetEntry> = Object.create(null);
    const blobDirectory = directory(path, 'blobs', true);
    let firstDate = '', current: PptDocument | undefined;
    for (const [index, input] of legacy.versions.entries()) {
      const row = object(input), seq = index + 1;
      if (row.ver !== `v${seq}` || !date(row.createdAt) || !['page', 'publish'].includes(String(row.entry)) || row.files !== undefined && !Array.isArray(row.files)) return fail('corrupt', 'The saved presentation version history is invalid. Its original files were kept.');
      firstDate ||= row.createdAt;
      const doc: PptDocument = { id, owner, title, version: row.ver, seq, createdAt: firstDate, updatedAt: row.createdAt };
      const files: Record<string, FileEntry> = Object.create(null);
      for (const value of (row.files ?? []) as unknown[]) {
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string' || !HASH.test(value[1])) return fail('corrupt', 'The saved presentation file index is invalid.');
        const name = filePath(value[0]), sha256 = value[1];
        if (Object.hasOwn(files, name)) return fail('corrupt', 'The saved presentation contains duplicate file names.');
        const bytes = bytesAt(blobDirectory, sha256, MAX_BINARY);
        if (hash(bytes) !== sha256) return fail('corrupt', 'The saved presentation content is damaged. Its original files were kept.');
        files[name] = { sha256, size: bytes.length, contentType: contentType(name) };
      }
      if (Object.values(files).reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL) return fail('corrupt', 'The saved presentation exceeds its file limit.');
      revisions[doc.version] = this.saveSnapshot(path, { schema: 1, document: doc, files }); current = doc;
    }
    if (existsSync(join(path, 'uploads.json'))) {
      const uploads = object(jsonAt(path, 'uploads.json'));
      if (uploads.format !== 1 || !Array.isArray(uploads.uploads)) return fail('corrupt', 'The saved presentation uploads cannot be migrated safely.');
      for (const item of uploads.uploads) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !ASSET.test(item[0])) return fail('corrupt', 'The saved presentation upload index is invalid.');
        const row = object(item[1]), value = entry({ ...row, contentType: row.type });
        if (typeof row.name !== 'string' || row.name.length > 512 || Object.hasOwn(assets, item[0])) return fail('corrupt', 'The saved presentation upload metadata is invalid.');
        const bytes = this.readBlob(path, value.sha256, value.size, 'uploads');
        if (row.createdAt !== undefined && (!Number.isSafeInteger(row.createdAt) || Number(row.createdAt) < 0)) return fail('corrupt', 'The saved presentation upload timestamp is invalid.');
        immutable(blobDirectory, value.sha256, bytes); assets[item[0]] = { ...value, name: row.name, ...(row.createdAt !== undefined ? { createdAt: Number(row.createdAt) } : {}) };
      }
    }
    const state: Manifest = { schema: 1, document: current!, revisions, assets };
    atomicJson(path, 'document.json', state);
    return state;
  }
}
