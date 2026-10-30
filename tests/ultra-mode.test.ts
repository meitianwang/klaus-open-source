import { classifyRuntimePolicy, presetRuntimePolicy, runtimePolicyConfig, resolveRuntimePolicy, type LegacyPermissionPreset } from '../contracts/runtime-settings';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { ComposerService } from '../main/services/composer';
import { readSessionThinkingLevel, setSessionThinkingLevel, readSessionUltraMode, applySessionUltraSelection, inheritSessionComposerPreferences, sessionPermissionPreset, setSessionPermissionPreset } from '../main/services/session-store';
import { buildSessionConfig } from '../main/services/session-init';
import { kvGet, kvSet, withSettingsDb } from '../main/services/settings';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { modelPreference } from '../main/services/mobile/model-config';
import { object, type JsonObject } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import { SessionConfiguration } from '../main/sessions/configuration';
import { HostState } from '../main/services/host-state';
import { effort } from '../main/services/extensions/frontmatter';

const h = new Harness();
async function invoke(registry: ChannelRegistry, channel: string, payload: Json): Promise<Json> {
  const handler = registry.lookup(channel);
  assert(handler);
  return handler({ channel, role: 'main', senderId: 1, args: [payload] });
}
const roots: string[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/ultra-mode-vectors.json'), 'utf8'));
function fresh(): string { const root = mkdtempSync(join(tmpdir(), 'klaus-ultra-')); roots.push(root); return root; }
const policies = new Map<string, JsonObject>();
function policyValues(root: string): JsonObject {
  let values = policies.get(root);
  if (!values) { values = runtimePolicyConfig(presetRuntimePolicy('default')) as JsonObject; policies.set(root, values); }
  return values;
}
function setDefault(root: string, preset: LegacyPermissionPreset): void { policies.set(root, runtimePolicyConfig(presetRuntimePolicy(preset)) as JsonObject); }
function defaultPreset(root: string): string | null { return classifyRuntimePolicy(resolveRuntimePolicy(policyValues(root))); }
function policyRequest(root: string) {
  return async (method: string, raw: Json): Promise<Json> => {
    if (method === 'config/read') return { values: structuredClone(policyValues(root)), resolved: structuredClone(policyValues(root)), version: '1' };
    if (method === 'config/batchWrite') {
      const params = object(raw), values = policyValues(root);
      for (const item of params.edits as Json[]) { const edit = object(item); if (edit.value === null) delete values[String(edit.keyPath)]; else values[String(edit.keyPath)] = edit.value!; }
      return { version: '1' };
    }
    return {};
  };
}
function composer(root: string, changed: (value: unknown) => void | Promise<void> = () => {}): ComposerService {
  return new ComposerService({ configRoot: root, push: () => {}, request: policyRequest(root), onSessionConfigChanged: changed });
}

h.test('Ultra survives storage, session init, mobile projection, and model switching', async () => {
  const root = fresh(), service = composer(root);
  setSessionThinkingLevel('other', 'low', root);
  await service.setThinking({ sessionId: 'current', level: vector.mode });
  assert.equal(readSessionUltraMode('current', root), true);
  assert.equal(readSessionThinkingLevel('other', root), 'low');
  assert.equal(buildSessionConfig('ultra', false, null, presetRuntimePolicy('acceptEdits')).effort, 'xhigh');
  assert.equal(buildSessionConfig('ultra', false, null, presetRuntimePolicy('default'), false).ultraMode, false);
  assert.equal(buildSessionConfig('low', false, null, presetRuntimePolicy('default'), true).effort, 'low');
  assert.equal(buildSessionConfig('low', false, null, presetRuntimePolicy('default'), true).ultraMode, true);
  assert.equal(buildSessionConfig('off', false, null, presetRuntimePolicy('default'), true).ultraMode, true);
  assert.equal(buildSessionConfig('off', false, null, presetRuntimePolicy('default'), true).effort, undefined);
  assert.equal(modelPreference({ source: 'codex', selection: 'codex:fixture', thinkingLevel: 'ultra' })?.thinkingLevel, 'ultra');
  await service.setModel({ sessionId: 'current', mode: 'custom:no-effort' });
  assert.equal(readSessionUltraMode('current', root), true);
});

h.test('restricted Ultra confirmation publishes both choices from the same snapshot', async () => {
  const root = fresh();
  setDefault(root, 'bypassPermissions');
  const observed: unknown[] = [];
  const service = composer(root, () => { observed.push([readSessionUltraMode('current', root), defaultPreset(root)]); });
  await service.setThinking({ sessionId: 'current', level: vector.mode, permissionMode: vector.restrictedPermission });
  assert(observed.length > 0);
  assert(observed.every(row => JSON.stringify(row) === '[true,"default"]'));
});

h.test('failed publication restores both preferences and the future default', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'max', root);
  setDefault(root, 'bypassPermissions');
  const service = composer(root, () => { throw new Error('Publication failed'); });
  await assert.rejects(service.setThinking({ sessionId: 'current', level: 'ultra', permissionMode: 'default' }), /Publication failed/);
  assert.equal(readSessionThinkingLevel('current', root), 'max');
  assert.equal(readSessionThinkingLevel('', root), 'max');
  assert.equal(defaultPreset(root), 'bypassPermissions');
});

