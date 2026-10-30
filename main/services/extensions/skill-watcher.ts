import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { managedPath, missing } from './file-store';

const THROTTLE_MS = 10_000;
const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const localRoots = (roots: string[]): string[] => [...new Set(roots.filter(root => root && !root.includes('\0') && !root.includes('://') && isAbsolute(root)).map(root => resolve(root)))];

export interface SkillWatcherDeps {
  configRoot: string;
  invalidate: () => void;
  onChanged: () => void | Promise<void>;
  diagnostic: (path: string, error: unknown) => void;
  /** Production uses a ten second minimum interval between notifications. */
  throttleMs?: number;
  watch?: (path: string, options: { recursive: boolean }, listener: (event: string, filename: string | Buffer | null) => void) => FSWatcher;
}
export interface SkillWatchSubscription {
  update(projectRoots: string[]): Promise<void>;
  dispose(): Promise<void>;
}
interface RequestedWatch { path: string; recursive: boolean; logical: string }
interface ActualWatch { path: string; recursive: boolean; match: string; logical: string; fallback: boolean; existed: boolean }
interface Registration { watcher: FSWatcher; requests: ActualWatch[]; closed: Promise<void> }
interface WatchChange { eventPath: string; requests: ActualWatch[] }

/** Owns shared recursive watches and subscriptions for the host skill catalog. */
export class SkillWatcher {
  private readonly subscriptions = new Map<symbol, string[]>();
  private readonly registrations = new Map<string, Registration>();
  private readonly changedPaths = new Set<string>();
  private readonly pendingWatchChanges = new Map<string, WatchChange>();
  private watchChangesScheduled = false;
  private readonly systemRoot: string;
  private rootExistence = new Map<string, boolean>();
  private serial: Promise<void> = Promise.resolve();
  private emission: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextAllowed = 0;
  private emitting = false;
  private closed = false;
  constructor(private readonly deps: SkillWatcherDeps) { this.systemRoot = resolve(deps.configRoot, 'skills/.system'); }

  async subscribe(projectRoots: string[]): Promise<SkillWatchSubscription> {
    if (this.closed) throw new Error('Skill watching is closed');
    const id = Symbol('skill-roots');
    this.subscriptions.set(id, localRoots(projectRoots));
    await this.enqueue(() => this.reconcile());
    let disposed = false;
    return {
      update: async roots => {
        if (disposed || this.closed) return;
        this.subscriptions.set(id, localRoots(roots));
        await this.enqueue(() => this.reconcile());
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true; this.subscriptions.delete(id);
        await this.enqueue(() => this.reconcile());
      },
    };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.serial.then(operation);
    this.serial = result.catch(error => this.deps.diagnostic(this.deps.configRoot, error));
    return result;
  }

  private async existing(path: string): Promise<boolean> {
    try { await stat(path); return true; }
    catch (error) { if (!missing(error)) this.deps.diagnostic(path, error); return false; }
  }

  private async actual(request: RequestedWatch): Promise<ActualWatch | undefined> {
    const existed = await this.existing(request.path);
    if (existed) {
      try {
        const match = !request.recursive && (await lstat(request.path)).isSymbolicLink()
          ? join(await realpath(dirname(request.path)), basename(request.path)) : await realpath(request.path);
        return { ...request, match, fallback: false, existed };
      }
      catch (error) { this.deps.diagnostic(request.path, error); return undefined; }
    }
    let ancestor = dirname(request.path);
    for (;;) {
      try {
        if ((await stat(ancestor)).isDirectory()) {
          const canonical = await realpath(ancestor);
          return { path: ancestor, recursive: false, match: join(canonical, relative(ancestor, request.path)), logical: request.logical, fallback: true, existed };
        }
      } catch (error) { if (!missing(error)) this.deps.diagnostic(ancestor, error); }
      const parent = dirname(ancestor); if (parent === ancestor) return undefined; ancestor = parent;
    }
  }

