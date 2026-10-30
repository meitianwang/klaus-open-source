import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { prepareTestEngine } from './prepare-test-engine.mjs';
import { assertEngineSourceUnchanged, fingerprintEngineSource } from '../engine/scripts/prepare-rust-release.mjs';
import { nativeFingerprint, validateBinaryTarget } from '../packaging/resources.mjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = desktop;
const engineRoot = join(repo, 'engine/klaus-agent-rust');
const logsRoot = join(desktop, 'dist/composer-lifecycle-logs');
mkdirSync(logsRoot, { recursive: true });
const logs = mkdtempSync(join(logsRoot, 'run-'));
const gate = join(logs, 'gate.log'), log = openSync(gate, 'a');
let profile, passed = false;
const expected = [
  'first send promotes one virtual chat and persists the authored document',
  'switch and renderer reload preserve submitted identities and an independent draft',
  'native recall restores the complete document in its owning chat',
  'uploaded image and pasted text survive real send and history reload',
  'inline edit cancellation preserves the ordinary composer draft',
  'inline edit refusal retains the edit for retry and persists fixed attachments',
  'delayed send preflight cannot consume another running chat draft',
  'Chromium composition commits persist without a later keystroke',
  'composing keys retain their main and inline editor owners',
  'retired document restoration rejects a late composition notification',
  'side composition retains its committed draft across real side chat switches',
  'native directory and same-name image survive send reload and inline editing',
  'native directory drop and first send stay owned by the active side chat',
  'archiving the current chat cannot transfer its live tray into the welcome draft',
  'pasted card actions preserve rich main and side input with native history',
  'pending side input promotes once and queued editing preserves its real host owner',
  'interrupted queued input remains complete before process shutdown',
  'normal shutdown checkpoints independent durable drafts without recreating their input',
];
const restartExpected = [
  'a new process restores exact welcome and main documents without runtime trays',
  'cold-start recall restores the submitted document in its original owner',
  'a paused queue restores and explicitly replays its exact durable input once',
  'cold archived content stays read-only and supports an independent edit after restoration',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function execute(name, args, timeout = 180_000) {
  writeFileSync(log, `\nCOMMAND: ${JSON.stringify([process.execPath, ...args])}\n`);
  const result = spawnSync(process.execPath, args, { cwd: desktop, stdio: ['ignore', log, log], timeout });
  writeFileSync(log, `EXIT: ${result.status}; SIGNAL: ${result.signal ?? ''}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${name} failed; original output: ${gate}`);
}
function sourceIdentity() {
  const git = args => execFileSync('git', args, { cwd: engineRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
  if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(engineRoot)) throw Error('Engine source is not its own initialized worktree');
  return { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--short']) !== '', sourceFingerprint: fingerprintEngineSource(engineRoot) };
}
function engineProof(source) {
  const directory = join(repo, 'resources/bin', `${process.platform}-${process.arch}`);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.engineCommit !== source.commit || manifest.engineTreeDirty !== source.dirty
      || JSON.stringify(manifest.engineSourceFingerprint) !== JSON.stringify(source.sourceFingerprint)) throw Error('Staged engine does not match the current complete source');
  if (typeof manifest.binary !== 'string' || dirname(manifest.binary) !== '.') throw Error('Missing canonical engine executable');
  const bytes = readFileSync(join(directory, manifest.binary));
  if (sha256(bytes) !== manifest.sha256) throw Error('Engine executable differs from its manifest');
  validateBinaryTarget(bytes, process.platform, process.arch);
  return { source, manifest };
}
function nativeProof() {
  const nativeRoot = join(desktop, 'native');
  const path = join(nativeRoot, 'artifacts', `klaus-native-${process.platform}-${process.arch}.node`);
  const manifest = JSON.parse(readFileSync(path + '.json', 'utf8'));
  const fingerprint = nativeFingerprint(nativeRoot);
  if (manifest.abiVersion !== 1 || manifest.napiVersion !== 9 || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.credentialFixtures !== false || manifest.whatsappFixtures !== false
      || manifest.nativeSourceSha256 !== fingerprint.nativeSourceSha256 || manifest.cargoLockSha256 !== fingerprint.cargoLockSha256) throw Error('Production native artifact does not match the current sources');
  const bytes = readFileSync(path);
  if (sha256(bytes) !== manifest.sha256) throw Error('Native executable differs from its manifest');
  validateBinaryTarget(bytes, process.platform, process.arch);
  return manifest;
}
try {
  if (process.argv.length !== 2) throw Error('This fixture accepts no arguments');
  writeFileSync(log, 'COMMAND: Electron GUI preflight\n');
  assertElectronGuiAvailable();
  writeFileSync(log, 'Electron GUI test preflight passed.\n');
  const before = sourceIdentity();
  prepareTestEngine(repo, { logFile: gate });
  assertEngineSourceUnchanged(before, sourceIdentity());
  const proof = { engine: engineProof(before), native: nativeProof() };
  writeFileSync(join(logs, 'artifact-proof.json'), JSON.stringify(proof, null, 2));
  execute('host and fixture build', [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  execute('native binding build', [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.native-bindings.json']);
  execute('preload build', ['scripts/build-preload.mjs']);
  execute('frontend build', [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', 'vite.config.mts']);
  profile = mkdtempSync(join(tmpdir(), 'klaus-composer-lifecycle-'));
  const env = { ...process.env, KLAUS_COMPOSER_LIFECYCLE_PROFILE: profile, KLAUS_COMPOSER_LIFECYCLE_LOGS: logs };
  const processProof = [];
  for (const [phase, suite, cases] of [['seed', 'composer-lifecycle-app', expected], ['restore', 'composer-lifecycle-restart', restartExpected]]) {
    const phaseLogs = phase === 'seed' ? logs : join(logs, 'restarted');
    mkdirSync(phaseLogs, { recursive: true });
    writeFileSync(log, `\nCOMMAND: approved Electron runner dist/tests/composer-lifecycle-app.integration.js; phase=${phase}\n`);
    const result = spawnElectronGuiSync(require('electron'), ['dist/tests/composer-lifecycle-app.integration.js'], {
      cwd: desktop, env: { ...env, KLAUS_COMPOSER_LIFECYCLE_PHASE: phase, KLAUS_COMPOSER_LIFECYCLE_LOGS: phaseLogs },
      stdio: ['ignore', log, log], timeout: 240_000,
    });
    writeFileSync(log, `PID: ${result.pid}; EXIT: ${result.status}; SIGNAL: ${result.signal ?? ''}\n`);
    if (result.error) throw result.error;
    const report = JSON.parse(readFileSync(join(phaseLogs, 'results.json'), 'utf8'));
    if (result.status !== 0 || report.suite !== suite || report.failed !== 0 || report.info !== 0
        || report.passed !== cases.length || report.results.length !== cases.length
        || cases.some(name => report.results.filter(row => row.name === name && row.ok === true).length !== 1)) throw Error(`The complete ${phase} lifecycle report did not pass`);
    processProof.push({ phase, pid: result.pid, suite, passed: report.passed });
  }
  if (processProof[0].pid === processProof[1].pid) throw Error('Restart did not create a distinct application process');
  writeFileSync(join(logs, 'process-proof.json'), JSON.stringify(processProof, null, 2));
  assertEngineSourceUnchanged(before, sourceIdentity());
  if (JSON.stringify({ engine: engineProof(before), native: nativeProof() }) !== JSON.stringify(proof)) throw Error('Runtime artifacts changed during acceptance');
  passed = true;
  console.log(`Composer lifecycle: ${expected.length} seed and ${restartExpected.length} restarted cases passed in two processes. Original output: ${gate}`);
} catch (error) {
  writeFileSync(log, `${error instanceof Error ? error.stack : String(error)}\n`);
  console.error(`${error instanceof Error ? error.message : error}\nOriginal output: ${gate}`);
  process.exitCode = 1;
} finally {
  closeSync(log);
  if (profile && passed) rmSync(profile, { recursive: true, force: true });
  else if (profile) console.error(`Retained owned failed profile: ${profile}`);
}
