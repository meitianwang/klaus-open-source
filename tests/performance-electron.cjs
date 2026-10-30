const { app, BrowserWindow } = require('electron');
const { strict: assert } = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const root = process.env.KLAUS_PERFORMANCE_TEST_ROOT;
const phase = process.env.KLAUS_PERFORMANCE_TEST_PHASE;
const runId = process.env.KLAUS_PERFORMANCE_TEST_RUN_ID;
const rounds = Number(process.env.KLAUS_PERFORMANCE_TEST_ROUNDS ?? 3);
assert(root && phase && runId, 'Measurement root, phase and run identity are required');
assert(Number.isInteger(rounds) && rounds >= 3 && rounds <= 5, 'Measurement rounds must be between three and five');
fs.mkdirSync(root, { recursive: true });
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const report = { phase, runId, completed: false, expectedRounds: rounds, startedAtMs: Date.now(),
  workload: { historyRows: 5000, retentionVisits: 50 },
  method: 'Isolated real Electron renderer, production transcript/store, deterministic local events; native character dispatch to second animation frame; process CPU counters; post-GC heap retained after navigation.', rounds: [], errors: [], limitations: [] };
// Recorded scenario times were 5.6-6.6s. Bound streaming at 30s and a single
// native paint at 5s, while retaining the runner's existing 300s overall limit.
// Retention has 50 history loads; its separate 90s bound cannot extend that limit.
const deadlines = { ready: 20_000, operation: 10_000, prepare: 30_000, streaming: 30_000, paint: 5000, settle: 20_000, retention: 90_000 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
let server, window, finished = false, sequence = 0;
const closingWindows = new WeakSet();
const persist = () => {
  const target = path.join(root, 'results.json'), temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n'); fs.renameSync(temporary, target);
};
function checkpoint(name, state, detail = {}) {
  const entry = { sequence: ++sequence, name, state, atMs: Date.now(), elapsedMs: Date.now() - report.startedAtMs, ...detail };
  report.stage = entry;
  fs.appendFileSync(path.join(root, 'stages.jsonl'), JSON.stringify({ runId, ...entry }) + '\n');
  fs.writeFileSync(path.join(root, 'progress.json'), JSON.stringify({ runId, completed: report.completed, ...entry }, null, 2) + '\n');
}
async function stage(name, task, timeoutMs = deadlines.operation, detail = {}) {
  const started = performance.now(); let timer;
  checkpoint(name, 'started', { ...detail, timeoutMs });
  try {
    const result = await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Performance stage timed out: ${name} (${timeoutMs}ms)`)), timeoutMs);
    })]);
    checkpoint(name, 'completed', { ...detail, durationMs: performance.now() - started });
    return result;
  } catch (error) {
    checkpoint(name, 'failed', { ...detail, durationMs: performance.now() - started, error: String(error.stack || error) });
    throw error;
  } finally { clearTimeout(timer); }
}
function fail(error, code = 1, signal) {
  if (finished) return;
  finished = true; report.completed = false;
  report.errors.push(String(error.stack || error));
  report.failure = { atMs: Date.now(), stage: report.stage, ...(signal ? { signal } : {}) };
  try {
    if (window && !window.isDestroyed()) report.failure.window = { focused: window.isFocused(), loading: window.webContents.isLoading(), url: window.webContents.getURL(), pid: window.webContents.getOSProcessId() };
  } catch (diagnosticError) { report.failure.diagnosticError = String(diagnosticError); }
  try { persist(); checkpoint('measurement', 'failed', { signal: signal ?? null, error: String(error) }); }
  catch (diagnosticError) { console.error('Cannot persist performance failure:', diagnosticError); }
  console.error(error);
  try { if (window && !window.isDestroyed()) { closingWindows.add(window); window.destroy(); } server?.close(); } catch (cleanupError) { console.error(cleanupError); }
  app.exit(code);
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, () => fail(new Error(`Performance fixture received ${signal}`), code, signal));
process.on('uncaughtException', error => fail(error));
process.on('unhandledRejection', error => fail(error instanceof Error ? error : new Error(String(error))));
app.on('before-quit', () => { if (!finished) fail(new Error('Performance fixture quit before completion')); });
function evaluate(name, source, timeoutMs, detail) {
  return stage(name, () => window.webContents.executeJavaScript(source, true), timeoutMs, detail);
}
async function openWindow(origin, detail = {}) {
  checkpoint('window.create', 'started', detail);
  window = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: true,
    title: 'Klaus isolated performance measurement', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer: ' + event.message); });
  const measuredWindow = window;
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!closingWindows.has(measuredWindow)) fail(new Error('Performance renderer exited: ' + JSON.stringify(details)));
  });
  window.on('unresponsive', () => checkpoint('window.unresponsive', 'observed', detail));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin) && !/^(data:|blob:)/.test(details.url) }));
  checkpoint('window.create', 'completed', detail);
  await stage('window.load', () => window.loadURL(origin + '/index.html'), deadlines.ready, detail);
  window.webContents.debugger.attach('1.3');
  app.focus({ steal: true }); window.focus(); window.webContents.focus();
  await stage('window.focus', async () => {
    while (!window.isFocused() || !window.webContents.isFocused()) await pause(25);
  }, deadlines.paint, detail);
  const ready = await evaluate('window.renderer-ready', 'Boolean(window.performanceFixture && document.querySelector("#input"))', deadlines.paint, detail);
  assert(ready, 'Performance renderer fixture did not initialize');
}
function closeWindow(detail = {}) {
  checkpoint('window.destroy', 'started', detail); closingWindows.add(window); window.destroy(); checkpoint('window.destroy', 'completed', detail);
}
function metric(pid) {
  const row = app.getAppMetrics().find(row => row.pid === pid);
  assert(row && Number.isFinite(row.cpu?.cumulativeCPUUsage), 'Renderer CPU counter is unavailable');
  return row;
}
persist();
void stage('app.ready', () => app.whenReady(), deadlines.ready).then(async () => {
  const fixture = path.join(root, 'fixture');
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const target = path.resolve(fixture, '.' + pathname);
    if (!target.startsWith(fixture + path.sep)) { response.writeHead(403).end(); return; }
    fs.readFile(target, (error, data) => {
      if (error) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : target.endsWith('.png') ? 'image/png' : target.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      response.end(data);
    });
  });
  await stage('server.listen', () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await openWindow(origin, { purpose: 'interaction checks' });
  report.transitions = await evaluate('interactions.transitions', 'performanceFixture.verifyTransitions()', deadlines.prepare);
  assert.equal(report.transitions.length, 4); persist();
  report.settledInteractions = await evaluate('interactions.settled', 'performanceFixture.verifySettledInteractions()', deadlines.prepare);
  assert.equal(report.settledInteractions.length, 4); persist();
  closeWindow();
  for (let round = 1; round <= rounds; round++) {
    const row = { round, scenarios: [] };
    report.rounds.push(row); persist();
    await openWindow(origin, { round });
    for (const kind of ['markdown', 'paragraph']) {
      const context = { round, kind };
      const preparation = await evaluate('scenario.prepare', `performanceFixture.startStreaming(${JSON.stringify(kind)}, 5000)`, deadlines.prepare, context);
      assert.equal(preparation.historyRows, 5000, 'Preparation must retain the full loaded history');
      assert.equal(preparation.scrollMode, 'main', 'Measure the production main transcript surface');
      assert(preparation.virtualSpacers > 0 && preparation.mountedTurns > 0 && preparation.mountedTurns < 2500, 'Main transcript must exercise its virtual window');
      row.preparations ??= []; row.preparations.push({ kind, ...preparation }); persist();
      const pid = window.webContents.getOSProcessId(), before = metric(pid), started = performance.now(), inputs = [];
      await stage('scenario.stream', async () => {
        let index = 0, status;
        do {
          const remaining = deadlines.streaming - (performance.now() - started);
          assert(remaining > 0, `Streaming exceeded ${deadlines.streaming}ms: round ${round} ${kind}`);
          const inputContext = { ...context, input: index };
          await evaluate('input.arm', `performanceFixture.armInput(${index})`, Math.min(deadlines.paint, remaining), inputContext);
          const focused = await evaluate('input.focus-check', 'document.hasFocus() && document.activeElement === document.querySelector("#input")', deadlines.paint, inputContext);
          assert(focused, `Native input target lost focus: round ${round} ${kind} input ${index}`);
          checkpoint('input.dispatch', 'started', inputContext);
          const dispatchedAt = performance.timeOrigin + performance.now();
          window.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
          const painted = await evaluate('input.paint', `performanceFixture.awaitInput(${index})`, deadlines.paint, inputContext);
          assert(painted.valueLength > 0);
          inputs.push(Math.max(0, painted.paintAt - dispatchedAt));
          checkpoint('input.dispatch', 'completed', inputContext);
          index++; await pause(15);
          status = await evaluate('scenario.status', 'performanceFixture.status()', deadlines.paint, context);
          assert(!status.error, status.error);
        } while (!status.done || inputs.length < 12);
      }, deadlines.streaming, context);
      const result = await evaluate('scenario.settle', 'performanceFixture.settle()', deadlines.settle, context);
      assert(!result.error, result.error);
      assert.equal(result.retainedHistoryRows, 5000, 'Streaming must retain all loaded history');
      assert.equal(result.deltas, 1440, 'All streaming events must be delivered');
      assert.equal(result.finalTextInDom, true, 'Current streamed content must be complete in the DOM');
      assert.equal(typeof result.finalTextVisible, 'boolean', 'Current viewport geometry must be recorded');
      assert(!result.horizontalOverflow, 'Transcript overflowed horizontally');
      if (kind === 'markdown') assert(result.highlightedSpans > 0, 'Code highlighting was lost');
      const elapsedMs = performance.now() - started, after = metric(pid);
      const cpuSeconds = after.cpu.cumulativeCPUUsage - before.cpu.cumulativeCPUUsage;
      const { html, text, ...measurements } = result;
      const scenario = { kind, historyRows: preparation.historyRows, preparation, ...measurements, inputs, inputP50Ms: percentile(inputs, .50), inputP95Ms: percentile(inputs, .95),
        measuredElapsedMs: elapsedMs, rendererCpuSeconds: cpuSeconds, rendererCpuPercent: cpuSeconds / (elapsedMs / 1000) * 100,
        htmlSha256: createHash('sha256').update(html).digest('hex'), textSha256: createHash('sha256').update(text).digest('hex') };
      const completed = await evaluate('scenario.finish-turn', 'performanceFixture.finishTurn()', deadlines.settle, context);
      const { html: completedHtml, ...completion } = completed;
      assert.equal(completion.savedMessages, 5001, 'The complete 5000-row history and final reply must be retained');
      assert.equal(completion.finalTextInDom, true, 'Final saved content must be complete in the DOM');
      assert.equal(typeof completion.finalTextVisible, 'boolean', 'Final viewport geometry must be recorded');
      assert.equal(completion.streamingIndicators, 0, 'Completed history retained streaming indicators');
      if (kind === 'markdown') assert(completion.highlightedSpans > 0, 'Final history lost code highlighting');
      if (completion.worker) {
        assert.equal(completion.worker.failed, false, 'Markdown worker failed during measurement');
        assert(completion.worker.completed > 0, 'The asynchronous rendering path was not exercised');
      }
      scenario.completion = { ...completion, htmlSha256: createHash('sha256').update(completedHtml).digest('hex') };
      for (const [measurement, value] of [['streaming', scenario], ['completion', scenario.completion]]) {
        for (const code of value.limitations || []) report.limitations.push({ round, kind, measurement, code, geometry: value.viewportGeometry });
      }
      row.scenarios.push(scenario); persist();
      if (round === 1) {
        fs.writeFileSync(path.join(root, kind + '-settled.html'), html);
        fs.writeFileSync(path.join(root, kind + '-completed.html'), completedHtml);
        const image = await stage('capture.settled', () => window.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 810 }), deadlines.operation, context);
        fs.writeFileSync(path.join(root, kind + '-settled.png'), image.toPNG());
        const clip = await evaluate('capture.prepare-tail', `(async () => {
          const viewport = document.querySelector('#messages');
          viewport.scrollTop = viewport.scrollHeight;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { x: 0, y: 0, width: innerWidth, height: Math.max(1, Math.floor(document.querySelector('#input').getBoundingClientRect().top - 10)) };
        })()`, deadlines.paint, context);
        const tail = await stage('capture.tail', () => window.webContents.capturePage(clip), deadlines.operation, context);
        fs.writeFileSync(path.join(root, kind + '-completed-tail.png'), tail.toPNG());
        await evaluate('capture.prepare-fixed', `(async () => {
          const viewport = document.querySelector('#messages'); viewport.style.height = '720px';
          const target = viewport.querySelector(${JSON.stringify(kind === 'markdown' ? 'pre' : '.msg-group.assistant:last-child')});
          target?.scrollIntoView({ block: 'center' });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`, deadlines.paint, context);
        window.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 }); await pause(400);
        const fixed = await stage('capture.fixed', () => window.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 720 }), deadlines.operation, context);
        fs.writeFileSync(path.join(root, kind + '-fixed-viewport.png'), fixed.toPNG());
        await evaluate('capture.restore-viewport', "document.querySelector('#messages').style.height = ''", deadlines.paint, context);
      }
      console.log(JSON.stringify({ round, kind, deltas: scenario.deltas, notifications: scenario.notifications, inputP95Ms: scenario.inputP95Ms, rendererCpuSeconds: cpuSeconds, longTasks: scenario.longTasks.length }));
    }
    closeWindow({ round });
  }
  await openWindow(origin, { purpose: 'retention' });
  report.retention = await evaluate('retention.visit', 'performanceFixture.retention(50)', deadlines.retention); persist();
  assert.equal(report.retention.visited, 50, 'All retention visits must complete');
  await stage('retention.collect-garbage', () => window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage'));
  report.heapAfterRetention = await stage('retention.heap', () => window.webContents.debugger.sendCommand('Runtime.getHeapUsage')); persist();
  report.domCounters = await stage('retention.dom', () => window.webContents.debugger.sendCommand('Memory.getDOMCounters')); persist();
  console.log('RETENTION ' + JSON.stringify(report.retention));
  console.log('HEAP ' + JSON.stringify(report.heapAfterRetention));
  console.log('LIMITATIONS ' + JSON.stringify(report.limitations));
  closeWindow();
  await stage('server.close', () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  assert.equal(report.rounds.length, rounds);
  assert(report.rounds.every(row => row.scenarios.length === 2));
  assert.equal(report.errors.length, 0);
  report.completed = true; report.completedAtMs = Date.now();
  checkpoint('measurement', 'completed'); persist(); finished = true;
  console.log('COMPLETED ' + JSON.stringify({ runId, rounds, workload: report.workload, elapsedMs: report.completedAtMs - report.startedAtMs }));
  app.exit(0);
}).catch(error => fail(error));
