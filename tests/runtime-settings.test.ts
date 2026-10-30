import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Harness } from './harness';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry } from '../main/ipc/registry';
import { EngineSettings, modelEntry, modelRow, runtimeConfigScope } from '../main/services/engine-settings';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { ComposerService } from '../main/services/composer';
import { HostState } from '../main/services/host-state';
import { SessionConfiguration } from '../main/sessions/configuration';
import { applyRuntimeSettings, runtimePolicyForSession, finishPermissionDefaultMigration, storedPermissionMode } from '../main/services/runtime-policy';
import { applySessionRuntimePolicy, inheritSessionComposerPreferences, sessionPermissionPreset, setSessionPermissionPreset, sessionRuntimePolicy } from '../main/services/session-store';
import { configuredInference, replaceInferenceInit } from '../main/sessions/inference';
import { object, type JsonObject } from '../main/services/service-types';
import { classifyRuntimePolicy, decodeApprovalPolicy, presetRuntimePolicy, resolveRuntimePolicy, type GranularApprovalPolicy, type LegacyPermissionPreset, type RuntimePolicy } from '../contracts/runtime-settings';
import { kvSet, kvGet, withSettingsDb } from '../main/services/settings';
import { WindowsRuntimePolicyProjection, isNativeLocalWindows, applyEffectiveRuntimePolicy } from '../main/services/windows-runtime-policy';
import { bindFriendSession } from '../main/services/friend-session-scope';
import { WorkspaceStore } from '../main/services/workspaces';

const h = new Harness();
const roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/runtime-settings.json'), 'utf8')) as {
  presets: Array<{ mode: LegacyPermissionPreset; policy: RuntimePolicy }>;
  options: Record<string, string[]>;
  runtimePresetCases: Array<{ mode: LegacyPermissionPreset; current: RuntimePolicy; expected: RuntimePolicy }>;
  policyConfiguration: { persistedKeys: string[]; defaultMode: string; workspaceTable: { writable_roots: string[]; network_access: boolean; exclude_tmpdir_env_var: boolean; exclude_slash_tmp: boolean } };
  granularPolicies: Array<{ input: JsonObject; expected: GranularApprovalPolicy; preset: 'default' | null }>;
  executionPolicyCases: Array<{ name: string; policy: RuntimePolicy; expected: JsonObject }>;
};
function fresh(): string { const root = mkdtempSync(join(tmpdir(), 'klaus-runtime-settings-')); roots.push(root); return root; }
function fixture(initial: JsonObject = {}) {
  const root = fresh(), project = join(root, 'project'), projectPath = join(project, '.klaus', 'config.toml'), userPath = join(root, 'config.toml');
  const files = new Map<string, JsonObject>([[userPath, structuredClone(initial)], [projectPath, {}]]);
  const versions = new Map<string, number>([[userPath, 1], [projectPath, 1]]);
  const requests: Array<{ method: string; params: JsonObject }> = [];
  const defaults: JsonObject = { approval_policy: null, sandbox_mode: 'read-only', approvals_reviewer: null, sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false }, modelVerbosity: null, reasoningSummary: 'auto', webSearch: { mode: 'client', source: 'builtin', access: 'live' } };
  const request = async (method: string, raw: Json): Promise<Json> => {
    const params = object(raw); requests.push({ method, params: structuredClone(params) });
    const path = typeof params.filePath === 'string' ? params.filePath : userPath;
    if (method === 'config/read') {
      const user = files.get(userPath)!, layer = params.cwd === project ? files.get(projectPath)! : {};
      const sources: JsonObject = Object.fromEntries(Object.keys(defaults).map(key => [key, 'defaults']));
      for (const key of Object.keys(user)) sources[key] = 'user';
      for (const key of Object.keys(layer)) sources[key] = 'project';
      return { path, version: String(versions.get(path)), values: structuredClone(files.get(path) ?? {}), resolved: { ...defaults, ...user, ...layer }, sources };
    }
    if (method === 'config/batchWrite') {
      if (params.expectedVersion !== undefined && params.expectedVersion !== String(versions.get(path))) throw new Error('configuration version conflict');
      const values = structuredClone(files.get(path) ?? {});
      for (const rawEdit of params.edits as Json[]) {
        const edit = object(rawEdit), keys = String(edit.keyPath).split('.'); let target = values;
        for (const key of keys.slice(0, -1)) { target[key] ??= {}; target = object(target[key]); }
        const key = keys.at(-1)!;
        if (edit.value === null) delete target[key]; else target[key] = edit.value!;
      }
      files.set(path, values); versions.set(path, (versions.get(path) ?? 0) + 1);
      return { path, version: String(versions.get(path)), values, resolved: { ...defaults, ...values }, sources: {} };
    }
    if (method === 'session/setRuntimePolicy') return { submissionId: 'applied-policy' };
    throw new Error('Unexpected request: ' + method);
  };
  return { root, project, projectPath, userPath, files, versions, request, requests, settings: new EngineSettings(request) };
}

