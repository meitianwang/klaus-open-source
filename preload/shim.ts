// Isolated Electron bridge shared by the five preload entry points.
// Each entry grants only the members its document uses. The main process remains
// authoritative for channel permissions, using its own WebContents role registry.
// Calls return structured envelopes so Electron cannot discard error details.
// Subscriptions resolve to disposable functions across contextBridge.

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { isTrustedAppUrl } from '../main/app/trusted-origin';

// The import above is bundled, not resolved at runtime: a sandboxed preload cannot
// `require` a relative module (verified on Electron 44 — "module not found", and only
// `electron`, `events`, `url`, `timers` are available). `scripts/build-preload.mjs`
// bundles each entry with esbuild, which inlines `host-channels.ts`. That module imports
// nothing, so it can be inlined without dragging `contract.ts` (which reads the channel
// table with `fs`) into a renderer-adjacent bundle. Sharing the names is what makes the
// two sides of the boundary agree by construction rather than by a drift check.

/** The wire reply from the main process. Mirrors `InvokeReply` in the binding. */
interface Reply {
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; channel?: string };
}

/** Which shim members a window's preload publishes. Everything defaults to off. */
export interface ShimCapabilities {
  /** Resolve disk-backed browser Files in the main chat document only. */
  localFiles?: boolean;
  /** Publish `core.invoke`, routing to the main process. Needed by any bridge. */
  invoke: boolean;
  /**
   * Publish `event.listen`, delivering host pushes.
   *
   * Off for canvas: `bridge/canvas-api.ts` imports only `call` and `expose`, has no
   * `subscribe(` anywhere in its 137 lines, and that page evaluates model-authored
   * code — a listener it cannot use is a channel model-authored code could abuse.
   */
  listen: boolean;
  /**
   * Publish `window.getCurrentWindow()`.
   *
   * Only main/artifact (through `webview-integration.ts`) and recorder (`close()` at
   * `recorder.html:81`) need it.
   */
  window: boolean;
  /**
   * Which `getCurrentWindow()` members to publish. Ignored unless `window` is on.
   *
   * The recorder needs `close` alone; main needs all three. Listing them per window is
   * what keeps the surface minimal instead of publishing the union everywhere.
   */
  windowMembers?: ReadonlyArray<'isFullscreen' | 'onResized' | 'close'>;
  /**
   * Whether this window may answer the two `plugin:window|*` commands.
   *
   * Only windows whose bridge pulls in `webview-integration.ts` (main and artifact)
   * ever call them. Off elsewhere, so a canvas page asking the host to maximize the
   * window is refused rather than acted on.
   */
  windowPluginCommands?: boolean;
}

