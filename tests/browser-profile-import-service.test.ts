import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserDiscoveryResult,
  BrowserImportRequest,
  BrowserImportResult,
} from '../contracts/browser-import';
import {
  BrowserImportJobError,
  type BrowserImportJobOptions,
  type BrowserImportJobSnapshot,
  type BrowserProfileImportBackend,
} from '../contracts/browser-import-jobs';
import { BrowserProfileImportService } from '../main/browser/profile-import-service';
import { assert, assertEqual, Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-service-'));
let sequence = 0;

function configRoot(): string {
  return join(root, String(++sequence), 'config');
}

function completedResult(
  request: BrowserImportRequest,
  counts: Partial<BrowserImportResult['counts']> = {},
): BrowserImportResult {
  return {
    ok: true,
    cancelled: false,
    sourceId: request.sourceId,
    profileId: request.profileId,
    counts: { cookies: 0, passwords: 0, history: 0, extensions: 0, ...counts },
    errors: [],
  };
}

function historyRequest(): BrowserImportRequest {
  return {
    sourceId: 'chrome',
    profileId: 'Default',
    categories: { cookies: false, passwords: false, history: true, extensions: false },
  };
}

async function rejectsWithJobCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(error instanceof BrowserImportJobError, `expected BrowserImportJobError, got ${String(error)}`);
    assertEqual(error.code, code, 'job error code');
    return;
  }
  throw new Error(`expected ${code}, but the operation resolved`);
}

interface FakeBackendOptions {
  discoverResult?: BrowserDiscoveryResult;
  importResult?: BrowserImportResult | ((requestId: string, request: BrowserImportRequest, signal: AbortSignal) => BrowserImportResult | Promise<BrowserImportResult>);
  prepareDelay?: () => void;
}

interface FakeBackend {
  backend: BrowserProfileImportBackend;
  importer: BrowserImportJobOptions['importer'];
  calls: {
    importer: number;
    discover: number;
    importProfile: number;
    lastRequestId?: string;
    lastRequest?: BrowserImportRequest;
    lastSignal?: AbortSignal;
  };
  releasePrepare?: () => void;
}

function fakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const calls: FakeBackend['calls'] = { importer: 0, discover: 0, importProfile: 0 };
  let releasePrepare: (() => void) | undefined;
  const preparePromise = options.prepareDelay
    ? new Promise<void>(resolve => { releasePrepare = resolve; })
    : Promise.resolve();

  const backend: BrowserProfileImportBackend = {
    async discover(signal) {
      calls.discover += 1;
      if (signal.aborted) throw new Error('aborted');
      return options.discoverResult ?? { profiles: [], errors: [] };
    },
    async importProfile(requestId, request, signal) {
      calls.importProfile += 1;
      calls.lastRequestId = requestId;
      calls.lastRequest = request;
      calls.lastSignal = signal;
      if (signal.aborted) throw new Error('aborted');
      if (typeof options.importResult === 'function') {
        return options.importResult(requestId, request, signal);
      }
      return options.importResult ?? completedResult(request);
    },
  };

  const importer: BrowserImportJobOptions['importer'] = async signal => {
    calls.importer += 1;
    await waitForSignalSettled(preparePromise, signal);
    if (signal.aborted) throw new Error('aborted');
    return backend;
  };

  return { backend: { discover: backend.discover.bind(backend), importProfile: backend.importProfile.bind(backend) }, calls, importer, releasePrepare };
}

function waitForSignalSettled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => finish(() => resolve(undefined));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

function makeService(config: Partial<BrowserImportJobOptions> & { importer: BrowserImportJobOptions['importer'] }): BrowserProfileImportService {
  return new BrowserProfileImportService({
    configRoot: configRoot(),
    importer: config.importer,
    emit: config.emit ?? (() => undefined),
    terminalLimit: config.terminalLimit,
  });
}