for (const preset of vector.presets) h.test(`the ${preset.mode} preset has a complete distinct policy`, () => {
  assert.deepEqual(presetRuntimePolicy(preset.mode), preset.policy);
  assert.equal(classifyRuntimePolicy(preset.policy), preset.mode);
});
for (const row of vector.executionPolicyCases) h.test(`execution policy: ${row.name}`, () => {
  const init: JsonObject = { permissionMode: 'bypassPermissions', config: {} };
  applyEffectiveRuntimePolicy(init, { policy: row.policy }, {});
  assert.equal(Object.hasOwn(init, 'permissionMode'), false);
  assert.deepEqual({ approval: object(init.config).approval_policy, sandbox: object(init.config).sandbox_mode,
    reviewer: object(init.config).approvals_reviewer }, row.expected);
});
h.test('configured full access reaches startup, frozen reload and forks without an explicit preset row', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' });
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push() {}, onSessionConfigChanged() {} });
  assert.equal(object(await composer.getPermission('thread')).effectiveMode, 'bypassPermissions');
  assert.equal(sessionPermissionPreset('thread', f.root), 'bypassPermissions');
  const saved = structuredClone(sessionRuntimePolicy('thread', f.root));
  const init: JsonObject = { cwd: f.project, config: {} };
  const requested = applyRuntimeSettings(init, await f.settings.resolved(f.project), 'thread', f.root);
  assert.equal(Object.hasOwn(init, 'permissionMode'), false);
  assert.equal(object(init.config).approval_policy, 'never');
  assert.equal(object(init.config).sandbox_mode, 'danger-full-access');
  applyEffectiveRuntimePolicy(init, { policy: requested.policy }, {});
  assert.equal(Object.hasOwn(init, 'permissionMode'), false);
  await f.settings.writePermissionPreset('default');
  inheritSessionComposerPreferences('thread', 'fork', f.root);
  for (const id of ['thread', 'fork']) {
    const restored: JsonObject = { cwd: f.project, config: {} };
    applyRuntimeSettings(restored, await f.settings.resolved(f.project), id, f.root);
    assert.equal(Object.hasOwn(restored, 'permissionMode'), false);
    assert.equal(object(restored.config).sandbox_mode, 'danger-full-access');
    assert.deepEqual(sessionRuntimePolicy(id, f.root), saved);
    assert.equal(sessionPermissionPreset(id, f.root), 'bypassPermissions');
  }
});
h.test('a friend conversation starts from its grant instead of the global full-access default', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' });
  bindFriendSession(f.root, 'friend-thread', { accountId: 'owner', friendshipId: 'friend', friendUserId: 'peer' });
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push() {}, onSessionConfigChanged() {} });
  const initial = object(await composer.getPermission('friend-thread'));
  const initialSaved = sessionRuntimePolicy('friend-thread', f.root);
  assert.equal(initial.preset, 'default', 'the friend grant supplies the initial request-approval preset');
  assert.equal(object(initial.policy).approvalPolicy, 'on-request');
  assert.equal(object(initial.policy).sandboxMode, 'workspace-write', 'the friend resource cap applies to the displayed effective policy');
  assert.equal(initialSaved, undefined, 'reading the initial preset does not freeze the global default into the friend conversation');
  await composer.setPermission({ sessionId: 'friend-thread', mode: 'bypassPermissions' });
  assert.equal(object(await composer.getPermission('friend-thread')).preset, 'bypassPermissions', 'a later in-session choice wins');
  assert.deepEqual(object(sessionRuntimePolicy('friend-thread', f.root)).policy, presetRuntimePolicy('bypassPermissions'), 'the override belongs only to this conversation');
  assert.equal(f.requests.some(row => row.method === 'config/batchWrite'), false, 'the in-session choice never rewrites the friend or global settings');
});
h.test('configured full access publishes bypass execution to the live conversation without an explicit preset row', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' });
  const state = new HostState(); state.rememberSession('thread', 'engine-thread', { cwd: f.project });
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log() {}, updateRuntimeConfig: async () => {} });
  await configuration.composerChanged({ kind: 'permission', sessionId: 'thread' });
  assert.deepEqual(f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params, {
    sessionId: 'engine-thread', approvalPolicy: 'never',
    sandboxMode: 'danger-full-access', approvalsReviewer: 'user', networkAllowed: true,
  });
  assert.equal(sessionPermissionPreset('thread', f.root), undefined);
  assert.equal(f.requests.some(row => row.method === 'config/batchWrite'), false);
});
h.test('legacy session presets migrate once and cannot replace a newer saved policy', async () => {
  const f = fixture();
  sessionRuntimePolicy('legacy', f.root);
  withSettingsDb(f.root, db => db.prepare('INSERT INTO session_permission_modes VALUES(?,?,?)').run('legacy', 'bypassPermissions', 1));
  assert.deepEqual(runtimePolicyForSession('legacy', {}, f.root).policy, presetRuntimePolicy('bypassPermissions'));
  withSettingsDb(f.root, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_permission_modes').get()!.n, 0);
    db.prepare('INSERT INTO session_permission_modes VALUES(?,?,?)').run('legacy', 'default', 0);
  });
  assert.deepEqual(runtimePolicyForSession('legacy', {}, f.root).policy, presetRuntimePolicy('bypassPermissions'));
  withSettingsDb(f.root, db => assert.equal(db.prepare('SELECT count(*) AS n FROM session_permission_modes').get()!.n, 0));
  assert.equal(Object.hasOwn(sessionRuntimePolicy('legacy', f.root)!, 'mode'), false);
});
h.test('legacy preset migration preserves later explicit picks and resolves ties to the canonical policy', () => {
  for (const [canonicalTime, legacyTime, expected] of [[1, 2, 'bypassPermissions'], [3, 2, 'default'], [2, 2, 'default']] as const) {
    const f = fixture(); sessionRuntimePolicy('legacy', f.root);
    withSettingsDb(f.root, db => {
      db.prepare('INSERT INTO session_runtime_policies VALUES(?,?,?)').run('legacy', JSON.stringify({ policy: presetRuntimePolicy('default') }), canonicalTime);
      db.prepare('INSERT INTO session_permission_modes VALUES(?,?,?)').run('legacy', 'bypassPermissions', legacyTime);
    });
    assert.deepEqual(runtimePolicyForSession('legacy', {}, f.root).policy, presetRuntimePolicy(expected));
    assert.deepEqual(runtimePolicyForSession('legacy', {}, f.root).policy, presetRuntimePolicy(expected));
    withSettingsDb(f.root, db => assert.equal(db.prepare('SELECT count(*) AS n FROM session_permission_modes').get()!.n, 0));
  }
});
h.test('preset and combined orchestration writes persist only canonical policies', async () => {
  const f = fixture();
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push() {}, onSessionConfigChanged() {} });
  await composer.setPermission({ sessionId: 'chosen', mode: 'bypassPermissions' });
  await composer.setUltraMode({ sessionId: 'chosen', enabled: true, permissionMode: 'default' });
  assert.deepEqual(runtimePolicyForSession('chosen', {}, f.root).policy, presetRuntimePolicy('default'));
  assert.equal(kvGet('composer.permission_mode', f.root), null);
  withSettingsDb(f.root, db => assert.equal(db.prepare('SELECT count(*) AS n FROM session_permission_modes').get()!.n, 0));
});
const windowsVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/runtime-windows-sandbox.json'), 'utf8')) as {
  effectiveProjection: { requiredStatuses: string[]; readOnlyPolicy: RuntimePolicy; hosts: Array<{ platform: NodeJS.Platform; remoteBinding: string | null; applicable: boolean }> };
};
h.test('new-chat permission reads do not require a session workspace', async () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    for (const status of ['ready', 'notConfigured']) {
      const f = fixture({ approval_policy: 'never', approvals_reviewer: 'user', sandbox_mode: 'danger-full-access' });
      const workspaces = new WorkspaceStore({ configRoot: f.root, push() {}, onSessionWorkdirChanged() {}, pickDirectory: async () => null });
      assert.throws(() => workspaces.remoteBinding(''), /invalid sessionId/u);
      const bindingReads: string[] = [], readinessReads: string[] = [];
      const projection = new WindowsRuntimePolicyProjection({
        isNativeLocal: id => isNativeLocalWindows(platform, id, sessionId => {
          bindingReads.push(sessionId);
          return workspaces.remoteBinding(sessionId);
        }),
        request: async method => { readinessReads.push(method); return { status }; },
      });
      const composer = new ComposerService({ configRoot: f.root, request: f.request, push() {}, onSessionConfigChanged() {}, runtimePolicyProjection: projection });
      const selection = object(await composer.getPermission(''));
      assert.equal(selection.preset, 'bypassPermissions');
      assert.equal(selection.effectiveMode, platform === 'win32' && status === 'notConfigured' ? 'read-only' : 'bypassPermissions');
      assert.equal(object(selection.configuredPolicy).sandboxMode, 'danger-full-access');
      assert.deepEqual(bindingReads, []);
      assert.deepEqual(readinessReads, platform === 'win32' ? ['engine/windowsSandboxReadiness'] : []);
      assert.equal(f.requests.every(request => request.method === 'config/read'), true);
      assert.equal(projection.applies('existing-session'), platform === 'win32');
      assert.deepEqual(bindingReads, platform === 'win32' ? ['existing-session'] : []);
    }
  }
});
h.test('known native preparation requirements project every permission policy without mutating it', async () => {
  for (const host of windowsVector.effectiveProjection.hosts) assert.equal(isNativeLocalWindows(host.platform, 'bound-session', () => host.remoteBinding), host.applicable);
  let status = 'ready', failure: unknown;
  const calls: Array<{ method: string; params: Json }> = [], errors: string[] = [];
  const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: id => id === 'local',
    request: async (method, params) => { calls.push({ method, params }); if (failure) throw failure; return { status }; },
    log: (_kind, detail) => errors.push(detail) });
  for (const policy of [...vector.presets.map(row => row.policy), { approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const, approvalsReviewer: 'user' as const, sandboxNetworkAllowed: true }, { approvalPolicy: vector.granularPolicies[0]!.expected, sandboxMode: 'workspace-write' as const, approvalsReviewer: 'auto_review' as const, sandboxNetworkAllowed: true }]) {
    const before = structuredClone(policy);
    for (status of windowsVector.effectiveProjection.requiredStatuses) {
      const effective = await projection.project('local', policy);
      assert.equal(effective.effectiveMode, 'read-only'); assert.deepEqual(effective.policy, windowsVector.effectiveProjection.readOnlyPolicy);
      assert.deepEqual(policy, before, 'the requested policy is never replaced or rewritten');
    }
    status = 'ready';
    assert.equal((await projection.project('local', policy)).policy, policy);
    const count = calls.length;
    status = 'notConfigured';
    assert.equal((await projection.project('remote-or-other-platform', policy)).policy, policy);
    assert.equal(calls.length, count, 'ineligible execution never queries local readiness');
    failure = new Error('Readiness unavailable');
    const failed = await projection.project('local', policy);
    assert.equal(failed.policy, policy); assert.equal(failed.effectiveMode, undefined, 'a query error is not a preparation requirement');
    failure = undefined;
  }
  assert(calls.every(call => call.method === 'engine/windowsSandboxReadiness' && JSON.stringify(call.params) === '{}'));
  assert.equal(errors.length, vector.presets.length + 2);
});
h.test('startup search access follows temporary execution policy while explicit freshness remains unchanged', async () => {
  const f = fixture();
  let status = 'notConfigured';
  const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: () => true, request: async () => ({ status }) });
  for (const access of [undefined, 'live', 'cached', 'disabled']) {
    const values: JsonObject = { approval_policy: 'never', sandbox_mode: 'danger-full-access', ...(access === undefined ? {} : { webSearch: { access } }) };
    const init: JsonObject = { config: {} };
    const requested = applyRuntimeSettings(init, values, 'startup-search-' + String(access), f.root);
    assert.equal(object(object(init.config).webSearch).access, access ?? 'live');
    status = 'notConfigured';
    applyEffectiveRuntimePolicy(init, await projection.project('local', requested.policy), values);
    assert.equal(object(object(init.config).webSearch).access, access ?? 'cached');
    status = 'ready';
    applyEffectiveRuntimePolicy(init, await projection.project('local', requested.policy), values);
    assert.equal(object(object(init.config).webSearch).access, access ?? 'live');
  }
});
h.test('composer restores saved full, automatic and network-enabled read-only policies after temporary projection', async () => {
  const policies: RuntimePolicy[] = [presetRuntimePolicy('bypassPermissions'), presetRuntimePolicy('auto'),
    { approvalPolicy: 'on-request', sandboxMode: 'read-only', approvalsReviewer: 'user', sandboxNetworkAllowed: true }];
  for (const policy of policies) {
    const f = fixture({ approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' });
    applySessionRuntimePolicy('windows-thread', { policy: { ...policy } }, f.root);
    const saved = structuredClone(sessionRuntimePolicy('windows-thread', f.root));
    let status = 'notConfigured';
    const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: () => true, request: async () => ({ status }) });
    const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, onSessionConfigChanged: () => {}, runtimePolicyProjection: projection });
    for (status of windowsVector.effectiveProjection.requiredStatuses) {
      const temporary = object(await composer.getPermission('windows-thread'));
      assert.equal(temporary.mode, classifyRuntimePolicy(policy)); assert.equal(temporary.preset, classifyRuntimePolicy(policy)); assert.equal(temporary.effectiveMode, 'read-only');
      assert.deepEqual(temporary.policy, windowsVector.effectiveProjection.readOnlyPolicy);
      assert.deepEqual(temporary.configuredPolicy, presetRuntimePolicy('bypassPermissions'));
      assert.deepEqual(sessionRuntimePolicy('windows-thread', f.root), saved);
    }
    status = 'ready';
    const ready = object(await composer.getPermission('windows-thread'));
    assert.equal(ready.effectiveMode, classifyRuntimePolicy(policy)); assert.deepEqual(ready.policy, policy);
    assert.deepEqual(sessionRuntimePolicy('windows-thread', f.root), saved);
    assert.equal(f.requests.some(call => call.method === 'config/batchWrite'), false);
  }
});
h.test('live permission publication uses the same temporary tuple and restores only the selected conversation when ready', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' }), state = new HostState();
  for (const id of ['chosen', 'other']) { setSessionPermissionPreset(id, 'bypassPermissions', f.root); state.rememberSession(id, 'engine-' + id, { cwd: f.project }); }
  let status = 'updateRequired';
  const projection = new WindowsRuntimePolicyProjection({ isNativeLocal: () => true, request: async () => ({ status }) });
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, runtimePolicyProjection: projection, updateRuntimeConfig: async () => {} });
  state.markStale('chosen');
  await configuration.composerChanged({ kind: 'permission', sessionId: 'chosen' });
  let policy = f.requests.filter(call => call.method === 'session/setRuntimePolicy').at(-1)!.params;
  assert.deepEqual(policy, { sessionId: 'engine-chosen', approvalPolicy: 'on-request', sandboxMode: 'read-only', approvalsReviewer: 'user', networkAllowed: false });
  assert.equal(state.isStale('chosen'), true);
  status = 'ready';
  await configuration.composerChanged({ kind: 'permission', sessionId: 'chosen' });
  policy = f.requests.filter(call => call.method === 'session/setRuntimePolicy').at(-1)!.params;
  assert.deepEqual(policy, { sessionId: 'engine-chosen', approvalPolicy: 'never', sandboxMode: 'danger-full-access', approvalsReviewer: 'user', networkAllowed: true });
  assert.equal(f.requests.filter(call => call.method === 'session/setRuntimePolicy').length, 2);
  assert.equal(sessionPermissionPreset('chosen', f.root), 'bypassPermissions'); assert.equal(sessionPermissionPreset('other', f.root), 'bypassPermissions');
  assert.equal(state.isStale('chosen'), true); assert.equal(state.isStale('other'), false);
});

