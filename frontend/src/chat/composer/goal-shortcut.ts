export interface GoalShortcutCommand {
  name: string
  description?: string
  source?: unknown
  kind?: string
  type?: string
  [key: string]: unknown
}

const source = 'client-goal-shortcut'

/** The local entry remains available when engine command discovery is offline. */
export function withGoalShortcut(commands: GoalShortcutCommand[], description: string): GoalShortcutCommand[] {
  return [{ name: 'goal', description, source, kind: 'command', type: 'action' }, ...commands.filter(command => command.name.toLowerCase() !== 'goal')]
}

export function isGoalShortcut(command: GoalShortcutCommand): boolean {
  return command.name === 'goal' && command.source === source
}

interface GoalShortcutHost {
  sessionId(): string | null
  enabled(): boolean
  interactionToken?(): string
  enable(): Promise<boolean>
  readDraft(): string
  replaceDraft(value: string, caret: number): void
}

/** Opening a mode never submits a model turn or consumes a changed draft. */
export async function activateGoalShortcut(host: GoalShortcutHost, range: { start: number; end: number } | null): Promise<boolean> {
  const sessionId = host.sessionId()
  const draft = host.readDraft()
  const interactionToken = host.interactionToken?.()
  if (!(await host.enable())) return false
  if (sessionId !== host.sessionId() || interactionToken !== host.interactionToken?.() || !host.enabled()) return false
  if (range && host.readDraft() === draft) {
    const before = draft.slice(0, range.start)
    const after = draft.slice(range.end).replace(/^[ \t]+/, '')
    host.replaceDraft(before + after, before.length)
  }
  return true
}
