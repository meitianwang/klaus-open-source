import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { checkCanvas, sdkExports } from './check';
import { inside, json, readBounded, record, scopedPath, text, writeAtomic, type Data } from '../visuals/data';

export const CANVAS_EXTENSION = '.canvas.tsx';

export class CanvasStore {
  readonly root: string;
  readonly canvases: string;
  constructor(readonly configRoot: string, readonly resourcesRoot: string) { this.root = join(configRoot, 'canvas'); this.canvases = join(this.root, 'canvases'); }

  provision(): void {
    mkdirSync(this.canvases, { recursive: true });
    const source = join(this.resourcesRoot, 'canvas');
    const digest = (directory: string): string => {
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Canvas SDK resources must be real directories.');
      const hash = createHash('sha256');
      const visit = (path: string, relative: string): void => { for (const name of readdirSync(path).sort()) { const file = join(path, name); const stat = lstatSync(file); if (stat.isSymbolicLink()) throw new Error('Canvas SDK resources cannot contain symlinks.'); if (stat.isDirectory()) visit(file, `${relative}/${name}`); else { hash.update(`${relative}/${name}\0`); hash.update(readBounded(file)); } } };
      visit(directory, ''); return hash.digest('hex');
    };
    for (const leaf of ['sdk', 'recipes']) {
      const from = join(source, leaf); const to = join(this.root, leaf);
      const expected = digest(from);
      let current = ''; try { current = digest(to); } catch { /* Missing or damaged managed assets are replaced. */ }
      if (current !== expected) { rmSync(to, { recursive: true, force: true }); cpSync(from, to, { recursive: true, errorOnExist: true, force: false }); }
    }
    writeFileSync(join(this.root, '.provisioned'), digest(source));
  }

  path(input: unknown): string { return scopedPath(this.root, input, CANVAS_EXTENSION); }
  name(path: string): string { return basename(path).slice(0, -CANVAS_EXTENSION.length) || 'Canvas'; }
  list(): Data {
    mkdirSync(this.canvases, { recursive: true });
    const canvases = readdirSync(this.canvases).filter(name => name.endsWith(CANVAS_EXTENSION)).flatMap(name => {
      try { const filePath = this.path(join(this.canvases, name)); return [{ filePath, name: this.name(filePath), modifiedMs: lstatSync(filePath).mtimeMs }]; } catch { return []; }
    }).sort((a,b) => b.modifiedMs - a.modifiedMs);
    return { ok: true, canvases };
  }
  load(input: unknown): Data { const path = this.path(input); return { ok: true, source: readBounded(path), data: this.state(path), themeKind: 'dark', locale: 'en' }; }
  private state(path: string): Data {
    try { const sidecar = scopedPath(this.root, path.replace(/\.tsx$/, '.data.json'), '.canvas.data.json'); return record(JSON.parse(readBounded(sidecar, 1024 * 1024))); } catch { return {}; }
  }
  writeState(input: unknown, entries: unknown): Data {
    const path = this.path(input);
    const next = { ...this.state(path), ...record(entries) };
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') > 1024 * 1024) throw new Error('Canvas persisted state exceeds 1 MiB.');
    const target = scopedPath(this.root, path.replace(/\.tsx$/, '.data.json'), '.canvas.data.json', false);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Canvas state cannot be a symbolic link.');
    writeAtomic(target, next); return { ok: true };
  }
  check(input: unknown): Data {
    const path = text(input, 'file_path');
    if (path !== resolve(path) || !path.endsWith(CANVAS_EXTENSION)) throw new Error('canvas_check requires an absolute .canvas.tsx file path.');
    const source = readBounded(path);
    const sdkNames = sdkExports(readBounded(join(this.root, 'sdk', 'index.d.ts')));
    if (!sdkNames.size) throw new Error('The Canvas SDK declarations are missing or invalid.');
    const diagnostics = checkCanvas(source, sdkNames, inside(realpathSync(this.canvases), realpathSync(path)));
    return { filePath: path, clean: diagnostics.every(diagnostic => diagnostic.message.startsWith('note:')), diagnostics: json(diagnostics) };
  }
  toolSpec(): Data { return { type: 'function', name: 'canvas_check', description: 'Validate a .canvas.tsx file against the Canvas SDK before presenting it. Run after every write; fix reported imports, missing default export or render-time network calls. A clean canvas opens in the work panel.', inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute .canvas.tsx file path.' } }, required: ['file_path'] } }; }
}
