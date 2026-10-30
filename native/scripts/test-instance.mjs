import { assertElectronGuiAvailable } from '../../scripts/electron-test-preflight.cjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, lstat, unlink } from 'node:fs/promises';
import { writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { observeFixtureProcess, withDeadline } from './fixture-process.mjs';

const desktop = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(path.join(desktop, 'package.json'));
const electron = process.env.KLAUS_TEST_ELECTRON || require('electron');
const addon = process.env.KLAUS_TEST_NATIVE_ADDON || path.join(desktop, 'native', 'artifacts', `klaus-native-${process.platform}-${process.arch}.node`);
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Instance guard requires a supported desktop OS');
assertElectronGuiAvailable();
const root = await mkdtemp(path.join(tmpdir(), 'klaus-instance-fixture-'));
const children = new Set(), identities = new Set(), servers = new Set(), sockets = new Set();
let passed = 0, failed = 0, serial = 0;
function identity() { const value = `ai.klaus.instance-fixture.${process.pid}.${randomBytes(5).toString('hex')}`; identities.add(value); return value; }
function socketPath(id) { return `/tmp/${id.replace(/[.-]/g, '_')}_si.sock`; }
function child(command, args, env = {}, control) {
  const actualEnv = { ...process.env, ...env }; delete actualEnv.ELECTRON_RUN_AS_NODE;
  const processChild = spawn(command, args, { env: actualEnv, cwd: desktop, stdio: ['pipe', 'pipe', 'pipe'] });
  const lifecycle = observeFixtureProcess(processChild);
  children.add(lifecycle);
  let output = '', stderr = '';
  const events = [], waiters = [];
  processChild.once('close', () => { for (const waiter of waiters.splice(0)) waiter(); });
  processChild.stderr.on('data', data => { stderr = (stderr + data).slice(-5000); });
  processChild.stdout.on('data', data => {
    output += data;
    while (output.includes('\n')) {
      const end = output.indexOf('\n'), line = output.slice(0, end).trim(); output = output.slice(end + 1);
      if (line.startsWith('INSTANCE ')) events.push(JSON.parse(line.slice(9)));
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  return {
    process: processChild,
    get exited() { return lifecycle.wait(); },
    async next(type, timeout = 10000) {
      const deadline = Date.now() + timeout;
      while (true) {
        const index = events.findIndex(value => value.type === type);
        if (index !== -1) return events.splice(index, 1)[0];
        if (lifecycle.error) throw lifecycle.error;
        if (lifecycle.ended || Date.now() > deadline) throw new Error(`Missing fixture ${type}: ${JSON.stringify(events)}; stderr=${stderr}`);
        await new Promise(resolve => { const timer = setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))); waiters.push(() => { clearTimeout(timer); resolve(); }); });
      }
    },
    command(value) { if (!control) throw new Error('Fixture has no command file'); appendFileSync(control, `${value}\n`); },
    async close() {
      if (!lifecycle.ended) { if (control) appendFileSync(control, 'close\n'); else processChild.stdin.end('close\n'); }
      const status = await lifecycle.wait();
      assert.deepEqual(status, { code: 0, signal: null }, `Fixture did not close successfully; stderr=${stderr}`);
      return status;
    },
    async kill() { return lifecycle.stop(); },
  };
}
async function worker(id) {
  assertElectronGuiAvailable();
  const profile = path.join(root, `profile-${serial++}`); await mkdir(profile);
  const control = path.join(profile, 'control.txt'); writeFileSync(control, '');
  const args = [path.join(desktop, 'native/tests/instance-worker.cjs'), ...(process.platform === 'darwin' ? ['-ApplePersistenceIgnoreState', 'YES'] : [])];
  return child(electron, args, { KLAUS_INSTANCE_FIXTURE_ID: id, KLAUS_INSTANCE_FIXTURE_PROFILE: profile, KLAUS_INSTANCE_FIXTURE_ADDON: addon }, control);
}
function windowsPeer(id, mode, bytes = Buffer.alloc(0), tag = 1542) {
  const message = path.join(root, `wire-${serial++}.bin`); writeFileSync(message, bytes);
  const control = path.join(root, `peer-control-${serial++}.txt`); writeFileSync(control, '');
  return child('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(desktop, 'native/tests/instance-peer.ps1'), '-Identity', id, '-Mode', mode, '-MessagePath', message, '-ControlPath', control, '-Tag', String(tag)], {}, control);
}
async function macPeer(id) {
  const messages = [];
  const server = net.createServer(stream => { sockets.add(stream); stream.once('close', () => sockets.delete(stream)); stream.setTimeout(10_000, () => stream.destroy()); let bytes = Buffer.alloc(0); stream.on('data', value => { bytes = Buffer.concat([bytes, value]); }); stream.on('end', () => { messages.push(bytes); stream.end(); }); });
  servers.add(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath(id), resolve); });
  return { messages, server, close: () => withDeadline(new Promise(resolve => server.close(resolve)), 5000, 'Fixture socket server did not close') };
}
async function test(name, fn) {
  const existing = new Set(children);
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failed++; console.error(`  FAIL ${name}: ${error.stack || error}`); }
  finally {
    const cleanup = await Promise.allSettled([...children].filter(peer => !existing.has(peer)).map(peer => peer.stop()));
    for (const result of cleanup) if (result.status === 'rejected') {
      failed++; console.error(`  FAIL ${name} cleanup: ${result.reason.stack || result.reason}`);
    }
  }
}
try {
  await test('normal Electron acquires before first yield and forwards to an already-ready native receiver', async () => {
    const id = identity(), primary = await worker(id);
    const ready = await primary.next('acquired'); assert.equal(ready.acquired, true); assert.equal(ready.synchronous, true);
    const secondary = await worker(id), result = await secondary.next('acquired'); assert.equal(result.acquired, false); assert.equal(result.acknowledged, true); assert.equal((await secondary.exited).code, 0);
    assert.equal((await primary.next('activation')).deepLink, 'klaus://settings');
    primary.command('assert'); assert.equal((await primary.next('held')).held, true);
    await primary.close(); assert.equal((await primary.next('closed')).complete, true);
  });
  await test('independent processes elect one data owner under simultaneous startup', async () => {
    const id = identity(), peers = await Promise.all([worker(id), worker(id), worker(id)]);
    const results = await Promise.all(peers.map(peer => peer.next('acquired')));
    assert.equal(results.filter(result => result.acquired).length, 1);
    for (const peer of peers) assert.equal((await peer.close()).code, 0);
  });
  await test('abrupt owner termination can be recovered by its recorded native ownership', async () => {
    const id = identity(), first = await worker(id); assert.equal((await first.next('acquired')).acquired, true); await first.kill();
    const second = await worker(id); assert.equal((await second.next('acquired')).acquired, true); assert.equal((await second.close()).code, 0);
  });
  await test('new instance forwards the shipped legacy protocol without claiming macOS UI acknowledgement', async () => {
    const id = identity();
    if (process.platform === 'darwin') {
      const legacy = await macPeer(id), next = await worker(id), result = await next.next('acquired');
      assert.equal(result.acquired, false); assert.equal(result.forwarded, true); assert.equal(result.acknowledged, false); assert.equal((await next.exited).code, 0);
      assert.equal(legacy.messages[0].toString(), '\0\0Klaus\0klaus://settings'); await legacy.close();
    } else {
      const legacy = windowsPeer(id, 'legacy'); await legacy.next('ready');
      const next = await worker(id), result = await next.next('acquired'); assert.equal(result.acquired, false); assert.equal(result.acknowledged, true);
      assert.equal(Buffer.from((await legacy.next('wire')).base64, 'base64').toString(), '|Klaus|klaus://settings\0'); assert.equal((await next.exited).code, 0); await legacy.close();
    }
  });
  await test('legacy activation is limited to focus and one valid deep link', async () => {
    const id = identity(), primary = await worker(id); await primary.next('acquired');
    if (process.platform === 'darwin') {
      await new Promise((resolve, reject) => { const client = net.connect(socketPath(id)); sockets.add(client); client.setTimeout(10_000, () => client.destroy(new Error('Fixture activation connection timed out'))); client.on('error', reject); client.on('data', () => {}); client.on('close', () => { sockets.delete(client); resolve(); }); client.on('connect', () => client.end('/untrusted\0\0Klaus\0--execute=bad\0klaus://new?discard=1\0klaus://settings')); });
    } else {
      const sender = windowsPeer(id, 'send', Buffer.from('/untrusted|Klaus|--execute=bad|klaus://new?discard=1|klaus://settings\0')); assert.equal((await sender.next('sent')).accepted, 1); assert.equal((await sender.exited).code, 0);
    }
    assert.equal((await primary.next('activation')).deepLink, 'klaus://new'); await primary.close();
  });
  if (process.platform === 'darwin') {
    await test('foreign socket replacement is detected and never removed during guard close', async () => {
      const id = identity(), primary = await worker(id); await primary.next('acquired'); await primary.next('ready'); await unlink(socketPath(id));
      const foreign = await macPeer(id), inode = (await lstat(socketPath(id))).ino;
      assert.equal((await primary.next('lost')).code, 'INSTANCE_ENDPOINT_LOST'); await primary.close();
      assert.equal((await lstat(socketPath(id))).ino, inode); await foreign.close();
    });
    await test('unknown legacy orphan fails closed without deleting its socket', async () => {
      const id = identity();
      const peer = child(process.execPath, ['-e', `const net=require('node:net');net.createServer().listen(process.argv[1],()=>console.log('INSTANCE '+JSON.stringify({type:'ready'})));`, socketPath(id)]);
      await peer.next('ready'); await peer.kill(); const inode = (await lstat(socketPath(id))).ino;
      const attempt = await worker(id); assert.match((await attempt.next('error')).code, /INSTANCE_UNKNOWN_ORPHAN/); assert.equal((await attempt.exited).code, 2);
      assert.equal((await lstat(socketPath(id))).ino, inode);
    });
  } else {
    await test('legacy mutex with no compatible window blocks startup within the native deadline', async () => {
      const id = identity(), legacy = windowsPeer(id, 'mutex-only'); await legacy.next('ready'); const start = Date.now();
      const attempt = await worker(id); const failure = await attempt.next('error'); assert.match(failure.code, /INSTANCE_(OWNER_WINDOW_MISSING|ACQUIRE_TIMEOUT)/); assert.equal(failure.synchronous, true); assert(Date.now() - start < 5000);
      assert.equal((await attempt.exited).code, 2); await legacy.close();
    });
    await test('WM_COPYDATA rejects the wrong tag, oversized and unterminated bytes', async () => {
      const id = identity(), primary = await worker(id); await primary.next('acquired');
      for (const [bytes, tag] of [[Buffer.from('|Klaus\0'), 7], [Buffer.alloc(32769, 1), 1542], [Buffer.from('|Klaus'), 1542]]) {
        const sender = windowsPeer(id, 'send', bytes, tag); assert.equal((await sender.next('sent')).accepted, 0); assert.equal((await sender.exited).code, 0);
      }
      primary.command('assert'); assert.equal((await primary.next('held')).held, true); await primary.close();
    });
  }
} finally {
  let complete = ![...children].some(peer => peer.cleanupError);
  const cleanup = await Promise.allSettled([...children].map(peer => peer.stop()));
  for (const result of cleanup) if (result.status === 'rejected') {
    complete = false; failed++; console.error(`  FAIL fixture cleanup: ${result.reason.stack || result.reason}`);
  }
  for (const socket of sockets) socket.destroy();
  for (const server of servers) if (server.listening) {
    try { await withDeadline(new Promise(resolve => server.close(resolve)), 5000, 'Fixture socket server cleanup timed out'); }
    catch (error) { complete = false; failed++; console.error(error); }
  }
  if (complete) {
    if (process.platform === 'darwin') for (const id of identities) {
      await rm(socketPath(id), { force: true }); await rm(`/tmp/${id.replace(/[.-]/g, '_')}_electron_si.lock`, { force: true });
    }
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`Fixture cleanup is unconfirmed; preserved ${root} and its identity endpoints`);
  }
}
console.log(`instance-native-electron: ${passed} passed, ${failed} failed; runtime=${electron}`);
process.exitCode = failed ? 1 : 0;
