import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserError } from '../main/browser/types';
import type { BrowserDownloadNetwork } from '../main/browser/native-downloads';
import type { PageDebuggerChannel } from '../main/browser/page-transport';
import {
  loadNativeBrowserBinding,
  NativePageTransport,
  NativeProfileDownloadNetwork,
  type NativeBrowserBinding,
  type NativeBrowserHandle,
  type NativeProfileRead,
  type NativeProfileRequestHandle,
} from '../main/browser/native-page';

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

test('native binding loader prepares the EventEmitter prototype and fails closed', () => {
  class FakeNativeBrowser {}
  const binding = {
    NativeBrowser: FakeNativeBrowser as unknown as NativeBrowserBinding['NativeBrowser'],
    create: async () => ({} as NativeBrowserHandle),
  };
  assert.equal(loadNativeBrowserBinding(() => binding), binding);
  assert.equal(Object.getPrototypeOf(FakeNativeBrowser.prototype), EventEmitter.prototype);
  assert.equal(loadNativeBrowserBinding(() => binding), binding);
  assert.throws(() => loadNativeBrowserBinding(() => undefined), (error: unknown) =>
    error instanceof BrowserError && error.code === 'unavailable');
  assert.throws(() => loadNativeBrowserBinding(() => ({ NativeBrowser: FakeNativeBrowser })), (error: unknown) =>
    error instanceof BrowserError && error.code === 'unavailable');
});

test('native browser events receive the prepended Electron event object', () => {
  class FakeNativeBrowser {}
  const binding = {
    NativeBrowser: FakeNativeBrowser as unknown as NativeBrowserBinding['NativeBrowser'],
    create: async () => ({} as NativeBrowserHandle),
  };
  loadNativeBrowserBinding(() => binding);
  const instance = new FakeNativeBrowser() as unknown as EventEmitter;
  const handle = instance as unknown as NativeBrowserHandle;
  const navigation: Array<{ event: unknown; url: string }> = [];
  handle.on('did-navigate', (event, url) => { navigation.push({ event, url }); });
  instance.emit('did-navigate', { sender: 'native' }, 'https://example.test/');
  assert.deepEqual(navigation, [{ event: { sender: 'native' }, url: 'https://example.test/' }]);

  const titles: Array<{ event: unknown; title: string }> = [];
  handle.on('page-title-updated', (event, title) => { titles.push({ event, title }); });
  instance.emit('page-title-updated', { sender: 'native' }, 'Document');
  assert.deepEqual(titles, [{ event: { sender: 'native' }, title: 'Document' }]);

  let loading = 0;
  handle.on('did-start-loading', event => { assert.ok(event); loading += 1; });
  instance.emit('did-start-loading', { sender: 'native' });
  assert.equal(loading, 1);
});

test('NativePageTransport exposes native activity and debugger only', () => {
  let begins = 0;
  let ends = 0;
  let destroyed = false;
  const debuggerChannel = {} as PageDebuggerChannel;
  const transport = new NativePageTransport({
    debugger: debuggerChannel,
    isDestroyed: () => destroyed,
    beginActivity: () => { begins += 1; },
    endActivity: () => { ends += 1; },
  });
  assert.equal(transport.debugger, debuggerChannel);
  const lease = transport.acquireActivity();
  assert.equal(begins, 1);
  lease.release();
  lease.release();
  assert.equal(ends, 1, 'the activity lease is idempotent');
  assert.equal(transport.isDestroyed(), false);
  destroyed = true;
  assert.equal(transport.isDestroyed(), true);
  assert.equal('captureViewport' in transport, false);
  assert.equal('printToPDF' in transport, false);
});

test('NativeProfileDownloadNetwork rejects unsupported init fields without starting a request', async () => {
  let starts = 0;
  const page: NativeProfileRequestHandle = {
    startRequest: async () => { starts += 1; return { url: '', status: 200, headers: [] }; },
    readRequest: async () => ({ done: true }),
    cancelRequest: () => {},
  };
  const network: BrowserDownloadNetwork = new NativeProfileDownloadNetwork(page, () => 'request-1');
  for (const init of [
    { method: 'POST' },
    { body: 'body' },
    { headers: { accept: 'text/plain' } },
    { redirect: 'follow' as const },
    { credentials: 'omit' as const },
    { cache: 'no-store' as const },
  ]) {
    await assert.rejects(network.fetch('https://example.test/file', init as RequestInit), BrowserError);
  }
  assert.equal(starts, 0);
});

