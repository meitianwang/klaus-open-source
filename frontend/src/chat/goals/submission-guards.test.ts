import { expect, test } from 'bun:test'
import { GoalInteractionClock, reviewGoalDraft, reviewGoalResume } from './draft-review'
import { GoalSnapshots } from './snapshots'
import type { GoalSnapshot } from './types'

const goal: GoalSnapshot = { goalId: 'saved-goal', threadId: 'chat', objective: 'Saved objective', status: 'active', tokenBudget: null, tokensUsed: 4, timeUsedSeconds: 1, createdAtMs: 1, updatedAtMs: 2 }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
async function until(check: () => boolean) { for (let count = 0; count < 30 && !check(); count++) await Promise.resolve(); expect(check()).toBe(true) }
function fixture(initial: GoalSnapshot | null = null) {
  const snapshots = new GoalSnapshots(), clock = new GoalInteractionClock()
  snapshots.receive('chat', initial, 0)
  const attachment = { path: '/owned/image.png', text: 'original attachment' }
  const binding = { sessionId: 'chat', draft: { text: 'New objective' }, attachments: [attachment], interactionToken: clock.token('chat') }
  const state = { current: binding, prepares: 0, confirms: 0, discards: 0, reads: 0 }
  const options = {
    binding, current: () => ({ ...state.current, interactionToken: clock.token(state.current.sessionId) }), objective: 'New objective',
    readGoal: async (): Promise<GoalSnapshot | null> => { state.reads++; return snapshots.get('chat') },
    currentGoal: () => snapshots.get('chat'), goalIntentVersion: () => snapshots.intentVersion('chat'),
    prepare: async () => { state.prepares++; return { objective: 'New objective', displayText: 'New objective', preparationId: 'owned-preparation' } },
    readObjective: async (source: GoalSnapshot) => source.objective,
    confirm: async () => { state.confirms++; return true }, discard: async () => { state.discards++ },
  }
  return { snapshots, clock, binding, state, options, attachment }
}

test('authoritative hydration must finish before replacement review or materialization', async () => {
  const f = fixture(), read = deferred<GoalSnapshot | null>()
  f.options.readGoal = () => read.promise
  const pending = reviewGoalDraft(f.options)
  expect(f.state).toMatchObject({ prepares: 0, confirms: 0 })
  f.snapshots.receive('chat', goal, 1)
  read.resolve(f.snapshots.get('chat'))
  expect((await pending)?.goal).toMatchObject({ goalId: goal.goalId, revision: 1 })
  expect(f.state).toMatchObject({ prepares: 1, confirms: 1, discards: 0 })
})

test('cancelling a hydrated replacement creates no files and retains the original attachment object', async () => {
  const f = fixture(goal)
  f.options.confirm = async () => { f.state.confirms++; return false }
  expect(await reviewGoalDraft(f.options)).toBeNull()
  expect(f.state).toMatchObject({ prepares: 0, confirms: 1, discards: 0 })
  expect(f.binding.attachments[0]).toBe(f.attachment)
  expect(f.binding.draft.text).toBe('New objective')
})

for (const change of ['objective', 'status', 'replacement', 'clear', 'objective-aba'] as const) test(`${change} during confirmation revokes the reviewed goal without preparing files`, async () => {
  const f = fixture(goal)
  f.options.confirm = async () => {
    if (change === 'clear') f.snapshots.receive('chat', null, 1)
    else f.snapshots.receive('chat', { ...goal, ...(change === 'status' ? { status: 'paused' } : change === 'replacement' ? { goalId: 'replacement' } : { objective: 'External objective' }) }, 1)
    if (change === 'objective-aba') f.snapshots.receive('chat', goal, 2)
    return true
  }
  expect(await reviewGoalDraft(f.options)).toBeNull()
  expect(f.state.prepares).toBe(0)
})

for (const change of ['navigate-away-and-back', 'stop', 'new-goal', 'absent-goal-aba'] as const) test(`${change} cancels an owned preparation and preserves its draft`, async () => {
  const f = fixture(), preparation = deferred<{ objective: string; displayText: string; preparationId: string }>()
  f.options.prepare = () => { f.state.prepares++; return preparation.promise }
  const pending = reviewGoalDraft(f.options)
  await until(() => f.state.prepares === 1)
  if (change === 'navigate-away-and-back') { f.clock.navigate(); f.clock.navigate() }
  else if (change === 'stop') f.clock.stop('chat')
  else { f.snapshots.receive('chat', goal, 1); if (change === 'absent-goal-aba') f.snapshots.receive('chat', null, 2) }
  preparation.resolve({ objective: 'New objective', displayText: 'New objective', preparationId: 'owned-preparation' })
  expect(await pending).toBeNull()
  expect(f.state.discards).toBe(1)
  expect(f.binding.attachments[0]).toBe(f.attachment)
  expect(f.binding.draft.text).toBe('New objective')
})

