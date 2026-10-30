import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { requestAcknowledged } from '../main/engine/acknowledged';
import type { ClientEvent } from '../main/engine/protocol';
import type { Json } from '../main/ipc/contract';
import { MemorySnapshotService } from '../main/services/memory-snapshots';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the actual snapshot decision gate');
const root = mkdtempSync(join(tmpdir(), 'klaus-memory-snapshot-live-')), h = new Harness(), manager = new EngineManager('0.0.0-memory-snapshots-live');
const prompts: JsonObject[] = [], audits: JsonObject[] = [], logs: string[] = [], completed = new Set<string>(), bindings = new Set<string>();
const providerBodies: JsonObject[] = [];
let engine!: ManagedEngine, snapshots!: MemorySnapshotService, baseUrl = '', providerRequests = 0, presentation = true;
const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const raw of request) { const bytes = Buffer.from(raw); size += bytes.length; if (size > 8 * 1024 * 1024) throw new Error('Fixture body exceeds its bound'); chunks.push(bytes); }
    const body = object(JSON.parse(Buffer.concat(chunks).toString())), messages = body.messages as JsonObject[], last = messages.at(-1)!;
    const content = last.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap(value => {
      const block = object(value);
      return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    }) : [];
    const hasResult = Array.isArray(content) && content.some(value => object(value).type === 'tool_result');
    const parentCommands = !hasResult && last.role === 'user'
      ? texts.map(text => /^MEMORY SNAPSHOT PARENT ([a-z0-9-]+)$/.exec(text)).filter((match): match is RegExpExecArray => match !== null) : [];
    if (parentCommands.length > 1) throw new Error('Ambiguous snapshot fixture parent commands');
    const parent = parentCommands.length === 1, agent = parentCommands[0]?.[1] ?? '';
    const tool = (body.tools as JsonObject[] | undefined)?.find(row => ['task', 'Task', 'Agent'].includes(String(row.name)));
    if (request.url !== '/v1/messages' || request.headers['x-api-key'] !== 'fixture-snapshot-key' || parent && !tool) throw new Error('Unexpected snapshot fixture provider request');
    providerRequests++;
    providerBodies.push(body);
    const block: JsonObject = parent ? { type: 'tool_use', id: 'toolu_' + randomUUID(), name: tool!.name!, input: { description: 'Own snapshot fixture', prompt: 'MEMORY SNAPSHOT CHILD', subagent_type: agent, run_in_background: false, fork_context: false } }
      : { type: 'text', text: 'Snapshot fixture model completed.' };
    const message = { id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model: body.model!, content: [block], stop_reason: parent ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 8 } };
    if (body.stream !== true) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return; }
    const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: parent ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: parent ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage }, { type: 'message_stop' }];
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('Fixture provider failed'); });
});
const request = (method: string, params: JsonObject) => engine.client.requestWithTimeout(method, params, 20_000);
const receive = (event: ClientEvent): void => {
  snapshots.receive(event);
  if (event.type === 'turnCompleted') completed.add(String(object(event.params).sessionId));
  if (event.type === 'rawSessionEvent' || event.type === 'engineEvent') {
    const outer = object(event.params), audit = object(object(outer.event ?? outer).agentMemorySnapshotDecision);
    if (Object.keys(audit).length) audits.push(audit);
  }
};
async function begin(name: string): Promise<{ id: string; directory: string; promptIndex: number; auditIndex: number }> {
  const directory = join(root, 'agent-memory', name); mkdirSync(join(directory, '.snapshots'), { recursive: true });
  writeFileSync(join(directory, 'local.md'), 'Only this local fixture.\n');
  writeFileSync(join(directory, '.snapshots/remote.md'), 'Only this incoming fixture.\n');
  writeFileSync(join(directory, '.snapshots/snapshot.json'), '{"updatedAt":"2026-09-08T00:00:00Z"}');
  const init = { cwd: root, provider: { type: 'anthropic', model: 'fixture-memory-model', baseUrl }, auth: { type: 'api_key', key: 'fixture-snapshot-key' },
    permissionMode: 'bypassPermissions', agents: [{ name, description: 'Own snapshot test', prompt: 'Answer the fixture briefly.', memory: 'user' }],
    agentMemorySnapshotPolicy: { timeoutMs: 5000, firstUse: 'initialize', timeout: 'keep', disconnect: 'keep', noHandler: 'keep' },
    config: { agentMemory: true, agentMemorySnapshot: true, autoMemory: false, autoDream: false, memoryRecall: false, thinking: false, maxRetries: 0, maxOutputTokens: 1024 } };
  const id = String(object(await request('session/start', { init })).sessionId); bindings.add(id);
  await request('session/subscribe', { sessionId: id });
  const promptIndex = prompts.length, auditIndex = audits.length;
  await request('turn/start', { sessionId: id, input: 'MEMORY SNAPSHOT PARENT ' + name });
  return { id, directory, promptIndex, auditIndex };
}
async function finish(id: string): Promise<void> { await waitFor(() => completed.has(id), 20_000, 'the real parent and child turn completes'); bindings.delete(id); snapshots.forget(id); await request('session/close', { sessionId: id }); }

