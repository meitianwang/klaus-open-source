import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { BrowserExtensionInfo, BrowserExtensionPackage } from '../../contracts/browser-extensions';
import { BrowserError } from './types';

interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  manifest: Record<string, unknown>;
}

interface ExtensionLoader {
  loadExtension(path: string, options: { allowFileAccess: boolean }): Promise<LoadedExtension>;
  removeExtension(id: string): void;
}

interface SavedExtension {
  id: string;
  path: string;
  name: string;
  version: string;
  enabled: boolean;
}

const EXTENSION_ID = /^[a-p]{32}$/u;
const MAX_EXTENSIONS = 100;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** Owns only the extensions loaded into the dedicated browsing session. */
export class BrowserExtensionManager {
  private readonly saved = new Map<string, SavedExtension>();
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly errors = new Map<string, string>();
  private readonly registryPath: string;
  private readonly ready: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private registryError: string | undefined;

  constructor(private readonly options: {
    directory: string;
    extensions: ExtensionLoader;
    changed?(): void;
  }) {
    this.registryPath = join(options.directory, 'extensions.json');
    this.ready = this.restore();
  }

  initialize(): Promise<void> { return this.ready; }

  private async restore(): Promise<void> {
    try {
      let text: string;
      try { text = await readFile(this.registryPath, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (text.length > 2 * 1024 * 1024) throw new Error('The extension registry is too large.');
      const value = JSON.parse(text) as { version?: unknown; items?: unknown };
      if (value.version !== 1 || !Array.isArray(value.items) || value.items.length > MAX_EXTENSIONS) throw new Error('The extension registry is invalid.');
      for (const item of value.items) {
        if (!item || typeof item !== 'object') throw new Error('The extension registry is invalid.');
        const row = item as SavedExtension;
        if (!EXTENSION_ID.test(row.id) || typeof row.path !== 'string' || !isAbsolute(row.path)
          || typeof row.name !== 'string' || typeof row.version !== 'string' || typeof row.enabled !== 'boolean'
          || this.saved.has(row.id)) throw new Error('The extension registry is invalid.');
        this.saved.set(row.id, { id: row.id, path: row.path, name: row.name, version: row.version, enabled: row.enabled });
      }
    } catch (error) {
      this.saved.clear();
      this.registryError = error instanceof Error ? error.message : 'The extension registry could not be read.';
      return;
    }
    for (const record of this.saved.values()) {
      if (this.disposed) return;
      if (!record.enabled) continue;
      try {
        const extension = await this.load(record.path);
        if (extension.id !== record.id) {
          this.options.extensions.removeExtension(extension.id);
          throw new Error('The extension identity changed. Remove it before installing the replacement.');
        }
        this.loaded.set(record.id, extension);
      } catch (error) { this.errors.set(record.id, this.errorMessage(error)); }
    }
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : 'The extension could not be loaded.').slice(0, 1000);
  }

  private assertOpen(): void {
    if (this.disposed) throw new BrowserError('unavailable', 'Browser extension management has closed.');
    if (this.registryError) throw new BrowserError('extension_registry_unavailable', this.registryError);
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pending.then(async () => { await this.ready; this.assertOpen(); return work(); });
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async source(path: string): Promise<string> {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new BrowserError('invalid_request', 'Select an absolute extension directory.');
    const directory = await lstat(path);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new BrowserError('invalid_extension', 'The extension must be a real directory.');
    const canonical = await realpath(path);
    const manifest = await lstat(join(canonical, 'manifest.json'));
    if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.size > MAX_MANIFEST_BYTES) throw new BrowserError('invalid_extension', 'The extension manifest is missing or invalid.');
    const value = JSON.parse(await readFile(join(canonical, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    if (![2, 3].includes(Number(value.manifest_version)) || typeof value.name !== 'string' || typeof value.version !== 'string') {
      throw new BrowserError('invalid_extension', 'The extension manifest needs a supported format, name and version.');
    }
    return canonical;
  }

  private async load(path: string): Promise<LoadedExtension> {
    const source = await this.source(path);
    if (this.disposed) throw new BrowserError('cancelled', 'Extension loading was cancelled.');
    const extension = await this.options.extensions.loadExtension(source, { allowFileAccess: false });
    if (this.disposed) {
      this.options.extensions.removeExtension(extension.id);
      throw new BrowserError('cancelled', 'Extension loading was cancelled.');
    }
    if (!EXTENSION_ID.test(extension.id) || extension.path !== source) {
      if (!this.loaded.has(extension.id)) this.options.extensions.removeExtension(extension.id);
      throw new BrowserError('invalid_extension', 'The extension did not load into its selected directory.');
    }
    return extension;
  }

  private async persist(): Promise<void> {
    this.assertOpen();
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, items: [...this.saved.values()] }) + '\n', { mode: 0o600, flag: 'wx' });
      this.assertOpen();
      await rename(temporary, this.registryPath);
    } finally { await rm(temporary, { force: true }); }
  }

