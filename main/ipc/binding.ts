// The Electron IPC binding, written WITHOUT importing Electron.
//
// This is the glue between `ipcMain.handle('ipc_invoke', …)` and `IpcRouter.route`.
// It is deliberately Electron-free and expressed against structural interfaces
// (`WebContentsLike`, `FrameLike`) so the two pieces of logic that actually matter are
// testable in plain Node:
//
//   1. HOW THE CALLER'S ROLE IS ESTABLISHED. Not from the payload. A renderer that
//      could declare its own role could declare `main` and take the full 370-channel
//      surface, so the role comes from the app's own window registry, keyed by the
//      sending WebContents id — the one thing a page cannot forge. Plan §6.2 item 3
//      ("主进程验证 sender/frame、允许的窗口角色") is only real if this holds.
//   2. THAT THE HANDLER NEVER REJECTS. Measured, not assumed: when an `ipcMain.handle`
//      listener throws or rejects, Electron replaces the payload with
//      `Error("Error invoking remote method '<channel>': <String(thrown)>")`. A thrown
//      convention-A envelope therefore arrives at the renderer as the literal text
//      "[object Object]", with `error.message` gone — the exact failure
//      `bridge/ipc.ts:80-91` warns about. Resolving with the outcome and letting the
//      PRELOAD reject preserves the envelope intact (verified: a resolved plain object
//      survives both `ipcMain.handle` and `contextBridge` with all its fields).
//
// The same reasoning applies to the reverse direction: `webContents.send(event,
// payload)` is what delivers a host push, and the payload keeps its `{args:[…]}`
// wrapper so `ipc.ts:116-119` can spread it unchanged.

import type { Json } from './contract';
import { ipcError } from './errors';
import type { CallerIdentity, RouteOutcome } from './router';
import { FORBIDDEN_CHANNEL_CODE } from './router';
import type { PushTarget, PushTransport } from './push';
import { pushEventName } from './push';
import { isTrustedAppUrl } from '../app/trusted-origin';

/**
 * The structural slice of Electron's `WebFrameMain` this module needs.
 *
 * `routingId` is the stable per-frame identifier; comparing the sender's frame against
 * its WebContents' `mainFrame` is how "is this the top frame" is answered without
 * depending on `WebFrameMain.top`'s self-reference semantics.
 */
export interface FrameLike {
  readonly routingId: number;
  readonly processId: number;
  readonly url: string;
  isDestroyed(): boolean;
}

