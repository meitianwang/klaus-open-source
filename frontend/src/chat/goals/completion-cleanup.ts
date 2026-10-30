import { isGoalConflict } from './submission'
import type { GoalSnapshot } from './types'

interface CompletionCleanupPorts<T> {
  clear(sessionId: string, input: { expectedGoalId: string; expectedGoalRevision: number; origin: 'automatic' }): Promise<T>
  apply(sessionId: string, result: T): void
  refresh(sessionId: string): Promise<void>
}

/** Release a stale cleanup before reading the next authoritative generation. */
export class GoalCompletionCleanup<T> {
  private readonly pending = new Set<string>()
  constructor(private readonly ports: CompletionCleanupPorts<T>) {}
  async run(sessionId: string, goal: Pick<GoalSnapshot, 'goalId' | 'status'>, revision: number): Promise<void> {
    if (goal.status !== 'complete') return
    const key = `${sessionId}:${goal.goalId}`
    if (this.pending.has(key)) return
    this.pending.add(key)
    let conflict = false
    try {
      const result = await this.ports.clear(sessionId, { expectedGoalId: goal.goalId, expectedGoalRevision: revision, origin: 'automatic' })
      this.ports.apply(sessionId, result)
    } catch (error) { conflict = isGoalConflict(error) }
    finally { this.pending.delete(key) }
    if (conflict) await this.ports.refresh(sessionId)
  }
}
