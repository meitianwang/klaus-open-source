import strict from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, sleep, waitFor } from './harness';
import { PipService, type PipDependencies, type PipState } from '../main/services/pip';
import { NativePipResource, type PipPortCallbacks, type PipNativeEvent } from '../main/native/pip';
import { ChannelRegistry } from '../main/ipc/registry';
import { IpcRouter } from '../main/ipc/router';
import { RoleTable } from '../main/ipc/contract';
import { registerPipHandlers } from '../main/ipc/handlers/pip';

const h = new Harness();
const owner = { id: 10, handle: Buffer.alloc(8) };
const browser = (tab: string | number = 1, browserId = 'chrome', extra: Record<string, unknown> = {}) => ({ _meta: { 'klaus/toolSurface': {
  kind: 'browserUse', browserId, backend: 'chrome', screenshot: { tabId: tab, url: 'data:image/png;base64,aGVsbG8=' }, ...extra,
} } });
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise };
}
function fixture(overrides: Partial<PipDependencies> = {}) {
  const commands: Record<string, unknown>[] = [], snapshots: PipState[] = [], callbacks: PipPortCallbacks[] = [], saved: string[] = [];
  let closes = 0, failWrite = false;
  const service = new PipService({ availability: () => ({ supported: true }), readPreferences: () => null, language: () => 'en',
    writePreferences: raw => { if (failWrite) throw new Error('disk-full'); saved.push(raw); },
    createNative: (_owner, callback) => { callbacks.push(callback); return { command: value => commands.push(structuredClone(value)), close: async () => { closes++; return { complete: true }; } }; },
    deliver: async (_id, _channel, state) => { snapshots.push(state); }, focusBrowser: async () => {}, ...overrides });
  service.attachOwner(owner);
  return { service, commands, snapshots, callbacks, saved, closes: () => closes, failWrite: () => { failWrite = true; } };
}
const upserts = (commands: Record<string, unknown>[]) => commands.filter(value => /^upsert/.test(String(value.type)));
const layout = { hostId: 'klaus-main-thread', sessionId: 'a', visible: true, animated: false, devicePixelRatio: 1,
  anchorRect: { x: 1, y: 2, width: 600, height: 400 }, containerRect: null, anchors: null, anchorRects: null,
  isCodexHomeAvailable: false, presentationScope: 'thread', interactionPassthroughRect: null };

