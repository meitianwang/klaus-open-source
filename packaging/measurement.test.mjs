import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Script, createContext, runInContext } from 'node:vm';
import { checkLimit, createStageLog, intervalCpu, MEASURE_BUDGETS, MEASURE_STAGES, measurementStatus, percentile, stageChecks, summarizeStage } from './measurement.mjs';
import { cpuTimeSeconds, descendantRows, processTable, remainingOwned, terminateObserved, unixProcessRows, windowsProcessRows } from './process-samples.mjs';
import { INSTALL_RENDERER_PROBE, PREPARE_INPUT_PROBE } from './measure-renderer.mjs';
import { INSTALL_MAIN_PROBE, PROFILE_RENDERER, READ_MAIN_PROBE, assertAction, measureInput, measuredTurnFinished, restoreMeasurementPreferences, terminalCommand, writeMeasurementFiles } from './measure-scenarios.mjs';
import { MEASURE_TOOL_COMMAND, measurementTextChunk, startMeasurementProvider } from './measure-provider.mjs';
import { launchPackage } from './fixture.mjs';

const rootFor = t => { const root = mkdtempSync(join(tmpdir(), 'klaus-measure-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const row = (pid, cpuSeconds, extra = {}) => ({ pid, parentPid: 10, startedAt: '2026-09-08T00:00:00Z', executable: `/fixture/process-${pid}`, rssKiB: 1024, cpuSeconds, ...extra });
const sample = (time, rows, metrics = [], osTime = time) => ({ sampledAtMs: time, osSampledAtMs: osTime, processes: rows, electronMetrics: metrics });
const metric = (pid, seconds) => ({ pid, creationTime: 1, cpu: { cumulativeCPUUsage: seconds, percentCPUUsage: 999 } });

test('process parsers retain cumulative CPU and creation identity without lifetime %CPU', () => {
  assert.equal(cpuTimeSeconds('1-02:03:04.50'), 93784.5); assert.equal(cpuTimeSeconds('3:04.20'), 184.2);
  assert.equal(cpuTimeSeconds('unavailable'), null);
  const unix = unixProcessRows(' 101 100 4096 1:02.30 Tue Sep  8 01:02:03 2026 /own App/engine\n');
  assert.equal(unix[0].cpuSeconds, 62.3); assert.equal(unix[0].executable, '/own App/engine'); assert.match(unix[0].startedAt, /2026/);
  const windows = windowsProcessRows(JSON.stringify({ ProcessId: 21, ParentProcessId: 20, WorkingSetSize: 2048, KernelModeTime: '12000000', UserModeTime: '23000000', StartedAt: 'fixture', ExecutablePath: 'C:\\Own App\\engine.exe' }));
  assert.equal(windows[0].cpuSeconds, 3.5); assert.equal(windows[0].rssKiB, 2);
  assert.equal(windowsProcessRows('{"ProcessId":1}')[0].cpuSeconds, null);
});

test('CPU uses source-specific time differences, includes engine and counts Electron exactly once', () => {
  const first = sample(1000, [row(10, 800), row(11, 100)], [metric(10, 5)], 900);
  const last = sample(2000, [row(10, 900), row(11, 100.002)], [metric(10, 5.03)], 1400);
  const value = intervalCpu(first, last);
  assert(value.available); assert(Math.abs(value.electronPercent - 3) < 1e-9); assert(Math.abs(value.otherOwnedPercent - 0.4) < 1e-9);
  assert(Math.abs(value.totalPercent - 3.4) < 1e-9); assert.equal(value.processes[0].source, 'electron-cumulativeCPUUsage');
  assert.equal(value.processes[1].intervalMs, 500);
  const summary = summarizeStage([{ ...last, intervalCpu: value, mainLoop: { p99Ms: 25, maxMs: 30 }, electronWakeupsPerSecond: 4 }]);
  assert(Math.abs(summary.cpuMeanPercent - 3.4) < 1e-9); assert.equal(summary.cpuCoverage, 'complete');
});

test('missing, reset, new or exited counters make whole-app CPU unavailable instead of zero', () => {
  const first = sample(1000, [row(10, 2), row(11, 1)]), valid = sample(2000, [row(10, 2.01), row(11, 1.01)]);
  for (const current of [sample(2000, [row(10, null), row(11, 1.01)]), sample(2000, [row(10, 1), row(11, 1.01)]),
    sample(2000, [...valid.processes, row(12, 0)]), sample(2000, [row(10, 2.01)]), sample(2000, [row(10, 2.01, { startedAt: 'reused' }), row(11, 1.01)])]) {
    const value = intervalCpu(first, current); assert.equal(value.available, false); assert.equal(value.totalPercent, null);
    assert.equal(summarizeStage([{ ...current, intervalCpu: value, electronWakeupsPerSecond: null }]).cpuMeanPercent, null);
  }
  const fallback = intervalCpu(first, valid); assert(fallback.available); assert.equal(fallback.processes[0].source, 'os-cumulative-cpu-time');
});

test('CPU mean weights cumulative seconds over the complete source sampling window', () => {
  const a = sample(0, [row(1, 0)]), b = sample(1000, [row(1, 0.1)]), c = sample(4000, [row(1, 0.1)]);
  const summary = summarizeStage([{ ...b, intervalCpu: intervalCpu(a, b) }, { ...c, intervalCpu: intervalCpu(b, c) }]);
  assert.equal(summary.cpuMeanPercent, 2.5); assert.equal(summary.electronWakeupsMeanPerSecond, null);
  assert.equal(checkLimit('cpu', null, 5, 'whole app').status, 'unavailable');
  assert.equal(percentile([2, 100, 3, 4, NaN], 95), 100);
});

test('process ownership survives reparenting and excludes reused PIDs and unrelated siblings', () => {
  const rows = [row(10, 1, { parentPid: 1 }), row(11, 1), row(12, 1, { parentPid: 11 }), row(20, 1, { parentPid: 1 })];
  const own = descendantRows(rows, 10); assert.deepEqual(own.map(value => value.pid), [10, 11, 12]);
  assert.deepEqual(remainingOwned(own, [row(11, 2, { parentPid: 1 }), row(12, 0, { startedAt: 'replacement' }), rows[3]]).map(value => value.pid), [11]);
});

test('actual owned Node process yields positive interval CPU and is reaped by exact-identity cleanup', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, ['-e', `process.stdout.write('ready\\n');process.stdin.once('data',()=>{const start=process.cpuUsage(),wall=Date.now();while(process.cpuUsage(start).user+process.cpuUsage(start).system<150000&&Date.now()-wall<3000){}process.stdout.write('done\\n');});`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data'); const before = processTable().find(value => value.pid === child.pid); assert(before && before.startedAt && before.executable);
  const done = once(child.stdout, 'data'); child.stdin.write('burn'); await done;
  const after = processTable().find(value => value.pid === child.pid); assert(after.cpuSeconds - before.cpuSeconds >= 0.1);
  const cleanup = await terminateObserved([before]); await exited;
  assert.deepEqual(cleanup, { remainingProcesses: [], errors: [] });
});

test('raw phase log survives a failing producer and refuses overwrite', t => {
  const file = join(rootFor(t), 'phases.jsonl'), log = createStageLog(file, { budget: MEASURE_BUDGETS.name });
  log.append('stage-start', { stage: 'pty' }, true); log.append('sample', { cpuSeconds: 1.2 }); log.close(); log.close();
  const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3]); assert.equal(rows.at(-1).cpuSeconds, 1.2);
  assert.throws(() => createStageLog(file, {}), /EEXIST/); assert.throws(() => log.append('late'), /closed/);
});

test('action validation accepts the model upsert null result and refuses explicit failures', () => {
  for (const value of [null, true, { ok: true }, { id: 'fixture' }]) assert.doesNotThrow(() => assertAction(value, 'fixture'));
  for (const value of [false, { ok: false }, { error: 'refused' }]) assert.throws(() => assertAction(value, 'fixture'), /fixture/);
});

function completeReport() {
  return { requestedRounds: 3, samplesPerStage: 10, errors: [], rounds: Array.from({ length: 3 }, (_, index) => ({ round: index + 1, checks: [], shutdown: { remainingProcesses: [] },
    stages: MEASURE_STAGES.map(name => ({ name, summary: { sampleCount: 10, cpuCoverage: 'complete', cpuMeanPercent: 1 }, checks: [checkLimit('rssPeakKiB', 1, 2, 'all owned')] })) })) };
}
test('fixed workload cannot pass on shortened runs, missing CPU, budget failures or missing stages', () => {
  assert.equal(MEASURE_BUDGETS.limits.idleCpuPercent, 5); assert.equal(MEASURE_BUDGETS.workload.ptyPayloadBytes, 8 * 1024 * 1024);
  const valid = completeReport(); assert.equal(measurementStatus(valid).status, 'passed');
  for (const alter of [value => value.rounds.pop(), value => value.requestedRounds = 4, value => value.samplesPerStage = 1, value => value.rounds[0].stages.pop(), value => value.rounds[0].stages[0].summary.sampleCount = 1,
    value => value.rounds[0].stages[0].checks.push(checkLimit('idleCpuPercent', null, 5, 'all owned'))]) {
    const report = completeReport(); alter(report); assert.equal(measurementStatus(report).status, 'incomplete');
  }
  valid.rounds[0].stages[0].checks.push(checkLimit('idleCpuPercent', 5.01, 5, 'all owned'));
  assert.equal(measurementStatus(valid).exitCode, 1); assert.equal(measurementStatus(valid).failed[0].round, 1);
  const unavailable = completeReport(); unavailable.rounds[0].checks.push(checkLimit('idleElectronWakeupsPerSecond', null, 120, 'Electron'));
  assert.equal(measurementStatus(unavailable).status, 'complete-with-unavailable-metrics');
});

test('missing whole-app CPU in any workload stage cannot pass without a CPU budget', () => {
  for (const name of MEASURE_STAGES) {
    for (const summary of [{ cpuCoverage: 'incomplete', cpuMeanPercent: null },
      { cpuCoverage: 'incomplete', cpuMeanPercent: 1 }, { cpuCoverage: 'complete', cpuMeanPercent: null },
      { cpuCoverage: undefined, cpuMeanPercent: undefined }]) {
      const report = completeReport();
      Object.assign(report.rounds[1].stages.find(stage => stage.name === name).summary, summary);
      const result = measurementStatus(report);
      assert.equal(result.status, 'incomplete'); assert.equal(result.exitCode, 2);
      assert.equal(result.failed.length, 0); assert.equal(result.unavailable.length, 1);
      assert.equal(result.unavailable[0].name, 'cpuMeanPercent');
      assert.equal(result.unavailable[0].stage, name); assert.equal(result.unavailable[0].round, 2);
      assert.equal(result.unavailable[0].actual, null);
    }
  }
});

test('post-cleanup idle enforces the same CPU and wakeup budgets as initial idle', () => {
  const summary = { rssPeakKiB: 1, mainLoopP99Ms: 1, mainLoopMaxMs: 1,
    cpuMeanPercent: 108.30323822295838, electronWakeupsMeanPerSecond: 528.1 };
  const idleChecks = name => stageChecks(name, summary).filter(check => check.name.startsWith('idle'));
  assert.deepEqual(idleChecks('post-cleanup-idle'), idleChecks('idle'));
  assert.deepEqual(idleChecks('post-cleanup-idle').map(check => check.status), ['fail', 'fail']);
  const report = completeReport();
  report.rounds[0].stages.find(stage => stage.name === 'post-cleanup-idle').checks = stageChecks('post-cleanup-idle', summary);
  assert.equal(measurementStatus(report).status, 'failed');
  assert(measurementStatus(report).failed.every(check => check.stage === 'post-cleanup-idle'));
  const missing = stageChecks('post-cleanup-idle', { ...summary, cpuMeanPercent: null, electronWakeupsMeanPerSecond: null });
  assert.equal(missing.find(check => check.name === 'idleCpuPercent').status, 'unavailable');
  assert.equal(missing.find(check => check.name === 'idleElectronWakeupsPerSecond').status, 'unavailable');
  assert(stageChecks('input', summary).every(check => !check.name.startsWith('idle')));
});

test('renderer CPU profiles remain diagnostic and release only their own debugger', async () => {
  const report = completeReport(); report.profileRenderer = true;
  assert.equal(measurementStatus(report).status, 'incomplete');
  for (const failedCommand of [null, 'Profiler.enable', 'Profiler.start', 'Profiler.stop']) {
    const commands = []; let attached = false;
    const profile = { nodes: [], samples: [] };
    const debuggerSession = { isAttached: () => attached, attach: () => { attached = true; },
      detach: () => { attached = false; commands.push('detach'); }, async sendCommand(command) {
        commands.push(command); if (command === failedCommand) throw new Error('profile refused');
        return command === 'Profiler.stop' ? { profile } : {};
      } };
    const context = createContext({ __packageMeasureWindow: { webContents: { debugger: debuggerSession } },
      setTimeout: (callback, ms) => { assert.equal(ms, 5000); callback(); } });
    if (failedCommand) await assert.rejects(() => runInContext(PROFILE_RENDERER, context), /profile refused/);
    else assert.equal((await runInContext(PROFILE_RENDERER, context)).profile, profile);
    assert.equal(attached, false); assert.equal(commands.at(-1), 'detach');
    commands.length = 0; attached = true;
    await assert.rejects(() => runInContext(PROFILE_RENDERER, context), /already has a debugger owner/);
    assert.equal(attached, true); assert.deepEqual(commands, []);
  }
});

function renderer() {
  const listeners = new Map(), target = new EventTarget(), document = new EventTarget();
  target.textContent = ''; target.scrollTop = 900; target.scrollHeight = 9000; target.clientHeight = 620; target.focus = () => undefined;
  document.scrollingElement = target; document.getElementById = () => target;
  const window = { scrollTo: () => { target.scrollTop = 0; setTimeout(() => document.dispatchEvent(new Event('scroll')), 0); },
    __KLAUS_DESKTOP__: { event: { async listen(channel, callback) { listeners.set(channel, callback); return () => listeners.delete(channel); } } } };
  const context = createContext({ window, document, performance, setTimeout, clearTimeout, InputEvent: Event, requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 2) });
  return { context, window, document, target, listeners };
}
test('serialized renderer probes parse split PTY bytes and detect lost rows without buffering output', async () => {
  const value = renderer(); for (const source of [INSTALL_RENDERER_PROBE, PREPARE_INPUT_PROBE('input'), PREPARE_INPUT_PROBE('scroll'), INSTALL_MAIN_PROBE, READ_MAIN_PROBE]) assert.doesNotThrow(() => new Script(source));
  await runInContext(INSTALL_RENDERER_PROBE, value.context);
  const data = 'KLAUS_PERF_BEGIN\r\nKPM000000:' + 'X'.repeat(244) + '\r\nKPM000001:' + 'X'.repeat(244) + '\r\nKLAUS_PERF_END\r\n';
  let sequence = 0;
  for (let index = 0; index < data.length; index += 37) value.listeners.get('ipc:terminal:data')({ payload: { args: [{ id: 'own', sequence: ++sequence, data: data.slice(index, index + 37) }] } });
  assert.equal(value.window.__klausMeasurement.terminals.own.rows, 2); assert.equal(value.window.__klausMeasurement.terminals.own.phase, 'ended');
  assert.equal(value.window.__klausMeasurement.terminals.own.tail, ''); assert.equal(value.window.__klausMeasurement.terminals.own.errors.length, 0);
  value.listeners.get('ipc:terminal:data')({ payload: { args: [{ id: 'lost', sequence: 1, data: 'KLAUS_PERF_BEGIN\nKPM000001:' + 'X'.repeat(244) + '\n' }] } });
  assert.match(value.window.__klausMeasurement.terminals.lost.errors[0], /Missing or changed/);
});

