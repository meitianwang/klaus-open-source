import { presetRuntimePolicy } from '../contracts/runtime-settings';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry, IpcHandlerError } from '../main/ipc/registry';
import { registerSettingsHandlers, SETTINGS_CHANNELS } from '../main/ipc/handlers/settings';
import { registerComposerHandlers, COMPOSER_CHANNELS } from '../main/ipc/handlers/composer';
import { registerAuthHandlers, AUTH_CHANNELS } from '../main/ipc/handlers/auth';
import { AccountService, type AccountDeps } from '../main/services/account-service';
import { EngineSettings } from '../main/services/engine-settings';
import { buildSessionConfig, buildSessionInit, thinkingLevelFor } from '../main/services/session-init';
import { readSessionModel, readSessionThinkingLevel, readSessionFastMode, setSessionFastMode, sessionSpecMode, setSessionModel, setSessionThinkingLevel, forgetEphemeralPreferences } from '../main/services/session-store';
import { inferenceInit, replaceInferenceInit } from '../main/sessions/inference';
import { migrateProviderRolesToTiers } from '../main/services/model-tier-migration';
import { isFailure, kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { type EngineRequest, type JsonObject, object, string } from '../main/services/service-types';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';
const fastModeVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/codex-fast-mode-vectors.json'), 'utf8')) as {
  cases: Array<{ name: string; source: string; modelValue: string; enabled: boolean; visible: boolean; effective: boolean }>;
  inferenceProjection: Array<{ name: string; init: Record<string, Json>; expected: { config: { fastMode: boolean } } }>;
};
const customModelThinkingVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/custom-model-thinking-vectors.json'), 'utf8')) as {
  cases: Array<{ name: string; payload: JsonObject; dialect: string }>;
};
import { registerFeatureSettingsTests } from './feature-settings';
import { registerAdvisorRuntimeTests } from './advisor-runtime.test';
import { registerFeatureModelTargetTests } from './feature-model-targets.test';
import { registerModelTierSettingsTests } from './model-tier-settings';
import { registerFileWorkspaceTests } from './file-workspaces';
import { registerGitServiceTests } from './git-services';
import { registerWorktreeServiceTests } from './worktree-services';
import { registerFileExtensionTests } from './file-extensions';
import { registerSkillsHooksStyleTests } from './skills-hooks-styles';
import { registerPluginServiceTests } from './plugin-services';
import { registerExtensionDirectoryTests } from './extension-directories';
import { registerMcpConfigurationTests } from './mcp-configuration';
import { registerMcpOAuthTests } from './mcp-oauth';
import { registerMcpRuntimeTests } from './mcp-runtime';
import { registerChannelAccessPermissionTests } from './channel-access-permissions';
import { registerWechatPairingTests } from './wechat-pairing';
import { registerChannelRuntimeTests } from './channel-runtime';
import { registerTelegramChannelTests } from './telegram-channel';
import { registerChannelManagerBoundaryTests } from './channel-manager-boundaries';
import { registerDiscordChannelTests } from './discord-channel';
import { registerWeComChannelTests } from './wecom-channel';
import { registerConnectorServiceTests } from './connector-services';
import { registerQQChannelTests } from './qq-channel';
import { registerDingTalkChannelTests } from './dingtalk-channel';
import { registerFeishuContractTests } from './feishu-contract';
import { registerFeishuChannelTests } from './feishu-channel';
import { registerWhatsAppChannelTests } from './whatsapp-channel';
import { registerCursorComposerControlTests } from './cursor-composer-controls';

