import { useSyncExternalStore } from 'react'
import { createPlanningQuestionsController, type PlanningQuestionAcknowledgement, type PlanningQuestionResolution, type PlanningQuestionsController } from './questions-controller'
import { PlanningQuestionHistory, PlanningQuestionsCard } from './questions'
import { planningQuestionHistory } from './question-history'
import { planningQuestionKey, type PlanningQuestionIdentity, type PlanningQuestionRequest } from './questions-state'

const requests = new Map<string, PlanningQuestionRequest>()
const controllers = new Map<string, PlanningQuestionsController>()
const listeners = new Set<() => void>()
const sessionEpochs = new Map<string, number>()
let version = 0
let respond: (identity: PlanningQuestionIdentity, resolution: PlanningQuestionResolution) => Promise<PlanningQuestionAcknowledgement> = async () => ({ accepted: false })
export function configurePlanningQuestions(callback: typeof respond) { respond = callback }
export function subscribePlanningQuestions(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function receivePlanningQuestion(request: PlanningQuestionRequest): void {
  const key = planningQuestionKey(request)
  const previous = requests.get(key)
  if (previous?.revision !== undefined && request.revision !== undefined && request.revision < previous.revision) return
  if (previous && previous.status !== 'pending' && request.status === 'pending') return
  requests.set(key, request)
  sessionEpochs.set(request.sessionId, (sessionEpochs.get(request.sessionId) ?? 0) + 1)
  const controller = controllers.get(key)
  if (controller) controller.reconcile(request)
  version++
  for (const listener of listeners) listener()
}
export function planningQuestionReadToken(sessionId: string): number { return sessionEpochs.get(sessionId) ?? 0 }
export function reconcilePlanningQuestionRead(sessionId: string, incoming: PlanningQuestionRequest[], token: number): boolean {
  if (planningQuestionReadToken(sessionId) !== token) return false
  const present = new Set(incoming.map(planningQuestionKey))
  for (const request of requests.values()) if (request.sessionId === sessionId && request.status === 'pending' && !present.has(planningQuestionKey(request))) receivePlanningQuestion({ ...request, status: 'expired' })
  for (const request of incoming) if (request.sessionId === sessionId) receivePlanningQuestion(request)
  return true
}
export function planningQuestionController(request: PlanningQuestionRequest): PlanningQuestionsController {
  const key = planningQuestionKey(request)
  let controller = controllers.get(key)
  if (!controller) {
    controller = createPlanningQuestionsController({ request: requests.get(key) ?? request, respond: (identity, resolution) => respond(identity, resolution) })
    const currentController = controller
    controller.subscribe(() => {
      const current = currentController.getSnapshot().request
      if (current.status !== 'pending' && (!requests.has(key) || requests.get(key)?.status === 'pending')) receivePlanningQuestion(current)
    })
    controllers.set(key, controller)
  }
  return controller
}
export function pendingPlanningQuestions(sessionId: string) { return [...requests.values()].filter(request => request.sessionId === sessionId && request.status === 'pending') }
export function planningQuestionForTool(sessionId: string, toolCallId: string, turnId?: string): PlanningQuestionRequest | undefined {
  const matches = [...requests.values()].filter(request => request.sessionId === sessionId && request.toolCallId === toolCallId
    && (turnId === undefined || request.turnId === turnId))
  return matches.length === 1 ? matches[0] : undefined
}
export function PlanningQuestionHistoryView({ sessionId, turnId, block, readOnly = false }: {
  sessionId: string; turnId?: string; block: Parameters<typeof planningQuestionHistory>[0]; readOnly?: boolean
}) {
  useSyncExternalStore(subscribePlanningQuestions, () => version, () => version)
  const saved = planningQuestionHistory(block)
  const live = planningQuestionForTool(sessionId, block.id, turnId)
  const request = saved.status === 'pending' && live ? live : saved
  const active = pendingPlanningQuestions(sessionId).at(-1)
  if (!readOnly && request.status === 'pending' && live && active && planningQuestionKey(active) === planningQuestionKey(live)
    && window.currentSessionId === sessionId) return null
  return <PlanningQuestionHistory request={request} />
}
export function PlanningQuestionView({ request, inComposer = false, readOnly = false }: { request: PlanningQuestionRequest; inComposer?: boolean; readOnly?: boolean }) {
  useSyncExternalStore(subscribePlanningQuestions, () => version, () => version)
  const latest = requests.get(planningQuestionKey(request)) ?? request
  const active = pendingPlanningQuestions(request.sessionId).at(-1)
  const isActive = !!active && planningQuestionKey(active) === planningQuestionKey(latest) && window.currentSessionId === request.sessionId
  if (!inComposer && isActive && latest.status === 'pending' && !readOnly) return null
  if (readOnly || latest.status === 'pending' && (!inComposer || !isActive)) return <PlanningQuestionHistory request={latest} />
  return <PlanningQuestionsCard controller={planningQuestionController(latest)} active={inComposer && isActive} allowSkip={latest.optional === true} language={(window as any).currentLang === 'zh' ? 'zh' : 'en'} />
}
