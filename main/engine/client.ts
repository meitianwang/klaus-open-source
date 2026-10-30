// AppServerClient: the TypeScript port of `klaus-host-core/src/rpc.rs`.
//
// Plan §6.1 item 3 requires: "request ID、pending map、超时、取消、反向请求响应；
// EOF/写失败一次性结束相关 pending".
//
// Semantics reproduced from the Rust original, each with the source line it comes
// from:
//
//   * Request ids start at 1 and increase by 1 (`rpc.rs:174`, `:358`).
//   * A request registers its pending entry BEFORE writing, under the same lock
//     `close()` drains, so a request racing a close cannot be stranded after the
//     last pending reply was rejected (`rpc.rs:359-368`).
//   * Call sites own request deadlines via `requestWithTimeout(...)`. The shared
//     scheduler includes queue time and gives each coalesced read consumer its
//     own cancellation/deadline while reserving turn-control capacity.
//   * On EOF or write failure ALL pending requests fail at once, each with
//     `{kind:'closed'}`. In Rust this is dropping the oneshot sender, which makes
//     every `rx.await` resolve to `RpcError::Closed` (`rpc.rs:373`,
//     `reject_all_pending`).
//   * A reverse-request reply is wrapped as `{ id, result: { response } }`
//     (`rpc.rs:103-105`).
//   * An unanswered reverse request must still be answered with error -32000 so the
//     engine falls back to deny/decline rather than hanging forever
//     (`rpc.rs:117-134`, Rust's `Drop`). TypeScript has no Drop, so the manager
//     calls `failOutstandingReverseRequests()` and the tests assert it.

import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { NdjsonFramer, parseFrame } from './ndjson';
import { rpcAdmission, RpcRequestScheduler, type RpcRequestOptions } from './request-scheduler';
import {
  classify,
  notificationToEvent,
  REVERSE_REQUEST_DROPPED_CODE,
  REVERSE_REQUEST_DROPPED_MESSAGE,
  type ClientEvent,
  type Json,
  type ReverseRequest,
  type RpcError,
} from './protocol';

export interface ClientEvents {
  event: [ClientEvent];
}

/**
 * Owns one engine connection: the stdin writer, the stdout reader, the pending
 * request map and the outstanding reverse-request set.
 *
 * Extends EventEmitter so the host can pump events in wire order
 * (`conn.on('event', ...)`), mirroring the Rust `events` mpsc receiver.
 */
