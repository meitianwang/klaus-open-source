import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { requestAcknowledged } from '../main/engine/acknowledged';
import { PluginService } from '../main/services/extensions/plugins';
import { PluginMarketplaceService } from '../main/services/extensions/marketplaces';
import { object, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { Harness } from './harness';
import { localRepository, marketFixture, put, zip } from './extension-market-fixture';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the isolated marketplace facade gate');
const h = new Harness();
void (async () => {
  const f = await marketFixture(), manager = new EngineManager('0.0.0-market-fixture');
  let engine: ManagedEngine, changed = 0;
  const request: EngineRequest = (method, params) => engine.client.requestWithTimeout(method, params, 10_000);
  const plugins = new PluginService({ configRoot: f.root, request,
    requestAcknowledged: (method, params, field) => requestAcknowledged(engine.client, method, params, field, 10_000),
    binding: () => undefined, resolveSession: async () => { throw new Error('This gate must not create a model session'); }, onChanged: () => { throw new Error('This gate must not mutate installed plugins'); } });
  const marketplaces = new PluginMarketplaceService({ workspaces: f.workspaces, plugins, request, environment: f.environment, gitOptions: { env: f.environment },
    onChanged: () => { changed++; } });
  const attach = async () => {
    engine = await manager.attach({ command: binary, args: [], cwd: f.root, env: [['HOME', f.root], ['USERPROFILE', f.root], ['XDG_CONFIG_HOME', join(f.root, 'xdg')],
      ['KLAUS_CONFIG_DIR', f.root], ['KLAUS_SESSION_DIR', join(f.root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(f.root, 'plugins')]] });
  };
  try {
    await h.test('the real engine confirms a marketplace write without installing a plugin', async () => {
      await attach(); assert.equal(manager.liveProcessCount(), 1);
      const source = join(f.root, 'local'); await put(join(source, '.claude-plugin/marketplace.json'), JSON.stringify({ name: 'local', plugins: [] }));
      const before = object(object(await request('config/read', {})).values).plugins;
      const result = object(await marketplaces.add({ source })); assert.equal(result.ok, true, JSON.stringify(result));
      const values = object(object(await request('config/read', {})).values);
      assert.equal(object(object(values.marketplaces).local).installLocation, source); assert.deepEqual(values.plugins, before);
    });
    await h.test('a real local Git acquisition remains installable while its unpublished row stays hidden', async () => {
      const repo = await localRepository(f.root, 'live-git', 'live-git');
      const result = object(await marketplaces.add({ source: repo.url })); assert.equal(result.ok, true, JSON.stringify(result));
      const values = object(object(await request('config/read', {})).values), target = String(object(object(values.marketplaces)['live-git']).installLocation);
      assert.deepEqual(JSON.parse(await readFile(join(target, 'plugins/fixture/.claude-plugin/plugin.json'), 'utf8')), { name: 'fixture', version: '1.0.0' });
      const catalog = await plugins.catalog.snapshot(); assert(catalog.rows.some(row => row.id === 'fixture@live-git'));
      const publicRows = object(await plugins.market()).plugins as JsonObject[];
      assert.equal(publicRows.some(row => row.id === 'fixture@live-git'), false);
    });
    await h.test('official mirror refresh persists through the real facade and survives an endpoint restart', async () => {
      const official = 'claude-plugins-official', sha = 'b'.repeat(40);
      const bytes = zip([{ name: 'marketplaces/' + official + '/.claude-plugin/marketplace.json', bytes: Buffer.from(JSON.stringify({ name: official, plugins: [] })) }]);
      f.route((request, response) => { if (request.url === '/latest') response.end(sha); else response.end(bytes); });
      const refreshed = object(await marketplaces.refresh()); assert.deepEqual(refreshed.official, { ok: true, sha });
      await manager.release(engine.key); assert.equal(manager.liveProcessCount(), 0); await attach();
      const values = object(object(await request('config/read', {})).values);
      assert.equal(object(object(values.marketplaces)[official]).gcsSha, sha); assert.equal(changed, 3); assert.equal(manager.liveProcessCount(), 1);
    });
    await h.test('marketplace services drain their work and the single engine owner exits', async () => {
      await marketplaces.close(); await plugins.close(); await manager.shutdownAll(); assert.equal(manager.liveProcessCount(), 0);
    });
  } finally {
    await marketplaces.close(); await plugins.close(); await manager.shutdownAll(); await f.close();
  }
  process.exitCode = await h.finish(join(__dirname, 'extension-market-live.result.json'), 'extension-market-live');
})();
