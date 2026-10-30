#!/usr/bin/env node
// Build reviewable Electron-format candidates. No signing, feed publication or installation.
import { build, Platform, Arch } from 'electron-builder';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installerConfiguration, prepareInstallerInclude, prepareNsisBundle } from '../packaging/installers.mjs';
import { candidateEdition, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';
import { verifyPackage } from '../packaging/verify.mjs';

const app = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { edition: { type: 'string' }, 'editions-file': { type: 'string' }, bundle: { type: 'string' }, out: { type: 'string' }, candidate: { type: 'boolean' }, 'nsis-archive': { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log('node scripts/package-installer.mjs --candidate --bundle <verified local app> --out <new output directory> [--edition <id>] [--editions-file <absolute path>] [--nsis-archive <official pinned tar.gz>]\nEdition defaults to the verified candidate identity; candidates without an edition are domestic. Additional editions come from --editions-file / KLAUS_DESKTOP_EDITIONS_FILE.'); process.exit(0); }
useDesktopEditionsFile(values['editions-file']);
if (!values.candidate || !values.bundle || !values.out) throw new Error('Only explicit --candidate builds are available here; supply --bundle and --out.');
for (const key of ['ELECTRON_BUILDER_NSIS_DIR', 'ELECTRON_BUILDER_NSIS_RESOURCES_DIR']) if (process.env[key]) throw new Error(`${key} bypasses archive verification; use --nsis-archive instead.`);
const source = verifyPackage(resolve(values.bundle)), [platform, arch] = source.target.split('-');
const edition = candidateEdition(source, values.edition);
if (platform !== process.platform) throw new Error(`Build ${platform} installers on ${platform}`);
const pkg = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
if (pkg.version !== source.version || pkg.devDependencies.electron !== source.electronVersion) throw new Error('Installer project version differs from the packaged application');
const output = resolve(values.out);
if (existsSync(output)) throw new Error('Use a fresh installer output directory; versions cannot overwrite existing bytes');
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, '.installer-stage-'));
const bundle = join(stage, platform === 'darwin' ? `${edition.productName}.app` : `${edition.productName}-${source.target}`);
let nsis;
try {
  // Preserve Electron framework links, and leave the verified source candidate untouched.
  await cp(source.bundle, bundle, { recursive: true, dereference: false, verbatimSymlinks: true });
  const assets = join(app, 'packaging/assets');
  const config = installerConfiguration({ platform, arch, version: source.version, electronVersion: source.electronVersion, output, assets, edition: edition.id,
    ...(platform === 'win32' ? { installerInclude: prepareInstallerInclude({ directory: stage, assets, edition: edition.id }) } : {}) });
  config.forceCodeSigning = false;
  config.mac.identity = null;
  config.win.signExecutable = false;
  if (values['nsis-archive']) {
    if (platform !== 'win32') throw new Error('--nsis-archive is only used for Windows installers');
    nsis = prepareNsisBundle(resolve(values['nsis-archive']), stage);
    process.env.ELECTRON_BUILDER_NSIS_DIR = nsis.directory;
    process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = nsis.directory;
  }
  const artifacts = await build({ projectDir: app, prepackaged: bundle, targets: (platform === 'darwin' ? Platform.MAC : Platform.WINDOWS).createTarget(platform === 'darwin' ? 'zip' : 'nsis', arch === 'arm64' ? Arch.arm64 : Arch.x64), publish: 'never', config });
  const files = [];
  for (const path of artifacts) {
    const sha256 = createHash('sha256'), sha512 = createHash('sha512');
    for await (const chunk of createReadStream(path)) { sha256.update(chunk); sha512.update(chunk); }
    files.push({ file: path.slice(output.length + 1), size: (await stat(path)).size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') });
  }
  if (!files.some(file => file.file.endsWith(platform === 'darwin' ? '.zip' : '-setup.exe'))) throw new Error('Builder did not produce the expected Electron installer format');
  // Verify the immutable original after builder operated on its separate copy.
  verifyPackage(source.bundle);
  const installer = platform === 'darwin' ? { kind: 'mac-zip' } : { kind: 'nsis', registryGuid: config.nsis.guid };
  const record = { schemaVersion: 1, edition: edition.id, application: edition.application, framework: 'electron', buildKind: 'local-unsigned-installer', updateEligible: false, platform, arch, version: source.version, installer, source, files, createdAt: new Date().toISOString() };
  await writeFile(join(output, 'installer-record.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record));
} finally { nsis?.cleanup(); await rm(stage, { recursive: true, force: true }); }
