export interface SpecGoalSnapshot {
  status?: string
  goalId?: string
  objective?: string
}

export type SpecReviewError =
  | 'spec_review_load_failed'
  | 'spec_review_empty'
  | 'spec_review_changed'
  | 'spec_review_goal_failed'
  | 'spec_review_goal_path_required'
  | 'spec_review_approval_failed'
  | 'spec_review_execution_failed'

export interface SpecReviewState {
  documentStatus: 'loading' | 'ready' | 'error'
  content: string
  baseline: string
  revision?: string
  phase: 'pending' | 'starting' | 'accepted' | 'ran' | 'failed' | 'cancelled'
  goalEnabled: boolean
  goalLocked: boolean
  error: SpecReviewError | null
}

export interface SpecReviewDependencies {
  readDocument(path: string): Promise<{ content?: string; error?: string; revision?: string }>
  getGoal(): Promise<SpecGoalSnapshot | null>
  setGoal(objective: string): Promise<{ ok?: boolean; goal?: SpecGoalSnapshot | null; error?: unknown }>
  respond(decision: 'allow' | 'deny', updatedInput?: Record<string, unknown>): Promise<unknown>
  goalObjective(path: string): string
}

export function isLiveSpecGoal(goal: SpecGoalSnapshot | null | undefined): boolean {
  return !!goal && typeof goal.status === 'string' && goal.status !== 'complete'
}

/** A Spec goal points at the durable document, including edits made at approval. */
export function buildSpecGoalObjective(path: string, template: string): string {
  const documentPath = String(path || '').trim()
  if (!documentPath) return ''
  const instruction = String(template || '').trim()
  if (!instruction) return documentPath
  return instruction.includes('{path}')
    ? instruction.replaceAll('{path}', documentPath)
    : `${instruction}\n\n${documentPath}`
}

export function isSpecExecuteShortcut(event: {
  key: string; metaKey: boolean; ctrlKey: boolean; altKey?: boolean; isComposing?: boolean
}): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.isComposing
}

export type SpecReviewToolStatus = 'running' | 'awaiting-approval' | 'ok' | 'error' | 'interrupted'

/** An approval acknowledgement only releases the tool; its result is authoritative. */
export function specReviewPhase(
  phase: SpecReviewState['phase'], decision?: string, toolStatus?: SpecReviewToolStatus,
): SpecReviewState['phase'] {
  if (decision && decision !== 'allow') return 'cancelled'
  if (toolStatus === 'ok') return 'ran'
  if (toolStatus === 'error') return 'failed'
  if (toolStatus === 'interrupted') return 'cancelled'
  if (decision === 'allow' && (phase === 'pending' || phase === 'starting')) return 'accepted'
  return phase
}

