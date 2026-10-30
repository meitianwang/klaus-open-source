// Explicit live gate: isolated config, a local stdio fixture, and no model or remote service.
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestAcknowledged } from '../main/engine/acknowledged';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { McpConfigurationService } from '../main/services/mcp/configuration';
import { McpRuntimeService } from '../main/services/mcp/runtime';
import { McpOAuthService } from '../main/services/mcp/oauth';
import { object, string, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { WorkspaceStore } from '../main/services/workspaces';
import { Harness, assert, assertDeepEqual, assertEqual, waitFor } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the live MCP configuration gate');
const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-mcp-config-live-'));
const project = join(root, 'project.with."quotes"'), serverFile = join(root, 'fixture.cjs'), pidFile = join(root, 'fixture-pids');
const manager = new EngineManager('0.0.0-mcp-config-live');
let engine: ManagedEngine, request: EngineRequest, sessionId = '', reloadChanges = false, changes = 0;
const workspaces = new WorkspaceStore({ configRoot: root, push: () => {}, pickDirectory: async () => null, onSessionWorkdirChanged: () => {} });
const service = new McpConfigurationService({ workspaces, request: (method, params) => request(method, params),
  onChanged: async () => {
    changes++;
    if (reloadChanges) await runtimeService.reconnect();
  }, resolveCwd: async id => { assertEqual(id, 'fixture-thread', 'existing thread only'); return project; } });
const runtimeService = new McpRuntimeService({ configuration: service,
  oauth: new McpOAuthService({ credentials: { readMcpOAuthRecord: async () => ({ value: null }), writeMcpOAuthRecord: async () => { throw new Error('This fixture has no OAuth grant'); }, removeMcpOAuthRecord: async () => { throw new Error('This fixture has no OAuth grant'); } }, openExternal: async () => { throw new Error('This fixture opens no browser'); } }),
  context: async () => ({ cwd: project, rendererId: 'fixture-thread', engineId: sessionId || undefined, generation: engine.generation }),
  isCurrent: context => context.engineId === (sessionId || undefined) && context.generation === engine.generation,
  connectReadyServers: async context => { assertEqual(context.rendererId, 'fixture-thread', 'live reload retains renderer identity'); return (await service.resolvedServerSet(context.cwd)).servers; },
  request: (method, params) => request(method, params), requestAcknowledged: (method, params, field) => requestAcknowledged(engine.client, method, params, field, 20_000),
  openExternal: async () => { throw new Error('This fixture opens no browser'); }, onStatusChanged: () => {},
});
const fixtureScript = String.raw`
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
appendFileSync(process.argv[2], String(process.pid) + '\n');
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'klaus-config-fixture', version: '1' } };
  else if (message.method === 'ping') result = {};
  else if (message.method === 'tools/list') result = { tools: ['echo', 'write'].map(name => ({ name, description: name + ' fixture', inputSchema: { type: 'object', properties: {} } })) };
  else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'fixture response' }] };
  else if (message.method === 'prompts/list') result = { prompts: [{ name: 'summary', description: 'Summarize fixture', arguments: [] }] };
  else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
input.on('close', () => process.exit(0));
`;
const definition = (): JsonObject => ({ command: process.execPath, args: [serverFile, pidFile], env: { ELECTRON_RUN_AS_NODE: '1' }, alwaysLoad: true });
async function attach(): Promise<void> {
  engine = await manager.attach({ command: binary!, args: [], cwd: root, env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')]] });
  request = (method, params) => engine.client.requestWithTimeout(method, params, 20_000);
}
async function runtime(): Promise<JsonObject[]> {
  const reply = object(await request('session/mcpRuntime', { sessionId })), servers = object(object(reply.mcpRuntime).runtime).servers;
  assert(Array.isArray(servers), 'named runtime reply carries mcpRuntime.runtime.servers: ' + JSON.stringify(reply));
  return servers as JsonObject[];
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };

h.test('live MCP user mutations persist through named versioned config writes', async () => {
  await mkdir(project); await writeFile(serverFile, fixtureScript); workspaces.projectsAdd({ path: project }); await attach();
  assertEqual(object(await service.create({ name: 'fixture', ...definition() })).ok, true, 'real user create');
  assertEqual(object(await service.create({ name: 'off', command: 'disabled-fixture-never-starts' })).ok, true, 'second declaration');
  assertEqual(object(await service.toggle({ name: 'off', enabled: false })).ok, true, 'real disabled persistence');
  const snapshot = object(await request('config/read', {})), servers = object(object(snapshot.values).mcpServers);
  assertEqual(object(servers.fixture).command, process.execPath, 'real authoritative stored executable');
  assertEqual(object(servers.off).enabled, false, 'real stored disabled sentinel'); assert(typeof snapshot.version === 'string', 'version returned by the actual engine');
});
h.test('live local config uses escaped canonical keys and project config keeps its separate disk schema', async () => {
  const legacy = project + '/./';
  await request('config/batchWrite', { edits: [{ keyPath: 'projects', value: { [legacy]: { marker: 'retain', mcpServers: { shared: { command: 'old' } } } }, mergeStrategy: 'replace' }] });
  assertEqual(object(await service.scopeMutate('local', 'update', { cwd: project, name: 'shared', config: { command: 'local-disabled', enabled: false } })).ok, true, 'quoted local path mutation');
  const projects = object(object(object(await request('config/read', {})).values).projects);
  assertEqual(projects[legacy], undefined, 'real old alias deleted'); assertEqual(object(projects[project]).marker, 'retain', 'unrelated project metadata retained');
  assertEqual(object(object(object(projects[project]).mcpServers).shared).enabled, false, 'real canonical key used');
  assertEqual(object(await service.scopeMutate('project', 'create', { cwd: project, name: 'project-off', config: { command: 'project-disabled', enabled: false } })).ok, true, 'real project disk mutation');
  assertEqual(await readFile(join(project, '.klaus/mcp.json'), 'utf8'), JSON.stringify({ mcpServers: { 'project-off': { command: 'project-disabled', enabled: false } } }, null, 2), 'project file contract');
});
h.test('resolved MCP declarations connect the actual stdio fixture and exclude disabled scopes', async () => {
  const declarations = await service.resolvedServerSet(project);
  assertDeepEqual(declarations.servers.map(server => server.name), ['fixture'], 'only enabled declaration admitted');
  const started = object(await request('session/start', { init: { cwd: project, threadId: 'fixture-thread', hostCapabilities: { mcpServers: declarations.servers, runtimeCapabilityRoots: [] } }, resume: null, fork: null }));
  sessionId = string(started.sessionId); assert(sessionId, 'real session initialized'); await request('session/subscribe', { sessionId });
  await waitFor(async () => (await runtime()).some(server => server.name === 'fixture' && server.state === 'ready'), 15_000, 'stdio tools connected');
  const servers = await runtime(); assertDeepEqual(servers.map(server => server.name), ['fixture'], 'no disabled process registered');
  assertDeepEqual((servers[0]?.tools as JsonObject[]).map(tool => tool.name).sort(), ['mcp__fixture__echo', 'mcp__fixture__write'], 'real tools loaded from the fixture');
  const status = await runtimeService.status() as JsonObject[]; assertEqual(status.find(row => row.name === 'fixture')?.status, 'connected', 'actual renderer status projection');
  assertEqual(runtimeService.promptRows('fixture-thread')[0]?.name, 'mcp:fixture:summary', 'prompt cache comes from the actual engine connection');
  reloadChanges = true;
});
h.test('tool denial and server disable reach live reload terminal outcomes and close real child processes', async () => {
  assertEqual(object(await service.setToolEnabled({ name: 'fixture', toolName: 'write', enabled: false })).ok, true, 'durable tool denial and terminal reload');
  await waitFor(async () => { const rows = await runtime(); return rows[0]?.state === 'ready' && (rows[0].tools as JsonObject[]).length === 1; }, 15_000, 'live filter applied');
  assertEqual(((await runtime())[0]?.tools as JsonObject[])[0]?.name, 'mcp__fixture__echo', 'disabled write tool absent');
  const status = await runtimeService.status() as JsonObject[], denied = (status.find(row => row.name === 'fixture')?.tools as JsonObject[]).find(tool => tool.name === 'mcp__fixture__write');
  assertEqual(denied?.enabled, false, 'runtime projection restores the actual denied tool as an off switch');
  assertEqual(object(await service.toggle({ name: 'fixture', enabled: false })).ok, true, 'server disable includes awaited reload');
  await waitFor(async () => !(await runtime()).length, 10_000, 'all declarations disconnected');
  const pids = (await readFile(pidFile, 'utf8')).trim().split('\n').map(Number); assert(pids.length > 0, 'actual child process ran');
  await waitFor(() => pids.every(pid => !alive(pid)), 10_000, 'all fixture processes reaped after disable');
});
h.test('one-owner endpoint restart retains user local and project MCP configuration', async () => {
  reloadChanges = false; if (sessionId) await request('session/close', { sessionId }); sessionId = '';
  const generation = engine.generation; await manager.release(engine.key); assertEqual(manager.liveProcessCount(), 0, 'old endpoint exited'); await attach();
  assert(engine.generation > generation, 'replacement owner advances generation'); assertEqual(manager.liveProcessCount(), 1, 'one actual engine process');
  const declarations = await service.resolvedServerSet(project); assertDeepEqual(declarations.servers, [], 'disabled user and scoped declarations survive restart');
  assertEqual(declarations.skipped.length, 4, 'all persisted sources loaded');
  assertEqual((await service.sessionStatus({ sessionId: 'fixture-thread' }) as JsonObject[]).length, 4, 'passive status resolves existing thread cwd');
  assertEqual(changes, 7, 'one notification for each durable change');
});
h.test('live MCP teardown drains the service and the only engine owner', async () => {
  await runtimeService.close(); await service.close(); await manager.shutdownAll(); assertEqual(manager.liveProcessCount(), 0, 'no remaining engine');
});
void h.finish(join(__dirname, 'mcp-configuration-live-result.json'), 'mcp-configuration-live').then(async code => {
  await runtimeService.close(); await service.close(); await manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); process.exitCode = code;
}, async error => { await runtimeService.close(); await service.close(); await manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); throw error; });
