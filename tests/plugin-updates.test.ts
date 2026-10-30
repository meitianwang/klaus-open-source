import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerPluginHandlers } from '../main/ipc/handlers/plugins';
import { newerPluginVersion } from '../main/services/extensions/plugin-catalog';
import { PluginService, type PluginChange, type PluginDeps } from '../main/services/extensions/plugins';
import { PluginSources } from '../main/services/extensions/plugin-sources';
import { pluginIconDataUrl, readPluginIcon, PLUGIN_ICON_LIMIT } from '../main/services/extensions/plugin-icons';
import { object, string, type JsonObject } from '../main/services/service-types';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness();
const evidence = join(__dirname, '..', 'plugin-update-logs');
mkdirSync(evidence, { recursive: true });
async function document(path: string, data: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data)); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
interface Fixture {
  root: string; market: string; source: string; installed: string; ledger: JsonObject; values: JsonObject;
  service: PluginService; registry: ChannelRegistry; notices: PluginChange[]; calls: Array<{ method: string; params: JsonObject; field?: string }>;
  failureLogs: JsonObject[];
  writeSource(version: string, name?: string): Promise<void>; clean(): Promise<void>;
  terminal: (params: JsonObject) => Promise<unknown>;
  changed: (change: PluginChange) => void | Promise<void>;
}
async function fixture(version = '1.0.0', available = '2.0.0', enabled = false): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'klaus-plugin-update-')), market = join(root, 'market'), source = join(market, 'plugins/fixture'), installed = join(root, 'engine-owned/fixture');
  const ledger: JsonObject = { 'fixture@local': { name: 'fixture', version, enabled, source: 'marketplace:local', installPath: installed } };
  const values: JsonObject = { marketplaces: { local: { installLocation: market } }, plugins: { 'untrusted@legacy': { version: '99.0.0', enabled: true } } };
  await document(join(market, '.codex-plugin/marketplace.json'), { name: 'local', plugins: [{ name: 'fixture', version: '0.1.0', description: 'Stale marketplace summary', source: './plugins/fixture' }] });
  await document(join(installed, '.codex-plugin/plugin.json'), { name: 'fixture', version, description: 'Installed package' });
  await mkdir(join(installed, 'skills/demo'), { recursive: true }); await writeFile(join(installed, 'skills/demo/SKILL.md'), 'Installed bytes must remain untouched by the host.\n');
  const notices: PluginChange[] = [], calls: Fixture['calls'] = [], registry = new ChannelRegistry();
  const failureLogs: JsonObject[] = [];
  let f!: Fixture;
  const deps: PluginDeps = {
    configRoot: root,
    failureLog: info => { failureLogs.push(info); return join(root, 'plugin-failure.log'); },
    request: async (method, params) => {
      calls.push({ method, params: structuredClone(object(params)) });
      if (method === 'config/read') return { values: structuredClone(values), version: 'fixture-config' };
      if (method === 'session/installedPlugins') return { installedPlugins: { version: 1, plugins: structuredClone(ledger) } };
      throw new Error('Host must not write plugin state or use an unnamed facade: ' + method);
    },
    requestAcknowledged: async (method, params, field) => {
      calls.push({ method, params: structuredClone(params), field });
      if (method === 'session/pluginCatalog') return { entries: [{ id: 'fixture@local', contributions: { skills: ['demo'] } }] };
      assertEqual(method, 'session/installPlugin', 'Only one named install facade writes the update');
      assertEqual(field, 'pluginMutation', 'Wait for the terminal mutation field');
      return f.terminal(params);
    },
    binding: () => undefined, resolveSession: async () => { throw new Error('Updates cannot create a conversation'); }, onChanged: async change => { notices.push(change); await f.changed(change); },
  };
  const service = registerPluginHandlers(registry, deps);
  f = {
    root, market, source, installed, ledger, values, service, registry, notices, calls, failureLogs, changed: () => {},
    terminal: async params => {
      const path = string(params.sourceDir); assert(await exists(path), 'Staged files exist during the actual facade call');
      const manifest = JSON.parse(await readFile(join(path, '.codex-plugin/plugin.json'), 'utf8'));
      assertEqual(manifest.name, 'fixture', 'Staged package identity'); assertEqual(params.version, manifest.version, 'Facade receives actual staged version');
      assertEqual(await readFile(join(path, 'skills/demo/SKILL.md'), 'utf8'), 'New release content\n', 'Real source bytes were staged');
      return { persisted: true, restartRequired: false, activationScope: 'next_turn', appliedToCurrentSession: false };
    },
    writeSource: async (next, name = 'fixture') => {
      await document(join(source, '.codex-plugin/plugin.json'), { name, version: next, description: 'Actual package release', skills: ['./skills'] });
      await mkdir(join(source, 'skills/demo'), { recursive: true }); await writeFile(join(source, 'skills/demo/SKILL.md'), 'New release content\n');
    },
    clean: async () => { await service.close(); rmSync(root, { recursive: true, force: true }); },
  };
  await f.writeSource(available); return f;
}
const installCalls = (f: Fixture) => f.calls.filter(call => call.method === 'session/installPlugin');
async function noStages(f: Fixture): Promise<void> {
  const path = join(f.root, 'plugins/staging'); assertDeepEqual(await exists(path) ? await readdir(path) : [], [], 'All host staging directories are removed');
  assertEqual(existsSync(join(f.root, 'plugins/installed_plugins.json')), false, 'Host never creates an engine-owned ledger');
}
async function failure(f: Fixture, payload: JsonObject, pattern: RegExp): Promise<void> {
  const ledger = structuredClone(f.ledger), installedBytes = await readFile(join(f.installed, 'skills/demo/SKILL.md'));
  const result = object(await f.service.update(payload)); assertEqual(result.ok, false, 'Update reports failure'); assert(pattern.test(string(result.error)), `Expected ${pattern}, got ${JSON.stringify(result)}`);
  assertDeepEqual(f.ledger, ledger, 'Host does not change the authoritative installed record'); assertDeepEqual(await readFile(join(f.installed, 'skills/demo/SKILL.md')), installedBytes, 'Host leaves installed bytes untouched');
  assertEqual(f.notices.length, 0, 'No successful invalidation on failure'); await noStages(f);
}
async function withStageHook(f: Fixture, hook: (staged: Awaited<ReturnType<PluginSources['stage']>>) => Promise<void>, action: () => Promise<void>): Promise<void> {
  const original = PluginSources.prototype.stage;
  PluginSources.prototype.stage = async function(entry, location) { const staged = await original.call(this, entry, location); await hook(staged); return staged; };
  try { await action(); } finally { PluginSources.prototype.stage = original; }
}

