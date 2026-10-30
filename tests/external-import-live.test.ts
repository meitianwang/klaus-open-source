// Actual engine import, followed by an actual model turn against a loopback SSE provider.
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { requestAcknowledged } from '../main/engine/acknowledged';
import type { ClientEvent } from '../main/engine/protocol';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the actual external import gate');
const root = mkdtempSync(join(tmpdir(), 'klaus-external-import-live-')), manager = new EngineManager('0.0.0-external-import-live'), h = new Harness();
const threadId = '614cc8f1-8c61-5f4f-8ef8-8199ba8b267a';
const params: JsonObject = { threadId, cwd: root, title: 'External source fixture',
  source: { providerId: 'qoder', format: 'claude-jsonl', path: join(root, 'never-opened-source.jsonl'), contentSha256: 'a'.repeat(64) },
  messages: [{ role: 'user', text: 'Original imported question', timestampMs: 1_700_000_000_000, sourceMessageId: 'source-user' },
    { role: 'assistant', text: '[external_agent_tool_result] Imported textual result', timestampMs: 1_700_000_001_000, sourceMessageId: 'source-answer' }],
  hostMetadata: { importedFrom: 'qoder', id: 'cannot-replace-thread-id', source: 'cannot-replace-engine-provenance' } };
const requests: JsonObject[] = []; let engine: ManagedEngine, baseUrl = '';
const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { const bytes = Buffer.from(chunk); length += bytes.length; if (length > 16 * 1024 * 1024) throw new Error('fixture request too large'); chunks.push(bytes); }
    const body = object(JSON.parse(Buffer.concat(chunks).toString())); requests.push(body);
    if (request.url !== '/v1/messages' || request.headers['x-api-key'] !== 'fixture-only-key') { response.writeHead(400); response.end('invalid fixture request'); return; }
    const events = [
      { type: 'message_start', message: { id: 'fixture-live-answer', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 11, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Actual loopback provider continuation.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('fixture failure'); });
});
async function attach(): Promise<void> {
  engine = await manager.attach({ command: binary!, args: [], cwd: root,
    env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')], ['HOME', root]] });
}
const request = (method: string, value: JsonObject) => engine.client.requestWithTimeout(method, value, 20_000);
const read = () => request('engine/readThread', { threadId, limit: 10 }).then(object);
const items = (result: JsonObject): JsonObject[] => (result.turns as JsonObject[]).slice().reverse().flatMap(turn => turn.items as JsonObject[]);
async function cleanup(): Promise<void> {
  await manager.shutdownAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true });
}

h.test('real engine imports through one named method without creating a model request', async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object', 'local fixture address'); baseUrl = `http://127.0.0.1:${address.port}`;
  await attach(); assertDeepEqual(await request('engine/importExternalSession', params), { threadId, persisted: true, alreadyImported: false, messageCount: 2 }, 'actual import receipt');
  assertEqual(requests.length, 0, 'import made no provider call');
  const listed = object(await request('engine/listSessions', {})); assert(JSON.stringify(listed).includes(threadId), 'actual store listing');
  const result = await read(), rows = items(result);
  assertDeepEqual(rows.map(row => row.type), ['userMessage', 'agentMessage'], 'external tools remain text');
  assertEqual(object(result.thread).id, threadId, 'host metadata cannot replace identity');
  assertEqual((result.turns as JsonObject[])[0]!.status, 'imported', 'no invented inference execution');
  assertEqual(object(rows[0]!.externalSource).timestampMs, 1_700_000_000_000, 'original message time');
  assertEqual(object(rows[1]!.externalSource).sourceMessageId, 'source-answer', 'original source message identity');
});
h.test('actual resume preserves imported prompt and a real loopback model turn appends to it', async () => {
  const started = object(await request('session/start', { resume: threadId, init: { threadId, cwd: root,
    provider: { type: 'anthropic', model: 'fixture-import-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-only-key' },
    config: { autoMemory: false, autoDream: false, memoryRecall: false, memory: { enabled: false }, thinking: false, maxOutputTokens: 1024 } } }));
  assertEqual(started.sessionId, threadId, 'same durable thread resumed'); assertEqual(requests.length, 0, 'resume does not run inference');
  let completed: unknown;
  const receive = (event: ClientEvent): void => { if (event.type === 'turnCompleted' && object(event.params).sessionId === threadId) completed = event.params; };
  engine.client.on('event', receive);
  try {
    await request('session/subscribe', { sessionId: threadId }); await request('turn/start', { sessionId: threadId, input: 'Continue this imported conversation' });
    await waitFor(() => completed !== undefined, 20_000, 'actual model terminal event');
    assertEqual(requests.length, 1, 'one real provider request');
    assert(JSON.stringify(requests[0]!.messages).includes('Original imported question'), 'original history reaches the actual model prompt');
    const result = await read(); assertEqual((result.turns as JsonObject[])[0]!.status, 'completed', 'actual new turn completed');
    assert(items(result).some(row => row.text === 'Actual loopback provider continuation.'), 'provider answer persisted alongside imported text');
  } finally { engine.client.off('event', receive); await request('session/close', { sessionId: threadId }); }
});
h.test('real engine restart gives an idempotent import receipt and refuses changed source content', async () => {
  await manager.release(engine.key); await attach();
  const before = await read(); assertDeepEqual(await request('engine/importExternalSession', params), { threadId, persisted: true, alreadyImported: true, messageCount: 2 }, 'exact retry across endpoint restart');
  await assertRejects(() => request('engine/importExternalSession', { ...params, title: 'Different request title' }), 'same ID with different normalized input refused');
  assertDeepEqual(await read(), before, 'conflict leaves the authoritative thread unchanged');
  assertEqual(requests.length, 1, 'retry and conflict do not run a model');
});
h.test('real archive and unarchive retain the import while native deletion removes it', async () => {
  const archived = object(await requestAcknowledged(engine.client, 'session/archiveSession', { threadId }, 'archived', 20_000)); assertEqual(archived.archived, true, 'real archive terminal');
  assertEqual(object((await read()).thread).archived, true, 'archive visible in read');
  assertEqual(object(await request('engine/importExternalSession', params)).alreadyImported, true, 'retry does not unarchive');
  const restored = object(await requestAcknowledged(engine.client, 'session/unarchiveSession', { threadId }, 'unarchived', 20_000)); assertEqual(restored.status, 'restored', 'real unarchive terminal');
  assertEqual(object((await read()).thread).archived, false, 'actual unarchive visible');
  const files = readdirSync(join(root, 'sessions')).filter(name => name.endsWith('.jsonl')); assertEqual(files.length, 1, 'one rollout through lifecycle');
  assert(readFileSync(join(root, 'sessions', files[0]!), 'utf8').includes('external_session_import_complete'), 'engine retains import receipt');
  assertEqual(object(await requestAcknowledged(engine.client, 'session/deleteSession', { threadId }, 'deleted', 20_000)).deleted, true, 'real delete terminal');
  await assertRejects(read, 'deleted thread is absent'); assert(!JSON.stringify(await request('engine/listSessions', {})).includes(threadId), 'deleted import leaves listing');
});
h.test('external import live gate reaps its unique engine owner', async () => {
  await manager.shutdownAll(); assertEqual(manager.liveProcessCount(), 0, 'no engine process remains');
});
void h.finish(join(__dirname, 'external-import-live-result.json'), 'external-import-live').then(async code => {
  await cleanup(); process.exitCode = code;
}, async error => { await cleanup(); throw error; });
