// Runs with the packaged Electron executable in Node mode, never with system Node.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const [resources, profile] = process.argv.slice(2);
if (!resources || !profile || !process.versions.electron) throw new Error('Run through scripts/smoke-package.mjs');
const started = performance.now();
const progress = stage => console.error(JSON.stringify({ stage, elapsedMs: Math.round(performance.now() - started) }));
void (async () => {
  progress('node-entry');
  const appRoot = join(resources, 'app.asar');
  const fromApp = createRequire(join(appRoot, 'package.json'));
  const { resolveDesktopPaths } = fromApp('./dist/main/app/paths');
  const paths = resolveDesktopPaths({ appRoot, resourcesPath: resources, packaged: true });
  assert.equal(fromApp('./dist/main/paths').resourceRoot(), resources);
  const { loadNativeAddon } = fromApp('./dist/main/native/binding');
  const addon = loadNativeAddon(paths.nativeAddonPath);
  progress('addon-loaded');
  assert.equal(addon.abiVersion(), 1); assert.equal(addon.processId(), process.pid);
  const binding = new addon.NativeHost();
  mkdirSync(join(profile, 'native-search'), { recursive: true });
  writeFileSync(join(profile, 'native-search/package-smoke.txt'), 'A disposable packaged native fixture.');
  const result = await binding.search({ operationId: 'package-native-search', root: join(profile, 'native-search'), query: 'package-smoke', limit: 10, deadlineMs: 3000 });
  assert(result.hits.some(hit => hit.rel === 'package-smoke.txt'));
  progress('native-search');
  assert.equal((await binding.shutdown(3000)).complete, true);
  progress('native-shutdown');
  const { ChromeSetup } = fromApp('./dist/main/browser/chrome-setup');
  const chromeRoot = join(profile, 'isolated-chrome'); mkdirSync(chromeRoot);
  const setup = new ChromeSetup({ configRoot: profile, extensionRoot: paths.chromeExtensionRoot, enabled: () => true,
    browserDataRoots: [chromeRoot], executable: process.execPath, hostScript: paths.chromeHostScript,
    discoveryDirectory: join(profile, 'relay'),
    // Registry installation belongs to the separate Windows platform suite.
    registerWindowsHost: async () => { throw new Error('The local package probe does not modify Windows registry hosts'); },
  });
  const installed = process.platform === 'win32' ? null : await setup.install();
  if (installed) assert.equal(installed.ok, true);
  progress('chrome-host-installed');
  let speechProbe, recordingProbe, recordingClosedHost;
  if (process.platform === 'darwin') {
    const result = spawnSync(paths.speechHelperPath, ['--probe'], { encoding: 'utf8', timeout: 10000 });
    progress('speech-probe-returned');
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    speechProbe = JSON.parse(result.stdout.trim());
    assert.equal(speechProbe.type, 'capabilities'); assert.equal(speechProbe.sampleRate, 16000);
    assert.equal(speechProbe.channels, 1); assert.equal(speechProbe.format, 's16le');
    const recording = spawnSync(paths.recordingHelperPath, ['--capabilities'], { encoding: 'utf8', timeout: 10000 });
    progress('recording-probe-returned');
    if (recording.error) throw recording.error;
    assert.equal(recording.status, 0, recording.stderr);
    recordingProbe = JSON.parse(recording.stdout.trim());
    assert.equal(recordingProbe.version, 1); assert.equal(recordingProbe.supported, true);
    assert.equal(typeof recordingProbe.permissions?.accessibility, 'boolean');
    assert.equal(typeof recordingProbe.permissions?.inputMonitoring, 'boolean');
    // No start command is sent: this verifies pipe ownership without capturing
    // user input, requesting permission, or creating an event tap.
    const closedHost = spawnSync(paths.recordingHelperPath, [], { input: '', encoding: 'utf8', timeout: 10000 });
    progress('recording-close-returned');
    if (closedHost.error) throw closedHost.error;
    assert.equal(closedHost.status, 2); assert.match(closedHost.stderr, /host-input-closed/);
    recordingClosedHost = { exitCode: closedHost.status, error: closedHost.stderr.trim() };
  }
  console.log(JSON.stringify({ electronVersion: process.versions.electron, nodeVersion: process.versions.node, nativeInProcess: true,
    nativeSearch: true, nativeShutdown: true, paths, installed, speechProbe, recordingProbe, recordingClosedHost, windowsRegistryVerified: false }));
})().catch(error => { console.error(error); process.exitCode = 1; });
