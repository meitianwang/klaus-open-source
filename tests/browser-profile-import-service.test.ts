import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserImportRequest,
  BrowserImportTarget,
  BrowserSecretContext,
} from '../contracts/browser-import';
import {
  BrowserImportJobError,
  type BrowserImportJobSnapshot,
  type ManagedDecryptor,
} from '../contracts/browser-import-jobs';
import { BrowserProfileImportService } from '../main/browser/profile-import-service';
import { assert, assertEqual, Harness } from './harness';
import {
  createCookies,
  createExtension,
  createHistory,
  createLogins,
  sourceRoot,
  writeLocalState,
} from './browser-profile-import-helpers';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-service-'));
let sequence = 0;

function fixture() {
  const base = join(root, String(++sequence));
  const userDataDir = join(base, 'user-data');
  const profileDir = join(userDataDir, 'Default');
  writeLocalState(userDataDir, { Default: { name: 'Synthetic Service' } });
  mkdirSync(profileDir, { recursive: true });
  return {
    base,
    userDataDir,
    profileDir,
    source: sourceRoot(userDataDir),
    configRoot: join(base, 'config'),
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

function managedDecryptor(
  onDecrypt: (input: Uint8Array, context: BrowserSecretContext) => Promise<string>,
  onClose: () => void,
): ManagedDecryptor {
  return {
    decrypt: onDecrypt,
    async close() {
      onClose();
    },
  };
}

h.test('history-only job is owner-scoped, copies inputs and never creates a decryptor', async () => {
  const f = fixture();
  createHistory(f.profileDir, [
    { url: 'https://example.test/history', title: 'Synthetic History', visitedAt: 1_700_000_000_000 },
  ]);
  const roots = [f.source];
  const snapshots: BrowserImportJobSnapshot[] = [];
  let decryptorCreates = 0;
  let decryptorCloses = 0;
  let appliedHistory = 0;
  const service = new BrowserProfileImportService({
    roots,
    configRoot: f.configRoot,
    target: async () => ({
      async applyHistory(entries) {
        appliedHistory = entries.length;
      },
    }),
    createDecryptor: () => {
      decryptorCreates += 1;
      return managedDecryptor(async () => 'unexpected', () => { decryptorCloses += 1; });
    },
    emit: (_ownerId: string, snapshot: BrowserImportJobSnapshot) => snapshots.push(snapshot),
  });

  const discovery = await service.discover('owner-a');
  assertEqual(discovery.profiles[0]?.profileId, 'Default', 'explicit discovery returns the profile');

  const request = historyRequest();
  const handle = service.start('owner-a', request);
  assertEqual(handle.snapshot.stage, 'queued', 'start returns queued snapshot');
  assertEqual(handle.snapshot.revision, 0, 'start returns revision 0');
  roots.length = 0;
  request.categories!.history = false;
  request.categories!.cookies = true;

  const final = await service.wait('owner-a', handle.jobId);
  assertEqual(final.stage, 'completed', 'history-only job completes');
  assertEqual(final.counts.history, 1, 'history count');
  assertEqual(appliedHistory, 1, 'target received history');
  assertEqual(decryptorCreates, 0, 'history-only import never creates a decryptor');
  assertEqual(decryptorCloses, 0, 'nothing to close');
  assert(!existsSync(join(f.configRoot, 'browser-import', 'jobs', handle.jobId)), 'job scratch removed');
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

h.test('a missing target capability is rejected before any data read or decryptor creation', async () => {
  const f = fixture();
  writeFileSync(join(f.profileDir, 'Cookies'), 'not a sqlite database');
  let decryptorCreates = 0;
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => ({
      async applyHistory() {},
    }),
    createDecryptor: () => {
      decryptorCreates += 1;
      return managedDecryptor(async () => 'unexpected', () => undefined);
    },
    emit: () => undefined,
  });
  const handle = service.start('owner', {
    sourceId: 'chrome',
    profileId: 'Default',
    categories: { cookies: true, passwords: false, history: false, extensions: false },
  });
  const final = await service.wait('owner', handle.jobId);
  assertEqual(final.stage, 'failed', 'capability failure is terminal');
  assertEqual(final.counts.cookies, 0, 'no counts are invented');
  assert(final.errors.some(error => error.code === 'target_capability_unavailable'), 'structured capability error');
  assert(!final.errors.some(error => error.code === 'snapshot_corrupted'), 'no cookie data was read');
  assertEqual(decryptorCreates, 0, 'decryptor was never created');
});

h.test('cross-owner state/cancel is rejected and profile busy is global', async () => {
  const f = fixture();
  createHistory(f.profileDir, [
    { url: 'https://example.test/history', title: 'Synthetic History', visitedAt: 1_700_000_000_000 },
  ]);
  let targetCalls = 0;
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => {
      targetCalls += 1;
      if (targetCalls === 1) return new Promise<BrowserImportTarget>(() => undefined);
      return { async applyHistory() {} };
    },
    createDecryptor: () => managedDecryptor(async () => 'unexpected', () => undefined),
    emit: () => undefined,
  });
  const request = historyRequest();
  const first = service.start('owner-a', request);
  await rejectsWithJobCode(async () => service.state('owner-b', first.jobId), 'forbidden');
  await rejectsWithJobCode(async () => service.cancel('owner-b', first.jobId), 'forbidden');
  await rejectsWithJobCode(async () => service.start('owner-b', request), 'profile_busy');

  service.cancel('owner-a', first.jobId);
  const cancelled = await service.wait('owner-a', first.jobId);
  assertEqual(cancelled.stage, 'cancelled', 'target init ignores signal but job cancels promptly');

  const second = service.start('owner-b', request);
  const completed = await service.wait('owner-b', second.jobId);
  assertEqual(completed.stage, 'completed', 'profile is free after cancellation');
});