/** The structural slice of Electron's `WebContents`. */
export interface WebContentsLike {
  readonly id: number;
  readonly mainFrame: FrameLike;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

/** The structural slice of Electron's `IpcMainInvokeEvent`. */
export interface InvokeEventLike {
  readonly sender: WebContentsLike;
  /** May be null if the frame navigated or was destroyed before the message arrived. */
  readonly senderFrame: FrameLike | null;
}

/**
 * The wire answer to a renderer invoke.
 *
 * This is what crosses the IPC boundary — NOT a `RouteOutcome`, which carries a `kind`
 * field the renderer has no use for. The preload reads `ok` and either resolves
 * `value` or rejects `error`, which is what makes convention A a real rejection at the
 * page while convention B stays a resolution (see `./errors.ts`).
 */
export type InvokeReply =
  | { ok: true; value: Json }
  | { ok: false; error: { code: string; message: string; channel?: string } };

/** Maps a sending WebContents id to the window role the APP assigned at creation. */
export type RoleResolver = (senderId: number) => string | undefined;

/**
 * Why an invoke could not be attributed to a caller.
 *
 * Kept as a distinct outcome from a routing refusal because each of these is a
 * main-process invariant failure rather than a page doing something disallowed, and
 * they should be logged differently: a window with no registered role means the app
 * forgot to register it, not that a renderer misbehaved.
 */
export type AttributionFailure =
  /** The sender is not in the window registry, so its role is unknown. */
  | 'unregistered-sender'
  /** The sender's WebContents or frame was already gone when the message arrived. */
  | 'destroyed-sender'
  /** The message came from a frame that is not its WebContents' top frame. */
  | 'subframe'
  | 'untrusted-document';

export type Attribution =
  | { ok: true; identity: CallerIdentity }
  | { ok: false; failure: AttributionFailure; senderId: number; detail: string };

/**
 * Establish who is calling, from the event alone.
 *
 * Order matters: the destroyed check comes first because reading `mainFrame.routingId`
 * on a torn-down WebContents is the thing most likely to throw, and the subframe check
 * comes before the role lookup so a subframe is refused even if it somehow belongs to
 * a registered window. Every branch is a refusal rather than a guess.
 */
export function attributeCaller(event: InvokeEventLike, roleOf: RoleResolver): Attribution {
  const senderId = event.sender.id;

  if (isGone(event.sender) || (event.senderFrame !== null && isGone(event.senderFrame))) {
    return {
      ok: false,
      failure: 'destroyed-sender',
      senderId,
      detail: 'the sending frame was destroyed before the message arrived',
    };
  }

  // A null senderFrame is Electron telling us the frame navigated or was destroyed
  // after the message was sent. Treat it as a non-top frame rather than as the top
  // frame: assuming the favourable case here would let a message from a vanished
  // subframe be attributed to the window's full privilege.
  const frame = event.senderFrame;
  if (frame === null) {
    return {
      ok: false,
      failure: 'subframe',
      senderId,
      detail: 'the message carried no sender frame',
    };
  }
  if (!isTopFrame(frame, event.sender)) {
    return {
      ok: false,
      failure: 'subframe',
      senderId,
      detail: `frame ${frame.routingId} is not the top frame of webContents ${senderId}`,
    };
  }

  // The role comes from the APP's window registry, never from the payload.
  if (!isTrustedAppUrl(frame.url)) {
    return { ok: false, failure: 'untrusted-document', senderId, detail: 'IPC requires the local application document' };
  }
  const role = roleOf(senderId);
  if (role === undefined) {
    return {
      ok: false,
      failure: 'unregistered-sender',
      senderId,
      detail: `webContents ${senderId} has no registered window role`,
    };
  }

  return { ok: true, identity: { role, senderId, senderFrameIsTop: true } };
}

/**
 * Whether `frame` is the top-level frame of `contents`.
 *
 * Compared by `routingId` rather than by object identity or by `frame.top === frame`,
 * because identity is not guaranteed across the IPC boundary and `top` is documented as
 * nullable. A mismatch means the message came from an iframe.
 *
 * The main window really does contain iframes: `workspace-panel.ts:1021-1023` renders
 * AGENT-AUTHORED html with `sandbox="allow-scripts"` and deliberately no
 * `allow-same-origin`. Those frames get no preload (so no bridge), but this check is
 * what makes the guarantee independent of how the window was configured — and it is
 * why `nodeIntegrationInSubFrames` must stay at its default `false`.
 */
export function isTopFrame(frame: FrameLike, contents: WebContentsLike): boolean {
  return frame.routingId === contents.mainFrame.routingId && frame.processId === contents.mainFrame.processId;
}

/** Guard every property read on an object Electron may have already torn down. */
function isGone(target: WebContentsLike | FrameLike): boolean {
  try {
    return target.isDestroyed();
  } catch {
    // A destroyed Electron object can throw on access. Treat that as "gone".
    return true;
  }
}

/**
 * The refusal an attribution failure produces on the wire.
 *
 * Uses the same `FORBIDDEN_CHANNEL` code as a role refusal so a page cannot
 * distinguish "I am not who I claim" from "I may not call this" — but the message
 * names the real reason, because these are main-process bugs that a developer has to
 * be able to diagnose from the renderer console.
 */
export function attributionRefusal(failure: AttributionFailure, detail: string): InvokeReply {
  return {
    ok: false,
    error: {
      code: FORBIDDEN_CHANNEL_CODE,
      message: `${failure}: ${detail}`,
    },
  };
}

/** Turn a router outcome into the wire reply, dropping the log-only `kind` field. */
export function toReply(outcome: RouteOutcome): InvokeReply {
  return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error.error };
}

/**
 * The `ipc_invoke` handler body.
 *
 * This is the function the app passes to `ipcMain.handle('ipc_invoke', …)`. It resolves
 * with an `InvokeReply` on EVERY path, including attribution failures and a payload
 * that is not the `{channel, args}` the bridge sends — never rejects, for the reason
 * documented at the top of this file.
 *
 * The payload shape mirrors the retired Rust shell's `ipc_invoke(channel, args)` command,
 * which the bridge calls as `invoke('ipc_invoke', { channel, args })` (see `call` and
 * `post` in `bridge/ipc.ts`).
 */