h.test('restricted Ultra replaces a pinned bypass and publishes only its session when the default is already restricted', async () => {
  const root = fresh(), scoped = vector.scopedRestrictedPermission;
  setDefault(root, scoped.defaultMode);
  setSessionPermissionPreset('current', scoped.before, root);
  setSessionPermissionPreset('other', 'default', root);
  const changes: unknown[] = [];
  const service = composer(root, change => {
    changes.push(change);
    assert.equal(sessionPermissionPreset('current', root), scoped.after);
    assert.equal(readSessionUltraMode('current', root), true);
  });
  await service.setThinking({ sessionId: 'current', level: 'ultra', permissionMode: scoped.after });
  assert.deepEqual(changes, [{ kind: 'permission', sessionId: 'current' }, { kind: 'thinking', sessionId: 'current' }]);
  assert.equal(sessionPermissionPreset('other', root), 'default');
  assert.equal(defaultPreset(root), scoped.defaultMode);
});

h.test('a failed scoped Ultra policy restores its pinned bypass and compensates the same scope', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'max', root);
  setSessionPermissionPreset('current', 'bypassPermissions', root);
  const changes: unknown[] = [];
  const service = composer(root, change => { changes.push(change); throw new Error('Scoped policy failed'); });
  await assert.rejects(service.setThinking({ sessionId: 'current', level: 'ultra', permissionMode: 'default' }), /Scoped policy failed/);
  assert.equal(sessionPermissionPreset('current', root), 'bypassPermissions');
  assert.equal(readSessionThinkingLevel('current', root), 'max');
  assert.equal(defaultPreset(root), 'default');
  assert.deepEqual(changes, [{ kind: 'permission', sessionId: 'current' }, { kind: 'permission', sessionId: 'current' }]);
});

h.test('scoped Ultra rollback preserves a newer permission write even when its mode is unchanged', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'max', root);
  setSessionPermissionPreset('current', 'bypassPermissions', root);
  let replaced = false;
  const service = composer(root, () => {
    if (replaced) return;
    replaced = true;
    setSessionPermissionPreset('current', 'default', root);
    throw new Error('A newer permission was selected');
  });
  await assert.rejects(service.setThinking({ sessionId: 'current', level: 'ultra', permissionMode: 'default' }), /newer permission/);
  assert.equal(sessionPermissionPreset('current', root), 'default');
  assert.equal(readSessionThinkingLevel('current', root), 'max');
});

h.test('invalid combined selections do not change permission or reasoning preferences', async () => {
  const root = fresh(), service = composer(root);
  setSessionThinkingLevel('current', 'high', root);
  await assert.rejects(service.setThinking({ sessionId: 'current', level: 'high', permissionMode: 'bypassPermissions' }));
  await assert.rejects(service.setThinking({ sessionId: 'current', level: 'ultra', permissionMode: 'invalid' }));
  assert.equal(readSessionThinkingLevel('current', root), 'high');
  assert.equal(defaultPreset(root), 'default');
});

