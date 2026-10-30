import type { ClientEvent } from './protocol';
import type { Json } from '../ipc/contract';

export interface AcknowledgedClient {
  requestWithTimeout(method: string, params: Json, timeoutMs: number): Promise<unknown>;
  on(event: 'event', listener: (event: ClientEvent) => void): unknown;
  off(event: 'event', listener: (event: ClientEvent) => void): unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Observe before submission: a local engine can publish its outcome before the ACK. */
export async function requestAcknowledged(
  client: AcknowledgedClient, method: string, params: Record<string, Json>, field: string, timeoutMs = 15_000, signal?: AbortSignal,
  acknowledgementField: 'submissionId' | 'turnId' = 'submissionId',
): Promise<unknown> {
  signal?.throwIfAborted();
  let submissionId: string | undefined;
  const early = new Map<string, Record<string, unknown>>();
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const completed = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  void completed.catch(() => undefined);
  const settle = (envelope: Record<string, unknown>): void => {
    if (typeof envelope.error === 'string') reject(new Error(envelope.error));
    else if (field in envelope) resolve(envelope[field]);
  };
  const receive = (event: ClientEvent): void => {
    if (event.type === 'streamClosed') {
      reject(new Error(`${method}: connection closed before the operation completed`));
      return;
    }
    if (event.type !== 'engineEvent' && event.type !== 'rawSessionEvent') return;
    const outer = record(event.params);
    const envelope = record(outer?.event) ?? outer;
    if (!envelope || (!(field in envelope) && typeof envelope.error !== 'string')) return;
    const id = envelope.submissionId ?? envelope.id;
    if (typeof id !== 'string') return;
    if (submissionId === id) settle(envelope);
    else if (!submissionId) {
      if (early.size >= 128) reject(new Error(`${method}: too many outcomes before acknowledgement`));
      else early.set(id, envelope);
    }
  };
  const timer = setTimeout(() => reject(new Error(`${method}: timed out waiting for ${field}`)), timeoutMs);
  const abort = (): void => reject(new Error(`${method}: outcome observation was cancelled`));
  client.on('event', receive);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const ack = record(await Promise.race([client.requestWithTimeout(method, params, timeoutMs), completed]));
    if (typeof ack?.error === 'string') throw new Error(ack.error);
    if (ack && field in ack) return ack[field];
    const identity = ack?.[acknowledgementField];
    if (typeof identity !== 'string' || !identity) {
      throw new Error(`${method}: reply carried neither ${field} nor a ${acknowledgementField}`);
    }
    submissionId = identity;
    const received = early.get(submissionId);
    if (received) settle(received);
    early.clear();
    return await completed;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    client.off('event', receive);
  }
}
