// What happens when the user sends a message while their queue is paused.
//
// The situation: the user stopped a turn, so the queued follow-ups paused instead
// of draining (that pause is deliberate — after an interruption the queued messages
// were written for a turn that no longer exists). Now they type a NEW message.
// Sending it says nothing about the paused rows, so the product has to ask rather
// than guess.
//
// Both answers send. They differ only in what happens to the queue: the primary
// "Send message" treats the interruption as over and resumes the paused rows,
// while the destructive "Clear queue" drops them. No third answer is offered.
//
// Clearing releases nothing: queued media are durable `uploads/` paths
// that only `wipeLocal` ever removes — so clearing a queue drops the rows and
// leaves those files where they already were.
//
// Split out as a pure function so the decision table is testable: the dialog is UI,
// but "which of the three things did the user choose" is a rule.
export type PausedQueueAnswer = 'send-and-resume' | 'send-and-clear' | 'cancel'

/** Which of the dialog's three exits was taken. */
export interface PausedQueueChoice {
  /** Dismissed via Escape, backdrop or Cancel — nothing is sent. */
  cancelled: boolean
  /** The destructive "Clear queue" button rather than the primary one. */
  clear: boolean
}

/**
 * Map one dialog outcome onto a queue decision.
 *
 * A dismissed dialog is `cancel` and must NOT send: the user was asked a question
 * and did not answer it, so the composer keeps its text. A queued message that went
 * out after the user pressed Escape would be worse than either button.
 */
export function pausedQueueDecision(choice: PausedQueueChoice | null | undefined): PausedQueueAnswer {
  if (!choice || choice.cancelled) return 'cancel'
  return choice.clear ? 'send-and-clear' : 'send-and-resume'
}

/** The result shape `klausDialog.confirm` resolves with when a checkbox is set. */
export interface ConfirmDialogResult {
  confirmed: boolean
  checked?: boolean
}

/**
 * Map the raw dialog result onto a queue decision.
 *
 * This translation is its own step rather than living inline in the send path
 * because the two shapes do not match field for field: the dialog answers
 * `{confirmed, checked}` while the decision is `{cancelled, clear}`. Getting it
 * wrong is silent and one-directional — a wrong mapping still returns *a* valid
 * decision, so the queue would just do the wrong thing (keep rows the user asked to
 * clear, or clear rows they wanted kept) with nothing to report it.
 *
 * `confirmed: false` never sends. The user was asked a question and did not answer
 * it, so a message that went out after Escape or a backdrop click would be worse
 * than either button.
 */
export function decisionFromDialog(result: ConfirmDialogResult | null | undefined): PausedQueueAnswer {
  return pausedQueueDecision({
    cancelled: !result || result.confirmed !== true,
    // The checkbox is the third state and only means anything together with a
    // confirmed send, which the cancelled check above already established.
    clear: result?.checked === true,
  })
}

/**
 * Whether the send has to ask at all.
 *
 * A queue that is merely non-empty is not a reason to interrupt the user: asking on
 * every queued message would put a modal in the ordinary path. Only a PAUSED queue
 * is ambiguous, because those rows will not run on their own.
 *
 * The caller derives `queueIsPaused` from the host's snapshot `interrupted` flag. It
 * is deliberately not called `queuePaused`: that was the name of a wire field on the
 * `done` event, which was removed once the host took over pausing. Reusing the name
 * here would point a reader at a field that no longer exists.
 */
export function needsPausedQueueConfirmation(queueIsPaused: boolean, queuedCount: number): boolean {
  return queueIsPaused === true && Number.isFinite(queuedCount) && queuedCount > 0
}
