import { getSessionStream, ingestAsyncQuestionResolution, resolveLiveApproval, updateAsyncQuestionUi } from '../stream-store'
import { canAnswerAsyncQuestion, closeAsyncQuestionPanel, setAsyncQuestionSubmission } from './async-question-state'
import { questionAnswerKey, questionAnswers, questionAttachments } from './question-state'

/** Submit only filled drafts in the expanded queue; skipped questions stay answerable. */
async function submitSnapshot(sessionId: string, ownerTurnId: string, panelId: number): Promise<void> {
  const initial = getSessionStream(sessionId)
  const queuedItems = new Set(initial.asyncQuestions.panel?.items.map(item => JSON.stringify(item)) || [])
  const requestIds = [...new Set(initial.asyncQuestions.panel?.items.map(item => item.requestId) || [])]
  const submissions = requestIds.flatMap(requestId => {
    const interaction = initial.asyncQuestions.requests[requestId]
    if (!canAnswerAsyncQuestion(interaction, initial.running, initial.activeTurnId)
      || interaction.state === 'submitting' || interaction.draft.uploading || interaction.draft.readingClipboard) return []
    const queuedQuestions = new Set(initial.asyncQuestions.panel?.items.filter(item => item.requestId === requestId)
      .map(item => questionAnswerKey(interaction.request.toolInput.questions[item.index])))
    const answers = Object.fromEntries(Object.entries(questionAnswers(interaction.request.toolInput.questions, interaction.draft))
      .filter(([question]) => queuedQuestions.has(question) && !Object.hasOwn(interaction.answers, question)))
    if (!Object.keys(answers).length) return []
    const attachments = Object.fromEntries(Object.entries(questionAttachments(interaction.request.toolInput.questions, interaction.draft))
      .filter(([question]) => Object.hasOwn(answers, question)))
    const payload = JSON.stringify({ answers, attachments })
    const clientResponseId = interaction.submissionPayload === payload && interaction.clientResponseId
      ? interaction.clientResponseId : crypto.randomUUID()
    return [{ requestId, turnId: interaction.request.turnId, answers, attachments, payload, clientResponseId }]
  })
  let submitted = false
  for (const { requestId, turnId, answers, attachments, payload, clientResponseId } of submissions) {
    const session = getSessionStream(sessionId)
    if (!canAnswerAsyncQuestion(session.asyncQuestions.requests[requestId], session.running, session.activeTurnId)) continue
    updateAsyncQuestionUi(sessionId, ui => setAsyncQuestionSubmission(ui, requestId, clientResponseId, undefined, payload))
    try {
      const result = await window.klaus.question.answer(sessionId, requestId, turnId, clientResponseId, answers,
        Object.keys(attachments).length ? attachments : undefined)
      if (result.accepted !== true) throw new Error('The answer was not accepted.')
      ingestAsyncQuestionResolution({ sessionId, requestId, turnId, state: result.state, answers })
      // The badge counted the question when it arrived; this submit path never
      // runs the card's respond(), so release the count here.
      ;(window as unknown as { untrackApprovalRequest?: (id: string) => void }).untrackApprovalRequest?.(requestId)
      submitted = true
    } catch (cause) {
      updateAsyncQuestionUi(sessionId, ui => {
        if (!canAnswerAsyncQuestion(ui.requests[requestId], getSessionStream(sessionId).running, getSessionStream(sessionId).activeTurnId)) return ui
        return setAsyncQuestionSubmission(ui, requestId, clientResponseId, cause instanceof Error ? cause.message : String(cause))
      })
      throw cause
    }
  }
  // An explicit skip does not send an empty steering message or close the turn.
  if (getSessionStream(sessionId).activeTurnId !== ownerTurnId || getSessionStream(sessionId).asyncQuestions.panel?.id !== panelId) return
  if (getSessionStream(sessionId).asyncQuestions.panel?.items.some(item => !queuedItems.has(JSON.stringify(item)))) return
  if (!submitted || !getSessionStream(sessionId).asyncQuestions.panel?.items.some(item => {
    const row = getSessionStream(sessionId).asyncQuestions.requests[item.requestId]
    return row && Object.keys(questionAnswers(row.request.toolInput.questions, row.draft))
      .some(question => !Object.hasOwn(row.answers, question))
  })) updateAsyncQuestionUi(sessionId, closeAsyncQuestionPanel)
}

/** The user declined an optional question outright: terminal on the client,
 *  the sidebar wait clears, and no reopen chip remains. The engine keeps the
 *  question pending until its turn closes, which is the documented fate of an
 *  unanswered optional question. */
export function declineAsyncQuestionRequest(sessionId: string, requestId: string): void {
  ;(window as unknown as { untrackApprovalRequest?: (id: string) => void }).untrackApprovalRequest?.(requestId)
  resolveLiveApproval(sessionId, requestId, { mode: 'skipped', answers: {} })
}

const submissionsInFlight = new Map<string, Promise<void>>()
export function submitAsyncQuestionPanel(sessionId: string): Promise<void> {
  const owner = getSessionStream(sessionId)
  if (!owner.running || !owner.activeTurnId || !owner.asyncQuestions.panel) return Promise.resolve()
  const ownerTurnId = owner.activeTurnId
  const key = JSON.stringify([sessionId, ownerTurnId])
  const panelId = owner.asyncQuestions.panel.id
  const existing = submissionsInFlight.get(key)
  if (existing) return existing
  updateAsyncQuestionUi(sessionId, ui => ({ ...ui, submitting: true, submittingTurnId: ownerTurnId, panel: ui.panel ? { ...ui.panel, deadlineMs: null } : null }))
  const promise = submitSnapshot(sessionId, ownerTurnId, panelId).finally(() => {
    submissionsInFlight.delete(key)
    updateAsyncQuestionUi(sessionId, ui => ui.submittingTurnId === ownerTurnId ? { ...ui, submitting: false, submittingTurnId: undefined } : ui)
  })
  submissionsInFlight.set(key, promise)
  return promise
}
