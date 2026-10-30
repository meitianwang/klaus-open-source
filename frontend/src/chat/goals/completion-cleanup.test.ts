import { expect, test } from 'bun:test'
import { GoalCompletionCleanup } from './completion-cleanup'
import type { GoalSnapshot } from './types'

const complete = { goalId: 'generation-a', status: 'complete' as const }
const conflict = () => Object.assign(new Error('Goal changed'), { data: { error: { code: 'GOAL_CONFLICT' } } })
function barrier() { let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve }); return { pending, release } }

test('new complete accounting observed during cleanup retries only after releasing the prior reservation', async () => {
  const response = barrier()
  let authoritative: Pick<GoalSnapshot, 'goalId' | 'status'> | null = complete
  let revision = 1, refreshes = 0
  const attempts: number[] = []
  const cleanup = new GoalCompletionCleanup<null>({
    clear: async (sessionId, input) => {
      expect(sessionId).toBe('thread-a')
      attempts.push(input.expectedGoalRevision)
      expect(input.expectedGoalId).toBe('generation-a')
      expect(input.origin).toBe('automatic')
      if (attempts.length === 1) await response.pending
      if (input.expectedGoalRevision !== revision) throw conflict()
      authoritative = null
      return null
    },
    apply: () => {},
    refresh: async sessionId => { refreshes++; if (authoritative) await cleanup.run(sessionId, authoritative, revision) },
  })
  const first = cleanup.run('thread-a', complete, 1)
  revision = 2
  await cleanup.run('thread-a', complete, 2)
  expect(attempts).toEqual([1])
  response.release()
  await first
  expect(attempts).toEqual([1, 2])
  expect(refreshes).toBe(1)
  expect(authoritative).toBeNull()
})

test('a conditional cleanup conflict refreshes a replacement without clearing its active goal', async () => {
  let refreshes = 0, attempts = 0
  const active = { goalId: 'generation-b', status: 'active' as const }
  const cleanup = new GoalCompletionCleanup<never>({
    clear: async () => { attempts++; throw conflict() },
    apply: () => { throw new Error('Rejected cleanup must not install a null snapshot') },
    refresh: async sessionId => { refreshes++; await cleanup.run(sessionId, active, 3) },
  })
  await cleanup.run('thread-a', complete, 1)
  expect(attempts).toBe(1)
  expect(refreshes).toBe(1)
})

test('a generation-mismatch reply installs its authoritative replacement instead of fabricating absence', async () => {
  const replacement = { goalId: 'generation-b', status: 'active' as const }
  let installed: typeof replacement | null = null
  const cleanup = new GoalCompletionCleanup<{ goal: typeof replacement; cleared: boolean }>({
    clear: async () => ({ goal: replacement, cleared: false }),
    apply: (sessionId, result) => { expect(sessionId).toBe('thread-a'); installed = result.goal },
    refresh: async () => { throw new Error('A successful authoritative reply requires no recovery read') },
  })
  await cleanup.run('thread-a', complete, 1)
  expect(installed).toEqual(replacement)
})

test('an ambiguous cleanup failure does not automatically replay and releases the reservation for later events', async () => {
  let attempts = 0, applied = 0
  const cleanup = new GoalCompletionCleanup<null>({
    clear: async () => { attempts++; if (attempts === 1) throw new Error('Transport closed'); return null },
    apply: () => { applied++ },
    refresh: async () => { throw new Error('An ambiguous failure must not schedule a recovery read') },
  })
  await cleanup.run('thread-a', complete, 1)
  expect(attempts).toBe(1)
  expect(applied).toBe(0)
  await cleanup.run('thread-a', complete, 2)
  expect(attempts).toBe(2)
  expect(applied).toBe(1)
})
