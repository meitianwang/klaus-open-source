import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebContents } from 'electron';
import { PageDebugger } from '../main/browser/cdp';
import { ElectronPageTransport, type PageDebuggerChannel, type PageTransport } from '../main/browser/page-transport';
import type { BrowserObject } from '../main/browser/types';

function fakeDebugger(send: (method: string, params?: BrowserObject, sessionId?: string) => Promise<BrowserObject>) {
  const events = new EventEmitter();
  const calls: Array<{ method: string; params?: BrowserObject; sessionId?: string }> = [];
  const channel: PageDebuggerChannel = {
    on: (event, listener) => events.on(event, listener),
    removeListener: (event, listener) => events.removeListener(event, listener),
    isAttached: () => true,
    attach: () => {},
    sendCommand: async (method, params, sessionId) => {
      calls.push({ method, params, sessionId });
      return send(method, params, sessionId);
    },
    detach: () => {},
  };
  return { channel, calls, events };
}

function fakeContents(send: (method: string, params?: BrowserObject, sessionId?: string) => Promise<BrowserObject>) {
  const { channel, calls, events } = fakeDebugger(send);
  const state = { throttling: true, captures: 0, pdfs: 0 };
  const contents = {
    debugger: channel,
    isDestroyed: () => false,
    getBackgroundThrottling: () => state.throttling,
    setBackgroundThrottling: (value: boolean) => { state.throttling = value; },
    capturePage: async () => {
      state.captures += 1;
      return { isEmpty: () => false, toJPEG: (quality: number) => Buffer.from(`jpeg:${quality}`), toPNG: () => Buffer.from('png') };
    },
    printToPDF: async () => { state.pdfs += 1; return Buffer.from('pdf'); },
  } as unknown as WebContents;
  return { contents, calls, events, state };
}

function nativeTransport(send: (method: string, params?: BrowserObject, sessionId?: string) => Promise<BrowserObject>) {
  const { channel, calls, events } = fakeDebugger(send);
  const activity = { acquired: 0, released: 0 };
  const transport: PageTransport = {
    debugger: channel,
    isDestroyed: () => false,
    acquireActivity: () => {
      activity.acquired += 1;
      return { release: () => { activity.released += 1; } };
    },
  };
  return { transport, calls, events, activity };
}

const targetInfo = async (method: string): Promise<BrowserObject> => method === 'Target.getTargetInfo'
  ? { targetInfo: { targetId: method === 'Target.getTargetInfo' ? 'target-1' : '' } }
  : {};

test('ElectronPageTransport keeps the existing throttling and capture behavior', async () => {
  const fake = fakeContents(targetInfo);
  const transport = new ElectronPageTransport(fake.contents);
  const lease = transport.acquireActivity();
  assert.equal(fake.state.throttling, false);
  await lease.release();
  assert.equal(fake.state.throttling, true);

  const screenshot = await transport.captureViewport('jpeg', 80);
  assert.equal(screenshot, Buffer.from('jpeg:80').toString('base64'));
  assert.equal(fake.state.captures, 1);
  assert.equal((await transport.printToPDF()).toString(), 'pdf');
  assert.equal(fake.state.pdfs, 1);
});

test('PageDebugger uses CDP capture and PDF when the transport has no native providers', async () => {
  const fake = nativeTransport(async (method): Promise<BrowserObject> => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'native-target' } } as BrowserObject;
    if (method === 'Page.captureScreenshot') return { data: 'ZmFrZS1zaG90' } as BrowserObject;
    if (method === 'Page.printToPDF') return { data: 'ZmFrZS1wZGY=' } as BrowserObject;
    return {} as BrowserObject;
  });
  const page = new PageDebugger(fake.transport);
  const shot = await page.screenshot();
  assert.equal(shot.data, 'ZmFrZS1zaG90');
  assert(fake.calls.some(call => call.method === 'Page.captureScreenshot'));
  const pdf = await page.printToPDF();
  assert.equal(pdf.data, 'ZmFrZS1wZGY=');
  assert(fake.calls.some(call => call.method === 'Page.printToPDF'));
  page.dispose();
});

test('PageDebugger acquires and releases the transport activity lease', async () => {
  const fake = nativeTransport(targetInfo);
  const page = new PageDebugger(fake.transport);
  await page.activity(async () => {
    assert.equal(fake.activity.acquired, 1);
    assert.equal(fake.activity.released, 0);
  });
  assert.equal(fake.activity.released, 1);
  page.dispose();
});