test('renderer retains terminal failures and measurements reject them instead of waiting for done', async () => {
  const value = renderer(); await runInContext(INSTALL_RENDERER_PROBE, value.context);
  const event = { type: 'api_error', sessionId: 'own', turnId: 'turn', terminal: true, error: 'Halted: repeating content' };
  value.listeners.get('ipc:chat:event:batch')({ payload: { args: [[event]] } });
  const captured = value.window.__klausMeasurement.events[0];
  assert.equal(captured.turnId, 'turn'); assert.equal(captured.terminal, true); assert.equal(captured.error, event.error);
  assert.throws(() => measuredTurnFinished(captured), /Halted: repeating content/);
  assert.throws(() => measuredTurnFinished({ type: 'interrupted' }), /interrupted/);
  for (const pending of [undefined, { type: 'message_complete' }, { type: 'api_error', terminal: false }]) assert.equal(measuredTurnFinished(pending), false);
  assert.equal(measuredTurnFinished({ type: 'done' }), true);
});

test('isolated preference restoration preserves missing rows and empty strings only after owned shutdown', async t => {
  const { DatabaseSync } = await import('node:sqlite'), root = mkdtempSync(join(tmpdir(), 'klaus-measure-test-'));
  const db = new DatabaseSync(join(root, 'settings.db'));
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('auth_mode','custom'),('composer.main_model','custom:package-measure'),('untouched','keep')");
  const read = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const snapshot = { auth_mode: null, 'composer.main_model': '' };
  const stopped = { code: 0, forced: false, remainingProcesses: [] };
  for (const shutdown of [undefined, { ...stopped, code: 1 }, { ...stopped, forced: true }, { ...stopped, remainingProcesses: [{}] }, { code: 0, forced: false }]) {
    await assert.rejects(() => restoreMeasurementPreferences(root, snapshot, shutdown), /confirmed normal shutdown/);
    assert.equal(read('auth_mode'), 'custom'); assert.equal(read('composer.main_model'), 'custom:package-measure');
  }
  await assert.rejects(() => restoreMeasurementPreferences(root, { ...snapshot, unexpected: null }, stopped), /Only the captured/);
  await assert.rejects(() => restoreMeasurementPreferences(root, { ...snapshot, auth_mode: undefined }, stopped), /string or missing/);
  assert.deepEqual(await restoreMeasurementPreferences(root, snapshot, stopped), [{ key: 'auth_mode', absent: true }, { key: 'composer.main_model', absent: false }]);
  assert.equal(read('auth_mode'), undefined); assert.equal(read('composer.main_model'), ''); assert.equal(read('untouched'), 'keep');
  await restoreMeasurementPreferences(root, snapshot, stopped);
  await restoreMeasurementPreferences(root, { auth_mode: 'custom', 'composer.main_model': null }, stopped);
  assert.equal(read('auth_mode'), 'custom'); assert.equal(read('composer.main_model'), undefined);
  db.exec("CREATE TRIGGER refuse_composer BEFORE INSERT ON settings WHEN NEW.key='composer.main_model' BEGIN SELECT RAISE(ABORT,'restore refused'); END");
  await assert.rejects(() => restoreMeasurementPreferences(root, { auth_mode: null, 'composer.main_model': 'old-model' }, stopped), /restore refused/);
  assert.equal(read('auth_mode'), 'custom'); assert.equal(read('composer.main_model'), undefined); assert.equal(read('untouched'), 'keep');
});