  async list(): Promise<BrowserExtensionInfo[]> {
    await this.ready;
    this.assertOpen();
    return [...this.saved.values()].map(record => {
      const extension = this.loaded.get(record.id);
      const manifest = extension?.manifest ?? {};
      const permissions = [...new Set([manifest.permissions, manifest.host_permissions].flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []))];
      return { ...record, loaded: !!extension, permissions, ...(this.errors.has(record.id) ? { error: this.errors.get(record.id) } : {}) };
    });
  }

  install(input: BrowserExtensionPackage): Promise<BrowserExtensionInfo> {
    return this.mutate(async () => {
      const source = await this.source(input.path);
      const previous = [...this.saved.values()].find(item => item.path === source || (input.id && item.id === input.id));
      if (!previous && this.saved.size >= MAX_EXTENSIONS) throw new BrowserError('extension_limit', 'Too many browser extensions are installed.');
      const savedBefore = new Map(this.saved);
      const loadedBefore = new Map(this.loaded);
      const affected = new Set<string>();
      if (previous) affected.add(previous.id);
      const previousLoaded = previous && this.loaded.get(previous.id);
      if (previousLoaded) {
        this.options.extensions.removeExtension(previousLoaded.id);
        this.loaded.delete(previousLoaded.id);
      }
      let extension: LoadedExtension | undefined;
      try {
        extension = await this.load(source);
        affected.add(extension.id);
        const collision = this.saved.get(extension.id);
        if (collision && collision.id !== previous?.id) throw new BrowserError('extension_conflict', 'This extension identity is already installed.');
        if (previous) this.saved.delete(previous.id);
        this.saved.set(extension.id, { id: extension.id, path: source, name: extension.name, version: extension.version, enabled: true });
        this.loaded.set(extension.id, extension);
        await this.persist();
      } catch (error) {
        if (extension) this.options.extensions.removeExtension(extension.id);
        this.saved.clear();
        for (const [id, record] of savedBefore) this.saved.set(id, record);
        for (const id of affected) {
          this.loaded.delete(id);
          const old = loadedBefore.get(id);
          if (old && !this.disposed) {
            try { this.loaded.set(id, await this.load(old.path)); }
            catch (restoreError) { this.errors.set(id, this.errorMessage(restoreError)); }
          }
        }
        throw error;
      }
      this.errors.delete(extension.id);
      if (previous) this.errors.delete(previous.id);
      this.options.changed?.();
      return (await this.list()).find(item => item.id === extension!.id)!;
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<BrowserExtensionInfo> {
    return this.mutate(async () => {
      const record = this.saved.get(id);
      if (!record) throw new BrowserError('not_found', 'The browser extension was not found.');
      const before = { ...record };
      const previous = this.loaded.get(id);
      let next: LoadedExtension | undefined;
      if (enabled && !previous) {
        next = await this.load(record.path);
        if (next.id !== id) {
          this.options.extensions.removeExtension(next.id);
          throw new BrowserError('extension_identity_changed', 'The extension identity changed.');
        }
      }
      try {
        record.enabled = enabled;
        await this.persist();
      } catch (error) {
        this.saved.set(id, before);
        if (next) this.options.extensions.removeExtension(next.id);
        throw error;
      }
      if (next) this.loaded.set(id, next);
      if (!enabled && previous) {
        this.options.extensions.removeExtension(id);
        this.loaded.delete(id);
      }
      this.errors.delete(id);
      this.options.changed?.();
      return (await this.list()).find(item => item.id === id)!;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      const record = this.saved.get(id);
      if (!record) throw new BrowserError('not_found', 'The browser extension was not found.');
      this.saved.delete(id);
      try { await this.persist(); }
      catch (error) { this.saved.set(id, record); throw error; }
      if (this.loaded.has(id)) this.options.extensions.removeExtension(id);
      this.loaded.delete(id);
      this.errors.delete(id);
      this.options.changed?.();
      // A selected unpacked source directory belongs to its user. Removing the
      // registration must never delete source code or downloaded user files.
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.loaded.keys()) this.options.extensions.removeExtension(id);
    this.loaded.clear();
  }
}
