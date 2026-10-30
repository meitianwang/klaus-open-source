import { spawnElectronGui } from '../scripts/electron-test-preflight.cjs';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Inspector, until } from './fixture.mjs';
import { childEnvironment, macProcesses } from './update-macos-environment.mjs';
import { inspectorPortFree } from './update-transport-probe.mjs';

export const mainWindow = `__updateElectron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('klaus-app://app/'))`;
const invokeExpression = (channel, value) => `window.__KLAUS_DESKTOP__.core.invoke('ipc_invoke', ${JSON.stringify({ channel, args: value === undefined ? [] : [value] })})`;
async function connectInspector(endpoint) {
  if (!/^ws:\/\/127\.0\.0\.1:\d+\/[^\s]+$/.test(endpoint)) throw new Error('Only a loopback Node inspector is accepted');
  const socket = new WebSocket(endpoint);
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out')); }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); ready(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('Inspector connection failed')); }, { once: true });
  });
  return new Inspector(socket);
}
export async function connectRuntime({ endpoint, pid, executable, profile, version, record }) {
  const inspector = await connectInspector(endpoint);
  try {
    const identity = await inspector.evaluate('({pid:process.pid,executable:process.execPath,arch:process.arch})');
    if (identity.pid !== pid || resolve(identity.executable) !== resolve(executable)) throw new Error('The inspector does not belong to the expected update process');
    const packageFile = resolve(executable, '../../Resources/app.asar/package.json');
    await inspector.evaluate(`globalThis.__updateElectron = process.getBuiltinModule('module').createRequire(${JSON.stringify(packageFile)})('electron'); true`);
    const status = await inspector.evaluate(`({version:__updateElectron.app.getVersion(),profile:__updateElectron.app.getPath('userData'),packaged:__updateElectron.app.isPackaged})`);
    if (!status.packaged || status.version !== version || status.profile !== join(profile, 'electron')) throw new Error('Automatic restart changed version, packaged identity or profile unexpectedly');
    await until(() => inspector.evaluate(`Boolean(${mainWindow})`), 30_000, 'the real updated main window');
    const page = expression => inspector.evaluate(`${mainWindow}.webContents.executeJavaScript(${JSON.stringify(expression)})`);
    await until(() => page("Boolean(window.__KLAUS_DESKTOP__ && document.readyState === 'complete')"), 30_000, 'the production IPC bridge');
    record('runtime-identity', { ...identity, ...status });
    return { inspector, pid, page, invoke: (channel, value) => page(invokeExpression(channel, value)),
      async beginInstall() {
        await inspector.evaluate(`globalThis.__updateInstallResult={pending:true}; void ${mainWindow}.webContents.executeJavaScript(${JSON.stringify(invokeExpression('updater:install'))}).then(value => { globalThis.__updateInstallResult={value}; }, error => { globalThis.__updateInstallResult={error:String(error)}; }); true`);
      },
      async quit() {
        try { await inspector.evaluate('__updateElectron.app.quit(); true'); }
        catch (error) { if (!/disconnected|closed/i.test(String(error))) throw error; }
        inspector.close();
      },
    };
  } catch (error) { inspector.close(); throw error; }
}

export async function launchFirst({ bundle, profile, ca, version, log, record, onSpawn = () => {} }) {
  const executable = join(bundle, 'Contents/MacOS/Klaus');
  const started = Date.now();
  const descriptor = openSync(log, 'ax', 0o600);
  let child;
  try { child = spawnElectronGui(executable, ['--inspect=127.0.0.1:0'], { env: childEnvironment(profile, ca), cwd: profile, stdio: ['ignore', descriptor, descriptor] }); }
  finally { closeSync(descriptor); }
  onSpawn(child);
  let exit, failure;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => { exit = { code, signal }; record('e1-exit', { pid: child.pid, ...exit }); resolve(exit); }));
  child.once('error', error => { failure = error; });
  const endpoint = await until(() => {
    if (failure || exit) throw failure ?? new Error('E1 exited before its inspector was ready');
    return /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(readFileSync(log, 'utf8'))?.[1];
  }, 30_000, 'the test-only E1 inspector');
  const hostLog = join(profile, 'electron-host.log');
  await until(() => {
    if (failure || exit) throw failure ?? new Error('E1 exited before the production entry was ready');
    return existsSync(hostLog) && readFileSync(hostLog, 'utf8').split('\n').some(line => {
      try { const entry = JSON.parse(line); return entry.kind === 'ready' && Date.parse(entry.at) >= started && JSON.parse(entry.detail).version === version; }
      catch { return false; }
    });
  }, 30_000, 'the E1 production entry before inspector injection');
  const runtime = await connectRuntime({ endpoint, pid: child.pid, executable, profile, version, record });
  return { ...runtime, child, exited, exit: () => exit, executable };
}

/** Observe the automatic Squirrel process before sending any test-only control signal. */
export async function observeRestart({ firstPid, executable, profile, version, since, record, signal }) {
  const identity = await until(() => { signal?.throwIfAborted(); return macProcesses().find(row => row.pid !== firstPid && row.executable === executable
    && Date.parse(row.started) >= since - 1500); }, 120_000, 'the automatic Squirrel E2 process');
  const log = join(profile, 'electron-host.log');
  await until(() => { signal?.throwIfAborted(); return existsSync(log) && readFileSync(log, 'utf8').split('\n').some(line => {
    try { const value = JSON.parse(line); return value.kind === 'ready' && Date.parse(value.at) >= since
      && JSON.parse(value.detail).version === version; } catch { return false; }
  }); }, 60_000, 'E2 readiness in the original profile');
  record('automatic-restart-observed', identity);
  const again = macProcesses().find(row => row.pid === identity.pid);
  if (!again || again.started !== identity.started || again.executable !== executable) throw new Error('E2 process identity changed before inspector activation');
  if (!inspectorPortFree()) throw new Error('The standard inspector port became occupied; no E2 control signal was sent');
  process.kill(identity.pid, 'SIGUSR1');
  const endpoint = await until(async () => {
    signal?.throwIfAborted();
    try {
      const response = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(1000) });
      const targets = await response.json();
      const candidate = targets.find(target => /^ws:\/\/127\.0\.0\.1:9229\//.test(target.webSocketDebuggerUrl));
      return candidate?.webSocketDebuggerUrl;
    } catch { return undefined; }
  }, 10_000, 'the public SIGUSR1 loopback inspector');
  return connectRuntime({ endpoint, pid: identity.pid, executable, profile, version, record });
}
