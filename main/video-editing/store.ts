import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { inside, record, text, writeAtomic, type Data } from '../visuals/data';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface VideoEditingProject {
  schema: 1;
  id: string;
  sessionId: string;
  title: string;
  path: string;
  updatedAtMs: number;
}

/** A workspace owns an editor instance and its native projects, not a flattened movie. */
export class VideoEditingStore {
  readonly root: string;
  private readonly latest = new Map<string, string>();
  constructor(configRoot: string) {
    const root = join(configRoot, 'video-editing');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }
  directory(id: string): string {
    if (!ID.test(id)) throw new Error('Invalid video workspace id.');
    const path = join(this.root, id);
    if (!existsSync(path) || !inside(this.root, realpathSync(path)) || !lstatSync(path).isDirectory()) throw new Error('Video workspace not found.');
    return path;
  }
  load(id: unknown, owner: string): VideoEditingProject {
    const key = text(id, 'video workspace id');
    const directory = this.directory(key), file = join(directory, 'project.json');
    if (!inside(directory, realpathSync(file))) throw new Error('Video workspace manifest escaped its directory.');
    const data = record(JSON.parse(readFileSync(file, 'utf8')));
    if (data.schema !== 1 || data.id !== key || typeof data.sessionId !== 'string' || typeof data.path !== 'string' || !isAbsolute(data.path) || typeof data.title !== 'string') throw new Error('Invalid video workspace manifest.');
    if (data.sessionId !== owner) throw new Error('Video workspace belongs to another chat.');
    return data as unknown as VideoEditingProject;
  }
  list(owner: string): VideoEditingProject[] {
    return readdirSync(this.root).filter(id => ID.test(id)).flatMap(id => {
      try { return [this.load(id, owner)]; } catch { return []; }
    }).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  resolveId(owner: string, id?: unknown): string {
    return this.load(id ?? this.latest.get(owner) ?? this.list(owner)[0]?.id, owner).id;
  }
  open(owner: string, fields: Data): VideoEditingProject {
    text(owner, 'video editing session');
    if (fields.id !== undefined) {
      const project = this.load(fields.id, owner);
      this.latest.set(owner, project.id);
      return project;
    }
    let supplied: string | undefined;
    if (fields.path !== undefined) {
      supplied = text(fields.path, 'video project folder');
      if (!isAbsolute(supplied)) throw new Error('Use an absolute video project folder.');
      supplied = existsSync(supplied) ? realpathSync(supplied) : resolve(supplied);
      for (const id of readdirSync(this.root).filter(id => ID.test(id))) {
        const saved = record(JSON.parse(readFileSync(join(this.root, id, 'project.json'), 'utf8')));
        if (saved.path !== supplied) continue;
        if (saved.sessionId !== owner) throw new Error('This video project already belongs to another chat.');
        return this.open(owner, { id });
      }
    }
    const id = randomUUID(), directory = join(this.root, id);
    mkdirSync(directory, { mode: 0o700 });
    const project: VideoEditingProject = {
      schema: 1, id, sessionId: owner, title: String(fields.title ?? 'Untitled video').trim().slice(0, 200) || 'Untitled video',
      path: supplied ?? join(directory, 'project'), updatedAtMs: Date.now(),
    };
    this.save(project);
    this.latest.set(owner, id);
    return project;
  }
  save(project: VideoEditingProject): void {
    writeAtomic(join(this.directory(project.id), 'project.json'), { ...project, updatedAtMs: Date.now() } as unknown as Data);
  }
  changed(id: string, owner: string, fields: Data): VideoEditingProject {
    const project = this.load(id, owner);
    if (typeof fields.name === 'string' && fields.name.trim()) project.title = fields.name.trim().slice(0, 200);
    if (typeof fields.path === 'string' && isAbsolute(fields.path)) project.path = fields.path;
    this.save(project);
    return project;
  }
  releaseSession(owner: string): void { this.latest.delete(owner); }
}