h.test('disposeOwner cancels and awaits its job and stops emitting', async () => {
  const f = fixture();
  createHistory(f.profileDir, [
    { url: 'https://example.test/history', title: 'Synthetic History', visitedAt: 1_700_000_000_000 },
  ]);
  let emits = 0;
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => new Promise<BrowserImportTarget>(() => undefined),
    createDecryptor: () => managedDecryptor(async () => 'unexpected', () => undefined),
    emit: () => { emits += 1; },
  });
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

h.test('cancel closes the lazily created decryptor before the cancelled terminal', async () => {
  const f = fixture();
  createCookies(f.profileDir, [{
    host: 'example.test',
    name: 'cookie',
    encrypted: Buffer.from('v10-encrypted'),
  }]);
  createLogins(f.profileDir, []);
  let decryptorCreates = 0;
  let decryptorCloses = 0;
  let applyStarted!: () => void;
  const started = new Promise<void>(resolve => { applyStarted = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const snapshots: BrowserImportJobSnapshot[] = [];
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => ({
      async applyCookies() {
        applyStarted();
        await gate;
      },
    }),
    createDecryptor: () => {
      decryptorCreates += 1;
      return managedDecryptor(async () => 'cookie-secret', () => { decryptorCloses += 1; });
    },
    emit: (_ownerId: string, snapshot: BrowserImportJobSnapshot) => snapshots.push(snapshot),
  });
  const handle = service.start('owner-cancel', {
    sourceId: 'chrome',
    profileId: 'Default',
    categories: { cookies: true, passwords: false, history: false, extensions: false },
  });
  await started;
  service.cancel('owner-cancel', handle.jobId);
  release();
  const final = await service.wait('owner-cancel', handle.jobId);
  assertEqual(final.stage, 'cancelled', 'job cancelled after the target callback returned');
  assertEqual(final.counts.cookies, 1, 'successfully applied cookie count is retained');
  assertEqual(decryptorCreates, 1, 'decryptor was created lazily');
  assertEqual(decryptorCloses, 1, 'decryptor closed before terminal');
  assert(!JSON.stringify(final).includes('cookie-secret'), 'terminal snapshot contains no plaintext');
  assert(!snapshots.some(snapshot => JSON.stringify(snapshot).includes('cookie-secret')), 'progress contains no plaintext');
});


h.test('global active job rejects a different source and profile', async () => {
  const firstFixture = fixture();
  const secondFixture = fixture();
  createHistory(firstFixture.profileDir, [
    { url: 'https://example.test/a', visitedAt: 1_700_000_000_000 },
  ]);
  writeLocalState(secondFixture.userDataDir, {
    Default: { name: 'Second' },
    'Profile 1': { name: 'Second Work' },
  });
  const secondProfile = join(secondFixture.userDataDir, 'Profile 1');
  mkdirSync(secondProfile, { recursive: true });
  createHistory(secondProfile, [
    { url: 'https://example.test/b', visitedAt: 1_700_000_000_000 },
  ]);
  const edge = sourceRoot(secondFixture.userDataDir, 'edge');
  let targetCalls = 0;
  const service = new BrowserProfileImportService({
    roots: [firstFixture.source, edge],
    configRoot: firstFixture.configRoot,
    target: async () => {
      targetCalls += 1;
      if (targetCalls === 1) return new Promise<BrowserImportTarget>(() => undefined);
      return { async applyHistory() {} };
    },
    createDecryptor: () => managedDecryptor(async () => 'unexpected', () => undefined),
    emit: () => undefined,
  });
  const first = service.start('owner-a', historyRequest());
  const otherRequest: BrowserImportRequest = {
    sourceId: 'edge',
    profileId: 'Profile 1',
    categories: { cookies: false, passwords: false, history: true, extensions: false },
  };
  await rejectsWithJobCode(async () => service.start('owner-b', otherRequest), 'profile_busy');
  service.cancel('owner-a', first.jobId);
  await service.wait('owner-a', first.jobId);
  const second = service.start('owner-b', otherRequest);
  const final = await service.wait('owner-b', second.jobId);
  assertEqual(final.stage, 'completed', 'different source/profile is free after the global job ends');
});

