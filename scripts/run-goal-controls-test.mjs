import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable, spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { prepareTestEngine } from './prepare-test-engine.mjs';
import { receiveFinalWorkflowCandidate } from './workflow-candidate-receipt.mjs';
import { assertEngineSourceUnchanged, fingerprintEngineSource } from '../engine/scripts/prepare-rust-release.mjs';

const require = createRequire(import.meta.url);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = desktop;
const engineRoot = join(repo, 'engine/klaus-agent-rust');
const platform = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`;
const stagedRoot = join(repo, 'resources/bin', platform);
const logsRoot = join(desktop, 'dist/goal-controls-live-logs');
mkdirSync(logsRoot, { recursive: true });
const logs = mkdtempSync(join(logsRoot, 'run-'));
const gate = join(logs, 'gate.log');
const log = openSync(gate, 'a');
let profile, passed = false;
const args = process.argv.slice(2);
const goalReadsOnly = args.includes('--goal-reads-only');
const requireFinalCandidate = args.includes('--require-final-candidate') || [
  'KLAUS_WORKFLOW_FINAL_APPROVAL', 'KLAUS_WORKFLOW_FINAL_APPROVAL_SHA256',
  'KLAUS_WORKFLOW_LOCAL_RECEIPT', 'KLAUS_WORKFLOW_LOCAL_RECEIPT_SHA256',
].some(key => Object.hasOwn(process.env, key));

function execute(name, executable, args, timeout = 180_000) {
  writeFileSync(log, `\n$ ${JSON.stringify([executable, ...args])}\n`);
  const result = spawnSync(executable, args, { cwd: desktop, stdio: ['ignore', log, log], timeout });
  writeFileSync(log, `exit_code=${result.status}\nsignal=${result.signal ?? ''}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with exit ${result.status}; original output: ${gate}`);
}

function engineSource() {
  if (!existsSync(join(engineRoot, '.git'))) throw new Error('The engine source worktree must be initialized before this fixture can run');
  const read = args => execFileSync('git', args, { cwd: engineRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  if (realpathSync(read(['rev-parse', '--show-toplevel'])) !== realpathSync(engineRoot)) throw new Error('The engine source identity did not resolve to its own worktree');
  return { commit: read(['rev-parse', 'HEAD']), dirty: read(['status', '--short']) !== '', sourceFingerprint: fingerprintEngineSource(engineRoot) };
}

function stagedProof(source) {
  const manifestPath = join(stagedRoot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.engineCommit !== source.commit || manifest.engineTreeDirty !== source.dirty
      || JSON.stringify(manifest.engineSourceFingerprint) !== JSON.stringify(source.sourceFingerprint)) throw new Error('The staged engine manifest does not match the complete current engine source');
  const artifact = manifest.binary ? { file: manifest.binary, sha256: manifest.sha256 } : manifest.artifacts?.find(value => value.role === 'engine');
  if (!artifact || typeof artifact.file !== 'string' || dirname(artifact.file) !== '.' || typeof artifact.sha256 !== 'string') throw new Error('The staged engine manifest has no canonical executable artifact');
  const actual = createHash('sha256').update(readFileSync(join(stagedRoot, artifact.file))).digest('hex');
  if (actual !== artifact.sha256) throw new Error('The staged engine bytes do not match their source-bound manifest');
  return { source, manifest, binarySha256: actual };
}

const required = {
  'goal-reads': ['goal state follows runtime recovery and ready-session selection without inference'],
  'goal-read-recovery': ['a second Electron process hydrates the saved paused goal without inference'],
  lifecycle: [
    'Goal menu entries leave independent planning without inference or persisted goal state',
    'paused Goal summary stays accessible at narrow width and opens a focused persistent editor without inference',
    'whole paste and image preparations preserve exact bytes and pending versus accepted ownership',
    'a real model completion persists one exact generation for the next Electron process',
    'named external completion persists achievement before guarded clear without HTTP inference',
  ],
  recovery: [
    'a second Electron process restores the exact model completion once without inference',
    'a second Electron process restores the exact external completion once without inference',
  ],
};

function validateReport(phase, directory) {
  const path = join(directory, 'results.json');
  if (!existsSync(path)) throw new Error(`${phase} produced no report: ${path}`);
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const names = required[phase];
  if (report.suite !== `goal-controls-${phase}` || report.failed !== 0 || report.info !== 0 || report.passed !== names.length
      || !Array.isArray(report.results) || report.results.length !== names.length
      || names.some(name => report.results.filter(row => row.name === name && row.ok === true).length !== 1)) throw new Error(`Incomplete ${phase} acceptance report: ${path}`);
  return JSON.parse(readFileSync(join(directory, 'process-proof.json'), 'utf8'));
}

try {
  if (args.some(arg => !['--require-final-candidate', '--goal-reads-only'].includes(arg)) || new Set(args).size !== args.length) throw new Error('Unknown or duplicate Goal controls acceptance option');
  if (goalReadsOnly && requireFinalCandidate) throw new Error('A focused read check cannot replace full final-candidate acceptance');
  const candidate = requireFinalCandidate ? receiveFinalWorkflowCandidate(repo) : undefined;
  const before = engineSource();
  if (candidate) assertEngineSourceUnchanged(candidate.engineIdentity, before);
  assertElectronGuiAvailable();
  if (candidate) writeFileSync(join(logs, 'approved-candidate.json'), JSON.stringify({ candidateId: candidate.candidateId,
    approvalSha256: candidate.approvalSha256, localReceiptSha256: candidate.localReceiptSha256 }, null, 2));
  writeFileSync(join(logs, 'engine-source-before.json'), JSON.stringify(before, null, 2));
  prepareTestEngine(repo, { logFile: gate });
  const prepared = engineSource();
  assertEngineSourceUnchanged(before, prepared);
  candidate?.verifySource();
  candidate?.verifyLocal();
  const proof = stagedProof(prepared), proofFile = join(logs, 'engine-proof.json');
  writeFileSync(proofFile, JSON.stringify(proof, null, 2));
  execute('host and fixture build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  execute('native binding build', process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.native-bindings.json']);
  execute('preload build', process.execPath, ['scripts/build-preload.mjs']);
  execute('frontend build', process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', 'vite.config.mts']);
  assertEngineSourceUnchanged(prepared, engineSource());
  profile = mkdtempSync(join(tmpdir(), 'klaus-goal-controls-'));
  candidate?.verifySource();
  candidate?.verifyLocal();
  const processes = [];
  const phases = goalReadsOnly ? ['goal-reads', 'goal-read-recovery'] : ['lifecycle', 'recovery', 'goal-reads', 'goal-read-recovery'];
  for (const phase of phases) {
    const phaseLogs = join(logs, phase); mkdirSync(phaseLogs);
    candidate?.verifySource();
    candidate?.verifyLocal();
    if (JSON.stringify(stagedProof(prepared)) !== JSON.stringify(proof)) throw new Error('The staged engine changed between acceptance phases');
    assertEngineSourceUnchanged(prepared, engineSource());
    const env = { ...process.env, KLAUS_GOAL_CONTROLS_PROFILE: profile, KLAUS_GOAL_CONTROLS_LOGS: phaseLogs, KLAUS_GOAL_CONTROLS_PHASE: phase, KLAUS_GOAL_CONTROLS_ENGINE_PROOF: proofFile };
    delete env.ELECTRON_RUN_AS_NODE;
    writeFileSync(log, `\n$ approved Electron runner dist/tests/goal-controls.integration.js phase=${phase}\n`);
    const child = spawnElectronGuiSync(require('electron'), ['dist/tests/goal-controls.integration.js'], { cwd: desktop, env, stdio: ['ignore', log, log], timeout: 240_000 });
    writeFileSync(log, `exit_code=${child.status}\nsignal=${child.signal ?? ''}\n`);
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`${phase} Electron acceptance failed; retained report and original output: ${phaseLogs}`);
    const processProof = validateReport(phase, phaseLogs);
    if (processProof.phase !== phase || processProof.profile !== profile || processProof.liveEngineCount !== 1
        || processProof.engineProofSha256 !== createHash('sha256').update(readFileSync(proofFile)).digest('hex')) throw new Error(`Invalid ${phase} production runtime proof`);
    processes.push(processProof);
  }
  if (processes.some(proof => !Number.isSafeInteger(proof.processId)) || new Set(processes.map(proof => proof.processId)).size !== phases.length) throw new Error('Each recovery phase must run in a separate Electron process');
  assertEngineSourceUnchanged(prepared, engineSource());
  candidate?.verifySource();
  candidate?.verifyLocal();
  if (JSON.stringify(stagedProof(prepared)) !== JSON.stringify(proof)) throw new Error('The staged engine changed during acceptance');
  writeFileSync(join(logs, 'complete-report.json'), JSON.stringify({ passed: true, goalReadsOnly, candidate: candidate ? { candidateId: candidate.candidateId, approvalSha256: candidate.approvalSha256, localReceiptSha256: candidate.localReceiptSha256 } : null,
    ...goalReadsOnly ? {} : { lifecycle: required.lifecycle, recovery: required.recovery },
    phases: Object.fromEntries(phases.map(phase => [phase, required[phase]])), processes }, null, 2));
  passed = true;
  console.log(`Goal controls lifecycle and second-process recovery passed. Original output: ${gate}`);
} catch (error) {
  writeFileSync(log, `${error instanceof Error ? error.stack : String(error)}\n`);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  closeSync(log);
  if (profile && passed) rmSync(profile, { recursive: true, force: true });
  else if (profile) console.error(`Retained owned failed profile: ${profile}`);
}
