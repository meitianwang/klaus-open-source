import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App, AutoUpdater } from 'electron';
import { CUSTOM_PROFILE_UPDATE_MESSAGE, systemRelaunchPreservesProfile } from '../main/updater/relaunch-profile';
import { createDesktopUpdater } from '../main/updater/runtime';
import { Harness } from './harness';

const h = new Harness();
h.test('the system relaunch can reopen the same default data directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-update-profile-'));
  try {
    const profile = join(root, '.klaus'); mkdirSync(profile);
    assert.equal(systemRelaunchPreservesProfile(profile, profile), true);
    assert.equal(systemRelaunchPreservesProfile(join(profile, '.'), profile), true);
    assert.equal(systemRelaunchPreservesProfile(join(root, 'custom'), profile), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
h.test('a fresh default profile is accepted but a separate fresh profile is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-update-profile-'));
  try {
    const profile = join(root, '.klaus');
    assert.equal(systemRelaunchPreservesProfile(profile, profile), true);
    assert.equal(systemRelaunchPreservesProfile(join(root, 'custom'), profile), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
if (['darwin', 'win32'].includes(process.platform)) h.test('an alias is accepted only when it resolves to the actual default data directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-update-profile-'));
  try {
    const profile = join(root, 'actual'), alias = join(root, 'alias'), other = join(root, 'other');
    mkdirSync(profile); mkdirSync(other); symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(systemRelaunchPreservesProfile(alias, profile), true);
    assert.equal(systemRelaunchPreservesProfile(alias, other), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
if (['darwin', 'win32'].includes(process.platform)) h.test('the packaged updater refuses a displaced profile before constructing a system installer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-update-profile-'));
  const configRoot = join(root, 'custom data'), logs: string[] = [];
  const forbidden = () => { throw new Error('A displaced profile must not enter platform verification or installer lifecycle'); };
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '0.4.0', getPath: forbidden, quit: forbidden }) as unknown as App;
  const native = new EventEmitter() as AutoUpdater;
  let service: Awaited<ReturnType<typeof createDesktopUpdater>> | undefined;
  try {
    mkdirSync(configRoot);
    // Profile viability precedes policy verification. This marker never authorizes an update.
    writeFileSync(join(root, 'electron-update.json'), '{}');
    service = await createDesktopUpdater({ app, autoUpdater: native, resourcesRoot: root, configRoot,
      emit: forbidden, log: message => logs.push(message), prepareToQuit: async () => forbidden(), installationFailedAfterPrepare: forbidden });
    assert.deepEqual(service.snapshot(), { supported: false, state: 'error', currentVersion: '0.4.0', availableVersion: null, error: CUSTOM_PROFILE_UPDATE_MESSAGE });
    service.start();
    assert.deepEqual(await service.check(), service.snapshot());
    assert.deepEqual(await service.install(), { ok: false, error: CUSTOM_PROFILE_UPDATE_MESSAGE });
    assert.deepEqual(service.requestInstall(), { ok: false, error: CUSTOM_PROFILE_UPDATE_MESSAGE });
    assert.deepEqual(logs, [CUSTOM_PROFILE_UPDATE_MESSAGE]);
    assert.equal(native.listenerCount('error'), 0);
    assert.equal(app.listenerCount('quit'), 0);
    assert.equal(existsSync(join(configRoot, 'electron')), false);
  } finally { await service?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
void h.finish(join(__dirname, 'updater-profile-result.json'), 'updater-profile').then(code => { process.exitCode = code; });
