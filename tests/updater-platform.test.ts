import { equal, ok, rejects } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { App, AutoUpdater } from 'electron';
import { createDesktopUpdater } from '../main/updater/runtime';
import { verifyPlatformSignature } from '../main/updater/platform';
import { Harness } from './harness';

const h = new Harness();
void (async () => {
  const executable = process.argv[2];
  if (!executable || !['darwin', 'win32'].includes(process.platform)) throw new Error('Supply an actual unsigned Electron candidate executable on macOS or Windows');
  const directory = await mkdtemp(join(tmpdir(), 'klaus-updater-platform-'));
  const native = new EventEmitter() as AutoUpdater;
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.0.0', getPath: () => resolve(executable), quit: () => { throw new Error('Fixture must not quit or install'); } }) as unknown as App;
  const log: string[] = [];
  const lifecycle = {
    prepareToQuit: async () => { throw new Error('An unsigned fixture must not prepare to install'); },
    installationFailedAfterPrepare: () => { throw new Error('An unsigned fixture must not reach installer handoff'); },
  };
  const config = { schemaVersion: 1, application: 'ai.klaus.desktop', framework: 'electron', version: '1.0.0', platform: process.platform, arch: process.arch, installer: process.platform === 'darwin' ? 'mac-zip' : 'nsis', channel: 'stable', feedUrl: 'https://updates.example.invalid/releases/electron/feed.json', teamId: '5TMKAXN7M6', publisher: 'CN=Klaus fixture publisher' };
  try {
    await h.test('an unsigned candidate with no release configuration has a real unavailable status', async () => {
      const service = await createDesktopUpdater({ ...lifecycle, app, autoUpdater: native, resourcesRoot: directory, configRoot: directory, emit: () => {}, log: message => log.push(message) });
      equal(service.snapshot().supported, false); equal(service.snapshot().state, 'idle');
      equal((await service.install()).ok, false); await service.dispose();
    });
    await h.test('an unsigned adjacent configuration cannot enable installation', async () => {
      await writeFile(join(directory, 'electron-update.json'), JSON.stringify(config));
      const service = await createDesktopUpdater({ ...lifecycle, app, autoUpdater: native, resourcesRoot: directory, configRoot: directory, emit: () => {}, log: message => log.push(message) });
      equal(service.snapshot().supported, false); equal(service.snapshot().state, 'error');
      ok(service.snapshot().error); equal((await service.install()).ok, false); await service.dispose();
      console.log(JSON.stringify({ platform: process.platform, rejection: service.snapshot().error }));
    });
    await h.test('OS verifier rejects a real unsigned candidate and a nonexistent signed artifact', async () => {
      const identity = { platform: process.platform as 'darwin' | 'win32', executable, teamId: config.teamId, publisher: config.publisher };
      await rejects(verifyPlatformSignature(process.platform === 'darwin' ? resolve(executable, '../../..') : executable, identity));
      await rejects(verifyPlatformSignature(join(directory, process.platform === 'darwin' ? 'missing.app' : 'missing.exe'), identity));
    });
    await h.test('old framework, mismatched versions and insecure feed configuration fail before any installer', async () => {
      for (const change of [{ framework: 'tauri' }, { version: '2.0.0' }, { feedUrl: 'http://example.com/releases/desktop' }]) {
        await writeFile(join(directory, 'electron-update.json'), JSON.stringify({ ...config, ...change }));
        const service = await createDesktopUpdater({ ...lifecycle, app, autoUpdater: native, resourcesRoot: directory, configRoot: directory, emit: () => {}, log: message => log.push(message) });
        equal(service.snapshot().supported, false); equal(service.snapshot().state, 'error'); await service.dispose();
      }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
  process.exitCode = await h.finish(join(__dirname, 'updater-platform.result.json'), 'updater-platform');
})();
