import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Harness, assert, assertEqual, assertDeepEqual } from './harness';
import { performPageOperation, type PageOperationContext } from '../main/browser/page-operations';
import { BrowserError, type BrowserObject } from '../main/browser/types';

const h = new Harness();
async function cancelled(work: () => Promise<unknown>): Promise<void> {
  let error: unknown;
  try { await work(); } catch (failure) { error = failure; }
  assert(error instanceof BrowserError && error.code === 'cancelled', 'the operation returns a structured cancellation');
}

h.test('input cancellation vectors prevent submission and release pressed keys', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-input-cancellation-vectors.json'), 'utf8')) as { keyCases: Array<{ name: string; action: string; cancelAt: string; events: string[] }> };
  for (const vector of vectors.keyCases) {
    const controller = new AbortController(), events: string[] = [];
    if (vector.cancelAt === 'before') controller.abort();
    const context = { signal: controller.signal, cdp: {
      evaluate: async () => null,
      command: async (_method: string, params: BrowserObject = {}) => {
        events.push(`${String(params.type)}:${String(params.key)}`);
        if (params.type === vector.cancelAt) controller.abort();
        return {};
      },
    } } as unknown as PageOperationContext;
    const fields: BrowserObject = vector.action === 'type' ? { text: 'abc', delayMs: 200, pressEnter: true } : { action: 'key', key: 'Enter' };
    await cancelled(() => performPageOperation(context, vector.action === 'type' ? 'type' : 'computer', fields));
    assertDeepEqual(events, vector.events, vector.name);
  }
});

h.test('a cancelled focus reply cannot start typing or clearing later', async () => {
  const controller = new AbortController(), commands: string[] = [];
  let finish!: (value: unknown) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const focus = new Promise<unknown>(resolve => { finish = resolve; });
  const context = { signal: controller.signal, cdp: {
    evaluate: async () => { started(); return focus; },
    command: async (method: string) => { commands.push(method); return {}; },
  } } as unknown as PageOperationContext;
  const pending = performPageOperation(context, 'type', { text: 'late text', clear: true, pressEnter: true });
  await entered;
  controller.abort();
  await cancelled(() => pending);
  finish(null);
  await new Promise(resolve => setImmediate(resolve));
  assertDeepEqual(commands, [], 'a late focus acknowledgement causes no further input');
});

h.test('a delayed key acknowledgement cannot keep a cancelled key pressed', async () => {
  const controller = new AbortController(), events: string[] = [];
  let finish!: (value: BrowserObject) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const keyDown = new Promise<BrowserObject>(resolve => { finish = resolve; });
  const context = { signal: controller.signal, cdp: {
    evaluate: async () => null,
    command: async (_method: string, params: BrowserObject = {}) => {
      events.push(`${String(params.type)}:${String(params.key)}`);
      if (params.type === 'keyDown') { started(); return keyDown; }
      return {};
    },
  } } as unknown as PageOperationContext;
  const pending = performPageOperation(context, 'type', { text: 'abc', delayMs: 200, pressEnter: true });
  await entered;
  controller.abort();
  await cancelled(() => pending);
  assertDeepEqual(events, ['keyDown:a', 'keyUp:a'], 'release is submitted before the delayed press acknowledgement');
  finish({});
  await new Promise(resolve => setImmediate(resolve));
  assertEqual(events.length, 2, 'a late reply cannot type or submit again');
});

h.test('cancellation during typing delay stops the next character', async () => {
  const controller = new AbortController(), events: string[] = [];
  const context = { signal: controller.signal, cdp: {
    evaluate: async () => null,
    command: async (_method: string, params: BrowserObject = {}) => {
      events.push(`${String(params.type)}:${String(params.key)}`);
      if (params.type === 'keyUp') setTimeout(() => controller.abort(), 5);
      return {};
    },
  } } as unknown as PageOperationContext;
  await cancelled(() => performPageOperation(context, 'computer', { action: 'type', text: 'abc', delayMs: 200 }));
  assertDeepEqual(events, ['keyDown:a', 'keyUp:a'], 'only the first character is delivered');
});

h.test('a rejected key press still releases its key without typing another character', async () => {
  const events: string[] = [];
  const context = { cdp: {
    evaluate: async () => null,
    command: async (_method: string, params: BrowserObject = {}) => {
      events.push(String(params.type));
      if (params.type === 'keyDown') throw new Error('synthetic transport failure');
      return {};
    },
  } } as unknown as PageOperationContext;
  let failed = false;
  try { await performPageOperation(context, 'type', { text: 'abc', delayMs: 1 }); } catch { failed = true; }
  assert(failed, 'the transport failure is retained');
  assertDeepEqual(events, ['keyDown', 'keyUp'], 'the pressed key is released on failure');
});

h.test('fixed waits and computer waits release immediately on cancellation', async () => {
  for (const operation of ['wait_for', 'computer']) {
    const controller = new AbortController();
    const context = { signal: controller.signal } as unknown as PageOperationContext;
    const started = Date.now();
    const pending = performPageOperation(context, operation, operation === 'wait_for' ? { ms: 120000 } : { action: 'wait', duration: 30 });
    controller.abort();
    await cancelled(() => pending);
    assert(Date.now() - started < 1000, 'cancellation does not wait for the requested duration');
  }
});

h.test('a cancelled network-idle probe removes listeners before a late reply', async () => {
  const controller = new AbortController();
  let finish!: (value: unknown) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const ready = new Promise<unknown>(resolve => { finish = resolve; });
  let listeners = 0, evaluations = 0;
  const context = { signal: controller.signal, cdp: {
    evaluate: async () => { evaluations++; started(); return ready; },
    onEvent: () => { listeners++; return () => { listeners--; }; },
  } } as unknown as PageOperationContext;
  const pending = performPageOperation(context, 'wait_for', { loadState: 'networkidle', timeoutMs: 120000 });
  await entered;
  controller.abort();
  await cancelled(() => pending);
  assertEqual(listeners, 0, 'network event listeners are removed on cancellation');
  finish('complete');
  await new Promise(resolve => setImmediate(resolve));
  assertEqual(evaluations, 1, 'a late probe cannot restart polling');
});

void h.finish(join(__dirname, 'browser-input-cancellation-result.json'), 'browser-input-cancellation').then(code => { process.exitCode = code; });
