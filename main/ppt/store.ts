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
      return { id: assetId, url: `_blob/${assetId}`, sizeBytes: bytes.length };
    });
  }
  assets(owner: string, id: string): { id: string; url: string; sizeBytes: number; type: string; name: string; sha256: string; createdAt?: number }[] {
    const state = this.manifest(owner, id);
    return Object.entries(state.assets).filter(([, asset]) => !asset.deleted).map(([assetId, asset]) => ({ id: assetId, url: `_blob/${assetId}`, sizeBytes: asset.size, type: asset.contentType, name: asset.name, sha256: asset.sha256, ...(asset.createdAt !== undefined ? { createdAt: asset.createdAt } : {}) }));
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