test('native-input harness acquires native focus, measures changed position and drains scrollend', async () => {
  const value = renderer(); let dispatches = 0, windowFocused = false, contentsFocused = false;
  const records = [], focused = [];
  value.document.readyState = 'complete'; value.document.visibilityState = 'visible';
  value.document.hasFocus = () => windowFocused && contentsFocused;
  Object.assign(value.context, { innerWidth: 800, innerHeight: 620 });
  const wc = { focus: () => { focused.push('contents'); contentsFocused = true; }, isFocused: () => contentsFocused,
    executeJavaScript: source => runInContext(source, value.context), sendInputEvent(event) {
    assert(windowFocused && contentsFocused); dispatches++; setTimeout(() => {
      if (event.type === 'mouseWheel') {
        assert.equal(event.deltaY, -120); value.target.scrollTop += 120; value.document.dispatchEvent(new Event('scroll'));
        setTimeout(() => value.document.dispatchEvent(new Event('scrollend')), 20);
      }
      else { value.target.textContent = event.keyCode; value.target.dispatchEvent(new Event('input')); }
    }, 5);
  } };
  const main = createContext({ wc, performance,
    __packageElectron: { app: { focus: () => focused.push('app') } },
    __packageMeasureWindow: { focus: () => { focused.push('window'); windowFocused = true; }, isFocused: () => windowFocused, isVisible: () => true,
      contentView: { children: [{ webContents: wc, getBounds: () => ({ x: 0, y: 0, width: 800, height: 620 }) }] } } });
  const runtime = { inspector: { evaluate: source => runInContext(source, main) } };
  const record = (type, fields) => records.push({ type, ...fields });
  const input = await measureInput(runtime, 'wc', 'input', record);
  windowFocused = false; contentsFocused = false;
  const scroll = await measureInput(runtime, 'wc', 'scroll', record);
  assert.equal(input.value, 'x'); assert.equal(scroll.beforeValue, 900); assert.equal(scroll.value, 1020);
  assert(input.durationMs >= 5); assert(scroll.durationMs >= 5); assert(scroll.settledAtMs > scroll.paintAtMs); assert.equal(dispatches, 2);
  assert.deepEqual(focused, ['app', 'window', 'contents', 'app', 'window', 'contents']);
  assert.deepEqual(records.map(row => [row.type, row.state.windowFocused, row.state.document.focused]),
    [['input-before', false, false], ['input-ready', true, true], ['input-before', false, false], ['input-ready', true, true]]);
});

