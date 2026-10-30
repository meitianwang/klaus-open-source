import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { EngineSettings } from '../main/services/engine-settings';
import { object } from '../main/services/service-types';
import type { RuntimeConfigScope, RuntimeSettingKey } from '../contracts/runtime-settings';
import { Harness } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('An explicit KLAUS_ENGINE_BINARY is required');
const h = new Harness();
const environmentKeys = ['KLAUS_CONFIG_DIR', 'KLAUS_SESSION_DIR', 'KLAUS_PLUGIN_HOME'] as const;

process.exitCode = 1;
void (async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-runtime-settings-live-'));
  const configRoot = join(root, 'config'), project = join(root, 'Project With Spaces');
  const savedEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const manager = new EngineManager('0.0.0-runtime-settings-fixture');
  let engine: ManagedEngine;
  const settings = new EngineSettings((method, params) => engine.client.requestWithTimeout(method, params, 15_000));
  const global: RuntimeConfigScope = { kind: 'user' }, scoped: RuntimeConfigScope = { kind: 'project', cwd: project };
  const attach = async () => {
    engine = await manager.attach({ command: binary, args: [], cwd: project, env: [] });
    assert.equal(manager.liveProcessCount(), 1);
  };
  const save = async (key: RuntimeSettingKey, value: string, scope: RuntimeConfigScope = global) => {
    const snapshot = await settings.runtimeSnapshot(scope);
    await settings.writeRow(key, value, { scope, expectedVersion: snapshot.version });
    return settings.runtimeSnapshot(scope);
  };
  try {
    for (const path of [configRoot, project]) await mkdir(path, { recursive: true });
    process.env.KLAUS_CONFIG_DIR = configRoot;
    process.env.KLAUS_SESSION_DIR = join(configRoot, 'sessions');
    process.env.KLAUS_PLUGIN_HOME = join(configRoot, 'plugins');
    console.log('engine_binary_sha256=' + createHash('sha256').update(await readFile(binary)).digest('hex'));
    await attach();

    await h.test('empty actual configuration uses coherent sandbox, approval, search and model defaults', async () => {
      const raw = await settings.configSnapshot(global), snapshot = await settings.runtimeSnapshot(global);
      assert.equal(resolve(snapshot.path), join(configRoot, 'config.toml'));
      console.log('isolated_empty_config=' + JSON.stringify(raw));
      console.log('isolated_runtime_defaults=' + JSON.stringify(snapshot));
      assert.equal(snapshot.effective['klaus.approvalPolicy'], 'on-request');
      assert.equal(snapshot.effective['klaus.sandboxMode'], 'read-only');
      assert.equal(snapshot.effective['klaus.sandbox.networkAllowed'], 'off');
      assert.equal(snapshot.effective['klaus.webSearch.access'], 'cached');
      assert.equal(snapshot.effective['klaus.modelVerbosity'], null);
      assert.equal(snapshot.effective['klaus.reasoningSummary'], 'auto');
      assert.equal(snapshot.effective['klaus.subagentModelCatalog'], 'off');
    });
    await h.test('unspecified search access follows the actual sandbox configuration', async () => {
      assert.equal((await save('klaus.sandboxMode', 'danger-full-access')).effective['klaus.webSearch.access'], 'live');
      assert.equal((await save('klaus.sandboxMode', 'workspace-write')).effective['klaus.webSearch.access'], 'cached');
      await settings.writeRow('klaus.webSearch.source', 'native');
      const snapshot = await settings.runtimeSnapshot(global);
      assert.equal(snapshot.values['klaus.webSearch.access'], null);
      assert.equal(snapshot.effective['klaus.webSearch.access'], 'cached');
    });
    await h.test('all five settings persist through the actual named config facade', async () => {
      for (const [key, value] of [
        ['klaus.approvalPolicy', 'never'], ['klaus.sandboxMode', 'read-only'],
        ['klaus.webSearch.access', 'indexed'], ['klaus.modelVerbosity', 'high'], ['klaus.reasoningSummary', 'detailed'],
        ['klaus.subagentModelCatalog', 'on'],
      ] as const) {
        const snapshot = await save(key, value);
        assert.equal(snapshot.values[key], value);
        assert.equal(snapshot.effective[key], value);
      }
      const disk = await readFile(join(configRoot, 'config.toml'), 'utf8');
      assert.match(disk, /approval_policy\s*=\s*["']never["']/u);
      assert.match(disk, /reasoningSummary\s*=\s*["']detailed["']/u);
      assert.match(disk, /subagentModelCatalog\s*=\s*true/u);
      const resolved = await settings.resolved(project);
      assert.equal(resolved.modelVerbosity, 'high');
      assert.equal(object(resolved.webSearch).access, 'indexed');
    });
    await h.test('actual stale config revisions reject without overwriting a newer selection', async () => {
      const stale = await settings.runtimeSnapshot(global);
      await save('klaus.reasoningSummary', 'concise');
      await assert.rejects(settings.writeRow('klaus.reasoningSummary', 'none', { scope: global, expectedVersion: stale.version }));
      assert.equal((await settings.runtimeSnapshot(global)).values['klaus.reasoningSummary'], 'concise');
    });
    await h.test('project settings inherit explicit user values and preserve local ownership', async () => {
      assert.equal(await settings.ensureConfigFile(scoped), join(project, '.klaus', 'config.toml'));
      await save('klaus.modelVerbosity', 'low', scoped);
      await save('klaus.subagentModelCatalog', 'off', scoped);
      const local = await settings.runtimeSnapshot(scoped);
      assert.equal(local.values['klaus.modelVerbosity'], 'low');
      assert.equal(local.values['klaus.reasoningSummary'], null);
      assert.equal(local.effective['klaus.reasoningSummary'], 'concise');
      assert.equal((await settings.runtimeSnapshot(global)).values['klaus.modelVerbosity'], 'high');
      assert.equal(local.effective['klaus.subagentModelCatalog'], 'off');
      assert.equal((await settings.runtimeSnapshot(global)).effective['klaus.subagentModelCatalog'], 'on');
      await settings.writeRow('klaus.webSearch.allowedDomains', 'example.com');
      await settings.writeRow('klaus.webSearch.blockedDomains', 'blocked.example.com');
      await settings.writeRow('klaus.webSearch.maxUses', '3');
      await save('klaus.webSearch.access', 'cached', scoped);
      assert.equal(await settings.row('klaus.webSearch.source', scoped), 'native');
      assert.equal(await settings.row('klaus.webSearch.allowedDomains', scoped), 'example.com');
      assert.equal(await settings.row('klaus.webSearch.blockedDomains', scoped), 'blocked.example.com');
      assert.equal(await settings.row('klaus.webSearch.maxUses', scoped), '3');
    });
    await h.test('explicit freshness survives every actual config read without collapsing modes', async () => {
      for (const value of ['disabled', 'cached', 'indexed', 'live']) {
        const snapshot = await save('klaus.webSearch.access', value);
        assert.equal(snapshot.values['klaus.webSearch.access'], value);
        assert.equal(object((await settings.resolved(project)).webSearch).access, 'cached');
        assert.equal(await settings.row('klaus.webSearch.enabled'), value === 'disabled' ? 'off' : 'on');
      }
    });
    await h.test('the existing search toggle restores each actual selected freshness mode', async () => {
      for (const value of ['cached', 'indexed', 'live']) {
        await save('klaus.webSearch.access', value);
        await settings.writeRow('klaus.webSearch.enabled', 'off');
        assert.equal((await settings.runtimeSnapshot(global)).effective['klaus.webSearch.access'], 'disabled');
        await settings.writeRow('klaus.webSearch.enabled', 'on');
        assert.equal((await settings.runtimeSnapshot(global)).effective['klaus.webSearch.access'], value);
        assert.equal(await settings.row('klaus.webSearch.source'), 'native');
      }
    });
    await h.test('clearing verbosity restores model default while sandbox-derived search remains independent', async () => {
      const snapshot = await save('klaus.modelVerbosity', '');
      assert.equal(snapshot.values['klaus.modelVerbosity'], null);
      assert.equal(snapshot.effective['klaus.modelVerbosity'], null);
      assert.equal(snapshot.values['klaus.webSearch.access'], 'live');
    });
    await h.test('an actual engine restart restores user and project values exactly', async () => {
      await manager.release(engine.key);
      await attach();
      const user = await settings.runtimeSnapshot(global), local = await settings.runtimeSnapshot(scoped);
      assert.equal(user.values['klaus.approvalPolicy'], 'never');
      assert.equal(user.values['klaus.sandboxMode'], 'read-only');
      assert.equal(user.values['klaus.modelVerbosity'], null);
      assert.equal(user.values['klaus.webSearch.access'], 'live');
      assert.equal(local.values['klaus.modelVerbosity'], 'low');
      assert.equal(local.effective['klaus.reasoningSummary'], 'concise');
      assert.equal(local.effective['klaus.webSearch.access'], 'cached');
      assert.equal(user.effective['klaus.subagentModelCatalog'], 'on');
      assert.equal(local.effective['klaus.subagentModelCatalog'], 'off');
    });
    await h.test('shutdown releases the actual isolated engine process', async () => {
      await manager.shutdownAll();
      assert.equal(manager.liveProcessCount(), 0);
    });
  } finally {
    await manager.shutdownAll();
    for (const key of environmentKeys) {
      if (savedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[key];
    }
    await rm(root, { recursive: true, force: true });
    console.log('runtime_settings_fixture_cleanup=removed');
  }
  process.exitCode = await h.finish(join(__dirname, 'runtime-settings-live-result.json'), 'runtime-settings-live');
})().catch(error => { console.error(error); process.exitCode = 1; });
