const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { RecordingService } = require('../dist/main/services/recording/service');
const { RecordingHelper } = require('../dist/main/services/recording/helper');
const { RecorderPanel } = require('../dist/main/app/recorder-panel');
const { createRecorderWindow } = require('../dist/main/app/windows');
const { registerRecordingHandlers } = require('../dist/main/ipc/handlers/recording');
const { ChannelRegistry } = require('../dist/main/ipc/registry');
const { IpcRouter } = require('../dist/main/ipc/router');
const { RoleTable } = require('../dist/main/ipc/contract');
const { handleCoreInvoke, HOST_CHANNELS } = require('../dist/main/ipc/binding');
const root = process.env.KLAUS_RECORDING_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-recording-electron-')) throw new Error('An isolated recording fixture profile is required');
app.setPath('userData', path.join(root, 'electron')); app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const results = [], roles = new Map(), services = [], captures = [], logs = [], deliveries = [];
let main, panelWindow, panel, service;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await sleep(20); } while (Date.now() < end);
  throw new Error(`Condition timed out: ${String(fn)}`);
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); throw error; }
}
const js = code => main.webContents.executeJavaScript(code);
const context = () => ({ sessionId: 'creator', signal: new AbortController().signal, elicit: async () => ({ action: 'accept' }) });
function make(command, native = false) {
  const ownPanel = new RecorderPanel({ createWindow: () => { panelWindow = createRecorderWindow('en'); panelWindow.setPosition(100, 100); return panelWindow; },
    registerOwner: window => roles.set(window.webContents.id, 'recorder'), unregisterOwner: id => roles.delete(id), log: value => logs.push(value) });
  let blocked = [];
  const recorder = new RecordingService({ recordingsRoot: path.join(root, `recordings-${services.length}`), platform: 'darwin', command,
    policy: () => ({ blockedApps: blocked, ...(native ? { allowedProcessIds: [process.pid] } : {}) }),
    showPanel: state => ownPanel.show(state), closePanel: id => ownPanel.close(id), log: value => logs.push(value),
    ended: async value => {
      deliveries.push(value); main.webContents.send('ipc:computer-use:record:ended', { args: [value] });
      await until(() => js(`window.recordingFixture.completed.includes(${JSON.stringify(value.recordingId)})`));
    } });
  ownPanel.bind(recorder); services.push(recorder); return { recorder, ownPanel, block: value => { blocked = value; } };
}
async function run() {
  await app.whenReady();
  protocol.handle('klaus-app', request => {
    if (new URL(request.url).pathname === '/recorder.html') return new Response(fs.readFileSync(path.resolve('frontend/recorder.html')), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return new Response(`<!doctype html><html><body><h1>Klaus Recording Synthetic Fixture</h1><textarea id="fixture" style="width:500px;height:180px"></textarea><input type="password" id="password"><script>${fs.readFileSync(path.join(root, 'recording-main-renderer.js'), 'utf8')}</script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  const registry = new ChannelRegistry(), router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload) => handleCoreInvoke({ roleOf: id => roles.get(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => false }, event, payload.command, payload.args));
  ipcMain.handle(HOST_CHANNELS.windowOp, () => ({ ok: true, value: false }));
  main = new BrowserWindow({ title: 'Klaus Recording Synthetic Fixture', width: 620, height: 420, show: true,
    webPreferences: { preload: path.resolve('dist/preload/main.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--klaus-role=main'] } });
  roles.set(main.webContents.id, 'main'); await main.loadURL('klaus-app://app/main.html'); await until(() => js('!!window.recordingFixture'));
  const f = make({ executable: process.execPath, args: [path.resolve('tests/fixtures/recording-helper.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  service = f.recorder; panel = f.ownPanel;
  // The registered dispatch selects the currently bound panel, never a renderer-selected owner.
  registerRecordingHandlers(registry, { status: id => panel.status(id), stop: (id, mode) => panel.stop(id, mode) });
  await test('normal Electron loads the actual recorder page and restricted preload with its captured recording id', async () => {
    const state = await service.start(context()); await until(() => panelWindow.isVisible());
    const preferences = panelWindow.webContents.getLastWebPreferences(); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    assert.equal(await panelWindow.webContents.executeJavaScript('typeof require'), 'undefined');
    const value = await panelWindow.webContents.executeJavaScript('window.__KLAUS_DESKTOP__.core.invoke("ipc_invoke", {channel:"computer-use:record:status",args:[]})');
    assert.equal(value.id, state.id); assert.equal(value.recording, true);
    const foreign = await js('window.__KLAUS_DESKTOP__.core.invoke("ipc_invoke", {channel:"computer-use:record:stop",args:[]}).then(()=>"allowed",e=>JSON.stringify(e))');
    assert.match(foreign, /RESOURCE_NOT_OWNED/);
  });
  await test('the real Stop button closes native transport before handing off once to the creating session', async () => {
    const state = service.snapshot('creator'); await panelWindow.webContents.executeJavaScript('document.getElementById("rec-stop").click()');
    await until(() => deliveries.some(value => value.recordingId === state.id)); await until(() => service.status().state === 'ended' && panelWindow.isDestroyed());
    await until(() => js('window.recordingFixture.sends.length === 1'));
    assert.deepEqual(await js('window.recordingFixture.sends'), ['creator']);
    assert.equal(await js('window.recordingFixture.currentSessionId'), 'different-active-session');
    main.webContents.send('ipc:computer-use:record:ended', { args: [deliveries.at(-1)] }); await sleep(100); assert.equal(await js('window.recordingFixture.sends.length'), 1);
    assert.ok(fs.readFileSync(state.eventsPath, 'utf8').includes('session.ended'));
  });
  await test('the real Discard button deletes its own drained recording and reload stops the next owner', async () => {
    await until(() => service.status().recording === false); await sleep(20);
    const state = await service.start(context()); await panelWindow.webContents.executeJavaScript('document.getElementById("rec-discard").click()');
    await until(() => panelWindow.isDestroyed()); await until(() => js('window.recordingFixture.discards.length === 1'));
    assert.equal(fs.existsSync(state.eventsPath), false); await sleep(20);
    const reloaded = await service.start(context()), previousId = panelWindow.webContents.id;
    panelWindow.webContents.reload(); await until(() => service.status().recording === false && panelWindow.isDestroyed());
    assert.equal(roles.has(previousId), false); assert.equal(service.snapshot('creator').id, reloaded.id);
    await until(() => deliveries.length === 3); await sleep(20);
  });
  await test('error endings visibly report failure and never enter the skill-drafting stop branch', async () => {
    const before = await js('window.recordingFixture.sends.length');
    main.webContents.send('ipc:computer-use:record:ended', { args: [{ recordingId: 'error-fixture', sessionId: 'creator', generation: 1, mode: 'error', error: 'Recording permission was revoked.' }] });
    await until(() => js('window.recordingFixture.failures.includes("Recording permission was revoked.")'));
    assert.equal(await js('window.recordingFixture.sends.length'), before);
    await assert.rejects(js('window.recordingFixture.handoff({recordingId:"lost-session",sessionId:"removed",generation:1,mode:"stop"})'), /session-no-longer-available/);
  });
  if (process.platform !== 'darwin') return;
  const nativePath = process.env.KLAUS_RECORDING_HELPER;
  if (!nativePath || !path.isAbsolute(nativePath)) throw new Error('Explicit native recording helper is required');
  const native = make({ executable: nativePath }, true); panel = native.ownPanel; service = native.recorder;
  await test('real macOS event tap records only the synthetic process, redacts text and honors blocked-app changes', async () => {
    const state = await service.start(context()); main.show(); main.focus(); await until(() => main.isFocused()); await js('document.getElementById("fixture").focus()');
    const input = async mode => {
      const bounds = main.getBounds(), args = [String(process.pid), mode, ...(mode === 'click' ? [String(bounds.x + 100), String(bounds.y + 180)] : [])];
      await new Promise((resolve, reject) => execFile(path.join(root, 'recording-input'), args, { timeout: 10_000 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : (console.log(stdout.trim()), resolve())));
    };
    await input('text'); await until(() => fs.readFileSync(state.eventsPath, 'utf8').includes('keyboard.text_input'), 5000);
    const captured = fs.readFileSync(state.eventsPath, 'utf8'); assert.match(captured, /\[REDACTED_API_KEY\]/); assert.equal(captured.includes('sk-fixture0123456789abcdef'), false);
    await input('click'); await until(() => fs.readFileSync(state.eventsPath, 'utf8').includes('mouse.click'));
    const rows = captured.trim().split('\n').map(JSON.parse), appName = rows.find(value => value.type === 'window.changed').app.name;
    assert.ok(appName); native.block([appName]); await service.updatePolicy(); await input('blocked');
    await until(() => fs.readFileSync(state.eventsPath, 'utf8').includes('recording.excludedApp'));
    native.block([]); await service.updatePolicy(); await input('secure'); await sleep(300);
    await js('document.getElementById("password").focus()'); await input('password'); await sleep(300); await js('document.getElementById("fixture").focus()');
    const result = await service.stop(state.id, 'stop', 'tool'); assert.equal(result.ok, true, result.error); assert.ok(result.state.suppressedEventCount > 0);
    const final = fs.readFileSync(state.eventsPath, 'utf8'); assert.equal(final.includes('excluded-fixture'), false); assert.equal(final.includes('private-fixture-password'), false);
    assert.equal(final.includes('session.ended'), true); assert.equal(panelWindow.isDestroyed(), true);
    const last = fs.statSync(state.eventsPath).size; await sleep(100); assert.equal(fs.statSync(state.eventsPath).size, last);
  });
  await test('real native ACK deadline fails a stalled consumer and close waits for its last entered callback', async () => {
    let release, entered = false;
    const pending = new Promise(resolve => { release = resolve; });
    const capture = new RecordingHelper({ command: { executable: nativePath }, recordingId: 'native-ack-fixture', generation: 1,
      blockedApps: [], allowedProcessIds: [process.pid], onReady: async () => {}, onEvent: async () => { entered = true; await pending; } }); captures.push(capture);
    await capture.ready; await until(() => entered);
    await sleep(5500); assert.throws(() => process.kill(capture.pid, 0), /ESRCH/);
    assert.deepEqual(await capture.close(10), { complete: false }); release();
    await assert.rejects(capture.done, /event-ack-timeout/); assert.deepEqual(await capture.close(), { complete: true });
  });
}
run().catch(error => { if (!results.some(value => !value.ok)) results.push({ name: 'setup', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  for (const recorder of services) { const result = await recorder.close(5000); if (!result.complete) results.push({ name: 'cleanup', ok: false, error: 'Recorder did not drain' }); }
  for (const capture of captures) await capture.close(1000);
  if (panel) await panel.shutdown();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  const failed = results.filter(value => !value.ok).length, passed = results.length - failed;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed, failed, results, logs, deliveries }, null, 2));
  console.log(`recording-electron: ${passed} passed, ${failed} failed, 0 info`); app.exit(failed ? 1 : 0);
});