test('accounting-only pushes rebase the returned guard without invalidating reviewed intent', async () => {
  const f = fixture(goal)
  f.options.confirm = async () => { f.snapshots.receive('chat', { ...goal, tokensUsed: 99, updatedAtMs: 3 }, 1); return true }
  const reviewed = await reviewGoalDraft(f.options)
  expect(reviewed?.goal).toMatchObject({ revision: 1, tokensUsed: 99 })
  expect(f.snapshots.guard('chat', reviewed!.goal!)).toEqual({ expectedGoalId: goal.goalId, expectedGoalRevision: 1 })
})

test('resume reads the full validated objective and preserves its source binding', async () => {
  const f = fixture({ ...goal, status: 'paused', objective: 'Read the complete goal objective from this Klaus-owned file: /owned/objective.md', objectiveMaterialized: true })
  const full = 'Saved full objective\n'.repeat(400)
  const result = await reviewGoalResume({ goal: f.snapshots.get('chat')!, valid: () => true,
    readGoal: f.options.readGoal, currentGoal: f.options.currentGoal,
    readObjective: async source => { expect(source.objective).toContain('/owned/objective.md'); return full },
  })
  expect(result?.objective).toBe(full)
  expect(result?.goal.objective).toContain('/owned/objective.md')
})

for (const change of ['navigation', 'objective', 'status', 'counter'] as const) test(`resume objective read handles ${change} without stale activation`, async () => {
  const f = fixture({ ...goal, status: 'paused' }), read = deferred<string>()
  const token = f.clock.token('chat')
  const pending = reviewGoalResume({ goal: f.snapshots.get('chat')!, valid: () => token === f.clock.token('chat'),
    readGoal: f.options.readGoal, currentGoal: f.options.currentGoal, readObjective: () => read.promise })
  await Promise.resolve()
  if (change === 'navigation') { f.clock.navigate(); f.clock.navigate() }
  else f.snapshots.receive('chat', { ...goal, status: 'paused', ...(change === 'objective' ? { objective: 'External objective' } : change === 'status' ? { status: 'usage_limited' } : { tokensUsed: 100 }) }, 1)
  read.resolve('Complete saved objective')
  const result = await pending
  if (change === 'counter') expect(result?.goal).toMatchObject({ revision: 1, tokensUsed: 100 })
  else expect(result).toBeNull()
})

 test('an in-place attachment edit during review cannot consume or prepare a different attachment snapshot', async () => {
  const f = fixture(goal)
  const snapshot = () => JSON.stringify(f.binding.attachments)
  const captured = { ...f.binding, attachmentSnapshot: snapshot() }
  f.options.confirm = async () => { f.attachment.text = 'New attachment authored during review'; return true }
  const result = await reviewGoalDraft({ ...f.options, binding: captured,
    current: () => ({ ...f.state.current, interactionToken: f.clock.token('chat'), attachmentSnapshot: snapshot() }) })
  expect(result).toBeNull()
  expect(f.state.prepares).toBe(0)
  expect(f.attachment.text).toBe('New attachment authored during review')
})

test('message submits keep their target across navigation while goal submits invalidate', () => {
  const clock = new GoalInteractionClock()
  const chatToken = clock.token('chat')
  const welcomeToken = clock.token(null)
  clock.navigate()
  expect(clock.routeInvalidated(false, 'chat', chatToken)).toBe(false)
  expect(clock.routeInvalidated(false, null, welcomeToken)).toBe(false)
  expect(clock.routeInvalidated(true, 'chat', chatToken)).toBe(true)
  expect(clock.routeInvalidated(true, null, welcomeToken)).toBe(true)
  const stopped = new GoalInteractionClock()
  const before = stopped.token('chat')
  expect(stopped.routeInvalidated(true, 'chat', before)).toBe(false)
  stopped.stop('chat')
  expect(stopped.routeInvalidated(true, 'chat', before)).toBe(true)
  expect(stopped.routeInvalidated(false, 'chat', before)).toBe(false)
})

test('message submits keep their target across navigation while goal submits invalidate', () => {
  const clock = new GoalInteractionClock()
  const chatToken = clock.token('chat')
  const welcomeToken = clock.token(null)
  clock.navigate()
  expect(clock.routeInvalidated(false, 'chat', chatToken)).toBe(false)
  expect(clock.routeInvalidated(false, null, welcomeToken)).toBe(false)
  expect(clock.routeInvalidated(true, 'chat', chatToken)).toBe(true)
  expect(clock.routeInvalidated(true, null, welcomeToken)).toBe(true)
  const stopped = new GoalInteractionClock()
  const before = stopped.token('chat')
  expect(stopped.routeInvalidated(true, 'chat', before)).toBe(false)
  stopped.stop('chat')
  expect(stopped.routeInvalidated(true, 'chat', before)).toBe(true)
  expect(stopped.routeInvalidated(false, 'chat', before)).toBe(false)
})
