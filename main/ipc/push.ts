// Host→renderer pushes, and the cold-start latch that keeps early ones from being lost.
//
// The shell emits `app.emit("ipc:<channel>", json!({"args": [...]}))` from 60 sites,
// which broadcasts to EVERY window and webview; exactly one push in the whole crate
// is targeted (`quick_input.rs:393-399`, `emit_to(WINDOW_LABEL, "ipc:quick-input:focus", …)`).
// `bridge/ipc.ts:116-119` unwraps it as `event.payload?.args || []` and spreads those
// into the callback, so the `{args:[…]}` wrapper is part of the wire contract and not
// an implementation detail.
//
// Two things this reproduces that are easy to get wrong:
//
//  1. THE LATCH. Three channels can fire during cold start, before any renderer
//     listener exists: a deep link arriving while the window loads, a quick-input
//     submission from the global hotkey, and an updater status from the startup check.
//     `deep_link::deliver_when_ready` parks those and `mark_renderer_ready` flushes
//     them. The latch is flipped by the FIRST renderer invoke (`main.rs:5158`),
//     because — as `main.rs:5154-5157` explains — that proves the api-shim is live:
//     it registers its event listeners before it can invoke anything. Flushing on
//     `did-finish-load` instead would race the preload's listener registration and
//     lose the very pushes this exists to save.
//
//  2. TARGETING BY ROLE, NOT BY NAME. Broadcasting to all and letting each preload
//     drop what its role may not hear would reproduce today's behaviour. Filtering
//     here instead is strictly stronger and behaviourally identical from the
//     renderer's side, because the preload would have dropped it anyway — and it
//     means `quick-input:focus` gets its targeted semantics for free: only the
//     `quick-input` role may listen to it, so it reaches only that window without
//     special-casing a label.
//
// Nothing here imports Electron. Delivery goes through a `PushTransport` the app
// supplies, so the latch, the parking order and the role filter are all testable in
// plain Node.

import type { Json } from './contract';

/** The wire shape of a push: `ipc:<channel>` carrying `{args:[…]}`. */
export const PUSH_EVENT_PREFIX = 'ipc:';

/** Build the event name a renderer listens on, as `ipc.ts:117` does. */
export function pushEventName(channel: string): string {
  return `${PUSH_EVENT_PREFIX}${channel}`;
}

/**
 * The `{args:[…]}` payload wrapper.
 *
 * `null` becomes an empty args array rather than `[null]`, matching
 * `deliver_when_ready` (`deep_link.rs:96`): `if arg.is_null() { {"args":[]} } else { {"args":[arg]} }`.
 * Several pushes carry no argument at all (`tray:new-chat`, `notify:sound`'s siblings),
 * and the renderer spreads `args`, so `[null]` would hand callbacks a spurious null
 * first argument where they expect none.
 */
export function pushPayload(arg: Json | null | undefined): { args: Json[] } {
  return { args: arg === null || arg === undefined ? [] : [arg] };
}

/**
 * Where a push actually goes.
 *
 * The app implements this with `webContents.send(event, payload)`. Keeping it behind
 * an interface is what makes this module Electron-free: the tests drive it with an
 * array and assert exact ordering, which a real BrowserWindow cannot do.
 */
export interface PushTransport {
  /**
   * Deliver one event to one renderer.
   *
   * Must not throw: a renderer that vanished mid-send (closed window, crashed
   * process) is normal, and losing one push must not abort the rest of the flush.
   */
  send(target: PushTarget, event: string, payload: { args: Json[] }): void;
}

/** One renderer that can receive pushes. */
export interface PushTarget {
  /** Stable id, for diagnostics. */
  id: number;
  /** The window role, which decides what this renderer may hear. */
  role: string;
}

/**
 * The renderer-ready latch plus whatever it parked.
 *
 * One latch for the whole app, not per renderer — that is what the Rust `static`
 * AtomicBool does, and it is correct: the point is "has any shim come up and
 * registered its listeners", and the first invoke from any window proves it.
 */
export class RendererReadyLatch {
  private ready = false;
  private readonly parked: Array<{ event: string; payload: { args: Json[] } }> = [];

  /** Has a renderer proved itself live yet? */
  isReady(): boolean {
    return this.ready;
  }