export interface InvokeDeps {
  route: (identity: CallerIdentity, channel: string, args: Json[]) => Promise<RouteOutcome>;
  roleOf: RoleResolver;
  /** Called for refusals that are main-process invariant failures, for the log. */
  onAttributionFailure?: (failure: AttributionFailure, detail: string, senderId: number) => void;
}

export async function handleInvoke(
  deps: InvokeDeps,
  event: InvokeEventLike,
  payload: unknown,
): Promise<InvokeReply> {
  const attribution = attributeCaller(event, deps.roleOf);
  if (!attribution.ok) {
    deps.onAttributionFailure?.(attribution.failure, attribution.detail, attribution.senderId);
    return attributionRefusal(attribution.failure, attribution.detail);
  }

  // A payload that is not `{channel, args}` cannot be routed. This is not a channel
  // refusal but a malformed call, so it gets its own code rather than NOT_MIGRATED —
  // reporting it as an unmigrated channel would send a developer looking for a missing
  // capability port when the real problem is the caller's shape.
  if (payload === null || typeof payload !== 'object') {
    return {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'ipc_invoke expects { channel, args }' },
    };
  }
  const { channel, args } = payload as { channel?: unknown; args?: unknown };
  if (typeof channel !== 'string' || channel.length === 0) {
    return {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'ipc_invoke expects a non-empty string `channel`' },
    };
  }
  if (args !== undefined && !Array.isArray(args)) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'IPC args must be an array' } };
  }
  const safeArgs = (args ?? []) as Json[];

  const outcome = await deps.route(attribution.identity, channel, safeArgs);
  return toReply(outcome);
}

/**
 * A `PushTransport` over Electron `WebContents`.
 *
 * `fromId` is injected rather than imported so this class stays Electron-free and can
 * be tested with fakes. A destroyed or already-closed renderer is reported as gone and
 * skipped; `PushBroadcaster.deliver` swallows a throw per target, so throwing here
 * would be safe too, but returning quietly keeps the delivered count honest.
 */
export class WebContentsPushTransport implements PushTransport {
  constructor(
    private readonly fromId: (id: number) => WebContentsLike | undefined,
    /** Called when a target could not be reached, for the log. */
    private readonly onUnreachable?: (target: PushTarget, event: string) => void,
  ) {}

  send(target: PushTarget, event: string, payload: { args: Json[] }): void {
    const contents = this.fromId(target.id);
    if (contents === undefined || isGone(contents) || !isTrustedAppUrl(contents.mainFrame.url)) {
      this.onUnreachable?.(target, event);
      return;
    }
    contents.send(event, payload);
  }
}

/**
 * The window-role registry the main process owns.
 *
 * This is the authority behind `roleOf`. A window registers when it is created and
 * unregisters when it is destroyed; nothing the renderer sends can change an entry,
 * which is what makes the role unforgeable. `PushBroadcaster` uses the same entries as
 * its target list, so a window that is closed stops receiving pushes without a second
 * bookkeeping structure to keep in sync.
 */
export class WindowRoleRegistry {
  private readonly roles = new Map<number, string>();

  /** Record the role of a newly created window's WebContents. */
  register(senderId: number, role: string): void {
    this.roles.set(senderId, role);
  }

  /** Drop a destroyed window. Idempotent, so a double-destroy is harmless. */
  unregister(senderId: number): void {
    this.roles.delete(senderId);
  }

  /** The role resolver to hand to `handleInvoke` and to window creation. */
  resolver(): RoleResolver {
    return (senderId) => this.roles.get(senderId);
  }

  /** Every registered window as a push target. */
  targets(): PushTarget[] {
    return [...this.roles.entries()].map(([id, role]) => ({ id, role }));
  }

  /** The role of one window, for diagnostics. */
  roleOf(senderId: number): string | undefined {
    return this.roles.get(senderId);
  }

  /** How many windows are registered. */
  size(): number {
    return this.roles.size;
  }
}

/**
 * The one channel name every window invokes.
 *
 * Named as the retired Rust shell's command was (`ipc_invoke`), because `call` and `post`
 * in `bridge/ipc.ts` hard-code it and §6.2 requires the frontend to load unchanged.
 */
export const INVOKE_CHANNEL = 'ipc_invoke';

/**
 * The window plugin commands `core.invoke` must also answer.
 *
 * `webview-integration.ts` calls these two directly through `__KLAUS_DESKTOP__.core.invoke`
 * rather than through a channel, because they are window operations rather than host
 * capabilities. They are NOT router channels and must not be added to the contract's
 * invoke registry — they are answered by the binding itself.
 */
