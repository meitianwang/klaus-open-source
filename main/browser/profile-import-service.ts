/**
 * Owner-scoped browser import jobs.
 *
 * The host must pass ownerId from its authenticated IPC context. It is never
 * read from a renderer request payload. A job owns one runtime target, one
 * lazily-created managed decryptor and one AbortSignal. Discovery is only
 * performed by the explicit discover/start entry points.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BROWSER_IMPORT_CATEGORIES,
  BrowserImportDecryptError,
  resolveBrowserImportSelection,
  validateBrowserImportRequest,
  type BrowserImportCounts,
  type BrowserImportIssue,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSelection,
  type BrowserImportTarget,
  type BrowserSourceRoot,
} from '../../contracts/browser-import';
import {
  BrowserImportJobError,
  type BrowserImportDiscovery,
  type BrowserImportJobHandle,
  type BrowserImportJobOptions,
  type BrowserImportJobSnapshot,
  type BrowserImportJobStage,
  type ManagedDecryptor,
} from '../../contracts/browser-import-jobs';
import { discoverBrowserProfiles } from './profile-discovery';
import { importBrowserProfile } from './profile-import';

interface JobRecord {
  jobId: string;
  ownerId: string;
  sourceId: string;
  profileId: string;
  request: BrowserImportRequest;
  roots: BrowserSourceRoot[];
  controller: AbortController;
  snapshot: BrowserImportJobSnapshot;
  done: Promise<void>;
  resolveDone: () => void;
  terminal: boolean;
}

const TERMINAL_STAGES = new Set<BrowserImportJobStage>(['completed', 'cancelled', 'failed']);

function emptyCounts(): BrowserImportCounts {
  return { cookies: 0, passwords: 0, history: 0, extensions: 0 };
}

function cloneCounts(counts: BrowserImportCounts): BrowserImportCounts {
  return {
    cookies: counts.cookies,
    passwords: counts.passwords,
    history: counts.history,
    extensions: counts.extensions,
  };
}

function cloneIssue(issue: BrowserImportIssue): BrowserImportIssue {
  return {
    category: issue.category,
    code: issue.code,
    message: issue.message,
    ...(issue.count === undefined ? {} : { count: issue.count }),
  };
}

function cloneSnapshot(snapshot: BrowserImportJobSnapshot): BrowserImportJobSnapshot {
  return {
    jobId: snapshot.jobId,
    sourceId: snapshot.sourceId,
    profileId: snapshot.profileId,
    revision: snapshot.revision,
    stage: snapshot.stage,
    counts: cloneCounts(snapshot.counts),
    errors: snapshot.errors.map(cloneIssue),
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
  };
}

function requestSelection(request: BrowserImportRequest): Required<BrowserImportSelection> {
  const selection = resolveBrowserImportSelection(request.categories);
  for (const category of BROWSER_IMPORT_CATEGORIES) {
    if (typeof selection[category] !== 'boolean') {
      throw new BrowserImportJobError('invalid_request', `The ${category} selection must be a boolean.`);
    }
  }
  return selection;
}

function copyRequest(input: BrowserImportRequest): BrowserImportRequest {
  const validation = validateBrowserImportRequest(input);
  if (!validation.ok) throw new BrowserImportJobError(validation.code, validation.message);
  const { sourceId, profileId, selection, allowlist, allowUnverifiedExtensions } = validation.value;
  return {
    sourceId,
    profileId,
    categories: { ...selection },
    ...(allowlist ? { cookieHostnameAllowlist: allowlist } : {}),
    ...(allowUnverifiedExtensions === undefined ? {} : { allowUnverifiedExtensions }),
  };
}

function copyRoots(roots: BrowserImportJobOptions['roots']): BrowserSourceRoot[] {
  let value: readonly BrowserSourceRoot[];
  try {
    value = typeof roots === 'function' ? roots() : roots;
  } catch {
    throw new BrowserImportJobError('roots_unavailable', 'The browser source roots are unavailable.');
  }
  if (!Array.isArray(value)) {
    throw new BrowserImportJobError('roots_unavailable', 'The browser source roots are invalid.');
  }
  return value.map(root => {
    if (!root || typeof root.id !== 'string' || !root.id
      || typeof root.label !== 'string'
      || typeof root.userDataDir !== 'string' || !root.userDataDir) {
      throw new BrowserImportJobError('roots_unavailable', 'A browser source root is invalid.');
    }
    return {
      id: root.id,
      label: root.label,
      userDataDir: root.userDataDir,
      ...(root.family ? { family: root.family } : {}),
    };
  });
}

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof BrowserImportJobError || error instanceof BrowserImportDecryptError) {
    return error.code;
  }
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[a-z0-9_]+$/u.test(code)) return code;
  }
  return fallback;
}

function failureResult(
  request: BrowserImportRequest,
  code: string,
  message: string,
  counts: BrowserImportCounts = emptyCounts(),
  cancelled = false,
): BrowserImportResult {
  return {
    ok: false,
    cancelled,
    sourceId: request.sourceId,
    profileId: request.profileId,
    counts,
    errors: [{ category: 'profile', code, message }],
  };
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new BrowserImportJobError('cancelled', 'The browser import was cancelled.'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(new BrowserImportJobError('cancelled', 'The browser import was cancelled.')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

class LazyManagedDecryptor {
  private instance: ManagedDecryptor | undefined;
  private closed = false;
  constructor(
    private readonly factory: BrowserImportJobOptions['createDecryptor'],
    private readonly source: BrowserSourceRoot,
    private readonly signal: AbortSignal,
  ) {}

  async decrypt(input: Uint8Array, context: Parameters<ManagedDecryptor['decrypt']>[1]): Promise<string> {
    if (this.closed) throw new BrowserImportDecryptError('decryptor_closed', 'The browser decryptor is closed.');
    if (this.signal.aborted) throw new BrowserImportDecryptError('cancelled', 'The browser import was cancelled.');
    if (!this.instance) this.instance = this.factory({ ...this.source }, this.signal);
    return this.instance.decrypt(input, context);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.instance) await this.instance.close();
  }
}

export class BrowserProfileImportService {
  private readonly terminalLimit: number;
  private readonly jobs = new Map<string, JobRecord>();
  private activeJobId: string | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private readonly terminalByOwner = new Map<string, string[]>();
  private readonly destroyedOwners = new Set<string>();
  private readonly disposePromises = new Map<string, Promise<void>>();

  constructor(private readonly options: BrowserImportJobOptions) {
    if (!options || typeof options.configRoot !== 'string' || !options.configRoot) {
      throw new BrowserImportJobError('invalid_config', 'A browser import config root is required.');
    }
    this.terminalLimit = Math.max(1, Math.min(100, Math.floor(options.terminalLimit ?? 10)));
  }

  /** Explicit UI-driven discovery. This is the only read-only discovery entry. */
  discover(ownerId: string, signal?: AbortSignal): Promise<BrowserImportDiscovery> {
    this.assertOwner(ownerId);
    const roots = copyRoots(this.options.roots);
    return discoverBrowserProfiles(roots, signal);
  }

  /**
   * Start one import. ownerId must come from the host's authenticated IPC
   * context, never from the renderer request payload.
   */
  start(ownerId: string, request: BrowserImportRequest): BrowserImportJobHandle {
    this.assertOwner(ownerId);
    const copiedRequest = copyRequest(request);
    const roots = copyRoots(this.options.roots);
    if (this.activeJobId) {
      throw new BrowserImportJobError('profile_busy', 'An import is already active for this browser target.');
    }
    const jobId = randomUUID();
    const now = Date.now();
    const snapshot: BrowserImportJobSnapshot = {
      jobId,
      sourceId: copiedRequest.sourceId,
      profileId: copiedRequest.profileId,
      revision: 0,
      stage: 'queued',
      counts: emptyCounts(),
      errors: [],
      startedAt: now,
      updatedAt: now,
    };
    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const job: JobRecord = {
      jobId,
      ownerId,
      sourceId: copiedRequest.sourceId,
      profileId: copiedRequest.profileId,
      request: copiedRequest,
      roots,
      controller: new AbortController(),
      snapshot,
      done,
      resolveDone,
      terminal: false,
    };
    this.jobs.set(jobId, job);
    this.activeJobId = jobId;
    this.emitSnapshot(job);
    const initialSnapshot = cloneSnapshot(snapshot);
    void this.run(job);
    return { jobId, snapshot: initialSnapshot };
  }

  state(ownerId: string, jobId: string): BrowserImportJobSnapshot {
    return cloneSnapshot(this.requireOwnedJob(ownerId, jobId).snapshot);
  }

  cancel(ownerId: string, jobId: string): BrowserImportJobSnapshot {
    const job = this.requireOwnedJob(ownerId, jobId);
    if (!job.terminal && !job.controller.signal.aborted) {
      this.setStage(job, 'cancelling');
      job.controller.abort();
    }
    return cloneSnapshot(job.snapshot);
  }

  async wait(ownerId: string, jobId: string): Promise<BrowserImportJobSnapshot> {
    const job = this.requireOwnedJob(ownerId, jobId);
    await job.done;
    return cloneSnapshot(job.snapshot);
  }

  async disposeOwner(ownerId: string): Promise<void> {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new BrowserImportJobError('invalid_owner', 'An owner identifier is required.');
    }
    const existing = this.disposePromises.get(ownerId);
    if (existing) return existing;
    this.destroyedOwners.add(ownerId);
    const promise = (async () => {
      const owned = [...this.jobs.values()].filter(job => job.ownerId === ownerId);
      for (const job of owned) {
        if (!job.terminal && !job.controller.signal.aborted) job.controller.abort();
      }
      await Promise.all(owned.map(job => job.done));
      for (const job of owned) {
        this.jobs.delete(job.jobId);
        if (this.activeJobId === job.jobId) this.activeJobId = undefined;
      }
      this.terminalByOwner.delete(ownerId);
    })();
    this.disposePromises.set(ownerId, promise);
    await promise;
  }

  /** Drain decryptors and native writes before the shared Profile is closed. */
  disposeAll(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const owners = new Set([...this.jobs.values()].map(job => job.ownerId));
    this.disposal = Promise.all([...owners].map(owner => this.disposeOwner(owner))).then(() => undefined);
    return this.disposal;
  }

  private assertOwner(ownerId: string): void {
    if (this.disposed) throw new BrowserImportJobError('owner_destroyed', 'The browser import service has closed.');
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new BrowserImportJobError('invalid_owner', 'An owner identifier is required.');
    }
    if (this.destroyedOwners.has(ownerId)) {
      throw new BrowserImportJobError('owner_destroyed', 'The owner has been disposed.');
    }
  }

  private requireOwnedJob(ownerId: string, jobId: string): JobRecord {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new BrowserImportJobError('invalid_owner', 'An owner identifier is required.');
    }
    const job = this.jobs.get(jobId);
    if (!job) throw new BrowserImportJobError('unknown_job', 'The browser import job does not exist.');
    if (job.ownerId !== ownerId) {
      throw new BrowserImportJobError('forbidden', 'The browser import job belongs to another owner.');
    }
    return job;
  }

  private async run(job: JobRecord): Promise<void> {
    let result: BrowserImportResult | undefined;
    let lazy: LazyManagedDecryptor | undefined;
    let closeError: unknown;
    let jobRoot: string | undefined;
    let phase: 'target' | 'import' = 'target';
    try {
      if (job.controller.signal.aborted) throw new BrowserImportJobError('cancelled', 'The browser import was cancelled.');
      this.setStage(job, 'preparing');
      const source = job.roots.find(root => root.id === job.sourceId);
      if (!source) {
        throw new BrowserImportJobError('source_unavailable', 'The selected browser source is not available.');
      }
      const target = await waitForAbort(
        Promise.resolve().then(() => this.options.target(copyRequest(job.request), job.controller.signal)),
        job.controller.signal,
      );
      if (job.controller.signal.aborted) throw new BrowserImportJobError('cancelled', 'The browser import was cancelled.');
      this.assertTargetCapabilities(job.request, target);

      this.setStage(job, 'importing');
      phase = 'import';
      lazy = new LazyManagedDecryptor(this.options.createDecryptor, { ...source }, job.controller.signal);
      jobRoot = join(this.options.configRoot, 'browser-import', 'jobs', job.jobId);
      result = await importBrowserProfile(job.request, {
        roots: job.roots.map(root => ({ ...root })),
        decryptor: lazy,
        target,
        extensionRoot: join(this.options.configRoot, 'browser-import', 'extensions'),
        tempRoot: join(jobRoot, 'tmp'),
        signal: job.controller.signal,
      });
      this.setStage(job, 'closing');
    } catch (error) {
      if (job.controller.signal.aborted || errorCode(error, '') === 'cancelled') {
        result = failureResult(job.request, 'cancelled', 'The browser import was cancelled.', emptyCounts(), true);
      } else {
        const code = errorCode(error, phase === 'target' ? 'target_unavailable' : 'import_failed');
        const message = error instanceof BrowserImportJobError
          ? error.message
          : phase === 'target'
            ? 'The browser target could not be initialized.'
            : 'The browser import did not complete.';
        result = failureResult(job.request, code, message);
      }
    } finally {
      if (lazy) {
        try {
          await lazy.close();
        } catch (error) {
          closeError = error;
        }
      }
      if (jobRoot) {
        try {
          await rm(jobRoot, { recursive: true, force: true });
        } catch {
          /* Best-effort cleanup of this job's empty scratch tree. */
        }
      }
    }

    if (closeError) {
      const code = errorCode(closeError, 'decryptor_close_failed');
      result = {
        ...(result ?? failureResult(job.request, code, 'The browser decryptor could not be closed.')),
        ok: false,
        errors: [
          ...((result ?? failureResult(job.request, code, 'The browser decryptor could not be closed.')).errors),
          { category: 'profile', code, message: 'The browser decryptor could not be closed.' },
        ],
      };
    }
    if (job.controller.signal.aborted && result) {
      result.cancelled = true;
      result.ok = false;
      if (!result.errors.some(issue => issue.code === 'cancelled')) {
        result.errors = [...result.errors, { category: 'profile', code: 'cancelled', message: 'The browser import was cancelled.' }];
      }
    }
    this.finish(job, result ?? failureResult(job.request, 'import_failed', 'The browser import did not complete.'));
  }

  private assertTargetCapabilities(request: BrowserImportRequest, target: BrowserImportTarget): void {
    const selection = requestSelection(request);
    const missing: string[] = [];
    if (selection.cookies && typeof target.applyCookies !== 'function') missing.push('cookies');
    if (selection.passwords && typeof target.applyPasswords !== 'function') missing.push('passwords');
    if (selection.history && typeof target.applyHistory !== 'function') missing.push('history');
    if (selection.extensions && typeof target.installExtension !== 'function') missing.push('extensions');
    if (missing.length > 0) {
      throw new BrowserImportJobError(
        'target_capability_unavailable',
        `The browser target cannot apply: ${missing.join(', ')}.`,
      );
    }
  }

  private setStage(job: JobRecord, stage: BrowserImportJobStage): void {
    if (job.terminal || job.snapshot.stage === stage) return;
    if (job.snapshot.stage === 'cancelling' && stage !== 'cancelled' && stage !== 'failed') return;
    job.snapshot.revision += 1;
    job.snapshot.stage = stage;
    job.snapshot.updatedAt = Date.now();
    this.emitSnapshot(job);
  }

  private emitSnapshot(job: JobRecord): void {
    if (this.destroyedOwners.has(job.ownerId)) return;
    try {
      this.options.emit(job.ownerId, cloneSnapshot(job.snapshot));
    } catch {
      /* A host UI callback must not break job state or resource cleanup. */
    }
  }

  private finish(job: JobRecord, result: BrowserImportResult): void {
    if (job.terminal) return;
    job.terminal = true;
    job.snapshot.revision += 1;
    job.snapshot.stage = result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed';
    job.snapshot.counts = cloneCounts(result.counts);
    job.snapshot.errors = result.errors.map(cloneIssue);
    job.snapshot.updatedAt = Date.now();
    this.emitSnapshot(job);
    if (this.activeJobId === job.jobId) this.activeJobId = undefined;
    this.retainTerminal(job);
    job.resolveDone();
  }

  private retainTerminal(job: JobRecord): void {
    const list = this.terminalByOwner.get(job.ownerId) ?? [];
    list.push(job.jobId);
    while (list.length > this.terminalLimit) {
      const removed = list.shift();
      if (removed) this.jobs.delete(removed);
    }
    this.terminalByOwner.set(job.ownerId, list);
  }
}