h.test('disposing an owner with only a completed job does not release another owner lock', async () => {
  const f = fixture();
  createHistory(f.profileDir, [
    { url: 'https://example.test/a', visitedAt: 1_700_000_000_000 },
  ]);
  let targetCalls = 0;
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => {
      targetCalls += 1;
      if (targetCalls === 1) return { async applyHistory() {} };
      return new Promise<BrowserImportTarget>(() => undefined);
    },
    createDecryptor: () => managedDecryptor(async () => 'unexpected', () => undefined),
    emit: () => undefined,
  });
  const completed = service.start('owner-a', historyRequest());
  assertEqual((await service.wait('owner-a', completed.jobId)).stage, 'completed', 'owner A completed');
  const active = service.start('owner-b', historyRequest());
  await service.disposeOwner('owner-a');
  await rejectsWithJobCode(async () => service.start('owner-c', historyRequest()), 'profile_busy');
  service.cancel('owner-b', active.jobId);
  await service.wait('owner-b', active.jobId);
});

h.test('request bounds and extension confirmation are rejected before target initialization', async () => {
  const f = fixture();
  let targetCalls = 0;
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => {
      targetCalls += 1;
      return { async applyHistory() {} };
    },
    createDecryptor: () => managedDecryptor(async () => 'unexpected', () => undefined),
    emit: () => undefined,
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
  assertEqual(targetCalls, 0, 'target is not initialized for rejected requests');
});

h.test('cancellation during closing stays cancelling and preserves counts', async () => {
  const f = fixture();
  createCookies(f.profileDir, [{
    host: 'example.test',
    name: 'cookie',
    encrypted: Buffer.from('v10-encrypted'),
  }]);
  createLogins(f.profileDir, []);
  let applyStartedResolve!: () => void;
  const applyStarted = new Promise<void>(resolve => { applyStartedResolve = resolve; });
  let releaseApply!: () => void;
  const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
  let closeStartedResolve!: () => void;
  const closeStarted = new Promise<void>(resolve => { closeStartedResolve = resolve; });
  let releaseClose!: () => void;
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => ({
      async applyCookies() {
        applyStartedResolve();
        await applyGate;
      },
    }),
    createDecryptor: () => ({
      async decrypt() {
        return 'cookie-secret';
      },
      async close() {
        closeStartedResolve();
        await closeGate;
      },
    }),
    emit: () => undefined,
  });
  const handle = service.start('owner-cancel-closing', {
    sourceId: 'chrome',
    profileId: 'Default',
    categories: { cookies: true, passwords: false, history: false, extensions: false },
  });
  await applyStarted;
  service.cancel('owner-cancel-closing', handle.jobId);
  releaseApply();
  await closeStarted;
  assertEqual(service.state('owner-cancel-closing', handle.jobId).stage, 'cancelling', 'cancelling is not downgraded to closing');
  releaseClose();
  const final = await service.wait('owner-cancel-closing', handle.jobId);
  assertEqual(final.stage, 'cancelled', 'cancel wins during closing');
  assertEqual(final.counts.cookies, 1, 'successful apply count is retained');
});

h.test('job scratch is removed while installed extension copies remain', async () => {
  const f = fixture();
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  createExtension(f.profileDir, { id, version: '1.0.0' });
  let installedPath = '';
  let decryptorCreates = 0;
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => ({
      async installExtension(extension) {
        installedPath = extension.path;
        return { id: extension.id };
      },
    }),
    createDecryptor: () => {
      decryptorCreates += 1;
      return managedDecryptor(async () => 'unexpected', () => undefined);
    },
    emit: () => undefined,
  });
  const handle = service.start('owner-extension', {
    sourceId: 'chrome',
    profileId: 'Default',
    allowUnverifiedExtensions: true,
    categories: { cookies: false, passwords: false, history: false, extensions: true },
  });
  const final = await service.wait('owner-extension', handle.jobId);
  assertEqual(final.stage, 'completed', 'extension import completed');
  assertEqual(final.counts.extensions, 1, 'extension count');
  assert(installedPath && existsSync(installedPath), 'installed extension copy is retained');
  assert(!existsSync(join(f.configRoot, 'browser-import', 'jobs', handle.jobId)), 'job scratch is removed');
  assertEqual(decryptorCreates, 0, 'extension-only job does not create a decryptor');
});

h.test('terminal snapshots are bounded per owner', async () => {
  const f = fixture();
  createHistory(f.profileDir, [
    { url: 'https://example.test/history', title: 'Synthetic History', visitedAt: 1_700_000_000_000 },
  ]);
  const service = new BrowserProfileImportService({
    roots: [f.source],
    configRoot: f.configRoot,
    target: async () => ({ async applyHistory() {} }),
    createDecryptor: () => managedDecryptor(async () => 'unexpected', () => undefined),
    emit: () => undefined,
    terminalLimit: 3,
  });
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