h.test('committed geometry and image acceptance vectors preserve the product contract', async () => {
  const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-pip-vectors.json'), 'utf8'));
  const f = fixture();
  for (const row of vectors.size) {
    await f.callbacks[0]!.onEvent({ type: 'resize', maxDisplaySize: row.input }); strict.equal(f.service.snapshot().maxDisplaySize, row.expected);
  }
  for (const [index, row] of vectors.imageUrls.entries()) {
    const sid = `url-${index}`, value = browser(); value._meta['klaus/toolSurface'].screenshot!.url = row.url;
    const before = upserts(f.commands).length; f.service.browserResult(sid, f.service.beginOperation(sid), value);
    strict.equal(upserts(f.commands).length > before, row.accepted);
  }
  strict.equal((await f.service.close()).complete, true);
});
h.test('hide all persists for future tasks and showing one task preserves every other choice', async () => {
  const f = fixture();
  for (const sid of ['a', 'b']) f.service.browserResult(sid, f.service.beginOperation(sid), browser());
  f.service.setVisibility(owner.id, { scope: 'all', visible: false });
  f.service.browserResult('c', f.service.beginOperation('c'), browser());
  f.service.setVisibility(owner.id, { scope: 'task', sessionId: 'a', visible: true });
  strict.deepEqual(f.service.snapshot().taskVisibilities, { a: 'shown', b: 'hidden', c: 'hidden' });
  strict.equal(f.service.snapshot().alwaysHidePictureInPicture, false);
  strict.deepEqual(JSON.parse(f.saved.at(-1)!).taskVisibilities, { a: 'shown', b: 'hidden', c: 'hidden' });
  await f.service.close();
});
h.test('failed settings transaction leaves both returned state and native preferences unchanged', async () => {
  const f = fixture(); const before = f.service.snapshot(); f.failWrite(); const count = f.commands.length;
  strict.throws(() => f.service.setVisibility(owner.id, { scope: 'task', sessionId: 'a', visible: false }), /disk-full/);
  strict.deepEqual(f.service.snapshot(), before); strict.equal(f.commands.length, count);
  await f.callbacks[0]!.onEvent({ type: 'visibility', scope: 'all', visible: false });
  strict.equal(f.service.snapshot().alwaysHidePictureInPicture, false); strict.match(f.service.snapshot().error!, /disk-full/);
  strict.equal(f.commands.at(-1)!.alwaysHidePictureInPicture, false); await f.service.close();
});
h.test('invalid visibility and malformed layout cannot invoke native actions through renderer JSON', async () => {
  const f = fixture();
  for (const value of [{ scope: 'all', visible: true }, { scope: 'task', visible: false }, { scope: 'other', visible: false }, { scope: 'task', sessionId: 'a', visible: 1 }]) {
    strict.throws(() => f.service.setVisibility(owner.id, value));
  }
  f.service.setHostLayout(owner.id, { ...layout, type: 'upsertWindow', pid: 123, helperPath: '/evil', generation: 9 });
  strict.equal(f.commands.at(-1)!.type, 'layout'); strict.equal('pid' in f.commands.at(-1)!, false); strict.equal('helperPath' in f.commands.at(-1)!, false);
  strict.throws(() => f.service.setHostLayout(owner.id, { ...layout, anchorRect: { x: 0, y: 0, width: Infinity, height: 2 } }));
  strict.throws(() => f.service.setHostLayout(owner.id, { ...layout, hostId: 'foreign' }));
  await f.service.close();
});
h.test('the three routed channels enforce renderer role and exact resource ownership', async () => {
  const f = fixture(), registry = new ChannelRegistry(); registerPipHandlers(registry, f.service);
  const router = new IpcRouter({ registry, roles: RoleTable.load() }); strict.equal(registry.size(), 3);
  const route = (role: string, senderId: number, channel: string, args: never[] = []) => router.route({ role, senderId, senderFrameIsTop: true }, channel, args);
  strict.equal((await route('main', owner.id, 'computer-use-pip:get-state')).ok, true);
  strict.equal((await route('main', 90, 'computer-use-pip:get-state')).ok, false);
  strict.equal((await route('recorder', owner.id, 'computer-use-pip:get-state')).ok, false);
  strict.equal((await route('canvas', owner.id, 'computer-use-pip:set-host-layout')).ok, false);
  await f.service.close();
});
h.test('late permission and browser results cannot resurrect a completed turn or target a new turn', async () => {
  const f = fixture(); f.service.observe([{ type: 'stream_mode', mode: 'requesting', sessionId: 'a', turnId: 'one' }]);
  const old = f.service.beginOperation('a'); f.service.browserResult('a', old, browser());
  f.service.observe([{ type: 'done', sessionId: 'a', turnId: 'one' }]); const before = upserts(f.commands).length;
  f.service.approvedWindow('a', old, { app: { pid: 22 } }); f.service.browserResult('a', old, browser(2));
  strict.equal(upserts(f.commands).length, before); strict.deepEqual(f.service.snapshot().activeTaskIds, []);
  f.service.observe([{ type: 'stream_mode', mode: 'requesting', sessionId: 'a', turnId: 'two' }]);
  f.service.approvedWindow('a', old, { app: { pid: 22 } }); strict.equal(upserts(f.commands).length, before);
  f.service.approvedWindow('a', f.service.beginOperation('a'), { app: { pid: 22 } }); strict.equal(upserts(f.commands).length, before + 1);
  f.service.observe([{ type: 'done', sessionId: 'a', turnId: 'one' }]); strict.deepEqual(f.service.snapshot().activeTaskIds, ['a']); await f.service.close();
});
h.test('tool call leases pin capture to the accepted operation and omit unknown native optionals', async () => {
  const f = fixture(); f.service.observe([{ type: 'tool_start', sessionId: 'a', toolName: 'mcp__computer-use__click', toolCallId: 'call' }]);
  strict.deepEqual(f.service.snapshot().activeTaskIds, ['a']);
  f.service.observe([{ type: 'tool_end', sessionId: 'a', toolCallId: 'call', computerUse: { app: { pid: 42 }, windowId: null,
    mapping: { screenshotScreenX: 1, screenshotScreenY: 2, screenshotScreenWidth: 400, screenshotScreenHeight: 300 } } }]);
  const value = upserts(f.commands).at(-1)!; strict.equal('windowId' in value, false); strict.equal('associatedWindowIds' in value, false);
  strict.deepEqual(value.bounds, { x: 1, y: 2, width: 400, height: 300 });
  f.service.cursor('a', f.service.beginOperation('a'), { x: 30, y: 40, active: true, type: 'shutdown' });
  strict.deepEqual(Object.keys(f.commands.at(-1)!).sort(), ['active', 'epoch', 'sessionId', 'type', 'x', 'y']);
  strict.equal(f.commands.at(-1)!.active, true); await f.service.close();
});
h.test('failed browser observations invalidate closed tabs without reviving activity or harming another task', async () => {
  const f = fixture();
  for (const sid of ['a', 'b']) f.service.browserResult(sid, f.service.beginOperation(sid), browser(1));
  f.service.browserResult('a', f.service.beginOperation('a'), { ...browser(2, 'chrome', { openTabIds: [] }), isError: true });
  strict.equal(upserts(f.commands).length, 2);
  const removal = f.commands.filter(value => value.type === 'remove' && Array.isArray(value.presentationIds) && value.presentationIds.length).at(-1)!;
  strict.deepEqual(removal.presentationIds, ['browser:["a","chrome","1"]']);
  f.service.browserResult('idle', f.service.beginOperation('idle'), { ...browser(), isError: true }); strict.equal(f.service.snapshot().activeTaskIds.includes('idle'), false);
  f.service.browserResult('b', f.service.beginOperation('b'), browser(1, 'chrome', { sessionEnded: true }));
  strict.equal(f.service.snapshot().activeTaskIds.includes('b'), false); await f.service.close();
});
h.test('native ready and error callbacks must refer to the current frame revision', async () => {
  const f = fixture(), epoch = f.service.beginOperation('a'); f.service.browserResult('a', epoch, browser()); const first = upserts(f.commands).at(-1)!;
  f.service.browserResult('a', epoch, browser()); const second = upserts(f.commands).at(-1)!;
  await f.callbacks[0]!.onEvent({ ...first, type: 'error', message: 'obsolete' }); strict.equal(f.service.snapshot().error, null);
  await f.callbacks[0]!.onEvent({ ...second, type: 'error', message: 'current failure' }); strict.equal(f.service.snapshot().error, 'current failure');
  await f.callbacks[0]!.onEvent({ ...first, type: 'ready' }); strict.equal(f.service.snapshot().error, 'current failure');
  await f.callbacks[0]!.onEvent({ ...second, type: 'ready' }); strict.equal(f.service.snapshot().error, null); await f.service.close();
});
h.test('a replaced browser target cannot receive a stale click or a late focus failure', async () => {
  const gate = deferred(), focused: unknown[] = [];
  const f = fixture({ focusBrowser: async target => { focused.push(target); await gate.promise; } });
  const epoch = f.service.beginOperation('a'); f.service.browserResult('a', epoch, browser()); const first = upserts(f.commands).at(-1)!;
  await f.callbacks[0]!.onEvent({ ...first, type: 'focus' }); await sleep(0); strict.equal(focused.length, 1);
  f.service.browserResult('a', epoch, browser()); await f.callbacks[0]!.onEvent({ ...first, type: 'focus' }); strict.equal(focused.length, 1);
  gate.reject(new Error('old-target-gone')); await sleep(0); strict.equal(f.service.snapshot().error, null); await f.service.close();
});
h.test('state pushes keep one in-flight acknowledgement and coalesce the newest snapshot', async () => {
  const gate = deferred(), delivered: PipState[] = [];
  const f = fixture({ deliver: async (_id, _channel, state) => { delivered.push(state); if (delivered.length === 1) await gate.promise; } });
  for (let i = 0; i < 300; i++) f.service.zoomChanged(1 + i / 1000);
  strict.equal(delivered.length, 1); gate.resolve(); await waitFor(() => delivered.length === 2, 500, 'coalesced snapshot');
  strict.equal(delivered[1]!.zoomFactor, 1.299); await f.service.close();
});
h.test('owner detach aborts and waits for entered delivery and focus callbacks before allowing reuse', async () => {
  const delivery = deferred(), focus = deferred(), signals: AbortSignal[] = [];
  const f = fixture({ deliver: async (_id, _channel, _state, signal) => { signals.push(signal); await delivery.promise; },
    focusBrowser: async (_target, signal) => { signals.push(signal); await focus.promise; } });
  f.service.browserResult('a', f.service.beginOperation('a'), browser()); await f.callbacks[0]!.onEvent({ ...upserts(f.commands).at(-1)!, type: 'focus' }); await sleep(0);
  strict.deepEqual(await f.service.detachOwner(owner.id, 1), { complete: false }); strict.equal(signals.every(signal => signal.aborted), true);
  strict.throws(() => f.service.attachOwner(owner), /previous/); strict.throws(() => f.service.setHostLayout(owner.id, layout));
  delivery.resolve(); focus.reject(new Error('cancelled')); await sleep(0); strict.deepEqual(await f.service.detachOwner(owner.id), { complete: true });
  f.service.attachOwner(owner); await f.callbacks[0]!.onEvent({ type: 'error', message: 'stale owner' }); strict.equal(f.service.snapshot().error, null);
  await f.service.close();
});
h.test('unsupported platforms return their real capability and do not instantiate a native producer', async () => {
  const f = fixture({ availability: () => ({ supported: false, error: 'PiP requires supported macOS native APIs' }),
    createNative: () => { throw new Error('must never start'); } });
  strict.equal(f.service.getState(owner.id).supported, false); strict.match(f.service.getState(owner.id).error!, /macOS/);
  f.service.setVisibility(owner.id, { scope: 'task', sessionId: 'a', visible: false });
  strict.equal((await f.service.close()).complete, true);
});
h.test('presentation resource limits reject excess sources with a visible error', async () => {
  const f = fixture(), epoch = f.service.beginOperation('a');
  for (let tab = 1; tab <= 33; tab++) f.service.browserResult('a', epoch, browser(tab));
  strict.equal(upserts(f.commands).length, 32); strict.match(f.service.snapshot().error!, /32/); await f.service.close();
});
h.test('ordinary streaming tokens never flood the native command or state transport', async () => {
  const f = fixture(), before = f.commands.length, revision = f.service.snapshot().revision;
  for (let index = 0; index < 300; index++) f.service.observe([{ type: 'text_delta', sessionId: 'stream', text: 'x' }]);
  strict.equal(f.commands.length, before); strict.equal(f.service.snapshot().revision, revision); await f.service.close();
});

