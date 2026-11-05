import { join } from 'node:path';
import type { BrowserDiscoveryResult, BrowserImportRequest, BrowserImportResult } from '../contracts/browser-import';
import { nativeSourceImportBackend, type NativeSourceImportHandle } from '../main/browser/native-source-import';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness();
const request: BrowserImportRequest = { sourceId: 'chrome', profileId: 'Default' };
const receipt = (cancelled = false): BrowserImportResult => ({
  ok: !cancelled, cancelled, ...request,
  counts: { cookies: 3, passwords: 1, history: 4, extensions: 0 }, errors: [],
});
const fixture = (overrides: Partial<NativeSourceImportHandle> = {}): NativeSourceImportHandle => ({
  listImportableProfiles: async () => ({ profiles: [], errors: [] }),
  importProfile: async () => receipt(), cancelProfileImport: () => {}, ...overrides,
});

h.test('discovery preserves native permission errors instead of reporting an empty successful result', async () => {
  const result: BrowserDiscoveryResult = { profiles: [], errors: [{ sourceId: 'chrome', code: 'source_permission_denied', message: 'Access denied.' }] };
  const backend = nativeSourceImportBackend(fixture({ listImportableProfiles: async () => result }));
  assertDeepEqual(await backend.discover(new AbortController().signal), result, 'native diagnostic preserved');
});

h.test('discovery creates unique bounded native operation ids', async () => {
  const ids: string[] = [];
  const backend = nativeSourceImportBackend(fixture({ listImportableProfiles: async id => { ids.push(id); return { profiles: [], errors: [] }; } }));
  await Promise.all([backend.discover(new AbortController().signal), backend.discover(new AbortController().signal)]);
  assertEqual(new Set(ids).size, 2, 'independent discovery ids');
  assert(ids.every(id => id.length > 0 && id.length <= 128), 'native request bounds');
});

h.test('an obsolete native runtime is explicitly unavailable without a source-side fallback', async () => {
  const handle = fixture();
  (handle as unknown as Record<string, unknown>).importProfile = undefined;
  await assertRejects(async () => nativeSourceImportBackend(handle), 'missing native importer');
});

h.test('an already cancelled operation does not start source discovery or import', async () => {
  let calls = 0;
  const backend = nativeSourceImportBackend(fixture({
    listImportableProfiles: async () => { calls++; return { profiles: [], errors: [] }; },
    importProfile: async () => { calls++; return receipt(); },
  }));
  const controller = new AbortController(); controller.abort();
  await assertRejects(() => backend.discover(controller.signal), 'cancelled discovery');
  await assertRejects(() => backend.importProfile('cancel-before-start', request, controller.signal), 'cancelled import');
  assertEqual(calls, 0, 'no source operations started');
});

h.test('import cancellation waits for the original receipt and preserves confirmed writes', async () => {
  const controller = new AbortController();
  let resolve!: (value: BrowserImportResult) => void;
  const cancelled: string[] = [];
  const backend = nativeSourceImportBackend(fixture({
    importProfile: async () => new Promise(done => { resolve = done; }),
    cancelProfileImport: id => cancelled.push(id),
  }));
  let settled = false;
  const pending = backend.importProfile('native-job', request, controller.signal).then(value => { settled = true; return value; });
  controller.abort(); await Promise.resolve();
  assertDeepEqual(cancelled, ['native-job'], 'native cancellation forwarded once');
  assertEqual(settled, false, 'waits for acknowledged cancellation');
  resolve(receipt(true));
  assertDeepEqual(await pending, receipt(true), 'confirmed native mutation counts retained');
});

h.test('an abort queued while native registration runs reaches the registered operation', async () => {
  const controller = new AbortController(); const ids: string[] = [];
  const backend = nativeSourceImportBackend(fixture({
    importProfile: async () => { controller.abort(); return receipt(true); },
    cancelProfileImport: id => ids.push(id),
  }));
  assertEqual((await backend.importProfile('registration-race', request, controller.signal)).cancelled, true, 'cancellation receipt');
  assert(ids.includes('registration-race'), 'registered native operation cancelled');
});

h.test('settled native operations detach their abort listener', async () => {
  const controller = new AbortController(); let cancellations = 0;
  const backend = nativeSourceImportBackend(fixture({ cancelProfileImport: () => { cancellations++; } }));
  await backend.importProfile('completed', request, controller.signal);
  controller.abort(); assertEqual(cancellations, 0, 'later abort cannot cancel a completed native operation');
});

h.test('native failures propagate without inventing an import receipt', async () => {
  const backend = nativeSourceImportBackend(fixture({ importProfile: async () => { throw new Error('Native target closed.'); } }));
  await assertRejects(() => backend.importProfile('closed', request, new AbortController().signal), 'native failure');
});

h.test('history indexing failures preserve native counts and become an explicit partial result', async () => {
  const ids: string[] = [];
  const backend = nativeSourceImportBackend(fixture(), id => { ids.push(id); return 'History indexing failed.'; });
  const result = await backend.importProfile('projection', request, new AbortController().signal);
  assertEqual(result.ok, false, 'indexing failure is visible');
  assertDeepEqual(result.counts, receipt().counts, 'native writes remain acknowledged');
  assertEqual(result.errors.at(-1)?.code, 'history_projection_failed', 'specific diagnostic');
  assertDeepEqual(ids, ['projection'], 'failure is scoped to its owning request');
});

void h.finish(join(__dirname, 'browser-profile-import-result.json'), 'browser-profile-import').then(code => { process.exitCode = code; });
