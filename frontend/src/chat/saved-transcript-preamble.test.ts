import { describe, expect, test } from 'bun:test'
import vector from '../../../contracts/vectors/inherited-transcript-vectors.json'
import { commitOlderTurns, commitSavedSnapshot, commitTurnItems, savedBoundary, savedRows, savedTurn, savedTurns } from './saved-transcript'
import type { TranscriptPageReply } from './transcript-pagination'

const messages = vector.messages
const summary = [messages[0], messages.at(-1)!]
const snapshot = (rows: unknown[] = summary): TranscriptPageReply => ({
  turns: [vector.shell], messages: rows, page: { hasMore: false },
})
const ids = (history: ReturnType<typeof commitSavedSnapshot>) => savedRows(history).map(row => row.uuid)

function hydrate(history: ReturnType<typeof commitSavedSnapshot>, rows: unknown[] = messages, cursor: string | null = null) {
  const turn = savedTurn(history, vector.shell.id)!
  return commitTurnItems(history, turn.id, turn.itemsPagination, turn.items, {
    rows, reply: {}, nextCursor: cursor,
  })!
}

describe('inherited transcript pagination ownership', () => {
  test('friend display records survive empty preamble hydration and reload', () => {
    const rows = vector.friendDisplay.messages
    let history = commitSavedSnapshot(null, snapshot(rows), 1)
    expect(ids(history)).toEqual(vector.friendDisplay.expectedIds)
    expect(savedTurn(history, vector.shell.id)!.items).toEqual([])
    history = hydrate(history, [])
    expect(ids(history)).toEqual(vector.friendDisplay.expectedIds)
    history = commitSavedSnapshot(history, snapshot(rows), 2)
    history = hydrate(history, [])
    expect(ids(history)).toEqual(vector.friendDisplay.expectedIds)
  })

  test('friend display records stay independent while inherited details load', () => {
    const rows = vector.friendDisplay.messages
    const initial = commitSavedSnapshot(null, snapshot([...summary, ...rows]), 1)
    expect(savedTurn(initial, vector.shell.id)!.items).toEqual(summary)
    const detailed = hydrate(initial)
    expect(ids(detailed)).toEqual([...vector.expected.fullIds, ...vector.friendDisplay.expectedIds])
    expect(new Set(ids(detailed)).size).toBe(ids(detailed).length)
    expect(savedRows(hydrate(commitSavedSnapshot(detailed, snapshot([...summary, ...rows]), 2))))
      .toEqual(savedRows(detailed))
  })

  test('model-owned friend inputs retain their explicit turn owner', () => {
    const row = { ...vector.friendDisplay.messages[0], turnId: 'friend-task' }
    const history = commitSavedSnapshot(null, {
      messages: [row], turns: [{ id: 'friend-task', itemsView: 'full' }], page: { hasMore: false },
    }, 1)
    expect(savedTurn(history, 'friend-task')!.items).toEqual([row])
    expect(savedTurns(history)).toHaveLength(1)
  })

  test('summary messages belong to the preamble without inventing model turn ids', () => {
    const history = commitSavedSnapshot(null, snapshot(), 1)
    expect(ids(history)).toEqual(vector.expected.summaryIds)
    expect(savedTurns(history)).toHaveLength(1)
    expect(savedTurn(history, vector.shell.id)!.items).toEqual(summary)
    expect(savedTurn(history, vector.shell.id)!.itemsPagination.summaryItemIds).toEqual(vector.expected.summaryIds)
    expect(savedRows(history).every(row => row.turnId === undefined)).toBe(vector.expected.preserveMissingTurnIds)
  })

  test('automatic detail hydration publishes every inherited message exactly once', () => {
    const initial = commitSavedSnapshot(null, snapshot(), 1)
    const detailed = hydrate(initial)
    expect(ids(detailed)).toEqual(vector.expected.fullIds)
    expect(savedTurns(detailed)).toHaveLength(1)
    expect(savedTurn(detailed, vector.shell.id)!.itemsPagination.hasLoadedOldest).toBe(true)
    expect(ids(initial)).toEqual(vector.expected.summaryIds)
    const revisited = commitSavedSnapshot(detailed, snapshot(), 2)
    expect(ids(revisited)).toEqual(vector.expected.fullIds)
    expect(savedTurn(revisited, vector.shell.id)!.itemsPagination.hasLoadedOldest).toBe(true)
  })

  test('partial detail pages preserve ordering across a summary refresh', () => {
    const initial = commitSavedSnapshot(null, snapshot(), 1)
    const prefix = savedTurn(initial, vector.shell.id)!
    const history = commitTurnItems(initial, prefix.id, prefix.itemsPagination, prefix.items, {
      rows: messages.slice(2), openingRows: messages.slice(0, 1), reply: {}, nextCursor: 'older-prefix',
    })!
    expect(ids(history)).toEqual(['inherited-user', 'inherited-followup', 'inherited-final'])
    const refreshed = commitSavedSnapshot(history, snapshot(), 2)
    expect(ids(refreshed)).toEqual(ids(history))
    const completed = hydrate(refreshed, messages.slice(0, 2))
    expect(ids(completed)).toEqual(vector.expected.fullIds)
    expect(savedRows(completed).every(row => row.turnId === undefined)).toBe(true)
  })

  test('a changed preamble revision reconnects to accepted details without auxiliary copies', () => {
    const initial = hydrate(commitSavedSnapshot(null, snapshot(), 1))
    const appended = { uuid: 'appended-answer', role: 'assistant', text: 'Additional inherited content' }
    const refreshed = commitSavedSnapshot(initial, {
      ...snapshot([messages[0], appended]), turns: [{ ...vector.shell, updatedAtOrdinal: 5 }],
    }, 2)
    expect(ids(refreshed)).toEqual([...vector.expected.fullIds, appended.uuid])
    expect(savedTurn(refreshed, vector.shell.id)!.itemsPagination.reconnect?.stopItemId).toBe('inherited-final')
    const reconnected = hydrate(refreshed, [...messages, appended])
    expect(ids(reconnected)).toEqual([...vector.expected.fullIds, appended.uuid])
    expect(savedTurns(reconnected)).toHaveLength(1)
    expect(savedTurn(reconnected, vector.shell.id)!.itemsPagination.hasLoadedOldest).toBe(true)
  })

  test('an older preamble page stays before later model turns and independent metadata', () => {
    const later = { uuid: 'new-user', turnId: 'new-turn', role: 'user', text: 'Continue here' }
    const completion = { uuid: 'goal-completed-goal-1', role: 'assistant', text: '', contentBlocks: [{ type: 'goal_completion', goal: { goalId: 'goal' } }] }
    let history = commitSavedSnapshot(null, {
      turns: [{ id: 'new-turn', ordinal: 10, itemsView: 'full' }], messages: [later], page: { hasMore: true, nextCursor: 'before-new' },
    }, 1)
    history = commitOlderTurns(history, savedBoundary(history)!, snapshot([...summary, completion]))!
    expect(ids(history)).toEqual([...vector.expected.summaryIds, completion.uuid, later.uuid])
    history = hydrate(history)
    expect(ids(history)).toEqual([...vector.expected.fullIds, completion.uuid, later.uuid])
    expect(savedTurn(history, vector.shell.id)!.items).not.toContain(completion)
    expect(savedTurn(history, 'new-turn')!.items).toEqual([later])
  })

  test('full preamble snapshots and ordinary unbound records keep their separate meaning', () => {
    const full = commitSavedSnapshot(null, { ...snapshot(messages), turns: [{ ...vector.shell, itemsView: 'full' }] }, 1)
    expect(ids(full)).toEqual(vector.expected.fullIds)
    expect(savedTurn(full, vector.shell.id)!.itemsPagination.hasLoadedOldest).toBe(true)
    const standalone = commitSavedSnapshot(null, { messages, turns: [], page: { hasMore: false } }, 1)
    expect(ids(standalone)).toEqual(vector.expected.fullIds)
    expect(savedTurns(standalone).every(turn => turn.auxiliary)).toBe(true)
  })
})
