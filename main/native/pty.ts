import { randomUUID } from 'node:crypto';
import type { CommandResult, NativeCloseReport, NativeHostBinding, PtyEvent, PtyInfo, PtyOptions } from './binding';

export interface PtyCloseReport extends NativeCloseReport {
  deliveryComplete: boolean;
  deliveredSequence: number;
  deliveryError?: string;
}

/** A native queue cannot drain faster than this sink settles. Never put an unbounded queue in the sink. */
export type PtySink = (event: PtyEvent) => void | Promise<void>;

export async function beforeDeadline<T>(promise: Promise<T>, until: number): Promise<{ done: true; value: T } | { done: false }> {
  const remaining = Math.max(0, until - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), remaining); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function validDeadline(deadlineMs: number): void {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000) throw new Error('INVALID_DEADLINE: expected 1-120000 milliseconds');
}

/** One generation of one PTY. A new open must use a new resourceId, even if the UI reuses a terminal id. */
export class NativePty {
  readonly resourceId: string;
  readonly ready: Promise<PtyInfo>;
  readonly finished: Promise<void>;
  private callbackEnabled = true;
  private closePromise?: Promise<PtyCloseReport>;
  private terminalReport?: NativeCloseReport;
  private lastSequence = 0;
  private deliveredSequence = 0;
  private deliveryError?: string;
  private closing = false;
  private pumpSettled = false;
  private startFailed = false;

  constructor(private readonly host: NativeHostBinding, options: PtyOptions, private readonly sink: PtySink, private readonly onError: (error: Error) => void) {
    this.resourceId = options.resourceId;
    // The sink is installed before native creation; startPty reserves the resource synchronously.
    this.ready = host.startPty(options);
    this.finished = this.pump();
    // Observe failed starts even if the owner's teardown races its awaited creation.
    void this.ready.catch(() => { this.startFailed = true; });
  }

  private async pump(): Promise<void> {
    try {
      await this.ready;
      for (;;) {
        const event = await this.host.readPty(this.resourceId);
        if (!event) break;
        if (event.resourceId !== this.resourceId || event.sequence !== this.lastSequence + 1) throw new Error('NATIVE_EVENT_SEQUENCE: missing, reordered, or wrong-resource PTY event');
        this.lastSequence = event.sequence;
        if (!this.callbackEnabled) continue;
        await this.sink(event);
        this.deliveredSequence = event.sequence;
      }
    } catch (error) {
      this.deliveryError = error instanceof Error ? error.message : String(error);
      const notifyOwner = this.callbackEnabled;
      this.callbackEnabled = false;
      if (notifyOwner) {
        try { this.onError(error instanceof Error ? error : new Error(String(error))); } catch { /* The error remains in the close report. */ }
      }
      // Closing is synchronous on entry to the addon, before its asynchronous waiter is queued.
      try { await this.host.closePty(this.resourceId, 1000); } catch { /* A creation failure may have no resource. */ }
    } finally {
      try {
        this.terminalReport = this.host.ptyReport(this.resourceId);
        if (this.terminalReport.state === 'closed') this.host.releasePty(this.resourceId);
      } catch { /* A failed registration has no resource to release. */ }
      this.pumpSettled = true;
    }
  }

  /** Physical worker termination and settled delivery; this does not erase an incomplete close report. */
  get stopped(): boolean {
    if (!this.pumpSettled) return false;
    if (this.terminalReport?.state !== 'closed') {
      try { this.terminalReport = this.host.ptyReport(this.resourceId); }
      catch { return this.startFailed && !this.terminalReport; }
    }
    if (this.terminalReport.state !== 'closed') return false;
    this.host.releasePty(this.resourceId);
    return true;
  }

  write(data: Buffer, deadlineMs = 5000, operationId = randomUUID()): Promise<CommandResult> {
    validDeadline(deadlineMs);
    if (this.closing || this.terminalReport) return Promise.reject(new Error('CLOSED: PTY is closing or closed'));
    return this.host.writePty(this.resourceId, operationId, data, deadlineMs);
  }

  resize(cols: number, rows: number, deadlineMs = 5000, operationId = randomUUID()): Promise<CommandResult> {
    validDeadline(deadlineMs);
    if (this.closing || this.terminalReport) return Promise.reject(new Error('CLOSED: PTY is closing or closed'));
    return this.host.resizePty(this.resourceId, operationId, cols, rows, deadlineMs);
  }

  cancel(operationId: string): boolean {
    if (this.terminalReport) return false;
    return this.host.cancelPtyOperation(this.resourceId, operationId);
  }

  /** Shared promise; after it resolves the event pump can never invoke the sink again. */
  close(deadlineMs = 2000): Promise<PtyCloseReport> {
    validDeadline(deadlineMs);
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.performClose(Date.now() + deadlineMs, deadlineMs);
    return this.closePromise;
  }

  private async performClose(until: number, deadlineMs: number): Promise<PtyCloseReport> {
    let report = this.terminalReport;
    let waiterComplete = true;
    try {
      if (!report) {
        const result = await beforeDeadline(this.host.closePty(this.resourceId, deadlineMs), until);
        waiterComplete = result.done;
        if (result.done) report = result.value;
      }
      const delivery = await beforeDeadline(this.finished, until);
      report ??= this.terminalReport ?? this.host.ptyReport(this.resourceId);
      const deliveryComplete = delivery.done && this.deliveredSequence === report.lastSequence && !this.deliveryError;
      return { ...report, complete: report.complete && waiterComplete && deliveryComplete, deliveryComplete, deliveredSequence: this.deliveredSequence,
        deliveryError: this.deliveryError ?? (!deliveryComplete ? 'PTY event delivery did not finish before the close deadline' : undefined) };
    } finally {
      this.callbackEnabled = false;
      try { this.host.releasePty(this.resourceId); } catch { /* The pump may already have released it. */ }
    }
  }
}
