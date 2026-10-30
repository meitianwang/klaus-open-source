// The typed IPC router: ONE entry point, role-checked, for every caller.
//
// The shell's `ipc_invoke` is "one single entry point shared by the window and the
// mobile bridge, so a phone can never take a different code path than the window"
// (`main.rs:5173-5176`), and the agent's `klaus_query`/`klaus_action` tools are a
// third caller of the same router (`klaus_control.rs:15-22`). That property is
// preserved here: a renderer, the phone bridge and an agent tool all arrive as
// `(role, channel, args)` and take the identical path.
//
// What this ADDS, because the shell structurally cannot do it: caller identity.
// `ipc_invoke` takes no `Window` parameter (`main.rs:5147-5153`), so no Rust handler
// can see who called it and the crate has no channel gating at all — one capability
// file grants all six surfaces identically, and a canvas page can already reach all
// 375 channels. Plan §6.2 requires the main process to validate "sender/frame、允许
// 的窗口角色、参数与资源归属", so role checking is net-new rather than a port. The
// allowlists are the MEASURED surface each entry uses today (derived by
// `scripts/derive-channel-contract.mjs`), which is why enforcing them removes nothing
// a window actually calls.
//
// This module imports no Electron. The app binds it to `ipcMain.handle`; keeping the
// router pure is what lets `tests/ipc-router.test.ts` assert the exact error shapes
// and privilege refusals without launching a window.

import type { IpcError, Json } from './contract';
import { RoleTable } from './contract';
import { ipcError, notMigrated, resultKind } from './errors';
import { ChannelRegistry, IpcHandlerError, type HandlerContext } from './registry';
import { PushBroadcaster } from './push';
import { rpcErrorMessage } from '../engine/protocol';

/**
 * What the router answers.
 *
 * `ok:false` is convention A — the caller must REJECT the IPC promise with `error` as
 * the rejection payload, because `bridge/ipc.ts:80-91` only unwraps `error.message`
 * on the rejection path. Convention B (a resolved `{ok:false,error:"<string>"}`) is
 * not representable here at all: it is simply `ok:true` with that object as the
 * value, which is exactly why the two conventions cannot be collapsed. See
 * `./errors.ts`.
 */
export type RouteOutcome =
  | { ok: true; value: Json; kind: string }
  | { ok: false; error: IpcError; kind: string };

/**
 * Why a call was refused, for logging and tests.
 *
 * Kept separate from the wire `code` because two of these deliberately share a code
 * with an existing shell behaviour while meaning something different, and one is a
 * code the shell has no equivalent for.
 */
export type Refusal =
  /** The channel is not registered by any module. Mirrors the shell's `NOT_MIGRATED`. */
  | 'unknown-channel'
  /**
   * The channel EXISTS but this role may not call it.
   *
   * Deliberately NOT reported as `NOT_MIGRATED`: that code tells a developer the
   * capability is unimplemented, which would send them looking for a missing port
   * when the real situation is a privilege boundary working as designed. Conflating
   * the two would make a genuine least-privilege refusal look like a migration gap.
   */
  | 'role-not-permitted'
  /** The caller did not identify itself with a known role. */
  | 'unknown-role';

/** The wire code for a role that tried a channel outside its allowlist. */
export const FORBIDDEN_CHANNEL_CODE = 'FORBIDDEN_CHANNEL';

/**
 * The wire code for an exception a handler did not convert into an `IpcHandlerError`.
 *
 * The shell has no equivalent: every Rust handler returns `Result`, so an uncaught
 * panic is a process-level event rather than a wire answer. In TypeScript an uncaught
 * throw is routine (a rejected promise from a dependency, a TypeError on an
 * unexpected shape), and it must still reach the renderer as a convention-A envelope
 * — otherwise `ipc.ts` would receive a rejection whose payload is an `Error` object
 * with no `error.message`, and every UI alert for that failure would read
 * "[object Object]", which is precisely the defect that comment describes.
 */
export const HOST_ERROR_CODE = 'HOST_ERROR';

function handlerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return String(error);
  try {
    const prototype = Object.getPrototypeOf(error);
    if (prototype !== Object.prototype && prototype !== null) return 'unknown error';
    // AppServerClient constructs plain RpcError records. Read only their own data
    // fields, never arbitrary payloads, inherited properties or conversion hooks.
    const field = (key: string): unknown => Object.getOwnPropertyDescriptor(error, key)?.value;
    const kind = field('kind');
    switch (kind) {
      case 'server': {
        const code = field('code'), message = field('message');
        if (typeof code === 'number' && Number.isSafeInteger(code) && typeof message === 'string') return rpcErrorMessage({ kind, code, message });
        break;
      }
      case 'closed': return rpcErrorMessage({ kind });
      case 'io': {
        const message = field('message');
        if (typeof message === 'string') return rpcErrorMessage({ kind, message });
        break;
      }
      case 'timeout': {
        const method = field('method');
        if (typeof method === 'string') return rpcErrorMessage({ kind, method });
        break;
      }
    }
  } catch {
    // A rejected value can reject inspection too; it is not a trusted wire error.
  }
  return 'unknown error';
}

