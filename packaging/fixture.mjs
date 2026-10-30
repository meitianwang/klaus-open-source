import { spawnElectronGui } from '../scripts/electron-test-preflight.cjs';
// Test-only control through Node's public inspector. No test endpoint ships in the app.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { packageLocations } from './verify.mjs';
import { processTable, processIdentity, descendantRows, remainingOwned, terminateObserved } from './process-samples.mjs';

export async function until(work, timeout = 20000, label = 'condition') {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await work();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export class Inspector {
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.nextId = 1;
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data.toString());
      const pending = this.pending.get(value.id);
      if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.error) pending.reject(new Error(JSON.stringify(value.error))); else pending.resolve(value.result);
    });
    socket.addEventListener('close', () => { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Inspector disconnected')); } this.pending.clear(); });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new Inspector(socket);
  }
  async evaluate(expression) {
    const id = this.nextId++;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Inspector evaluation timed out')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      const wrapped = `(async () => { try { return await (0, eval)(${JSON.stringify(expression)}); } catch (error) { throw new Error(error instanceof Error ? error.stack : JSON.stringify(error)); } })()`;
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: wrapped, awaitPromise: true, returnByValue: true } }));
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.socket.close(); }
}

export function descendants(pid) {
  return descendantRows(processTable(), pid);
}

export async function launchPackage(bundle, profile, { guest = true, serverUrl, logPath } = {}) {
  mkdirSync(profile, { recursive: true });
  mkdirSync(join(profile, 'workspace'), { recursive: true });
  if (guest) writeFileSync(join(profile, 'klaus-guest-mode'), '1', { mode: 0o600 });
  const locations = packageLocations(bundle), start = performance.now(), wallStart = Date.now();
  const env = { ...process.env, KLAUS_CONFIG_DIR: profile, KLAUS_SESSION_DIR: join(profile, 'sessions'),
    KLAUS_PLUGIN_HOME: join(profile, 'plugins'), CANONICAL_CWD: join(profile, 'workspace'), KLAUS_TEST: '1',
    ...(serverUrl ? { KLAUS_SERVER_URL: serverUrl } : {}), ...(process.platform === 'win32' ? {} : { SHELL: '/bin/sh' }) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnElectronGui(locations.executable, ['--inspect=127.0.0.1:0'], { cwd: profile, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  let stderr = '', stdout = '', exit, launchError;
  const exited = new Promise(resolve => {
    child.once('error', error => { launchError = error; exit = { code: null, signal: null, launchError: String(error) }; resolve(exit); });
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit); });
  });
  child.stderr.on('data', data => { stderr += data; if (logPath) appendFileSync(logPath, data); });
  child.stdout.on('data', data => { stdout += data; if (logPath) appendFileSync(logPath, data); });
  let inspector, stopping;
  const observed = new Map();
  function ownedSnapshot() {
    const rows = child.pid ? descendants(child.pid) : [];
    for (const row of rows) observed.set(processIdentity(row), row);
    return rows;
  }
  async function stop() {
    if (stopping) return stopping;
    stopping = stopOnce(); return stopping;
  }
  async function stopOnce() {
    const started = performance.now(); ownedSnapshot(); let forced = false;
    const tracked = [...observed.values()];
    if (inspector && exit === undefined) {
      try { await inspector.evaluate('globalThis.__packageElectron.app.quit()'); } catch { /* Normal shutdown can close the inspector first. */ }
      inspector.close();
    }
    await Promise.race([exited, delay(10000, undefined, { ref: false })]);
    if (exit === undefined) {
      forced = true;
      child.kill('SIGTERM'); await Promise.race([exited, delay(3000, undefined, { ref: false })]);
      if (exit === undefined) { child.kill('SIGKILL'); await exited; }
    }
    let remaining = [];
    try {
      await until(() => { remaining = remainingOwned(tracked, processTable()); return !remaining.length; }, 3000, 'packaged child-process cleanup');
    } catch (error) {
      const beforeCleanup = remaining, cleanup = await terminateObserved(tracked);
      error.shutdown = { ...exit, shutdownMs: performance.now() - started, forced, trackedProcesses: tracked, remainingBeforeCleanup: beforeCleanup, ...cleanup };
      throw error;
    }
    const shutdown = { ...exit, stderr, stdout, shutdownMs: performance.now() - started, forced, trackedProcesses: tracked, remainingProcesses: remaining };
    if (forced) { const error = new Error('Packaged application did not exit through its normal shutdown path'); error.shutdown = shutdown; throw error; }
    return shutdown;
  }
  try {
    const endpoint = await until(() => {
      if (launchError) throw launchError;
      if (exit !== undefined) throw new Error(`Packaged application exited during startup: ${JSON.stringify(exit)}\n${stderr}`);
      return /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr)?.[1];
    }, 20000, 'the loopback test inspector');
    inspector = await Inspector.connect(endpoint);
    const log = join(profile, 'electron-host.log');
    await until(() => {
      if (exit !== undefined) throw new Error(`Packaged application exited during initialization\n${stderr}`);
      return existsSync(log) && readFileSync(log, 'utf8').split('\n').some(line => {
        if (!line.includes('"kind":"ready"')) return false;
        try { return Date.parse(JSON.parse(line).at) >= wallStart; } catch { return false; }
      });
    }, 30000, 'the production host ready record');
    const hostReadyMs = performance.now() - start;
    // The inspector can open during Node bootstrap, before Electron is available.
    await inspector.evaluate(`globalThis.__packageRequire = process.getBuiltinModule('module').createRequire(${JSON.stringify(join(locations.resources, 'app.asar/package.json'))}); globalThis.__packageElectron = __packageRequire('electron'); true`);
    const windowExpression = `__packageElectron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('klaus-app://'))`;
    await until(() => inspector.evaluate(`Boolean(${windowExpression})`), 10000, 'the packaged frontend window');
    const page = expression => inspector.evaluate(`${windowExpression}.webContents.executeJavaScript(${JSON.stringify(expression)})`);
    await until(() => page("Boolean(window.klaus && window.__KLAUS_DESKTOP__ && document.readyState === 'complete')"), 20000, 'the real frontend and isolated bridge');
    const frontendReadyMs = performance.now() - start;
    const invoke = (channel, value) => page(`window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke', ${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`);
    return { child, inspector, page, invoke, profile, hostReadyMs, frontendReadyMs, stop, log,
      snapshot: async () => {
        const processes = ownedSnapshot(), osSampledAtMs = performance.timeOrigin + performance.now();
        const electronMetrics = await inspector.evaluate('__packageElectron.app.getAppMetrics()');
        return { processes, electronMetrics, osSampledAtMs, sampledAtMs: performance.timeOrigin + performance.now() };
      } };
  } catch (error) {
    try { error.shutdown = await stop(); } catch (shutdownError) {
      const failure = new AggregateError([error, shutdownError], 'Packaged startup and cleanup failed'); failure.shutdown = shutdownError.shutdown; throw failure;
    }
    throw error;
  }
}
