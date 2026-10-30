import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inside, message, readBounded, record, text, writeAtomic, type Data } from '../visuals/data';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 32;
const HISTORY_COUNT = 20;
const HISTORY_BYTES = 256 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PrototypeFile { name: string; file: string; uid: number; view?: Data; parent?: { index: number; branch: string } }

function fileState(file: Data, index: number, count: number): Pick<PrototypeFile, 'view' | 'parent'> {
  const state: Pick<PrototypeFile, 'view' | 'parent'> = {};
  if (file.view !== undefined && file.view !== null) {
    const view = record(file.view);
    if (JSON.stringify(view).length > 16 * 1024 || ['cx', 'cy', 'zoom', 'vw', 'vh'].some(key => typeof view[key] !== 'number' || !Number.isFinite(view[key]))) throw new Error('Invalid saved design viewport.');
    state.view = view;
  }
  if (file.parent !== undefined && file.parent !== null) {
    const parent = record(file.parent);
    if (!Number.isSafeInteger(parent.index) || Number(parent.index) < 0 || Number(parent.index) >= count || parent.index === index || typeof parent.branch !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parent.branch)) throw new Error('Invalid saved design branch.');
    state.parent = { index: Number(parent.index), branch: parent.branch };
  }
  return state;
}
export interface PrototypeProject {
  schema: 1;
  id: string;
  sessionId: string;
  title: string;
  version: number;
  generation: string;
  files: PrototypeFile[];
  active: number;
  updatedAtMs: number;
}

