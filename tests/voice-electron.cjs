const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('node:http');
const { app, BrowserWindow, ipcMain, protocol, systemPreferences } = require('electron');
const { VoiceService } = require('../dist/main/services/voice/service');
const { registerVoiceHandlers } = require('../dist/main/ipc/handlers/voice');
const { ChannelRegistry } = require('../dist/main/ipc/registry');
const { RoleTable } = require('../dist/main/ipc/contract');
const { IpcRouter } = require('../dist/main/ipc/router');
const { handleCoreInvoke, HOST_CHANNELS } = require('../dist/main/ipc/binding');
const { kvSet } = require('../dist/main/services/settings');
const root = process.env.KLAUS_VOICE_TEST_ROOT;
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('klaus-voice-electron-')) throw new Error('An isolated voice fixture profile is required');
app.setPath('userData', path.join(root, 'electron'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const results = []; let service, window, cloudServer;
async function test(name, run) {
  try { await run(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`  FAIL ${name}\n${error.stack}`); }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => window.webContents.executeJavaScript(code);
async function until(code, timeout = 8000) {
  const end = Date.now() + timeout;
  do { if (await js(code)) return; await sleep(20); } while (Date.now() < end);
  throw new Error(`Renderer condition timed out: ${code}`);
}
async function run() {
  await app.whenReady(); app.dock?.hide();
  protocol.handle('klaus-app', request => {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/fixture.js') return new Response(fs.readFileSync(path.join(root, 'renderer.js')), { headers: { 'Content-Type': 'text/javascript' } });
    if (pathname === '/fixture.css') return new Response(fs.readFileSync(path.join(root, 'renderer.css')), { headers: { 'Content-Type': 'text/css' } });
    if (pathname === '/js/voice-capture-worklet.js') return new Response(fs.readFileSync(path.resolve('frontend/public/js/voice-capture-worklet.js')), { headers: { 'Content-Type': 'text/javascript' } });
    if (pathname === '/production.css') return new Response(fs.readFileSync(path.resolve('frontend/css/styles.css')), { headers: { 'Content-Type': 'text/css' } });
    const source = fs.readFileSync(path.resolve('frontend/index.html'), 'utf8');
    const shell = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
    return new Response(shell.replace('</head>', '<link rel="stylesheet" href="/production.css"><link rel="stylesheet" href="/fixture.css"></head>').replace('</body>', '<script src="/fixture.js"></script></body>'), { headers: { 'Content-Type': 'text/html' } });
  });
  let blockPolish = false, polishEntered = false, releasePolish;
  let rejectFull = false, partialRequests = 0, finalRequests = 0;
  const evidence = path.resolve('dist/voice-live-fix-logs'); fs.mkdirSync(evidence, { recursive: true });
  const pendingPolish = new Promise(resolve => { releasePolish = resolve; });
  const audio = []; let audioActive = 0, stoppedWithPending = false;
  service = new VoiceService({ configRoot: path.join(root, 'klaus'), listModels: async () => [],
    completeText: async () => { if (blockPolish) { polishEntered = true; await pendingPolish; } throw new Error('fixture-no-refinement'); },
    readModelCredential: async () => null, micPermission: async () => ({ ok: true, status: 'synthetic-fixture' }),
    speechCommand: { executable: process.execPath, args: [path.resolve('tests/fixtures/speech-helper.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    deliver: async (id, channel, event) => {
      assert.equal(id, window.webContents.id); window.webContents.send(`ipc:${channel}`, { args: [event] });
      await js(`window.voiceFixture.received(${event.seq})`);
    } });
  const actualTranscribe = service.transcribe.bind(service);
  service.transcribe = async (owner, payload) => {
    if (payload.partial) partialRequests++; else if (!payload.segmentIds) finalRequests++;
    if (rejectFull && !payload.partial && !payload.segmentIds) return { ok: false, error: 'VOICE_HTTP_503' };
    return actualTranscribe(owner, payload);
  };
  const registry = new ChannelRegistry(); registerVoiceHandlers(registry, service);
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.windowOp, () => ({ ok: true, value: false }));
  ipcMain.handle(HOST_CHANNELS.coreInvoke, async (event, payload) => {
    const request = payload.args;
    const isAudio = request?.channel === 'voice:session:audio';
    if (isAudio) { audioActive++; audio.push(Buffer.from(request.args[0].data.__klausBinary, 'base64')); }
    if (request?.channel === 'voice:session:stop' && audioActive) stoppedWithPending = true;
    try { return await handleCoreInvoke({ roleOf: id => id === window.webContents.id ? 'main' : undefined,
      route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => false }, event, payload.command, payload.args); }
    finally { if (isAudio) audioActive--; }
  });
  window = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { preload: path.resolve('dist/preload/main.js'), sandbox: true,
    contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, additionalArguments: ['--klaus-role=main'] } });
  service.attachOwner(window.webContents.id);
  await window.loadURL('klaus-app://app/index.html'); await until('!!window.voiceFixture');
  await test('normal Electron reads actual OS microphone status without requesting or recording', async () => {
    assert.notEqual(process.env.ELECTRON_RUN_AS_NODE, '1'); assert.ok(process.versions.electron);
    const status = systemPreferences.getMediaAccessStatus('microphone');
    assert.ok(['not-determined', 'granted', 'denied', 'restricted', 'unknown'].includes(status));
    console.log(`microphone-status=${status}`);
  });
  await test('production voice UI, bridge, sandboxed preload and AudioWorklet deliver a synthetic utterance with its tail', async () => {
    await js('window.voiceFixture.click()'); await until('window.voiceFixture.state() === "recording"');
    await sleep(445); await js('window.voiceFixture.click()'); await until('window.voiceFixture.inserted.length === 1');
    const data = Buffer.concat(audio);
    assert.ok(data.length > 3200); assert.ok(audio.at(-1).length <= 3200); assert.equal(stoppedWithPending, false);
    assert.equal(await js('window.voiceFixture.inserted[0]'), `pcm:${data.length}:${crypto.createHash('sha256').update(data).digest('hex')}`);
    assert.equal(await js('window.voiceFixture.trackState()'), 'ended'); assert.deepEqual(await js('window.voiceFixture.alerts'), []);
  });
  await test('Escape during late polish prevents a final composer insertion and history write', async () => {
    await sleep(50); blockPolish = true;
    await js('window.voiceFixture.click()'); await until('window.voiceFixture.state() === "recording"');
    await sleep(150); await js('window.voiceFixture.click()');
    const end = Date.now() + 5000; while (!polishEntered && Date.now() < end) await sleep(20);
    assert.equal(polishEntered, true);
    const recordedDuration = await js('window.voiceFixture.surface().timer');
    await sleep(1100);
    assert.equal(await js('window.voiceFixture.surface().timer'), recordedDuration, 'recording duration must freeze while final text is pending');
    assert.equal(await js('window.voiceFixture.state()'), 'transcribing');
    await js('window.voiceFixture.cancel()'); await sleep(50); releasePolish();
    await until('window.voiceFixture.state() === "idle"'); await sleep(100);
    assert.equal(await js('window.voiceFixture.inserted.length'), 1); assert.equal(service.store.history(100).length, 1);
  });
  await test('cancelled permission/capture startup stops a late MediaStream instead of starting a helper', async () => {
    await js('window.voiceFixture.delay(); window.voiceFixture.click()'); await until('window.voiceFixture.pendingStream()');
    await js('window.voiceFixture.cancel()'); await until('window.voiceFixture.state() === "idle"');
    await js('window.voiceFixture.release()'); await until('window.voiceFixture.trackState() === "ended"');
    assert.equal(await js('window.voiceFixture.inserted.length'), 1);
  });
  let holdCloud = false, cloudEntered = false, cloudAborted = false, cloudBody;
  const cloudRequests = [];
  cloudServer = createServer((request, response) => {
    const chunks = []; request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      cloudBody = Buffer.concat(chunks); cloudEntered = true;
      cloudRequests.push(cloudBody);
      if (holdCloud) { response.once('close', () => { cloudAborted = true; }); return; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ text: 'Recorded cloud fixture.' }));
    });
  });
  await new Promise(resolve => cloudServer.listen(0, '127.0.0.1', resolve));
  kvSet('voice.transcribe.apiKey', 'isolated-cloud-fixture', path.join(root, 'klaus'));
  kvSet('voice.transcribe.baseUrl', `http://127.0.0.1:${cloudServer.address().port}/v1`, path.join(root, 'klaus'));
  kvSet('voice.input.source', 'custom', path.join(root, 'klaus'));
  await test('the cloud dictation pipeline sends a recorded synthetic utterance through the production bridge', async () => {
    await js('window.voiceFixture.click()'); await until('window.voiceFixture.state() === "recording"');
    await sleep(160); await js('window.voiceFixture.click()'); await until('window.voiceFixture.inserted.length === 2');
    assert.equal(await js('window.voiceFixture.inserted[1]'), 'Recorded cloud fixture.');
    // The custom wire accepts the compact container: the platform Opus encoder
    // must have produced a real Ogg file, not the WAV fallback.
    assert.ok(cloudBody.length > 100); assert.ok(cloudBody.includes(Buffer.from('audio/webm')));
    assert.ok(cloudBody.includes(Buffer.from('name="file"'))); assert.ok(cloudBody.includes(Buffer.from('voice.webm')));
    assert.ok(cloudBody.includes(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
    assert.equal(await js('window.voiceFixture.trackState()'), 'ended');
  });
  await test('continuous and segment WebM audio decode with real platform codecs', async () => {
    const codec = await js('window.voiceFixture.codecRoundtrip()');
    fs.writeFileSync(path.join(evidence, 'codec-roundtrip.json'), JSON.stringify(codec, null, 2));
    assert.ok(codec.bytes < 20000 && codec.bytes > 5000);
    assert.ok(Math.abs(codec.duration - 3) < 0.05);
    assert.ok(Math.abs(codec.segmentDuration - 2) < 0.05);
    assert.ok(codec.rms > 0.20 && codec.rms < 0.32);
  });
  for (const target of ['main', 'side', 'plan']) await test(`live text is visibly rendered before stop in the ${target} composer`, async () => {
    const count = await js('window.voiceFixture.inserted.length'), before = partialRequests;
    await js(`window.voiceFixture.target(${JSON.stringify(target)}); window.voiceFixture.click()`);
    await until('window.voiceFixture.state() === "recording"');
    await until('window.voiceFixture.surface().text.includes("Recorded cloud fixture.")', 6500);
    const surface = await js('window.voiceFixture.surface()');
    assert.equal(surface.visible, true, JSON.stringify(surface));
    assert.notEqual(surface.timer, '0:00');
    assert.equal(await js('window.voiceFixture.state()'), 'recording');
    assert.equal(await js('window.voiceFixture.inserted.length'), count);
    assert.equal(partialRequests - before, 1);
    if (target !== 'main') assert.equal(surface.mainHidden, true);
    fs.writeFileSync(path.join(evidence, `live-${target}.json`), JSON.stringify(surface, null, 2));
    fs.writeFileSync(path.join(evidence, `live-${target}.png`), (await window.webContents.capturePage()).toPNG());
    await js('window.voiceFixture.click()'); await until(`window.voiceFixture.inserted.length === ${count + 1}`);
    await until('window.voiceFixture.state() === "idle"');
  });
  await test('a failed full pass recovers every segment including the tail and writes history once', async () => {
    await js('window.voiceFixture.target("main")');
    const count = await js('window.voiceFixture.inserted.length'), history = service.store.history(100).length;
    await js('window.voiceFixture.click()'); await until('window.voiceFixture.state() === "recording"');
    await until('window.voiceFixture.surface().text.includes("Recorded cloud fixture.")', 6500);
    await sleep(250); rejectFull = true;
    await js('window.voiceFixture.click()'); await until(`window.voiceFixture.inserted.length === ${count + 1}`);
    rejectFull = false;
    assert.equal(await js(`window.voiceFixture.inserted[${count}]`), 'Recorded cloud fixture. Recorded cloud fixture.');
    assert.equal(service.store.history(100).length, history + 1);
    await until('window.voiceFixture.state() === "idle"');
  });
  await test('Escape cancels an in-flight real cloud HTTP request without inserting its late result', async () => {
    const insertCount = await js('window.voiceFixture.inserted.length');
    holdCloud = true; cloudEntered = false;
    await js('window.voiceFixture.click()'); await until('window.voiceFixture.state() === "recording"');
    await sleep(160); await js('window.voiceFixture.click()');
    const end = Date.now() + 5000; while (!cloudEntered && Date.now() < end) await sleep(20);
    assert.equal(cloudEntered, true); await js('window.voiceFixture.cancel()'); await until('window.voiceFixture.state() === "idle"');
    assert.equal(cloudAborted, true); assert.equal(await js('window.voiceFixture.inserted.length'), insertCount);
  });
  await js('window.voiceFixture.close()');
  assert.equal((await service.shutdown()).complete, true);
}
const watchdog = setTimeout(() => { console.error('voice-electron timed out'); app.exit(1); }, 45_000);
run().catch(error => { console.error(error); results.push({ name: 'setup', ok: false, error: error.stack }); }).finally(async () => {
  if (service) await service.shutdown(5000);
  if (cloudServer) { cloudServer.closeAllConnections(); await new Promise(resolve => cloudServer.close(resolve)); }
  window?.destroy(); clearTimeout(watchdog);
  const failed = results.filter(row => !row.ok).length;
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ platform: process.platform, results }, null, 2));
  console.log(`voice-electron: ${results.length - failed} passed, ${failed} failed`); app.exit(failed ? 1 : 0);
});
