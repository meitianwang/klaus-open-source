import type { TurnInterruptOrigin, TurnInterruptOutcome } from '../../contracts/planning-goals';
import type { ClientEvent } from '../engine/protocol';
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

/** A dispatch acknowledgement does not confirm the engine's atomic pause and cancellation. */
export async function interruptTurn(options: {
  client: EngineClientLike; sessionId: string; rendererId: string; origin: TurnInterruptOrigin; expectedTurnId?: string;
  outcomeTimeoutMs?: number;
}): Promise<TurnInterruptOutcome> {
  const { client, sessionId, rendererId, origin, expectedTurnId } = options;
  const controller = new AbortController(), early = new Map<string, TurnInterruptOutcome | IpcHandlerError>();
  let correlation: string | undefined, timer: NodeJS.Timeout | undefined;
  let resolve!: (outcome: TurnInterruptOutcome) => void, reject!: (error: unknown) => void;
  const completion = new Promise<TurnInterruptOutcome>((yes, no) => { resolve = yes; reject = no; });
  const deliver = (outcome: TurnInterruptOutcome | IpcHandlerError): void => {
    if (outcome instanceof IpcHandlerError) reject(outcome); else resolve(outcome);
  };
  const receive = (event: ClientEvent): void => {
    if (event.type === 'streamClosed') { reject(new IpcHandlerError('ENGINE_DISCONNECTED', 'The engine disconnected before confirming the interruption')); return; }
    if (event.type !== 'rawSessionEvent' && event.type !== 'sessionEvent' && event.type !== 'engineEvent') return;
    const params = object(event.params), envelope = object(params?.event) ?? params;
    if (params?.sessionId !== sessionId || !envelope || typeof envelope.submissionId !== 'string' || !envelope.submissionId || envelope.turnInterrupt === undefined) return;
    const outcome = turnInterruptOutcome(envelope.turnInterrupt) ?? new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid final interruption outcome');
    if (correlation !== undefined) { if (envelope.submissionId === correlation) deliver(outcome); return; }
    early.set(envelope.submissionId, outcome);
    while (early.size > 32) early.delete(early.keys().next().value!);
  };
  client.on('event', receive);
  try {
    timer = setTimeout(() => reject(new IpcHandlerError('TURN_INTERRUPT_UNCONFIRMED', 'The engine did not confirm the interruption before its control deadline')), options.outcomeTimeoutMs ?? 30_000);
    const dispatch = async (): Promise<TurnInterruptOutcome> => {
      const ack = object(await client.requestWithTimeout('turn/interrupt', { sessionId, origin, ...(expectedTurnId ? { expectedTurnId } : {}) },
        origin === 'user-stop' ? 500 : 15_000, { priority: origin === 'user-stop' ? 'critical' : 'interactive', conversationId: rendererId, signal: controller.signal }));
      if (!ack || typeof ack.submissionId !== 'string' || !ack.submissionId) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine did not acknowledge the interruption request');
      correlation = ack.submissionId;
      const outcome = early.get(correlation); early.clear();
      if (outcome) deliver(outcome);
      return completion;
    };
    return await Promise.race([dispatch(), completion]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort(); client.off('event', receive); early.clear();
  }
}
