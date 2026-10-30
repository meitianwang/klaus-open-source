export type GoalStatus = 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete'

/** An authoritative goal snapshot; timestamps are Unix milliseconds. */
export interface GoalSnapshot {
  goalId: string
  threadId: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAtMs: number
  updatedAtMs: number
  revision?: number
  intentVersion?: number
  /** The objective is a reference that must be read before editing. */
  objectiveMaterialized?: boolean
}

export type GoalLocale = 'en' | 'zh' | string
export type GoalTurnMetadata = Partial<import('../../../../contracts/planning-goals').GoalTurnMetadata>
export type GoalAction = 'pause' | 'resume' | 'clear'
export type GoalActionResult = void | { ok?: boolean; error?: unknown }
export type GoalActionCallback = (goal: GoalSnapshot) => Promise<GoalActionResult>

export function goalNextStatus(status: GoalStatus): 'active' | 'paused' | null {
  if (status === 'active') return 'paused'
  if (status === 'paused' || status === 'blocked' || status === 'usage_limited') return 'active'
  return null
}

/** Accounting updates may advance a revision without changing the user's intent. */
export function sameGoalIntent(left: GoalSnapshot | null, right: GoalSnapshot | null): boolean {
  return !!left && !!right && left.goalId === right.goalId && left.threadId === right.threadId
    && left.objective === right.objective && left.status === right.status && left.tokenBudget === right.tokenBudget
}
export interface GoalMutationGuard { expectedGoalId: string; expectedGoalRevision: number }
