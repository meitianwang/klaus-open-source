const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const { createMainWindow, createPetWindow } = require('../dist/main/app/windows');
const { DesktopPetRuntime } = require('../dist/main/app/desktop-pet');
const { DesktopShortcuts } = require('../dist/main/app/shortcuts');
const { observeNativePetOutsideClicks, beginNativePetWindowDrag } = require('../dist/main/app/pet-pointer');
const { snapPet, clampPet } = require('../dist/main/pets/geometry');
const windowVector = require('../contracts/vectors/desktop-pet-window-vectors.json');
const logs = process.argv[2];
if (!logs || !path.isAbsolute(logs)) throw Error('An absolute window test artifact directory is required');
app.setPath('userData', fs.mkdtempSync(path.join(logs, 'window-profile-')));
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const trace = (event, detail) => fs.appendFileSync(path.join(logs, 'window-native.jsonl'), `${JSON.stringify({ event, detail })}\n`);
async function until(check, label, timeout = 3500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(25); }
  throw Error(`Timed out: ${label}`);
}
let runtime, main, pet, target, addon, owner, lastFocus, focusWork = Promise.resolve();
let shortcutToken = 0, directOutsideToken = 0, passed = 0;
const restoredApplications = [];
const deadline = setTimeout(() => { console.error('Companion window fixture timed out'); app.exit(1); }, 55_000);
function pass(message) { passed++; console.log(`PASS: ${message}`); trace('pass', message); }
const nativeDragEvidence = [];
async function input(mode, points = [], targetPid = process.pid) {
  return new Promise((resolve, reject) => execFile(path.join(logs, 'pet-window-input'), [String(targetPid), mode, ...points.flatMap(p => [String(p.x), String(p.y)])], (error, stdout, stderr) => {
    trace('system-input', { mode, points, stdout, stderr, error: error?.message }); if (error) reject(error); else resolve();
  }));
}
async function mainClick(id) {
  const rect = await main.webContents.executeJavaScript(`(() => {const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const bounds = main.getBounds(), before = await main.webContents.executeJavaScript(`window.clicks.${id}`);
  const point = { x: bounds.x + rect.x, y: bounds.y + rect.y };
  await input('click', [point]); await until(() => main.isFocused(), 'main focus after system click');
  if ((await main.webContents.executeJavaScript(`window.clicks.${id}`)) === before) await input('click', [point]);
  await until(async () => (await main.webContents.executeJavaScript(`window.clicks.${id}`)) > before, `main ${id} click`);
}
async function measure(request) {
  await pet.webContents.executeJavaScript('document.getElementById("input").hidden=false;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const layout = await pet.webContents.executeJavaScript('(() => {const r=document.getElementById("input").getBoundingClientRect();return{width:500,height:400,pet:{x:r.x,y:r.y,width:r.width,height:r.height}}})()');
  const state = runtime.setLayout(owner, { ...layout, focusRequestId: request.requestId });
  assert.equal(runtime.completeFocus(owner, request.requestId, state.layout.revision), true);
  await pet.webContents.executeJavaScript('document.getElementById("input").focus()');
}
app.whenReady().then(async () => {
  addon = require(path.join(__dirname, '../native/artifacts', `klaus-native-${process.platform}-${process.arch}.node`));
  assert.equal(addon.petInputObserverCount(), 0);
  const area = screen.getPrimaryDisplay().workArea;
  main = createMainWindow('Companion native window fixture');
  main.setBounds({ x: area.x + 20, y: area.y + 20, width: 900, height: 650 });
  await main.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><body style="margin:0;background:white"><button id="outside" style="position:absolute;left:50px;top:130px;width:180px;height:80px">Main</button><button id="overlap" style="position:absolute;left:430px;top:230px;width:180px;height:80px">Transparent</button><script>window.clicks={outside:0,overlap:0};for(const id of ["outside","overlap"])document.getElementById(id).onclick=()=>window.clicks[id]++;</script>'));
  assert(addon.petWindowNumber(main.getNativeWindowHandle()) > 0);
  main.show(); app.focus({ steal: true }); main.focus(); await until(() => main.isFocused(), 'initial main focus');
  await mainClick('outside'); pass('main window receives native system clicks before companion startup');
  runtime = new DesktopPetRuntime({
    dataDirectory: path.join(logs, 'window-data'), builtIns: [], readShortcut: () => '',
    pageUrl: 'data:text/html,' + encodeURIComponent('<!doctype html><body style="margin:0;background:transparent"><textarea id="input" style="position:absolute;box-sizing:border-box;left:350px;top:264px;width:112px;height:121px"></textarea>'),
    createWindow: () => { pet = createPetWindow(); assert.equal(addon.configurePetPanel(pet.getNativeWindowHandle()), true); return pet; },
    focusWindow: (window, active) => { window.setFocusable(active); assert.equal(addon.configurePetPanel(window.getNativeWindowHandle()), true); return addon.focusPetPanel(window.getNativeWindowHandle(), active); },
    captureActiveApplication: () => addon.captureActiveApplication() ?? undefined,
    restoreActiveApplication: token => { restoredApplications.push(token); return addon.restoreActiveApplication(token); },
    observeOutsideClicks: (listener, window) => observeNativePetOutsideClicks(addon, window.getNativeWindowHandle(), () => screen.getCursorScreenPoint(), listener, error => { throw Error(error); }, windowNumber => BrowserWindow.getAllWindows().some(candidate => !candidate.isDestroyed() && addon.petWindowNumber(candidate.getNativeWindowHandle()) === windowNumber)),
    startNativeDrag: (window, point, listener, originBounds) => beginNativePetWindowDrag(addon, window.getNativeWindowHandle(), point, event => {
      const record = { ...event, time: Date.now() };
      nativeDragEvidence.push(record); trace('native-drag-evidence', record); listener(event);
    }, error => { throw Error(error); }, originBounds),
    emit(channel, value) { if (channel === 'desktop-pet:focus' && value.type === 'focus-input') { lastFocus = value; focusWork = focusWork.then(() => measure(value)); } },
    broadcast() {}, openMain() {}, openSettings() {}, openTask() {}, log: message => trace('runtime', message),
  });
  await runtime.updateSettings({ language: 'zh' }); assert.equal(pet, undefined);
  await runtime.updateSettings({ enabled: true }); assert(pet);
  if (pet.webContents.isLoading()) await new Promise(resolve => pet.webContents.once('did-finish-load', resolve));
  owner = pet.webContents.id;
  runtime.setLayout(owner, { width: 500, height: 400, pet: { x: 350, y: 264, width: 112, height: 121 } });
  runtime.setRegions(owner, [{ x: 350, y: 264, width: 112, height: 121 }]); runtime.rendererReady(owner);
  await until(() => pet.isVisible(), 'enabled companion becomes visible after disabled language initialization');
  assert.equal(main.isFocused(), true); pass('disabled locale initialization then enabling opens an inactive native panel');
  // Position the transparent viewport over a real main-window button.
  const anchor = runtime.snapshot().layout.pet, bounds = pet.getBounds(), mainBounds = main.getBounds();
  runtime.startDrag(owner, { x: 0, y: 0, screenX: bounds.x + anchor.x, screenY: bounds.y + anchor.y });
  runtime.endDrag(owner, { x: 0, y: 0, screenX: mainBounds.x + 650, screenY: mainBounds.y + 430 });
  await runtime.focusInput(); await focusWork; await until(() => pet.isFocused(), 'layout ACK focuses native panel');
  await input('text'); await until(async () => (await pet.webContents.executeJavaScript('document.getElementById("input").value')).includes('pet-fixture'), 'native keyboard text reaches companion input');
  assert.equal(await pet.webContents.executeJavaScript('document.activeElement.id'), 'input');
  await mainClick('overlap'); assert.equal(pet.isFocusable(), false); pass('measured focus ACK retains a native editable input and transparent clicks reach the main window');
  let hotkeyCount = 0;
  const accelerator = 'Control+Alt+Shift+Y';
  const hotkeys = new DesktopShortcuts({
    shortcuts: globalShortcut,
    read: key => key === 'desktop_pet_shortcut' ? accelerator : 'off',
    toggleMain() {}, toggleQuickInput() {},
    toggleDesktopPet: async () => { hotkeyCount++; await runtime.toggleFromShortcut(); },
    log: message => trace('hotkey-registration', message),
  });
  try {
    hotkeys.start(); assert.equal(hotkeys.state('desktopPet').active, accelerator);
    for (const scenario of ['hidden', 'visible', 'stashed', 'hidden-stashed']) {
      await runtime.show();
      if (scenario.includes('stashed')) {
        const edge = runtime.snapshot().layout.stashEdges[0]; assert(edge);
        runtime.stash(owner, edge); await wait(1050); assert.equal(runtime.snapshot().stashedEdge, edge);
      }
      if (scenario.includes('hidden')) await runtime.hide();
      app.focus({ steal: true }); main.focus(); await until(() => main.isFocused(), `main focus before ${scenario} hotkey`);
      const previous = hotkeyCount;
      const previousFocus = lastFocus;
      await input('mini-shortcut');
      await until(() => hotkeyCount === previous + 1, `OS shortcut callback for ${scenario}`);
      const expectedVisible = scenario !== 'visible';
      await until(() => pet.isVisible() === expectedVisible, `native companion visibility for ${scenario}`);
      assert.equal(runtime.snapshot().stashedEdge, null);
      assert.equal(pet.isFocused(), windowVector.visibility.shortcutOpensEditor);
      assert.equal(pet.isFocusable(), false);
      assert.equal(lastFocus, previousFocus, 'a visibility shortcut issues no editor focus request');
      trace('native-hotkey-result', { scenario, hotkeyCount, focused: pet.isFocused(), visible: pet.isVisible() });
    }
  } finally { hotkeys.close(); }
  pass('an OS global shortcut toggles hidden, visible and stashed presentations without taking editor focus');
  const oldFocus = lastFocus; await runtime.hide(); assert.equal(runtime.completeFocus(owner, oldFocus.requestId, runtime.snapshot().layout.revision), false);
  await runtime.show();
  let outside = 0; directOutsideToken = addon.observePetOutsideClicks(pet.getNativeWindowHandle(), () => outside++);
  const child = new BrowserWindow({ parent: pet, width: 180, height: 100, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await child.loadURL('data:text/html,<button style="width:100%;height:100%">Owned child</button>'); child.show(); child.focus(); await until(() => child.isFocused(), 'owned child focus');
  const cb = child.getBounds(); await input('click', [{ x: cb.x + 80, y: cb.y + 60 }]); await wait(150); assert.equal(outside, 0); child.destroy();
  main.focus(); await until(() => main.isFocused(), 'main focus before outside click'); await mainClick('outside'); await until(() => outside === 1, 'native outside click delivered');
  addon.stopPetOutsideClicks(directOutsideToken); addon.stopPetOutsideClicks(directOutsideToken); directOutsideToken = 0; assert.equal(addon.petInputObserverCount(), 0);
  pass('native outside observers ignore owned child windows and stop idempotently');
  await runtime.updateSettings({ visibility: 'on-demand' }); await runtime.show(); assert.equal(addon.petInputObserverCount(), 1);
  await runtime.withInteraction(owner, async () => { assert.equal(addon.petInputObserverCount(), 0); await mainClick('outside'); assert.equal(pet.isVisible(), true); });
  assert.equal(addon.petInputObserverCount(), 1); await mainClick('outside');
  assert.equal(pet.isVisible(), !windowVector.visibility.outsideClickHides);
  assert.equal(pet.isFocusable(), false); assert.equal(addon.petInputObserverCount(), 1);
  await runtime.hide(); assert.equal(addon.petInputObserverCount(), 0);
  pass('native outside subscriptions suspend for reserved interaction, retain visible presentation and close after explicit hiding');
  await runtime.updateSettings({ visibility: 'always-visible' }); await runtime.show(); main.focus(); await until(() => main.isFocused(), 'main before drag');
  if (screen.getAllDisplays().length !== 1) throw Error('Native drag fixture requires one identified display');
  const dragBounds = pet.getBounds(), rect = runtime.snapshot().layout.pet;
  const start = { x: dragBounds.x + rect.x + rect.width / 2, y: dragBounds.y + rect.y + rect.height / 2 };
  const delta = { x: start.x - 70, y: start.y - 50 };
  runtime.startDrag(owner, { x: rect.width / 2, y: rect.height / 2, screenX: start.x, screenY: start.y });
  runtime.moveDrag(owner, { x: rect.width / 2 + 2, y: rect.height / 2, screenX: start.x + 2, screenY: start.y });
  assert.equal(addon.petInputObserverCount(), 1);
  const beforeLayout = pet.getBounds(); runtime.setLayout(owner, { width: 500, height: 401, pet: rect }); assert.equal(pet.getBounds().height, beforeLayout.height);
  const dragSequence = nativeDragEvidence.length;
  await input('alt-drag', [start, delta]); await until(() => addon.petInputObserverCount() === 0, 'native drag release disposes monitors');
  const snapStarted = Date.now(); let lastSnapSample, lastSnapChange = snapStarted;
  const snapDestination = (point, mascot, workArea) => clampPet(snapPet(point, mascot, workArea), {
    width: mascot.width, height: mascot.height + (runtime.snapshot().settings.showPet ? windowVector.draw.compactControlsBottomReserve : 0),
  }, workArea);
  await until(() => {
    const bounds = pet.getBounds(), mascot = runtime.snapshot().layout.pet, point = { x: bounds.x + mascot.x, y: bounds.y + mascot.y }, target = snapDestination(point, mascot, screen.getDisplayNearestPoint(point).workArea);
    const sample = JSON.stringify({ bounds, point, target });
    if (sample !== lastSnapSample) { lastSnapSample = sample; lastSnapChange = Date.now(); trace('native-drag-settle-sample', { elapsedMs: Date.now() - snapStarted, bounds, point, target }); }
    return Math.abs(point.x - target.x) <= 1 && Math.abs(point.y - target.y) <= 1 && Date.now() - lastSnapChange >= 80;
  }, 'native Alt drag settles at its work-area snap point', 3000);
  const actual = pet.getBounds(), current = runtime.snapshot().layout.pet, point = { x: actual.x + current.x, y: actual.y + current.y }, targetPoint = snapDestination(point, current, screen.getDisplayNearestPoint(point).workArea);
  trace('native-drag-completion', { actual, current, point, targetPoint, workArea: screen.getDisplayNearestPoint(point).workArea, events: nativeDragEvidence.slice(dragSequence) });
  assert(Math.abs(point.x - targetPoint.x) <= 1 && Math.abs(point.y - targetPoint.y) <= 1); assert.equal(actual.height, 401);
  pass('actual native drag defers layout until release, disposes observers and Alt-release springs to an edge');
  const visibleBounds = pet.getBounds(), edge = runtime.snapshot().layout.stashEdges[0]; assert(edge);
  runtime.stash(owner, edge); await wait(1150);
  const stashed = pet.getBounds(), layout = runtime.snapshot().layout, work = screen.getDisplayNearestPoint({ x: visibleBounds.x, y: visibleBounds.y }).workArea;
  const exposed = Math.min(stashed.x + layout.pet.x + layout.pet.width, work.x + work.width) - Math.max(stashed.x + layout.pet.x, work.x); assert.equal(exposed, 24);
  runtime.stash(owner, null); await wait(1150); assert.equal(pet.getBounds().x, visibleBounds.x); assert.equal(pet.getBounds().y, visibleBounds.y);
  const hiding = runtime.hide(); await wait(20); await runtime.show(); await hiding; await wait(350); assert.equal(pet.isVisible(), true); assert.equal(pet.getOpacity(), 1);
  pass('real panel stash retains a visible handle, restores its anchor and survives fade-hide/reopen races');
  app.hide(); await wait(150); assert.equal(pet.isVisible(), true); app.show(); app.focus({ steal: true }); main.focus(); await until(() => main.isFocused(), 'main reopens after application Hide'); pass('native companion remains visible through application Hide and the main window reopens normally');
  const ownChordInput = async mode => {
    const foreground = () => ({ mode, targetPid: process.pid, externalForegroundPid: addon.captureActiveApplication() ?? null, mainFocused: main.isFocused(), appHidden: app.isHidden() });
    trace('own-chord-precondition', { phase: 'before-focus', ...foreground() });
    app.focus({ steal: true }); main.focus();
    try {
      await until(() => { const state = foreground(); return state.mainFocused && !state.appHidden && state.externalForegroundPid === null; }, `own main foreground before ${mode}`);
    } catch (error) {
      trace('own-chord-precondition', { phase: 'failed', ...foreground() }); throw error;
    }
    trace('own-chord-precondition', { phase: 'ready', ...foreground() });
    await input(mode);
  };
  let shortcuts = 0; shortcutToken = addon.observeAppshotShortcut('DoubleCommand', () => shortcuts++); assert.equal(addon.petInputObserverCount(), 1);
  main.focus(); await until(() => main.isFocused(), 'main before chord inputs');
  await ownChordInput('single'); await wait(100); assert.equal(shortcuts, 0);
  await ownChordInput('chord'); await until(() => shortcuts === 1, 'both Command keys trigger once');
  await ownChordInput('combo'); await wait(150); assert.equal(shortcuts, 1);
  await ownChordInput('reverse'); await until(() => shortcuts === 2, 'reverse Command order triggers once');
  addon.stopAppshotShortcut(shortcutToken); addon.stopAppshotShortcut(shortcutToken); shortcutToken = 0; await ownChordInput('chord'); await wait(150); assert.equal(shortcuts, 2); assert.equal(addon.petInputObserverCount(), 0);
  shortcutToken = addon.observeAppshotShortcut('DoubleAlt', () => shortcuts++); await ownChordInput('alt-chord'); await until(() => shortcuts === 3, 'both Alt keys trigger once'); addon.stopAppshotShortcut(shortcutToken); shortcutToken = 0;
  shortcutToken = addon.observeAppshotShortcut('DoubleOption', () => shortcuts++); await ownChordInput('alt-chord'); await until(() => shortcuts === 4, 'Option alias triggers both Alt keys'); addon.stopAppshotShortcut(shortcutToken); shortcutToken = 0;
  shortcutToken = addon.observeAppshotShortcut('DoubleShift', () => shortcuts++); await ownChordInput('chord'); await wait(100); assert.equal(shortcuts, 4); await ownChordInput('shift-chord'); await until(() => shortcuts === 5, 'both Shift keys trigger once'); addon.stopAppshotShortcut(shortcutToken); shortcutToken = 0;
  pass('native modifier chord monitor rejects single keys and key combinations, supports either order and stops without retained observers');
  target = spawn(path.join(logs, 'pet-window-input'), ['window'], { stdio: ['ignore', 'pipe', 'pipe'] });
  target.once('error', error => trace('foreground-target-error', error.message));
  let ready = ''; target.stdout.on('data', chunk => ready += chunk); target.stderr.on('data', chunk => trace('foreground-target-stderr', String(chunk)));
  await until(() => ready.includes(`ready:${target.pid}`), 'separate owned foreground fixture ready', 3500);
  await until(() => addon.captureActiveApplication() === String(target.pid), 'separate owned app is foreground');
  let globalShortcuts = 0; shortcutToken = addon.observeAppshotShortcut('DoubleCommand', () => globalShortcuts++); await input('chord', [], target.pid); await until(() => globalShortcuts === 1, 'global native chord is observed while the separate owned app is foreground'); addon.stopAppshotShortcut(shortcutToken); shortcutToken = 0; pass('global modifier observation works while another owned application is foreground');
  await runtime.focusInput(); await focusWork; await until(() => pet.isFocused(), 'panel focuses above external owned app');
  runtime.setKeyboard(owner, false); await until(() => addon.captureActiveApplication() === String(target.pid), 'explicit release restores external app'); assert.equal(restoredApplications.at(-1), String(target.pid));
  pass('foreground capture and native release restore a separate owned application process');
  await runtime.shutdown(); runtime = undefined; assert.equal(addon.petInputObserverCount(), 0);
  pass('shutdown leaves no native outside, drag or shortcut observers');
}).then(async () => {
  target?.kill(); for (const window of BrowserWindow.getAllWindows()) window.destroy();
  console.log(`desktop-pet-window-native: ${passed} passed, 0 failed`); clearTimeout(deadline); app.exit(0);
}, async error => {
  trace('failure', error.stack || String(error)); console.error(error);
  if (shortcutToken) addon.stopAppshotShortcut(shortcutToken); if (directOutsideToken) addon.stopPetOutsideClicks(directOutsideToken);
  target?.kill(); await runtime?.shutdown(); for (const window of BrowserWindow.getAllWindows()) window.destroy(); clearTimeout(deadline); app.exit(1);
});
