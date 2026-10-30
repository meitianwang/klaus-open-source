// Real Windows registry, packaged Node host and isolated official Chrome fixture.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { createServer } = require('node:http');
const { createConnection } = require('node:net');
const { execFileSync, spawn } = require('node:child_process');
const { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [resources, profile, chromeExecutable, reportPath] = process.argv.slice(2);
assert.equal(process.platform, 'win32'); assert(process.versions.electron);
const fromApp = createRequire(join(resources, 'app.asar/package.json'));
const { resolveDesktopPaths } = fromApp('./dist/main/app/paths');
const { ChromeSetup } = fromApp('./dist/main/browser/chrome-setup');
const { ChromeBrowserService } = fromApp('./dist/main/browser/chrome-browser');
const { ChromeRelay, discoverChrome } = fromApp('./dist/main/browser/chrome-relay');
const { chromeFrame } = fromApp('./dist/main/browser/chrome-wire');
const paths = resolveDesktopPaths({ appRoot: join(resources, 'app.asar'), resourcesPath: resources, packaged: true });
const name = JSON.parse(readFileSync(join(paths.chromeExtensionRoot, 'extension-id.json'), 'utf8')).extensionHostName;
const bases = ['Software\\Google\\Chrome', 'Software\\Microsoft\\Edge', 'Software\\BraveSoftware\\Brave-Browser', 'Software\\Chromium'];
const keys = bases.map(base => `${base}\\NativeMessagingHosts\\${name}`);
// reg.exe is an external executable, so registry probes survive policy that locks
// PowerShell into Constrained Language Mode; the remaining PowerShell call below only
// uses cmdlets.
const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${command}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
const regView = view => (view === 'Registry32' ? '/reg:32' : '/reg:64');
function registry() {
  const rows = [];
  for (const view of ['Registry32', 'Registry64']) {
    for (const key of keys) {
      let value = null;
      try {
        const output = execFileSync('reg.exe', ['query', `HKCU\\${key}`, '/ve', regView(view)], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
        const line = output.split(/\r?\n/).map(row => row.trim()).find(row => row.startsWith('(Default)') && row.includes('REG_SZ'));
        value = line ? line.slice(line.indexOf('REG_SZ') + 'REG_SZ'.length).trim() : null;
      } catch { value = null; }
      rows.push({ key, view, exists: value !== null, value });
    }
  }
  return rows;
}
async function until(work, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await work(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Windows Chrome fixture timed out');
}
const checks = [], diagnostics = [];
const record = (name, detail = true) => { checks.push({ name, detail }); console.log(`ok ${name}`); };
const config = join(profile, 'Klaus 配置 with spaces'), chromeProfile = join(profile, 'chrome-profile');
const discoveryDirectory = join(config, 'relay');
const manifestPath = join(config, 'chrome-native-host', `${name}.json`);
const leasePath = join(profile, 'registry-lease.json');
function restoreRegistry() {
  for (const row of registry().filter(row => row.exists)) {
    assert.equal(row.value, manifestPath, 'Refuse to delete a registration changed by another process');
    execFileSync('reg.exe', ['delete', `HKCU\\${row.key}`, '/f', regView(row.view)], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
  }
  const after = registry(); assert(after.every(row => !row.exists)); return after;
}
const server = createServer((request, response) => {
  if (request.url === '/download') { response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="windows-package.txt"' }); response.end('Windows packaged Chrome download'); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<title>Windows package page</title><input id="value" value="before"><button id="run" onclick="document.body.dataset.clicked=\'yes\'">Run</button>');
});
let ownedRegistry = false, browser, browserExit, service, nativePid, relay, failure;
const chromeLog = join(profile, 'chrome.log');
async function closeBrowser() {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  const [port, path] = readFileSync(join(chromeProfile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
  const socket = new WebSocket(`ws://127.0.0.1:${Number(port)}${path}`);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser close connection timed out')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
    });
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await until(() => browser.exitCode !== null || browser.signalCode !== null, 15000);
    await browserExit;
  } finally { socket.close(); }
}
if (reportPath === '--cleanup') {
  // The parent runs this independent process even after a fixture timeout.
  // A lease is created only after the original two-view state was all absent.
  if (existsSync(leasePath)) {
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    assert.equal(lease.manifestPath, manifestPath); assert.equal(lease.originalAbsent, true);
    if (Number.isSafeInteger(lease.chromePid) && lease.chromePid > 0) {
      const command = ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${lease.chromePid}'; if ($p) { $p.CommandLine }`).trim();
      if (command && command.includes(chromeProfile)) execFileSync('taskkill.exe', ['/PID', String(lease.chromePid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    console.log(JSON.stringify({ registryRestored: restoreRegistry().every(row => !row.exists) }));
  }
} else void (async () => {
  try {
    assert(existsSync(chromeExecutable), 'Official Chrome for Testing is required');
    const before = registry(); assert.equal(before.length, 8);
    assert(before.every(row => !row.exists), 'Existing user native messaging registrations are never overwritten');
    record('all four registry keys are absent in both registry views', before);
    writeFileSync(leasePath, JSON.stringify({ manifestPath, originalAbsent: true }), { mode: 0o600 });
    ownedRegistry = true;
    mkdirSync(join(chromeProfile, 'Default'), { recursive: true }); mkdirSync(join(profile, 'downloads'));
    writeFileSync(join(chromeProfile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: join(profile, 'downloads'), prompt_for_download: false } }));
    const setup = new ChromeSetup({ configRoot: config, extensionRoot: paths.chromeExtensionRoot, browserDataRoots: [chromeProfile], browserExecutable: chromeExecutable,
      enabled: () => true, executable: process.execPath, hostScript: paths.chromeHostScript, discoveryDirectory });
    const installed = await setup.install(); assert.equal(installed.ok, true, JSON.stringify(installed));
    const registered = registry().filter(row => row.exists);
    assert(keys.every(key => registered.some(row => row.key === key))); assert(registered.every(row => row.value === manifestPath));
    record('production setup registers the packaged launcher in HKCU', { count: registered.length, manifestPath, hostPath: installed.hostPath });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    const log = createWriteStream(chromeLog);
    browser = spawn(chromeExecutable, [`--user-data-dir=${chromeProfile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--remote-debugging-port=0', '--enable-logging=stderr', `--load-extension=${paths.chromeExtensionRoot}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    writeFileSync(leasePath, JSON.stringify({ manifestPath, originalAbsent: true, chromePid: browser.pid }), { mode: 0o600 });
    browser.stdout.pipe(log); browser.stderr.pipe(log);
    browserExit = new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', (code, signal) => { log.end(); resolve({ code, signal }); }); });
    const instance = await until(async () => {
      if (browser.exitCode !== null || browser.signalCode !== null) throw new Error('Official Chrome exited before connecting');
      return (await discoverChrome(discoveryDirectory)).browsers[0];
    }, 40000);
    relay = await ChromeRelay.connect(instance.endpoint); nativePid = (await relay.request('host/browser')).pid;
    assert(nativePid > 0 && nativePid !== process.pid); assert(instance.endpoint.endsWith('.port'));
    assert.equal((await setup.diagnostics()).diagnostics.ok, true);
    record('official Chrome launches the actual packaged native host with Unicode paths', { browserId: instance.id, nativePid, endpointKind: 'loopback' });
    const endpoint = JSON.parse(readFileSync(instance.endpoint, 'utf8')); assert(/^127\.0\.0\.1:\d+$/.test(endpoint.addr));
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(endpoint.addr.split(':')[1]) });
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('Unauthenticated loopback client was not closed')); }, 3000);
      socket.on('data', () => { clearTimeout(timer); socket.destroy(); reject(new Error('Unauthenticated client received a response')); });
      socket.once('connect', () => socket.write(chromeFrame({ jsonrpc: '2.0', id: 1, method: 'host/browser' })));
      socket.once('error', reject); socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
    record('the Windows loopback relay refuses an unauthenticated client');
    service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory, artifactDirectory: join(profile, 'artifacts'), reportDiagnostic: value => diagnostics.push(value) });
    const call = (task, kind, fields = {}) => service.execute(task, instance.id, kind, fields, {});
    const value = result => result.structuredContent.value;
    const a = value(await call('A', 'new_tab', { url: origin })), b = value(await call('B', 'new_tab', { url: origin }));
    assert.notEqual(a.tabId, b.tabId);
    await assert.rejects(() => call('A', 'eval', { tabId: b.tabId, expression: 'document.title' }));
    await call('A', 'type', { selector: '#value', text: '人工 agent', clear: true }); await call('A', 'click', { selector: '#run' });
    assert.equal(value(await call('A', 'eval', { expression: 'document.querySelector("#value").value+":"+document.body.dataset.clicked' })), '人工 agent:yes');
    assert.equal(value(await call('B', 'eval', { expression: 'document.querySelector("#value").value' })), 'before');
    assert.equal(value(await call('A', 'eval', { expression: 'JSON.stringify([typeof require,typeof process,typeof module,typeof Buffer,typeof ipcRenderer,typeof window.klaus,typeof window.__KLAUS_DESKTOP__])' })), JSON.stringify(Array(7).fill('undefined')));
    const screenshot = await call('A', 'screenshot');
    assert(screenshot.content.some(item => item.type === 'image' && item.data.length > 100)); assert.equal(screenshot._meta['klaus/toolSurface'].backend, 'chrome');
    record('task ownership, real page input, isolated globals and screenshot work through the packaged extension');
    const download = value(await call('A', 'download', { url: `${origin}/download`, timeoutMs: 15000 }));
    assert.equal(readFileSync(download.path, 'utf8'), 'Windows packaged Chrome download');
    record('task-owned download returns the actual Windows file');
    service.releaseSession('A'); await until(async () => value(await call('B', 'eval', { expression: 'document.title' })) === 'Windows package page');
    await service.shutdown(); service = undefined; relay.close(); relay = undefined;
    await closeBrowser(); await until(() => existsSync(discoveryDirectory) && readdirSync(discoveryDirectory).length === 0);
    await until(() => { try { process.kill(nativePid, 0); return false; } catch { return true; } });
    assert.deepEqual(diagnostics, []);
    record('task shutdown and normal Chrome close remove the native process and discovery file');
  } catch (error) { failure = error; console.error(error); }
  finally {
    try {
      if (service) await service.shutdown(); if (relay) relay.close();
      if (browser && browser.exitCode === null && browser.signalCode === null) {
        try { await closeBrowser(); }
        catch { execFileSync('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await browserExit; }
      }
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (ownedRegistry) {
        const after = restoreRegistry();
        record('temporary registry keys are removed and the original absent state is restored', after);
      }
    } catch (error) { failure = failure ? new AggregateError([failure, error], 'Fixture and cleanup failed') : error; console.error(error); }
    writeFileSync(reportPath, `${JSON.stringify({ platform: process.platform, electronVersion: process.versions.electron, passed: checks.length, failed: failure ? 1 : 0, checks, diagnostics, error: failure ? String(failure.stack ?? failure) : null, chromeLog }, null, 2)}\n`);
    console.log(`windows-chrome-package: ${checks.length} passed, ${failure ? 1 : 0} failed`);
    process.exitCode = failure ? 1 : 0;
  }
})();
