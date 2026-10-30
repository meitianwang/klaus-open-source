import { useEffect, useSyncExternalStore } from 'react'
import { createPlanReviewController, type PlanReviewController } from './plan-controller'
import { ProposedPlanCard, ProposedPlanReview } from './plan-card'
import type { PlanningApi, PlanningSnapshot, ProposedPlan } from './types'

const snapshots = new Map<string, PlanningSnapshot>()
const controllers = new Map<string, PlanReviewController>()
const listeners = new Set<() => void>()
let version = 0
let integration: null | { api: PlanningApi; open(sessionId: string, controller: PlanReviewController): void; download(content: string): Promise<void> } = null

export function configurePlanningWorkflow(options: NonNullable<typeof integration>) { integration = options }
export function planningSnapshot(sessionId: string) { return snapshots.get(sessionId) }
export function subscribePlanningWorkflow(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function pendingProposedPlan(sessionId: string) {
  return snapshots.get(sessionId)?.plans.filter(plan => plan.status === 'proposed' && plan.reviewPending !== false).at(-1)
}
export function receivePlanningSnapshot(sessionId: string, planning: PlanningSnapshot): boolean {
  if (planning.revision < (snapshots.get(sessionId)?.revision ?? -1)) return false
  snapshots.set(sessionId, planning)
  for (const plan of planning.plans) controllers.get(`${sessionId}:${plan.id}`)?.sync(plan)
  version++
  for (const listener of listeners) listener()
  return true
}
export function planReviewController(sessionId: string, plan: ProposedPlan): PlanReviewController | null {
  if (!integration) return null
  const key = `${sessionId}:${plan.id}`
  let controller = controllers.get(key)
  if (!controller) {
    controller = createPlanReviewController(sessionId, plan, integration.api, snapshot => {
      receivePlanningSnapshot(sessionId, snapshot)
      window.dispatchEvent(new CustomEvent('klaus:planning-snapshot', { detail: { sessionId, planning: snapshot } }))
    })
    controllers.set(key, controller)
  }
  return controller
}
export function ProposedPlanView({ plan, sessionId }: { plan: ProposedPlan; sessionId: string }) {
  useSyncExternalStore(subscribePlanningWorkflow, () => version, () => version)
  const snapshot = snapshots.get(sessionId)
  const saved = snapshot?.plans.find(entry => entry.id === plan.id)
  const latest = saved && !(plan.status === 'writing' && plan.content.length > saved.content.length) ? saved : plan
  const controller = planReviewController(sessionId, latest)
  useEffect(() => { controller?.sync(latest) }, [controller, latest])
  if (!controller || !integration) return null
  return <ProposedPlanCard controller={controller} onOpen={() => integration?.open(sessionId, controller)} download={integration.download} />
}

export function PendingPlanReview({ sessionId }: { sessionId: string }) {
  useSyncExternalStore(subscribePlanningWorkflow, () => version, () => version)
  const plan = pendingProposedPlan(sessionId)
  const controller = plan ? planReviewController(sessionId, plan) : null
  useEffect(() => { if (plan) controller?.sync(plan) }, [controller, plan])
  return controller ? <ProposedPlanReview controller={controller} /> : null
}

if (typeof window !== 'undefined') window.addEventListener('klaus:session-change', () => { for (const controller of controllers.values()) controller.invalidateBinding() })
