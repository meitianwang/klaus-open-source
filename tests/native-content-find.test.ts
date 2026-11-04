import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FindInPageOptions, WebContents } from 'electron';
import {
  NATIVE_CONTENT_FIND_SELECTION,
  NativeContentFind,
  type NativeFindMatch,
  type NativeFindOptions,
} from '../main/app/native-content-find';
import { nativeFindPage, type NativeFindDebugger, type NativeFindHandle } from '../main/browser/native-find';

class Target extends EventEmitter {
  id = 1;
  destroyed = false;
  requests: Array<{ id: number; query: string; options?: FindInPageOptions }> = [];
  stops: string[] = [];
  scripts: string[] = [];
  selectionGate?: Promise<string>;
  isDestroyed() { return this.destroyed; }
  findInPage(query: string, options?: FindInPageOptions) { const id = this.requests.length + 1; this.requests.push({ id, query, options }); return id; }
  stopFindInPage(action: string) { this.stops.push(action); }
  async executeJavaScript(script: string) { this.scripts.push(script); return this.selectionGate ?? 'Selected native text'; }
  result(requestId: number, finalUpdate = true) { this.emit('found-in-page', {}, { requestId, finalUpdate, matches: 4, activeMatchOrdinal: 2 }); }
}
function fixture(timeoutMs = 200) {
  const first = new Target(), second = new Target(); second.id = 2;
  let current: Target | null = first;
  const find = new NativeContentFind({ target: () => current as unknown as WebContents | null, timeoutMs });
  return { find, first, second, setTarget: (target: Target | null) => { current = target; } };
}

class NativeTarget extends EventEmitter implements NativeFindHandle {
  destroyed = false;
  attached = false;
  requests: Array<{ query: string; options: Required<NativeFindOptions> }> = [];
  stops: boolean[] = [];
  evaluations: Array<{ method: string; params?: Record<string, unknown> }> = [];
  evaluateValue: unknown = 'Native selected text';
  findGate?: Promise<void>;

  readonly debugger: NativeFindDebugger = {
    isAttached: () => this.attached,
    attach: () => { this.attached = true; },
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      this.evaluations.push({ method, params });
      return { result: { value: this.evaluateValue } };
    },
  };

  isDestroyed() { return this.destroyed; }
  async find(query: string, options: Required<NativeFindOptions>): Promise<NativeFindMatch> {
    this.requests.push({ query, options });
    if (this.findGate) await this.findGate;
    return { matches: 6, active: 3 };
  }
  stopFind(clear: boolean) { this.stops.push(clear); }
}

test('Escape in an Electron page closes only its owning search and releases the input listener', async () => {
  const target = new Target(), closed: number[] = [];
  const native = new NativeContentFind({ target: id => id === 8 ? target as unknown as WebContents : null, onClose: id => closed.push(id) });
  await native.find(8, '');
  let prevented = false;
  target.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  assert.equal(prevented, true);
  assert.deepEqual(closed, [8]);
  assert.equal(target.listenerCount('before-input-event'), 0);
  assert.equal(target.stops.at(-1), 'clearSelection');
  native.close();
});

test('native search binds the selected text seed and accepts only its own final response', async t => {
  const f = fixture(); t.after(() => f.find.close());
  assert.deepEqual(await f.find.find(10, ''), { matches: 0, active: 0, selectedText: 'Selected native text' });
  assert.match(f.first.scripts[0]!, /window\.getSelection/);
  const result = f.find.find(10, 'literal', { matchCase: true, forward: false, findNext: true });
  let settled = false; void result.then(() => { settled = true; });
  f.first.result(99); f.first.result(1, false); await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(f.first.requests[0], { id: 1, query: 'literal', options: { matchCase: true, forward: false, findNext: false } });
  f.first.result(1); assert.deepEqual(await result, { matches: 4, active: 2 });
  assert.equal(f.first.listenerCount('found-in-page'), 0);
});

test('a new query cancels only the superseded request and ignores its late response', async t => {
  const f = fixture(); t.after(() => f.find.close());
  const first = f.find.find(10, 'first'); const rejected = assert.rejects(first, /SUPERSEDED/);
  const second = f.find.find(10, 'second'); await rejected;
  assert.equal(f.first.listenerCount('found-in-page'), 1);
  f.first.result(1); f.first.result(2);
  assert.deepEqual(await second, { matches: 4, active: 2 });
});

test('a delayed selection seed cannot clear a newer native search', async t => {
  const f = fixture(); t.after(() => f.find.close());
  let resolve!: (value: string) => void;
  f.first.selectionGate = new Promise<string>(done => { resolve = done; });
  const seed = f.find.find(10, ''); const seedRejected = assert.rejects(seed, /SUPERSEDED/);
  const query = f.find.find(10, 'new query');
  resolve('old selected text'); await seedRejected;
  assert.deepEqual(f.first.stops, []);
  f.first.result(1); assert.deepEqual(await query, { matches: 4, active: 2 });
});

test('target transfers invalidate the session without finding or clearing another window page', async t => {
  const f = fixture(); t.after(() => f.find.close());
  await f.find.find(10, '');
  f.setTarget(f.second);
  await assert.rejects(f.find.find(10, 'changed'), /TARGET_CHANGED/);
  await assert.rejects(f.find.find(10, 'still changed'), /TARGET_CHANGED/);
  f.find.stop(10);
  assert.deepEqual(f.first.stops, ['clearSelection']);
  assert.deepEqual(f.second.requests, []);
  assert.deepEqual(f.second.stops, []);
  await f.find.find(10, '');
  assert.deepEqual(f.second.stops, ['clearSelection']);
});