void (async () => {
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object'); baseUrl = 'http://127.0.0.1:' + address.port;
    engine = await manager.attach({ command: binary, args: [], cwd: root, env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')], ['HOME', root]] });
    snapshots = new MemorySnapshotService({ generation: () => engine.generation, rendererId: id => bindings.has(id) ? id : '', timeoutMs: 2000,
      present: async prompt => { prompts.push(prompt); return presentation; }, log: text => logs.push(text),
      resolve: async (owner, requestId, result) => {
        assert.equal(owner.generation, engine.generation); assert(bindings.has(owner.engineId));
        const field = 'agentMemorySnapshotDecision', method = 'decision' in result ? 'session/resolveAgentMemorySnapshotDecision' : 'session/settleAgentMemorySnapshotUnavailable';
        const audit = object(await requestAcknowledged(engine.client, method, { sessionId: owner.engineId, requestId, ...result }, field));
        assert.equal(object(audit.request).requestId, requestId); assert.notEqual(audit.status, 'requested');
      },
    }); engine.client.on('event', receive);
    for (const choice of ['keep', 'merge', 'replace'] as const) await h.test('actual snapshot ' + choice + ' decision is audited and applied by the sole engine', async () => {
      const run = await begin('snapshot-' + choice);
      try {
        try { await waitFor(() => prompts.length > run.promptIndex, 10_000, 'real engine snapshot prompt'); }
        catch (error) { process.stdout.write(JSON.stringify({ audit: audits.slice(run.auditIndex), history: await request('engine/readThread', { threadId: run.id, limit: 2 }) }).slice(0, 6000) + '\n'); throw error; }
        const prompt = prompts[run.promptIndex]!; assert.equal(prompt.agentType, 'snapshot-' + choice);
        assert.equal(await snapshots.respond({ requestId: prompt.requestId!, choice }), null);
        await waitFor(() => audits.slice(run.auditIndex).some(audit => audit.status === 'applied' && audit.decision === choice), 10_000, 'the real engine applies the selected choice');
        if (choice !== 'replace') assert.equal(readFileSync(join(run.directory, 'local.md'), 'utf8'), 'Only this local fixture.\n');
        else assert.equal(existsSync(join(run.directory, 'local.md')), false);
        if (choice === 'replace') assert.equal(readFileSync(join(run.directory, 'remote.md'), 'utf8'), 'Only this incoming fixture.\n');
        else assert.equal(existsSync(join(run.directory, 'remote.md')), false);
        await snapshots.respond({ requestId: prompt.requestId!, choice: choice === 'keep' ? 'replace' : 'keep' });
        assert.equal(snapshots.counts().prompts, 0); await finish(run.id);
        if (choice === 'merge') assert(providerBodies.some(body => JSON.stringify(body.messages).includes('updated shared snapshot')), 'merge prepends the actual reconciliation instruction instead of overwriting files');
      } finally { if (bindings.delete(run.id)) { snapshots.forget(run.id); await request('session/close', { sessionId: run.id }); } }
    });
    await h.test('a missing renderer settles the actual engine request with its keep policy', async () => {
      presentation = false; const run = await begin('snapshot-no-handler');
      try {
        await waitFor(() => audits.slice(run.auditIndex).some(audit => audit.status === 'applied' && audit.source === 'no-handler-policy' && audit.decision === 'keep'), 10_000, 'actual no-handler keep audit');
        await finish(run.id); assert.equal(readFileSync(join(run.directory, 'local.md'), 'utf8'), 'Only this local fixture.\n'); assert.equal(existsSync(join(run.directory, 'remote.md')), false);
      } finally { presentation = true; if (bindings.delete(run.id)) { snapshots.forget(run.id); await request('session/close', { sessionId: run.id }); } }
    });
    await h.test('a timed out real prompt cannot later replace local memory', async () => {
      const run = await begin('snapshot-timeout');
      try {
        await waitFor(() => audits.slice(run.auditIndex).some(audit => audit.status === 'applied' && audit.source === 'timeout-policy' && audit.decision === 'keep'), 10_000, 'actual timeout keep audit');
        const prompt = prompts[run.promptIndex]!; await snapshots.respond({ requestId: prompt.requestId!, choice: 'replace' });
        await finish(run.id); assert.equal(readFileSync(join(run.directory, 'local.md'), 'utf8'), 'Only this local fixture.\n'); assert.equal(existsSync(join(run.directory, 'remote.md')), false);
      } finally { if (bindings.delete(run.id)) { snapshots.forget(run.id); await request('session/close', { sessionId: run.id }); } }
    });
    await h.test('snapshot decisions leave no prompt jobs or secondary engine process', async () => {
      await snapshots.close(); assert.deepEqual(snapshots.counts(), { prompts: 0, operations: 0 }); assert.deepEqual(logs, []); assert(providerRequests >= 10); assert.equal(manager.liveProcessCount(), 1);
      assert(providerBodies.some(body => (body.messages as JsonObject[]).some(message => {
        const blocks = message.content;
        return message.role === 'user' && Array.isArray(blocks)
          && blocks.some(block => object(block).text === 'MEMORY SNAPSHOT PARENT snapshot-keep')
          && blocks.some(block => typeof object(block).text === 'string' && String(object(block).text).includes('<skill-catalog:'));
      })), 'the exact parent input and generated catalog metadata remain separate provider text blocks');
      await manager.shutdownAll(); assert.equal(manager.liveProcessCount(), 0);
    });
  } catch (error) { await h.test('snapshot live setup', () => { throw error; }); }
  finally {
    await snapshots?.close(); if (engine) engine.client.off('event', receive); await manager.shutdownAll();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { force: true, recursive: true });
  }
  process.exitCode = await h.finish(join(__dirname, 'memory-snapshots-live-result.json'), 'memory-snapshots-live');
})();
