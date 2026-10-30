// The real named facade owns every write in a throwaway profile. No model or remote service is used.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineManager, type ManagedEngine } from '../main/engine/manager';
import { ChannelRegistry } from '../main/ipc/registry';
import type { Json } from '../main/ipc/contract';
import { registerPermissionRuleHandlers } from '../main/ipc/handlers/permission-rules';
import { PermissionRulesService } from '../main/services/permission-rules';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY is required for the live permission gate');
const root = mkdtempSync(join(tmpdir(), 'klaus-permissions-live-')), manager = new EngineManager('0.0.0-permissions-live');
const h = new Harness(), registry = new ChannelRegistry(); let engine: ManagedEngine;
const service: PermissionRulesService = registerPermissionRuleHandlers(registry, { request: (method, params) => engine.client.requestWithTimeout(method, params, 10_000) });
async function attach(): Promise<void> {
  engine = await manager.attach({ command: binary!, args: [], cwd: root,
    env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')], ['HOME', root]] });
}
async function invoke(channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'actual registered channel');
  return handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] });
}
h.test('real permission facade stores three behaviors and returns their renderer rows', async () => {
  await attach();
  assertDeepEqual(await invoke('permission:rules:list'), { ok: true, allow: [], deny: [], ask: [] }, 'isolated empty store');
  const entries: JsonObject[] = [
    { toolName: 'Read', behavior: 'allow' },
    { toolName: 'Bash', ruleContent: 'git status', behavior: 'ask' },
    { toolName: 'mcp__calendar__delete*', behavior: 'deny' },
  ];
  for (const entry of entries) assertDeepEqual(await invoke('permission:rules:add', entry), { ok: true }, 'real mutation');
  assertDeepEqual(await invoke('permission:rules:list'), { ok: true, allow: [{ toolName: 'Read', source: 'userSettings' }],
    ask: [{ toolName: 'Bash', ruleContent: 'git status', source: 'userSettings' }], deny: [{ toolName: 'mcp__calendar__delete*', source: 'userSettings' }] }, 'actual engine snapshot');
  assertEqual(manager.liveProcessCount(), 1, 'one process owner');
  assert(!existsSync(join(root, 'settings.json')), 'no duplicate host rule store');
});
h.test('permission rules survive one-owner endpoint restart with the same profile', async () => {
  const generation = engine.generation; await manager.release(engine.key); await attach();
  assert(engine.generation > generation, 'new endpoint generation');
  assertDeepEqual(await service.snapshot(), { allow: ['Read'], deny: ['mcp__calendar__delete*'], ask: ['Bash(git status)'] }, 'durable engine store');
  assert(existsSync(join(root, 'permission-rules.json')), 'engine-owned file exists');
  const disk = JSON.parse(readFileSync(join(root, 'permission-rules.json'), 'utf8'));
  assertDeepEqual(disk.ask, ['Bash(git status)'], 'actual disk shape');
});
h.test('real permission rule deletes apply to the raw engine store', async () => {
  for (const entry of [{ toolName: 'Read', behavior: 'allow' }, { toolName: 'Bash', ruleContent: 'git status', behavior: 'ask' }, { toolName: 'mcp__calendar__delete*', behavior: 'deny' }] as JsonObject[]) {
    assertDeepEqual(await invoke('permission:rules:delete', entry), { ok: true }, 'real delete');
  }
  assertDeepEqual(await service.snapshot(), { allow: [], deny: [], ask: [] }, 'all removed');
});
h.test('real permission prefix round-trip includes parentheses and backslashes', async () => {
  const entry = { toolName: 'Bash', ruleContent: 'echo (fixture)\\tail', behavior: 'ask' };
  assertDeepEqual(await invoke('permission:rules:add', entry), { ok: true }, 'prefix saved');
  const listed = object(await service.list());
  assertDeepEqual(listed.ask, [{ toolName: 'Bash', ruleContent: entry.ruleContent, source: 'userSettings' }], 'same prefix returned');
  assertDeepEqual(await invoke('permission:rules:delete', entry), { ok: true }, 'prefix deleted');
  assertDeepEqual((await service.snapshot()).ask, [], 'no orphaned prefix rule');
});
h.test('real facade refuses an inert rule and an invalid batch without a partial durable grant', async () => {
  const before = await service.snapshot();
  const result = await service.add({ toolName: 'invalid tool', behavior: 'allow' });
  assertEqual(result.ok, false, 'unsupported grammar does not report success');
  let rejected = false;
  try { await engine.client.requestWithTimeout('engine/addPermissionRules', { rules: [{ toolName: 'Read' }, { toolName: 'Bash', argumentPrefix: 7 }] }, 10_000); }
  catch { rejected = true; }
  assert(rejected, 'bad prefix type rejects the complete facade batch');
  assertDeepEqual(await service.snapshot(), before, 'valid first entry was not partially saved');
});
h.test('real admin read and edit failures preserve a corrupt permission store', async () => {
  const file = join(root, 'permission-rules.json'), original = '{incomplete permissions';
  writeFileSync(file, original);
  await assertRejects(() => service.list(), 'corruption is not an empty success');
  assertEqual((await service.add({ toolName: 'Read', behavior: 'allow' })).ok, false, 'corrupt store write refused');
  assertEqual((await service.remove({ toolName: 'Read', behavior: 'allow' })).ok, false, 'corrupt store delete refused');
  assertEqual(readFileSync(file, 'utf8'), original, 'original bytes preserved');
});
h.test('real session permission reload uses the engine store and refuses invalid or closed bindings', async () => {
  const file = join(root, 'permission-rules.json');
  writeFileSync(file, JSON.stringify({ allow: [], deny: [], ask: [] }));
  const sessionId = 'permission-reload-fixture', generation = engine.generation;
  await engine.client.requestWithTimeout('session/start', { init: { threadId: sessionId, cwd: root } }, 10_000);
  try {
    assertDeepEqual(await service.add({ toolName: 'Write', behavior: 'deny' }), { ok: true }, 'engine-owned durable write');
    assertDeepEqual(await engine.client.requestWithTimeout('session/reloadPermissionRules', { sessionId }, 10_000), { allow: [], deny: ['Write'], ask: [] }, 'named terminal reload receipt');
    const good = readFileSync(file);
    writeFileSync(file, '{invalid live rules');
    await assertRejects(() => engine.client.requestWithTimeout('session/reloadPermissionRules', { sessionId }, 10_000), 'invalid store is not empty live policy');
    assertEqual(readFileSync(file, 'utf8'), '{invalid live rules', 'failed reload preserves bytes');
    writeFileSync(file, good);
    assertDeepEqual(await service.remove({ toolName: 'Write', behavior: 'deny' }), { ok: true }, 'delete exact durable rule');
    assertDeepEqual(await engine.client.requestWithTimeout('session/reloadPermissionRules', { sessionId }, 10_000), { allow: [], deny: [], ask: [] }, 'same bound session accepts empty new layer');
    await assertRejects(() => engine.client.requestWithTimeout('session/reloadPermissionRules', { sessionId, allow: ['Bash'] }, 10_000), 'host cannot inject its own durable array');
    assertEqual(engine.generation, generation, 'no endpoint replacement');
  } finally { await engine.client.requestWithTimeout('session/close', { sessionId }, 10_000); }
  await assertRejects(() => engine.client.requestWithTimeout('session/reloadPermissionRules', { sessionId }, 10_000), 'closed binding does not revive');
});
h.test('permission service and actual engine close leave no process owner', async () => {
  await service.close(); await manager.shutdownAll(); assertEqual(manager.liveProcessCount(), 0, 'all reaped');
});
void h.finish(join(__dirname, 'permission-rules-live-result.json'), 'permission-rules-live').then(async code => {
  await service.close(); await manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); process.exitCode = code;
}, async error => { await service.close(); await manager.shutdownAll(); rmSync(root, { recursive: true, force: true }); throw error; });
