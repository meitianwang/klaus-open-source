// EngineManager: the single TypeScript owner of the Klaus engine process.
//
// This is the port of `klaus-host-core/src/pool.rs` plus the connection half of
// `rpc.rs`. Plan §5 makes it the ONLY thing allowed to spawn or hold an engine
// process: "TS EngineManager 独占引擎进程" — no native addon may manage the engine,
// and no second code path may spawn one, because a second owner means two processes
// racing over the same session state.
//
// Plan §6.1 items this file is responsible for:
//   1. 按实际 spawn key 共享/隔离引擎；并发 attach 不重复 spawn；启动失败与最后释放
//      可收敛。  -> `attach` dedupes on `spawnKey`, concurrent attaches for one key
//      share ONE in-flight spawn, a failed spawn leaves nothing cached, and the last
//      release tears the process down.
//   3. request ID、pending map、超时、取消、反向请求响应；EOF/写失败一次性结束相关
//      pending。 -> delegated to `AppServerClient`; the manager adds the exit
//      ordering and generation isolation below.
//
// Exit ordering, reproduced from `pool.rs:386-419` plus the reverse-request rule in
// `rpc.rs:117-134`. The order matters and is not interchangeable:
//
//   a. fail every outstanding reverse request with -32000  (MUST precede b: after
//      stdin closes a reply is unwritable and the engine hangs waiting for it)
//   b. `client.close()` — signals both I/O tasks and closes stdin
//   c. wait `KILL_FALLBACK` (5s) for the process to exit on its own
//   d. `child.kill()` if it ignored stdin EOF
//
// Generation isolation: each attach stamps a monotonically increasing generation on
// its client. A stale client from an earlier process cannot write into the current
// one's slot, because the slot is only ever replaced by a client whose generation is
// higher (`retire`'s `Arc::ptr_eq` guard in Rust, `pool.rs:369-385`).

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AppServerClient } from './client';
import { effectiveEnv, spawnKey, type SpawnOptions } from './spawn';
import {
  rpcErrorMessage,
  type ClientEvent,
  type Json,
  type JsonObject,
  type ReverseRequest,
  type RpcError,
} from './protocol';

/** `main.rs:1156` — `ENGINE_INIT_TIMEOUT` is 20 seconds. */
export const ENGINE_INIT_TIMEOUT_MS = 20_000;

/** `pool.rs:20` — `KILL_FALLBACK` is 5 seconds. */
export const KILL_FALLBACK_MS = 5_000;

/**
 * Bound on re-attempting an attach whose slot vanished between the in-flight spawn
 * resolving and the lookup. Without a bound, an engine that is torn down as fast as
 * it starts would loop forever instead of reporting the failure.
 */
const ATTACH_RETRY_LIMIT = 3;

/** The initialize handshake the shell performs today (`engine.rs:1-110`). */
export const INITIALIZE_METHOD = 'initialize';

/**
 * Sent immediately after a successful `initialize` reply (`rpc.rs:281`). Omitting
 * it leaves the engine waiting for the client to confirm the handshake.
 */
export const INITIALIZED_NOTIFICATION = 'initialized';

/**
 * Build the `initialize` params exactly as `AppServerClient::initialize` does
 * (`rpc.rs:256-279`): `clientInfo` carries name and optional version, and
 * `capabilities` carries the opt-out list and `productEvents`. The nesting matters —
 * a flat `{optOutNotificationMethods, productEvents}` is silently ignored, so the
 * client would receive `session/event` twice (once as a JSON-RPC notification and
 * once as a product event).
 *
 * The shell opts out of `session/event` as a notification and receives it as a
 * product event instead (`engine.rs:52-57` passes `true` and `&["session/event"]`),
 * and `productEvents: true` is what makes the engine emit them at all.
 */
export function initializeParams(
  clientName: string,
  clientVersion: string | undefined,
  productEvents: boolean,
  optOutNotificationMethods: string[],
): JsonObject {
  const clientInfo: JsonObject = { name: clientName };
  if (clientVersion !== undefined) clientInfo.version = clientVersion;
  const params: JsonObject = { clientInfo };
  const capabilities: JsonObject = {};
  if (optOutNotificationMethods.length > 0) {
    capabilities.optOutNotificationMethods = optOutNotificationMethods;
  }
  if (productEvents) capabilities.productEvents = true;
  // The mobile follower joins an ordered history snapshot to the live stream.
  // Older engines ignore this additive capability.
  capabilities.revisionedSessionEvents = true;
  if (Object.keys(capabilities).length > 0) params.capabilities = capabilities;
  return params;
}

