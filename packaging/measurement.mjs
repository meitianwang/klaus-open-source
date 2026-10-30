import { createHash } from 'node:crypto';
import { readFileSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { arch, cpus, freemem, platform, release, totalmem, version } from 'node:os';

const budgetBytes = readFileSync(new URL('./measure-budgets.json', import.meta.url));
export const MEASURE_BUDGETS = JSON.parse(budgetBytes);
export const MEASURE_BUDGET_SHA256 = createHash('sha256').update(budgetBytes).digest('hex');
export const MEASURE_STAGES = ['idle', 'input', 'stream-tools', 'multitab-scroll', 'background', 'file-find', 'pty', 'post-cleanup-idle'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export function percentile(values, percent) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(percent / 100 * sorted.length) - 1)] : null;
}
export function hardware() {
  const processors = cpus();
  return { platform: platform(), arch: arch(), release: release(), osVersion: version(), logicalCpus: processors.length,
    cpuModels: [...new Set(processors.map(cpu => cpu.model))], memoryBytes: totalmem(), freeMemoryBytes: freemem(), runnerNodeVersion: process.version };
}

/** Stage boundaries are fsynced so a failed or interrupted round retains its last completed phase. */
export function createStageLog(path, header) {
  const fd = openSync(path, 'wx', 0o600); let sequence = 0, closed = false;
  const append = (type, fields = {}, durable = false) => {
    if (closed) throw new Error('Measurement log is closed');
    const row = { sequence: ++sequence, at: new Date().toISOString(), type, ...fields };
    writeFileSync(fd, JSON.stringify(row) + '\n'); if (durable) fsyncSync(fd); return row;
  };
  append('run-start', header, true);
  return { append, close() { if (!closed) { closed = true; fsyncSync(fd); closeSync(fd); } } };
}

function identity(row) { return `${row.pid}:${row.startedAt ?? ''}:${row.executable}`; }
/** Keep Electron and other descendants separate and never substitute lifetime ps %CPU. */
export function intervalCpu(previous, current) {
  if (!previous || !finite(current.sampledAtMs) || current.sampledAtMs <= previous.sampledAtMs) return { available: false, reason: 'No complete previous interval', processes: [] };
  const durationMs = current.sampledAtMs - previous.sampledAtMs, osDurationMs = current.osSampledAtMs - previous.osSampledAtMs;
  const before = new Map(previous.processes.map(row => [identity(row), row]));
  const previousMetrics = new Map(previous.electronMetrics.map(row => [row.pid, row])), metrics = new Map(current.electronMetrics.map(row => [row.pid, row]));
  const processes = current.processes.map(row => {
    const old = before.get(identity(row)), metric = metrics.get(row.pid), prior = previousMetrics.get(row.pid);
    const sameMetric = metric && prior && metric.creationTime === prior.creationTime;
    const cumulative = metric?.cpu?.cumulativeCPUUsage, oldCumulative = prior?.cpu?.cumulativeCPUUsage;
    const electron = Boolean(metric), useElectron = old && sameMetric && finite(cumulative) && finite(oldCumulative) && cumulative >= oldCumulative;
    const intervalMs = useElectron ? durationMs : osDurationMs;
    const seconds = !finite(intervalMs) || intervalMs <= 0 ? null : useElectron ? cumulative - oldCumulative : old && finite(row.cpuSeconds) && finite(old.cpuSeconds) && row.cpuSeconds >= old.cpuSeconds ? row.cpuSeconds - old.cpuSeconds : null;
    return { pid: row.pid, identity: identity(row), group: electron ? 'electron' : 'other-owned',
      bucket: useElectron ? 'electronAppMetrics' : electron ? 'electronOsFallback' : 'otherOwned', intervalMs,
      source: useElectron ? 'electron-cumulativeCPUUsage' : seconds === null ? 'unavailable' : 'os-cumulative-cpu-time',
      cpuSeconds: seconds, percent: seconds === null ? null : 100 * seconds / (intervalMs / 1000) };
  });
  const currentIds = new Set(current.processes.map(identity));
  const exited = previous.processes.filter(row => !currentIds.has(identity(row))).map(row => ({ pid: row.pid, identity: identity(row) }));
  const available = processes.length > 0 && !exited.length && processes.every(row => finite(row.percent));
  const total = group => processes.filter(row => !group || row.group === group).reduce((sum, row) => sum + (row.percent ?? 0), 0);
  const buckets = Object.fromEntries(['electronAppMetrics', 'electronOsFallback', 'otherOwned'].map(name => [name, {
    durationMs: name === 'electronAppMetrics' ? durationMs : osDurationMs,
    cpuSeconds: processes.filter(row => row.bucket === name).reduce((sum, row) => sum + (row.cpuSeconds ?? 0), 0),
  }]));
  return { available, durationMs, osDurationMs, buckets, processes, exited, electronPercent: total('electron'), otherOwnedPercent: total('other-owned'), totalPercent: available ? total() : null,
    ...(!available ? { reason: 'A process has no matched cumulative interval or exited between samples; partial totals are not a whole-app CPU measurement.' } : {}) };
}

