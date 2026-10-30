import { describe, expect, test } from 'bun:test';
import { bootPowerSavePolicy, mountPowerSavePolicy, type PowerSaveBridge } from './power-save';
import { call } from '../../bridge/ipc';
import type { PowerSaveRequest, PowerSaveSnapshot } from '../../../contracts/power-save';

const idle: PowerSaveSnapshot = { revision: 0, platform: 'darwin', preferences: {
  preventSleepWhileRunning: true, keepRemoteControlAwakeWhilePluggedIn: false,
}, context: { localExecutionAllowed: true, hasActiveLocalConversation: false, remoteControlEnabled: false, realtimeVoicePhase: 'inactive' } };
const empty = { shouldBlock: false, keepRemoteControlAwakeWhilePluggedIn: false, preventDisplaySleep: false };
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function fixture() {
  let listener: ((value: PowerSaveSnapshot) => void) | undefined, resolve!: (value: PowerSaveSnapshot) => void, reject!: (error: unknown) => void;
  const sent: PowerSaveRequest[] = [], errors: unknown[] = [];
  let send: (request: PowerSaveRequest) => Promise<unknown> = async request => { sent.push(request); };
  const bridge: PowerSaveBridge = { snapshot: () => new Promise((done, fail) => { resolve = done; reject = fail; }), subscribe: callback => {
    listener = callback; return () => { listener = undefined; };
  }, setRequest: request => send(request) };
  const dispose = mountPowerSavePolicy(bridge, error => errors.push(error));
  return { sent, errors, dispose, initial: (value: PowerSaveSnapshot) => resolve(value),
    rejectInitial: (error: unknown) => reject(error),
    push: (value: PowerSaveSnapshot) => listener?.(value), send: (callback: typeof send) => { send = callback; } };
}
describe('power policy observer', () => {
  test('subscribes before reading and ignores a stale initial snapshot', async () => {
    const f = fixture();
    f.push({ ...idle, revision: 2, context: { ...idle.context, hasActiveLocalConversation: true } }); await flush();
    f.initial(idle); await flush();
    expect(f.sent).toEqual([{ ...empty, shouldBlock: true }]);
    await f.dispose(); expect(f.sent.at(-1)).toEqual(empty);
  });
  test('serializes in-flight updates and cleanup cannot be overtaken by an older request', async () => {
    const f = fixture(); let release!: () => void;
    f.send(async request => { f.sent.push(request); if (f.sent.length === 1) await new Promise<void>(done => { release = done; }); });
    f.push({ ...idle, revision: 1, context: { ...idle.context, hasActiveLocalConversation: true } }); await flush();
    f.push({ ...idle, revision: 2, context: { ...idle.context, realtimeVoicePhase: 'active' } });
    const closing = f.dispose(); release(); await closing;
    expect(f.sent).toEqual([{ ...empty, shouldBlock: true }, empty]);
    f.initial({ ...idle, revision: 20, context: { ...idle.context, hasActiveLocalConversation: true } }); await flush();
    expect(f.sent.at(-1)).toEqual(empty);
  });
  test('preference changes are reactive and display requests remain independent', async () => {
    const f = fixture(); f.initial({ ...idle, context: { ...idle.context, hasActiveLocalConversation: true } }); await flush();
    f.push({ ...idle, revision: 1, preferences: { preventSleepWhileRunning: false, keepRemoteControlAwakeWhilePluggedIn: true },
      context: { ...idle.context, hasActiveLocalConversation: true, remoteControlEnabled: true, realtimeVoicePhase: 'active' } }); await flush();
    expect(f.sent.at(-1)).toEqual({ shouldBlock: false, keepRemoteControlAwakeWhilePluggedIn: true, preventDisplaySleep: true });
    f.push({ ...idle, revision: 2 }); await flush(); expect(f.sent.at(-1)).toEqual(empty);
    await f.dispose();
  });
  test('a rejected assertion request does not poison subsequent policy updates', async () => {
    const f = fixture(); let failed = false;
    f.send(async request => { if (!failed) { failed = true; throw new Error('fixture request failed'); } f.sent.push(request); });
    f.initial(idle); await flush(); expect(f.errors).toHaveLength(1);
    f.push({ ...idle, revision: 1 }); await flush(); expect(f.sent).toEqual([empty]);
    await f.dispose();
  });
  test('disposing before initial hydration never reacquires a lock', async () => {
    const f = fixture(); await f.dispose();
    f.initial({ ...idle, context: { ...idle.context, hasActiveLocalConversation: true } }); await flush();
    expect(f.sent).toEqual([empty]);
  });
  test('a rejected snapshot after disposal does not report an obsolete failure', async () => {
    const f = fixture(); await f.dispose();
    f.rejectInitial(new Error('snapshot owner closed')); await flush();
    expect(f.errors).toEqual([]);
    expect(f.sent).toEqual([empty]);
  });
  test('a rejected in-flight update after disposal still releases without reporting', async () => {
    const f = fixture(); let reject!: (error: unknown) => void;
    f.send(async request => {
      f.sent.push(request);
      if (f.sent.length === 1) await new Promise<void>((_done, fail) => { reject = fail; });
    });
    f.initial({ ...idle, context: { ...idle.context, hasActiveLocalConversation: true } }); await flush();
    const closing = f.dispose(); reject(new Error('request owner closed')); await closing;
    expect(f.errors).toEqual([]);
    expect(f.sent).toEqual([{ ...empty, shouldBlock: true }, empty]);
  });
  test('a rejected final release is best effort during window teardown', async () => {
    const f = fixture(); f.send(async () => { throw new Error('transport closed'); });
    await f.dispose();
    expect(f.errors).toEqual([]);
  });
  test('an obsolete failed update does not report after a newer policy succeeds', async () => {
    const f = fixture(); let reject!: (error: unknown) => void;
    f.send(async request => {
      f.sent.push(request);
      if (f.sent.length === 1) await new Promise<void>((_done, fail) => { reject = fail; });
    });
    f.initial(idle); await flush();
    f.push({ ...idle, revision: 1, context: { ...idle.context, hasActiveLocalConversation: true } });
    reject(new Error('previous request failed')); await flush();
    expect(f.errors).toEqual([]);
    expect(f.sent).toEqual([empty, { ...empty, shouldBlock: true }]);
    await f.dispose();
  });
  test('shutdown refusals from the renderer transport do not show a power failure', async () => {
    const previousWindow = (globalThis as any).window;
    const errors: unknown[] = [];
    (globalThis as any).window = { __KLAUS_DESKTOP__: { core: { invoke: async () => {
      throw { ok: false, error: { code: 'APP_CLOSING', message: 'The application is shutting down' } };
    } } } };
    try {
      const dispose = mountPowerSavePolicy({
        snapshot: () => call('power:snapshot'), subscribe: () => () => {},
        setRequest: request => call('power:request:set', request),
      }, error => errors.push(error));
      await flush(); await dispose();
      expect(errors).toEqual([]);
    } finally { (globalThis as any).window = previousWindow; }
  });
  test('active request shutdown refusals are ignored while real failures stay retryable', async () => {
    const f = fixture();
    f.send(async () => { throw Object.assign(new Error('closing'), { data: { ok: false, error: { code: 'APP_CLOSING' } } }); });
    f.initial(idle); await flush(); expect(f.errors).toEqual([]);
    const failure = new Error('power blocker unavailable');
    f.send(async () => { throw failure; });
    f.push({ ...idle, revision: 1 }); await flush(); expect(f.errors).toEqual([failure]);
    f.send(async request => { f.sent.push(request); });
    f.push({ ...idle, revision: 2 }); await flush(); expect(f.sent).toEqual([empty]);
    await f.dispose();
  });
  test('active snapshot failures use the selected interface language', async () => {
    const previousWindow = (globalThis as any).window, previousError = console.error;
    const toasts: string[] = [], keys: string[] = [];
    let dispose!: () => void;
    (globalThis as any).window = {
      klaus: { powerSave: { snapshot: async () => { throw new Error('snapshot unavailable'); },
        subscribe: () => () => {}, setRequest: async () => {} } },
      tt: (key: string) => { keys.push(key); return '无法更新防休眠状态'; },
      showToast: (message: string) => toasts.push(message),
      addEventListener: (_event: string, listener: () => void) => { dispose = listener; },
    };
    console.error = () => {};
    try {
      bootPowerSavePolicy(); await flush();
      expect(keys).toEqual(['power_update_failed']);
      expect(toasts).toEqual(['无法更新防休眠状态']);
      dispose(); await flush();
    } finally { (globalThis as any).window = previousWindow; console.error = previousError; }
  });
});