function nativeFixture() {
  const events: PipNativeEvent[] = []; let resourceId = '', closing = false, pending = 0, waits = 0;
  let waiting: ((ready: boolean) => void) | undefined;
  const wake = () => { if (waiting) { const resolve = waiting; waiting = undefined; resolve(!closing); } };
  const addon = { pipSupported: () => true, NativePip: class {
    constructor(resource: string) { resourceId = resource; }
    command(operationId: string) { return JSON.stringify({ operationId, resourceId, generation: 7, accepted: true }); }
    waitForEvents() {
      waits++;
      if (closing || events.length) return Promise.resolve(!closing);
      strict.equal(waiting, undefined, 'only one event waiter is admitted');
      return new Promise<boolean>(resolve => { waiting = resolve; });
    }
    drainEvents() { return events.splice(0); }
    beginClose() { closing = true; events.splice(0); wake(); }
    report() { return JSON.stringify({ resourceId, generation: 7, closing, complete: closing && pending === 0, pending, lastSequence: 0 }); }
  } };
  return { addon, enqueue: (sequence: number, value: Record<string, unknown>, generation = 7) => {
    events.push({ resourceId, sequence, generation, eventJson: JSON.stringify(value) }); wake();
  }, pending: (value: number) => { pending = value; }, waits: () => waits };
}
h.test('an idle native preview blocks until an event and close releases its pending wait', async () => {
  const f = nativeFixture(), received: unknown[] = [];
  const port = new NativePipResource({ addon: f.addon, handle: owner.handle, helperPath: '/fixture', onEvent: value => { received.push(value); }, onError: error => { throw error; } });
  await sleep(80); strict.equal(f.waits(), 1); strict.equal(received.length, 0);
  f.enqueue(1, { type: 'ready' }); await waitFor(() => received.length === 1, 500, 'native event delivered');
  strict.equal(f.waits(), 2);
  strict.equal((await port.close()).complete, true);
  await sleep(40); strict.equal(f.waits(), 2);
});
h.test('native wrapper rejects wrong generation or sequence and closes without delivering unsafe events', async () => {
  const f = nativeFixture(), errors: Error[] = [], received: unknown[] = [];
  const port = new NativePipResource({ addon: f.addon, handle: owner.handle, helperPath: '/fixture', onEvent: value => { received.push(value); }, onError: error => errors.push(error) });
  f.enqueue(1, { type: 'ready' }, 8); await waitFor(() => errors.length === 1, 500, 'invalid native event rejected');
  strict.equal(received.length, 0); strict.equal((await port.close()).complete, true); strict.throws(() => port.command({ type: 'layout' }), /closing/);
});
h.test('native close is idempotent and waits for both physical producer exit and entered callback', async () => {
  const f = nativeFixture(), gate = deferred(); let entered = false, calls = 0;
  const port = new NativePipResource({ addon: f.addon, handle: owner.handle, helperPath: '/fixture', onEvent: async () => { calls++; entered = true; await gate.promise; }, onError: () => {} });
  f.enqueue(1, { type: 'state' }); await waitFor(() => entered, 500, 'native callback entered'); f.pending(1);
  strict.equal((await port.close(1)).complete, false); gate.resolve(); await sleep(0); strict.equal((await port.close(1)).complete, false);
  f.pending(0); strict.equal((await port.close()).complete, true); f.enqueue(2, { type: 'state' }); await sleep(30); strict.equal(calls, 1);
});

void h.finish(join(__dirname, 'pip.result.json'), 'pip').then(code => { process.exitCode = code; });
