#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { launchPackage } from '../packaging/fixture.mjs';
import { verifyTestPackage } from '../packaging/verify-test-package.mjs';
import { checkLimit, createStageLog, hardware, MEASURE_BUDGETS, MEASURE_BUDGET_SHA256, MEASURE_STAGES, measurementStatus, METHOD } from '../packaging/measurement.mjs';
import { restoreMeasurementPreferences, runMeasurementRound, writeMeasurementFiles } from '../packaging/measure-scenarios.mjs';
import { startMeasurementProvider } from '../packaging/measure-provider.mjs';

// A dangling Promise must never turn an unfinished run into a successful process exit.
process.exitCode = 1;
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  output: { type: 'string' }, rounds: { type: 'string', default: String(MEASURE_BUDGETS.workload.rounds) },
  'idle-seconds': { type: 'string', default: String(MEASURE_BUDGETS.workload.samplesPerStage) }, archive: { type: 'string' },
  receipt: { type: 'string' }, 'profile-renderer': { type: 'boolean', default: false },
} });
if (positionals.length !== 1) throw new Error('Usage: npm run package:measure -- <Klaus.app or Windows package> [--receipt signed.receipt.json] [--output report.json] [--rounds 3] [--idle-seconds 10] [--archive local-review.zip] [--profile-renderer]');
const rounds = Number(values.rounds), samplesPerStage = Number(values['idle-seconds']);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10 || !Number.isInteger(samplesPerStage) || samplesPerStage < 1 || samplesPerStage > 60) throw new Error('Use 1-10 rounds and 1-60 one-second samples per stage; shorter runs remain diagnostic, not acceptance.');
const requestedBundle = resolve(positionals[0]), output = resolve(values.output ?? `${requestedBundle}.measure.json`), rawLogPath = `${output}.stages.jsonl`;
let bundle = requestedBundle;
const report = { schemaVersion: 2, startedAt: new Date().toISOString(), status: 'running', bundle, requestedBundle, output, rawLogPath,
  hardware: hardware(), budgets: MEASURE_BUDGETS, budgetSha256: MEASURE_BUDGET_SHA256, method: METHOD,
  samplesPerStage, requestedRounds: rounds, profileRenderer: values['profile-renderer'], stages: MEASURE_STAGES, rounds: [], errors: [],
  unavailableMetrics: [{ metric: 'energy', scope: 'whole application', reason: METHOD.energy.reason },
    { metric: 'idle-wakeups', scope: 'engine and non-Electron helpers', reason: 'No reliable cumulative wakeup source is available in this runner.' }] };
