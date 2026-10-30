import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createPackage } from '@electron/asar';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { computerUseArtifactName, computerUseSourceFingerprint, copyTree, electronDownloadOptions, inventory, nativeFingerprint, pipSourceFingerprint, recordingSourceFingerprint, requireTarget, sha256, specification, speechSourceFingerprint, validateBinaryTarget, validateComputerUse, validateEngine, validateNative, validatePip, validateRecording, validateSpeech, verifiedElectronArchiveDirectory } from './resources.mjs';
import { macSigningOptions } from './macos-signing.mjs';
import { verifyComputerUseResource, verifyPackage, verifyPipResource, verifyRuntimeModuleClosure } from './verify.mjs';
import { desktopEdition } from './desktop-edition.mjs';
import { stagePolicyNotices } from '../engine/scripts/policy-notices.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'klaus-package-test-'));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const commit = 'a'.repeat(40), platform = 'darwin', arch = 'arm64';
const windowsEngineArtifacts = [
  { role: 'engine', file: 'klaus-agent-stdio.exe' },
  { role: 'browserPipeAddon', file: 'klaus_browser_pipe.node' },
  { role: 'sandboxSetup', file: 'klaus-windows-sandbox-setup.exe' },
  { role: 'sandboxRunner', file: 'klaus-command-runner.exe' },
  { role: 'sandboxManagedDenyProbe', file: 'klaus-windows-managed-deny-probe.exe' },
];
const macho = () => { const bytes = Buffer.alloc(32); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x100000c, 4); return bytes; };
const pe = () => { const bytes = Buffer.alloc(128); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); return bytes; };

