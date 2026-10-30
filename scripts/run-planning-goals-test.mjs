import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { assertEngineSourceUnchanged, fingerprintEngineSource } from '../engine/scripts/prepare-rust-release.mjs';
import { receiveFinalWorkflowCandidate } from './workflow-candidate-receipt.mjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logs = join(desktop, 'dist/planning-goals-live-logs');
mkdirSync(logs, { recursive: true });
const gate = join(logs, 'gate.log');
const args = process.argv.slice(2);
const buildOnly = args.includes('--build-only');
const requireFinalCandidate = args.includes('--require-final-candidate') || [
  'KLAUS_WORKFLOW_FINAL_APPROVAL', 'KLAUS_WORKFLOW_FINAL_APPROVAL_SHA256',
  'KLAUS_WORKFLOW_LOCAL_RECEIPT', 'KLAUS_WORKFLOW_LOCAL_RECEIPT_SHA256',
].some(key => Object.hasOwn(process.env, key));
const log = openSync(gate, 'a');
const execute = (name, executable, args, timeout = 180_000) => {
  writeFileSync(log, `\n$ ${[executable, ...args].join(' ')}\n`);
  const result = spawnSync(executable, args, { cwd: desktop, stdio: ['ignore', log, log], timeout });
  writeFileSync(log, `exit_code=${result.status}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with exit ${result.status}; original output: ${gate}`);
};

