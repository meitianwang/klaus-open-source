import strict from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { Harness, sleep, waitFor } from './harness';
import { createPipRuntime, type PipRuntimeDependencies } from '../main/app/pip-runtime';
import type { PipPortCallbacks } from '../main/native/pip';
import { ChannelRegistry } from '../main/ipc/registry';

const h = new Harness();
const ownershipVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-pip-vectors.json'), 'utf8')).multiWindow;
const cleanups: Array<() => Promise<void>> = [];
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
class Contents extends EventEmitter {
  id = 10;
  url = 'klaus-app://app/index.html';
  loading = false;
  destroyed = false;
  getURL() { return this.url; }
  isDestroyed() { return this.destroyed; }
  isLoadingMainFrame() { return this.loading; }
}
class Window extends EventEmitter {
  webContents = new Contents();
  destroyed = false;
  visible = true;
  minimized = false;
  isVisible() { return this.visible; }
  isMinimized() { return this.minimized; }
  show() { this.visible = true; this.emit('show'); }
  hide() { this.visible = false; this.emit('hide'); }
  isDestroyed() { return this.destroyed; }
  getNativeWindowHandle() { return Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]); }
}
function fixture(overrides: Partial<PipRuntimeDependencies> = {}, loading = false) {
  const window = new Window(); window.webContents.loading = loading;
  const ports: Array<{ ownerId: number; callbacks: PipPortCallbacks; commands: Record<string, unknown>[]; closes: number; closed: boolean; gate?: { promise: Promise<void>; resolve(): void } }> = [];
  const registry = new ChannelRegistry(), deliveries: unknown[] = [], logs: string[] = [];
  let saved: string | null = null;
  const runtime = createPipRuntime(window as unknown as BrowserWindow, registry, {
    helperPath: '/fixture/unavailable-producer', readPreferences: () => saved, writePreferences: raw => { saved = raw; }, language: () => 'en',
    subscriptions: { wait: async () => {} }, deliver: async (_id, _channel, state) => { deliveries.push(state); },
    focusBrowser: async () => {}, log: (_kind, message) => { logs.push(message); }, deadlineMs: 200,
    backend: { availability: () => ({ supported: true }), create: (owner, callbacks) => {
      const port: typeof ports[number] = { ownerId: owner.id, callbacks, commands: [], closes: 0, closed: false }; ports.push(port);
      return { command: command => { strict.equal(port.closed, false); port.commands.push(command); },
        close: async () => { port.closes++; if (port.gate) await port.gate.promise; port.closed = true; return { complete: true }; } };
    } }, ...overrides,
  });
  cleanups.push(async () => {
    for (const port of ports) port.gate?.resolve();
    strict.equal((await runtime.shutdown(1000)).complete, true);
  });
  const navigate = (url = 'klaus-app://app/index.html') => {
    window.webContents.url = url; window.webContents.loading = true;
    window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
  };
  const finish = () => { window.webContents.loading = false; window.webContents.emit('did-finish-load'); };
  return { window, runtime, ports, registry, deliveries, logs, navigate, finish };
}

const layout = (sessionId: string, x = 1) => ({ hostId: 'klaus-main-thread', sessionId, visible: true, animated: false, devicePixelRatio: 1,
  anchorRect: { x, y: 2, width: 600, height: 400 }, containerRect: null, anchors: null, anchorRects: null,
  isCodexHomeAvailable: false, presentationScope: 'thread' });
function secondWindow(f: ReturnType<typeof fixture>, id = 20) {
  const window = new Window(); window.webContents.id = id;
  f.runtime.attachWindow(window as unknown as BrowserWindow); return window;
}
function invoke(f: ReturnType<typeof fixture>, ownerId: number, channel: string, payload?: unknown, role = 'main') {
  return Promise.resolve(f.registry.lookup(channel)!({ role, senderId: ownerId, channel, args: payload === undefined ? [] : [payload as never] }));
}

