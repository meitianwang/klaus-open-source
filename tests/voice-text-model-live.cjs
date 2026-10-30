// Opt-in verification of the configured shared text model with synthetic dictation.
// Uses a private profile for test history; account credentials stay in the engine.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { parseArgs } = require('node:util');
const { AppServerClient } = require('../dist/main/engine/client');
const { EngineSettings } = require('../dist/main/services/engine-settings');
const { voiceModelAccess } = require('../dist/main/app/voice-runtime');
const { readModelTierMapping } = require('../dist/main/services/model-tier-settings');
const { VoiceStore } = require('../dist/main/services/voice/store');
const { polish } = require('../dist/main/services/voice/network');
const { values } = parseArgs({ options: { engine: { type: 'string' }, account: { type: 'string' }, output: { type: 'string' } } });
for (const key of ['engine', 'account', 'output']) assert.ok(values[key] && path.isAbsolute(values[key]), `--${key} requires an absolute path`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klaus-voice-text-live-'));
const report = { fixture: 'synthetic complete dictation through production shared-tier resolver and real selected provider', calls: [], passed: false };
const started = performance.now();
let child;
(async () => {
  const mapping = readModelTierMapping(values.account);
  assert.ok(mapping.low, 'an explicit configured global low tier is required for this opt-in check');
  report.expected = mapping.low;
  const env = { ...process.env, KLAUS_CONFIG_DIR: values.account, KLAUS_SESSION_DIR: path.join(root, 'sessions'), KLAUS_PLUGIN_HOME: path.join(root, 'plugins') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'KLAUS_AGENT_CONFIG_JSON', 'KLAUS_MODEL', 'KLAUS_PROVIDER']) delete env[key];
  child = spawn(values.engine, ['--app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = new AppServerClient(child.stdin, 'voice-text-routing-verification');
  child.stdout.on('data', data => client.feedStdout(data)); child.stdout.on('end', () => client.endStdout());
  child.stderr.on('data', () => {});
  const request = async (method, params) => {
    report.calls.push({ method, ...(method === 'engine/completeText' ? { source: params.source, modelId: params.modelId } : {}) });
    return client.requestWithTimeout(method, params, 40000);
  };
  const initialized = await request('initialize', { clientInfo: { name: 'voice-text-routing-verification', version: '1' } }); client.captureInitializeResult(initialized);
  const connection = { generation: 1, client };
  const nativeRequest = client.requestWithTimeout.bind(client);
  client.requestWithTimeout = async (method, params, ...rest) => {
    report.calls.push({ method, ...(method === 'engine/completeText' ? { source: params.source, modelId: params.modelId } : {}) });
    return nativeRequest(method, params, ...rest);
  };
  const models = voiceModelAccess(new EngineSettings(request), request, values.account, () => connection);
  const raw = 'this is a live dictation test i am still speaking now please keep every sentence in the input box';
  const began = performance.now();
  const result = await polish(new VoiceStore(path.join(root, 'voice')), models, raw, '', new AbortController().signal);
  report.elapsedRefinementMs = Math.round(performance.now() - began); report.result = result;
  assert.equal(result.polished, true, 'the selected model must return a complete refinement rather than raw fallback');
  assert.match(result.text, /live dictation test/i); assert.match(result.text, /still speaking now/i); assert.match(result.text, /keep every sentence in the input box/i);
  const completions = report.calls.filter(call => call.method === 'engine/completeText');
  assert.equal(completions.length, 1); assert.equal(completions[0].source, mapping.low.source); assert.equal(completions[0].modelId, mapping.low.modelId);
  assert.equal(report.calls.some(call => call.method === 'model/credential/read'), false, 'text inference must keep credentials inside the engine');
  report.passed = true;
})().catch(error => { report.error = { name: error.name, message: String(error.message).slice(0, 1000) }; process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) { const closed = once(child, 'close'); child.stdin.end(); child.kill('SIGTERM'); await closed; }
  report.totalMs = Math.round(performance.now() - started);
  fs.writeFileSync(values.output, JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, expected: report.expected, elapsedRefinementMs: report.elapsedRefinementMs, error: report.error }));
});
