import type { BrowserWindow } from 'electron';
import { accessSync, constants, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { Json } from '../ipc/contract';
import { arg0 } from '../ipc/binary';
import type { ChannelRegistry } from '../ipc/registry';
import { NativePipResource, type PipPort, type PipPortCallbacks } from '../native/pip';
import { PIP_PUSH_CHANNEL, PipService, normalizePipHostLayout, type PipOwner, type PipState } from '../services/pip';
import { isTrustedAppUrl } from './trusted-origin';

export interface PipRuntimeDependencies {
  addonPath?: string;
  helperPath: string;
  diagnosticPath?: string;
  readPreferences(): string | null;
  writePreferences(raw: string): void;
  language(): string;
  subscriptions: { wait(ownerId: number, channel: string, signal?: AbortSignal, timeoutMs?: number): Promise<void> };
  deliver(ownerId: number, channel: string, state: PipState, signal: AbortSignal): Promise<void>;
  focusBrowser(target: Record<string, unknown>, signal: AbortSignal): Promise<void>;
  log(kind: string, message: string): void;
  deadlineMs?: number;
  /** A main-process adapter seam for a native backend or isolated lifecycle fixture. */
  backend?: {
    availability(): { supported: boolean; error?: string };
    create(owner: PipOwner, callbacks: PipPortCallbacks): PipPort;
  };
}

/** Registered main windows share one native PiP generation, transferred through a bounded drain. */
export function createPipRuntime(window: BrowserWindow, registry: ChannelRegistry, deps: PipRuntimeDependencies) {
  let id = window.webContents.id;
  interface Host {
    window: BrowserWindow;
    loaded: boolean;
    documentRevision: number;
    layout?: Record<string, unknown>;
    zoomFactor: number;
    detach(): void;
  }
  const hosts = new Map<number, Host>();
  let attachedOwnerId: number | undefined;
  const duration = Math.max(1, Math.min(30_000, Number.isFinite(deps.deadlineMs) ? deps.deadlineMs! : 5000));
  const budget = (value: number) => Math.max(0, Math.min(30_000, Number.isFinite(value) ? value : duration));
  let closing = false, wanted = !window.isDestroyed() && window.isVisible() && !window.isMinimized(), revision = 0, attached = false, attachedRevision = -1;
  let visibilityCheck: NodeJS.Immediate | undefined;
  let loaded = !window.webContents.isLoadingMainFrame();
  let flight: Promise<{ complete: boolean }> | undefined;
  let shutdownFlight: Promise<{ complete: boolean }> | undefined;
  const wakeups = new Set<() => void>();
  const wake = () => { for (const notify of [...wakeups]) notify(); };
  const syncVisibility = () => {
    if (closing) return;
    const visible = !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    if (wanted !== visible) {
      wanted = visible; revision++; wake();
      deps.log('pip-owner', `Window visibility reconciled as ${visible ? 'shown' : 'hidden'}`);
    }
  };
  const trusted = () => !window.isDestroyed() && !window.webContents.isDestroyed() && isTrustedAppUrl(window.webContents.getURL());
  const needsWork = () => attached
    ? closing || !wanted || !loaded || !trusted() || attachedRevision !== revision
    : !closing && wanted && loaded && trusted();
  const within = (task: Promise<{ complete: boolean }>, deadline: number) => new Promise<{ complete: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ complete: false }), Math.max(0, deadline - performance.now()));
    void task.then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
  });
  const available = () => {
    if (!NativePipResource.supported(deps.addonPath)) return { supported: false, error: 'Native Picture-in-Picture is unavailable on this platform' };
    try {
      if (!statSync(deps.helperPath).isFile()) throw new Error('producer is not a file');
      accessSync(deps.helperPath, constants.X_OK);
      return { supported: true };
    } catch (error) { return { supported: false, error: `Picture-in-Picture producer is unavailable: ${String(error)}` }; }
  };
  const service = new PipService({
    availability: deps.backend?.availability ?? available,
    createNative: (owner, callbacks) => deps.backend?.create(owner, callbacks) ?? new NativePipResource({
      handle: owner.handle, addonPath: deps.addonPath, helperPath: deps.helperPath, diagnosticPath: deps.diagnosticPath, ...callbacks,
    }),
    readPreferences: deps.readPreferences, writePreferences: deps.writePreferences,
    language: deps.language, focusBrowser: deps.focusBrowser,
    deliver: async (ownerId, channel, state, signal) => {
      await deps.subscriptions.wait(ownerId, channel, signal, duration);
      signal.throwIfAborted();
      if (!trusted() || ownerId !== id) throw new Error('Picture-in-Picture renderer owner changed before delivery');
      await deps.deliver(ownerId, channel, state, signal);
    },
  });

  const reconcile = (deadlineMs = duration): Promise<{ complete: boolean }> => {
    if (flight) return flight;
    const deadline = performance.now() + budget(deadlineMs);
    let inspectedRevision = revision;
    let complete = false;
    const task = Promise.resolve().then(async () => {
      for (;;) {
        const intent = revision;
        inspectedRevision = intent;
        if (attached && (closing || !wanted || !loaded || !trusted() || attachedRevision !== intent)) {
          const result = await service.detachOwner(attachedOwnerId!, Math.max(0, deadline - performance.now()), attachedOwnerId !== id);
          if (!result.complete) return result;
          attached = false; attachedOwnerId = undefined;
        }
        if (intent !== revision) continue;
        if (!closing && wanted && loaded && trusted() && !attached) {
          service.attachOwner({ id, handle: window.getNativeWindowHandle() });
          attached = true; attachedOwnerId = id; attachedRevision = intent;
          const host = hosts.get(id);
          service.zoomChanged(host?.zoomFactor ?? 1);
          if (host?.layout) service.setHostLayout(id, host.layout);
        }
        complete = true; return { complete: true };
      }
    });
    flight = task;
    void task.finally(() => {
      if (flight === task) flight = undefined;
      wake();
      if (inspectedRevision !== revision || (complete && needsWork())) report(reconcile());
    }).catch(() => {});
    return task;
  };
  const report = (task: Promise<{ complete: boolean }>) => {
    void task.then(result => { if (!result.complete) deps.log('pip-owner', 'The previous Picture-in-Picture owner has not finished closing'); })
      .catch(error => deps.log('pip-owner', String(error)));
  };
  const settle = async (deadline: number): Promise<{ complete: boolean }> => {
    for (;;) {
      const result = await within(reconcile(Math.max(0, deadline - performance.now())), deadline);
      if (!result.complete || !needsWork()) return result;
      if (performance.now() >= deadline) return { complete: false };
    }
  };
  const assertHost = (ownerId: number): Host => {
    const host = hosts.get(ownerId);
    if (closing || !host || host.window.isDestroyed() || host.window.webContents.isDestroyed() || !isTrustedAppUrl(host.window.webContents.getURL())) throw new Error('Picture-in-Picture window owner is unavailable');
    return host;
  };
  const assertCaller = (ownerId: number) => {
    assertHost(ownerId);
    if (ownerId !== id || !trusted()) throw new Error('Picture-in-Picture window owner is unavailable');
  };
  const waitForChange = (deadline: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); wakeups.delete(done); resolve(); };
    const timer = setTimeout(done, Math.max(0, deadline - performance.now())); wakeups.add(done);
  });
  const ready = async (ownerId = id, deadlineMs = duration): Promise<void> => {
    assertCaller(ownerId);
    syncVisibility();
    const intent = revision, deadline = performance.now() + budget(deadlineMs);
    for (;;) {
      const result = await settle(deadline);
      assertCaller(ownerId);
      syncVisibility();
      if (revision !== intent) throw new Error('Picture-in-Picture window changed while waiting for its owner');
      if (!result.complete) throw new Error('The previous Picture-in-Picture owner is still closing');
      if (!wanted) throw new Error('Picture-in-Picture window is hidden');
      if (attached) return;
      if (performance.now() >= deadline) throw new Error('Picture-in-Picture document did not become ready before the deadline');
      await waitForChange(deadline);
    }
  };
  const getState = async (ownerId = id): Promise<PipState> => {
    assertHost(ownerId);
    if (ownerId !== id) return service.snapshot();
    assertCaller(ownerId);
    syncVisibility();
    const intent = revision, result = await settle(performance.now() + duration);
    assertCaller(ownerId);
    syncVisibility();
    if (revision !== intent) throw new Error('Picture-in-Picture document changed while reading its state');
    if (!result.complete) throw new Error('The previous Picture-in-Picture owner is still closing');
    // A startup getter must not wait for load or subscription registration: either
    // may be waiting for this IPC reply. Reading preferences cannot activate capture.
    return service.snapshot();
  };
  const ownerAction = async <T>(ownerId: number, action: () => T): Promise<T> => {
    assertCaller(ownerId); syncVisibility();
    const intent = revision;
    await ready(ownerId);
    if (revision !== intent) throw new Error('Picture-in-Picture document changed before applying its request');
    return action();
  };
  const selectWindow = (ownerId: number): void => {
    const host = assertHost(ownerId);
    if (ownerId === id) return;
    window = host.window; id = ownerId; loaded = host.loaded;
    wanted = !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    revision++; report(reconcile()); wake();
  };
  const caller = (context: { role: string; senderId: number }): Host => {
    if (context.role !== 'main') throw new Error('Picture-in-Picture belongs to a main application window');
    return assertHost(context.senderId);
  };
  registry.registerAll({
    'computer-use-pip:get-state': async context => { caller(context); return await getState(context.senderId) as unknown as Json; },
    'computer-use-pip:set-visibility': async context => {
      caller(context); selectWindow(context.senderId);
      return await ownerAction(context.senderId, () => service.setVisibility(context.senderId, arg0(context.args))) as unknown as Json;
    },
    'computer-use-pip:set-host-layout': async context => {
      const host = caller(context), documentRevision = host.documentRevision;
      const layout = normalizePipHostLayout(arg0(context.args)); host.layout = layout;
      if (context.senderId !== id) return { ok: true };
      try { await ready(context.senderId); }
      catch (error) {
        if (host.documentRevision !== documentRevision || context.senderId === id) throw error;
        return { ok: true };
      }
      if (host.documentRevision !== documentRevision) throw new Error('Picture-in-Picture document changed before applying its layout');
      if (context.senderId === id && host.layout === layout) service.setHostLayout(context.senderId, layout);
      return { ok: true };
    },
  }, 'computer-use-pip-runtime');

  const attachWindow = (owner: BrowserWindow): void => {
    const contents = owner.webContents, ownerId = contents.id;
    if (hosts.has(ownerId)) return;
    if (closing || owner.isDestroyed()) throw new Error('Picture-in-Picture window owner is unavailable');
    const host: Host = { window: owner, loaded: !contents.isLoadingMainFrame(), documentRevision: 0, zoomFactor: contents.getZoomFactor?.() ?? 1, detach() {} };
    hosts.set(ownerId, host);
    const active = () => ownerId === id && hosts.get(ownerId) === host;
    const visibilityChanged = () => {
      if (closing || !active()) return;
      syncVisibility(); report(reconcile()); wake();
      if (!visibilityCheck) visibilityCheck = setImmediate(() => {
        visibilityCheck = undefined;
        if (!closing) { syncVisibility(); report(reconcile()); wake(); }
      });
    };
    const hide = () => {
      if (closing || !active()) return;
      visibilityChanged();
      if (wanted) deps.log('pip-owner', 'Ignored a stale hide event for a visible window');
    };
    const invalidate = () => {
      host.loaded = false; host.layout = undefined; host.documentRevision++;
      if (!closing && active()) { loaded = false; revision++; report(reconcile()); wake(); }
    };
    const navigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => { if (details.isMainFrame && !details.isSameDocument) invalidate(); };
    const finished = () => {
      host.loaded = true; host.zoomFactor = contents.getZoomFactor?.() ?? 1;
      if (!closing && active()) { loaded = true; report(reconcile()); wake(); }
    };
    const focus = () => {
      if (!closing && !owner.isDestroyed() && isTrustedAppUrl(contents.getURL())) selectWindow(ownerId);
    };
    const zoom = () => {
      if (owner.isDestroyed()) return;
      host.zoomFactor = contents.getZoomFactor?.() ?? 1;
      if (!closing && active()) service.zoomChanged(host.zoomFactor);
    };
    const destroyed = () => {
      const wasActive = active();
      invalidate(); host.detach(); hosts.delete(ownerId);
      if (!closing && wasActive) { wanted = false; loaded = false; revision++; report(reconcile()); wake(); }
      if (!closing && ownerId === id) {
        const replacement = [...hosts.values()].find(item => !item.window.isDestroyed() && item.window.isVisible() && !item.window.isMinimized() && isTrustedAppUrl(item.window.webContents.getURL()))
          ?? [...hosts.values()].find(item => !item.window.isDestroyed() && isTrustedAppUrl(item.window.webContents.getURL()));
        if (replacement) selectWindow(replacement.window.webContents.id);
      }
    };
    owner.on('focus', focus); owner.on('show', visibilityChanged); owner.on('hide', hide); owner.on('minimize', visibilityChanged); owner.on('restore', visibilityChanged); owner.on('closed', destroyed);
    contents.on('did-start-navigation', navigation); contents.on('did-finish-load', finished);
    contents.on('render-process-gone', invalidate); contents.on('destroyed', destroyed);
    contents.on('zoom-changed', zoom);
    host.detach = () => {
      owner.removeListener('focus', focus); owner.removeListener('show', visibilityChanged); owner.removeListener('hide', hide); owner.removeListener('minimize', visibilityChanged); owner.removeListener('restore', visibilityChanged); owner.removeListener('closed', destroyed);
      contents.removeListener('did-start-navigation', navigation); contents.removeListener('did-finish-load', finished);
      contents.removeListener('render-process-gone', invalidate); contents.removeListener('destroyed', destroyed); contents.removeListener('zoom-changed', zoom);
    };
  };
  attachWindow(window);
  report(reconcile());

  return {
    service, ready, getState, attachWindow,
    observe: (events: readonly unknown[]) => service.observe(events),
    zoomChanged: (factor: number) => { const host = hosts.get(id); if (host) host.zoomFactor = factor; service.zoomChanged(factor); },
    async attachOwner(ownerId = id): Promise<void> { selectWindow(ownerId); syncVisibility(); report(reconcile()); await ready(ownerId); },
    async detachOwner(ownerId = id, deadlineMs = duration): Promise<{ complete: boolean }> {
      if (ownerId !== id) return { complete: true };
      wanted = false; revision++; wake(); return settle(performance.now() + budget(deadlineMs));
    },
    shutdown(deadlineMs = duration): Promise<{ complete: boolean }> {
      if (shutdownFlight) return shutdownFlight;
      closing = true; wanted = false; revision++; wake();
      if (visibilityCheck) { clearImmediate(visibilityCheck); visibilityCheck = undefined; }
      for (const host of hosts.values()) host.detach();
      const deadline = performance.now() + budget(deadlineMs);
      const task = (async () => {
        const prior = await settle(deadline);
        const final = await within(service.close(Math.max(0, deadline - performance.now())), deadline);
        return { complete: prior.complete && final.complete };
      })();
      shutdownFlight = task;
      void task.finally(() => { if (shutdownFlight === task) shutdownFlight = undefined; wake(); }).catch(() => {});
      return task;
    },
  };
}

export { PIP_PUSH_CHANNEL };