/**
 * The identity of whoever is calling.
 *
 * `senderFrameIsTop` carries the frame half of §6.2's "验证 sender/frame". The main
 * window renders AGENT-AUTHORED html in an iframe (`workspace-panel.ts:1021-1023`,
 * `sandbox="allow-scripts"` and deliberately no `allow-same-origin`, so the frame is
 * an opaque origin). With `nodeIntegrationInSubFrames` left at its default `false` a
 * subframe gets no preload and therefore no bridge — but the router must not rely on
 * that being configured correctly. A caller that is not the top frame of its
 * WebContents is refused, which makes the guarantee hold regardless of how the window
 * was built.
 */
export interface CallerIdentity {
  /** The window role, established by which preload the window was created with. */
  role: string;
  /** Stable id of the sending WebContents. */
  senderId: number;
  /** Whether the sender is the top-level frame of its WebContents. */
  senderFrameIsTop: boolean;
}

export interface RouterOptions {
  registry: ChannelRegistry;
  roles: RoleTable;
  broadcaster?: PushBroadcaster;
  /** Host-only identities cannot be supplied through the renderer route. */
  hostRoles?: Record<string, readonly string[]>;
  /**
   * Called for every routed call, with the wire-log fields. Optional because tests
   * assert on outcomes directly; the app supplies it so a channel answering with the
   * wrong JSON KIND is diagnosable at the boundary (see `resultKind`).
   */
  onRoute?: (entry: RouteLogEntry) => void;
}

/** One routed call, as the shell's two wire logs record it (`main.rs:5185-5191`, `:7028-7031`). */
export interface RouteLogEntry {
  channel: string;
  role: string;
  senderId: number;
  /** `ok`/`Err(CODE)` for a refusal, the JSON kind for a success. */
  result: string;
  /** Present only when the call was refused. */
  refusal?: Refusal;
  /** Milliseconds the handler took, so a slow channel is attributable. */
  elapsedMs: number;
}

export class IpcRouter {
  private readonly registry: ChannelRegistry;
  private readonly roles: RoleTable;
  private readonly broadcaster?: PushBroadcaster;
  private readonly onRoute?: (entry: RouteLogEntry) => void;
  private readonly hostRoles: Map<string, Set<string>>;

  constructor(options: RouterOptions) {
    this.registry = options.registry;
    this.roles = options.roles;
    this.broadcaster = options.broadcaster;
    this.onRoute = options.onRoute;
    this.hostRoles = new Map(Object.entries(options.hostRoles ?? {}).map(([role, channels]) => [role, new Set(channels)]));
  }

  /** The registry behind this router, for the contract test. */
  channelRegistry(): ChannelRegistry {
    return this.registry;
  }

