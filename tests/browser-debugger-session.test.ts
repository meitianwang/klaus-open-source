import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import { PageDebugger } from '../main/browser/cdp';
import { ChromePageDebugger } from '../main/browser/chrome-cdp';
import type { ChromeRelay } from '../main/browser/chrome-relay';
import type { BrowserObject } from '../main/browser/types';

function fakeContents(send?: (method: string, sessionId?: string) => Promise<BrowserObject>): { contents: WebContents; calls: Array<{ method: string; sessionId?: string }>; emit: (method: string, params: BrowserObject, sessionId?: string) => void } {
  const emitter = new EventEmitter();
  const calls: Array<{ method: string; sessionId?: string }> = [];
  const contents = {
    debugger: {
      on: emitter.on.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
      isAttached: () => true,
      attach: () => {},
      detach: () => {},
      sendCommand: async (method: string, _params: unknown, sessionId?: string) => { calls.push({ method, sessionId }); return send ? send(method, sessionId) : {}; },
    },
    isDestroyed: () => false,
  } as unknown as WebContents;
  return {
    contents,
    calls,
    emit: (method, params, sessionId) => emitter.emit('message', {}, method, params, sessionId),
  };
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('PageDebugger drops late events from an unknown child session', async () => {
  const fake = fakeContents();
  const page = new PageDebugger(fake.contents);
  fake.emit('Target.attachedToTarget', { targetInfo: { targetId: 'child-target', type: 'iframe' }, sessionId: 'child-session' });
  await tick();
  const childMethods = fake.calls.filter(call => call.sessionId === 'child-session').map(call => call.method);
  for (const method of ['Target.setAutoAttach', 'Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) {
    assert(childMethods.includes(method), method + ' is sent to the owned child session');
  }
  fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'known-child' }] }, 'child-session');
  fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'late-child' }] }, 'late-session');
  fake.emit('Target.detachedFromTarget', { sessionId: 'child-session' });
  fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'after-detach' }] }, 'child-session');
  fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'root' }] });
  assert.deepEqual(page.console.map(entry => entry.text), ['known-child', 'root']);
  page.dispose();
});

test('ChromePageDebugger drops late events from an unknown child session', async () => {
  const calls: Array<{ method: string; params: BrowserObject }> = [];
  const relay = { request: async (method: string, params: BrowserObject) => { calls.push({ method, params }); return {}; } } as unknown as ChromeRelay;
  const page = new ChromePageDebugger(relay, 'session', 7);
  const notify = (method: string, params: BrowserObject, sessionId?: string): void => {
    page.acceptNotification({ method: 'onCDPEvent', params: { source: { tabId: 7, ...(sessionId ? { sessionId } : {}) }, method, params } });
  };
  notify('Target.attachedToTarget', { targetInfo: { targetId: 'child-target', type: 'iframe' }, sessionId: 'child-session' });
  await tick();
  const childMethods = calls.filter(call => call.method === 'executeCdp' && call.params.sessionId === 'child-session').map(call => String(call.params.method));
  for (const method of ['Target.setAutoAttach', 'Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'Fetch.enable']) {
    assert(childMethods.includes(method), method + ' is sent to the owned child target');
  }
  notify('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'known-child' }] }, 'child-session');
  notify('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'late-child' }] }, 'late-session');
  notify('Target.detachedFromTarget', { sessionId: 'child-session' });
  notify('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'after-detach' }] }, 'child-session');
  notify('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'root' }] });
  assert.deepEqual(page.console.map(entry => entry.text), ['known-child', 'root']);
  await page.dispose();
});

function sessionHarness(backend: 'native' | 'chrome', send: (method: string, sessionId?: string) => Promise<BrowserObject>) {
  if (backend === 'native') {
    const fake = fakeContents(send);
    return { page: new PageDebugger(fake.contents), notify: fake.emit };
  }
  const relay = { request: async (method: string, params: BrowserObject) => send(String(params.method ?? method), typeof params.sessionId === 'string' ? params.sessionId : undefined) } as unknown as ChromeRelay;
  const page = new ChromePageDebugger(relay, 'session', 7);
  const notify = (method: string, params: BrowserObject, sessionId?: string): void => {
    page.acceptNotification({ method: 'onCDPEvent', params: { source: { tabId: 7, ...(sessionId ? { sessionId } : {}) }, method, params } });
  };
  return { page, notify };
}

for (const backend of ['native', 'chrome'] as const) {
  test(`${backend} child initialization failure cannot remove a replacement session`, async () => {
    let rejectOld!: (error: Error) => void;
    const old = new Promise<BrowserObject>((_resolve, reject) => { rejectOld = reject; });
    const { page, notify } = sessionHarness(backend, async (method, sessionId) => method === 'Target.setAutoAttach' && sessionId === 'old-session' ? old : {});
    notify('Target.attachedToTarget', { targetInfo: { targetId: 'child', type: 'iframe' }, sessionId: 'old-session' });
    await tick();
    notify('Target.detachedFromTarget', { sessionId: 'old-session' });
    notify('Target.attachedToTarget', { targetInfo: { targetId: 'child', type: 'iframe' }, sessionId: 'new-session' });
    await tick();
    rejectOld(new Error('synthetic delayed initialization failure'));
    await tick();
    assert.deepEqual(page.frameTargets(), ['child']);
    notify('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'replacement-child' }] }, 'new-session');
    assert.deepEqual(page.console.map(entry => entry.text), ['replacement-child']);
    await page.dispose();
  });

  test(`${backend} nested detach cleans its child after the parent session was removed`, async () => {
    const { page, notify } = sessionHarness(backend, async () => ({}));
    notify('Target.attachedToTarget', { targetInfo: { targetId: 'parent', type: 'iframe' }, sessionId: 'parent-session' });
    await tick();
    notify('Target.attachedToTarget', { targetInfo: { targetId: 'nested', type: 'iframe' }, sessionId: 'nested-session' }, 'parent-session');
    await tick();
    notify('Target.detachedFromTarget', { sessionId: 'parent-session' });
    notify('Target.detachedFromTarget', { sessionId: 'nested-session' }, 'parent-session');
    assert.deepEqual(page.frameTargets(), []);
    notify('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'late-nested' }] }, 'nested-session');
    assert.deepEqual(page.console, []);
    await page.dispose();
  });
}

