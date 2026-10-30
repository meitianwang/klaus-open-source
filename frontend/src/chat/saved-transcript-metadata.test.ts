import { expect, test } from 'bun:test'
import { commitOlderTurns, commitSavedSnapshot, commitTurnItems, savedBoundary, savedRows, savedShells, savedTurn } from './saved-transcript'

const user = { uuid: 'user', turnId: 'turn', role: 'user', text: 'Request' }
const final = { uuid: 'final', turnId: 'turn', role: 'assistant', text: 'Answer' }
const completion = { uuid: 'goal-completed-goal-3', role: 'assistant', text: '', contentBlocks: [{ type: 'goal_completion', goal: { goalId: 'goal' } }] }
const page = { turns: [{ id: 'turn', ordinal: 100, itemsView: 'summary' as const }], messages: [user, final, completion], page: { hasMore: true, nextCursor: 'older' } }

test('unbound completion metadata survives summary, detail hydration, and overlapping older windows once', () => {
  let history = commitSavedSnapshot(null, page, 1)
  expect(savedRows(history)).toEqual([user, final, completion])
  expect(Object.keys(savedShells(history))).toEqual(['turn'])
  const turn = savedTurn(history, 'turn')!
  history = commitTurnItems(history, 'turn', turn.itemsPagination, turn.items, {
    rows: [user, { uuid: 'body', turnId: 'turn', role: 'assistant', text: 'Work' }, final, completion],
    reply: {}, nextCursor: null,
  })!
  expect(savedRows(history).map(row => row.uuid)).toEqual(['user', 'body', 'final', 'goal-completed-goal-3'])
  expect(savedTurn(history, 'turn')!.itemsPagination.newestSnapshotItemId).toBe('final')
  const request = savedBoundary(history)!
  history = commitOlderTurns(history, request, {
    turns: [{ id: 'before', ordinal: 1, itemsView: 'full' }],
    messages: [{ uuid: 'earlier', turnId: 'before', role: 'user', text: 'Earlier' }, completion],
    page: { hasMore: false },
  })!
  expect(savedRows(history).map(row => row.uuid)).toEqual(['earlier', 'user', 'body', 'final', 'goal-completed-goal-3'])
})

test('turn-bound completion rows remain rendered without becoming reconnect stop items', () => {
  let history = commitSavedSnapshot(null, { ...page, messages: [user, final, { ...completion, turnId: 'turn' }] }, 1)
  const turn = savedTurn(history, 'turn')!
  history = commitTurnItems(history, 'turn', turn.itemsPagination, turn.items, {
    rows: [user, final, { ...completion, turnId: 'turn' }], reply: {}, nextCursor: null,
  })!
  expect(savedRows(history).map(row => row.uuid)).toEqual(['user', 'final', 'goal-completed-goal-3'])
  expect(savedTurn(history, 'turn')!.itemsPagination.newestSnapshotItemId).toBe('final')
})