test('fixture generator creates declared files and an exact 8 MiB ordered PTY payload', t => {
  const root = rootFor(t), files = writeMeasurementFiles(root, 61, MEASURE_BUDGETS.workload.ptyPayloadBytes);
  assert.equal(readdirSync(join(files.source, 'group-00')).length, 60); assert.equal(readdirSync(join(files.source, 'group-01')).length, 1);
  const child = spawnSync(process.execPath, [files.script], { maxBuffer: 9 * 1024 * 1024 }); assert.equal(child.status, 0);
  const begin = Buffer.from('KLAUS_PERF_BEGIN\r\n'), end = Buffer.from('KLAUS_PERF_END\r\n');
  assert(child.stdout.subarray(0, begin.length).equals(begin)); assert(child.stdout.subarray(-end.length).equals(end));
  assert.equal(child.stdout.length - begin.length - end.length, 8 * 1024 * 1024);
  assert.throws(() => terminalCommand('C:\\bad%PATH%\\electron.exe', 'file.cjs', 'win32'), /metacharacters/);
  assert.match(terminalCommand('/own path/Electron', "/own path/a'b.cjs", 'darwin'), /ELECTRON_RUN_AS_NODE=1/);
});

test('full measured text preserves 200 timed chunks and original byte volume without repeated words', () => {
  assert.equal(MEASURE_BUDGETS.workload.streamChunks, 200); assert.equal(MEASURE_BUDGETS.workload.streamChunkIntervalMs, 50);
  for (const background of [false, true]) {
    const words = [];
    for (let index = 0; index < MEASURE_BUDGETS.workload.streamChunks; index++) {
      const prefix = `Measured ${background ? 'background' : 'stream'} ${String(index).padStart(4, '0')}: `;
      const text = measurementTextChunk(index, background);
      assert.equal(Buffer.byteLength(text), Buffer.byteLength(prefix + 'text '.repeat(20) + '\n'));
      assert(text.startsWith(prefix)); assert(text.endsWith('\n')); assert.equal(measurementTextChunk(index, background), text);
      const chunkWords = text.slice(prefix.length).trim().split(' '); assert.equal(chunkWords.length, 20);
      assert(chunkWords.every(word => /^[a-z0-9]{4}$/.test(word))); words.push(...chunkWords);
    }
    assert.equal(new Set(words).size, 4000);
  }
});

