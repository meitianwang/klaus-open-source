import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { savedTurn } from './saved-transcript'

const previousWindow = (globalThis as any).window
let store: typeof import('./stream-store')
let api: any
beforeAll(async () => {
  ;(globalThis as any).window = { addEventListener() {}, klaus: { session: {
    historyPage: (...args: any[]) => api.historyPage(...args),
    historyItems: (...args: any[]) => api.historyItems(...args),
  } } }
  store = await import('./stream-store')
})
afterAll(() => { (globalThis as any).window = previousWindow })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const ids = (sessionId: string) => store.getSessionStream(sessionId).history?.map(row => row.uuid) ?? []
function fixture(capability = true) {
  const calls: any[] = []
  const turnIds = ['t0', 't1', 't2', 't3', 't4']
  const messages = Object.fromEntries(turnIds.map(turnId => [turnId, Array.from({ length: 240 }, (_, index) => ({
    uuid: `${turnId}-m${index}`, turnId, role: index === 0 ? 'user' : 'assistant', text: `Message ${index}`,
  }))]))
  api = {
    historyPage: async (_id: string, options: any) => {
      calls.push({ type: 'turns', ...options })
      return {
        ...(capability ? { supportsItemAnchors: true } : {}),
        messages: turnIds.flatMap(id => messages[id]),
        turns: turnIds.map((id, index) => ({ id, ordinal: index, updatedAtOrdinal: 240, status: 'completed', itemsView: 'full' })),
        turnStatuses: Object.fromEntries(turnIds.map(id => [id, 'completed'])), page: { hasMore: false },
      }
    },
    historyItems: async (_id: string, options: any) => {
      calls.push({ type: 'items', ...options })
      const all = messages[options.turnId]
      const anchor = options.cursor ?? options.beforeItemId
      const end = anchor ? all.findIndex((row: any) => row.uuid === anchor) : all.length
      if (end < 0) throw new Error('unknown item anchor')
      const start = Math.max(0, end - options.limit)
      return { supportsItemAnchors: true, messages: all.slice(start, end),
        page: { hasMore: start > 0, nextCursor: start > 0 ? all[start].uuid : null } }
    },
  }
  return { calls, messages }
}
const bottom = { oldestRenderedTurnId: 't4', firstProtectedItemId: null }

describe('saved history retention and request ownership', () => {
  test('all mounted readers must report a bottom boundary before release', async () => {
    fixture()
    const id = 'retention-all-readers'
    const first = store.registerSavedHistoryViewport(id), second = store.registerSavedHistoryViewport(id)
    first.setHistoryViewport(bottom)
    await store.loadSessionHistory(id); await tick()
    expect(ids(id)).toHaveLength(1200)
    second.setHistoryViewport(bottom); await tick()
    const state = store.getSessionStream(id)
    expect(ids(id)).toHaveLength(500)
    expect(state.loadedRows).toHaveLength(500)
    expect(Object.keys(state.savedTranscript!.entitiesByKey)).toHaveLength(5)
    expect(state.supportsSavedItemAnchors).toBe(true)
    expect(savedTurn(state.savedTranscript, 't2')?.itemsPagination.olderItemId).toBe('t2-m220')
    first.dispose(); second.dispose()
    store.retireSessionStream(id)
  })
  test('releasing an off-bottom surface permits the remaining bottom reader to trim', async () => {
    fixture()
    const id = 'retention-reader-disposal'
    const first = store.registerSavedHistoryViewport(id), second = store.registerSavedHistoryViewport(id)
    first.setHistoryViewport(bottom)
    await store.loadSessionHistory(id); await tick()
    expect(ids(id)).toHaveLength(1200)
    second.dispose(); await tick()
    expect(ids(id)).toHaveLength(500)
    first.dispose(); store.retireSessionStream(id)
  })
  test('a host without an explicit item-anchor capability never releases rows', async () => {
    fixture(false)
    const id = 'retention-old-host'
    const surface = store.registerSavedHistoryViewport(id)
    surface.setHistoryViewport(bottom)
    await store.loadSessionHistory(id); await tick()
    expect(store.getSessionStream(id).supportsSavedItemAnchors).toBe(false)
    expect(ids(id)).toHaveLength(1200)
    surface.dispose(); store.retireSessionStream(id)
  })
  test('legacy item IDs release all retained row projections together', async () => {
    const { messages } = fixture()
    for (const rows of Object.values(messages)) for (const row of rows as any[]) { row.id = row.uuid; delete row.uuid }
    const id = 'retention-legacy-item-id'
    const surface = store.registerSavedHistoryViewport(id)
    surface.setHistoryViewport(bottom)
    await store.loadSessionHistory(id); await tick()
    const state = store.getSessionStream(id)
    expect(state.history).toHaveLength(500)
    expect(state.loadedRows).toHaveLength(500)
    expect(savedTurn(state.savedTranscript, 't2')?.itemsPagination.olderItemId).toBe('t2-m220')
    surface.dispose(); store.retireSessionStream(id)
  })

  test('an evicted prefix reloads before its retained anchor without re-reading the latest suffix', async () => {
    const { calls } = fixture()
    const id = 'retention-item-anchor-reload'
    const surface = store.registerSavedHistoryViewport(id)
    surface.setHistoryViewport(bottom)
    await store.loadSessionHistory(id); await tick()
    surface.setHistoryViewport(null)
    await store.loadTurnHistoryItems(id, 't2')
    const read = calls.filter(call => call.type === 'items')
    expect(read).toEqual([{ type: 'items', turnId: 't2', beforeItemId: 't2-m220', limit: 100, sortDirection: 'desc' }])
    expect(savedTurn(store.getSessionStream(id).savedTranscript, 't2')?.items.map(row => row.uuid))
      .toEqual(Array.from({ length: 120 }, (_, index) => `t2-m${index + 120}`))
    expect(savedTurn(store.getSessionStream(id).savedTranscript, 't2')?.itemsPagination.olderCursor).toBe('t2-m120')
    await store.loadTurnHistoryItems(id, 't2')
    expect(calls.filter(call => call.type === 'items').at(-1)).toEqual({ type: 'items', turnId: 't2', cursor: 't2-m120', limit: 100, sortDirection: 'desc' })
    expect(new Set(ids(id)).size).toBe(ids(id).length)
    surface.dispose(); store.retireSessionStream(id)
  })
  test('an empty evicted turn rehydrates through its ordinary newest item page', async () => {
    const { calls, messages } = fixture()
    const id = 'retention-empty-turn-reload'
    const surface = store.registerSavedHistoryViewport(id)
    surface.setHistoryViewport(bottom)
    await store.loadSessionHistory(id); await tick()
    surface.setHistoryViewport(null)
    expect(savedTurn(store.getSessionStream(id).savedTranscript, 't0')?.items).toEqual([])
    await store.loadTurnHistoryItems(id, 't0', true)
    expect(calls.filter(call => call.type === 'items')[0]).toEqual({ type: 'items', turnId: 't0', limit: 100, sortDirection: 'desc' })
    expect(savedTurn(store.getSessionStream(id).savedTranscript, 't0')?.items).toEqual(messages.t0)
    surface.dispose(); store.retireSessionStream(id)
  })
  test('a retired registration cannot trim a newly recreated conversation', async () => {
    fixture()
    const id = 'retention-stale-reader'
    const surface = store.registerSavedHistoryViewport(id)
    store.retireSessionStream(id, { deleted: false })
    await store.loadSessionHistory(id); await tick()
    surface.setHistoryViewport(bottom); await tick()
    expect(ids(id)).toHaveLength(1200)
    surface.dispose(); store.retireSessionStream(id)
  })
})