test('navigation, destruction and timeout release pending request listeners', async t => {
  const f = fixture(20); t.after(() => f.find.close());
  const navigating = f.find.find(10, 'navigation'); const rejected = assert.rejects(navigating, /TARGET_CHANGED/);
  f.first.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); await rejected;
  assert.equal(f.first.listenerCount('found-in-page'), 0);
  f.find.stop(10);
  await assert.rejects(f.find.find(10, 'timeout'), /TIMEOUT/);
  assert.equal(f.first.listenerCount('found-in-page'), 0);
  const destroyed = f.find.find(10, 'destroy'); const destroyedRejection = assert.rejects(destroyed, /TARGET_CHANGED/);
  f.first.destroyed = true; f.first.emit('destroyed'); await destroyedRejection;
  assert.equal(f.first.listenerCount('did-start-navigation'), 0);
});

test('a real native page runs through the narrow contract without WebContents APIs', async t => {
  const target = new NativeTarget();
  const page = nativeFindPage(target);
  const find = new NativeContentFind({ target: id => id === 4 ? page : null, timeoutMs: 100 });
  t.after(() => find.close());
  assert.equal('findInPage' in target, false);
  assert.equal('executeJavaScript' in target, false);
  assert.deepEqual(await find.find(4, 'needle', { forward: false, findNext: true, matchCase: true }), { matches: 6, active: 3 });
  assert.deepEqual(target.requests[0], {
    query: 'needle',
    options: { forward: false, findNext: true, matchCase: true },
  });
  assert.equal(target.attached, false);
  find.stop(4);
  assert.deepEqual(target.stops, [true]);
});

test('native selection is read through the page debugger', async t => {
  const target = new NativeTarget();
  const page = nativeFindPage(target);
  const find = new NativeContentFind({ target: () => page, timeoutMs: 100 });
  t.after(() => find.close());
  assert.deepEqual(await find.find(4, ''), { matches: 0, active: 0, selectedText: 'Native selected text' });
  assert.equal(target.attached, true);
  assert.equal(target.evaluations.length, 1);
  assert.equal(target.evaluations[0]!.method, 'Runtime.evaluate');
  assert.equal(target.evaluations[0]!.params?.expression, NATIVE_CONTENT_FIND_SELECTION);
  assert.deepEqual(target.stops, [true]);
});

test('native adapter prefers a prepared evaluate function', async t => {
  const target = new NativeTarget();
  const calls: string[] = [];
  const page = nativeFindPage(target, { evaluate: async expression => { calls.push(expression); return 'Prepared selection'; } });
  const find = new NativeContentFind({ target: () => page, timeoutMs: 100 });
  t.after(() => find.close());
  assert.deepEqual(await find.find(5, ''), { matches: 0, active: 0, selectedText: 'Prepared selection' });
  assert.deepEqual(calls, [NATIVE_CONTENT_FIND_SELECTION]);
  assert.equal(target.attached, false);
});

test('native navigation releases the narrow listeners and rejects the pending find', async t => {
  const target = new NativeTarget();
  let release!: () => void;
  target.findGate = new Promise<void>(done => { release = done; });
  const page = nativeFindPage(target);
  const find = new NativeContentFind({ target: () => page, timeoutMs: 200 });
  t.after(() => find.close());
  const pending = find.find(4, 'slow');
  const rejected = assert.rejects(pending, /TARGET_CHANGED/);
  target.emit('did-navigate', {}, 'https://example.test/next');
  await rejected;
  release();
  assert.equal(target.listenerCount('did-navigate'), 0);
  assert.equal(target.listenerCount('destroyed'), 0);
});

test('a removed owner target invalidates the session and disposes listeners', async t => {
  const f = fixture(); t.after(() => f.find.close());
  await f.find.find(10, '');
  f.setTarget(null);
  await assert.rejects(f.find.find(10, 'next'), /TARGET_CHANGED/);
  assert.equal(f.first.listenerCount('did-start-navigation'), 0);
  assert.equal(f.first.listenerCount('destroyed'), 0);
});

test('a fresh adapter for the same native page keeps the session', async t => {
  const target = new NativeTarget();
  const find = new NativeContentFind({ target: () => nativeFindPage(target), timeoutMs: 100 });
  t.after(() => find.close());
  assert.deepEqual(await find.find(9, 'one'), { matches: 6, active: 3 });
  assert.deepEqual(await find.find(9, 'two'), { matches: 6, active: 3 });
  find.stop(9);
  assert.deepEqual(target.stops, [true]);
});

test('a native page receives only the newest live request', async t => {
  const target = new NativeTarget();
  const page = nativeFindPage(target);
  const find = new NativeContentFind({ target: () => page, timeoutMs: 100 });
  t.after(() => find.close());
  const first = find.find(6, 'first');
  const firstRejection = assert.rejects(first, /SUPERSEDED/);
  const second = find.find(6, 'second');
  await firstRejection;
  assert.deepEqual(await second, { matches: 6, active: 3 });
  assert.deepEqual(target.requests.map(request => request.query), ['second']);
  assert.deepEqual(target.stops, [], 'an already canceled request never starts native work');
});