test('actual loopback provider emits a tool call, incremental text, background stream and drains close', { timeout: 10000 }, async () => {
  const records = [], provider = await startMeasurementProvider({ streamChunks: 3, streamChunkIntervalMs: 2 }, (type, fields) => records.push({ type, ...fields }));
  const post = (content, stream = true) => fetch(provider.origin + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'measurement-fixture-key' }, body: JSON.stringify({ model: 'fixture', stream, tools: [{ name: 'Bash' }], messages: [{ role: 'user', content }] }) });
  try {
    assert.equal((await fetch(provider.origin + '/other')).status, 404);
    assert((await (await fetch(provider.origin + '/measure/browser')).text()).includes('Deterministic browser row 1999'));
    const tool = await (await post('KLAUS_PERF_STREAM')).text(); assert.match(tool, /"type":"tool_use"/);
    const parts = tool.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert.equal(JSON.parse(parts.filter(row => row.delta?.partial_json).map(row => row.delta.partial_json).join('')).command, MEASURE_TOOL_COMMAND);
    const reply = await (await post([{ type: 'tool_result', tool_use_id: 'own', content: 'KLAUS_PERF_TOOL' }])).text(); assert.equal((reply.match(/"type":"text_delta"/g) ?? []).length, 3);
    const deltas = reply.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(row => row.delta?.type === 'text_delta');
    assert.deepEqual(deltas.map(row => row.delta.text), [0, 1, 2].map(index => measurementTextChunk(index)));
    const background = await (await post('KLAUS_PERF_BACKGROUND')).text(); assert.match(background, /Measured background 0002/);
    assert.equal((await (await post('title', false)).json()).stop_reason, 'end_turn');
    assert.equal(provider.counters.toolCalls, 1); assert.equal(provider.counters.completed, 4); assert.equal(provider.counters.failed, 0);
    assert.deepEqual(records.filter(row => row.type === 'provider-request').map(row => row.request), [1, 2, 3, 4]);
    assert.deepEqual(records.filter(row => row.type === 'provider-complete').map(row => [row.request, row.stopReason]), [[1, 'tool_use'], [2, 'end_turn'], [3, 'end_turn'], [4, 'end_turn']]);
    assert(!JSON.stringify(records).includes('measurement-fixture-key'));
  } finally { await provider.close(); }
});

