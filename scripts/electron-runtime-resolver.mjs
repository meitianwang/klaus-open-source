#!/usr/bin/env node
// Resolve the Electron runtime used by development, packaging and test launchers.
// A custom runtime is accepted only through explicit paths and a receipt that pins
// its source metadata and every file in the application bundle.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RUNTIME_ENV = Object.freeze({
  mode: 'KLAUS_ELECTRON_RUNTIME_MODE',
  directory: 'KLAUS_ELECTRON_RUNTIME_DIR',
  receipt: 'KLAUS_ELECTRON_RUNTIME_RECEIPT',
  manifest: 'KLAUS_ELECTRON_RUNTIME_MANIFEST',
});

export const RUNTIME_RECEIPT_SCHEMA = 1;
export const RUNTIME_RECEIPT_KIND = 'klaus-electron-runtime';
const SHA256 = /^[a-f0-9]{64}$/;
const ELECTRON_VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const SUPPORTED_MODES = new Set(['native', 'stock']);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty absolute path`);
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return resolve(value);
}

function relativeInside(root, candidate, label) {
  const path = relative(root, candidate);
  if (path === '') return '';
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(`${label} must stay inside ${root}`);
  return path.split(sep).join('/');
}

function inside(root, relativePath, label) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const path = resolve(root, relativePath);
  relativeInside(root, path, label);
  return path;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function plistObject(file) {
  if (process.platform !== 'darwin') throw new Error('The custom Electron runtime requires macOS plist validation');
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot read ${file}: ${result.stderr?.trim() || result.signal || result.status}`);
  return JSON.parse(result.stdout);
}

function assertMachO(bytes, arch) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw new Error('The Electron executable is too small to be a Mach-O binary');
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error('The Electron executable is not a thin 64-bit Mach-O binary');
  const expected = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : undefined;
  if (!expected || bytes.readUInt32LE(4) !== expected) throw new Error(`The Electron executable architecture differs from ${arch}`);
}

function manifestSource(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('The Electron runtime manifest must be an object');
  for (const field of ['electron_version', 'chromium_version', 'node_version']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) throw new Error(`The Electron runtime manifest is missing ${field}`);
  }
  if (!manifest.repositories || typeof manifest.repositories !== 'object' || Array.isArray(manifest.repositories)) {
    throw new Error('The Electron runtime manifest is missing repositories');
  }
  if (!Array.isArray(manifest.patch_order) || !manifest.patch_order.length) throw new Error('The Electron runtime manifest is missing patch_order');
  const patchOrder = [];
  const seen = new Set();
  for (const patch of manifest.patch_order) {
    if (!patch || typeof patch !== 'object') throw new Error('The Electron runtime manifest contains an invalid patch order entry');
    if (typeof patch.repo !== 'string' || !Object.hasOwn(manifest.repositories, patch.repo)) throw new Error(`The Electron runtime manifest has an unknown patch repository: ${patch.repo}`);
    if (typeof patch.file !== 'string' || !patch.file || isAbsolute(patch.file) || patch.file.split(/[\\/]/).includes('..')) throw new Error(`The Electron runtime manifest has an invalid patch file: ${patch.file}`);
    if (!SHA256.test(patch.sha256 ?? '')) throw new Error(`The Electron runtime manifest has an invalid patch SHA-256: ${patch.file}`);
    if (seen.has(patch.file)) throw new Error(`The Electron runtime manifest repeats a patch: ${patch.file}`);
    seen.add(patch.file);
    patchOrder.push({ repo: patch.repo, file: patch.file, sha256: patch.sha256 });
  }
  const hash = createHash('sha256');
  for (const patch of patchOrder) hash.update(patch.repo).update('\0').update(patch.file).update('\0').update(patch.sha256).update('\0');
  return {
    name: typeof manifest.name === 'string' ? manifest.name : undefined,
    electronVersion: manifest.electron_version,
    chromiumVersion: manifest.chromium_version,
    nodeVersion: manifest.node_version,
    repositories: manifest.repositories,
    patchOrderSha256: hash.digest('hex'),
  };
}

