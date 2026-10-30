// Explicit live gate: isolated profile, actual plugin persistence, no model turn.
import { mkdtempSync, rmSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { requestAcknowledged } from '../main/engine/acknowledged';
import { PluginService, type PluginChange } from '../main/services/extensions/plugins';
import { object, string, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the live plugin gate');
const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-plugins-live-')), market = join(root, 'market'), packageDir = join(market, 'plugins/fixture');
const manager = new EngineManager('0.0.0-plugin-live');
let request: EngineRequest, acknowledged: (method: string, params: JsonObject, field: string) => Promise<unknown>;
let engine: ManagedEngine, engineId = '', installedPath = '', changes = 0, endpointDirty = false;
const notices: PluginChange[] = [];
const service = new PluginService({ configRoot: root, request: (method, params) => request(method, params), requestAcknowledged: (method, params, field) => acknowledged(method, params, field),
  binding: id => id === 'fixture-session' && engineId ? { engineId, stale: false } : undefined, endpointRestartRequired: () => endpointDirty,
  resolveSession: async () => { throw new Error('This live gate must never synthesize a missing thread'); }, onChanged: change => { notices.push(change); changes++; endpointDirty = change.mutation.restartRequired === true; } });
async function document(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function attach(): Promise<void> {
  engine = await manager.attach({ command: binary!, args: [], cwd: root, env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')]] });
  request = (method, params) => engine.client.requestWithTimeout(method, params, 20_000);
  acknowledged = (method, params, field) => requestAcknowledged(engine.client, method, params, field, 20_000);
}
async function start(threadId: string): Promise<void> {
  const started = object(await request('session/start', { init: { cwd: root, threadId }, resume: null, fork: null }));
  engineId = string(started.sessionId); assert(engineId, 'real session created without a model turn'); await request('session/subscribe', { sessionId: engineId });
}
async function restart(threadId: string): Promise<void> {
  if (engineId) { await request('session/close', { sessionId: engineId }); engineId = ''; }
  const generation = engine.generation; await manager.release(engine.key);
  assertEqual(manager.liveProcessCount(), 0, 'old endpoint exits before its replacement');
  await attach(); assert(engine.generation > generation, 'one owner advances its endpoint generation');
  assertEqual(manager.liveProcessCount(), 1, 'only the replacement endpoint exists'); endpointDirty = false; await start(threadId);
}
const pluginSkills = (runtime: JsonObject): JsonObject[] => (object(runtime.extensions).skills as JsonObject[]).filter(skill => string(skill.name).includes('demo'));

h.test('live plugin installation persists through the named facade and copies the real staged package', async () => {
  await attach();
  await start('fixture-session');
  const second = object(await request('session/start', { init: { cwd: root, threadId: 'fixture-preexisting' }, resume: null, fork: null }));
  const preexistingId = string(second.sessionId); assert(preexistingId, 'second pre-existing session created');
  await document(join(market, '.claude-plugin/marketplace.json'), { name: 'local', plugins: [{ name: 'fixture', source: './plugins/fixture' }] });
  await document(join(packageDir, '.claude-plugin/plugin.json'), { name: 'fixture', version: '1.2.3', description: 'Live plugin test', skills: ['./skills'] });
  await mkdir(join(packageDir, 'skills/demo'), { recursive: true }); await writeFile(join(packageDir, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Live plugin fixture\n---\nUse in a test only.\n');
  const saved = object(await request('config/batchWrite', { edits: [{ keyPath: 'marketplaces.local', value: { installLocation: market }, mergeStrategy: 'replace' }] }));
  assertEqual(saved.error, undefined, 'real marketplace config write');
  const installed = object(await service.install({ id: 'fixture@local' })); assertEqual(installed.ok, true, 'terminal install outcome: ' + JSON.stringify(installed));
  const config = object(await request('config/read', {})), record = object(object(object(config.values).plugins)['fixture@local']);
  assertEqual(record.enabled, true, 'real engine ledger enabled'); installedPath = string(record.installPath);
  assert(installedPath && installedPath !== packageDir && installedPath.startsWith(root), 'engine owns a separate isolated installation');
  assertEqual(await readFile(join(installedPath, 'skills/demo/SKILL.md'), 'utf8'), await readFile(join(packageDir, 'skills/demo/SKILL.md'), 'utf8'), 'real installed bytes');
  assertDeepEqual(await readdir(join(root, 'plugins/staging')), [], 'host staging removed after terminal result');
  assertEqual(notices[0]?.id, 'fixture@local', 'install callback retains the complete ledger identity');
  assertEqual(notices[0]?.mutation.restartRequired, false, 'installation activates without restarting the endpoint');
  const existing = object(await service.runtimeView({ sessionId: 'fixture-session' }));
  assertEqual(pluginSkills(existing).length, 1, 'an already loaded session sees the installed skill');
  assertEqual(object((existing.plugins as JsonObject[])[0]).effectiveStatus, 'active', 'the existing session reports the effective plugin');
  const reply = object(await request('session/extensionRuntime', { sessionId: preexistingId }));
  const extensions = object(reply.extensionRuntime ?? reply);
  assertEqual((extensions.skills as JsonObject[]).filter(skill => string(skill.name).includes('demo')).length, 1, 'second pre-existing session also receives the plugin');
  await request('session/close', { sessionId: preexistingId });
});
h.test('live plugin catalog attributes manifest contributions and passive runtime creates no session', async () => {
  const catalog = object(await service.market()), row = (catalog.plugins as JsonObject[]).find(row => row.id === 'fixture@local');
  assert(row, 'installed marketplace row'); assert(Array.isArray(object(row.contributions).skills), 'real engine catalog contribution list');
  const runtime = object(await service.runtimeView({ sessionId: 'not-created' })); assertEqual(runtime.status, 'no_session', 'passive runtime does not activate');
  assertEqual(object((runtime.plugins as JsonObject[])[0]).effectiveStatus, 'unknown', 'passive view does not invent a session runtime');
});
h.test('a second session on the same endpoint sees the installed skill immediately', async () => {
  const started = object(await request('session/start', { init: { cwd: root, threadId: 'fixture-second' }, resume: null, fork: null }));
  const secondId = string(started.sessionId); assert(secondId, 'second real session created');
  try {
    const reply = object(await request('session/extensionRuntime', { sessionId: secondId }));
    const extensions = object(reply.extensionRuntime ?? reply);
    const skills = (extensions.skills as JsonObject[]).filter(skill => string(skill.name).includes('demo'));
    assertEqual(skills.length, 1, 'new session loads the current endpoint plugin projection');
    assertEqual(object(skills[0]?.source).kind, 'plugin', 'new session retains plugin provenance');
  } finally { await request('session/close', { sessionId: secondId }); }
  const runtime = object(await service.runtimeView({ sessionId: 'fixture-session' }));
  assertEqual(runtime.status, 'ready', 'four real runtime queries'); assert(runtime.capabilities && runtime.extensions, 'renderer projection fields present');
  assertDeepEqual(runtime.diagnostics, [], 'no hidden runtime query failure');
  assertEqual(pluginSkills(runtime).length, 1, 'original session remains active');
  assertEqual(object(await service.market()).restartRequired, false, 'settings does not request a restart');
});
h.test('one-owner endpoint restart preserves the installed skill exactly once with plugin provenance', async () => {
  await restart('fixture-after-install');
  const runtime = object(await service.runtimeView({ sessionId: 'fixture-session' })), skills = pluginSkills(runtime);
  assertEqual(skills.length, 1, 'actual plugin skill loaded once'); assertEqual(object(skills[0]?.source).kind, 'plugin', 'engine owns skill provenance');
  assertEqual(object((runtime.plugins as JsonObject[])[0]).effectiveStatus, 'active', 'replacement endpoint uses installed registry');
  assertEqual(object(await service.market()).restartRequired, false, 'settings pending indicator cleared by the owner');
});
h.test('disable and re-enable update the loaded session without restarting', async () => {
  assertEqual(object(await service.toggle({ id: 'fixture@local', enabled: false })).restartRequired, false, 'disable activates immediately');
  const config = object(await request('config/read', {})); assertEqual(object(object(object(config.values).plugins)['fixture@local']).enabled, false, 'engine config stores disabled');
  const rows = await service.list({ sessionId: 'fixture-session' }) as JsonObject[];
  assertEqual(rows.find(row => row.id === 'fixture@local')?.enabled, false, 'desired flag comes from current engine config');
  assertEqual(object(rows.find(row => row.id === 'fixture@local')?.runtime).effectiveStatus, 'disabled', 'loaded session no longer reports an active plugin');
  assertEqual(pluginSkills(object(await service.runtimeView({ sessionId: 'fixture-session' }))).length, 0, 'loaded session loses the disabled skill');
  const priorLedger = object(object(object(await request('session/installedPlugins', {})).installedPlugins).plugins);
  const dataPath = string(object(priorLedger['fixture@local']).dataPath);
  assert(dataPath.startsWith(root), 'user data belongs to the actual isolated engine store');
  const userData = join(dataPath, 'notes.json');
  await document(userData, { title: 'Preserve user work during updates' });
  const userBytes = await readFile(userData);
  await document(join(packageDir, '.claude-plugin/plugin.json'), { name: 'fixture', version: '1.2.4', description: 'Updated live plugin test', skills: ['./skills'] });
  const nextSkill = '---\nname: updated-demo\ndescription: Updated live plugin fixture\n---\nUse the new release in a test only.\n';
  await writeFile(join(packageDir, 'skills/demo/SKILL.md'), nextSkill);
  const offered = (object(await service.market()).plugins as JsonObject[]).find(row => row.id === 'fixture@local')!;
  assertEqual(offered.installedVersion, '1.2.3', 'real ledger exposes installed version');
  assertEqual(offered.availableVersion, '1.2.4', 'actual local manifest exposes the publication');
  assertEqual(offered.updateAvailable, true, 'disabled installation can receive a newer release');
  const updated = object(await service.update({ id: 'fixture@local', version: '1.2.4', installedVersion: '1.2.3' }));
  assertEqual(updated.ok, true, 'real engine confirms update: ' + JSON.stringify(updated));
  assertEqual(updated.updated, true, 'update result distinguishes release replacement');
  const updatedLedger = object(object(object(await request('session/installedPlugins', {})).installedPlugins).plugins);
  const updatedRecord = object(updatedLedger['fixture@local']);
  assertEqual(updatedRecord.version, '1.2.4', 'real engine persists the new release');
  assertEqual(updatedRecord.enabled, false, 'same-id update preserves user disablement');
  assertEqual(updatedRecord.dataPath, dataPath, 'same-id update retains its persistent engine data directory');
  installedPath = string(updatedRecord.installPath);
  assertEqual(await readFile(join(installedPath, 'skills/demo/SKILL.md'), 'utf8'), nextSkill, 'engine owns the updated package bytes');
  assertDeepEqual(await readFile(userData), userBytes, 'update preserves user data');
  assertEqual(pluginSkills(object(await service.runtimeView({ sessionId: 'fixture-session' }))).length, 0, 'update does not activate a disabled plugin');
  const refreshed = (object(await service.market()).plugins as JsonObject[]).find(row => row.id === 'fixture@local')!;
  assertEqual(refreshed.installedVersion, '1.2.4', 'market reflects confirmed installed version');
  assertEqual(refreshed.updateAvailable, false, 'completed release no longer shows an update action');
  assertDeepEqual(await readdir(join(root, 'plugins/staging')), [], 'update staging removed after real persistence');
  assertEqual(object(await service.toggle({ id: 'fixture@local', enabled: true })).restartRequired, false, 're-enable activates immediately');
  const enabledSkills = pluginSkills(object(await service.runtimeView({ sessionId: 'fixture-session' })));
  assertEqual(enabledSkills.length, 1, 'loaded session regains the enabled skill');
  assert(string(enabledSkills[0]?.name).includes('updated-demo'), 'loaded session uses the updated skill identity');
  const pluginRuntime = object(object(await request('session/pluginRuntime', { sessionId: engineId })).pluginRuntime);
  const loaded = (pluginRuntime.entries as JsonObject[]).find(row => row.name === 'fixture')!;
  assertEqual(loaded.version, '1.2.4', 'loaded runtime reports the new version');
  assertEqual(loaded.dir, installedPath, 'loaded runtime uses the committed new package path');
  await restart('fixture-after-reenable');
  assertEqual(pluginSkills(object(await service.runtimeView({ sessionId: 'fixture-session' }))).length, 1, 'restart preserves the active skill without duplication');
});
h.test('the named install facade carries the update version guard through the real wire codec', async () => {
  const before = object(await request('session/installedPlugins', {}));
  const refused = await assertRejects(() => acknowledged('session/installPlugin', {
    marketplace: 'local', sourceDir: packageDir, version: '1.2.4', expectedInstalledVersion: '0.0.0',
  }, 'pluginMutation'), 'a stale expected version is rejected by the actual endpoint');
  assert(refused instanceof Error && refused.message.includes('Installed plugin version changed'), 'rejection comes from the engine version guard');
  assertDeepEqual(await request('session/installedPlugins', {}), before, 'rejection preserves the committed registry');
  assertEqual(pluginSkills(object(await service.runtimeView({ sessionId: 'fixture-session' }))).length, 1, 'stale update keeps the current plugin active');
});
h.test('live uninstall removes the engine copy and ledger while preserving the marketplace source', async () => {
  const removed = object(await service.uninstall({ id: 'fixture@local' })); assertEqual(removed.removed, true, 'terminal engine uninstall');
  assertEqual(await exists(installedPath), false, 'engine removed its copy'); assert(await exists(packageDir), 'marketplace source preserved');
  const config = object(await request('config/read', {})); assertEqual(object(object(config.values).plugins)['fixture@local'], undefined, 'no stale engine ledger record');
  assertEqual(pluginSkills(object(await service.runtimeView({ sessionId: 'fixture-session' }))).length, 0, 'loaded session loses the uninstalled skill');
  assertEqual(changes, 5, 'one invalidation for install, update, two toggles and uninstall');
});
h.test('a delayed update cannot resurrect an installation removed before the RPC', async () => {
  const refused = await assertRejects(() => acknowledged('session/installPlugin', {
    marketplace: 'local', sourceDir: packageDir, version: '1.2.4', expectedInstalledVersion: '1.2.4',
  }, 'pluginMutation'), 'update intent is rejected for an uninstalled plugin');
  assert(refused instanceof Error && refused.message.includes('Plugin is no longer installed'), 'the actual guard prevents resurrection');
  const ledger = object(object(object(await request('session/installedPlugins', {})).installedPlugins).plugins);
  assertEqual(ledger['fixture@local'], undefined, 'the user removal remains committed');
  assertEqual(pluginSkills(object(await service.runtimeView({ sessionId: 'fixture-session' }))).length, 0, 'removed plugin remains absent from the live session');
});
h.test('an official plugin package installs with its editor template and skill provenance', async () => {
  const source = resolve(__dirname, '../../tests/fixtures/official-plugins/prototype-studio');
  const target = join(market, 'plugins/prototype-studio');
  await cp(source, target, { recursive: true });
  await document(join(market, '.claude-plugin/marketplace.json'), { name: 'klaus-official', plugins: [{ name: 'prototype-studio', source: './plugins/prototype-studio', version: '1.0.0' }] });
  await request('config/batchWrite', { edits: [{ keyPath: 'marketplaces."klaus-official"', value: { installLocation: market }, mergeStrategy: 'replace' }] });
  const installed = object(await service.install({ id: 'prototype-studio@klaus-official' }));
  assertEqual(installed.ok, true, 'real official prototype installation');
  const config = object(await request('config/read', {}));
  const record = object(object(object(config.values).plugins)['prototype-studio@klaus-official']);
  const path = string(record.installPath);
  assert(path && path.startsWith(root), 'engine-owned prototype package');
  assertEqual(await readFile(join(path, 'templates/prototype-studio.canvas.tsx'), 'utf8'), await readFile(join(source, 'templates/prototype-studio.canvas.tsx'), 'utf8'), 'editor template copied intact');
  const runtime = object(await service.runtimeView({ sessionId: 'fixture-session' }));
  const skills = (object(runtime.extensions).skills as JsonObject[]).filter(skill => string(skill.name).includes('prototype-studio'));
  assertEqual(skills.length, 1, 'prototype skill loads in the existing session without a restart');
  assertEqual(object(skills[0]?.source).kind, 'plugin', 'prototype skill attributed to plugin');
  assertEqual(object(await service.uninstall({ id: 'prototype-studio@klaus-official' })).removed, true, 'official prototype uninstalled from isolated fixture');
});
h.test('the real engine retires legacy Diagram without losing its disabled state or user documents', async () => {
  const source = resolve(__dirname, '../../tests/fixtures/official-plugins/digram');
  const mirrored = join(root, 'plugins/marketplaces/klaus-official/plugins/digram');
  await cp(source, mirrored, { recursive: true });
  await request('config/batchWrite', { edits: [{ keyPath: 'marketplaces."klaus-official"',
    value: { installLocation: join(root, 'plugins/marketplaces/klaus-official') }, mergeStrategy: 'replace' }] });
  const documentPath = join(root, 'digram/important.digram.json');
  await document(documentPath, { title: 'Keep this diagram' });
  const original = await readFile(documentPath);
  await request('config/batchWrite', { edits: [{ keyPath: 'plugins."digram@builtin"',
    value: { name: 'digram', source: 'builtin', installPath: '/removed/bundled/digram', installedAtMs: 1, enabled: false }, mergeStrategy: 'replace' }] });

  let refused = false;
  try { await request('session/migrateBundledDiagram', { sourceDir: root }); }
  catch { refused = true; }
  assert(refused, 'engine refuses a source outside its official mirror');
  assert(object(object(object(await request('session/installedPlugins', {})).installedPlugins).plugins)['digram@builtin'], 'refusal keeps the legacy record');
  const migrated = object(await request('session/migrateBundledDiagram', { sourceDir: mirrored }));
  assertEqual(migrated.migrated, true, 'named facade confirms persisted migration');
  const ledger = object(object(object(await request('session/installedPlugins', {})).installedPlugins).plugins);
  assertEqual(ledger['digram@builtin'], undefined, 'legacy record retired');
  const official = object(ledger['digram@klaus-official']);
  assertEqual(official.enabled, false, 'user disablement survives');
  assert(string(official.installPath).startsWith(root) && string(official.installPath) !== mirrored, 'engine owns a distinct installed package');
  assertDeepEqual(await readFile(documentPath), original, 'Diagram document bytes stay untouched');
  const rows = object(await service.market()).plugins as JsonObject[];
  assertEqual(rows.filter(row => row.name === 'digram').length, 1, 'market contains a single Diagram');
  assertEqual(rows.find(row => row.id === 'digram@klaus-official')?.installed, true, 'official Diagram is installed');
  assertEqual(object(await request('session/migrateBundledDiagram', { sourceDir: mirrored })).migrated, false, 'repeated migration is a no-op');
  await restart('fixture-after-migration');
  const runtime = object(await service.runtimeView({ sessionId: 'fixture-session' }));
  const diagram = (runtime.plugins as JsonObject[]).find(row => row.pluginId === 'digram@klaus-official');
  assertEqual(diagram?.effectiveStatus, 'disabled', 'new endpoint has the official disabled state');
  assertDeepEqual(diagram?.errors, [], 'retired builtin no longer produces a load error');

  assertEqual(object(await service.uninstall({ id: 'digram@klaus-official' })).removed, true, 'user can uninstall the official copy');
  assertEqual(object(await request('session/migrateBundledDiagram', { sourceDir: mirrored })).migrated, false, 'uninstall is never reversed by startup migration');
  assertDeepEqual(await readFile(documentPath), original, 'uninstall also preserves Diagram documents');
});
h.test('the bundled desktop pet workflow installs once with live skill provenance and its validation helper', async () => {
  const source = resolve(__dirname, '../../resources/plugins-builtin/desktop-pet');
  const priorMarkets = object(object(await request('config/read', {})).values).marketplaces;
  const priorChanges = changes;
  const installed = await Promise.all([service.ensureBundled('desktop-pet', source), service.ensureBundled('desktop-pet', source)]);
  for (const result of installed) assertEqual(object(result).ok, true, 'real bundled workflow installation');
  assertEqual(changes - priorChanges, 1, 'concurrent workflow creation performs one terminal installation');
  const ledger = object(object(object(await request('session/installedPlugins', {})).installedPlugins).plugins);
  const record = object(ledger['desktop-pet@builtin']), path = string(record.installPath);
  assert(path.startsWith(root) && path !== source, 'engine owns an isolated workflow copy');
  assertEqual(record.enabled === false, false, 'workflow is enabled');
  const skill = 'skills/create-desktop-pet/SKILL.md', helper = 'skills/create-desktop-pet/scripts/validate-pet.cjs';
  assertEqual(await readFile(join(path, skill), 'utf8'), await readFile(join(source, skill), 'utf8'), 'creation skill installed intact');
  assertEqual(await readFile(join(path, helper), 'utf8'), await readFile(join(source, helper), 'utf8'), 'standalone validator installed intact');
  const runtime = object(await service.runtimeView({ sessionId: 'fixture-session' }));
  assert(Array.isArray(object(runtime.extensions).skills), 'workflow skill query must succeed: ' + JSON.stringify(runtime));
  const skills = (object(runtime.extensions).skills as JsonObject[]).filter(skill => string(skill.name).includes('create-desktop-pet'));
  assertEqual(skills.length, 1, 'loaded session receives the creation skill exactly once');
  assertEqual(object(skills[0]?.source).kind, 'plugin', 'engine attributes the creation skill to its installed plugin');
  assertDeepEqual(object(object(await request('config/read', {})).values).marketplaces, priorMarkets, 'bundled workflow does not replace marketplace configuration');
  assertDeepEqual(await readdir(join(root, 'plugins/staging')), [], 'bundled staging removed after engine persistence');
  await service.toggle({ id: 'desktop-pet@builtin', enabled: false });
  assertEqual(object(await service.ensureBundled('desktop-pet', source)).ok, true, 'a new create request re-enables the installed workflow');
  const refreshed = object(await service.runtimeView({ sessionId: 'fixture-session' }));
  assert(Array.isArray(object(refreshed.extensions).skills), 're-enabled workflow skill query must succeed: ' + JSON.stringify(refreshed));
  assertEqual((object(refreshed.extensions).skills as JsonObject[]).filter(skill => string(skill.name).includes('create-desktop-pet')).length, 1, 're-enable preserves one loaded creation skill');
  assertEqual(object(await service.uninstall({ id: 'desktop-pet@builtin' })).removed, true, 'isolated fixture removes the workflow after validation');
});
h.test('live plugin teardown releases the single engine owner and every staging directory', async () => {
  if (engineId) await request('session/close', { sessionId: engineId });
  await service.close(); await manager.shutdownAll();
  assertEqual(manager.liveProcessCount(), 0, 'no remaining engine process'); assertDeepEqual(await readdir(join(root, 'plugins/staging')), [], 'no temporary plugin package');
});
void h.finish(join(__dirname, 'plugins-live-result.json'), 'plugins-live').then(async code => {
  await service.close(); await manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); process.exitCode = code;
}, async error => { await manager.shutdownAll(); await service.close(); rmSync(root, { recursive: true, force: true }); throw error; });
