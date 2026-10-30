// Actual engine persistence plus loopback device authorization. No provider account or browser.
import assert from 'node:assert/strict';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { McpBuiltinService } from '../main/services/mcp/builtins';
import { McpConfigurationService } from '../main/services/mcp/configuration';
import { resolveMcpDeviceClientId } from '../main/services/mcp/device';
import { object, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { WorkspaceStore } from '../main/services/workspaces';
import { Harness, waitFor } from './harness';
import { deferred, deviceFixture } from './mcp-device-fixture';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the MCP device persistence gate');
const h = new Harness();

void (async () => {
  let builtins!: McpBuiltinService, engine!: ManagedEngine;
  const f = await deviceFixture({ catalog: () => builtins.catalog(), install: (payload, signal) => builtins.install(payload, signal) });
  const manager = new EngineManager('0.0.0-mcp-device-live'), home = join(f.temp, 'home');
  const request: EngineRequest = (method, params) => engine.client.requestWithTimeout(method, params, 15_000);
  const workspaces = new WorkspaceStore({ configRoot: f.root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null });
  let changes = 0, holdReload = false, queueHeld = false;
  const held = deferred();
  const configuration = new McpConfigurationService({ workspaces, request, onChanged: async () => { changes++; if (holdReload) { queueHeld = true; await held.promise; } } });
  const seed: JsonObject[] = [{ id: 'github', auth: 'apikey', config: { type: 'http', url: f.origin + '/mcp', headers: { Authorization: 'Bearer ${GITHUB_PAT}' } }, envKeys: [{ key: 'GITHUB_PAT', secret: true }],
    deviceAuth: { provider: 'github', scope: 'repo read:org read:user', tokenEnvKey: 'GITHUB_PAT', defaultClientId: 'fixture-public-client', registerUrl: f.origin + '/register' } }];
  builtins = new McpBuiltinService({ configRoot: f.root, mcp: configuration, endpoint: () => undefined, seed,
    deviceClientId: (id, catalog) => resolveMcpDeviceClientId(f.root, id, catalog, {}), log: () => {} });
  const attach = async () => { await mkdir(f.root, { recursive: true }); await mkdir(home, { recursive: true }); engine = await manager.attach({ command: binary, args: [], cwd: f.root,
    env: [['HOME', home], ['USERPROFILE', home], ['XDG_CONFIG_HOME', join(home, '.config')], ['KLAUS_CONFIG_DIR', f.root], ['KLAUS_SESSION_DIR', join(f.root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(f.root, 'plugins')]] }); };
  const servers = async () => object(object(object(await request('config/read', {})).values).mcpServers);
  const tokenOf = (rows: JsonObject) => object(object(rows.github).headers).Authorization;
  try {
    await h.test('device grant and ordinary MCP creation share actual versioned engine persistence', async () => {
      await attach(); assert.equal(manager.liveProcessCount(), 1);
      const rows = await builtins.list() as JsonObject[]; assert.equal(object(rows[0]!.deviceAuth).ready, true);
      assert.equal(object(await f.service.start({ id: 'github' })).ok, true);
      const [authorized, ordinary] = await Promise.all([f.service.wait({ id: 'github' }), configuration.create({ name: 'ordinary', type: 'http', url: f.origin + '/other-mcp' })]);
      assert.deepEqual(authorized, { ok: true }); assert.equal(object(ordinary).ok, true);
      const stored = await servers(); assert.equal(tokenOf(stored), 'Bearer fixture-access-fixture-device-1');
      assert.equal(object(stored.ordinary).url, f.origin + '/other-mcp'); assert.equal(changes, 2);
    });
    await h.test('real reauthorization replaces only declared credential slots and restores enabled state', async () => {
      const old = object((await servers()).github);
      assert.equal(object(await configuration.update({ name: 'github', config: { ...old, headers: { ...object(old.headers), Extra: 'keep' }, disabledTools: ['write'], timeout: 37 } })).ok, true);
      assert.equal(object(await configuration.toggle({ name: 'github', enabled: false })).ok, true);
      assert.equal(object(await f.service.start({ id: 'github' })).ok, true); assert.deepEqual(await f.service.wait({ id: 'github' }), { ok: true });
      const stored = await servers(), github = object(stored.github);
      assert.equal(tokenOf(stored), 'Bearer fixture-access-fixture-device-2'); assert.equal(object(github.headers).Extra, 'keep');
      assert.deepEqual(github.disabledTools, ['write']); assert.equal(github.timeout, 37); assert.equal(github.enabled, undefined);
      assert.equal(object((await builtins.list() as JsonObject[])[0]!).enabled, true);
      assert((await readdir(f.root)).every(name => !/device.*(json|token)/i.test(name)), 'device service creates no second credential ledger');
    });
    await h.test('restarting the one engine preserves the new credential and unrelated MCP policy', async () => {
      const before = await servers(), generation = engine.generation;
      await manager.release(engine.key); assert.equal(manager.liveProcessCount(), 0); await attach();
      assert(engine.generation > generation); assert.equal(manager.liveProcessCount(), 1); assert.deepEqual(await servers(), before);
    });
    await h.test('cancelling behind the actual shared mutation queue prevents a stale credential write', async () => {
      holdReload = true;
      const barrier = configuration.create({ name: 'barrier', type: 'http', url: f.origin + '/barrier-mcp' });
      await waitFor(() => queueHeld, 3000, 'ordinary config mutation holds its real reload boundary');
      await f.service.start({ id: 'github' }); const waiting = f.service.wait({ id: 'github' });
      await waitFor(() => f.installs.length === 3, 3000, 'device token reached the real built-in queue');
      f.service.cancel({ id: 'github' }); assert.deepEqual(await waiting, { ok: false, error: 'cancelled' });
      holdReload = false; held.resolve(); assert.equal(object(await barrier).ok, true);
      await f.service.close();
      const stored = await servers(); assert.equal(tokenOf(stored), 'Bearer fixture-access-fixture-device-2'); assert.equal(object(stored.barrier).url, f.origin + '/barrier-mcp');
    });
    await h.test('device and MCP shutdown leave no extra engine or external HTTP operation', async () => {
      await f.service.close(); await builtins.close(); await configuration.close(); await manager.shutdownAll();
      assert.equal(manager.liveProcessCount(), 0); assert(f.requests.every(row => row.path === '/login/device/code' || row.path === '/login/oauth/access_token'));
    });
  } finally { holdReload = false; held.resolve(); await f.service.close(); await builtins.close(); await configuration.close(); await manager.shutdownAll(); await f.close(); }
  process.exitCode = await h.finish(join(__dirname, 'mcp-device-live-result.json'), 'mcp-device-live');
})();
