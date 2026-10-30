import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Json } from '../contract';
import { ChannelRegistry, IpcHandlerError, type HandlerContext } from '../registry';
import type { FileHit, PtyOptions } from '../../native/binding';
import { NativeCapabilities } from '../../native/service';
import { beforeDeadline, validDeadline, type NativePty } from '../../native/pty';
import { canonicalPath } from '../../services/directory-leases';

export interface NativeHandlerOptions {
  capabilities: NativeCapabilities;
  /** Must validate session/workspace access using context.senderId before returning roots. */
  resolveSearchRoots(context: HandlerContext, payload: Record<string, Json>): Promise<{ root: string; extraRoots: string[] }>;
  /** Main resolves cwd, executable and environment; a renderer cannot supply an executable here. */
  resolveTerminalOptions(context: HandlerContext, payload: Record<string, Json>): Promise<Omit<PtyOptions, 'resourceId' | 'cols' | 'rows' | 'deadlineMs'>>;
  /** Target only this sender. Resolve after bounded delivery/ack, so output pressure reaches the PTY. */
  deliver(senderId: number, channel: 'terminal:data' | 'terminal:exit', payload: Json): void | Promise<void>;
}

interface Terminal {
  owner: string;
  id: string;
  ready: Promise<Json>;
  resource?: NativePty;
  cwd?: string;
  closing: boolean;
  close?: Promise<StopResult>;
  writes: Promise<void>;
  pendingWrites: number;
}

type StopResult = { ok: true } | { ok: false; error: string };
interface DirectoryLease { roots: Set<string>; ready: Promise<void> }

