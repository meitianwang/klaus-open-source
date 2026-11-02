import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import { PageDebugger } from '../main/browser/cdp';
import { ChromePageDebugger } from '../main/browser/chrome-cdp';
import type { ChromeRelay } from '../main/browser/chrome-relay';
import type { BrowserObject } from '../main/browser/types';

function fakeContents(): { contents: WebContents; calls: Array<{ method: string; sessionId?: string }>; emit: (method: string, params: BrowserObject, sessionId?: string) => void } {
  const emitter = new EventEmitter();
  const calls: Array<{ method: string; sessionId?: string }> = [];
  const contents = {
    debugger: {
      on: emitter.on.bind(emitter),
      removeListener: emitter.removeListener.bind(emitter),
      isAttached: () => true,
      attach: () => {},
      detach: () => {},
      sendCommand: async (method: string, _params: unknown, sessionId?: string) => { calls.push({ method, sessionId }); return {}; },
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
