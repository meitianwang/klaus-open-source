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

test('navigation interception can be installed before the popup renderer becomes ready', async () => {
  let rendererReady = false;
  const fake = nativeTransport(async (method): Promise<BrowserObject> => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'popup-target' } };
    if (!rendererReady && ['Runtime.enable', 'Network.enable', 'Page.getFrameTree'].includes(method)) throw new Error('Renderer is waiting for the original navigation');
    return {};
  });
  const page = new PageDebugger(fake.transport);
  await page.prepareNavigation();
  await page.navigationCommand('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
  assert.deepEqual(fake.calls.map(call => call.method), ['Target.getTargetInfo', 'Page.enable', 'Fetch.enable']);
  rendererReady = true;
  await page.initialize();
  assert.equal(fake.calls.filter(call => call.method === 'Target.getTargetInfo').length, 1);
  assert.ok(fake.calls.some(call => call.method === 'Runtime.enable'));
  page.dispose();
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

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('PageDebugger does not disable focus emulation when a new activity starts during teardown', async () => {
  const focus: Array<{ enabled: boolean; resolve: () => void }> = [];
  const fake = nativeTransport(async (method, params): Promise<BrowserObject> => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'race-target' } } as BrowserObject;
    if (method === 'Emulation.setFocusEmulationEnabled') {
      let resolve!: () => void;
      const ready = new Promise<void>(done => { resolve = done; });
      focus.push({ enabled: params?.enabled === true, resolve });
      return ready.then(() => ({} as BrowserObject));
    }
    if (method === 'Runtime.evaluate') return { result: { value: null } } as BrowserObject;
    return {} as BrowserObject;
  });
  const page = new PageDebugger(fake.transport);
  let second: Promise<void> | undefined;
  const startSecond = (): void => { second = page.activity(async () => {}); };
  const first = page.activity(async () => {
    // Reach the teardown yield only after the first activity's work resolves.
    queueMicrotask(() => queueMicrotask(startSecond));
  });

  await flush();
  assert.equal(focus.length, 1);
  assert.equal(focus[0]!.enabled, true);
  focus[0]!.resolve();
  await flush();

  assert.equal(focus.length, 2, 'the new activity must start while the old teardown is yielding');
  assert.equal(focus[1]!.enabled, true);
  assert.equal(focus.filter(entry => !entry.enabled).length, 0, 'old teardown must not send a disable after the new activity starts');
  focus[1]!.resolve();
  await flush();

  assert.equal(focus.length, 3);
  assert.equal(focus[2]!.enabled, false);
  focus[2]!.resolve();
  await flush();
  assert.ok(second);
  await Promise.all([first, second]);
  page.dispose();
});

test('PageDebugger releases a lease that resolves after dispose', async () => {
  let resolveAcquire!: (lease: { release(): void }) => void;
  const acquire = new Promise<{ release(): void }>(resolve => { resolveAcquire = resolve; });
  const debug = fakeDebugger(async (method) => method === 'Target.getTargetInfo'
    ? { targetInfo: { targetId: 'disposed-target' } } as BrowserObject
    : {} as BrowserObject);
  const transport: PageTransport = {
    debugger: debug.channel,
    isDestroyed: () => false,
    acquireActivity: () => acquire,
  };
  const page = new PageDebugger(transport);
  let releases = 0;
  const activity = page.activity(async () => {});
  await flush();
  page.dispose();
  resolveAcquire({ release: () => { releases += 1; } });
  await activity;
  assert.equal(releases, 1, 'a lease acquired after dispose must be released immediately');
});

test('ElectronPageTransport makes acquisition failures visible and keeps accounting correct', () => {
  let failing = true;
  let throttling = true;
  const debug = fakeDebugger(async () => ({} as BrowserObject));
  const contents = {
    debugger: debug.channel,
    isDestroyed: () => false,
    getBackgroundThrottling: () => {
      if (failing) throw new Error('synthetic throttling read failure');
      return throttling;
    },
    setBackgroundThrottling: (value: boolean) => { throttling = value; },
    capturePage: async () => ({ isEmpty: () => false, toJPEG: () => Buffer.from(''), toPNG: () => Buffer.from('') }),
    printToPDF: async () => Buffer.from(''),
  } as unknown as WebContents;
  const transport = new ElectronPageTransport(contents);
  assert.throws(() => transport.acquireActivity(), /synthetic throttling read failure/u);
  failing = false;
  const lease = transport.acquireActivity();
  assert.equal(throttling, false);
  lease.release();
  assert.equal(throttling, true);
});

test('PageDebugger contains synchronous lease release failures during dispose and late acquire', async () => {
  let releases = 0;
  let finishWork!: () => void;
  const work = new Promise<void>(resolve => { finishWork = resolve; });
  const activeDebug = fakeDebugger(async (method) => method === 'Target.getTargetInfo'
    ? { targetInfo: { targetId: 'sync-release-active' } } as BrowserObject
    : {} as BrowserObject);
  const activeTransport: PageTransport = {
    debugger: activeDebug.channel,
    isDestroyed: () => false,
    acquireActivity: () => ({
      release: () => {
        releases += 1;
        throw new Error('synchronous release failure');
      },
    }),
  };
  const activePage = new PageDebugger(activeTransport);
  const activeActivity = activePage.activity(async () => { await work; });
  await flush();
  assert.doesNotThrow(() => activePage.dispose(), 'dispose must contain a synchronous release failure');
  finishWork();
  await activeActivity;
  assert.equal(releases, 1, 'dispose attempts the active lease once');

  let resolveAcquire!: (lease: { release(): void }) => void;
  const acquire = new Promise<{ release(): void }>(resolve => { resolveAcquire = resolve; });
  let lateReleases = 0;
  const lateDebug = fakeDebugger(async (method) => method === 'Target.getTargetInfo'
    ? { targetInfo: { targetId: 'sync-release-late' } } as BrowserObject
    : {} as BrowserObject);
  const lateTransport: PageTransport = {
    debugger: lateDebug.channel,
    isDestroyed: () => false,
    acquireActivity: () => acquire,
  };
  const latePage = new PageDebugger(lateTransport);
  const lateActivity = latePage.activity(async () => {});
  await flush();
  latePage.dispose();
  resolveAcquire({
    release: () => {
      lateReleases += 1;
      throw new Error('late synchronous release failure');
    },
  });
  await lateActivity;
  assert.equal(lateReleases, 1, 'a late lease release is attempted once and contained');
});
