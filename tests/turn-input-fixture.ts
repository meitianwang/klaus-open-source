import type { Json } from '../main/ipc/contract';

/** Build a real admission reply from the recorded turn/submit request. */
export function acceptedTurnInput(value: Json, fallbackSubmissionId = 'fixture-turn'): Json {
  const params = value as Record<string, Json>;
  const submissionId = typeof params.submissionId === 'string' ? params.submissionId : fallbackSubmissionId;
  const steering = params.mode === 'steer';
  return { status: steering ? 'steered' : 'started', submissionId,
    turnId: steering ? String(params.expectedTurnId) : submissionId };
}
