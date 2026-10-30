import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nativeFingerprint, sha256, validateBinaryTarget, requireTarget } from '../packaging/resources.mjs';
import { createGate, desktopDirectory } from './gate-runner.mjs';

const gate = createGate('native-gate');
const target = requireTarget(process.platform, process.arch), native = join(desktopDirectory, 'native');
const buildTests = readdirSync(join(native, 'scripts')).filter(name => name.endsWith('.test.mjs')).sort();
if (buildTests.length) await gate.run('native-build-tools', process.execPath, [
  '--test', '--test-concurrency=1', ...buildTests.map(name => `native/scripts/${name}`),
]);
const manifestPath = join(native, 'artifacts', `klaus-native-${target}.node.json`);
const fingerprint = () => nativeFingerprint(native);
function currentArtifact() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bytes = readFileSync(manifestPath.slice(0, -5));
  assert.equal(manifest.abiVersion, 1); assert.equal(manifest.napiVersion, 9);
  assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch);
  assert.equal(manifest.credentialFixtures, false); assert.equal(manifest.whatsappFixtures, false);
  assert.equal(manifest.sha256, sha256(bytes));
  for (const [key, value] of Object.entries(fingerprint())) assert.equal(manifest[key], value);
  validateBinaryTarget(bytes, process.platform, process.arch);
  // Working-source artifacts can be tested. Release validation independently
  // requires sourceTreeDirty:false before an artifact can enter an installer.
  return manifest;
}
const cargoArgs = ['--locked', '--manifest-path', join(native, 'Cargo.toml'), '--target-dir', join(native, 'target'), '--workspace', '--all-features'];
const env = { ...process.env, CARGO_BUILD_JOBS: '4' };
await gate.run('clippy', 'cargo', ['clippy', ...cargoArgs, '--all-targets', '--', '-D', 'warnings'], { env });
await gate.run('rust-tests', 'cargo', ['test', ...cargoArgs], { env });
// Exercise optimized native instance handling: debug builds can hide FFI aliasing bugs.
if (process.platform === 'darwin') {
  await gate.run('release-instance-tests', 'cargo', ['test', '--release', '--locked',
    '--manifest-path', join(native, 'Cargo.toml'), '--target-dir', join(native, 'target'),
    '-p', 'klaus-native-core', '--lib', 'instance::'], { env });
}
try { currentArtifact(); }
catch { await gate.run('build-addon', process.execPath, ['native/scripts/build.mjs']); }
const source = currentArtifact();
console.log(JSON.stringify({ nativeArtifact: target, sha256: source.sha256, sourceTreeDirty: source.sourceTreeDirty }));
await gate.run('electron-addon', process.execPath, ['native/scripts/test-electron.mjs']);
await gate.run('electron-instance', process.execPath, ['native/scripts/test-instance.mjs']);
currentArtifact();
gate.finish();
