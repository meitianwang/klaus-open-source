#!/usr/bin/env node
// Local, unsigned packaging only. Publishing and platform signing are separate gates.
import { packager } from '@electron/packager';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { computerUseArtifactName, copyTree, electronDownloadOptions, engineArtifactRecords, inventory, readJson, requireTarget, sourceIdentity, specification, validateComputerUse, validateEngine, validateNative, validatePip, validateRecording, validateRequired, validateSpeech, verifiedElectronArchiveDirectory } from '../packaging/resources.mjs';
import { copyPolicyNotices } from '../engine/scripts/policy-notices.mjs';
import { verifyPackage } from '../packaging/verify.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition, packagedDesktopEditionDocument, useDesktopEditionsFile } from '../packaging/desktop-edition.mjs';
import { DEFAULT_PLUGIN_SEED, collectBundledOfficialPlugins, copyBundledOfficialPlugins, officialPluginRecords, validatePluginSeed } from '../packaging/official-plugins.mjs';
import { validateBrowserImportResource, helperName as browserImportHelperName } from '../packaging/browser-import.mjs';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));
const repo = appDirectory;

// Runtime dependencies occasionally ship test trees (e.g. comlink/tests pulled
// in via @kreuzberg/wasm). The asar content gate rejects any `tests` directory,
// including bare directory entries, so remove the whole subtree before packing.
function stripRuntimeTestTrees(nodeModules) {
  let removed = 0;
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (!statSync(path).isDirectory()) continue;
      if (/^(?:tests|__tests__|e2e)$/.test(name) || name === 'test-fixtures') {
        rmSync(path, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      visit(path);
    }
  };
  visit(nodeModules);
  return removed;
}
const { values } = parseArgs({ options: {
  edition: { type: 'string', default: DEFAULT_DESKTOP_EDITION }, 'editions-file': { type: 'string' },
  platform: { type: 'string', default: process.platform }, arch: { type: 'string', default: process.arch },
  'engine-dir': { type: 'string' }, 'engine-commit': { type: 'string' }, 'native-dir': { type: 'string' },
  'speech-dir': { type: 'string' }, 'recording-dir': { type: 'string' }, 'pip-dir': { type: 'string' }, 'computer-use-dir': { type: 'string' }, 'browser-import-dir': { type: 'string' },
  'frontend-dir': { type: 'string' }, 'electron-zip': { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
  'official-plugins-dir': { type: 'string' }, 'bundle-official-plugin': { type: 'string', multiple: true }, 'plugin-seed-dir': { type: 'string' },
} });
if (values.help) {
  console.log(`Desktop edition: --edition <id> (default ${DEFAULT_DESKTOP_EDITION}; additional editions come from --editions-file / KLAUS_DESKTOP_EDITIONS_FILE).`);
  console.log('Official plugins: --official-plugins-dir <marketplace dir> --bundle-official-plugin <name> (repeatable); none are bundled by default.');
  console.log('Plugin seed: --plugin-seed-dir <dir with known_marketplaces.json> (default: an empty seed).');
  console.log('npm run package -- --engine-dir <staged bin/platform-arch> --native-dir <production artifacts> [--speech-dir <macOS speech artifacts>] [--recording-dir <macOS recording artifacts>] [--pip-dir <macOS PiP artifacts>] [--computer-use-dir <target Computer Use artifacts>] [--browser-import-dir <target browser import helper>] [--engine-commit <40-char commit>] [--platform darwin|win32] [--arch arm64|x64] [--electron-zip <official release archive>] [--out <directory>]');
  process.exit(0);
}
const platform = values.platform, arch = values.arch;
useDesktopEditionsFile(values['editions-file']);
const edition = desktopEdition(values.edition);
const target = requireTarget(platform, arch);
if (process.platform !== platform) throw new Error(`Build ${platform} packages on ${platform}; cross-platform output is not a platform verification.`);
for (const option of ['speech-dir', 'recording-dir', 'pip-dir']) {
  if (platform !== 'darwin' && values[option] !== undefined) throw new Error(`--${option} is only valid for a macOS package`);
}
const identity = sourceIdentity(repo);
const engineCommit = values['engine-commit'] ?? identity.recordedEngineCommit;
const engineDirectory = resolve(values['engine-dir'] ?? join(repo, 'resources/bin', target));
const nativeDirectory = resolve(values['native-dir'] ?? join(appDirectory, 'native/artifacts'));
const frontendDirectory = resolve(values['frontend-dir'] ?? join(appDirectory, 'frontend-dist'));
const output = resolve(values.out ?? join(repo, 'release/electron'));
if (existsSync(join(output, `${edition.productName}-${target}`))) throw new Error('The output already contains this edition and target. Choose a new --out directory.');
const engine = validateEngine(engineDirectory, { platform, arch, engineCommit });
const native = validateNative(nativeDirectory, join(appDirectory, 'native'), { platform, arch });
const speechDirectory = platform === 'darwin' ? resolve(values['speech-dir'] ?? join(repo, 'resources/speech', target)) : undefined;
const speech = speechDirectory ? validateSpeech(speechDirectory, { platform, arch, sourceRoot: join(appDirectory, 'native/speech') }) : undefined;
const recordingDirectory = platform === 'darwin' ? resolve(values['recording-dir'] ?? join(repo, 'resources/recording', target)) : undefined;
const recording = recordingDirectory ? validateRecording(recordingDirectory, { platform, arch, sourceRoot: join(appDirectory, 'native/recording') }) : undefined;
const pipDirectory = platform === 'darwin' ? resolve(values['pip-dir'] ?? join(repo, 'resources/pip', target)) : undefined;
const pip = pipDirectory ? validatePip(pipDirectory, { platform, arch, sourceRoot: join(appDirectory, 'native/pip') }) : undefined;
const computerUseDirectory = resolve(values['computer-use-dir'] ?? join(repo, 'resources/computer-use', target));
const computerUse = validateComputerUse(computerUseDirectory, { platform, arch, sourceRoot: join(appDirectory, 'native/computer-use') });
const browserImportDirectory = resolve(values['browser-import-dir'] ?? join(repo, 'resources/browser-import', target));
const browserImport = validateBrowserImportResource(browserImportDirectory, { repo, platform, arch });
const pkg = readJson(join(appDirectory, 'package.json'));
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(pkg.version)) throw new Error('The desktop package version is invalid');
if (platform === 'darwin' && !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('macOS bundle versions require three numeric components. Select the preview channel when signing a prerelease candidate.');
if (!/^\d+\.\d+\.\d+$/.test(pkg.devDependencies.electron)) throw new Error('The Electron runtime version must be pinned exactly');
const download = electronDownloadOptions(appDirectory, { version: pkg.devDependencies.electron, platform, arch });
const electronZipDir = values['electron-zip'] ? verifiedElectronArchiveDirectory(values['electron-zip'], download) : undefined;
const bundledOfficialPlugins = collectBundledOfficialPlugins(values['official-plugins-dir'], values['bundle-official-plugin'] ?? []);
const pluginSeedDirectory = resolve(values['plugin-seed-dir'] ?? DEFAULT_PLUGIN_SEED);
validatePluginSeed(pluginSeedDirectory);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build command failed (${result.status}): ${command} ${args.join(' ')}`);
}
function npm(args, cwd) {
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...args], cwd);
  else if (process.platform !== 'win32') run('npm', args, cwd);
  else throw new Error('Run this Windows build through npm run package so the npm CLI path is explicit.');
}

npm(['run', 'typecheck'], appDirectory);
npm(['run', 'build'], appDirectory);
// Build the single desktop UI unless an explicit prebuilt bundle was supplied.
if (!values['frontend-dir']) npm(['run', 'build:frontend'], appDirectory);
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, '.stage-'));
try {
  const appStage = join(stage, 'app'), resources = join(stage, 'resources');
  mkdirSync(appStage); mkdirSync(resources);
  for (const file of ['package.json', 'package-lock.json']) copyTree(join(appDirectory, file), join(appStage, file));
  npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], appStage);
  rmSync(join(appStage, 'package-lock.json'));
  rmSync(join(appStage, 'node_modules/.bin'), { recursive: true, force: true });
  rmSync(join(appStage, 'node_modules/.package-lock.json'), { force: true });
  for (const file of inventory(join(appStage, 'node_modules'))) {
    if (file.path.endsWith('.map')) rmSync(join(appStage, 'node_modules', file.path));
  }
  stripRuntimeTestTrees(join(appStage, 'node_modules'));
  if (existsSync(join(appStage, 'node_modules/electron'))) throw new Error('The development Electron package leaked into runtime dependencies');
  for (const tree of ['main', 'preload', 'contracts', 'shared']) copyTree(join(appDirectory, 'dist', tree), join(appStage, 'dist', tree), (file, name) => statSync(file).isDirectory() || name.endsWith('.js') || name.endsWith('.json'));
  for (const file of ['channel-table.json', 'engine/klaus-app-server.schema.json']) copyTree(join(appDirectory, 'contracts', file), join(appStage, 'contracts', file));
  // The package carries the public editions plus its own, never any other definition file content.
  writeFileSync(join(appStage, 'contracts', 'desktop-editions.json'), `${JSON.stringify(packagedDesktopEditionDocument(edition.id), null, 2)}\n`);
  writeFileSync(join(appStage, 'package.json'), `${JSON.stringify({ name: pkg.name, productName: edition.productName, version: pkg.version, private: true,
    description: pkg.description, type: pkg.type, main: pkg.main, dependencies: pkg.dependencies, klausDesktopLayoutVersion: 1, klausDesktopEdition: edition.id }, null, 2)}\n`);
  copyTree(frontendDirectory, join(resources, 'frontend'));
  copyTree(join(repo, 'resources', 'manual', 'klaus-manual.md'), join(resources, 'manual', 'klaus-manual.md'));
  for (const name of specification.sharedRoots) copyTree(join(repo, 'resources', name), join(resources, name));
  copyTree(pluginSeedDirectory, join(resources, 'plugins-seed'));
  copyBundledOfficialPlugins(bundledOfficialPlugins, resources);
  for (const file of [...engineArtifactRecords(engine, { platform, arch }).map(artifact => artifact.file), 'manifest.json']) copyTree(join(engineDirectory, file), join(resources, 'bin', target, file));
  copyPolicyNotices(engineDirectory, join(resources, 'bin', target), engine);
  for (const file of [native.filename, `${native.filename}.json`]) copyTree(join(nativeDirectory, file), join(resources, 'native', file));
  if (speechDirectory) for (const file of ['klaus-speech-helper', 'klaus-speech-helper.json']) copyTree(join(speechDirectory, file), join(resources, 'speech', target, file));
  if (recordingDirectory) for (const file of ['klaus-recording-helper', 'klaus-recording-helper.json']) copyTree(join(recordingDirectory, file), join(resources, 'recording', target, file));
  if (pipDirectory) for (const file of ['klaus-pip-producer', 'klaus-pip-producer.json']) copyTree(join(pipDirectory, file), join(resources, 'pip', target, file));
  const computerUseFilename = computerUseArtifactName(platform);
  for (const file of [computerUseFilename, computerUseFilename + '.json']) copyTree(join(computerUseDirectory, file), join(resources, 'computer-use', target, file));
  const browserImportFilename = browserImportHelperName(platform);
  for (const file of [browserImportFilename, browserImportFilename + '.json']) copyTree(join(browserImportDirectory, file), join(resources, 'browser-import', target, file));
  if (platform === 'darwin') copyTree(join(appDirectory, 'packaging/assets/icon.icns'), join(resources, 'app-icon.icns'));
  validateRequired(appStage, resources);
  const resourcesManifest = {
    layoutVersion: specification.layoutVersion, application: edition.productName, edition: edition.id, applicationId: edition.application, version: pkg.version, platform, arch,
    electronVersion: pkg.devDependencies.electron, buildKind: 'local-unsigned', createdAt: new Date().toISOString(),
    electronArchiveSha256: Object.values(download.checksums)[0],
    ...identity, officialPlugins: officialPluginRecords(bundledOfficialPlugins), engine, native: native.manifest, ...(speech ? { speech } : {}), ...(recording ? { recording } : {}), ...(pip ? { pip } : {}), ...(computerUse ? { computerUse } : {}), browserImport,
    appFiles: inventory(appStage), resourceFiles: inventory(resources),
  };
  writeFileSync(join(resources, 'desktop-resources.json'), `${JSON.stringify(resourcesManifest, null, 2)}\n`);
  const packages = await packager({
    dir: appStage, out: output, platform, arch, name: edition.productName, executableName: edition.executableName,
    appVersion: pkg.version, buildVersion: pkg.version, electronVersion: pkg.devDependencies.electron,
    download, ...(electronZipDir ? { electronZipDir } : {}),
    appBundleId: edition.application, helperBundleId: edition.helperApplication, appCopyright: 'Klaus',
    appCategoryType: 'public.app-category.developer-tools', darwinDarkModeSupport: true,
    asar: true, prune: false, overwrite: false,
    // Packager 20 probes a missing optional Icon Composer file when `icon` is
    // set on macOS. Use the documented plist + extraResource mechanism for ICNS.
    ...(platform === 'win32' ? { icon: join(appDirectory, 'packaging/assets/icon.ico') } : {}),
    extraResource: readdirSync(resources).sort().map(name => join(resources, name)),
    protocols: [{ name: edition.productName, schemes: [edition.protocol] }],
    usageDescription: { Microphone: 'Klaus uses the microphone when you choose voice input.', Camera: 'Klaus uses the camera when you allow a browser page to use it.', SpeechRecognition: 'Klaus uses system speech recognition to transcribe your voice into the message box.' },
    extendInfo: { NSHighResolutionCapable: true, CFBundleIconFile: 'app-icon.icns',
      // Passive status reads need no purpose string, but the in-app consent request for
      // Photos (and any future location request) aborts without one, so the bundle must
      // declare both purposes.
      NSPhotoLibraryUsageDescription: 'Klaus reads and updates your macOS Photos library when you enable the Photos connector.',
      NSLocationUsageDescription: 'Klaus reads your location when an agent step needs geographic context.' },
    ...(platform === 'win32' ? { win32metadata: { CompanyName: 'Klaus', FileDescription: `${edition.productName} desktop`, ProductName: edition.productName } } : {}),
  });
  if (packages.length !== 1) throw new Error('Expected exactly one packaged target');
  const bundle = platform === 'darwin' ? join(packages[0], `${edition.productName}.app`) : packages[0];
  const report = verifyPackage(bundle);
  writeFileSync(join(packages[0], 'package-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Packaged desktop: ${bundle}`);
  console.log(JSON.stringify(report));
} finally { rmSync(stage, { recursive: true, force: true }); }
