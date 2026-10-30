const { storeBytes } = require('../dist/main/services/media');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, screen, nativeImage } = require('electron');
const { NativeComputerUse } = require('../dist/main/native/computer-use');
const { ComputerUsePolicyService } = require('../dist/main/services/computer-use/policy');
const { ComputerUseConnector } = require('../dist/main/services/computer-use/connector');
const root = process.env.KLAUS_COMPUTER_USE_TEST_ROOT;
if (process.platform !== 'win32' || !root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-computer-use-windows-')) throw Error('An isolated Windows Computer Use fixture profile is required');
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {});
const results = []; let window, backend, connector, latest, approvals = 0;
const input = process.execPath, nativeApp = path.join(root, 'Klaus CU Windows Native Fixture.exe');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, timeout = 7000) {
  const end = Date.now() + timeout;
  do { if (await probe()) return; await sleep(10); } while (Date.now() < end);
  throw Error('Synthetic Windows UI condition timed out');
}
const context = (signal = new AbortController().signal) => ({ sessionId: 'windows-fixture', turnId: 'fixture-turn', signal,
  elicit: async () => { approvals++; return { action: 'accept' }; } });
const invoke = (name, args = {}, signal) => connector.call(name, { app: input, ...args }, context(signal));
const dom = source => window.webContents.executeJavaScript(source);
async function read() {
  latest = await invoke('get_app_state');
  fs.writeFileSync(path.join(root, 'latest-tree.txt'), latest.content[0].text);
  return latest;
}
function index(label) {
  const line = latest.content[0].text.split('\n').find(value => value.includes(label));
  assert.ok(line, `Synthetic UIA element ${label} must be visible`);
  return line.trim().match(/^([0-9]+)/)[1];
}
async function point(selector) {
  const geometry = await dom(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,scale:devicePixelRatio}})()`);
  const mapping = latest._meta.klaus.computerUse.mapping;
  const content = screen.dipToScreenRect(window, window.getContentBounds());
  return { x: (content.x + geometry.x * geometry.scale - mapping.screenshotScreenX) / mapping.screenshotScreenWidth * mapping.screenshotPixelWidth,
    y: (content.y + geometry.y * geometry.scale - mapping.screenshotScreenY) / mapping.screenshotScreenHeight * mapping.screenshotPixelHeight };
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); throw error; }
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ title: 'Klaus Computer Use Windows Fixture', width: 800, height: 690, x: 100, y: 70, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  fs.writeFileSync(path.join(root, 'synthetic.html'), `<!doctype html><html><head><title>Klaus Computer Use Windows Fixture</title></head><body style="background:white;color:black;font:18px sans-serif;padding:20px">
    <h1>Klaus synthetic Windows fixture</h1><label>Fixture text <input aria-label="Fixture input" id="input" value="initial fixture value"></label>
    <button aria-label="Fixture increment" onclick="count++;document.querySelector('#count').textContent=count">Increment</button><span id="count">0</span>
    <label><input type="checkbox" id="toggle" aria-label="Fixture toggle">Toggle</label>
    <div id="scroll" tabindex="0" role="region" aria-label="Fixture scroll region" style="height:160px;overflow:auto;border:2px solid black;margin-top:20px"><div style="height:1800px;background:linear-gradient(white,lightblue)">Fixture scroll content</div></div>
    <div id="drag" draggable="true" aria-label="Fixture drag source" style="background:red;width:60px;height:40px">Drag</div>
    <div id="drop" aria-label="Fixture drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault();dropped=true" style="background:lightgreen;width:160px;height:50px;margin-left:300px">Drop</div>
    <textarea id="multiline" aria-label="Fixture multiline" style="width:350px;height:60px">line1