function policyNoticeFixture(root, destinationDir = root) {
  const repoRoot = join(root, 'notice-source');
  for (const component of ['context/prompts', 'goal/templates', 'planning/prompts', 'engine/approval_context/assets']) {
    const directory = join(repoRoot, 'engine/klaus-agent-rust/crates/core/src', component);
    mkdirSync(directory, { recursive: true });
    for (const name of ['LICENSE', 'NOTICE', 'policy.md.license']) writeFileSync(join(directory, name), `${component}/${name}\n`);
  }
  const sandboxNotices = [
    ['crates/core/src/sandbox/linux', ['LICENSE-APACHE', 'NOTICE']],
    ['crates/sandbox-linux-bwrap', ['vendor/bubblewrap/LICENSE', 'vendor/bubblewrap/COPYING', 'NOTICE', 'LICENSE-MIT', 'LICENSE-APACHE']],
    ['crates/sandbox-win', ['LICENSE-APACHE', 'NOTICE', 'LICENSE-MIT']],
    ['crates/sandbox-win/src/elevated/pty_native', ['LICENSE', 'NOTICE']],
    ['crates/sandbox-win/src/mxc', ['LICENSE-MIT']],
  ];
  for (const [component, notices] of sandboxNotices) {
    for (const name of notices) {
      const file = join(repoRoot, 'engine/klaus-agent-rust', component, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${component}/${name}\n`);
    }
  }
  return stagePolicyNotices({ repoRoot, destinationDir, engineCommit: commit });
}

test('packaged runtime module closure rejects omitted emitted dependencies without reading comments as code', () => {
  const sources = new Map([
    ['dist/main/index.js', "require('./app/runtime')"],
    ['dist/main/app/runtime.js', "require('../../contracts/legacy-ui-state')"],
    ['dist/contracts/legacy-ui-state.js', "// require('./not-a-real-module')"],
  ]);
  const verify = () => verifyRuntimeModuleClosure([...sources.keys()], file => Buffer.from(sources.get(file)));
  assert.doesNotThrow(verify);
  sources.delete('dist/contracts/legacy-ui-state.js');
  assert.throws(verify, /dist\/main\/app\/runtime\.js -> \.\.\/\.\.\/contracts\/legacy-ui-state/);
});

test('native executable headers reject a foreign architecture independently of JSON metadata', () => {
  assert.doesNotThrow(() => validateBinaryTarget(macho(), 'darwin', 'arm64'));
  assert.throws(() => validateBinaryTarget(macho(), 'darwin', 'x64'), /Unsupported desktop target/);
  assert.throws(() => validateBinaryTarget(macho(), 'win32', 'x64'), /PE header/);
  const pe = Buffer.alloc(128); pe.writeUInt16LE(0x5a4d, 0); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
  assert.doesNotThrow(() => validateBinaryTarget(pe, 'win32', 'x64'));
  pe.writeUInt16LE(0xaa64, 68); assert.throws(() => validateBinaryTarget(pe, 'win32', 'x64'), /architecture/);
});

test('target selection rejects unsupported and incomplete platform keys', () => {
  assert.equal(requireTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(requireTarget('win32', 'x64'), 'win32-x64');
  assert.throws(() => requireTarget('darwin', 'x64'), /Unsupported/);
  assert.throws(() => requireTarget('linux', 'arm64'), /Unsupported/);
  assert.throws(() => requireTarget('win32', 'arm64'), /Unsupported/);
});

test('Electron download validation requires a matching installed version and a target checksum', () => fixture(root => {
  const directory = join(root, 'node_modules/electron'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '44.2.0' }));
  writeFileSync(join(directory, 'checksums.json'), JSON.stringify({ 'electron-v44.2.0-win32-x64.zip': 'a'.repeat(64) }));
  assert.equal(electronDownloadOptions(root, { version: '44.2.0', platform: 'win32', arch: 'x64' }).checksums['electron-v44.2.0-win32-x64.zip'], 'a'.repeat(64));
  assert.throws(() => electronDownloadOptions(root, { version: '44.2.1', platform: 'win32', arch: 'x64' }), /version differs/);
  assert.throws(() => electronDownloadOptions(root, { version: '44.2.0', platform: 'darwin', arch: 'arm64' }), /no checksum/);
}));

test('offline Electron archives reject another target, changed bytes and symlinks', () => fixture(root => {
  const name = 'electron-v44.2.0-win32-x64.zip', file = join(root, name), bytes = Buffer.from('archive fixture');
  const download = { checksums: { [name]: sha256(bytes) } };
  writeFileSync(file, bytes);
  assert.equal(verifiedElectronArchiveDirectory(file, download), root);
  assert.throws(() => verifiedElectronArchiveDirectory(join(root, 'electron-v44.2.0-darwin-arm64.zip'), download), /filename differs/);
  writeFileSync(file, 'changed'); assert.throws(() => verifiedElectronArchiveDirectory(file, download), /SHA-256/);
  rmSync(file); writeFileSync(join(root, 'target.zip'), bytes); symlinkSync(join(root, 'target.zip'), file);
  assert.throws(() => verifiedElectronArchiveDirectory(file, download), /SHA-256/);
}));

test('engine validation rejects incorrect commit, dirty source, target and modified bytes', () => fixture(root => {
  const binary = 'klaus-agent-stdio', bytes = macho();
  const manifest = { engineCommit: commit, engineTreeDirty: false, platform, arch, binary, targetTriple: 'aarch64-apple-darwin', sha256: sha256(bytes), releaseFlagsSha256: 'f'.repeat(64), policyNotices: policyNoticeFixture(root) };
  writeFileSync(join(root, binary), bytes, { mode: 0o755 });
  const save = value => writeFileSync(join(root, 'manifest.json'), JSON.stringify(value));
  save(manifest);
  assert.equal(validateEngine(root, { platform, arch, engineCommit: commit }).engineCommit, commit);
  save({ ...manifest, policyNotices: undefined }); assert.throws(() => validateEngine(root, { platform, arch, engineCommit: commit }), /notice identity is missing/);
  save(manifest);
  const notice = join(root, 'licenses/goal-policy/NOTICE'), originalNotice = readFileSync(notice);
  writeFileSync(notice, 'changed'); assert.throws(() => validateEngine(root, { platform, arch, engineCommit: commit }), /notice SHA-256 mismatch/);
  writeFileSync(notice, originalNotice);
  if (process.platform !== 'win32') {
    chmodSync(join(root, binary), 0o644); assert.throws(() => validateEngine(root, { platform, arch, engineCommit: commit }), /not executable/);
    chmodSync(join(root, binary), 0o755);
  }
  assert.throws(() => validateEngine(root, { platform, arch, engineCommit: 'b'.repeat(40) }), /commit/);
  save({ ...manifest, engineTreeDirty: true }); assert.throws(() => validateEngine(root, { platform, arch, engineCommit: commit }), /clean/);
  save({ ...manifest, arch: 'x64' }); assert.throws(() => validateEngine(root, { platform, arch, engineCommit: commit }), /target/);
  save(manifest); writeFileSync(join(root, binary), 'tampered');
  assert.throws(() => validateEngine(root, { platform, arch, engineCommit: commit }), /SHA-256/);
}));

test('native validation rejects credential fixture builds and stale source fingerprints', () => fixture(root => {
  const nativeRoot = join(root, 'source');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'core/Cargo.toml', 'binding/Cargo.toml', 'binding/build.rs', 'scripts/build.mjs', 'scripts/build-target.mjs', 'scripts/publish-artifact.mjs', 'core/src/lib.rs', 'binding/src/lib.rs', 'vendor/wacore-noise/Cargo.toml', 'vendor/wacore/Cargo.toml', 'vendor/whatsapp-rust/Cargo.toml', 'vendor/wacore-noise/src/lib.rs', 'vendor/wacore/src/lib.rs', 'vendor/whatsapp-rust/src/lib.rs', 'pip/KlausPIP.h', 'pip/KlausPIPHost.m', 'pip/KlausPIPTransport.m', 'permissions/KlausPermissions.h', 'permissions/KlausPermissions.m', 'pets/KlausPetPanel.h', 'pets/KlausPetPanel.m', 'pets/KlausAppshotShortcut.h']) {
    mkdirSync(dirname(join(nativeRoot, name)), { recursive: true }); writeFileSync(join(nativeRoot, name), name);
  }
  const filename = 'klaus-native-darwin-arm64.node', bytes = macho();
  const manifest = { abiVersion: 1, napiVersion: 9, platform, arch, credentialFixtures: false, sourceCommit: commit, sourceTreeDirty: false, ...nativeFingerprint(nativeRoot), sha256: sha256(bytes) };
  writeFileSync(join(root, filename), bytes);
  const save = value => writeFileSync(join(root, `${filename}.json`), JSON.stringify(value));
  save(manifest); assert.equal(validateNative(root, nativeRoot, { platform, arch }).filename, filename);
  save({ ...manifest, credentialFixtures: true }); assert.throws(() => validateNative(root, nativeRoot, { platform, arch }), /production/);
  save({ ...manifest, whatsappFixtures: true }); assert.throws(() => validateNative(root, nativeRoot, { platform, arch }), /production/);
  save({ ...manifest, nativeSourceSha256: '0'.repeat(64) }); assert.throws(() => validateNative(root, nativeRoot, { platform, arch }), /fingerprint/);
  save(manifest);
  for (const name of ['pip/KlausPIP.h', 'pip/KlausPIPHost.m', 'pip/KlausPIPTransport.m', 'permissions/KlausPermissions.h', 'permissions/KlausPermissions.m', 'pets/KlausPetPanel.h', 'pets/KlausPetPanel.m', 'pets/KlausAppshotShortcut.h']) {
    writeFileSync(join(nativeRoot, name), 'changed'); assert.throws(() => validateNative(root, nativeRoot, { platform, arch }), /fingerprint/);
    writeFileSync(join(nativeRoot, name), name);
  }
  writeFileSync(join(root, filename), 'tampered');
  assert.throws(() => validateNative(root, nativeRoot, { platform, arch }), /SHA-256/);
}));

test('macOS speech validation rejects stale sources, missing proof and altered helper bytes', () => fixture(root => {
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
  for (const name of ['klaus-speech-helper.swift', 'helper-info.plist', 'build.mjs']) writeFileSync(join(sourceRoot, name), name);
  const binary = join(root, 'klaus-speech-helper'), bytes = macho();
  writeFileSync(binary, bytes, { mode: 0o755 });
  const manifest = { platform, arch, sourceCommit: commit, sourceTreeDirty: false, sourceSha256: speechSourceFingerprint(sourceRoot), compiler: 'Apple Swift fixture', sha256: sha256(bytes) };
  const save = value => writeFileSync(`${binary}.json`, JSON.stringify(value));
  const validate = () => validateSpeech(root, { platform, arch, sourceRoot });
  save(manifest); assert.equal(validate().sha256, manifest.sha256);
  assert.throws(() => validateSpeech(root, { platform: 'win32', arch: 'x64', sourceRoot }), /only a macOS resource/);
  for (const change of [{ sourceTreeDirty: true }, { sourceSha256: '' }, { compiler: '' }]) {
    save({ ...manifest, ...change }); assert.throws(validate, /clean, identified/);
  }
  save({ ...manifest, arch: 'x64' }); assert.throws(validate, /target mismatch/);
  save(manifest); writeFileSync(join(sourceRoot, 'build.mjs'), 'changed build'); assert.throws(validate, /source fingerprint/);
  writeFileSync(join(sourceRoot, 'build.mjs'), 'build.mjs'); writeFileSync(binary, 'changed binary'); assert.throws(validate, /SHA-256/);
  rmSync(`${binary}.json`); assert.throws(validate, /ENOENT/);
}));

test('macOS recording validation rejects foreign targets, stale sources and modified helpers', () => fixture(root => {
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
  for (const name of ['klaus-recording-helper.m', 'helper-info.plist', 'build.mjs']) writeFileSync(join(sourceRoot, name), name);
  const binary = join(root, 'klaus-recording-helper'), bytes = macho();
  writeFileSync(binary, bytes, { mode: 0o755 });
  const manifest = { platform, arch, sourceCommit: commit, sourceTreeDirty: false, sourceSha256: recordingSourceFingerprint(sourceRoot), compiler: 'Apple clang fixture', sha256: sha256(bytes) };
  const save = value => writeFileSync(`${binary}.json`, JSON.stringify(value));
  const validate = () => validateRecording(root, { platform, arch, sourceRoot });
  save(manifest); assert.equal(validate().sha256, manifest.sha256);
  assert.throws(() => validateRecording(root, { platform: 'win32', arch: 'x64', sourceRoot }), /only a macOS resource/);
  for (const change of [{ sourceTreeDirty: true }, { sourceSha256: '' }, { compiler: '' }]) {
    save({ ...manifest, ...change }); assert.throws(validate, /clean, identified/);
  }
  save({ ...manifest, arch: 'x64' }); assert.throws(validate, /target mismatch/);
  save(manifest); writeFileSync(join(sourceRoot, 'build.mjs'), 'changed build'); assert.throws(validate, /source fingerprint/);
  writeFileSync(join(sourceRoot, 'build.mjs'), 'build.mjs'); writeFileSync(binary, 'changed binary'); assert.throws(validate, /SHA-256/);
  rmSync(`${binary}.json`); assert.throws(validate, /ENOENT/);
}));

test('macOS signing plan permits engine V8 JIT while keeping ordinary helper permissions minimal', () => fixture(root => {
  const app = join(root, 'Klaus.app');
  const options = macSigningOptions({ app, arch: 'arm64', identity: 'Developer ID Application: Fixture (ABCDEFGHIJ)', electronVersion: '44.2.0' });
  assert.equal(options.identityValidation, true); assert.equal(options.binaries.length, 6);
  assert(options.optionsForFile(app).entitlements.includes('com.apple.security.device.audio-input'));
  for (const file of [app, join(app, 'Contents/MacOS/Klaus')]) {
    assert(options.optionsForFile(file).entitlements.includes('com.apple.security.personal-information.photos-library'));
  }
  const speech = options.binaries.find(file => file.endsWith('klaus-speech-helper'));
  const engine = options.binaries.find(file => file.endsWith('klaus-agent-stdio'));
  assert.deepEqual(options.optionsForFile(speech), { hardenedRuntime: true, entitlements: ['com.apple.security.device.audio-input'] });
  assert.deepEqual(options.optionsForFile(engine), { hardenedRuntime: true, entitlements: ['com.apple.security.cs.allow-jit'] });
  assert(options.binaries.includes(join(app, 'Contents/Resources/recording/darwin-arm64/klaus-recording-helper')));
  assert(options.binaries.includes(join(app, 'Contents/Resources/pip/darwin-arm64/klaus-pip-producer')));
  assert(options.binaries.includes(join(app, 'Contents/Resources/computer-use/darwin-arm64/klaus-computer-use-helper')));
  for (const file of options.binaries.filter(file => file !== speech && file !== engine)) assert.deepEqual(options.optionsForFile(file), { hardenedRuntime: true, entitlements: [] });
  assert.throws(() => macSigningOptions({ app, arch: 'x64', identity: 'Developer ID Application: Fixture (ABCDEFGHIJ)', electronVersion: '44.2.0' }), /Unsupported desktop target/);
  assert.deepEqual(options.optionsForFile(join(app, 'Contents/Frameworks/Klaus Helper (Renderer).app')), { hardenedRuntime: true });
  assert.throws(() => options.optionsForFile(join(root, 'foreign-helper')), /outside/);
  assert.throws(() => macSigningOptions({ app, arch: 'arm64', identity: '-', electronVersion: '44.2.0' }), /explicit/);
}));

function pipFixture(root) {
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
  for (const name of ['KlausPIP.h', 'KlausPIPService.m', 'KlausPIPTransport.m', 'producer-main.m', 'helper-info.plist', 'build.mjs']) writeFileSync(join(sourceRoot, name), name);
  const directory = join(root, 'resources/pip/darwin-arm64'); mkdirSync(directory, { recursive: true });
  const binary = join(directory, 'klaus-pip-producer'), bytes = macho();
  writeFileSync(binary, bytes, { mode: 0o755 });
  const manifest = { platform, arch, sourceCommit: commit, sourceTreeDirty: false, sourceSha256: pipSourceFingerprint(sourceRoot), compiler: 'Apple clang fixture', sha256: sha256(bytes) };
  const save = value => writeFileSync(`${binary}.json`, JSON.stringify(value));
  save(manifest);
  return { directory, sourceRoot, binary, bytes, manifest, save };
}

test('PiP validation requires clean complete source proof, executable bytes and the selected architecture', () => fixture(root => {
  const { directory, sourceRoot, binary, bytes, manifest, save } = pipFixture(root);
  const validate = () => validatePip(directory, { platform, arch, sourceRoot });
  assert.equal(validate().sha256, manifest.sha256);
  assert.throws(() => validatePip(directory, { platform: 'win32', arch: 'x64', sourceRoot }), /only a macOS resource/);
  for (const change of [{ sourceTreeDirty: true }, { sourceCommit: '' }, { sourceSha256: '' }, { compiler: '' }]) {
    save({ ...manifest, ...change }); assert.throws(validate, /clean, identified/);
  }
  save({ ...manifest, arch: 'x64' }); assert.throws(validate, /target mismatch/);
  save(manifest);
  for (const name of ['KlausPIP.h', 'KlausPIPService.m', 'KlausPIPTransport.m', 'producer-main.m', 'helper-info.plist', 'build.mjs']) {
    writeFileSync(join(sourceRoot, name), 'changed'); assert.throws(validate, /source fingerprint/);
    writeFileSync(join(sourceRoot, name), name);
  }
  writeFileSync(binary, 'changed'); assert.throws(validate, /SHA-256/);
  const wrongArchitecture = Buffer.from(bytes); wrongArchitecture.writeUInt32LE(0x1000007, 4);
  writeFileSync(binary, wrongArchitecture); save({ ...manifest, sha256: sha256(wrongArchitecture) });
  assert.throws(validate, /Mach-O architecture/);
  writeFileSync(binary, bytes); save(manifest);
  if (process.platform !== 'win32') {
    chmodSync(binary, 0o644); assert.throws(validate, /not executable/); chmodSync(binary, 0o755);
  }
  rmSync(`${binary}.json`); assert.throws(validate, /ENOENT/);
}));

test('PiP resources require their exact target and two files, and reject Windows presence', () => fixture(root => {
  const { binary, directory, manifest } = pipFixture(root), resources = join(root, 'resources');
  const identity = { platform, arch, pip: manifest };
  assert.deepEqual(verifyPipResource(resources, identity), manifest);
  assert.throws(() => verifyPipResource(resources, { ...identity, pip: { ...manifest, sourceCommit: 'b'.repeat(40) } }), /resource identity/);
  writeFileSync(join(directory, 'diagnostic.log'), 'fixture');
  assert.throws(() => verifyPipResource(resources, identity), /resource identity/);
  rmSync(join(directory, 'diagnostic.log'));
  mkdirSync(join(resources, 'pip/darwin-x64')); assert.throws(() => verifyPipResource(resources, identity), /Unexpected PiP producer target/);
  rmSync(join(resources, 'pip/darwin-x64'), { recursive: true });
  rmSync(binary); assert.throws(() => verifyPipResource(resources, identity), /ENOENT/);
  const windows = { platform: 'win32', arch: 'x64' };
  assert.throws(() => verifyPipResource(resources, windows), /leaked into a Windows package/);
  rmSync(join(resources, 'pip'), { recursive: true });
  assert.equal(verifyPipResource(resources, windows), undefined);
  for (const pip of [manifest, null, false]) assert.throws(() => verifyPipResource(resources, { ...windows, pip }), /leaked into a Windows package/);
  symlinkSync(join(resources, 'missing-pip'), join(resources, 'pip'), 'junction');
  assert.throws(() => verifyPipResource(resources, windows), /leaked into a Windows package/);
}));

test('PiP resource validation rejects linked binaries, manifests and target directories', () => fixture(root => {
  const { directory, binary, bytes, manifest } = pipFixture(root), resources = join(root, 'resources');
  const identity = { platform, arch, pip: manifest };
  const foreign = join(root, 'foreign'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'binary'), bytes, { mode: 0o755 });
  rmSync(binary); symlinkSync(join(foreign, 'binary'), binary);
  assert.throws(() => verifyPipResource(resources, identity), /regular files/);
  rmSync(binary); writeFileSync(binary, bytes, { mode: 0o755 });
  writeFileSync(join(foreign, 'manifest.json'), JSON.stringify(manifest));
  rmSync(`${binary}.json`); symlinkSync(join(foreign, 'manifest.json'), `${binary}.json`);
  assert.throws(() => verifyPipResource(resources, identity), /regular files/);
  rmSync(directory, { recursive: true }); symlinkSync(foreign, directory, 'junction');
  assert.throws(() => verifyPipResource(resources, identity), /regular directory/);
}));

function computerUseFixture(root, targetPlatform = platform, targetArch = arch) {
  const sourceRoot = join(root, 'source'); mkdirSync(sourceRoot);
  const sources = targetPlatform === 'win32' ? ['windows-helper.cpp', 'windows-helper.manifest', 'build-windows.mjs'] : ['klaus-computer-use-helper.m', 'lockscreen.m', 'lockscreen.h', 'helper-info.plist', 'build.mjs'];
  for (const name of sources) writeFileSync(join(sourceRoot, name), name);
  const directory = join(root, 'resources/computer-use', `${targetPlatform}-${targetArch}`); mkdirSync(directory, { recursive: true });
  const binary = join(directory, computerUseArtifactName(targetPlatform)), bytes = targetPlatform === 'win32' ? pe() : macho();
  writeFileSync(binary, bytes, { mode: 0o755 });
  const manifest = { platform: targetPlatform, arch: targetArch, sourceCommit: commit, sourceTreeDirty: false, sourceSha256: computerUseSourceFingerprint(sourceRoot, targetPlatform), compiler: targetPlatform === 'win32' ? 'MSVC fixture' : 'Apple clang fixture', sha256: sha256(bytes) };
  const save = value => writeFileSync(`${binary}.json`, JSON.stringify(value));
  save(manifest);
  return { directory, sourceRoot, binary, bytes, manifest, save };
}

test('Computer Use validation requires clean complete source proof, executable bytes and the selected architecture', () => fixture(root => {
  const { directory, sourceRoot, binary, bytes, manifest, save } = computerUseFixture(root);
  const validate = () => validateComputerUse(directory, { platform, arch, sourceRoot });
  assert.equal(validate().sha256, manifest.sha256);
  assert.throws(() => validateComputerUse(directory, { platform: 'win32', arch: 'x64', sourceRoot }), /ENOENT/);
  for (const change of [{ sourceTreeDirty: true }, { sourceCommit: '' }, { sourceSha256: '' }, { compiler: '' }]) {
    save({ ...manifest, ...change }); assert.throws(validate, /clean, identified/);
  }
  save({ ...manifest, arch: 'x64' }); assert.throws(validate, /target mismatch/);
  save(manifest);
  for (const name of ['klaus-computer-use-helper.m', 'lockscreen.m', 'lockscreen.h', 'helper-info.plist', 'build.mjs']) {
    writeFileSync(join(sourceRoot, name), 'changed'); assert.throws(validate, /source fingerprint/);
    writeFileSync(join(sourceRoot, name), name);
  }
  writeFileSync(binary, 'changed'); assert.throws(validate, /SHA-256/);
  const wrongArchitecture = Buffer.from(bytes); wrongArchitecture.writeUInt32LE(0x1000007, 4);
  writeFileSync(binary, wrongArchitecture); save({ ...manifest, sha256: sha256(wrongArchitecture) });
  assert.throws(validate, /Mach-O architecture/);
  writeFileSync(binary, bytes); save(manifest);
  if (process.platform !== 'win32') {
    chmodSync(binary, 0o644); assert.throws(validate, /not executable/); chmodSync(binary, 0o755);
  }
  rmSync(`${binary}.json`); assert.throws(validate, /ENOENT/);
}));

test('Computer Use resources require their exact target and two files, and reject foreign platform presence', () => fixture(root => {
  const { binary, directory, manifest } = computerUseFixture(root), resources = join(root, 'resources');
  const identity = { platform, arch, computerUse: manifest };
  assert.deepEqual(verifyComputerUseResource(resources, identity), manifest);
  assert.throws(() => verifyComputerUseResource(resources, { ...identity, computerUse: { ...manifest, sourceCommit: 'b'.repeat(40) } }), /resource identity/);
  writeFileSync(join(directory, 'diagnostic.log'), 'fixture');
  assert.throws(() => verifyComputerUseResource(resources, identity), /resource identity/);
  rmSync(join(directory, 'diagnostic.log'));
  mkdirSync(join(resources, 'computer-use/darwin-x64')); assert.throws(() => verifyComputerUseResource(resources, identity), /Unexpected Computer Use helper target/);
  rmSync(join(resources, 'computer-use/darwin-x64'), { recursive: true });
  rmSync(binary); assert.throws(() => verifyComputerUseResource(resources, identity), /ENOENT/);
  const windows = { platform: 'win32', arch: 'x64' };
  assert.throws(() => verifyComputerUseResource(resources, windows), /Unexpected Computer Use helper target/);
  rmSync(join(resources, 'computer-use'), { recursive: true });
  assert.throws(() => verifyComputerUseResource(resources, windows), /Unexpected Computer Use helper target/);
  for (const computerUse of [manifest, null, false]) assert.throws(() => verifyComputerUseResource(resources, { ...windows, computerUse }), /Unexpected Computer Use helper target/);
  symlinkSync(join(resources, 'missing-computer-use'), join(resources, 'computer-use'), 'junction');
  assert.throws(() => verifyComputerUseResource(resources, windows), /Unexpected Computer Use helper target/);
}));

test('Windows Computer Use requires the exact three-source fingerprint, clean metadata and x64 PE bytes', () => fixture(root => {
  const { directory, sourceRoot, binary, bytes, manifest, save } = computerUseFixture(root, 'win32', 'x64');
  const validate = () => validateComputerUse(directory, { platform: 'win32', arch: 'x64', sourceRoot });
  assert.deepEqual(validate(), manifest);
  for (const name of ['windows-helper.cpp', 'windows-helper.manifest', 'build-windows.mjs']) {
    writeFileSync(join(sourceRoot, name), 'changed'); assert.throws(validate, /source fingerprint/); writeFileSync(join(sourceRoot, name), name);
  }
  for (const change of [{ sourceTreeDirty: true }, { sourceCommit: '' }, { sourceSha256: '' }, { compiler: '' }]) { save({ ...manifest, ...change }); assert.throws(validate, /clean, identified/); }
  save({ ...manifest, platform: 'darwin' }); assert.throws(validate, /target mismatch/);
  save(manifest); writeFileSync(binary, 'tampered'); assert.throws(validate, /SHA-256/);
  const wrong = Buffer.from(bytes); wrong.writeUInt16LE(0xaa64, 68); writeFileSync(binary, wrong); save({ ...manifest, sha256: sha256(wrong) }); assert.throws(validate, /PE architecture/);
  writeFileSync(binary, macho()); save({ ...manifest, sha256: sha256(macho()) }); assert.throws(validate, /PE header/);
  assert.throws(() => validateComputerUse(directory, { platform: 'win32', arch: 'arm64', sourceRoot }), /Unsupported desktop target/);
}));

test('Windows Computer Use packaging requires its exe and manifest and cannot accept a missing or foreign helper', () => fixture(root => {
  const { directory, binary, manifest } = computerUseFixture(root, 'win32', 'x64'), resources = join(root, 'resources');
  const identity = { platform: 'win32', arch: 'x64', computerUse: manifest };
  assert.deepEqual(verifyComputerUseResource(resources, identity), manifest);
  for (const computerUse of [undefined, null, false, { ...manifest, sourceCommit: 'b'.repeat(40) }]) assert.throws(() => verifyComputerUseResource(resources, { ...identity, computerUse }), /resource identity/);
  writeFileSync(join(directory, 'klaus-computer-use-helper.pdb'), 'private symbols'); assert.throws(() => verifyComputerUseResource(resources, identity), /resource identity/); rmSync(join(directory, 'klaus-computer-use-helper.pdb'));
  mkdirSync(join(resources, 'computer-use/darwin-arm64')); assert.throws(() => verifyComputerUseResource(resources, identity), /Unexpected Computer Use helper target/); rmSync(join(resources, 'computer-use/darwin-arm64'), { recursive: true });
  rmSync(binary); assert.throws(() => verifyComputerUseResource(resources, identity), /ENOENT/);
}));

for (const id of [undefined, 'domestic', 'international']) test(`Windows ${id ?? 'legacy domestic'} package inventory includes edition identity and rejects changed helper bytes`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'klaus-windows-package-test-'));
  try {
    const resources = join(root, 'resources'), appSource = join(root, 'app-source');
    const { binary, manifest: computerUse } = computerUseFixture(root, 'win32', 'x64');
    const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
    for (const file of specification.requiredAppFiles) write(join(appSource, file), '{}');
    for (const file of specification.requiredResourceFiles) write(join(resources, file), '{}');
    for (const name of specification.sharedRoots) if (!existsSync(join(resources, name))) mkdirSync(join(resources, name));
    write(join(resources, 'plugins-seed/known_marketplaces.json'), '{}\n');
    const edition = desktopEdition(id);
    write(join(appSource, 'package.json'), JSON.stringify({ name: 'klaus-desktop', version: '1.2.3', main: 'dist/main/index.js', klausDesktopLayoutVersion: 1,
      ...(id ? { klausDesktopEdition: id, productName: edition.productName } : {}) }));
    if (id) write(join(appSource, 'contracts/desktop-editions.json'), readFileSync(new URL('../contracts/desktop-editions.json', import.meta.url)));
    const artifacts = windowsEngineArtifacts.map(artifact => { const bytes = pe(); write(join(resources, 'bin/win32-x64', artifact.file), bytes); return { ...artifact, sha256: sha256(bytes) }; });
    const engine = { schemaVersion: 2, engineCommit: commit, engineTreeDirty: false, platform: 'win32', arch: 'x64', targetTriple: 'x86_64-pc-windows-msvc', releaseFlagsSha256: 'f'.repeat(64), artifacts,
      policyNotices: policyNoticeFixture(root, join(resources, 'bin/win32-x64')) };
    write(join(resources, 'bin/win32-x64/manifest.json'), JSON.stringify(engine));
    const native = { abiVersion: 1, napiVersion: 9, platform: 'win32', arch: 'x64', sourceCommit: commit, sourceTreeDirty: false, credentialFixtures: false, whatsappFixtures: false, sha256: sha256(pe()) };
    write(join(resources, 'native/klaus-native-win32-x64.node'), pe());
    write(join(resources, 'native/klaus-native-win32-x64.node.json'), JSON.stringify(native));
    const manifest = { layoutVersion: 1, application: edition.productName, ...(id ? { edition: id, applicationId: edition.application } : {}),
      buildKind: 'local-unsigned', platform: 'win32', arch: 'x64', version: '1.2.3', electronVersion: '44.2.0', engine, native, computerUse,
      appFiles: inventory(appSource), resourceFiles: inventory(resources) };
    write(join(resources, 'desktop-resources.json'), JSON.stringify(manifest));
    write(join(root, `${edition.executableName}.exe`), pe());
    await createPackage(appSource, join(resources, 'app.asar'));
    const report = verifyPackage(root);
    assert.equal(report.verified, true);
    assert.equal(report.edition, id ?? 'domestic');
    assert.equal(report.application, edition.application);
    assert.equal(report.computerUseSha256, computerUse.sha256);
    assert.equal(report.resourceFiles, manifest.resourceFiles.length);
    const noticePath = 'bin/win32-x64/licenses/goal-policy/NOTICE';
    assert(manifest.resourceFiles.some(file => file.path === noticePath));
    const notice = join(resources, noticePath), noticeBytes = readFileSync(notice);
    writeFileSync(notice, 'changed attribution');
    assert.throws(() => verifyPackage(root), /Packaged resource hash mismatch: bin\/win32-x64\/licenses\/goal-policy\/NOTICE/);
    writeFileSync(notice, noticeBytes);
    write(join(resources, 'desktop-resources.json'), JSON.stringify({ ...manifest, edition: id === 'international' ? 'domestic' : 'international' }));
    assert.throws(() => verifyPackage(root), /Unknown desktop resource manifest/);
    write(join(resources, 'desktop-resources.json'), JSON.stringify(manifest));
    // A recorded official plugin must be present with its required files, and an
    // unrecorded plugin directory is refused even when its bytes are inventoried.
    write(join(resources, 'desktop-resources.json'), JSON.stringify({ ...manifest, officialPlugins: [{ name: 'sample-editor', version: '1.0.0', skills: ['sample-editor'] }] }));
    assert.throws(() => verifyPackage(root), /Packaged resource is missing: plugins-official\/sample-editor\/plugin.json/);
    const official = join(resources, 'plugins-official/sample-editor');
    for (const file of ['plugin.json', 'runtime/dist/index.html', 'runtime/dist/runtime-manifest.json', 'skills/sample-editor/SKILL.md']) write(join(official, file), '{}');
    write(join(resources, 'desktop-resources.json'), JSON.stringify(manifest));
    assert.throws(() => verifyPackage(root), /Packaged official plugins differ from the resource manifest/);
    write(join(resources, 'desktop-resources.json'), JSON.stringify({ ...manifest, officialPlugins: [{ name: 'sample-editor', version: '1.0.0', skills: ['sample-editor'] }], resourceFiles: inventory(resources).filter(file => !['desktop-resources.json', 'app.asar'].includes(file.path)) }));
    assert.equal(verifyPackage(root).verified, true);
    rmSync(join(resources, 'plugins-official'), { recursive: true });
    write(join(resources, 'desktop-resources.json'), JSON.stringify(manifest));
    const changed = pe(); changed[100] = 1; writeFileSync(binary, changed);
    assert.throws(() => verifyPackage(root), /Packaged resource hash mismatch: computer-use/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Computer Use resource validation rejects linked binaries, manifests and target directories', () => fixture(root => {
  const { directory, binary, bytes, manifest } = computerUseFixture(root), resources = join(root, 'resources');
  const identity = { platform, arch, computerUse: manifest };
  const foreign = join(root, 'foreign'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'binary'), bytes, { mode: 0o755 });
  rmSync(binary); symlinkSync(join(foreign, 'binary'), binary);
  assert.throws(() => verifyComputerUseResource(resources, identity), /regular files/);
  rmSync(binary); writeFileSync(binary, bytes, { mode: 0o755 });
  writeFileSync(join(foreign, 'manifest.json'), JSON.stringify(manifest));
  rmSync(`${binary}.json`); symlinkSync(join(foreign, 'manifest.json'), `${binary}.json`);
  assert.throws(() => verifyComputerUseResource(resources, identity), /regular files/);
  rmSync(directory, { recursive: true }); symlinkSync(foreign, directory, 'junction');
  assert.throws(() => verifyComputerUseResource(resources, identity), /regular directory/);
}));

test('Windows packaging requires the complete artifact set and verifies the pipe addon bytes and architecture', () => fixture(root => {
  const engine = pe(), addon = pe(); addon[100] = 1;
  const addonFile = 'klaus_browser_pipe.node';
  const manifest = { schemaVersion: 2, engineCommit: commit, engineTreeDirty: false, platform: 'win32', arch: 'x64', targetTriple: 'x86_64-pc-windows-msvc', releaseFlagsSha256: 'f'.repeat(64),
    artifacts: windowsEngineArtifacts.map(artifact => ({ ...artifact, sha256: sha256(artifact.role === 'browserPipeAddon' ? addon : engine) })), policyNotices: policyNoticeFixture(root) };
  const save = value => writeFileSync(join(root, 'manifest.json'), JSON.stringify(value));
  const validate = () => validateEngine(root, { platform: 'win32', arch: 'x64', engineCommit: commit });
  for (const artifact of windowsEngineArtifacts) writeFileSync(join(root, artifact.file), artifact.role === 'browserPipeAddon' ? addon : engine);
  save(manifest);
  assert.equal(validate().artifacts.length, 5);
  for (const artifact of windowsEngineArtifacts.filter(item => item.role.startsWith('sandbox'))) {
    rmSync(join(root, artifact.file)); assert.throws(validate, /ENOENT/);
    writeFileSync(join(root, artifact.file), 'tampered'); assert.throws(validate, new RegExp(`SHA-256 mismatch: ${artifact.role}`));
    writeFileSync(join(root, artifact.file), engine);
  }
  for (const artifacts of [manifest.artifacts.slice(0, 1), [...manifest.artifacts, manifest.artifacts[1]]]) {
    save({ ...manifest, artifacts }); assert.throws(validate, /complete schema 2 artifact set/);
  }
  save({ ...manifest, artifacts: manifest.artifacts.map(artifact => artifact.role === 'browserPipeAddon' ? { ...artifact, file: 'klaus_browser_pipe.dll' } : artifact) });
  assert.throws(validate, /browserPipeAddon/);
  save(manifest); rmSync(join(root, addonFile)); assert.throws(validate, /ENOENT/);
  writeFileSync(join(root, addonFile), 'tampered'); assert.throws(validate, /SHA-256 mismatch: browserPipeAddon/);
  const wrongArchitecture = pe(); wrongArchitecture.writeUInt16LE(0xaa64, 68);
  writeFileSync(join(root, addonFile), wrongArchitecture);
  save({ ...manifest, artifacts: manifest.artifacts.map(artifact => artifact.role === 'browserPipeAddon' ? { ...artifact, sha256: sha256(wrongArchitecture) } : artifact) });
  assert.throws(validate, /PE architecture/);
}));

test('copying preserves hidden plugin metadata and inventory notices changed content', () => fixture(root => {
  const source = join(root, 'source'), target = join(root, 'copy');
  mkdirSync(join(source, '.claude-plugin'), { recursive: true });
  writeFileSync(join(source, '.claude-plugin/plugin.json'), '{}');
  copyTree(source, target);
  const original = inventory(target);
  assert.equal(original[0].path, '.claude-plugin/plugin.json');
  writeFileSync(join(target, '.claude-plugin/plugin.json'), '{"changed":true}');
  assert.notEqual(inventory(target)[0].sha256, original[0].sha256);
}));

test('resource symlinks cannot import an external user file', () => fixture(root => {
  const source = join(root, 'source'), target = join(root, 'copy');
  mkdirSync(source); writeFileSync(join(root, 'private.txt'), 'fixture');
  symlinkSync(join(root, 'private.txt'), join(source, 'link'));
  assert.throws(() => copyTree(source, target), /Symlinks/);
  assert.throws(() => inventory(source), /symlink/);
}));
