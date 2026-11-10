import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { PageDebugger } from '../main/browser/cdp';
import type { BrowserManager, BrowserPage } from '../main/browser/manager';
import type { BrowserObject } from '../main/browser/types';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerBrowserHandlers } from '../main/ipc/handlers/browser';
import { Harness } from './harness';

const h = new Harness();

interface RecordedCall { method: string; params: BrowserObject; sessionId?: string }

/**
 * A page transport double whose debugger answers the initialization handshake
 * and records every command with its parameters and target session.
 */
function fakePage(): { page: PageDebugger; calls: RecordedCall[]; emit: (method: string, params: BrowserObject, sessionId?: string) => void; sent: (method: string) => RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const emitter = new EventEmitter();
  const contents = {
    debugger: {
      on: emitter.on.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
      isAttached: () => true,
      attach: () => {},
      detach: () => {},
      sendCommand: async (method: string, params: unknown, sessionId?: string) => {
        calls.push({ method, params: (params ?? {}) as BrowserObject, sessionId });
        if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'T1' } };
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F1' } } };
        return {};
      },
    },
    isDestroyed: () => false,
  } as unknown as WebContents;
  const page = new PageDebugger(contents);
  return {
    page,
    calls,
    emit: (method, params, sessionId) => { emitter.emit('message', {}, method, params, sessionId); },
    sent: method => calls.filter(call => call.method === method),
  };
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

h.test('a top-level device-metrics override is tracked and the takeover clear drops it once', async () => {
  const f = fakePage();
  await f.page.command('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.equal(f.page.hasEmulationOverride, true);
  await f.page.clearEmulationOverrides();
  assert.equal(f.page.hasEmulationOverride, false);
  assert.equal(f.sent('Emulation.clearDeviceMetricsOverride').length, 1);
  // A settled clear is a no-op: repeated user actions never re-send it.
  await f.page.clearEmulationOverrides();
  assert.equal(f.sent('Emulation.clearDeviceMetricsOverride').length, 1);
  f.page.dispose();
});

h.test('an operation-side reset drops the record so the takeover clear stays a no-op', async () => {
  const f = fakePage();
  await f.page.command('Emulation.setDeviceMetricsOverride', { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
  await f.page.command('Emulation.clearDeviceMetricsOverride');
  assert.equal(f.page.hasEmulationOverride, false);
  await f.page.clearEmulationOverrides();
  assert.equal(f.sent('Emulation.clearDeviceMetricsOverride').length, 1);
  f.page.dispose();
});

h.test('touch emulation is tracked while enabled and disabled by the takeover clear', async () => {
  const f = fakePage();
  await f.page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  assert.equal(f.page.hasEmulationOverride, true);
  await f.page.command('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  assert.equal(f.page.hasEmulationOverride, false);
  await f.page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await f.page.clearEmulationOverrides();
  const touch = f.sent('Emulation.setTouchEmulationEnabled');
  assert.deepEqual(touch[touch.length - 1]!.params, { enabled: false, maxTouchPoints: 1 });
  assert.equal(f.page.hasEmulationOverride, false);
  f.page.dispose();
});

h.test('frame-scoped emulation commands are not tracked as page state', async () => {
  const f = fakePage();
  f.emit('Target.attachedToTarget', { targetInfo: { targetId: 'child-target', type: 'iframe' }, sessionId: 'child-session' });
  await tick();
  await f.page.command('Emulation.setDeviceMetricsOverride', { width: 700, height: 900 }, 'child-target');
  assert.equal(f.page.hasEmulationOverride, false);
  await f.page.clearEmulationOverrides();
  assert.equal(f.sent('Emulation.clearDeviceMetricsOverride').length, 0);
  f.page.dispose();
});

h.test('user navigation surfaces restore the natural scale before navigating and stop does not', async () => {
  const order: string[] = [];
  const page = {
    view: { webContents: { stop: () => { order.push('stop'); } } },
    cdp: { clearEmulationOverrides: async () => { order.push('clear'); } },
  } as unknown as BrowserPage;
  const manager = {
    windowId: 9,
    conversationId: 'saved-session',
    ensurePage: async () => page,
    navigate: async () => { order.push('navigate'); },
    historyAction: async (_page: BrowserPage, action: string) => { order.push(`history:${action}`); },
    ok: () => ({ ok: true }),
  } as unknown as BrowserManager;
  const registry = new ChannelRegistry();
  registerBrowserHandlers(registry, { manager });
  const invoke = (channel: string, payload: BrowserObject = {}) => {
    const handler = registry.lookup(channel); assert(handler);
    return handler({ role: 'main', senderId: 9, channel, args: [payload] });
  };
  await invoke('browser-use:navigate', { url: 'https://example.invalid' });
  assert.deepEqual(order, ['clear', 'navigate']);
  for (const action of ['back', 'forward', 'reload']) {
    order.length = 0;
    await invoke(`browser-use:${action}`);
    assert.deepEqual(order, ['clear', `history:${action}`]);
  }
  order.length = 0;
  await invoke('browser-use:stop');
  assert.deepEqual(order, ['stop']);
});

void h.finish(join(__dirname, 'browser-emulation-override-result.json'), 'browser-emulation-override').then(code => { process.exitCode = code; });