h.test('a live permission switch publishes that conversation preset, not the remembered default', async () => {
  const root = fresh(), state = new HostState();
  state.rememberSession('mine', 'engine-mine', {});
  state.rememberSession('other', 'engine-other', {});
  // The remembered default still asks every time; only this conversation was
  // switched to bypass. Publishing the default instead of the row left the
  // running session asking for approvals its own picker had turned off, while
  // the picker displayed the new value.
  setDefault(root, 'default');
  setSessionPermissionPreset('mine', 'bypassPermissions', root);
  const calls: string[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: root, log: () => {},
    request: async (method, params) => {
      if (method === 'config/read') { assert.deepEqual(params, {}); return { resolved: policyValues(root) }; }
      assert.equal(method, 'session/setRuntimePolicy');
      assert.equal(Object.hasOwn(params, 'permissionMode'), false);
      calls.push(`${String(params.sessionId)}:${String(params.approvalPolicy)}:${String(params.sandboxMode)}`);
      for (const key of ['sandbox', 'requireRealSandbox', 'sandboxRetryOnDenial']) assert.equal(Object.hasOwn(params, key), false);
      return {};
    },
  });
  await configuration.composerChanged({ kind: 'permission', sessionId: 'mine' });
  assert.deepEqual(calls, ['engine-mine:never:danger-full-access'],
    'only the switched conversation is re-published, with its own preset and its sandbox released');
});

h.test('a default-only permission change still reaches conversations without their own preset', async () => {
  const root = fresh(), state = new HostState();
  state.rememberSession('inherit', 'engine-inherit', {});
  state.rememberSession('pinned', 'engine-pinned', {});
  setSessionPermissionPreset('pinned', 'default', root);
  setDefault(root, 'bypassPermissions');
  const calls: string[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: root, log: () => {},
    request: async (method, params) => {
      if (method === 'config/read') { assert.deepEqual(params, {}); return { resolved: policyValues(root) }; }
      assert.equal(Object.hasOwn(params, 'permissionMode'), false); calls.push(`${String(params.sessionId)}:${String(params.sandboxMode)}`); return {};
    },
  });
  await configuration.composerChanged({ kind: 'permission' });
  assert.deepEqual(calls.sort(), ['engine-inherit:danger-full-access', 'engine-pinned:workspace-write']);
});

h.test('turning off prompting settles approval cards only where bypass actually landed', async () => {
  const root = fresh(), state = new HostState();
  state.rememberSession('mine', 'engine-mine', {});
  state.rememberSession('plain', 'engine-plain', {});
  state.rememberSession('planned', 'engine-planned', {});
  setSessionPermissionPreset('mine', 'bypassPermissions', root);
  setSessionPermissionPreset('plain', 'default', root);
  setSessionPermissionPreset('planned', 'bypassPermissions', root);
  withSettingsDb(root, db => db.prepare('INSERT INTO session_chat_modes (session_id, mode, updated_at) VALUES (?, ?, ?)').run('planned', 'plan', 1));
  const settled: string[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: root, log: () => {},
    request: async method => method === 'config/read' ? { resolved: {} } : {},
    settleBypassedApprovals: async id => { settled.push(id); } });
  await configuration.composerChanged({ kind: 'permission' });
  // Collaboration is independent of policy. Every conversation whose selected
  // preset disables prompting settles the approvals answered by the engine.
  assert.deepEqual(settled, ['mine', 'planned']);
});

h.test('a failed policy publication leaves the approval cards standing', async () => {
  const root = fresh(), state = new HostState();
  state.rememberSession('mine', 'engine-mine', {});
  setSessionPermissionPreset('mine', 'bypassPermissions', root);
  const settled: string[] = [];
  const configuration = new SessionConfiguration({ state, configRoot: root, log: () => {},
    request: async method => {
      if (method === 'config/read') return { resolved: policyValues(root) };
      assert.equal(method, 'session/setRuntimePolicy');
      throw new Error('engine refused the policy');
    },
    settleBypassedApprovals: async id => { settled.push(id); } });
  await assert.rejects(configuration.composerChanged({ kind: 'permission', sessionId: 'mine' }), /engine refused/);
  // The engine never reached bypass, so it is still waiting on every card it parked.
  assert.deepEqual(settled, []);
  assert.equal(state.isStale('mine'), true);
});