function engineSource() {
  const cwd = resolve(desktop, 'engine/klaus-agent-rust');
  if (!existsSync(join(cwd, '.git'))) throw new Error('The engine source worktree must be initialized before this fixture can run');
  const git = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const read = args => execFileSync(git, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (realpathSync(read(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(cwd)) throw new Error('The engine source identity did not resolve to its own worktree');
  return { commit: read(['rev-parse', 'HEAD']).trim(), dirty: read(['status', '--short']) !== '',
    sourceFingerprint: fingerprintEngineSource(cwd) };
}

function stagedProof(source) {
  const platform = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`;
  const directory = resolve(desktop, `resources/bin/${platform}`);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.engineCommit !== source.commit || manifest.engineTreeDirty !== source.dirty
      || JSON.stringify(manifest.engineSourceFingerprint) !== JSON.stringify(source.sourceFingerprint)) throw new Error('The staged engine manifest does not match the complete current engine source');
  const artifact = manifest.binary ? { file: manifest.binary, sha256: manifest.sha256 } : manifest.artifacts?.find(value => value.role === 'engine');
  if (!artifact || typeof artifact.file !== 'string' || dirname(artifact.file) !== '.' || typeof artifact.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('The staged engine manifest has no canonical executable artifact');
  const actual = createHash('sha256').update(readFileSync(join(directory, artifact.file))).digest('hex');
  if (actual !== artifact.sha256) throw new Error('The staged engine bytes do not match their source-bound manifest');
  return { source, manifest, binarySha256: actual };
}

let profile;
let passed = false;
let completed = false;
let candidate;
try {
  if (args.some(arg => !['--build-only', '--require-final-candidate'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Unknown or duplicate planning/goal acceptance option');
  if (buildOnly && requireFinalCandidate) throw new Error('Final candidate reception requires a live run; build-only cannot accept the final-candidate flag or receipt inputs');
  if (!buildOnly) {
    if (requireFinalCandidate) {
      candidate = receiveFinalWorkflowCandidate(desktop);
      assertEngineSourceUnchanged(candidate.engineIdentity, engineSource());
      writeFileSync(join(logs, 'approved-candidate.json'), JSON.stringify({
        purpose: candidate.purpose, candidateId: candidate.candidateId,
        approvalSha256: candidate.approvalSha256, localReceiptSha256: candidate.localReceiptSha256,
        engineIdentity: candidate.engineIdentity,
      }, null, 2));
    }
    assertElectronGuiAvailable();
  }
  execute('host build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  execute('native binding build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.native-bindings.json']);
  execute('preload build', process.execPath, ['scripts/build-preload.mjs']);
  execute('frontend build', process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', 'vite.config.mts']);
  if (!buildOnly) {
    candidate?.verifySource();
    candidate?.verifyLocal();
    const source = engineSource();
    if (candidate) assertEngineSourceUnchanged(candidate.engineIdentity, source);
    writeFileSync(join(logs, 'engine-source-before.json'), JSON.stringify(source, null, 2));
    execute('current engine preparation', process.execPath, ['engine/scripts/prepare-rust-release.mjs', '--dev'], 900_000);
    const preparedSource = engineSource();
    writeFileSync(join(logs, 'engine-source-after.json'), JSON.stringify(preparedSource, null, 2));
    assertEngineSourceUnchanged(source, preparedSource);
    const proof = stagedProof(preparedSource);
    writeFileSync(join(logs, 'engine-proof.json'), JSON.stringify(proof, null, 2));
    const platform = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`;
    const manifest = resolve(desktop, `resources/bin/${platform}/manifest.json`);
    writeFileSync(join(logs, 'engine-build-manifest.json'), readFileSync(manifest));
    const resultFile = join(logs, 'results.json');
    rmSync(resultFile, { force: true });
    profile = realpathSync(mkdtempSync(join(tmpdir(), 'klaus-planning-goals-')));
    const env = { ...process.env, KLAUS_WORKFLOW_FIXTURE_PROFILE: profile, KLAUS_WORKFLOW_FIXTURE_LOGS: logs };
    delete env.ELECTRON_RUN_AS_NODE;
    assertEngineSourceUnchanged(preparedSource, engineSource());
    if (JSON.stringify(stagedProof(preparedSource)) !== JSON.stringify(proof)) throw new Error('The staged engine changed before application acceptance');
    candidate?.verifySource();
    candidate?.verifyLocal();
    writeFileSync(log, '\n$ approved Electron runner dist/tests/planning-goals.integration.js\n');
    const result = spawnElectronGuiSync(require('electron'), ['dist/tests/planning-goals.integration.js'], {
      cwd: desktop, env, stdio: ['ignore', log, log], timeout: 240_000,
    });
    writeFileSync(log, `exit_code=${result.status}\n`);
    if (result.error) throw result.error;
    assertEngineSourceUnchanged(preparedSource, engineSource());
    if (JSON.stringify(stagedProof(preparedSource)) !== JSON.stringify(proof)) throw new Error('The staged engine changed during application acceptance');
    if (result.status !== 0 || !existsSync(resultFile)) throw new Error(`Planning/goal application acceptance failed; original output: ${gate}`);
    const report = JSON.parse(readFileSync(resultFile, 'utf8'));
    const required = [
      'the isolated production frontend and single engine are ready',
      'planning questions, streamed proposal, edited acceptance and execution use the ordinary engine',
      'plan feedback replaces the proposal and Escape exits without implementation',
      'goal continuation, pause, edit, resume and completion converge across the real application',
      'reopening the isolated runtime restores history without resurrecting completed work',
      'paused goal budgets, rich objective save and clear preserve authoritative identity',
      'a real goal ceiling admits one wrap-up and keeps terminal accounting',
      'actual allowance and request errors stop goals with distinct recovery controls',
      'materialized objectives remain complete and readable through the actual engine',
    ];
    if (report.suite !== 'planning-goals-live' || report.failed !== 0 || report.info !== 0 || report.passed !== required.length
        || !Array.isArray(report.results) || report.results.length !== required.length
        || required.some(name => report.results.filter(row => row.name === name && row.ok === true).length !== 1)) {
      throw new Error(`Incomplete planning/goal acceptance receipt: ${resultFile}`);
    }
    candidate?.verifySource();
    candidate?.verifyLocal();
    passed = true;
  }
  completed = true;
} catch (error) {
  writeFileSync(log, `${error instanceof Error ? error.stack : String(error)}\n`);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (candidate) {
    for (const [name, verify] of [
      ['final approved source', candidate.verifySource],
      ['final local output', candidate.verifyLocal],
      ['final engine source', () => assertEngineSourceUnchanged(candidate.engineIdentity, engineSource())],
    ]) {
      try { verify(); }
      catch (error) {
        writeFileSync(log, `${name}: ${error instanceof Error ? error.stack : String(error)}\n`);
        console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        passed = false;
        completed = false;
        process.exitCode = 1;
      }
    }
  }
  closeSync(log);
  if (profile && passed) rmSync(profile, { recursive: true, force: true });
  else if (profile) console.error(`Retained owned failed profile: ${profile}`);
}

if (completed) console.log(`Planning/goal ${buildOnly ? 'fixture build' : 'application acceptance'} passed. Original output: ${gate}`);
