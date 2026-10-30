import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { App, AutoUpdater } from 'electron';
import { PlatformUpdateInstaller } from '../main/updater/platform';
import { parseReleaseEnvelope } from '../main/updater/policy';
import { Harness } from './harness';
import { updateFixture } from './updater-fixture';

const h = new Harness();
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** OS signature and installer boundaries are simulated; the private HTTP handoff is real. */
async function fixture(platform: 'darwin' | 'win32', faults: { signature?: boolean; preparation?: boolean; launch?: boolean; quit?: boolean; staging?: boolean } = {}) {
  const signed = updateFixture(), release = signed.release();
  release.platform = platform;
  if (platform === 'win32') { release.artifact.kind = 'nsis'; release.artifact.url = release.artifact.url.replace(/\.zip$/, '.exe'); }
  const proof = parseReleaseEnvelope(signed.envelope(release), { ...signed.policy, platform });
  const directory = await mkdtemp(join(tmpdir(), 'klaus-updater-handoff-'));
  const file = join(directory, platform === 'darwin' ? 'update.zip' : 'update.exe');
  await writeFile(file, signed.artifact);
  const order: string[] = [], failures: Array<{ message: string; staged: boolean }> = [];
  const entered = deferred(), allowClose = deferred();
  let feed = '', argumentsUsed: readonly string[] = [], spawnOptions: SpawnOptions | undefined;
  const executable = platform === 'darwin' ? join(directory, 'Klaus.app/Contents/MacOS/Klaus') : join(directory, 'Klaus Update Target/Klaus.exe');
  const native = Object.assign(new EventEmitter(), {
    setFeedURL: (options: { url: string }) => { feed = options.url; order.push('feed'); },
    checkForUpdates: () => { order.push('stage'); queueMicrotask(() => native.emit(faults.staging ? 'error' : 'update-downloaded', faults.staging ? new Error('staging refused') : undefined)); },
    quitAndInstall: () => { order.push('quit-and-install'); if (faults.quit) throw new Error('native handoff refused'); },
  }) as unknown as AutoUpdater;
  const app = Object.assign(new EventEmitter(), { quit: () => { order.push('quit'); } }) as unknown as Pick<App, 'quit' | 'once'>;
  const installer = new PlatformUpdateInstaller({
    identity: { platform, executable, teamId: '5TMKAXN7M6', publisher: 'CN=Fixture' }, app, autoUpdater: native, timeoutMs: 5_000,
    log: message => order.push(`log:${message}`),
    prepareToQuit: async () => { order.push('prepare'); entered.resolve(); await allowClose.promise; if (faults.preparation) throw new Error('delivery did not drain'); order.push('drained'); },
    installationFailedAfterPrepare: (error, staged) => failures.push({ message: String(error), staged }),
  }, {
    verifySignature: async path => { order.push(path === file ? 'verify-artifact' : 'verify-installed'); if (faults.signature) throw new Error('signature refused'); },
    spawnInstaller: ((_file: string, args: readonly string[], options: SpawnOptions) => {
      order.push('spawn'); argumentsUsed = args; spawnOptions = options;
      const child = Object.assign(new EventEmitter(), { unref: () => { order.push('unref'); } }) as unknown as ChildProcess;
      queueMicrotask(() => child.emit(faults.launch ? 'error' : 'spawn', faults.launch ? new Error('installer refused') : undefined));
      return child;
    }) as typeof spawn,
  });
  return { installer, update: { proof, file }, order, failures, entered, allowClose, executable, get feed() { return feed; }, get argumentsUsed() { return argumentsUsed; }, get spawnOptions() { return spawnOptions; }, close: async () => { allowClose.resolve(); await installer.dispose(); (app as unknown as EventEmitter).emit('quit'); await rm(directory, { recursive: true, force: true }); } };
}

