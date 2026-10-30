import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { IpcHandlerError } from '../ipc/registry';
import { pathInside } from './workspaces';

/** Preserve missing suffixes so a never-created or removed directory still has a stable lease. */
export async function canonicalPath(path: string, links = 0): Promise<string> {
  if (links >= 40) throw new IpcHandlerError('BAD_REQUEST', 'Directory symlink resolution is too deep');
  let ancestor = path;
  for (;;) {
    try { return resolve(await realpath(ancestor), relative(ancestor, path)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // realpath cannot resolve a dangling link after its target was removed.
      // Retain its target and the missing suffix so that the active lease still applies.
      try {
        if ((await lstat(ancestor)).isSymbolicLink()) {
          return canonicalPath(resolve(dirname(ancestor), await readlink(ancestor), relative(ancestor, path)), links + 1);
        }
      } catch (linkError) {
        if (!['ENOENT', 'ENOTDIR'].includes((linkError as NodeJS.ErrnoException).code ?? '')) throw linkError;
      }
      const parent = dirname(ancestor); if (parent === ancestor) return path; ancestor = parent;
    }
  }
}

/** Excludes new activity until a caller finishes removing or replacing a directory. */
export class DirectoryLeases {
  private readonly leases = new Map<symbol, string[]>();
  private readonly active = new Set<Promise<void>>();
  private readonly preparing = new Set<Promise<void>>();

  private async aliases(paths: string[]): Promise<string[]> {
    const aliases = new Set(paths.filter(isAbsolute).map(path => resolve(path)));
    for (const path of [...aliases]) aliases.add(await canonicalPath(path));
    return [...aliases];
  }
  private assertAllowed(paths: string[]): void {
    for (const roots of this.leases.values()) for (const root of roots) {
      if (paths.some(path => pathInside(path, root))) throw new IpcHandlerError('DIRECTORY_BUSY', 'This directory is being removed or replaced');
    }
  }
  run<T>(roots: () => Promise<string[]>, callback: () => T | Promise<T>): Promise<T> {
    let finish!: () => void;
    const active = new Promise<void>(resolve => { finish = resolve; });
    this.active.add(active);
    return (async () => {
      try {
        const paths = await this.aliases(await roots());
        while (this.preparing.size) await Promise.all([...this.preparing]);
        this.assertAllowed(paths);
        return await callback();
      } finally { this.active.delete(active); finish(); }
    })();
  }
  async quiesce(root: string, drain: (roots: string[]) => void | Promise<void>): Promise<() => void> {
    if (!isAbsolute(root)) throw new IpcHandlerError('BAD_REQUEST', 'A directory lease requires an absolute path');
    const id = Symbol('directory-lease'), paths = [resolve(root)];
    // Install before the first await, so resolving an old request cannot admit new work.
    this.leases.set(id, paths);
    let prepared!: () => void;
    const preparation = new Promise<void>(resolve => { prepared = resolve; });
    this.preparing.add(preparation);
    const finishPreparation = (): void => { this.preparing.delete(preparation); prepared(); };
    const pending = [...this.active];
    const release = (): void => { this.leases.delete(id); };
    try {
      paths.push(...await this.aliases(paths));
      finishPreparation();
      await Promise.all(pending);
      await drain(paths);
      return release;
    } catch (error) { release(); throw error; }
    finally { finishPreparation(); }
  }
  async overlaps(paths: string[], roots: string[]): Promise<boolean> {
    return (await this.aliases(paths)).some(path => roots.some(root => pathInside(path, root)));
  }
}
