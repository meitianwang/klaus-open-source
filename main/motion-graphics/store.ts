import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inside, message, readBounded, record, text, writeAtomic, type Data } from '../visuals/data';

const MAX_PROJECT_JSON_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_WORKSPACE_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_ASSETS = 256;
const HISTORY_COUNT = 16;
const HISTORY_BYTES = 384 * 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface MotionGraphicsAssetRef {
  path: string;
  sha256: string;
  bytes: number;
}

export interface MotionGraphicsProject {
  schema: 1;
  id: string;
  sessionId: string;
  title: string;
  version: number;
  generation: string;
  assets: MotionGraphicsAssetRef[];
  summary: Data | null;
  updatedAtMs: number;
}

function validVirtualPath(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.startsWith('/')
    && value.length > 1
    && value.length <= 512
    && !value.includes('..')
    && !/[\u0000-\u001f]/.test(value)
  );
}

/** Publishes immutable generations of `.ecproj` timelines with content-addressed media blobs. */
export class MotionGraphicsStore {
  readonly root: string;
  private readonly currentBySession = new Map<string, string>();

  constructor(configRoot: string, private readonly onWarning?: (error: string) => void) {
    const root = join(configRoot, 'motion-graphics');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
  }

  private directory(id: unknown): string {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid motion-graphics workspace id.');
    const directory = join(this.root, id);
    if (!existsSync(directory) || !inside(this.root, realpathSync(directory)) || !lstatSync(directory).isDirectory()) {
      throw new Error('Motion-graphics workspace not found.');
    }
    return directory;
  }

