const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow, screen } = require('electron');
const { createMainWindow, createPetWindow } = require('../dist/main/app/windows');
const { DesktopPetRuntime } = require('../dist/main/app/desktop-pet');

const logs = process.argv[2];
if (!logs || !path.isAbsolute(logs)) throw Error('An absolute input test artifact directory is required');
app.setPath('userData', fs.mkdtempSync(path.join(logs, 'main-input-profile-')));
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const trace = (event, detail) => fs.appendFileSync(path.join(logs, 'main-input.jsonl'), `${JSON.stringify({ event, detail })}\n`);
async function until(check, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await wait(25); }
  throw Error(`Timed out: ${label}`);
}
let runtime, main, pet;
const deadline = setTimeout(() => { console.error('Companion input fixture timed out'); app.exit(1); }, 30_000);
app.whenReady().then(async () => {
  const addon = require(path.join(__dirname, '../native/artifacts', `klaus-native-${process.platform}-${process.arch}.node`));
  const area = screen.getPrimaryDisplay().workArea;
  main = createMainWindow('Companion input fixture');
  main.setBounds({ x: area.x + 20, y: area.y + 20, width: 900, height: 650 });
  await main.loadURL('data:text/html,' + encodeURIComponent(`<!doctype html><html><body style="margin:0;background:white">
    <button id="outside" style="position:absolute;left:50px;top:130px;width:180px;height:80px">Main window</button>
    <button id="overlap" style="position:absolute;left:430px;top:230px;width:180px;height:80px">Under transparent space</button>
    <script>window.clicks={outside:0,overlap:0};for(const id of ['outside','overlap'])document.getElementById(id).onclick=()=>window.clicks[id]++;</script>
    </body></html>`));
  main.show(); app.focus({ steal: true }); main.focus();
  await until(() => main.isFocused(), 'main window initially focused');
  async function input(mode, point) {
    const args = [String(process.pid), mode, ...(point ? [String(point.x), String(point.y)] : [])];
    await new Promise((resolve, reject) => execFile(path.join(logs, 'recording-input'), args, (error, stdout, stderr) => {
      trace('system-input', { mode, point, stdout, stderr, error: error?.message });
      if (error) reject(error); else resolve();
    }));
  }
  async function clickMain(id, activate = false) {
    const point = await main.webContents.executeJavaScript(`(() => {const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    const bounds = main.getBounds(), screenPoint = { x: bounds.x + point.x, y: bounds.y + point.y };
    const before = await main.webContents.executeJavaScript(`window.clicks.${id}`);
    await input('click', screenPoint);
    await until(() => main.isFocused(), 'system click returns focus to the main window');
    if (activate) await input('click', screenPoint);
    await until(async () => (await main.webContents.executeJavaScript(`window.clicks.${id}`)) > before, `main window receives ${id} click`);
    trace('main-click', { id, before, after: await main.webContents.executeJavaScript(`window.clicks.${id}`), mainFocused: main.isFocused() });
  }
  await clickMain('outside');
  console.log('PASS: main window receives system mouse input before opening the companion');
  runtime = new DesktopPetRuntime({
    dataDirectory: path.join(logs, 'main-input-data'), builtIns: [], readShortcut: () => '',
    pageUrl: 'data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:transparent"><textarea id="input" style="position:absolute;box-sizing:border-box;left:350px;top:250px;width:112px;height:121px"></textarea></body></html>'),
    createWindow: () => { pet = createPetWindow(); assert.equal(addon.configurePetPanel(pet.getNativeWindowHandle()), true); return pet; },
    focusWindow: (window, active) => { window.setFocusable(active); assert.equal(addon.configurePetPanel(window.getNativeWindowHandle()), true); return addon.focusPetPanel(window.getNativeWindowHandle(), active); },
    broadcast() {}, openMain() {}, openSettings() {}, openTask() {}, log: message => trace('runtime', message),
  });
  await runtime.show();
  if (pet.webContents.isLoading()) await new Promise(resolve => pet.webContents.once('did-finish-load', resolve));
  const owner = pet.webContents.id;
  runtime.setLayout(owner, { width: 500, height: 400, pet: { x: 350, y: 250, width: 112, height: 121 } });
  runtime.setRegions(owner, [{ x: 350, y: 250, width: 112, height: 121 }]);
  runtime.rendererReady(owner);
  // Place the transparent part over the second button and leave the first button outside the panel.
  const anchor = runtime.snapshot().layout.pet, bounds = pet.getBounds(), mainBounds = main.getBounds();
  const origin = { screenX: bounds.x + anchor.x, screenY: bounds.y + anchor.y };
  runtime.startDrag(owner, { x: 0, y: 0, ...origin });
  runtime.endDrag(owner, { x: 0, y: 0, screenX: mainBounds.x + 650, screenY: mainBounds.y + 430 });
  trace('windows', { main: main.getBounds(), pet: pet.getBounds() });
  runtime.setKeyboard(owner, false);
  assert.equal(main.isFocused(), true, 'initial inactive keyboard update preserves main focus');
  await clickMain('outside');
  console.log('PASS: opening an inactive companion preserves main window input');
  async function focusInput() {
    runtime.setKeyboard(owner, true);
    await until(() => pet.isFocused(), 'companion receives keyboard focus');
    await pet.webContents.executeJavaScript('document.getElementById("input").focus()');
  }
  await focusInput(); await input('text');
  await until(async () => (await pet.webContents.executeJavaScript('document.getElementById("input").value')).includes('hello '), 'companion receives system keyboard input');
  await clickMain('outside', true);
  assert.equal(pet.isFocusable(), false, 'blur releases native companion focusability');
  console.log('PASS: system mouse input returns to the main window after typing in the companion');
  await focusInput();
  await clickMain('overlap', true);
  console.log('PASS: transparent companion space passes system clicks to the main window during editing');
  await focusInput(); runtime.setKeyboard(owner, false);
  await until(() => main.isFocused(), 'closing companion input restores the prior window');
  await clickMain('outside');
  console.log('PASS: closing companion input restores main window focus and mouse input');
}).then(async () => {
  await runtime?.shutdown();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  console.log('desktop-pet-main-input: 5 passed, 0 failed');
  clearTimeout(deadline); app.exit(0);
}, async error => {
  trace('failure', error.stack || String(error)); console.error(error);
  await runtime?.shutdown(); clearTimeout(deadline); app.exit(1);
});
