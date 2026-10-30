import { initialQuestionDraft, questionAnswerKey, questionAnswers, type QuestionDraft, type UserQuestion } from './question-state'

export const QUESTION_PANEL_TIMEOUT_MS = 30_000
export const QUESTION_COUNTDOWN_VISIBLE_MS = 20_000

export interface AsyncQuestionRequest {
  requestId: string
  sessionId: string
  turnId: string
  toolCallId?: string
  toolName: 'ask_user_async'
  responseChannel: 'async-question'
  attachmentsSupported?: boolean
  toolInput: { questions: UserQuestion[]; metadata?: unknown }
  answers?: Record<string, string>
  state?: 'pending' | 'submitting' | 'answered' | 'expired' | 'cancelled' | 'declined'
}

export interface QuestionInteraction {
  request: AsyncQuestionRequest
  draft: QuestionDraft
  baseline: QuestionDraft
  answers: Record<string, string>
  state: NonNullable<AsyncQuestionRequest['state']>
  clientResponseId?: string
  submissionPayload?: string
  error?: string
  runtimeRevision: number
}

export interface QuestionPanelItem { requestId: string; index: number }
export interface QuestionPanel {
  id: number
  items: QuestionPanelItem[]
  selected: number
  deadlineMs: number | null
}
export interface AsyncQuestionUi {
  requests: Record<string, QuestionInteraction>
  panel: QuestionPanel | null
  restoredDrafts: Array<{ turnId: string; text: string }>
  submitting?: boolean
  closedTurnIds?: string[]
  panelSequence?: number
  submittingTurnId?: string
  resolutions?: Record<string, { turnId: string; state: QuestionInteraction['state']; answers: Record<string, string> }>
}
export const EMPTY_ASYNC_QUESTIONS: AsyncQuestionUi = { requests: {}, panel: null, restoredDrafts: [] }

export function unansweredQuestionItems(interaction: QuestionInteraction): QuestionPanelItem[] {
  if (!['pending', 'submitting'].includes(interaction.state)) return []
  return interaction.request.toolInput.questions.flatMap((question, index) =>
    Object.hasOwn(interaction.answers, questionAnswerKey(question)) ? [] : [{ requestId: interaction.request.requestId, index }])
}

export function receiveAsyncQuestion(ui: AsyncQuestionUi, request: AsyncQuestionRequest, now: number, recovered = false): AsyncQuestionUi {
  if (ui.closedTurnIds?.includes(request.turnId)) return ui
  const previous = ui.requests[request.requestId]
  const resolution = ui.resolutions?.[request.requestId]?.turnId === request.turnId ? ui.resolutions[request.requestId] : undefined
  const draft = previous?.draft || initialQuestionDraft(request.toolInput.questions, true)
  const interaction: QuestionInteraction = {
    ...previous, request, draft, baseline: previous?.baseline || draft,
    answers: { ...request.answers, ...previous?.answers, ...resolution?.answers },
    // A local decline is the user's verdict and survives recovery: the engine
    // still lists the question as pending until its turn closes, and adopting
    // that wire state would resurrect a question the user already refused.
    state: resolution?.state || (previous?.state === 'declined' ? 'declined' : request.state || previous?.state || 'pending'),
    runtimeRevision: (previous?.runtimeRevision || 0) + 1,
  }
  // Historical prose lives in the transcript; this registry retains only bounded UI state.
  const retained = Object.entries(ui.requests).filter(([id, value]) => id === request.requestId
    || value.request.turnId === request.turnId || ['pending', 'submitting'].includes(value.state)).slice(-127)
  const requests = { ...Object.fromEntries(retained), [request.requestId]: interaction }
  const items = unansweredQuestionItems(interaction)
  let panel = ui.panel
  let panelSequence = ui.panelSequence || 0
  if (!previous && !recovered && items.length) {
    const sameTurn = panel && panel.items.every(item => requests[item.requestId]?.request.turnId === request.turnId)
    panel = sameTurn ? { ...panel!, items: [...panel!.items, ...items] }
      : { id: ++panelSequence, items, selected: 0, deadlineMs: now + QUESTION_PANEL_TIMEOUT_MS }
  }
  const resolutions = { ...ui.resolutions }
  delete resolutions[request.requestId]
  return { ...ui, requests, panel, panelSequence, resolutions }
}

