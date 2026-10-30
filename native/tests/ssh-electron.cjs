const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, ipcMain } = require('electron');
const { loadNativeAddon } = require('../../dist/main/native/binding');
const { NativeSshTransport, parseSshTarget, sshDirectoryCommand, sshDirectoryResult } = require('../../dist/main/native/ssh');
const { ChannelRegistry } = require('../../dist/main/ipc/registry');
const { registerSshHandlers } = require('../../dist/main/ipc/handlers/ssh');
const { SshConnectionPool } = require('../../dist/main/services/ssh-pool');
const addonPath = path.resolve(__dirname, '../artifacts', `klaus-native-${process.platform}-${process.arch}.node`);

const root = process.env.KLAUS_SSH_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-ssh-gate-')) throw new Error('An isolated SSH gate profile is required');
// This gate measures native protocol/IPC; rendering uses software to avoid remote-desktop GPU state.
app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, 'electron'));
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const target = { host: '127.0.0.1', user: 'fixture', port: fixture.port };
const results = [];
const rawResources = new Set();
const transports = new Set();
const windows = new Map();
const acknowledgments = new Map();
const delivered = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let handlers;
let addon;
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); }
}
function home() { const dir = path.join(root, randomUUID()); fs.mkdirSync(dir); return dir; }
function raw() {
  const resourceId = randomUUID();
  const binding = new addon.NativeSsh(resourceId, JSON.stringify({ userHome: home(), localUser: 'fixture', agentPath: null }));
  rawResources.add(binding);
  return { resourceId, binding };
}
async function closeRaw(binding) {
  assert.equal(JSON.parse(await binding.shutdown(3000)).complete, true);
  assert.equal(await binding.readEvent(), null);
  rawResources.delete(binding);
}
async function login(binding) {
  const pending = binding.connect('connect', JSON.stringify(target), 5000);
  const event = JSON.parse(await binding.readEvent());
  assert.equal(event.operationId, 'connect'); assert.equal(event.sequence, 1);
  assert.equal(binding.answer('connect', event.requestId, 'fixture-password'), true);
  assert.equal(JSON.parse(await pending).result.connected, true);
}
async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= until) throw new Error('Fixture observation timed out'); await sleep(10); }
}
function invoke(window, channel, payload) {
  return window.webContents.executeJavaScript(`window.sshFixture.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload ?? null)})`);
}
async function window() {
  const value = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'ssh-preload.cjs') } });
  windows.set(value.webContents.id, value);
  handlers.attachOwner(value.webContents.id);
  await value.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8"><title>SSH fixture</title>');
  await value.webContents.executeJavaScript('window.prompts = []; window.sshFixture.onPrompt(payload => { window.prompts.push(payload); });');
  return value;
}