h.test('plugin artwork stays package-owned and rereads edited assets without application writes', async () => {
  const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/plugin-icon-vectors.json'), 'utf8'));
  const f = await fixture(), bytes = Buffer.from(vector.iconDataUrl.split(',')[1], 'base64');
  try {
    assertEqual(PLUGIN_ICON_LIMIT, vector.maxBytes, 'committed artwork size limit');
    await mkdir(join(f.source, 'assets'), { recursive: true });
    await writeFile(join(f.source, 'assets/icon.png'), bytes);
    await document(join(f.source, '.codex-plugin/plugin.json'), { ...vector.manifest, version: '2.0.0' });
    assertEqual(await readPluginIcon(f.source, vector.manifest), vector.iconDataUrl, 'package-relative artwork');
    const market = object(await f.service.market());
    assertEqual(object((market.plugins as Json[])[0]).iconDataUrl, vector.iconDataUrl, 'existing market response carries package artwork');
    const changed = Buffer.concat([bytes, Buffer.from([0])]);
    await writeFile(join(f.source, 'assets/icon.png'), changed);
    assertEqual((await f.service.catalog.snapshot()).rows[0]?.iconDataUrl, 'data:image/png;base64,' + changed.toString('base64'), 'refresh reads current asset bytes');
    await document(join(f.installed, '.codex-plugin/plugin.json'), vector.manifest);
    await mkdir(join(f.installed, 'assets'), { recursive: true }); await writeFile(join(f.installed, 'assets/icon.png'), bytes);
    f.values.marketplaces = {};
    assertEqual((await f.service.list({}) as JsonObject[])[0]?.iconDataUrl, vector.iconDataUrl, 'installed plugin works without its marketplace');
    await noStages(f);
    assertEqual(installCalls(f).length, 0, 'artwork reads do not mutate plugin state');
  } finally { await f.clean(); }
});

