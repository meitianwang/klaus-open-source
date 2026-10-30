import { constants } from 'node:fs';
import { open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { pathInside } from './workspaces';
import { errorMessage, string, type JsonObject } from './service-types';

const MEMORY_LIMIT = 256 * 1024, SPEC_LIMIT = 8 * 1024 * 1024;
export interface DocumentOptions {
  configRoot: string;
  withFiles(paths: string[], work: () => Promise<Json>): Promise<Json>;
  openPath(path: string): Promise<void>;
  openMemoryWindow(path: string): Promise<void>;
  chooseSpecExportPath(name: string): Promise<string | undefined>;
}

/** Bounded readers and explicitly chosen exports; engine memory remains engine-owned. */
export class DocumentService {
  private readonly root: string;
  private closed = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly options: DocumentOptions) { this.root = resolve(options.configRoot); }
  private active(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'Document operations are closing'); }
  private track(work: () => Promise<Json>): Promise<Json> {
    this.active();
    const action = Promise.resolve().then(() => { this.active(); return work(); });
    this.pending.add(action); void action.finally(() => this.pending.delete(action)).catch(() => {}); return action;
  }
  private async memoryPath(input: string): Promise<string> {
    if (!input || input.includes('\0')) throw new Error('invalid-path');
    const target = resolve(this.root, input), roots = [join(this.root, 'agent-memory')];
    try {
      for (const entry of await readdir(join(this.root, 'projects'), { withFileTypes: true })) {
        if (entry.isDirectory()) roots.push(join(this.root, 'projects', entry.name, 'memory'));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const allowed = roots.filter(root => pathInside(target, root));
    if (!allowed.length) for (const root of roots) {
      try { if (pathInside(target, await realpath(root))) allowed.push(root); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    if (!allowed.length) throw new Error('path-escape');
    // Keep stat's missing-file error shape while separately verifying symlink scope.
    const info = await stat(target); if (!info.isFile()) throw new Error('not-a-file');
    const actual = await realpath(target), config = await realpath(this.root);
    for (const root of allowed) {
      const actualRoot = await realpath(root);
      if (pathInside(actualRoot, config) && pathInside(actual, actualRoot)) return actual;
    }
    throw new Error('path-escape');
  }
  private async specPath(input: string): Promise<string> {
    if (!input || input.includes('\0') || !isAbsolute(input) || !input.endsWith('.md')) throw new Error('invalid spec path');
    const target = resolve(input), parent = dirname(target), global = join(this.root, 'plans');
    const projectSpecs = basename(parent) === 'specs' && basename(dirname(parent)) === '.klaus';
    if (parent !== global && !projectSpecs) throw new Error('not a spec document');
    let info;
    try { info = await stat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('spec document is missing'); throw error;
    }
    if (!info.isFile()) throw new Error('not a spec document');
    const actual = await realpath(target), actualParent = await realpath(parent);
    const expectedParent = parent === global ? join(await realpath(this.root), 'plans')
      : join(await realpath(dirname(dirname(parent))), '.klaus', 'specs');
    if (actualParent !== expectedParent || !pathInside(actual, actualParent)) throw new Error('spec path escapes its document directory');
    return actual;
  }
  private async bytes(path: string, limit: number): Promise<{ bytes: Buffer; size: number }> {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat(); if (!info.isFile()) throw new Error('not-a-file');
      const bytes = Buffer.alloc(Math.min(limit, info.size)); let offset = 0;
      while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
      const after = await file.stat();
      if (offset !== bytes.length || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new Error('The document changed while it was being read');
      return { bytes: bytes.subarray(0, offset), size: info.size };
    } finally { await file.close(); }
  }
  readMemory(payload: JsonObject): Promise<Json> {
    return this.track(() => this.options.withFiles([this.root], async (): Promise<Json> => {
      try {
        const path = await this.memoryPath(string(payload.relPath) || string(payload.filePath));
        const { bytes, size } = await this.bytes(path, MEMORY_LIMIT); this.active();
        return { ok: true, content: bytes.toString('utf8'), truncated: size > MEMORY_LIMIT, size };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    }));
  }
  openMemory(payload: JsonObject): Promise<Json> {
    return this.track(() => this.options.withFiles([this.root], async (): Promise<Json> => {
      try { const path = await this.memoryPath(string(payload.filePath)); this.active(); await this.options.openMemoryWindow(path); return { ok: true }; }
      catch (error) { return { ok: false, error: errorMessage(error) }; }
    }));
  }
  revealMemory(): Promise<Json> {
    return this.track(async (): Promise<Json> => {
      try { await this.options.openPath(this.root); return { ok: true, dir: this.root }; }
      catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }
  readSpec(payload: JsonObject): Promise<Json> {
    return this.track(() => this.options.withFiles([string(payload.path)], async (): Promise<Json> => {
      try {
        const path = await this.specPath(string(payload.path)), { bytes, size } = await this.bytes(path, SPEC_LIMIT + 1);
        if (size > SPEC_LIMIT || bytes.length > SPEC_LIMIT) throw new Error('Spec document exceeds the 8 MiB limit');
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); this.active();
        return { content, revision: createHash('sha256').update(bytes).digest('hex') };
      } catch (error) { return { error: errorMessage(error) }; }
    }));
  }
  openSpec(payload: JsonObject): Promise<Json> {
    return this.track(() => this.options.withFiles([string(payload.path)], async (): Promise<Json> => {
      try { const path = await this.specPath(string(payload.path)); this.active(); await this.options.openPath(path); return { ok: true }; }
      catch (error) { return { ok: false, error: errorMessage(error) }; }
    }));
  }
  saveSpec(payload: JsonObject): Promise<Json> {
    return this.track(async (): Promise<Json> => {
      try {
        if (typeof payload.content !== 'string') throw new Error('missing Spec content');
        const content = payload.content; if (Buffer.byteLength(content) > SPEC_LIMIT) throw new Error('Spec document exceeds the 8 MiB limit');
        const rawName = basename(string(payload.name) || 'spec.md').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 200) || 'spec.md';
        const name = rawName.endsWith('.md') ? rawName : rawName + '.md';
        const path = await this.options.chooseSpecExportPath(name); this.active();
        if (!path) return { ok: false, canceled: true };
        if (!isAbsolute(path) || path.includes('\0')) throw new Error('The save dialog returned an invalid path');
        return await this.options.withFiles([path], async () => {
          const temporary = join(dirname(path), `.klaus-spec-${randomUUID()}.tmp`);
          try { this.active(); await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); this.active(); await rename(temporary, path); }
          finally { await rm(temporary, { force: true }); }
          return { ok: true, path };
        });
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    });
  }
  async close(deadlineMs = 5000): Promise<void> {
    this.closed = true; let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Document operations did not finish before the shutdown deadline')), deadlineMs); }),
    ]); } finally { if (timer) clearTimeout(timer); }
  }
}