/** Owns the approval transaction without consuming a pending ask on any failure. */
export function createSpecReviewController(
  request: { input: Record<string, unknown>; path: string },
  deps: SpecReviewDependencies,
  initialGoal: SpecGoalSnapshot | null = null,
) {
  const inline = typeof request.input.plan === 'string' ? request.input.plan : ''
  let state: SpecReviewState = {
    documentStatus: request.path ? 'loading' : inline.trim() ? 'ready' : 'error',
    content: request.path ? '' : inline,
    baseline: request.path ? '' : inline,
    revision: typeof request.input.planRevision === 'string' ? request.input.planRevision : undefined,
    phase: 'pending',
    goalEnabled: isLiveSpecGoal(initialGoal),
    goalLocked: isLiveSpecGoal(initialGoal),
    error: !request.path && !inline.trim() ? 'spec_review_empty' : null,
  }
  const listeners = new Set<() => void>()
  let documentRevision = 0
  let operationRevision = 0
  // A successful Goal creation survives a retry of only the approval response.
  let establishedGoal = isLiveSpecGoal(initialGoal) ? initialGoal : null

  function patch(next: Partial<SpecReviewState>) {
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  }

  function syncGoal(goal: SpecGoalSnapshot | null) {
    if (isLiveSpecGoal(goal)) {
      establishedGoal = goal
      patch({ goalEnabled: true, goalLocked: true })
    } else {
      establishedGoal = null
      patch({ goalLocked: false })
    }
  }

  async function loadDocument(): Promise<void> {
    if (!request.path || state.phase !== 'pending') return
    const revision = ++documentRevision
    patch({ documentStatus: 'loading', error: null })
    try {
      const result = await deps.readDocument(request.path)
      if (revision !== documentRevision) return
      if (result.error || typeof result.content !== 'string') throw new Error('Document unavailable')
      if (!result.content.trim()) {
        patch({ documentStatus: 'error', error: 'spec_review_empty' })
        return
      }
      patch({ documentStatus: 'ready', content: result.content, baseline: result.content, revision: result.revision, error: null })
    } catch {
      if (revision === documentRevision) patch({ documentStatus: 'error', error: 'spec_review_load_failed' })
    }
  }

  async function approve(): Promise<boolean> {
    if (state.phase !== 'pending' || state.documentStatus !== 'ready') return false
    if (!state.content.trim()) {
      patch({ error: 'spec_review_empty' })
      return false
    }
    const revision = ++operationRevision
    const content = state.content
    const baseline = state.baseline
    const planRevision = state.revision
    const wantsGoal = state.goalEnabled
    const active = () => revision === operationRevision && state.phase === 'starting'
    let failure: SpecReviewError = 'spec_review_load_failed'
    patch({ phase: 'starting', error: null })
    try {
      // Never submit a stale editor over a file revised after this card loaded.
      if (request.path) {
        const latest = await deps.readDocument(request.path)
        if (!active()) return false
        if (latest.error || typeof latest.content !== 'string') throw new Error('Document unavailable')
        if (latest.content !== baseline || (planRevision && latest.revision && latest.revision !== planRevision)) {
          failure = 'spec_review_changed'
          throw new Error('Document changed')
        }
      }
      if (wantsGoal) {
        failure = 'spec_review_goal_failed'
        const liveGoal = establishedGoal || await deps.getGoal()
        if (!active()) return false
        if (isLiveSpecGoal(liveGoal)) {
          syncGoal(liveGoal)
        } else {
          if (!request.path) {
            failure = 'spec_review_goal_path_required'
            throw new Error('Spec path required')
          }
          const result = await deps.setGoal(deps.goalObjective(request.path))
          if (!active()) return false
          if (result?.ok !== true || result.error || !isLiveSpecGoal(result.goal)) throw new Error('Goal creation failed')
          syncGoal(result.goal || null)
        }
      }
      failure = 'spec_review_approval_failed'
      // Always replace the original tool's inline summary with the full document.
      const result = await deps.respond('allow', {
        ...request.input, plan: content,
        ...(planRevision ? { planRevision } : {}),
      })
      if (revision !== operationRevision) return false
      if (result && typeof result === 'object') {
        const response = result as { ok?: boolean; error?: unknown }
        if (response.ok === false || response.error) throw new Error('Approval failed')
      }
      if (active()) patch({ phase: 'accepted', error: null })
      return true
    } catch {
      if (active()) patch({ phase: 'pending', error: failure })
      return false
    }
  }

  async function cancel(): Promise<boolean> {
    if (state.phase !== 'pending') return false
    const revision = ++operationRevision
    patch({ phase: 'starting', error: null })
    try {
      const result = await deps.respond('deny')
      if (revision !== operationRevision) return false
      if (result && typeof result === 'object') {
        const response = result as { ok?: boolean; error?: unknown }
        if (response.ok === false || response.error) throw new Error('Cancellation failed')
      }
      patch({ phase: 'cancelled', error: null })
      return true
    } catch {
      if (revision === operationRevision) patch({ phase: 'pending', error: 'spec_review_approval_failed' })
      return false
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    loadDocument,
    approve,
    cancel,
    syncGoal,
    completeTool(status?: SpecReviewToolStatus) {
      const phase = specReviewPhase(state.phase, state.phase === 'cancelled' ? 'cancelled' : undefined, status)
      if (phase !== state.phase) patch({ phase, error: phase === 'failed' ? 'spec_review_execution_failed' : null })
    },
    edit(content: string) {
      if (state.phase === 'pending' && state.documentStatus === 'ready') {
        patch({ content, error: state.error === 'spec_review_changed' ? state.error : null })
      }
    },
    setGoalEnabled(enabled: boolean) {
      if (state.phase === 'pending' && !state.goalLocked) patch({ goalEnabled: enabled, error: null })
    },
    resolve(decision: string) {
      operationRevision++
      documentRevision++
      const phase = specReviewPhase(state.phase, decision)
      patch({ phase, error: phase === 'failed' ? 'spec_review_execution_failed' : null })
    },
  }
}
