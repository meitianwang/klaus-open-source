import { describe, expect, test } from 'bun:test'
import {
  commitOlderTurns,
  commitSavedSnapshot,
  commitTurnItems,
  ownsSavedBoundary,
  patchSavedTurn,
  savedBoundary,
  savedPagination,
  savedRows,
  savedTurn,
  savedTurns,
  type SavedTranscript,
  type TurnBoundaryRequest,
  type TurnItemsPage,
  type TurnItemsPagination,
} from './saved-transcript'
import {
  fetchTurnItemsPage,
  loadFirstPaint,
  loadOlderTurnsPage,
  type PaginationApi,
  type TranscriptPageReply,
  type TranscriptTurnShell,
} from './transcript-pagination'

interface Row { uuid: string; turnId: string; role: string; text: string }
const row = (id: string, text = id, turnId = 't1'): Row => ({ uuid: id, turnId, role: id === 'prompt' ? 'user' : 'assistant', text })
const shell = (id = 't1', revision = 1, itemsView: TranscriptTurnShell['itemsView'] = 'summary'): TranscriptTurnShell => ({
  id, ordinal: Number(id.slice(1)), itemsView, updatedAtOrdinal: revision, status: 'completed',
})
const reply = (turns: TranscriptTurnShell[], messages: Row[], cursor: string | null = null): TranscriptPageReply => ({
  turns, messages, page: { hasMore: cursor !== null, nextCursor: cursor },
})
const itemsPage = (messages: Row[], cursor: string | null = null, openingRows?: Row[]): TurnItemsPage => ({
  rows: messages, reply: reply([], messages, cursor), nextCursor: cursor, ...(openingRows ? { openingRows } : {}),
})
const ids = (history: SavedTranscript) => savedRows(history).map(value => value.uuid)
const turnIds = (history: SavedTranscript) => savedTurns(history).map(turn => turn.id)
function pager(history: SavedTranscript, id = 't1'): TurnItemsPagination {
  const turn = savedTurn(history, id)
  if (!turn) throw new Error(`Expected saved turn ${id}`)
  return turn.itemsPagination
}
function boundary(history: SavedTranscript): TurnBoundaryRequest {
  const value = savedBoundary(history)
  if (!value) throw new Error('Expected an older turn boundary')
  return value
}
function commit(history: SavedTranscript, page: TurnItemsPage, turnId = 't1'): SavedTranscript {
  const turn = savedTurn(history, turnId)
  if (!turn) throw new Error(`Expected saved turn ${turnId}`)
  const result = commitTurnItems(history, turnId, turn.itemsPagination, turn.items, page)
  if (!result) throw new Error(`Rejected item page for ${turnId}`)
  return result
}
function apiWith(reads: {
  page?: PaginationApi['session']['historyPage']
  items?: PaginationApi['session']['historyItems']
}): PaginationApi {
  return { session: {
    historyPage: reads.page ?? (async () => { throw new Error('Unexpected summary read') }),
    historyItems: reads.items ?? (async () => { throw new Error('Unexpected detail read') }),
  } }
}
async function expectRejection(promise: Promise<unknown>, message: string): Promise<void> {
  const result = await promise.then(() => null, error => error)
  expect(result).toBeInstanceOf(Error)
  expect((result as Error | null)?.message).toContain(message)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// Item pages are chronological; cursors walk from the newest page toward older pages.
describe('summary publication and detailed items', () => {
  test('publishes the summary before any detail read can resolve', async () => {
    const summary = deferred<TranscriptPageReply>()
    const blockedDetail = deferred<TranscriptPageReply>()
    let detailReads = 0
    const api = apiWith({
      page: () => summary.promise,
      items: () => { detailReads += 1; return blockedDetail.promise },
    })
    const loading = loadFirstPaint(api, 'session')
    const prompt = row('prompt', 'Please inspect the log')
    const answer = row('answer', 'Summary answer')
    summary.resolve(reply([shell()], [prompt, answer], 'older-turns'))
    const first = await loading
    const history = commitSavedSnapshot(null, first.reply, 1)

    expect(savedRows(history)).toEqual([prompt, answer])
    expect(turnIds(history)).toEqual(['t1'])
    expect(savedPagination(history).olderCursor).toBe('older-turns')
    expect(detailReads).toBe(0)
  })

  test('an older summary also publishes without hydrating its turn bodies', async () => {
    const initial = commitSavedSnapshot(null, reply([shell('t2')], [row('t2-summary', 'Newest', 't2')], 'older'), 1)
    let detailReads = 0
    const olderSummary = reply([shell('t1')], [row('prompt'), row('answer')])
    const api = apiWith({ page: async () => olderSummary, items: async () => { detailReads += 1; throw new Error('Details unavailable') } })
    const older = await loadOlderTurnsPage(api, 'session', savedPagination(initial))
    expect(older).not.toBeNull()
    const accepted = commitOlderTurns(initial, boundary(initial), older!.reply)!
    expect(turnIds(accepted)).toEqual(['t1', 't2'])
    expect(ids(accepted)).toEqual(['prompt', 'answer', 't2-summary'])
    expect(detailReads).toBe(0)
  })

  test('replaces summary-only rows with detail while preserving concurrent edits and newly appended rows', () => {
    const initial = commitSavedSnapshot(null, reply([shell()], [row('prompt', 'Truncated prompt'), row('summary-only'), row('answer', 'Truncated answer')]), 1)
    const captured = savedTurn(initial, 't1')!.items
    const expected = pager(initial)
    const editedAnswer = row('answer', 'Answer updated while loading')
    const appended = row('live-added', 'Concurrent message')
    const current = patchSavedTurn(initial, 't1', turn => ({
      ...turn, items: [turn.items[0], turn.items[1], editedAnswer, appended],
    }))
    const details = [row('prompt', 'Complete prompt'), row('tool-result', 'Full tool output'), row('answer', 'Older response from disk')]
    const result = commitTurnItems(current, 't1', expected, captured, itemsPage(details))!

    expect(ids(result)).toEqual(['prompt', 'tool-result', 'answer', 'live-added'])
    expect(savedRows(result).map(value => value.text)).toEqual([
      'Complete prompt', 'Full tool output', 'Answer updated while loading', 'Concurrent message',
    ])
    expect(savedRows(result)[2]).toBe(editedAnswer)
    expect(savedRows(result)[3]).toBe(appended)
    expect(pager(result).hasLoadedOldest).toBe(true)
    expect(ids(initial)).toEqual(['prompt', 'summary-only', 'answer'])
  })

  test('opening rows keep the prompt visible while the detailed middle remains paginated', () => {
    const initial = commitSavedSnapshot(null, reply([shell()], [row('prompt', 'Summary prompt'), row('answer', 'Summary answer')]), 1)
    const result = commit(initial, itemsPage([row('m98'), row('answer', 'Complete answer')], 'before-m98', [row('prompt', 'Complete prompt'), row('m1')]))
    expect(ids(result)).toEqual(['prompt', 'm1', 'm98', 'answer'])
    expect(savedRows(result).map(value => value.text)).toEqual(['Complete prompt', 'm1', 'm98', 'Complete answer'])
    expect(pager(result).olderCursor).toBe('before-m98')
    expect(pager(result).hasLoadedOldest).toBe(false)
  })

  test('an accepted detail page invalidates a duplicate response captured for the same request', () => {
    const initial = commitSavedSnapshot(null, reply([shell()], [row('answer')]), 1)
    const expected = pager(initial)
    const captured = savedTurn(initial, 't1')!.items
    const current = commit(initial, itemsPage([row('prompt'), row('answer')], 'older-items'))
    expect(commitTurnItems(current, 't1', expected, captured, itemsPage([row('stale')]))).toBeNull()
    expect(ids(current)).toEqual(['prompt', 'answer'])
    expect(pager(current).olderCursor).toBe('older-items')
  })

  test('a refreshed summary invalidates a previously captured detail page', () => {
    const initial = commitSavedSnapshot(null, reply([shell()], [row('answer', 'Revision one')]), 1)
    const expected = pager(initial)
    const captured = savedTurn(initial, 't1')!.items
    const refreshed = commitSavedSnapshot(initial, reply([shell('t1', 2)], [row('answer', 'Revision two')]), 2)
    expect(commitTurnItems(refreshed, 't1', expected, captured, itemsPage([row('answer', 'Stale details')]))).toBeNull()
    expect(savedRows(refreshed).at(-1)?.text).toBe('Revision two')
  })

  test('hydrating one turn preserves neighboring rows and their independent pagination', () => {
    const initial = commitSavedSnapshot(null, reply([shell('t1'), shell('t2')], [row('prompt'), row('answer'), row('neighbor', 'Neighbor summary', 't2')], 'older-turns'), 1)
    const neighbor = savedTurn(initial, 't2')!
    const result = commit(initial, itemsPage([row('prompt'), row('middle'), row('answer')], 'older-t1-items'))
    expect(ids(result)).toEqual(['prompt', 'middle', 'answer', 'neighbor'])
    expect(savedTurn(result, 't2')).toBe(neighbor)
    expect(pager(result, 't2')).toBe(neighbor.itemsPagination)
    expect(savedPagination(result).olderCursor).toBe('older-turns')
    expect(pager(result).olderCursor).toBe('older-t1-items')
  })

  test('an unchanged summary revision retains hydrated middle rows and the existing older item cursor', () => {
    const initial = commitSavedSnapshot(null, reply([shell()], [row('prompt'), row('answer')]), 1)
    const hydrated = commit(initial, itemsPage([row('prompt'), row('middle'), row('answer')], 'older-items'))
    const refreshed = commitSavedSnapshot(hydrated, reply([shell()], [row('prompt'), row('answer')]), 2)
    expect(ids(refreshed)).toEqual(['prompt', 'middle', 'answer'])
    expect(pager(refreshed).olderCursor).toBe('older-items')
    expect(pager(refreshed).hasLoadedOldest).toBe(false)
  })
})

describe('older turn windows', () => {
  test('deduplicates overlapping turns and rows, advances once, and rejects a repeated response', () => {
    const initial = commitSavedSnapshot(null, reply([shell('t2'), shell('t3')], [row('m2', 'Current t2', 't2'), row('m3', 'Current t3', 't3')], 'cursor-1'), 1)
    const pending = boundary(initial)
    const older = reply([shell('t1'), shell('t2')], [row('m1'), row('m2', 'Updated t2', 't2')], 'cursor-2')
    const next = commitOlderTurns(initial, pending, older)!
    expect(turnIds(next)).toEqual(['t1', 't2', 't3'])
    expect(ids(next)).toEqual(['m1', 'm2', 'm3'])
    expect(savedRows(next)[1].text).toBe('Updated t2')
    expect(savedPagination(next).olderCursor).toBe('cursor-2')
    expect(savedPagination(next).oldestLoadedTurnId).toBe('t1')
    expect(ownsSavedBoundary(next, pending)).toBe(false)
    expect(commitOlderTurns(next, pending, older)).toBeNull()
    expect(ids(initial)).toEqual(['m2', 'm3'])
  })

  test('failed older reads retain the cursor and retry the same page successfully', async () => {
    let history = commitSavedSnapshot(null, reply([shell('t2')], [row('m2', 'Current', 't2')], 'cursor-1'), 1)
    const cursors: unknown[] = []
    let fail = true
    const api = apiWith({ page: async (_id, options) => {
      cursors.push(options?.cursor)
      if (fail) { fail = false; throw new Error('offline') }
      return reply([shell('t1')], [row('m1')])
    } })
    await expectRejection(loadOlderTurnsPage(api, 'session', savedPagination(history)), 'offline')
    expect(savedPagination(history).olderCursor).toBe('cursor-1')
    expect(ids(history)).toEqual(['m2'])
    const retry = await loadOlderTurnsPage(api, 'session', savedPagination(history))
    history = commitOlderTurns(history, boundary(history), retry!.reply)!
    expect(cursors).toEqual(['cursor-1', 'cursor-1'])
    expect(ids(history)).toEqual(['m1', 'm2'])
    expect(savedPagination(history).hasLoadedOldest).toBe(true)
  })

  test('refuses unchanged older cursors without consuming rows or the retry boundary', () => {
    const initial = commitSavedSnapshot(null, reply([shell('t2')], [row('m2', 'Current', 't2')], 'cursor-1'), 1)
    const pending = boundary(initial)
    expect(() => commitOlderTurns(initial, pending, reply([shell('t1')], [row('m1')], 'cursor-1'))).toThrow('unchanged cursor')
    expect(ids(initial)).toEqual(['m2'])
    expect(ownsSavedBoundary(initial, pending)).toBe(true)
    expect(savedPagination(initial).olderCursor).toBe('cursor-1')
  })

  test('does not accept an older response into a newer summary generation', () => {
    const initial = commitSavedSnapshot(null, reply([shell('t2')], [row('m2', 'Current', 't2')], 'cursor-1'), 1)
    const pending = boundary(initial)
    const refreshed = commitSavedSnapshot(initial, reply([shell('t2'), shell('t3')], [row('m2', 'Updated', 't2'), row('m3', 'Newest', 't3')], 'cursor-1'), 2)
    expect(commitOlderTurns(refreshed, pending, reply([shell('t1')], [row('m1')]))).toBeNull()
    expect(turnIds(refreshed)).toEqual(['t2', 't3'])
    expect(savedPagination(refreshed).olderCursor).toBe('cursor-1')
  })

  test('retains disconnected windows and joins them when a middle turn page reaches the earlier island', () => {
    const early = commitSavedSnapshot(null, reply([shell('t1'), shell('t2')], [row('m1'), row('m2', 'Two', 't2')]), 1)
    const latest = commitSavedSnapshot(early, reply([shell('t5'), shell('t6')], [row('m5', 'Five', 't5'), row('m6', 'Six', 't6')], 'before-t5'), 2)
    expect(turnIds(latest)).toEqual(['t1', 't2', 't5', 't6'])
    expect(ids(latest)).toEqual(['m1', 'm2', 'm5', 'm6'])
    expect(latest.islands).toHaveLength(2)
    expect(latest.isComplete).toBe(false)
    const pending = boundary(latest)
    expect(pending.handle.cursor).toBe('before-t5')
    const joined = commitOlderTurns(latest, pending, reply([shell('t2'), shell('t3'), shell('t4')], [
      row('m2', 'Two refreshed', 't2'), row('m3', 'Three', 't3'), row('m4', 'Four', 't4'),
    ], 'before-t2'))!
    expect(joined.islands).toHaveLength(1)
    expect(turnIds(joined)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
    expect(ids(joined)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    expect(joined.isComplete).toBe(true)
    expect(savedPagination(joined).hasLoadedOldest).toBe(true)
  })

  test('retains the already loaded prefix when a newer summary window overlaps it', () => {
    const initial = commitSavedSnapshot(null, reply([shell('t3')], [row('m3', 't3', 't3')], 'before-t3'), 1)
    const expanded = commitOlderTurns(initial, boundary(initial), reply([shell('t1'), shell('t2')], [row('m1'), row('m2', 't2', 't2')], 'before-t1'))!
    const refreshed = commitSavedSnapshot(expanded, reply([shell('t2'), shell('t3'), shell('t4')], [row('m2', 't2 refreshed', 't2'), row('m3', 't3', 't3'), row('m4', 't4', 't4')], 'before-t2'), 2)
    expect(turnIds(refreshed)).toEqual(['t1', 't2', 't3', 't4'])
    expect(ids(refreshed)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(savedPagination(refreshed).olderCursor).toBe('before-t1')
    expect(savedPagination(refreshed).oldestLoadedTurnId).toBe('t1')
  })
})

describe('item page reads and retry', () => {
  test('fetches only one body page plus the opening prompt and commits before requesting another body page', async () => {
    let history = commitSavedSnapshot(null, reply([shell()], [row('prompt'), row('answer')]), 1)
    const calls: { cursor?: string | null; direction?: string; limit?: number }[] = []
    const api = apiWith({ items: async (_id, options) => {
      calls.push({ cursor: options.cursor, direction: options.sortDirection, limit: options.limit })
      return options.sortDirection === 'asc' ? reply([], [row('prompt'), row('m1')], 'opening-next')
        : reply([], [row('m98'), row('answer')], 'older-items')
    } })
    const page = await fetchTurnItemsPage(api, 'session', 't1', pager(history))
    expect(calls).toEqual([
      { cursor: undefined, direction: 'desc', limit: 98 },
      { cursor: undefined, direction: 'asc', limit: 2 },
    ])
    history = commit(history, page)
    expect(ids(history)).toEqual(['prompt', 'm1', 'm98', 'answer'])
    expect(pager(history).olderCursor).toBe('older-items')
  })

  test('an opening-preview failure retains the original summary and retries the complete preview unit', async () => {
    let history = commitSavedSnapshot(null, reply([shell()], [row('prompt', 'Summary prompt'), row('answer', 'Summary answer')]), 1)
    const directions: string[] = []
    let failOpening = true
    const api = apiWith({ items: async (_id, options) => {
      directions.push(options.sortDirection ?? '')
      if (options.sortDirection === 'asc') {
        if (failOpening) { failOpening = false; throw new Error('opening preview failed') }
        return reply([], [row('prompt', 'Full prompt'), row('m1')])
      }
      return reply([], [row('m98'), row('answer', 'Full answer')], 'older-items')
    } })
    await expectRejection(fetchTurnItemsPage(api, 'session', 't1', pager(history)), 'opening preview failed')
    expect(savedRows(history).map(value => value.text)).toEqual(['Summary prompt', 'Summary answer'])
    expect(pager(history).olderCursor).toBeNull()
    expect(pager(history).hasLoadedOldest).toBe(false)
    history = commit(history, await fetchTurnItemsPage(api, 'session', 't1', pager(history)))
    expect(directions).toEqual(['desc', 'asc', 'desc', 'asc'])
    expect(ids(history)).toEqual(['prompt', 'm1', 'm98', 'answer'])
    expect(pager(history).olderCursor).toBe('older-items')
  })

  test('deduplicates overlapping item pages and keeps incoming content once', () => {
    let history = commitSavedSnapshot(null, reply([shell()], [row('m3'), row('m4')]), 1)
    history = commit(history, itemsPage([row('m3', 'Initial m3'), row('m4')], 'older-items'))
    history = commit(history, itemsPage([row('m1'), row('m2'), row('m3', 'Complete m3')]))
    expect(ids(history)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(savedRows(history)[2].text).toBe('Complete m3')
    expect(pager(history).hasLoadedOldest).toBe(true)
  })

  test('a failed older item read retains accepted rows and retries the same cursor', async () => {
    let history = commitSavedSnapshot(null, reply([shell()], [row('m3')]), 1)
    history = commit(history, itemsPage([row('m3'), row('m4')], 'older-items'))
    const cursors: unknown[] = []
    let fail = true
    const api = apiWith({ items: async (_id, options) => {
      cursors.push(options.cursor)
      if (fail) { fail = false; throw new Error('item read failed') }
      return reply([], [row('m1'), row('m2')])
    } })
    await expectRejection(fetchTurnItemsPage(api, 'session', 't1', pager(history)), 'item read failed')
    expect(ids(history)).toEqual(['m3', 'm4'])
    expect(pager(history).olderCursor).toBe('older-items')
    history = commit(history, await fetchTurnItemsPage(api, 'session', 't1', pager(history)))
    expect(cursors).toEqual(['older-items', 'older-items'])
    expect(ids(history)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  test('an unchanged item cursor cannot discard accepted rows or advance pagination', async () => {
    let history = commitSavedSnapshot(null, reply([shell()], [row('m3')]), 1)
    history = commit(history, itemsPage([row('m3')], 'older-items'))
    const api = apiWith({ items: async () => reply([], [row('m2')], 'older-items') })
    await expectRejection(fetchTurnItemsPage(api, 'session', 't1', pager(history)), 'unchanged cursor')
    expect(ids(history)).toEqual(['m3'])
    expect(pager(history).olderCursor).toBe('older-items')
  })

  test('shrinks an oversized page at the same cursor and succeeds without dropping the accepted suffix', async () => {
    let history = commitSavedSnapshot(null, reply([shell()], [row('m3')]), 1)
    history = commit(history, itemsPage([row('m3')], 'older-items'))
    const calls: { cursor?: string | null; limit?: number }[] = []
    const api = apiWith({ items: async (_id, options) => {
      calls.push({ cursor: options.cursor, limit: options.limit })
      if (calls.length < 3) throw new Error('decoded message length too large')
      return reply([], [row('m1'), row('m2')])
    } })
    history = commit(history, await fetchTurnItemsPage(api, 'session', 't1', pager(history)))
    expect(calls).toEqual([
      { cursor: 'older-items', limit: 100 }, { cursor: 'older-items', limit: 50 }, { cursor: 'older-items', limit: 25 },
    ])
    expect(ids(history)).toEqual(['m1', 'm2', 'm3'])
  })
})

function reconnectHistory(): SavedTranscript {
  const initial = commitSavedSnapshot(null, reply([shell()], [row('prompt'), row('m2')]), 1)
  const hydrated = commit(initial, itemsPage([row('prompt', 'Full prompt'), row('m1'), row('m2')], 'old-prefix-cursor'))
  return commitSavedSnapshot(hydrated, reply([shell('t1', 2)], [row('prompt', 'Prompt summary'), row('m6')]), 2)
}

describe('reconnecting a changed turn to previously loaded details', () => {
  test('retains the hydrated prefix and appends the newest page while the stop item is still missing', () => {
    const refreshed = reconnectHistory()
    const result = commit(refreshed, itemsPage([row('m5'), row('m6')], 'before-m5', [row('prompt', 'Full prompt'), row('m1')]))
    expect(ids(result)).toEqual(['prompt', 'm1', 'm2', 'm5', 'm6'])
    expect(pager(result).olderCursor).toBe('before-m5')
    expect(pager(result).hasLoadedOldest).toBe(false)
  })

  test('keeps the accepted newest suffix when a second reconnect page reaches the stop item and resumes the old cursor', async () => {
    const refreshed = reconnectHistory()
    let history = commit(refreshed, itemsPage([row('m5'), row('m6')], 'before-m5', [row('prompt', 'Full prompt'), row('m1')]))
    history = commit(history, itemsPage([row('m2'), row('m3'), row('m4')], 'unused-overlap-cursor'))
    expect(ids(history)).toEqual(['prompt', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
    expect(pager(history).olderCursor).toBe('old-prefix-cursor')
    const calls: unknown[] = []
    const api = apiWith({ items: async (_id, options) => { calls.push(options.cursor); return reply([], [row('oldest')]) } })
    history = commit(history, await fetchTurnItemsPage(api, 'session', 't1', pager(history)))
    expect(calls).toEqual(['old-prefix-cursor'])
    expect(ids(history)).toEqual(['oldest', 'prompt', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'])
  })

  test('reaching the stop item restores an already exhausted old cursor despite more overlap on the wire', () => {
    const initial = commitSavedSnapshot(null, reply([shell()], [row('prompt'), row('m2')]), 1)
    const hydrated = commit(initial, itemsPage([row('prompt'), row('m1'), row('m2')]))
    const refreshed = commitSavedSnapshot(hydrated, reply([shell('t1', 2)], [row('prompt'), row('m4')]), 2)
    const result = commit(refreshed, itemsPage([row('prompt'), row('m1'), row('m2'), row('m3'), row('m4')], 'redundant-overlap'))
    expect(ids(result)).toEqual(['prompt', 'm1', 'm2', 'm3', 'm4'])
    expect(pager(result).olderCursor).toBeNull()
    expect(pager(result).hasLoadedOldest).toBe(true)
  })

  test('preserves a concurrently appended message beyond the reconnect page', () => {
    const refreshed = reconnectHistory()
    const captured = savedTurn(refreshed, 't1')!.items
    const expected = pager(refreshed)
    const live = row('m7', 'Arrived during reconnect')
    const current = patchSavedTurn(refreshed, 't1', turn => ({ ...turn, items: [...turn.items, live] }))
    const result = commitTurnItems(current, 't1', expected, captured, itemsPage([row('m2'), row('m3'), row('m4'), row('m5'), row('m6')], 'unused-overlap-cursor', [row('prompt', 'Full prompt'), row('m1')]))!
    expect(ids(result)).toEqual(['prompt', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'])
    expect(savedRows(result).at(-1)).toBe(live)
    expect(pager(result).olderCursor).toBe('old-prefix-cursor')
  })
})