function directoryKey(directory: string): string {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function containsDirectory(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function payload(context: HandlerContext): Record<string, Json> {
  const value = context.args[0];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function dimensions(value: Json | undefined, fallback: number, min: number, max: number): number {
  const number = value === undefined || typeof value === 'object' && value !== null ? NaN : Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function nativeOwner(senderId: number): string { return `renderer:${senderId}`; }

/** The application attaches/detaches trusted owners alongside its WebContents lifecycle. */
export function registerNativeHandlers(registry: ChannelRegistry, options: NativeHandlerOptions): {
  attachOwner(senderId: number): void;
  detachOwner(senderId: number, deadlineMs?: number): Promise<{ complete: boolean }>;
  quiesceDirectory(root: string, deadlineMs?: number): Promise<() => void>;
} {
  const terminals = new Map<string, Terminal>();
  const activeSearches = new Map<string, () => boolean>();
  const directoryLeases = new Map<string, DirectoryLease>();

  function forgetStopped(terminal: Terminal): void {
    if (terminal.resource?.stopped && terminals.get(terminal.id) === terminal) terminals.delete(terminal.id);
  }

  function matchesLease(lease: DirectoryLease, cwd: string): boolean {
    return [...lease.roots].some((root) => containsDirectory(root, directoryKey(cwd)));
  }

  async function resolveCwd(cwd: string, initialLeases: DirectoryLease[]): Promise<string> {
    if (!path.isAbsolute(cwd)) throw new Error('INVALID_CWD: terminal cwd must be absolute');
    const canonical = await realpath(cwd);
    const observed = new Set(initialLeases);
    for (;;) {
      for (const lease of directoryLeases.values()) observed.add(lease);
      await Promise.allSettled([...observed].map((lease) => lease.ready));
      // A lease can arrive while filesystem resolution is pending. Check again before spawning.
      if ([...directoryLeases.values()].some((lease) => !observed.has(lease))) continue;
      if ([...observed].some((lease) => matchesLease(lease, cwd) || matchesLease(lease, canonical))) {
        throw new Error('DIRECTORY_QUIESCED: terminal directory is being removed');
      }
      return canonical;
    }
  }

  function owned(context: HandlerContext, id: string): Terminal | undefined {
    const terminal = terminals.get(id);
    if (terminal && terminal.owner !== nativeOwner(context.senderId)) throw new IpcHandlerError('RESOURCE_NOT_OWNED', 'Terminal belongs to another caller');
    return terminal;
  }

  async function stop(terminal: Terminal, deadlineMs = 2000): Promise<StopResult> {
    if (terminal.close) return terminal.close;
    terminal.closing = true;
    terminal.close = (async (): Promise<StopResult> => {
      const until = Date.now() + deadlineMs;
      const creation = await beforeDeadline(terminal.ready, until);
      const report = await terminal.resource?.close(Math.max(1, until - Date.now()));
      forgetStopped(terminal);
      if (creation.done && !terminal.resource && terminals.get(terminal.id) === terminal) terminals.delete(terminal.id);
      return !creation.done || report && !report.complete ? { ok: false, error: report?.error ?? report?.deliveryError ?? 'Terminal shutdown deadline exceeded' } : { ok: true };
    })();
    return terminal.close;
  }

  registry.register('engine:workspaceFileSearch', async (context) => {
    const value = payload(context);
    const query = typeof value.query === 'string' ? value.query : '';
    const limit = typeof value.limit === 'number' && Number.isFinite(value.limit) ? Math.trunc(value.limit) : 40;
    if (limit < -2147483648 || limit > 2147483647) throw new IpcHandlerError('INVALID_LIMIT', 'File-search limit exceeds the supported integer range');
    const owner = nativeOwner(context.senderId);
    // One composer search per owner/session; a new query cancels every phase of its predecessor.
    const key = `${owner}:${typeof value.sessionId === 'string' ? value.sessionId : ''}`;
    activeSearches.get(key)?.();
    if (activeSearches.size >= 32 && !activeSearches.has(key)) throw new IpcHandlerError('BUSY', 'Too many file searches are pending');
    let cancelled = false;
    let current: (() => boolean) | undefined;
    const cancel = () => { cancelled = true; return current?.() ?? false; };
    activeSearches.set(key, cancel);
    try {
      const roots = await options.resolveSearchRoots(context, value);
      const hits: FileHit[] = [];
      for (const [index, root] of [roots.root, ...(limit < 0 ? [] : roots.extraRoots)].entries()) {
        if (cancelled) return [];
        if (limit >= 0 && hits.length >= limit) break;
        const operation = options.capabilities.search(owner, { root, query, limit: limit < 0 ? limit : limit - hits.length, deadlineMs: 15_000 });
        current = operation.cancel;
        const result = await operation.result;
        if (result.truncated) throw new IpcHandlerError('SEARCH_LIMIT_EXCEEDED', 'Workspace file listing exceeded its memory or entry bound');
        hits.push(...result.hits.map((hit) => index === 0 ? hit : { ...hit, rel: path.join(root, hit.rel) }));
      }
      return hits.map((hit) => ({ rel: hit.rel, name: hit.name, isDir: hit.isDir }));
    } catch (error) {
      if (cancelled) return [];
      throw error;
    } finally { if (activeSearches.get(key) === cancel) activeSearches.delete(key); }
  }, 'native-files');

  // Persistent-session counterpart to the one-shot search above. The @-menu's
  // file picker re-queries on every keystroke; a session walks the tree once and
  // re-ranks it, so typing does not re-walk. The three channels are start/query/
  // stop. Session state lives in the capability layer keyed by owner, so the
  // handler holds no registry of its own and owner isolation is enforced there.

  registry.register('engine:workspaceFileSearchSessionStart', async (context) => {
    const value = payload(context);
    const owner = nativeOwner(context.senderId);
    const deadlineMs = typeof value.deadlineMs === 'number' && Number.isFinite(value.deadlineMs)
      ? Math.trunc(value.deadlineMs) : 30_000;
    // The chat session id resolves the workspace roots; the native session id is
    // minted independently (by the capability layer) so two pickers in one chat
    // session never collide and the id always satisfies the native identifier rule.
    const roots = await options.resolveSearchRoots(context, value);
    // Pin the workspace layout at creation, exactly as the one-shot handler
    // resolves it per call: [primary, ...extra]. The session keeps these roots so
    // it can rebase a secondary root's hit without the caller passing indexes.
    const sessionRoots = [roots.root, ...roots.extraRoots];
    const session = await options.capabilities.openSearchSession(owner, sessionRoots, deadlineMs);
    if (session.info.truncated) {
      await options.capabilities.closeSearchSession(owner, session.sessionId);
      throw new IpcHandlerError('SEARCH_LIMIT_EXCEEDED', 'Workspace file listing exceeded its memory or entry bound');
    }
    return { sessionId: session.sessionId, roots: session.info.roots, scanned: session.info.scanned };
  }, 'native-files');

  registry.register('engine:workspaceFileSearchSessionQuery', async (context) => {
    const value = payload(context);
    const owner = nativeOwner(context.senderId);
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
    if (!sessionId) throw new IpcHandlerError('INVALID_SESSION', 'A search-session query needs a sessionId');
    const query = typeof value.query === 'string' ? value.query : '';
    const limit = typeof value.limit === 'number' && Number.isFinite(value.limit) ? Math.trunc(value.limit) : 40;
    if (limit < -2147483648 || limit > 2147483647) throw new IpcHandlerError('INVALID_LIMIT', 'File-search limit exceeds the supported integer range');
    const deadlineMs = typeof value.deadlineMs === 'number' && Number.isFinite(value.deadlineMs)
      ? Math.trunc(value.deadlineMs) : 5_000;
    const session = options.capabilities.ownedSearchSession(owner, sessionId);
    // Ranking a held snapshot is milliseconds, but a stale query from an earlier
    // keystroke can still be in flight; NativeSearchSession cancels it and its
    // superseded result resolves empty rather than rejecting.
    const operation = session.query(query, limit, deadlineMs);
    const result = await operation.result;
    return result.hits.map((hit) => ({ rel: hit.rel, name: hit.name, isDir: hit.isDir }));
  }, 'native-files');

  registry.register('engine:workspaceFileSearchSessionStop', async (context) => {
    const value = payload(context);
    const owner = nativeOwner(context.senderId);
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
    if (!sessionId) return { ok: true };
    await options.capabilities.closeSearchSession(owner, sessionId);
    return { ok: true };
  }, 'native-files');

  registry.register('terminal:start', (context): Json | Promise<Json> => {
    const value = payload(context);
    const rawId = typeof value.id === 'string' ? value.id.trim() : '';
    const id = /^[A-Za-z0-9._:-]{1,120}$/.test(rawId) ? rawId : `term-${randomUUID()}`;
    for (const terminal of terminals.values()) forgetStopped(terminal);
    const existing = owned(context, id);
    if (existing) return existing.closing ? Promise.resolve({ ok: false, error: 'Terminal is closing' }) : existing.ready;
    if (terminals.size >= 16) return { ok: false, error: 'BUSY: at most 16 terminals may be pending or running' };
    const terminal: Terminal = { id, owner: nativeOwner(context.senderId), ready: Promise.resolve(null), closing: false, writes: Promise.resolve(), pendingWrites: 0 };
    // A request begun during a lease keeps that lease even if its resolver completes after release.
    const initialLeases = [...directoryLeases.values()];
    terminals.set(id, terminal);
    terminal.ready = (async (): Promise<Json> => {
      try {
        const resolved = await options.resolveTerminalOptions(context, value);
        const cwd = await resolveCwd(resolved.cwd, initialLeases);
        terminal.cwd = directoryKey(cwd);
        if (terminal.closing) throw new Error('CLOSED: terminal creation was cancelled');
        if ([...directoryLeases.values()].some((lease) => matchesLease(lease, resolved.cwd) || matchesLease(lease, cwd))) {
          throw new Error('DIRECTORY_QUIESCED: terminal directory is being removed');
        }
        const decoder = new StringDecoder('utf8');
        const resource = options.capabilities.openPty(terminal.owner, { ...resolved, cwd,
          cols: dimensions(value.cols, 80, 20, 400), rows: dimensions(value.rows, 12, 4, 120), deadlineMs: 5000,
        }, async (event) => {
          if (event.kind === 'data') {
            const data = decoder.write(event.data);
            if (data) await options.deliver(context.senderId, 'terminal:data', { id, data, resourceId: event.resourceId, sequence: event.sequence });
          } else {
            const tail = decoder.end();
            if (tail) await options.deliver(context.senderId, 'terminal:data', { id, data: tail, resourceId: event.resourceId, sequence: event.sequence });
            await options.deliver(context.senderId, 'terminal:exit', { id, exitCode: event.exitCode, signal: event.signal,
              resourceId: event.resourceId, sequence: event.sequence,
              ...(event.error ? { error: event.error } : {}), outputComplete: event.outputComplete });
          }
        });
        terminal.resource = resource;
        void resource.finished.then(() => forgetStopped(terminal));
        const info = await resource.ready;
        return { ok: true, id, cwd: info.cwd, shell: info.command };
      } catch (error) {
        if (!terminal.resource && terminals.get(id) === terminal) terminals.delete(id);
        else forgetStopped(terminal);
        return { ok: false, error: message(error) };
      }
    })();
    return terminal.ready;
  }, 'native-pty');

  registry.register('terminal:write', async (context): Promise<Json> => {
    const value = payload(context);
    const terminal = owned(context, typeof value.id === 'string' ? value.id : '');
    if (!terminal || terminal.closing) return { ok: false, error: 'Terminal not found or closing' };
    const data = typeof value.data === 'string' ? value.data : '';
    if (Buffer.byteLength(data) > 1024 * 1024) return { ok: false, error: 'Terminal paste exceeds 1 MiB' };
    if (terminal.pendingWrites >= 8) return { ok: false, error: 'BACKPRESSURE: terminal input queue is full' };
    terminal.pendingWrites++;
    const write = terminal.writes.then(async () => {
      await terminal.ready;
      if (!terminal.resource || terminal.closing) throw new Error('CLOSED: terminal is unavailable');
      const bytes = Buffer.from(data);
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
        if (terminal.closing) throw new Error('CLOSED: terminal paste was interrupted');
        await terminal.resource.write(bytes.subarray(offset, offset + 64 * 1024));
      }
    });
    terminal.writes = write.catch(() => undefined);
    try { await write; return { ok: true }; }
    catch (error) { return { ok: false, error: message(error) }; }
    finally { terminal.pendingWrites--; }
  }, 'native-pty');

  registry.register('terminal:resize', async (context): Promise<Json> => {
    const value = payload(context);
    const terminal = owned(context, typeof value.id === 'string' ? value.id : '');
    if (!terminal || terminal.closing) return { ok: false, error: 'Terminal not found or closing' };
    try {
      await terminal.ready;
      if (!terminal.resource) throw new Error('Terminal did not start');
      await terminal.resource.resize(dimensions(value.cols, 80, 20, 400), dimensions(value.rows, 12, 4, 120));
      return { ok: true };
    } catch (error) { return { ok: false, error: message(error) }; }
  }, 'native-pty');

  registry.register('terminal:kill', (context) => {
    const terminal = owned(context, typeof payload(context).id === 'string' ? payload(context).id as string : '');
    return terminal ? stop(terminal) : { ok: true };
  }, 'native-pty');

  return {
    attachOwner: (senderId) => options.capabilities.registerOwner(nativeOwner(senderId)),
    detachOwner: async (senderId, deadlineMs = 2000) => {
      const owner = nativeOwner(senderId);
      for (const [key, cancel] of activeSearches) if (key.startsWith(`${owner}:`)) cancel();
      for (const terminal of terminals.values()) if (terminal.owner === owner) terminal.closing = true;
      const report = await options.capabilities.closeOwner(owner, deadlineMs);
      for (const terminal of terminals.values()) if (terminal.owner === owner) forgetStopped(terminal);
      return { complete: report.complete };
    },
    quiesceDirectory: async (root, deadlineMs = 5000) => {
      validDeadline(deadlineMs);
      if (!path.isAbsolute(root)) throw new Error('INVALID_DIRECTORY: quiescence requires an absolute directory');
      if (directoryLeases.size >= 64) throw new Error('BUSY: too many directory leases are active');
      const until = Date.now() + deadlineMs;
      const id = randomUUID();
      const lease: DirectoryLease = { roots: new Set([directoryKey(root)]), ready: Promise.resolve() };
      directoryLeases.set(id, lease);
      lease.ready = canonicalPath(root).then((canonical) => { lease.roots.add(directoryKey(canonical)); });
      const release = () => { directoryLeases.delete(id); };
      try {
        if (!(await beforeDeadline(lease.ready, until)).done) throw new Error('DIRECTORY_QUIESCE_TIMEOUT: directory resolution is pending');
        for (const terminal of terminals.values()) forgetStopped(terminal);
        const results = await Promise.all([...terminals.values()].map(async (terminal): Promise<StopResult> => {
          if (!terminal.cwd) {
            const creation = await beforeDeadline(terminal.ready, until);
            if (!creation.done) return { ok: false, error: `Terminal ${terminal.id} is still resolving its directory` };
          }
          if (!terminal.cwd || !matchesLease(lease, terminal.cwd)) return { ok: true };
          const closed = await beforeDeadline(stop(terminal, Math.max(1, until - Date.now())), until);
          return closed.done ? closed.value : { ok: false, error: `Terminal ${terminal.id} is still closing` };
        }));
        const failure = results.find((result) => !result.ok);
        if (failure) throw new Error(`DIRECTORY_QUIESCE_FAILED: ${failure.error}`);
        return release;
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}