/**
 * The values the retired Rust shell passed in its `initialize` call: client name
 * `klaus-tauri`, the crate version, product events on, `session/event` opted out.
 * This host uses its own name — the engine only reports it, so the rename
 * is safe, and keeping `klaus-tauri` would misattribute the host in engine logs.
 */
export const SHELL_CLIENT_NAME = 'klaus-electron';
export const SHELL_PRODUCT_EVENTS = true;
export const SHELL_OPT_OUT_NOTIFICATION_METHODS = ['session/event'];

export interface ManagedEngine {
  readonly key: string;
  readonly generation: number;
  readonly pid: number | undefined;
  readonly client: AppServerClient;
  /** Number of active attachments; teardown happens when it reaches zero. */
  attachments: number;
}

export type EngineEvent = ClientEvent & { generation: number };

export interface ManagerEvents {
  /** Any client event, tagged with the generation that produced it. */
  event: [EngineEvent];
  /** The engine process exited. */
  exit: [{ generation: number; key: string; code: number | null; signal: string | null }];
  /** A reverse request the UI must answer (approval / elicitation). */
  reverseRequest: [{ generation: number; request: ReverseRequest }];
}

/**
 * A record of one engine process: the child, its client, the attachment count and
 * the in-flight spawn so concurrent attachers do not double-spawn.
 */
interface Slot {
  key: string;
  generation: number;
  child?: ChildProcess;
  client?: AppServerClient;
  attachments: number;
  /** Set once teardown begins, so late attachers cannot reuse a dying slot. */
  dying: boolean;
  stopping?: Promise<void>;
  /** Last stderr bytes of this process, kept so a failed handshake can quote them. */
  stderrTail?: string;
}

export class EngineManager extends EventEmitter {
  private readonly slots = new Map<string, Slot>();
  private generationCounter = 0;
  private readonly inFlight = new Map<string, Promise<AppServerClient>>();
  /** Includes children whose initialize handshake has not completed. */
  private readonly owned = new Set<Slot>();
  private closing = false;
  private shutdownPromise?: Promise<void>;

  /**
   * @param clientVersion Reported to the engine in `clientInfo.version`. Pass the
   * app version, as the retired Rust shell passed its own crate version.
   */
  constructor(private readonly clientVersion?: string) {
    super();
  }

  /**
   * Attach to the engine described by `opts`, spawning it if necessary.
   *
   * Two attaches with equal `spawnKey` values get the SAME process (`pool.rs`
   * `attach` dedupes on `key`); different keys get isolated processes. This is how
   * `ensure_engine` and the cron watcher share one engine today.
   *
   * Concurrent attaches for one key share a single in-flight spawn, so a burst of
   * callers cannot start several processes for the same key.
   */
  async attach(opts: SpawnOptions, attempt = 0): Promise<ManagedEngine> {
    if (this.closing) throw new Error('engine manager is shutting down');
    const key = spawnKey(opts);
    const existing = this.slots.get(key);
    if (existing && !existing.dying && existing.client && !existing.client.isClosed()) {
      existing.attachments++;
      return this.toManaged(existing);
    }

    // Share one spawn across concurrent attachers for this key.
    const pending = this.inFlight.get(key);
    if (pending) {
      const client = await pending;
      const slot = this.slots.get(key);
      if (!this.closing && slot && !slot.dying && slot.client === client) {
        slot.attachments++;
        return this.toManaged(slot);
      }
      // The slot went away while we waited (its handshake failed, or it was torn
      // down immediately). Retry from the top so a racing teardown cannot strand the
      // caller -- bounded, because an engine that fails every time must surface that
      // failure rather than spin.
      if (attempt >= ATTACH_RETRY_LIMIT) {
        throw new Error(`engine ${key} did not stay up after ${attempt} attach attempts`);
      }
      return this.attach(opts, attempt + 1);
    }

    const started = this.start(opts, key);
    this.inFlight.set(key, started);
    try {
      const client = await started;
      const slot = this.slots.get(key);
      if (this.closing || !slot || slot.dying || slot.client !== client) {
        throw new Error(`engine slot for ${key} vanished during start`);
      }
      slot.attachments++;
      return this.toManaged(slot);
    } finally {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    }
  }

