import type { PlanDocument, PlanningApi, PlanningSnapshot, ProposedPlan } from './types'

export type PlanImplementationMode = 'standard' | 'goal' | 'orchestrate' | 'ultra'

export interface PlanImplementationHooks {
  prepareMode?(sessionId: string, mode: PlanImplementationMode, content: string): Promise<boolean>
  goalState?(sessionId: string): { eligible: boolean; locked: boolean }
}

export interface PlanReviewState {
  plan: ProposedPlan
  content: string
  baseline: string
  document: PlanDocument | null
  phase: 'ready' | 'loading' | 'saving' | 'accepting' | 'sending-feedback' | 'cancelling'
  error: string | null
  editorOpen: boolean
  reviewPending: boolean
  feedbackOpen: boolean
  feedbackDraft: string
  conflict: PlanDocument | null
  implementationMode: PlanImplementationMode
}

/** A review lease is tied to one conversation, artifact, and complete revision. */
export function createPlanReviewController(sessionId: string, plan: ProposedPlan, api: PlanningApi, publish: (planning: PlanningSnapshot) => void, hooks?: PlanImplementationHooks) {
  let state: PlanReviewState = { plan, content: plan.content, baseline: plan.content, document: null, phase: 'ready', error: null, editorOpen: false, feedbackOpen: false, feedbackDraft: '', reviewPending: plan.status === 'proposed' && (plan as ProposedPlan & { reviewPending?: boolean }).reviewPending !== false, conflict: null, implementationMode: 'standard' }
  const listeners = new Set<() => void>()
  let epoch = 0
  let disposed = false
  let actionReceipt: { kind: 'implementation' | 'feedback'; revision: number; content: string; id: string } | null = null
  const patch = (next: Partial<PlanReviewState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const valid = (ticket: number) => !disposed && epoch === ticket
  const identity = () => ({ planId: state.plan.id, revision: state.plan.revision })
  const usable = () => state.plan.status === 'proposed' && state.reviewPending && state.phase === 'ready'
  const key = (kind: 'implementation' | 'feedback', content: string) => {
    if (!actionReceipt || actionReceipt.kind !== kind || actionReceipt.revision !== state.plan.revision || actionReceipt.content !== content) actionReceipt = { kind, revision: state.plan.revision, content, id: globalThis.crypto?.randomUUID?.() ?? `review-${Date.now()}-${Math.random().toString(36).slice(2)}` }
    return actionReceipt.id
  }

  async function loadDocument() {
    if (state.phase !== 'ready') return false
    if (state.plan.status === 'writing') { patch({ editorOpen: true }); return true }
    const ticket = ++epoch
    patch({ phase: 'loading', error: null })
    try {
      const result = await api.readDocument(sessionId, identity())
      if (!valid(ticket)) return false
      if (result.document.planId !== state.plan.id || result.document.revision < state.plan.revision) throw new Error('planning_stale')
      const successor = result.planning.plans.find(plan => plan.id === state.plan.id && plan.revision === result.document.revision)
      if (!successor) throw new Error('planning_stale')
      if (state.content !== state.baseline && result.document.content !== state.baseline) {
        patch({ plan: successor, document: result.document, phase: 'ready', editorOpen: true, error: 'planning_stale', conflict: result.document })
      } else patch({ plan: successor, document: result.document, content: result.document.content, baseline: result.document.content, phase: 'ready', editorOpen: true, conflict: null })
      publish(result.planning)
      if (!valid(ticket)) return false
      return true
    } catch {
      if (valid(ticket)) patch({ phase: 'ready', error: 'planning_document_failed' })
      return false
    }
  }

  async function save() {
    if (state.phase !== 'ready') return false
    if (state.content === state.baseline) return true
    if (state.plan.status !== 'proposed') { patch({ error: 'planning_stale' }); return false }
    const ticket = ++epoch
    const content = state.content
    patch({ phase: 'saving', error: null })
    try {
      const latest = await api.readDocument(sessionId, identity())
      if (!valid(ticket)) return false
      if (latest.document.planId !== state.plan.id || latest.document.revision !== state.plan.revision || latest.document.content !== state.baseline) {
        const successor = latest.planning.plans.find(plan => plan.id === state.plan.id && plan.revision === latest.document.revision)
        patch({ ...(successor ? { plan: successor } : {}), phase: 'ready', error: 'planning_stale', conflict: latest.document })
        publish(latest.planning)
        return false
      }
      const result = await api.saveDocument(sessionId, { ...identity(), content, expectedContent: state.baseline })
      if (!valid(ticket)) return false
      if (result.document.planId !== state.plan.id || result.document.revision < state.plan.revision) throw new Error('planning_stale')
      const successor = result.planning.plans.find(plan => plan.id === state.plan.id && plan.revision === result.document.revision)
      if (!successor || successor.content !== result.document.content) throw new Error('planning_stale')
      patch({ plan: successor, document: result.document, content: result.document.content, baseline: result.document.content, phase: 'ready', conflict: null })
      publish(result.planning)
      if (!valid(ticket)) return false
      return true
    } catch {
      if (valid(ticket)) patch({ phase: 'ready', error: 'planning_save_failed' })
      return false
    }
  }

  async function accept(mode: PlanImplementationMode = state.implementationMode) {
    if (!usable()) return false
    if (!state.content.trim()) { patch({ error: 'planning_empty' }); return false }
    if (mode !== state.implementationMode) patch({ implementationMode: mode })
    // Save the entire review before re-reading the document. The read includes
    // edits from an external editor and detects a superseded artifact revision.
    if (!(await save()) || !usable()) return false
    const ticket = ++epoch
    patch({ phase: 'accepting', error: null })
    try {
      const latest = await api.readDocument(sessionId, identity())
      if (!valid(ticket)) return false
      if (latest.document.planId !== state.plan.id || latest.document.revision < state.plan.revision || !latest.document.content.trim()) throw new Error('planning_stale')
      const successor = latest.planning.plans.find(plan => plan.id === state.plan.id && plan.revision === latest.document.revision)
      if (!successor || successor.status !== 'proposed' || (successor as ProposedPlan & { reviewPending?: boolean }).reviewPending === false) throw new Error('planning_stale')
      patch({ plan: successor, document: latest.document, content: latest.document.content, baseline: latest.document.content })
      if (hooks?.prepareMode) {
        const prepared = await hooks.prepareMode(sessionId, mode, latest.document.content)
        if (!valid(ticket)) return false
        if (!prepared) {
          patch({ phase: 'ready' })
          return false
        }
      }
      const result = await api.accept(sessionId, { ...identity(), content: latest.document.content, clientRequestId: key('implementation', latest.document.content) })
      if (!valid(ticket)) return false
      if (result.accepted === false && result.planning.plans.find(plan => plan.id === state.plan.id)?.status !== 'accepted') throw new Error('Plan admission was refused')
      publish(result.planning)
      if (valid(ticket)) patch({ phase: 'ready' })
      return true
    } catch {
      if (valid(ticket)) patch({ phase: 'ready', error: 'planning_accept_failed' })
      return false
    }
  }

  async function feedback(value: string) {
    if (!usable() || !value.trim()) return false
    const ticket = ++epoch
    patch({ phase: 'sending-feedback', error: null, feedbackOpen: true, feedbackDraft: value })
    try {
      const result = await api.feedback(sessionId, { ...identity(), feedback: value, clientRequestId: key('feedback', value) })
      if (!valid(ticket)) return false
      if (result.accepted === false && (result.planning.plans.find(plan => plan.id === state.plan.id) as (ProposedPlan & { reviewPending?: boolean }) | undefined)?.reviewPending !== false) throw new Error('Plan feedback was refused')
      patch({ feedbackOpen: false, feedbackDraft: '' })
      publish(result.planning)
      if (valid(ticket)) patch({ phase: 'ready', reviewPending: false })
      return true
    } catch {
      if (valid(ticket)) patch({ phase: 'ready', error: 'planning_feedback_failed' })
      return false
    }
  }

  async function cancel() {
    if (!usable()) return false
    const ticket = ++epoch
    patch({ phase: 'cancelling', error: null })
    try {
      const result = await api.cancel(sessionId, identity())
      if (!valid(ticket)) return false
      publish(result.planning)
      if (valid(ticket)) patch({ phase: 'ready', reviewPending: false, feedbackOpen: false })
      return true
    } catch {
      if (valid(ticket)) patch({ phase: 'ready', error: 'planning_cancel_failed' })
      return false
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    sync(next: ProposedPlan) {
      if (next.id !== state.plan.id || next.threadId !== state.plan.threadId) return
      if (next.revision < state.plan.revision) return
      if (next.revision !== state.plan.revision && state.phase === 'saving' && next.status === 'proposed' && next.content === state.content) {
        patch({ plan: next })
        return
      }
      if (next.revision !== state.plan.revision) {
        epoch++
        actionReceipt = null
        const dirty = state.content !== state.baseline
        patch({ plan: next, ...(dirty ? {} : { content: next.content, baseline: next.content }), document: null, phase: 'ready', reviewPending: next.status === 'proposed' && (next as ProposedPlan & { reviewPending?: boolean }).reviewPending !== false,
          conflict: dirty ? { planId: next.id, revision: next.revision, path: next.documentPath || '', content: next.content } : null, error: dirty ? 'planning_stale' : null })
      } else {
        if (next.status !== state.plan.status && ['superseded', 'interrupted'].includes(next.status)) { epoch++; patch({ phase: 'ready', error: 'planning_stale' }) }
        patch({ plan: next, ...((next as ProposedPlan & { reviewPending?: boolean }).reviewPending !== undefined ? { reviewPending: (next as ProposedPlan & { reviewPending?: boolean }).reviewPending } : next.status !== state.plan.status && next.status === 'proposed' ? { reviewPending: true } : {}), ...(state.content === state.baseline && (!state.editorOpen || next.status === 'writing' || state.plan.status === 'writing') ? { content: next.content, baseline: next.content } : {}) })
      }
    },
    setFeedbackOpen(open: boolean) { if (!disposed && usable()) patch({ feedbackOpen: open }) },
    editFeedback(value: string) { if (!disposed && usable()) patch({ feedbackDraft: value, error: null }) },
    edit(content: string) { if (state.phase === 'ready') patch({ content, error: null }) },
    revert() { if (state.phase === 'ready') patch({ content: state.baseline, error: null }) },
    useSavedDocument() { if (state.phase === 'ready' && state.conflict) patch({ document: state.conflict, content: state.conflict.content, baseline: state.conflict.content, conflict: null, error: null }) },
    async closeEditor() {
      if (state.plan.status !== 'proposed' && state.phase === 'ready') { patch({ editorOpen: false }); return }
      if (await save()) patch({ editorOpen: false })
    },
    openEditor: loadDocument,
    setImplementationMode(mode: PlanImplementationMode) { patch({ implementationMode: mode }) },
    goalState: () => hooks?.goalState?.(sessionId) ?? { eligible: true, locked: false },
    save, accept, feedback, cancel,
    invalidateBinding() {
      epoch++
      if (state.phase !== 'ready') patch({ phase: 'ready', error: 'planning_stale' })
    },
    dispose() { disposed = true; epoch++; state = { ...state, feedbackOpen: false, feedbackDraft: '' }; listeners.clear() },
  }
}
export type PlanReviewController = ReturnType<typeof createPlanReviewController>
