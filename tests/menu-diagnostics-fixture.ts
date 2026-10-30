import { app, BrowserWindow, type ProcessMetric, type WebPreferences } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopMenuDiagnostics, type MenuDiagnosticsServices } from '../main/app/menu-diagnostics';

const profile = process.env.KLAUS_MENU_DIAGNOSTICS_PROFILE;
if (!profile) throw new Error('An isolated KLAUS_MENU_DIAGNOSTICS_PROFILE is required.');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

async function main(): Promise<void> {
  await app.whenReady();
  let snapshots = 0, statusCalls = 0, chinese = true;
  const metric = (pid: number, name: string, cpu: number): ProcessMetric => ({ pid, name, type: 'Utility', creationTime: 1,
    cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 2048, peakWorkingSetSize: 4096 } });
  const diagnostics = new DesktopMenuDiagnostics({ app: { getName: () => 'Klaus', getVersion: () => '1.2.3', getAppMetrics: () => {
    snapshots++; return [metric(10, 'First process', 20), metric(20, 'Second process', 5)];
  } }, configRoot: profile!, parent: () => null, chinese: () => chinese,
    status: () => { statusCalls++; return { engine: '<img src=x onerror="globalThis.injected=true">', native: 4,
      engineProcesses: 1, searches: 2, ptys: 3, searchSessions: 4 }; },
    onChanged: () => {}, log: (kind, detail) => console.log(`${kind}: ${detail}`) }, {
      dialog: {
        showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
        showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
      } as unknown as MenuDiagnosticsServices['dialog'],
    });
  try {
    await diagnostics.showTaskManager();
    const task = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('任务管理器'));
    assert.ok(task);
    const preferences = (task.webContents as typeof task.webContents & { getLastWebPreferences(): WebPreferences }).getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true); assert.equal(preferences.nodeIntegration, false);
    assert.ok(!preferences.preload);
    const globals = await task.webContents.executeJavaScript('({require:typeof require,process:typeof process,klaus:typeof window.klaus,host:typeof window.__KLAUS_DESKTOP__})');
    assert.deepEqual(globals, { require: 'undefined', process: 'undefined', klaus: 'undefined', host: 'undefined' });
    let rows = await task.webContents.executeJavaScript('Array.from(document.querySelectorAll("tbody tr"),row=>row.cells[0].textContent)');
    assert.deepEqual(rows, ['First process', 'Second process']);
    await task.webContents.executeJavaScript('document.querySelector("th[data-key=cpu] button").click()');
    rows = await task.webContents.executeJavaScript('Array.from(document.querySelectorAll("tbody tr"),row=>row.cells[0].textContent)');
    assert.deepEqual(rows, ['Second process', 'First process']);
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.ok(snapshots >= 2);
    rows = await task.webContents.executeJavaScript('Array.from(document.querySelectorAll("tbody tr"),row=>row.cells[0].textContent)');
    assert.deepEqual(rows, ['Second process', 'First process']);
    await diagnostics.showTaskManager();
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await diagnostics.showStatus();
    const status = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('系统状态'));
    assert.ok(status);
    assert.equal(await status.webContents.executeJavaScript('document.querySelectorAll("img").length'), 0);
    assert.equal(await status.webContents.executeJavaScript('typeof globalThis.injected'), 'undefined');
    assert.match(await status.webContents.executeJavaScript('document.body.textContent'), /1\.2\.3/);
    assert.match(await status.webContents.executeJavaScript('document.body.textContent'), /原生能力/);
    assert.equal(await status.webContents.executeJavaScript('window.open("https://example.invalid")===null'), true);
    assert.ok(statusCalls >= 1);
    chinese = false;
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(task.getTitle(), 'Klaus — Task Manager');
    assert.equal(status.getTitle(), 'Klaus — System Status');
    assert.equal(await task.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Task Manager');
    assert.equal(await task.webContents.executeJavaScript('document.querySelector("th[data-key=name] button").textContent'), 'Process');
    assert.match(await task.webContents.executeJavaScript('document.getElementById("hint").textContent'), /Updates every second/);
    assert.match(await task.webContents.executeJavaScript('document.getElementById("updated").textContent'), /Last updated/);
    assert.equal(await status.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'System Status');
    assert.match(await status.webContents.executeJavaScript('document.querySelector("tbody").textContent'), /Engine processes/);
    chinese = true;
    await new Promise(resolve => setTimeout(resolve, 1150));
    assert.equal(task.getTitle(), 'Klaus — 任务管理器');
    assert.equal(status.getTitle(), 'Klaus — 系统状态');
    assert.equal(await task.webContents.executeJavaScript('document.querySelector("h1").textContent'), '任务管理器');
    assert.equal(await task.webContents.executeJavaScript('document.querySelector("th[data-key=name] button").textContent'), '进程');
    assert.equal(await task.webContents.executeJavaScript('document.documentElement.lang'), 'zh-CN');
    assert.equal(await task.webContents.executeJavaScript('document.querySelector("th[data-key=cpu]").getAttribute("aria-sort")'), 'ascending');
    rows = await task.webContents.executeJavaScript('Array.from(document.querySelectorAll("tbody tr"),row=>row.cells[0].textContent)');
    assert.deepEqual(rows, ['Second process', 'First process']);
    const translatedStatus = await status.webContents.executeJavaScript('document.querySelector("tbody").textContent');
    for (const label of ['引擎进程数', '搜索进程数', '终端会话数', '搜索会话数']) assert.ok(translatedStatus.includes(label));
    assert.doesNotMatch(translatedStatus, /engineProcesses|searches|searchSessions|ptys/);
    await diagnostics.toggleTrace();
    assert.equal(diagnostics.traceState, 'recording');
    await new Promise(resolve => setTimeout(resolve, 100));
    await diagnostics.toggleTrace();
    assert.equal(diagnostics.traceState, 'idle');
    const trace = readdirSync(join(profile!, 'diagnostics')).find(name => name.endsWith('.json'));
    assert.ok(trace);
    const tracePath = join(profile!, 'diagnostics', trace);
    assert.ok(statSync(tracePath).size > 0);
    assert.ok(Array.isArray(JSON.parse(readFileSync(tracePath, 'utf8')).traceEvents));
    await diagnostics.close();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log('menu-diagnostics GUI: sandbox, bridge isolation, sorting, refreshing, live locale changes, native count labels, status escaping, window reuse, real performance trace and cleanup passed');
  } finally { await diagnostics.close(); }
}

void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
