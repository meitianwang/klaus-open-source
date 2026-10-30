import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { DISCORD_ACCESS_CHANNELS, registerDiscordAccessHandlers } from '../main/ipc/handlers/discord-access';
import { PERMISSION_RULE_CHANNELS, registerPermissionRuleHandlers } from '../main/ipc/handlers/permission-rules';
import { DiscordAccessService } from '../main/services/channels/discord-access';
import { PermissionRulesService, parsePermissionRule, formatPermissionRule, type PermissionRules } from '../main/services/permission-rules';
import { object, type EngineRequest, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const vector = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/channel-access-permission.json'), 'utf8')) as {
  emptyAccess: JsonObject; deliveryInput: JsonObject; delivery: JsonObject; ruleParsing: Array<{ input: string; expected: JsonObject }>;
};
function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel); assert(handler, 'actual registered channel ' + channel);
  return Promise.resolve(handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] }));
}
function seed(root: string, state: JsonObject): string {
  const directory = join(root, 'channels/discord'); mkdirSync(directory, { recursive: true });
  const file = join(directory, 'access.json'); writeFileSync(file, JSON.stringify(state)); return file;
}
function pending(senderId: string, chatId: string, expiresAt: number): JsonObject { return { senderId, chatId, createdAt: 100, expiresAt, replies: 1 }; }
function ruleEngine(): { request: EngineRequest; rules: PermissionRules; calls: Array<{ method: string; params: Json }> } {
  const rules: PermissionRules = { allow: [], deny: [], ask: [] }, calls: Array<{ method: string; params: Json }> = [];
  return { rules, calls, request: async (method, raw) => {
    calls.push({ method, params: structuredClone(raw) }); const params = object(raw), behavior = params.behavior as keyof PermissionRules;
    if (method === 'engine/addPermissionRules') {
      for (const input of params.rules as Json[]) {
        const entry = object(input), text = formatPermissionRule(String(entry.toolName), entry.argumentPrefix as string | undefined);
        if (!rules[behavior].includes(text)) rules[behavior].push(text);
      }
    } else if (method === 'engine/removePermissionRule') rules[behavior] = rules[behavior].filter(rule => rule !== params.rule);
    else assertEqual(method, 'engine/permissionRules', 'only named rule facade methods');
    return structuredClone(rules);
  } };
}

