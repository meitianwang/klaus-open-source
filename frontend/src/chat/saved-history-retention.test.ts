import { describe, expect, test } from 'bun:test'
import { commitSavedSnapshot, savedRows, savedTurn, type SavedTranscript, type SavedTurn } from './saved-transcript'
import { canEvictSavedItem, retainSavedHistoryItems, SAVED_HISTORY_HIGH_WATER_ITEMS, SAVED_HISTORY_RETAINED_ITEMS } from './saved-history-retention'
import vectors from '../../../contracts/vectors/saved-history-retention-vectors.json'

const item = (turn: number, index: number) => ({ uuid: `t${turn}-m${index}`, turnId: `t${turn}`, role: 'assistant', text: `Message ${index}` })
function fixture(turns = 10, count = 120): SavedTranscript {
  return commitSavedSnapshot(null, {
    turns: Array.from({ length: turns }, (_, index) => ({ id: `t${index}`, ordinal: index, status: 'completed', itemsView: 'full' })),
    messages: Array.from({ length: turns }, (_, turn) => Array.from({ length: count }, (_, index) => item(turn, index))).flat(),
    page: { hasMore: false },
  }, 1)
}
const viewport = (id = 't9', firstProtectedItemId: string | null = null) => ({ oldestRenderedTurnId: id, firstProtectedItemId })

function replaceTurn(history: SavedTranscript, turn: SavedTurn): SavedTranscript {
  return { ...history, entitiesByKey: { ...history.entitiesByKey, [`turn:${turn.id}`]: turn } }
}

describe('saved item retention boundaries', () => {
  test('uses the committed item thresholds', () => {
    expect(SAVED_HISTORY_HIGH_WATER_ITEMS).toBe(vectors.highWaterItems)
    expect(SAVED_HISTORY_RETAINED_ITEMS).toBe(vectors.retainedItems)
  })
  for (const vector of vectors.windows) test(vector.name, () => {
    const history = fixture(vector.turns, vector.itemsPerTurn)
    const retained = retainSavedHistoryItems(history, [viewport(`t${vector.oldestVisibleTurn}`), viewport()])
    expect(savedRows(retained)).toHaveLength(vector.expectedItems)
    expect(Object.keys(retained.entitiesByKey)).toEqual(Object.keys(history.entitiesByKey))
    expect(retained.islands).toBe(history.islands)
  })
  test('an off-bottom or unknown reader prevents any release', () => {
    const history = fixture()
    for (const readers of [[], [null], [viewport(), null], [viewport('missing')]]) {
      expect(retainSavedHistoryItems(history, readers)).toBe(history)
    }
  })
  test('a partially released turn retains an independent item anchor', () => {
    const history = fixture()
    const retained = retainSavedHistoryItems(history, [viewport()])
    expect(savedTurn(retained, 't0')?.items).toEqual([])
    expect(savedTurn(retained, 't0')?.itemsPagination).toEqual({ olderCursor: null, olderItemId: undefined,
      evicted: true, isLoadingOlder: false, hasLoadedOldest: false })
    expect(savedTurn(retained, 't5')?.itemsPagination.olderItemId).toBe('t5-m100')
    expect(savedRows(history)).toHaveLength(1200)
  })
  test('a control row and its previous neighbor stop the safe prefix', () => {
    const history = fixture(), turn = savedTurn(history, 't0')!
    const changed = { ...turn, items: turn.items.map((row, index) => index === 7 ? { ...row, kind: 'approval-review' } : row) }
    const retained = retainSavedHistoryItems(replaceTurn(history, changed), [viewport()])
    expect(savedTurn(retained, 't0')?.items[0].uuid).toBe('t0-m6')
    expect(savedTurn(retained, 't0')?.items[1].kind).toBe('approval-review')
    expect(savedRows(retained)).toHaveLength(1194)
    expect(retainSavedHistoryItems(retained, [viewport()])).toBe(retained)
  })
  test('an explicit item boundary protects a visible suffix inside a running turn', () => {
    const history = fixture(1, 1200), turn = savedTurn(history, 't0')!
    const running = { ...turn, shell: { ...turn.shell, status: 'running' },
      items: turn.items.map((row, index) => ({ ...row, completed: index < 1100 })) }
    const retained = retainSavedHistoryItems(replaceTurn(history, running), [viewport('t0', 't0-m900')])
    expect(savedRows(retained)).toHaveLength(500)
    expect(savedTurn(retained, 't0')?.items[0].uuid).toBe('t0-m700')
    expect(savedTurn(retained, 't0')?.items.at(-1).uuid).toBe('t0-m1199')
  })
  test('unsealed rows and invalid item boundaries never disappear', () => {
    const history = fixture(1, 1200), turn = savedTurn(history, 't0')!
    const running = replaceTurn(history, { ...turn, shell: { ...turn.shell, status: 'running' } })
    expect(retainSavedHistoryItems(running, [viewport('t0', 't0-m900')])).toBe(running)
    expect(retainSavedHistoryItems(history, [viewport('t0', 'unknown-item')])).toBe(history)
  })
  test('loading summaries reconnects and disconnected islands defer release', () => {
    const history = fixture(), turn = savedTurn(history, 't0')!
    for (const pagination of [
      { ...turn.itemsPagination, isLoadingOlder: true },
      { ...turn.itemsPagination, summaryItemIds: [] },
      { ...turn.itemsPagination, reconnect: { stopItemId: 'm1', olderCursorAfterReconnect: null, beforeItemId: 'm2' } },
    ]) {
      const pending = replaceTurn(history, { ...turn, itemsPagination: pagination })
      expect(retainSavedHistoryItems(pending, [viewport()])).toBe(pending)
    }
    const split = { ...history, islands: [...history.islands, { ...history.islands[0], id: 'other', entries: [] }] }
    expect(retainSavedHistoryItems(split, [viewport()])).toBe(split)
  })
  test('compound rows preserve controls and incomplete tools atomically', () => {
    const turn = savedTurn(fixture(1, 1), 't0')!
    for (const block of [{ type: 'proposed_plan' }, { type: 'goal_completion' },
      { type: 'tool_use', name: 'ask_user_async', __result: {} },
      { type: 'tool_use', name: 'TaskUpdate', __result: {} }, { type: 'tool_use', name: 'read' }]) {
      expect(canEvictSavedItem(turn, { ...item(0, 0), contentBlocks: [{ type: 'text', text: 'Done' }, block] })).toBe(false)
    }
    expect(canEvictSavedItem(turn, { ...item(0, 0), contentBlocks: [{ type: 'tool_use', name: 'read', __result: {} }] })).toBe(true)
  })
})