h.test('invalid or escaping artwork cannot leak paths or hide an otherwise readable plugin', async () => {
  const vector = JSON.parse(await readFile(join(__dirname, '../../contracts/vectors/plugin-icon-vectors.json'), 'utf8'));
  const f = await fixture(), bytes = Buffer.from(vector.iconDataUrl.split(',')[1], 'base64');
  try {
    for (const value of vector.rejectedValues) assertEqual(pluginIconDataUrl(value), undefined, 'unsafe artwork value rejected');
    await mkdir(join(f.source, 'assets'), { recursive: true });
    await writeFile(join(f.root, 'outside.png'), bytes);
    await symlink(join(f.root, 'outside.png'), join(f.source, 'assets/link.png'));
    for (const icon of [...vector.rejectedPaths, './assets/link.png', './assets/missing.png']) {
      await assertRejects(() => readPluginIcon(f.source, { interface: { icon } }), 'invalid icon is refused: ' + icon);
    }
    await writeFile(join(f.source, 'assets/icon.png'), Buffer.alloc(PLUGIN_ICON_LIMIT + 1));
    await assertRejects(() => readPluginIcon(f.source, vector.manifest), 'oversized artwork refused');
    await writeFile(join(f.source, 'assets/icon.png'), '<svg onload="alert(1)"/>');
    await document(join(f.source, '.codex-plugin/plugin.json'), { ...vector.manifest, version: '2.0.0' });
    const row = (await f.service.catalog.snapshot()).rows[0]!;
    assertEqual(row.id, 'fixture@local', 'bad artwork does not remove plugin');
    assertEqual(row.iconDataUrl, undefined, 'bad artwork uses the frontend fallback');
  } finally { await f.clean(); }
});

