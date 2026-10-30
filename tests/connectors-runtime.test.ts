import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorsRuntime } from '../main/app/connectors-runtime';
import type { MacOsCommand, MacOsCommands } from '../main/native/macos-command';
import { ChannelRegistry } from '../main/ipc/registry';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertEqual, waitFor } from './harness';

const h = new Harness();
async function fixture(real = false) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-connector-runtime-')), commands: MacOsCommand[] = [];
  let run: (request: MacOsCommand, signal: AbortSignal) => Promise<string> = async () => '[{"name":"owned.txt","kind":"file","size":5,"tags":[]}]';
  const backend: MacOsCommands = { available: async () => true, run: (request, signal) => { commands.push(request); return run(request, signal); }, close: async () => ({ complete: true }) };
  let turn: string | undefined = 'turn-1', reloads = 0;
  const runtime = createConnectorsRuntime(new ChannelRegistry(), { configRoot: root, userHome: root, platform: 'darwin', ...(real ? {} : { commands: backend }),
    permissionRules: async () => ({ allow: [], deny: [], ask: ['mcp__klaus-macos-finder__move_to_trash'] }), runtimeActive: async () => true, runtimeStatus: async () => [],
    currentTurn: () => turn, directory: async () => root, guardInteraction: async (_id, signal) => signal.throwIfAborted(), onChanged: async () => { reloads++; }, log: () => {},
  });
  return { root, runtime, commands, run: (callback: typeof run) => { run = callback; }, turn: (value: string | undefined) => { turn = value; }, reloads: () => reloads,
    close: async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function connect(runtime: ReturnType<typeof createConnectorsRuntime>, id = 'fixture') {
  const capabilities = await runtime.hostCapabilities(id), server = (capabilities.mcpServers as JsonObject[]).find(row => row.name === 'klaus-macos-finder');
  assert(server, 'the enabled Finder server is declared'); const url = string(server.url);
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (body: unknown) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
  assertEqual(initialized.status, 200, 'the actual host transport initialized'); await initialized.json();
  headers['mcp-session-id'] = initialized.headers.get('mcp-session-id')!;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = async () => object(object(await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result).tools as JsonObject[];
  const call = async (name: string, args: JsonObject = {}) => {
    const response = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }), content = await response.text();
    const frames = content.split('\n').filter(line => line.startsWith('data:')).map(line => object(JSON.parse(line.slice(5))));
    return frames.find(row => row.id === 3) ?? object(JSON.parse(content));
  };
  return { post, tools, call };
}
void (async () => {
  await h.test('connector preferences describe real capabilities and govern the actual MCP tool list', async () => {
    const f = await fixture(); try {
      const listed = await f.runtime.service.list(), finder = listed.find(row => row.id === 'macos-finder')!;
      assertEqual(finder.runtimeAvailable, true, 'Finder has an implementation'); assertEqual(finder.enabled, false, 'availability does not silently enable access');
      assertEqual(object((finder.tools as JsonObject[]).find(row => row.name === 'move_to_trash')).approval, 'ask', 'full engine permission names reach the settings panel');
      assertEqual((await f.runtime.service.toggle({ id: 'macos-finder', enabled: true })).ok, true, 'the preference is persisted');
      const client = await connect(f.runtime); assert((await client.tools()).some(row => row.name === 'list_folder'), 'enabled tool is actually served');
      assertEqual((await f.runtime.service.setToolEnabled({ id: 'macos-finder', toolName: 'list_folder', enabled: false })).ok, true, 'tool disable saved');
      assert(!(await client.tools()).some(row => row.name === 'list_folder'), 'the current connection sees the updated tool set');
      const denied = await client.call('list_folder', { path: f.root }); assert(denied.error || object(denied.result).isError, 'a stale tool invocation cannot bypass disable');
      assertEqual(f.commands.length, 0, 'no native command ran for the disabled tool'); assertEqual(f.reloads(), 2, 'each committed preference triggers a runtime refresh');
    } finally { await f.close(); }
  });
  await h.test('the connector transport owns task identity and release waits for actual native cancellation', async () => {
    const f = await fixture(); let release!: () => void; try {
      await f.runtime.service.toggle({ id: 'macos-finder', enabled: true }); const client = await connect(f.runtime);
      let started = false, aborted = false;
      f.run(async (_request, signal) => { started = true; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); await new Promise<void>(resolve => { release = resolve; }); signal.throwIfAborted(); return '[]'; });
      const called = client.call('list_folder', { path: f.root, sessionId: 'forged', turnId: 'forged' }).catch(() => ({}));
      await waitFor(() => started, 2000, 'native operation started'); let finished = false;
      const closing = f.runtime.releaseSession('fixture').then(() => { finished = true; });
      await waitFor(() => aborted, 2000, 'the owned native operation was cancelled');
      assertEqual(finished, false, 'cleanup does not report success before the native command exits'); release(); await called; await closing;
      assertEqual(f.runtime.counts().owners, 0, 'the native conversation was retired');
      assertEqual((await client.post({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).status, 404, 'the old capability token was revoked');
      f.run(async () => '[]'); const replacement = await connect(f.runtime); const result = object((await replacement.call('list_folder', { path: f.root })).result);
      assertEqual(result.isError, undefined, 'a fresh task owner can use the connector');
      assert(f.commands[0]!.generation !== f.commands[1]!.generation, 'resource generations cannot be reused by a replacement task');
    } finally { release?.(); await f.close(); }
  });
  await h.test('disabled connectors revoke existing transports and do not remain advertised as connected', async () => {
    const f = await fixture(); try {
      await f.runtime.service.toggle({ id: 'macos-finder', enabled: true }); const client = await connect(f.runtime);
      assertEqual(object((await f.runtime.service.status())[0]).status, 'failed', 'an enabled preference is not proof the engine connected');
      await f.runtime.service.toggle({ id: 'macos-finder', enabled: false });
      assertEqual((await client.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 403, 'the disabled server rejects existing tokens');
      assertEqual((await f.runtime.hostCapabilities('fixture')).mcpServers instanceof Array, true, 'capabilities keep the expected shape');
      assertEqual(f.runtime.counts().owners, 0, 'disabling the last connector drains its native owner');
    } finally { await f.close(); }
  });
  if (process.platform === 'darwin') await h.test('the served Finder tool reads only the real owned fixture through Foundation', async () => {
    const f = await fixture(true); try {
      await writeFile(join(f.root, 'owned.txt'), 'owned'); await f.runtime.service.toggle({ id: 'macos-finder', enabled: true });
      const client = await connect(f.runtime), result = object((await client.call('list_folder', { path: f.root })).result);
      assertEqual(result.isError, undefined, 'the real macOS command succeeded');
      const text = string(object((result.content as JsonObject[])[0]).text), rows = object(JSON.parse(text)).items as JsonObject[];
      assert(rows.some(row => row.name === 'owned.txt' && row.size === 5), 'actual filesystem metadata crossed the MCP transport');
    } finally { await f.close(); }
  });
  process.exitCode = await h.finish(join(__dirname, 'connectors-runtime-result.json'), 'connectors-runtime');
})();
