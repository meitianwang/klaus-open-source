import { sameGoalIntent, type GoalMutationGuard, type GoalSnapshot } from './types'

/** Revisions include absence so a late read cannot resurrect a cleared goal. */
export class GoalSnapshots {
  private values = new Map<string, { goal: GoalSnapshot | null; revision: number; intentVersion: number }>()
  private readonly reads = new Map<string, symbol>()
  get(sessionId: string): GoalSnapshot | null { return this.values.get(sessionId)?.goal ?? null }
  has(sessionId: string): boolean { return this.values.has(sessionId) }
  intentVersion(sessionId: string): number { return this.values.get(sessionId)?.intentVersion ?? 0 }
  revision(sessionId: string): number { return this.values.get(sessionId)?.revision ?? 0 }
  guard(sessionId: string, captured: GoalSnapshot): GoalMutationGuard {
    const current = this.values.get(sessionId)?.goal ?? null
    if (!sameGoalIntent(captured, current) || !current || current.revision === undefined
      || captured.intentVersion !== undefined && captured.intentVersion !== current.intentVersion) throw new Error('Goal intent changed')
    return { expectedGoalId: current.goalId, expectedGoalRevision: current.revision }
  }
  readToken(sessionId: string): symbol { const token = Symbol(); this.reads.set(sessionId, token); return token }
  isCurrentRead(sessionId: string, token: symbol): boolean { return this.reads.get(sessionId) === token }
  finishRead(sessionId: string, token: symbol): void { if (this.isCurrentRead(sessionId, token)) this.reads.delete(sessionId) }
  forget(sessionId: string): void { this.reads.delete(sessionId); this.values.delete(sessionId) }
  receive(sessionId: string, goal: GoalSnapshot | null, revision: number, readToken?: symbol): boolean {
    const previous = this.values.get(sessionId)
    if (readToken !== undefined && !this.isCurrentRead(sessionId, readToken)) return false
    if (previous && revision < previous.revision) return false
    // Replaying an unchanged cached snapshot must not cancel an explicit read.
    if (previous && revision === previous.revision && (previous.goal === null && goal === null
      || sameGoalIntent(previous.goal, goal) && previous.goal?.tokensUsed === goal?.tokensUsed
        && previous.goal?.timeUsedSeconds === goal?.timeUsedSeconds && previous.goal?.createdAtMs === goal?.createdAtMs
        && previous.goal?.updatedAtMs === goal?.updatedAtMs && previous.goal?.objectiveMaterialized === goal?.objectiveMaterialized)) return true
    const intentVersion = previous && (previous.goal === null && goal === null || sameGoalIntent(previous.goal, goal)) ? previous.intentVersion : (previous?.intentVersion ?? 0) + 1
    this.reads.delete(sessionId)
    this.values.set(sessionId, { goal: goal ? { ...goal, revision, intentVersion } : null, revision, intentVersion })
    return true
  }
}