h.test('registered background getters and validated layouts do not steal the native owner', async () => {
  const f = fixture(); await f.runtime.ready(); const second = secondWindow(f);
  strict.equal((await f.runtime.getState(second.webContents.id)).supported, true);
  strict.deepEqual(await invoke(f, 20, 'computer-use-pip:set-host-layout', layout('secondary', 44)), { ok: true });
  strict.equal(f.ports.length, ownershipVector.maximumActiveNativeOwners); strict.equal(f.ports[0]!.ownerId, ownershipVector.mainOwnerIds[0]);
  strict.equal(f.ports[0]!.ownerId === second.webContents.id, ownershipVector.backgroundLayoutTransfersOwner);
  strict.equal(f.ports[0]!.commands.some(command => command.type === 'layout'), false);
  await strict.rejects(invoke(f, 20, 'computer-use-pip:set-host-layout', { ...layout('secondary'), anchorRect: { x: Infinity } }), /rectangle/);
  await strict.rejects(invoke(f, 99, 'computer-use-pip:get-state'), /unavailable/);
  await strict.rejects(invoke(f, 20, 'computer-use-pip:get-state', undefined, 'canvas'), /main application/);
  second.emit('focus'); await f.runtime.ready(20);
  strict.equal(f.ports.length, 2); strict.equal(f.ports[0]!.closed, true); strict.equal(f.ports[1]!.ownerId, 20);
  strict.equal(f.ports[1]!.commands.find(command => command.type === 'layout')!.sessionId, 'secondary');
  strict.equal((f.ports[1]!.commands.find(command => command.type === 'layout')!.anchorRect as {x:number}).x, 44);
});
h.test('focus handoff drains exactly one helper and preserves approved preview sources', async () => {
  const f = fixture(); await f.runtime.ready(); const second = secondWindow(f), old = f.ports[0]!;
  f.runtime.zoomChanged(1.5);
  const lease = f.runtime.service.beginOperation('active-task');
  f.runtime.service.approvedWindow('active-task', lease, { app: { pid: 220, name: 'Approved fixture' }, windowId: 33 });
  f.runtime.service.browserResult('browser-task', f.runtime.service.beginOperation('browser-task'), { _meta: { 'klaus/toolSurface': { kind: 'browserUse', browserId: 'iab', backend: 'iab', screenshot: { tabId: 'fixture-tab', url: 'data:image/png;base64,aGVsbG8=' } } } });
  old.gate = deferred(); second.emit('focus'); await waitFor(() => old.closes > 0, 1000, 'previous native owner draining');
  strict.equal(f.ports.length, 1);
  await invoke(f, 10, 'computer-use-pip:set-host-layout', layout('primary', 55));
  strict.deepEqual((await f.runtime.getState(10)).activeTaskIds, ['active-task', 'browser-task']);
  old.gate.resolve(); await f.runtime.ready(20);
  strict.equal(f.ports.length, 2); strict.equal(old.closed, true);
  strict.equal((await f.runtime.getState(20)).zoomFactor, 1);
  strict.equal(f.ports[1]!.commands.some(command => command.type === 'upsertWindow' && command.pid === 220), ownershipVector.transferPreservesApprovedSources);
  strict.equal(f.ports[1]!.commands.some(command => command.type === 'upsertBrowser' && command.dataUrl === 'data:image/png;base64,aGVsbG8='), ownershipVector.transferPreservesApprovedSources);
  strict.equal(f.ports.filter(port => !port.closed).length, ownershipVector.maximumActiveNativeOwners);
  strict.equal(f.ports[1]!.commands.some(command => command.type === 'layout' && command.sessionId === 'primary'), false);
  await old.callbacks.onEvent({ type: 'visibility', scope: 'all', visible: false });
  strict.equal((await f.runtime.getState(20)).alwaysHidePictureInPicture, false);
  f.window.emit('focus'); await f.runtime.ready(10);
  strict.equal(f.ports[2]!.commands.find(command => command.type === 'layout')!.sessionId, 'primary');
  strict.equal((await f.runtime.getState(10)).zoomFactor, 1.5);
});
h.test('secondary visibility actions select their owner and closing it releases only that host', async () => {
  const f = fixture(); await f.runtime.ready(); const second = secondWindow(f);
  await invoke(f, 20, 'computer-use-pip:set-visibility', { scope: 'task', sessionId: 'secondary-task', visible: false });
  strict.equal(f.ports.at(-1)!.ownerId, 20);
  strict.equal((await f.runtime.getState(20)).taskVisibilities['secondary-task'], 'hidden');
  second.destroyed = true; second.webContents.destroyed = true; second.emit('closed');
  await f.runtime.ready(10); strict.equal(f.ports.at(-1)!.ownerId, 10);
  strict.equal(second.listenerCount('focus'), 0); strict.equal(second.webContents.listenerCount('zoom-changed'), 0);
  await strict.rejects(f.runtime.getState(20), /unavailable/);
  await f.runtime.shutdown(); strict.equal(f.window.listenerCount('focus'), 0);
});

