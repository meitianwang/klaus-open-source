const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, BrowserWindow, ipcMain, protocol, nativeImage } = require('electron');
const { PipService } = require('../dist/main/services/pip');
const { NativePipResource } = require('../dist/main/native/pip');
const { registerPipHandlers } = require('../dist/main/ipc/handlers/pip');
const { ChannelRegistry } = require('../dist/main/ipc/registry');
const { IpcRouter } = require('../dist/main/ipc/router');
const { RoleTable } = require('../dist/main/ipc/contract');
const { createPipRuntime } = require('../dist/main/app/pip-runtime');
const { handleCoreInvoke, HOST_CHANNELS } = require('../dist/main/ipc/binding');
const layoutFailureContract = require('../contracts/vectors/computer-use-pip-vectors.json').nativeLayoutFailure;
const root = process.env.KLAUS_PIP_TEST_ROOT;
const diagnosticsOnly = process.env.KLAUS_PIP_DIAGNOSTICS_ONLY === '1';
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-pip-electron-')) throw new Error('An isolated PiP test profile is required');
app.setPath('userData', path.join(root, 'electron'));
protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const results = [], nativeEvents = [], ports = [], roles = new Map(), services = [], runtimes = [], evidence = [];
let main, source, service, port;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 8000) {
  const deadline = Date.now() + ms;
  do { if (await fn()) return; await sleep(20); } while (Date.now() < deadline);
  throw new Error(`Condition timed out: ${String(fn)}`);
}
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); throw error; }
}
const js = code => main.webContents.executeJavaScript(code);
const invoke = (channel, ...args) => js(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke',${JSON.stringify({ channel, args })})`);
const layout = visible => ({ hostId: 'klaus-main-thread', sessionId: 'synthetic-session', visible, animated: false,
  anchorRect: { x: 0, y: 0, width: 680, height: 470 }, containerRect: { x: 0, y: 0, width: 680, height: 470 },
  anchors: null, anchorRects: null, devicePixelRatio: 1, isCodexHomeAvailable: false, interactionPassthroughRect: null, presentationScope: 'thread' });
function makeService() {
  const own = new PipService({ availability: () => ({ supported: NativePipResource.supported(process.env.KLAUS_PIP_ADDON) }),
    readPreferences: () => fs.existsSync(path.join(root, 'preferences.json')) ? fs.readFileSync(path.join(root, 'preferences.json'), 'utf8') : null,
    writePreferences: raw => fs.writeFileSync(path.join(root, 'preferences.json'), raw), language: () => 'en',
    createNative: (owner, callbacks) => {
      port = new NativePipResource({ addonPath: process.env.KLAUS_PIP_ADDON, helperPath: process.env.KLAUS_PIP_PRODUCER, handle: owner.handle,
        diagnosticPath: path.join(root, 'computer-use-pip-crash.log'),
        onEvent: event => { nativeEvents.push(event); return callbacks.onEvent(event); }, onError: callbacks.onError }); ports.push(port); return port;
    },
    deliver: async (ownerId, channel, state, signal) => {
      if (signal.aborted || main.isDestroyed() || main.webContents.id !== ownerId) throw new Error('fixture owner unavailable');
      main.webContents.send(`ipc:${channel}`, { args: [state] });
      await until(async () => signal.aborted || await js(`window.pipStates.some(value=>value.revision>=${state.revision})`));
      if (signal.aborted) throw new Error('fixture delivery cancelled');
    }, focusBrowser: async target => { evidence.push({ focus: target }); } });
  own.attachOwner({ id: main.webContents.id, handle: main.getNativeWindowHandle() }); services.push(own); return own;
}
async function captureWindow(windowId, file) {
  let failure;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const result = await promisify(execFile)(path.join(root, 'pip-snapshot'), [String(process.pid), String(windowId), file], { timeout: 8000 });
      return JSON.parse(result.stdout);
    } catch (error) {
      failure = error;
      console.error(`pip-snapshot attempt ${attempt}: ${error.stderr || error.message}`);
      if (attempt < 5) await sleep(1000);
    }
  }
  throw failure;
}
async function snapshot(name) {
  const report = port.report(); evidence.push(report);
  const value = await captureWindow(report.native.ownerWindowId, path.join(root, `${name}.png`));
  console.log(`pip-pixels: ${JSON.stringify(value)}`); evidence.push({ name, ...value }); return value;
}
async function run() {
  console.log('pip-startup: waiting for app readiness');
  await app.whenReady();
  console.log('pip-startup: app ready');
  protocol.handle('klaus-app', () => new Response(`<!doctype html><html><body style="margin:0;background:#202020;color:white"><h1>Klaus PiP synthetic owner</h1><script>
    window.pipStates=[];window.__KLAUS_DESKTOP__.event.listen('ipc:computer-use-pip:state',event=>{window.pipStates.push(event.payload.args[0])});
  </script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const registry = new ChannelRegistry(), router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload) => handleCoreInvoke({ roleOf: id => roles.get(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => false }, event, payload.command, payload.args));
  ipcMain.handle(HOST_CHANNELS.windowOp, () => ({ ok: true, value: false }));
  main = new BrowserWindow({ title: 'Klaus PiP Synthetic Owner', x: 20, y: 40, width: 700, height: 530, show: true,
    webPreferences: { preload: path.resolve('dist/preload/main.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--klaus-role=main'] } });
  roles.set(main.webContents.id, 'main'); await main.loadURL('klaus-app://app/main.html'); await until(() => js('!!window.pipStates'));
  console.log('pip-startup: renderer ready');
  service = makeService(); registerPipHandlers(registry, service);
  console.log('pip-startup: native owner attached');
  await test('normal Electron loads the exact owner channels and reports real native availability', async () => {
    const state = await invoke('computer-use-pip:get-state'); assert.equal(state.supported, process.platform === 'darwin');
    assert.equal(await js('typeof require'), 'undefined');
    assert.equal(main.webContents.getLastWebPreferences().sandbox, true);
    if (process.platform === 'darwin') {
      const addon = require(process.env.KLAUS_PIP_ADDON);
      assert.equal(addon.processId(), process.pid);
      assert.throws(() => port.command({ type: 'diagnostics', path: path.join(root, 'wrong-name.log') }), /Invalid preview diagnostic path/);
      assert.throws(() => port.command({ type: 'diagnostics', path: `${root}/other\0/computer-use-pip-crash.log` }), /Invalid preview diagnostic path/);
    }
  });
  if (process.platform !== 'darwin') return;
  await test('actual native browser card shows and hides through the production IPC bridge', async () => {
    const pixels = Buffer.alloc(120 * 80 * 4); for (let offset = 0; offset < pixels.length; offset += 4) { pixels[offset + 2] = 255; pixels[offset + 3] = 255; }
    const url = nativeImage.createFromBitmap(pixels, { width: 120, height: 80 }).toDataURL();
    const lease = service.beginOperation('synthetic-session');
    service.browserResult('synthetic-session', lease, { _meta: { 'klaus/toolSurface': { kind: 'browserUse', browserId: 'synthetic-browser', backend: 'iab', screenshot: { tabId: 1, url } } } });
    await invoke('computer-use-pip:set-host-layout', layout(true));
    await until(() => port.report().native.panelVisible && nativeEvents.some(event => event.type === 'ready'));
    if (!diagnosticsOnly) {
      const before = await snapshot('browser-card'); assert.ok(before.red > 100, 'actual hosted browser pixels must be red');
    }
    const errorsBefore = nativeEvents.filter(event => event.type === layoutFailureContract.invalidComputedFrameEvent).length;
    port.command({ type: 'layout', ...layout(true), anchorRect: { x: 1e308, y: 0, width: 1e308, height: 470 } });
    await until(() => nativeEvents.filter(event => event.type === layoutFailureContract.invalidComputedFrameEvent).length > errorsBefore);
    const diagnosticFile = path.join(root, layoutFailureContract.diagnosticFile);
    const diagnostic = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8').trim().split('\n').at(-1));
    for (const field of layoutFailureContract.diagnosticFields) assert.ok(Object.hasOwn(diagnostic, field), `missing diagnostic ${field}`);
    for (const field of layoutFailureContract.geometryFields) assert.ok(Object.hasOwn(diagnostic.context, field), `missing geometry ${field}`);
    assert.equal(diagnostic.kind, 'invalid-frame');
    assert.equal(diagnostic.exception, null);
    assert.match(diagnostic.context.frame, /inf/i);
    assert.ok(diagnostic.context.sessionIds.includes('synthetic-session'));
    assert.equal(JSON.stringify(diagnostic).includes('data:image'), false, 'diagnostics must not contain preview pixels');
    assert.equal(fs.statSync(diagnosticFile).mode & 0o777, 0o600);
    evidence.push({ diagnostic });
    assert.equal(port.report().native.panelVisible, layoutFailureContract.previewVisibleAfterInvalidFrame, 'invalid native geometry must hide only the preview');
    await invoke('computer-use-pip:set-host-layout', layout(true));
    await until(() => port.report().native.panelVisible === layoutFailureContract.previewVisibleAfterValidLayout);
    if (!diagnosticsOnly) {
      const recovered = await snapshot('browser-card-recovered'); assert.ok(recovered.red > 100, 'valid geometry must restore the preview');
    }
    await invoke('computer-use-pip:set-visibility', { scope: 'task', sessionId: 'synthetic-session', visible: false });
    await until(() => !port.report().native.panelVisible);
    await invoke('computer-use-pip:set-visibility', { scope: 'task', sessionId: 'synthetic-session', visible: true });
    await until(() => port.report().native.panelVisible);
    await invoke('computer-use-pip:set-host-layout', layout(false)); await until(() => !port.report().native.panelVisible);
    await invoke('computer-use-pip:set-host-layout', layout(true)); await until(() => port.report().native.panelVisible);
    service.removeSession('synthetic-session', false); await until(() => !port.report().native.panelVisible);
  });
  if (diagnosticsOnly) return;
  await test('the dedicated producer streams changing pixels from only the approved synthetic window', async () => {
    source = new BrowserWindow({ title: 'Klaus PiP Synthetic Source', x: 740, y: 60, width: 420, height: 340, show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await source.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#0000ff"></body>'));
    const windowId = Number(source.getMediaSourceId().split(':')[1]); assert.ok(windowId > 0);
    service.observe([{ type: 'stream_mode', mode: 'requesting', sessionId: 'synthetic-session', turnId: 'live' }]);
    service.approvedWindow('synthetic-session', service.beginOperation('synthetic-session'), { app: { pid: process.pid, name: 'Synthetic source' }, windowId });
    await invoke('computer-use-pip:set-host-layout', layout(true));
    await until(() => port.report().native.items.some(item => item.contextId > 0), 12_000);
    await until(() => port.report().native.items.every(item => !item.appearanceAnimating));
    const initial = await snapshot('live-blue'); assert.ok(initial.blue > 100, 'WindowServer remote layer must contain blue source pixels');
    await source.webContents.executeJavaScript('document.body.style.background="#00ff00"');
    assert.equal(await source.webContents.executeJavaScript('getComputedStyle(document.body).backgroundColor'), 'rgb(0, 255, 0)');
    await sleep(700);
    const sourcePixels = await captureWindow(windowId, path.join(root, 'source-green.png'));
    evidence.push({ sourcePixels }); assert.ok(sourcePixels.green > 100, 'the source fixture must visibly be green');
    const updated = await snapshot('live-green'); assert.ok(updated.green > 100, 'live remote layer must update to green');
    const pids = port.report().native.producerPids; assert.equal(pids.length, 1); assert.notEqual(pids[0], process.pid);
    assert.equal(port.report().native.queuedCommands <= 64, true);
  });
  await test('completion freezes live pixels and an older turn cannot replace the completed card', async () => {
    const lease = service.beginOperation('synthetic-session'); service.observe([{ type: 'done', sessionId: 'synthetic-session', turnId: 'live' }]);
    await until(() => port.report().native.items.some(item => item.completed));
    assert.deepEqual(service.snapshot().activeTaskIds, []);
    await source.webContents.executeJavaScript('document.body.style.background="#ff0000"'); await sleep(600);
    const frozen = await snapshot('completed-green'); assert.ok(frozen.green > 100, 'completed native frame remains green');
    service.approvedWindow('synthetic-session', lease, { app: { pid: process.pid }, windowId: Number(source.getMediaSourceId().split(':')[1]) });
    assert.equal(port.report().native.items.every(item => item.completed), true);
  });
  await test('reload detaches the owner, waits for producer exit, and permits a new generation', async () => {
    const old = port, pids = old.report().native.producerPids, id = main.webContents.id;
    let drained;
    main.webContents.once('did-start-loading', () => { drained = service.detachOwner(id); });
    main.webContents.reload(); await until(() => !!drained); assert.deepEqual(await drained, { complete: true });
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(old.report().complete, true); assert.equal(old.report().native.items.length, 0);
    await until(() => js('!!window.pipStates')); const oldGeneration = old.report().generation;
    service.attachOwner({ id, handle: main.getNativeWindowHandle() }); assert.notEqual(port.report().generation, oldGeneration);
    assert.throws(() => old.command({ type: 'layout' }), /closing/);
    await invoke('computer-use-pip:set-host-layout', layout(true));
  });
  await test('native event backpressure fails explicitly and drains every producer before closing', async () => {
    await service.detachOwner(main.webContents.id);
    const addon = require(process.env.KLAUS_PIP_ADDON), binding = new addon.NativePip('backpressure-fixture', main.getNativeWindowHandle(), process.env.KLAUS_PIP_PRODUCER);
    try {
      for (let i = 0; i < 70; i++) binding.command(`bad-image-${i}`, JSON.stringify({ type: 'upsertBrowser', presentationId: 'invalid', sessionId: 'fixture', epoch: 0, contentRevision: i,
        dataUrl: 'data:image/png;base64,aGVsbG8=' }));
    } catch (error) { assert.match(String(error), /backpressure/); }
    assert.throws(() => binding.drainEvents(), /backpressure/);
    binding.beginClose(); await until(() => JSON.parse(binding.report(true)).complete); assert.deepEqual(binding.drainEvents(), []);
  });
  await test('the runtime drains real hide and reload events before attaching a fresh native generation', async () => {
    const owned = [], runtime = createPipRuntime(main, new ChannelRegistry(), {
      addonPath: process.env.KLAUS_PIP_ADDON, helperPath: process.env.KLAUS_PIP_PRODUCER,
      readPreferences: () => null, writePreferences: () => {}, language: () => 'en',
      subscriptions: { wait: async (_id, _channel, signal) => { signal.throwIfAborted(); } },
      deliver: async (id, channel, state, signal) => {
        signal.throwIfAborted(); assert.equal(id, main.webContents.id);
        main.webContents.send(`ipc:${channel}`, { args: [state] });
        await until(async () => signal.aborted || await js(`window.pipStates.some(value=>value.revision>=${state.revision})`));
        signal.throwIfAborted();
      }, focusBrowser: async () => {}, log: (_kind, message) => evidence.push({ runtime: message }),
      backend: { availability: () => ({ supported: NativePipResource.supported(process.env.KLAUS_PIP_ADDON) }), create: (owner, callbacks) => {
        const native = new NativePipResource({ handle: owner.handle, addonPath: process.env.KLAUS_PIP_ADDON, helperPath: process.env.KLAUS_PIP_PRODUCER, ...callbacks });
        owned.push(native); ports.push(native); return native;
      } },
    });
    runtimes.push(runtime); await runtime.ready();
    const before = owned[0], lease = runtime.service.beginOperation('runtime-session');
    runtime.service.approvedWindow('runtime-session', lease, { app: { pid: process.pid, name: 'Synthetic runtime source' }, windowId: Number(source.getMediaSourceId().split(':')[1]) });
    await until(() => before.report().native.items.some(item => item.contextId > 0), 12_000);
    main.hide(); await until(() => before.report().complete);
    assert.equal((await runtime.getState()).supported, true); assert.equal(owned.length, 1);
    let shown = false;
    main.once('show', () => { shown = true; evidence.push({ runtimeShowEvent: true, visible: main.isVisible() }); });
    main.show();
    console.log(`pip-runtime-show: ${JSON.stringify({ visibleImmediately: main.isVisible(), showEventImmediately: shown })}`);
    await until(() => shown); await runtime.ready(); assert.equal(owned.length, 2);
    const second = owned[1]; assert.notEqual(second.report().generation, before.report().generation);
    runtime.service.approvedWindow('runtime-session', lease, { app: { pid: process.pid }, windowId: Number(source.getMediaSourceId().split(':')[1]) });
    assert.equal(second.report().native.items.length, 0);
    const started = new Promise(resolve => main.webContents.once('did-start-navigation', resolve));
    const finished = new Promise(resolve => main.webContents.once('did-finish-load', resolve));
    main.webContents.reload(); await started;
    assert.equal((await runtime.getState()).supported, true); await finished; await runtime.ready();
    assert.equal(second.report().complete, true); assert.equal(owned.length, 3);
    assert.notEqual(owned[2].report().generation, second.report().generation);
    assert.deepEqual(await runtime.shutdown(5000), { complete: true });
  });
}
run().catch(error => { if (!results.some(value => !value.ok)) results.push({ name: 'setup', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const runtime of runtimes) { if (!(await runtime.shutdown(5000)).complete) results.push({ name: 'cleanup', ok: false, error: 'PiP runtime did not drain' }); }
  for (const own of services) { if (!(await own.close(5000)).complete) results.push({ name: 'cleanup', ok: false, error: 'PiP service did not drain' }); }
  for (const own of ports) { if (!(await own.close(5000)).complete) results.push({ name: 'cleanup', ok: false, error: 'Native PiP producer did not exit' }); }
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  const failed = results.filter(value => !value.ok).length, passed = results.length - failed;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed, failed, results, evidence, nativeEvents }, null, 2));
  console.log(`pip-electron: ${passed} passed, ${failed} failed, 0 info`); app.exit(failed ? 1 : 0);
});
