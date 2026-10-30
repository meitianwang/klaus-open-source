import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppshotRuntime, appshotCaptureApplication } from '../main/app/appshot-runtime';
import { Harness, assert, assertEqual, waitFor } from './harness';
const h = new Harness();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-capture-unit-'));
  const callbacks: Array<() => void> = [], failures: string[] = [], settings: unknown[] = [];
  let stopped = 0, capture: ((signal: AbortSignal) => Promise<void>) | undefined;
  const runtime = new AppshotRuntime({ filename: join(root, 'settings.json'), platform: 'darwin', observe: (_shortcut, callback) => { callbacks.push(callback); return () => { stopped++; }; }, capture: async (value, signal) => { settings.push(value); await capture?.(signal); }, failed: value => failures.push(value), log: () => {} });
  await runtime.initialize();
  return { root, runtime, callbacks, failures, settings, stopped: () => stopped, capture: (value: (signal: AbortSignal) => Promise<void>) => { capture = value; }, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
async function rejected(task: () => unknown | Promise<unknown>) { let didReject = false; try { await task(); } catch { didReject = true; } assert(didReject, 'Invalid configuration must reject'); }
h.test('capture source identities remain pinned while focus changes during asynchronous work', async () => {
  const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/desktop-pet-appshot-vectors.json'), 'utf8')) as { targets: Array<{ ownedWindowFocused: boolean; companionFocused: boolean; previousApplication: string | null; externalApplication: string | null; expectedApplication: string | null; expectedError?: string; externalReads: number }> };
  for (const row of vector.targets) {
    const f = await fixture(); let ownedWindowFocused = row.ownedWindowFocused, companionFocused = row.companionFocused, external = row.externalApplication, reads = 0, release!: () => void;
    const requests: Array<string | undefined> = [], pending = new Promise<void>(resolve => { release = resolve; });
    const token = (value: string | null) => value === 'self' ? String(process.pid) : value ?? undefined;
    try {
      f.capture(async () => {
        const application = appshotCaptureApplication({ ownedWindowFocused, companionFocused, previousApplication: token(row.previousApplication), captureExternalApplication: () => { reads++; return token(external); } });
        await pending; requests.push(application);
      });
      f.callbacks[0]!(); ownedWindowFocused = !ownedWindowFocused; companionFocused = !companionFocused; external = '9009'; release();
      if (row.expectedError) {
        await waitFor(() => f.failures.length === 1, 1000, 'An unknown source rejects the pending capture');
        assertEqual(f.failures[0], row.expectedError, 'The failure explains how to choose a capture source');
        assertEqual(requests.length, 0, 'An unknown source cannot reach native capture with a later foreground');
      } else {
        await waitFor(() => requests.length === 1, 1000, 'The pending capture finishes after focus changes');
        assertEqual(requests[0], token(row.expectedApplication), 'The native capture receives the source fixed before asynchronous work');
      }
      assertEqual(reads, row.externalReads, 'Owned focus and saved companion targets never consult a later external foreground');
    } finally { release(); await f.close(); }
  }
});
h.test('capture defaults and concurrent preference changes persist without losing either change', async () => {
  const f = await fixture();
  try {
    assertEqual(f.runtime.snapshot().settings.shortcut, 'DoubleCommand', 'Platform default uses the native command chord');
    assert(f.runtime.snapshot().active, 'A successful native registration is active');
    await Promise.all([f.runtime.update({ alwaysSendToMini: true }), f.runtime.update({ soundEnabled: false })]);
    const saved = JSON.parse(await readFile(join(f.root, 'settings.json'), 'utf8'));
    assert(saved.alwaysSendToMini && saved.soundEnabled === false, 'Serialized writes preserve independent changes');
  } finally { await f.close(); }
});
h.test('callbacks queued by a replaced or stopped native monitor cannot start a capture', async () => {
  const f = await fixture();
  try {
    const first = f.callbacks[0]!;
    await f.runtime.update({ shortcut: 'Control+Shift+A' });
    first(); assertEqual(f.settings.length, 0, 'Stale native callbacks are generation fenced');
    f.callbacks.at(-1)!();
    await waitFor(() => f.settings.length === 1, 1000, 'Current registration captures');
    const current = f.callbacks.at(-1)!; await f.runtime.update({ shortcut: null });
    current(); assertEqual(f.settings.length, 1, 'Disabling capture revokes queued callbacks');
    await f.runtime.close(); first(); current(); assertEqual(f.settings.length, 1, 'Closed runtime cannot recapture');
  } finally { await f.close(); }
});
h.test('one capture owns the complete native and delivery transaction before another shortcut may start', async () => {
  const f = await fixture(); let finish!: () => void;
  try {
    f.capture(() => new Promise(resolve => { finish = resolve; }));
    f.callbacks[0]!(); f.callbacks[0]!();
    assertEqual(f.settings.length, 1, 'Repeated chord events cannot overlap a pending capture');
    finish(); await new Promise(resolve => setTimeout(resolve, 0));
    f.callbacks[0]!(); assertEqual(f.settings.length, 2, 'A finalized capture releases the next transaction'); finish();
  } finally { await f.close(); }
});
h.test('shutdown aborts pending work and suppresses late failure notices', async () => {
  const f = await fixture();
  try {
    f.capture(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })));
    f.callbacks[0]!(); await f.runtime.close();
    assert(f.stopped() > 0, 'Shutdown disposes the native monitor');
    assertEqual(f.failures.length, 0, 'Cancelled shutdown does not create a stale capture error');
  } finally { await f.close(); }
});
h.test('invalid preferences leave the existing native registration and saved configuration intact', async () => {
  const f = await fixture();
  try {
    await f.runtime.update({ destination: 'last-chat' }); const before = f.stopped();
    for (const value of [{ shortcut: '' }, { shortcut: 'bad\nkey' }, { destination: 'unknown' }, { soundEnabled: 1 }]) await rejected(() => f.runtime.update(value));
    assertEqual(f.runtime.snapshot().settings.destination, 'last-chat', 'Invalid updates preserve existing destination');
    assertEqual(f.stopped(), before, 'Invalid preferences cannot revoke a working native registration');
  } finally { await f.close(); }
});
void h.finish('result.json', 'desktop-pet-appshot').then(code => { process.exitCode = code; });