export function summarizeStage(samples, timings = {}) {
  const rss = samples.map(sample => sample.processes.reduce((sum, process) => sum + process.rssKiB, 0));
  const cpu = samples.map(sample => sample.intervalCpu), completeCpu = cpu.length > 0 && cpu.every(sample => sample?.available);
  const cpuBuckets = Object.fromEntries(['electronAppMetrics', 'electronOsFallback', 'otherOwned'].map(name => {
    const seconds = cpu.reduce((sum, sample) => sum + (sample?.buckets?.[name]?.cpuSeconds ?? 0), 0);
    const durationMs = cpu.reduce((sum, sample) => sum + (sample?.buckets?.[name]?.durationMs ?? 0), 0);
    return [name, { cpuSeconds: seconds, durationMs, percent: completeCpu && durationMs > 0 ? 100 * seconds / (durationMs / 1000) : null }];
  }));
  const wakeups = samples.map(sample => sample.electronWakeupsPerSecond);
  const loopP99 = samples.map(sample => sample.mainLoop?.p99Ms), loopMax = samples.map(sample => sample.mainLoop?.maxMs);
  return { sampleCount: samples.length, rssMeanKiB: mean(rss), rssPeakKiB: rss.length ? Math.max(...rss) : null,
    cpuMeanPercent: completeCpu && Object.values(cpuBuckets).every(row => finite(row.percent)) ? Object.values(cpuBuckets).reduce((sum, row) => sum + row.percent, 0) : null,
    cpuBuckets,
    cpuCoverage: completeCpu ? 'complete' : 'incomplete',
    electronWakeupsMeanPerSecond: wakeups.length && wakeups.every(finite) ? mean(wakeups) : null,
    mainLoopP99Ms: loopP99.length && loopP99.every(finite) ? Math.max(...loopP99) : null,
    mainLoopMaxMs: loopMax.length && loopMax.every(finite) ? Math.max(...loopMax) : null,
    inputFrameP95Ms: percentile(timings.inputFrameMs ?? [], 95), fileSearchP95Ms: percentile(timings.fileSearchMs ?? [], 95), ...timings };
}

export function checkLimit(name, actual, maximum, scope) {
  return { name, actual: finite(actual) ? actual : null, maximum, scope, status: !finite(actual) ? 'unavailable' : actual <= maximum ? 'pass' : 'fail' };
}
export function stageChecks(name, summary, limits = MEASURE_BUDGETS.limits) {
  const checks = [checkLimit('rssPeakKiB', summary.rssPeakKiB, name === 'idle' ? limits.idleRssKiB : limits.loadedRssKiB, 'all owned processes'),
    checkLimit('mainLoopP99Ms', summary.mainLoopP99Ms, limits.mainLoopP99Ms, 'Electron main process'),
    checkLimit('mainLoopMaxMs', summary.mainLoopMaxMs, limits.mainLoopMaxMs, 'Electron main process')];
  if (['idle', 'post-cleanup-idle'].includes(name)) checks.push(checkLimit('idleCpuPercent', summary.cpuMeanPercent, limits.idleCpuPercent, 'all owned processes, one logical CPU = 100%'),
    checkLimit('idleElectronWakeupsPerSecond', summary.electronWakeupsMeanPerSecond, limits.idleElectronWakeupsPerSecond, 'Electron processes only; engine/helper wakeups unavailable'));
  if (['input', 'multitab-scroll'].includes(name)) checks.push(checkLimit('inputFrameP95Ms', summary.inputFrameP95Ms, limits.inputFrameP95Ms, 'controlled native input dispatch to renderer animation frame; no display scanout measurement'));
  if (name === 'file-find') checks.push(checkLimit('fileSearchP95Ms', summary.fileSearchP95Ms, limits.fileSearchP95Ms, 'IPC request through native file index'));
  if (name === 'pty') checks.push(checkLimit('ptyDurationMs', summary.ptyDurationMs, limits.ptyDurationMs, '8 MiB ordered payload through production PTY and renderer consumer'));
  return checks;
}