h.test('history-only job completes via the backend and copies the request', async () => {
  const f = fakeBackend({
    importResult: (_requestId, request) => completedResult(request, { history: 1 }),
  });
  const snapshots: BrowserImportJobSnapshot[] = [];
  const service = makeService({ importer: f.importer, emit: (_ownerId, snapshot) => snapshots.push(snapshot) });

  const discovery = await service.discover('owner-a');
  assertEqual(discovery.profiles.length, 0, 'explicit discovery returns the backend result');
  assertEqual(f.calls.importer, 1, 'importer is initialized for discovery');
  assertEqual(f.calls.discover, 1, 'backend discover is called');

  const request = historyRequest();
  const handle = service.start('owner-a', request);
  assertEqual(handle.snapshot.stage, 'queued', 'start returns queued snapshot');
  assertEqual(handle.snapshot.revision, 0, 'start returns revision 0');

  // Mutate the caller's request after start; the service must have copied it.
  request.categories!.history = false;
  request.categories!.cookies = true;

  const final = await service.wait('owner-a', handle.jobId);
  assertEqual(final.stage, 'completed', 'history-only job completes');
  assertEqual(final.counts.history, 1, 'history count');
  assertEqual(f.calls.importProfile, 1, 'backend importProfile is called');
  assertEqual(f.calls.lastRequestId, handle.jobId, 'requestId is the job id');
  assertEqual(f.calls.lastRequest?.categories?.history, true, 'service passed copied request to backend');
  assertEqual(f.calls.lastRequest?.categories?.cookies, false, 'mutated request did not affect backend call');

  const stages = snapshots.filter(snapshot => snapshot.jobId === handle.jobId).map(snapshot => snapshot.stage);
  assert(stages.includes('preparing'), 'preparing stage emitted');
  assert(stages.includes('importing'), 'importing stage emitted');
  assert(stages.includes('closing'), 'closing stage emitted');
  assert(stages.at(-1) === 'completed', 'terminal stage emitted');
  const revisions = snapshots.filter(snapshot => snapshot.jobId === handle.jobId).map(snapshot => snapshot.revision);
  for (let index = 1; index < revisions.length; index += 1) {
    assert(revisions[index]! > revisions[index - 1]!, 'revision is monotonic');
  }
});

h.test('a backend missing required methods is rejected before data is imported', async () => {
  const service = makeService({
    importer: async () => ({
      discover: async () => ({ profiles: [], errors: [] }),
      importProfile: undefined as unknown as BrowserProfileImportBackend['importProfile'],
    }),
  });
  const handle = service.start('owner', historyRequest());
  const final = await service.wait('owner', handle.jobId);
  assertEqual(final.stage, 'failed', 'invalid backend is terminal');
  assertEqual(final.counts.history, 0, 'no counts are invented');
  assert(final.errors.some(error => error.code === 'invalid_backend'), 'structured backend error');
});

h.test('cross-owner state/cancel is rejected and profile busy is global', async () => {
  const f = fakeBackend({ prepareDelay: () => undefined });
  const service = makeService({ importer: f.importer });
  const request = historyRequest();
  const first = service.start('owner-a', request);
  await rejectsWithJobCode(async () => service.state('owner-b', first.jobId), 'forbidden');
  await rejectsWithJobCode(async () => service.cancel('owner-b', first.jobId), 'forbidden');
  await rejectsWithJobCode(async () => service.start('owner-b', request), 'profile_busy');

  service.cancel('owner-a', first.jobId);
  f.releasePrepare?.();
  const cancelled = await service.wait('owner-a', first.jobId);
  assertEqual(cancelled.stage, 'cancelled', 'target init ignores signal but job cancels promptly');

  const second = service.start('owner-b', request);
  f.releasePrepare?.();
  const completed = await service.wait('owner-b', second.jobId);
  assertEqual(completed.stage, 'completed', 'profile is free after cancellation');
});

h.test('disposeOwner cancels and awaits its job and stops emitting', async () => {
  const f = fakeBackend({ prepareDelay: () => undefined });
  let emits = 0;
  const service = makeService({ importer: f.importer, emit: () => { emits += 1; } });
  service.start('owner-dispose', historyRequest());
  const beforeDispose = emits;
  const started = Date.now();
  await service.disposeOwner('owner-dispose');
  const elapsed = Date.now() - started;
  assert(elapsed < 2_000, `dispose timed out: ${elapsed}ms`);
  await new Promise(resolve => setTimeout(resolve, 20));
  assertEqual(emits, beforeDispose, 'no snapshot is emitted after owner disposal');
  await rejectsWithJobCode(async () => service.start('owner-dispose', historyRequest()), 'owner_destroyed');
  await rejectsWithJobCode(async () => service.discover('owner-dispose'), 'owner_destroyed');
});

