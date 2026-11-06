import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { uploadFiles } from '../main/browser/file-upload';
import { performAdvancedPageOperation } from '../main/browser/page-advanced';
import type { BrowserCdp } from '../main/browser/page-operations';
import { BrowserError, type BrowserObject } from '../main/browser/types';

type EventListener = (method: string, params: BrowserObject, frame?: string) => void;
function transport(options: { chooser?: boolean; multiple?: boolean; observation?: 'empty' | 'detached' | 'unavailable'; rejection?: string } = {}) {
  const calls: Array<{ method: string; params: BrowserObject }> = [], listeners = new Set<EventListener>();
  let selected = false;
  const cdp = {
    command: async (method: string, params: BrowserObject = {}) => {
      calls.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { objectId: 'control' } };
      if (method === 'DOM.describeNode') {
        if (params.objectId === 'document') return { node: { nodeName: '#document', frameId: 'main', backendNodeId: 1 } };
        const file = !options.chooser || params.objectId === 'chosen';
        return { node: { nodeName: file ? 'INPUT' : 'BUTTON', backendNodeId: file ? 42 : 41, attributes: file ? ['type', 'file', ...(options.multiple ? ['multiple', ''] : [])] : [] } };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (String(params.functionDeclaration).includes('ownerDocument')) return { result: { objectId: 'document' } };
        if (options.observation === 'unavailable') throw new Error('Execution context was destroyed');
        return { result: { value: { connected: options.observation !== 'detached', files: selected && !options.observation ? [{ name: 'one.txt', size: 3, type: 'text/plain' }] : [] } } };
      }
      if (method === 'DOM.setFileInputFiles') {
        if (options.rejection) throw new Error(options.rejection);
        selected = true; return {};
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'chosen' } };
      return {};
    },
    onEvent: (listener: EventListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as BrowserCdp;
  return { cdp, calls, listeners, selected: () => selected,
    emit: (params: BrowserObject, frame?: string) => { for (const listener of listeners) listener('Page.fileChooserOpened', params, frame); } };
}