async function inspectBundle(appDirectory) {
  const app = await lstat(appDirectory);
  if (app.isSymbolicLink() || !app.isDirectory()) throw new Error(`The Electron application bundle must be a real directory: ${appDirectory}`);
  const directories = [];
  const files = [];
  const symlinks = [];

  const visit = async directory => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath = relativeInside(appDirectory, path, 'The Electron bundle entry');
      const value = await lstat(path);
      if (value.isSymbolicLink()) {
        const target = await readlink(path);
        const resolvedTarget = resolve(dirname(path), target);
        relativeInside(appDirectory, resolvedTarget, `The Electron bundle symlink ${relativePath}`);
        symlinks.push({ path: relativePath, target });
      } else if (value.isDirectory()) {
        directories.push(relativePath);
        await visit(path);
      } else if (value.isFile()) {
        files.push({
          path: relativePath,
          size: value.size,
          executable: (value.mode & 0o111) !== 0,
          sha256: await sha256File(path),
        });
      } else {
        throw new Error(`The Electron bundle contains an unsupported file type: ${relativePath}`);
      }
    }
  };
  await visit(appDirectory);
  directories.sort();
  files.sort((left, right) => compareText(left.path, right.path));
  symlinks.sort((left, right) => compareText(left.path, right.path));

  const hash = createHash('sha256');
  const entries = [
    ...directories.map(path => ({ path, line: `dir\0${path}\n` })),
    ...files.map(file => ({ path: file.path, line: `file\0${file.path}\0${file.size}\0${file.executable ? '1' : '0'}\0${file.sha256}\n` })),
    ...symlinks.map(link => ({ path: link.path, line: `link\0${link.path}\0${link.target}\n` })),
  ].sort((left, right) => compareText(left.path, right.path));
  for (const entry of entries) hash.update(entry.line);
  return { directories, files, symlinks, treeSha256: hash.digest('hex') };
}

