/**
 * Owner-scoped browser import jobs.
 *
 * The host must pass ownerId from its authenticated IPC context. It is never
 * read from a renderer request payload. A job owns one backend instance and one
 * AbortSignal. Discovery is only performed by the explicit discover entry point.
 */

import { randomUUID } from 'node:crypto';
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
} from '../../contracts/browser-import';
import {
  BrowserImportJobError,
  type BrowserImportDiscovery,
  type BrowserImportJobHandle,
  type BrowserImportJobOptions,
  type BrowserImportJobSnapshot,
  type BrowserImportJobStage,
  type BrowserProfileImportBackend,
} from '../../contracts/browser-import-jobs';

interface JobRecord {
  jobId: string;
  ownerId: string;
  sourceId: string;
  profileId: string;
  request: BrowserImportRequest;
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

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
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
  private readonly discoveryControllers = new Map<string, Set<AbortController>>();

  constructor(private readonly options: BrowserImportJobOptions) {
    if (!options || typeof options.configRoot !== 'string' || !options.configRoot) {
      throw new BrowserImportJobError('invalid_config', 'A browser import config root is required.');
    }
    if (typeof options.importer !== 'function') {
      throw new BrowserImportJobError('invalid_config', 'A browser import backend importer is required.');
    }
    if (typeof options.emit !== 'function') {
      throw new BrowserImportJobError('invalid_config', 'A browser import emit callback is required.');
    }
    this.terminalLimit = Math.max(1, Math.min(100, Math.floor(options.terminalLimit ?? 10)));
  }

  /** Explicit UI-driven discovery. This is the only read-only discovery entry. */
  discover(ownerId: string, signal?: AbortSignal): Promise<BrowserImportDiscovery> {
    this.assertOwner(ownerId);
    const controller = new AbortController();
    const set = this.discoveryControllers.get(ownerId) ?? new Set();
    set.add(controller);
    this.discoveryControllers.set(ownerId, set);

    let externalListener: (() => void) | undefined;
    if (signal) {
      externalListener = () => controller.abort();
      if (signal.aborted) {
        externalListener();
      } else {
        signal.addEventListener('abort', externalListener, { once: true });
      }
    }

    const cleanup = (): void => {
      if (externalListener && signal) signal.removeEventListener('abort', externalListener);
      set.delete(controller);
      if (set.size === 0) this.discoveryControllers.delete(ownerId);
    };

    return (async (): Promise<BrowserImportDiscovery> => {
      try {
        const backend = await waitForAbort(this.options.importer(controller.signal), controller.signal);
        if (controller.signal.aborted) {
          throw new BrowserImportJobError('cancelled', 'The browser import was cancelled.');
        }
        const result = await backend.discover(controller.signal);
        return this.validateDiscoveryResult(result);
      } finally {
        cleanup();
      }
    })();
  }