async function invoke(registry: ChannelRegistry, channel: string, payload?: Json): Promise<Json> {
  const handler = registry.lookup(channel);
  assert(handler, 'registered channel ' + channel);
  return handler({ channel, role: 'main', senderId: 1, args: payload === undefined ? [] : [payload] });
}
function configEngine(initial: JsonObject = {}): { request: EngineRequest; calls: Array<{ method: string; params: Json }>; values: JsonObject } {
  const values = structuredClone(initial);
  const calls: Array<{ method: string; params: Json }> = [];
  const request: EngineRequest = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'config/read') return { values: structuredClone(values), resolved: {} };
    if (method === 'config/batchWrite') {
      for (const raw of object(params).edits as Json[]) {
        const edit = object(raw);
        const path = String(edit.keyPath);
        let segments: string[];
        if (path.startsWith('modelProviders.')) {
          const quoted = path.slice('modelProviders.'.length);
          const match = /^("(?:[^"\\]|\\.)*")(.*)$/.exec(quoted);
          assert(match, 'quoted provider id');
          segments = ['modelProviders', JSON.parse(match[1]!), ...match[2]!.split('.').filter(Boolean)];
        } else segments = path.split('.');
        let cursor = values;
        for (const segment of segments.slice(0, -1)) {
          if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = {};
          cursor = object(cursor[segment]);
        }
        const key = segments.at(-1)!;
        if (edit.value === null) delete cursor[key];
        else cursor[key] = structuredClone(edit.value!);
      }
      return { values: structuredClone(values), resolved: {} };
    }
    if (method === 'model/credential/write' || method === 'model/credential/delete') return { ok: true };
    if (method === 'model/selection/resolve') {
      const input = object(params), source = String(input.source);
      return { source, selection: String(input.selection).includes(':') ? input.selection : source + ':resolved' };
    }
    throw new Error('Unexpected fixture RPC ' + method);
  };
  return { request, calls, values };
}
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ url: string; close(): Promise<void> }> {
  const listener = createServer((req, res) => { void Promise.resolve(handler(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert(address && typeof address !== 'string', 'fixture listening');
  return { url: 'http://127.0.0.1:' + address.port, close: async () => {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  } };
}
async function body(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
function json(response: ServerResponse, value: Json, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
}
function accountDeps(root: string, extra: Partial<AccountDeps> = {}): AccountDeps {
  return { configRoot: root, request: async () => { throw new Error('No engine request expected'); }, appVersion: 'test',
    openExternal: async () => {}, push: () => {}, onAuthChanged: () => {}, pollIntervalMs: 1, requestTimeoutMs: 1000, ...extra };
}
function signedIn(root: string): void {
  writeFileSync(join(root, 'klaus-auth.json'), JSON.stringify({ token: 'fixture-account-token', user: { id: 'account-1', displayName: 'Before' } }));
}

export function registerServiceHandlerTests(h: Harness, freshRoot: () => string): void {
  registerCursorComposerControlTests(h, freshRoot);
  registerChannelAccessPermissionTests(h, freshRoot);
  registerWechatPairingTests(h, freshRoot);
  registerChannelRuntimeTests(h, freshRoot);
  registerTelegramChannelTests(h, freshRoot);
  registerChannelManagerBoundaryTests(h, freshRoot);
  registerDiscordChannelTests(h, freshRoot);
  registerWeComChannelTests(h, freshRoot);
  registerConnectorServiceTests(h, freshRoot);
  registerQQChannelTests(h, freshRoot);
  registerDingTalkChannelTests(h, freshRoot);
  registerFeishuContractTests(h, freshRoot);
  registerFeishuChannelTests(h, freshRoot);
  registerWhatsAppChannelTests(h, freshRoot);
  registerFileWorkspaceTests(h, freshRoot);
  registerGitServiceTests(h, freshRoot);
  registerWorktreeServiceTests(h, freshRoot);
  registerFileExtensionTests(h, freshRoot);
  registerSkillsHooksStyleTests(h, freshRoot);
  registerPluginServiceTests(h, freshRoot);
  registerExtensionDirectoryTests(h, freshRoot);
  registerMcpConfigurationTests(h, freshRoot);
  registerMcpOAuthTests(h);
  registerMcpRuntimeTests(h);
  registerFeatureSettingsTests(h, freshRoot);
  registerAdvisorRuntimeTests(h, freshRoot);
  registerFeatureModelTargetTests(h, freshRoot);
  registerModelTierSettingsTests(h, freshRoot);
  h.test('public source writes normalize retired and unknown modes while every BYO source stays available', () => {
    const root = freshRoot();
    for (const source of ['subscription', 'custom', 'codex', 'qoder', 'qwenwork', 'workbuddy']) {
      assertEqual(kvSet('auth_mode', source, root), true, 'BYO write');
    }
    for (const source of ['klaus', 'local', 'unknown']) {
      assertEqual(kvSet('auth_mode', source, root), true, 'retired and unknown values normalize');
      assertEqual(kvGet('auth_mode', root), 'custom', 'to the default source rather than storing an unknown mode');
    }
  });
  h.test('model changes atomically preserve other sessions and freeze legacy sources before replacing the default', () => {
    const root = freshRoot();
    kvSet('auth_mode', 'custom', root);
    withSettingsDb(root, db => {
      db.exec('CREATE TABLE session_main_models (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at INTEGER NOT NULL)');
      db.prepare('INSERT INTO session_main_models VALUES (?, ?, ?)').run('legacy', 'auto', 1);
    });
    mkdirSync(join(root, 'projects', 'repo'), { recursive: true });
    writeFileSync(join(root, 'projects', 'repo', 'unopened.jsonl'), '');
    writeFileSync(join(root, 'projects', 'repo', 'compressed-project.jsonl.zst'), '');
    mkdirSync(join(root, 'sessions'), { recursive: true });
    writeFileSync(join(root, 'sessions', '1792600000000-compressed-native.jsonl.zst'), '');
    setSessionModel('new', 'codex:selected', 'codex', root);
    assertDeepEqual(readSessionModel('legacy', root), { mode: 'auto', source: 'custom' }, 'legacy source frozen');
    assertDeepEqual(readSessionModel('unopened', root), { mode: 'auto', source: 'custom' }, 'unopened transcript frozen');
    assertDeepEqual(readSessionModel('compressed-project', root), { mode: 'auto', source: 'custom' }, 'compressed project transcript keeps its source');
    assertDeepEqual(readSessionModel('compressed-native', root), { mode: 'auto', source: 'custom' }, 'compressed native transcript keeps its source');
    assertDeepEqual(readSessionModel('new', root), { mode: 'codex:selected', source: 'codex' }, 'new selection persisted');
    withSettingsDb(root, db => db.exec("CREATE TRIGGER refuse_update BEFORE UPDATE ON session_main_models WHEN NEW.session_id = 'new' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"));
    let failed = false;
    try { setSessionModel('new', 'custom:replacement', 'custom', root); } catch { failed = true; }
    assert(failed, 'storage failure surfaced');
    assertEqual(kvGet('auth_mode', root), 'codex', 'source rolled back');
    assertEqual(kvGet('composer.main_model', root), 'codex:selected', 'default rolled back');
    assertDeepEqual(readSessionModel('new', root), { mode: 'codex:selected', source: 'codex' }, 'session rolled back');
  });
  h.test('a thinking-level change touches one conversation and the future default, never another live one', () => {
    // The user-facing requirement: changing conversation A's reasoning level must
    // leave a running conversation B on its own level, and only conversations
    // created AFTER the change pick up the new default. This is exactly the model
    // behaviour mirrored for the thinking level.
    const root = freshRoot();
    // Two conversations already exist and have frozen their own level on first read.
    assertEqual(readSessionThinkingLevel('a', root), 'medium', 'A starts at the default');
    assertEqual(readSessionThinkingLevel('b', root), 'medium', 'B starts at the default');

    setSessionThinkingLevel('a', 'high', root);
    assertEqual(readSessionThinkingLevel('a', root), 'high', 'A kept its own pick');
    assertEqual(readSessionThinkingLevel('b', root), 'medium', 'B is untouched by a change to A');
    // The global default moved so future conversations inherit the new level...
    assertEqual(kvGet('composer.thinking_level', root), 'high', 'the default for NEW conversations follows');
    assertEqual(readSessionThinkingLevel('created-after', root), 'high', 'a conversation created after the change inherits the new default');
    // ...but an EXISTING conversation stays frozen at what it had.
    assertEqual(readSessionThinkingLevel('b', root), 'medium', 'B still keeps the level it had');

    // A session init reads its own level through thinkingLevelFor, not the global
    // default, so B still reconfigures with medium even though the default is high.
    assertEqual(thinkingLevelFor('b', root), 'medium', 'B reconfigures with its own level');
    assertEqual(thinkingLevelFor('a', root), 'high', 'A reconfigures with its own level');

    // 'off' clears effort in the engine config and is a NON-default level, so it is
    // stored explicitly. Only the default ('medium') is stored by ABSENCE of the
    // global row, mirroring the composer's writeDefault convention and the model
    // path's handling of 'auto'.
    setSessionThinkingLevel('a', 'off', root);
    assertEqual(readSessionThinkingLevel('a', root), 'off', 'A is off');
    assertEqual(kvGet('composer.thinking_level', root), 'off', 'a non-default level is stored explicitly');
    assertEqual(readSessionThinkingLevel('b', root), 'medium', 'B is still untouched');

    // Setting back to the default removes the global row rather than storing it.
    setSessionThinkingLevel('a', 'medium', root);
    assertEqual(readSessionThinkingLevel('a', root), 'medium', 'A is back at the default');
    assertEqual(kvGet('composer.thinking_level', root), null, 'the default is kept as row absence');
  });
  h.test('an existing conversation freezes the level it had before the migration ran', () => {
    // Conversations that predate per-session storage must keep the level that was
    // global at migration time, not drift to whatever the default becomes later.
    const root = freshRoot();
    kvSet('composer.thinking_level', 'xhigh', root);
    mkdirSync(join(root, 'projects', 'repo'), { recursive: true });
    writeFileSync(join(root, 'projects', 'repo', 'old.jsonl'), '');
    // First read of the pre-existing conversation freezes the then-current global.
    assertEqual(readSessionThinkingLevel('old', root), 'xhigh', 'a pre-existing transcript froze its level');
    // A later default change reaches new conversations only.
    setSessionThinkingLevel('other', 'low', root);
    assertEqual(readSessionThinkingLevel('old', root), 'xhigh', 'the frozen conversation kept xhigh');
  });
  h.test('saved source selects its own tier map and collaboration preserves the permission preset', () => {
    const root = freshRoot();
    setSessionModel('custom-thread', 'custom:fixture', 'custom', root);
    kvSet('model_tiers:custom', JSON.stringify({ high: 'custom-high', low: '' }), root);
    kvSet('model_tiers:codex', JSON.stringify({ high: 'codex-high' }), root);
    setSessionModel('other', 'codex:fixture', 'codex', root);
    sessionSpecMode('custom-thread', root);
    withSettingsDb(root, db => db.prepare('INSERT INTO session_chat_modes (session_id, mode, updated_at) VALUES (?, ?, ?)').run('custom-thread', 'plan', 1));
    const init = buildSessionInit({ rendererId: 'custom-thread', cwd: root, configRoot: root, runtimePolicyOverride: presetRuntimePolicy('default') });
    assert(init.ok, 'BYO init');
    assertDeepEqual(init.init.modelTierSelections, { high: 'custom-high', low: '' }, 'tiers from saved source');
    assertEqual(Object.hasOwn(init.init, 'permissionMode'), false, 'legacy permission state does not cross the facade');
    assertEqual(object(init.init.config).sandbox_mode, 'workspace-write', 'the explicit policy stays independent of collaboration');
    assertEqual(init.init.collaborationMode, 'plan', 'legacy planning flag seeds independent collaboration');
    assertEqual(init.init.prePlanPermissionMode, undefined, 'collaboration needs no permission restoration override');
    assertEqual(object(object(init.init.config).sandbox_workspace_write).network_access, false, 'the explicit policy keeps workspace network isolation');
  });
  h.test('composer registers real channels and resolves selection with the saved source and tier preferences', async () => {
    const root = freshRoot(), engine = configEngine(), registry = new ChannelRegistry();
    const changes: JsonObject[] = [], pushes: string[] = [];
    registerComposerHandlers(registry, { configRoot: root, request: engine.request, push: channel => pushes.push(channel),
      onSessionConfigChanged: change => { changes.push({ ...change }); } });
    for (const channel of COMPOSER_CHANNELS) assert(registry.lookup(channel), channel);
    await invoke(registry, 'session:set-main-model', { sessionId: 'thread', mode: 'auto', source: 'custom' });
    kvSet('model_tiers:custom', '{"high":"model-a"}', root);
    assertDeepEqual(await invoke(registry, 'session:get-main-model', { sessionId: 'thread' }), { mode: 'auto', source: 'custom', resolvedMode: 'custom:resolved' }, 'resolved getter');
    assertDeepEqual(engine.calls.at(-1), { method: 'model/selection/resolve', params: { source: 'custom', selection: 'auto', modelTierSelections: { high: 'model-a' } } }, 'named facade request');
    await invoke(registry, 'session:set-thinking-level', { level: 'xhigh' });
    assertDeepEqual(await invoke(registry, 'session:get-thinking-level'), { level: 'xhigh' }, 'xhigh preserved');
    await invoke(registry, 'session:set-permission-mode', { mode: 'default' });
    assertDeepEqual(changes, [{kind:'model',sessionId:'thread'},{kind:'thinking',sessionId:''}], 'an unchanged permission preset does not republish live policy');
    assertEqual(pushes.length, 3, 'preference updates broadcast');
    const failure = await assertRejects(() => invoke(registry, 'session:set-main-model', { mode: 'custom:a', source: 'codex' }), 'source mismatch');
    assert(failure instanceof IpcHandlerError && failure.code === 'INVALID_MODEL_SOURCE', 'typed source error');
    assertDeepEqual(readSessionModel('thread', root), { mode: 'auto', source: 'custom' }, 'failed mutation retained session');
  });
  for (const vector of fastModeVectors.cases) {
    h.test(`Codex Fast mode source contract: ${vector.name}`, async () => {
      const root = freshRoot(), registry = new ChannelRegistry();
      kvSet('auth_mode', vector.source, root);
      kvSet('composer.main_model', vector.modelValue, root);
      readSessionModel('thread', root);
      setSessionFastMode('thread', vector.enabled, root);
      registerComposerHandlers(registry, { configRoot: root, request: async () => ({}), push: () => {}, onSessionConfigChanged: () => {} });
      assertDeepEqual(await invoke(registry, 'session:get-fast-mode', { sessionId: 'thread' }),
        { enabled: vector.effective, supported: vector.visible }, 'source determines availability');
      if (!vector.visible) {
        const error = await assertRejects(() => invoke(registry, 'session:set-fast-mode', { sessionId: 'thread', enabled: true }), 'foreign source refuses Fast');
        assert(error instanceof IpcHandlerError && ['INVALID_MODEL_SOURCE', 'MODEL_SELECTION_UNAVAILABLE'].includes(error.code), 'unavailable Fast rejection is typed');
      }
    });
  }
  h.test('Fast mode persists per conversation, changes only that inference, and remains independent of reasoning', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), changes: JsonObject[] = [];
    setSessionModel('a', 'codex:gpt-6.1-sol', 'codex', root);
    setSessionModel('b', 'codex:gpt-6.1-sol', 'codex', root);
    setSessionThinkingLevel('a', 'max', root);
    registerComposerHandlers(registry, { configRoot: root, request: async () => ({}), push: () => {},
      onSessionConfigChanged: change => { changes.push({ ...change }); } });
    assertDeepEqual(await invoke(registry, 'session:get-fast-mode', { sessionId: 'a' }), { enabled: false, supported: true }, 'Standard by default');
    await invoke(registry, 'session:set-fast-mode', { sessionId: 'a', enabled: true });
    assertEqual(readSessionFastMode('a', root), true, 'persisted setting survives reread');
    assertEqual(readSessionFastMode('b', root), false, 'other conversation retains Standard');
    assertEqual(readSessionThinkingLevel('a', root), 'max', 'Fast does not change reasoning');
    assertDeepEqual(changes, [{ kind: 'fast', sessionId: 'a' }], 'only A is published');
    assertDeepEqual(await invoke(registry, 'session:get-fast-mode'), { enabled: true, supported: true }, 'future default');
    setSessionModel('new', 'codex:gpt-6.1-sol', 'codex', root);
    assertEqual(readSessionFastMode('new', root), true, 'new chat inherits Fast');
    await invoke(registry, 'session:set-fast-mode', { enabled: false });
    assertEqual(readSessionFastMode('a', root), true, 'draft change cannot change A');
    assertEqual(readSessionFastMode('new', root), true, 'draft change cannot change an existing chat');
    const init = buildSessionInit({ rendererId: 'a', cwd: root, configRoot: root });
    assert(init.ok, 'Codex init');
    assertEqual(object(init.init.config).fastMode, true, 'new and resumed init carries Fast');
    setSessionModel('a', 'subscription:opus', 'subscription', root);
    const other = buildSessionInit({ rendererId: 'a', cwd: root, configRoot: root });
    assert(other.ok, 'subscription init');
    assertEqual(object(other.init.config).fastMode, undefined, 'non-Codex init carries no Fast setting');
    setSessionModel('a', 'codex:gpt-6.1-sol', 'codex', root);
    assertDeepEqual(await invoke(registry, 'session:get-fast-mode', { sessionId: 'a' }), { enabled: true, supported: true }, 'returning to Codex restores its preference');
    await assertRejects(() => invoke(registry, 'session:set-fast-mode', { sessionId: 'a', enabled: 'true' }), 'invalid boolean');
    assertEqual(readSessionFastMode('a', root), true, 'invalid mutation preserves the value');
    forgetEphemeralPreferences('a', root);
    assertEqual(readSessionFastMode('a', root), false, 'disposed session no longer retains Fast');
  });
  h.test('Fast mode migration leaves unopened historical conversations in Standard', () => {
    const root = freshRoot();
    kvSet('migrated.composer_session_source_v3', '1', root);
    kvSet('migrated.composer_session_thinking_v1', '1', root);
    mkdirSync(join(root, 'projects', 'fixture'), { recursive: true });
    writeFileSync(join(root, 'projects', 'fixture', 'old.jsonl'), '');
    setSessionFastMode('', true, root);
    assertEqual(readSessionFastMode('old', root), false, 'unopened history stays Standard');
    assertEqual(readSessionFastMode('created-after', root), true, 'future session inherits default');
  });
  h.test('Fast mode is seeded per source, not from the remembered default', () => {
    const root = freshRoot();
    kvSet('composer.codex_fast_mode', 'true', root);
    // The remembered default is on, but only a Codex conversation can act on it.
    setSessionModel('codex-one', 'codex:gpt-6.1-sol', 'codex', root);
    setSessionModel('custom-one', 'custom:gpt-6.1-sol', 'custom', root);
    setSessionModel('qoder-one', 'qoder:ultimate', 'qoder', root);
    assertEqual(readSessionFastMode('codex-one', root), true, 'Codex conversation inherits Fast');
    assertEqual(readSessionFastMode('custom-one', root), false, 'custom conversation starts Standard');
    assertEqual(readSessionFastMode('qoder-one', root), false, 'subscription conversation starts Standard');
  });
  h.test('A stale Fast row never reaches a conversation on another source', () => {
    const root = freshRoot();
    kvSet('composer.codex_fast_mode', 'true', root);
    setSessionModel('earned', 'codex:gpt-6.1-sol', 'codex', root);
    setSessionFastMode('earned', true, root);
    assertEqual(readSessionFastMode('earned', root), true, 'Codex conversation keeps its own flag');

    // Leave Codex: the row still says enabled, but the capability is gone, so the
    // read must report Standard rather than let the flag travel to the engine.
    setSessionModel('earned', 'custom:gpt-6.1-sol', 'custom', root);
    assertEqual(readSessionFastMode('earned', root), false, 'another source reports Standard');
    const init = buildSessionInit({ rendererId: 'earned', cwd: root, configRoot: root });
    assert(init.ok, 'init resolves');
    assertEqual(object(init.init.config).fastMode, undefined, 'no Fast setting reaches a non-Codex engine');

    // Return to Codex and the preference the conversation earned still applies.
    setSessionModel('earned', 'codex:gpt-6.1-sol', 'codex', root);
    assertEqual(readSessionFastMode('earned', root), true, 'returning to Codex restores its preference');
  });
  h.test('Fast mode migration clears rows no conversation can act on', () => {
    const root = freshRoot();
    kvSet('migrated.composer_session_source_v3', '1', root);
    kvSet('migrated.composer_session_thinking_v1', '1', root);
    kvSet('migrated.composer_session_fast_v1', '1', root);
    setSessionModel('kept', 'codex:gpt-6.1-sol', 'codex', root);
    setSessionModel('cleared', 'custom:gpt-6.1-sol', 'custom', root);
    // Re-arm the migration and leave behind the rows an earlier revision wrote.
    withSettingsDb(root, db => {
      db.prepare('DELETE FROM settings WHERE key = ?').run('migrated.composer_fast_source_scoped_v1');
      const stale = db.prepare('UPDATE session_fast_modes SET enabled = 1 WHERE session_id = ?');
      stale.run('cleared');
      stale.run('kept');
    });
    readSessionModel('kept', root);
    withSettingsDb(root, db => {
      const read = db.prepare('SELECT enabled FROM session_fast_modes WHERE session_id = ?');
      assertEqual((read.get('cleared') as { enabled: number }).enabled, 0, 'foreign-source row cleared');
      assertEqual((read.get('kept') as { enabled: number }).enabled, 1, 'Codex row preserved');
      assertEqual(kvGet('migrated.composer_fast_source_scoped_v1', root), '1', 'migration recorded once');
    });
  });
  for (const vector of fastModeVectors.inferenceProjection) {
    h.test(`Fast mode live inference projection: ${vector.name}`, () => {
      const selection = inferenceInit(vector.init);
      assertDeepEqual(selection, vector.expected, 'flag survives named facade projection');
      assertEqual(object(replaceInferenceInit({ config: { fastMode: true, sandbox: 'auto' } }, selection).config).fastMode,
        vector.expected.config.fastMode, 'publication replaces old Fast state');
    });
  }
  h.test('model resolver failure is visible and never changes the saved selection', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    setSessionModel('thread', 'auto', 'custom', root);
    registerComposerHandlers(registry, { configRoot: root, request: async () => ({ source: 'codex', selection: 'codex:wrong' }),
      push: () => {}, onSessionConfigChanged: () => {} });
    const result = object(await invoke(registry, 'session:get-main-model', { sessionId: 'thread' }));
    assertEqual(result.resolvedMode, null, 'foreign source refused');
    assert(typeof result.resolutionError === 'string', 'error shown');
    assertDeepEqual(readSessionModel('thread', root), { mode: 'auto', source: 'custom' }, 'no fallback write');
  });
  h.test('persisted model sources are available without starting a provider or fetching a catalog', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    let requests = 0;
    registerComposerHandlers(registry, { configRoot: root,
      request: async () => { requests++; throw new Error('Provider catalog is offline'); },
      push: () => {}, onSessionConfigChanged: () => {} });
    setSessionModel('first', 'auto', 'custom', root);
    setSessionModel('second', 'auto', 'codex', root);
    assertDeepEqual(await invoke(registry, 'session:get-main-model', { sessionId: 'first', resolve: false }),
      { mode: 'auto', source: 'custom', resolvedMode: null }, 'existing conversation retains its source offline');
    assertDeepEqual(await invoke(registry, 'session:get-main-model', { resolve: false }),
      { mode: 'auto', source: 'codex', resolvedMode: null }, 'draft reads the latest default offline');
    assertEqual(requests, 0, 'persisted source reads never contact the engine');
    const resolved = object(await invoke(registry, 'session:get-main-model', { sessionId: 'first' }));
    assertEqual(resolved.source, 'custom', 'resolution failure retains the persisted source');
    assertEqual(resolved.resolvedMode, null, 'unavailable model is not guessed');
    assertEqual(requests, 1, 'full resolution still uses the named engine facade');
  });
  h.test('settings routes engine configuration without copying it into SQLite and writes related intent atomically', async () => {
    const root = freshRoot(), fixture = configEngine(), registry = new ChannelRegistry(), changed: string[] = [];
    registerSettingsHandlers(registry, { configRoot: root, request: fixture.request, onSettingsChanged: key => { changed.push(key); } });
    for (const channel of SETTINGS_CHANNELS) assert(registry.lookup(channel), channel);
    assertEqual(await invoke(registry, 'settings:kv:get', { key: 123 }), null, 'missing or invalid get is null');
    await Promise.all([
      invoke(registry, 'settings:kv:set', { key: 'klaus.webSearch.enabled', value: 'on' }),
      invoke(registry, 'settings:kv:set', { key: 'klaus.webSearch.source', value: 'codex' }),
    ]);
    assertDeepEqual(object(fixture.values.webSearch), { mode: 'client', source: 'codex' }, 'source and enabled compose, and the engine learns the chosen source');
    assertEqual(kvGet('klaus.webSearch.source', root), null, 'no second store');
    const batches = fixture.calls.filter(call => call.method === 'config/batchWrite');
    assert(batches.every(call => (object(call.params).edits as Json[]).length === 3), 'intent, mode and source in one batch');
    await invoke(registry, 'settings:kv:set', { key: 'klaus.maxToolConcurrency', value: '3.9' });
    assertEqual(await invoke(registry, 'settings:kv:get', { key: 'klaus.maxToolConcurrency' }), '3', 'number encoding');
    const requestCount = fixture.calls.length;
    for (const key of ['klaus.sandbox', 'klaus.sandbox.requireReal', 'klaus.sandbox.retryOnDenial', 'klaus.confineReads',
      'klaus.additionalReadableRoots', 'klaus.additionalWritableRoots', 'composer.permission_mode', 'migrated.composer_permission_v2']) {
      const rejectedWrite = await assertRejects(() => invoke(registry, 'settings:kv:set', { key, value: '/safe,relative' }), 'retired execution storage is rejected');
      assert(rejectedWrite instanceof IpcHandlerError && rejectedWrite.code === 'BAD_REQUEST', 'retired writes return a typed request error');
      const rejectedRead = await assertRejects(() => invoke(registry, 'settings:kv:get', { key }), 'retired execution storage is not an alternate read surface');
      assert(rejectedRead instanceof IpcHandlerError && rejectedRead.code === 'BAD_REQUEST', 'retired reads return a typed request error');
      assertEqual(kvGet(key, root), null, 'retired execution settings never gain another SQLite copy');
    }
    assertEqual(fixture.calls.length, requestCount, 'retired settings never reach the engine configuration writer');
    assertEqual(fixture.values.additionalWritableRoots, undefined, 'retired root fields are not reconstructed');
    assertEqual(changed.length, 3, 'only accepted settings publish invalidation hooks');
  });
  h.test('custom model definitions and keys use separate named APIs and retired roles migrate once', async () => {
    const fixture = configEngine(), engine = new EngineSettings(fixture.request);
    await engine.upsertModel({ id: 'a.b"c', name: 'Primary', provider: 'openai', model: 'model-a', apiKey: 'fixture-secret',
      openaiApi: 'responses', supportsVision: true, reasoningEffort: 'xhigh' });
    await engine.upsertModel({ id: 'secondary', name: 'Secondary', provider: 'anthropic', model: 'model-b', supportsThinking: true });
    assert(!JSON.stringify(fixture.values).includes('fixture-secret'), 'key absent from config');
    const list = await engine.listModels();
    assert(!JSON.stringify(list).includes('fixture-secret'), 'key absent from renderer list');
    const row = object(list[0]);
    assertEqual(row.reasoningEffort, 'xhigh', 'capabilities round trip');
    assertEqual(row.supportsVision, true, 'vision declaration round trip');
    assertEqual(row.openaiApi, 'responses', 'endpoint kind retained');
    const credentials = fixture.calls.filter(call => call.method === 'model/credential/write');
    assertDeepEqual(credentials[0]?.params, { id: 'a.b"c', apiKey: 'fixture-secret' }, 'credential store RPC');
    // A pre-roles-retirement config carries role arrays; the one-shot migration
    // turns them into the custom source's tier map, then drops the fields.
    object(object(fixture.values.modelProviders)['a.b"c']).roles = ['sonnet'];
    const root = freshRoot();
    const before = fixture.calls.length;
    await migrateProviderRolesToTiers(engine, root);
    assertEqual(kvGet('model_tiers:custom', root), JSON.stringify({ medium: 'a.b"c' }), 'role becomes the tier pick');
    const roleEdits = (object(fixture.calls.slice(before).find(call => call.method === 'config/batchWrite')?.params).edits as Json[]).map(object);
    assert(roleEdits.length === 2 && roleEdits.every(edit => String(edit.keyPath).endsWith('.roles')), 'role removal covers both entries in one batch');
    // An existing map, even an empty one, wins: a second run writes nothing.
    await migrateProviderRolesToTiers(engine, root);
    assertEqual(fixture.calls.slice(before).filter(call => call.method === 'config/batchWrite').length, 1, 'migration is one-shot');
  });
  for (const vector of customModelThinkingVectors.cases) h.test(`custom model thinking support survives save and reopen: ${vector.name}`, async () => {
    const fixture = configEngine(), engine = new EngineSettings(fixture.request);
    const payload: JsonObject = { id: 'thinking-model', name: 'Thinking model', maxContextTokens: 562_144,
      supportsVision: true, thinking: 'off', ...vector.payload };
    for (const enabled of [true, false, true]) {
      await engine.upsertModel({ ...payload, supportsThinking: enabled });
      const row = object((await new EngineSettings(fixture.request).listModels())[0]);
      assertEqual(row.supportsThinking, enabled, 'saved thinking support is restored by a fresh reader');
      assertEqual(row.thinking, 'off', 'capability does not enable conversation thinking');
      assertEqual(row.reasoningEffort, payload.reasoningEffort, 'reasoning effort remains independent');
      assertEqual(row.supportsVision, true, 'vision declaration is preserved');
      assertEqual(row.maxContextTokens, 562_144, 'custom context window is preserved');
      assertEqual(row.openaiApi, payload.openaiApi, 'endpoint kind is preserved');
      const capabilities = object(object(object(fixture.values.modelProviders)['thinking-model']).capabilities);
      assertEqual(capabilities.reasoningDialect, vector.dialect, 'request dialect is preserved');
      assertEqual(Object.hasOwn(capabilities, 'thinking'), enabled, 'engine configuration retains the declaration');
    }
  });
  h.test('custom thinking controls publish each conversation choice independently of model capabilities', async () => {
    const root = freshRoot(), fixture = configEngine(), engine = new EngineSettings(fixture.request), registry = new ChannelRegistry();
    await engine.upsertModel({ id: 'qwen-model', name: 'Qwen model', provider: 'openai', model: 'qwen3.8-max',
      openaiApi: 'chat', reasoningEffort: 'xhigh', supportsThinking: true });
    const changes: string[] = [];
    registerComposerHandlers(registry, { configRoot: root, request: fixture.request, engineSettings: engine,
      push: () => {}, onSessionConfigChanged: change => { changes.push(change.kind); } });
    const catalog = object(await invoke(registry, 'session:get-main-model-options', { source: 'custom' }));
    const options = catalog.options as JsonObject[];
    assertDeepEqual(options[0]?.supportedThinkingLevels, ['off', 'low', 'medium', 'high', 'xhigh'], 'declared capability exposes on and off controls');
    for (const selected of ['xhigh', 'off', 'low']) {
      await invoke(registry, 'session:set-thinking-level', { sessionId: 'qwen-thread', level: selected });
      const config = object(inferenceInit({ config: buildSessionConfig(thinkingLevelFor('qwen-thread', root), false, null, presetRuntimePolicy('default')) }).config);
      assertEqual(config.thinking, selected !== 'off', 'the named model update carries explicit thinking intent');
      assertEqual(config.effort, selected === 'off' ? undefined : selected, 'off removes the previous effort');
    }
    assertDeepEqual(changes, ['thinking', 'thinking', 'thinking'], 'each chat selection invalidates the live configuration');
    assertEqual(object((await engine.listModels())[0]).supportsThinking, true, 'conversation off does not clear model support');
  });
  h.test('catalog projection keeps provider thinking declarations including distinct xhigh and max levels', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    registerComposerHandlers(registry, { configRoot: root, push: () => {}, onSessionConfigChanged: () => {},
      request: async method => method === 'codex/models' ? { models: [{ id: 'a', name: ' A ', supportedReasoningLevels: ['low', 'xhigh', 'max'], defaultReasoning: 'xhigh' }] }
        : { models: [{ key: 'q', display_name: 'Q', efforts: ['minimal', 'ultra'], canDisableThinking: true, defaultEffort: 'minimal' }] } });
    assertDeepEqual(await invoke(registry, 'session:get-main-model-options', { source: 'codex' }), {
      options: [{ value: 'codex:a', label: 'A', description: 'a', supportsFastMode: true, supportedThinkingLevels: ['low', 'xhigh', 'max'], defaultThinkingLevel: 'xhigh' }],
    }, 'codex ladder');
    assertDeepEqual(await invoke(registry, 'session:get-main-model-options', { source: 'qoder' }), {
      options: [{ value: 'qoder:q', label: 'Q', description: 'Q', supportsFastMode: false, supportedThinkingLevels: ['off', 'low', 'max'], defaultThinkingLevel: 'low' }],
    }, 'qoder ladder');
    assertDeepEqual(await invoke(registry, 'session:get-main-model-options', { source: 'qwenwork' }), {
      options: [{ value: 'qwenwork:q', label: 'Q', description: 'Q', supportedThinkingLevels: ['off', 'low', 'max'], defaultThinkingLevel: 'low' }],
    }, 'qwenwork ladder');
    const failure = await assertRejects(() => invoke(registry, 'session:get-main-model-options', { source: 'local' }), 'retired source refused');
    assert(failure instanceof IpcHandlerError && failure.code === 'INVALID_MODEL_SOURCE', 'a retired source is unknown to the catalog');
  });
  h.test('subscription effort ladders project current models and preserve no-knob entries', async () => {
    // Local Ultra does not declare or send an unsupported native effort parameter.
    const root = freshRoot(), registry = new ChannelRegistry();
    registerComposerHandlers(registry, { configRoot: root, push: () => {}, onSessionConfigChanged: () => {},
      request: async () => ({ models: [
        { alias: 'fable', label: 'Fable 5.2', fastMode: true, fastBilling: 'extraCredits', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { alias: 'opus', label: 'Opus 5.5', tier: 'high', fastMode: true, fastBilling: 'extraCredits', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { alias: 'haiku', label: 'Haiku 5.5', tier: 'low', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { alias: 'legacy-small', label: 'Legacy small', effortLevels: [] },
      ] }) });
    const options = object(await invoke(registry, 'session:get-main-model-options', { source: 'subscription' })).options;
    const rows = Array.isArray(options) ? options.map(row => object(row)) : [];
    const [fable, opus, haiku, legacy] = rows;
    assertDeepEqual(rows.map(row => row.value), ['subscription:fable', 'subscription:opus', 'subscription:haiku', 'subscription:legacy-small'], 'all aliases are offered');
    assertEqual(object(fable).label, 'Fable 5.2', 'current Fable is labeled');
    assertEqual(object(fable).supportsFastMode, true, 'Fable 5.2 advertises Fast mode');
    assertDeepEqual(object(fable).supportedThinkingLevels, ['low', 'medium', 'high', 'xhigh', 'max'], 'Fable effort levels are projected');
    assertDeepEqual(object(opus).supportedThinkingLevels, ['low', 'medium', 'high', 'xhigh', 'max'], 'a declared ladder is projected');
    assertEqual(object(haiku).label, 'Haiku 5.5', 'current Haiku is labeled');
    assertDeepEqual(object(haiku).supportedThinkingLevels, ['low', 'medium', 'high', 'xhigh', 'max'], 'Haiku effort levels are projected');
    assertDeepEqual(object(legacy).supportedThinkingLevels, [], 'a model without an effort knob still offers the local orchestration choice');
  });
  h.test('QwenWork auth channels use only the named engine facade and open the returned authorization URL', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), calls: Array<{ method: string; params: Json }> = [];
    const { authUrl } = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/qwenwork-login-vectors.json'), 'utf8')) as { authUrl: string };
    let opened = '', authChanges = 0;
    const service = registerAuthHandlers(registry, accountDeps(root, {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'qwenwork/status') return { loggedIn: false };
        if (method === 'qwenwork/loginStart') return { ok: true, flowId: 'flow-1', authUrl };
        if (method === 'qwenwork/loginPoll') return { ok: false, pending: true };
        if (method === 'qwenwork/models') return { models: [{ key: 'qwork-auto', display_name: 'Standard', efforts: ['low', 'high'], contextTokens: [180000], max_output_tokens: 32768, is_vl: true }] };
        if (method === 'qwenwork/logout') return { ok: true };
        throw new Error('Unexpected fixture RPC ' + method);
      },
      openExternal: async url => { opened = url; },
      onAuthChanged: async () => { authChanges++; },
    }));
    try {
      assertDeepEqual(await invoke(registry, 'qwenwork-auth:status'), { loggedIn: false }, 'status');
      assertEqual(object(await invoke(registry, 'qwenwork-auth:start')).flowId, 'flow-1', 'start');
      assertEqual(opened, authUrl, 'gateway authorization page opened with all query parameters intact');
      assertDeepEqual(await invoke(registry, 'qwenwork-auth:poll', { flowId: 'flow-1' }), { ok: false, pending: true }, 'poll');
      assertDeepEqual(await invoke(registry, 'qwenwork-auth:models'), { ok: true, models: [{ key: 'qwork-auto', display_name: 'Standard', efforts: ['low', 'high'], contextTokens: [180000], max_output_tokens: 32768, is_vl: true, id: 'qwork-auto', name: 'Standard', description: 'Standard' }] }, 'catalog projection keeps model-specific metadata');
      assertDeepEqual(await invoke(registry, 'qwenwork-auth:logout'), { ok: true }, 'logout');
      assertEqual(authChanges, 1, 'logout invalidates active inference configuration');
      assertDeepEqual(calls.map(call => call.method), [
        'qwenwork/status', 'qwenwork/loginStart', 'qwenwork/loginPoll', 'qwenwork/models', 'qwenwork/logout',
      ], 'named facade methods');
      assertDeepEqual(calls[2]?.params, { flow: { flowId: 'flow-1' } }, 'flow payload');
    } finally { service.close(); }
  });
  h.test('Bailian console login opens the engine authorize URL and survives a failed handoff', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), calls: string[] = [];
    const authorizeUrl = 'https://bailian.console.aliyun.com/console-login?notice=127.0.0.1:53001?state=abc123';
    let opened = '';
    const service = registerAuthHandlers(registry, accountDeps(root, {
      request: async (method, params) => {
        calls.push(method);
        if (method === 'bailian/consoleLogin') return { ok: true, url: authorizeUrl, site: 'domestic' };
        if (method === 'bailian/consoleStatus') return { loggedIn: false };
        if (method === 'bailian/consoleLogout') return { ok: true };
        throw new Error('Unexpected fixture RPC ' + method);
      },
      openExternal: async url => { opened = url; },
    }));
    try {
      const result = object(await invoke(registry, 'bailian-auth:console-login'));
      assertEqual(string(result.url), authorizeUrl, 'the channel passes the authorize URL through');
      assertEqual(opened, authorizeUrl, 'the host hands the authorize URL to the browser');
      assertDeepEqual(calls, ['bailian/consoleLogin'], 'one named facade method');
    } finally { service.close(); }
    // A browser that refuses the handoff must not turn the channel into an
    // error: the card keeps waiting on the loopback listener instead, and the
    // failure lands on the diagnostic record rather than vanishing.
    const registry2 = new ChannelRegistry();
    const logged: string[] = [];
    const service2 = registerAuthHandlers(registry2, accountDeps(root, {
      request: async method => (method === 'bailian/consoleLogin' ? { ok: true, url: authorizeUrl } : { loggedIn: false }),
      openExternal: async () => { throw new Error('no browser on this machine'); },
      log: (kind, detail) => { logged.push(kind + ' ' + detail); },
    }));
    try {
      const result = object(await invoke(registry2, 'bailian-auth:console-login'));
      assertEqual(string(result.url), authorizeUrl, 'the channel still answers when the handoff fails');
      assert(logged.some(line => line.startsWith('bailian-console-login') && line.includes('handoff-failed')), 'the failed handoff is on the record');
    } finally { service2.close(); }
  });
  h.test('WorkBuddy auth channels use only the named engine facade and open the returned authorization URL', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), calls: Array<{ method: string; params: Json }> = [];
    const { authUrl } = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/workbuddy-login-vectors.json'), 'utf8')) as { authUrl: string };
    let opened = '', authChanges = 0;
    const service = registerAuthHandlers(registry, accountDeps(root, {
      request: async (method, params) => {
        calls.push({ method, params });
        if (method === 'workbuddy/status') return { loggedIn: false };
        if (method === 'workbuddy/loginStart') return { ok: true, flowId: 'flow-1', authUrl, interval: 1, expiresAt: Date.now() + 300_000 };
        if (method === 'workbuddy/loginPoll') return { ok: false, pending: true };
        if (method === 'workbuddy/models') return { models: [{ key: 'default-model', display_name: 'Auto', efforts: ['low', 'high'], contextTokens: [176000], max_output_tokens: 24000, is_vl: true, priceFactor: 0.34, icon: 'https://fixture.invalid/icon.png' }] };
        if (method === 'workbuddy/logout') return { ok: true };
        throw new Error('Unexpected fixture RPC ' + method);
      },
      openExternal: async url => { opened = url; },
      onAuthChanged: async () => { authChanges++; },
    }));
    try {
      assertDeepEqual(await invoke(registry, 'workbuddy-auth:status'), { loggedIn: false }, 'status');
      assertEqual(object(await invoke(registry, 'workbuddy-auth:start')).flowId, 'flow-1', 'start');
      assertEqual(opened, authUrl, 'the external-link page is opened with its state and platform intact');
      assertDeepEqual(await invoke(registry, 'workbuddy-auth:poll', { flowId: 'flow-1' }), { ok: false, pending: true }, 'poll');
      assertDeepEqual(await invoke(registry, 'workbuddy-auth:models'), {
        ok: true,
        models: [{
          key: 'default-model', display_name: 'Auto', efforts: ['low', 'high'], contextTokens: [176000],
          max_output_tokens: 24000, is_vl: true, priceFactor: 0.34, icon: 'https://fixture.invalid/icon.png',
          id: 'default-model', name: 'Auto', description: 'Auto',
        }],
      }, 'catalog projection keeps the credit multiplier and icon the picker renders');
      assertDeepEqual(await invoke(registry, 'workbuddy-auth:logout'), { ok: true }, 'logout');
      assertEqual(authChanges, 1, 'logout invalidates active inference configuration');
      assertDeepEqual(calls.map(call => call.method), [
        'workbuddy/status', 'workbuddy/loginStart', 'workbuddy/loginPoll', 'workbuddy/models', 'workbuddy/logout',
      ], 'named facade methods');
      assertDeepEqual(calls[2]?.params, { flow: { flowId: 'flow-1' } }, 'flow payload');
    } finally { service.close(); }
  });

  h.test('WorkBuddy browser login forwards the selected account site and refuses invalid regions', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), calls: Json[] = [], opened: string[] = [];
    const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/workbuddy-login-vectors.json'), 'utf8')) as {
      regions: Array<{ region: string; authUrl: string }>;
    };
    const service = registerAuthHandlers(registry, accountDeps(root, {
      request: async (method, params) => {
        assertEqual(method, 'workbuddy/loginStart', 'only the login facade is invoked');
        calls.push(params);
        const row = vectors.regions.find(row => row.region === object(params).region) ?? vectors.regions[1];
        assert(row !== undefined, 'the login vector includes an international default');
        return { ok: true, flowId: 'regional-flow', authUrl: row.authUrl };
      },
      openExternal: async url => { opened.push(url); },
    }));
    try {
      for (const row of vectors.regions) {
        await invoke(registry, 'workbuddy-auth:start', { region: row.region });
        assertEqual(opened.at(-1), row.authUrl, 'the chosen edition authorization page is opened unchanged');
      }
      await invoke(registry, 'workbuddy-auth:start');
      assertDeepEqual(calls, [{ region: 'cn' }, { region: 'intl' }, {}], 'both editions and legacy callers retain their parameters');
      for (const region of ['', 'unknown', null, 1]) {
        const error = await assertRejects(() => invoke(registry, 'workbuddy-auth:start', { region }), 'invalid region');
        assert(String(error).includes('must be cn or intl'), 'invalid sites explain the accepted values');
      }
      assertEqual(calls.length, 3, 'invalid sites never reach the engine');
    } finally { service.close(); }
  });

  h.test('WorkBuddy import channel forwards only valid selected editions', async () => {
    const registry = new ChannelRegistry(), imports: unknown[] = [];
    const service = registerAuthHandlers(registry, accountDeps(freshRoot()));
    service.subscriptions.workbuddyImportLocal = async region => { imports.push(region); return { ok: true }; };
    try {
      for (const region of ['cn', 'intl']) assertDeepEqual(await invoke(registry, 'workbuddy-auth:import-local', { region }), { ok: true }, 'selected import');
      await invoke(registry, 'workbuddy-auth:import-local');
      assertDeepEqual(imports, ['cn', 'intl', undefined], 'the selected edition reaches the import service');
      for (const region of ['', 'unknown', null, 1]) await assertRejects(() => invoke(registry, 'workbuddy-auth:import-local', { region }), 'invalid import edition');
      assertEqual(imports.length, 3, 'invalid regions never read native credentials');
    } finally { service.close(); }
  });

  h.test('a dead WorkBuddy catalog recovers by re-import only and never spends a refresh token', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(), calls: string[] = [];
    const credentials = {
      present: true,
      machineId: 'uid-1',
      userInfo: { uid: 'uid-1', access_token: 'copied-jwt' },
    } as { present: boolean; machineId?: string; userInfo?: Json; error?: string };
    const service = registerAuthHandlers(registry, accountDeps(root, {
      // The native reader is what re-import goes through, so the fixture has to be
      // the same shape the real one returns.
      subscriptionCredentials: {
        readClaudeOAuth: async () => ({ value: null }),
        readClaudeAccounts: async () => ({ accounts: [] }),
        writeClaudeAccounts: async () => ({ success: true }),
        writeClaudeOAuth: async () => ({ success: true }),
        removeClaudeOAuth: async () => true,
        readLocalClaudeCredential: async () => ({ present: false }),
        readCursorCredential: async () => ({ present: false }),
        readQoderIdeCredential: async () => ({ present: false }),
        readAntigravityKeychainSecret: async () => ({ present: false }),
        readQwenWorkCredential: async () => ({ present: false }),
        readWorkBuddyCredential: async () => ({ ...credentials }),
      },
      request: async (method, params) => {
        calls.push(method);
        if (method === 'workbuddy/models') {
          // The first read hits a token WorkBuddy rotated; after a re-import the
          // store copy is current and the catalog answers.
          if (calls.filter(name => name === 'workbuddy/models').length === 1) {
            throw new Error('workbuddy_login_expired');
          }
          return { models: [{ key: 'kimi-k3', display_name: 'Kimi K3' }] };
        }
        if (method === 'workbuddy/adoptCredential') return { ok: true };
        if (method === 'workbuddy/status') return { loggedIn: true, loginMethod: 'adopted', region: 'cn' };
        throw new Error('Unexpected fixture RPC ' + method);
      },
      openExternal: async () => {},
      onAuthChanged: async () => {},
    }));
    try {
      assertDeepEqual(await invoke(registry, 'workbuddy-auth:models'), {
        ok: true, models: [{ key: 'kimi-k3', display_name: 'Kimi K3', id: 'kimi-k3', name: 'Kimi K3', description: 'Kimi K3' }],
      }, 'the re-imported login answers the retry');
      assertDeepEqual(calls, ['workbuddy/models', 'workbuddy/status', 'workbuddy/adoptCredential', 'workbuddy/models'],
        'recovery re-reads the official store and retries once');
      assert(!calls.includes('workbuddy/refreshToken'),
        'a copied login is never refreshed: WorkBuddy rotates the token its own client holds');

      // When the store has nothing left to copy, the card must say so with the
      // stable code rather than retrying into a second dead read.
      calls.length = 0;
      credentials.present = false; credentials.userInfo = undefined; credentials.error = 'workbuddy_local_not_signed_in';
      assertDeepEqual(await invoke(registry, 'workbuddy-auth:models'), {
        ok: false, error: 'workbuddy_adopted_credential_needs_reimport', models: [],
      }, 'nothing to copy is reported as needing a re-import');
      assertDeepEqual(calls, ['workbuddy/models', 'workbuddy/status'], 'one dead read and its edition check, no refresh, no retry');
    } finally { service.close(); }
  });

  h.test('real account poll uses PKCE, stores private credentials, removes guest mode and broadcasts the user', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    writeFileSync(join(root, 'klaus-guest-mode'), '1');
    let authorize = new URL('https://fixture.invalid'), polls = 0;
    const pushes: Array<{ channel: string; payload: Json }> = [];
    const fixture = await server(async (req, res) => {
      if (req.url === '/api/auth/desktop/poll') {
        const data = await body(req); polls++;
        assertEqual(data.state, authorize.searchParams.get('state'), 'state sent with poll');
        assertEqual(createHash('sha256').update(String(data.code_verifier)).digest('base64url'), authorize.searchParams.get('code_challenge'), 'PKCE matches');
        json(res, { status: 'ok', token: 'fixture-token', user: { id: 'user-1', email: 'user@example.test' } });
      } else json(res, { error: 'fixture_unknown_route' }, 401);
    });
    const service = registerAuthHandlers(registry, accountDeps(root, { serverUrl: fixture.url, openExternal: async url => { authorize = new URL(url); }, push: (channel, payload) => { pushes.push({ channel, payload }); } }));
    try {
      for (const channel of AUTH_CHANNELS) assert(registry.lookup(channel), channel);
      const result = object(await invoke(registry, 'klausAuth:login'));
      assertEqual(result.ok, true, 'login succeeds with a valid account grant');
      assertEqual(polls, 1, 'completed first poll');
      assert(!existsSync(join(root, 'klaus-guest-mode')), 'guest marker removed');
      assertEqual(object(JSON.parse(readFileSync(join(root, 'klaus-auth.json'), 'utf8'))).token, 'fixture-token', 'token persisted');
      if (process.platform !== 'win32') assertEqual(statSync(join(root, 'klaus-auth.json')).mode & 0o777, 0o600, 'credential permissions');
      assertEqual(pushes[0]?.channel, 'klausAuth:loginPending', 'pending link emitted');
      assertEqual(pushes.at(-1)?.channel, 'klausAuth:updated', 'user emitted');
      assert(!JSON.stringify(result).includes('fixture-token'), 'token not returned to renderer');
    } finally { service.close(); await fixture.close(); }
  });
  h.test('cancel aborts an in-flight account poll and writes no auth file', async () => {
    const root = freshRoot();
    let requested = false;
    const fixture = await server(req => { if (req.url === '/api/auth/desktop/poll') requested = true; });
    const service = new AccountService(accountDeps(root, { serverUrl: fixture.url, requestTimeoutMs: 30_000 }));
    try {
      const pending = service.login();
      await waitFor(() => requested, 1000, 'poll started');
      service.cancelLogin();
      assertDeepEqual(await pending, { ok: false, error: 'login cancelled' }, 'prompt cancellation');
      assert(!existsSync(join(root, 'klaus-auth.json')), 'no credentials after cancellation');
    } finally { service.close(); await fixture.close(); }
  });
  h.test('account login reports unreachable servers, HTTP rejection and malformed successful grants', async () => {
    const root = freshRoot();
    let calls = 0;
    const unreachable = new AccountService(accountDeps(root, { fetch: async () => { calls++; throw new Error('fixture unreachable'); } }));
    const failed = object(await unreachable.login());
    assertEqual(failed.ok, false, 'transport failure reported');
    assertEqual(failed.error, 'login_server_unreachable', 'stable transport error code');
    assertEqual(calls, 5, 'bounded unreachable attempts');
    unreachable.close();
    for (const [status, response] of [[403, { error: 'forbidden' }], [200, { status: 'ok', token: 'without-user' }]] as const) {
      const fixture = await server((_req, res) => json(res, response, status));
      const service = new AccountService(accountDeps(root, { serverUrl: fixture.url }));
      try {
        assertEqual(object(await service.login()).ok, false, 'invalid login refused');
        assert(!existsSync(join(root, 'klaus-auth.json')), 'invalid grant never persisted');
      } finally { service.close(); await fixture.close(); }
    }
  });
  h.test('account login retries gateway restarts and never exposes their HTML response', async () => {
    const root = freshRoot();
    let polls = 0;
    const fixture = await server((req, res) => {
      if (req.url === '/api/auth/desktop/poll') {
        polls++;
        if (polls <= 3) {
          res.writeHead(501 + polls, { 'content-type': 'text/html' });
          res.end(`<html><body><h1>${501 + polls} gateway restart</h1></body></html>`);
          return;
        }
        json(res, { status: 'ok', token: 'fixture-token', user: { id: 'user-1' } });
        return;
      }
      json(res, { error: 'fixture_unknown_route' }, 401);
    });
    const service = new AccountService(accountDeps(root, { serverUrl: fixture.url }));
    try {
      const result = object(await service.login());
      assertEqual(result.ok, true, 'login survives one gateway restart');
      assertEqual(polls, 4, 'poll retried after 502, 503 and 504');
    } finally { await service.close(); await fixture.close(); }

    const unavailable = new AccountService(accountDeps(freshRoot(), {
      fetch: async () => new Response('<html><body>gateway secret</body></html>', { status: 502 }),
    }));
    try {
      const result = object(await unavailable.login());
      assertDeepEqual(result, { ok: false, error: 'login_service_unavailable' }, 'persistent gateway outage is product copy code');
      assert(!JSON.stringify(result).includes('gateway secret'), 'gateway HTML is never returned to the renderer');
    } finally { await unavailable.close(); }
  });
  h.test('offline logout clears account state and broadcasts signout', async () => {
    const root = freshRoot();
    signedIn(root);
    let changed = 0;
    const pushes: Array<{ channel: string; payload: Json }> = [];
    const service = new AccountService(accountDeps(root, {
      fetch: async () => { throw new Error('offline'); },
      onAuthChanged: () => { changed++; },
      push: (channel, payload) => { pushes.push({ channel, payload }); },
    }));
    try {
      assertDeepEqual(await service.logout(false), { ok: true }, 'local logout works offline');
      assert(!existsSync(join(root, 'klaus-auth.json')), 'credentials removed');
      assertEqual(changed, 1, 'dependent services are refreshed');
      assertDeepEqual(pushes.at(-1), { channel: 'klausAuth:updated', payload: { user: null } }, 'renderer receives signout');
    } finally { await service.close(); }
  });
  h.test('server-side device revocation clears the local account without a redundant logout request', async () => {
    const root = freshRoot();
    signedIn(root);
    let changed = 0, requests = 0;
    const pushes: Array<{ channel: string; payload: Json }> = [];
    const service = new AccountService(accountDeps(root, {
      fetch: async () => { requests++; throw new Error('no HTTP request expected'); },
      onAuthChanged: () => { changed++; },
      push: (channel, payload) => { pushes.push({ channel, payload }); },
    }));
    try {
      await service.authorizationExpired();
      assertEqual(requests, 0, 'revocation does not call logout with a dead token');
      assertEqual(changed, 1, 'dependent runtimes are refreshed');
      assert(!existsSync(join(root, 'klaus-auth.json')), 'local account state cleared');
      assertDeepEqual(pushes.at(-1), { channel: 'klausAuth:updated', payload: { user: null } }, 'renderer receives signout');
      await service.authorizationExpired();
      assertEqual(changed, 1, 'duplicate revocation is idempotent');
    } finally { await service.close(); }
  });
  h.test('late profile responses cannot resurrect an account after logout', async () => {
    const root = freshRoot();
    signedIn(root);
    let release: ((response: Response) => void) | undefined;
    const service = new AccountService(accountDeps(root, { fetch: async url => {
      if (String(url).endsWith('/api/auth/profile')) return new Promise<Response>(resolve => { release = resolve; });
      return new Response('{}', { status: 200 });
    } }));
    try {
      const pending = service.updateProfile('After');
      await waitFor(() => release !== undefined, 1000, 'profile request started');
      await service.logout(false);
      release!(new Response(JSON.stringify({ user: { id: 'account-1', displayName: 'After' } }), { status: 200 }));
      assertEqual(object(await pending).ok, false, 'stale response rejected');
      assert(!existsSync(join(root, 'klaus-auth.json')), 'logout remains effective');
    } finally { service.close(); }
  });
  h.test('account login commits a valid grant without secondary authorization requests', async () => {
    const root = freshRoot(), requests: string[] = [];
    const service = new AccountService(accountDeps(root, { fetch: async url => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      if (path !== '/api/auth/desktop/poll') throw new Error('Unexpected secondary request');
      return new Response(JSON.stringify({ status: 'ok', token: 'fixture-token', user: { id: 'user-1' } }));
    } }));
    try {
      assertEqual(object(await service.login()).ok, true, 'a valid account grant is enough');
      assertDeepEqual(requests, ['/api/auth/desktop/poll'], 'login calls only the poll endpoint');
      assertEqual(object(JSON.parse(readFileSync(join(root, 'klaus-auth.json'), 'utf8'))).token, 'fixture-token', 'the account is committed');
    } finally { await service.close(); }
  });
  h.test('pending login has a bounded deadline and a late grant cannot undo logout', async () => {
    const root = freshRoot();
    const fixture = await server((_req, res) => json(res, { status: 'pending' }));
    const limited = new AccountService(accountDeps(root, { serverUrl: fixture.url, loginTimeoutMs: 25 }));
    try {
      const result = object(await limited.login());
      assertEqual(result.ok, false, 'deadline refuses unfinished login');
      assertEqual(result.error, 'login_timed_out', 'timeout surfaced as a stable code');
    } finally { limited.close(); await fixture.close(); }
    let release: ((response: Response) => void) | undefined;
    const service = new AccountService(accountDeps(root, { fetch: async url => {
      if (String(url).endsWith('/api/auth/desktop/poll')) return new Promise<Response>(resolve => { release = resolve; });
      return new Response('{}', { status: 200 });
    } }));
    try {
      const pending = service.login();
      await waitFor(() => release !== undefined, 1000, 'login poll pending');
      await service.logout(false);
      release!(new Response(JSON.stringify({ status: 'ok', token: 'late-token', user: { id: 'user-1' } }), { status: 200 }));
      assertDeepEqual(await pending, { ok: false, error: 'login cancelled' }, 'late grant refused');
      assert(!existsSync(join(root, 'klaus-auth.json')), 'no account resurrection');
    } finally { service.close(); }
  });
  h.test('closing an account service cancels browser handoff and prevents later login writes', async () => {
    const root = freshRoot();
    const service = new AccountService(accountDeps(root, { openExternal: () => new Promise<void>(() => {}) }));
    const pending = service.login();
    service.close();
    assertDeepEqual(await pending, { ok: false, error: 'login cancelled' }, 'closing aborts browser handoff');
    assert(!existsSync(join(root, 'klaus-auth.json')), 'nothing persisted');
  });
  h.test('destructive auth channels require a host quiescence hook and wait for it before removing data', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    const service = registerAuthHandlers(registry, accountDeps(root));
    assert(!registry.lookup('klausAuth:wipeLocal'), 'no fake wipe handler without lifecycle integration');
    await assertRejects(() => service.logout(true), 'wipe not integrated');
    service.close();
    writeFileSync(join(root, 'settings.db'), 'fixture');
    let quiesced = false;
    const configured = new AccountService(accountDeps(root, { beforeWipeLocal: async () => {
      assert(existsSync(join(root, 'settings.db')), 'data present before quiescing');
      quiesced = true;
    } }));
    try {
      assertDeepEqual(await configured.wipeLocal(), { ok: true }, 'real wipe');
      assert(quiesced && !existsSync(join(root, 'settings.db')), 'closed resources before removal');
    } finally { configured.close(); }
  });
  h.test('concurrent local resets share quiescence and restart and cannot delete newly written data twice', async () => {
    const root = freshRoot(); writeFileSync(join(root, 'settings.db'), 'old'); writeFileSync(join(root, 'config.toml'), 'retained');
    let release!: () => void, stopped = 0, restarted = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = new AccountService(accountDeps(root, { beforeWipeLocal: async () => { stopped++; await gate; }, afterWipeLocal: () => { restarted++; } }));
    try {
      const first = service.wipeLocal(), second = service.wipeLocal(); assertEqual(first, second, 'the destructive operation is single-flight');
      assert(existsSync(join(root, 'settings.db')), 'nothing is removed while live owners drain'); release(); await first;
      assertEqual(stopped, 1, 'one quiescence'); assertEqual(restarted, 1, 'one restart handoff');
      assertEqual(readFileSync(join(root, 'config.toml'), 'utf8'), 'retained', 'engine configuration is outside the six cleanup targets');
      writeFileSync(join(root, 'settings.db'), 'new'); await service.wipeLocal(); assertEqual(readFileSync(join(root, 'settings.db'), 'utf8'), 'new', 'a replay cannot wipe new state');
    } finally { release(); await service.close(); }
  });
  h.test('local reset preserves files when quiescence fails and reports removal when only restart fails', async () => {
    const root = freshRoot(); writeFileSync(join(root, 'settings.db'), 'preserved');
    let restart = 0;
    const blocked = new AccountService(accountDeps(root, { beforeWipeLocal: async () => { throw new Error('native owner still running'); }, afterWipeLocal: () => { restart++; } }));
    try { await assertRejects(() => blocked.wipeLocal(), 'incomplete shutdown blocks deletion'); assertEqual(readFileSync(join(root, 'settings.db'), 'utf8'), 'preserved', 'live data preserved'); assertEqual(restart, 0, 'no relaunch on incomplete cleanup'); }
    finally { await blocked.close(); }
    const failedRestart = new AccountService(accountDeps(root, { beforeWipeLocal: async () => {}, afterWipeLocal: () => { throw new Error('relaunch unavailable'); } }));
    try {
      const error = await assertRejects(() => failedRestart.wipeLocal(), 'relaunch error is surfaced') as IpcHandlerError;
      assertEqual(error.code, 'LOCAL_DATA_REMOVED', 'failure identifies that destructive work already finished'); assert(!existsSync(join(root, 'settings.db')), 'deletion is not misreported as rolled back');
    } finally { await failedRestart.close(); }
  });
  h.test('source mismatch and malformed composer arguments cannot mutate the global default', async () => {
    const root = freshRoot(), registry = new ChannelRegistry();
    setSessionModel('thread', 'custom:original', 'custom', root);
    registerComposerHandlers(registry, { configRoot: root, request: configEngine().request, push: () => {}, onSessionConfigChanged: () => {} });
    await assertRejects(() => invoke(registry, 'session:set-main-model', { sessionId: 7, mode: 'codex:new', source: 'codex' }), 'malformed session id');
    assertEqual(kvGet('composer.main_model', root), 'custom:original', 'default not changed');
    const normalized = kvSet('auth_mode', 'klaus', root);
    assertEqual(normalized, true, 'a retired source normalizes in the public service');
    assertEqual(kvGet('auth_mode', root), 'custom', 'to the default source');
  });
}