  /** How many pushes are parked, for diagnostics and tests. */
  parkedCount(): number {
    return this.parked.length;
  }

  /**
   * Flip the latch and hand back everything that was parked, in the order it was
   * parked. Mirrors `mark_renderer_ready` (`deep_link.rs:79-88`), which `mem::take`s
   * the queue and emits each pair.
   *
   * Returns the drained queue rather than emitting it, so the caller decides where
   * they go and the latch stays free of transport concerns. Calling this twice is
   * harmless: the second call reports no change and returns nothing.
   */
  markReady(): Array<{ event: string; payload: { args: Json[] } }> {
    if (this.ready) return [];
    this.ready = true;
    // Copy-and-clear, not a swap of the same array reference, so a push that arrives
    // during the caller's flush cannot be appended to an array the caller is still
    // iterating.
    const pending = this.parked.splice(0, this.parked.length);
    return pending;
  }

  /** Park one push for later delivery. */
  park(event: string, payload: { args: Json[] }): void {
    this.parked.push({ event, payload });
  }
}

/**
 * Broadcasts host pushes to the renderers allowed to hear them.
 */
export class PushBroadcaster {
  private readonly targets = new Map<number, PushTarget>();

  constructor(
    private readonly transport: PushTransport,
    private readonly latch: RendererReadyLatch,
    /**
     * May this role listen to this channel? Supplied by the role table so there is
     * one source of privilege rather than a second list kept in step by hand.
     */
    private readonly mayListen: (role: string, channel: string) => boolean,
    /**
     * Channels that must survive cold start. From the contract's
     * `coldStartDeferred`, which names the three the shell parks today.
     */
    private readonly coldStartDeferred: ReadonlySet<string>,
  ) {}

  /** A renderer came up. It can now receive pushes. */
  addTarget(target: PushTarget): void {
    this.targets.set(target.id, target);
  }

  /** A renderer went away. Stop sending to it. */
  removeTarget(id: number): void {
    this.targets.delete(id);
  }

  /** Which renderers are currently registered. */
  targetCount(): number {
    return this.targets.size;
  }

  /**
   * Emit a push.
   *
   * Returns how many renderers actually received it, which is what makes a dropped
   * push visible instead of silent — the failure mode `command-map.json`'s audit
   * calls out ("the shell emits a channel nothing listens on → the payload is
   * dropped, and a renamed channel looks exactly like this").
   */
  emit(channel: string, arg: Json | null | undefined = null): number {
    const event = pushEventName(channel);
    const payload = pushPayload(arg);

    // Park before the latch is up, but ONLY the channels that can fire during cold
    // start. Parking everything would change behaviour for the other 33: today they
    // broadcast unconditionally and are lost if nobody is listening, which is what
    // `app.emit` does.
    if (!this.latch.isReady() && this.coldStartDeferred.has(channel)) {
      this.latch.park(event, payload);
      return 0;
    }

    return this.deliver(event, channel, payload);
  }

  /**
   * Called on the renderer's first invoke. Flushes whatever cold start parked.
   *
   * Parked pushes go to every registered renderer whose role may hear them, exactly
   * as `app.emit` would have broadcast them — the park preserved the payload, not a
   * destination, because at park time there may have been no renderer at all.
   */
  markRendererReady(): number {
    const pending = this.latch.markReady();
    let delivered = 0;
    for (const { event, payload } of pending) {
      const channel = event.startsWith(PUSH_EVENT_PREFIX) ? event.slice(PUSH_EVENT_PREFIX.length) : event;
      delivered += this.deliver(event, channel, payload);
    }
    return delivered;
  }

  /**
   * Send to each registered renderer whose role may listen to this channel.
   *
   * A send failure is swallowed per target: one closed window must not stop the
   * others from receiving the push. The transport is documented as non-throwing, but
   * this guards anyway because the cost of being wrong is a lost push for every
   * renderer after the broken one.
   */
  private deliver(event: string, channel: string, payload: { args: Json[] }): number {
    let delivered = 0;
    for (const target of this.targets.values()) {
      if (!this.mayListen(target.role, channel)) continue;
      try {
        this.transport.send(target, event, payload);
        delivered += 1;
      } catch {
        // A renderer that vanished mid-send. Drop this one and keep going.
      }
    }
    return delivered;
  }
}