  private async requestedRoots(): Promise<RequestedWatch[]> {
    const projects = localRoots([...this.subscriptions.values()].flat());
    const scopes = [{ boundary: this.deps.configRoot, relative: 'skills' }, ...projects.map(boundary => ({ boundary, relative: '.klaus/skills' }))];
    const requests = new Map<string, RequestedWatch>();
    const add = (request: RequestedWatch): void => { requests.set(JSON.stringify([request.path, request.recursive, request.logical]), request); };
    for (const scope of scopes) {
      const logical = resolve(scope.boundary, scope.relative);
      try {
        const path = await managedPath(scope.boundary, scope.relative);
        add({ path, recursive: true, logical });
        if (!await this.existing(path)) continue;
        const boundary = await realpath(scope.boundary), visited = new Set<string>();
        const walk = async (source: string, visible: string): Promise<void> => {
          if (within(visible, this.systemRoot)) return;
          let canonical: string;
          try { canonical = await realpath(source); }
          catch (error) { if (!missing(error)) this.deps.diagnostic(source, error); return; }
          if (!within(canonical, boundary)) return;
          let info;
          try { info = await lstat(source); }
          catch (error) { if (!missing(error)) this.deps.diagnostic(source, error); return; }
          if (info.isSymbolicLink()) {
            // Watch the link's directory for retargeting and its referent for edits.
            add({ path: source, recursive: false, logical: visible });
            const target = await stat(canonical);
            add({ path: canonical, recursive: target.isDirectory(), logical: visible });
            info = target;
          }
          if (!info.isDirectory() || visited.has(canonical)) return;
          visited.add(canonical);
          for (const entry of await readdir(source, { withFileTypes: true })) {
            if (entry.isDirectory() || entry.isSymbolicLink()) await walk(join(source, entry.name), join(visible, entry.name));
          }
        };
        await walk(path, logical);
      } catch (error) {
        // An unsafe or broken link must remain observable without following its referent.
        add({ path: logical, recursive: false, logical });
        if (!missing(error)) this.deps.diagnostic(logical, error);
      }
    }
    return [...requests.values()];
  }

