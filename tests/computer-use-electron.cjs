const path = require('node:path');
const compiledRoot = process.env.KLAUS_COMPUTER_USE_COMPILED_ROOT
  ? path.resolve(process.env.KLAUS_COMPUTER_USE_COMPILED_ROOT) : path.resolve(__dirname, '../dist');
const { storeBytes } = require(path.join(compiledRoot, 'main/services/media'));
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, powerMonitor } = require('electron');
const { NativeComputerUse } = require(path.join(compiledRoot, 'main/native/computer-use'));
const { ComputerUsePolicyService } = require(path.join(compiledRoot, 'main/services/computer-use/policy'));
const { ComputerUseConnector } = require(path.join(compiledRoot, 'main/services/computer-use/connector'));
const root = process.env.KLAUS_COMPUTER_USE_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-computer-use-electron-')) throw Error('An isolated synthetic Computer Use profile is required');
app.setPath('userData', path.join(root, 'electron'));
// Keep the process alive until native fixture cleanup and the result file finish.
app.on('window-all-closed', () => {});
const results = []; let window, backend, connector, input, latest, approvals = 0, nativePid;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, timeout = 8000) {
  const end = Date.now() + timeout;
  do { if (await probe()) return; await sleep(25); } while (Date.now() < end);
  throw Error('Synthetic UI condition timed out');
}
const context = () => ({ sessionId: 'fixture-session', turnId: 'fixture-turn', signal: new AbortController().signal,
  elicit: async () => { approvals++; return { action: 'accept' }; } });
const interruptedObservation = error => /Approved window.*(?:identified|capture|moved)|Approved.*capture.*changed|Focused accessibility window changed/i.test(error.message);
async function observeStable() {
  const end = Date.now() + 90000;
  for (;;) {
    await until(() => powerMonitor.getSystemIdleTime() >= 2, 120000);
    try { return await connector.call('get_app_state', { app: input }, context()); }
    catch (error) { if (!interruptedObservation(error) || Date.now() >= end) throw error; await sleep(250); }
  }
}
const invoke = async (name, args = {}) => {
  await until(() => powerMonitor.getSystemIdleTime() >= 2, 120000);
  try { return await connector.call(name, { app: input, ...args }, context()); }
  catch (error) {
    if (!interruptedObservation(error) || (name !== 'get_app_state' && !/may have executed/i.test(error.message))) throw error;
    console.log(`synthetic-observation-recovery: ${name}: ${error.message}`);
    return observeStable();
  }
};
async function read() {
  latest = await invoke('get_app_state');
  // Only the fixture's own accessibility result is retained for diagnosis.
  fs.writeFileSync(path.join(root, 'latest-tree.txt'), latest.content[0].text);
  return latest;
}
const dom = source => window.webContents.executeJavaScript(source);
function index(label) {
  const line = latest.content[0].text.split('\n').find(value => value.includes(label));
  assert.ok(line, `Synthetic element ${label} must be visible in the accessibility tree`);
  return line.trim().match(/^([0-9]+)/)[1];
}
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); throw error; }
}
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ title: 'Klaus Computer Use Synthetic Window', width: 720, height: 600, x: 120, y: 80, show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await window.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><head><title>Klaus Computer Use Synthetic Window</title></head><body style="background:white;color:black;font:18px sans-serif;padding:20px">
    <h1>Klaus synthetic Computer Use fixture</h1><label>Fixture text <input aria-label="Fixture input" id="input" value="initial fixture value"></label>
    <button aria-label="Fixture increment" onclick="count++;document.querySelector('#count').textContent=count">Increment</button><span id="count">0</span>
    <div id="scroll" tabindex="0" role="region" aria-label="Fixture scroll region" style="height:180px;overflow:auto;border:2px solid black;margin-top:20px"><div style="height:1800px;background:linear-gradient(white,lightblue)">Fixture scroll content</div></div>
    <div id="drag" draggable="true" aria-label="Fixture drag source" style="background:red;width:60px;height:40px">Drag</div>
    <div id="drop" aria-label="Fixture drop target" ondragover="event.preventDefault()" ondrop="event.preventDefault();dropped=true" style="background:lightgreen;width:160px;height:50px;margin-left:250px">Drop</div>
    <textarea id="multiline" aria-label="Fixture multiline" style="position:absolute;top:510px;right:20px;width:220px;height:40px">line1
