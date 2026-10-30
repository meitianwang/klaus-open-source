import assert from 'node:assert/strict';
import { copyFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { inspectInputs } from './update-macos-inputs.mjs';
import { GUARD_LEASE, inspectEnvironmentSnapshot, inspectListener, jobState, macProcesses, snapshotEnvironment } from './update-macos-environment.mjs';
import { cleanEnvironment, inspectLease, ownedShipItJob, reserveEnvironment } from './update-macos-cleanup.mjs';
import { preserveMacData, restoreMacData } from './update-macos-preserve.mjs';
import { fixtureTlsMaterial, updateServer } from './update-macos-transport.mjs';
import { launchFirst, observeRestart } from './update-macos-runtime.mjs';
import { assertSuccessfulReport, negativeCacheChecks, observeNativeUpdater, observeProcessExit, seedBusiness, seedUnverifiedCache, verifyBusiness, verifyProductionGuard } from './update-macos-scenario.mjs';
import { verifyReceiptIntegrity } from './release-receipt.mjs';
import { runTool } from './release-io.mjs';
import { until } from './fixture.mjs';

/** The named local account may preserve its existing data before using disposable app copies. */
export async function runMacUpdateAcceptance(options, record) {
  const report = { schemaVersion: 1, kind: 'electron-macos-update-acceptance', mode: options.execute ? 'execute' : 'preflight',
    complete: false, realInstallation: false, verified: {}, cleanup: { complete: true, resourcesCreated: false } };
  let initial, environment, preserved, server, first, second, spawned, handoffStarted = false, stage = 'preflight';
  const phase = (name, detail = {}) => { options.signal?.throwIfAborted(); stage = name; record(name, detail); };
  const inspect = async (preserveExisting = options.preserveExisting) => {
    const snapshot = await snapshotEnvironment();
    if (snapshot.paths.some(path => path.path === GUARD_LEASE && path.present)) snapshot.lease = await inspectLease(snapshot.uid);
    return inspectEnvironmentSnapshot(snapshot, { ...options, preserveExisting });
  };
  try {
    phase('environment-preflight');
    initial = await inspect();
    report.account = { username: initial.username, uid: initial.uid, home: initial.home };
    phase('environment-empty', initial);
    const inputs = await inspectInputs({ ...options, record }); report.verified.signedInputs = true;
    const listener = inspectListener(inputs.port); record('fixture-listener-preflight', listener);
    if (listener.busy) throw new Error('The signed fixture HTTPS port is occupied; no namespace was created');
    await fixtureTlsMaterial(inputs.origin, options);
    report.releases = { first: inputs.first.version, second: inputs.second.version, arch: inputs.arch, teamId: inputs.teamId, origin: inputs.origin };
    phase('signed-inputs-verified', report.releases);
    if (!options.execute) { report.preflightPassed = true; phase('preflight-only', { installationPerformed: false }); return report; }
    initial = await inspect();
    if (options.preserveExisting) {
      preserved = await preserveMacData(initial, record);
      report.preservedData = { root: preserved.root, entries: preserved.entries.length, restored: false };
    }
    // Verify emptiness again immediately before reserving any fixed product name.
    initial = await inspect(false);
    environment = await reserveEnvironment(initial); report.environment = environment;
    report.cleanup = { complete: false, resourcesCreated: true };
    phase('owned-environment-created', { root: environment.root, profile: environment.profile });
    await runTool('/usr/bin/ditto', [inputs.firstBundle, environment.bundle], { timeoutMs: 180_000 });
    await verifyReceiptIntegrity(environment.bundle, inputs.firstReceipt);
    await seedUnverifiedCache(environment);
    server = await updateServer(inputs, { cert: options.cert, key: options.key, record });
    phase('launch-e1');
    first = await launchFirst({ ...environment, ca: resolve(options.ca), version: inputs.first.version,
      log: `${options.journal}.e1.log`, record, onSpawn: child => { spawned = child; } });
    await verifyProductionGuard(environment, record); report.verified.productionGuard = true;
    await observeNativeUpdater(first, options.journal);
    const status = await first.invoke('updater:status');
    assert.equal(status.supported, true, `Signed default-profile updates are unavailable: ${status.error}`);
    const fixture = await seedBusiness(first, environment, inputs.origin, record); report.businessFixture = fixture;
    phase('negative-cache-checks');
    await negativeCacheChecks(first, environment, inputs, server, record, options.signal); report.verified.cacheNegativeChecks = true;
    // Ownership is checked immediately before Squirrel can submit its fixed launchd label.
    for (const domain of [`gui/${initial.uid}`, `user/${initial.uid}`]) assert.equal(jobState(domain).present, false);
    phase('real-install-handoff'); handoffStarted = true; report.installationAttempted = true;
    const since = Date.now(); await first.beginInstall();
    const seenJobs = new Set(), seenPids = new Set();
    let inspectorDetached = false;
    await until(async () => {
      options.signal?.throwIfAborted();
      for (const row of macProcesses().filter(item => item.executable.startsWith(`${environment.root}/`))) {
        if (!seenPids.has(row.pid)) { seenPids.add(row.pid); record('handoff-process', row); }
      }
      for (const domain of [`gui/${initial.uid}`, `user/${initial.uid}`]) {
        const job = jobState(domain);
        if (job.present && !seenJobs.has(domain)) {
          assert(ownedShipItJob(job, environment.bundle, environment.home), 'Squirrel registered an unexpected installation target');
          seenJobs.add(domain); record('shipit-job', job);
        }
      }
      if (first.exit()) return first.exit();
      // A connected Node inspector keeps Electron alive after app.quit().
      // Disconnect only after the native updater has committed to its handoff.
      if (!inspectorDetached) {
        const events = (await readFile(options.journal, 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        if (events.some(item => item.stage === 'native-updater' && item.name === 'before-quit-for-update')) {
          first.inspector.close(); inspectorDetached = true;
          record('test-inspector-detached-after-handoff', { pid: first.pid });
        }
      }
      if (inspectorDetached) return false;
      try {
        const result = await first.inspector.evaluate('globalThis.__updateInstallResult');
        if (result?.error || result?.value?.ok === false) throw new Error(`Production install rejected: ${result.error ?? result.value.error}`);
      } catch (error) { if (!/Inspector disconnected/.test(String(error))) throw error; }
      return false;
    }, 180_000, 'the actual E1 updater exit');
    assert.deepEqual(await first.exited, { code: 0, signal: null }); report.verified.firstExited = true;
    first.inspector.close();
    const nativeEvents = (await readFile(options.journal, 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).filter(item => item.stage === 'native-updater');
    assert(nativeEvents.some(item => item.name === 'update-downloaded'));
    assert(nativeEvents.some(item => item.name === 'before-quit-for-update'));
    assert(seenJobs.size > 0, 'The real ShipIt launchd handoff was not observed'); report.verified.squirrelDownloaded = true;
    phase('wait-automatic-e2');
    second = await observeRestart({ firstPid: first.pid, executable: first.executable, profile: environment.profile, version: inputs.second.version, since, record, signal: options.signal });
    report.verified.automaticRestart = true;
    await verifyReceiptIntegrity(environment.bundle, inputs.secondReceipt); report.verified.secondReceipt = true; report.realInstallation = true;
    await verifyBusiness(second, fixture, record); report.verified.businessPreserved = true;
    assert.equal((await second.invoke('updater:status')).currentVersion, inputs.second.version);
    await observeProcessExit(second, options.journal);
    phase('normal-e2-exit', { pid: second.pid });
    await second.quit();
    await until(() => !macProcesses().some(row => row.pid === second.pid && row.executable === first.executable), 30_000, 'normal E2 exit');
    const exits = (await readFile(options.journal, 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert(exits.some(item => item.stage === 'process-exit' && item.pid === second.pid && item.code === 0), 'E2 did not record a normal process exit');
    report.verified.secondExited = true;
  } catch (error) { report.failure = { stage, error: String(error), reasons: error.reasons }; record('failed', report.failure); }
  finally {
    if (environment) {
      try { await copyFile(join(environment.profile, 'electron-host.log'), `${options.journal}.host.log`); }
      catch (error) { if (error.code !== 'ENOENT') record('host-log-preservation-failed', { error: String(error) }); }
      // A partially staged native installer has no public cancellation/rollback API. Keep its environment intact.
      if (report.failure && handoffStarted && !report.verified.secondExited) {
        first?.inspector.close(); second?.inspector.close(); spawned?.unref();
        report.cleanup = { complete: false, retainedForInspection: true, reason: 'Native handoff did not finish; no installer was force-killed or state erased', root: environment.root };
      } else {
        if (report.failure && first && !first.exit()) {
          try { await first.quit(); await until(() => first.exit(), 30_000, 'E1 failure cleanup'); } catch (error) { record('failure-cleanup-error', { error: String(error) }); }
        } else if (report.failure && spawned && spawned.exitCode === null && spawned.signalCode === null) {
          // Startup failed before an installer existed. Only the child spawned by this runner is signalled.
          spawned.kill('SIGTERM'); record('failed-startup-termination', { pid: spawned.pid });
        }
        first?.inspector.close(); second?.inspector.close();
        try { report.cleanup = await cleanEnvironment(environment, initial, record); }
        catch (error) { report.cleanup = { complete: false, error: String(error), retainedForInspection: true }; }
        spawned?.unref();
      }
    }
    if (server) try { await server.close(); } catch (error) {
      report.failure ??= { stage: 'fixture-server-cleanup', error: String(error) };
      record('fixture-server-cleanup-failed', { error: String(error) });
    }
    if (preserved) {
      try {
        if (!report.cleanup.complete) throw new Error('Temporary updater state must drain before restoring original data');
        await inspect(false);
        await restoreMacData(preserved, record);
        report.preservedData.restored = true;
      } catch (error) {
        report.cleanup.complete = false;
        report.cleanup.originalDataRetained = preserved.root;
        report.cleanup.restoreError = String(error);
      }
    }
    record('cleanup', report.cleanup);
  }
  if (!report.failure) {
    try { assertSuccessfulReport(report); report.complete = true; }
    catch (error) { report.failure = { stage: 'final-assertions', error: String(error) }; }
  }
  record('report', report); return report;
}
