import type { TurnInterruptOrigin, TurnInterruptOutcome } from '../../contracts/planning-goals';
import { object } from '../ipc/arguments';
import { IpcHandlerError } from '../ipc/registry';
import type { EngineClientLike } from './service';

export function turnInterruptOutcome(value: unknown): TurnInterruptOutcome | undefined {
  const row = object(value);
  if (!row || typeof row.accepted !== 'boolean'
    || row.interruptedTurnId !== undefined && (typeof row.interruptedTurnId !== 'string' || !row.interruptedTurnId || row.interruptedTurnId.length > 256)
    || row.goalPauseError !== undefined && typeof row.goalPauseError !== 'string') return undefined;
  return { accepted: row.accepted, ...(typeof row.interruptedTurnId === 'string' ? { interruptedTurnId: row.interruptedTurnId } : {}),
    ...(typeof row.goalPauseError === 'string' ? { goalPauseError: row.goalPauseError.slice(0, 8192) } : {}) };
}

/** Trusted callers must not turn a dispatch acknowledgement or failed pause into success. */
export function requireInterruptConfirmation(value: unknown): void {
  const result = object(value);
  if (result?.confirmed === true && result.accepted === false) throw new IpcHandlerError('TURN_INTERRUPT_REJECTED', 'The captured turn no longer accepts interruption');
  if (result?.confirmed === false || typeof result?.interruptionError === 'string') {
    throw new IpcHandlerError('TURN_INTERRUPT_UNCONFIRMED', typeof result?.interruptionError === 'string' ? result.interruptionError : 'The engine did not confirm the interruption');
  }
  if (typeof result?.goalPauseError === 'string' && result.goalPauseError) throw new IpcHandlerError('GOAL_PAUSE_FAILED', result.goalPauseError);
}

/**
 * The engine's `turn/interrupt` reply is the settled interruption outcome itself: it
 * arrives only once cancellation has landed, or at once with `accepted:false` when
 * nothing was running, so awaiting the reply is the confirmation. The bounded ceiling
 * keeps a stuck engine from parking callers forever; breaching it surfaces to the
 * caller as an unconfirmed result, never as a transcript notice.
 */
export async function interruptTurn(options: {
  client: EngineClientLike; sessionId: string; rendererId: string; origin: TurnInterruptOrigin; expectedTurnId?: string;
  outcomeTimeoutMs?: number;
}): Promise<TurnInterruptOutcome> {
  const { client, sessionId, rendererId, origin, expectedTurnId } = options;
  const response = await client.requestWithTimeout('turn/interrupt', { sessionId, origin, ...(expectedTurnId ? { expectedTurnId } : {}) },
    options.outcomeTimeoutMs ?? 30_000, { priority: origin === 'user-stop' ? 'critical' : 'interactive', conversationId: rendererId });
  const outcome = turnInterruptOutcome(response);
  if (!outcome) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid final interruption outcome');
  return outcome;
}
