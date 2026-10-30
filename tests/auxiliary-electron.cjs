const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, ClipboardItem, globalShortcut, ipcMain, protocol, screen, systemPreferences } = require('electron');
const { QuickInputRuntime } = require('../dist/main/app/quick-input');
const { DesktopShortcuts } = require('../dist/main/app/shortcuts');
const { createQuickInputWindow } = require('../dist/main/app/windows');
const { VoiceService } = require('../dist/main/services/voice/service');
const { ClipboardFiles } = require('../dist/main/services/clipboard-files');
const { SystemPermissions } = require('../dist/main/services/system-permissions');
const { registerVoiceHandlers } = require('../dist/main/ipc/handlers/voice');
const { registerAuxiliaryHandlers } = require('../dist/main/ipc/handlers/auxiliary');
const { ChannelRegistry } = require('../dist/main/ipc/registry');
const { RoleTable } = require('../dist/main/ipc/contract');
const { IpcRouter } = require('../dist/main/ipc/router');
const { handleCoreInvoke, HOST_CHANNELS } = require('../dist/main/ipc/binding');
const { kvSet } = require('../dist/main/services/settings');
const root = process.env.KLAUS_AUXILIARY_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-auxiliary-electron-')) throw new Error('An isolated auxiliary fixture profile is required');
app.setPath('userData', path.join(root, 'electron')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const results = [], roles = new Map(), logs = [], trace = []; let main, quick, runtime, voice, server, clipboard, shortcuts, hotkeyResult;
function record(event, detail) { if (trace.length < 500) trace.push({ at: Date.now(), event, detail }); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => quick.webContents.executeJavaScript(code);
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await sleep(15); } while (Date.now() < end);
  throw new Error(`Condition timed out: ${String(fn)}`);
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); throw error; }
}
function key(value) { quick.webContents.sendInputEvent({ type: 'keyDown', keyCode: value }); quick.webContents.sendInputEvent({ type: 'keyUp', keyCode: value }); }
async function shown() {
  let result;
  if (process.platform === 'win32') {
    // Windows grants foreground activation to actual user-input paths. Exercise the
    // registered OS hotkey instead of weakening the production focus check.
    const pending = new Promise(resolve => { hotkeyResult = resolve; });
    let timer;
    try {
      const nativeInput = fs.readFileSync(path.join(__dirname, 'fixtures/windows-quick-input-hotkey.ps1'), 'utf8');
      await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', nativeInput], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Native hotkey input failed: ${stderr || error.message}`));
        else { console.log(stdout.trim()); resolve(); }
      }));
      result = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native quick-input hotkey was not delivered')), 15_000); })]);
    } finally { if (timer) clearTimeout(timer); hotkeyResult = undefined; }
  } else result = await runtime.show();
  assert.equal(result.ok, true, result.error); await until(() => quick.isVisible() && quick.isFocused()); await until(() => js('!!window.quickFixture'));
}
async function run() {
  await app.whenReady();
  protocol.handle('klaus-app', request => {
    const isQuick = new URL(request.url).pathname === '/quick-input.html';
    const source = fs.readFileSync(path.join(root, isQuick ? 'quick-input-renderer.js' : 'quick-input-main-renderer.js'), 'utf8');
    const html = isQuick ? fs.readFileSync(path.resolve('frontend-dist/quick-input.html'), 'utf8') : '<!doctype html><html><body><div id="submitted"></div></body></html>';
    return new Response(html.replace('</body>', `<script>${source}</script></body>`), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  const registry = new ChannelRegistry(), router = new IpcRouter({ registry, roles: RoleTable.load() });
  let permissionGate, releasePermission, permissionEntered = false, attachmentCount = 0, cloudDelay = false, cloudEntered = false, cloudAborted = false;
  server = createServer((request, response) => {
    let size = 0; request.on('data', value => { size += value.length; });
    request.on('end', () => {
      assert.ok(size > 500); cloudEntered = true;
      if (cloudDelay) response.on('close', () => { cloudAborted = true; });
      else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: 'synthetic quick input' })); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  voice = new VoiceService({ configRoot: path.join(root, 'klaus'), listModels: async () => [], readModelCredential: async () => null,
    micPermission: async () => { permissionEntered = true; if (permissionGate) await permissionGate; return { ok: true, status: 'synthetic-fixture' }; }, deliver: async () => { throw new Error('Quick input does not own system speech events'); } });
  kvSet('voice.transcribe.apiKey', 'isolated-quick-input-fixture', path.join(root, 'klaus'));
  kvSet('voice.transcribe.baseUrl', `http://127.0.0.1:${server.address().port}/v1`, path.join(root, 'klaus'));
  registerVoiceHandlers(registry, voice);
  main = new BrowserWindow({ show: false, width: 600, height: 300, webPreferences: { preload: path.resolve('dist/preload/main.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ['--klaus-role=main'] } });
  roles.set(main.webContents.id, 'main');
  ipcMain.handle(HOST_CHANNELS.windowOp, () => ({ ok: true, value: false }));
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload) => {
    if (payload.args?.channel === 'quick-input:hide') record('renderer-hide', payload.args.args);
    return handleCoreInvoke({ roleOf: id => roles.get(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => false }, event, payload.command, payload.args);
  });
  await main.loadURL('klaus-app://app/index.html'); await until(() => main.webContents.executeJavaScript('!!window.mainFixture'));
  let language = 'zh', delivered = 0;
  runtime = new QuickInputRuntime({ createWindow: () => {
    quick = createQuickInputWindow();
    for (const event of ['show', 'hide', 'focus', 'blur']) quick.on(event, () => record('window-' + event, { visible: quick.isVisible(), focused: quick.isFocused() }));
    return quick;
  }, pageUrl: 'klaus-app://app/quick-input.html',
    workArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, language: () => language,
    registerOwner: window => roles.set(window.webContents.id, 'quick-input'), unregisterOwner: id => roles.delete(id), invalidateDelivery: () => {},
    attachVoiceOwner: id => { record('attach', id); attachmentCount++; voice.attachOwner(id); }, detachVoiceOwner: (id, deadline) => { record('detach', id); return voice.detachOwner(id, deadline); },
    deliverFocus: async (id, value) => {
      assert.equal(id, quick.webContents.id); await until(() => js('!!window.quickFixture'));
      const before = await js('window.quickFixture.focuses.length');
      quick.webContents.send('ipc:quick-input:focus', { args: [value] });
      record('focus-push', value);
      await until(() => js(`window.quickFixture.focuses.length === ${before + 1}`));
    }, submitToMain: async (value, signal) => {
      signal.throwIfAborted(); main.show(); main.focus();
      main.webContents.send('ipc:quick-input:submit', { args: [value] });
      await until(() => main.webContents.executeJavaScript(`window.mainFixture.received.some(value => value.submissionId === ${JSON.stringify(value.submissionId)})`));
      signal.throwIfAborted(); delivered++;
    }, log: value => logs.push(value) });
  if (process.platform === 'win32') {
    shortcuts = new DesktopShortcuts({ shortcuts: globalShortcut, read: key => key === 'global_shortcut' ? 'off' : 'Control+Alt+Shift+F10',
      toggleMain: () => {}, toggleQuickInput: async () => {
        record('native-hotkey'); const result = await runtime.toggle(); record('native-hotkey-result', result);
        hotkeyResult?.(result); hotkeyResult = undefined;
      }, log: value => logs.push(value) });
    assert.equal(shortcuts.start()[1].active, 'Control+Alt+Shift+F10', 'isolated native hotkey registration');
  }
  const fixtureFile = path.join(root, 'copied 中.txt'); fs.writeFileSync(fixtureFile, 'clipboard-format-fixture');
  // Construct real Electron ClipboardItem objects without reading or mutating the system clipboard.
  clipboard = new ClipboardFiles({ read: async () => [new ClipboardItem({ 'text/uri-list': new Blob([pathToFileURL(fixtureFile).href]) })] });
  const permissions = new SystemPermissions({ preferences: systemPreferences, openExternal: async () => { throw new Error('Settings must not open from a status test'); } });
  registerAuxiliaryHandlers(registry, { quickInput: runtime, clipboard, permissions });
  await test('normal Electron loads the existing quick-input page with its restricted sandbox preload and real window geometry', async () => {
    await shown(); assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1');
    const preferences = quick.webContents.getLastWebPreferences(); assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    assert.equal(await js('typeof require'), 'undefined'); assert.equal(await js('typeof window.klaus'), 'undefined');
    assert.equal(await js('document.getElementById("qi-input").placeholder'), '让 Klaus 帮你做点什么…');
    const area = screen.getDisplayMatching(quick.getBounds()).workArea, bounds = quick.getBounds();
    assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width); assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
    assert.equal(await js('document.activeElement.id'), 'qi-input');
  });
  await test('actual Electron toggle, Escape and main-window blur hide quick input and release its voice owner', async () => {
    assert.equal((await runtime.toggle()).ok, true); assert.equal(quick.isVisible(), false);
    await shown(); key('Escape'); await until(() => !quick.isVisible());
    await shown(); main.show(); main.focus(); await until(() => !quick.isVisible());
    await assert.rejects(voice.microphone(quick.webContents.id), /not attached/);
  });
  await test('actual keyboard Enter submits one trimmed draft through the production bridge to the main subscriber', async () => {
    await shown(); await quick.webContents.insertText('  quick fixture 中  '); key('Enter'); key('Enter');
    await until(() => delivered === 1); assert.equal(quick.isVisible(), false);
    assert.deepEqual(await main.webContents.executeJavaScript('window.mainFixture.received.map(value => value.text)'), ['quick fixture 中']);
    language = 'en'; await shown(); assert.equal(await js('document.getElementById("qi-input").value'), '');
    assert.equal(await js('document.getElementById("qi-input").placeholder'), 'Ask Klaus anything…');
  });
  await test('quick-input renderer cannot call main-only channels and a foreign main caller cannot submit as the quick owner', async () => {
    const error = await js('window.__KLAUS_DESKTOP__.core.invoke("ipc_invoke", {channel:"system:permissions:check",args:[]}).then(()=>"allowed",e=>JSON.stringify(e))');
    assert.match(error, /FORBIDDEN_CHANNEL/);
    const spoof = await main.webContents.executeJavaScript('window.__KLAUS_DESKTOP__.core.invoke("ipc_invoke", {channel:"quick-input:submit",args:[{text:"spoof"}]}).then(()=>"allowed",e=>JSON.stringify(e))');
    assert.match(spoof, /RESOURCE_NOT_OWNED/); assert.equal(delivered, 1);
  });
  await test('late getUserMedia resolution after Escape releases the real synthetic audio track and cannot revive recording', async () => {
    await js('window.quickFixture.delay(); window.quickFixture.clickMic()');
    await until(() => js('window.quickFixture.hasPendingStream()')); key('Escape'); await until(() => !quick.isVisible());
    await js('window.quickFixture.release()'); await until(() => js('window.quickFixture.trackState() === "ended"'));
    await shown(); assert.equal(await js('window.quickFixture.state()'), 'idle');
  });
  await test('real MediaRecorder cloud transcription inserts text, then Escape cancels a pending HTTP request without late insertion', async () => {
    await js('window.quickFixture.clickMic()'); await until(() => js('window.quickFixture.state() === "recording"')); await sleep(160); await js('window.quickFixture.clickMic()');
    await until(() => js('document.getElementById("qi-input").value === "synthetic quick input"'));
    cloudDelay = true; cloudEntered = false; await js('window.quickFixture.clickMic()'); await until(() => js('window.quickFixture.state() === "recording"')); await sleep(160); await js('window.quickFixture.clickMic()');
    await until(() => cloudEntered); key('Escape'); await until(() => !quick.isVisible() && cloudAborted);
    await shown(); await sleep(50); assert.equal(await js('document.getElementById("qi-input").value'), ''); assert.deepEqual(await js('window.quickFixture.alerts'), []);
  });
  await test('actual renderer reload waits for a pending OS permission before attaching the replacement owner', async () => {
    permissionEntered = false; permissionGate = new Promise(resolve => { releasePermission = resolve; });
    await js('window.quickFixture.clickMic()'); await until(() => permissionEntered); const before = attachmentCount;
    quick.webContents.reload(); await until(() => !quick.isVisible()); await sleep(80); assert.equal(attachmentCount, before);
    releasePermission(); permissionGate = undefined; await until(() => attachmentCount === before + 1 && quick.isVisible());
    await until(() => js('!!window.quickFixture')); assert.equal(await js('window.quickFixture.state()'), 'idle');
  });
  await test('Electron ClipboardItem file-format fixture and actual OS permission status use the six registered handlers', async () => {
    const files = await registry.lookup('clipboard:read-file-paths')({ role: 'main', senderId: main.webContents.id, channel: 'clipboard:read-file-paths', args: [] });
    assert.deepEqual(files, [fixtureFile]);
    const status = await permissions.check(); assert.equal(status.supported, process.platform === 'darwin'); console.log(`system-permissions=${JSON.stringify(status)}`);
  });
  await test('destroying the actual quick window unregisters its owner and later show creates a fresh renderer', async () => {
    const old = quick.webContents.id; await js('window.quickFixture.close()'); quick.destroy(); await until(() => !roles.has(old));
    await shown(); assert.notEqual(quick.webContents.id, old); await assert.rejects(voice.microphone(old), /not attached/);
    await js('window.quickFixture.close()'); assert.equal((await runtime.shutdown()).complete, true); assert.equal(quick.isDestroyed(), true);
    assert.equal((await voice.shutdown()).complete, true);
  });
}
run().catch(error => { if (!results.some(value => !value.ok)) results.push({ name: 'setup', ok: false, error: error.stack }); console.error(error); }).finally(async () => {
  await runtime?.shutdown(1000); await voice?.shutdown(1000); await clipboard?.close();
  shortcuts?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (main && !main.isDestroyed()) main.destroy(); if (quick && !quick.isDestroyed()) quick.destroy();
  const failed = results.filter(result => !result.ok).length;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ results, logs, trace }, null, 2));
  if (failed) console.error(JSON.stringify(trace.slice(-25)));
  console.log(`auxiliary-electron: ${results.length - failed} passed, ${failed} failed`); app.exit(failed ? 1 : 0);
});
