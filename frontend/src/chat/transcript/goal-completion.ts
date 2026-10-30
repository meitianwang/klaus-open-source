export interface GoalCompletionSummary {
  goalId?: string
  durationSeconds: number | null
}

export interface GoalCompletionSource {
  turnId?: string
  completion: GoalCompletionSummary
  snapshot?: boolean
}

/** Resolve outcomes by their source turn, including snapshots echoed without one. */
export function goalCompletionsByTurn(sources: readonly GoalCompletionSource[]): Map<string, GoalCompletionSummary> {
  const owners = new Map<string, string>()
  const result = new Map<string, GoalCompletionSummary>()
  for (const source of sources) {
    if (source.turnId && source.completion.goalId) owners.set(source.completion.goalId, source.turnId)
    if (source.turnId && !source.snapshot) result.set(source.turnId, source.completion)
  }
  for (const source of sources) {
    if (!source.snapshot) continue
    const turnId = source.turnId ?? (source.completion.goalId ? owners.get(source.completion.goalId) : undefined)
    if (turnId) result.set(turnId, source.completion)
  }
  return result
}

export function formatWorkflowDuration(durationSeconds: number, locale: string): string {
  let remaining = Math.round(durationSeconds)
  const units = [['hour', 3600], ['minute', 60], ['second', 1]] as const
  const parts: string[] = []
  for (const [unit, size] of units) {
    const value = Math.floor(remaining / size)
    remaining %= size
    if (value > 0 || (unit === 'second' && parts.length === 0)) {
      parts.push(new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(value))
    }
  }
  return parts.join(' ')
}