  /**
   * Spawn the child, wire its stdio to a client, and run the `initialize`
   * handshake. A failure at any step leaves no cached slot, so the next attach
   * retries from scratch rather than reusing a half-started process — plan §6.1
   * item 1's "启动失败…可收敛".
   */
  private async start(opts: SpawnOptions, key: string): Promise<AppServerClient> {
    const generation = ++this.generationCounter;
    const slot: Slot = { key, generation, attachments: 0, dying: false };

    // `spawn()` returns synchronously and reports a failed exec ASYNCHRONOUSLY, as
    // an 'error' event on the child (ENOENT for a missing binary, EACCES for a
    // non-executable one). A try/catch around `spawn()` therefore never sees it, and
    // an 'error' event with no listener throws out of the process — taking the whole
    // host down instead of failing one attach. The listener must be attached in the
    // same tick as the spawn, and the failure must be raced against the handshake.
    let spawnError: Error | undefined;
    let child: ChildProcess;
    try {
      // Argv is `<command> [args…] --app-server`, exactly as `pool.rs:243-259`
      // builds it: `--app-server` is appended by the pool, never passed by callers.
      child = spawn(opts.command, [...opts.args, '--app-server'], {
        cwd: opts.cwd,
        // `inheritedEnv` reproduces `SpawnOptions::inherited_env()` (`pool.rs:41-84`)
        // including the KLAUS_CONFIG_DIR / KLAUS_PLUGIN_HOME / KLAUS_SESSION_DIR
        // trio; `opts.env` overrides the process environment.
        env: Object.fromEntries(effectiveEnv(opts)),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Still reachable for synchronous argument errors.
      throw new Error(`engine spawn failed: ${describe(error)}`);
    }

    /** Rejects once the child reports it could not be exec'd. */
    const spawnFailed = new Promise<never>((_resolve, reject) => {
      child.once('error', (error) => {
        spawnError = error instanceof Error ? error : new Error(String(error));
        reject(new Error(`engine spawn failed: ${describe(error)}`));
      });
    });
    // Keep the promise from being reported as unhandled when the spawn succeeds and
    // nothing ever rejects it.
    spawnFailed.catch(() => undefined);

    if (!child.stdin || !child.stdout) {
      child.kill();
      throw new Error('engine spawn failed: stdio not available');
    }

    const client = new AppServerClient(child.stdin, `engine#${generation}`);
    client.on('requestDiagnostic', record => this.emit('requestDiagnostic', { generation, ...record }));
    client.on('cursorWireDiagnostic', record => this.emit('cursorWireDiagnostic', { generation, ...record }));
    slot.child = child;
    slot.client = client;
    this.owned.add(slot);
    // NOTE: the slot is deliberately NOT put into `this.slots` yet. Registering it
    // before the handshake completes would let a concurrent attacher take a client
    // whose engine has not answered `initialize`, and plan §6.1 item 1 requires
    // concurrent attach to converge on ONE usable process, not one half-started
    // one. It is registered below, only after the handshake succeeds.

    // Wire the reader. Events are re-emitted tagged with the generation so a
    // consumer can discard anything from a process it no longer considers current.
    child.stdout.on('data', (chunk: Buffer) => client.feedStdout(chunk));
    child.stdout.on('end', () => client.endStdout());
    child.stdout.on('error', (error) => {
      client.close(`stdout error: ${describe(error)}`);
    });
    // Always drain stderr: an unread diagnostic pipe can block the engine's RPC loop.
    // The tail is retained on the slot so a failed handshake can quote the engine's own
    // diagnosis: the RPC rejection that reaches the caller only says the connection
    // closed, which is how an engine refusing to serve (bad config file, missing ledger)
    // once surfaced to the user as `[object Object]`.
    child.stderr?.on('data', (chunk: Buffer) => {
      slot.stderrTail = ((slot.stderrTail ?? '') + chunk.toString('utf8')).slice(-8192);
      this.emit('stderr', { generation, key, chunk });
    });
    child.stdin.on('error', (error) => {
      // A broken pipe is how an engine that already exited presents; the client's
      // close path fails every pending request at once.
      client.close(`stdin error: ${describe(error)}`);
    });

    client.on('event', (event: ClientEvent) => {
      if (event.type === 'streamClosed') {
        void this.destroySlot(slot, 'engine protocol stream closed');
      }
      if (event.type === 'reverseRequest') {
        this.emit('reverseRequest', { generation, request: event.request });
      }
      this.emit('event', { ...event, generation } as EngineEvent);
    });

    child.on('exit', (code, signal) => {
      this.owned.delete(slot);
      // The client may already be closed (we closed it during teardown); closing
      // again is a no-op and its close reason is first-wins (`rpc.rs:349-355`).
      client.close(`engine exited (code=${code} signal=${signal})`);
      this.retire(key, client);
      this.emit('exit', { generation, key, code, signal });
    });

    try {
      // The handshake is bounded, as `engine.rs:51` bounds it with
      // ENGINE_INIT_TIMEOUT. An engine that starts but never answers must not hang
      // the caller forever. It is raced against `spawnFailed`, because a child that
      // could not be exec'd never writes anything — waiting on the handshake alone
      // would sit out the full 20s before reporting a missing binary.
      const initialized = await Promise.race([
        client.requestWithTimeout(
          INITIALIZE_METHOD,
          initializeParams(SHELL_CLIENT_NAME, this.clientVersion, SHELL_PRODUCT_EVENTS, SHELL_OPT_OUT_NOTIFICATION_METHODS),
          ENGINE_INIT_TIMEOUT_MS,
        ),
        spawnFailed,
      ]);
      client.captureInitializeResult(initialized);
      // `rpc.rs:281` sends `initialized` after a successful reply; without it the
      // engine treats the handshake as incomplete.
      await client.notify(INITIALIZED_NOTIFICATION, {});
      if (this.closing || slot.dying || client.isClosed()) {
        throw new Error('engine startup cancelled during shutdown');
      }
    } catch (error) {
      // The slot was never published, so this only has to clean up the child and
      // fail anything already in flight on this connection. `spawnError` distinguishes
      // "the binary was never exec'd" (nothing to wait for or kill) from "the engine
      // started and then failed the handshake" (a real process to tear down).
      await this.destroySlot(
        slot,
        rpcErrorMessage(normalizeRpcError(error)),
        spawnError !== undefined,
      );
      throw startupFailure(error, slot.stderrTail);
    }

    // Publish only now that the handshake succeeded. A concurrent attacher that
    // finds this slot is therefore guaranteed a usable engine.
    this.slots.set(key, slot);
    return client;
  }

  private toManaged(slot: Slot): ManagedEngine {
    const client = slot.client;
    if (!client) throw new Error(`engine slot ${slot.key} has no client`);
    return {
      key: slot.key,
      generation: slot.generation,
      pid: slot.child?.pid,
      client,
      get attachments() {
        return slot.attachments;
      },
    };
  }

  /**
   * Release one attachment. The last release tears the process down —
   * plan §6.1 item 1's "最后释放可收敛".
   */
  async release(key: string): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.attachments = Math.max(0, slot.attachments - 1);
    if (slot.attachments > 0 || slot.dying) return;
    await this.destroySlot(slot, 'last attachment released');
  }

  /**
   * Retire a slot whose process already exited. The generation guard is the
   * TypeScript form of `retire`'s `Arc::ptr_eq` check (`pool.rs:369-376`): if the
   * slot has already been replaced by a NEWER process, do not tear that one down.
   */
  private retire(key: string, client: AppServerClient): void {
    const slot = this.slots.get(key);
    if (!slot || slot.client !== client) return;
    slot.dying = true;
    this.slots.delete(key);
  }

  /**
   * The §6.1 shutdown ordering, in full. Steps a→d must run in this order.
   */
  private destroySlot(slot: Slot, reason: string, neverSpawned = false): Promise<void> {
    slot.stopping ??= this.stopSlot(slot, reason, neverSpawned).finally(() => {
      this.owned.delete(slot);
    });
    return slot.stopping;
  }

  private async stopSlot(slot: Slot, reason: string, neverSpawned: boolean): Promise<void> {
    slot.dying = true;
    // Remove from the pool FIRST so a concurrent attacher cannot grab a dying
    // process (`pool.rs:357-365` removes before teardown).
    if (this.slots.get(slot.key) === slot) this.slots.delete(slot.key);

    const client = slot.client;
    const child = slot.child;

    if (client) {
      // (a) Unanswered reverse requests must be failed BEFORE stdin closes, or the
      //     reply is unwritable and the engine hangs on an approval nobody can give.
      //     This is the explicit replacement for Rust's `Responder::drop`
      //     (`rpc.rs:117-134`), which TypeScript cannot do implicitly.
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.failOutstandingReverseRequests(),
          new Promise<void>(resolve => { deadline = setTimeout(resolve, 500); }),
        ]);
      } catch {
        // A broken writer must not prevent process cleanup.
      } finally {
        if (deadline) clearTimeout(deadline);
      }
      // (b) Close the client: signals both I/O tasks and closes stdin.
      client.close(reason);
    }
    slot.client = undefined;

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      slot.child = undefined;
      return;
    }

    // The child was never exec'd (ENOENT/EACCES), so there is no process to wait for
    // or kill. Skipping this is what keeps a missing-binary attach from sitting out
    // two KILL_FALLBACK windows.
    if (neverSpawned || child.pid === undefined) {
      child.kill();
      slot.child = undefined;
      return;
    }

    // (c) Wait KILL_FALLBACK for the process to exit on its own after stdin EOF.
    const exited = await this.waitForExit(child, KILL_FALLBACK_MS);
    if (!exited) {
      // (d) It ignored stdin EOF; kill it, as `pool.rs:404-413` does.
      child.kill('SIGKILL');
      await this.waitForExit(child, KILL_FALLBACK_MS);
    }
    slot.child = undefined;
  }

  /**
   * Wait for the child to be finished.
   *
   * Listens for `close` as well as `exit`, because a child that could not be exec'd
   * (ENOENT / EACCES) emits `error` then `close` and never emits `exit` at all.
   * Waiting on `exit` alone would sit out the whole KILL_FALLBACK, then SIGKILL a
   * process that does not exist, then wait it out a second time.
   */
  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true);
        return;
      }
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        child.removeListener('exit', onDone);
        child.removeListener('close', onDone);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      function onDone(): void {
        finish(true);
      }
      child.once('exit', onDone);
      child.once('close', onDone);
    });
  }

  /** Tear down every engine. Called on app quit. */
  shutdownAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    const children = [...this.owned];
    const starts = [...this.inFlight.values()];
    this.shutdownPromise = (async () => {
      await Promise.all(children.map((slot) => this.destroySlot(slot, 'host shutdown')));
      await Promise.allSettled(starts);
    })();
    return this.shutdownPromise;
  }

  /**
   * Fail every reverse request still outstanding, across all generations. Used when
   * the host is going away but the processes are not, so the engine does not sit
   * waiting on an approval that can never arrive.
   */
  async failAllOutstandingReverseRequests(): Promise<number> {
    let sent = 0;
    for (const slot of this.owned) {
      if (slot.client) sent += await slot.client.failOutstandingReverseRequests();
    }
    return sent;
  }

  /** Live process count, for diagnostics (`pool.rs:419` `live_process_count`). */
  liveProcessCount(): number {
    return this.slots.size;
  }

  /** Snapshot of every managed engine, for diagnostics. */
  inspect(): Array<{ key: string; generation: number; pid?: number; attachments: number; dying: boolean }> {
    return [...this.slots.values()].map((slot) => ({
      key: slot.key,
      generation: slot.generation,
      pid: slot.child?.pid,
      attachments: slot.attachments,
      dying: slot.dying,
    }));
  }
}

function normalizeRpcError(error: unknown): RpcError {
  if (typeof error === 'object' && error !== null && 'kind' in error) return error as RpcError;
  return { kind: 'io', message: describe(error) };
}

/**
 * The error an attach caller sees when the engine never made it through the handshake.
 * `AppServerClient` rejects with a bare `RpcError` record whose only field for this
 * failure is `kind: 'closed'`, so a caller that logs or shows the raw value gets
 * `[object Object]` and loses the reason entirely. Wrapping it in a real `Error` keeps
 * the RPC detail in the message and appends the engine's stderr tail, which is where
 * the engine reports WHY it refused to serve before closing the stream.
 */
function startupFailure(error: unknown, stderrTail: string | undefined): Error {
  const rpc = error instanceof Error ? error.message : rpcErrorMessage(normalizeRpcError(error));
  const tail = stderrTail?.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0).slice(-4).join(' | ');
  return new Error(tail ? `engine startup failed: ${rpc}; engine reported: ${tail}` : `engine startup failed: ${rpc}`);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
