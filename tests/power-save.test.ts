import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { powerSaveRequest, type PowerSaveContext, type PowerSaveRequest } from '../contracts/power-save';
import { PowerSaveController, PowerSaveSettings, type CronPowerBlocker } from '../main/services/cron-power';
import { HostState } from '../main/services/host-state';
import { AgentTaskTracker } from '../main/sessions/agent-tasks';
import { MobileRelay } from '../main/services/mobile/relay';
import { MobileSettingsStore } from '../main/services/mobile/settings';
import { mobileFixture } from './mobile-fixture';
import { kvSet, withSettingsDb } from '../main/services/settings';
import { vectorPath } from '../main/paths';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const h = new Harness(), roots: string[] = [];
const vectors = JSON.parse(readFileSync(vectorPath('power-save-vectors.json'), 'utf8'));
const none: PowerSaveRequest = { shouldBlock: false, keepRemoteControlAwakeWhilePluggedIn: false, preventDisplaySleep: false };
function fixture() {
  let next = 0, failStart = false, failStop = false, failQuery = false;
  const active = new Map<number, string>(), calls: string[] = [], errors: unknown[] = [];
  class Monitor extends EventEmitter { battery = false; isOnBatteryPower(): boolean { if (failQuery) throw new Error('query failed'); return this.battery; } }
  const monitor = new Monitor();
  const blocker: CronPowerBlocker = {
    start: type => { if (failStart) throw new Error('start failed'); active.set(++next, type); calls.push('start:' + type); return next; },
    stop: id => { if (failStop) throw new Error('stop failed'); active.delete(id); calls.push('stop:' + id); },
    isStarted: id => active.has(id),
  };
  return { monitor, active, calls, errors, controller: new PowerSaveController(blocker, monitor, error => errors.push(error)),
    failures: (start: boolean, stop = false, query = false) => { failStart = start; failStop = stop; failQuery = query; } };
}
function root(): string { const value = mkdtempSync(join(tmpdir(), 'klaus-power-')); roots.push(value); return value; }