line2
line3</textarea>
    <script>window.count=0;window.dropped=false;window.keyEvents=0;window.wheels=[];window.moves=[];window.heldKeys=[];window.keyDetails=[];window.clicks=[];window.pressTimes=[];let downAt=0;
    document.addEventListener('keydown',e=>{keyEvents++;keyDetails.push({type:'down',code:e.code,location:e.location});if(!heldKeys.includes(e.code))heldKeys.push(e.code);downAt=performance.now()});
    document.addEventListener('keyup',e=>{keyDetails.push({type:'up',code:e.code,location:e.location});heldKeys=heldKeys.filter(key=>key!==e.code);pressTimes.push(performance.now()-downAt)});
    document.addEventListener('mousedown',e=>{window.mouseDownAt=performance.now();window.mouseHeld=true;window.lastModifiers={shift:e.shiftKey,meta:e.metaKey,ctrl:e.ctrlKey}});
    document.addEventListener('mouseup',()=>{window.mouseHeld=false;clicks.push({duration:performance.now()-mouseDownAt,...lastModifiers})});
    document.addEventListener('wheel',e=>wheels.push({target:e.target.id,x:e.clientX,y:e.clientY,dy:e.deltaY}));document.addEventListener('mousemove',e=>{if(moves.length<30)moves.push({target:e.target.id,x:e.clientX,y:e.clientY})});</script></body></html>`));
  window.show(); window.focus(); await until(() => window.isFocused()); await sleep(1800);
  input = path.resolve(path.dirname(process.execPath), '../..');
  backend = new NativeComputerUse({ command: { executable: '/bin/sh', args: ['-c', 'exec "$1" 2>>"$2"', 'fixture',
    process.env.KLAUS_COMPUTER_USE_HELPER, path.join(root, 'native-diagnostics.log')], env: { ...process.env, KLAUS_COMPUTER_USE_DIAGNOSTICS: '1' } } }); await backend.initialize();
  const nativeRequest = backend.request.bind(backend);
  backend.request = async (request, signal) => {
    const result = await nativeRequest(request, signal);
    if (request.method === 'resolve' || request.method === 'activate') fs.appendFileSync(path.join(root, 'native-identities.jsonl'), JSON.stringify({ method: request.method, app: request.args.app, result }) + '\n');
    if (request.method === 'state') fs.writeFileSync(path.join(root, 'raw-state.json'), JSON.stringify({ ...result, screenshot: { ...result.screenshot, data: '<fixture image omitted>' } }, null, 2));
    return result;
  };
  const policy = new ComputerUsePolicyService({ configRoot: path.join(root, 'profile'), availability: () => backend.availability(), enabledChanged: async () => {} });
  await policy.setAppPolicy({ restricted_to_apps: [input, process.env.KLAUS_COMPUTER_USE_SYNTHETIC_APP] });
  connector = new ComputerUseConnector({ policy, backend,
    saveScreenshot: (data, mime) => storeBytes(Buffer.from(data, 'base64'), mime, path.join(root, 'profile')),
  }); connector.attachSession('fixture-session');
  await test('normal Electron resolves, approves and captures only its own application window', async () => {
    assert.equal(backend.availability().available, true);
    const result = await read(); assert.equal(approvals, 0); assert.equal(result.content[1].type, 'image');
    console.log(`synthetic-accessibility-enabled: ${app.isAccessibilitySupportEnabled()}`);
    const metadata = result._meta.klaus.computerUse; assert.equal(metadata.app.pid, process.pid);
    assert.ok(metadata.mapping.screenshotPixelWidth > 100); assert.match(result.content[0].text, /Fixture input/);
    fs.writeFileSync(path.join(root, 'approved-window.png'), Buffer.from(result.content[1].data, 'base64'));
  });
  await test('native accessibility click and value writes change the real synthetic controls', async () => {
    latest = await invoke('click', { element_index: index('Fixture increment') }); await until(async () => await dom('count') === 1);
    await read(); latest = await invoke('set_value', { element_index: index('Fixture input'), value: 'changed fixture text' });
    assert.equal(await dom('document.querySelector("#input").value'), 'changed fixture text');
  });
  await test('native selection, Unicode typing and keyboard input update the selected field', async () => {
    await read(); latest = await invoke('select_text', { element_index: index('Fixture input'), text: 'fixture', prefix: 'changed ', selection: 'text' });
    assert.deepEqual(await dom('[document.querySelector("#input").selectionStart,document.querySelector("#input").selectionEnd]'), [8, 15]);
    latest = await invoke('type_text', { text: 'native' }); assert.equal(await dom('document.querySelector("#input").value'), 'changed native text');
    const before = await dom('keyEvents'); latest = await invoke('press_key', { key: 'Tab' }); assert.ok(await dom('keyEvents') > before);
  });
  await test('multiline selections use raw text offsets and keyboard aliases retain their meaning', async () => {
    await read(); latest = await invoke('select_text', { element_index: index('Fixture multiline'), text: 'line2', prefix: 'line1\n', selection: 'text' });
    assert.deepEqual(await dom('[document.querySelector("#multiline").selectionStart,document.querySelector("#multiline").selectionEnd]'), [6, 11]);
    latest = await invoke('press_key', { key: 'ControlOrMeta+a' }); latest = await invoke('press_key', { key: 'C' });
    assert.equal(await dom('document.querySelector("#multiline").value'), 'C');
    latest = await invoke('press_key', { key: 'BackSpace' }); assert.equal(await dom('document.querySelector("#multiline").value'), '');
  });
  await test('modifier clicks, aliases and hold durations reach the actual event handlers', async () => {
    await read(); const before = await dom('count');
    latest = await invoke('click', { element_index: index('Fixture increment'), key: 'Shift_R', duration: 0.15 });
    assert.equal(await dom('count'), before + 1);
    const click = await dom('clicks.at(-1)'); assert.equal(click.shift, true); assert.ok(click.duration >= 120);
    assert.deepEqual(await dom('keyDetails.filter(event=>event.code==="ShiftRight").slice(-2)'), [{ type: 'down', code: 'ShiftRight', location: 2 }, { type: 'up', code: 'ShiftRight', location: 2 }]);
    assert.deepEqual(await dom('heldKeys.filter(key=>key.startsWith("Shift"))'), []); assert.equal(await dom('mouseHeld'), false);
    latest = await invoke('press_key', { key: 'Page_Down', duration: 0.1 });
    assert.ok(await dom('pressTimes.at(-1)') >= 80);
    latest = await invoke('press_key', { key: 'Next' });
    latest = await invoke('press_key', { key: 'Shift_L', duration: 13.1 });
    assert.ok(await dom('pressTimes.at(-1)') >= 13000);
    assert.deepEqual(await dom('heldKeys.filter(key=>key.startsWith("Shift")||key==="PageDown")'), []);
    await read(); latest = await invoke('click', { element_index: index('Fixture increment'), duration: 0.01 });
    assert.equal(await dom('clicks.at(-1).shift'), false);
  });
  await test('Unicode text and Return input preserve multiline and forward-delete semantics', async () => {
    await read(); latest = await invoke('click', { element_index: index('Fixture multiline') });
    latest = await invoke('press_key', { key: 'ControlOrMeta+a' });
    latest = await invoke('type_text', { text: '测试 😀\nsecond line' });
    assert.equal(await dom('document.querySelector("#multiline").value'), '测试 😀\nsecond line');
    latest = await invoke('press_key', { key: 'ControlOrMeta+a' });
    latest = await invoke('type_text', { text: 'abc' });
    await read(); latest = await invoke('select_text', { element_index: index('Fixture multiline'), text: 'abc', selection: 'cursor_before' });
    latest = await invoke('press_key', { key: 'Delete' });
    assert.equal(await dom('document.querySelector("#multiline").value'), 'bc');
  });
  await test('cancelled held input releases both its key chord and mouse button', async () => {
    await read(); const button = index('Fixture increment'), controller = new AbortController();
    const pending = connector.call('click', { app: input, element_index: button, key: 'Shift_L', duration: 3 }, { ...context(), signal: controller.signal });
    const rejected = assert.rejects(pending, /may have executed|cancelled|aborted/i);
    await until(() => dom('mouseHeld===true')); controller.abort(); await rejected;
    await until(() => dom('mouseHeld===false&&heldKeys.filter(key=>key.startsWith("Shift")).length===0')); await read();
  });
  await test('native secondary window action and scroll act on the approved target', async () => {
    await read();
    const rootLine = latest.content[0].text.split('\n').find(line => /^0 /.test(line));
    if (rootLine?.includes('Raise')) latest = await invoke('perform_secondary_action', { element_index: '0', action: 'Raise' });
    else throw Error('The synthetic accessibility window must expose AXRaise');
    await read(); latest = await invoke('scroll', { element_index: index('Fixture scroll region'), direction: 'down', pages: 1 });
    console.log('synthetic-scroll-input: '+JSON.stringify(await dom('({scrollTop:document.querySelector("#scroll").scrollTop,wheels,moves})')));
    await until(async () => await dom('document.querySelector("#scroll").scrollTop') > 0);
  });
  await test('a drag and screenshot coordinate click use the captured window mapping', async () => {
    await read(); const geometry = await dom(`(()=>{const a=document.querySelector('#drag').getBoundingClientRect(),b=document.querySelector('#drop').getBoundingClientRect();return {from:{x:a.x+a.width/2,y:a.y+a.height/2},to:{x:b.x+b.width/2,y:b.y+b.height/2}}})()`);
    const meta = latest._meta.klaus.computerUse.mapping, contentBounds = window.getContentBounds(), nativeBounds = window.getBounds();
    const point = position => ({ x: (position.x + contentBounds.x - nativeBounds.x) / meta.screenshotScreenWidth * meta.screenshotPixelWidth,
      y: (position.y + contentBounds.y - nativeBounds.y) / meta.screenshotScreenHeight * meta.screenshotPixelHeight });
    const from = point(geometry.from), to = point(geometry.to);
    latest = await invoke('drag', { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y });
    assert.equal(await dom('dropped'), true);
    await read(); const button = await dom(`(()=>{const r=document.querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), location = point(button);
    const before = await dom('count'); latest = await invoke('click', location); await until(async () => await dom('count') === before + 1);
  });
  await test('a moved window or changed element identity requires fresh state before an input action', async () => {
    await read(); const before = await dom('count'), button = index('Fixture increment'), original = window.getPosition();
    window.setPosition(original[0] + 20, original[1]);
    await assert.rejects(invoke('click', { element_index: button }), /window changed/); assert.equal(await dom('count'), before);
    await read(); const freshButton = index('Fixture increment');
    await dom('document.querySelector("button").setAttribute("aria-label","Changed fixture identity")');
    await assert.rejects(invoke('click', { element_index: freshButton }), /identity changed/); assert.equal(await dom('count'), before);
  });
  await test('changed observed values are refused before editing and live text can still be observed', async () => {
    await read(); const field = index('Fixture input');
    await dom('document.querySelector("#input").value="user supplied value"');
    await assert.rejects(invoke('set_value', { element_index: field, value: 'stale replacement' }), /No input was sent.*value changed/);
    assert.equal(await dom('document.querySelector("#input").value'), 'user supplied value');
    await dom('window.live=setInterval(()=>document.querySelector("#count").textContent=String(Date.now()),150)');
    const result = await read(); assert.equal(result.content[1].type, 'image');
    await dom('clearInterval(live)');
  });
  await test('application activation opens and focuses only the separately approved synthetic app', async () => {
    const target = process.env.KLAUS_COMPUTER_USE_SYNTHETIC_APP;
    assert.ok(target.startsWith(root + path.sep));
    const result = await connector.call('get_app_state', { app: target }, context());
    const identity = result._meta.klaus.computerUse.app; nativePid = identity.pid;
    assert.notEqual(nativePid, process.pid); assert.equal(fs.realpathSync(identity.path), fs.realpathSync(target)); assert.equal(approvals, 0);
    assert.match(result.content[0].text, /Only synthetic fixture content/);
    assert.equal(window.isFocused(), false);
  });
  await test('native close drains owned children and rejects later work', async () => {
    assert.deepEqual(await connector.close(), { complete: true });
    await assert.rejects(invoke('get_app_state'), /unavailable/);
  });
}
let exiting = false;
async function finish(code) {
  if (exiting) return; exiting = true;
  if (code && window && !window.isDestroyed()) console.error('synthetic-window-status: ' + JSON.stringify({ pid: process.pid, hidden: app.isHidden(), visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), bounds: window.getBounds() }));
  try { if (connector) await connector.close(); else if (backend) await backend.close(); } catch {}
  if (window && !window.isDestroyed()) window.destroy();
  if (!nativePid && fs.existsSync(path.join(root, 'native-fixture.plist'))) {
    try { nativePid = Number(execFileSync('/usr/bin/plutil', ['-extract', 'pid', 'raw', path.join(root, 'native-fixture.plist')], { encoding: 'utf8' })); } catch {}
  }
  if (Number.isSafeInteger(nativePid) && nativePid > 0 && nativePid !== process.pid) {
    try { process.kill(nativePid, 'SIGTERM'); } catch {}
    try { await until(() => { try { process.kill(nativePid, 0); return false; } catch { return true; } }, 3000); }
    catch { code = 1; console.error('Synthetic native app did not finish exiting'); }
  }
  const passed = results.filter(item => item.ok).length, failed = results.filter(item => !item.ok).length;
  if (failed && fs.existsSync(path.join(root, 'native-diagnostics.log'))) console.error(fs.readFileSync(path.join(root, 'native-diagnostics.log'), 'utf8').slice(0, 4096));
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed, failed, results }, null, 2));
  console.log(`computer-use-electron: ${passed} passed, ${failed} failed, 0 info`); app.exit(code);
}
const watchdog = setTimeout(() => { console.error('Computer Use synthetic fixture deadline exceeded'); void finish(1); }, 420000);
run().then(() => { clearTimeout(watchdog); return finish(0); }, error => { clearTimeout(watchdog); console.error(error.stack); return finish(1); });