export function measurementStatus(report) {
  const checks = report.rounds.flatMap(round => [...(round.checks ?? []).map(check => ({ ...check, round: round.round })),
    ...round.stages.flatMap(stage => [...stage.checks,
      ...(stage.summary.cpuCoverage === 'complete' && finite(stage.summary.cpuMeanPercent) ? [] : [{
        name: 'cpuMeanPercent', actual: null, status: 'unavailable', scope: 'all owned processes',
        reason: 'Whole-app CPU requires matched cumulative counters throughout every workload stage.',
      }])].map(check => ({ ...check, round: round.round, stage: stage.name })))]);
  const failed = checks.filter(check => check.status === 'fail');
  const unavailable = checks.filter(check => check.status === 'unavailable');
  const requiredUnavailable = unavailable.filter(check => check.name !== 'idleElectronWakeupsPerSecond');
  const fullWorkload = report.rounds.length === report.requestedRounds && report.rounds.length >= MEASURE_BUDGETS.workload.rounds && report.samplesPerStage >= MEASURE_BUDGETS.workload.samplesPerStage
    && report.rounds.every(round => MEASURE_STAGES.every(name => round.stages.filter(stage => stage.name === name && stage.summary.sampleCount >= MEASURE_BUDGETS.workload.samplesPerStage).length === 1) && round.shutdown?.remainingProcesses?.length === 0);
  const status = report.errors.length || failed.length ? 'failed' : requiredUnavailable.length || !fullWorkload || report.profileRenderer ? 'incomplete' : unavailable.length || report.unavailableMetrics?.length ? 'complete-with-unavailable-metrics' : 'passed';
  return { status, failed, unavailable, fullWorkload, exitCode: status === 'failed' ? 1 : status === 'incomplete' ? 2 : 0 };
}

export const METHOD = {
  startup: 'Fresh process each round. Round one creates its own profile, subsequent rounds reuse that profile after fixture cleanup. OS filesystem caches are not cleared.',
  input: 'Public Electron native input dispatch to the second renderer requestAnimationFrame. DOM state must change; native scrolling reaches scrollend before the next input. This is not physical input-to-photon latency.',
  memory: 'Sampled owned process RSS/WorkingSet sum in KiB, with per-PID source records. Shared pages may be counted in multiple processes; sub-interval memory peaks are not captured.',
  cpu: 'Differences of cumulative CPU seconds over each source clock; one logical CPU is 100%. Electron appMetrics and other observed owned processes are grouped and merged once by PID and creation identity. Churn or missing counters make CPU unavailable. Processes born and exited entirely between OS samples cannot be accounted for.',
  loop: 'Node monitorEventLoopDelay with 20 ms resolution; nanosecond histogram converted to milliseconds per sampling interval.',
  wakeups: 'Electron CPUUsage idleWakeupsPerSecond has a real source on macOS. Windows always returns zero, so it is unavailable. Rust engine/helper wakeups and energy consumption have no source in this runner.',
  energy: { status: 'unavailable', reason: 'No privileged whole-system energy sampler or calibrated power source is used.' },
  instrumentation: 'A loopback public Node Inspector, main-loop histogram, renderer event observers and bounded PTY integrity parser add measurement overhead. The provider and file corpus are isolated local fixtures; no remote model account is used.',
  sources: ['https://www.electronjs.org/docs/latest/api/structures/cpu-usage', 'https://www.electronjs.org/docs/latest/api/structures/process-metric', 'https://nodejs.org/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions'],
};