/** Reopen what this surface can still answer when it starts showing a session.
 *
 *  Entering a conversation is itself the "later" a deferred question waits for:
 *  the user chose to look at this chat, so its answerable questions belong in
 *  front of them instead of somewhere up the transcript. That matters because
 *  the transcript copy is process evidence — it folds with its turn and is
 *  unmounted while folded — so a question whose panel went away may have no chip
 *  left to click, and the sidebar pill that still marks the chat carries no
 *  position to scroll to.
 *
 *  The trigger is a surface starting to show a session, never a state change, so
 *  dismissing the panel while still looking at that chat stays dismissed.
 *
 *  A panel that is still counting down is left exactly as it is: rebuilding it
 *  would restart the 30 seconds under someone who is reading. A panel whose
 *  countdown has already elapsed is a different case — leaving the chat unmounts
 *  the card that drives the tick, so the stale deadline survives in the store and
 *  would close the panel the instant it mounts again, making the question flash
 *  and vanish on the way back in. That one is restored from what it held, with
 *  the deadline cleared: like a question reopened from its transcript chip, one
 *  the user came back for does not hide again on a timer. Anything that stopped
 *  being answerable while away drops out, and `canAnswerAsyncQuestion` is what
 *  keeps declined, answered, expired and previous-turn questions out of the
 *  queue built from scratch. */
export function reopenAsyncQuestions(
  ui: AsyncQuestionUi,
  session: { running: boolean; activeTurnId: string | null },
  now: number,
): AsyncQuestionUi {
  // A send in flight owns the panel: rebuilding it here would re-queue a
  // question that is already on its way to the engine.
  if (ui.submitting) return ui
  if (ui.panel) {
    if (ui.panel.deadlineMs == null || ui.panel.deadlineMs > now) return ui
    const panel = ui.panel
    const selected = panel.items[panel.selected]
    const items = panel.items.filter(item => {
      const interaction = ui.requests[item.requestId]
      return !!interaction && canAnswerAsyncQuestion(interaction, session.running, session.activeTurnId)
        && unansweredQuestionItems(interaction).some(value => value.index === item.index)
    })
    if (!items.length) return { ...ui, panel: null }
    const at = items.findIndex(item => item.requestId === selected?.requestId && item.index === selected?.index)
    const panelSequence = (ui.panelSequence || 0) + 1
    return { ...ui, panelSequence, panel: { id: panelSequence, items, selected: Math.max(0, at), deadlineMs: null } }
  }
  const items = Object.values(ui.requests).flatMap(interaction =>
    canAnswerAsyncQuestion(interaction, session.running, session.activeTurnId)
      ? unansweredQuestionItems(interaction) : [])
  if (!items.length) return ui
  const panelSequence = (ui.panelSequence || 0) + 1
  return { ...ui, panelSequence, panel: { id: panelSequence, items, selected: 0, deadlineMs: null } }
}

export function openAsyncQuestion(ui: AsyncQuestionUi, item: QuestionPanelItem): AsyncQuestionUi {
  const interaction = ui.requests[item.requestId]
  if (!interaction || !unansweredQuestionItems(interaction).some(value => value.index === item.index)) return ui
  const panelSequence = (ui.panelSequence || 0) + 1
  return { ...ui, panelSequence, panel: { id: panelSequence, items: [item], selected: 0, deadlineMs: null } }
}

export function closeAsyncQuestionPanel(ui: AsyncQuestionUi, expectedDeadline?: number): AsyncQuestionUi {
  if (expectedDeadline !== undefined && ui.panel?.deadlineMs !== expectedDeadline) return ui
  return ui.panel ? { ...ui, panel: null } : ui
}

