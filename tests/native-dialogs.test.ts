import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageDebugger } from '../main/browser/cdp';
import type { BrowserObject } from '../main/browser/types';
import { BrowserError } from '../main/browser/types';
import { NativeDialogs, type NativeDialogPage } from '../main/browser/native-dialogs';

class FakePageDebugger {
  readonly commands: Array<{ method: string; params?: BrowserObject }> = [];
  private readonly listeners = new Set<(method: string, params: BrowserObject, frame?: string) => void>();

  onEvent(listener: (method: string, params: BrowserObject, frame?: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async command(method: string, params: BrowserObject = {}): Promise<BrowserObject> {
    this.commands.push({ method, params });
    return {};
  }

  emit(method: string, params: BrowserObject, frame?: string): void {
    for (const listener of [...this.listeners]) listener(method, params, frame);
  }

  get listenerCount(): number { return this.listeners.size; }
}

function makePage(handle: number): { page: NativeDialogPage; cdp: FakePageDebugger } {
  const cdp = new FakePageDebugger();
  return { page: { handle, cdp: cdp as unknown as PageDebugger }, cdp };
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

test('opening state records the CDP fields and answer uses Page.handleJavaScriptDialog', async () => {
  const { page, cdp } = makePage(1);
  const dialogs = new NativeDialogs();
  dialogs.bind(page);
  cdp.emit('Page.javascriptDialogOpening', {
    url: 'https://example.test/page',
    message: 'Name?',
    type: 'prompt',
    defaultPrompt: 'anonymous',
  });
  const state = dialogs.state(page);
  assert.ok(state);
  assert.equal(state.type, 'prompt');
  assert.equal(state.message, 'Name?');
  assert.equal(state.defaultPrompt, 'anonymous');
  assert.equal(state.url, 'https://example.test/page');
  assert.ok(state.id);

  const copy = dialogs.state(page);
  assert.ok(copy);
  copy.message = 'changed';
  assert.equal(dialogs.state(page)?.message, 'Name?', 'state returns a copy');

  await dialogs.answer(page, true, 'Klaus', state.id);
  const command = cdp.commands.at(-1);
  assert.ok(command);
  assert.equal(command.method, 'Page.handleJavaScriptDialog');
  assert.deepEqual(command.params, { accept: true, promptText: 'Klaus' });

  cdp.emit('Page.javascriptDialogClosed', { result: true, userInput: 'Klaus' });
  assert.equal(dialogs.state(page), null);
  dialogs.dispose();
});

test('confirm dismiss omits promptText and supports answering without an id', async () => {
  const { page, cdp } = makePage(2);
  const dialogs = new NativeDialogs();
  dialogs.bind(page);
  cdp.emit('Page.javascriptDialogOpening', {
    url: 'https://example.test/confirm',
    message: 'Continue?',
    type: 'confirm',
  });
  assert.ok(dialogs.state(page));
  await dialogs.answer(page, false, 'ignored');
  const command = cdp.commands.at(-1);
  assert.ok(command);
  assert.deepEqual(command.params, { accept: false });
  dialogs.dispose();
});

test('an old dialog id cannot answer a newly opened dialog', async () => {
  const { page, cdp } = makePage(3);
  const dialogs = new NativeDialogs();
  dialogs.bind(page);
  cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/a', message: 'A', type: 'alert' });
  const first = dialogs.state(page);
  assert.ok(first);
  cdp.emit('Page.javascriptDialogClosed', { result: true, userInput: '' });
  cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/b', message: 'B', type: 'confirm' });
  const second = dialogs.state(page);
  assert.ok(second);
  assert.notEqual(first.id, second.id);

  await assert.rejects(
    dialogs.answer(page, true, undefined, first.id),
    (error: unknown) => error instanceof BrowserError && error.code === 'stale_dialog',
  );
  assert.equal(dialogs.state(page)?.id, second.id, 'the new dialog remains current');
  await dialogs.answer(page, true, undefined, second.id);
  const command = cdp.commands.at(-1);
  assert.ok(command);
  assert.deepEqual(command.params, { accept: true });
  dialogs.dispose();
});

test('release removes state and the listener, and late events are ignored', async () => {
  const { page, cdp } = makePage(4);
  const dialogs = new NativeDialogs();
  dialogs.bind(page);
  cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/a', message: 'A', type: 'alert' });
  assert.ok(dialogs.state(page));
  dialogs.release(4);
  assert.equal(dialogs.state(page), null);
  assert.equal(cdp.listenerCount, 0);
  cdp.emit('Page.javascriptDialogClosed', { result: true, userInput: '' });
  cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/b', message: 'B', type: 'alert' });
  assert.equal(dialogs.state(page), null);
  await assert.rejects(
    dialogs.answer(page, true),
    (error: unknown) => error instanceof BrowserError && error.code === 'not_found',
  );
});

test('rebinding a handle ignores events from the previous debugger', async () => {
  const old = makePage(5);
  const current = makePage(5);
  const dialogs = new NativeDialogs();
  dialogs.bind(old.page);
  dialogs.bind(current.page);
  assert.equal(old.cdp.listenerCount, 0);
  old.cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/old', message: 'Old', type: 'alert' });
  assert.equal(dialogs.state(current.page), null);
  current.cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/new', message: 'New', type: 'alert' });
  assert.equal(dialogs.state(current.page)?.message, 'New');
  dialogs.dispose();
});

test('dispose clears every binding and listener', () => {
  const a = makePage(6);
  const b = makePage(7);
  const dialogs = new NativeDialogs();
  dialogs.bind(a.page);
  dialogs.bind(b.page);
  a.cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/a', message: 'A', type: 'alert' });
  b.cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test/b', message: 'B', type: 'alert' });
  assert.ok(dialogs.state(a.page));
  assert.ok(dialogs.state(b.page));
  dialogs.dispose();
  assert.equal(dialogs.state(a.page), null);
  assert.equal(dialogs.state(b.page), null);
  assert.equal(a.cdp.listenerCount, 0);
  assert.equal(b.cdp.listenerCount, 0);
  dialogs.dispose();
});

test('permission events and child frame dialog events do not become JavaScript dialogs', () => {
  const { page, cdp } = makePage(8);
  const dialogs = new NativeDialogs();
  dialogs.bind(page);
  cdp.emit('Browser.permissionRequest', { permission: 'geolocation', origin: 'https://example.test' });
  assert.equal(dialogs.state(page), null);
  assert.deepEqual(cdp.commands, []);
  cdp.emit('Page.javascriptDialogOpening', { url: 'https://frame.test', message: 'Child', type: 'alert' }, 'child-target');
  assert.equal(dialogs.state(page), null);
  dialogs.dispose();
});

test('a pending answer rejects a second answer and a completed dialog rejects reuse', async () => {
  const { page, cdp } = makePage(9);
  const dialogs = new NativeDialogs();
  dialogs.bind(page);
  let resolveCommand!: () => void;
  const command = new Promise<void>(resolve => { resolveCommand = resolve; });
  cdp.command = async (method: string, params: BrowserObject = {}): Promise<BrowserObject> => {
    cdp.commands.push({ method, params });
    await command;
    return {};
  };
  cdp.emit('Page.javascriptDialogOpening', { url: 'https://example.test', message: 'Wait', type: 'confirm' });
  const state = dialogs.state(page);
  assert.ok(state);
  const first = dialogs.answer(page, true, undefined, state.id);
  await flush();
  await assert.rejects(
    dialogs.answer(page, true, undefined, state.id),
    (error: unknown) => error instanceof BrowserError && error.code === 'unavailable',
  );
  resolveCommand();
  await first;
  await assert.rejects(
    dialogs.answer(page, true, undefined, state.id),
    (error: unknown) => error instanceof BrowserError && error.code === 'stale_dialog',
  );
  dialogs.dispose();
});
