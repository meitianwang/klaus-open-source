import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { resolveReleaseTarget } from '../engine/scripts/prepare-rust-release.mjs';
import { validatePolicyNotices } from '../engine/scripts/policy-notices.mjs';

export const specification = JSON.parse(readFileSync(new URL('./resources.json', import.meta.url), 'utf8'));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export function requireTarget(platform, arch) {
  const target = `${platform}-${arch}`;
  if (!specification.targets.includes(target)) throw new Error(`Unsupported desktop target: ${target}`);
  return target;
}

export function validateBinaryTarget(bytes, platform, arch) {
  requireTarget(platform, arch);
  if (platform === 'darwin') {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== (arch === 'arm64' ? 0x100000c : 0x1000007)) throw new Error('Mach-O architecture differs from the selected target');
  } else {
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Windows artifact has no PE header');
    const offset = bytes.readUInt32LE(60);
    if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('PE architecture differs from the selected target');
  }
}

/** Inputs are copied explicitly; a checkout, build cache or linked user file cannot leak in. */
export function copyTree(source, destination, include = () => true) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are not allowed in application resources: ${source}`);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      if (['.git', '.DS_Store', 'Thumbs.db'].includes(name) || !include(join(source, name), name)) continue;
      copyTree(join(source, name), join(destination, name), include);
    }
  } else if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  } else throw new Error(`Unsupported resource file type: ${source}`);
}

export function inventory(root) {
  const result = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected resource symlink: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push({ path: relative(root, path).replaceAll('\\', '/'), size: stat.size, sha256: sha256(readFileSync(path)) });
      else throw new Error(`Unexpected resource file type: ${path}`);
    }
  }
  visit(root);
  return result;
}

export function nativeFingerprint(nativeRoot) {
  const files = ['Cargo.toml', 'Cargo.lock', 'core/Cargo.toml', 'binding/Cargo.toml', 'binding/build.rs', 'scripts/build.mjs', 'scripts/build-target.mjs', 'scripts/publish-artifact.mjs'];
  function visit(directory) {
    for (const entry of readdirSync(join(nativeRoot, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(file);
    }
  }
  visit('core/src'); visit('binding/src'); visit('vendor/wacore-noise/src'); visit('vendor/wacore/src'); visit('vendor/whatsapp-rust/src');
  files.push('vendor/wacore-noise/Cargo.toml', 'vendor/wacore/Cargo.toml', 'vendor/whatsapp-rust/Cargo.toml');
  files.push('pip/KlausPIP.h', 'pip/KlausPIPHost.m', 'pip/KlausPIPTransport.m');
  files.push('permissions/KlausPermissions.h', 'permissions/KlausPermissions.m');
  files.push('pets/KlausPetPanel.h', 'pets/KlausPetPanel.m', 'pets/KlausAppshotShortcut.h');
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(file).update('\0').update(readFileSync(join(nativeRoot, file))).update('\0');
  return { nativeSourceSha256: hash.digest('hex'), cargoLockSha256: sha256(readFileSync(join(nativeRoot, 'Cargo.lock'))) };
}

/** The engine release driver owns the artifact set, including the Windows pipe addon. */
export function engineArtifactRecords(manifest, { platform, arch }) {
  requireTarget(platform, arch);
  const target = resolveReleaseTarget(platform, arch);
  if (manifest.platform !== platform || manifest.arch !== arch || manifest.targetTriple !== target.targetTriple) throw new Error('Engine artifact target mismatch');
  if (platform !== 'win32') {
    if (manifest.binary !== target.binary || !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? '')) throw new Error('Engine artifact target or SHA-256 mismatch');
    return [{ role: 'engine', file: target.binary, sha256: manifest.sha256 }];
  }
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== target.artifacts.length) throw new Error('Windows engine requires its complete schema 2 artifact set');
  return target.artifacts.map(({ role, file }) => {
    const artifact = manifest.artifacts.find(entry => entry.role === role);
    if (!artifact || artifact.file !== file || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw new Error(`Invalid Windows engine artifact: ${role}`);
    return { role, file, sha256: artifact.sha256 };
  });
}

export function validateEngine(directory, { platform, arch, engineCommit }) {
  const manifest = readJson(join(directory, 'manifest.json'));
  if (!/^[a-f0-9]{40}$/.test(engineCommit ?? '') || manifest.engineCommit !== engineCommit) throw new Error('Engine commit does not match the explicitly selected source');
  if (manifest.engineTreeDirty !== false) throw new Error('A production engine artifact must come from a clean source tree');
  if (!/^[a-f0-9]{64}$/.test(manifest.releaseFlagsSha256 ?? '')) throw new Error('Engine release flags fingerprint is missing');
  for (const artifact of engineArtifactRecords(manifest, { platform, arch })) {
    const bytes = readFileSync(join(directory, artifact.file));
    if (sha256(bytes) !== artifact.sha256) throw new Error(`Engine binary SHA-256 mismatch: ${artifact.role}`);
    validateBinaryTarget(bytes, platform, arch);
    // Windows filesystems do not expose POSIX execute bits. Architecture and
    // content verification still apply when inspecting a foreign artifact.
    if (process.platform !== 'win32' && platform !== 'win32' && (statSync(join(directory, artifact.file)).mode & 0o111) === 0) throw new Error('Engine binary is not executable');
  }
  validatePolicyNotices(directory, manifest);
  return manifest;
}

export function validateNative(directory, nativeRoot, { platform, arch }) {
  const filename = `klaus-native-${requireTarget(platform, arch)}.node`;
  const manifest = readJson(join(directory, `${filename}.json`));
  const fingerprint = nativeFingerprint(nativeRoot);
  if (manifest.platform !== platform || manifest.arch !== arch || manifest.abiVersion !== 1 || manifest.napiVersion !== 9) throw new Error('Native artifact platform or ABI mismatch');
  if (manifest.credentialFixtures !== false || manifest.whatsappFixtures === true || manifest.sourceTreeDirty !== false || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '')) throw new Error('Only clean production native artifacts can be packaged');
  if (manifest.nativeSourceSha256 !== fingerprint.nativeSourceSha256 || manifest.cargoLockSha256 !== fingerprint.cargoLockSha256) throw new Error('Native artifact source fingerprint differs from this checkout');
  const bytes = readFileSync(join(directory, filename));
  if (sha256(bytes) !== manifest.sha256) throw new Error('Native binary SHA-256 mismatch');
  validateBinaryTarget(bytes, platform, arch);
  return { filename, manifest };
}

export function speechSourceFingerprint(sourceRoot) {
  return sha256(Buffer.concat(['klaus-speech-helper.swift', 'helper-info.plist', 'build.mjs'].map(file => readFileSync(join(sourceRoot, file)))));
}

/** Speech is a separate macOS artifact, with its own clean-source build proof. */
export function validateSpeech(directory, { platform, arch, sourceRoot }) {
  requireTarget(platform, arch);
  if (platform !== 'darwin') throw new Error('The system speech helper is only a macOS resource');
  const filename = 'klaus-speech-helper', manifest = readJson(join(directory, `${filename}.json`));
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error('Speech helper target mismatch');
  if (manifest.sourceTreeDirty !== false || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 ?? '') || typeof manifest.compiler !== 'string' || !manifest.compiler.trim()) throw new Error('Only clean, identified speech helper artifacts can be packaged');
  if (sourceRoot && manifest.sourceSha256 !== speechSourceFingerprint(sourceRoot)) throw new Error('Speech helper source fingerprint differs from this checkout');
  const file = join(directory, filename), bytes = readFileSync(file);
  if (sha256(bytes) !== manifest.sha256) throw new Error('Speech helper SHA-256 mismatch');
  validateBinaryTarget(bytes, platform, arch);
  if (process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0) throw new Error('Speech helper is not executable');
  return manifest;
}

export function recordingSourceFingerprint(sourceRoot) {
  return sha256(Buffer.concat(['klaus-recording-helper.m', 'helper-info.plist', 'build.mjs'].map(file => readFileSync(join(sourceRoot, file)))));
}

/** Native recording is macOS-only and has its own immutable source/build proof. */
export function validateRecording(directory, { platform, arch, sourceRoot }) {
  requireTarget(platform, arch);
  if (platform !== 'darwin') throw new Error('The native recording helper is only a macOS resource');
  const filename = 'klaus-recording-helper', manifest = readJson(join(directory, `${filename}.json`));
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error('Recording helper target mismatch');
  if (manifest.sourceTreeDirty !== false || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 ?? '') || typeof manifest.compiler !== 'string' || !manifest.compiler.trim()) throw new Error('Only clean, identified recording helper artifacts can be packaged');
  if (sourceRoot && manifest.sourceSha256 !== recordingSourceFingerprint(sourceRoot)) throw new Error('Recording helper source fingerprint differs from this checkout');
  const file = join(directory, filename), bytes = readFileSync(file);
  if (sha256(bytes) !== manifest.sha256) throw new Error('Recording helper SHA-256 mismatch');
  validateBinaryTarget(bytes, platform, arch);
  if (process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0) throw new Error('Recording helper is not executable');
  return manifest;
}

export function pipSourceFingerprint(sourceRoot) {
  const files = ['KlausPIP.h', 'KlausPIPService.m', 'KlausPIPTransport.m', 'producer-main.m', 'helper-info.plist', 'build.mjs'];
  return sha256(Buffer.concat(files.flatMap(file => [Buffer.from(`${file}\0`), readFileSync(join(sourceRoot, file)), Buffer.from('\0')])));
}

/** The PiP producer is a separate macOS executable with a clean source/build proof. */
export function validatePip(directory, { platform, arch, sourceRoot }) {
  requireTarget(platform, arch);
  if (platform !== 'darwin') throw new Error('The PiP producer is only a macOS resource');
  const filename = 'klaus-pip-producer', file = join(directory, filename);
  if (!lstatSync(file).isFile() || !lstatSync(`${file}.json`).isFile()) throw new Error('PiP producer and its manifest must be regular files');
  const manifest = readJson(`${file}.json`);
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error('PiP producer target mismatch');
  if (manifest.sourceTreeDirty !== false || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 ?? '') || typeof manifest.compiler !== 'string' || !manifest.compiler.trim()) throw new Error('Only clean, identified PiP producer artifacts can be packaged');
  if (sourceRoot && manifest.sourceSha256 !== pipSourceFingerprint(sourceRoot)) throw new Error('PiP producer source fingerprint differs from this checkout');
  const bytes = readFileSync(file);
  if (sha256(bytes) !== manifest.sha256) throw new Error('PiP producer SHA-256 mismatch');
  validateBinaryTarget(bytes, platform, arch);
  if (process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0) throw new Error('PiP producer is not executable');
  return manifest;
}

export function computerUseArtifactName(platform) {
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('Unsupported Computer Use helper platform');
  return 'klaus-computer-use-helper' + (platform === 'win32' ? '.exe' : '');
}

export function computerUseSourceFingerprint(sourceRoot, platform = 'darwin') {
  computerUseArtifactName(platform);
  const files = platform === 'win32' ? ['windows-helper.cpp', 'windows-helper.manifest', 'build-windows.mjs'] : ['klaus-computer-use-helper.m', 'lockscreen.m', 'lockscreen.h', 'helper-info.plist', 'build.mjs'];
  return sha256(Buffer.concat(files.map(file => readFileSync(join(sourceRoot, file)))));
}

/** Computer Use has an independent native build proof and no checkout fallback. */
export function validateComputerUse(directory, { platform, arch, sourceRoot }) {
  requireTarget(platform, arch);
  const file = join(directory, computerUseArtifactName(platform));
  if (!lstatSync(file).isFile() || !lstatSync(`${file}.json`).isFile()) throw new Error('Computer Use helper and its manifest must be regular files');
  const manifest = readJson(`${file}.json`);
  if (manifest.platform !== platform || manifest.arch !== arch) throw new Error('Computer Use helper target mismatch');
  if (manifest.sourceTreeDirty !== false || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit ?? '') || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256 ?? '') || typeof manifest.compiler !== 'string' || !manifest.compiler.trim()) throw new Error('Only clean, identified Computer Use helper artifacts can be packaged');
  if (sourceRoot && manifest.sourceSha256 !== computerUseSourceFingerprint(sourceRoot, platform)) throw new Error('Computer Use helper source fingerprint differs from this checkout');
  const bytes = readFileSync(file);
  if (sha256(bytes) !== manifest.sha256) throw new Error('Computer Use helper SHA-256 mismatch');
  validateBinaryTarget(bytes, platform, arch);
  if (platform === 'darwin' && process.platform !== 'win32' && (statSync(file).mode & 0o111) === 0) throw new Error('Computer Use helper is not executable');
  return manifest;
}

/** Match Electron's own installer: its pinned npm package supplies the release checksum. */
export function electronDownloadOptions(appDirectory, { version, platform, arch }) {
  requireTarget(platform, arch);
  const electronDirectory = join(appDirectory, 'node_modules/electron');
  if (readJson(join(electronDirectory, 'package.json')).version !== version) throw new Error('Installed Electron package version differs from the locked runtime');
  const filename = `electron-v${version}-${platform}-${arch}.zip`;
  const checksum = readJson(join(electronDirectory, 'checksums.json'))[filename];
  if (!/^[a-f0-9]{64}$/.test(checksum ?? '')) throw new Error('The pinned Electron package has no checksum for this target');
  return { checksums: { [filename]: checksum } };
}

/** Offline archives retain the same pinned checksum gate as network downloads. */
export function verifiedElectronArchiveDirectory(archive, download) {
  const file = resolve(archive), entries = Object.entries(download.checksums);
  if (entries.length !== 1 || basename(file) !== entries[0][0]) throw new Error('Electron archive filename differs from the selected runtime');
  if (!lstatSync(file).isFile() || sha256(readFileSync(file)) !== entries[0][1]) throw new Error('Electron archive SHA-256 differs from the pinned official release');
  return dirname(file);
}

export function sourceIdentity(repo) {
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const engineLine = git(['ls-tree', 'HEAD', 'engine/klaus-agent-rust']);
  return { clientCommit: git(['rev-parse', 'HEAD']), clientTreeDirty: git(['status', '--porcelain', '--untracked-files=all']).length !== 0,
    recordedEngineCommit: engineLine.split(/\s+/)[2] };
}

export function validateRequired(appDirectory, resourceDirectory) {
  for (const [root, files] of [[appDirectory, specification.requiredAppFiles], [resourceDirectory, specification.requiredResourceFiles]]) {
    for (const file of files) if (!existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) throw new Error(`Required packaged file is missing: ${file}`);
  }
  const extensionRoot = join(resourceDirectory, 'plugins-builtin/browser/chrome-extension');
  const extension = readJson(join(extensionRoot, 'manifest.json'));
  const identity = readJson(join(extensionRoot, 'extension-id.json'));
  if (extension.manifest_version !== 3 || !/^[a-p]{32}$/.test(identity.extensionId ?? '') || typeof extension.key !== 'string') throw new Error('Chrome extension manifest or stable identity is invalid');
  const expectedId = [...createHash('sha256').update(Buffer.from(extension.key, 'base64')).digest('hex').slice(0, 32)].map(value => String.fromCharCode(97 + Number.parseInt(value, 16))).join('');
  if (identity.extensionId !== expectedId) throw new Error('Chrome extension key and identity disagree');
  const references = [extension.background?.service_worker, ...Object.values(extension.icons ?? {}), extension.action?.default_popup,
    ...(extension.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])])].filter(Boolean);
  for (const file of references) {
    if (typeof file !== 'string' || file.includes('..') || !existsSync(join(extensionRoot, file))) throw new Error(`Chrome extension resource is missing: ${file}`);
  }
  // An empty seed (`{}`) is the public default; a missing or malformed one is not.
  const seed = readJson(join(resourceDirectory, 'plugins-seed', 'known_marketplaces.json'));
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) throw new Error('Bundled plugin seed is invalid');
}