export function registerChannelAccessPermissionTests(h: Harness, freshRoot: () => string): void {
  h.test('Discord and permission registrars cover exactly the twelve implemented channels', async () => {
    const registry = new ChannelRegistry(), engine = ruleEngine();
    const discord = registerDiscordAccessHandlers(registry, { configRoot: freshRoot() });
    const rules = registerPermissionRuleHandlers(registry, { request: engine.request });
    assertDeepEqual(registry.channels(), [...DISCORD_ACCESS_CHANNELS, ...PERMISSION_RULE_CHANNELS].sort(), 'actual registration coverage');
    assertDeepEqual(await invoke(registry, 'channels:discord:access'), vector.emptyAccess, 'missing file default');
    assertDeepEqual(await invoke(registry, 'permission:rules:list'), { ok: true, allow: [], deny: [], ask: [] }, 'empty engine rules');
    assertEqual(registry.lookup('channels:connect'), undefined, 'transport is not claimed by a config-only service');
    await discord.close(); await rules.close();
  });
  h.test('Discord policy and full-replace group and delivery mutations retain their file schema', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), service = registerDiscordAccessHandlers(registry, { configRoot: root });
    assertEqual(object(await invoke(registry, 'channels:discord:setDmPolicy', { dmPolicy: 'allowlist' })).ok, true, 'policy saved');
    assertEqual(object(await invoke(registry, 'channels:discord:upsertGroup', { channelId: ' room ', requireMention: true, allowFrom: [' one ', '', 7] })).ok, true, 'group saved');
    assertDeepEqual(object(await service.access()).groups, [{ channelId: 'room', requireMention: true, allowFrom: ['one', '7'] }], 'normalization');
    await invoke(registry, 'channels:discord:upsertGroup', { channelId: 'room' });
    assertDeepEqual(object(await service.access()).groups, [{ channelId: 'room', requireMention: false, allowFrom: [] }], 'absent fields replace previous values');
    await invoke(registry, 'channels:discord:updateDelivery', vector.deliveryInput);
    const snapshot = await service.access();
    for (const [key, value] of Object.entries(vector.delivery)) assertDeepEqual(snapshot[key], value, 'normalized delivery ' + key);
    await invoke(registry, 'channels:discord:updateDelivery', {});
    const defaults = await service.access(); for (const key of ['mentionPatterns', 'ackReaction', 'replyToMode', 'textChunkLimit', 'chunkMode']) assertDeepEqual(defaults[key], vector.emptyAccess[key], 'cleared delivery ' + key);
    await invoke(registry, 'channels:discord:removeGroup', { channelId: ' room ' });
    assertDeepEqual((await service.access()).groups, [], 'group removed');
    const disk = JSON.parse(readFileSync(join(root, 'channels/discord/access.json'), 'utf8'));
    assertDeepEqual(disk.groups, {}, 'persist maps rather than UI arrays'); assertDeepEqual(disk.pending, {}, 'pending map');
    if (process.platform !== 'win32') { assertEqual(statSync(join(root, 'channels/discord')).mode & 0o777, 0o700, 'private dir'); assertEqual(statSync(join(root, 'channels/discord/access.json')).mode & 0o777, 0o600, 'private file'); }
    await service.close();
    const reopened = new DiscordAccessService({ configRoot: root }); assertEqual((await reopened.access()).dmPolicy, 'allowlist', 'reopen preserves settings'); await reopened.close();
  });
  h.test('Discord approval consumes a live code, persists the grant and queues one existing drop-box notification', async () => {
    const root = freshRoot(), file = seed(root, { pending: { abc123: pending('sender-1', 'chat-1', 2000), denied: pending('sender-2', 'chat-2', 2000) } });
    const registry = new ChannelRegistry(), service = registerDiscordAccessHandlers(registry, { configRoot: root, now: () => 1000 });
    assertEqual(object(await invoke(registry, 'channels:discord:approvePending', { code: 'abc123' })).ok, true, 'approved');
    assertEqual(readFileSync(join(root, 'channels/discord/approved/sender-1'), 'utf8'), 'chat-1', 'existing drop-box shape');
    assertEqual(object(await invoke(registry, 'channels:discord:approvePending', { code: 'abc123' })).ok, false, 'code is single-use');
    await invoke(registry, 'channels:discord:addAllowFrom', { senderId: ' sender-1 ' });
    assertDeepEqual((await service.access()).allowFrom, ['sender-1'], 'deduplicated');
    await invoke(registry, 'channels:discord:removeAllowFrom', { senderId: ' sender-1 ' });
    assert(!existsSync(join(root, 'channels/discord/approved/sender-1')), 'revoke removes queued notification');
    assertEqual(object(await invoke(registry, 'channels:discord:denyPending', { code: 'denied' })).ok, true, 'denied');
    assertDeepEqual(JSON.parse(readFileSync(file, 'utf8')).pending, {}, 'both codes consumed');
    assertDeepEqual((await service.access()).allowFrom, [], 'no grant remains'); await service.close();
  });
  h.test('Discord expired codes and unsafe sender paths never grant access', async () => {
    const root = freshRoot(); seed(root, { pending: { expired: pending('old', 'old-chat', 1000), escape: pending('../../outside', 'chat', 2000) } });
    const service = new DiscordAccessService({ configRoot: root, now: () => 1000 });
    assertEqual((await service.approvePending({ code: 'expired' })).ok, false, 'expiry checked before approve');
    assertEqual((await service.approvePending({ code: 'escape' })).ok, false, 'path refused before grant');
    assertDeepEqual((await service.access()).allowFrom, [], 'neither sender was admitted');
    assert(!existsSync(join(root, 'outside')), 'no escaped file created');
    assertEqual((await service.addAllowFrom({ senderId: '..\\outside' })).ok, false, 'Windows separator refused on every host');
    for (const payload of [{ senderId: '' }, { senderId: ' ' }]) assertDeepEqual(await service.addAllowFrom(payload), { ok: false, error: 'Missing sender id' }, 'validation has no fake snapshot');
    assertEqual((await service.setDmPolicy({ dmPolicy: 'open' })).ok, false, 'unsupported policy');
    await service.close();
  });
  h.test('Discord corrupt files are preserved and actual read failures do not become empty settings', async () => {
    const root = freshRoot(), file = seed(root, {}), original = '{corrupt-json'; writeFileSync(file, original);
    const service = new DiscordAccessService({ configRoot: root, now: () => 1000 });
    assertDeepEqual(await service.access(), vector.emptyAccess, 'corrupt document default after preservation');
    const aside = readdirSync(join(root, 'channels/discord')).find(name => name.startsWith('access.json.corrupt-1000-'));
    assert(aside, 'corrupt bytes retained'); assertEqual(readFileSync(join(root, 'channels/discord', aside), 'utf8'), original, 'original content untouched');
    mkdirSync(file); await assertRejects(() => service.access(), 'directory read error is visible');
    assert(statSync(file).isDirectory(), 'read failure was not replaced'); await service.close();
  });
  h.test('Discord concurrent edits are serialized and hostile map keys remain plain data', async () => {
    const root = freshRoot(), service = new DiscordAccessService({ configRoot: root });
    await Promise.all(Array.from({ length: 20 }, (_, i) => service.addAllowFrom({ senderId: String(i + 1) })));
    assertEqual(((await service.access()).allowFrom as Json[]).length, 20, 'no read-modify-write lost updates');
    await service.upsertGroup({ channelId: '__proto__', requireMention: true });
    assertDeepEqual((await service.access()).groups, [{ channelId: '__proto__', requireMention: true, allowFrom: [] }], 'prototype key round-trips as own data');
    assertEqual(({} as JsonObject).requireMention, undefined, 'prototype unchanged'); await service.close();
  });
  h.test('Discord saved but notification failure remains explicit and close drains accepted work', async () => {
    const root = freshRoot(); let release!: () => void, entered = false;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const service = new DiscordAccessService({ configRoot: root, onChanged: async () => { entered = true; await blocked; throw new Error('refresh fixture failed'); } });
    const edit = service.addAllowFrom({ senderId: 'one' }); await waitFor(() => entered, 1000, 'notification entered');
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await Promise.resolve(); assertEqual(closed, false, 'close waits pending notification');
    await assertRejects(() => service.access(), 'closed service refuses new work'); release();
    const result = await edit; assertEqual(result.ok, false, 'failure exposed'); assertEqual(result.saved, true, 'saved status not hidden');
    await closing; assertDeepEqual(JSON.parse(readFileSync(join(root, 'channels/discord/access.json'), 'utf8')).allowFrom, ['one'], 'grant persisted');
  });
  h.test('permission strings project committed aliases, prefixes and malformed forms', () => {
    for (const row of vector.ruleParsing) assertDeepEqual(parsePermissionRule(row.input), row.expected, 'rule ' + row.input);
    assertEqual(formatPermissionRule('Bash', 'echo (a)\\b'), 'Bash(echo (a)\\b)', 'engine literal rule encoding');
  });
  h.test('permission edits use named engine ownership and never write a host rule file', async () => {
    const registry = new ChannelRegistry(), engine = ruleEngine(); let changes = 0;
    const service = registerPermissionRuleHandlers(registry, { request: engine.request, onChanged: () => { changes++; } });
    assertDeepEqual(await invoke(registry, 'permission:rules:add', { toolName: ' Bash ', ruleContent: ' git status ', behavior: 'ask' }), { ok: true }, 'write reply');
    assertDeepEqual(engine.calls[0], { method: 'engine/addPermissionRules', params: { rules: [{ toolName: 'Bash', argumentPrefix: 'git status' }], behavior: 'ask' } }, 'named structured input');
    assertDeepEqual(await invoke(registry, 'permission:rules:list'), { ok: true, allow: [], deny: [], ask: [{ toolName: 'Bash', ruleContent: 'git status', source: 'userSettings' }] }, 'renderer projection');
    assertDeepEqual(await invoke(registry, 'permission:rules:delete', { toolName: 'Bash', ruleContent: 'git status', behavior: 'ask' }), { ok: true }, 'delete');
    assertDeepEqual(engine.calls.at(-1), { method: 'engine/removePermissionRule', params: { rule: 'Bash(git status)', behavior: 'ask' } }, 'named delete');
    assertDeepEqual(engine.rules.ask, [], 'store changed'); assertEqual(changes, 2, 'notification only after writes'); await service.close();
  });
  h.test('permission invalid payloads do not reach the engine or become default allow', async () => {
    const engine = ruleEngine(), service = new PermissionRulesService({ request: engine.request });
    const invalid: JsonObject[] = [{}, { toolName: 'Bash', behavior: 'ALLOW' }, { toolName: 'Bash', behavior: 'deny', source: 'projectSettings' }, { toolName: 'Bash', behavior: 'allow', ruleContent: 7 }];
    for (const payload of invalid) {
      assertEqual((await service.add(payload)).ok, false, 'invalid add refused'); assertEqual((await service.remove(payload)).ok, false, 'invalid delete refused');
    }
    assertEqual(engine.calls.length, 0, 'no invalid RPC submitted'); await service.close();
  });
  h.test('permission deletion preserves original raw keys for aliases and tool-wide legacy rows', async () => {
    const engine = ruleEngine(); engine.rules.allow.push('Task', 'Read(*)', 'Bash(\\\\server\\share\\)');
    const service = new PermissionRulesService({ request: engine.request });
    assertEqual((await service.remove({ toolName: 'Agent', behavior: 'allow' })).ok, true, 'legacy alias removed');
    assertEqual((await service.remove({ toolName: 'Read', behavior: 'allow' })).ok, true, 'tool-wide star removed');
    assertEqual((await service.remove({ toolName: 'Bash', ruleContent: '\\\\server\\share\\', behavior: 'allow' })).ok, true, 'literal UNC removed');
    assertDeepEqual(engine.calls.filter(call => call.method === 'engine/removePermissionRule').map(call => object(call.params).rule), ['Task', 'Read(*)', 'Bash(\\\\server\\share\\)'], 'raw identities forwarded');
    assertDeepEqual(engine.rules.allow, [], 'no invisible rows remain'); await service.close();
  });
  h.test('permission partial alias deletion still refreshes the host and reports the persisted change', async () => {
    const engine = ruleEngine(); engine.rules.allow.push('Task', 'Agent'); let changes = 0;
    const service = new PermissionRulesService({ request: (method, params) => {
      if (method === 'engine/removePermissionRule' && object(params).rule === 'Agent') throw new Error('second delete fixture failed');
      return engine.request(method, params);
    }, onChanged: () => { changes++; } });
    const result = await service.remove({ toolName: 'Agent', behavior: 'allow' });
    assertEqual(result.ok, false, 'partial mutation is not complete'); assertEqual(result.saved, true, 'partial persistence visible');
    assertDeepEqual(engine.rules.allow, ['Agent'], 'only completed deletion applied'); assertEqual(changes, 1, 'live policy refresh still runs'); await service.close();
  });
  h.test('permission read and write failures stay visible including malformed snapshots', async () => {
    for (const reply of [{}, { allow: [], deny: [], ask: [7] }, { error: { message: 'engine read failed' } }]) {
      const service = new PermissionRulesService({ request: async () => reply });
      await assertRejects(() => service.list(), 'invalid list must reject');
      assertEqual((await service.add({ toolName: 'Read', behavior: 'allow' })).ok, false, 'invalid write reply is not success'); await service.close();
    }
    const engine = ruleEngine(), service = new PermissionRulesService({ request: engine.request, onChanged: () => { throw new Error('host refresh failed'); } });
    const result = await service.add({ toolName: 'Read', behavior: 'deny' });
    assertEqual(result.ok, false, 'refresh failed'); assertEqual(result.saved, true, 'rule saved nonetheless'); assertDeepEqual(engine.rules.deny, ['Read'], 'actual fixture mutation'); await service.close();
  });
  h.test('permission close waits for accepted engine requests and rejects subsequent reads', async () => {
    let release!: () => void, entered = false;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const service = new PermissionRulesService({ request: async () => { entered = true; await waiting; return { allow: [], deny: [], ask: [] }; } });
    const request = service.list(); await waitFor(() => entered, 1000, 'request pending');
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await Promise.resolve(); assertEqual(closed, false, 'close pending');
    await assertRejects(() => service.list(), 'new read refused'); release(); await request; await closing;
  });
}