h.test('cancel during import waits for backend acknowledgement and keeps confirmed counts', async () => {
  let importStartedResolve!: () => void;
  const importStarted = new Promise<void>(resolve => { importStartedResolve = resolve; });
  const f = fakeBackend({
    importResult: async (_requestId, _request, signal) => {
      importStartedResolve();
      await new Promise<void>(resolve => {
        const check = () => {
          if (signal.aborted) resolve();
          else setTimeout(check, 5);
        };
        check();
      });
      return {
        ok: false,
        cancelled: true,
        sourceId: 'chrome',
        profileId: 'Default',
        counts: { cookies: 1, passwords: 0, history: 0, extensions: 0 },
        errors: [{ category: 'profile', code: 'cancelled', message: 'Cancelled by user.' }],
      };
    },
  });
  const service = makeService({ importer: f.importer });
  const handle = service.start('owner-cancel', {
    sourceId: 'chrome',
    profileId: 'Default',
    categories: { cookies: true, passwords: false, history: false, extensions: false },
  });
  await importStarted;
  assertEqual(service.state('owner-cancel', handle.jobId).stage, 'importing', 'import is in progress before cancel');
  service.cancel('owner-cancel', handle.jobId);
  const final = await service.wait('owner-cancel', handle.jobId);
  assertEqual(final.stage, 'cancelled', 'job cancelled after backend acknowledged');
  assertEqual(final.counts.cookies, 1, 'confirmed cookie count is retained');
});

h.test('disposeOwner during discovery cancels the discovery controller', async () => {
  const f = fakeBackend({
    discoverResult: { profiles: [], errors: [] },
    prepareDelay: () => undefined,
  });
  const service = makeService({ importer: f.importer });
  let caught: unknown;
  service.discover('owner-discover').then(
    () => undefined,
    error => { caught = error; },
  );
  await service.disposeOwner('owner-discover');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(caught instanceof BrowserImportJobError, 'discovery rejects after owner disposal');
  assertEqual((caught as BrowserImportJobError).code, 'cancelled', 'discovery rejects with cancelled');
});

h.test('global active job rejects a different source and profile', async () => {
  const f = fakeBackend({ prepareDelay: () => undefined });
  const service = makeService({ importer: f.importer });
  const first = service.start('owner-a', historyRequest());
  const otherRequest: BrowserImportRequest = {
    sourceId: 'edge',
    profileId: 'Profile 1',
    categories: { cookies: false, passwords: false, history: true, extensions: false },
  };
  await rejectsWithJobCode(async () => service.start('owner-b', otherRequest), 'profile_busy');
  service.cancel('owner-a', first.jobId);
  f.releasePrepare?.();
  await service.wait('owner-a', first.jobId);
  const second = service.start('owner-b', otherRequest);
  f.releasePrepare?.();
  const final = await service.wait('owner-b', second.jobId);
  assertEqual(final.stage, 'completed', 'different source/profile is free after the global job ends');
});

h.test('disposing an owner with only a completed job does not release another owner lock', async () => {
  const service = makeService({ importer: fakeBackend({ importResult: (_requestId, request) => completedResult(request) }).importer });
  const completed = service.start('owner-a', historyRequest());
  assertEqual((await service.wait('owner-a', completed.jobId)).stage, 'completed', 'owner A completed');
  const active = service.start('owner-b', historyRequest());
  await service.disposeOwner('owner-a');
  await rejectsWithJobCode(async () => service.start('owner-c', historyRequest()), 'profile_busy');
  service.cancel('owner-b', active.jobId);
  await service.wait('owner-b', active.jobId);
});

h.test('request bounds and extension confirmation are rejected before backend initialization', async () => {
  let importerCalls = 0;
  const service = makeService({
    importer: async signal => {
      importerCalls += 1;
      return fakeBackend().backend;
    },
  });
  await rejectsWithJobCode(async () => service.start('owner', {
    sourceId: 'chrome',
    profileId: 'Default',
    categories: { extensions: true },
    allowUnverifiedExtensions: false,
  }), 'extensions_not_confirmed');
  await rejectsWithJobCode(async () => service.start('owner', {
    sourceId: 'chrome',
    profileId: 'Default',
    cookieHostnameAllowlist: Array.from({ length: 513 }, () => 'example.test'),
  }), 'invalid_request');
  await rejectsWithJobCode(async () => service.start('owner', {
    sourceId: 'chrome',
    profileId: 'Default',
    cookieHostnameAllowlist: ['x'.repeat(254)],
  }), 'invalid_request');
  assertEqual(importerCalls, 0, 'importer is not initialized for rejected requests');
});

