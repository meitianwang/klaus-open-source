import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnElectronGui } from './electron-test-preflight.cjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
export const PERFORMANCE_DEADLINE_MS = 300_000;
export const PERFORMANCE_WORKLOAD = Object.freeze({ historyRows: 5000, retentionVisits: 50 });
export function measurementRounds(value = process.env.KLAUS_PERFORMANCE_TEST_ROUNDS ?? 3) {
  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 3 || rounds > 5) throw new Error('Measurement rounds must be between three and five');
  return rounds;
}

/** Process exit is necessary, but a complete measurement is the acceptance gate. */
export function validatePerformanceReport(report, { phase, rounds, runId }) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const number = (value, minimum = 0) => typeof value === 'number' && Number.isFinite(value) && value >= minimum;
  const integer = (value, minimum = 0) => Number.isInteger(value) && value >= minimum;
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const visibility = (record, label) => {
    check(record?.finalTextInDom === true, `${label} lacks complete DOM content`);
    check(typeof record?.finalTextVisible === 'boolean', `${label} lacks a viewport diagnostic`);
    if (record?.finalTextVisible === false) {
      check(object(record.viewportGeometry) && Number.isFinite(record.viewportGeometry.rect?.top)
        && Number.isFinite(record.viewportGeometry.viewport?.bottom)
        && Array.isArray(record.limitations) && record.limitations.includes('isolated-fixture-sentinel-outside-viewport'), `${label} omits its viewport limitation evidence`);
    }
  };
  if (!object(report)) return ['Missing or invalid performance report'];
  check(report.completed === true, 'Performance report is not completed:true');
  check(report.phase === phase, 'Measurement phase does not match');
  if (runId !== undefined) check(report.runId === runId, 'Measurement run identity does not match');
  check(report.expectedRounds === rounds, 'Declared round count does not match');
  check(number(report.startedAtMs, 1) && number(report.completedAtMs, report.startedAtMs), 'Completion timestamps are missing or invalid');
  check(report.workload?.historyRows === PERFORMANCE_WORKLOAD.historyRows && report.workload?.retentionVisits === PERFORMANCE_WORKLOAD.retentionVisits, 'Measurement workload is missing or reduced');
  check(Array.isArray(report.errors) && report.errors.length === 0, 'Performance report contains errors or omits its error list');
  for (const field of ['transitions', 'settledInteractions']) {
    check(Array.isArray(report[field]) && report[field].length === 4 && report[field].every(value => typeof value === 'string' && value.length > 0), `${field} did not complete all four checks`);
  }
  check(Array.isArray(report.rounds) && report.rounds.length === rounds, `Expected exactly ${rounds} completed rounds`);
  for (const [index, row] of (Array.isArray(report.rounds) ? report.rounds : []).entries()) {
    const prefix = `Round ${index + 1}`;
    check(object(row) && row.round === index + 1, `${prefix} has the wrong identity`);
    check(Array.isArray(row?.scenarios) && row.scenarios.length === 2, `${prefix} must contain both scenarios`);
    for (const [scenarioIndex, scenario] of (Array.isArray(row?.scenarios) ? row.scenarios : []).entries()) {
      const kind = ['markdown', 'paragraph'][scenarioIndex], label = `${prefix} ${kind}`;
      if (!object(scenario)) { errors.push(`${label} is missing`); continue; }
      check(scenario.kind === kind && scenario.done === true && scenario.error === undefined, `${label} is incomplete, failed, or has the wrong kind`);
      check(scenario.historyRows === PERFORMANCE_WORKLOAD.historyRows && scenario.retainedHistoryRows === PERFORMANCE_WORKLOAD.historyRows, `${label} did not retain 5000 history rows`);
      const preparation = scenario.preparation;
      check(object(preparation) && preparation.historyRows === 5000 && preparation.scrollMode === 'main' && integer(preparation.virtualSpacers, 1)
        && integer(preparation.mountedTurns, 1) && preparation.mountedTurns < 2500 && integer(preparation.domElements, 1), `${label} lacks production virtual window evidence`);
      check(scenario.deltas === 1440, `${label} did not deliver all 1440 streaming events`);
      visibility(scenario, label);
      check(Array.isArray(scenario.inputs) && scenario.inputs.length >= 12 && scenario.inputs.every(value => number(value)), `${label} lacks native input samples`);
      for (const field of ['inputP50Ms', 'inputP95Ms', 'rendererCpuSeconds', 'rendererCpuPercent', 'mutations']) check(number(scenario[field]), `${label} lacks ${field}`);
      for (const field of ['measuredElapsedMs', 'durationMs']) check(number(scenario[field], Number.MIN_VALUE), `${label} lacks ${field}`);
      for (const field of ['domElements', 'deltas', 'notifications']) check(integer(scenario[field], 1), `${label} lacks ${field}`);
      check(Array.isArray(scenario.longTasks) && scenario.longTasks.every(value => number(value)), `${label} lacks long task measurements`);
      check(scenario.horizontalOverflow === false, `${label} has horizontal overflow or no DOM verdict`);
      check(integer(scenario.highlightedSpans) && (kind !== 'markdown' || scenario.highlightedSpans > 0), `${label} lacks highlighted DOM evidence`);
      check(hash(scenario.htmlSha256) && hash(scenario.textSha256), `${label} lacks content hashes`);
      const completion = scenario.completion;
      check(object(completion) && completion.savedMessages === PERFORMANCE_WORKLOAD.historyRows + 1 && completion.streamingIndicators === 0 && hash(completion.htmlSha256), `${label} lacks a complete history handoff`);
      visibility(completion, `${label} completion`);
      check(integer(completion?.highlightedSpans) && (kind !== 'markdown' || completion.highlightedSpans > 0), `${label} lost final highlighting`);
      // Some measured revisions have no worker. A present worker must complete cleanly.
      if (completion?.worker !== null && completion?.worker !== undefined) {
        check(completion.worker.failed === false && integer(completion.worker.completed, 1) && completion.worker.inFlight === 0 && completion.worker.queued === 0, `${label} has unfinished or failed worker work`);
      }
    }
  }
  check(object(report.retention) && report.retention.visited === PERFORMANCE_WORKLOAD.retentionVisits, 'Retention did not visit exactly 50 conversations');
  for (const phase of ['beforeDelete', 'afterDelete']) {
    const retained = report.retention?.[phase];
    check(object(retained) && ['records', 'histories', 'serializedHistoryBytes'].every(field => integer(retained[field])), `Retention ${phase} is missing cache measurements`);
  }
  const heap = report.heapAfterRetention;
  check(object(heap) && number(heap.usedSize, 1) && number(heap.totalSize, heap.usedSize), 'Post-GC heap measurement is missing or invalid');
  const dom = report.domCounters;
  check(object(dom) && integer(dom.documents, 1) && integer(dom.nodes, 1) && integer(dom.jsEventListeners), 'Post-retention DOM counters are missing or invalid');
  return errors;
}

