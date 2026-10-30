import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json, readBounded, scopedPath, text, writeAtomic, type Data } from '../visuals/data';
import { emptyDocument, parseDocument, type Model3DDocument } from './model';

const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const SUFFIX = '.model3d.json';
const INDEX_NAME = 'index.json';
const MAX_INDEX_BYTES = 4 * 1024 * 1024;

/** The listing metadata one document contributes to the side-car index. */
interface IndexEntry {
  sessionId: string;
  title: string;
  version: number;
  updatedAtMs: number;
  objects: number;
  meshes: number;
  materials: number;
}

/**
 * Durable storage for 3D documents.
 *
 * Only the DOCUMENT is stored — datablocks, modifier stacks, transforms,
 * animation keys. Evaluated geometry is derived data (it is recomputed from the
 * modifier stack and cached in memory), so it is never written: a 50k-vertex
 * subdivision result would make every save megabytes and every load re-parse
 * data the kernel can rebuild in milliseconds.
 *
 * History is deliberately absent. The modifier stack IS the non-destructive
 * record — that is the whole point of the design — so undo for a modelling step
 * means removing or re-tuning a layer, not replaying edits. Transform drags are
 * the one thing without that protection; undo for them is a known follow-up.
 */
export class Model3DStore {
  readonly root: string;

  constructor(configRoot: string) {
    this.root = join(configRoot, 'model3d');
    mkdirSync(this.root, { recursive: true });
  }

  path(input: unknown): string {
    const id = text(input, '3D document id');
    if (id === '.' || id === '..' || /[\x00-\x1f/\\<>:"|?*]/.test(id) || /[. ]$/.test(id)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) || Buffer.byteLength(id) > 160) {
      throw new Error('3D document id is not a safe filename.');
    }
    return scopedPath(this.root, join(this.root, `${id}${SUFFIX}`), SUFFIX, false);
  }

  load(id: unknown, sessionId: string): Model3DDocument {
    text(sessionId, '3D session');
    const path = this.path(id);
    scopedPath(this.root, path, SUFFIX);
    const doc = parseDocument(JSON.parse(readBounded(path, MAX_DOCUMENT_BYTES)));
    if (doc.id !== id) throw new Error('3D document file id does not match its filename.');
    if (doc.sessionId !== sessionId) {
      throw new Error(doc.sessionId ? 'This 3D document belongs to another session.' : 'Legacy 3D document has no session owner.');
    }
    return doc;
  }

  list(sessionId: string): Data[] {
    text(sessionId, '3D session');
    const names = readdirSync(this.root).filter(name => name.endsWith(SUFFIX));
    const index = this.readIndex();
    const rows: Data[] = [];
    const entries: Record<string, IndexEntry> = {};
    let reconciled = index === null;
    for (const name of names) {
      const id = name.slice(0, -SUFFIX.length);
      const entry = index?.[id];
      if (entry) {
        entries[id] = entry;
        if (entry.sessionId === sessionId) rows.push(this.row(id, entry));
        continue;
      }
      // Unknown to the index: a new or hand-placed document. Read it once to
      // learn its owner, then let the index carry the answer.
      reconciled = true;
      const learned = this.readEntry(id);
      if (!learned) continue;
      entries[id] = learned;
      if (learned.sessionId === sessionId) rows.push(this.row(id, learned));
    }
    if (reconciled || index === null || Object.keys(index).length !== Object.keys(entries).length) {
      this.writeIndex(entries);
    }
    return rows.sort((a, b) => Number(b.updatedAtMs) - Number(a.updatedAtMs));
  }

  private row(id: string, entry: IndexEntry): Data {
    return {
      id, title: entry.title, version: entry.version, updatedAtMs: entry.updatedAtMs,
      objects: entry.objects, meshes: entry.meshes, materials: entry.materials,
      filePath: this.path(id),
    };
  }

  /** Listing metadata parsed straight from a document, owner included. */
  private readEntry(id: string): IndexEntry | null {
    try {
      const doc = parseDocument(JSON.parse(readBounded(this.path(id), MAX_DOCUMENT_BYTES)));
      if (doc.id !== id) return null;
      return {
        sessionId: doc.sessionId, title: doc.title, version: doc.version, updatedAtMs: doc.updatedAtMs,
        objects: doc.objects.length, meshes: Object.keys(doc.meshes).length,
        materials: Object.keys(doc.materials).length,
      };
    } catch {
      // A corrupt document is skipped rather than failing the whole list: one
      // bad file must not blank the panel's document switcher.
      return null;
    }
  }

  /**
   * The side-car ownership index. Listing used to read and parse EVERY
   * document in the directory — every session's, megabytes each — just to
   * keep the rows of one session; the index answers ownership from a single
   * small file and only documents it has never seen are opened.
   */
  private readIndex(): Record<string, IndexEntry> | null {
    try {
      const parsed = JSON.parse(readBounded(join(this.root, INDEX_NAME), MAX_INDEX_BYTES));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const entries: Record<string, IndexEntry> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<IndexEntry> | null;
        // A malformed row is treated as unknown so the document is re-read
        // rather than listed with invented metadata.
        if (!entry || typeof entry.sessionId !== 'string' || typeof entry.title !== 'string'
          || typeof entry.version !== 'number' || typeof entry.updatedAtMs !== 'number') continue;
        entries[id] = {
          sessionId: entry.sessionId, title: entry.title, version: entry.version,
          updatedAtMs: entry.updatedAtMs, objects: Number(entry.objects) || 0,
          meshes: Number(entry.meshes) || 0, materials: Number(entry.materials) || 0,
        };
      }
      return entries;
    } catch {
      return null;
    }
  }

