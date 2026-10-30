#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyTestPackage } from '../packaging/verify-test-package.mjs';
import { launchPackage, until } from '../packaging/fixture.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' }, receipt: { type: 'string' } } });
if (positionals.length !== 1) throw new Error('Usage: npm run package:smoke -- <Klaus.app or Windows package> [--receipt signed.receipt.json] [--output report.json]');
const report = await verifyTestPackage(positionals[0], { receipt: values.receipt });
assert.equal(report.target, `${process.platform}-${process.arch}`, 'smoke must run on the packaged target');
const output = resolve(values.output ?? `${positionals[0]}.smoke.json`);
// Unix domain socket paths are capped at 103 bytes on macOS. Keep the isolated
// native-host fixture below /tmp rather than the long per-user temporary path.
const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'kps-'));
let runtime;
const checks = [];
const devtoolsPolicy = JSON.parse(readFileSync(new URL('../contracts/vectors/packaged-devtools-vectors.json', import.meta.url), 'utf8')).packaged;
const record = (name, detail = true) => { checks.push({ name, detail }); console.log(`ok ${name}`); };
const server = createServer((request, response) => {
  if (request.url === '/fixture') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Packaged browser fixture</title><input id="value" value="same-page"><button onclick="document.body.dataset.clicked=\'yes\'">Run</button>'); }
  else { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{"error":"Local package fixture has no account or OAuth endpoint"}'); }
});
try {
  const native = spawnSync(report.executable, [fileURLToPath(new URL('../packaging/native-smoke.cjs', import.meta.url)), report.resources, root], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000,
  });
  writeFileSync(`${output}.native.log`, native.stderr ?? '');
  if (native.error) {
    if (native.stdout) process.stdout.write(native.stdout);
    if (native.stderr) process.stderr.write(native.stderr);
    throw native.error;
  }
  assert.equal(native.status, 0, native.stderr);
  const nativeResult = JSON.parse(native.stdout.trim().split('\n').at(-1));
  record('packaged Node mode loads app.asar and the production addon in this process', nativeResult);
  if (process.platform === 'darwin') {
    const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(report.bundle, 'Contents/Info.plist')], { encoding: 'utf8' }));
    assert(plist.NSMicrophoneUsageDescription?.length > 0); assert(plist.NSSpeechRecognitionUsageDescription?.length > 0);
    assert(plist.NSPhotoLibraryUsageDescription?.length > 0); assert(plist.NSLocationUsageDescription?.length > 0);
    assert.equal(nativeResult.speechProbe?.type, 'capabilities');
    record('packaged speech helper probes without requesting access and the app declares voice purposes', nativeResult.speechProbe);
    assert.equal(nativeResult.recordingProbe?.version, 1);
    record('packaged recording helper reads capabilities without starting capture or prompting', nativeResult.recordingProbe);
    assert.equal(nativeResult.recordingClosedHost?.exitCode, 2);
    record('packaged recording helper exits when the owning input pipe closes', nativeResult.recordingClosedHost);
  }

  const helper = spawn(nativeResult.installed?.hostPath ?? report.executable,
    nativeResult.installed ? [] : [nativeResult.paths.chromeHostScript, '--discovery-directory', join(root, 'relay')],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let received = Buffer.alloc(0), helperError = '';
  helper.stdout.on('data', chunk => { received = Buffer.concat([received, chunk]); });
  helper.stderr.on('data', chunk => { helperError += chunk; });
  const helperExited = new Promise((resolveExit, reject) => { helper.once('error', reject); helper.once('exit', (code, signal) => resolveExit({ code, signal })); });
  try {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    helper.stdin.write(Buffer.concat([header, body]));
    await until(() => {
      if (helper.exitCode !== null || helper.signalCode !== null) throw new Error(`Packaged native host exited before replying: ${helperError}`);
      return received.length >= 4 && received.length >= received.readUInt32LE(0) + 4;
    }, 10000, 'the actual packaged native messaging reply');
    const value = JSON.parse(received.subarray(4, 4 + received.readUInt32LE(0)).toString());
    assert.deepEqual(value, { jsonrpc: '2.0', id: 1, result: 'pong' });
    helper.stdin.end();
    const closed = await helperExited; assert.equal(closed.code, 0, helperError);
    assert.equal(readdirSync(join(root, 'relay')).length, 0, 'native host removed its discovery endpoint');
    record('packaged native messaging launcher replies and removes its endpoint');
  } finally { if (helper.exitCode === null && helper.signalCode === null) { helper.kill('SIGTERM'); await helperExited; } }

  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  runtime = await launchPackage(report.bundle, join(root, 'app'), { serverUrl: origin, logPath: `${output}.log` });
  const metadata = await runtime.inspector.evaluate(`({ packaged: __packageElectron.app.isPackaged, appPath: __packageElectron.app.getAppPath(), resourcesPath: process.resourcesPath, paths: __packageRequire('./dist/main/paths').resourceRoot() })`);
  assert.equal(metadata.packaged, true); assert.equal(metadata.paths, report.resources);
  assert.equal(metadata.appPath, join(report.resources, 'app.asar'));
  assert.deepEqual(await runtime.page(`({ require: typeof window.require, process: typeof window.process, module: typeof window.module, Buffer: typeof window.Buffer })`), { require: 'undefined', process: 'undefined', module: 'undefined', Buffer: 'undefined' });
  record('the untouched production entry opens the packaged frontend with an isolated preload', metadata);
  const devtools = await runtime.inspector.evaluate(`(async () => {
    const window = __packageElectron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html'));
    if (!window) throw new Error('Packaged main window was not found');
    window.webContents.openDevTools({ mode: 'detach' });
    await new Promise(resolve => setTimeout(resolve, 300));
    const roles = items => items.flatMap(item => [item.role, ...(item.submenu ? roles(item.submenu.items) : [])]).filter(Boolean);
    const menu = __packageElectron.Menu.getApplicationMenu();
    return { opened: window.webContents.isDevToolsOpened(), roles: menu ? roles(menu.items) : [] };
  })()`);
  assert.equal(devtools.opened, devtoolsPolicy.opened);
  assert(!devtools.roles.some(role => devtoolsPolicy.forbiddenMenuRoles.includes(role)), JSON.stringify(devtools.roles));
  record('packaged main renderer blocks DevTools and the native menu omits development actions', devtools);
  const picture = join(root, 'app/workspace/package-preview.png');
  writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaLjwHwAEpAJw/IFNkwAAAABJRU5ErkJggg==', 'base64'));
  await runtime.invoke('settings:kv:set', { key: 'auth_mode', value: 'custom' });
  await runtime.invoke('settings:models:upsert', { id: 'package-fixture', name: 'Local package fixture', provider: 'anthropic',
    model: 'fixture-model', baseUrl: origin, apiKey: 'local-package-fixture', isDefault: true });
  await runtime.invoke('settings:kv:set', { key: 'composer.main_model', value: 'custom:package-fixture' });
  const workspace = await runtime.invoke('workspaces:save', { name: 'Local package verification', roots: [join(root, 'app/workspace')] });
  const session = await runtime.invoke('session:new', { workspaceId: workspace.id });
  const media = await runtime.invoke('artifacts:file-url', { sessionId: session.id, filePath: picture });
  const range = await runtime.page(`fetch(${JSON.stringify(media.url)}, {headers:{Range:'bytes=0-7'}}).then(async response => ({status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))}))`);
  assert.equal(range.status, 206); assert.deepEqual(range.bytes, [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await runtime.invoke('artifacts:open-window', { sessionId: session.id, filePath: picture })).ok, true);
  const previewExpression = `__packageElectron.BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('artifact.html'))`;
  await until(() => runtime.inspector.evaluate(`(async () => { const window = ${previewExpression}; return window && window.webContents.executeJavaScript("Boolean(document.querySelector('#aw-body img')?.naturalWidth)"); })()`), 10000, 'the packaged restricted media preview');
  assert.equal(await runtime.inspector.evaluate(`${previewExpression}.webContents.executeJavaScript('typeof window.klaus.chat')`), 'undefined');
  assert.equal(await runtime.inspector.evaluate(`(async () => {
    const contents = ${previewExpression}.webContents;
    contents.openDevTools({ mode: 'detach' });
    await new Promise(resolve => setTimeout(resolve, 300));
    return contents.isDevToolsOpened();
  })()`), devtoolsPolicy.opened);
  await runtime.inspector.evaluate(`${previewExpression}.destroy()`);
  record('packaged artifact frontend renders owned media through the range-capable private protocol');
  const enabled = await runtime.invoke('settings:browser-use:set-enabled', { enabled: true });
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  await runtime.invoke('browser-use:set-conversation', { conversationId: 'package-smoke' });
  const navigated = await runtime.invoke('browser-use:navigate', { url: `${origin}/fixture` });
  assert.equal(navigated.ok, true, JSON.stringify(navigated));
  const browserExpression = `__packageElectron.webContents.getAllWebContents().find(contents => contents.getURL() === ${JSON.stringify(`${origin}/fixture`)})`;
  await until(() => runtime.inspector.evaluate(`Boolean(${browserExpression})`), 10000, 'the actual WebContentsView page');
  const browser = await runtime.inspector.evaluate(`(async () => { const contents = ${browserExpression}; const prefs = contents.getLastWebPreferences(); const result = await contents.debugger.sendCommand('Runtime.evaluate', { expression: "document.getElementById('value').value='packaged-agent'; document.querySelector('button').click(); document.body.dataset.clicked", returnByValue: true }); return { id: contents.id, sandbox: prefs.sandbox, isolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, value: result.result.value }; })()`);
  assert.equal(browser.sandbox, true); assert.equal(browser.isolation, true); assert.equal(browser.nodeIntegration, false); assert.equal(browser.value, 'yes');
  const screenshot = await runtime.invoke('browser-use:screenshot', {});
  assert.equal(screenshot.ok, true); assert.match(screenshot.dataUrl, /^data:image\//);
  record('packaged WebContentsView loads a real page and CDP edits that same sandboxed page', browser);
  const snapshot = await runtime.snapshot();
  const engines = snapshot.processes.filter(row => /klaus-agent-stdio(?:\.exe)?$/.test(row.executable));
  assert.equal(engines.length, 1, JSON.stringify(snapshot.processes));
  assert.equal(engines[0].executable, join(report.resources, 'bin', report.target, process.platform === 'win32' ? 'klaus-agent-stdio.exe' : 'klaus-agent-stdio'));
  record('one packaged Rust engine belongs to the Electron process', engines);
  const timings = { hostReadyMs: runtime.hostReadyMs, frontendReadyMs: runtime.frontendReadyMs };
  const closed = await runtime.stop(); runtime = undefined;
  assert.equal(closed.code, 0, closed.stderr);
  const logs = readFileSync(join(root, 'app/electron-host.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert(!logs.some(entry => ['preload-error', 'renderer-gone', 'shutdown-error'].includes(entry.kind)), JSON.stringify(logs));
  assert(logs.some(entry => entry.kind === 'native-shutdown' && JSON.parse(entry.detail).complete === true));
  record('normal application shutdown drains native resources and leaves no children');
  writeFileSync(output, `${JSON.stringify({ package: report, checks, timings, shutdown: closed, processSnapshot: snapshot, scope: 'Package smoke with dummy local model configuration; package.verification records signed or unsigned evidence. No user credentials, live grants, signing operation or installed-update test.' }, null, 2)}\n`);
  console.log(`packaged-smoke: ${checks.length} passed, 0 failed`);
  console.log(`Report: ${output}`);
} finally {
  try { if (runtime) await runtime.stop(); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); rmSync(root, { recursive: true, force: true }); }
}