h.test('background document replacement clears only that window cached layout', async () => {
  const f = fixture(); await f.runtime.ready(); const second = secondWindow(f);
  await invoke(f, 20, 'computer-use-pip:set-host-layout', layout('old-secondary'));
  second.webContents.loading = true;
  second.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: second.webContents.url });
  strict.equal(f.ports[0]!.closes, 0);
  second.webContents.loading = false; second.webContents.emit('did-finish-load'); second.emit('focus');
  await f.runtime.ready(20);
  strict.equal(f.ports.at(-1)!.commands.some(command => command.type === 'layout'), false);
  strict.equal((await f.runtime.getState(10)).supported, true);
});

h.test('startup getter does not depend on its own pending subscription or load event', async () => {
  let deliveries = 0;
  const f = fixture({ subscriptions: { wait: async (_owner, _channel, signal) => new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) reject(new Error('cancelled'));
    else signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) }, deliver: async () => { deliveries++; } }, true);
  strict.equal((await f.runtime.getState()).supported, true); strict.equal(f.ports.length, 0);
  f.finish(); await f.runtime.ready(); strict.equal(f.ports.length, 1);
  strict.equal((await f.runtime.getState()).supported, true); strict.equal(deliveries, 0);
  strict.equal((await f.runtime.shutdown()).complete, true);
});
h.test('startup, repeated show and duplicate finish events attach only one generation', async () => {
  const f = fixture(); await f.runtime.ready();
  f.window.show(); f.finish(); f.window.show(); await f.runtime.ready();
  strict.equal(f.ports.length, 1); strict.equal(f.registry.size(), 3);
});
h.test('a delayed native hide event cannot detach a window that is already visible', async () => {
  const f = fixture(); await f.runtime.ready();
  f.window.hide(); await f.runtime.getState();
  f.window.show(); await f.runtime.ready();
  const current = f.ports.at(-1)!;
  f.window.emit('hide');
  await f.runtime.ready();
  strict.equal(current.closes, 0);
  strict.equal(f.ports.length, 2);
  strict.equal(f.logs.at(-1), 'Ignored a stale hide event for a visible window');
  f.window.hide(); await f.runtime.getState();
  strict.equal(current.closed, true);
});
h.test('an early show event cannot leave a visible window unable to change its preferences', async () => {
  const f = fixture(); await f.runtime.ready();
  f.window.hide(); await f.runtime.getState();
  const handler = f.registry.lookup('computer-use-pip:set-visibility')!;
  const call = () => Promise.resolve(handler({ role: 'main', senderId: 10, channel: 'computer-use-pip:set-visibility', args: [{ scope: 'task', sessionId: 'late-show', visible: false }] }));
  await strict.rejects(call(), /hidden/);
  f.window.emit('show');
  f.window.visible = true;
  await call();
  strict.equal((await f.runtime.getState()).taskVisibilities['late-show'], 'hidden');
  strict.equal(f.ports.length, 2);
  f.window.minimized = true; f.window.emit('minimize'); await f.runtime.getState();
  await strict.rejects(call(), /hidden/);
  f.window.minimized = false; f.window.emit('restore'); await f.runtime.ready();
  strict.equal(f.ports.length, 3);
});
h.test('a window hidden during native drain cannot apply an earlier visibility request', async () => {
  const f = fixture(); await f.runtime.ready(); const old = f.ports[0]!; old.gate = deferred();
  f.window.hide(); await waitFor(() => old.closes > 0, 1000, 'old hidden owner closing');
  f.window.show();
  const handler = f.registry.lookup('computer-use-pip:set-visibility')!;
  const pending = Promise.resolve(handler({ role: 'main', senderId: 10, channel: 'computer-use-pip:set-visibility', args: [{ scope: 'task', sessionId: 'stale', visible: false }] }));
  const rejected = strict.rejects(pending, /changed|hidden/);
  await sleep(0); f.window.hide(); old.gate.resolve(); await rejected;
  strict.equal((await f.runtime.getState()).taskVisibilities.stale, undefined);
  strict.equal(f.ports.length, 1);
});
h.test('reload getter waits for actual native close and old epochs and callbacks cannot revive', async () => {
  const f = fixture(); await f.runtime.ready();
  const lease = f.runtime.service.beginOperation('session');
  const old = f.ports[0]!; old.gate = deferred(); f.navigate();
  await waitFor(() => old.closes > 0, 1000, 'old owner closing'); f.finish();
  let returned = false; const read = f.runtime.getState().then(state => { returned = true; return state; });
  await sleep(10); strict.equal(returned, false); strict.equal(f.ports.length, 1);
  old.gate.resolve(); strict.equal((await read).supported, true); await f.runtime.ready(); strict.equal(f.ports.length, 2);
  f.runtime.service.approvedWindow('session', lease, { app: { pid: 200 } });
  await old.callbacks.onEvent({ type: 'visibility', scope: 'all', visible: false });
  strict.equal((await f.runtime.getState()).alwaysHidePictureInPicture, false);
  strict.equal(f.ports[1]!.commands.some(command => command.type === 'upsertWindow'), false);
});
h.test('hide wins over a queued show while the previous generation is still draining', async () => {
  const f = fixture(); await f.runtime.ready(); const old = f.ports[0]!; old.gate = deferred();
  f.window.hide(); await waitFor(() => old.closes > 0, 1000, 'hidden owner closing');
  const attach = f.runtime.attachOwner(); const rejected = strict.rejects(attach, /changed|hidden/);
  f.window.hide(); old.gate.resolve(); await rejected;
  strict.equal((await f.runtime.getState()).supported, true); strict.equal(f.ports.length, 1);
  f.window.show(); await f.runtime.ready(); strict.equal(f.ports.length, 2);
});
h.test('a startup layout waiting for readiness cannot apply to a newer document', async () => {
  const f = fixture({}, true);
  const handler = f.registry.lookup('computer-use-pip:set-host-layout')!;
  const pending = Promise.resolve(handler({ role: 'main', senderId: 10, channel: 'computer-use-pip:set-host-layout', args: [layout('stale-document')] }));
  const rejected = strict.rejects(pending, /changed/);
  await sleep(5); f.navigate(); f.finish(); await rejected; await f.runtime.ready();
  strict.equal(f.ports.flatMap(port => port.commands).some(command => command.type === 'layout'), false);
});
h.test('same-document and subframe navigations do not revoke the trusted main owner', async () => {
  const f = fixture(); await f.runtime.ready();
  f.window.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://fixture.invalid' });
  f.window.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'klaus-app://app/index.html#other' });
  await f.runtime.ready(); strict.equal(f.ports.length, 1); strict.equal(f.ports[0]!.closes, 0);
});
h.test('untrusted navigation releases the native owner and refuses state and reactivation', async () => {
  const f = fixture(); await f.runtime.ready(); f.navigate('https://fixture.invalid'); f.finish();
  await waitFor(() => f.ports[0]!.closed, 1000, 'untrusted owner closed');
  await strict.rejects(f.runtime.getState(), /unavailable/); f.window.show(); await sleep(5); strict.equal(f.ports.length, 1);
  f.navigate(); f.finish(); await f.runtime.ready(); strict.equal(f.ports.length, 2);
  await strict.rejects(f.runtime.getState(900), /unavailable/);
});
h.test('shutdown is bounded but remains incomplete until the actual entered ACK settles', async () => {
  const ack = deferred(); let entered = false, aborted = false;
  const f = fixture({ deliver: async (_owner, _channel, _state, signal) => {
    entered = true; signal.addEventListener('abort', () => { aborted = true; }); await ack.promise;
  } });
  await f.runtime.ready(); await waitFor(() => entered, 1000, 'state ACK entered');
  const first = f.runtime.shutdown(5); strict.equal(f.runtime.shutdown(5), first);
  const start = Date.now(); strict.deepEqual(await first, { complete: false }); strict.ok(Date.now() - start < 250);
  strict.equal(aborted, true); strict.equal(f.window.listenerCount('show'), 0); strict.equal(f.window.webContents.listenerCount('did-finish-load'), 0);
  ack.resolve(); strict.deepEqual(await f.runtime.shutdown(1000), { complete: true });
  f.window.show(); f.finish(); strict.equal(f.ports.length, 1);
});
h.test('destroy during reload cannot attach a replacement after native close completes', async () => {
  const f = fixture(); await f.runtime.ready(); const old = f.ports[0]!; old.gate = deferred(); f.navigate();
  await waitFor(() => old.closes > 0, 1000, 'owner closing'); f.finish();
  f.window.destroyed = true; f.window.webContents.destroyed = true; f.window.emit('closed'); old.gate.resolve();
  await waitFor(() => old.closed, 1000, 'destroyed producer drained'); await sleep(5);
  strict.equal(f.ports.length, 1); await strict.rejects(f.runtime.getState(), /unavailable/);
});
h.test('a hide immediately after construction is reconciled before the first owner can activate', async () => {
  const f = fixture(); f.window.hide();
  strict.equal((await f.runtime.getState()).supported, true); strict.equal(f.ports.length, 0);
  f.window.show(); await f.runtime.ready(); strict.equal(f.ports.length, 1);
});

void h.finish(join(__dirname, 'pip-runtime-results.json'), 'pip-runtime').then(async code => {
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { console.error(error); code = 1; }
  }
  process.exitCode = code;
});
