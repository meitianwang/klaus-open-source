import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inside, message, readBounded, record, text, writeAtomic, type Data } from '../visuals/data';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 24;
const HISTORY_COUNT = 16;
const HISTORY_BYTES = 384 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PhotoEditingFile {
  id: number;
  name: string;
  file: string;
  width: number;
  height: number;
}

export interface PhotoEditingProject {
  schema: 1;
  id: string;
  sessionId: string;
  title: string;
  version: number;
  generation: string;
  files: PhotoEditingFile[];
  active: number;
  updatedAtMs: number;
}

/** Publishes immutable generations of native `.pcraft` bundles per workspace save. */
export class PhotoEditingStore {
  readonly root: string;
  private readonly currentBySession = new Map<string, string>();

  constructor(configRoot: string, private readonly onWarning?: (error: string) => void) {
    const root = join(configRoot, 'photo-editing');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }

  private directory(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid photo-editing workspace id.');
    const directory = join(this.root, id);
    if (!existsSync(directory) || !inside(this.root, realpathSync(directory)) || !lstatSync(directory).isDirectory()) {
      throw new Error('Photo-editing workspace not found.');
    }
    return directory;
  }

  private parse(input: unknown): PhotoEditingProject {
    const value = record(input);
    if (
      value.schema !== 1
      || typeof value.id !== 'string'
      || !ID.test(value.id)
      || typeof value.sessionId !== 'string'
      || typeof value.title !== 'string'
      || !Number.isSafeInteger(value.version)
      || Number(value.version) < 0
      || typeof value.generation !== 'string'
      || (value.generation !== '' && !ID.test(value.generation))
      || !Array.isArray(value.files)
      || value.files.length > MAX_FILES
      || !Number.isSafeInteger(value.active)
    ) {
      throw new Error('Invalid photo-editing workspace manifest.');
    }
    const files = value.files.map((entry, index) => {
      const file = record(entry);
      if (
        file.file !== `${index}.pcraft`
        || typeof file.name !== 'string'
        || !Number.isSafeInteger(file.id)
        || Number(file.id) < 0
        || !Number.isSafeInteger(file.width)
        || Number(file.width) < 1
        || !Number.isSafeInteger(file.height)
        || Number(file.height) < 1
      ) {
        throw new Error('Invalid photo-editing document entry.');
      }
      return {
        id: Number(file.id),
        name: file.name,
        file: file.file,
        width: Number(file.width),
        height: Number(file.height),
      };
    });
    const active = Number(value.active);
    if (active < 0 || active >= Math.max(1, files.length)) {
      throw new Error('Invalid active photo-editing document.');
    }
    return {
      schema: 1,
      id: value.id,
      sessionId: value.sessionId,
      title: value.title,
      version: Number(value.version),
      generation: value.generation,
      files,
      active,
      updatedAtMs: Number(value.updatedAtMs) || 0,
    };
  }