/** Keep timeout/signal provenance even when Electron handles TERM and exits zero. */
export async function supervisePerformanceChild(child, { output, phase, rounds, runId, timeoutMs = PERFORMANCE_DEADLINE_MS, killGraceMs = 5000 }) {
  mkdirSync(output, { recursive: true });
  const log = text => { appendFileSync(join(output, 'electron.log'), text); process.stdout.write(text); };
  let timedOut = false, interruptedSignal = null, hardKill;
  const terminate = signal => {
    child.kill(signal);
    hardKill ??= setTimeout(() => child.kill('SIGKILL'), killGraceMs);
  };
  const signalHandlers = ['SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => { interruptedSignal = signal; log(`\nRUNNER SIGNAL: ${signal}\n`); terminate(signal); };
    process.on(signal, handler); return [signal, handler];
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => log(String(chunk)));
  const timer = setTimeout(() => { timedOut = true; log(`\nRUNNER TIMEOUT: ${timeoutMs}ms; sending SIGTERM\n`); terminate('SIGTERM'); }, timeoutMs);
  let exit;
  try {
    exit = await new Promise(resolveExit => {
      child.once('error', error => resolveExit({ code: null, signal: null, error: String(error.stack || error) }));
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
  } finally {
    clearTimeout(timer); clearTimeout(hardKill);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
  const errors = [];
  if (timedOut) errors.push(`Performance deadline exceeded (${timeoutMs}ms)`);
  if (interruptedSignal) errors.push(`Performance runner interrupted by ${interruptedSignal}`);
  if (exit.signal) errors.push(`Performance child terminated by ${exit.signal}`);
  if (exit.error) errors.push(exit.error);
  if (exit.code !== 0) errors.push(`Performance child exited with ${exit.code}`);
  let limitations = [];
  try {
    const report = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8'));
    errors.push(...validatePerformanceReport(report, { phase, rounds, runId }));
    if (Array.isArray(report.limitations)) limitations = report.limitations;
  } catch (error) { errors.push(`Cannot read performance report: ${error.message}`); }
  const outcome = { ok: errors.length === 0, completed: errors.length === 0, phase, runId, expectedRounds: rounds,
    deadlineMs: timeoutMs, timedOut, interruptedSignal, exitCode: exit.code, exitSignal: exit.signal, errors, limitations };
  writeFileSync(join(output, 'runner-result.json'), JSON.stringify(outcome, null, 2) + '\n');
  log('\nRUNNER RESULT: ' + JSON.stringify(outcome) + '\n');
  return outcome;
}

async function main() {
  const phase = process.argv[2] ?? 'candidate';
  if (!/^[a-z0-9-]+$/.test(phase)) throw new Error('Invalid measurement phase');
  const rounds = measurementRounds();
  const output = resolve(process.argv[3] ?? join(desktop, 'dist/performance-fix-logs/20261021', phase));
  const fixture = join(output, 'fixture'), runId = randomUUID();
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(output, 'run.json'), JSON.stringify({ phase, runId, rounds, workload: PERFORMANCE_WORKLOAD, deadlineMs: PERFORMANCE_DEADLINE_MS, startedAtMs: Date.now() }, null, 2) + '\n');
  await require('esbuild').build({ entryPoints: [join(desktop, 'frontend/src/chat/performance-dom-entry.ts')],
    outfile: join(fixture, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent' });
  const worker = join(desktop, 'frontend/src/chat/markdown.worker.ts');
  if (existsSync(worker)) await require('esbuild').build({ entryPoints: [worker], outfile: join(fixture, 'markdown-worker.js'),
    bundle: true, platform: 'browser', format: 'esm', logLevel: 'silent' });
  cpSync(join(desktop, 'frontend/css'), join(fixture, 'css'), { recursive: true });
  cpSync(join(desktop, 'frontend/public/agent-avatar.png'), join(fixture, 'agent-avatar.png'));
  writeFileSync(join(fixture, 'index.html'), `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="css/styles.css"><link rel="stylesheet" href="browser.css">
<style>*{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:var(--fg)}
#messages{height:calc(100% - 90px);padding:32px 64px;overflow:auto;display:block;overflow-anchor:none}
#input{position:fixed;bottom:12px;left:64px;width:calc(100% - 128px);height:60px;resize:none;font:16px system-ui}</style></head>
<body><div id="messages"></div><textarea id="input" aria-label="Measurement input"></textarea><script src="browser.js"></script></body></html>`);
  const binary = require('electron'), args = [join(desktop, 'tests/performance-electron.cjs')];
  const env = { ...process.env, KLAUS_PERFORMANCE_TEST_ROOT: output, KLAUS_PERFORMANCE_TEST_PHASE: phase,
    KLAUS_PERFORMANCE_TEST_RUN_ID: runId, KLAUS_PERFORMANCE_TEST_ROUNDS: String(rounds) };
  delete env.ELECTRON_RUN_AS_NODE;
  writeFileSync(join(output, 'electron.log'), 'COMMAND: ' + JSON.stringify([binary, ...args]) + '\n');
  const child = spawnElectronGui(binary, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const outcome = await supervisePerformanceChild(child, { output, phase, rounds, runId });
  process.exitCode = outcome.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
