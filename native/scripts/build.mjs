import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nativeBuildTarget } from './build-target.mjs';
import { publishNativeArtifact } from './publish-artifact.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const debug = process.argv.includes('--debug');
const credentialFixtures = process.argv.includes('--credential-fixtures');
const whatsappFixtures = process.argv.includes('--whatsapp-fixtures');
if (credentialFixtures && whatsappFixtures) throw new Error('Choose one isolated fixture artifact family');
const rustVersion = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
const rustHost = rustVersion.stdout?.match(/^host: (\S+)$/m)?.[1];
if (rustVersion.status !== 0 || !rustHost) throw new Error('Could not identify the Rust host target');
const buildTarget = nativeBuildTarget(process.argv.slice(2), process.platform, process.arch, rustHost);
function sourceFingerprint() {
  const inputs = ['Cargo.toml', 'Cargo.lock', 'core/Cargo.toml', 'binding/Cargo.toml', 'binding/build.rs', 'scripts/build.mjs', 'scripts/build-target.mjs', 'scripts/publish-artifact.mjs'];
  function visit(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.rs')) inputs.push(file);
    }
  }
  visit('core/src'); visit('binding/src'); visit('vendor/wacore-noise/src'); visit('vendor/wacore/src'); visit('vendor/whatsapp-rust/src');
  inputs.push('vendor/wacore-noise/Cargo.toml', 'vendor/wacore/Cargo.toml', 'vendor/whatsapp-rust/Cargo.toml');
  inputs.push('pip/KlausPIP.h', 'pip/KlausPIPHost.m', 'pip/KlausPIPTransport.m');
  inputs.push('permissions/KlausPermissions.h', 'permissions/KlausPermissions.m');
  inputs.push('pets/KlausPetPanel.h', 'pets/KlausPetPanel.m', 'pets/KlausAppshotShortcut.h');
  const hash = createHash('sha256');
  for (const relative of inputs.sort()) hash.update(relative).update('\0').update(readFileSync(path.join(root, relative))).update('\0');
  return hash.digest('hex');
}
const nativeSourceSha256 = sourceFingerprint();
const cargoLockSha256 = createHash('sha256').update(readFileSync(path.join(root, 'Cargo.lock'))).digest('hex');
const sourceCommitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (sourceCommitResult.status !== 0) throw new Error('Could not identify the native source commit');
const sourceCommit = sourceCommitResult.stdout.trim();
const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], { cwd: root, encoding: 'utf8' });
if (status.status !== 0) throw new Error('Could not identify the native source status');
const sourceTreeDirty = status.stdout.trim().length > 0;
const args = ['build', '--locked', '--manifest-path', path.join(root, 'Cargo.toml'), '-p', 'klaus-node'];
if (!debug) args.push('--release');
const targetDir = path.join(root, 'target', ...(credentialFixtures ? ['credential-fixtures'] : whatsappFixtures ? ['whatsapp-fixtures'] : []));
args.push('--target-dir', targetDir);
if (buildTarget.cross) args.push('--target', buildTarget.triple);
if (credentialFixtures) args.push('--features', 'credential-fixtures');
if (whatsappFixtures) args.push('--features', 'whatsapp-fixtures');
const result = spawnSync('cargo', args, {
  cwd: root,
  env: { ...process.env, CARGO_BUILD_JOBS: '4' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (sourceFingerprint() !== nativeSourceSha256) throw new Error('Native source changed during the build; discard this artifact and rebuild');
const library = process.platform === 'win32' ? 'klaus_node.dll'
  : process.platform === 'darwin' ? 'libklaus_node.dylib' : 'libklaus_node.so';
const artifactDir = path.join(root, 'artifacts', ...(credentialFixtures ? ['fixtures'] : whatsappFixtures ? ['whatsapp-fixtures'] : []));
mkdirSync(artifactDir, { recursive: true });
const target = path.join(artifactDir, `klaus-native-${buildTarget.platform}-${buildTarget.arch}.node`);
const source = path.join(targetDir, ...(buildTarget.cross ? [buildTarget.triple] : []), debug ? 'debug' : 'release', library);
if (process.platform === 'darwin') {
  const actual = spawnSync('xcrun', ['lipo', '-archs', source], { encoding: 'utf8' });
  if (actual.status !== 0 || actual.stdout.trim() !== (buildTarget.arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error('Native Mach-O architecture does not match the requested target');
}
const sha256 = publishNativeArtifact(source, target, { abiVersion: 1, napiVersion: 9, platform: buildTarget.platform, arch: buildTarget.arch, targetTriple: buildTarget.triple, credentialFixtures, whatsappFixtures, sourceCommit, sourceTreeDirty, nativeSourceSha256, cargoLockSha256 });
console.log(`Native addon: ${target}`);
console.log(`SHA-256: ${sha256}`);
