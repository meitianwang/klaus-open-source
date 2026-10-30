const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, ipcMain } = require('electron');
const { loadNativeAddon } = require('../../dist/main/native/binding');
const { NativeCapabilities } = require('../../dist/main/native/service');
const { ChannelRegistry } = require('../../dist/main/ipc/registry');
const { registerNativeHandlers } = require('../../dist/main/ipc/handlers/native');
const root = process.env.KLAUS_CONPTY_TEST_ROOT;
if (process.platform !== 'win32' || !root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-conpty-electron-')) throw new Error('An isolated Windows gate profile is required');
const executable = process.env.KLAUS_CONPTY_NODE_EXECUTABLE;
if (!executable || !path.isAbsolute(executable)) throw new Error('An explicit fixture Node executable is required');
fs.mkdirSync(path.join(root, 'electron'));
app.setPath('userData', path.join(root, 'electron'));
app.disableHardwareAcceleration();
const results = [], live = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const until = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() >= until) throw new Error(`Timed out: ${label}`); await sleep(10); }
}
function directory() { const value = path.join(root, randomUUID()); fs.mkdirSync(value); return value; }
function options(script, cwd = directory()) { return { cwd, command: executable, args: ['-e', script], env: [], cols: 80, rows: 24, deadlineMs: 10000 }; }
const interactive = String.raw`process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdout.write('READY');let text='';process.stdin.on('data',s=>{text+=s;if(text.includes('\r')){process.stdout.write('INPUT:'+text.replace(/\r/g,'')+' SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\r\n',()=>process.exit(7));}});`;
const flood = String.raw`const chunk='Q'.repeat(128)+'\r\n';let n=0;function write(){while(n<24576){n++;if(!process.stdout.write(chunk)){process.stdout.once('drain',write);return;}}process.stdout.write('DONE',()=>process.exit(0));}write();`;
let addon;
function host() { const binding = new addon.NativeHost(); live.add(binding); return binding; }
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); }
}
async function run() {
  await app.whenReady();
  await test('the Windows addon loads in the same normal Electron main process', async () => {
    assert.ok(process.versions.electron);
    assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
    addon = loadNativeAddon(path.resolve(__dirname, '../artifacts', `klaus-native-${process.platform}-${process.arch}.node`));
    assert.equal(addon.processId(), process.pid);
    assert.equal(addon.abiVersion(), 1);
    assert.equal(typeof addon.NativeCredentials, 'function');
    assert.equal(addon.createCredentialFixture, undefined);
    assert.equal(addon.createWhatsAppFixture, undefined);
    for (const method of ['readMcpOAuthRecord', 'writeMcpOAuthRecord', 'removeMcpOAuthRecord']) {
      assert.equal(typeof addon.NativeCredentials.prototype[method], 'function');
    }
    console.log(`  runtime Electron=${process.versions.electron} Node=${process.versions.node} N-API=${process.versions.napi} pid=${process.pid}`);
  });
  if (!addon) throw new Error('Addon did not load');
  await require('./directory-quiescence.cjs')(test, host, directory, cwd => options('process.stdin.resume();setInterval(()=>{},1000);', cwd));
  await test('Windows file search observes filesystem changes and immediate cancellation', async () => {
    const binding = host(), capabilities = new NativeCapabilities(binding, () => {}), cwd = directory();
    capabilities.registerOwner('search');
    fs.writeFileSync(path.join(cwd, '你好.txt'), '');
    assert.deepEqual((await capabilities.search('search', { root: cwd, query: '你好', limit: 10, deadlineMs: 3000 }).result).hits, [{ rel: '你好.txt', name: '你好.txt', isDir: false }]);
    const job = capabilities.search('search', { root: cwd, query: '', limit: 10, deadlineMs: 3000 });
    job.cancel(); await assert.rejects(job.result, /CANCELLED/);
    fs.unlinkSync(path.join(cwd, '你好.txt'));
    assert.deepEqual((await capabilities.search('search', { root: cwd, query: '你好', limit: 10, deadlineMs: 3000 }).result).hits, []);
    assert.equal((await capabilities.shutdown()).complete, true);
  });
  await test('ConPTY input, Unicode, resize, ordered events and close cross N-API', async () => {
    const binding = host(), errors = [], capabilities = new NativeCapabilities(binding, (_o, _r, error) => errors.push(error));
    capabilities.registerOwner('interactive');
    const chunks = []; let sequence = 0, exit;
    const resource = capabilities.openPty('interactive', options(interactive), event => {
      assert.equal(event.sequence, ++sequence);
      if (event.kind === 'data') chunks.push(event.data); else exit = event;
    });
    await resource.ready;
    await waitFor(() => Buffer.concat(chunks).includes(Buffer.from('READY')), 'readiness');
    assert.equal(exit, undefined, Buffer.concat(chunks).toString());
    assert.equal((await resource.resize(97, 31, 3000, 'resize')).operationId, 'resize');
    await sleep(40);
    assert.equal((await resource.write(Buffer.from('你好\r'), 3000, 'input')).bytesWritten, 7);
    await resource.finished;
    const text = Buffer.concat(chunks).toString();
    assert.ok(text.includes('INPUT:你好 SIZE:97x31'), JSON.stringify(text));
    assert.equal(exit.exitCode, 7); assert.equal(exit.outputComplete, true);
    const closing = resource.close(3000); assert.equal(resource.close(), closing);
    const report = await closing;
    assert.equal(report.complete, true, JSON.stringify(report)); assert.equal(report.deliveryComplete, true);
    const count = sequence; await sleep(30); assert.equal(sequence, count);
    assert.deepEqual(errors, []); await capabilities.shutdown();
  });
  await test('slow acknowledged delivery preserves three MiB and leaves Electron responsive', async () => {
    const binding = host(), capabilities = new NativeCapabilities(binding, () => {});
    capabilities.registerOwner('flood');
    let glyphs = 0, ticks = 0, active = 0, peak = 0;
    const timer = setInterval(() => ticks++, 5);
    const resource = capabilities.openPty('flood', { ...options(flood), cols: 140 }, async event => {
      active++; peak = Math.max(peak, active);
      for (const byte of event.data) if (byte === 81) glyphs++;
      if (event.kind === 'data') await sleep(4);
      active--;
    });
    try {
      await resource.ready; await resource.finished;
      const report = await resource.close(3000);
      assert.equal(glyphs, 3145728); assert.equal(peak, 1);
      assert.equal(report.complete, true, JSON.stringify(report)); assert.equal(report.discardedBytes, 0);
      assert.ok(report.peakQueueChunks <= 65); assert.ok(ticks > 20);
    } finally { clearInterval(timer); await capabilities.shutdown(); }
  });
  await test('deadline close fences stalled data and error callbacks on Windows', async () => {
    const binding = host(); let errors = 0, callbacks = 0, release;
    const gate = new Promise((_resolve, reject) => { release = () => reject(new Error('late sink rejection')); });
    const capabilities = new NativeCapabilities(binding, () => errors++); capabilities.registerOwner('stalled');
    const resource = capabilities.openPty('stalled', options(flood), async () => { callbacks++; await gate; });
    await resource.ready; await waitFor(() => callbacks === 1, 'stalled sink');
    const started = Date.now(), report = await resource.close(100);
    assert.ok(Date.now() - started < 500); assert.equal(report.complete, false); assert.equal(report.deliveryComplete, false);
    const count = callbacks; release(); await resource.finished; await sleep(30);
    assert.equal(callbacks, count); assert.equal(errors, 0); await capabilities.shutdown();
  });
  await test('a sandboxed renderer invokes the terminal and acknowledges its native events', async () => {
    const binding = host(), capabilities = new NativeCapabilities(binding, () => {}), registry = new ChannelRegistry(), cwd = directory();
    const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'electron-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    const pending = new Map(); let peak = 0;
    const ack = (event, id) => { if (event.sender.id !== window.webContents.id) return; const entry = pending.get(id); if (entry) { clearTimeout(entry.timer); pending.delete(id); entry.resolve(); } };
    ipcMain.on('native-test:ack', ack);
    const handlers = registerNativeHandlers(registry, {
      capabilities, resolveSearchRoots: async () => ({ root: cwd, extraRoots: [] }), resolveTerminalOptions: async () => options(interactive, cwd),
      deliver: (senderId, channel, payload) => new Promise((resolve, reject) => {
        assert.equal(senderId, window.webContents.id); assert.ok(pending.size < 8);
        const deliveryId = randomUUID();
        const timer = setTimeout(() => { pending.delete(deliveryId); reject(new Error('renderer ACK deadline')); }, 3000);
        pending.set(deliveryId, { resolve, timer }); peak = Math.max(peak, pending.size);
        window.webContents.send('native-test:event', { deliveryId, channel, payload });
      }),
    });
    handlers.attachOwner(window.webContents.id);
    ipcMain.handle('native-test:invoke', (event, channel, value) => {
      assert.equal(event.sender.id, window.webContents.id); const handler = registry.lookup(channel); assert.ok(handler);
      return handler({ role: 'main', senderId: event.sender.id, channel, args: [value] });
    });
    try {
      await window.loadFile(path.join(__dirname, 'renderer.html'));
      const invoke = (channel, payload) => window.webContents.executeJavaScript(`window.nativeTest.invoke(${JSON.stringify(channel)},${JSON.stringify(payload)})`);
      assert.equal((await invoke('terminal:start', { id: 'renderer-terminal' })).ok, true);
      const received = () => window.webContents.executeJavaScript('window.nativeTest.received()');
      await waitFor(async () => (await received()).some(event => event.payload.data?.includes('READY')), 'renderer readiness');
      assert.deepEqual(await invoke('terminal:write', { id: 'renderer-terminal', data: 'renderer input\r' }), { ok: true });
      await waitFor(async () => (await received()).some(event => event.channel === 'terminal:exit'), 'renderer exit');
      const events = await received();
      assert.ok(events.map(event => event.payload.data ?? '').join('').includes('INPUT:renderer input'));
      assert.equal(events.at(-1).payload.exitCode, 7); assert.equal(peak, 1); assert.equal(pending.size, 0);
      assert.ok(events.every(event => event.payload.id === 'renderer-terminal' && typeof event.payload.resourceId === 'string' && Number.isInteger(event.payload.sequence)));
      assert.equal((await handlers.detachOwner(window.webContents.id)).complete, true);
      await capabilities.shutdown();
    } finally {
      ipcMain.removeHandler('native-test:invoke'); ipcMain.removeListener('native-test:ack', ack);
      for (const value of pending.values()) clearTimeout(value.timer);
      window.destroy();
    }
  });
}
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('ConPTY Electron watchdog expired'); app.exit(1); }, 90000);
run().catch(error => { results.push({ name: 'suite', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const binding of live) { try { await binding.shutdown(2000); } catch {} }
  const passed = results.filter(result => result.ok).length, failed = results.length - passed;
  const output = path.join(__dirname, '../test-results'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'conpty-electron.json'), JSON.stringify({ electron: process.versions.electron, passed, failed, results }, null, 2));
  console.log(`conpty-electron: ${passed} passed, ${failed} failed`); clearTimeout(watchdog); app.exit(failed ? 1 : 0);
});
