import type { AcknowledgedClient } from './acknowledged';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';

export type TurnInputMode = 'start-if-idle' | 'continue-if-idle' | 'steer' | 'start-or-steer';
export interface TurnInputRequest {
  sessionId: string;
  input: Json;
  mode: TurnInputMode;
  submissionId?: string;
  expectedTurnId?: string;
  options?: Json;
  queueMessageId?: string;
  delivery?: 'user' | 'delegation';
  displayMetadata?: Json;
}
export interface TurnInputAccepted {
  status: 'started' | 'steered';
  submissionId: string;
  turnId: string;
}
export interface TurnInputReason {
  code: string;
  [key: string]: Json;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
const refusalMessages: Record<string, string> = {
  'not-idle': 'A turn is already running for this conversation.',
  'no-active-turn': 'No turn is running for this conversation.',
  'expected-turn-mismatch': 'The running turn changed before this message could be delivered.',
  'active-turn-not-steerable': 'The current operation cannot accept follow-up messages.',
  'session-closing': 'The conversation is closing.',
  'empty-input': 'A message needs text or an attachment.',
  'invalid-input': 'The message could not be accepted.',
};

/** A typed refusal proves that this submission did not retain or execute input. */
export class TurnInputRefusedError extends IpcHandlerError {
  readonly kind = 'server';
  constructor(readonly reason: TurnInputReason) {
    super(reason.code === 'not-idle' ? 'TURN_IN_PROGRESS' : 'TURN_INPUT_REFUSED',
      refusalMessages[reason.code] ?? 'The engine declined this message.');
  }
}

/** An invalid acknowledgement cannot prove that issued input was rejected. */
export class InvalidTurnInputReplyError extends Error {
  readonly kind = 'invalid_ack';
  constructor() { super('The engine did not confirm this message submission.'); }
}

/** Submit once; the engine owns the atomic routing decision. Acceptance is not application. */
export async function submitTurnInput(
  client: AcknowledgedClient, request: TurnInputRequest, timeoutMs: number,
): Promise<TurnInputAccepted> {
  if (request.mode === 'steer' && !request.expectedTurnId) {
    throw new TurnInputRefusedError({ code: 'invalid-input' });
  }
  return decodeTurnInputReply(await client.requestWithTimeout('turn/submit', { ...request }, timeoutMs), request);
}

/** All direct and queued admissions share the same identity and uncertainty checks. */
export function decodeTurnInputReply(value: unknown, request: TurnInputRequest): TurnInputAccepted {
  const response = record(value);
  if (!response || typeof response.submissionId !== 'string' || !response.submissionId
    || (request.submissionId !== undefined && response.submissionId !== request.submissionId)) {
    throw new InvalidTurnInputReplyError();
  }
  if (response.status === 'not-submitted') {
    const reason = record(response.reason);
    if (!reason || typeof reason.code !== 'string' || !reason.code) throw new InvalidTurnInputReplyError();
    throw new TurnInputRefusedError(reason as TurnInputReason);
  }
  if ((response.status !== 'started' && response.status !== 'steered')
    || typeof response.turnId !== 'string' || !response.turnId
    || ((request.mode === 'start-if-idle' || request.mode === 'continue-if-idle') && response.status !== 'started')
    || (request.mode === 'steer' && response.status !== 'steered')
    || (response.status === 'steered' && request.expectedTurnId !== undefined && response.turnId !== request.expectedTurnId)
    || (response.status === 'started' && (request.expectedTurnId !== undefined || response.turnId !== response.submissionId))) {
    throw new InvalidTurnInputReplyError();
  }
  return { status: response.status, submissionId: response.submissionId, turnId: response.turnId };
}