async function run() {
  await app.whenReady(); app.dock?.hide();
  addon = loadNativeAddon(addonPath);
  await test('normal Electron loads SSH inside its own process', async () => {
    assert.ok(process.versions.electron); assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(addon.processId(), process.pid); assert.equal(addon.abiVersion(), 1);
    assert.equal(typeof addon.NativeSsh, 'function');
    assert.equal(addon.createCredentialFixture, undefined);
  });
  await test('native Promise envelopes, challenge IDs, binary bytes and nonzero exit survive Electron loading', async () => {
    const { binding, resourceId } = raw();
    await login(binding);
    const result = JSON.parse(await binding.execute('binary', 'fixture:binary', 3000));
    assert.equal(result.resourceId, resourceId); assert.equal(result.operationId, 'binary');
    assert.deepEqual(Buffer.from(result.result.stdoutBase64, 'base64'), Buffer.from([0, 255, 1, 195, 169]));
    assert.equal(Buffer.from(result.result.stderrBase64, 'base64').toString(), 'fixture stderr');
    assert.equal(result.result.exitCode, 7); assert.equal(result.result.outputComplete, true);
    await closeRaw(binding);
  });
  await test('accepted command timeout is explicit and records exactly one remote execution', async () => {
    const { binding } = raw(); await login(binding);
    const before = JSON.parse(fs.readFileSync(path.join(root, 'audit.json'), 'utf8')).commands.filter(value => value === 'fixture:hang').length;
    await assert.rejects(binding.execute('hang', 'fixture:hang', 250), /SSH_OPERATION_OUTCOME_UNKNOWN/);
    await closeRaw(binding);
    const after = JSON.parse(fs.readFileSync(path.join(root, 'audit.json'), 'utf8')).commands.filter(value => value === 'fixture:hang').length;
    assert.equal(after - before, 1);
  });
  await test('full native queue refuses admission and queued cancellation settles during a live prompt', async () => {
    const { binding } = raw();
    const open = binding.connect('connect', JSON.stringify(target), 5000).then(() => null, error => error);
    const event = JSON.parse(await binding.readEvent());
    const queued = Array.from({ length: 7 }, (_, i) => binding.listHosts(`queued-${i}`, 5000).then(() => null, error => error));
    assert.throws(() => binding.listHosts('full', 100), /BUSY/);
    assert.equal(binding.cancel('queued-0'), true);
    assert.match(String(await queued[0]), /CANCELLED/);
    await closeRaw(binding);
    assert.equal(binding.answer('connect', event.requestId, 'fixture-password'), false);
    assert.match(String(await open), /CANCELLED/); await Promise.all(queued);
  });
  await test('host key mismatch remains a distinct failure before authentication', async () => {
    const dir = home(); fs.mkdirSync(path.join(dir, '.ssh'));
    const known = `[127.0.0.1]:${fixture.port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G2sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X\n`;
    fs.writeFileSync(path.join(dir, '.ssh/known_hosts'), known);
    const binding = new addon.NativeSsh(randomUUID(), JSON.stringify({ userHome: dir, localUser: 'fixture', agentPath: null })); rawResources.add(binding);
    await assert.rejects(binding.connect('open', JSON.stringify(target), 5000), /SSH_HOST_KEY_CHANGED/);
    await closeRaw(binding);
    assert.equal(fs.readFileSync(path.join(dir, '.ssh/known_hosts'), 'utf8'), known);
  });
  await test('wrapper emits two sequenced keyboard challenges and becomes silent after close', async () => {
    const events = [];
    let transport;
    transport = new NativeSshTransport({ userHome: home(), localUser: 'fixture', agentPath: null, addonPath }, async event => {
      events.push(event); assert.equal(transport.answer(event.requestId, event.echo ? 'fixture-user' : 'fixture-otp'), true);
    }); transports.add(transport);
    await transport.connect({ ...target, user: 'interactive' }, 5000);
    assert.deepEqual(events.map(event => [event.sequence, event.echo]), [[1, true], [2, false]]);
    assert.equal((await transport.close()).complete, true); transports.delete(transport);
    await sleep(50); assert.equal(events.length, 2);
    await assert.rejects(transport.execute('late'), /CLOSED/);
  });
  await test('close fences new callbacks and reports an in-flight delivery until it settles', async () => {
    let release; let calls = 0;
    const delivery = new Promise(resolve => { release = resolve; });
    const transport = new NativeSshTransport({ userHome: home(), localUser: 'fixture', agentPath: null, addonPath }, async () => { calls += 1; await delivery; });
    transports.add(transport);
    const connecting = transport.connect(target, 5000).then(() => null, error => error);
    await waitFor(() => calls === 1);
    assert.equal((await transport.close(30)).complete, false);
    release();
    assert.equal((await transport.close()).complete, true);
    assert.match(String(await connecting), /CANCELLED|CLOSED/);
    transports.delete(transport);
    await sleep(50); assert.equal(calls, 1);
  });
  await test('a delivery timeout keeps the resource unsettled until the original callback returns', async () => {
    let release;
    const delivery = new Promise(resolve => { release = resolve; });
    const transport = new NativeSshTransport({ userHome: home(), localUser: 'fixture', agentPath: null, addonPath }, async () => delivery);
    transports.add(transport);
    const connecting = transport.connect(target, 10_000).then(() => null, error => error);
    try {
      await waitFor(() => transport.report().closing, 7500);
      assert.equal(transport.stopped, false);
      const report = await transport.close(30);
      assert.equal(report.complete, false);
      assert.equal(report.deliveryError, 'SSH_PROMPT_DELIVERY_TIMEOUT');
    } finally { release(); }
    assert.equal((await transport.close()).complete, true);
    assert.equal(transport.stopped, true);
    assert.match(String(await connecting), /CANCELLED|CLOSED/);
    transports.delete(transport);
  });

  const registry = new ChannelRegistry();
  const pool = new SshConnectionPool({ userHome: home(), localUser: 'fixture', agentPath: null, addonPath,
    deliver(senderId, _channel, event) {
      delivered.push({ senderId, event });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { acknowledgments.delete(event.requestId); reject(new Error('Fixture delivery deadline')); }, 4000);
        acknowledgments.set(event.requestId, { senderId, finish: () => { clearTimeout(timer); resolve(); } });
        windows.get(senderId).webContents.send('ssh-fixture-prompt', event);
      });
    },
  });
  handlers = registerSshHandlers(registry, pool);
  ipcMain.handle('ssh-fixture-invoke', (event, channel, value) => {
    const handler = registry.lookup(channel); if (!handler) throw new Error('Unknown fixture channel');
    return handler({ senderId: event.sender.id, role: 'main', channel, args: [value] });
  });
  ipcMain.on('ssh-fixture-ack', (event, id) => {
    const pending = acknowledgments.get(id);
    if (pending?.senderId === event.sender.id) { acknowledgments.delete(id); pending.finish(); }
  });
  await test('real isolated renderer receives askpass and caller ownership rejects a different window answer', async () => {
    const first = await window(); const other = await window();
    const index = delivered.length;
    const connecting = invoke(first, 'ssh:test', { target: `fixture@127.0.0.1:${fixture.port}` });
    await waitFor(() => delivered.length > index);
    const { event, senderId } = delivered[index];
    assert.equal(senderId, first.webContents.id);
    assert.deepEqual(await invoke(other, 'ssh:askpass-answer', { requestId: event.requestId, password: 'fixture-password' }), { ok: false });
    assert.deepEqual(await invoke(first, 'ssh:askpass-answer', { requestId: event.requestId, password: 'fixture-password' }), { ok: true });
    assert.deepEqual(await connecting, { ok: true, home: '/fixture home' });
    assert.equal(await first.webContents.executeJavaScript('window.prompts.length'), 1);
    assert.deepEqual(await invoke(first, 'ssh:list-dirs', { target: `fixture@127.0.0.1:${fixture.port}`, path: "/quote'" }),
      { ok: true, path: '/fixture home', dirs: ['plain', 'with\nnewline', "quote'", '.hidden'] });
    assert.equal(delivered.length, index + 1);
    assert.deepEqual(await invoke(first, 'ssh:make-workdir', { target: `fixture@127.0.0.1:${fixture.port}`, path: '/fixture home' }),
      { workdir: `ssh://fixture@127.0.0.1:${fixture.port}/fixture home`, label: 'fixture home @ 127.0.0.1' });
    assert.equal((await handlers.detachOwner(first.webContents.id)).complete, true);
    assert.equal((await handlers.detachOwner(other.webContents.id)).complete, true);
  });
  await test('detaching a window cancels pending authentication and permits no later prompt callback', async () => {
    const first = await window(); const index = delivered.length;
    const connecting = invoke(first, 'ssh:test', { target: `fixture@127.0.0.1:${fixture.port}` });
    await waitFor(() => delivered.length > index);
    assert.equal((await handlers.detachOwner(first.webContents.id)).complete, true);
    const result = await connecting; assert.equal(result.ok, false); assert.match(result.error, /CANCELLED|CLOSED|not attached/);
    await sleep(50); assert.equal(delivered.length, index + 1);
  });
  for (const [name, answer, expected] of [['rejected', 'wrong-password', /SSH_AUTHENTICATION_FAILED/], ['cancelled', null, /CANCELLED/]]) {
    await test(`the same renderer and target recover after ${name} authentication`, async () => {
      const first = await window();
      const wanted = `fixture@127.0.0.1:${fixture.port}`;
      const index = delivered.length;
      const failed = invoke(first, 'ssh:test', { target: wanted });
      await waitFor(() => delivered.length > index);
      const previous = delivered[index].event;
      assert.deepEqual(await invoke(first, 'ssh:askpass-answer', { requestId: previous.requestId, password: answer }), { ok: true });
      const result = await failed; assert.equal(result.ok, false); assert.match(result.error, expected);
      const retryIndex = delivered.length;
      const retried = invoke(first, 'ssh:test', { target: wanted });
      await waitFor(() => delivered.length > retryIndex);
      const current = delivered[retryIndex].event;
      assert.notEqual(current.resourceId, previous.resourceId);
      assert.equal(current.sequence, 1);
      assert.deepEqual(await invoke(first, 'ssh:askpass-answer', { requestId: previous.requestId, password: 'fixture-password' }), { ok: false });
      assert.deepEqual(await invoke(first, 'ssh:askpass-answer', { requestId: current.requestId, password: 'fixture-password' }), { ok: true });
      assert.deepEqual(await retried, { ok: true, home: '/fixture home' });
      assert.equal((await handlers.detachOwner(first.webContents.id)).complete, true);
    });
  }
  await test('a refused network connection recovers through the same handler target', async () => {
    const first = await window();
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const wanted = `fixture@127.0.0.1:${port}`;
    const failed = await invoke(first, 'ssh:test', { target: wanted });
    assert.equal(failed.ok, false);
    const sockets = new Set();
    const forwarder = net.createServer(socket => {
      const upstream = net.connect(fixture.port, '127.0.0.1');
      sockets.add(socket); sockets.add(upstream);
      for (const [current, other] of [[socket, upstream], [upstream, socket]]) {
        current.on('error', () => other.destroy());
        current.on('close', () => { sockets.delete(current); other.destroy(); });
      }
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise((resolve, reject) => { forwarder.once('error', reject); forwarder.listen(port, '127.0.0.1', resolve); });
    try {
      const index = delivered.length;
      const retried = invoke(first, 'ssh:test', { target: wanted });
      await waitFor(() => delivered.length > index);
      assert.deepEqual(await invoke(first, 'ssh:askpass-answer', { requestId: delivered[index].event.requestId, password: 'fixture-password' }), { ok: true });
      assert.deepEqual(await retried, { ok: true, home: '/fixture home' });
    } finally {
      assert.equal((await handlers.detachOwner(first.webContents.id)).complete, true);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => forwarder.close(resolve));
    }
  });
  await test('a failed connection remains fenced while its previous callback is still running', async () => {
    const localRegistry = new ChannelRegistry(); const captured = [];
    let release; let challenge; let calls = 0;
    const blocked = new Promise(resolve => { release = resolve; });
    const local = registerSshHandlers(localRegistry, new SshConnectionPool({
      userHome: home(), localUser: 'fixture', agentPath: null, addonPath,
      createTransport(options, deliver) { const transport = new NativeSshTransport(options, deliver); captured.push(transport); return transport; },
      async deliver(_owner, _channel, event) {
        calls += 1;
        if (calls === 1) { challenge = event; await blocked; }
        else assert.equal(captured.at(-1).answer(event.requestId, 'fixture-password'), true);
      },
    }));
    local.attachOwner(9001);
    const call = () => localRegistry.lookup('ssh:test')({ senderId: 9001, role: 'main', channel: 'ssh:test', args: [{ target: `fixture@127.0.0.1:${fixture.port}` }] });
    try {
      const first = call();
      await waitFor(() => challenge);
      assert.equal(captured[0].answer(challenge.requestId, null), true);
      await waitFor(() => captured[0].report().complete);
      const premature = await call();
      assert.equal(premature.ok, false); assert.match(premature.error, /SSH_RESOURCE_CLOSING/);
      assert.equal(captured.length, 1);
      release();
      assert.equal((await first).ok, false);
      assert.deepEqual(await call(), { ok: true, home: '/fixture home' });
      assert.equal(captured.length, 2);
    } finally { release(); assert.equal((await local.shutdown()).complete, true); }
  });
  await test('a stopped config transport is replaced on the next list-hosts call', async () => {
    const localRegistry = new ChannelRegistry(); const captured = [];
    const local = registerSshHandlers(localRegistry, new SshConnectionPool({
      userHome: home(), localUser: 'fixture', agentPath: null, addonPath, async deliver() { throw new Error('No configuration prompt is permitted'); },
      createTransport(options, deliver) { const transport = new NativeSshTransport(options, deliver); captured.push(transport); return transport; },
    }));
    local.attachOwner(9002);
    const call = () => localRegistry.lookup('ssh:list-hosts')({ senderId: 9002, role: 'main', channel: 'ssh:list-hosts', args: [] });
    try {
      assert.deepEqual(await call(), { hosts: [] });
      assert.equal((await captured[0].close()).complete, true);
      assert.deepEqual(await call(), { hosts: [] });
      assert.equal(captured.length, 2);
      assert.notEqual(captured[0].resourceId, captured[1].resourceId);
    } finally { assert.equal((await local.shutdown()).complete, true); }
  });
  await test('directory framing preserves special names and refuses malformed or excessive responses', async () => {
    assert.equal(parseSshTarget('ssh://fixture@host:2222/a').port, 2222);
    assert.throws(() => parseSshTarget('host:99999'), /SSH_INVALID_TARGET/);
    assert.throws(() => sshDirectoryCommand('relative'), /SSH_INVALID_PATH/);
    const result = { stdout: Buffer.from('/root\0'), stderr: Buffer.alloc(0), exitCode: 0, signal: null, outputComplete: true };
    assert.deepEqual(sshDirectoryResult(result), { ok: true, path: '/root', dirs: [] });
    assert.throws(() => sshDirectoryResult({ ...result, stdout: Buffer.from('/root\0bad/name\0') }), /SSH_DIRECTORY_RESPONSE_INVALID/);
    assert.throws(() => sshDirectoryResult({ ...result, stdout: Buffer.from('/root\0' + 'x\0'.repeat(10001)) }), /SSH_DIRECTORY_RESPONSE_INVALID/);
    if (process.platform !== 'win32') {
      const dir = path.join(home(), "quoted'; $value"); fs.mkdirSync(dir);
      for (const name of ["quote'", 'with\nnewline', '.hidden', 'plain']) fs.mkdirSync(path.join(dir, name));
      const output = require('node:child_process').spawnSync('/bin/sh', ['-c', sshDirectoryCommand(dir)]);
      assert.equal(output.status, 0);
      assert.deepEqual(sshDirectoryResult({ ...result, stdout: output.stdout }).dirs.sort(), ['.hidden', 'plain', "quote'", 'with\nnewline'].sort());
    }
  });
}

const watchdog = setTimeout(() => { console.error('SSH Electron gate timed out'); app.exit(1); }, 100_000);
run().catch(error => { results.push({ name: 'suite setup', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  try {
    if (handlers) assert.equal((await handlers.shutdown()).complete, true);
    for (const binding of rawResources) assert.equal(JSON.parse(await binding.shutdown(5000)).complete, true);
    for (const transport of transports) assert.equal((await transport.close()).complete, true);
    for (const window of windows.values()) window.destroy();
  } catch (error) { results.push({ name: 'shutdown', ok: false, error: error.stack }); console.error(error); }
  clearTimeout(watchdog);
  const failed = results.filter(result => !result.ok).length;
  fs.mkdirSync(path.resolve('native/test-results'), { recursive: true });
  fs.writeFileSync(path.resolve('native/test-results/ssh-electron.json'), JSON.stringify({ results }, null, 2));
  console.log(`ssh-electron: ${results.length - failed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