  private parse(input: unknown): MotionGraphicsProject {
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
      || !Array.isArray(value.assets)
      || value.assets.length > MAX_ASSETS
    ) {
      throw new Error('Invalid motion-graphics workspace manifest.');
    }
    const seenPaths = new Set<string>();
    const assets = value.assets.map(entry => {
      const item = record(entry);
      if (
        !validVirtualPath(item.path)
        || seenPaths.has(item.path)
        || typeof item.sha256 !== 'string'
        || !SHA256.test(item.sha256)
        || !Number.isSafeInteger(item.bytes)
        || Number(item.bytes) < 0
        || Number(item.bytes) > MAX_ASSET_BYTES
      ) {
        throw new Error('Invalid motion-graphics footage reference.');
      }
      seenPaths.add(item.path);
      return {
        path: item.path,
        sha256: item.sha256,
        bytes: Number(item.bytes),
      };
    });
    const summary = value.summary && typeof value.summary === 'object' && !Array.isArray(value.summary)
      ? (value.summary as Data)
      : null;
    return {
      schema: 1,
      id: value.id,
      sessionId: value.sessionId,
      title: value.title,
      version: Number(value.version),
      generation: value.generation,
      assets,
      summary,
      updatedAtMs: Number(value.updatedAtMs) || 0,
    };
  }

  open(sessionId: string, fields: Data): MotionGraphicsProject {
    text(sessionId, 'motion-graphics session');
    if (fields.id !== undefined) {
      const project = this.load(fields.id, sessionId);
      this.currentBySession.set(sessionId, project.id);
      return project;
    }
    const title = String(fields.title ?? 'Untitled').trim().slice(0, 200) || 'Untitled';
    const id = randomUUID();
    const directory = join(this.root, id);
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, 'media'), { mode: 0o700 });
    mkdirSync(join(directory, 'previews'), { mode: 0o700 });
    mkdirSync(join(directory, 'exports'), { mode: 0o700 });
    const project: MotionGraphicsProject = {
      schema: 1,
      id,
      sessionId,
      title,
      version: 0,
      generation: '',
      assets: [],
      summary: null,
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

  load(id: unknown, sessionId: string): MotionGraphicsProject {
    const directory = this.directory(id);
    const path = join(directory, 'project.json');
    if (!inside(directory, realpathSync(path))) throw new Error('Motion-graphics manifest escaped its directory.');
    const project = this.parse(JSON.parse(readBounded(path, 2 * 1024 * 1024)));
    if (project.id !== id || project.sessionId !== sessionId) {
      throw new Error('Motion-graphics workspace belongs to another chat.');
    }
    return project;
  }

  list(sessionId: string): MotionGraphicsProject[] {
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

  projectJson(project: MotionGraphicsProject): string {
    if (!project.generation) return '';
    const directory = this.directory(project.id);
    const path = realpathSync(join(directory, project.generation, 'project.ecproj'));
    if (!inside(directory, path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_PROJECT_JSON_BYTES) {
      throw new Error('Invalid saved motion-graphics project.');
    }
    return readFileSync(path, 'utf8');
  }

  assetBytes(id: string, asset: MotionGraphicsAssetRef): Buffer {
    const directory = this.directory(id);
    const mediaDir = join(directory, 'media');
    const path = realpathSync(join(mediaDir, asset.sha256));
    if (!inside(directory, path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_ASSET_BYTES) {
      throw new Error(`Missing or invalid motion-graphics media asset (${asset.path}).`);
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
      projectJson: this.projectJson(project),
      assets: project.assets.map(asset => ({
        path: asset.path,
        bytesBase64: this.assetBytes(project.id, asset).toString('base64'),
      })),
    };
  }

  private writeMediaBlob(mediaDir: string, sha256: string, bytes: Buffer): void {
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 });
    const destination = join(mediaDir, sha256);
    if (existsSync(destination)) {
      const stat = lstatSync(destination);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes.length) {
        return;
      }
    }
    const temp = join(mediaDir, `.tmp-${process.pid}-${randomUUID()}`);
    try {
      writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(temp, destination);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  save(id: string, sessionId: string, fields: Data): MotionGraphicsProject {
    const project = this.load(id, sessionId);
    if (!Number.isSafeInteger(fields.baseVersion) || fields.baseVersion !== project.version) {
      throw new Error(`Motion-graphics save conflict: current version ${project.version}.`);
    }
    const projectJson = text(fields.projectJson, 'projectJson');
    const projectJsonBytes = Buffer.from(projectJson, 'utf8');
    if (projectJsonBytes.length === 0 || projectJsonBytes.length > MAX_PROJECT_JSON_BYTES) {
      throw new Error('Motion-graphics project JSON exceeds the 64 MiB workspace limit.');
    }
    const parsedProject = record(JSON.parse(projectJson));
    if (typeof parsedProject !== 'object') {
      throw new Error('Motion-graphics project JSON must be an object.');
    }

    const directory = this.directory(id);
    const mediaDir = join(directory, 'media');
    const byPath = new Map<string, MotionGraphicsAssetRef>(project.assets.map(item => [item.path, item]));

    const rawNewAssets = fields.newAssets === undefined ? [] : fields.newAssets;
    if (!Array.isArray(rawNewAssets) || rawNewAssets.length > MAX_ASSETS) {
      throw new Error(`A motion-graphics save may attach at most ${MAX_ASSETS} new media assets.`);
    }
    for (const rawEntry of rawNewAssets) {
      const entry = record(rawEntry);
      if (!validVirtualPath(entry.path)) {
        throw new Error('Invalid motion-graphics virtual footage path.');
      }
      const b64 = text(entry.bytesBase64, 'bytesBase64');
      if (b64.length > MAX_ASSET_BYTES * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
        throw new Error('Invalid or oversized motion-graphics footage encoding.');
      }
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > MAX_ASSET_BYTES || bytes.toString('base64') !== b64) {
        throw new Error('Invalid or oversized motion-graphics footage bytes.');
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      this.writeMediaBlob(mediaDir, sha256, bytes);
      byPath.set(entry.path, { path: entry.path, sha256, bytes: bytes.length });
    }

    const rawReferenced = fields.referencedPaths === undefined ? [...byPath.keys()] : fields.referencedPaths;
    if (!Array.isArray(rawReferenced) || rawReferenced.length > MAX_ASSETS) {
      throw new Error(`A motion-graphics workspace may reference at most ${MAX_ASSETS} media assets.`);
    }
    const seenRef = new Set<string>();
    const nextAssets: MotionGraphicsAssetRef[] = [];
    let totalMediaBytes = 0;
    for (const refPath of rawReferenced) {
      if (!validVirtualPath(refPath)) throw new Error('Invalid referenced motion-graphics footage path.');
      if (seenRef.has(refPath)) continue;
      seenRef.add(refPath);
      const resolved = byPath.get(refPath);
      if (!resolved) {
        throw new Error(`Referenced footage asset is missing from workspace media store: ${refPath}`);
      }
      totalMediaBytes += resolved.bytes;
      if (totalMediaBytes > MAX_WORKSPACE_MEDIA_BYTES) {
        throw new Error('Motion-graphics workspace media exceeds the 512 MiB limit.');
      }
      nextAssets.push(resolved);
    }

    const summary = fields.summary && typeof fields.summary === 'object' && !Array.isArray(fields.summary)
      ? (fields.summary as Data)
      : null;
    const activeCompName = summary && typeof summary.activeComp === 'object' && summary.activeComp !== null
      ? String((summary.activeComp as Data).name ?? '').trim().slice(0, 200)
      : '';
    const nextTitle = project.title === 'Untitled' && activeCompName && activeCompName !== 'Main Composition'
      ? activeCompName
      : project.title;

    const generation = randomUUID();
    const target = join(directory, generation);
    mkdirSync(target, { mode: 0o700 });
    const next: MotionGraphicsProject = {
      ...project,
      title: nextTitle,
      version: project.version + 1,
      generation,
      assets: nextAssets,
      summary,
      updatedAtMs: Date.now(),
    };
    try {
      writeFileSync(join(target, 'project.ecproj'), projectJsonBytes, { flag: 'wx', mode: 0o600 });
      writeAtomic(join(target, 'snapshot.json'), next as unknown as Data);
      writeAtomic(join(directory, 'project.json'), next as unknown as Data);
    } catch (error) {
      if (this.load(id, sessionId).generation !== generation) {
        rmSync(target, { recursive: true, force: true });
      }
      throw error;
    }
    try {
      this.prune(directory, generation, nextAssets);
    } catch (error) {
      this.onWarning?.(message(error));
    }
    return next;
  }

  private prune(directory: string, current: string, activeAssets: MotionGraphicsAssetRef[]): void {
    const generations = readdirSync(directory)
      .filter(name => ID.test(name))
      .flatMap(name => {
        try {
          const path = join(directory, name);
          if (!inside(directory, realpathSync(path)) || lstatSync(path).isSymbolicLink()) return [];
          const snapshot = this.parse(JSON.parse(readBounded(join(path, 'snapshot.json'), 2 * 1024 * 1024)));
          const size = lstatSync(join(path, 'project.ecproj')).size;
          return [{ name, version: snapshot.version, size, assets: snapshot.assets }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.version - a.version);

    const retainedHashes = new Set<string>(activeAssets.map(item => item.sha256));
    let bytes = 0;
    for (let index = 0; index < generations.length; index++) {
      const item = generations[index]!;
      bytes += item.size;
      if (item.name !== current && (index >= HISTORY_COUNT || bytes > HISTORY_BYTES)) {
        rmSync(join(directory, item.name), { recursive: true, force: true });
      } else {
        for (const asset of item.assets) retainedHashes.add(asset.sha256);
      }
    }

    const mediaDir = join(directory, 'media');
    if (existsSync(mediaDir) && inside(directory, realpathSync(mediaDir))) {
      for (const entry of readdirSync(mediaDir)) {
        if (SHA256.test(entry) && !retainedHashes.has(entry)) {
          rmSync(join(mediaDir, entry), { force: true });
        }
      }
    }
  }

  releaseSession(sessionId: string): void {
    this.currentBySession.delete(sessionId);
  }
}
