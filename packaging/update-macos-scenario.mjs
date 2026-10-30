import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { until } from './fixture.mjs';
import { fileProof } from './release-io.mjs';
import { updaterContract } from './release-signatures.mjs';
import { GUARD_SOCKET, jobState, macProcesses, pathState } from './update-macos-environment.mjs';
import { inspectLease } from './update-macos-cleanup.mjs';

export async function seedBusiness(runtime, environment, origin, record) {
  const marker = randomUUID(), modelId = `update-${marker}`, title = `E1 preserved ${marker}`;
  const file = join(environment.workspace, 'Business data with spaces.txt');
  await writeFile(file, `${marker}\n`, { flag: 'wx', mode: 0o600 });
  await runtime.invoke('settings:kv:set', { key: 'auth_mode', value: 'custom' });
  await runtime.invoke('settings:models:upsert', { id: modelId, name: title, provider: 'anthropic', model: 'fixture-model',
    baseUrl: origin, apiKey: 'isolated-update-fixture-no-real-credential', isDefault: true });
  await runtime.invoke('settings:kv:set', { key: 'composer.main_model', value: `custom:${modelId}` });
  const workspace = await runtime.invoke('workspaces:save', { name: title, roots: [environment.workspace] });
  assert.equal(typeof workspace.id, 'string');
  const session = await runtime.invoke('session:new', { workspaceId: workspace.id });
  assert.equal(typeof session.id, 'string');
  await runtime.invoke('session:rename', { sessionId: session.id, title });
  const fixture = { marker, modelId, title, workspaceId: workspace.id, sessionId: session.id, file };
  await verifyBusiness(runtime, fixture, record);
  return fixture;
}
export async function verifyBusiness(runtime, fixture, record) {
  assert.equal(await readFile(fixture.file, 'utf8'), `${fixture.marker}\n`);
  assert.equal(await runtime.invoke('settings:kv:get', { key: 'composer.main_model' }), `custom:${fixture.modelId}`);
  const { workspaces } = await runtime.invoke('workspaces:list');
  assert(workspaces.some(item => item.id === fixture.workspaceId && item.name === fixture.title));
  const models = await runtime.invoke('settings:models:list');
  assert(models.some(item => item.id === fixture.modelId && item.name === fixture.title));
  const sessions = await runtime.invoke('session:list');
  assert(sessions.some(item => item.id === fixture.sessionId && item.title === fixture.title));
  record('business-fixture-preserved', { sessionId: fixture.sessionId, workspaceId: fixture.workspaceId, modelId: fixture.modelId, file: fixture.file });
}
export async function observeNativeUpdater(runtime, journal) {
  await runtime.inspector.evaluate(`globalThis.__nativeUpdateEvents=[]; for(const name of ['checking-for-update','update-available','update-not-available','update-downloaded','before-quit-for-update','error']) __updateElectron.autoUpdater.on(name,()=>{ const entry={at:new Date().toISOString(),stage:'native-updater',name,pid:process.pid}; __nativeUpdateEvents.push(entry); process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(journal)},JSON.stringify(entry)+'\\n'); }); true`);
}
export async function observeProcessExit(runtime, journal) {
  await runtime.inspector.evaluate(`process.once('exit',code=>process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(journal)},JSON.stringify({at:new Date().toISOString(),stage:'process-exit',pid:process.pid,code})+'\\n')); true`);
}
async function downloadedCache(environment, inputs) {
  const directory = join(environment.profile, 'electron/updates');
  const names = (await readdir(directory)).filter(name => name.startsWith('download-'));
  assert.equal(names.length, 1, 'Only the current verified download may remain');
  const file = join(directory, names[0], 'update.zip'), proof = await fileProof(file);
  for (const key of ['size', 'sha256', 'sha512']) assert.equal(proof[key], inputs.artifactProof[key]);
  const contract = updaterContract();
  await contract.verifyMinisignFile(file, inputs.artifactProof.signature, contract.parseMinisignKey(contract.KLAUS_UPDATE_PUBLIC_KEY), inputs.artifactProof);
  return { file, proof };
}
export async function download(runtime, environment, inputs, record, signal) {
  await runtime.invoke('updater:check'); let previous;
  await until(async () => {
    signal?.throwIfAborted();
    const status = await runtime.invoke('updater:status');
    if (status.state !== previous) { previous = status.state; record('download-status', status); }
    if (!status.supported || status.state === 'error') throw new Error(`Production download failed: ${status.error}`);
    return status.state === 'downloaded' && status.availableVersion === inputs.second.version;
  }, 180_000, 'the signed update cache');
  const cached = await downloadedCache(environment, inputs);
  record('cache-verified', cached); return cached;
}
export async function negativeCacheChecks(runtime, environment, inputs, server, record, signal) {
  const seeded = join(environment.profile, 'electron/updates/download-unverified');
  const rejected = await runtime.invoke('updater:install');
  assert.deepEqual(rejected, { ok: false, error: 'no_update_downloaded' });
  assert.equal((await runtime.invoke('updater:status')).currentVersion, inputs.first.version);
  assert.equal((await runtime.inspector.evaluate('__nativeUpdateEvents')).length, 0);
  record('unverified-cache-not-installed', rejected);
  await rm(seeded, { recursive: true }); server.enable();
  const cached = await download(runtime, environment, inputs, record, signal);
  await chmod(cached.file, 0o600); await appendFile(cached.file, 'intentional fixture corruption');
  const result = await runtime.invoke('updater:install');
  assert.equal(result.ok, false); assert.equal(typeof result.error, 'string'); assert(result.error.length > 0);
  assert.equal((await runtime.inspector.evaluate('__nativeUpdateEvents')).length, 0);
  assert.equal((await runtime.invoke('updater:status')).currentVersion, inputs.first.version);
  for (const domain of [`gui/${environment.uid}`, `user/${environment.uid}`]) assert.equal(jobState(domain).present, false);
  record('tampered-cache-refused-before-squirrel', result);
  return download(runtime, environment, inputs, record, signal);
}
export async function seedUnverifiedCache(environment) {
  const directory = join(environment.profile, 'electron/updates/download-unverified');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'update.zip'), 'not a signed update', { flag: 'wx', mode: 0o600 });
}
export async function verifyProductionGuard(environment, record) {
  assert.equal((await pathState(GUARD_SOCKET)).type, 'socket');
  const lease = await inspectLease(environment.uid); assert.equal(lease.idle, false);
  record('production-guard-held', { ...lease, socket: GUARD_SOCKET, processes: macProcesses().filter(row => row.executable.startsWith(`${environment.root}/`)) });
}

export function assertSuccessfulReport(report) {
  assert.equal(report.mode, 'execute');
  for (const stage of ['signedInputs', 'productionGuard', 'cacheNegativeChecks', 'squirrelDownloaded', 'firstExited', 'automaticRestart', 'secondReceipt', 'businessPreserved', 'secondExited']) assert.equal(report.verified[stage], true, `Missing stage: ${stage}`);
  assert.equal(report.cleanup.complete, true); assert.equal(report.cleanup.ownedRootRemoved, true);
  assert.equal(report.cleanup.leaseRetainedByDesign, true);
  return true;
}
