import assert from 'node:assert/strict';
import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ELECTRON_NSIS_GUID, FIXTURE_NSIS_GUID, installerConfiguration, macDmgConfiguration, prepareNsisBundle } from './installers.mjs';

const input = { version: '1.2.3', electronVersion: '44.2.0', output: '/fixture/out', assets: '/fixture/assets' };
test('macOS updates use a versioned architecture-specific Electron ZIP', () => {
  const config = installerConfiguration({ ...input, platform: 'darwin', arch: 'arm64' });
  equal(config.appId, 'ai.klaus.desktop');
  deepEqual(config.mac.target, [{ target: 'zip', arch: ['arm64'] }]);
  equal(config.mac.artifactName, 'Klaus-1.2.3-darwin-arm64.zip');
  equal(config.publish, null);
});
test('macOS DMG uses a compact native layout without versioned volume chrome or overflow', () => {
  const config = macDmgConfiguration({ version: '1.2.3', arch: 'arm64' });
  equal(config.artifactName, 'Klaus-1.2.3-darwin-arm64.dmg');
  equal(config.title, 'Klaus');
  equal(config.iconSize, 96); equal(config.iconTextSize, 12);
  deepEqual(config.contents, [
    { x: 130, y: 220, type: 'file' },
    { x: 410, y: 220, type: 'link', path: '/Applications' },
  ]);
  deepEqual(config.contents.map(({ x }) => [x - config.iconSize / 2, 540 - (x + config.iconSize / 2)]), [[82, 362], [362, 82]]);
  equal(Object.hasOwn(config, 'window'), false);
});
test('Windows uses full per-user NSIS and preserves business data on uninstall', () => {
  const config = installerConfiguration({ ...input, platform: 'win32', arch: 'x64' });
  deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  equal(config.nsis.perMachine, false); equal(config.nsis.allowElevation, false); equal(config.nsis.packElevateHelper, false);
  equal(config.nsis.deleteAppDataOnUninstall, false); equal(config.nsis.differentialPackage, false);
  equal(config.win.verifyUpdateCodeSignature, true);
  equal(config.nsis.guid, ELECTRON_NSIS_GUID);
});
test('the Windows installer parks the Chrome native host launcher before replacing files', () => {
  const config = installerConfiguration({ ...input, platform: 'win32', arch: 'x64' });
  equal(config.nsis.include, join(input.assets, 'installer.nsh'), 'the custom NSIS script path follows the build assets');
  const script = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'assets', 'installer.nsh'), 'utf8');
  for (const macro of ['customInit', 'customUnInit', 'customInstall', 'customUnInstall']) {
    assert(script.includes(`!macro ${macro}`), `${macro} hook is defined`);
  }
  // Parking must happen in both init hooks (installer before the stock kill
  // loop; uninstaller after the kill loop but before any file deletion) and
  // restore after the file replacement, or the extension respawn race is open.
  const parkCount = script.split('!insertmacro parkChromeNativeHostLauncher').length - 1;
  const restoreCount = script.split('!insertmacro restoreChromeNativeHostLauncher').length - 1;
  equal(parkCount, 2, 'park runs in customInit and customUnInit');
  equal(restoreCount, 2, 'restore runs in customInstall and customUnInstall');
  assert(script.indexOf('!insertmacro parkChromeNativeHostLauncher') < script.indexOf('!insertmacro restoreChromeNativeHostLauncher'), 'parking precedes restore');
  // The stock customCheckAppRunning escape hatch is deliberately unused: its
  // preamble is conditionally skipped when the macro exists and cannot be
  // reproduced by hand without makensis conflicts (see installer.nsh header).
  assert(!script.includes('!macro customCheckAppRunning'), 'customCheckAppRunning is not defined');
  assert(script.includes('StrCpy $R9 "$R8.updating"'), 'the parked name is built from the launcher path, never a second literal');
});
test('real-installation fixtures have a separate application identity and no Klaus deep link', () => {
  const config = installerConfiguration({ ...input, platform: 'win32', arch: 'x64', fixture: true });
  equal(config.appId, 'ai.klaus.desktop.installer-fixture'); equal(config.executableName, 'KlausInstallerFixture'); deepEqual(config.protocols, []);
  equal(config.nsis.guid, FIXTURE_NSIS_GUID); equal(config.nsis.guid === ELECTRON_NSIS_GUID, false);
});
test('unknown targets and ambiguous versions never produce an installer configuration', () => {
  throws(() => installerConfiguration({ ...input, platform: 'win32', arch: 'arm64' }));
  throws(() => installerConfiguration({ ...input, platform: 'darwin', arch: 'arm64', version: '../1.2.3' }));
});
test('an offline installer toolset cannot bypass the pinned official checksum', () => {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-nsis-checksum-'));
  try {
    const archive = join(directory, 'fake.tar.gz'); writeFileSync(archive, 'untrusted executable');
    throws(() => prepareNsisBundle(archive, directory), /pinned official toolset/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