  private writeIndex(entries: Record<string, IndexEntry>): void {
    try {
      writeAtomic(join(this.root, INDEX_NAME), json(entries));
    } catch {
      // A listing must survive an unwritable index: the next list rebuilds it.
    }
  }

  /** The addressed document, or this session's most recently edited one. */
  resolveId(sessionId: string, id?: unknown): string {
    if (typeof id === 'string' && id) return id;
    return text(this.list(sessionId)[0]?.id, '3D scene; call model3d_scene first');
  }

  open(sessionId: string, fields: Data): Model3DDocument {
    text(sessionId, '3D session');
    const id = fields.id === undefined ? `m3d-${randomUUID()}` : text(fields.id, 'id');
    if (existsSync(this.path(id))) return this.load(id, sessionId);
    const next = emptyDocument(id, typeof fields.title === 'string' ? fields.title : 'Untitled', sessionId);
    this.save(next);
    return next;
  }

  /**
   * Persist a document, bumping version and timestamp.
   *
   * `expectedVersion` gives the panel stale-write detection: a drag built
   * against version N is refused if an agent edit already produced N+1, so the
   * two can never silently overwrite each other.
   */
  save(next: Model3DDocument, expectedVersion?: number): Model3DDocument {
    const expected = expectedVersion ?? next.version;
    if (existsSync(this.path(next.id))) {
      const current = this.load(next.id, next.sessionId);
      if (current.version !== expected) throw new Error(`Stale 3D document: expected version ${expected}, found ${current.version}`);
    }
    const updatedAtMs = Date.now();
    const value = json({ ...next, version: next.version + 1, updatedAtMs });
    if (Buffer.byteLength(JSON.stringify(value, null, 2)) > MAX_DOCUMENT_BYTES) throw new Error('The 3D document exceeds 128 MiB.');
    writeAtomic(this.path(next.id), value);
    next.version += 1;
    next.updatedAtMs = updatedAtMs;
    this.touchIndex(next);
    return next;
  }

  /** Write without bumping the version (used right after a version bump). */
  persist(doc: Model3DDocument): void {
    if (Buffer.byteLength(JSON.stringify(doc, null, 2)) > MAX_DOCUMENT_BYTES) throw new Error('The 3D document exceeds 128 MiB.');
    writeAtomic(this.path(doc.id), json(doc));
    this.touchIndex(doc);
  }

  /** Keep the listing index's copy of one document as fresh as its file. */
  private touchIndex(doc: Model3DDocument): void {
    const entries = this.readIndex() ?? {};
    entries[doc.id] = {
      sessionId: doc.sessionId, title: doc.title, version: doc.version, updatedAtMs: doc.updatedAtMs,
      objects: doc.objects.length, meshes: Object.keys(doc.meshes).length,
      materials: Object.keys(doc.materials).length,
    };
    this.writeIndex(entries);
  }

  remove(id: string, sessionId: string): boolean {
    const path = this.path(id);
    try {
      this.load(id, sessionId);
    } catch {
      return false;
    }
    rmSync(path, { force: true });
    return true;
  }
}