line2
line3</textarea><div id="cancel-drag" style="width:90px;height:25px;background:blue">Cancel drag</div>
    <script>window.count=0;window.dropped=false;window.keyEvents=0;window.keys=[];window.heldCodes=[];window.downs=0;window.ups=0;window.rights=0;
    document.addEventListener('keydown',e=>{keyEvents++;if(!heldCodes.includes(e.code))heldCodes.push(e.code);keys.push({key:e.key,code:e.code,ctrl:e.ctrlKey,shift:e.shiftKey,alt:e.altKey,meta:e.metaKey,composing:e.isComposing,target:e.target.id})});document.addEventListener('keyup',e=>{heldCodes=heldCodes.filter(code=>code!==e.code)});document.addEventListener('mousedown',()=>downs++);document.addEventListener('mouseup',()=>ups++);
    document.addEventListener('contextmenu',event=>{event.preventDefault();rights++});</script></body></html>`);
  await window.loadFile(path.join(root, 'synthetic.html'));
  window.show(); window.focus();
  await until(() => window.isFocused()); await sleep(1800);
  console.log('synthetic-display-scale=' + screen.getDisplayMatching(window.getBounds()).scaleFactor);
  console.log('nativeHelperSha256=' + createHash('sha256').update(fs.readFileSync(process.env.KLAUS_COMPUTER_USE_HELPER)).digest('hex'));
  backend = new NativeComputerUse({ command: { executable: process.env.KLAUS_COMPUTER_USE_HELPER } }); await backend.initialize();
  const request = backend.request.bind(backend);
  backend.request = async (operation, signal) => {
    const result = await request(operation, signal);
    if (operation.method === 'state') fs.writeFileSync(path.join(root, 'raw-state.json'), JSON.stringify({ ...result, screenshot: { ...result.screenshot, data: '<own fixture image omitted>' } }, null, 2));
    return result;
  };
  const policy = new ComputerUsePolicyService({ configRoot: path.join(root, 'profile'), availability: () => backend.availability(), enabledChanged: async () => {} });
  await policy.setAppPolicy({ restricted_to_apps: [input, nativeApp] });
  connector = new ComputerUseConnector({ policy, backend,
    saveScreenshot: (data, mime) => storeBytes(Buffer.from(data, 'base64'), mime, path.join(root, 'profile')),
  }); connector.attachSession('windows-fixture');
  await test('interactive Windows loads UIA and captures only the approved real Electron HWND', async () => {
    console.log('nativeWindowsAvailability=' + JSON.stringify(backend.availability())); assert.equal(backend.availability().available, true);
    // The first UIA query enables Chromium's renderer tree asynchronously.
    // Wait for the actual controls before asserting or issuing any input.
    console.log('synthetic-uia-ready-before=' + JSON.stringify({ accessibilitySupportEnabled: app.accessibilitySupportEnabled,
      dom: await dom('({readyState:document.readyState,input:!!document.querySelector("#input")})') }));
    let result, readinessProbes = 0;
    const readinessStarted = Date.now();
    await until(async () => {
      result = await read();
      const inputReady = result.content[0].text.includes('Fixture input'), incrementReady = result.content[0].text.includes('Fixture increment');
      console.log('synthetic-uia-ready-probe=' + JSON.stringify({ probe: ++readinessProbes, elapsedMs: Date.now() - readinessStarted, inputReady, incrementReady }));
      return inputReady && incrementReady;
    }, 7000);
    assert.equal(approvals, 0); assert.equal(result.content[1].type, 'image');
    const metadata = result._meta.klaus.computerUse; assert.equal(metadata.app.pid, process.pid);
    const png = Buffer.from(result.content[1].data, 'base64'), image = nativeImage.createFromBuffer(png);
    assert.deepEqual(image.getSize(), { width: metadata.mapping.screenshotPixelWidth, height: metadata.mapping.screenshotPixelHeight });
    assert.match(result.content[0].text, /Fixture input/);
    const pixels = image.toBitmap(); let color = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) if (Math.max(...pixels.subarray(offset, offset + 3)) - Math.min(...pixels.subarray(offset, offset + 3)) > 100) color++;
    assert.ok(color > 1000, 'The WGC PNG must contain the synthetic colored controls');
    fs.writeFileSync(path.join(root, 'approved-window.png'), png);
  });
  await test('UIA Invoke and ValuePattern update the real approved controls', async () => {
    latest = await invoke('click', { element_index: index('Fixture increment') }); await until(async () => await dom('count') === 1);
    await read(); latest = await invoke('set_value', { element_index: index('Fixture input'), value: 'changed fixture text' });
    assert.equal(await dom('document.querySelector("#input").value'), 'changed fixture text');
  });
  await test('UIA selection and real Unicode input preserve the selected text boundary', async () => {
    await read(); latest = await invoke('select_text', { element_index: index('Fixture input'), text: 'fixture', prefix: 'changed ', selection: 'text' });
    assert.deepEqual(await dom('[document.querySelector("#input").selectionStart,document.querySelector("#input").selectionEnd]'), [8, 15]);
    latest = await invoke('type_text', { text: '中文😀' }); assert.equal(await dom('document.querySelector("#input").value'), 'changed 中文😀 text');
  });
  await test('multiline selection and keyboard aliases retain their actual Windows meaning', async () => {
    await read(); latest = await invoke('select_text', { element_index: index('Fixture multiline'), text: 'line2', prefix: 'line1\n', selection: 'text' });
    assert.deepEqual(await dom('[document.querySelector("#multiline").selectionStart,document.querySelector("#multiline").selectionEnd]'), [6, 11]);
    latest = await invoke('press_key', { key: 'ControlOrMeta+a' });
    assert.deepEqual(await dom('[document.querySelector("#multiline").selectionStart,document.querySelector("#multiline").selectionEnd]'), [0, 17]);
    latest = await invoke('press_key', { key: 'C' });
    const key = await dom('keys.at(-1)');
    assert.equal(key.code, 'KeyC'); assert.equal(key.shift, true); assert.equal(key.ctrl, false); assert.equal(key.target, 'multiline');
    console.log('synthetic-physical-key=' + JSON.stringify(key));
    // Physical keys obey the active IME. Literal text uses the Unicode API;
    // this fixture never switches the user's keyboard layout or input method.
    latest = await invoke('press_key', { key: 'Escape' }); latest = await invoke('press_key', { key: 'ControlOrMeta+a' });
    latest = await invoke('type_text', { text: 'C' });
    assert.equal(await dom('document.querySelector("#multiline").value'), 'C');
    latest = await invoke('press_key', { key: 'BackSpace' }); assert.equal(await dom('document.querySelector("#multiline").value'), '');
    await read(); const controller = new AbortController();
    const pending = invoke('press_key', { key: 'Control_L+Control_R+a', duration: 3 }, controller.signal);
    const rejected = assert.rejects(pending, /may have executed|cancelled|aborted/i);
    await until(() => dom('heldCodes.includes("ControlLeft")&&heldCodes.includes("ControlRight")'));
    controller.abort(); await rejected;
    await until(() => dom('!heldCodes.includes("ControlLeft")&&!heldCodes.includes("ControlRight")'));
    await read(); latest = await invoke('press_key', { key: 'a' });
    assert.equal(await dom('keys.at(-1).ctrl'), false);
  });
  await test('UIA secondary Toggle and scrolling target the approved element', async () => {
    await read(); latest = await invoke('perform_secondary_action', { element_index: index('Fixture toggle'), action: 'Toggle' });
    assert.equal(await dom('document.querySelector("#toggle").checked'), true);
    await read(); latest = await invoke('scroll', { element_index: index('Fixture scroll region'), direction: 'down', pages: 1 });
    await until(async () => await dom('document.querySelector("#scroll").scrollTop') > 0);
  });
  await test('physical screenshot coordinates drive drag and mouse buttons on the selected HWND', async () => {
    await read(); const from = await point('#drag'), to = await point('#drop');
    latest = await invoke('drag', { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y }); assert.equal(await dom('dropped'), true);
    await read(); latest = await invoke('click', await point('button')); await until(async () => await dom('count') === 2);
    await read(); latest = await invoke('click', { ...await point('button'), mouse_button: 'right' }); assert.equal(await dom('rights'), 1);
  });
  await test('cancelling an entered real drag drains helper cleanup and releases its own mouse button', async () => {
    await read(); const from = await point('#cancel-drag'), controller = new AbortController();
    const downs = await dom('downs'), ups = await dom('ups');
    const pending = invoke('drag', { from_x: from.x, from_y: from.y, to_x: from.x + 45, to_y: from.y }, controller.signal);
    const settled = pending.then(() => ({ accepted: true }), error => ({ error: error.message }));
    await until(async () => await dom('downs') > downs); controller.abort();
    const result = await settled; assert.match(result.error ?? '', /cancelled/);
    await until(async () => await dom('ups') > ups);
    const counts = await dom('({downs,ups})');
    console.log('synthetic-drag-cancel=' + JSON.stringify({ result, mouseDownDelta: counts.downs - downs, mouseUpDelta: counts.ups - ups }));
    await read(); latest = await invoke('click', await point('button')); assert.equal(await dom('count'), 3);
  });
  await test('moved windows and changed native element identities reject stale input', async () => {
    await read(); const before = await dom('count'), button = index('Fixture increment'), original = window.getPosition();
    window.setPosition(original[0] + 20, original[1]);
    await assert.rejects(invoke('click', { element_index: button }), /window changed/); assert.equal(await dom('count'), before);
    await read(); const fresh = index('Fixture increment'); await dom('document.querySelector("button").setAttribute("aria-label","Changed fixture identity")');
    await assert.rejects(invoke('click', { element_index: fresh }), /identity changed/); assert.equal(await dom('count'), before);
  });
  await test('approved executable activation launches and focuses only the separate synthetic application', async () => {
    const result = await connector.call('get_app_state', { app: nativeApp }, context());
    const identity = result._meta.klaus.computerUse.app; assert.notEqual(identity.pid, process.pid);
    assert.equal(fs.realpathSync(identity.path).toLowerCase(), fs.realpathSync(nativeApp).toLowerCase()); assert.equal(approvals, 0);
    assert.match(result.content[0].text, /Only synthetic fixture content/); assert.equal(window.isFocused(), false);
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'raw-state.json'), 'utf8')), mapping = result._meta.klaus.computerUse.mapping;
    assert.ok(raw.bounds.width - mapping.screenshotScreenWidth >= 0 && raw.bounds.width - mapping.screenshotScreenWidth <= 1);
    assert.ok(raw.bounds.height - mapping.screenshotScreenHeight >= 0 && raw.bounds.height - mapping.screenshotScreenHeight <= 1);
    console.log('synthetic-native-capture=' + JSON.stringify({ windowBounds: raw.bounds, captureMapping: mapping }));
    const field = raw.elements.find(element => element.title === 'Native fixture field'); assert.ok(field?.bounds);
    await invoke('click', { app: nativeApp,
      x: (field.bounds.x + field.bounds.width / 2 - mapping.screenshotScreenX) / mapping.screenshotScreenWidth * mapping.screenshotPixelWidth,
      y: (field.bounds.y + field.bounds.height / 2 - mapping.screenshotScreenY) / mapping.screenshotScreenHeight * mapping.screenshotPixelHeight });
    await invoke('press_key', { app: nativeApp, key: 'ControlOrMeta+a' });
    const changed = await invoke('type_text', { app: nativeApp, text: 'Native HWND Unicode 中文' });
    assert.match(changed.content[0].text, /Native HWND Unicode 中文/);
  });
  await test('close drains native resources and rejects later work', async () => {
    assert.deepEqual(await connector.close(), { complete: true }); await assert.rejects(invoke('get_app_state'), /unavailable/);
  });
}
let exiting = false;
async function finish(code) {
  if (exiting) return; exiting = true;
  try { if (connector) assert.deepEqual(await connector.close(), { complete: true }); else if (backend) assert.deepEqual(await backend.close(), { complete: true }); }
  catch (error) { console.error(error.stack); code = 1; }
  if (window && !window.isDestroyed()) window.destroy();
  const state = path.join(root, 'native-fixture.json');
  if (fs.existsSync(state)) {
    const pid = JSON.parse(fs.readFileSync(state, 'utf8')).pid;
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
      const quote = value => "'" + value.replaceAll("'", "''") + "'";
      const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { if ($p.ExecutablePath -ne ${quote(nativeApp)}) { throw 'Synthetic process identity changed' }; Stop-Process -Id ${pid}; Wait-Process -Id ${pid} -Timeout 5 -ErrorAction SilentlyContinue }; if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { throw 'Synthetic process did not exit' }`;
      try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 }); }
      catch (error) { console.error(error.message); code = 1; }
    }
  }
  const passed = results.filter(item => item.ok).length, failed = results.filter(item => !item.ok).length;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed, failed, results, cleanup: code === 0 }, null, 2));
  console.log(`computer-use-windows-electron: ${passed} passed, ${failed} failed, 0 info`); app.exit(code);
}
const watchdog = setTimeout(() => { console.error('Windows Computer Use fixture deadline exceeded'); void finish(1); }, 170000);
run().then(() => { clearTimeout(watchdog); return finish(0); }, error => { clearTimeout(watchdog); console.error(error.stack); return finish(1); });