export class AppServerClient extends EventEmitter {
  private initializeCapabilities: Readonly<Record<string, Json>> = Object.freeze({});
  get capabilities(): Readonly<Record<string, Json>> { return this.initializeCapabilities; }
  captureInitializeResult(value: unknown): void {
    const result = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const capabilities = result.capabilities;
    this.initializeCapabilities = Object.freeze(capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) ? { ...capabilities as Record<string, Json> } : {});
  }
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: Json) => void;
    reject: (error: RpcError) => void;
  }>();
  /** Reverse requests the engine is still waiting on. Insertion-ordered. */
  private readonly reverse = new Map<symbol, ReverseRequest & { id: Json }>();
  private closed = false;
  private closeReason: string | undefined;
  private readonly framer: NdjsonFramer;
  private readonly scheduler = new RpcRequestScheduler(record => this.emit('requestDiagnostic', record));
  private readEpoch = 0;

  constructor(
    private readonly stdin: Writable,
    /** Diagnostics only; the reader is driven by `feedStdout`. */
    readonly label = 'engine',
  ) {
    super();
    this.framer = new NdjsonFramer((line) => this.onLine(line));
    // The client owns this writer, so it owns the stream's error path too. Without a
    // listener of its own, a broken pipe (the engine exited while we were writing)
    // becomes an UNHANDLED 'error' event, which crashes the whole host process --
    // far worse than losing one request. `markClosed` is idempotent and its close
    // reason is first-wins, so a caller that also listens (the manager does) is
    // unaffected.
    this.stdin.on('error', (error) => {
      this.noteCloseReason(`stdin error: ${describeError(error)}`);
      this.markClosed();
    });
  }

  // ---------------------------------------------------------------------------
  // Reader
  // ---------------------------------------------------------------------------

  /** Feed a raw stdout chunk. Splits frames and classifies each. */
  feedStdout(chunk: Buffer): void {
    this.framer.push(chunk);
  }

  /** Flush a trailing frame with no newline, then emit `streamClosed`. */
  endStdout(): void {
    this.framer.end();
    this.noteCloseReason('engine stream closed');
    this.markClosed();
  }

  private onLine(line: string): void {
    const parsed = parseFrame(line);
    if (!parsed.ok) {
      // The Rust reader reports the frame rather than dropping it silently
      // (`rpc.rs:232-239`); the PUMP then decides to ignore it, because a stray
      // line on stdout must not abort a healthy turn. Keeping that split here means
      // the decision stays visible and testable.
      this.emit('event', { type: 'protocolError', line } satisfies ClientEvent);
      return;
    }
    this.onMessage(parsed.value);
  }

  private onMessage(message: Json): void {
    const classified = classify(message);
    switch (classified.kind) {
      case 'reverseRequest':
        this.emit('event', {
          type: 'reverseRequest',
          request: this.makeResponder(classified.method, classified.params, classified.id),
        } satisfies ClientEvent);
        return;
      case 'notification':
        // A committed external queue change must not share a pre-change in-flight read.
        if (classified.method === 'thread/queue/changed') this.readEpoch++;
        this.emit('event', notificationToEvent(classified.method, classified.params));
        return;
      case 'response': {
        const entry = this.pending.get(classified.id);
        // An id with no pending entry is ignored: it is either already answered or
        // belongs to a generation this client does not own (`rpc.rs:420-435`).
        if (!entry) return;
        this.pending.delete(classified.id);
        if (classified.error) {
          // The server's own code and message are preserved so a caller can tell
          // "engine refused" from "engine died" (`RpcError::Server`, `rpc.rs:52`).
          entry.reject({
            kind: 'server',
            code: classified.error.code,
            message: classified.error.message,
            ...(classified.error.data !== undefined ? { data: classified.error.data } : {}),
          });
          return;
        }
        entry.resolve(classified.result);
        return;
      }
      case 'ignored':
        return;
    }
  }

  private makeResponder(method: string, params: Json, id: Json): ReverseRequest {
    const key = Symbol('reverse');
    let answered = false;
    const self = this;
    const request: ReverseRequest & { id: Json } = {
      method,
      params,
      id,
      outstanding: true,
      async respond(response: Json): Promise<void> {
        // Second answer is a no-op: the engine already matched this id, and a
        // duplicate reply would be misread as the response to a later request
        // (`rpc.rs:91`, `:102`).
        if (answered || !request.outstanding) return;
        answered = true;
        request.outstanding = false;
        self.reverse.delete(key);
        await self.writeFrame({ id, result: { response } });
      },
      async respondError(code: number, message: string): Promise<void> {
        if (answered || !request.outstanding) return;
        answered = true;
        request.outstanding = false;
        self.reverse.delete(key);
        await self.writeFrame({ id, error: { code, message } });
      },
    };
    this.reverse.set(key, request);
    return request;
  }

  // ---------------------------------------------------------------------------
  // Writer
  // ---------------------------------------------------------------------------

  /**
   * Single-owner serialised writer. Node streams already serialise `write()` calls
   * internally, but a failed write must close the connection and fail every pending
   * request, which is what `rpc.rs` does by shutting the writer task down.
   */
  private writeFrame(frame: unknown): Promise<void> {
    return this.writeEncodedFrame(JSON.stringify(frame));
  }

  private writeEncodedFrame(frame: string): Promise<void> {
    if (this.closed) return Promise.reject({ kind: 'closed' } satisfies RpcError);
    return new Promise<void>((resolve, reject) => {
      this.stdin.write(frame + '\n', (error) => {
        if (error) {
          this.noteCloseReason(`write failed: ${error.message}`);
          this.markClosed();
          reject({ kind: 'io', message: error.message } satisfies RpcError);
          return;
        }
        resolve();
      });
      // The write callback runs after this frame is consumed. Adding a second drain
      // listener would retain one callback per backpressured frame after close.
    });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Send a request and wait for its reply. Rejects with `{kind:'closed'}` if the
   * connection closes first — matching Rust's `rx.await.map_err(|_| Closed)`.
   */
  request(method: string, params: Json = null, options?: RpcRequestOptions): Promise<Json> {
    return this.scheduleRequest(method, params, undefined, options);
  }

  private scheduleRequest(method: string, params: Json, timeoutMs?: number, options?: RpcRequestOptions): Promise<Json> {
    const admission = rpcAdmission(method, params, timeoutMs, options);
    // Capture at submission: a queued request must not observe later caller edits.
    // Keep its encoded form so large image payloads are serialized only once.
    const encodedParams = JSON.stringify(params);
    admission.bytes = Buffer.byteLength(encodedParams ?? '') + Buffer.byteLength(method);
    // A read after a mutation must not join an older in-flight read. Unknown
    // methods conservatively advance the epoch; only the explicit read set shares.
    if (admission.coalesceKey) admission.coalesceKey = `${this.readEpoch}:${admission.coalesceKey}`;
    else this.readEpoch++;
    return this.scheduler.schedule(admission, signal => this.sendRequest(method, encodedParams, signal));
  }

  private sendRequest(method: string, encodedParams: string | undefined, signal: AbortSignal): Promise<Json> {
    if (this.closed) return Promise.reject({ kind: 'closed' } satisfies RpcError);
    if (signal.aborted) return Promise.reject({ kind: 'server', code: -32800, message: 'The app-server request was cancelled' } satisfies RpcError);
    const id = this.nextId++;
    const diagnostic = method.startsWith('cursor/') || method === 'model/selection/resolve';
    const started = performance.now();
    const note = (phase: string, outcome?: string): void => {
      if (diagnostic) try { this.emit('cursorWireDiagnostic', { method, rpcRequestId: id, phase, outcome, elapsedMs: performance.now() - started }); } catch { /* Diagnostics cannot interrupt the protocol. */ }
    };
    note('sent');
    return new Promise<Json>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void, outcome = 'ok'): void => {
        if (settled) return;
        settled = true;
        note('settled', outcome);
        signal.removeEventListener('abort', abort);
        this.pending.delete(id);
        callback();
      };
      const abort = () => finish(() => reject({ kind: 'server', code: -32800, message: 'The app-server request was cancelled' } satisfies RpcError), 'cancelled');
      // Register BEFORE writing, so a close that arrives mid-write still finds this
      // entry and rejects it (`rpc.rs:359-368`).
      this.pending.set(id, {
        resolve: value => finish(() => resolve(value)),
        reject: error => finish(() => reject(error), error.kind),
      });
      signal.addEventListener('abort', abort, { once: true });
      void this.writeEncodedFrame(`{"id":${id},"method":${JSON.stringify(method)}${encodedParams === undefined ? '' : `,"params":${encodedParams}`}}`).then(() => {
        // If the write failed the connection is closed; `markClosed` already
        // rejected this entry, so nothing further is needed here.
        note('write_complete');
        if (this.closed && this.pending.has(id)) this.rejectAllPending();
      }).catch(error => {
        finish(() => reject({ kind: 'io', message: describeError(error) } satisfies RpcError), 'io');
      });
    });
  }

  /** `request` bounded by a deadline, as the Rust call sites do. */
  requestWithTimeout(method: string, params: Json, timeoutMs: number, options?: RpcRequestOptions): Promise<Json> {
    return this.scheduleRequest(method, params, timeoutMs, options);
  }

  /** Fire-and-forget notification — no `id` on the wire (`rpc.rs:375-378`). */
  notify(method: string, params: Json = null): Promise<void> {
    return this.writeFrame({ method, params });
  }

  /**
   * Close the connection: note the reason, mark closed, fail every pending request
   * at once (`rpc.rs:338-343`), and END STDIN.
   *
   * Ending stdin is the step that makes teardown graceful instead of forced. The
   * Rust client's `close()` sets a `shutdown` flag its writer task observes, and that
   * task then drops its stdin handle; `pool.rs:386-419` waits for the engine to exit
   * on that EOF and only SIGKILLs after KILL_FALLBACK. A TypeScript `close()` that
   * merely flips a boolean leaves the pipe open, so the engine never learns the host
   * went away: every shutdown would sit out the full five seconds and then kill a
   * process that would have exited on its own.
   *
   * `end()` flushes what is already buffered before closing, so the -32000 replies
   * written by `failOutstandingReverseRequests()` are not truncated — which is why
   * the caller must fail reverse requests BEFORE calling this.
   */
  close(reason = 'connection closed by host'): void {
    this.noteCloseReason(reason);
    this.markClosed();
    // A stream that is already gone (the child died first) cannot be ended again.
    if (!this.stdin.destroyed && this.stdin.writable && !this.stdin.writableEnded) this.stdin.end();
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Why the connection ended, first reason wins (`rpc.rs:349-355`). */
  getCloseReason(): string | undefined {
    return this.closeReason;
  }

  /**
   * The TypeScript stand-in for Rust's `Responder::drop`: answer every reverse
   * request the engine is still waiting on with -32000, so the engine falls back to
   * deny/decline instead of hanging (`rpc.rs:117-134`).
   *
   * Must be called before/while tearing the process down, never after stdin is
   * closed — a reply written to a closed pipe is lost and the engine hangs on it.
   */
  async failOutstandingReverseRequests(
    code = REVERSE_REQUEST_DROPPED_CODE,
    message = REVERSE_REQUEST_DROPPED_MESSAGE,
  ): Promise<number> {
    const outstanding = [...this.reverse.values()];
    this.reverse.clear();
    let sent = 0;
    for (const request of outstanding) {
      if (!request.outstanding) continue;
      if (this.closed) {
        request.outstanding = false;
        continue;
      }
      await request.respondError(code, message);
      sent++;
    }
    return sent;
  }

  /** Reverse requests still awaiting an answer. */
  outstandingReverseRequests(): ReverseRequest[] {
    return [...this.reverse.values()];
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.scheduler.close();
    this.rejectAllPending();
    for (const request of this.reverse.values()) request.outstanding = false;
    this.reverse.clear();
    this.emit('event', { type: 'streamClosed' } satisfies ClientEvent);
  }

  /**
   * Fail every in-flight request at once. This is the TypeScript equivalent of
   * dropping all the oneshot senders, which makes each `rx.await` resolve to
   * `RpcError::Closed` (`rpc.rs:373`, `reject_all_pending`).
   */
  private rejectAllPending(): void {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of entries) entry.reject({ kind: 'closed' } satisfies RpcError);
  }

  private noteCloseReason(reason: string): void {
    this.closeReason ??= reason;
  }

  /** Diagnostics: framing counters. */
  stats(): { frames: number; unparseable: number; pending: number; reverse: number } {
    return {
      frames: this.framer.frames,
      unparseable: this.framer.unparseable,
      pending: this.pending.size,
      reverse: this.reverse.size,
    };
  }

  schedulingStats(): { queued: number; running: number; consumers: number } { return this.scheduler.stats(); }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
