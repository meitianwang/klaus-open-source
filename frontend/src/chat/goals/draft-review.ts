import { sameGoalIntent, type GoalSnapshot } from './types'

export interface GoalDraftBinding<Draft, Attachment> {
  sessionId: string | null
  draft: Draft
  attachments: readonly Attachment[]
  interactionToken?: string
  attachmentSnapshot?: string
}

/** Navigation and Stop invalidate pending work even after returning to the same chat. */
export class GoalInteractionClock {
  private navigation = 0
  private sequence = 0
  private stopped = new Map<string, number>()
  navigate(): void { this.navigation++ }
  stop(sessionId: string): void {
    this.stopped.delete(sessionId)
    this.stopped.set(sessionId, ++this.sequence)
    while (this.stopped.size > 1000) this.stopped.delete(this.stopped.keys().next().value!)
  }
  token(sessionId: string | null): string { return `${this.navigation}:${sessionId ? this.stopped.get(sessionId) ?? 0 : 0}` }
  /** Goal routes die with navigation and Stop; ordinary message submits keep their target. */
  routeInvalidated(goalMode: boolean, sessionId: string | null, capturedToken: string): boolean {
    return goalMode && this.token(sessionId) !== capturedToken
  }
}

export function sameGoalDraft<Draft, Attachment>(captured: GoalDraftBinding<Draft, Attachment>, current: GoalDraftBinding<Draft, Attachment>): boolean {
  return captured.sessionId === current.sessionId && captured.interactionToken === current.interactionToken && captured.attachmentSnapshot === current.attachmentSnapshot
    && JSON.stringify(captured.draft) === JSON.stringify(current.draft)
    && captured.attachments.length === current.attachments.length && captured.attachments.every((attachment, index) => attachment === current.attachments[index])
}

export function sameGoalReview(captured: GoalSnapshot | null, current: GoalSnapshot | null): boolean {
  return captured === null ? current === null : sameGoalIntent(captured, current)
    && (captured.intentVersion === undefined || captured.intentVersion === current?.intentVersion)
}

export function goalSubmissionRoute(armed: boolean): 'goal' | 'message' { return armed ? 'goal' : 'message' }

interface PreparedObjective { objective: string; displayText: string; preparationId?: string }

/** Review authoritative intent before creating files; only that reviewed draft may submit. */
export async function reviewGoalDraft<Draft, Attachment, Prepared extends PreparedObjective>(options: {
  binding: GoalDraftBinding<Draft, Attachment>
  current(): GoalDraftBinding<Draft, Attachment>
  objective: string
  readGoal(): Promise<GoalSnapshot | null>
  currentGoal(): GoalSnapshot | null
  goalIntentVersion(): number
  prepare(goal: GoalSnapshot | null, valid: () => boolean): Promise<Prepared | null>
  readObjective(goal: GoalSnapshot): Promise<string>
  confirm(goal: GoalSnapshot, objective: string): Promise<boolean>
  discard(prepared: Prepared): Promise<void>
}): Promise<{ prepared: Prepared; goal: GoalSnapshot | null; intentVersion: number } | null> {
  const draftCurrent = () => sameGoalDraft(options.binding, options.current())
  if (!draftCurrent()) return null
  const goal = await options.readGoal()
  const intentVersion = options.goalIntentVersion()
  const valid = () => draftCurrent() && intentVersion === options.goalIntentVersion() && sameGoalReview(goal, options.currentGoal())
  if (!valid()) return null
  if (goal && goal.status !== 'complete') {
    const previous = goal.objectiveMaterialized && options.binding.attachments.length === 0
      ? await options.readObjective(goal) : goal.objective
    if (!valid()) return null
    const changed = previous.trim() !== options.objective.trim() || options.binding.attachments.length > 0
    if (changed && !(await options.confirm(goal, options.objective))) return null
    if (!valid()) return null
  }
  const prepared = await options.prepare(options.currentGoal(), valid)
  if (!prepared) return null
  if (!valid()) { await options.discard(prepared); return null }
  return { prepared, goal: options.currentGoal(), intentVersion }
}

export async function reviewGoalResume(options: {
  goal: GoalSnapshot
  valid(): boolean
  readGoal(): Promise<GoalSnapshot | null>
  currentGoal(): GoalSnapshot | null
  readObjective(goal: GoalSnapshot): Promise<string>
}): Promise<{ goal: GoalSnapshot; objective: string } | null> {
  const goal = await options.readGoal()
  if (!options.valid() || !goal || !sameGoalReview(options.goal, goal)
    || !['paused', 'blocked', 'usage_limited'].includes(goal.status)) return null
  const objective = await options.readObjective(goal)
  const current = options.currentGoal()
  return options.valid() && current && sameGoalReview(goal, current) ? { goal: current, objective } : null
}