  open(sessionId: string, fields: Data): PhotoEditingProject {
    text(sessionId, 'photo-editing session');
    if (fields.id !== undefined) {
      const project = this.load(fields.id, sessionId);
      this.currentBySession.set(sessionId, project.id);
      return project;
    }
    const title = String(fields.title ?? 'Untitled').trim().slice(0, 200) || 'Untitled';
    const id = randomUUID();
    const directory = join(this.root, id);
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, 'previews'), { mode: 0o700 });
    const project: PhotoEditingProject = {
      schema: 1,
      id,
      sessionId,
      title,
      version: 0,
      generation: '',
      files: [],
      active: 0,
      updatedAtMs: Date.now(),
    };
    writeAtomic(join(directory, 'project.json'), project as unknown as Data);
    this.currentBySession.set(sessionId, id);
    return project;
  }

  resolveId(sessionId: string, input?: unknown): string {
    const id = input ?? this.currentBySession.get(sessionId);
    if (id === undefined) {
      const existing = this.list(sessionId)[0];
      if (existing) {
        this.currentBySession.set(sessionId, existing.id);
        return existing.id;
      }
    }
    return this.load(id, sessionId).id;
  }

  discard(id: string, sessionId: string, previousId?: string): void {
    this.load(id, sessionId);
    rmSync(this.directory(id), { recursive: true, force: true });
    if (this.currentBySession.get(sessionId) === id) {
      this.currentBySession.delete(sessionId);
      if (previousId) this.open(sessionId, { id: previousId });
    }
  }

  load(id: unknown, sessionId: string): PhotoEditingProject {
    const directory = this.directory(id);
    const path = join(directory, 'project.json');
    if (!inside(directory, realpathSync(path))) throw new Error('Photo-editing manifest escaped its directory.');
    const project = this.parse(JSON.parse(readBounded(path, 1024 * 1024)));
    if (project.id !== id || project.sessionId !== sessionId) {
      throw new Error('Photo-editing workspace belongs to another chat.');
    }
    return project;
  }

  list(sessionId: string): PhotoEditingProject[] {
    return readdirSync(this.root)
      .filter(id => ID.test(id))
      .flatMap(id => {
        try {
          return [this.load(id, sessionId)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  bytes(project: PhotoEditingProject, index: number): Buffer {
    const file = project.files[index];
    if (!file || !project.generation) throw new Error('No saved photo-editing document.');
    const directory = this.directory(project.id);
    const path = realpathSync(join(directory, project.generation, file.file));
    if (!inside(directory, path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_BYTES) {
      throw new Error('Invalid saved photo-editing bundle.');
    }
    return readFileSync(path);
  }

  runtimeLoad(id: string, sessionId: string): Data {
    const project = this.load(id, sessionId);
    return {
      id,
      title: project.title,
      version: project.version,
      fresh: project.version === 0,
      active: project.active,
      files: project.files.map((file, index) => ({
        id: file.id,
        name: file.name,
        width: file.width,
        height: file.height,
        data: this.bytes(project, index).toString('base64'),
      })),
    };
  }

  save(id: string, sessionId: string, fields: Data): PhotoEditingProject {
    const project = this.load(id, sessionId);
    if (!Number.isSafeInteger(fields.baseVersion) || fields.baseVersion !== project.version) {
      throw new Error(`Photo-editing save conflict: current version ${project.version}.`);
    }
    if (!Array.isArray(fields.files) || fields.files.length > MAX_FILES) {
      throw new Error(`A photo-editing workspace may contain at most ${MAX_FILES} open documents.`);
    }
    const rawActive = fields.active === null || fields.active === undefined ? 0 : Number(fields.active);
    if (!Number.isInteger(rawActive) || rawActive < 0 || rawActive >= Math.max(1, fields.files.length)) {
      throw new Error('Invalid active photo-editing document.');
    }
    let size = 0;
    const decoded = fields.files.map((input, index) => {
      const file = record(input);
      const data = text(file.data, 'native photo-editing bundle bytes');
      if (data.length > MAX_BYTES * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new Error('Invalid or oversized photo-editing bundle encoding.');
      }
      const bytes = Buffer.from(data, 'base64');
      size += bytes.length;
      if (bytes.toString('base64') !== data) throw new Error('Invalid photo-editing bundle encoding.');
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || size > MAX_BYTES) {
        throw new Error('Expected native .pcraft archives within the 128 MiB workspace limit.');
      }
      const docId = Number.isSafeInteger(file.id) && Number(file.id) >= 0 ? Number(file.id) : index + 1;
      const width = Number.isSafeInteger(file.width) && Number(file.width) >= 1 ? Number(file.width) : 1;
      const height = Number.isSafeInteger(file.height) && Number(file.height) >= 1 ? Number(file.height) : 1;
      const name = String(file.name ?? `Document ${index + 1}`).replace(/[\x00-\x1f]/g, '').slice(0, 200) || 'Untitled';
      return {
        bytes,
        entry: { id: docId, name, file: `${index}.pcraft`, width, height },
      };
    });
    const directory = this.directory(id);
    const generation = randomUUID();
    const target = join(directory, generation);
    mkdirSync(target, { mode: 0o700 });
    const nextTitle = decoded[rawActive]?.entry.name && project.title === 'Untitled'
      ? decoded[rawActive]!.entry.name
      : project.title;
    const next: PhotoEditingProject = {
      ...project,
      title: nextTitle,
      version: project.version + 1,
      generation,
      files: decoded.map(item => item.entry),
      active: rawActive,
      updatedAtMs: Date.now(),
    };
    try {
      for (const { bytes, entry } of decoded) {
        writeFileSync(join(target, entry.file), bytes, { flag: 'wx', mode: 0o600 });
      }
      writeAtomic(join(target, 'snapshot.json'), next as unknown as Data);
      writeAtomic(join(directory, 'project.json'), next as unknown as Data);
    } catch (error) {
      if (this.load(id, sessionId).generation !== generation) {
        rmSync(target, { recursive: true, force: true });
      }
      throw error;
    }
    try {
      this.prune(directory, generation);
    } catch (error) {
      this.onWarning?.(message(error));
    }
    return next;
  }

  private prune(directory: string, current: string): void {
    const generations = readdirSync(directory)
      .filter(name => ID.test(name))
      .flatMap(name => {
        try {
          const path = join(directory, name);
          if (!inside(directory, realpathSync(path)) || lstatSync(path).isSymbolicLink()) return [];
          const snapshot = this.parse(JSON.parse(readBounded(join(path, 'snapshot.json'), 1024 * 1024)));
          const size = snapshot.files.reduce((sum, file) => sum + lstatSync(join(path, file.file)).size, 0);
          return [{ name, version: snapshot.version, size }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.version - a.version);
    let bytes = 0;
    for (let index = 0; index < generations.length; index++) {
      const item = generations[index]!;
      bytes += item.size;
      if (item.name !== current && (index >= HISTORY_COUNT || bytes > HISTORY_BYTES)) {
        rmSync(join(directory, item.name), { recursive: true, force: true });
      }
    }
  }

  releaseSession(sessionId: string): void {
    this.currentBySession.delete(sessionId);
  }
}
