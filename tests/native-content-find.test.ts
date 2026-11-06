import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FindInPageOptions, WebContents } from 'electron';
import { NativeContentFind } from '../main/app/native-content-find';

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

test('Escape in a native page closes only its owning search and releases the input listener', async () => {
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
