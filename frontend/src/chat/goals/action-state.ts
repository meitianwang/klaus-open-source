import type { GoalAction, GoalActionCallback, GoalSnapshot } from './types'

export interface GoalActionState { pending: GoalAction | null; failed: boolean }

/** All actions on the displayed generation share one in-flight reservation. */
export class GoalActionController {
  private state: GoalActionState = { pending: null, failed: false }
  private listeners = new Set<() => void>()
  readonly getSnapshot = (): GoalActionState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(state: GoalActionState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  async run(action: GoalAction, goal: GoalSnapshot, callback: GoalActionCallback): Promise<boolean> {
    if (this.state.pending) return false
    this.publish({ pending: action, failed: false })
    try {
      const result = await callback(goal)
      if (result?.ok === false || result?.error) throw new Error('Goal action failed')
      this.publish({ pending: null, failed: false })
      return true
    } catch {
      this.publish({ pending: null, failed: true })
      return false
    }
  }
}
