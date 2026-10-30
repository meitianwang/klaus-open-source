import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertElectronGuiAvailable } from './electron-test-preflight.cjs';
import { nativeFingerprint, validateBinaryTarget } from '../packaging/resources.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = desktop;
const artifactFlag = process.argv.indexOf('--artifact-root');
const artifactRoot = artifactFlag >= 0 ? resolve(process.argv[artifactFlag + 1]) : repo;
const logs = join(desktop, 'dist/queue-card-audit-logs');
const buildOnly = process.argv.includes('--build-only');
const require = createRequire(import.meta.url);
mkdirSync(logs, { recursive: true });
if (existsSync(join(logs, 'results.json')) || existsSync(join(logs, 'diagnostics.json'))) {
  const previous = existsSync(join(logs, 'results.json')) ? JSON.parse(readFileSync(join(logs, 'results.json'), 'utf8')) : { failed: true };
  const attempt = join(logs, 'attempts', `${Date.now()}-${previous.failed ? 'failed' : 'passed'}`);
  mkdirSync(attempt, { recursive: true });
  for (const name of readdirSync(logs).filter(name => /^(case-\d+\.(json|png)|results\.json|diagnostics\.json|workbench\.png|progress\.log|gate\.log)$/.test(name))) {
    if (existsSync(join(logs, name))) copyFileSync(join(logs, name), join(attempt, name));
  }
}
const gate = join(logs, 'gate.log');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const command = (args, env = process.env, timeout = 180000) => {
  appendFileSync(gate, `$ ${[process.execPath, ...args].join(' ')}\n`);
  const result = spawnSync(process.execPath, args, { cwd: desktop, env, encoding: 'utf8', timeout, maxBuffer: 24 * 1024 * 1024 });
  appendFileSync(gate, `${result.stdout || ''}${result.stderr || ''}\nExit: ${result.status}\n`);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Fixture command failed with exit ${result.status}`);
};
function stageVerifiedArtifacts() {
  const platform = `${process.platform}-${process.arch}`;
  const sourceNative = join(artifactRoot, 'native/artifacts', `klaus-native-${platform}.node`);
  const nativeManifest = JSON.parse(readFileSync(sourceNative + '.json', 'utf8'));
  const nativeBytes = readFileSync(sourceNative);
  assert.equal(nativeManifest.abiVersion, 1); assert.equal(nativeManifest.napiVersion, 9);
  assert.equal(nativeManifest.platform, process.platform); assert.equal(nativeManifest.arch, process.arch);
  assert.equal(nativeManifest.credentialFixtures, false); assert.equal(nativeManifest.whatsappFixtures, false);
  assert.equal(nativeManifest.sha256, sha(nativeBytes)); validateBinaryTarget(nativeBytes, process.platform, process.arch);
  for (const [key, value] of Object.entries(nativeFingerprint(join(desktop, 'native')))) assert.equal(nativeManifest[key], value, `Native source fingerprint ${key}`);
  const sourceEngine = join(artifactRoot, 'resources/bin', platform);
  const manifest = JSON.parse(readFileSync(join(sourceEngine, 'manifest.json'), 'utf8'));
  const pin = spawnSync('git', ['ls-tree', 'HEAD', 'engine/klaus-agent-rust'], { cwd: repo, encoding: 'utf8' });
  if (pin.status !== 0) throw Error('Cannot identify the engine source pin');
  const engineCommit = /^160000 commit ([0-9a-f]{40})\t/.exec(pin.stdout)?.[1];
  assert.equal(manifest.engineCommit, engineCommit, 'Staged engine must match this checkout engine pin');
  assert.equal(manifest.engineTreeDirty, false, 'Staged engine must identify a clean source tree');
  const artifacts = manifest.artifacts || [{ file: manifest.binary, sha256: manifest.sha256 }];
  for (const artifact of artifacts) assert.equal(sha(readFileSync(join(sourceEngine, artifact.file))), artifact.sha256, `Engine artifact ${artifact.file}`);
  const binary = join(sourceEngine, manifest.binary || 'klaus-agent-stdio.exe');
  const identity = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(identity.status, 0); assert(String(identity.stdout).includes(`engine build ${engineCommit}`), 'Engine binary embeds its declared source commit');
  const targetEngine = join(repo, 'resources/bin', platform);
  mkdirSync(targetEngine, { recursive: true }); mkdirSync(join(desktop, 'native/artifacts'), { recursive: true });
  const copy = (source, destination) => {
    if (existsSync(destination) && realpathSync(source) === realpathSync(destination)) return;
    const temporary = `${destination}.${process.pid}.copying`;
    copyFileSync(source, temporary); renameSync(temporary, destination);
  };
  for (const artifact of artifacts) copy(join(sourceEngine, artifact.file), join(targetEngine, artifact.file));
  copy(join(sourceEngine, 'manifest.json'), join(targetEngine, 'manifest.json'));
  copy(sourceNative, join(desktop, 'native/artifacts', `klaus-native-${platform}.node`));
  copy(sourceNative + '.json', join(desktop, 'native/artifacts', `klaus-native-${platform}.node.json`));
  const evidence = { engineCommit, engineSha256: manifest.sha256, nativeSha256: nativeManifest.sha256, nativeSourceSha256: nativeManifest.nativeSourceSha256, engineIdentity: identity.stdout.trim() };
  appendFileSync(gate, `Verified production artifacts: ${JSON.stringify(evidence)}\n`); console.log('Verified production artifacts:', JSON.stringify(evidence));
}
let profile;
let success = false;
try {
  if (!buildOnly) assertElectronGuiAvailable();
  stageVerifiedArtifacts();
  command([require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  command([join(desktop, 'scripts/build-preload.mjs')]);
  command([join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', join(desktop, 'vite.config.mts')]);
  if (!buildOnly) {
    profile = mkdtempSync(join(tmpdir(), 'klaus-queue-card-app-'));
    const env = { ...process.env, KLAUS_CONFIG_DIR: profile, KLAUS_QUEUE_CARD_FIXTURE_PROFILE: profile, KLAUS_QUEUE_CARD_FIXTURE_LOGS: logs };
    command([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'dist/tests/queue-card-app.integration.js')], env, 360000);
    const result = JSON.parse(readFileSync(join(logs, 'results.json'), 'utf8'));
    assert.equal(result.suite, 'queue-card-app'); assert.equal(result.failed, 0); assert.equal(result.passed, 8);
  }
  success = true;
} catch (error) {
  appendFileSync(gate, `${error?.stack || error}\n`); console.error(error); process.exitCode = 1;
} finally {
  if (profile && success) rmSync(profile, { recursive: true, force: true });
  else if (profile) console.error(`Retained failed queue card profile: ${profile}`);
}