/** Read the role the app injected, or null if it did not. */
function injectedRole(): string | null {
  const prefix = '--klaus-role=';
  for (const arg of process.argv) {
    if (typeof arg === 'string' && arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

/**
 * Turn a reply into the promise the bridge expects.
 *
 * `ok:true` resolves with `value` — INCLUDING `null`, because `ipc.ts:76-79` maps
 * `null` to `undefined` for `settings:kv:get` itself and doing it here instead would
 * put that contract in two places. `ok:false` rejects with the envelope rebuilt around
 * `error`, which is what `ipc.ts:80-89` unwraps into a real `Error` with `.data`.
 */
function unwrap(reply: Reply): Promise<unknown> {
  if (reply && reply.ok) return Promise.resolve(reply.value);
  const error = reply?.error ?? { code: 'HOST_ERROR', message: 'the host returned no error detail' };
  // Rebuild the convention-A envelope rather than rejecting with `error` alone:
  // ipc.ts reads `raw.error.message` and stores the whole payload as `err.data`, and
  // some callers inspect `err.data.error.channel`.
  return Promise.reject({ ok: false, error });
}

/**
 * Convert an unreachable main process into a convention-A envelope.
 *
 * `ipcRenderer.invoke` rejects with Electron's own wrapped Error when no handler
 * exists. Letting that through would give `ipc.ts` a rejection whose `error.message` is
 * missing, reproducing the "[object Object]" alert. Naming the real cause matters: a
 * missing handler is a host bug (the binding was not installed, or the channel name
 * drifted), not a renderer misbehaving.
 */
function transportRejection(detail: string): Promise<never> {
  return Promise.reject({
    ok: false,
    error: { code: 'TRANSPORT_ERROR', message: `the host did not answer: ${detail}` },
  });
}

/**
 * Install the shim for this window.
 *
 * Called once per preload entry. Publishing is all-or-nothing per capability: a
 * capability that is off is absent from the exposed object rather than present and
 * throwing, so `typeof window.__KLAUS_DESKTOP__.event === 'undefined'` is the honest answer for
 * a window that may not listen. `bridge/canvas-api.ts:131` already probes the shim that
 * way (`hasDesktopHost()`), so absence is a state the frontend is written to handle.
 */
export function installShim(capabilities: ShimCapabilities): void {
  const role = injectedRole();

  const shim: Record<string, unknown> = {};

  const documentUrl = (globalThis as { location?: { href: string } }).location?.href;
  if (capabilities.localFiles && role === 'main' && process.isMainFrame && isTrustedAppUrl(documentUrl ?? '')) {
    shim.files = { getPathForFile: (file: File): string => webUtils.getPathForFile(file) };
  }

  if (capabilities.invoke) {
    shim.core = {
      /**
       * The single invoke entry point.
       *
       * `ipc_invoke` carries `{channel, args}` to the router. The two
       * `plugin:window|*` commands are answered by the main process's window path, and
       * are refused for windows that did not opt in — a canvas page has no business
       * maximizing the app.
       */
      invoke: (command: string, args?: unknown): Promise<unknown> => {
        if (typeof command !== 'string') return transportRejection('the command name was not a string');
        const isPluginCommand = command.startsWith('plugin:window|');
        if (isPluginCommand && capabilities.windowPluginCommands !== true) {
          // Refused here rather than forwarded: the frontend calls these with
          // `.catch(() => {})` (webview-integration.ts:93,95), so a rejection is
          // already the handled path, and not forwarding means a window that cannot
          // drag also cannot ask the host to try.
          return transportRejection(`'${command}' is not available to this window`);
        }
        return ipcRenderer
          .invoke(HOST_CHANNELS.coreInvoke, { command, args, role })
          .then(
            (reply: Reply) => unwrap(reply),
            (error: unknown) => transportRejection(error instanceof Error ? error.message : String(error)),
          );
      },
    };
  }

  if (capabilities.listen) {
    type Listener = (event: { payload: unknown }) => unknown;
    const listeners = new Map<string, Set<Listener>>();
    ipcRenderer.on(HOST_CHANNELS.delivery, (_event, packet: { deliveryId: string; event: string; payload: unknown }) => {
      if (!packet || typeof packet.deliveryId !== 'string' || typeof packet.event !== 'string') return;
      const receivers = [...(listeners.get(packet.event) ?? [])];
      // A PTY consumer resolves only after xterm has parsed this chunk. Missing
      // consumers fail explicitly; silently dropping terminal bytes is not an ACK.
      void Promise.all(receivers.map(async handler => handler({ payload: packet.payload }))).then(
        () => ipcRenderer.send(HOST_CHANNELS.deliveryAck, { deliveryId: packet.deliveryId, ok: receivers.length > 0 }),
        () => ipcRenderer.send(HOST_CHANNELS.deliveryAck, { deliveryId: packet.deliveryId, ok: false }),
      );
    });
    shim.event = {
      /**
       * Register a push listener; resolve with its disposer.
       *
       * The promise wrapper is the subscription shape `ipc.ts:117-125` expects, and resolving
       * asynchronously (rather than returning the function) also means a subscriber that
       * disposes before the promise settles still works — `ipc.ts` guards that with its
       * own `disposed` flag.
       */
      listen: (name: string, handler: Listener): Promise<() => void> => {
        if (typeof name !== 'string' || !name.startsWith('ipc:') || typeof handler !== 'function') {
          return Promise.reject(new Error('listen expects (eventName, handler)'));
        }
        const receivers = listeners.get(name) ?? new Set<Listener>();
        receivers.add(handler);
        listeners.set(name, receivers);
        const wrapped = (_event: unknown, payload: unknown): void => {
          try {
            void Promise.resolve(handler({ payload })).catch(() => {});
          } catch {
            // A throwing subscriber must not stop its neighbours on the same channel,
            // and must not escape into Electron's dispatch loop where it would surface
            // as an unhandled error with no channel name attached.
          }
        };
        ipcRenderer.on(name, wrapped);
        if (receivers.size === 1) ipcRenderer.send(HOST_CHANNELS.listenerState, { channel: name.slice(4), active: true });
        return Promise.resolve(() => {
          ipcRenderer.removeListener(name, wrapped);
          receivers.delete(handler);
          if (!receivers.size) {
            listeners.delete(name);
            ipcRenderer.send(HOST_CHANNELS.listenerState, { channel: name.slice(4), active: false });
          }
        });
      },
    };
  }

  if (capabilities.window) {
    const members = new Set(capabilities.windowMembers ?? []);
    const currentWindow: Record<string, unknown> = {};

    // Every member goes to the main process, because the POLICY lives there: whether
    // `close()` hides or closes depends on the window's role
    // (`close_hides_window("main") == true`, main.rs:7069-7071, so the main window
    // hides and the app keeps running behind the tray). A preload deciding that itself
    // would put shell policy in six places.
    const sendOp = (op: string): Promise<unknown> =>
      ipcRenderer.invoke(HOST_CHANNELS.windowOp, { op, role }).then(
        (reply: Reply) => unwrap(reply),
        (error: unknown) => transportRejection(error instanceof Error ? error.message : String(error)),
      );

    if (members.has('isFullscreen')) {
      currentWindow.isFullscreen = (): Promise<unknown> => sendOp('isFullscreen');
    }
    if (members.has('onResized')) {
      currentWindow.onResized = (callback: () => void): Promise<() => void> => {
        // onResized resolves with an unlisten function. The resize itself is
        // pushed by the main process when the BrowserWindow resizes.
        const listener = (): void => {
          try {
            callback();
          } catch {
            // A throwing callback must not break the IPC dispatch loop.
          }
        };
        ipcRenderer.on(HOST_CHANNELS.resized, listener);
        return Promise.resolve(() => {
          ipcRenderer.removeListener(HOST_CHANNELS.resized, listener);
        });
      };
    }
    if (members.has('close')) {
      currentWindow.close = (): Promise<unknown> => sendOp('close');
    }

    shim.window = { getCurrentWindow: (): Record<string, unknown> => currentWindow };
  }

  // `exposeInMainWorld` copies the object into the page's isolated world. The shim is
  // published even when empty, because `bridge/canvas-api.ts:131` distinguishes
  // "running under a host" by `typeof window.__KLAUS_DESKTOP__ !== 'undefined'` — an absent
  // object would make a hosted canvas page take its dev-only branch.
  contextBridge.exposeInMainWorld('__KLAUS_DESKTOP__', shim);
}
