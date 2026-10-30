import { requireInterruptConfirmation } from './turn-interrupt';
import { IpcHandlerError } from '../ipc/registry';
import { object } from '../ipc/arguments';
import type { ClientEvent } from '../engine/protocol';
import type { EngineClientLike } from './service';

export interface TurnReplyOptions {
  client: EngineClientLike;
  sessionId: string;
  turnId: string;
  signal?: AbortSignal;
  drainMs?: number;
  /** Admission runs inside the session's existing turn-start mutation. */
  start(signal: AbortSignal, admitted: () => void): Promise<void>;
  interrupt(): Promise<unknown>;
  settled(complete: boolean): void;
}

/** Collect only the named facade turn's final assistant item, including completion before its ACK. */
export async function collectTurnReply(options: TurnReplyOptions): Promise<{ reply: string | null }> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  let admitted = false, terminal = false, reply = '';
  let resolve!: () => void, reject!: (error: unknown) => void;
  const outcome = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void outcome.catch(() => {});
  let cancellation: Promise<void> | undefined;
  const stop = (): Promise<void> => cancellation ??= (async () => {
    if (terminal || !admitted || options.client.isClosed()) return;
    try { requireInterruptConfirmation(await options.interrupt()); }
    catch (error) { if (!terminal && !options.client.isClosed()) throw new IpcHandlerError('CANCEL_FAILED', `The messaging turn could not be interrupted: ${String(error)}`); }
    if (terminal || options.client.isClosed()) return;
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        outcome.catch(() => {}),
        new Promise<void>((_, fail) => { deadline = setTimeout(() => fail(new IpcHandlerError('CANCEL_FAILED', 'The engine did not finish the interrupted messaging turn')), options.drainMs ?? 15_000); }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); }
  })();
  const abort = (): void => { if (admitted && !terminal) void stop().catch(reject); };
  const receive = (event: ClientEvent): void => {
    if (event.type === 'streamClosed') { terminal = true; reject(new IpcHandlerError('ENGINE_DISCONNECTED', 'The engine exited during the messaging turn')); return; }
    if (event.type !== 'turnCompleted' && event.type !== 'productEvent') return;
    const params = object(event.params);
    if (terminal || params?.sessionId !== options.sessionId || (params.submissionId ?? params.turnId) !== options.turnId) return;
    if (event.type === 'turnCompleted') {
      terminal = true;
      const result = object(params.result), failure = result?.error;
      if (failure != null) reject(new Error(typeof failure === 'string' ? failure : JSON.stringify(failure)));
      else if (result?.stopReason === 'aborted') reject(new IpcHandlerError('TURN_INTERRUPTED', 'The messaging turn was interrupted'));
      else {
        if (result && Object.hasOwn(result, 'finalText')) reply = typeof result.finalText === 'string' ? result.finalText : '';
        if (Buffer.byteLength(reply) > 1024 * 1024) reject(new Error('The messaging reply exceeded the 1 MiB limit'));
        else resolve();
      }
    } else if (event.method === 'turn/failed') {
      terminal = true;
      const detail = object(params.detail), error = object(detail?.error);
      reject(new Error(typeof error?.message === 'string' ? error.message : typeof detail?.error === 'string' ? detail.error : 'The messaging turn failed'));
    } else if (event.method === 'item/completed') {
      const item = object(params.item);
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        if (Buffer.byteLength(item.text) > 1024 * 1024) controller.abort(new Error('The messaging reply exceeded the 1 MiB limit'));
        else reply = item.text;
      }
    }
  };
  options.client.on('event', receive);
  signal.addEventListener('abort', abort, { once: true });
  try {
    try { await options.start(signal, () => { admitted = true; if (signal.aborted) queueMicrotask(abort); }); }
    catch (error) {
      // A formal JSON-RPC rejection proves that this start was not accepted.
      if (object(error)?.kind === 'server') terminal = true;
      throw error;
    }
    await outcome;
    signal.throwIfAborted();
    return { reply: reply.trim() ? reply : null };
  } finally {
    try { if (admitted && !terminal && !options.client.isClosed()) await stop(); }
    finally {
      signal.removeEventListener('abort', abort);
      options.client.off('event', receive);
      options.settled(!admitted || terminal || options.client.isClosed());
    }
  }
}