  private async reconcile(): Promise<void> {
    if (this.closed) return;
    if (!this.subscriptions.size) {
      this.changedPaths.clear();
      if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    }
    const desired = new Map<string, ActualWatch[]>();
    const requested = this.subscriptions.size ? await this.requestedRoots() : [];
    const installed = new Map<string, ActualWatch>();
    for (const request of requested) {
      const actual = await this.actual(request); if (!actual) continue;
      installed.set(JSON.stringify(request), actual);
      // File and link watches use their parent so atomic replacement remains visible.
      let directory = actual.path, recursive = actual.recursive;
      if (!actual.fallback) {
        try {
          if (!(await stat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink() && !recursive) { directory = dirname(directory); recursive = false; }
        } catch (error) { if (!missing(error)) this.deps.diagnostic(directory, error); continue; }
      }
      try { directory = await realpath(directory); }
      catch (error) { if (!missing(error)) this.deps.diagnostic(directory, error); continue; }
      const key = JSON.stringify([directory, recursive]);
      const requests = desired.get(key) ?? []; requests.push(actual); desired.set(key, requests);
    }
    for (const [key, requests] of desired) {
      const current = this.registrations.get(key);
      if (current) { current.requests = requests; continue; }
      const [path, recursive] = JSON.parse(key) as [string, boolean];
      try {
        const watcher = (this.deps.watch ?? watch)(path, { recursive }, (_event, filename) => {
          const eventPath = filename === null ? path : resolve(path, filename.toString());
          const snapshot = this.registrations.get(key)?.requests ?? [];
          // Ancestor watches also receive database, log and application-cache writes.
          // Only paths that can change a requested root belong on the shared queue.
          if (filename !== null && !snapshot.some(request => within(request.match, eventPath) || within(eventPath, request.match))) return;
          const changeKey = JSON.stringify([key, eventPath]);
          const previous = this.pendingWatchChanges.get(changeKey);
          this.pendingWatchChanges.set(changeKey, { eventPath, requests: previous
            ? [...new Map([...previous.requests, ...snapshot].map(request => [JSON.stringify(request), request])).values()] : snapshot });
          this.scheduleWatchChanges();
        });
        watcher.on('error', error => { this.deps.diagnostic(path, error); });
        const closed = new Promise<void>(resolve => { watcher.once('close', resolve); });
        this.registrations.set(key, { watcher, requests, closed });
      } catch (error) { this.deps.diagnostic(path, error); }
    }
    for (const [key, registration] of this.registrations) if (!desired.has(key)) { registration.watcher.close(); await registration.closed; this.registrations.delete(key); }
    const roots = this.subscriptions.size ? [resolve(this.deps.configRoot, 'skills'), ...localRoots([...this.subscriptions.values()].flat()).map(root => join(root, '.klaus/skills'))] : [];
    const nextExistence = new Map<string, boolean>(), changed: string[] = [];
    for (const root of roots) {
      const exists = await this.existing(root); nextExistence.set(root, exists);
      if (this.rootExistence.has(root) && this.rootExistence.get(root) !== exists) changed.push(root);
    }
    this.rootExistence = nextExistence;
    // A creation can race the move from an ancestor watch to its requested root.
    // Recheck after installation so that the first file cannot fall into that gap.
    let moved = false;
    for (const request of requested) {
      const before = installed.get(JSON.stringify(request)), after = await this.actual(request);
      if (before && after && (before.path !== after.path || before.recursive !== after.recursive || before.match !== after.match || before.existed !== after.existed)) {
        if (before.existed !== after.existed) changed.push(request.logical);
        moved = true; break;
      }
    }
    if (moved) await this.reconcile();
    this.queueChange(changed);
  }

  private scheduleWatchChanges(): void {
    if (this.closed || this.watchChangesScheduled || !this.pendingWatchChanges.size) return;
    this.watchChangesScheduled = true;
    void this.enqueue(async () => {
      try {
        if (this.closed) return;
        const changes = [...this.pendingWatchChanges.values()]; this.pendingWatchChanges.clear();
        const changed: string[] = [];
        for (const { eventPath, requests } of changes) for (const request of requests) {
          const matched = request.match;
          if (eventPath === matched) changed.push(request.logical);
          else if (within(matched, eventPath)) {
            if (!request.fallback || request.existed || await this.existing(matched)) changed.push(request.logical);
          } else if (within(eventPath, matched) && (request.recursive || dirname(eventPath) === matched)) {
            changed.push(join(request.logical, relative(matched, eventPath)));
          }
        }
        // A batch shares root discovery while preserving every logical change and rebind.
        await this.reconcile();
        this.queueChange(changed);
      } finally {
        this.watchChangesScheduled = false;
        this.scheduleWatchChanges();
      }
    }).catch(() => { /* enqueue reports diagnostics and keeps the shared queue usable. */ });
  }

  private queueChange(paths: string[]): void {
    if (this.closed || !this.subscriptions.size) return;
    for (const path of paths) this.changedPaths.add(path);
    this.schedule();
  }
  private schedule(): void {
    if (this.closed || this.emitting || this.timer || !this.changedPaths.size) return;
    const wait = Math.max(0, this.nextAllowed - Date.now());
    if (!wait) { this.flush(); return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, wait);
    this.timer.unref();
  }
  private flush(): void {
    if (this.closed || !this.subscriptions.size || !this.changedPaths.size) return;
    const paths = [...this.changedPaths]; this.changedPaths.clear();
    this.nextAllowed = Date.now() + Math.max(0, this.deps.throttleMs ?? THROTTLE_MS);
    if (paths.every(path => within(path, this.systemRoot))) { this.schedule(); return; }
    this.deps.invalidate(); this.emitting = true;
    this.emission = Promise.resolve().then(() => this.deps.onChanged()).catch(error => this.deps.diagnostic(this.deps.configRoot, error)).finally(() => { this.emitting = false; this.schedule(); });
  }

  async close(): Promise<void> {
    this.closed = true; this.subscriptions.clear(); this.changedPaths.clear(); this.pendingWatchChanges.clear(); this.rootExistence.clear();
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    await this.serial;
    const closing = [...this.registrations.values()];
    for (const registration of closing) registration.watcher.close();
    await Promise.all(closing.map(registration => registration.closed));
    this.registrations.clear();
    await this.emission;
  }
}
