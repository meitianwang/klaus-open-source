import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WINDOWS_SANDBOX_SETTING_KEY } from '../contracts/windows-sandbox';
import { notificationToEvent } from '../main/engine/protocol';
import type { Json } from '../main/ipc/contract';
import { ChannelRegistry, type HandlerContext } from '../main/ipc/registry';
import { registerRuntimeWindowsSandboxHandlers } from '../main/ipc/handlers/runtime-windows-sandbox';
import { registerSettingsHandlers } from '../main/ipc/handlers/settings';
import { EngineSettings, isEngineConfigRow } from '../main/services/engine-settings';
import { HostState } from '../main/services/host-state';
import { KlausControlService } from '../main/services/klaus-control';
import { WindowsSandboxSetup } from '../main/services/windows-sandbox-setup';
import { SessionConfiguration } from '../main/sessions/configuration';
import { object } from '../main/services/service-types';
import { Harness } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/runtime-windows-sandbox.json'), 'utf8')) as {
  readinessStatuses: string[]; setupRequests: Json[]; completions: Json[];
};
const readiness = 'settings:runtime:windows-sandbox-readiness';
const start = 'settings:runtime:windows-sandbox-setup-start';
function fixture() {
  const calls: Array<{ method: string; params: Json }> = [], pushes: Array<{ channel: string; payload: Json }> = [];
  let generation: number | undefined = 4, reply: Json = { started: true }, failure: unknown;
  const service = new WindowsSandboxSetup({ request: async (method, params) => {
    calls.push({ method, params }); if (failure) throw failure; return reply;
  }, currentGeneration: () => generation, push: (channel, payload) => pushes.push({ channel, payload }) });
  const registry = new ChannelRegistry();
  registerRuntimeWindowsSandboxHandlers(registry, service);
  const invoke = (channel: string, params?: Json) => registry.lookup(channel)!({ role: 'main', senderId: 1, channel,
    args: params === undefined ? [] : [params] });
  return { calls, pushes, service, registry, invoke, generation: (value: number | undefined) => { generation = value; },
    reply: (value: Json) => { reply = value; }, fail: (error: unknown) => { failure = error; } };
}
process.exitCode = 1;
void (async () => {
  await h.test('readiness sends the parameterless named facade and preserves each native result', async () => {
    const f = fixture();
    for (const status of vector.readinessStatuses) {
      const reply = { status }; f.reply(reply);
      assert.equal(await f.invoke(readiness), reply);
    }
    assert.deepEqual(f.calls, Array.from({ length: 3 }, () => ({ method: 'engine/windowsSandboxReadiness', params: {} })));
  });
  await h.test('setup preserves explicit modes and omitted, null, and supplied working directories', async () => {
    const f = fixture();
    for (const params of vector.setupRequests) {
      for (const started of [true, false]) {
        const reply = { started }; f.reply(reply);
        assert.equal(await f.invoke(start, params), reply);
      }
    }
    assert.deepEqual(f.calls.map(call => call.params), [
      { mode: 'elevated' }, { mode: 'elevated' },
      { mode: 'unelevated', cwd: null }, { mode: 'unelevated', cwd: null },
      { mode: 'unelevated', cwd: 'C:\\work' }, { mode: 'unelevated', cwd: 'C:\\work' },
    ]);
    assert(f.calls.every(call => call.method === 'engine/startWindowsSandboxSetup'));
  });
  await h.test('invalid setup transport cannot select a default mode or start native preparation', async () => {
    const f = fixture();
    const variants: Json[] = [{}, { mode: 'mxc' }, { mode: 'admin' }, { mode: 'elevated', cwd: 3 }];
    for (const params of variants) {
      await assert.rejects(async () => f.invoke(start, params));
    }
    assert.deepEqual(f.calls, []);
  });
  await h.test('native request errors are propagated without a fabricated success or a configuration write', async () => {
    const f = fixture(), error = { kind: 'server', code: -32000, message: 'Native setup failed' };
    f.fail(error);
    await assert.rejects(async () => f.invoke(start, { mode: 'elevated' }), value => value === error);
    assert.deepEqual(f.calls, [{ method: 'engine/startWindowsSandboxSetup', params: { mode: 'elevated' } }]);
    assert.deepEqual(f.pushes, []);
  });
  await h.test('global completion is delivered without a thread binding and preserves nullable and textual errors', () => {
    const f = fixture();
    for (const params of vector.completions) {
      f.service.receive(notificationToEvent('engine/windowsSandboxSetupCompleted', params), 4);
      assert.equal(f.pushes.at(-1)!.payload, params);
    }
    assert(f.pushes.every(push => push.channel === 'settings:runtime:windows-sandbox-setup-completed'));
    assert.deepEqual(f.calls, []);
  });
  await h.test('completion from a retired engine generation is dropped while the replacement event is delivered', () => {
    const f = fixture(), event = notificationToEvent('engine/windowsSandboxSetupCompleted', { mode: 'elevated', success: true, error: null });
    f.generation(5); f.service.receive(event, 4);
    f.generation(undefined); f.service.receive(event, 5);
    assert.deepEqual(f.pushes, []);
    f.generation(5); f.service.receive(event, 5);
    assert.equal(f.pushes.length, 1);
  });
  await h.test('unrelated and malformed engine notifications cannot impersonate a setup result', () => {
    const f = fixture();
    for (const params of [{ mode: 'mxc', success: true, error: null }, { mode: 'elevated', success: 'true', error: null },
      { mode: 'elevated', success: true }, { mode: 'elevated', success: false, error: {} }]) {
      f.service.receive(notificationToEvent('engine/windowsSandboxSetupCompleted', params), 4);
    }
    f.service.receive(notificationToEvent('engine/other', { mode: 'elevated', success: true, error: null }), 4);
    assert.deepEqual(f.pushes, []);
  });
  await h.test('runtime preparation is reachable through model control without an additional confirmation gate', async () => {
    const f = fixture();
    const service = new KlausControlService({ context: (_id, signal) => ({ sessionId: 'thread', unattended: false, signal,
      assertCurrent: () => {}, currentBrowserSessionId: () => null,
      dispatch: async (channel, params) => await f.invoke(channel, params) }), manual: async () => '', storedRows: () => ({}),
      threadTool: async () => null, navigate: async () => {}, preferencesChanged: () => {},
      quickInput: { shortcuts: () => [], card: () => ({}), show: async () => null, hide: async () => null, setShortcut: async () => {} } });
    try {
      const result = await service.execute('klaus_action', { key: 'runtime', action: 'startWindowsSandboxSetup', arguments: { mode: 'unelevated' } }, 'thread', new AbortController().signal);
      assert.equal(object(result).success, true);
      assert.deepEqual(f.calls, [{ method: 'engine/startWindowsSandboxSetup', params: { mode: 'unelevated' } }]);
    } finally { await service.close(); }
  });
  await h.test('the Windows configuration row uses the canonical key and only accepts exact levels or null', async () => {
    const calls: Array<{ method: string; params: Json }> = [];
    const settings = new EngineSettings(async (method, params) => { calls.push({ method, params }); return {}; });
    assert.equal(isEngineConfigRow(WINDOWS_SANDBOX_SETTING_KEY), true);
    for (const value of ['elevated', 'unelevated', 'mxc', null]) await settings.writeRow(WINDOWS_SANDBOX_SETTING_KEY, value);
    assert.deepEqual(calls, ['elevated', 'unelevated', 'mxc', null].map(value => ({ method: 'config/batchWrite', params: {
      edits: [{ keyPath: 'windows.sandbox', value, mergeStrategy: 'replace' }],
    } })));
    for (const value of ['', ' elevated ', 'on', 'disabled']) await assert.rejects(settings.writeRow(WINDOWS_SANDBOX_SETTING_KEY, value));
    await assert.rejects(settings.writeRow('klaus.reasoningSummary', null));
    assert.equal(calls.length, 4);
  });
  await h.test('Windows configuration reads preserve all levels and the unset state', async () => {
    for (const value of ['elevated', 'unelevated', 'mxc', null]) {
      const settings = new EngineSettings(async (method, params) => {
        assert.equal(method, 'config/read'); assert.deepEqual(params, {});
        return { values: { windows: { sandbox: value } } };
      });
      assert.equal(await settings.row(WINDOWS_SANDBOX_SETTING_KEY), value);
    }
  });
  await h.test('existing settings IPC writes and clears Windows configuration separately and fences live bindings', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.windows-runtime-'));
    try {
      const state = new HostState(), calls: Array<{ method: string; params: Json }> = [];
      const request = async (method: string, params: Json) => { calls.push({ method, params }); return {}; };
      const config = new SessionConfiguration({ state, configRoot: directory, request, log: () => {} });
      const registry = new ChannelRegistry();
      registerSettingsHandlers(registry, { configRoot: directory, request, onSettingsChanged: (key, scope) => config.settingsChanged(key, scope) });
      for (const value of ['elevated', null]) {
        state.rememberSession('thread', 'engine-thread', { cwd: directory, config: {} });
        const context: HandlerContext = { role: 'main', senderId: 1, channel: 'settings:kv:set', args: [{ key: WINDOWS_SANDBOX_SETTING_KEY, value }] };
        assert.deepEqual(await registry.lookup(context.channel)!(context), { ok: true });
        assert.equal(state.isStale('thread'), true);
      }
      assert.deepEqual(calls, ['elevated', null].map(value => ({ method: 'config/batchWrite', params: {
        edits: [{ keyPath: 'windows.sandbox', value, mergeStrategy: 'replace' }],
      } })));
      await assert.rejects(async () => registry.lookup('settings:kv:set')!({ role: 'main', senderId: 1, channel: 'settings:kv:set', args: [{ key: 'language', value: null }] }));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  process.exitCode = await h.finish(join(__dirname, 'windows-sandbox-setup-result.json'), 'windows-sandbox-setup');
})();
