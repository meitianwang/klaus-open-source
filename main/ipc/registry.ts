// The channel registry: every host capability the router can dispatch to.
//
// Plan §6.2: "IPC 方法注册和事件表是唯一来源" — the registration table and the event
// table are the single source of truth. That is what this file is. A capability that
// is not registered here does not exist to any renderer, phone bridge or agent tool,
// and there is no second dispatch path that could reach it.
//
// The retired Rust shell routed with one flat 359-arm `match` over 375 channel strings
// (in its `main.rs`, readable through git history — see `main/paths.ts`). A `match` cannot
// be introspected, which is why the shell
// needed a separate audit script that regexes its own source to prove the arms and the
// renderer bridges agree. A registry can be introspected, so the same proof becomes a
// direct comparison against the contract instead of a source scrape — see
// `tests/ipc-contract.test.ts`.
//
// Registration order does not matter and duplicates are refused loudly: a channel
// registered twice would mean two implementations of one capability, and the shell's
// `match` makes that impossible by construction, so the registry enforces it instead.

import type { Json } from './contract';

/**
 * The context a handler is given.
 *
 * `role` and `sender` are here because plan §6.2 requires the main process to
 * validate "参数与资源归属" (arguments and resource ownership). A handler that needs
 * to check a resource belongs to its caller — a canvas page asking about a canvas
 * file it does not own, say — needs to know who is asking. The retired shell could not do
 * this: its `ipc_invoke` command took no window parameter, so no handler
 * there could see its caller. Carrying the role on every call makes that class of check
 * expressible for the first time.
 */
export interface HandlerContext {
  /** The window role this call came from. */
  role: string;
  /** Stable id of the sending WebContents, for logging and ownership checks. */
  senderId: number;
  /** The channel being handled, so one handler can serve several channels. */
  channel: string;
  /**
   * The raw `args` array as the renderer sent it.
   *
   * Handlers read `arg0(args)` exactly as the Rust ones do (`main.rs:5115-5117`) —
   * only the first element is ever consulted, and a missing one is `null`. Args are
   * passed through UNTOUCHED: binary decoding is per-field and belongs to the handler
   * that knows which field holds bytes (see `./binary.ts`).
   */
  args: Json[];
  /** Present for an owned remote call; recheck after awaits and before queued writes. */
  assertCurrent?(): void;
  signal?: AbortSignal;
}

/**
 * Convention A failure: throwing this rejects the IPC promise with the
 * `{"ok":false,"error":{code,message}}` envelope `bridge/ipc.ts:80-91` unwraps.
 *
 * Handlers throw this instead of returning it, so the two error conventions stay
 * distinguishable at the type level: a thrown `IpcError` is convention A, a returned
 * `{ok:false,error:"<string>"}` is convention B.
 */
export class IpcHandlerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IpcHandlerError';
    this.code = code;
  }
}

/**
 * A channel handler.
 *
 * Resolving with a value is convention A success; resolving with
 * `{ok:false,error:"<message>"}` is convention B, a SOFT failure the renderer's
 * promise still accepts. Throwing (or rejecting) is convention A failure. Returning
 * the wrong one silently changes whether the caller's `if (!result.ok)` branch runs,
 * so the distinction is documented at `./errors.ts`.
 */
export type ChannelHandler = (context: HandlerContext) => Promise<Json> | Json;

interface Registration {
  channel: string;
  handler: ChannelHandler;
  /** Where this handler came from, for diagnostics when a channel misbehaves. */
  origin: string;
}

/**
 * The registry.
 *
 * Deliberately NOT a module-level singleton: tests build their own, and the app
 * builds exactly one. A global would make every test mutate shared state and could
 * not be reset between cases.
 */
export class ChannelRegistry {
  private readonly handlers = new Map<string, Registration>();

  /**
   * Register one channel.
   *
   * @param origin a short label for the module registering this, used only in
   *   diagnostics. Passing it is required so an unexplained handler cannot appear:
   *   when a channel does something unexpected, the first question is who owns it.
   */
  register(channel: string, handler: ChannelHandler, origin: string): void {
    if (!channel || typeof channel !== 'string') {
      throw new Error(`cannot register an empty channel name (origin '${origin}')`);
    }
    const existing = this.handlers.get(channel);
    if (existing) {
      throw new Error(
        `channel '${channel}' is already registered by '${existing.origin}'; ` +
          `'${origin}' cannot register it again`,
      );
    }
    this.handlers.set(channel, { channel, handler, origin });
  }

  /** Register many channels from one module, each with the same origin. */
  registerAll(handlers: Record<string, ChannelHandler>, origin: string): void {
    for (const [channel, handler] of Object.entries(handlers)) {
      this.register(channel, handler, origin);
    }
  }

  /** Look up a channel's handler, or `undefined` if nothing registered it. */
  lookup(channel: string): ChannelHandler | undefined {
    return this.handlers.get(channel)?.handler;
  }

  /** Every registered channel name. Sorted for stable comparison in tests. */
  channels(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /** How many channels are registered. */
  size(): number {
    return this.handlers.size;
  }

  /** The origin label of a channel's handler, for diagnostics. */
  originOf(channel: string): string | undefined {
    return this.handlers.get(channel)?.origin;
  }
}
