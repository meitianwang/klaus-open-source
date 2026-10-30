import { expect, test } from 'bun:test'
import { GoalSnapshots } from './snapshots'
import type { GoalSnapshot } from './types'
const goal: GoalSnapshot = { goalId: 'generation-a', threadId: 'thread-a', status: 'active', objective: 'Finish the work', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAtMs: 1, updatedAtMs: 1 }
test('a delayed goal read cannot overwrite an update or a null-clear snapshot', () => {
  const snapshots = new GoalSnapshots()
  const read = snapshots.readToken('a')
  snapshots.receive('a', goal, 1)
  expect(snapshots.receive('a', null, 0, read)).toBe(false)
  const secondRead = snapshots.readToken('a')
  expect(snapshots.receive('a', null, 2)).toBe(true)
  expect(snapshots.receive('a', goal, 1, secondRead)).toBe(false)
  expect(snapshots.get('a')).toBeNull()
})
test('mutations in separate conversations do not share ordering', () => {
  const snapshots = new GoalSnapshots()
  const readA = snapshots.readToken('a')
  snapshots.receive('b', null, 8)
  expect(snapshots.receive('a', goal, 1, readA)).toBe(true)
  expect(snapshots.get('a')?.goalId).toBe('generation-a')
  expect(snapshots.get('b')).toBeNull()
})

test('an older pushed event without a read token cannot replace or clear a newer goal snapshot', () => {
  const snapshots = new GoalSnapshots()
  const current = { ...goal, objective: 'The current objective', tokensUsed: 300 }
  expect(snapshots.receive('a', current, 4)).toBe(true)
  expect(snapshots.receive('a', { ...goal, objective: 'An obsolete objective' }, 3)).toBe(false)
  expect(snapshots.receive('a', null, 2)).toBe(false)
  expect(snapshots.get('a')).toMatchObject(current)
  expect(snapshots.revision('a')).toBe(4)
})

for (const newerFinishesFirst of [false, true]) test(`only the newest requested read can install a snapshot, newer finishes first: ${newerFinishesFirst}`, () => {
  const snapshots = new GoalSnapshots()
  const oldRead = snapshots.readToken('a'), newRead = snapshots.readToken('a')
  const old = () => expect(snapshots.receive('a', goal, 99, oldRead)).toBe(false)
  const latest = () => expect(snapshots.receive('a', { ...goal, objective: 'Current read' }, 2, newRead)).toBe(true)
  if (newerFinishesFirst) { latest(); old() } else { old(); latest() }
  expect(snapshots.get('a')?.objective).toBe('Current read')
})

test('forgetting a conversation invalidates its reads even after the same identity is reused', () => {
  const snapshots = new GoalSnapshots()
  snapshots.receive('a', goal, 4)
  const oldRead = snapshots.readToken('a')
  snapshots.forget('a')
  expect(snapshots.get('a')).toBeNull()
  const currentRead = snapshots.readToken('a')
  expect(snapshots.receive('a', goal, 99, oldRead)).toBe(false)
  expect(snapshots.receive('a', null, 0, currentRead)).toBe(true)
})

for (const cached of [goal, null]) test(`replaying an unchanged ${cached ? 'present' : 'absent'} goal preserves a pending explicit read`, () => {
  const snapshots = new GoalSnapshots()
  snapshots.receive('a', cached, 3)
  const previous = snapshots.get('a'), read = snapshots.readToken('a')
  snapshots.receive('a', cached ? { ...cached } : null, 3)
  expect(snapshots.isCurrentRead('a', read)).toBe(true)
  expect(snapshots.get('a')).toBe(previous)
  expect(snapshots.receive('a', goal, 4, read)).toBe(true)
})