const controller = new AbortController();
let log, root, runtime, provider, completed = false, safeToRemoveProfile = true;
function persist() {
  const temporary = join(dirname(output), `.${randomUUID()}.measure-report.tmp`);
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, output);
  } finally { rmSync(temporary, { force: true }); }
}
function errorRecord(error) {
  return { message: String(error), stack: error?.stack, ...(error instanceof AggregateError ? { causes: error.errors.map(errorRecord) } : {}), ...(error?.shutdown ? { shutdown: error.shutdown } : {}) };
}
function fail(error, context) {
  const record = { context, ...errorRecord(error) }; report.errors.push(record); log?.append('failure', record, true); persist();
}
function size(path, seen = new Set()) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { logicalBytes: 0, allocatedBytes: 0, files: 0, links: 1 };
  if (stat.isDirectory()) return readdirSync(path).map(name => size(join(path, name), seen)).reduce((sum, value) => ({ logicalBytes: sum.logicalBytes + value.logicalBytes, allocatedBytes: sum.allocatedBytes === null || value.allocatedBytes === null ? null : sum.allocatedBytes + value.allocatedBytes, files: sum.files + value.files, links: sum.links + value.links }), { logicalBytes: 0, allocatedBytes: 0, files: 0, links: 0 });
  const key = `${stat.dev}:${stat.ino}`;
  if (seen.has(key)) return { logicalBytes: 0, allocatedBytes: 0, files: 0, links: 0 };
  seen.add(key);
  return { logicalBytes: stat.size, allocatedBytes: typeof stat.blocks === 'number' ? stat.blocks * 512 : null, files: 1, links: 0 };
}
function runnerSources() {
  return Object.fromEntries(['scripts/measure-package.mjs', 'packaging/measurement.mjs', 'packaging/measure-provider.mjs', 'packaging/measure-renderer.mjs', 'packaging/measure-scenarios.mjs',
    'packaging/process-samples.mjs', 'packaging/fixture.mjs', 'packaging/verify.mjs', 'packaging/resources.mjs', 'packaging/verify-test-package.mjs',
    'packaging/release.mjs', 'packaging/release-receipt.mjs', 'packaging/release-signatures.mjs', 'packaging/release-macos.mjs', 'packaging/release-macho.mjs',
    'packaging/macos-signing.mjs', 'packaging/release-windows.mjs', 'packaging/release-io.mjs'].map(file => [file,
    createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex')]));
}
// Reserve every result path before launching anything; never overwrite an earlier run.
for (const file of [output, rawLogPath, ...Array.from({ length: rounds }, (_, index) => `${output}.round-${index + 1}.app.log`)]) {
  if (existsSync(file)) throw new Error(`Measurement output already exists: ${file}`);
}
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
log = createStageLog(rawLogPath, { bundle, hardware: report.hardware, budgets: MEASURE_BUDGETS, budgetSha256: MEASURE_BUDGET_SHA256, samplesPerStage, requestedRounds: rounds });
const interrupt = signal => { log.append('interrupted', { signal }, true); controller.abort(new Error(`Measurement interrupted by ${signal}`)); };
const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
const beforeExit = () => {
  if (completed) return;
  report.status = 'incomplete'; report.errors.push({ context: 'runner', message: 'Runner stopped with unfinished asynchronous work; no successful summary was produced.' });
  log.append('unfinished-exit', { profile: root ?? null }, true); persist(); log.close(); process.exitCode = 1;
};
process.once('beforeExit', beforeExit);
const watchdog = setTimeout(() => controller.abort(new Error('Measurement run exceeded its bounded deadline')), rounds * (samplesPerStage * MEASURE_STAGES.length + 120) * 1000 + 60000);
try {
  const metadata = await verifyTestPackage(bundle, { receipt: values.receipt });
  if (metadata.target !== `${process.platform}-${process.arch}` || !MEASURE_BUDGETS.targets.includes(metadata.target)) throw new Error('Measurements must run on the package target');
  if (metadata.clientTreeDirty !== false || metadata.recordedEngineCommit !== metadata.engineCommit) throw new Error('Measurements require a clean client candidate with its exact recorded engine');
  bundle = metadata.bundle; report.bundle = bundle;
  report.package = metadata; report.runnerSources = runnerSources(); report.size = size(bundle);
  log.append('package-verified', { package: metadata, runnerSources: report.runnerSources, size: report.size }, true); persist();
  if (values.archive) {
    if (process.platform !== 'darwin') throw new Error('Size-sample ZIP creation uses macOS ditto. Pass a Windows installer through the platform release gate.');
    const archive = resolve(values.archive); if (existsSync(archive)) throw new Error('The archive already exists; select a new output file');
    log.append('size-archive-start', { archive }, true);
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive], { stdio: 'inherit', timeout: 300000 });
    report.archive = { path: archive, bytes: statSync(archive).size, format: 'macOS ditto ZIP, local size sample; no release-signing claim' };
    log.append('size-archive-complete', report.archive, true); persist();
  }
  root = mkdtempSync(join(tmpdir(), 'kpm-')); report.profile = root;
  const files = writeMeasurementFiles(join(root, 'workspace'), MEASURE_BUDGETS.workload.fileCount, MEASURE_BUDGETS.workload.ptyPayloadBytes);
  provider = await startMeasurementProvider(MEASURE_BUDGETS.workload, (type, fields) => log.append(type, fields));
  log.append('fixture-ready', { profile: root, files, provider: provider.origin }, true); persist();
  for (let index = 0; index < rounds; index += 1) {
    controller.signal.throwIfAborted();
    const round = { round: index + 1, freshProfile: index === 0, stages: [], checks: [] }; report.rounds.push(round);
    let preferenceSnapshot;
    round.appLog = `${output}.round-${round.round}.app.log`; writeFileSync(round.appLog, '', { flag: 'wx', mode: 0o600 });
    log.append('round-start', { round: round.round, freshProfile: round.freshProfile, appLog: round.appLog }, true); persist();
    try {
      safeToRemoveProfile = false;
      runtime = await launchPackage(bundle, root, { serverUrl: provider.origin, logPath: round.appLog });
      round.hostReadyMs = runtime.hostReadyMs; round.frontendReadyMs = runtime.frontendReadyMs;
      round.checks.push(checkLimit('frontendReadyMs', round.frontendReadyMs, round.freshProfile ? MEASURE_BUDGETS.limits.freshFrontendReadyMs : MEASURE_BUDGETS.limits.warmFrontendReadyMs, round.freshProfile ? 'fresh isolated profile' : 'reused isolated profile'));
      log.append('frontend-ready', { round: round.round, hostReadyMs: round.hostReadyMs, frontendReadyMs: round.frontendReadyMs }, true); persist();
      round.stages = await runMeasurementRound(runtime, { round: round.round, provider, files, samplesPerStage, log, signal: controller.signal, profileRenderer: report.profileRenderer,
        onStage: stages => { round.stages = [...stages]; persist(); },
        onPreferencesCaptured: snapshot => { preferenceSnapshot = snapshot; } });
      const before = round.stages.find(stage => stage.name === 'idle').summary.rssMeanKiB;
      const after = round.stages.find(stage => stage.name === 'post-cleanup-idle').summary.rssMeanKiB;
      round.checks.push(checkLimit('postCleanupRssGrowthKiB', before == null || after == null ? null : after - before, MEASURE_BUDGETS.limits.postCleanupRssGrowthKiB, 'mean RSS after cleanup minus initial idle mean'));
    } catch (error) {
      round.error = errorRecord(error); if (error.shutdown) { round.shutdown = error.shutdown; safeToRemoveProfile = error.shutdown.remainingProcesses?.length === 0; }
      fail(error, `round ${round.round}`);
    } finally {
      log.append('shutdown-start', { round: round.round }, true);
      if (runtime) {
        try { round.shutdown = await runtime.stop(); }
        catch (error) { if (error.shutdown) round.shutdown = error.shutdown; fail(error, `round ${round.round} shutdown`); }
        finally { runtime = undefined; safeToRemoveProfile = round.shutdown?.remainingProcesses?.length === 0; }
      }
      if (round.shutdown) {
        round.checks.push(checkLimit('shutdownMs', round.shutdown.shutdownMs, MEASURE_BUDGETS.limits.shutdownMs, 'normal app.quit through owned process disappearance'));
        if (round.shutdown.code !== 0 || round.shutdown.forced || round.shutdown.remainingProcesses?.length !== 0) fail(new Error('Application did not exit normally with all observed children drained'), `round ${round.round} shutdown`);
      }
      if (preferenceSnapshot) {
        try {
          const restored = await restoreMeasurementPreferences(root, preferenceSnapshot, round.shutdown);
          round.preferencesRestored = true; log.append('preferences-restored', { round: round.round, restored }, true);
        } catch (error) { round.preferencesRestored = false; fail(error, `round ${round.round} preference restoration`); }
      }
      log.append('round-end', { round }, true); persist();
      console.log(JSON.stringify({ round: round.round, frontendReadyMs: round.frontendReadyMs, stages: round.stages.map(stage => ({ name: stage.name, summary: stage.summary, checks: stage.checks })), shutdownMs: round.shutdown?.shutdownMs, error: round.error ?? null }));
    }
    if (!safeToRemoveProfile || round.error || round.preferencesRestored === false) break;
  }
} catch (error) { fail(error, 'measurement'); }
finally {
  log.append('fixture-cleanup-start', { profile: root ?? null }, true);
  try { if (provider) await provider.close(); } catch (error) { fail(error, 'provider cleanup'); }
  if (root && safeToRemoveProfile) {
    try { rmSync(root, { recursive: true, force: true }); report.profileCleanup = { removed: !existsSync(root), path: root }; }
    catch (error) { fail(error, 'profile cleanup'); }
  } else if (root) { report.profileCleanup = { removed: false, path: root, reason: 'Owned process cleanup was not confirmed; retain the profile for diagnosis.' }; }
  if (controller.signal.aborted) fail(controller.signal.reason, 'interruption or deadline');
  clearTimeout(watchdog); process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm);
  const result = measurementStatus(report); Object.assign(report, result, { completedAt: new Date().toISOString() });
  log.append('run-complete', { ...result, profileCleanup: report.profileCleanup ?? null }, true); persist(); log.close();
  completed = true; process.removeListener('beforeExit', beforeExit); process.exitCode = result.exitCode;
  console.log(`packaged-measure: ${result.status}, ${result.failed.length} budget failures, ${result.unavailable.length} unavailable metrics; report ${output}`);
}
