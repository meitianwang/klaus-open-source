import { describe, expect, test } from 'bun:test'
import { FIRST_PAGE_TURN_LIMIT, ITEM_PAGE_LIMIT, fetchTurnItems, fetchTurnItemsPage, loadFirstPaint, loadOlderTurnsPage, type TranscriptPaginationState } from './transcript-pagination'
import type { TurnItemsPagination } from './saved-transcript'

const row = (index: number) => ({ uuid: `m${index}`, turnId: 'turn', role: index === 0 ? 'user' : 'assistant', text: `Message ${index}` })
const summary = { turns: [{ id: 'turn', ordinal: 10, status: 'completed', itemsView: 'summary' }], messages: [row(0), row(202)], page: { hasMore: true, nextCursor: 'older-turns' } }
function fixture(count = 203, failures: string[] = []) {
  const calls: any[] = []
  const messages = Array.from({ length: count }, (_, index) => row(index))
  const api = { session: {
    historyPage: async (_id: string, opts: any) => { calls.push({ method: 'turns', ...opts }); return summary },
    historyItems: async (_id: string, opts: any) => {
      calls.push({ method: 'items', ...opts })
      const error = failures.shift()
      if (error) throw new Error(error)
      const ascending = opts.sortDirection === 'asc'
      const end = opts.cursor ? messages.findIndex(message => message.uuid === opts.cursor) : messages.length
      const start = ascending ? 0 : Math.max(0, end - opts.limit)
      const items = ascending ? messages.slice(0, opts.limit) : messages.slice(start, end)
      return { messages: items, page: { hasMore: ascending ? opts.limit < count : start > 0,
        nextCursor: ascending ? messages[opts.limit]?.uuid ?? null : start > 0 ? messages[start].uuid : null } }
    },
  } }
  return { api, calls, messages }
}
const initial: TurnItemsPagination = { olderCursor: null, isLoadingOlder: false, hasLoadedOldest: false, summaryItemIds: ['m0', 'm202'] }

describe('summary windows', () => {
  test('publishes five turn summaries without waiting for item reads', async () => {
    const { api, calls } = fixture(203, ['unavailable'])
    const first = await loadFirstPaint(api, 'session')
    expect(calls).toEqual([{ method: 'turns', limit: FIRST_PAGE_TURN_LIMIT, itemsView: 'summary', sortDirection: 'desc' }])
    expect(first.rows).toEqual(summary.messages)
    expect(first.pagination.olderCursor).toBe('older-turns')
    expect(first.shells[0].itemsView).toBe('summary')
  })
  test('older windows also publish summaries independently', async () => {
    const { api, calls } = fixture()
    const current: TranscriptPaginationState = { olderCursor: 'before', oldestLoadedTurnId: 'turn-2', isLoadingOlder: false, hasLoadedOldest: false }
    const page = await loadOlderTurnsPage(api, 'session', current)
    expect(calls).toEqual([{ method: 'turns', cursor: 'before', limit: 5, itemsView: 'summary', sortDirection: 'desc' }])
    expect(page?.rows).toEqual(summary.messages)
    expect(await loadOlderTurnsPage(api, 'session', { ...current, hasLoadedOldest: true })).toBe(null)
    expect(await loadOlderTurnsPage(api, 'session', { ...current, isLoadingOlder: true })).toBe(null)
  })
})
describe('turn item pages', () => {
  test('hydrates a summary with a 98-item suffix and a two-item opening', async () => {
    const { api, calls, messages } = fixture()
    const page = await fetchTurnItemsPage(api, 'session', 'turn', initial)
    expect(calls).toEqual([
      { method: 'items', turnId: 'turn', limit: 98, sortDirection: 'desc' },
      { method: 'items', turnId: 'turn', limit: 2, sortDirection: 'asc' },
    ])
    expect(page.rows).toEqual(messages.slice(-98))
    expect(page.openingRows).toEqual(messages.slice(0, 2))
    expect(page.nextCursor).toBe('m105')
  })
  test('continues 100-item pages without a total item cap', async () => {
    const { api, messages } = fixture(711)
    let pagination: TurnItemsPagination = { olderCursor: null, isLoadingOlder: false, hasLoadedOldest: false }
    let loaded: any[] = []
    while (!pagination.hasLoadedOldest) {
      const page = await fetchTurnItemsPage(api, 'session', 'turn', pagination)
      loaded = [...page.rows, ...loaded]
      pagination = { olderCursor: page.nextCursor, isLoadingOlder: false, hasLoadedOldest: page.nextCursor === null }
    }
    expect(loaded).toEqual(messages)
    expect(loaded.length).toBe(711)
  })
  test('halves an oversized page while retaining its cursor and order', async () => {
    const { api, calls, messages } = fixture(20, ['decoded message length too large'])
    const page = await fetchTurnItemsPage(api, 'session', 'turn', { ...initial, summaryItemIds: undefined, olderCursor: 'm10' })
    expect(calls.map(call => call.limit)).toEqual([ITEM_PAGE_LIMIT, 50])
    expect(calls.map(call => call.cursor)).toEqual(['m10', 'm10'])
    expect(page.rows).toEqual(messages.slice(0, 10))
  })
  test('a failure preserves the supplied pagination for retry', async () => {
    const { api, calls } = fixture(203, ['disconnected'])
    let message = ''
    try { await fetchTurnItemsPage(api, 'session', 'turn', initial) } catch (error) { message = (error as Error).message }
    expect(message).toBe('disconnected')
    expect(initial.olderCursor).toBe(null)
    expect(initial.summaryItemIds).toEqual(['m0', 'm202'])
    expect((await fetchTurnItemsPage(api, 'session', 'turn', initial)).nextCursor).toBe('m105')
    expect(calls[0]).toEqual(calls[1])
  })
  test('rejects an unchanged cursor instead of looping', async () => {
    const { api } = fixture()
    api.session.historyItems = async () => ({ messages: [], page: { nextCursor: 'same', hasMore: true } })
    let message = ''
    try { await fetchTurnItemsPage(api, 'session', 'turn', { ...initial, olderCursor: 'same' }) } catch (error) { message = (error as Error).message }
    expect(message).toBe('thread items page returned an unchanged cursor')
  })
  test('a bounded reader keeps chronological order', async () => {
    const { api, messages } = fixture(250)
    expect((await fetchTurnItems(api, 'session', 'turn', 125)).rows).toEqual(messages.slice(-125))
  })
})