  /**
   * Route one call.
   *
   * Never throws: every failure mode becomes a `RouteOutcome`. That is a deliberate
   * contract with the IPC binding — a throw escaping here would reject the renderer's
   * promise with an unstructured payload and reproduce the "[object Object]" alert the
   * bridge comment warns about.
   */
  async route(caller: CallerIdentity, channel: string, args: Json[] | undefined): Promise<RouteOutcome> {
    const startedAt = Date.now();
    const safeArgs = Array.isArray(args) ? args : [];

    // --- sender/frame and role validation ------------------------------------
    // Checked BEFORE the channel lookup so an unidentified caller learns nothing
    // about which channels exist: refusing on privilege first means the refusal for
    // an unknown role is identical whether or not the channel is real.
    if (!caller.senderFrameIsTop) {
      return this.refuse(caller, channel, safeArgs, startedAt, 'unknown-role',
        ipcError(FORBIDDEN_CHANNEL_CODE, 'calls from a subframe are not permitted'));
    }
    if (!this.roles.hasRole(caller.role as never)) {
      return this.refuse(caller, channel, safeArgs, startedAt, 'unknown-role',
        ipcError(FORBIDDEN_CHANNEL_CODE, `unknown window role '${caller.role}'`));
    }
    if (!this.roles.mayInvoke(caller.role as never, channel)) {
      // Distinguish "nobody may call this" from "this role may not": the first is a
      // migration gap and must say NOT_MIGRATED, the second is a privilege boundary.
      const registered = this.registry.lookup(channel) !== undefined;
      if (!registered) {
        return this.refuse(caller, channel, safeArgs, startedAt, 'unknown-channel', notMigrated(channel));
      }
      return this.refuse(caller, channel, safeArgs, startedAt, 'role-not-permitted',
        ipcError(
          FORBIDDEN_CHANNEL_CODE,
          `channel '${channel}' is not permitted for window role '${caller.role}'`,
        ));
    }

    // --- the renderer-ready latch --------------------------------------------
    // Flipped on EVERY call, exactly as `ipc_invoke` calls `mark_renderer_ready`
    // unconditionally and the function early-returns if already set (`main.rs:5158`,
    // `deep_link.rs:79-88`). The first invoke proves the shim registered its event
    // listeners, so cold-start pushes parked until now can be flushed. Done before
    // dispatch so a channel that throws still releases the latch — otherwise one
    // early failure would strand every parked deep link for the app's lifetime.
    this.broadcaster?.markRendererReady();

    // --- dispatch -------------------------------------------------------------
    const handler = this.registry.lookup(channel);
    if (!handler) {
      // Unreachable when the contract and registry agree (checked above via
      // `mayInvoke`), but kept as a hard failure rather than a silent undefined: a
      // contract row with no implementation must surface, per the no-silent-fallback
      // rule the shell's own `NOT_MIGRATED` arm documents.
      return this.refuse(caller, channel, safeArgs, startedAt, 'unknown-channel', notMigrated(channel));
    }

    return this.dispatch(caller, channel, safeArgs, startedAt, handler);
  }

  /** The authenticated host transport supplies its own cancellation and ownership checks. */
  async routeHost(role: string, channel: string, args: Json[], assertCurrent: () => void, signal: AbortSignal): Promise<RouteOutcome> {
    const caller = { role, senderId: -1, senderFrameIsTop: true }, startedAt = Date.now();
    if (!this.hostRoles.get(role)?.has(channel)) return this.refuse(caller, channel, args, startedAt, 'role-not-permitted', ipcError(FORBIDDEN_CHANNEL_CODE, 'This host caller cannot use the channel'));
    const handler = this.registry.lookup(channel);
    if (!handler) return this.refuse(caller, channel, args, startedAt, 'unknown-channel', notMigrated(channel));
    return this.dispatch(caller, channel, args, startedAt, handler, assertCurrent, signal);
  }
  private async dispatch(caller: CallerIdentity, channel: string, safeArgs: Json[], startedAt: number,
    handler: (context: HandlerContext) => Promise<Json> | Json, assertCurrent?: () => void, signal?: AbortSignal): Promise<RouteOutcome> {
    const context: HandlerContext = {
      role: caller.role,
      senderId: caller.senderId,
      channel,
      args: safeArgs,
      ...(assertCurrent ? { assertCurrent } : {}), ...(signal ? { signal } : {}),
    };

    try {
      assertCurrent?.();
      const value = await handler(context);
      assertCurrent?.();
      const kind = resultKind({ ok: true, value });
      this.log({ channel, role: caller.role, senderId: caller.senderId, result: kind, elapsedMs: Date.now() - startedAt });
      return { ok: true, value, kind };
    } catch (error) {
      // Convention A: a handler that throws `IpcHandlerError` chose its own code and
      // message. Anything else is an unexpected host failure and still has to reach
      // the renderer as a structured envelope.
      if (error instanceof IpcHandlerError) {
        const envelope = ipcError(error.code, error.message);
        return this.refuse(caller, channel, safeArgs, startedAt, undefined, envelope);
      }
      const message = handlerErrorMessage(error);
      const envelope = ipcError(HOST_ERROR_CODE, `channel '${channel}' failed: ${message}`);
      return this.refuse(caller, channel, safeArgs, startedAt, undefined, envelope);
    }
  }

  /**
   * Build a refusal outcome and log it.
   *
   * `refusal` is `undefined` for handler-level failures, which are not privilege or
   * routing refusals — the distinction matters in the log because a spike in
   * `role-not-permitted` means a contract problem while a spike in handler failures
   * means a capability problem.
   */
  private refuse(
    caller: CallerIdentity,
    channel: string,
    _args: Json[],
    startedAt: number,
    refusal: Refusal | undefined,
    error: IpcError,
  ): RouteOutcome {
    const kind = resultKind({ ok: false, error });
    this.log({
      channel,
      role: caller.role,
      senderId: caller.senderId,
      result: kind,
      refusal,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, error, kind };
  }

  private log(entry: RouteLogEntry): void {
    try {
      this.onRoute?.(entry);
    } catch {
      // A broken logger must not break routing.
    }
  }
}
