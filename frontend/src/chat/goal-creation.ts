export interface CreatedGoal { status: string; objective?: string; goalId?: string }

/** Reserve the draft before asynchronous model/workspace checks or promotion. */
export function createGoalSubmissionGate() {
  type Lease = Set<string | null>
  const owners = new Map<string | null, Lease>()
  return {
    has: (sessionId: string | null) => owners.has(sessionId),
    begin(sessionId: string | null): (() => void) | null {
      if (owners.has(sessionId)) return null
      const lease: Lease = new Set([sessionId])
      owners.set(sessionId, lease)
      return () => {
        for (const key of lease) if (owners.get(key) === lease) owners.delete(key)
      }
    },
    promote(source: string | null, sessionId: string) {
      const lease = owners.get(source)
      if (!lease) return
      lease.add(sessionId)
      owners.set(sessionId, lease)
    },
  }
}

/** Admission remains accepted when a newer completion or clear precedes its reply. */
export async function createGoalFromDraft(options: {
  create(): Promise<{ ok?: boolean; goal?: CreatedGoal | null; admission?: 'scheduled' | 'steered' | 'deferred'; error?: unknown } | undefined>
  accept(goal: CreatedGoal | null): void
  consumeUnchangedDraft(): void
}): Promise<CreatedGoal | null> {
  const result = await options.create()
  const admitted = result?.admission && ['scheduled', 'steered', 'deferred'].includes(result.admission)
  if (result?.ok !== true || result.error || !admitted && (!result.goal?.status || result.goal.status === 'complete')) {
    throw new Error('Goal was not created')
  }
  options.accept(result.goal ?? null)
  options.consumeUnchangedDraft()
  return result.goal ?? null
}
