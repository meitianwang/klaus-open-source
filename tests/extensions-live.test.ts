// Explicit live gate: KLAUS_ENGINE_BINARY must identify the staged engine under test.
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineManager } from '../main/engine/manager';
import { WorkspaceStore } from '../main/services/workspaces';
import { HookStyleService } from '../main/services/extensions/hooks-styles';
import { SkillService } from '../main/services/extensions/skills';
import { object, type EngineRequest } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the live extension gate');
const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-extensions-live-')), manager = new EngineManager('0.0.0-extension-test');
const workspaces = new WorkspaceStore({ configRoot: root, onSessionWorkdirChanged: () => {}, push: () => {}, pickDirectory: async () => null });
const changes: string[] = [];
let request: EngineRequest;
const hooks = new HookStyleService({ workspaces, request: (method, params) => request(method, params), onChanged: async kind => { changes.push(kind); } });
const skills = new SkillService({ workspaces, request: (method, params) => request(method, params), onChanged: async () => {}, openPreviewWindow: async () => { throw new Error('No GUI preview requested by this protocol test'); } });

h.test('live engine supplies authoritative hooks and writes the selected isolated store', async () => {
  const engine = await manager.attach({ command: binary, args: [], cwd: root, env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')]] });
  request = (method, params) => engine.client.requestWithTimeout(method, params, 15_000);
  const initial = object(await hooks.hooksGet());
  assertEqual(initial.ok, true, 'real hooks/read succeeded');
  assert(Array.isArray(initial.events) && initial.events.includes('PreToolUse'), 'engine dispatch event roster');
  assertEqual(initial.path, join(root, 'hooks.json'), 'isolated config store');
  const content = { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo extension-fixture', timeout: 2 }] }] };
  const written = object(await hooks.hooksSet({ hooks: content }));
  assertEqual(written.ok, true, 'real hooks/write succeeded');
  assertDeepEqual(JSON.parse(await readFile(join(root, 'hooks.json'), 'utf8')), content, 'actual engine file content');
});
h.test('live engine rejects unsupported hooks and a project hook edit stays inside its registered checkout', async () => {
  const before = await readFile(join(root, 'hooks.json'), 'utf8');
  assertEqual(object(await hooks.hooksSet({ hooks: { InventedEvent: [] } })).ok, false, 'real engine event validation');
  assertEqual(await readFile(join(root, 'hooks.json'), 'utf8'), before, 'validation leaves previous hook store');
  const project = join(root, 'project'); await mkdir(project); workspaces.projectsAdd({ path: project });
  assertEqual(object(await hooks.hooksSet({ projectRoot: project, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo project-fixture' }] }] } })).ok, true, 'named project write');
  assertEqual(object(JSON.parse(await readFile(join(project, '.klaus/hooks.json'), 'utf8'))).Stop instanceof Array, true, 'project hook file created by engine');
});
h.test('live output-style edits use engine config and default removes the explicit selection', async () => {
  assertEqual(object(await hooks.outputStylesSet({ style: 'Learning' })).ok, true, 'live config batch write');
  assertEqual(object(await hooks.outputStylesList()).current, 'Learning', 'live config read');
  assertEqual(object(await hooks.outputStylesSet({ style: 'default' })).ok, true, 'default write');
  const config = object(await request('config/read', {}));
  assertEqual(object(config.values).outputStyle, undefined, 'explicit setting removed by engine');
  assertEqual(changes.filter(kind => kind === 'outputStyle').length, 2, 'both completed mutations invalidated sessions');
});
h.test('live engine builtins merge with packaged skills without a fabricated empty reply', async () => {
  const result = object(await skills.builtin());
  assertEqual(result.error, null, 'live builtinSkills method completed');
  assert(Array.isArray(result.items) && result.items.some(row => object(row).dirName === 'slash-command-creator'), 'packaged skill present beside engine roster');
});
h.test('live extension resources release the only engine process', async () => {
  await skills.close(); await hooks.close(); await manager.shutdownAll();
  assertEqual(manager.liveProcessCount(), 0, 'engine process count after shutdown');
});
void h.finish(join(__dirname, 'extensions-live-result.json'), 'extensions-live').then(async code => {
  await skills.close(); await hooks.close(); await manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); process.exitCode = code;
}, async error => {
  await manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); throw error;
});