h.test('SemVer ordering rejects downgrades and equal build metadata while ordering numeric prereleases', () => {
  const cases: Array<[string, string, boolean]> = [
    ['2.10.0', '2.9.0', true], ['2.9.0', '2.10.0', false], ['1.0.0', '1.0.0', false],
    ['1.0.0+published', '1.0.0+installed', false], ['1.0.0-beta.10', '1.0.0-beta.2', true], ['1.0.0-beta.2', '1.0.0-beta.10', false],
    ['1.0.0', '1.0.0-rc.1', true], ['1.0.0-rc.1', '1.0.0', false], ['2.0.0-beta.1', '1.9.9', true],
    ['v1.2.4', '1.2.3', true], ['unknown', '1.0.0', false], ['abcdef123456', '123456abcdef', false], ['1.2', '1.0.0', false], ['1.2.3', '', false],
  ];
  for (const [available, installed, expected] of cases) assertEqual(newerPluginVersion(available, installed), expected, `${installed} -> ${available}`);
});
h.test('local manifests override stale release summaries and installed versions come only from the engine record', async () => {
  const f = await fixture();
  try {
    await document(join(f.installed, '.codex-plugin/plugin.json'), { name: 'fixture', version: '9.0.0' });
    const row = (await f.service.catalog.snapshot()).rows.find(row => row.id === 'fixture@local')!;
    assertEqual(row.installedVersion, '1.0.0', 'Engine installed version'); assertEqual(row.availableVersion, '2.0.0', 'Actual package version'); assertEqual(row.version, '2.0.0', 'Backward compatible release alias');
    assertEqual(row.description, 'Actual package release', 'Actual package description'); assertEqual(row.updateAvailable, true, 'Installed plugin has a newer release'); assertEqual(row.enabled, false, 'Disabled remains discoverable');
  } finally { await f.clean(); }
});
h.test('a newly published local package is discovered without reinstalling or editing the marketplace summary', async () => {
  const f = await fixture('1.0.0', '1.0.0');
  try {
    assertEqual((await f.service.catalog.snapshot()).rows[0]!.updateAvailable, false, 'Initial same release');
    await f.writeSource('1.1.0'); const row = (await f.service.catalog.snapshot()).rows[0]!;
    assertEqual(row.installedVersion, '1.0.0', 'Installed state is unchanged'); assertEqual(row.availableVersion, '1.1.0', 'Publication is visible'); assertEqual(row.updateAvailable, true, 'Update becomes actionable'); assertEqual(installCalls(f).length, 0, 'Discovery does not install');
  } finally { await f.clean(); }
});
h.test('a newer official catalog release remains visible above an older downloaded package', async () => {
  const f = await fixture('1.0.0', '1.0.0');
  try {
    delete f.ledger['fixture@local'];
    f.ledger['fixture@klaus-official'] = { name: 'fixture', version: '1.0.0', enabled: false, source: 'marketplace:klaus-official', installPath: f.installed };
    f.values.marketplaces = { 'klaus-official': { installLocation: f.market } };
    await document(join(f.market, '.codex-plugin/marketplace.json'), { name: 'klaus-official', plugins: [{ name: 'fixture', version: '2.0.0', description: 'Published official release', source: './plugins/fixture' }] });
    const row = (await f.service.catalog.snapshot()).rows.find(row => row.id === 'fixture@klaus-official')!;
    assertEqual(row.availableVersion, '2.0.0', 'The official catalog version survives stale cache enrichment');
    assertEqual(row.description, 'Published official release', 'The official catalog description belongs to the newer release');
    assertEqual(row.installedVersion, '1.0.0', 'Installed state still comes from the engine');
    assertEqual(row.updateAvailable, true, 'The newer official package can be acquired on demand');
    assertEqual(installCalls(f).length, 0, 'Reading the catalog does not install or download');
  } finally { await f.clean(); }
});
h.test('catalog offers mirror SemVer prerelease ordering and never offer a downgrade', async () => {
  const f = await fixture();
  try {
    for (const [installed, available, expected] of [['3.0.0', '2.0.0', false], ['2.0.0-beta.2', '2.0.0-beta.10', true], ['2.0.0', '2.0.0-rc.9', false], ['2.0.0-rc.9', '2.0.0', true], ['2.0.0+one', '2.0.0+two', false], ['unknown', '3.0.0', false]] as Array<[string, string, boolean]>) {
      object(f.ledger['fixture@local']).version = installed; await f.writeSource(available);
      const row = (await f.service.catalog.snapshot()).rows[0]!; assertEqual(row.updateAvailable, expected, `${installed} -> ${available} catalog availability`);
    }
  } finally { await f.clean(); }
});
h.test('orphans and builtins remain manageable without presenting unsupported update actions', async () => {
  const f = await fixture();
  try {
    f.ledger['orphan@retired'] = { name: 'orphan', version: '1.0.0', installPath: f.installed, enabled: true };
    f.ledger['browser@builtin'] = { name: 'browser', source: 'builtin', version: '1.0.0', installPath: f.installed, enabled: false };
    const rows = (await f.service.catalog.snapshot()).rows; for (const id of ['orphan@retired', 'browser@builtin']) { const row = rows.find(row => row.id === id)!; assert(row.installed === true, 'Installed orphan remains visible'); assertEqual(row.updateAvailable, false, id + ' is not an actionable release'); }
    assertEqual(rows.find(row => row.id === 'orphan@retired')!.availableVersion, undefined, 'An installed manifest is not an available marketplace release');
    const market = object(await f.service.market()); assert((market.plugins as JsonObject[]).some(row => row.id === 'orphan@retired'), 'Orphan remains in actual marketplace response');
  } finally { await f.clean(); }
});
h.test('the update IPC routes a real staged release through one install facade and invalidates only after persistence', async () => {
  const f = await fixture();
  try {
    const handler = f.registry.lookup('plugins:update'); assert(handler, 'Actual update channel registered');
    const result = object(await handler({ role: 'main', senderId: 1, channel: 'plugins:update', args: [{ id: 'fixture@local', version: '2.0.0', installedVersion: '1.0.0' }] }));
    assertDeepEqual(result, { ok: true, name: 'fixture', restartRequired: false, activationScope: 'next_turn', appliedToCurrentSession: false, updated: true, version: '2.0.0' }, 'Confirmed UI update result');
    const calls = installCalls(f); assertEqual(calls.length, 1, 'One install facade'); assertEqual(calls[0]!.params.marketplace, 'local', 'Same marketplace identity'); assertEqual(calls[0]!.params.version, '2.0.0', 'New staged version');
    assertEqual(calls[0]!.params.expectedInstalledVersion, '1.0.0', 'Engine must reject a removed or replaced installation at commit time');
    assertEqual(f.notices[0]!.id, 'fixture@local', 'Invalidation retains full installed identity'); assertEqual(f.notices[0]!.method, 'session/installPlugin', 'Existing named facade');
    assertEqual(f.calls.some(call => ['session/uninstallPlugin', 'session/setInstalledPluginEnabled', 'config/batchWrite'].includes(call.method)), false, 'Host neither uninstalls nor resets enabled state');
    assertEqual(object(f.ledger['fixture@local']).enabled, false, 'Host leaves disabled ledger state under engine ownership'); await noStages(f);
  } finally { await f.clean(); }
});
h.test('updates reject missing releases and noninstalled entries before calling the engine', async () => {
  const f = await fixture();
  try {
    await failure(f, { id: 'missing@local', version: '2.0.0' }, /not found/i);
    delete f.ledger['fixture@local']; await failure(f, { id: 'fixture@local', version: '2.0.0' }, /not an updatable/i);
    assertEqual(installCalls(f).length, 0, 'No install for missing entries');
  } finally { await f.clean(); }
});
h.test('ordinary fresh installs omit the update-only engine guard', async () => {
  const f = await fixture();
  try {
    delete f.ledger['fixture@local'];
    const installed = object(await f.service.install({ id: 'fixture@local' }));
    assertEqual(installed.ok, true, 'Fresh install remains supported');
    assertEqual(installed.version, '2.0.0', 'The confirmed installation reports the staged package version');
    assertEqual(installCalls(f).length, 1, 'One ordinary install request');
    assertEqual(Object.hasOwn(installCalls(f)[0]!.params, 'expectedInstalledVersion'), false, 'Omitted guard retains the existing install contract');
    await noStages(f);
  } finally { await f.clean(); }
});
h.test('builtin, equal, older and unorderable versions cannot use the update mutation', async () => {
  const f = await fixture();
  try {
    object(f.ledger['fixture@local']).source = 'builtin'; await failure(f, { id: 'fixture@local', version: '2.0.0' }, /not an updatable/i); object(f.ledger['fixture@local']).source = 'marketplace:local';
    for (const next of ['1.0.0', '0.9.0', 'unknown']) { await f.writeSource(next); await failure(f, { id: 'fixture@local', version: next }, /No newer/i); }
    assertEqual(installCalls(f).length, 0, 'No downgrade or bogus release write');
  } finally { await f.clean(); }
});
h.test('stale selected or installed versions require refreshing before any acquisition', async () => {
  const f = await fixture();
  try {
    await failure(f, { id: 'fixture@local', version: '1.9.0', installedVersion: '1.0.0' }, /release changed/i);
    await failure(f, { id: 'fixture@local', version: '2.0.0', installedVersion: '0.9.0' }, /Installed plugin changed/i);
    await failure(f, { id: 'fixture@local' }, /version/i); assertEqual(installCalls(f).length, 0, 'Stale UI cannot dispatch an install');
  } finally { await f.clean(); }
});
h.test('ordinary installs also refuse a staged manifest with a different marketplace identity', async () => {
  const f = await fixture();
  try {
    await f.writeSource('2.0.0', 'different-plugin'); const result = object(await f.service.install({ id: 'fixture@local' })); assertEqual(result.ok, false, 'Identity mismatch refused'); assert(/identity/.test(string(result.error)), 'Explicit identity error');
    assertEqual(installCalls(f).length, 0, 'Wrong plugin never reaches engine'); assertEqual(f.notices.length, 0, 'No invalidation'); await noStages(f);
  } finally { await f.clean(); }
});
h.test('a staged release changing after catalog selection is rejected and cleaned', async () => {
  const f = await fixture();
  const original = PluginSources.prototype.stage;
  try {
    PluginSources.prototype.stage = async function(entry, location) { await f.writeSource('3.0.0'); return original.call(this, entry, location); };
    await failure(f, { id: 'fixture@local', version: '2.0.0' }, /package version changed/i);
    assertEqual(installCalls(f).length, 0, 'Unreviewed release never installs');
  } finally { PluginSources.prototype.stage = original; await f.clean(); }
});
h.test('an installation removed or changed during staging cannot be overwritten by an older request', async () => {
  for (const field of ['version', 'enabled', 'removed']) {
    const f = await fixture();
    try {
      await withStageHook(f, async () => { if (field === 'removed') delete f.ledger['fixture@local']; else object(f.ledger['fixture@local'])[field] = field === 'version' ? '1.5.0' : true; }, async () => {
        const result = object(await f.service.update({ id: 'fixture@local', version: '2.0.0', installedVersion: '1.0.0' })); assertEqual(result.ok, false, `${field} conflict refused`); assert(/Installed plugin changed/.test(string(result.error)), 'Staging race error');
        assertEqual(installCalls(f).length, 0, 'No stale replacement'); assertEqual(f.notices.length, 0, 'No success notice'); await noStages(f);
      });
    } finally { await f.clean(); }
  }
});
h.test('an engine failure keeps installed bytes and desired state while disposing all host staging', async () => {
  const f = await fixture();
  try { f.terminal = async () => { throw new Error('Engine refused replacement'); }; await failure(f, { id: 'fixture@local', version: '2.0.0' }, /Engine refused/); assertEqual(installCalls(f).length, 1, 'One attempted facade call'); }
  finally { await f.clean(); }
});
h.test('a failed update receipt carries the host-written diagnostic log path', async () => {
  const f = await fixture();
  try {
    f.terminal = async () => { throw new Error('Engine refused replacement'); };
    const result = object(await f.service.update({ id: 'fixture@local', version: '2.0.0' }));
    assertEqual(result.ok, false, 'Update reports failure');
    assertEqual(string(result.diagnosticLog), join(f.root, 'plugin-failure.log'), 'Receipt echoes the failure log path');
    assertEqual(f.failureLogs.length, 1, 'One failure record written');
    const record = object(f.failureLogs[0]);
    assertEqual(string(record.action), 'update', 'Record names the action');
    assertEqual(string(record.id), 'fixture@local', 'Record names the plugin');
    assert(/Engine refused/.test(string(record.error)), 'Record keeps the engine error');
  } finally { await f.clean(); }
});
h.test('submission ACKs and nonpersisted replies cannot report a completed update', async () => {
  for (const reply of [{ submissionId: 'queued-only' }, { persisted: false }, { error: 'Install validation failed' }]) {
    const f = await fixture(); try { f.terminal = async () => reply; await failure(f, { id: 'fixture@local', version: '2.0.0' }, /persist|validation failed/i); }
    finally { await f.clean(); }
  }
});
h.test('temporary files remain alive until terminal persistence and are cleaned before update resolves', async () => {
  const f = await fixture(), terminal = deferred(); let entered = false, finished = false, path = '';
  try {
    f.terminal = async params => { entered = true; path = string(params.sourceDir); await terminal.promise; return { persisted: true, restartRequired: true, activationScope: 'endpoint_restart', appliedToCurrentSession: false }; };
    const update = f.service.update({ id: 'fixture@local', version: '2.0.0' }).then(result => { finished = true; return object(result); });
    await waitFor(() => entered, 1000, 'Terminal facade entered'); assertEqual(finished, false, 'Update waits for engine persistence'); assertEqual(f.notices.length, 0, 'No early invalidation'); assert(await exists(path), 'Staged package not removed before engine reads it');
    terminal.resolve(); const result = await update; assertEqual(result.restartRequired, true, 'Activation boundary reaches UI'); assertEqual(f.notices.length, 1, 'One persisted change'); assertEqual(await exists(path), false, 'Cleanup finished before UI success'); await noStages(f);
  } finally { terminal.resolve(); await f.clean(); }
});
h.test('a source escaping its package through a symlink is refused without installed-state changes', async () => {
  const f = await fixture();
  try { await writeFile(join(f.root, 'outside.txt'), 'not part of this plugin'); await symlink(join(f.root, 'outside.txt'), join(f.source, 'escape.txt')); await failure(f, { id: 'fixture@local', version: '2.0.0' }, /symlink outside/i); assertEqual(installCalls(f).length, 0, 'No unsafe source reaches engine'); }
  finally { await f.clean(); }
});