function normalizeEntries(entries, keys) {
  return [...entries]
    .map(entry => Object.fromEntries(keys.map(key => [key, entry[key]])))
    .sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

function assertEntriesEqual(actual, expected, keys, label) {
  if (!Array.isArray(expected) || canonicalJson(normalizeEntries(actual, keys)) !== canonicalJson(normalizeEntries(expected, keys))) {
    throw new Error(`${label} differs from the receipt`);
  }
}

function assertReceiptValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function readReceipt(receiptFile) {
  const receipt = await readJson(receiptFile);
  assertReceiptValue(receipt?.schemaVersion === RUNTIME_RECEIPT_SCHEMA, `Unsupported Electron runtime receipt schema: ${receipt?.schemaVersion}`);
  assertReceiptValue(receipt.kind === RUNTIME_RECEIPT_KIND, `Unexpected Electron runtime receipt kind: ${receipt.kind}`);
  return receipt;
}

export function selectElectronRuntimeMode({ mode, env = process.env } = {}) {
  const explicit = String(mode ?? env[RUNTIME_ENV.mode] ?? '').trim().toLowerCase();
  if (explicit) {
    if (!SUPPORTED_MODES.has(explicit)) throw new Error(`${RUNTIME_ENV.mode} must be native or stock`);
    return explicit;
  }
  const injected = [RUNTIME_ENV.directory, RUNTIME_ENV.receipt, RUNTIME_ENV.manifest].some(key => String(env[key] ?? '').trim());
  return injected ? 'native' : 'stock';
}

export async function resolveStockRuntime({ appDirectory }) {
  const root = absolutePath(appDirectory, 'The desktop application directory');
  const packageFile = join(root, 'node_modules/electron/package.json');
  let packageValue;
  try {
    packageValue = await readJson(packageFile);
  } catch (error) {
    throw new Error(`The stock Electron package is not installed at ${packageFile}`, { cause: error });
  }
  const require = createRequire(join(root, 'package.json'));
  const executable = require('electron');
  const value = await stat(executable);
  if (!value.isFile()) throw new Error('The stock Electron executable is not a file');
  return { mode: 'stock', executable, electronVersion: packageValue.version, receipt: null, receiptSha256: null };
}

export async function validateNativeRuntime({ runtimeDirectory, receiptFile, manifestFile, platform, arch, requirePackagerZip = false }) {
  const runtimeRoot = absolutePath(runtimeDirectory, RUNTIME_ENV.directory);
  const receiptPath = absolutePath(receiptFile, RUNTIME_ENV.receipt);
  const manifestPath = absolutePath(manifestFile, RUNTIME_ENV.manifest);
  const runtimeReal = await realpath(runtimeRoot);
  const receiptReal = await realpath(receiptPath);
  const manifestReal = await realpath(manifestPath);
  const runtimeStat = await stat(runtimeReal);
  const receiptStat = await stat(receiptReal);
  const manifestStat = await stat(manifestReal);
  if (!runtimeStat.isDirectory()) throw new Error(`${RUNTIME_ENV.directory} must point to a directory`);
  if (!receiptStat.isFile()) throw new Error(`${RUNTIME_ENV.receipt} must point to a file`);
  if (!manifestStat.isFile()) throw new Error(`${RUNTIME_ENV.manifest} must point to a file`);
  relativeInside(runtimeReal, receiptReal, RUNTIME_ENV.receipt);

  const receipt = await readReceipt(receiptReal);
  const manifest = await readJson(manifestReal);
  const source = manifestSource(manifest);
  const receiptSha256 = await sha256File(receiptReal);
  const patchManifestSha256 = await sha256File(manifestReal);

  assertReceiptValue(receipt.target?.platform === platform, `Electron runtime platform differs from ${platform}`);
  assertReceiptValue(receipt.target?.arch === arch, `Electron runtime architecture differs from ${arch}`);
  assertReceiptValue(receipt.name === source.name, 'Electron runtime receipt name differs from the manifest');
  assertReceiptValue(receipt.electron?.version === source.electronVersion, 'Electron runtime receipt version differs from the manifest');
  assertReceiptValue(receipt.electron?.chromiumVersion === source.chromiumVersion, 'Chromium version differs from the manifest');
  assertReceiptValue(receipt.electron?.nodeVersion === source.nodeVersion, 'Node version differs from the manifest');
  assertReceiptValue(receipt.source?.patchManifestSha256 === patchManifestSha256, 'Patch manifest SHA-256 differs from the receipt');
  assertReceiptValue(receipt.source?.patchOrderSha256 === source.patchOrderSha256, 'Patch order SHA-256 differs from the receipt');
  assertReceiptValue(canonicalJson(receipt.source?.repositories) === canonicalJson(source.repositories), 'Source repositories differ from the manifest');
  assertReceiptValue(ELECTRON_VERSION.test(receipt.electron.version), 'Electron runtime receipt has an invalid version');

  const appDirectory = inside(runtimeReal, receipt.bundle?.appDirectory, 'The receipt application bundle');
  const observed = await inspectBundle(appDirectory);
  assertReceiptValue(receipt.bundle?.treeSha256 === observed.treeSha256, 'Electron application tree SHA-256 differs from the receipt');
  assertEntriesEqual(observed.directories, receipt.bundle?.directories, ['path'], 'Electron application directories');
  assertEntriesEqual(observed.files, receipt.bundle?.files, ['path', 'size', 'executable', 'sha256'], 'Electron application files');
  assertEntriesEqual(observed.symlinks, receipt.bundle?.symlinks, ['path', 'target'], 'Electron application symlinks');

  const executable = inside(appDirectory, receipt.bundle?.executable, 'The receipt Electron executable');
  const executableEntry = observed.files.find(file => file.path === receipt.bundle.executable);
  assertReceiptValue(executableEntry?.executable === true, 'The Electron executable is not marked executable');
  const executableBytes = await readFile(executable);
  assertReceiptValue(sha256Bytes(executableBytes) === executableEntry.sha256, 'Electron executable SHA-256 differs from the receipt');
  assertMachO(executableBytes, arch);

  const plistFile = inside(appDirectory, 'Contents/Info.plist', 'The Electron Info.plist');
  const info = plistObject(plistFile);
  assertReceiptValue(info.CFBundleShortVersionString === receipt.electron.version, 'The Electron Info.plist version differs from the receipt');
  const frameworkPlist = inside(appDirectory, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist', 'The Electron Framework Info.plist');
  const framework = plistObject(frameworkPlist);
  assertReceiptValue(framework.CFBundleVersion === receipt.electron.version, 'The Electron Framework version differs from the receipt');

  let packagerZip = null;
  if (requirePackagerZip) {
    assertReceiptValue(receipt.packager?.zipFile, 'The Electron runtime receipt has no packager ZIP');
    const zipFile = inside(runtimeReal, receipt.packager.zipFile, 'The receipt packager ZIP');
    let zipStat;
    try { zipStat = await lstat(zipFile); }
    catch (error) { throw new Error(`The packager ZIP is missing: ${zipFile}`, { cause: error }); }
    assertReceiptValue(zipStat.isFile() && !zipStat.isSymbolicLink(), 'The packager ZIP must be a regular file');
    const zipSha256 = await sha256File(zipFile);
    assertReceiptValue(zipSha256 === receipt.packager.zipSha256, 'Packager ZIP SHA-256 differs from the receipt');
    packagerZip = { file: zipFile, sha256: zipSha256, filename: basename(zipFile) };
  }

  return {
    mode: 'native',
    executable,
    electronVersion: receipt.electron.version,
    target: { platform, arch },
    receiptPath: receiptReal,
    receiptSha256,
    receipt,
    packagerZip,
    packagerZipDir: packagerZip ? dirname(packagerZip.file) : undefined,
    summary: {
      mode: 'native',
      name: receipt.name,
      target: { platform, arch },
      electronVersion: receipt.electron.version,
      chromiumVersion: receipt.electron.chromiumVersion,
      nodeVersion: receipt.electron.nodeVersion,
      receiptSha256,
      patchManifestSha256,
      patchOrderSha256: source.patchOrderSha256,
      bundleTreeSha256: observed.treeSha256,
      executableSha256: executableEntry.sha256,
      packagerZipSha256: packagerZip?.sha256 ?? null,
    },
  };
}

export async function resolveElectronRuntime({ appDirectory, mode, env = process.env, platform = process.platform, arch = process.arch, requirePackagerZip = false } = {}) {
  const selected = selectElectronRuntimeMode({ mode, env });
  if (selected === 'stock') {
    const runtime = await resolveStockRuntime({ appDirectory });
    return { ...runtime, target: { platform, arch }, summary: { mode: 'stock', electronVersion: runtime.electronVersion, target: { platform, arch } } };
  }
  const runtimeDirectory = env[RUNTIME_ENV.directory];
  const receiptFile = env[RUNTIME_ENV.receipt];
  const manifestFile = env[RUNTIME_ENV.manifest];
  const missing = [RUNTIME_ENV.directory, RUNTIME_ENV.receipt, RUNTIME_ENV.manifest].filter((_, index) => !String([runtimeDirectory, receiptFile, manifestFile][index] ?? '').trim());
  if (missing.length) throw new Error(`Native Electron runtime selection requires ${missing.join(', ')}; stock fallback is disabled`);
  return validateNativeRuntime({ runtimeDirectory, receiptFile, manifestFile, platform, arch, requirePackagerZip });
}

export function describeElectronRuntime(runtime) {
  const target = `${runtime.target.platform}-${runtime.target.arch}`;
  return runtime.mode === 'native'
    ? `native ${runtime.receipt.name} ${runtime.electronVersion} (${target}, receipt ${runtime.receiptSha256.slice(0, 16)})`
    : `stock Electron ${runtime.electronVersion} (${target})`;
}

export async function createPackagerArchive({ runtimeDirectory, appDirectory, platform, arch, version, zipFile }) {
  if (platform !== 'darwin') throw new Error('Custom Electron runtime archives are currently supported only on macOS');
  if (!ELECTRON_VERSION.test(version)) throw new Error(`Invalid Electron version: ${version}`);
  const runtimeRoot = absolutePath(runtimeDirectory, RUNTIME_ENV.directory);
  const app = inside(runtimeRoot, appDirectory, 'The receipt application bundle');
  const destination = zipFile
    ? inside(runtimeRoot, zipFile, 'The receipt packager ZIP')
    : inside(runtimeRoot, `packager/electron-v${version}-${platform}-${arch}.zip`, 'The receipt packager ZIP');
  await mkdir(dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  const result = spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', '--noextattr', '--noacl', '--noqtn', app, destination], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot create the Electron packager ZIP: ${result.stderr?.trim() || result.signal || result.status}`);
  const value = await stat(destination);
  if (!value.isFile()) throw new Error('The packager ZIP was not created');
  return { file: destination, filename: basename(destination), sha256: await sha256File(destination) };
}

export async function createNativeRuntimeReceipt({ runtimeDirectory, receiptFile, manifestFile, appDirectory = 'Electron.app', platform = process.platform, arch = process.arch, packagerZip }) {
  const runtimeRoot = absolutePath(runtimeDirectory, RUNTIME_ENV.directory);
  const receiptPath = absolutePath(receiptFile, RUNTIME_ENV.receipt);
  const manifestPath = absolutePath(manifestFile, RUNTIME_ENV.manifest);
  const runtimeReal = await realpath(runtimeRoot);
  const manifestReal = await realpath(manifestPath);
  const app = inside(runtimeReal, appDirectory, 'The receipt application bundle');
  const manifest = await readJson(manifestReal);
  const source = manifestSource(manifest);
  const observed = await inspectBundle(app);
  const version = plistObject(inside(app, 'Contents/Info.plist', 'The Electron Info.plist')).CFBundleShortVersionString;
  if (version !== source.electronVersion) throw new Error('The Electron Info.plist version differs from the manifest');
  const frameworkVersion = plistObject(inside(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist', 'The Electron Framework Info.plist')).CFBundleVersion;
  if (frameworkVersion !== source.electronVersion) throw new Error('The Electron Framework version differs from the manifest');
  const executable = inside(app, 'Contents/MacOS/Electron', 'The Electron executable');
  const executableEntry = observed.files.find(file => file.path === 'Contents/MacOS/Electron');
  if (!executableEntry?.executable) throw new Error('The Electron executable is missing or not executable');
  assertMachO(await readFile(executable), arch);
  const archive = packagerZip
    ? { file: inside(runtimeReal, packagerZip, 'The receipt packager ZIP'), filename: basename(packagerZip), sha256: await sha256File(inside(runtimeReal, packagerZip, 'The receipt packager ZIP')) }
    : await createPackagerArchive({ runtimeDirectory: runtimeReal, appDirectory, platform, arch, version });
  const receipt = {
    schemaVersion: RUNTIME_RECEIPT_SCHEMA,
    kind: RUNTIME_RECEIPT_KIND,
    name: source.name,
    target: { platform, arch },
    electron: {
      version: source.electronVersion,
      chromiumVersion: source.chromiumVersion,
      nodeVersion: source.nodeVersion,
    },
    source: {
      repositories: source.repositories,
      patchManifestSha256: await sha256File(manifestReal),
      patchOrderSha256: source.patchOrderSha256,
    },
    bundle: {
      appDirectory: relative(runtimeReal, app).split(sep).join('/'),
      executable: 'Contents/MacOS/Electron',
      treeSha256: observed.treeSha256,
      directories: observed.directories,
      files: observed.files,
      symlinks: observed.symlinks,
    },
    packager: {
      zipFile: relative(runtimeReal, archive.file).split(sep).join('/'),
      zipSha256: archive.sha256,
    },
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return validateNativeRuntime({ runtimeDirectory: runtimeReal, receiptFile: receiptPath, manifestFile: manifestReal, platform, arch, requirePackagerZip: true });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  const values = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith('--')) throw new Error(`Unknown runtime resolver argument: ${argument}`);
    const key = argument.slice(2);
    if (key === 'require-packager-zip') {
      values[key] = true;
      continue;
    }
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
  }
  return { command, values };
}

async function main(argv) {
  const parsed = parseCli(argv);
  if (parsed.command === 'help') {
    console.log(`Usage:
  node scripts/electron-runtime-resolver.mjs create --runtime-dir <dir> --receipt <file> --manifest <file> [--app Electron.app] [--platform darwin] [--arch arm64] [--packager-zip <file>]
  node scripts/electron-runtime-resolver.mjs verify --runtime-dir <dir> --receipt <file> --manifest <file> [--platform darwin] [--arch arm64] [--require-packager-zip]

The runtime directory, receipt and manifest are explicit inputs. The resolver never
downloads a runtime and never falls back to the stock Electron package in native mode.`);
    return;
  }
  if (!['create', 'verify'].includes(parsed.command)) throw new Error(`Unknown runtime resolver command: ${parsed.command}`);
  if (parsed.command === 'create') {
    const runtime = await createNativeRuntimeReceipt({
      runtimeDirectory: parsed.values['runtime-dir'], receiptFile: parsed.values.receipt, manifestFile: parsed.values.manifest,
      appDirectory: parsed.values.app ?? 'Electron.app', platform: parsed.values.platform ?? process.platform, arch: parsed.values.arch ?? process.arch,
      packagerZip: parsed.values['packager-zip'],
    });
    console.log(JSON.stringify(runtime.summary, null, 2));
    return;
  }
  const runtime = await validateNativeRuntime({
    runtimeDirectory: parsed.values['runtime-dir'], receiptFile: parsed.values.receipt, manifestFile: parsed.values.manifest,
    platform: parsed.values.platform ?? process.platform, arch: parsed.values.arch ?? process.arch,
    requirePackagerZip: parsed.values['require-packager-zip'] !== undefined,
  });
  console.log(JSON.stringify(runtime.summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
