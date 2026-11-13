// Opt-in live-service verification with synthetic speech, the production bridge,
// actual worklet capture and the production structured composer. No physical mic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
const { AppServerClient } = require('../dist/main/engine/client');
const { voiceModelAccess } = require('../dist/main/app/voice-runtime');
const { VoiceService } = require('../dist/main/services/voice/service');
const { registerVoiceHandlers } = require('../dist/main/ipc/handlers/voice');
const { ChannelRegistry } = require('../dist/main/ipc/registry');
const { IpcRouter } = require('../dist/main/ipc/router');
const { RoleTable } = require('../dist/main/ipc/contract');
const { HOST_CHANNELS, handleCoreInvoke } = require('../dist/main/ipc/binding');
const { kvSet } = require('../dist/main/services/settings');
const { EngineSettings } = require('../dist/main/services/engine-settings');

const root = process.env.KLAUS_VOICE_LIVE_ROOT;
const engineBinary = process.env.KLAUS_VOICE_LIVE_ENGINE;
const accountRoot = process.env.KLAUS_VOICE_LIVE_ACCOUNT;
const speech = process.env.KLAUS_VOICE_LIVE_PCM;
const output = process.env.KLAUS_VOICE_LIVE_OUTPUT;
const source = process.env.KLAUS_VOICE_LIVE_SOURCE;
const refinement = process.env.KLAUS_VOICE_LIVE_REFINEMENT === '1';
if (!['antigravity', 'qoder', 'qwenwork'].includes(source)) throw new Error('An explicit streaming source is required');
if (![root, engineBinary, accountRoot, speech, output].every(value => value && path.isAbsolute(value))) throw new Error('Explicit isolated profile, engine, account, synthetic speech and output paths are required');
app.setPath('userData', path.join(root, 'electron'));
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'klaus-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let child, client, service, window;
const report = { fixture: 'synthetic speech through production PCM capture and editor; real engine and provider', rpcCounts: {}, refinement, stages: [] };
const epoch = performance.now();
const stage = (name, details = {}) => report.stages.push({ name, atMs: Math.round(performance.now() - epoch), ...details });
const watchdog = setTimeout(() => { console.error('live-voice verification timed out'); app.exit(1); }, 110000);
const js = code => window.webContents.executeJavaScript(code);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(code, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!await js(code)) { if (Date.now() >= deadline) throw new Error(`Timed out: ${code}`); await sleep(20); }
}
(async () => {
  await app.whenReady(); app.dock?.hide(); fs.mkdirSync(output, { recursive: true });
  const env = { ...process.env, KLAUS_CONFIG_DIR: accountRoot, KLAUS_SESSION_DIR: path.join(root, 'sessions'), KLAUS_PLUGIN_HOME: path.join(root, 'plugins') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KLAUS_AGENT_CONFIG_JSON', 'KLAUS_MODEL', 'KLAUS_PROVIDER']) delete env[key];
  child = spawn(engineBinary, ['--app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  client = new AppServerClient(child.stdin, 'live-dictation-verification');
  child.stdout.on('data', data => client.feedStdout(data));
  child.stdout.on('end', () => client.endStdout());
  let stderr = '';
  child.stderr.on('data', data => {
    stderr += data.toString('utf8');
    const lines = stderr.split('\n'); stderr = lines.pop() || '';
    for (const line of lines) if (line.startsWith('[dictation-transport]')) (report.transportDiagnostics ??= []).push(line.slice(0, 512));
  });
  const request = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, ...args) => {
    report.rpcCounts[method] = (report.rpcCounts[method] || 0) + 1;
    const startedAt = performance.now();
    if (method === 'engine/dictationEnd') stage('engine_end_requested', { cancel: args[0]?.cancel === true });
    if (method === 'engine/completeText') { stage('text_completion_requested', { source: args[0]?.source, modelId: args[0]?.modelId }); (report.textTargets ??= []).push({ source: args[0]?.source, modelId: args[0]?.modelId }); }
    let result;
    try { result = await request(method, ...args); }
    catch (error) {
      const message = error?.message || String(error);
      (report.rpcFailures ??= []).push({ method, code: message.match(/(?:qwenwork|qoder|antigravity|dictation)[a-z_-]+/i)?.[0] || 'request-failed' });
      throw error;
    }
    if (method === 'engine/dictationEnd') stage('engine_end_acknowledged', { elapsedMs: Math.round(performance.now() - startedAt) });
    if (method === 'engine/dictationStart') report.accountGenerationBound = typeof result?.credentialGeneration === 'string' && result.credentialGeneration.length > 0;
    return result;
  };
  const initialized = await client.requestWithTimeout('initialize', { clientInfo: { name: 'live-dictation-verification', version: '1' } }, 30000);
  client.captureInitializeResult(initialized);
  const invoke = (method, params) => client.requestWithTimeout(method, params, 450000);
  const settings = refinement ? new EngineSettings(invoke) : { providers: async () => ({}) };
  const models = voiceModelAccess(settings, invoke, accountRoot, () => ({ generation: 1, client }));
  if (!refinement) models.completeText = undefined;
  const listModels = models.listModels.bind(models), credential = models.readModelCredential.bind(models), create = models.streaming.create.bind(models.streaming);
  let modelReads = 0;
  models.listModels = async signal => { modelReads++; stage('models_requested'); const result = await listModels(signal); stage('models_resolved', { count: result.length }); return result; };
  models.readModelCredential = async (id, signal) => { stage('credential_requested'); const result = await credential(id, signal); stage('credential_resolved', { available: !!result }); return result; };
  models.streaming.create = (id, provider, signal, onEvent, onFailure, options) => create(id, provider, signal, event => {
    if (event.type !== 'partial') stage('recognizer_' + event.type, { code: event.code, polished: event.polished, refinementComplete: event.refinementComplete });
    if (event.type === 'final') report.nativeFinal = { text: event.text, rawText: event.rawText, polished: event.polished, refinementComplete: event.refinementComplete };
    if (event.type === 'recognized') report.recognizedRaw = event.text;
    return onEvent(event);
  }, onFailure, options);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { stage('text_request_started'); try { const result = await nativeFetch(...args); stage('text_response_headers', { status: result.status }); return result; } catch (error) { stage('text_request_failed', { cancelled: args[1]?.signal?.aborted === true }); throw error; } };
  assert.equal(await models.streaming.available(source, new AbortController().signal), true, 'an actual streaming account is required');
  service = new VoiceService({ configRoot: path.join(root, 'voice'), platform: 'win32', ...models,
    micPermission: async () => ({ ok: true, status: 'synthetic-fixture' }),
    diagnostic: event => stage('host_' + event.stage, event),
    deliver: async (_owner, channel, payload) => {
      if (payload.type !== 'partial') stage('renderer_' + payload.type, { polished: payload.polished, refinementComplete: payload.refinementComplete, refinementSource: payload.refinementSource });
      if (payload.type === 'final') report.winner = { text: payload.text, rawText: payload.rawText, polished: payload.polished, refinementComplete: payload.refinementComplete, refinementSource: payload.refinementSource };
      window.webContents.send(`ipc:${channel}`, { args: [payload] }); await js(`window.voiceFixture.received(${payload.seq})`);
    },
  });
  kvSet('voice.input.source', source, path.join(root, 'voice'));
  const registry = new ChannelRegistry(); registerVoiceHandlers(registry, service);
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.windowOp, () => ({ ok: true, value: false }));
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload) => handleCoreInvoke({ roleOf: id => id === window.webContents.id ? 'main' : undefined, route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => false }, event, payload.command, payload.args));
  protocol.handle('klaus-app', request => {
    const url = new URL(request.url);
    const routes = {
      '/fixture.js': [path.join(root, 'renderer.js'), 'text/javascript'],
      '/fixture.css': [path.join(root, 'renderer.css'), 'text/css'],
      '/production.css': [path.resolve('frontend/css/styles.css'), 'text/css'],
      '/js/voice-capture-worklet.js': [path.resolve('frontend/public/js/voice-capture-worklet.js'), 'text/javascript'],
      '/speech.pcm': [speech, 'application/octet-stream'],
    };
    const route = routes[url.pathname];
    if (route) return new Response(fs.readFileSync(route[0]), { headers: { 'Content-Type': route[1] } });
    const source = fs.readFileSync(path.resolve('frontend/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
    return new Response(source.replace('</head>', '<link rel="stylesheet" href="/production.css"><link rel="stylesheet" href="/fixture.css"></head>').replace('</body>', '<script>window.__voiceFixtureLive=true</script><script src="/fixture.js"></script></body>'), { headers: { 'Content-Type': 'text/html' } });
  });
  window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { preload: path.resolve('dist/preload/main.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, additionalArguments: ['--klaus-role=main'] } });
  service.attachOwner(window.webContents.id);
  await window.loadURL('klaus-app://app/index.html'); await until('!!window.voiceFixture');
  const config = await service.config(window.webContents.id);
  report.source = config.source; report.systemAsr = config.systemAsr;
  assert.equal(config.source, source); assert.equal(config.systemAsr, false); assert.equal(config.streaming, true);
  const began = Date.now(); await js('window.voiceFixture.click()');
  await until('window.voiceFixture.events.some(event => event.type === "partial" && event.text?.trim() || event.type === "error" || event.code === "speech-recovering")');
  assert.equal(await js('window.voiceFixture.events.some(event => event.type === "partial" && event.text?.trim())'), true, 'the selected provider must deliver live text without degrading to file transcription');
  // Let the compositor present the transcript before measuring or capturing it.
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  report.firstVisibleMs = Date.now() - began;
  report.live = await js('window.voiceFixture.surface()');
  assert.equal(report.live.visible, true); assert.equal(await js('window.voiceFixture.state()'), 'recording');
  assert.equal(await js('window.voiceFixture.inserted.length'), 0);
  fs.writeFileSync(path.join(output, 'live-provider-preview.png'), (await window.webContents.capturePage()).toPNG());
  // Let the entire six-second utterance reach the microphone stream.
  const remaining = Math.max(7500, fs.statSync(speech).size / 32 + 2000) - (Date.now() - began); if (remaining > 0) await sleep(remaining);
  const stopped = Date.now(); stage('stop_clicked'); await js('window.voiceFixture.click()');
  await until('window.voiceFixture.inserted.length === 1', refinement ? 60000 : 10000);
  report.postStopMs = Date.now() - stopped;
  report.editor = await js('window.voiceFixture.composer.read()');
  report.partialSnapshots = await js('window.voiceFixture.events.length'); report.modelReads = modelReads;
  assert.equal(report.editor.installed, true);
  if (process.env.KLAUS_VOICE_LIVE_LANGUAGE === 'zh') {
    assert.match(report.editor.value, /实时语音输入/); assert.match(report.editor.value, /输入框/);
  } else {
    assert.match(report.editor.value, /live dictation test/i); assert.match(report.editor.value, /still speaking now/i);
  }
  assert.equal(report.editor.domText, report.editor.value);
  if (refinement) {
    assert.equal(report.winner?.refinementComplete, true, 'the winning route must produce complete refinement');
    assert.equal(report.winner?.polished, true, 'latency verification must preserve completed refinement rather than delivering raw text');
    assert.ok(['native', 'text-model'].includes(report.winner.refinementSource));
    assert.ok((report.rpcCounts['engine/completeText'] || 0) <= 1, 'at most one complete backup request is permitted');
    if (report.winner.refinementSource === 'text-model') assert.equal(report.rpcCounts['engine/completeText'], 1);
    assert.equal(report.modelReads, 0, 'text refinement must not discover custom API-key models');
    assert.equal(report.editor.value, report.winner.text);
    for (const value of [report.winner.rawText, report.winner.text]) {
      assert.match(value, /live dictation test/i);
      assert.match(value, /still speaking now/i);
      assert.match(value, /keep every sentence in the input box/i);
    }
  } else {
    assert.equal(report.modelReads, 0);
  }
  assert.equal(report.accountGenerationBound, true, 'retained audio recovery must stay bound to the account that opened dictation');
  assert.equal(report.rpcCounts[`${source}/transcribeAudio`] || 0, 0, 'healthy real-time capture must not use file transcription');
  assert.equal(Object.keys(report.rpcCounts).some(method => /^(antigravity|qoder|qwenwork)\//.test(method) && !method.startsWith(`${source}/`)), false, 'dictation must never discover or use a different provider');
  assert.ok(report.rpcCounts['engine/dictationAppendAudio'] > 20, 'audio must travel as live PCM frames');
  assert.equal(service.store.history(10).length, 1);
  await until('window.voiceFixture.state() === "idle" && !window.voiceFixture.surface().visible');
  await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  report.visiblePostStopMs = Date.now() - stopped;
  fs.writeFileSync(path.join(output, 'live-provider-final.png'), (await window.webContents.capturePage()).toPNG());
  report.passed = true;
  console.log(JSON.stringify({ source: report.source, systemAsr: report.systemAsr, firstVisibleMs: report.firstVisibleMs, postStopMs: report.postStopMs, editorText: report.editor.value, modelReads, streamingAudioCalls: report.rpcCounts['engine/dictationAppendAudio'] }));
})().catch(async error => {
  report.passed = false; report.error = error.stack;
  if (window && !window.isDestroyed()) report.failureState = await js('({state: window.voiceFixture?.state(), events: window.voiceFixture?.events, alerts: window.voiceFixture?.alerts})').catch(() => null);
  console.error(error.stack);
}).finally(async () => {
  clearTimeout(watchdog);
  if (service) await service.shutdown(10000);
  if (window && !window.isDestroyed()) { await js('window.voiceFixture?.close()').catch(() => {}); window.destroy(); }
  child?.stdin.end(); child?.kill('SIGTERM');
  fs.writeFileSync(path.join(output, 'live-provider-ui-result.json'), JSON.stringify(report, null, 2));
  app.exit(report.passed ? 0 : 1);
});
