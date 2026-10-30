// Short primitive gate only. Package workloads and acceptance budgets run in measure-package.mjs.
'use strict';
const { app, BrowserWindow, WebContentsView, protocol } = require('electron');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
if (!process.argv[2]) throw new Error('An isolated, disposable profile directory is required');
app.setPath('userData', resolve(process.argv[2]));
app.setName('Klaus Measurement Primitive Gate');
protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window, failed = 0, passed = 0;
const views = [];
const timeout = setTimeout(() => { console.error('measure-electron: deadline exceeded'); app.exit(1); }, 20000);
async function check(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack ?? error}`); }
}
app.whenReady().then(async () => {
  const { measureInput, INSTALL_MAIN_PROBE, READ_MAIN_PROBE } = await import(pathToFileURL(resolve(__dirname, 'measure-scenarios.mjs')).href);
  protocol.handle('klaus-app', () => new Response('<!doctype html><style>body{height:9000px;font:18px sans-serif;margin:0}#input{height:70px;border:1px solid black}</style><div id="input" contenteditable="true"></div>' + Array.from({ length: 200 }, (_, i) => `<p>Owned fixture row ${i}</p>`).join(''), { headers: { 'content-type': 'text/html' } }));
  window = new BrowserWindow({ width: 900, height: 700, title: 'Owned measurement primitive gate', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  globalThis.__packageElectron = { app, BrowserWindow }; globalThis.__measureContents = window.webContents;
  const runtime = { inspector: { evaluate: source => Promise.resolve((0, eval)(source)) } };
  await window.loadURL('klaus-app://measure/main'); window.show(); window.focus();
  const focusDeadline = Date.now() + 2000;
  while (!window.isFocused() && Date.now() < focusDeadline) await delay(20);
  await check('actual character input reaches the composer and second animation frame', async () => {
    assert(window.isFocused(), 'The OS must actually focus the owned window'); window.webContents.focus();
    const value = await measureInput(runtime, '__measureContents', 'input'); assert.equal(value.value, 'x'); assert(value.durationMs > 0);
  });
  await check('three actual WebContentsViews receive native scroll input with scrollend between inputs', async () => {
    for (let index = 0; index < 3; index++) {
      if (views.length) window.contentView.removeChildView(views.at(-1));
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); views.push(view);
      window.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 850, height: 620 });
      await view.webContents.loadURL(`klaus-app://measure/tab-${index}`); view.webContents.focus(); globalThis.__measureContents = view.webContents;
      for (let attempt = 0; attempt < 2; attempt++) {
        const value = await measureInput(runtime, '__measureContents', 'scroll'); assert(value.value > value.beforeValue); assert(value.durationMs > 0); assert(value.settledAtMs >= value.startedAtMs);
      }
    }
  });
  await check('actual appMetrics expose cumulative CPU and the main-loop histogram records intervals', async () => {
    await runtime.inspector.evaluate(INSTALL_MAIN_PROBE);
    const before = app.getAppMetrics().find(row => row.pid === process.pid); await delay(70);
    const end = Date.now() + 35; while (Date.now() < end) { /* Controlled CPU work proves the cumulative source advances. */ }
    await delay(40);
    const after = app.getAppMetrics().find(row => row.pid === process.pid), loop = await runtime.inspector.evaluate(READ_MAIN_PROBE);
    assert(Number.isFinite(after.cpu.cumulativeCPUUsage)); assert(after.cpu.cumulativeCPUUsage > before.cpu.cumulativeCPUUsage);
    assert(loop.count > 0 && loop.maxMs > 0 && loop.p99Ms > 0); globalThis.__packageMeasureLoop.disable();
    console.log(JSON.stringify({ cpuSource: 'Electron cumulativeCPUUsage seconds', cumulativeAdvanced: true, mainLoopSamples: loop.count }));
  });
}).catch(error => { failed++; console.error(error.stack ?? String(error)); }).finally(() => {
  for (const view of views) if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  if (window && !window.isDestroyed()) window.destroy();
  clearTimeout(timeout); console.log(`measure-electron: ${passed} passed, ${failed} failed, 0 info`); app.exit(failed ? 1 : 0);
});
