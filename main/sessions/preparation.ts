import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';

/** Preparation deadlines expire a waiter, never the server-owned recovery. */
export const SESSION_PREPARATION_TIMEOUTS_MS = [120_000, 240_000, 480_000] as const;
export const SESSION_PREPARATION_CLOSING_DELAYS_MS = [750, 1500, 3000, 6000] as const;

interface PreparationClient {
  requestWithTimeout(method: string, params: Json, timeoutMs: number): Promise<unknown>;
}

/** Extract bare RPC failures without hiding the server's explanation. */
export function sessionFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
    if (record.kind === 'timeout') return `The engine request timed out${typeof record.method === 'string' ? ` (${record.method})` : ''}`;
    if (record.kind === 'closed') return 'The engine connection closed';
    try { return JSON.stringify(error); } catch { return 'The engine request failed'; }
  }
  return String(error);
}

export class SessionPreparationPendingError extends Error {
  readonly code = 'SESSION_PREPARATION_PENDING';
  constructor(override readonly cause: unknown) {
    super('The conversation is still restoring. Retry to reconnect to the same recovery.');
  }
}

/** Reattach each deadline retry to the same core publication single-flight. */
export async function prepareSession(client: PreparationClient, engineId: string, assertCurrent: () => void,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<void> {
  let timeoutAttempt = 0, closingAttempt = 0;
  while (true) {
    assertCurrent();
    try {
      const reply = object(await client.requestWithTimeout('session/prepare', { sessionId: engineId }, SESSION_PREPARATION_TIMEOUTS_MS[timeoutAttempt]!));
      assertCurrent();
      if (reply?.ready !== true || reply.sessionId !== engineId) throw new Error('The engine did not confirm conversation readiness');
      return;
    } catch (error) {
      assertCurrent();
      const failure = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {};
      if (failure.kind === 'timeout') {
        if (++timeoutAttempt < SESSION_PREPARATION_TIMEOUTS_MS.length) continue;
        throw new SessionPreparationPendingError(error);
      }
      const closing = failure.kind === 'server' && typeof failure.message === 'string'
        && /\b(?:session|conversation)\b.*\b(?:closing|shut down)\b/i.test(failure.message);
      if (!closing || closingAttempt >= SESSION_PREPARATION_CLOSING_DELAYS_MS.length) throw error;
      await wait(SESSION_PREPARATION_CLOSING_DELAYS_MS[closingAttempt++]!);
    }
  }
}