async function fixture(run: (path: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'klaus-upload-unit-'));
  const path = join(directory, 'one.txt'); await writeFile(path, 'one');
  try { await run(path, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function holdCommand(page: ReturnType<typeof transport>, matches: (method: string, params: BrowserObject) => boolean) {
  const entered = deferred<void>(), resume = deferred<void>(), original = page.cdp.command.bind(page.cdp);
  page.cdp.command = async (method, params = {}) => {
    const response = await original(method, params);
    if (matches(method, params)) { entered.resolve(); await resume.promise; }
    return response;
  };
  return { entered: entered.promise, resume: () => resume.resolve() };
}

const cancelled = (error: unknown): boolean => error instanceof BrowserError && error.code === 'cancelled';
function onlyCleanup(page: ReturnType<typeof transport>, from: number): void {
  assert(page.calls.slice(from).every(call => call.method === 'Runtime.releaseObject' || call.method === 'Page.setInterceptFileChooserDialog' && call.params.enabled === false), 'no business command starts after cancellation');
}

test('file selection uses a backend node and reports the acknowledged input observation', async () => fixture(async path => {
  const page = transport(); const result = await uploadFiles(page.cdp, { selector: '#file', files: [path] }, async () => {});
  assert.equal(result.acknowledged, true); assert.equal((result.observation as BrowserObject).state, 'attached');
  assert.deepEqual(page.calls.find(call => call.method === 'DOM.setFileInputFiles')?.params, { backendNodeId: 42, files: [path] });
  assert.deepEqual(result.files, [{ name: 'one.txt', size: 3, type: 'text/plain' }]); assert(page.selected());
  assert(page.calls.some(call => call.method === 'Runtime.releaseObject' && call.params.objectId === 'control'));
}));

for (const [observation, state] of [['empty', 'input-empty'], ['detached', 'input-detached'], ['unavailable', 'unavailable']] as const) {
  test('an acknowledged selection retains the ' + state + ' diagnostic after page handling', async () => fixture(async path => {
    const page = transport({ observation }); const result = await uploadFiles(page.cdp, { selector: '#file', files: [path] }, async () => {});
    assert(page.selected()); assert.equal(result.acknowledged, true); assert.equal((result.observation as BrowserObject).state, state);
    assert.equal(page.calls.filter(call => call.method === 'DOM.setFileInputFiles').length, 1);
  }));
}

test('a rejected browser command fails instead of converting empty readback into success', async () => fixture(async path => {
  const page = transport({ rejection: 'Not allowed' });
  await assert.rejects(uploadFiles(page.cdp, { files: [path] }, async () => {}), /Not allowed/);
  assert(!page.selected()); assert(!page.calls.some(call => call.method === 'Runtime.callFunctionOn'));
}));

test('local paths and multiple selection are validated before sending file data', async () => fixture(async (path, directory) => {
  for (const files of [[join(directory, 'missing')], [directory], ['relative.txt'], [path, path]]) {
    const page = transport(); await assert.rejects(uploadFiles(page.cdp, { files }, async () => {}));
    assert(!page.calls.some(call => call.method === 'DOM.setFileInputFiles'));
  }
}));

test('a chooser accepts only its document and CDP source and always removes interception', async () => fixture(async path => {
  const page = transport({ chooser: true });
  const result = await uploadFiles(page.cdp, { selector: '#choose', files: [path] }, async () => {
    page.emit({ backendNodeId: 99, frameId: 'main', mode: 'selectSingle' }, 'other-target');
    page.emit({ backendNodeId: 98, frameId: 'another-document', mode: 'selectSingle' });
    page.emit({ backendNodeId: 42, frameId: 'main', mode: 'selectSingle' });
  });
  assert.equal(result.via, 'file-chooser'); assert.equal(page.listeners.size, 0);
  assert.deepEqual(page.calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog').map(call => call.params.enabled), [true, false]);
  assert.equal(page.calls.find(call => call.method === 'DOM.resolveNode')?.params.backendNodeId, 42);
}));

test('a foreign-frame chooser cannot receive the requested files', async () => fixture(async path => {
  const page = transport({ chooser: true });
  await assert.rejects(uploadFiles(page.cdp, { files: [path], timeoutMs: 20 }, async () => {
    page.emit({ backendNodeId: 42, frameId: 'other', mode: 'selectSingle' });
  }), /No file chooser/);
  assert.equal(page.listeners.size, 0); assert(!page.selected());
  assert.deepEqual(page.calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog').map(call => call.params.enabled), [true, false]);
}));

test('a failed chooser activation releases the control and interception', async () => fixture(async path => {
  const page = transport({ chooser: true });
  await assert.rejects(uploadFiles(page.cdp, { files: [path] }, async () => { throw new Error('Control detached'); }), /Control detached/);
  assert.equal(page.listeners.size, 0); assert(!page.selected());
  assert(page.calls.some(call => call.method === 'Runtime.releaseObject' && call.params.objectId === 'control'));
  assert.equal(page.calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog').at(-1)?.params.enabled, false);
}));

test('an owned out-of-process frame can address its file input directly', async () => fixture(async path => {
  const page = transport(); Object.assign(page.cdp, { captureScope: { root: page.cdp, frame: 'child-target' } });
  assert.equal((await uploadFiles(page.cdp, { files: [path] }, async () => {})).acknowledged, true);
  assert(page.selected());
}));

test('an out-of-process chooser has an explicit error without losing direct-input support', async () => fixture(async path => {
  const page = transport({ chooser: true }); Object.assign(page.cdp, { captureScope: { root: page.cdp, frame: 'child-target' } });
  await assert.rejects(uploadFiles(page.cdp, { files: [path] }, async () => {}), /File choosers in out-of-process frames are not supported/);
  assert(!page.selected()); assert.equal(page.listeners.size, 0);
}));

test('the advanced operation forwards cancellation before starting file selection', async () => fixture(async path => {
  const page = transport(), controller = new AbortController(); controller.abort();
  await assert.rejects(performAdvancedPageOperation({ cdp: page.cdp, signal: controller.signal, navigate: async () => {}, history: async () => {}, download: async () => ({}) }, 'file_upload', { files: [path] }, async () => ({})), cancelled);
  assert.equal(page.calls.length, 0);
}));

test('cancellation during local file inspection cannot start a browser command', async () => fixture(async path => {
  const page = transport(), controller = new AbortController();
  const pending = uploadFiles(page.cdp, { files: [path] }, async () => {}, controller.signal);
  queueMicrotask(() => controller.abort());
  await assert.rejects(pending, cancelled); assert.equal(page.calls.length, 0);
}));

for (const method of ['Runtime.evaluate', 'DOM.describeNode']) test('a late ' + method + ' reply cannot select files after cancellation', async () => fixture(async path => {
  const page = transport(), controller = new AbortController(), held = holdCommand(page, name => name === method);
  const pending = uploadFiles(page.cdp, { files: [path] }, async () => {}, controller.signal);
  await held.entered; const beforeAbort = page.calls.length; controller.abort(); held.resume();
  await assert.rejects(pending, cancelled);
  assert(!page.selected()); onlyCleanup(page, beforeAbort);
  assert(page.calls.some(call => call.method === 'Runtime.releaseObject' && call.params.objectId === 'control'), 'late runtime handle is released');
}));

test('cancelling a parked chooser rejects immediately and removes interception and listeners', async () => fixture(async path => {
  const page = transport({ chooser: true }), controller = new AbortController(), activated = deferred<void>();
  const pending = uploadFiles(page.cdp, { files: [path], timeoutMs: 10000 }, async () => { activated.resolve(); }, controller.signal);
  await activated.promise; const beforeAbort = page.calls.length; controller.abort();
  await assert.rejects(pending, cancelled);
  assert(!page.selected()); assert.equal(page.listeners.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  onlyCleanup(page, beforeAbort);
  assert.equal(page.calls.filter(call => call.method === 'Page.setInterceptFileChooserDialog').at(-1)?.params.enabled, false);
}));

test('a late interception acknowledgement cannot activate a chooser after cancellation', async () => fixture(async path => {
  const page = transport({ chooser: true }), controller = new AbortController();
  const held = holdCommand(page, (method, params) => method === 'Page.setInterceptFileChooserDialog' && params.enabled === true);
  let activated = false;
  const pending = uploadFiles(page.cdp, { files: [path] }, async () => { activated = true; }, controller.signal);
  await held.entered; const beforeAbort = page.calls.length; controller.abort(); held.resume();
  await assert.rejects(pending, cancelled);
  assert.equal(activated, false); assert.equal(page.listeners.size, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0); onlyCleanup(page, beforeAbort);
}));

test('a late chooser input handle is released without selecting files after cancellation', async () => fixture(async path => {
  const page = transport({ chooser: true }), controller = new AbortController(), held = holdCommand(page, method => method === 'DOM.resolveNode');
  const pending = uploadFiles(page.cdp, { files: [path] }, async () => { page.emit({ backendNodeId: 42, frameId: 'main', mode: 'selectSingle' }); }, controller.signal);
  await held.entered; const beforeAbort = page.calls.length; controller.abort(); held.resume();
  await assert.rejects(pending, cancelled);
  assert(!page.selected()); onlyCleanup(page, beforeAbort);
  assert(page.calls.some(call => call.method === 'Runtime.releaseObject' && call.params.objectId === 'chosen'));
}));

test('cancellation after an issued file command prevents any observation command', async () => fixture(async path => {
  const page = transport(), controller = new AbortController(), held = holdCommand(page, method => method === 'DOM.setFileInputFiles');
  const pending = uploadFiles(page.cdp, { files: [path] }, async () => {}, controller.signal);
  await held.entered; assert(page.selected(), 'the already-issued browser command cannot be undone');
  const beforeAbort = page.calls.length; controller.abort(); held.resume();
  await assert.rejects(pending, cancelled); onlyCleanup(page, beforeAbort);
  assert(!page.calls.some(call => call.method === 'Runtime.callFunctionOn'));
}));

test('readback cannot turn a cancellation error into an unavailable observation', async () => fixture(async path => {
  for (const rejection of [new BrowserError('cancelled', 'Readback cancelled'), { code: 'cancelled' }, { kind: 'cancelled' }, new DOMException('Readback aborted', 'AbortError')]) {
    const page = transport(), original = page.cdp.command.bind(page.cdp);
    page.cdp.command = async (method, params) => {
      if (method === 'Runtime.callFunctionOn') throw rejection;
      return original(method, params);
    };
    await assert.rejects(uploadFiles(page.cdp, { files: [path] }, async () => {}), error => error === rejection);
    assert(page.selected());
  }
}));

test('a late readback response cannot become a successful receipt after cancellation', async () => fixture(async path => {
  const page = transport(), controller = new AbortController(), held = holdCommand(page, method => method === 'Runtime.callFunctionOn');
  const pending = uploadFiles(page.cdp, { files: [path] }, async () => {}, controller.signal);
  await held.entered; const beforeAbort = page.calls.length; controller.abort(); held.resume();
  await assert.rejects(pending, cancelled);
  assert(page.selected()); onlyCleanup(page, beforeAbort);
}));