h.test('combined orchestration failure compensates only its own canonical policy', async () => {
  const root = fresh(), state = new HostState();
  state.rememberSession('current', 'engine-current', {}); state.rememberSession('other', 'engine-other', {});
  setSessionThinkingLevel('current', 'max', root); setSessionPermissionPreset('current', 'bypassPermissions', root);
  setDefault(root, 'bypassPermissions');
  const calls: string[] = [], request = policyRequest(root);
  const configuration = new SessionConfiguration({ state, configRoot: root, log() {}, request: async (method, params) => {
    if (method !== 'session/setRuntimePolicy') return request(method, params);
    calls.push(String(params.sessionId) + ':' + String(params.approvalPolicy));
    if (params.approvalPolicy === 'on-request') throw new Error('Policy failure');
    return {};
  } });
  await assert.rejects(composer(root, change => configuration.composerChanged(change as Parameters<SessionConfiguration['composerChanged']>[0]))
    .setUltraMode({ sessionId: 'current', enabled: true, permissionMode: 'default' }), /Policy failure/);
  assert.deepEqual(calls, ['engine-current:on-request', 'engine-current:never']);
  assert.equal(sessionPermissionPreset('current', root), 'bypassPermissions');
  assert.equal(defaultPreset(root), 'bypassPermissions'); assert.equal(readSessionThinkingLevel('current', root), 'max');
});

h.test('failed Ultra publication preserves a newer default while rolling back its owned rows', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'max', root);
  setDefault(root, 'bypassPermissions');
  let changed = false;
  const service = composer(root, () => {
    if (changed) return;
    changed = true;
    setSessionThinkingLevel('other', 'low', root);
    throw new Error('Concurrent publication failure');
  });
  await assert.rejects(service.setThinking({ sessionId: 'current', level: 'ultra', permissionMode: 'default' }), /Concurrent publication failure/);
  assert.equal(readSessionThinkingLevel('', root), 'low');
  assert.equal(readSessionThinkingLevel('other', root), 'low');
  assert.equal(readSessionThinkingLevel('current', root), 'max');
  assert.equal(defaultPreset(root), 'bypassPermissions');
});

h.test('models without native effort expose an exit from Ultra', async () => {
  const service = new ComposerService({ configRoot: fresh(), push: () => {}, onSessionConfigChanged: () => {},
    request: async () => ({ models: [{ alias: 'plain', effortLevels: [] }, { alias: 'limited', effortLevels: ['low', 'high'] }] }) });
  const rows = await service.options('subscription');
  assert.deepEqual(object(rows[0]).supportedThinkingLevels, vector.noEffortChoices);
  assert.deepEqual(object(rows[1]).supportedThinkingLevels, vector.limitedModelChoices);
});

h.test('child conversation inherits Ultra without changing future defaults', () => {
  const root = fresh();
  setSessionThinkingLevel('parent', 'high', root);
  applySessionUltraSelection('parent', true, root);
  setSessionThinkingLevel('', 'medium', root);
  inheritSessionComposerPreferences('parent', 'child', root);
  assert.equal(readSessionThinkingLevel('child', root), 'high');
  assert.equal(readSessionUltraMode('child', root), true);
  assert.equal(readSessionThinkingLevel('', root), 'medium');
});

h.test('unknown model capabilities expose local Ultra without inventing native effort', async () => {
  const service = new ComposerService({ configRoot: fresh(), push: () => {}, onSessionConfigChanged: () => {},
    request: async () => ({ models: [{ alias: 'unknown' }] }) });
  assert.deepEqual(object((await service.options('subscription'))[0]).supportedThinkingLevels, vector.noEffortChoices);
  assert.equal(effort('ultra'), 'ultra');
  assert.equal(effort('xhigh'), 'xhigh');
});