export function editAsyncQuestion(ui: AsyncQuestionUi, requestId: string, draft: QuestionDraft): AsyncQuestionUi {
  const interaction = ui.requests[requestId]
  if (!interaction || !['pending', 'submitting'].includes(interaction.state)) return ui
  return { ...ui, requests: { ...ui.requests, [requestId]: { ...interaction, draft, error: undefined } },
    panel: ui.panel ? { ...ui.panel, deadlineMs: null } : null }
}

export function navigateAsyncQuestion(ui: AsyncQuestionUi, selected: number, now: number): AsyncQuestionUi {
  if (!ui.panel || selected < 0 || selected >= ui.panel.items.length) return ui
  return { ...ui, panel: { ...ui.panel, selected, deadlineMs: now + QUESTION_PANEL_TIMEOUT_MS } }
}

export function resetAsyncQuestionDeadline(ui: AsyncQuestionUi, now: number): AsyncQuestionUi {
  if (!ui.panel || ui.panel.deadlineMs === null) return ui
  return { ...ui, panel: { ...ui.panel, deadlineMs: now + QUESTION_PANEL_TIMEOUT_MS } }
}

export function setAsyncQuestionSubmission(ui: AsyncQuestionUi, requestId: string, clientResponseId: string, error?: string, submissionPayload?: string): AsyncQuestionUi {
  const interaction = ui.requests[requestId]
  if (!interaction) return ui
  return { ...ui, requests: { ...ui.requests, [requestId]: { ...interaction,
    clientResponseId, submissionPayload: submissionPayload ?? interaction.submissionPayload, state: error ? 'pending' : 'submitting', error,
    runtimeRevision: interaction.runtimeRevision + 1 } },
    panel: ui.panel ? { ...ui.panel, deadlineMs: null } : null }
}

export function resolveAsyncQuestion(ui: AsyncQuestionUi, requestId: string, state: QuestionInteraction['state'], answers: Record<string, string>): AsyncQuestionUi {
  const interaction = ui.requests[requestId]
  if (!interaction) return ui
  const cumulative = { ...interaction.answers, ...answers }
  const next: QuestionInteraction = { ...interaction, state, answers: cumulative, error: undefined, runtimeRevision: interaction.runtimeRevision + 1 }
  const baseline = { ...interaction.baseline, answers: interaction.baseline.answers.map((row, index) =>
    Object.hasOwn(answers, questionAnswerKey(interaction.request.toolInput.questions[index]))
      ? interaction.draft.answers[index] : row) }
  next.baseline = baseline
  const requests = { ...ui.requests, [requestId]: next }
  const items = ui.panel?.items.filter(item => requests[item.requestId] && unansweredQuestionItems(requests[item.requestId]).some(value => value.index === item.index)) || []
  const selectedItem = ui.panel?.items[ui.panel.selected]
  const selected = selectedItem ? items.findIndex(item => item.requestId === selectedItem.requestId && item.index === selectedItem.index) : -1
  const panel = ui.panel && items.length ? { ...ui.panel, items, selected: Math.max(0, selected) } : null
  return { ...ui, requests, panel }
}

export function expireAsyncQuestions(ui: AsyncQuestionUi, turnId?: string | null): AsyncQuestionUi {
  let changed = false
  const closedTurnIds = [...new Set([...(ui.closedTurnIds || []), ...(turnId ? [turnId] : Object.values(ui.requests).map(row => row.request.turnId))])].slice(-64)
  const restoredDrafts = [...ui.restoredDrafts]
  const requests = Object.fromEntries(Object.entries(ui.requests).map(([id, interaction]) => {
    if (!['pending', 'submitting'].includes(interaction.state) || turnId && interaction.request.turnId !== turnId) return [id, interaction]
    changed = true
    const unsent = questionAnswers(interaction.request.toolInput.questions, interaction.draft)
    const text = interaction.request.toolInput.questions.flatMap((question, index) => {
      if (Object.hasOwn(interaction.answers, questionAnswerKey(question)) || !unsent[questionAnswerKey(question)]) return []
      const answer = interaction.draft.answers[index]
      const baseline = interaction.baseline.answers[index]
      if (JSON.stringify(answer) === JSON.stringify(baseline)) return []
      return [unsent[questionAnswerKey(question)]]
    }).join('\n\n')
    if (text) restoredDrafts.push({ turnId: interaction.request.turnId, text })
    return [id, { ...interaction, state: 'expired' as const, draft: interaction.baseline }]
  }))
  if (!changed) return JSON.stringify(closedTurnIds) === JSON.stringify(ui.closedTurnIds || []) ? ui : { ...ui, closedTurnIds }
  const panel = ui.panel?.items.some(item => requests[item.requestId]?.state === 'expired') ? null : ui.panel
  return { ...ui, requests, panel, restoredDrafts: restoredDrafts.slice(-16), submitting: false, submittingTurnId: undefined, closedTurnIds }
}