h.test('a persisted update keeps its activation receipt when refreshing the projection fails', async () => {
  const f = await fixture();
  try {
    f.changed = () => { throw new Error('Fixture projection unavailable'); };
    const result = object(await f.service.update({ id: 'fixture@local', version: '2.0.0' }));
    assertEqual(result.ok, true, 'Persistence remains successful');
    assertEqual(result.activationScope, 'next_turn', 'Activation boundary reaches the UI');
    assertEqual(result.appliedToCurrentSession, false, 'Current-session outcome is preserved');
    assertEqual(result.warningCode, 'PLUGIN_PROJECTION_REFRESH_FAILED', 'Projection failure is separately identified');
    assertEqual(installCalls(f).length, 1, 'No replacement is resubmitted');
    await noStages(f);
  } finally { await f.clean(); }
});
h.test('cleanup failure after persistence cannot turn a completed update into a retryable installation failure', async () => {
  const f = await fixture();
  try {
    await withStageHook(f, async staged => {
      const cleanup = staged.cleanup;
      staged.cleanup = async () => { await cleanup(); throw new Error('Fixture cleanup receipt unavailable'); };
    }, async () => {
      const result = object(await f.service.update({ id: 'fixture@local', version: '2.0.0' }));
      assertEqual(result.ok, true, 'Persisted update stays completed');
      assertEqual(result.warningCode, 'PLUGIN_STAGING_CLEANUP_FAILED', 'Cleanup failure stays separate from installation');
      assertEqual(result.version, '2.0.0', 'Installed version remains confirmed');
      await noStages(f);
    });
  } finally { await f.clean(); }
});
h.test('catalog detail metadata remains bounded and belongs to the selected release', async () => {
  const f = await fixture();
  try {
    await document(join(f.source, '.codex-plugin/plugin.json'), { name: 'fixture', version: '2.0.0', releaseNotes: 'A documented change', readme: 'Usage instructions', compatibility: 'macOS', homepage: 'https://example.invalid/plugin' });
    let row = (await f.service.catalog.snapshot()).rows[0]!;
    assertEqual(row.releaseNotes, 'A documented change', 'Declared release notes are available without another package download');
    assertEqual(row.readme, 'Usage instructions', 'Declared documentation is available');
    await document(join(f.source, '.codex-plugin/plugin.json'), { name: 'fixture', version: '2.0.0', readme: 'x'.repeat(64 * 1024 + 1) });
    row = (await f.service.catalog.snapshot()).rows[0]!;
    assertEqual(row.readme, undefined, 'Oversized documentation is omitted');
  } finally { await f.clean(); }
});

void h.finish(join(evidence, 'result.json'), 'plugin-updates').then(code => { process.exitCode = code; });