h.test('policy cases follow the committed lifecycle contract', () => {
  for (const row of vectors.policyCases) {
    const context: PowerSaveContext = { localExecutionAllowed: true, hasActiveLocalConversation: row.active, remoteControlEnabled: row.remote, realtimeVoicePhase: row.voice };
    const result = powerSaveRequest({ preventSleepWhileRunning: row.task, keepRemoteControlAwakeWhilePluggedIn: true }, context);
    assertDeepEqual([result.shouldBlock, result.keepRemoteControlAwakeWhilePluggedIn, result.preventDisplaySleep], row.expected, row.name);
    const denied = powerSaveRequest({ preventSleepWhileRunning: true, keepRemoteControlAwakeWhilePluggedIn: true }, { ...context, localExecutionAllowed: false });
    assertEqual(denied.shouldBlock, false, 'execution access only gates ordinary task requests');
  }
});
h.test('multiple owners retain independent requests and display has priority', () => {
  const f = fixture(), ordinary = { ...none, shouldBlock: true };
  f.controller.update(1, ordinary); f.controller.update(1, ordinary); f.controller.update(2, ordinary);
  assertDeepEqual(f.calls, ['start:prevent-app-suspension'], 'one idempotent assertion');
  f.controller.release(1); assertEqual(f.active.size, 1, 'other owner remains');
  f.controller.update(3, { ...none, preventDisplaySleep: true });
  assertDeepEqual([...f.active.values()], ['prevent-display-sleep'], 'display priority');
  f.controller.release(3); assertDeepEqual([...f.active.values()], ['prevent-app-suspension'], 'downgrade retains ordinary demand');
  f.controller.release(2); assertEqual(f.active.size, 0, 'last owner releases'); f.controller.close();
});
h.test('remote access only holds on external power and task work still holds on battery', () => {
  const f = fixture(); f.monitor.battery = true;
  f.controller.update(1, { ...none, keepRemoteControlAwakeWhilePluggedIn: true }); assertEqual(f.active.size, 0, 'battery remote is inert');
  f.monitor.battery = false; f.monitor.emit('on-ac'); assertEqual(f.active.size, 1, 'plugging in acquires');
  f.monitor.battery = true; f.monitor.emit('on-battery'); assertEqual(f.active.size, 0, 'unplugging releases');
  f.controller.update(2, { ...none, shouldBlock: true }); assertEqual(f.active.size, 1, 'ordinary tasks work on battery');
  f.controller.update(3, { ...none, preventDisplaySleep: true }); assertDeepEqual([...f.active.values()], ['prevent-display-sleep'], 'voice remains independent');
  f.controller.close(); assertEqual(f.active.size, 0, 'shutdown releases');
  assertEqual(f.monitor.listenerCount('on-ac') + f.monitor.listenerCount('on-battery'), 0, 'power listeners removed');
});
h.test('operating-system assertion failures remain retryable and teardown does not query power', async () => {
  const f = fixture(); f.failures(true);
  await assertRejects(async () => f.controller.update(1, { ...none, shouldBlock: true }), 'failed acquisition reported');
  f.failures(false); f.controller.update(1, { ...none, shouldBlock: true }); assertEqual(f.active.size, 1, 'next update retries');
  f.failures(false, true); f.controller.release(1); assertEqual(f.errors.length, 1, 'release failure logged');
  f.failures(false, false, true); f.controller.close(); assertEqual(f.active.size, 0, 'last release bypasses battery query');
  await assertRejects(async () => f.controller.update(1, none), 'closed owner cannot restart');
});
h.test('preferences default off and preserve explicit values over legacy migration', () => {
  const config = root(), settings = new PowerSaveSettings(config);
  assertDeepEqual(settings.get(), vectors.defaults, 'default preferences');
  kvSet(vectors.migration.legacyTaskKey, 'true', config);
  assertDeepEqual(settings.get(), { preventSleepWhileRunning: true, keepRemoteControlAwakeWhilePluggedIn: true }, 'legacy task value supplies missing remote setting');
  settings.set('keepRemoteControlAwakeWhilePluggedIn', false);
  settings.set('preventSleepWhileRunning', false); settings.set('preventSleepWhileRunning', true);
  assertDeepEqual(new PowerSaveSettings(config).get(), { preventSleepWhileRunning: true, keepRemoteControlAwakeWhilePluggedIn: false }, 'explicit remote survives restart and task changes');
});
h.test('rejected preference writes preserve the stored policy', async () => {
  const config = root(), settings = new PowerSaveSettings(config);
  withSettingsDb(config, db => db.exec("CREATE TRIGGER reject_power BEFORE INSERT ON settings WHEN NEW.key='power.prevent_sleep_while_running' BEGIN SELECT RAISE(ABORT,'fixture rejection'); END"));
  await assertRejects(async () => settings.set('preventSleepWhileRunning', true), 'storage error is reported');
  assertDeepEqual(settings.get(), vectors.defaults, 'failed write has no saved effect');
});
h.test('engine connection loss publishes the idle lifecycle before observers read it', () => {
  const state = new HostState(), observations: string[][] = [];
  state.onTurnRunningChange = () => observations.push(state.runningSessions());
  state.markTurnRunning('local-task', 'turn'); state.invalidateConnection();
  assertDeepEqual(observations, [['local-task'], []], 'active then empty snapshot');
  assert(!state.isWorking('local-task'), 'lost connection no longer holds activity');
});
h.test('independent child turns remain active and idle persistent children release their demand', () => {
  const tracker = new AgentTaskTracker(); let changes = 0; tracker.onChanged = () => changes++;
  tracker.observe({ type: 'productEvent', method: 'item/completed', params: { sessionId: 'engine-parent', item: {
    type: 'tool_call', toolName: 'task', id: 'call', status: 'completed', arguments: { persistent: true }, result: { agentId: 'child' },
  } } }, () => 'parent');
  assertDeepEqual(tracker.activeConversations(), [{ parentId: 'parent', id: 'child' }], 'child owns independent active status');
  const child = (type: string) => tracker.observe({ type: 'rawSessionEvent', params: { sessionId: 'engine-parent', event: {
    subagentEvent: { agentId: 'child', event: { type, stopReason: 'completed' } },
  } } }, () => 'parent');
  child('turn.completed'); assertDeepEqual(tracker.activeConversations(), [], 'idle persistent child does not hold a lock');
  assertEqual(tracker.presentation('parent').tasks.call && (tracker.presentation('parent').tasks.call as Record<string, unknown>).status, 'running', 'presentation still lists persistent child');
  child('turn.started'); assertEqual(tracker.activeConversations().length, 1, 'next child turn reacquires demand');
  tracker.forget('parent'); assertDeepEqual(tracker.activeConversations(), [], 'removed child cannot retain demand');
  assertEqual(changes, 4, 'each lifecycle change publishes context');
});
h.test('authoritative child snapshots remove running aliases after canonical identity convergence', () => {
  const tracker = new AgentTaskTracker();
  tracker.reconcile('parent', { child: { agentId: 'child', status: 'running' } });
  assertEqual(tracker.activeConversations().length, 1, 'early alias active');
  tracker.reconcile('parent', { call: { agentId: 'child', status: 'completed' } });
  assertDeepEqual(tracker.activeConversations(), [], 'obsolete running alias removed');
  assertDeepEqual(Object.keys(tracker.presentation('parent').tasks), ['call'], 'exact authoritative membership');
});
h.test('remote sleep availability follows the live endpoint without requiring an attached phone', async () => {
  let changes = 0;
  const f = await mobileFixture({ connectionChanged: () => changes++ });
  try {
    assertEqual(f.bridge.remoteControlKeepsAwake(), false, 'disabled endpoint');
    f.account({ token: 'fixture-power-token', userId: 'fixture-power-user' }); await f.enable();
    assertEqual(f.bridge.remoteControlKeepsAwake(), true, 'connecting or connected endpoint');
    await waitFor(() => f.relays.some(relay => relay.frames.some(row => row.type === 'desktop_hello')), 2000, 'registered relay');
    assertEqual(f.bridge.remoteControlKeepsAwake(), true, 'no phone is attached');
    await f.bridge.set({ enabled: false }); assertEqual(f.bridge.remoteControlKeepsAwake(), false, 'disabled access releases remote demand');
    assert(changes > 1, 'connection lifecycle publishes changes');
  } finally { await f.close(); }
});
h.test('failed remote enable suppresses retry demand until a connection succeeds', async () => {
  const f = await mobileFixture(); let release: () => void = () => {}, requests = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const relay = new MobileRelay({ ...new MobileSettingsStore(f.root, f.relayURL, {}).read(), enabled: true, localBaseURL: 'http://127.0.0.1:1' }, {
    configRoot: f.root, account: () => ({ token: 'fixture-power-token', userId: 'fixture-power-user' }),
    machineIdentifier: async () => 'fixture-power-machine', retryDelaysMs: [5],
    fetch: async (input, init) => { requests++; if (requests === 1) throw new Error('fixture registration error'); if (requests === 2) await blocked; return fetch(input, init); },
  });
  try {
    relay.start(); await waitFor(() => requests === 2, 2000, 'retry registration pending');
    assertDeepEqual(relay.powerStatus(), { status: 'connecting', enableFailed: true }, 'failed-enable suppression survives retry');
    release(); await waitFor(() => relay.status().connected, 2000, 'successful reconnect');
    assertDeepEqual(relay.powerStatus(), { status: 'connected', enableFailed: false }, 'success clears suppression');
  } finally { release(); await relay.close(); await f.close(); }
});
void (async () => {
  const failed = await h.finish(join(__dirname, 'power-save-result.json'), 'power-save');
  for (const config of roots) rmSync(config, { recursive: true, force: true });
  process.exit(failed);
})();
