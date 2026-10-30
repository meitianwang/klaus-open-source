import {
  planningQuestionAllowsOther, planningQuestionDraft, planningQuestionIdentity, planningQuestionKey, planningQuestionResult, planningQuestionsReady,
  validPlanningQuestions, type PlanningQuestionAnswers, type PlanningQuestionDraft, type PlanningQuestionIdentity,
  type PlanningQuestionRequest, type PlanningQuestionResolvedStatus,
} from './questions-state'

export interface PlanningQuestionResolution {
  status: PlanningQuestionResolvedStatus
  response: PlanningQuestionAnswers
}

export interface PlanningQuestionAcknowledgement {
  accepted: boolean
  status?: PlanningQuestionResolvedStatus
  response?: PlanningQuestionAnswers
  identity?: PlanningQuestionIdentity
}

export interface PlanningQuestionsSnapshot {
  request: PlanningQuestionRequest
  draft: PlanningQuestionDraft
  submitting: boolean
  failed: boolean
  valid: boolean
}

export interface PlanningQuestionsControllerOptions {
  request: PlanningQuestionRequest
  respond(identity: PlanningQuestionIdentity, resolution: PlanningQuestionResolution): Promise<PlanningQuestionAcknowledgement>
}

/** A controller belongs to one displayed request. Keep it across renderer rebinds. */
export function createPlanningQuestionsController(options: PlanningQuestionsControllerOptions) {
  let snapshot: PlanningQuestionsSnapshot = {
    request: options.request,
    draft: planningQuestionDraft(validPlanningQuestions(options.request) ? options.request.questions : []),
    submitting: false, failed: false, valid: validPlanningQuestions(options.request),
  }
  let operation = 0
  let disposed = false
  const listeners = new Set<() => void>()
  const publish = (next: PlanningQuestionsSnapshot) => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const editable = () => !disposed && snapshot.valid && snapshot.request.status === 'pending' && !snapshot.submitting
  const edit = (draft: PlanningQuestionDraft) => { if (editable()) publish({ ...snapshot, draft, failed: false }) }
  const answerContract = (request: PlanningQuestionRequest) => JSON.stringify(request.questions.map(question =>
    [question.id, question.options.map(option => option.label).sort(), planningQuestionAllowsOther(question)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))

  async function respond(status: 'answered' | 'skipped' | 'cancelled'): Promise<boolean> {
    if (!editable() || status === 'answered' && !planningQuestionsReady(snapshot.request, snapshot.draft)) return false
    const identity = planningQuestionIdentity(snapshot.request)
    const key = planningQuestionKey(identity)
    const currentOperation = ++operation
    const response = planningQuestionResult(snapshot.request, status === 'answered' ? snapshot.draft : undefined)
    publish({ ...snapshot, submitting: true, failed: false })
    try {
      const result = await options.respond(identity, { status, response })
      if (disposed || currentOperation !== operation || planningQuestionKey(snapshot.request) !== key) return false
      if (!result?.accepted || result.identity && planningQuestionKey(result.identity) !== key) throw new Error('Question response was not accepted')
      publish({ ...snapshot, request: { ...snapshot.request, status: result.status || status, answers: (result.response || response).answers }, submitting: false, failed: false })
      return true
    } catch {
      if (!disposed && currentOperation === operation && planningQuestionKey(snapshot.request) === key)
        publish({ ...snapshot, submitting: false, failed: true })
      return false
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    editDraft(draft: PlanningQuestionDraft): void { edit(planningQuestionDraft(snapshot.request.questions, draft)) },
    reconcile(request: PlanningQuestionRequest): void {
      if (disposed) return
      const same = planningQuestionKey(request) === planningQuestionKey(snapshot.request)
      if (same && request.revision !== undefined && snapshot.request.revision !== undefined && request.revision < snapshot.request.revision) return
      if (same && snapshot.request.status !== 'pending' && request.status === 'pending') return
      const valid = validPlanningQuestions(request)
      const invalidate = !same || request.status !== 'pending' || !valid || !snapshot.valid || answerContract(request) !== answerContract(snapshot.request)
      if (invalidate) operation++
      const selectedId = snapshot.valid ? snapshot.request.questions[snapshot.draft.index]?.id : undefined
      const index = valid ? request.questions.findIndex(question => question.id === selectedId) : 0
      const previousDraft = same ? { ...snapshot.draft, index: Math.max(0, index) } : undefined
      publish({ request, valid, draft: planningQuestionDraft(valid ? request.questions : [], previousDraft),
        submitting: !invalidate && snapshot.submitting, failed: same && !invalidate && snapshot.failed })
    },
    navigate(index: number): void {
      if (!editable() || index < 0 || index >= snapshot.request.questions.length) return
      const question = snapshot.request.questions[index]
      const answer = snapshot.draft.answers[question.id]
      const selected = answer.other ? question.options.length : question.options.findIndex(option => option.label === answer.selected)
      edit({ ...snapshot.draft, index, focusedOption: Math.max(0, selected) })
    },
    select(index: number): void {
      const question = snapshot.request.questions[snapshot.draft.index]
      if (!editable() || !question || index < 0 || index >= question.options.length + (planningQuestionAllowsOther(question) ? 1 : 0)) return
      const answer = snapshot.draft.answers[question.id]
      edit({ ...snapshot.draft, focusedOption: index, answers: { ...snapshot.draft.answers, [question.id]: {
        ...answer, selected: question.options[index]?.label || null, other: index === question.options.length,
      } } })
    },
    setOtherText(text: string): void {
      const question = snapshot.request.questions[snapshot.draft.index]
      if (!editable() || !question || !planningQuestionAllowsOther(question)) return
      edit({ ...snapshot.draft, focusedOption: question.options.length, answers: { ...snapshot.draft.answers,
        [question.id]: { selected: null, other: true, text } } })
    },
    submit: () => respond('answered'),
    skip: () => respond('skipped'),
    cancel: () => respond('cancelled'),
    dispose(): void { disposed = true; operation++; listeners.clear() },
  }
}

export type PlanningQuestionsController = ReturnType<typeof createPlanningQuestionsController>