h.test('the legacy edit-only identity does not select a permission preset', () => {
  const legacy = presetRuntimePolicy('acceptEdits');
  assert.equal(legacy.approvalsReviewer, 'user'); assert.equal(classifyRuntimePolicy(legacy), null);
});
h.test('automatic review retains the selected filesystem policy and its existing network intent', async () => {
  for (const sandboxMode of ['read-only', 'workspace-write'] as const) for (const sandboxNetworkAllowed of [false, true]) {
    const f = fixture({ approval_policy: 'on-request', sandbox_mode: sandboxMode, sandbox_workspace_write: { network_access: sandboxNetworkAllowed } });
    const expected = { ...resolveRuntimePolicy({ approval_policy: 'on-request', sandbox_mode: sandboxMode, sandbox_workspace_write: { network_access: sandboxNetworkAllowed } }), approvalsReviewer: 'auto_review', sandboxNetworkAllowed: sandboxMode === 'read-only' ? false : sandboxNetworkAllowed };
    const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, onSessionConfigChanged: () => {} });
    await composer.getPermission('chosen');
    await composer.setPermission({ sessionId: 'chosen', mode: 'auto' });
    assert.deepEqual(object(await composer.getPermission('chosen')).policy, expected);
    assert.equal(object(await composer.getPermission('chosen')).preset, 'auto');
    await f.settings.writePermissionPreset('auto');
    assert.deepEqual(runtimePolicyForSession('', object(f.files.get(f.userPath)), f.root).policy, expected);
  }
});
h.test('automatic review preserves an explicit read-only runtime network grant', () => {
  for (const { mode, current, expected } of vector.runtimePresetCases) assert.deepEqual(presetRuntimePolicy(mode, current), expected);
  assert.equal(resolveRuntimePolicy({ sandbox_mode: 'read-only', sandbox_workspace_write: { network_access: true } }).sandboxNetworkAllowed, false);
});
h.test('granular permission categories decode independently and classify only the built-in request policy as default', () => {
  for (const { input, expected, preset } of vector.granularPolicies) {
    assert.deepEqual(decodeApprovalPolicy(input), expected);
    const policy = resolveRuntimePolicy({ approval_policy: input, sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false } });
    assert.deepEqual(policy.approvalPolicy, expected); assert.equal(classifyRuntimePolicy(policy), preset);
    assert.equal(classifyRuntimePolicy({ ...policy, approvalsReviewer: 'auto_review' }), null);
    assert.equal(classifyRuntimePolicy({ ...policy, sandboxMode: 'read-only' }), null);
    assert.equal(classifyRuntimePolicy({ ...policy, sandboxNetworkAllowed: true }), null);
    assert.deepEqual(presetRuntimePolicy('auto', policy), presetRuntimePolicy('auto'));
  }
  const complete = vector.granularPolicies[0]!.expected.granular;
  for (const key of ['sandbox_approval', 'rules', 'mcp_elicitations']) {
    const missing = { ...complete } as Record<string, unknown>; delete missing[key];
    assert.equal(decodeApprovalPolicy({ granular: missing }), undefined);
  }
  for (const key of Object.keys(complete)) assert.equal(decodeApprovalPolicy({ granular: { ...complete, [key]: 'true' } }), undefined);
  assert.equal(decodeApprovalPolicy({ granular: complete, never: null }), undefined);
  assert.throws(() => resolveRuntimePolicy({ approval_policy: { granular: {} } }), /Invalid granular approval policy/);
});
h.test('granular configuration survives scoped settings writes and unrelated preference edits', async () => {
  const granular = vector.granularPolicies[0]!.expected, f = fixture({ approval_policy: granular });
  const registry = new ChannelRegistry(), changes: string[] = [], scope = { kind: 'project' as const, cwd: f.project };
  registerSettingsHandlers(registry, { configRoot: f.root, request: f.request, onSettingsChanged: key => { changes.push(key); } });
  const invoke = async (channel: string, args: Json) => registry.lookup(channel)!({ channel, role: 'main', senderId: 1, args: [args] });
  assert.deepEqual(await invoke('settings:kv:get', { key: 'klaus.approvalPolicy' }), granular);
  const before = await f.settings.runtimeSnapshot(scope);
  assert.equal(before.values['klaus.approvalPolicy'], null); assert.deepEqual(before.effective['klaus.approvalPolicy'], granular);
  await invoke('settings:kv:set', { key: 'klaus.approvalPolicy', value: vector.granularPolicies[1]!.input, scope, expectedVersion: before.version });
  const after = await f.settings.runtimeSnapshot(scope), configured = vector.granularPolicies[1]!.expected;
  assert.deepEqual(after.values['klaus.approvalPolicy'], configured); assert.deepEqual(after.effective['klaus.approvalPolicy'], configured);
  await f.settings.writeRow('klaus.reasoningSummary', 'none', { scope, expectedVersion: after.version });
  assert.deepEqual(object(f.files.get(f.projectPath)).approval_policy, configured); assert.deepEqual(object(f.files.get(f.userPath)).approval_policy, granular);
  const writes = f.requests.filter(row => row.method === 'config/batchWrite').length;
  await assert.rejects(invoke('settings:kv:set', { key: 'klaus.approvalPolicy', value: { granular: { rules: true } }, scope }), /setting value/);
  assert.equal(f.requests.filter(row => row.method === 'config/batchWrite').length, writes);
  assert.deepEqual(changes, ['klaus.approvalPolicy']);
});
h.test('granular session policy survives startup, frozen reload, fork and live publication until a preset is chosen', async () => {
  const granular = vector.granularPolicies[0]!.expected;
  const f = fixture({ approval_policy: granular, sandbox_mode: 'read-only', sandbox_workspace_write: { network_access: true } });
  const init: JsonObject = { cwd: f.project, config: {} };
  applyRuntimeSettings(init, await f.settings.resolved(f.project), 'thread', f.root);
  assert.deepEqual(object(init.config).approval_policy, granular);
  const state = new HostState(); state.rememberSession('thread', 'engine-thread', init);
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async () => {} });
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, sessionCwd: async () => f.project, onSessionConfigChanged: change => configuration.composerChanged(change) });
  assert.equal(object(await composer.getPermission('thread')).preset, null);
  await f.settings.writeRow('klaus.reasoningSummary', 'none');
  assert.deepEqual(object(object(await composer.getPermission('thread')).policy).approvalPolicy, granular);
  inheritSessionComposerPreferences('thread', 'fork', f.root);
  assert.deepEqual(runtimePolicyForSession('fork', await f.settings.resolved(f.project), f.root).policy.approvalPolicy, granular);
  await configuration.settingsChanged('klaus.sandboxMode');
  assert.deepEqual(f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params.approvalPolicy, granular);
  await composer.setPermission({ sessionId: 'thread', mode: 'auto' });
  assert.deepEqual(object(await composer.getPermission('thread')).policy, presetRuntimePolicy('auto'));
  assert.equal(f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params.approvalPolicy, 'on-request');
});
h.test('editing a custom model preserves declared review and context metadata across inference replacement', async () => {
  const metadata: JsonObject = {autoReviewModelOverride:'review-model',requiresSandboxedReview:true,nodeReplAutoReviewRequired:true,
    guardian:{mode:'score'},guardianV2:{mode:'async'},modelMessages:{guardian:'Policy with Unicode \ud800'},compHash:'model-hash',
    supportsReasoningSummaryParameter:true,defaultReasoningSummary:'none',supportedReasoningEfforts:['low','max'],defaultReasoningEffort:'low',multiAgentReasoningEffort:'max',
    effectiveContextWindowPercent:95,autoCompactTokenLimit:175000,usedFallbackModelMetadata:false,modelSpecialty:'reviewer',supportsImageDetailOriginal:true};
  const current = {modelProviders:{custom:{provider:'openai',model:'main',capabilities:metadata}}};
  const roundTrip = modelEntry({...modelRow('custom',current.modelProviders.custom),name:'Renamed through editor'});
  for (const [key,value] of Object.entries(metadata)) assert.deepEqual(object(roundTrip.capabilities)[key],value);
  const written: JsonObject[] = [];
  const settings = new EngineSettings(async (method, params) => {
    if (method === 'config/read') return {values:current};
    assert.equal(method,'config/batchWrite'); written.push(object((object(params).edits as Json[])[0]).value as JsonObject); return {};
  });
  await settings.upsertModel({id:'custom',provider:'openai',model:'main',name:'Renamed model',maxContextTokens:12345});
  for (const [key,value] of Object.entries(metadata)) assert.deepEqual(object(written[0]!.capabilities)[key],value);
  const replaced = replaceInferenceInit({config:{sandbox_mode:'workspace-write'}}, {provider:{},auth:{},capabilities:metadata,capabilitiesByModel:[{model:'review-model',capabilities:metadata}],config:{model:'main'}});
  assert.deepEqual(replaced.capabilities,metadata); assert.deepEqual(replaced.capabilitiesByModel,[{model:'review-model',capabilities:metadata}]);
});
h.test('reviewer compatibility values normalize to one canonical policy', () => {
  for (const approvalsReviewer of ['auto_review', 'guardian_subagent', 'automatic']) {
    const policy = resolveRuntimePolicy({ approvals_reviewer: approvalsReviewer, approval_policy: 'on-request', sandbox_mode: 'read-only' });
    assert.equal(policy.approvalsReviewer, 'auto_review'); assert.equal(classifyRuntimePolicy(policy), 'auto');
  }
  assert.equal(classifyRuntimePolicy(resolveRuntimePolicy({ approvals_reviewer: 'auto_review', approval_policy: 'never', sandbox_mode: 'danger-full-access' })), null);
});
h.test('all advertised values roundtrip and invalid choices never write', async () => {
  const f = fixture();
  for (const [key, values] of Object.entries(vector.options)) for (const value of values) {
    await f.settings.writeRow(key, value); assert.equal(await f.settings.row(key), value || null, key + ':' + value);
  }
  const writes = f.requests.filter(row => row.method === 'config/batchWrite').length;
  for (const key of Object.keys(vector.options)) await assert.rejects(f.settings.writeRow(key, 'unsupported'), /Unknown runtime setting/);
  assert.equal(f.requests.filter(row => row.method === 'config/batchWrite').length, writes);
});
h.test('project reads and writes retain their own version and inherit user values', async () => {
  const f = fixture({ approval_policy: 'never', modelVerbosity: 'high' }), scope = { kind: 'project' as const, cwd: f.project };
  const initial = await f.settings.runtimeSnapshot(scope);
  assert.equal(initial.path, f.projectPath); assert.equal(initial.values['klaus.modelVerbosity'], null); assert.equal(initial.effective['klaus.modelVerbosity'], 'high');
  await f.settings.writeRow('klaus.modelVerbosity', 'low', { scope, expectedVersion: initial.version });
  assert.equal(object(f.files.get(f.userPath)).modelVerbosity, 'high');
  assert.equal((await f.settings.runtimeSnapshot(scope)).effective['klaus.modelVerbosity'], 'low');
  await assert.rejects(f.settings.writeRow('klaus.reasoningSummary', 'none', { scope, expectedVersion: initial.version }), /version conflict/);
  assert.equal(object(f.files.get(f.projectPath)).reasoningSummary, undefined);
  const inheritedSearch = { source: 'native', mode: 'native', access: 'indexed', allowedDomains: ['docs.example.com'], blockedDomains: ['blocked.example.com'], maxUses: 3 };
  const search = fixture({ webSearch: inheritedSearch });
  await search.settings.writeRow('klaus.webSearch.access', 'cached', { scope: { kind: 'project', cwd: search.project } });
  assert.deepEqual(object(search.files.get(search.projectPath)).webSearch, { ...inheritedSearch, access: 'cached' });
  assert.deepEqual(object(search.files.get(search.userPath)).webSearch, inheritedSearch);
});
h.test('the subagent catalog switch defaults off and persists independently at user and project scopes', async () => {
  const f = fixture(), scope = { kind: 'project' as const, cwd: f.project };
  const initial = await f.settings.runtimeSnapshot();
  assert.equal(initial.values['klaus.subagentModelCatalog'], null);
  assert.equal(initial.effective['klaus.subagentModelCatalog'], 'off');
  await f.settings.writeRow('klaus.subagentModelCatalog', 'on', { expectedVersion: initial.version });
  assert.equal((await f.settings.runtimeSnapshot(scope)).effective['klaus.subagentModelCatalog'], 'on');
  const project = await f.settings.runtimeSnapshot(scope);
  await f.settings.writeRow('klaus.subagentModelCatalog', 'off', { scope, expectedVersion: project.version });
  assert.equal((await f.settings.runtimeSnapshot()).effective['klaus.subagentModelCatalog'], 'on');
  assert.equal((await new EngineSettings(f.request).runtimeSnapshot(scope)).effective['klaus.subagentModelCatalog'], 'off');
  assert.equal(object(f.files.get(f.userPath)).subagentModelCatalog, true);
  assert.equal(object(f.files.get(f.projectPath)).subagentModelCatalog, false);
  await assert.rejects(f.settings.writeRow('klaus.subagentModelCatalog', 'unsupported'), /Unknown runtime setting value/);
});
h.test('live subagent model policy uses the shared catalog and clears it when the scoped switch is disabled', async () => {
  const f = fixture({ modelProviders: { fixture: { name: 'Fixture Model', provider: 'openai', model: 'wire-model' } } }), state = new HostState();
  state.rememberSession('matching', 'engine-matching', { cwd: f.project });
  state.rememberSession('other', 'engine-other', { cwd: '/another-project' });
  state.rememberSession('unattended', 'engine-unattended', { cwd: f.project });
  const updates: Array<{ sessionId: string; update: JsonObject }> = [], statusReads: string[] = [];
  const config = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log() {},
    isUnattended: id => id === 'unattended', modelSourceStatus: async source => { statusReads.push(source); return { loggedIn: false }; },
    updateRuntimeConfig: async (sessionId, update) => { updates.push({ sessionId, update }); } });
  const scope = { kind: 'project' as const, cwd: f.project };
  await config.settingsChanged('klaus.subagentModelCatalog', scope);
  assert.deepEqual(updates.pop(), { sessionId: 'matching', update: { subagentModelCatalog: false, subagentModelOptions: [] } });
  assert.deepEqual(statusReads, []);
  await f.settings.writeRow('klaus.subagentModelCatalog', 'on', { scope });
  kvSet('model_tiers:global', '{broken', f.root);
  await config.settingsChanged('klaus.subagentModelCatalog', scope);
  assert.deepEqual(updates.pop(), { sessionId: 'matching', update: {
    subagentModelCatalog: true, subagentModelOptions: [{ value: 'custom:fixture', label: 'custom · Fixture Model' }],
  } });
  assert(statusReads.length > 0);
  assert.equal(kvGet('model_tiers:global', f.root), '{broken', 'catalog listing neither reads nor rewrites an unrelated tier mapping');
  f.files.set(f.userPath, { modelProviders: { replacement: { name: 'Replacement', provider: 'openai', model: 'replacement-wire-model' } } });
  await config.refreshSubagentModelCatalog();
  assert.deepEqual(updates.pop(), { sessionId: 'matching', update: {
    subagentModelCatalog: true, subagentModelOptions: [{ value: 'custom:replacement', label: 'custom · Replacement' }],
  } });
  const statusCount = statusReads.length;
  await f.settings.writeRow('klaus.subagentModelCatalog', 'off', { scope });
  await config.settingsChanged('klaus.subagentModelCatalog', scope);
  assert.deepEqual(updates.pop(), { sessionId: 'matching', update: { subagentModelCatalog: false, subagentModelOptions: [] } });
  assert.equal(statusReads.length, statusCount);
  assert.equal(state.isStale('matching'), false);
  assert.equal(updates.length, 0);
});
h.test('catalog policy publication continues after a rejected binding and reports the failure', async () => {
  const f = fixture(), state = new HostState(), visited: string[] = [];
  state.rememberSession('failed', 'engine-failed', {}); state.rememberSession('ready', 'engine-ready', {});
  const config = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log() {},
    updateRuntimeConfig: async id => { visited.push(id); if (id === 'failed') throw Error('policy rejected'); } });
  await assert.rejects(config.settingsChanged('klaus.subagentModelCatalog'), /policy rejected/);
  assert.deepEqual(visited, ['failed', 'ready']);
  assert.equal(state.isStale('failed'), true);
  assert.equal(state.isStale('ready'), false);
});
h.test('a stale version cannot overwrite another edit and concurrent independent rows remain intact', async () => {
  const f = fixture(), snapshot = await f.settings.runtimeSnapshot();
  const results = await Promise.allSettled([
    f.settings.writeRow('klaus.modelVerbosity', 'low', { expectedVersion: snapshot.version }),
    f.settings.writeRow('klaus.reasoningSummary', 'none', { expectedVersion: snapshot.version }),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  const freshSnapshot = await f.settings.runtimeSnapshot();
  await f.settings.writeRow('klaus.reasoningSummary', 'none', { expectedVersion: freshSnapshot.version });
  assert.equal(object(f.files.get(f.userPath)).modelVerbosity, 'low'); assert.equal(object(f.files.get(f.userPath)).reasoningSummary, 'none');
});
h.test('web access changes retain the source and its precise access mode', async () => {
  for (const source of ['kimi', 'custom']) {
    const f = fixture({ desktop: { webSearch: { source, enabled: true } }, webSearch: { source, mode: 'client' } });
    for (const access of ['disabled', 'cached', 'indexed', 'live']) {
      await f.settings.writeRow('klaus.webSearch.access', access);
      const search = object(object(f.files.get(f.userPath)).webSearch);
      assert.equal(search.source, source === 'custom' ? 'builtin' : source); assert.equal(search.access, access); assert.equal(search.mode, access === 'disabled' ? 'off' : 'client');
    }
  }
});
h.test('the existing enabled control keeps explicit access coherent without erasing source selection', async () => {
  const f = fixture({ desktop: { webSearch: { source: 'native', enabled: false } }, webSearch: { source: 'native', mode: 'off', access: 'disabled' } });
  await f.settings.writeRow('klaus.webSearch.enabled', 'on');
  assert.equal(object(object(f.files.get(f.userPath)).webSearch).access, 'cached');
  await f.settings.writeRow('klaus.webSearch.enabled', 'off');
  assert.equal(object(object(f.files.get(f.userPath)).webSearch).access, 'disabled');
});
h.test('search disable and re-enable preserves cached, indexed and live choices across both controls', async () => {
  for (const source of ['kimi', 'custom']) for (const access of ['cached', 'indexed', 'live']) {
    const f = fixture({ webSearch: { source, mode: 'client' }, desktop: { webSearch: { source } } });
    await f.settings.writeRow('klaus.webSearch.access', access);
    await f.settings.writeRow('klaus.webSearch.enabled', 'off'); await f.settings.writeRow('klaus.webSearch.enabled', 'on');
    assert.equal(object(object(f.files.get(f.userPath)).webSearch).access, access);
    await f.settings.writeRow('klaus.webSearch.access', 'disabled'); await f.settings.writeRow('klaus.webSearch.enabled', 'on');
    const saved = object(f.files.get(f.userPath)); assert.equal(object(saved.webSearch).access, access); assert.equal(object(saved.webSearch).source, source === 'custom' ? 'builtin' : source);
    assert.equal(object(object(saved.desktop).webSearch).lastEnabledAccess, access);
  }
});
h.test('unconfigured schema defaults grant no network and derive search access from the sandbox', async () => {
  const actualDefaults = new EngineSettings(async () => ({ path: '/config.toml', version: 'e3b0c44298fc1c14', values: {}, resolved: { sandbox_mode: 'read-only', sandbox_workspace_write: { network_access: false }, modelVerbosity: null, reasoningSummary: 'auto', webSearch: { mode: 'client' } }, sources: { sandbox_mode: 'defaults', sandbox_workspace_write: 'defaults', modelVerbosity: 'defaults', reasoningSummary: 'defaults', webSearch: 'defaults' } }));
  const actual = await actualDefaults.runtimeSnapshot();
  assert.deepEqual(actual.effective, { 'klaus.approvalPolicy': 'on-request', 'klaus.sandboxMode': 'read-only', 'klaus.sandbox.networkAllowed': 'off', 'klaus.modelVerbosity': null, 'klaus.reasoningSummary': 'auto', 'klaus.webSearch.access': 'cached', 'klaus.subagentModelCatalog': 'off' });
  const f = fixture(), initial = await f.settings.runtimeSnapshot();
  assert.equal(initial.effective['klaus.sandboxMode'], 'read-only'); assert.equal(initial.effective['klaus.sandbox.networkAllowed'], 'off'); assert.equal(initial.effective['klaus.webSearch.access'], 'cached');
  const restricted: JsonObject = { config: {} }; applyRuntimeSettings(restricted, await f.settings.resolved(), 'restricted', f.root);
  assert.equal(restricted.networkAllowed, false); assert.equal(object(object(restricted.config).webSearch).access, 'cached');
  await f.settings.writePermissionPreset('bypassPermissions');
  const full = await f.settings.runtimeSnapshot(); assert.equal(full.effective['klaus.webSearch.access'], 'live');
  const unrestricted: JsonObject = { config: {} }; applyRuntimeSettings(unrestricted, await f.settings.resolved(), 'full', f.root);
  assert.equal(object(object(unrestricted.config).webSearch).access, 'live');
  const restored = configuredInference(restricted, await f.settings.resolved(), {});
  assert.equal(object(object(restored.config).webSearch).access, 'cached');
});
h.test('raw nested intent distinguishes schema freshness from explicit inherited user access', async () => {
  const read = (values: JsonObject, resolved: JsonObject, sources: JsonObject) => new EngineSettings(async () => ({ path: '/config.toml', version: '1', values, resolved, sources }));
  const inferred = read({ webSearch: { source: 'builtin', mode: 'client' } }, { sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: true }, webSearch: { source: 'builtin', mode: 'client', access: 'live' } }, { sandbox_mode: 'defaults', sandbox_workspace_write: 'defaults', webSearch: 'user' });
  assert.equal((await inferred.runtimeSnapshot()).effective['klaus.webSearch.access'], 'cached');
  const inherited = read({}, { sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: true }, webSearch: { source: 'native', mode: 'native', access: 'live' } }, { sandbox_mode: 'user', sandbox_workspace_write: 'user', webSearch: 'user' });
  const project = await inherited.runtimeSnapshot({ kind: 'project', cwd: '/project' });
  assert.equal(project.values['klaus.webSearch.access'], null); assert.equal(project.effective['klaus.webSearch.access'], 'live'); assert.equal(project.effective['klaus.sandbox.networkAllowed'], 'on');
});
h.test('explicit access and legacy freshness remain exact across sandbox and inference changes', async () => {
  for (const access of ['cached', 'indexed', 'live', 'disabled']) {
    const explicit = fixture({ sandbox_mode: 'workspace-write', webSearch: { access } });
    assert.equal((await explicit.settings.runtimeSnapshot()).effective['klaus.webSearch.access'], access);
    const selected = configuredInference({ config: { sandbox_mode: 'danger-full-access' } }, await explicit.settings.resolved(), {});
    assert.equal(object(object(selected.config).webSearch).access, access);
  }
  for (const mode of ['cached', 'indexed', 'live', 'off']) {
    const legacy = fixture({ sandbox_mode: 'workspace-write', webSearch: { mode } });
    assert.equal((await legacy.settings.runtimeSnapshot()).effective['klaus.webSearch.access'], mode === 'off' ? 'disabled' : mode);
  }
});
h.test('global preset persistence writes every policy field atomically', async () => {
  const f = fixture();
  await f.settings.writePermissionPreset('auto');
  const writes = f.requests.filter(row => row.method === 'config/batchWrite'); assert.equal(writes.length, 1);
  assert.equal((writes[0]!.params.edits as Json[]).length, 4); assert.equal(writes[0]!.params.expectedVersion, '1');
  assert.deepEqual(runtimePolicyForSession('', object(f.files.get(f.userPath)), f.root).policy, presetRuntimePolicy('auto', resolveRuntimePolicy({sandbox_mode:'read-only'})));
});
h.test('default-policy rollback is order independent and never undoes a newer writer', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'danger-full-access', approvals_reviewer: 'user' });
  const selection = await f.settings.writePermissionPreset('default');
  const current = object(f.files.get(f.userPath)), table = object(current.sandbox_workspace_write);
  current.sandbox_workspace_write = Object.fromEntries(Object.entries(table).reverse());
  f.files.set(f.userPath, current);
  await selection.rollback();
  assert.equal(f.files.get(f.userPath)!.sandbox_mode, 'danger-full-access');
  const first = await f.settings.writePermissionPreset('default');
  await f.settings.writePermissionPreset('default');
  const version = f.versions.get(f.userPath);
  await first.rollback();
  assert.equal(f.versions.get(f.userPath), version);
  assert.equal(f.files.get(f.userPath)!.sandbox_mode, 'workspace-write');
});
h.test('retired preset storage cannot be rewritten through generic settings', async () => {
  const f = fixture(), registry = new ChannelRegistry();
  registerSettingsHandlers(registry, { configRoot: f.root, request: f.request, onSettingsChanged() {} });
  for (const key of ['composer.permission_mode', 'migrated.composer_permission_v2']) {
    await assert.rejects(async () => registry.lookup('settings:kv:set')!({ channel: 'settings:kv:set', role: 'main', senderId: 1, args: [{ key, value: 'bypassPermissions' }] }));
    assert.equal(kvGet(key, f.root), null);
  }
  assert.equal(f.requests.length, 0);
});
h.test('legacy defaults migrate only absent policy fields and retain edit-only identity', async () => {
  const f = fixture(); kvSet('composer.permission_mode', 'acceptEdits', f.root);
  await f.settings.migratePermissionDefault('acceptEdits');
  finishPermissionDefaultMigration(f.root, 'acceptEdits');
  assert.equal(storedPermissionMode(f.root), undefined);
  assert.deepEqual(runtimePolicyForSession('', object(f.files.get(f.userPath)), f.root), { policy: presetRuntimePolicy('acceptEdits') });
  assert.equal(f.requests.filter(row => row.method === 'config/batchWrite')[0]!.params.expectedVersion, '1');
  await f.settings.migratePermissionDefault('bypassPermissions');
  assert.equal(f.requests.filter(row => row.method === 'config/batchWrite').length, 1);
  await f.settings.writeRow('klaus.approvalPolicy', ''); await f.settings.writeRow('klaus.sandboxMode', ''); await f.settings.writeRow('klaus.approvalsReviewer', '');
  assert.equal(await f.settings.migratePermissionDefault(storedPermissionMode(f.root)), false);
  assert.equal(Object.hasOwn(runtimePolicyForSession('', object(f.files.get(f.userPath)), f.root), 'mode'), false);
});
h.test('configured policies freeze per conversation across global changes and are inherited on fork', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'read-only', approvals_reviewer: 'user' });
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, onSessionConfigChanged: () => {}, sessionCwd: async () => f.project });
  const first = object(await composer.getPermission('first')); assert.equal(first.preset, null);
  await f.settings.writePermissionPreset('bypassPermissions');
  assert.deepEqual(object(await composer.getPermission('first')).policy, first.policy);
  const second = object(await composer.getPermission('second')); assert.equal(second.preset, 'bypassPermissions');
  inheritSessionComposerPreferences('first', 'fork', f.root);
  assert.deepEqual(object(await composer.getPermission('fork')).policy, first.policy);
});
h.test('a per-conversation preset changes only that conversation and a failed publication rolls it back', async () => {
  const f = fixture(), changed: string[] = [];
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, onSessionConfigChanged: change => { if (change.sessionId === 'rejected') throw new Error('policy rejected'); changed.push(change.sessionId ?? 'default'); } });
  await composer.getPermission('other');
  await composer.setPermission({ sessionId: 'chosen', mode: 'auto' });
  assert.equal(object(await composer.getPermission('chosen')).preset, 'auto'); assert.equal(object(await composer.getPermission('other')).preset, null);
  await assert.rejects(composer.setPermission({ sessionId: 'rejected', mode: 'bypassPermissions' }), /policy rejected/);
  assert.equal(sessionPermissionPreset('rejected', f.root), undefined); assert.deepEqual(changed, ['chosen']);
});
h.test('permission rollback preserves a newer writer and global picks leave frozen conversations unchanged', async () => {
  const f = fixture(); let replaced = false;
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, onSessionConfigChanged: () => {
    if (!replaced) { replaced = true; setSessionPermissionPreset('thread', 'default', f.root); throw new Error('newer permission'); }
  } });
  await assert.rejects(composer.setPermission({ sessionId: 'thread', mode: 'auto' }), /newer permission/);
  assert.equal(sessionPermissionPreset('thread', f.root), 'default');
  await composer.getPermission('frozen'); await composer.setPermission({ mode: 'bypassPermissions' });
  assert.equal(object(await composer.getPermission('frozen')).preset, null);
  assert.equal(object(await composer.getPermission('')).preset, 'bypassPermissions');
});
h.test('an unmatched configured policy selects no preset and remains intact until a preset is chosen', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'read-only', approvals_reviewer: 'user' }), state = new HostState();
  state.rememberSession('thread', 'engine-thread', { cwd: f.project });
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {} });
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, sessionCwd: async () => f.project, onSessionConfigChanged: change => configuration.composerChanged(change) });
  const configured = object(await composer.getPermission('thread'));
  assert.equal(configured.mode, null); assert.equal(configured.preset, null); assert.equal(configured.effectiveMode, null);
  assert.equal(Object.hasOwn(configured, 'customAvailable'), false);
  assert.deepEqual(configured.policy, { approvalPolicy: 'never', sandboxMode: 'read-only', approvalsReviewer: 'user', sandboxNetworkAllowed: false });
  assert.deepEqual(configured.configuredPolicy, configured.policy);
  assert.equal(f.requests.some(row => row.method === 'config/batchWrite' || row.method === 'session/setRuntimePolicy'), false);
  await composer.setPermission({ sessionId: 'thread', mode: 'default' });
  const normal = object(await composer.getPermission('thread'));
  assert.equal(normal.preset, 'default'); assert.deepEqual(normal.policy, presetRuntimePolicy('default'));
  assert.deepEqual(normal.configuredPolicy, configured.policy);
  const applied = f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params;
  assert.equal(applied.approvalPolicy, 'on-request'); assert.equal(applied.sandboxMode, 'workspace-write');
});
h.test('an unsupported permission choice cannot write configuration, replace a frozen policy or publish changes', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'read-only', approvals_reviewer: 'user' });
  const changes: unknown[] = [], pushes: unknown[] = [];
  const composer = new ComposerService({ configRoot: f.root, request: f.request,
    push: (...args) => { pushes.push(args); }, onSessionConfigChanged: change => { changes.push(change); } });
  await composer.setPermission({ sessionId: 'thread', mode: 'auto' });
  for (const sessionId of ['', 'thread']) {
    const before = await composer.getPermission(sessionId), requests = f.requests.length;
    const writes = structuredClone([...f.files]), frozen = sessionRuntimePolicy('thread', f.root);
    const changeCount = changes.length, pushCount = pushes.length;
    assert.deepEqual(await composer.setPermission({ sessionId, mode: 'custom' }), { error: 'invalid mode' });
    assert.equal(f.requests.length, requests); assert.deepEqual([...f.files], writes);
    assert.equal(changes.length, changeCount); assert.equal(pushes.length, pushCount);
    assert.deepEqual(sessionRuntimePolicy('thread', f.root), frozen);
    assert.deepEqual(await composer.getPermission(sessionId), before);
  }
});
h.test('startup and live policy publication use the same frozen configured policy', async () => {
  const f = fixture({ approval_policy: 'never', sandbox_mode: 'read-only', approvals_reviewer: 'user', sandbox_workspace_write: { network_access: false } });
  const init: JsonObject = { cwd: f.project, config: {} };
  applyRuntimeSettings(init, await f.settings.resolved(f.project), 'thread', f.root);
  const state = new HostState(); state.rememberSession('thread', 'engine-thread', init);
  const config = object(init.config);
  const updates: JsonObject[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async (sessionId, update) => { assert.equal(sessionId, 'thread'); updates.push(update); } });
  await f.settings.writePermissionPreset('bypassPermissions'); await configuration.settingsChanged('klaus.sandboxMode');
  const published = f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params;
  assert.equal(published.sandboxMode, config.sandbox_mode); assert.equal(published.approvalPolicy, config.approval_policy); assert.equal(published.networkAllowed, init.networkAllowed);
  assert.deepEqual(updates, [{ webSearchAccess: 'cached' }]);
  assert.equal(state.isStale('thread'), false);
});
h.test('inference-only settings publish a fence without tearing down the session and include default resets', async () => {
  const f = fixture(), state = new HostState(); state.rememberSession('thread', 'engine-thread', { cwd: f.project });
  const published: Array<string | undefined> = [];
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, publishInference: async id => { published.push(id); } });
  await configuration.settingsChanged('klaus.modelVerbosity'); await configuration.settingsChanged('klaus.reasoningSummary');
  assert.equal(state.isStale('thread'), false); assert.equal(published.length, 2);
  const selected = configuredInference({ config: {} }, { modelVerbosity: null, reasoningSummary: 'auto' }, {});
  assert.deepEqual(object(selected.config), { modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'cached' } });
  const updated = replaceInferenceInit({ config: { modelVerbosity: 'high', reasoningSummary: 'none', sandbox_mode: 'read-only' } }, selected);
  assert.deepEqual(object(updated.config), { sandbox_mode: 'read-only', modelVerbosity: null, reasoningSummary: 'auto', webSearch: { access: 'cached' } });
});
h.test('project web access updates only matching live sessions without teardown and propagates rejection', async () => {
  const f = fixture({ webSearch: { access: 'cached' } }), state = new HostState();
  state.rememberSession('matching', 'engine-matching', { cwd: f.project }); state.rememberSession('other', 'engine-other', { cwd: '/another-project' });
  const updates: Array<{ sessionId: string; update: JsonObject }> = [];
  const config = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async (sessionId, update) => { updates.push({ sessionId, update }); } });
  await config.settingsChanged('klaus.webSearch.access', { kind: 'project', cwd: f.project });
  assert.deepEqual(updates, [{ sessionId: 'matching', update: { webSearchAccess: 'cached' } }]); assert.equal(state.isStale('matching'), false);
  const rejected = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async () => { throw new Error('access rejected'); } });
  await assert.rejects(rejected.settingsChanged('klaus.webSearch.access'), /access rejected/);
});
h.test('conversations without resource roots publish global cached, disabled and live access', async () => {
  const f = fixture(), state = new HostState(); state.rememberSession('rootless', 'engine-rootless', {});
  const updates: JsonObject[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async (sessionId, update) => { assert.equal(sessionId, 'rootless'); updates.push(update); } });
  for (const access of ['cached', 'disabled', 'live']) {
    await f.settings.writeRow('klaus.webSearch.access', access);
    await configuration.settingsChanged('klaus.webSearch.access');
    assert.deepEqual(updates.at(-1), { webSearchAccess: access });
  }
  const reads = f.requests.filter(row => row.method === 'config/read');
  assert.equal(reads.length, 6); assert(reads.every(row => Object.keys(row.params).length === 0));
  assert.equal(state.isStale('rootless'), false);
});
h.test('rootless search publication derives cached or live defaults before an explicit override', async () => {
  const f = fixture(), state = new HostState(); state.rememberSession('rootless-default', 'engine-rootless-default', {});
  const updates: JsonObject[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async (sessionId, update) => { assert.equal(sessionId, 'rootless-default'); updates.push(update); } });
  await configuration.settingsChanged('klaus.webSearch.access'); assert.deepEqual(updates.at(-1), { webSearchAccess: 'cached' });
  await f.settings.writePermissionPreset('bypassPermissions');
  await configuration.settingsChanged('klaus.webSearch.access'); assert.deepEqual(updates.at(-1), { webSearchAccess: 'live' });
  await f.settings.writeRow('klaus.webSearch.access', 'indexed');
  await configuration.settingsChanged('klaus.webSearch.access'); assert.deepEqual(updates.at(-1), { webSearchAccess: 'indexed' });
});
h.test('live permission transitions immediately publish sandbox-derived search for only the chosen conversation', async () => {
  const f = fixture(), state = new HostState();
  state.rememberSession('chosen', 'engine-chosen', { cwd: f.project }); state.rememberSession('other', 'engine-other', { cwd: f.project });
  const updates: JsonObject[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async (sessionId, update) => {
    assert.equal(sessionId, 'chosen'); assert.equal(f.requests.at(-1)?.method, 'session/setRuntimePolicy'); updates.push(update);
  } });
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, sessionCwd: async () => f.project, onSessionConfigChanged: change => configuration.composerChanged(change) });
  await composer.getPermission('chosen'); await composer.getPermission('other');
  await composer.setPermission({ sessionId: 'chosen', mode: 'bypassPermissions' });
  await composer.setPermission({ sessionId: 'chosen', mode: 'default' });
  assert.deepEqual(updates, [{ webSearchAccess: 'live' }, { webSearchAccess: 'cached' }]);
  assert.equal(object(await composer.getPermission('other')).preset, null);
  assert.equal(state.isStale('chosen'), false); assert.equal(state.isStale('other'), false);
});
h.test('live permission transitions retain each explicit search access mode', async () => {
  for (const access of ['cached', 'indexed', 'live', 'disabled']) {
    const f = fixture({ webSearch: { access } }), state = new HostState();
    state.rememberSession('chosen', 'engine-chosen', { cwd: f.project });
    const updates: JsonObject[] = [];
    const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async (sessionId, update) => { assert.equal(sessionId, 'chosen'); updates.push(update); } });
    for (const mode of ['bypassPermissions', 'default'] as const) {
      setSessionPermissionPreset('chosen', mode, f.root); await configuration.composerChanged({ kind: 'permission', sessionId: 'chosen' });
    }
    assert.deepEqual(updates, [{ webSearchAccess: access }, { webSearchAccess: access }]);
  }
});
h.test('a failed search publication rolls the chosen permission and derived search back together', async () => {
  const f = fixture(), state = new HostState(); state.rememberSession('chosen', 'engine-chosen', { cwd: f.project });
  const updates: JsonObject[] = []; let reject = true;
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async (sessionId, update) => {
    assert.equal(sessionId, 'chosen'); updates.push(update); if (reject) { reject = false; throw new Error('search publication rejected'); }
  } });
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, sessionCwd: async () => f.project, onSessionConfigChanged: change => configuration.composerChanged(change) });
  await composer.getPermission('chosen');
  await assert.rejects(composer.setPermission({ sessionId: 'chosen', mode: 'bypassPermissions' }), /search publication rejected/);
  assert.equal(object(await composer.getPermission('chosen')).preset, null);
  assert.deepEqual(updates, [{ webSearchAccess: 'live' }, { webSearchAccess: 'cached' }]);
  assert.equal(f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)?.params.sandboxMode, 'read-only');
  assert.equal(state.isStale('chosen'), true);
});
h.test('missing live search publication fences the binding for an authoritative rebuild', async () => {
  const f = fixture(), state = new HostState(); state.rememberSession('chosen', 'engine-chosen', { cwd: f.project });
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {} });
  setSessionPermissionPreset('chosen', 'bypassPermissions', f.root);
  await configuration.composerChanged({ kind: 'permission', sessionId: 'chosen' }); assert.equal(state.isStale('chosen'), true);
});
h.test('a scoped network edit preserves inherited writable roots and temporary-directory exclusions atomically', async () => {
  const table = structuredClone(vector.policyConfiguration.workspaceTable);
  const f = fixture({ sandbox_mode: 'workspace-write', sandbox_workspace_write: table });
  const scope = { kind: 'project' as const, cwd: f.project }, before = await f.settings.runtimeSnapshot(scope);
  await f.settings.writeRow('klaus.sandbox.networkAllowed', 'on', { scope, expectedVersion: before.version });
  assert.deepEqual(object(f.files.get(f.projectPath)).sandbox_workspace_write, { ...table, network_access: true });
  assert.deepEqual(object(f.files.get(f.userPath)).sandbox_workspace_write, table);
  const batch = f.requests.filter(row => row.method === 'config/batchWrite').at(-1)!.params;
  assert.equal(batch.expectedVersion, before.version); assert.deepEqual((batch.edits as JsonObject[]).map(row => row.keyPath), ['sandbox_workspace_write']);
  await f.settings.writeRow('klaus.sandbox.networkAllowed', '', { scope });
  const cleared = object(object(f.files.get(f.projectPath)).sandbox_workspace_write);
  assert.equal(Object.hasOwn(cleared, 'network_access'), false); assert.deepEqual(cleared.writable_roots, table.writable_roots); assert.equal(cleared.exclude_slash_tmp, true);
});
h.test('canonical initialization preserves a read-only runtime network grant across automatic review and reload', async () => {
  const f = fixture({ sandbox_mode: 'read-only' });
  const policy = { approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const, approvalsReviewer: 'user' as const, sandboxNetworkAllowed: true };
  applySessionRuntimePolicy('thread', { policy }, f.root);
  const composer = new ComposerService({ configRoot: f.root, request: f.request, push: () => {}, onSessionConfigChanged: () => {} });
  await composer.setPermission({ sessionId: 'thread', mode: 'auto' });
  const init: JsonObject = { config: {} }; applyRuntimeSettings(init, await f.settings.resolved(), 'thread', f.root);
  assert.equal(init.networkAllowed, true); assert.equal(object(init.config).sandbox_mode, 'read-only');
  assert.equal(object(init.config).approvals_reviewer, 'auto_review');
  for (const key of ['sandboxMode', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'sandboxNetworkAllowed', 'requireRealSandbox', 'sandboxRetryOnDenial', 'additionalWritableRoots', 'additionalReadableRoots', 'confineReads']) assert.equal(Object.hasOwn(object(init.config), key), false, key);
  assert.equal(runtimePolicyForSession('thread', {}, f.root).policy.sandboxNetworkAllowed, true);
});
h.test('preset publications retain captured roots while configuration publications include the complete workspace table', async () => {
  const table = { writable_roots: ['/configured'], network_access: true, exclude_tmpdir_env_var: true, exclude_slash_tmp: false };
  const f = fixture({ sandbox_mode: 'workspace-write', sandbox_workspace_write: table }), state = new HostState();
  state.rememberSession('thread', 'engine-thread', { cwd: f.project, config: { sandbox_workspace_write: { ...table, writable_roots: ['/configured', '/runtime-resource'] } } }, { source: 'custom', selection: 'fixture', hostWritableRoots: ['/runtime-resource'] });
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async () => {} });
  setSessionPermissionPreset('thread', 'default', f.root);
  await configuration.composerChanged({ kind: 'permission', sessionId: 'thread' });
  assert.equal(Object.hasOwn(f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params, 'sandboxWorkspaceWrite'), false);
  await configuration.settingsChanged('klaus.sandbox.networkAllowed');
  const wire = f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params;
  assert.deepEqual(wire.sandboxWorkspaceWrite, { ...table, writable_roots: ['/configured', '/runtime-resource'] });
  for (const key of ['sandbox', 'requireRealSandbox', 'sandboxRetryOnDenial']) assert.equal(Object.hasOwn(wire, key), false, key);
});
h.test('live configuration removes revoked writable roots while preserving only captured host resources', async () => {
  const table = { writable_roots: ['/revoked', '/overlap'], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: true };
  const f = fixture({ sandbox_mode: 'workspace-write', sandbox_workspace_write: table }), state = new HostState();
  state.rememberSession('thread', 'engine-thread', { cwd: f.project, config: { sandbox_workspace_write: { ...table, writable_roots: [...table.writable_roots, '/resource'] } } },
    { source: 'custom', selection: 'fixture', hostWritableRoots: ['/overlap', '/resource'] });
  const configuration = new SessionConfiguration({ state, configRoot: f.root, request: f.request, log: () => {}, updateRuntimeConfig: async () => {} });
  f.files.set(f.userPath, { sandbox_mode: 'workspace-write', sandbox_workspace_write: { ...table, writable_roots: ['/new'] } });
  await configuration.settingsChanged('klaus.sandbox.networkAllowed');
  const update = f.requests.filter(row => row.method === 'session/setRuntimePolicy').at(-1)!.params;
  assert.deepEqual(object(update.sandboxWorkspaceWrite).writable_roots, ['/new', '/overlap', '/resource']);
  assert.deepEqual(state.resourceRoots('thread'), [f.project, '/new', '/overlap', '/resource']);
  assert.deepEqual(state.hostWritableRoots('thread'), ['/overlap', '/resource']);
  f.files.set(f.userPath, { sandbox_mode: 'workspace-write', sandbox_workspace_write: { ...table, writable_roots: [] } });
  await configuration.settingsChanged('klaus.sandbox.networkAllowed');
  assert.deepEqual(state.resourceRoots('thread'), [f.project, '/overlap', '/resource']);
  const acknowledged = state.resourceRoots('thread');
  state.applyWorkspaceSettings('thread', 'replaced-engine', { ...table, writable_roots: ['/stale'] });
  assert.deepEqual(state.resourceRoots('thread'), acknowledged);
});
h.test('configuration migration notices are forwarded without introducing a config writer or approval gate', async () => {
  const migrationWarnings = [{ code: 'legacySandboxConfigMigrated', message: 'Legacy sandbox fields were migrated.', keys: ['sandbox', 'requireRealSandbox'] }];
  const settings = new EngineSettings(async method => { assert.equal(method, 'config/read'); return { path: '/config.toml', version: '2', values: {}, resolved: { sandbox_mode: 'read-only' }, migrationWarnings }; });
  assert.deepEqual((await settings.runtimeSnapshot()).migrationWarnings, migrationWarnings);
});
h.test('canonical governed defaults take precedence without a legacy backend fallback', async () => {
  assert.equal(resolveRuntimePolicy({ sandbox: 'process', sandboxMode: 'danger-full-access', sandboxNetworkAllowed: true }).sandboxMode, 'read-only');
  const settings = new EngineSettings(async () => ({ path: '/config.toml', version: '1', values: {}, resolved: { sandbox_mode: 'workspace-write', sandbox_workspace_write: { network_access: false } }, sources: { sandbox_mode: 'defaults', sandbox_workspace_write: 'defaults' } }));
  assert.equal((await settings.runtimeSnapshot()).effective['klaus.sandboxMode'], 'workspace-write');
});
h.test('retired sandbox rows are rejected by settings handlers instead of being written to local preferences', async () => {
  const f = fixture(), registry = new ChannelRegistry();
  registerSettingsHandlers(registry, { configRoot: f.root, request: f.request, onSettingsChanged: () => {} });
  const invoke = async (channel: string, args: Json) => registry.lookup(channel)!({ channel, role: 'main', senderId: 1, args: [args] });
  for (const key of ['klaus.sandbox', 'klaus.sandbox.requireReal', 'klaus.sandbox.retryOnDenial', 'klaus.confineReads', 'klaus.additionalReadableRoots', 'klaus.additionalWritableRoots']) {
    await assert.rejects(invoke('settings:kv:get', { key }), /retired/);
    await assert.rejects(invoke('settings:kv:set', { key, value: 'on' }), /retired/);
    assert.equal(kvGet(key, f.root), null);
  }
  assert.equal(f.requests.length, 0);
});
h.test('scoped metadata and config opening use only the engine returned path', async () => {
  const f = fixture(), registry = new ChannelRegistry(), opened: string[] = [];
  registerSettingsHandlers(registry, { configRoot: f.root, request: f.request, onSettingsChanged: () => {}, openConfig: async path => { opened.push(path); } });
  const invoke = async (channel: string, args: Json) => registry.lookup(channel)!({ channel, role: 'main', senderId: 1, args: [args] });
  const scope = { kind: 'project', cwd: f.project };
  assert.equal(object(await invoke('settings:runtime-config:get', { scope })).path, f.projectPath);
  await invoke('settings:runtime-config:open', { scope }); assert.deepEqual(opened, [f.projectPath]);
  await assert.rejects(invoke('settings:kv:set', { key: 'theme', value: 'dark', scope }), /not project scoped/);
  assert.throws(() => runtimeConfigScope({ kind: 'project', cwd: 'relative' }), /absolute project/);
});

void h.finish(join(__dirname, 'runtime-settings-result.json'), 'runtime-settings').then(code => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
