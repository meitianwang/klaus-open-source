// Exercise source parsing and host receipts against an actual isolated engine process.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { ExternalAgentImportService } from '../main/external-agent-import/service';
import { object, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { Harness } from './harness';
import { importFixture, put } from './external-import-fixture';
const h = new Harness(), binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY with engine/importExternalSession is required');
void (async () => {
  const f = await importFixture(), manager = new EngineManager('0.0.0-external-host-fixture');
  let engine: ManagedEngine, loseReply = true, threadId = '';
  const imports: JsonObject[] = [], receipts: JsonObject[] = [];
  const request: EngineRequest = async (method, params) => {
    const reply = await engine.client.requestWithTimeout(method, params, 15_000);
    if (method === 'engine/importExternalSession') {
      imports.push(structuredClone(object(params))); receipts.push(object(reply));
      if (loseReply) { loseReply = false; throw new Error('Fixture dropped the actual persisted import reply'); }
    }
    return reply;
  };
  const unexpected = async (): Promise<never> => { throw new Error('The transcript gate cannot mutate skills, hooks, MCP or plugins'); };
  const service = new ExternalAgentImportService({ home: f.home, workspaces: f.workspaces, request,
    skills: { withMutation: unexpected }, hooks: { withMutation: unexpected }, mcp: { importJson: unexpected, scopeList: unexpected, scopeMutate: unexpected }, plugins: { install: unexpected, toggle: unexpected }, onChanged: () => {} });
  const attach = async () => { await mkdir(f.root, { recursive: true }); engine = await manager.attach({ command: binary, args: [], cwd: f.root,
    env: [['HOME', f.home], ['USERPROFILE', f.home], ['XDG_CONFIG_HOME', join(f.home, '.config')], ['KLAUS_CONFIG_DIR', f.root], ['KLAUS_SESSION_DIR', join(f.root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(f.root, 'plugins')]] }); };
  const path = join(f.home, '.claude/projects/project/actual source.jsonl'), payload: JsonObject = { items: [{ providerId: 'claude-code', itemType: 'SESSIONS', details: { sessions: [{ path }] } }] };
  const read = () => request('engine/readThread', { threadId, limit: 10 }).then(object);
  const messages = (reply: JsonObject): JsonObject[] => (reply.turns as JsonObject[]).slice().reverse().flatMap(turn => turn.items as JsonObject[]);
  try {
    await put(path, [
      { type: 'user', cwd: f.ws, timestamp: '2026-09-01T01:00:00.000Z', uuid: 'external-user', message: { content: 'Original fixture question' } },
      { type: 'assistant', message: { id: 'external-answer', content: [{ type: 'text', text: 'Original fixture answer' }] } },
    ].map(value => JSON.stringify(value)).join('\n'));
    f.workspaces.projectsAdd({ path: f.ws });
    assert(f.workspaces.registeredProjectRoots().includes(f.ws));
    await h.test('the real facade persists normalized source text even when the host loses its reply', async () => {
      await attach(); assert.equal(manager.liveProcessCount(), 1);
      const reply = object(await service.import(payload)); assert.equal(reply.ok, false); assert.equal(reply.changed, false);
      assert.match(String(reply.errors), /dropped/); assert.equal(object(await service.status()).importedSessionCount, 0);
      assert.equal(receipts[0]!.persisted, true); threadId = String(receipts[0]!.threadId);
      const stored = await read(); assert.equal(object(stored.thread).id, threadId); assert.equal((stored.turns as JsonObject[])[0]!.status, 'imported');
      assert.deepEqual(messages(stored).map(row => row.type), ['userMessage', 'agentMessage']);
      assert.deepEqual(messages(stored)[0]!.content, [{ type: 'text', text: 'Original fixture question' }]);
      assert.equal(messages(stored)[1]!.text, 'Original fixture answer');
      assert.equal(object(messages(stored)[0]!.externalSource).sourceMessageId, 'external-user');
      assert.equal(object(messages(stored)[0]!.externalSource).timestampMs, 1788224400000);
    });
    await h.test('restarting the single engine and retrying recovers one exact host receipt', async () => {
      await manager.release(engine.key); await attach();
      const reply = object(await service.import(payload)); assert.equal(reply.ok, true, JSON.stringify(reply)); assert.deepEqual(reply.imported, { SESSIONS: 1 });
      assert.equal(receipts[1]!.alreadyImported, true); assert.deepEqual(imports[0], imports[1]); assert.equal(object(await service.status()).importedSessionCount, 1);
      assert.equal(f.workspaces.customWorkdir(threadId), f.ws); assert(JSON.stringify(await request('engine/listSessions', {})).includes(threadId));
      const receipt = JSON.parse(await readFile(join(f.root, 'external_agent_session_imports.json'), 'utf8')).records;
      assert.equal(receipt.length, 1); assert.equal(receipt[0].engine_import, true);
      assert.equal(object(await service.import(payload)).changed, false); assert.equal(imports.length, 2);
    });
    await h.test('the real engine rejects same-ID modified content without overwriting imported history', async () => {
      const before = await read();
      await assert.rejects(request('engine/importExternalSession', { ...imports[0]!, messages: [{ role: 'user', text: 'conflicting replacement' }] }));
      assert.deepEqual(await read(), before);
    });
    await h.test('a changed source receives a new identity while the original thread remains readable', async () => {
      await put(path, JSON.stringify({ type: 'user', cwd: f.ws, message: { content: 'Changed source is a separate import' } }));
      const reply = object(await service.import(payload)); assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal(object(await service.status()).importedSessionCount, 2);
      assert.notEqual(receipts.at(-1)!.threadId, threadId); assert.deepEqual(messages(await read())[0]!.content, [{ type: 'text', text: 'Original fixture question' }]);
    });
    await h.test('host import shutdown leaves no engine process', async () => { await service.close(); await manager.shutdownAll(); assert.equal(manager.liveProcessCount(), 0); });
  } finally { await service.close(); await manager.shutdownAll(); await f.close(); }
  process.exitCode = await h.finish(join(__dirname, 'external-agent-import-live-result.json'), 'external-agent-import-live');
})();