test('provider cancellation closes an active response and all owned timers', { timeout: 10000 }, async () => {
  const provider = await startMeasurementProvider({ streamChunks: 200, streamChunkIntervalMs: 50 }, () => undefined);
  const response = await fetch(provider.origin + '/v1/messages', { method: 'POST', headers: { 'x-api-key': 'measurement-fixture-key' }, body: JSON.stringify({ model: 'fixture', stream: true, messages: [{ role: 'user', content: 'KLAUS_PERF_BACKGROUND' }] }) });
  const reading = response.text().then(() => 'complete', () => 'cancelled');
  await delay(10); await provider.close(); assert.equal(await reading, 'cancelled'); assert.equal(provider.counters.failed, 1);
});

test('real CLI preflight failure persists original phase and exits nonzero without launching a package', t => {
  const root = rootFor(t), output = join(root, 'report.json'), script = fileURLToPath(new URL('../scripts/measure-package.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [script, join(root, 'missing.app'), '--output', output], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1); assert(existsSync(output));
  const report = JSON.parse(readFileSync(output, 'utf8')), phases = readFileSync(output + '.stages.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(report.status, 'failed'); assert(report.errors[0].message); assert.equal(report.rounds.length, 0);
  assert.equal(phases[0].type, 'run-start'); assert(phases.some(row => row.type === 'failure')); assert.equal(phases.at(-1).type, 'run-complete');
  const again = spawnSync(process.execPath, [script, join(root, 'missing.app'), '--output', output], { encoding: 'utf8', timeout: 10000 });
  assert.equal(again.status, 1); assert.match(again.stderr, /already exists/);
});

test('package spawn failure settles cleanup instead of waiting on a nonexistent process exit', { timeout: 5000 }, async t => {
  const root = rootFor(t);
  await assert.rejects(() => launchPackage(join(root, 'missing.app'), join(root, 'profile')), error => {
    assert.match(String(error), /ENOENT/); assert.equal(error.shutdown.launchError.includes('ENOENT'), true);
    assert.deepEqual(error.shutdown.remainingProcesses, []); return true;
  });
});
