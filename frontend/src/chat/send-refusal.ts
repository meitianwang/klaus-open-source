/**
 * Host refusals that are routing instructions, not provider failures.
 *
 * A send that reaches the host while a turn still owns the conversation is
 * refused with TURN_IN_PROGRESS and the wording "use a follow-up": the payload
 * belongs to the follow-up channel (steer or queue), and the refusal itself is
 * internal coordination the transcript must never surface as a row.
 */
export function isTurnInProgressRefusal(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown } | null | undefined
  if (!err || typeof err !== 'object') return false
  if (err.code === 'TURN_IN_PROGRESS') return true
  return typeof err.message === 'string' && err.message.includes('Use a follow-up while a turn is running')
}
