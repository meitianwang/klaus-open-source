import { join } from 'node:path';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { requireTarget } from './resources.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition } from './desktop-edition.mjs';

// Stable registry identities for the first Electron release and its isolated
// installation fixture. Do not derive them from the former shell's app ID.
export const ELECTRON_NSIS_GUID = desktopEdition().nsisGuid;
export const FIXTURE_NSIS_GUID = '4e231d8b-b35c-4db7-9dc0-f101045e5798';

/** Keep Finder content aligned with electron-builder's pinned 540x380 DMG background. */
export function macDmgConfiguration({ version, arch, edition: id = DEFAULT_DESKTOP_EDITION }) {
  const edition = desktopEdition(id);
  requireTarget('darwin', arch);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('DMG versions must be explicit');
  return {
    artifactName: `${edition.artifactPrefix}-${version}-darwin-${arch}.dmg`,
    title: edition.productName,
    sign: false,
    format: 'UDZO',
    iconSize: 96,
    iconTextSize: 12,
    contents: [
      { x: 130, y: 220, type: 'file' },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  };
}

/** Platform formats shared by local installer candidates and the later signed release gate. */
export function installerConfiguration({ platform, arch, version, electronVersion, output, assets, fixture = false, edition: id = DEFAULT_DESKTOP_EDITION, installerInclude }) {
  const edition = desktopEdition(id);
  requireTarget(platform, arch);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !/^\d+\.\d+\.\d+$/.test(electronVersion)) throw new Error('Installer versions must be explicit');
  // The shared script's defaults describe the legacy identity; every other edition injects its own.
  if (platform === 'win32' && !edition.legacyIdentity && !installerInclude) throw new Error('Windows installers for this edition require an edition-scoped include');
  return {
    appId: fixture ? 'ai.klaus.desktop.installer-fixture' : edition.application,
    productName: fixture ? 'Klaus Installer Fixture' : edition.productName,
    executableName: fixture ? 'KlausInstallerFixture' : edition.executableName,
    directories: { output, buildResources: assets },
    electronVersion,
    extraMetadata: { version, klausDesktopEdition: edition.id, klausDesktopLayoutVersion: 1 },
    npmRebuild: false,
    toolsets: { nsis: '1.2.1' },
    publish: null,
    protocols: fixture ? [] : [{ name: edition.productName, schemes: [edition.protocol] }],
    mac: { target: [{ target: 'zip', arch: [arch] }], artifactName: `${edition.artifactPrefix}-${version}-darwin-${arch}.zip`, icon: join(assets, 'icon.icns'), notarize: false },
    win: { target: [{ target: 'nsis', arch: [arch] }], artifactName: `${edition.artifactPrefix}-${version}-win32-${arch}-setup.exe`, icon: join(assets, 'icon.ico'), requestedExecutionLevel: 'asInvoker', verifyUpdateCodeSignature: true },
    nsis: {
      guid: fixture ? FIXTURE_NSIS_GUID : edition.nsisGuid,
      oneClick: true, perMachine: false, allowElevation: false, packElevateHelper: false,
      deleteAppDataOnUninstall: false, createDesktopShortcut: false, createStartMenuShortcut: true,
      differentialPackage: false, runAfterFinish: true,
      // Parks the Chrome native host launcher while files are replaced; see
      // the header comment in the script for the respawn race it closes.
      include: installerInclude ?? join(assets, 'installer.nsh'),
    },
  };
}

/** Inject only the edition-specific default; preserve launcher parking behavior. */
export function prepareInstallerInclude({ directory, assets, edition: id = DEFAULT_DESKTOP_EDITION }) {
  const edition = desktopEdition(id);
  if (!/^\.[a-z0-9-]+$/.test(edition.configDirectory)) throw new Error('Invalid installer config directory');
  const file = join(directory, `${edition.artifactPrefix}-installer.nsh`);
  const template = readFileSync(join(assets, 'installer.nsh'), 'utf8');
  writeFileSync(file, `!define KLAUS_CONFIG_DIRECTORY "${edition.configDirectory}"\n!define KLAUS_DESKTOP_EDITION "${edition.id}"\n!define KLAUS_APPLICATION "${edition.application}"\n!define KLAUS_LEGACY_IDENTITY "${edition.legacyIdentity ? 1 : 0}"\n${template}`, { flag: 'wx' });
  return file;
}

export const NSIS_TOOLSET = { version: '1.2.1', file: 'nsis-bundle-3.12.tar.gz', sha256: '56997fdefe25e7928a1a68b4583d08b240b66cf660234053b20131a74cc082f4', url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis%401.2.1/nsis-bundle-3.12.tar.gz' };

/** Public offline toolset override, only after the pinned official archive checksum passes. */
export function prepareNsisBundle(archive, parent) {
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== NSIS_TOOLSET.sha256) throw new Error('NSIS archive differs from the pinned official toolset');
  const directory = mkdtempSync(join(parent, '.nsis-'));
  try {
    // Git Bash's GNU tar treats a drive-letter archive as a remote host. Use
    // the native Windows tool so both the archive and destination keep their
    // normal filesystem meaning, independent of the caller's PATH.
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xzf', archive, '-C', directory, '--strip-components=1'], { stdio: 'pipe' });
    if (!existsSync(join(directory, 'makensis.cmd')) || !existsSync(join(directory, 'windows/Plugins'))) throw new Error('NSIS archive does not contain the documented toolset layout');
    return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}