export const WINDOW_PLUGIN_COMMANDS = {
  /**
   * Starts a native window drag.
   *
   * Electron 44 has NO programmatic window-drag API (verified: zero occurrences of
   * `startWindowDragging` in `electron.d.ts`; `webContents.startDrag` is file
   * drag-and-drop, a different thing). The only mechanism is the Chromium CSS property
   * `-webkit-app-region: drag`, and the UI already declares it comprehensively across
   * every frameless surface — verified by scanning all css/html:
   *
   *   css/styles.css:400    .app-titlebar-controls (also pointer-events:none)
   *   css/styles.css:447    .app-titlebar-title    (also pointer-events:none)
   *   css/styles.css:6505   .boot-screen
   *   css/styles.css:6573   .login-screen
   *   css/artifact.css:62   .aw-titlebar
   *   quick-input.html:45   .qi-card
   *   recorder.html:21      the recorder's title strip
   *
   * ...plus ~40 `no-drag` carve-outs (`styles.css:268`, `:426`, `:470`, and so on) that
   * exempt buttons, inputs and links from the regions above.
   *
   * Those declarations are DEAD in WKWebView — which is the entire reason
   * `webview-integration.ts:55-95` implements a JS drag path calling this command (see
   * its comment at lines 12-22: "WKWebView does not implement the Chromium-only
   * `-webkit-app-region` CSS property"). Electron IS Chromium, so every region above is
   * live here and the JS path is redundant. This command therefore resolves as a no-op
   * rather than rejecting: the caller does `.catch(() => {})` either way, and a
   * rejection would misreport a capability that genuinely exists, just by a different
   * mechanism.
   *
   * One real-platform question remains, and it cannot be answered headlessly: whether a
   * region that is ALSO `pointer-events: none` (`.app-titlebar-controls`,
   * `.app-titlebar-title`) still produces a draggable strip. Chromium computes
   * draggable regions during paint and is believed to honour them independently of
   * pointer-events, but `sendInputEvent` injects below the browser's non-client
   * hit-testing — measured: a drag region and a plain region both "receive" a synthetic
   * mousedown — so it cannot be settled by automation. Pinned as a P1.4 acceptance item
   * under §11's "IME、窗口遮挡… 仍需要真实平台验收", and note the two pointer-events:none
   * regions are exactly the ones the JS fallback was written to cover geometrically
   * (`webview-integration.ts:70-78` tests the box because such a strip never appears in
   * the event path).
   */
  startDragging: 'window:start-dragging',
  /**
   * Toggles maximize. Unlike dragging this DOES have a real Electron API, so the
   * binding implements it: `isMaximized()` then `maximize()`/`unmaximize()`.
   * `webview-integration.ts:87-95` calls it on a double-click in a drag region, which
   * is the macOS/Windows zoom convention.
   */
  toggleMaximize: 'window:toggle-maximize',
} as const;

/**
 * The window operations the shim's `getCurrentWindow()` needs, answered by the main
 * process so that POLICY stays in one place.
 *
 * `close()` is the important one: `close_hides_window(label)` is true for exactly the
 * main window (`main.rs:7069-7071`, pinned by the test at `main.rs:8742`), and its
 * `CloseRequested` handler calls `prevent_close()` then `hide()` (`main.rs:8056-8062`).
 * So a main-window `close()` must HIDE — the app keeps running behind the tray — while
 * every other window really closes. That is a shell policy, not a page decision, so the
 * preload asks the main process and never decides for itself.
 */
export const WINDOW_OPS_CHANNEL = 'klaus:window-op';

/** One window operation request. */
export type WindowOp =
  | { op: 'isFullscreen' }
  | { op: 'close' }
  | { op: 'toggleMaximize' }
  | { op: 'startDragging' };

/**
 * Apply a window operation, given the window's own control surface.
 *
 * `WindowControls` is structural so this stays testable: the app supplies the real
 * `BrowserWindow`, the tests supply a recorder. Returns the reply to send back.
 */
export interface WindowControls {
  isFullScreen(): boolean;
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
  /** Really close the window. */
  close(): void;
  /** Hide without closing; the app keeps running. */
  hide(): void;
}

