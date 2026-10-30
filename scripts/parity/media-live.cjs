const { binaryPath, outputRoot } = require('./paths.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EngineManager } = require('../../dist/main/engine/manager.js');
const { SessionService } = require('../../dist/main/sessions/service.js');
const { HostState } = require('../../dist/main/services/host-state.js');
const { SessionEventPump, ChatEventForwarder } = require('../../dist/main/sessions/events.js');
const { DynamicTools } = require('../../dist/main/sessions/dynamic-tools.js');
const { registerMediaGenerationTools } = require('../../dist/main/services/media-generation/service.js');
const { setSessionModel } = require('../../dist/main/services/session-store.js');
const { kvSet } = require('../../dist/main/services/settings.js');
const { mediaFixture, png } = require('../../dist/tests/media-generation-fixture.js');
const { waitFor } = require('../../dist/tests/harness.js');
const fixtureFile = path.resolve(__dirname, '../../dist/tests/fixtures/anthropic.js');
const fixture = new Module(fixtureFile); fixture.filename = fixtureFile; fixture.paths = Module._nodeModulePaths(path.dirname(fixtureFile));
const original = fs.readFileSync(fixtureFile, 'utf8');
assert(original.includes("'list_archived_threads'"));
fixture._compile(original.replace("'list_archived_threads'", "'list_archived_threads', 'generate_image'"), fixtureFile);
const log = (event, data = {}) => process.stdout.write(JSON.stringify({ event, ...data }) + '\n');
void (async () => {
  process.env.KLAUS_TEST = '1';
  const media = await mediaFixture(); const provider = await fixture.exports.startProvider('unused');
  const manager = new EngineManager('media-parity-fixture'), state = new HostState(), frames = [];
  const binary = binaryPath();
  const options = { command: binary, args: [], env: [['KLAUS_CONFIG_DIR', media.root], ['KLAUS_SESSION_DIR', path.join(media.root, 'sessions')], ['KLAUS_PLUGIN_HOME', path.join(media.root, 'plugins')]] };
  let sessions, dynamic, forwarder;
  try {
    const engine = await manager.attach(options), client = engine.client;
    log('attached', { binary, profile: media.root });
    await client.requestWithTimeout('config/batchWrite', { edits: [{ keyPath: 'modelProviders.parity', mergeStrategy: 'replace', value: { name: 'Media fixture', provider: 'anthropic', model: 'fixture-model', baseUrl: provider.url, maxContextTokens: 200000, default: true, thinking: 'off' } }] }, 15000);
    await client.requestWithTimeout('model/credential/write', { id: 'parity', apiKey: 'fixture-key' }, 15000);
    setSessionModel('', 'custom:parity', 'custom', media.root);
    kvSet('model_tiers:custom', JSON.stringify({ low: 'parity', medium: 'parity', high: 'parity' }), media.root);
    media.config('custom', 'image', { model: 'fixture-image' });
    dynamic = new DynamicTools({ request: (method, params) => client.requestWithTimeout(method, params, 15000), knownSession: id => state.bindings().some(binding => binding.engineId === id), log: message => log('dynamic-error', { message }) });
    forwarder = new ChatEventForwarder((_channel, values) => frames.push(...values));
    const pump = new SessionEventPump({ state, configRoot: media.root, forwarder, currentGeneration: () => engine.generation, emit: (channel, value) => { log('push', { channel, toolName: value.toolName }); if (channel === 'permission:request') { assert.equal(value.toolName, 'generate_image'); void pump.respond({ requestId: value.requestId, decision: 'allow' }, true).catch(error => log('approval-error', { message: String(error) })); } }, observe: (event, generation) => dynamic.receive(event, generation), log: (kind, detail) => log(kind, { detail }) });
    sessions = new SessionService({ manager, state, configRoot: media.root, workspaces: media.workspaces, spawnOptions: () => options, dynamicTools: () => dynamic.definitions(), pushChatEvents: values => forwarder.enqueue(values), onEvent: (event, generation) => pump.receive(event, generation), onClosing: id => media.service.releaseSession(id) });
    registerMediaGenerationTools(dynamic, media.service, (engineId, signal) => {
      const owner = state.bindings().find(binding => binding.engineId === engineId && !binding.stale);
      assert(owner); const source = state.sessionProvider(owner.rendererId).source;
      return { source, sessionId: owner.rendererId, signal, assertCurrent: () => { signal.throwIfAborted(); assert(!sessions.isSessionClosing(owner.rendererId)); assert.equal(state.liveSession(owner.rendererId), engineId); assert.equal(state.sessionProvider(owner.rendererId).source, source); } };
    });
    const session = await sessions.newSession({ workdir: media.root }); await sessions.rename(session.id, 'Media fixture');
    await sessions.send(session.id, { text: 'HOST TOOL FIXTURE ' + JSON.stringify({ tool: 'generate_image', input: { prompt: 'Blue square' } }) });
    try { await waitFor(() => frames.some(frame => frame.type === 'done'), 30000, 'image generation real turn'); }
    catch (error) { log('timeout', { frames: frames.map(frame => ({ type: frame.type, toolName: frame.toolName })), modelRequests: provider.requests.length, generated: media.generated.length }); throw error; }
    assert.equal(media.requests.length, 1); assert.equal(media.generated.length, 1);
    const saved = media.generated[0].paths[0]; assert.deepEqual(fs.readFileSync(saved), png);
    const ends = frames.filter(frame => frame.type === 'tool_end');
    log('tool-results', { results: ends.map(frame => ({ name: frame.toolName, id: frame.id, media: frame.media, contentLength: String(frame.content).length })), mediaRequests: media.requests.length });
    const image = ends.flatMap(frame => frame.media || []).find(item => item.mimeType === 'image/png');
    assert(image, 'Actual dynamic tool result must have a renderable image, not base64 JSON text');
    assert.deepEqual(fs.readFileSync(image.path), png);
    assert(ends.every(frame => !String(frame.content).includes(png.toString('base64'))));
    log('passed', { mediaRequests: 1, generatedFiles: 1, liveImage: true, modelRequests: provider.requests.filter(request => request.stream).length });
  } finally { await dynamic?.close(); await sessions?.shutdown(); await manager.shutdownAll(); forwarder?.close(); await media.close(); await provider.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