  /**
   * Start one import. ownerId must come from the host's authenticated IPC
   * context, never from the renderer request payload.
   */
  start(ownerId: string, request: BrowserImportRequest): BrowserImportJobHandle {
    this.assertOwner(ownerId);
    const copiedRequest = copyRequest(request);
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
      const controllers = this.discoveryControllers.get(ownerId);
      if (controllers) {
        for (const controller of controllers) controller.abort();
        this.discoveryControllers.delete(ownerId);
      }
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

  /** Drain active imports before the shared Profile is closed. */
  disposeAll(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    const owners = new Set([...this.jobs.values()].map(job => job.ownerId));
    for (const owner of this.discoveryControllers.keys()) owners.add(owner);
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
    try {
      if (job.controller.signal.aborted) throw new BrowserImportJobError('cancelled', 'The browser import was cancelled.');
      this.setStage(job, 'preparing');
      const backend = await waitForAbort(
        this.options.importer(job.controller.signal),
        job.controller.signal,
      );
      if (job.controller.signal.aborted) throw new BrowserImportJobError('cancelled', 'The browser import was cancelled.');
      if (typeof backend.discover !== 'function' || typeof backend.importProfile !== 'function') {
        throw new BrowserImportJobError('invalid_backend', 'The browser import backend is missing required methods.');
      }

      this.setStage(job, 'importing');
      const rawResult = await backend.importProfile(job.jobId, job.request, job.controller.signal);
      result = this.validateImportResult(job.request, rawResult);
      this.setStage(job, 'closing');
    } catch (error) {
      if (job.controller.signal.aborted || errorCode(error, '') === 'cancelled') {
        result = failureResult(job.request, 'cancelled', 'The browser import was cancelled.', emptyCounts(), true);
      } else {
        const code = errorCode(error, 'import_failed');
        const message = error instanceof BrowserImportJobError
          ? error.message
          : 'The browser import did not complete.';
        result = failureResult(job.request, code, message);
      }
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

  private validateImportResult(
    request: BrowserImportRequest,
    raw: unknown,
  ): BrowserImportResult {
    if (!raw || typeof raw !== 'object') {
      throw new BrowserImportJobError('invalid_result', 'The backend returned an invalid import result.');
    }
    const result = raw as Record<string, unknown>;
    if (typeof result.ok !== 'boolean' || typeof result.cancelled !== 'boolean') {
      throw new BrowserImportJobError('invalid_result', 'The backend result is missing completion flags.');
    }
    if (result.sourceId !== request.sourceId || result.profileId !== request.profileId) {
      throw new BrowserImportJobError('invalid_result', 'The backend result identity does not match the request.');
    }
    if (!result.counts || typeof result.counts !== 'object') {
      throw new BrowserImportJobError('invalid_result', 'The backend result is missing counts.');
    }
    const rawCounts = result.counts as Record<string, unknown>;
    const counts = emptyCounts();
    for (const category of BROWSER_IMPORT_CATEGORIES) {
      if (!isSafeInteger(rawCounts[category])) {
        throw new BrowserImportJobError('invalid_result', `The backend returned an invalid ${category} count.`);
      }
      counts[category] = rawCounts[category];
    }
    const selection = requestSelection(request);
    for (const category of BROWSER_IMPORT_CATEGORIES) {
      if (!selection[category] && counts[category] !== 0) {
        throw new BrowserImportJobError('invalid_result', `The backend reported ${category} writes that were not requested.`);
      }
    }
    const rawErrors = Array.isArray(result.errors) ? result.errors : [];
    const errors: BrowserImportIssue[] = [];
    for (const entry of rawErrors) {
      if (!entry || typeof entry !== 'object') {
        throw new BrowserImportJobError('invalid_result', 'The backend result contains an invalid error entry.');
      }
      const issue = entry as Record<string, unknown>;
      if (!BROWSER_IMPORT_CATEGORIES.includes(issue.category as never) && issue.category !== 'profile' && issue.category !== 'discovery') {
        throw new BrowserImportJobError('invalid_result', 'The backend result contains an invalid error category.');
      }
      if (typeof issue.code !== 'string' || !issue.code) {
        throw new BrowserImportJobError('invalid_result', 'The backend result contains an invalid error code.');
      }
      if (typeof issue.message !== 'string') {
        throw new BrowserImportJobError('invalid_result', 'The backend result contains an invalid error message.');
      }
      errors.push({
        category: issue.category as BrowserImportIssue['category'],
        code: issue.code,
        message: issue.message,
        ...(isSafeInteger(issue.count) ? { count: issue.count } : {}),
      });
    }
    return {
      ok: result.ok,
      cancelled: result.cancelled,
      sourceId: request.sourceId,
      profileId: request.profileId,
      counts,
      errors,
    };
  }

  private validateDiscoveryResult(raw: unknown): BrowserImportDiscovery {
    if (!raw || typeof raw !== 'object') {
      throw new BrowserImportJobError('invalid_discovery', 'The backend returned an invalid discovery result.');
    }
    const result = raw as Record<string, unknown>;
    if (!Array.isArray(result.profiles) || !Array.isArray(result.errors)) {
      throw new BrowserImportJobError('invalid_discovery', 'The backend discovery result is missing required arrays.');
    }
    const profiles = result.profiles.map((entry): BrowserImportDiscovery['profiles'][number] => {
      if (!entry || typeof entry !== 'object') {
        throw new BrowserImportJobError('invalid_discovery', 'The backend discovery result contains an invalid profile entry.');
      }
      const profile = entry as Record<string, unknown>;
      const sourceId = typeof profile.sourceId === 'string' ? profile.sourceId : '';
      const sourceLabel = typeof profile.sourceLabel === 'string' ? profile.sourceLabel : '';
      const profileId = typeof profile.profileId === 'string' ? profile.profileId : '';
      const displayName = typeof profile.displayName === 'string' ? profile.displayName : '';
      return {
        sourceId,
        sourceLabel,
        profileId,
        displayName,
        lastUsed: profile.lastUsed === true,
        cookies: profile.cookies === true,
        passwords: profile.passwords === true,
        history: profile.history === true,
        extensions: profile.extensions === true,
      };
    });
    const errors = result.errors.map((entry): BrowserImportDiscovery['errors'][number] => {
      if (!entry || typeof entry !== 'object') {
        throw new BrowserImportJobError('invalid_discovery', 'The backend discovery result contains an invalid error entry.');
      }
      const issue = entry as Record<string, unknown>;
      return {
        sourceId: issue.sourceId === null || typeof issue.sourceId === 'string' ? issue.sourceId : null,
        code: typeof issue.code === 'string' ? issue.code : 'invalid_discovery',
        message: typeof issue.message === 'string' ? issue.message : 'The backend discovery result contains an invalid error entry.',
      };
    });
    return { profiles, errors };
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