/**
 * Does closing this window hide it instead?
 *
 * The port of `close_hides_window(label) == (label == "main")`. Keyed by ROLE rather
 * than by label because role is what the rest of this host reasons in, and the mapping
 * is one-to-one for the main window. Pinned by the shell's own test
 * (`main.rs:8742-8745`: main hides, the overlay does not).
 */
export function closeHidesWindow(role: string): boolean {
  return role === 'main';
}

/**
 * Handle one window operation.
 *
 * Never throws: an operation on a window that vanished mid-call is answered as a
 * soft failure rather than crashing the main process, matching the shell's habit of
 * `let _ = window.hide()` (ignoring the result) at `main.rs:8060`.
 */
export function handleWindowOp(
  op: WindowOp,
  role: string,
  controls: WindowControls,
): { ok: true; value: Json } | { ok: false; error: string } {
  try {
    switch (op.op) {
      case 'isFullscreen':
        return { ok: true, value: controls.isFullScreen() };
      case 'close':
        // The main window HIDES; everything else closes. See closeHidesWindow.
        if (closeHidesWindow(role)) controls.hide();
        else controls.close();
        return { ok: true, value: null };
      case 'toggleMaximize':
        if (controls.isMaximized()) controls.unmaximize();
        else controls.maximize();
        return { ok: true, value: null };
      case 'startDragging':
        // No Electron API exists; the CSS `-webkit-app-region: drag` regions already in
        // the UI are the mechanism in Chromium. Resolving is honest: the drag works,
        // just not through this call. See WINDOW_PLUGIN_COMMANDS.startDragging.
        return { ok: true, value: null };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Answer one `core.invoke` command.
 *
 * The shim exposes exactly ONE invoke entry point, and this is where its three
 * commands part ways: `ipc_invoke` goes to the router, the two window plugin commands
 * go to the window operation path. Anything else is refused with a distinct code,
 * because a command name the shim does not know means the frontend started using a
 * `__KLAUS_DESKTOP__` member this host has not implemented — which the contract test is also
 * designed to catch statically.
 */
export interface InvokeCommandDeps extends InvokeDeps {
  /** Run a window operation for the calling window. */
  windowOp: (senderId: number, op: WindowOp) => Promise<Json> | Json;
}

export async function handleCoreInvoke(
  deps: InvokeCommandDeps,
  event: InvokeEventLike,
  command: string,
  args: unknown,
): Promise<InvokeReply> {
  switch (command) {
    case INVOKE_CHANNEL:
      return handleInvoke(deps, event, args);
    case WINDOW_PLUGIN_COMMANDS.startDragging:
      return runWindowOp(deps, event, { op: 'startDragging' });
    case WINDOW_PLUGIN_COMMANDS.toggleMaximize:
      return runWindowOp(deps, event, { op: 'toggleMaximize' });
    default:
      return {
        ok: false,
        error: {
          code: 'UNKNOWN_COMMAND',
          message: `unknown __KLAUS_DESKTOP__.core.invoke command '${command}'`,
        },
      };
  }
}

/** Run one window operation, attributing the caller first. */
async function runWindowOp(
  deps: InvokeCommandDeps,
  event: InvokeEventLike,
  op: WindowOp,
): Promise<InvokeReply> {
  const attribution = attributeCaller(event, deps.roleOf);
  if (!attribution.ok) {
    deps.onAttributionFailure?.(attribution.failure, attribution.detail, attribution.senderId);
    return attributionRefusal(attribution.failure, attribution.detail);
  }
  try {
    return { ok: true, value: await deps.windowOp(attribution.identity.senderId, op) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'HOST_ERROR',
        message: `window op '${op.op}' failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

/**
 * Re-export the shared channel names so the main-process side imports them from here.
 * The constants live in `./host-channels` (dependency-free) precisely so a preload can
 * bundle them too without dragging in the rest of this module's graph — see that file.
 */
export { HOST_CHANNELS } from './host-channels';

/** Build the event name for a push, re-exported so callers need one import. */
export { pushEventName };

/**
 * The refusal a preload gets when it cannot even reach the main process.
 *
 * `ipcRenderer.invoke` rejects with an Electron-wrapped Error when there is no
 * handler at all. The preload converts that into the convention-A envelope shape so
 * `ipc.ts` still finds an `error.message` and the UI still reads something sensible
 * instead of "[object Object]".
 */
export function transportFailure(detail: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: ipcError('TRANSPORT_ERROR', detail).error };
}