test('NativeProfileDownloadNetwork streams one native chunk per pull', async () => {
  const started: Array<{ id: string; url: string }> = [];
  const cancels: string[] = [];
  const readResolvers: Array<(value: NativeProfileRead) => void> = [];
  const page: NativeProfileRequestHandle = {
    startRequest: async (id, url) => {
      started.push({ id, url });
      return { url, status: 200, headers: [['content-type', 'text/plain']] };
    },
    readRequest: () => new Promise(resolve => { readResolvers.push(resolve); }),
    cancelRequest: id => { cancels.push(id); },
  };
  const network = new NativeProfileDownloadNetwork(page, () => 'request-2');
  const controller = new AbortController();
  const response = await network.fetch('https://example.test/file', { credentials: 'include', redirect: 'manual', signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.deepEqual(started, [{ id: 'request-2', url: 'https://example.test/file' }]);
  assert.equal(readResolvers.length, 0, 'no read starts before the consumer pulls');
  assert.ok(response.body);
  const reader = response.body.getReader();
  const first = reader.read();
  await until(() => readResolvers.length === 1);
  const firstResolver = readResolvers.shift();
  assert.ok(firstResolver);
  firstResolver({ done: false, data: Buffer.from('hello').toString('base64') });
  const firstChunk = await first;
  assert.ok(firstChunk.value);
  assert.equal(Buffer.from(firstChunk.value).toString(), 'hello');
  assert.equal(readResolvers.length, 0, 'one chunk at a time without prefetch');
  const second = reader.read();
  await until(() => readResolvers.length === 1);
  const secondResolver = readResolvers.shift();
  assert.ok(secondResolver);
  secondResolver({ done: true });
  assert.equal((await second).done, true);
  assert.deepEqual(cancels, ['request-2']);
  controller.abort();
  assert.deepEqual(cancels, ['request-2'], 'abort listener removed after end');
});

test('NativeProfileDownloadNetwork returns redirect headers and releases immediately', async () => {
  const cancels: string[] = [];
  let reads = 0;
  const page: NativeProfileRequestHandle = {
    startRequest: async (_id, url) => ({ url, status: 302, headers: [['location', 'https://other.test/file']] }),
    readRequest: async () => { reads += 1; return { done: true }; },
    cancelRequest: id => { cancels.push(id); },
  };
  const network = new NativeProfileDownloadNetwork(page, () => 'request-3');
  const response = await network.fetch('https://example.test/start', { credentials: 'include', redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://other.test/file');
  assert.equal(response.body, null);
  assert.equal(reads, 0);
  assert.deepEqual(cancels, ['request-3']);
});

test('NativeProfileDownloadNetwork returns a null body for no-body statuses', async () => {
  for (const status of [204, 205, 304]) {
    const cancels: string[] = [];
    const page: NativeProfileRequestHandle = {
      startRequest: async (_id, url) => ({ url, status, headers: [] }),
      readRequest: async () => ({ done: true }),
      cancelRequest: id => { cancels.push(id); },
    };
    const network = new NativeProfileDownloadNetwork(page, () => `request-${status}`);
    const response = await network.fetch('https://example.test/file', { credentials: 'include', redirect: 'manual' });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.deepEqual(cancels, [`request-${status}`]);
  }
});

test('NativeProfileDownloadNetwork aborts before headers and cancels the request', async () => {
  const cancels: string[] = [];
  let rejectStart: ((error: Error) => void) | undefined;
  const page: NativeProfileRequestHandle = {
    startRequest: () => new Promise((_resolve, reject) => { rejectStart = reject; }),
    readRequest: async () => ({ done: true }),
    cancelRequest: id => {
      cancels.push(id);
      rejectStart?.(new Error('cancelled by native'));
    },
  };
  const controller = new AbortController();
  const network = new NativeProfileDownloadNetwork(page, () => 'request-4');
  const pending = network.fetch('https://example.test/file', { credentials: 'include', redirect: 'manual', signal: controller.signal });
  await Promise.resolve();
  assert.ok(rejectStart);
  controller.abort(new BrowserError('cancelled', 'headers aborted'));
  await assert.rejects(pending, /headers aborted/u);
  assert.deepEqual(cancels, ['request-4']);
});

test('NativeProfileDownloadNetwork aborts during a pull and cancels the request', async () => {
  const cancels: string[] = [];
  let resolveRead: ((value: NativeProfileRead) => void) | undefined;
  const page: NativeProfileRequestHandle = {
    startRequest: async (_id, url) => ({ url, status: 200, headers: [] }),
    readRequest: () => new Promise(resolve => { resolveRead = resolve; }),
    cancelRequest: id => { cancels.push(id); },
  };
  const controller = new AbortController();
  const network = new NativeProfileDownloadNetwork(page, () => 'request-5');
  const response = await network.fetch('https://example.test/file', { credentials: 'include', redirect: 'manual', signal: controller.signal });
  assert.ok(response.body);
  const reader = response.body.getReader();
  const read = reader.read();
  await until(() => resolveRead !== undefined);
  const lateResolve = resolveRead;
  assert.ok(lateResolve);
  controller.abort(new BrowserError('cancelled', 'body aborted'));
  await assert.rejects(read, /body aborted/u);
  assert.deepEqual(cancels, ['request-5']);
  lateResolve({ done: true });
  await Promise.resolve();
  assert.deepEqual(cancels, ['request-5'], 'late native completion does not cancel again');
});

test('NativeProfileDownloadNetwork cancels on a native read failure and consumer cancellation', async () => {
  const cancels: string[] = [];
  const page: NativeProfileRequestHandle = {
    startRequest: async (_id, url) => ({ url, status: 200, headers: [] }),
    readRequest: async () => { throw new Error('native read failed'); },
    cancelRequest: id => { cancels.push(id); },
  };
  const network = new NativeProfileDownloadNetwork(page, () => 'request-6');
  const response = await network.fetch('https://example.test/file', { credentials: 'include', redirect: 'manual' });
  assert.ok(response.body);
  await assert.rejects(response.body.getReader().read(), /native read failed/u);
  assert.deepEqual(cancels, ['request-6']);

  const second: NativeProfileRequestHandle = {
    startRequest: async (_id, url) => ({ url, status: 200, headers: [] }),
    readRequest: async () => ({ done: true }),
    cancelRequest: id => { cancels.push(id); },
  };
  const secondNetwork = new NativeProfileDownloadNetwork(second, () => 'request-7');
  const secondResponse = await secondNetwork.fetch('https://example.test/file', { credentials: 'include', redirect: 'manual' });
  await secondResponse.body?.cancel();
  assert.deepEqual(cancels, ['request-6', 'request-7']);
});
