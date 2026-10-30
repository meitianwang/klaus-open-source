const { binaryPath, outputRoot } = require('./paths.cjs');
const { mkdtempSync, appendFileSync, mkdirSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { EngineManager } = require('../../dist/main/engine/manager.js');
const { SessionService } = require('../../dist/main/sessions/service.js');
const { HostState } = require('../../dist/main/services/host-state.js');
const { SessionEventPump, ChatEventForwarder } = require('../../dist/main/sessions/events.js');
const { setSessionModel } = require('../../dist/main/services/session-store.js');
const { kvSet } = require('../../dist/main/services/settings.js');
const { startProvider } = require('../../dist/tests/fixtures/anthropic.js');
const { waitFor } = require('../../dist/tests/harness.js');

void (async () => {
  const configRoot = mkdtempSync(join(outputRoot(), 'queue-live-'));
  const progress = (event, data = {}) => {
    const value = { event, ...data };
    appendFileSync(join(configRoot, 'progress.jsonl'), JSON.stringify(value) + '\n');
    process.stdout.write(JSON.stringify(value) + '\n');
  };
  process.env.KLAUS_TEST = '1';
  const provider = await startProvider("printf 'QUEUE_FIXTURE\\n'");
  const manager = new EngineManager('queue-parity-fixture');
  const binary = binaryPath();
  const options = { command: binary, args: [], env: [
    ['KLAUS_CONFIG_DIR', configRoot], ['KLAUS_SESSION_DIR', join(configRoot, 'sessions')], ['KLAUS_PLUGIN_HOME', join(configRoot, 'plugins')],
  ] };
  let sessions;
  try {
    const engine = await manager.attach(options), client = engine.client;
    const request = client.requestWithTimeout.bind(client);
    client.requestWithTimeout = async (method, params, timeout) => {
      if (method !== 'session/resumePending') return request(method, params, timeout);
      progress('resume-request', { params });
      try { const reply = await request(method, params, timeout); progress('resume-ack', { reply }); return reply; }
      catch (error) { progress('resume-rpc-error', { error }); throw error; }
    };
    progress('attached', { binary, configRoot });
    await client.requestWithTimeout('config/batchWrite', { edits: [{ keyPath: 'modelProviders.parity', mergeStrategy: 'replace', value: {
      name: 'Queue fixture', provider: 'anthropic', model: 'fixture-model', baseUrl: provider.url,
      maxContextTokens: 200000, default: true, thinking: 'off',
    } }] }, 15000);
    await client.requestWithTimeout('model/credential/write', { id: 'parity', apiKey: 'fixture-key' }, 15000);
    setSessionModel('', 'custom:parity', 'custom', configRoot);
    kvSet('model_tiers:custom', JSON.stringify({ low: 'parity', medium: 'parity', high: 'parity' }), configRoot);
    const state = new HostState(), frames = [], resumes = [];
    const forwarder = new ChatEventForwarder((_channel, values) => frames.push(...values));
    const pump = new SessionEventPump({ state, forwarder, currentGeneration: () => engine.generation, emit: () => {}, log: (kind, detail) => progress(kind, { detail }) });
    sessions = new SessionService({ manager, state, configRoot, spawnOptions: () => options,
      pushChatEvents: values => forwarder.enqueue(values), onEvent: (event, generation) => pump.receive(event, generation),
      log: (kind, detail) => progress(kind, { detail }),
    });
    client.on('event', event => {
      const params = event.params || {}, envelope = params.event || params;
      if (envelope.pendingResume) { resumes.push(envelope.pendingResume); progress('resume', envelope.pendingResume); }
      if (envelope.error) progress('raw-error', { submissionId: envelope.submissionId, error: envelope.error });
      if (event.type === 'turnCompleted' || event.method === 'turn/failed') progress('terminal', { type: event.type, params });
    });
    const workdir = join(configRoot, 'workspace'); mkdirSync(workdir);
    const session = await sessions.newSession({ workdir });
    await sessions.rename(session.id, 'Queue fixture');
    const engineId = state.liveSession(session.id);
    const requestsBeforeTurn = provider.requests.length;
    await sessions.send(session.id, { text: 'AGENT CHILD FIXTURE' });
    await waitFor(() => provider.agents.active === 1, 30000, 'held main fixture');
    progress('main-held');
    for (const index of [1, 2]) await client.requestWithTimeout('session/steer', {
      sessionId: engineId, input: `QUEUED INPUT ${index}`, priority: 'next', submissionId: `queue-fixture-${index}`,
    }, 15000);
    const snapshot = await client.requestWithTimeout('session/queueSnapshot', { sessionId: engineId }, 15000);
    const items = snapshot.queueSnapshot.items.filter(item => item.state === 'pending');
    assert.equal(items.length, 2);
    const identities = items.map(item => item.message.uuid);
    progress('queued', { identities });
    provider.agents.release();
    try { await waitFor(() => resumes.length >= 2 && frames.some(frame => frame.type === 'done') && !state.isWorking(session.id), 30000, 'real queued continuation completion'); }
    catch (error) { progress('timeout', { resumes, frameTypes: frames.map(frame => frame.type), working: state.isWorking(session.id), requests: provider.requests.map(request => ({ stream: request.stream, model: request.model })) }); throw error; }
    assert.equal(resumes.filter(value => value.started).length, 1);
    assert.equal(frames.filter(frame => frame.type === 'done').length, 1);
    const streamingCalls = provider.requests.slice(requestsBeforeTurn).filter(request => request.stream === true).length;
    assert.equal(streamingCalls, 2);
    const history = await client.requestWithTimeout('session/history', { sessionId: engineId }, 15000);
    const rows = history.history || history.messages;
    for (const uuid of identities) assert(rows.some(row => row.uuid === uuid), `Original queue UUID retained: ${uuid}`);
    const finalQueue = await client.requestWithTimeout('session/queueSnapshot', { sessionId: engineId }, 15000);
    assert.equal(finalQueue.queueSnapshot.items.filter(item => item.state === 'pending').length, 0);
    const saved = await client.requestWithTimeout('engine/readThreadHistory', { threadId: session.id }, 15000);
    assert.deepEqual(saved.history.filter(row => ['user', 'assistant'].includes(row.type)).map(row => row.uuid), rows.filter(row => ['user', 'assistant'].includes(row.type)).map(row => row.uuid));
    assert.deepEqual(saved.turnFinalMessageIds, history.turnFinalMessageIds);
    assert.deepEqual(saved.turnCancelledTools, history.turnCancelledTools);
    const exported = await sessions.exportMessages(session.id);
    assert.deepEqual(exported.map(row => row.uuid), rows.map(row => row.uuid));
    await sessions.setArchived(session.id, true);
    await client.requestWithTimeout('model/credential/delete', { id: 'parity' }, 15000);
    const beforeOfflineRead = provider.requests.length;
    const offline = await sessions.history(session.id);
    assert(offline.messages.some(row => row.text === 'Fixture response complete.'));
    assert.equal(state.liveSession(session.id), undefined);
    assert.equal(sessions.canReadSessionMedia(session.id), true);
    assert.deepEqual((await sessions.exportMessages(session.id)).map(row => row.uuid), rows.map(row => row.uuid));
    assert.equal(provider.requests.length, beforeOfflineRead);
    assert((await sessions.listArchivedSessions()).some(row => row.id === session.id));
    progress('passed', { streamingCalls, continuedBatches: 1, finalDone: 1, retainedQueueIdentities: identities.length, storedMessageIdentities: true, originalExportGroups: true, archivedProviderFreeRead: true });
    forwarder.close();
  } finally {
    await (sessions ? sessions.shutdown() : manager.shutdownAll());
    await provider.close();
    rmSync(configRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
