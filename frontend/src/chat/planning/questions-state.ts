export interface PlanningQuestionIdentity {
  sessionId: string
  turnId: string
  toolCallId: string
  requestId: string
}

export interface PlanningQuestion {
  id: string
  header: string
  question: string
  options: Array<{ label: string; description: string }>
  allowOther?: boolean
  isOther?: boolean
  isSecret?: boolean
}

export type PlanningQuestionStatus = 'pending' | 'answered' | 'skipped' | 'cancelled' | 'expired'
export type PlanningQuestionResolvedStatus = Exclude<PlanningQuestionStatus, 'pending'>
export interface PlanningQuestionAnswers { answers: Record<string, { answers: string[] }> }

export interface PlanningQuestionRequest extends PlanningQuestionIdentity {
  questions: PlanningQuestion[]
  status: PlanningQuestionStatus
  answers?: PlanningQuestionAnswers['answers']
  optional?: boolean
  revision?: number
}

export interface PlanningQuestionDraftAnswer {
  selected: string | null
  other: boolean
  text: string
}

export interface PlanningQuestionDraft {
  index: number
  focusedOption: number
  answers: Record<string, PlanningQuestionDraftAnswer>
}

export function planningQuestionIdentity(request: PlanningQuestionIdentity): PlanningQuestionIdentity {
  return { sessionId: request.sessionId, turnId: request.turnId, toolCallId: request.toolCallId, requestId: request.requestId }
}

export function planningQuestionKey(request: PlanningQuestionIdentity): string {
  return JSON.stringify([request.sessionId, request.turnId, request.toolCallId, request.requestId])
}

export function planningQuestionAllowsOther(question: PlanningQuestion): boolean {
  return question.allowOther ?? question.isOther ?? true
}

/** This surface accepts the structured single-choice contract only. */
export function validPlanningQuestions(request: PlanningQuestionRequest): boolean {
  if (![request.sessionId, request.turnId, request.toolCallId, request.requestId].every(value => typeof value === 'string' && value.length > 0)
    || !['pending', 'answered', 'skipped', 'cancelled', 'expired'].includes(request.status)
    || !Array.isArray(request.questions) || request.questions.length < 1 || request.questions.length > 3) return false
  const ids = new Set<string>()
  return request.questions.every(question => {
    const incoming = question as PlanningQuestion & { multiSelect?: boolean; attachments?: unknown }
    if (!question || typeof question.id !== 'string' || !question.id.trim() || ids.has(question.id)
      || typeof question.header !== 'string' || !question.header.trim() || Array.from(question.header).length > 12
      || typeof question.question !== 'string' || !question.question.trim()
      || [question.allowOther, question.isOther, question.isSecret].some(value => value !== undefined && typeof value !== 'boolean')
      || !Array.isArray(question.options) || question.options.length < 2 || question.options.length > 3
      || incoming.multiSelect === true || incoming.attachments !== undefined) return false
    ids.add(question.id)
    const labels = new Set<string>()
    return question.options.every(option => {
      if (!option || typeof option.label !== 'string' || !option.label.trim() || labels.has(option.label)
        || typeof option.description !== 'string' || !option.description.trim()) return false
      labels.add(option.label)
      return true
    })
  })
}

export function planningQuestionDraft(questions: PlanningQuestion[], previous?: PlanningQuestionDraft): PlanningQuestionDraft {
  const answers = Object.fromEntries(questions.map(question => {
    const saved = previous?.answers[question.id]
    const selected = saved?.selected && question.options.some(option => option.label === saved.selected) ? saved.selected : null
    return [question.id, { selected, other: planningQuestionAllowsOther(question) && saved?.other === true, text: saved?.text || '' }]
  }))
  const index = Math.min(previous?.index || 0, Math.max(0, questions.length - 1))
  const question = questions[index]
  const lastOption = question ? question.options.length - (planningQuestionAllowsOther(question) ? 0 : 1) : 0
  return { index, focusedOption: Math.min(previous?.focusedOption || 0, lastOption), answers }
}

export function planningQuestionAnswer(question: PlanningQuestion, draft: PlanningQuestionDraft): string | null {
  const answer = draft.answers[question.id]
  if (!answer) return null
  if (answer.other) return planningQuestionAllowsOther(question) && answer.text.trim() ? answer.text.trim() : null
  return question.options.some(option => option.label === answer.selected) ? answer.selected : null
}

export function planningQuestionsReady(request: PlanningQuestionRequest, draft: PlanningQuestionDraft): boolean {
  return validPlanningQuestions(request) && request.questions.every(question => planningQuestionAnswer(question, draft) !== null)
}

export function planningQuestionResult(request: PlanningQuestionRequest, draft?: PlanningQuestionDraft): PlanningQuestionAnswers {
  return { answers: Object.fromEntries(request.questions.map(question => {
    const answer = draft ? planningQuestionAnswer(question, draft) : null
    return [question.id, { answers: answer === null ? [] : [answer] }]
  })) }
}
