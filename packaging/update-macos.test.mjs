import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleasePair } from './update-macos-inputs.mjs';
import { GUARD_LEASE, childEnvironment, inspectEnvironmentSnapshot, pathState } from './update-macos-environment.mjs';
import { deleteTemporaryPreferenceDomain, ownedShipItJob, removeOwnedDirectory } from './update-macos-cleanup.mjs';
import { preserveMacData, restoreMacData } from './update-macos-preserve.mjs';
import { assertSuccessfulReport } from './update-macos-scenario.mjs';
import { createLoopbackCertificates } from './update-transport-probe.mjs';
import { updateServer } from './update-macos-transport.mjs';
import { runTool } from './release-io.mjs';
import { validateStaple } from './release-macos.mjs';

// This suite exercises macOS namespace/path semantics; Windows has a separate NSIS installation gate.
const macTest = (name, body) => test(name, { skip: process.platform !== 'darwin' }, body);
macTest('temporary preference cleanup removes empty CFPreferences files and retains unexpected values or errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-empty-preference-'));
  const file = join(root, 'fixture.plist');
  const seed = values => runTool('python3', ['-c', 'import plistlib,json,sys\nwith open(sys.argv[1],"wb") as f: plistlib.dump(json.loads(sys.argv[2]),f)\n', file, JSON.stringify(values)]);
  try {
    await seed({});
    await deleteTemporaryPreferenceDomain(['delete', file.slice(0, -6)], [file], process.getuid());
    assert.equal((await pathState(file)).present, false);
    await seed({ preserved: true });
    const missing = async (command, args, options) => {
      if (command !== '/usr/bin/defaults') return runTool(command, args, options);
      options.onFailure({ exitCode: 1, stdout: '', stderr: 'Domain fixture does not exist' });
      throw new Error('defaults failed');
    };
    await assert.rejects(deleteTemporaryPreferenceDomain(['delete', 'fixture'], [file], process.getuid(), missing), /values remain/);
    assert.equal((await pathState(file)).present, true);
    await seed({});
    await assert.rejects(deleteTemporaryPreferenceDomain(['delete', 'fixture'], [file], process.getuid(), async (_command, _args, options) => {
      options.onFailure({ exitCode: 1, stdout: '', stderr: 'Permission denied' }); throw new Error('defaults denied');
    }), /defaults denied/);
    assert.equal((await pathState(file)).present, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
macTest('ticket validation retries explicit transient lookup failures but never accepts a rejected ticket', async () => {
  let calls = 0;
  const run = async (_command, _args, options) => {
    calls++;
    if (calls < 3) {
      options.onFailure({ exitCode: 68, stdout: 'Error Domain=NSURLErrorDomain Code=-1001 "The request timed out."', stderr: '' });
      throw new Error('xcrun failed (exit 68)');
    }
    return { stdout: 'The validate action worked!', stderr: '' };
  };
  assert.equal((await validateStaple('/signed/Klaus.app', run)).stdout, 'The validate action worked!');
  assert.equal(calls, 3);
  for (const transient of [false, true]) {
    calls = 0;
    await assert.rejects(validateStaple('/signed/Klaus.app', async (_command, _args, options) => {
      calls++; options.onFailure({ exitCode: 68, stdout: transient ? 'NSURLErrorDomain Code=-1009' : 'Invalid ticket', stderr: '' });
      throw new Error('Ticket validation failed');
    }), /Ticket validation failed/);
    assert.equal(calls, transient ? 3 : 1);
  }
});
const receipt = version => ({ application: 'ai.klaus.desktop', framework: 'electron', platform: 'darwin', arch: 'arm64',
  channel: 'stable', version, buildKind: 'signed-release', platformProof: { verified: true, teamId: 'ABC1234567' }, notarization: { status: 'Accepted', stapled: true } });
const policy = version => ({ teamId: 'ABC1234567', channel: 'stable', feedUrl: `https://127.0.0.1:29431/releases/electron/stable/darwin/arm64/${version}` });
macTest('signed release identity rejects downgrade, cross-framework, wrong team and non-TLS/remote fixture origins', () => {
  assert.equal(assertReleasePair(receipt('1.0.0'), receipt('1.0.1'), policy('1.0.0'), policy('1.0.1')).arch, 'arm64');
  for (const mutate of [value => { value.version = '1.0.0'; }, value => { value.version = '0.9.0'; }, value => { value.framework = 'tauri'; },
    value => { value.arch = 'x64'; }, value => { value.channel = 'preview'; }, value => { value.platformProof.teamId = 'WRONG12345'; },
    value => { value.notarization.stapled = false; }, value => { value.platformProof.verified = false; }]) {
    const value = receipt('1.0.1'); mutate(value);
    assert.throws(() => assertReleasePair(receipt('1.0.0'), value, policy('1.0.0'), policy('1.0.1')));
  }
  for (const origin of ['http://127.0.0.1:29431', 'https://releases.example.com:29431', 'https://127.0.0.1', 'https://127.0.0.1:443', 'https://user:secret@127.0.0.1:29431']) {
    assert.throws(() => assertReleasePair(receipt('1.0.0'), receipt('1.0.1'), { ...policy('1.0.0'), feedUrl: `${origin}/releases/electron/stable/darwin/arm64/1.0.0` }, { ...policy('1.0.1'), feedUrl: `${origin}/releases/electron/stable/darwin/arm64/1.0.1` }));
  }
  assert.throws(() => assertReleasePair(receipt('1.0.0'), receipt('1.0.1'), { ...policy('1.0.0'), channel: 'preview' }, policy('1.0.1')), /feed identity/);
  assert.equal(assertReleasePair(receipt('1.0.0'), receipt('1.0.1'), policy('1.0.0'),
    { ...policy('1.0.1'), feedUrl: 'https://klaus-ai.cn/releases/electron/stable/darwin/arm64/1.0.1' }).origin, 'https://127.0.0.1:29431');
});
const snapshot = () => ({ platform: 'darwin', username: 'update-fixture', uid: 502, home: '/Users/update-fixture', environmentHome: '/Users/update-fixture',
  paths: [], preferenceDomains: [], jobs: [], processes: [], inspectorBusy: false });
const expected = { expectedUser: 'update-fixture', expectedHome: '/Users/update-fixture', configRoot: '/Users/update-fixture/.klaus' };
macTest('the named local account accepts only its actual default profile', () => {
  assert.equal(inspectEnvironmentSnapshot(snapshot(), expected).username, 'update-fixture');
  assert.throws(() => inspectEnvironmentSnapshot(snapshot(), { ...expected, configRoot: '/tmp/isolated' }), /does not preserve custom profiles/);
  assert.throws(() => inspectEnvironmentSnapshot(snapshot(), { ...expected, expectedUser: 'someone-else' }), /named non-root/);
  assert.throws(() => inspectEnvironmentSnapshot({ ...snapshot(), environmentHome: '/tmp/fake-home' }, expected), /without an override/);
});
macTest('an attested idle lease is reusable without unlinking it, while occupied or substituted leases block', () => {
  const state = { path: GUARD_LEASE, present: true, uid: 502, dev: 1, ino: 42, type: 'file', mode: 0o600, links: 1 };
  const value = { ...snapshot(), paths: [state], lease: { idle: true, uid: 502, dev: 1, ino: 42 } };
  assert.equal(inspectEnvironmentSnapshot(value, expected), value);
  for (const lease of [{ ...value.lease, idle: false }, { ...value.lease, ino: 43 }, { ...value.lease, uid: 0 }]) {
    assert.throws(() => inspectEnvironmentSnapshot({ ...value, lease }, { ...expected, preserveExisting: true }));
  }
});
macTest('local data preservation requires owned app paths and never accepts active apps or launchd jobs', () => {
  const value = { ...snapshot(), paths: [{ path: '/Users/update-fixture/.klaus', present: true, uid: 502, type: 'directory' }] };
  assert.equal(inspectEnvironmentSnapshot(value, { ...expected, preserveExisting: true }), value);
  for (const change of [{ processes: [{}] }, { jobs: [{}] }, { paths: [{ ...value.paths[0], uid: 0 }] },
    { paths: [{ ...value.paths[0], type: 'symlink' }] }, { paths: [{ ...value.paths[0], path: '/tmp/foreign' }] }]) {
    assert.throws(() => inspectEnvironmentSnapshot({ ...value, ...change }, { ...expected, preserveExisting: true }));
  }
});
macTest('existing business data returns with the same inode and bytes; restore refuses a new foreign profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'update preserve '));
  try {
    const profile = join(home, '.klaus'); await mkdir(profile); await writeFile(join(profile, 'business.bin'), Buffer.from([0, 1, 255, 42]));
    const witness = await pathState(profile);
    const value = { home, uid: witness.uid, paths: [witness], preferenceDomains: [] };
    const backup = await preserveMacData(value, () => {});
    assert.equal((await pathState(profile)).present, false);
    await mkdir(profile); await writeFile(join(profile, 'foreign.txt'), 'must survive');
    await assert.rejects(restoreMacData(backup, () => {}), /Refusing to overwrite/);
    assert.equal(await readFile(join(profile, 'foreign.txt'), 'utf8'), 'must survive');
    assert.deepEqual(await readFile(join(backup.entries[0].destination, 'business.bin')), Buffer.from([0, 1, 255, 42]));
    await rm(profile, { recursive: true });
    await restoreMacData(backup, () => {});
    assert.equal((await pathState(profile)).ino, witness.ino);
    assert.deepEqual(await readFile(join(profile, 'business.bin')), Buffer.from([0, 1, 255, 42]));
    assert.equal((await pathState(backup.root)).present, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
macTest('all host preferences are archived first and only the actual current host refreshes its cache', async () => {
  const home = await mkdtemp(join(tmpdir(), 'update preferences '));
  try {
    const directory = join(home, 'Library/Preferences/ByHost'); await mkdir(directory, { recursive: true });
    const currentHostId = '11111111-1111-1111-1111-111111111111';
    const previous = join(directory, 'ai.klaus.desktop.00000000-0000-0000-0000-000000000000.plist');
    const current = join(directory, `ai.klaus.desktop.${currentHostId}.plist`);
    for (const [file, value] of [[previous, 'old-host'], [current, 'current-host']]) await writeFile(file,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>marker</key><string>${value}</string><key>bookmark</key><data>AP8q</data><key>date</key><date>2026-09-13T00:00:00Z</date></dict></plist>`);
    const before = await Promise.all([previous, current].map(pathState));
    const calls = [];
    const run = async (command, args) => {
      if (command !== '/usr/bin/defaults') return runTool(command, args);
      calls.push(args);
      assert.equal(args[0], '-currentHost'); assert.equal(args[2], 'ai.klaus.desktop');
      if (args[1] === 'delete') {
        for (const file of [previous, current]) assert.equal((await pathState(file)).present, false);
      } else if (args[1] === 'import') await copyFile(args[3], current);
      else assert.fail('Unexpected preference mutation');
      return { stdout: '', stderr: '' };
    };
    const backup = await preserveMacData({ home, uid: before[0].uid, paths: [], preferenceDomains: [previous, current], currentHostId }, () => {}, run);
    await restoreMacData(backup, () => {}, run);
    assert.deepEqual(calls.map(args => args[1]), ['delete', 'import']);
    for (const witness of before) assert.equal((await pathState(witness.path)).ino, witness.ino);
    assert.match(await readFile(previous, 'utf8'), /old-host/); assert.match(await readFile(current, 'utf8'), /current-host/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
macTest('any prior production namespace, active process, job or inspector causes a read-only refusal', () => {
  for (const value of [{ paths: [{ path: '/tmp/lease', present: true }] }, { preferenceDomains: ['prior.plist'] }, { jobs: [{}] },
    { processes: [{}] }, { inspectorBusy: true }, { uid: 0 }, { platform: 'win32' }]) {
    assert.throws(() => inspectEnvironmentSnapshot({ ...snapshot(), ...value }, expected));
  }
});
macTest('child trust is scoped and profile changes do not reset HOME or CODEX_HOME or allow bypass flags', () => {
  const source = { HOME: '/Users/update-fixture', CODEX_HOME: '/keep/codex', KLAUS_TEST: '1', NODE_OPTIONS: '--inspect', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    ELECTRON_RUN_AS_NODE: '1', KLAUS_INSTANCE_IDENTITY: 'fake', KLAUS_ALLOW_REAL_PROFILE_IN_TEST: '1' };
  const value = childEnvironment('/Users/update-fixture/.klaus', '/own/ca.pem', source);
  assert.equal(value.HOME, source.HOME); assert.equal(value.CODEX_HOME, source.CODEX_HOME);
  assert.equal(value.NODE_EXTRA_CA_CERTS, '/own/ca.pem');
  for (const key of ['KLAUS_TEST', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'ELECTRON_RUN_AS_NODE', 'KLAUS_INSTANCE_IDENTITY', 'KLAUS_ALLOW_REAL_PROFILE_IN_TEST']) assert.equal(value[key], undefined);
  assert.equal(source.KLAUS_TEST, '1');
});
macTest('cleanup refuses replaced directories and symlink substitutions without deleting their contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'update cleanup '));
  try {
    const owned = join(directory, 'owned'), retained = join(directory, 'retained');
    await mkdir(owned); const witness = await pathState(owned);
    await rename(owned, retained); await mkdir(owned); await writeFile(join(owned, 'foreign.txt'), 'preserve');
    await assert.rejects(removeOwnedDirectory(witness), /identity changed/);
    assert.equal(await readFile(join(owned, 'foreign.txt'), 'utf8'), 'preserve');
    await rm(owned, { recursive: true }); await symlink(retained, owned, 'dir');
    await assert.rejects(removeOwnedDirectory(witness), /identity changed/);
    await rm(owned); await rename(retained, owned); await removeOwnedDirectory(witness);
    assert.equal((await pathState(owned)).present, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
macTest('launchd cleanup requires both the exact owned bundle family and owned state file', () => {
  const bundle = '/Users/update-fixture/Klaus update acceptance Abc/Klaus.app';
  const job = { detail: `program = ${bundle}/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt\narguments = {\n  ${bundle}/Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt\n  /Users/update-fixture/Library/Caches/ai.klaus.desktop.ShipIt/ShipItState.plist\n}\n` };
  assert.equal(ownedShipItJob(job, bundle, '/Users/update-fixture'), true);
  assert.equal(ownedShipItJob(job, '/Applications/Klaus.app', '/Users/update-fixture'), false);
  assert.equal(ownedShipItJob(job, bundle, '/Users/someone-else'), false);
  assert.equal(ownedShipItJob({ detail: job.detail.replace('program = ', 'arbitrary = ') }, bundle, '/Users/update-fixture'), false);
});
macTest('a persistent idle lease is allowed only after every real update and owned cleanup assertion', () => {
  const report = { mode: 'execute', verified: Object.fromEntries(['signedInputs', 'productionGuard', 'cacheNegativeChecks', 'squirrelDownloaded', 'firstExited',
    'automaticRestart', 'secondReceipt', 'businessPreserved', 'secondExited'].map(key => [key, true])), cleanup: { complete: true, ownedRootRemoved: true, leaseRetainedByDesign: true } };
  assert.equal(assertSuccessfulReport(report), true);
  for (const key of Object.keys(report.verified)) { const bad = structuredClone(report); delete bad.verified[key]; assert.throws(() => assertSuccessfulReport(bad)); }
  for (const key of ['complete', 'ownedRootRemoved', 'leaseRetainedByDesign']) { const bad = structuredClone(report); bad.cleanup[key] = false; assert.throws(() => assertSuccessfulReport(bad)); }
  assert.throws(() => assertSuccessfulReport({ ...report, mode: 'preflight' }));
});
macTest('actual HTTPS fixture serves unchanged signed bytes, withholds upgrades, limits target and denies alternate Host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'update https ')); let server;
  try {
    const tls = await createLoopbackCertificates(directory), artifact = join(directory, 'update.zip');
    await writeFile(artifact, 'signed bytes fixture');
    const inputs = { origin: 'https://127.0.0.1:0', port: 0, firstPolicy: { feedUrl: 'https://127.0.0.1:0/first' }, secondPolicy: { feedUrl: 'https://127.0.0.1:0/second' },
      envelope: { payload: 'unchanged signed payload', signature: 'unchanged signed signature' }, artifact, artifactProof: { url: 'https://127.0.0.1:0/artifact', size: 20 } };
    // Production inputs require a signed explicit port. This transport-only case reserves an ephemeral one.
    server = await updateServer(inputs, { ...tls, record: () => {} });
    const fetchPath = async (path, host = '127.0.0.1:0') => {
      const script = `const https=require('node:https'); https.get({hostname:'127.0.0.1',servername:'localhost',port:${server.port},path:${JSON.stringify(path)},headers:{host:${JSON.stringify(host)}}},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,body})));}).on('error',e=>console.log(JSON.stringify({error:e.code,message:e.message})));`;
      const env = { ...process.env, NODE_EXTRA_CA_CERTS: tls.ca }; delete env.NODE_TLS_REJECT_UNAUTHORIZED; delete env.NODE_OPTIONS;
      return JSON.parse((await runTool(process.execPath, ['-e', script], { env })).stdout);
    };
    assert.equal((await fetchPath('/first')).status, 204); server.enable();
    assert.deepEqual(await fetchPath('/first'), { status: 200, body: JSON.stringify(inputs.envelope) });
    assert.deepEqual(await fetchPath('/artifact'), { status: 200, body: 'signed bytes fixture' });
    assert.equal((await fetchPath('/second')).status, 204);
    assert.equal((await fetchPath('/anything')).status, 404);
    assert.equal((await fetchPath('/first', 'foreign.example')).status, 403);
  } finally { if (server) await server.close(); await rm(directory, { recursive: true, force: true }); }
});