h.test('legacy Ultra storage migrates to xhigh without overriding an explicit false mode', () => {
  const root = fresh();
  readSessionThinkingLevel('legacy', root);
  withSettingsDb(root, db => {
    db.prepare("DELETE FROM settings WHERE key = 'migrated.composer_ultra_mode_v1'").run();
    db.prepare("UPDATE session_thinking_levels SET level = 'ultra' WHERE session_id = 'legacy'").run();
    db.prepare("INSERT INTO session_ultra_modes(session_id, enabled, updated_at) VALUES ('legacy', 0, 1) ON CONFLICT(session_id) DO UPDATE SET enabled=0").run();
  });
  assert.equal(readSessionThinkingLevel('legacy', root), 'xhigh');
  assert.equal(readSessionUltraMode('legacy', root), false);
});

h.test('existing chats retain their frozen mode when the future default changes', async () => {
  const root = fresh(), service = composer(root);
  setSessionThinkingLevel('existing', 'low', root);
  readSessionThinkingLevel('existing', root);
  await service.setUltraMode({ enabled: true });
  assert.equal(readSessionUltraMode('existing', root), false);
  assert.equal(readSessionUltraMode('new', root), true);
});

h.test('toggling Ultra preserves native effort and disabling publishes an explicit false', async () => {
  const root = fresh(), service = composer(root);
  setSessionThinkingLevel('current', 'low', root);
  await service.setUltraMode({ sessionId: 'current', enabled: true });
  assert.equal(readSessionThinkingLevel('current', root), 'low');
  await service.setUltraMode({ sessionId: 'current', enabled: false });
  assert.equal(readSessionThinkingLevel('current', root), 'low');
  assert.equal(readSessionUltraMode('current', root), false);
  assert.equal(buildSessionConfig('low', false, null, presetRuntimePolicy('default'), false).ultraMode, false);
});

h.test('a native menu pick publishes its effort and exit from Ultra together', async () => {
  const root = fresh(), pick = vector.nativeMenuSelection;
  setSessionThinkingLevel('current', 'high', root);
  applySessionUltraSelection('current', true, root);
  readSessionUltraMode('other', root);
  const observed: unknown[] = [];
  const service = composer(root, () => {
    observed.push([readSessionThinkingLevel('current', root), readSessionUltraMode('current', root)]);
  });
  await service.setThinking({ sessionId: 'current', level: pick.level, ultraMode: pick.ultraMode });
  assert.deepEqual(observed, Array.from({ length: pick.publicationCount }, () => [pick.level, false]));
  assert.equal(readSessionUltraMode('other', root), true);
  assert.equal(readSessionUltraMode('', root), true);
  assert.equal(readSessionThinkingLevel('', root), 'high');
});

h.test('selecting the preserved native effort still publishes the exit from Ultra', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'low', root);
  applySessionUltraSelection('current', true, root);
  const changes: unknown[] = [];
  await composer(root, change => { changes.push(change); }).setThinking({ sessionId: 'current', level: 'low', ultraMode: false });
  assert.deepEqual(changes, [{ kind: 'thinking', sessionId: 'current' }]);
  assert.equal(readSessionUltraMode('current', root), false);
});

h.test('a rejected native menu selection restores effort and Ultra together', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'high', root);
  applySessionUltraSelection('current', true, root);
  await assert.rejects(composer(root, () => { throw new Error('Native selection failed'); })
    .setThinking({ sessionId: 'current', level: 'low', ultraMode: false }), /Native selection failed/);
  assert.equal(readSessionThinkingLevel('current', root), 'high');
  assert.equal(readSessionUltraMode('current', root), true);
  assert.equal(readSessionThinkingLevel('', root), 'high');
  assert.equal(readSessionUltraMode('', root), true);
});

