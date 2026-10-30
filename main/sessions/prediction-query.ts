import { randomUUID } from 'node:crypto';
import { IpcHandlerError } from '../ipc/registry';
import { object } from '../services/service-types';
import type { EngineClientLike } from './service';

/** Cancellation is sent on the captured connection after request registration. */
export async function queryPrediction(client: EngineClientLike, sessionId: string, sourceTurnId: string, prompt: string, effort: string | null, signal: AbortSignal): Promise<{ suggestion: string | null }> {
  signal.throwIfAborted();
  const requestId = `prediction-${randomUUID()}`;
  let cancellation: Promise<void> | undefined;
  const answer = client.requestWithTimeout('session/predictMessage', { sessionId, requestId, sourceTurnId, prompt, ...(effort ? { effort } : {}) }, 45_000,
    { priority: 'background', source: 'thread', conversationId: sessionId });
  const cancel = (): void => {
    cancellation ??= client.isClosed() ? Promise.resolve() : client.requestWithTimeout('session/cancelPrediction', { sessionId, requestId }, 15_000,
      { priority: 'critical', source: 'thread', conversationId: sessionId }).then(reply => {
      const ack = object(reply);
      if (typeof ack.submissionId !== 'string' || ack.error != null) throw new IpcHandlerError('CANCEL_FAILED', 'Prediction cancellation was not acknowledged');
    });
    void cancellation.catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const reply = object(await answer);
    if (cancellation) await cancellation;
    signal.throwIfAborted();
    if (reply.suggestion !== null && typeof reply.suggestion !== 'string') throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid prediction');
    return { suggestion: typeof reply.suggestion === 'string' ? reply.suggestion.trim() || null : null };
  } catch (error) {
    cancel();
    if (cancellation) await cancellation;
    throw error;
  } finally { signal.removeEventListener('abort', cancel); }
}