void (async () => {
  await h.test('Mac stages a verified update but keeps the renderer alive until its owner has drained', async () => {
    const f = await fixture('darwin');
    try {
      const install = f.installer.install(f.update, new AbortController().signal);
      await f.entered.promise;
      deepEqual(f.order, ['verify-installed', 'feed', 'stage', 'prepare']);
      equal((await fetch(f.feed)).status, 200);
      f.allowClose.resolve(); await install; await turn();
      deepEqual(f.order, ['verify-installed', 'feed', 'stage', 'prepare', 'drained', 'quit-and-install']);
      deepEqual(f.failures, []); await rejects(fetch(f.feed));
    } finally { await f.close(); }
  });
  await h.test('Windows verifies both signatures before draining and only then launches into the current install directory', async () => {
    const f = await fixture('win32');
    try {
      const install = f.installer.install(f.update, new AbortController().signal);
      await f.entered.promise;
      deepEqual(f.order, ['verify-installed', 'verify-artifact', 'prepare']);
      f.allowClose.resolve(); await install; await turn();
      deepEqual(f.order, ['verify-installed', 'verify-artifact', 'prepare', 'drained', 'spawn', 'unref', 'quit']);
      deepEqual(f.argumentsUsed, ['--updated', '--force-run', `/D=${dirname(f.executable)}`]);
      ok(dirname(f.executable).includes(' '), 'the actual installation target contains spaces');
      deepEqual(f.spawnOptions, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
      deepEqual(f.failures, []);
    } finally { await f.close(); }
  });
  for (const platform of ['darwin', 'win32'] as const) {
    await h.test(`${platform} reports incomplete preparation without handing off or claiming a staged Mac update was cancelled`, async () => {
      const f = await fixture(platform, { preparation: true });
      try {
        f.allowClose.resolve(); await rejects(f.installer.install(f.update, new AbortController().signal), /delivery did not drain/);
        equal(f.failures.length, 1); equal(f.failures[0]!.staged, platform === 'darwin');
        ok(!f.order.some(step => ['spawn', 'quit', 'quit-and-install'].includes(step)));
      } finally { await f.close(); }
    });
    await h.test(`${platform} cancellation while draining never starts the installer`, async () => {
      const f = await fixture(platform), signal = new AbortController();
      try {
        const install = f.installer.install(f.update, signal.signal);
        await f.entered.promise; signal.abort(new Error('owner closed')); f.allowClose.resolve();
        await rejects(install, /owner closed/); equal(f.failures.length, 1);
        equal(f.failures[0]!.staged, platform === 'darwin');
        ok(!f.order.some(step => ['spawn', 'quit', 'quit-and-install'].includes(step)));
      } finally { await f.close(); }
    });
  }
  await h.test('a signature rejection keeps normal application work running and never prepares shutdown', async () => {
    const f = await fixture('darwin', { signature: true });
    try { await rejects(f.installer.install(f.update, new AbortController().signal), /signature refused/); deepEqual(f.order, ['verify-installed', 'log:Update installation failed: signature refused']); deepEqual(f.failures, []); }
    finally { await f.close(); }
  });
  await h.test('a native staging failure closes the loopback feed without draining the application', async () => {
    const f = await fixture('darwin', { staging: true });
    try {
      await rejects(f.installer.install(f.update, new AbortController().signal), /staging refused/);
      ok(!f.order.includes('prepare')); deepEqual(f.failures, []); await rejects(fetch(f.feed));
    } finally { await f.close(); }
  });
  await h.test('a native quit failure after successful preparation is reported instead of becoming an uncaught exception', async () => {
    const f = await fixture('darwin', { quit: true });
    try {
      f.allowClose.resolve(); await f.installer.install(f.update, new AbortController().signal); await turn();
      equal(f.failures.length, 1); equal(f.failures[0]!.staged, true); ok(f.failures[0]!.message.includes('native handoff refused'));
    } finally { await f.close(); }
  });
  await h.test('Windows launch failure after preparation reports an unstaged installation failure', async () => {
    const f = await fixture('win32', { launch: true });
    try {
      f.allowClose.resolve(); await rejects(f.installer.install(f.update, new AbortController().signal), /installer refused/);
      equal(f.failures.length, 1); equal(f.failures[0]!.staged, false); ok(!f.order.includes('quit'));
    } finally { await f.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'updater-handoff.result.json'), 'updater-handoff');
})();