/** Every save publishes a complete generation after all native documents were written. */
export class PrototypeStore {
  readonly root: string;
  private readonly currentBySession = new Map<string, string>();
  constructor(configRoot: string, private readonly onWarning?: (error: string) => void) {
    const root = join(configRoot, 'prototypes');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }
  private directory(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid interface design id.');
    const directory = join(this.root, id);
    if (!existsSync(directory) || !inside(this.root, realpathSync(directory)) || !lstatSync(directory).isDirectory()) throw new Error('Interface design not found.');
    return directory;
  }
  private parse(input: unknown): PrototypeProject {
    const value = record(input);
    if (value.schema !== 1 || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.sessionId !== 'string' || typeof value.title !== 'string'
      || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || typeof value.generation !== 'string' || (value.generation !== '' && !ID.test(value.generation))
      || !Array.isArray(value.files) || value.files.length > MAX_FILES || !Number.isSafeInteger(value.active)) throw new Error('Invalid interface design manifest.');
    const files = value.files.map((input, index) => {
      const file = record(input);
      if (file.file !== `${index}.figcraft` || typeof file.name !== 'string' || !Number.isSafeInteger(file.uid)) throw new Error('Invalid interface design file entry.');
      return { name: file.name, file: file.file, uid: Number(file.uid), ...fileState(file, index, (value.files as unknown[]).length) };
    });
    const active = Number(value.active);
    if (active < 0 || active >= Math.max(1, files.length)) throw new Error('Invalid active design document.');
    return { schema: 1, id: value.id, sessionId: value.sessionId, title: value.title, version: Number(value.version), generation: value.generation, files, active, updatedAtMs: Number(value.updatedAtMs) || 0 };
  }
  open(sessionId: string, fields: Data): PrototypeProject {
    text(sessionId, 'interface design session');
    if (fields.id !== undefined) {
      const project = this.load(fields.id, sessionId);
      this.currentBySession.set(sessionId, project.id);
      return project;
    }
    const title = String(fields.title ?? 'Untitled').trim().slice(0, 200) || 'Untitled';
    const id = randomUUID();
    const directory = join(this.root, id);
    mkdirSync(directory, { mode: 0o700 });
    const project: PrototypeProject = { schema: 1, id, sessionId, title, version: 0, generation: '', files: [], active: 0, updatedAtMs: Date.now() };
    writeAtomic(join(directory, 'project.json'), project as unknown as Data);
    this.currentBySession.set(sessionId, id);
    return project;
  }
  resolveId(sessionId: string, input?: unknown): string {
    const id = input ?? this.currentBySession.get(sessionId);
    return this.load(id, sessionId).id;
  }
  discard(id: string, sessionId: string, previousId?: string): void {
    this.load(id, sessionId);
    rmSync(this.directory(id), { recursive: true });
    if (this.currentBySession.get(sessionId) === id) {
      this.currentBySession.delete(sessionId);
      if (previousId) this.open(sessionId, { id: previousId });
    }
  }
  load(id: unknown, sessionId: string): PrototypeProject {
    const directory = this.directory(id);
    const path = join(directory, 'project.json');
    if (!inside(directory, realpathSync(path))) throw new Error('Interface design manifest escaped its directory.');
    const project = this.parse(JSON.parse(readBounded(path, 1024 * 1024)));
    if (project.id !== id || project.sessionId !== sessionId) throw new Error('Interface design belongs to another chat.');
    return project;
  }
  list(sessionId: string): PrototypeProject[] {
    return readdirSync(this.root).filter(id => ID.test(id)).flatMap(id => {
      try { return [this.load(id, sessionId)]; } catch { return []; }
    }).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  bytes(project: PrototypeProject, index: number): Buffer {
    const file = project.files[index];
    if (!file || !project.generation) throw new Error('No saved design file.');
    const directory = this.directory(project.id);
    const path = realpathSync(join(directory, project.generation, file.file));
    if (!inside(directory, path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_BYTES) throw new Error('Invalid saved design file.');
    return readFileSync(path);
  }
  runtimeLoad(id: string, sessionId: string): Data {
    const project = this.load(id, sessionId);
    return { id, title: project.title, version: project.version, fresh: project.version === 0, active: project.active,
      files: project.files.map((file, index) => ({ name: file.name, uid: file.uid, view: file.view ?? null, parent: file.parent ?? null, data: this.bytes(project, index).toString('base64') })) };
  }
  save(id: string, sessionId: string, fields: Data): PrototypeProject {
    const project = this.load(id, sessionId);
    if (!Number.isSafeInteger(fields.baseVersion) || fields.baseVersion !== project.version) throw new Error(`Design save conflict: current version ${project.version}.`);
    if (!Array.isArray(fields.files) || fields.files.length > MAX_FILES) throw new Error(`A design workspace may contain at most ${MAX_FILES} files.`);
    const active = Number(fields.active ?? 0);
    if (!Number.isInteger(active) || active < 0 || active >= Math.max(1, fields.files.length)) throw new Error('Invalid active design document.');
    let size = 0;
    const decoded = fields.files.map((input, index) => {
      const file = record(input);
      const data = text(file.data, 'native design bytes');
      if (data.length > MAX_BYTES * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid or oversized design encoding.');
      const bytes = Buffer.from(data, 'base64');
      size += bytes.length;
      if (bytes.toString('base64') !== data) throw new Error('Invalid design encoding.');
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || size > MAX_BYTES) throw new Error('Expected native design archives within the workspace size limit.');
      if (!Number.isSafeInteger(file.uid) || Number(file.uid) < 0) throw new Error('Invalid design document identity.');
      const name = String(file.name ?? `Design ${index + 1}`).replace(/[\x00-\x1f]/g, '').slice(0, 200) || 'Untitled';
      return { bytes, entry: { name, file: `${index}.figcraft`, uid: Number(file.uid), ...fileState(file, index, (fields.files as unknown[]).length) } };
    });
    const directory = this.directory(id);
    const generation = randomUUID();
    const target = join(directory, generation);
    mkdirSync(target, { mode: 0o700 });
    const next: PrototypeProject = { ...project, version: project.version + 1, generation, files: decoded.map(item => item.entry), active, updatedAtMs: Date.now() };
    try {
      for (const { bytes, entry } of decoded) writeFileSync(join(target, entry.file), bytes, { flag: 'wx', mode: 0o600 });
      writeAtomic(join(target, 'snapshot.json'), next as unknown as Data);
      writeAtomic(join(directory, 'project.json'), next as unknown as Data);
    } catch (error) {
      // The previously published generation remains readable when staging fails.
      if (this.load(id, sessionId).generation !== generation) rmSync(target, { recursive: true, force: true });
      throw error;
    }
    // Retention failure must not turn an already published save into a false conflict.
    try { this.prune(directory, generation); }
    catch (error) { this.onWarning?.(message(error)); }
    return next;
  }
  private prune(directory: string, current: string): void {
    const generations = readdirSync(directory).filter(name => ID.test(name)).flatMap(name => {
      try {
        const path = join(directory, name);
        if (!inside(directory, realpathSync(path)) || lstatSync(path).isSymbolicLink()) return [];
        const snapshot = this.parse(JSON.parse(readBounded(join(path, 'snapshot.json'), 1024 * 1024)));
        const size = snapshot.files.reduce((sum, file) => sum + lstatSync(join(path, file.file)).size, 0);
        return [{ name, version: snapshot.version, size }];
      } catch { return []; }
    }).sort((a, b) => b.version - a.version);
    let bytes = 0;
    for (let index = 0; index < generations.length; index++) {
      const item = generations[index]!;
      bytes += item.size;
      if (item.name !== current && (index >= HISTORY_COUNT || bytes > HISTORY_BYTES)) rmSync(join(directory, item.name), { recursive: true, force: true });
    }
  }
  releaseSession(sessionId: string): void { this.currentBySession.delete(sessionId); }
}