h.test('native menu rollback preserves a newer mode selection in the same chat', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'high', root);
  applySessionUltraSelection('current', true, root);
  await assert.rejects(composer(root, () => {
    applySessionUltraSelection('current', false, root);
    throw new Error('A newer mode was saved');
  }).setThinking({ sessionId: 'current', level: 'low', ultraMode: false }), /newer mode/);
  assert.equal(readSessionThinkingLevel('current', root), 'high');
  assert.equal(readSessionUltraMode('current', root), false);
  assert.equal(readSessionUltraMode('', root), false);
});

h.test('an existing chat cannot replace the Ultra default for future chats', async () => {
  const root = fresh(), service = composer(root);
  assert.equal(readSessionUltraMode('', root), false);
  await service.setUltraMode({ sessionId: 'current', enabled: true });
  assert.equal(readSessionUltraMode('current', root), true);
  assert.equal(readSessionUltraMode('future', root), false);
  await service.setUltraMode({ enabled: true });
  await service.setUltraMode({ sessionId: 'current', enabled: false });
  assert.equal(readSessionUltraMode('current', root), false);
  assert.equal(readSessionUltraMode('future-after-draft-selection', root), true);
});

h.test('an unscoped native menu selection updates the future default atomically', async () => {
  const root = fresh(), service = composer(root);
  await service.setUltraMode({ enabled: true });
  await service.setThinking({ level: 'low', ultraMode: false });
  assert.equal(readSessionUltraMode('future', root), false);
  assert.equal(readSessionThinkingLevel('future', root), 'low');
});

h.test('native menu selection cannot enable Ultra or bypass permission confirmation', async () => {
  const root = fresh(), service = composer(root);
  for (const ultraMode of [true, 'false', null]) {
    await assert.rejects(service.setThinking({ sessionId: 'current', level: 'low', ultraMode }), /only leave Ultra/);
  }
  assert.equal(readSessionUltraMode('current', root), false);
});

h.test('a direct native selection exits Ultra atomically without replacing future defaults', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'high', root);
  applySessionUltraSelection('current', true, root);
  readSessionUltraMode('other', root);
  const observed: unknown[] = [];
  await composer(root, () => {
    observed.push([readSessionThinkingLevel('current', root), readSessionUltraMode('current', root)]);
  }).setThinking({ sessionId: 'current', level: 'low' });
  assert.deepEqual(observed, [['low', false]]);
  assert.equal(readSessionThinkingLevel('current', root), 'low');
  assert.equal(readSessionUltraMode('current', root), false);
  assert.equal(readSessionThinkingLevel('', root), 'high');
  assert.equal(readSessionUltraMode('', root), true);
  assert.equal(readSessionUltraMode('other', root), true);
});

h.test('a rejected direct native selection restores the complete previous selection', async () => {
  const root = fresh();
  setSessionThinkingLevel('current', 'high', root);
  applySessionUltraSelection('current', true, root);
  await assert.rejects(composer(root, () => { throw new Error('Native publication failed'); })
    .setThinking({ sessionId: 'current', level: 'low' }), /Native publication failed/);
  assert.equal(readSessionThinkingLevel('current', root), 'high');
  assert.equal(readSessionUltraMode('current', root), true);
  assert.equal(readSessionThinkingLevel('', root), 'high');
  assert.equal(readSessionUltraMode('', root), true);
});

h.test('the retired workflow setting cannot turn off the capability', async () => {
  const root = fresh(), registry = new ChannelRegistry();
  kvSet('klaus.workflow', 'off', root);
  const calls: string[] = [];
  registerSettingsHandlers(registry, { configRoot: root, onSettingsChanged: () => {}, request: async method => { calls.push(method); return {}; } });
  const get = await invoke(registry, 'settings:kv:get', { key: 'klaus.workflow' });
  assert.equal(get, 'on');
  await invoke(registry, 'settings:kv:set', { key: 'klaus.workflow', value: 'off' });
  assert.equal(await invoke(registry, 'settings:kv:get', { key: 'klaus.workflow' }), 'on');
  assert.equal(kvGet('klaus.workflow', root), null);
  assert.equal(calls.length, 0);
});

void h.finish(join(__dirname, 'ultra-mode-result.json'), 'ultra-mode').then(code => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(code);
});
