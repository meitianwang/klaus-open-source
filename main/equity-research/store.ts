import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readBounded, record, writeAtomic, type Data } from '../visuals/data';

export interface EquityResearchProject {
  id: string;
  sessionId: string;
  title: string;
  version: number;
  updatedAtMs: number;
  summary?: string;
}

export class EquityResearchStore {
  readonly root: string;
  private readonly current = new Map<string, string>();

  constructor(configRoot: string) {
    this.root = join(configRoot, 'equity-research');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private directory(id: unknown): string {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)) throw new Error('Invalid equity workspace id.');
    return join(this.root, id);
  }

  private manifest(project: EquityResearchProject): void {
    writeAtomic(join(this.directory(project.id), 'project.json'), { ...project });
  }

  open(owner: string, options: { id?: unknown; title?: string } = {}): EquityResearchProject {
    if (options.id !== undefined) {
      const project = this.load(options.id, owner);
      this.current.set(owner, project.id);
      return project;
    }
    const project = { id: randomUUID(), sessionId: owner, title: options.title?.trim() || 'Equity Research', version: 0, updatedAtMs: Date.now() };
    mkdirSync(this.directory(project.id), { mode: 0o700 });
    this.manifest(project);
    this.current.set(owner, project.id);
    return project;
  }

  resolveId(owner: string, id?: unknown): string {
    return this.load(id ?? this.current.get(owner) ?? this.list(owner)[0]?.id, owner).id;
  }

  load(id: unknown, owner: string): EquityResearchProject {
    const project = JSON.parse(readBounded(join(this.directory(id), 'project.json'))) as EquityResearchProject;
    if (project.id !== id || project.sessionId !== owner) throw new Error('Equity workspace not found in this chat.');
    if (!Number.isSafeInteger(project.version) || project.version < 0) throw new Error('Invalid equity workspace version.');
    return project;
  }

  list(owner: string): EquityResearchProject[] {
    return readdirSync(this.root).flatMap(id => {
      try { return [this.load(id, owner)]; } catch { return []; }
    }).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  discard(id: string, owner: string): void {
    this.load(id, owner);
    rmSync(this.directory(id), { recursive: true });
    if (this.current.get(owner) === id) this.current.delete(owner);
  }

  readDocument(project: EquityResearchProject): Data | null {
    return project.version ? record(JSON.parse(readBounded(join(this.directory(project.id), `${project.version}.json`)))) : null;
  }

  runtimeLoad(id: string, owner: string) {
    const project = this.load(id, owner);
    return { document: this.readDocument(project), version: project.version };
  }

  saveDocument(id: string, owner: string, input: { expectedVersion: number; document: Data; title?: string; summary?: string }) {
    const project = this.load(id, owner);
    const document = this.readDocument(project);
    if (input.expectedVersion !== project.version) return { ok: false, conflict: true, version: project.version, current: { version: project.version, document } } as const;
    if (input.document.schema !== 1) throw new Error('Expected a schema v1 equity workspace document.');
    const priorCode = record(document?.security).secucode;
    if (priorCode && priorCode !== record(input.document.security).secucode) throw new Error('Open a separate workspace tab via equity_open for a different security.');
    const version = project.version + 1;
    const next = { ...project, version, title: input.title?.trim() || project.title, summary: input.summary ?? project.summary, updatedAtMs: Date.now() };
    const directory = this.directory(id);
    writeAtomic(join(directory, `${version}.json`), input.document);
    this.manifest(next);
    if (version > 24) rmSync(join(directory, `${version - 24}.json`), { force: true });
    return { ok: true, conflict: false, version, project: next } as const;
  }
}
