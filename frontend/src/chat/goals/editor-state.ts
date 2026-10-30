import { sameGoalIntent, type GoalSnapshot } from './types'

export interface GoalEditorState {
  goal: GoalSnapshot | null
  text: string
  savedText: string
  dirty: boolean
  saving: boolean
  loading: boolean
  needsRead: boolean
  sourceChanged: boolean
  error: 'load' | 'save' | null
}

export type ReadGoalObjective = (goal: GoalSnapshot) => Promise<string>
export type SaveGoalObjective = (objective: string, goal: GoalSnapshot) => Promise<GoalSnapshot>

/** Own one controller per conversation so drafts survive panel remounts. */
export class GoalEditorController {
  private state: GoalEditorState = {
    goal: null, text: '', savedText: '', dirty: false, saving: false, loading: false,
    needsRead: false, sourceChanged: false, error: null,
  }
  private listeners = new Set<() => void>()
  private epoch = 0
  private pendingObjective: string | null = null

  constructor(goal?: GoalSnapshot) { if (goal) this.update(goal) }
  readonly getSnapshot = (): GoalEditorState => this.state
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(next: GoalEditorState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  update(goal: GoalSnapshot | null): void {
    const previous = this.state
    const sameGoal = !!goal && previous.goal?.goalId === goal.goalId && previous.goal.threadId === goal.threadId
    const sameSource = sameGoalIntent(previous.goal, goal) && !!goal &&
      (previous.goal?.intentVersion === undefined || previous.goal.intentVersion === goal.intentVersion) &&
      !!previous.goal?.objectiveMaterialized === !!goal.objectiveMaterialized
    if (sameSource) {
      this.publish({ ...previous, goal })
      return
    }
    // An event acknowledging this save is allowed to precede its RPC reply.
    if (sameGoal && previous.saving && goal?.objective === this.pendingObjective) {
      this.publish({ ...previous, goal, savedText: previous.text.trim(), dirty: false, sourceChanged: false })
      return
    }
    this.epoch++
    this.pendingObjective = null
    const preserveDraft = sameGoal && previous.dirty
    const savedText = goal?.objective ?? ''
    this.publish({
      goal, savedText, text: preserveDraft ? previous.text : savedText, dirty: preserveDraft,
      saving: false, loading: false, needsRead: !!goal?.objectiveMaterialized,
      sourceChanged: preserveDraft, error: null,
    })
  }

  setText(text: string): void {
    if (!this.state.goal || this.state.saving || this.state.loading || this.state.needsRead) return
    this.publish({ ...this.state, text, dirty: text !== this.state.savedText, error: null })
  }

  revert(): void {
    if (this.state.saving || this.state.loading) return
    this.publish({ ...this.state, text: this.state.savedText, dirty: false, sourceChanged: false, error: null })
  }

  async readObjective(read: ReadGoalObjective): Promise<boolean> {
    const { goal, needsRead, loading } = this.state
    if (!goal || !needsRead || loading) return false
    const epoch = this.epoch
    this.publish({ ...this.state, loading: true, error: null })
    try {
      const text = await read(goal)
      if (this.epoch !== epoch) return false
      this.publish({
        ...this.state, savedText: text, text: this.state.dirty ? this.state.text : text,
        loading: false, needsRead: false, error: null,
      })
      return true
    } catch {
      if (this.epoch === epoch) this.publish({ ...this.state, loading: false, error: 'load' })
      return false
    }
  }

  expectSavedObjective(objective: string): void { if (this.state.saving) this.pendingObjective = objective }

  canSave(): boolean {
    const state = this.state
    return !!state.goal && state.dirty && !!state.text.trim() && state.text.trim() !== state.savedText.trim() && !state.saving &&
      !state.loading && !state.needsRead && !state.sourceChanged
  }

  async save(save: SaveGoalObjective): Promise<boolean> {
    if (!this.canSave()) return false
    const { goal, text } = this.state
    const epoch = this.epoch
    const objective = text.trim()
    this.pendingObjective = objective
    this.publish({ ...this.state, saving: true, error: null })
    try {
      const saved = await save(objective, goal!)
      if (this.epoch !== epoch) return false
      if (saved.goalId !== goal!.goalId || saved.threadId !== goal!.threadId || saved.objective !== objective && saved.objective !== this.pendingObjective) throw new Error('Goal save returned a different objective')
      this.pendingObjective = null
      this.publish({
        goal: saved, text: objective, savedText: objective, dirty: false, saving: false,
        loading: false, needsRead: false, sourceChanged: false, error: null,
      })
      return true
    } catch {
      if (this.epoch === epoch) {
        this.pendingObjective = null
        this.publish({ ...this.state, saving: false, error: 'save' })
      }
      return false
    }
  }
}