h.test('invalid backend result identity is rejected and does not report success', async () => {
  const f = fakeBackend({ importResult: completedResult({ sourceId: 'edge', profileId: 'Default', categories: { cookies: false, passwords: false, history: true, extensions: false } }) });
  const service = makeService({ importer: f.importer });
  const handle = service.start('owner', historyRequest());
  const final = await service.wait('owner', handle.jobId);
  assertEqual(final.stage, 'failed', 'invalid result identity is terminal');
  assertEqual(final.counts.history, 0, 'invented counts are discarded');
  assert(final.errors.some(error => error.code === 'invalid_result'), 'structured invalid result error');
});

h.test('invalid backend counts are rejected and do not report success', async () => {
  const f = fakeBackend({
    importResult: (_requestId, request) => ({
      ...completedResult(request, { history: -1 }),
      counts: { cookies: 0, passwords: 0, history: -1, extensions: 0 },
    }),
  });
  const service = makeService({ importer: f.importer });
  const handle = service.start('owner', historyRequest());
  const final = await service.wait('owner', handle.jobId);
  assertEqual(final.stage, 'failed', 'negative count is terminal');
  assertEqual(final.counts.history, 0, 'invalid count is discarded');
  assert(final.errors.some(error => error.code === 'invalid_result'), 'structured invalid result error');
});

h.test('backend result counts for unrequested categories are rejected', async () => {
  const f = fakeBackend({
    importResult: (_requestId, request) => completedResult(request, { cookies: 5 }),
  });
  const service = makeService({ importer: f.importer });
  const handle = service.start('owner', historyRequest());
  const final = await service.wait('owner', handle.jobId);
  assertEqual(final.stage, 'failed', 'unrequested category count is terminal');
  assertEqual(final.counts.cookies, 0, 'unrequested count is discarded');
  assert(final.errors.some(error => error.code === 'invalid_result'), 'structured invalid result error');
});

h.test('backend failure before mutation is surfaced without invented counts', async () => {
  const f = fakeBackend({
    importResult: async () => {
      const error = new Error('profile database locked');
      (error as { code?: string }).code = 'database_locked';
      throw error;
    },
  });
  const service = makeService({ importer: f.importer });
  const handle = service.start('owner', historyRequest());
  const final = await service.wait('owner', handle.jobId);
  assertEqual(final.stage, 'failed', 'backend failure is terminal');
  assertEqual(final.counts.history, 0, 'no counts are invented on failure');
  assert(final.errors.some(error => error.code === 'database_locked'), 'backend error code is preserved');
});

h.test('backend result ok=true but cancelled=true is normalized to cancelled', async () => {
  const f = fakeBackend({
    importResult: (_requestId, request) => ({
      ...completedResult(request, { history: 2 }),
      cancelled: true,
    }),
  });
  const service = makeService({ importer: f.importer });
  const handle = service.start('owner', historyRequest());
  const final = await service.wait('owner', handle.jobId);
  assertEqual(final.stage, 'cancelled', 'contradictory result is cancelled');
  assertEqual(final.counts.history, 2, 'confirmed count is retained');
});

h.test('terminal snapshots are bounded per owner', async () => {
  const f = fakeBackend({ importResult: (_requestId, request) => completedResult(request, { history: 1 }) });
  const service = makeService({ importer: f.importer, terminalLimit: 3 });
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const handle = service.start('owner-terminal', historyRequest());
    ids.push(handle.jobId);
    const final = await service.wait('owner-terminal', handle.jobId);
    assertEqual(final.stage, 'completed', 'history job completes');
  }
  for (const id of ids.slice(0, 2)) {
    await rejectsWithJobCode(async () => service.state('owner-terminal', id), 'unknown_job');
  }
  for (const id of ids.slice(-3)) {
    assertEqual(service.state('owner-terminal', id).stage, 'completed', 'recent terminal retained');
  }
});

void h.finish(join(__dirname, 'browser-profile-import-service-result.json'), 'browser-profile-import-service').then(code => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