export function canAnswerAsyncQuestion(interaction: QuestionInteraction | undefined, running: boolean, activeTurnId: string | null): boolean {
  return !!interaction && running && activeTurnId === interaction.request.turnId
    && ['pending', 'submitting'].includes(interaction.state)
}

/** The user declined a question outright: terminal, no reopen chip, and the
 *  sidebar wait clears. Drafts are kept so a later engine verdict (the turn
 *  closing) can still show what was typed before the decline. */
export function declineAsyncQuestion(ui: AsyncQuestionUi, requestId: string): AsyncQuestionUi {
  const interaction = ui.requests[requestId]
  if (!interaction || !['pending', 'submitting'].includes(interaction.state)) return ui
  const requests = { ...ui.requests, [requestId]: { ...interaction, state: 'declined' as const, error: undefined } }
  const items = ui.panel?.items.filter(item => item.requestId !== requestId) || []
  const selectedItem = ui.panel?.items[ui.panel.selected]
  const selected = selectedItem ? items.findIndex(item => item.requestId === selectedItem.requestId && item.index === selectedItem.index) : -1
  return { ...ui, requests, panel: ui.panel && items.length ? { ...ui.panel, items, selected: Math.max(0, selected) } : null }
}

/** Retire a missing request from an authoritative snapshot without closing sibling requests. */
export function retireAsyncQuestion(ui: AsyncQuestionUi, requestId: string): AsyncQuestionUi {
  const interaction = ui.requests[requestId]
  if (!interaction || !['pending', 'submitting'].includes(interaction.state)) return ui
  const retired = expireAsyncQuestions({ ...ui, requests: { [requestId]: interaction }, panel: null, restoredDrafts: [] }, interaction.request.turnId)
  const items = ui.panel?.items.filter(item => item.requestId !== requestId) || []
  const selectedItem = ui.panel?.items[ui.panel.selected]
  const selected = selectedItem ? items.findIndex(item => item.requestId === selectedItem.requestId && item.index === selectedItem.index) : -1
  return { ...ui, requests: { ...ui.requests, [requestId]: retired.requests[requestId] },
    restoredDrafts: [...ui.restoredDrafts, ...retired.restoredDrafts].slice(-16),
    panel: ui.panel && items.length ? { ...ui.panel, items, selected: Math.max(0, selected) } : null }
}

export function rememberAsyncQuestionResolution(ui: AsyncQuestionUi, requestId: string, turnId: string, state: QuestionInteraction['state'], answers: Record<string, string>): AsyncQuestionUi {
  const retained = Object.entries(ui.resolutions || {}).filter(([id]) => id !== requestId).slice(-127)
  const previous = ui.resolutions?.[requestId]
  return { ...ui, resolutions: { ...Object.fromEntries(retained), [requestId]: { turnId, state, answers: { ...(previous?.turnId === turnId ? previous.answers : {}), ...answers } } } }
}

export function questionCountdown(deadlineMs: number | null | undefined, now: number): number | null {
  if (deadlineMs == null) return null
  const remaining = Math.max(0, deadlineMs - now)
  return remaining <= QUESTION_COUNTDOWN_VISIBLE_MS ? Math.ceil(remaining / 1000) : null
}
