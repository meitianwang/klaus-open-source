import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { until } from './fixture.mjs';
import { intervalCpu, summarizeStage, stageChecks, MEASURE_BUDGETS } from './measurement.mjs';
import { MEASURE_TOOL_COMMAND } from './measure-provider.mjs';
import { INSTALL_RENDERER_PROBE, PREPARE_INPUT_PROBE } from './measure-renderer.mjs';

export const INSTALL_MAIN_PROBE = `(() => {
  globalThis.__packageMeasureWindow = __packageElectron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('klaus-app://'));
  if (!__packageMeasureWindow) throw new Error('No main measurement window');
  globalThis.__packageMeasureLoop = process.getBuiltinModule('perf_hooks').monitorEventLoopDelay({resolution:20});
  __packageMeasureLoop.enable();
  return true;
})()`;
export const READ_MAIN_PROBE = `(() => {
  const value = __packageMeasureLoop;
  const result = value.count > 0 ? {count:value.count,p99Ms:value.percentile(99)/1e6,maxMs:value.max/1e6,meanMs:value.mean/1e6} : null;
  value.reset(); return result;
})()`;

export function writeMeasurementFiles(workspace, count, ptyBytes) {
  const source = join(workspace, 'file-fixture'); mkdirSync(source, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const directory = join(source, `group-${String(Math.floor(index / 60)).padStart(2, '0')}`); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `klaus-perf-file-${String(index).padStart(5, '0')}.txt`), `fixture ${index}\n${'content '.repeat(64)}\n`);
  }
  if (ptyBytes % 256) throw new Error('PTY payload must contain complete 256-byte rows');
  const script = join(workspace, 'pty-output.cjs');
  writeFileSync(script, `'use strict';\n(async()=>{const {once}=require('node:events');const put=async text=>{if(!process.stdout.write(text))await once(process.stdout,'drain');};await put('KLAUS_PERF_BEGIN\\r\\n');for(let i=0;i<${ptyBytes / 256};i++){await put('KPM'+String(i).padStart(6,'0')+':'+ 'X'.repeat(244)+'\\r\\n');}await put('KLAUS_PERF_END\\r\\n');})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});\n`);
  return { source, script, count, ptyBytes };
}
export function terminalCommand(executable, script, platform = process.platform) {
  if (platform === 'win32') {
    if (/["%!\r\n]/.test(executable + script)) throw new Error('Unsupported metacharacters in the Windows measurement path');
    return `set ELECTRON_RUN_AS_NODE=1\r\n"${executable}" "${script}"\r\nexit\r\n`;
  }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return `ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(script)}\nexit\n`;
}
export function assertAction(result, message) {
  assert(result !== false && result?.ok !== false && !result?.error, message);
  return result;
}

export async function measureInput(runtime, contentsExpression, kind, record = () => undefined) {
  const inspect = () => runtime.inspector.evaluate(`(async () => {
    const contents=${contentsExpression}, window=__packageMeasureWindow;
    const view=window.contentView.children.find(view=>view.webContents===contents);
    return {windowFocused:window.isFocused(),contentsFocused:contents.isFocused(),visible:window.isVisible(),
      attached:!!view,bounds:view?.getBounds(),document:await contents.executeJavaScript('({focused:document.hasFocus(),ready:document.readyState,visibility:document.visibilityState,width:innerWidth,height:innerHeight,scrollTop:document.scrollingElement?.scrollTop})')};
  })()`);
  const before = await inspect(); record('input-before', { kind, state: before });
  try {
    // 原生输入要求所属窗口与目标页面获得焦点；准备过程不计入输入延迟。
    await until(() => runtime.inspector.evaluate(`(() => {
      __packageElectron.app.focus({steal:true});__packageMeasureWindow.focus();${contentsExpression}.focus();
      return __packageMeasureWindow.isFocused()&&${contentsExpression}.isFocused();
    })()`), 3000, 'the measured native input focus');
    await runtime.inspector.evaluate(`${contentsExpression}.executeJavaScript(${JSON.stringify(PREPARE_INPUT_PROBE(kind))})`);
    const ready = await inspect(); record('input-ready', { kind, state: ready });
    assert(ready.document.focused && ready.document.ready === 'complete' && ready.document.visibility === 'visible', 'The measured document must be ready, visible and focused');
    if (kind === 'scroll') assert(ready.attached && ready.document.width > 100 && ready.document.height > 180, 'Native wheel coordinates must lie inside the presented view');
    const startedAtMs = await runtime.inspector.evaluate(`(() => {
      if(!__packageMeasureWindow.isFocused()||!${contentsExpression}.isFocused())throw new Error('Native input focus was lost before dispatch');
      const started=performance.timeOrigin+performance.now();${contentsExpression}.sendInputEvent(${JSON.stringify(kind === 'scroll'
        ? { type: 'mouseWheel', x: 100, y: 180, deltaY: -120, deltaX: 0, canScroll: true } : { type: 'char', keyCode: 'x' })});return started;
    })()`);
    const result = await runtime.inspector.evaluate(`${contentsExpression}.executeJavaScript('window.__klausMeasurementPaint')`);
    assert(kind === 'scroll' ? result.value > result.beforeValue : result.value === 'x', 'Native input must visibly change the controlled document');
    const durationMs = result.paintAtMs - startedAtMs; assert(durationMs >= 0, 'Input clocks must share the same epoch');
    const settledAtMs = kind === 'scroll' ? await runtime.inspector.evaluate(`${contentsExpression}.executeJavaScript('window.__klausMeasurementScrollSettled')`) : result.paintAtMs;
    return { kind, startedAtMs, ...result, settledAtMs, durationMs };
  } catch (error) {
    try { record('input-failure', { kind, error: String(error), state: await inspect() }); }
    catch (inspectionError) { record('input-failure', { kind, error: String(error), inspectionError: String(inspectionError) }); }
    throw error;
  }
}

export function measuredTurnFinished(event) {
  if (event?.type === 'api_error' && event.terminal === true) throw new Error(`Measured engine turn failed: ${event.error}`);
  if (event?.type === 'interrupted') throw new Error('Measured engine turn was interrupted');
  return event?.type === 'done';
}

export async function restoreMeasurementPreferences(profile, snapshot, shutdown) {
  // 仅供隔离测量 profile 使用；所有自有进程退出后才恢复，不增加产品 IPC 或授权例外。
  assert(shutdown?.code === 0 && shutdown.forced === false && shutdown.remainingProcesses?.length === 0,
    'Preference restoration requires confirmed normal shutdown of all owned processes');
  const keys = ['auth_mode', 'composer.main_model'];
  assert.deepEqual(Object.keys(snapshot).sort(), [...keys].sort(), 'Only the captured measurement preferences may be restored');
  for (const key of keys) assert(snapshot[key] === null || typeof snapshot[key] === 'string', 'Preference snapshots preserve string or missing values');
  const file = join(profile, 'settings.db'), stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'The isolated settings database must be a regular file');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 3000; BEGIN IMMEDIATE');
    try {
      for (const key of keys) {
        if (snapshot[key] === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
        else db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, snapshot[key]);
        assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null, snapshot[key]);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
  return keys.map(key => ({ key, absent: snapshot[key] === null }));
}

export const PROFILE_RENDERER = `(async () => {
  const debuggerSession = __packageMeasureWindow.webContents.debugger;
  if (debuggerSession.isAttached()) throw new Error('The measured renderer already has a debugger owner');
  debuggerSession.attach('1.3');
  try {
    await debuggerSession.sendCommand('Profiler.enable');
    await debuggerSession.sendCommand('Profiler.setSamplingInterval', {interval:1000});
    await debuggerSession.sendCommand('Profiler.start');
    await new Promise(resolve => setTimeout(resolve, 5000));
    return await debuggerSession.sendCommand('Profiler.stop');
  } finally { debuggerSession.detach(); }
})()`;

export async function runMeasurementRound(runtime, { round, provider, files, samplesPerStage, log, signal, onStage, onPreferencesCaptured, profileRenderer = false }) {
  const workload = MEASURE_BUDGETS.workload, stages = [], sessions = [], tabs = [];
  let terminalId, workspace, active, primaryError, originalSettings, modelConfigured = false, browserChanged = false;
  const record = (type, fields, durable = false) => log.append(type, { round, ...fields }, durable);
  const invoke = async (channel, payload) => { signal.throwIfAborted(); return runtime.invoke(channel, payload); };
  const get = expression => { signal.throwIfAborted(); return runtime.page(expression); };
  async function sample(previous, name, index) {
    signal.throwIfAborted();
    const raw = await runtime.snapshot();
    assert(raw.processes.some(row => row.pid === runtime.child.pid && Number.isFinite(row.rssKiB) && row.rssKiB > 0), 'The owned main process must appear in the OS snapshot');
    const mainLoop = await runtime.inspector.evaluate(READ_MAIN_PROBE);
    const visible = await runtime.inspector.evaluate('__packageMeasureWindow.isVisible()');
    const value = { index, ...raw, mainLoop, visible, intervalCpu: intervalCpu(previous, raw),
      electronWakeupsPerSecond: process.platform === 'darwin' && raw.electronMetrics.length && raw.electronMetrics.every(row => Number.isFinite(row.cpu?.idleWakeupsPerSecond))
        ? raw.electronMetrics.reduce((sum, row) => sum + row.cpu.idleWakeupsPerSecond, 0) : null };
    record('sample', { stage: name, sample: value }); return value;
  }
  async function stage(name, work = async () => ({})) {
    record('stage-start', { stage: name }, true); const started = performance.now(), samples = [];
    let timings = {}, error;
    try {
      let previous = await runtime.snapshot(); await runtime.inspector.evaluate(READ_MAIN_PROBE);
      record('stage-baseline', { stage: name, sample: previous, provider: { ...provider.counters } }, true);
      let workDone = false;
      const working = Promise.resolve().then(work).finally(() => { workDone = true; });
      const results = await Promise.allSettled([working, (async () => {
        for (let index = 1; index <= samplesPerStage || !workDone; index += 1) {
          await delay(workload.sampleIntervalMs, undefined, { signal });
          previous = await sample(previous, name, index); samples.push(previous);
        }
      })()]);
      if (results[0].status === 'fulfilled') timings = results[0].value;
      const errors = results.filter(result => result.status === 'rejected').map(result => String(result.reason));
      if (errors.length) throw new Error(errors.join('; '));
    } catch (failure) { error = String(failure); }
    const summary = summarizeStage(samples, timings), checks = stageChecks(name, summary);
    const result = { name, durationMs: performance.now() - started, summary, checks, ...(error ? { error } : {}) };
    stages.push(result); record('stage-end', { stage: result }, true); await onStage(stages);
    if (error) throw new Error(`${name}: ${error}`);
    if (profileRenderer && ['idle', 'post-cleanup-idle'].includes(name)) {
      // 额外采样不进入预算窗口；整轮仍标作诊断，不能充当性能验收。
      record('renderer-profile-start', { stage: name }, true);
      const profile = await runtime.inspector.evaluate(PROFILE_RENDERER);
      record('renderer-profile', { stage: name, ...profile }, true);
    }
    return result;
  }
  async function settleTurn(id) {
    try {
      await until(async () => {
        signal.throwIfAborted();
        const requests = await get(`window.__klausMeasurement.permissions.splice(0)`);
        for (const permission of requests) {
          if (permission.sessionId !== id || !['Bash', 'bash'].includes(permission.toolName) || permission.toolInput?.command !== MEASURE_TOOL_COMMAND) throw new Error('Unexpected permission in the isolated measurement');
          record('fixture-tool-approval', { sessionId: id, requestId: permission.requestId, command: MEASURE_TOOL_COMMAND }, true);
          await invoke('permission:respond', { requestId: permission.requestId, decision: 'allow' });
        }
        const ended = await get(`window.__klausMeasurement.events.find(event=>event.sessionId===${JSON.stringify(id)}&&(event.type==='done'||event.type==='interrupted'||(event.type==='api_error'&&event.terminal===true)))`);
        return measuredTurnFinished(ended);
      }, 30000, 'the measured engine turn terminal');
    } catch (error) {
      // 清理会删除会话；先保存隔离 fixture 的失败现场，不用快照替代完成事件。
      record('turn-wait-failed', { sessionId: id, error: String(error), provider: { ...provider.counters } }, true);
      try {
        const snapshot = await runtime.page(`({events:window.__klausMeasurement.events.filter(event=>event.sessionId===${JSON.stringify(id)}).slice(-40),pendingPermissions:window.__klausMeasurement.permissions.length,renderedText:document.getElementById('messages')?.innerText.slice(-8000),sendDisabled:document.getElementById('send')?.disabled})`);
        record('turn-failure-snapshot', { sessionId: id, snapshot }, true);
      } catch (snapshotError) { record('turn-failure-snapshot-error', { sessionId: id, error: String(snapshotError) }, true); }
      throw error;
    }
  }
  async function newSession() {
    const row = await invoke('session:new', { workspaceId: workspace.id }); assert(row.id); sessions.push(row.id);
    await get(`window.switchSession(${JSON.stringify(row.id)}).then(()=>true)`); active = row.id; return row.id;
  }
  try {
    await runtime.inspector.evaluate(INSTALL_MAIN_PROBE); await get(INSTALL_RENDERER_PROBE);
    await until(() => get(`document.getElementById('input') && getComputedStyle(document.getElementById('login-screen')).display==='none'`), 15000, 'the real guest composer');
    await stage('idle');
    await stage('input', async () => {
      const inputFrameMs = [];
      for (let index = 0; index < 10; index += 1) { const measurement = await measureInput(runtime, '__packageMeasureWindow.webContents', 'input', record); inputFrameMs.push(measurement.durationMs); record('input', measurement); }
      await get(`document.getElementById('input').textContent='';document.getElementById('input').dispatchEvent(new InputEvent('input',{bubbles:true}));true`);
      return { inputFrameMs };
    });
    originalSettings = { authMode: await invoke('settings:kv:get', { key: 'auth_mode' }), composerModel: await invoke('settings:kv:get', { key: 'composer.main_model' }),
      browser: await invoke('settings:browser-use:get', {}) };
    onPreferencesCaptured({ auth_mode: originalSettings.authMode, 'composer.main_model': originalSettings.composerModel });
    assertAction(await invoke('settings:kv:set', { key: 'auth_mode', value: 'custom' }), 'The isolated auth mode must be configurable');
    modelConfigured = true;
    assertAction(await invoke('settings:models:upsert', { id: 'package-measure', name: 'Local performance fixture', provider: 'anthropic', model: 'fixture-measure-model',
      baseUrl: provider.origin, apiKey: 'measurement-fixture-key', isDefault: true }), 'The fixture model must be configured');
    await invoke('settings:kv:set', { key: 'composer.main_model', value: 'custom:package-measure' });
    workspace = await invoke('workspaces:save', { name: 'Package measurement workspace', roots: [join(runtime.profile, 'workspace')] }); assert(workspace.id);
    await newSession();
    await stage('stream-tools', async () => {
      const id = active, started = performance.now();
      await get(`(()=>{const input=document.getElementById('input');input.textContent='KLAUS_PERF_STREAM';input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));return true;})()`);
      await until(() => get(`!document.getElementById('send').disabled`), 10000, 'measured composer submit');
      await get(`document.getElementById('send').click();true`); await settleTurn(id);
      const lastChunk = `Measured stream ${String(workload.streamChunks - 1).padStart(4, '0')}`;
      assert(await get(`document.getElementById('messages').innerText.includes(${JSON.stringify(lastChunk)})`), 'The actual final stream chunk must render');
      const events = await get(`window.__klausMeasurement.events.filter(event=>event.sessionId===${JSON.stringify(id)})`);
      record('stream-events', { sessionId: id, events }, true);
      assert(events.some(event => event.type === 'tool_start') && events.some(event => event.type === 'tool_end' && !event.isError), 'The actual tool lifecycle must complete');
      return { turnDurationMs: performance.now() - started, deltaCount: events.filter(event => event.type === 'text_delta').length };
    });
    browserChanged = true;
    assertAction(await invoke('settings:browser-use:set-enabled', { enabled: true }), 'The real browser plugin must be enabled');
    await stage('multitab-scroll', async () => {
      const inputFrameMs = [];
      for (let tab = 0; tab < workload.browserTabs; tab += 1) {
        const url = `${provider.origin}/measure/browser?round=${round}&tab=${tab}`;
        await get(`window.klausOpenBrowserTab({url:${JSON.stringify(url)}}).then(()=>true)`);
        const state = await invoke('browser-use:tabs', { action: 'list' }); assert(state.ok && state.tabs.length === tab + 1, 'Exactly the declared browser tabs must exist'); const tabId = state.tabs.at(-1).id; assert.equal(typeof tabId, 'string'); tabs.push(tabId);
        const contents = `__packageElectron.webContents.getAllWebContents().find(contents=>contents.getURL()===${JSON.stringify(url)})`;
        await until(() => runtime.inspector.evaluate(`Boolean(${contents})`), 10000, 'the actual measured WebContentsView');
        assert((await invoke('browser-use:state', {})).visible, 'The measured browser view must be visible');
        for (let index = 0; index < workload.scrollInputsPerTab; index += 1) { const measurement = await measureInput(runtime, contents, 'scroll', (type, fields) => record(type, { tab, index, ...fields }, true)); inputFrameMs.push(measurement.durationMs); record('input', { tab, ...measurement }); }
      }
      return { inputFrameMs, browserTabs: workload.browserTabs };
    });
    await invoke('browser-use:hide', {});
    while (tabs.length) { const tabId = tabs.at(-1); assert((await invoke('browser-use:tabs', { action: 'close', tabId })).ok); tabs.pop(); }
    const hiddenId = await newSession();
    await stage('background', async () => {
      await invoke('chat:send', { sessionId: hiddenId, text: 'KLAUS_PERF_BACKGROUND' });
      await until(() => get(`window.__klausMeasurement.events.some(event=>event.sessionId===${JSON.stringify(hiddenId)}&&event.type==='text_delta')`), 10000, 'background stream startup');
      await runtime.inspector.evaluate('__packageMeasureWindow.hide();true');
      const hiddenAtMs = performance.timeOrigin + performance.now(); record('background-hidden', { sessionId: hiddenId, hiddenAtMs }, true);
      try {
        assert.equal(await runtime.inspector.evaluate('__packageMeasureWindow.isVisible()'), false);
        await settleTurn(hiddenId);
        assert.equal(await runtime.inspector.evaluate('__packageMeasureWindow.isVisible()'), false);
        const deltaCount = await get(`window.__klausMeasurement.events.filter(event=>event.sessionId===${JSON.stringify(hiddenId)}&&event.type==='text_delta').length`); assert(deltaCount >= 2);
        return { deltaCount, completedWhileHidden: true, hiddenAtMs, hiddenDurationMs: performance.timeOrigin + performance.now() - hiddenAtMs };
      } finally { await runtime.inspector.evaluate('__packageMeasureWindow.show();true'); }
    });
    await stage('file-find', async () => {
      const fileSearchMs = [];
      for (let index = 0; index < workload.fileQueries; index += 1) {
        const query = `klaus-perf-file-${String((index * 271) % files.count).padStart(5, '0')}`, started = performance.now();
        const hits = await invoke('engine:workspaceFileSearch', { sessionId: active, query, limit: 20 }); const durationMs = performance.now() - started;
        assert(Array.isArray(hits) && hits.some(hit => hit.name === `${query}.txt`), 'Real native search must return the owned file');
        fileSearchMs.push(durationMs); record('file-search', { query, durationMs, hits: hits.length });
      }
      return { fileSearchMs, indexedFixtureFiles: files.count };
    });
    await stage('pty', async () => {
      await get('window.klausNewTerminal().then(()=>true)');
      terminalId = await until(() => get('Object.keys(window.__klausMeasurement.terminals)[0]'), 10000, 'the current xterm owns the real PTY');
      assert((await invoke('terminal:resize', { id: terminalId, cols: 400, rows: 24 })).ok, 'The fixture row fits the ConPTY buffer width');
      const started = performance.now();
      const command = terminalCommand((await runtime.inspector.evaluate('process.execPath')), files.script);
      assert((await invoke('terminal:write', { id: terminalId, data: command })).ok, 'The real PTY accepts the fixture command');
      const terminal = await until(async () => { const value = await get(`window.__klausMeasurement.terminals[${JSON.stringify(terminalId)}]`); return value?.exit ? value : false; }, 20000, '8 MiB PTY completion');
      assert.equal(terminal.phase, 'ended'); assert.equal(terminal.rows, files.ptyBytes / 256); assert.deepEqual(terminal.errors, []);
      assert.equal(terminal.exit.exitCode, 0); assert.equal(terminal.exit.outputComplete, true); assert(!terminal.exit.error);
      assert((await invoke('terminal:kill', { id: terminalId })).ok, 'PTY close waits for terminal ACK');
      const ptyDurationMs = performance.now() - started; record('pty-result', { ...terminal, tail: undefined, payloadBytes: files.ptyBytes, ptyDurationMs });
      terminalId = undefined; await get('Promise.resolve(window.klausCloseTerminalPanel()).then(()=>true)');
      return { ptyDurationMs, payloadBytes: files.ptyBytes, orderedRows: terminal.rows, outputComplete: true };
    });
  } catch (error) { primaryError = error; }
  record('scenario-cleanup-start', {}, true);
  const cleanupErrors = [];
  const clean = async (name, work) => {
    try { assertAction(await work(), `Cleanup failed: ${name}`); record('cleanup-step', { name }); }
    catch (error) { cleanupErrors.push(`${name}: ${String(error)}`); record('cleanup-error', { name, error: String(error) }, true); }
  };
  if (terminalId) await clean('terminal', () => runtime.invoke('terminal:kill', { id: terminalId }));
  if (tabs.length) {
    await clean('browser-hide', () => runtime.invoke('browser-use:hide', {}));
    for (const tabId of tabs) await clean(`tab:${tabId}`, () => runtime.invoke('browser-use:tabs', { action: 'close', tabId }));
  }
  for (const sessionId of sessions) await clean(`session:${sessionId}`, () => runtime.invoke('session:delete', { sessionId }));
  if (workspace?.id) await clean('workspace', () => runtime.invoke('workspaces:delete', { id: workspace.id }));
  if (browserChanged) await clean('browser-preference', () => runtime.invoke('settings:browser-use:set-enabled', { enabled: originalSettings.browser?.enabled === true }));
  if (modelConfigured) await clean('fixture-model', () => runtime.invoke('settings:models:delete', { id: 'package-measure' }));
  if (originalSettings) record('preference-restoration-deferred', { until: 'confirmed-owned-process-shutdown' }, true);
  await clean('renderer-probe', () => runtime.page(`(()=>{for(const stop of window.__klausMeasurement?.unsubscribers??[])stop();delete window.__klausMeasurement;return true;})()`));
  record('scenario-cleanup-complete', { errors: cleanupErrors }, true);
  if (primaryError || cleanupErrors.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanupErrors.map(error => new Error(error))], 'Measurement scenario or cleanup failed');
  await stage('post-cleanup-idle');
  await runtime.inspector.evaluate('__packageMeasureLoop.disable();delete globalThis.__packageMeasureLoop;true');
  return stages;
}
