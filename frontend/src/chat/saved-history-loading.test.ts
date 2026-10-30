import { beforeAll, afterAll, describe, expect, test } from 'bun:test'

const previousWindow = (globalThis as any).window
let api: any
let store: typeof import('./stream-store')
beforeAll(async () => {
  ;(globalThis as any).window = { addEventListener() {}, klaus: { session: {
    historyPage: (...args: any[]) => api.historyPage(...args),
    historyItems: (...args: any[]) => api.historyItems(...args),
  } } }
  store = await import('./stream-store')
})
afterAll(() => { (globalThis as any).window = previousWindow })
const row = (turnId: string, index: number) => ({ uuid: `${turnId}-${index}`, turnId, role: index === 0 ? 'user' : 'assistant',
  text: `Message ${index}`, ...(index === 710 ? { isFinalReply: true } : {}) })
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function fixture(turns = ['turn'], count = 711) {
  const calls: any[] = []
  const messages = Object.fromEntries(turns.map(id => [id, Array.from({ length: count }, (_, index) => row(id, index))]))
  api = {
    historyPage: async (_id: string, opts: any) => {
      calls.push({ type: 'turns', ...opts })
      return { messages: turns.flatMap(id => [messages[id][0], messages[id].at(-1)]),
        turns: turns.map((id, index) => ({ id, ordinal: index * 1000, updatedAtOrdinal: index * 1000 + count, itemsView: 'summary', status: 'completed' })),
        turnStatuses: Object.fromEntries(turns.map(id => [id, 'completed'])), page: { hasMore: false, nextCursor: null } }
    },
    historyItems: async (_id: string, opts: any) => {
      calls.push({ type: 'items', ...opts })
      const all = messages[opts.turnId]
      const end = opts.cursor ? all.findIndex(message => message.uuid === opts.cursor) : all.length
      const start = opts.sortDirection === 'asc' ? 0 : Math.max(0, end - opts.limit)
      const rows = opts.sortDirection === 'asc' ? all.slice(0, opts.limit) : all.slice(start, end)
      return { messages: rows, page: { hasMore: start > 0, nextCursor: start > 0 ? all[start].uuid : null } }
    },
  }
  return { calls, messages }
}
const loadedIds = (sessionId: string) => store.getSessionStream(sessionId).history?.map(message => message.uuid)
const pager = (sessionId: string, turnId = 'turn') => store.getSessionStream(sessionId).savedTranscript!.entitiesByKey[`turn:${turnId}`].itemsPagination
async function rejects(promise: Promise<unknown>) {
  let rejected = false
  try { await promise } catch { rejected = true }
  expect(rejected).toBe(true)
}

describe('saved history request ownership', () => {
  test('an interior gap reads its own cursor when an earlier window can also page', async () => {
    const calls: any[] = []
    const page = (ids: string[], cursor: string) => ({
      messages: ids.map(id => row(id, 0)),
      turns: ids.map(id => ({ id, ordinal: id.charCodeAt(0), itemsView: 'full', status: 'completed' })),
      turnStatuses: Object.fromEntries(ids.map(id => [id, 'completed'])),
      page: { hasMore: true, nextCursor: cursor },
    })
    let snapshots = 0
    api = {
      historyPage: async (_id: string, options: any) => {
        calls.push(options)
        if (options.cursor) return page(['b', 'c'], 'before-b')
        return snapshots++ === 0 ? page(['a'], 'before-a') : page(['c'], 'before-c')
      },
    }
    const id = 'interior-gap-own-cursor'
    await store.loadSessionHistory(id)
    await store.loadSessionHistory(id)
    const history = store.getSessionStream(id).savedTranscript!
    expect(history.islands).toHaveLength(2)
    const island = history.islands[1], boundary = island.olderBoundary
    if (boundary.status !== 'available' || !boundary.boundaryId) throw new Error('Missing interior boundary')
    await store.loadOlderHistoryPage(id, {
      ...boundary, boundaryId: boundary.boundaryId, generation: history.generation, islandId: island.id, edge: 'older',
    })
    expect(calls.at(-1).cursor).toBe('before-c')
    expect(loadedIds(id)).toEqual(['a-0', 'b-0', 'c-0'])
  })

  test('detail failure preserves summary and retry does not reload the snapshot', async () => {
    const { calls, messages } = fixture()
    const id = 'detail-failure-retry'
    await store.loadSessionHistory(id)
    const read = api.historyItems
    api.historyItems = async () => { throw new Error('disconnected') }
    await rejects(store.loadTurnHistoryItems(id, 'turn'))
    expect(loadedIds(id)).toEqual([messages.turn[0].uuid, messages.turn.at(-1)!.uuid])
    expect(pager(id).isLoadingOlder).toBe(false)
    expect(pager(id).olderCursor).toBe(null)
    api.historyItems = read
    await store.loadTurnHistoryItems(id, 'turn')
    expect(calls.filter(call => call.type === 'turns')).toHaveLength(1)
    expect(loadedIds(id)?.[0]).toBe('turn-0')
    expect(loadedIds(id)?.at(-1)).toBe('turn-710')
    expect(pager(id).olderCursor).toBe('turn-613')
  })

  test('successive pages commit independently and complete loading crosses 500 messages', async () => {
    const { messages } = fixture()
    const id = 'full-long-turn'
    await store.loadSessionHistory(id)
    await store.loadTurnHistoryItems(id, 'turn')
    const accepted = loadedIds(id)
    const cursor = pager(id).olderCursor
    const read = api.historyItems
    api.historyItems = async () => { throw new Error('later page failed') }
    await rejects(store.loadTurnHistoryItems(id, 'turn', true))
    expect(loadedIds(id)).toEqual(accepted)
    expect(pager(id).olderCursor).toBe(cursor)
    api.historyItems = read
    await store.loadTurnHistoryItems(id, 'turn', true)
    expect(loadedIds(id)).toEqual(messages.turn.map(message => message.uuid))
    expect(pager(id).hasLoadedOldest).toBe(true)
    await store.loadSessionHistory(id)
    expect(loadedIds(id)).toEqual(messages.turn.map(message => message.uuid))
  })

  test('two callers share a pending detail request and release it after settlement', async () => {
    const { calls } = fixture(['turn'], 3)
    const id = 'detail-request-coalescing'
    await store.loadSessionHistory(id)
    const read = api.historyItems, pending = deferred()
    api.historyItems = async (...args: any[]) => { await pending.promise; return read(...args) }
    const first = store.loadTurnHistoryItems(id, 'turn')
    const second = store.loadTurnHistoryItems(id, 'turn')
    pending.resolve(null)
    await Promise.all([first, second])
    expect(calls.filter(call => call.type === 'items')).toHaveLength(1)
    await store.loadSessionHistory(id, { reconcile: true })
    expect(calls.filter(call => call.type === 'turns')).toHaveLength(2)
    expect(loadedIds(id)).toEqual(['turn-0', 'turn-1', 'turn-2'])
  })

  test('reconnect keeps cached rows, invalidates a late page, and allows a fresh request', async () => {
    fixture(['turn'], 3)
    const id = 'reconnect-generation-fence'
    await store.loadSessionHistory(id)
    const pending = deferred(), read = api.historyItems
    api.historyItems = () => pending.promise
    const old = store.loadTurnHistoryItems(id, 'turn')
    const cached = loadedIds(id)
    const generation = store.getSessionStream(id).historyGeneration
    store.ingestEngineStatus({ status: 'reconnecting' })
    expect(loadedIds(id)).toEqual(cached)
    expect(store.getSessionStream(id).historyGeneration).toBe(generation + 1)
    expect(pager(id).isLoadingOlder).toBe(false)
    pending.resolve({ messages: [row('turn', 99)], page: { hasMore: false } })
    await old
    expect(loadedIds(id)).toEqual(cached)
    store.ingestEngineStatus({ status: 'ok' })
    api.historyItems = read
    await store.loadSessionHistory(id)
    await store.loadTurnHistoryItems(id, 'turn')
    expect(loadedIds(id)).toEqual(['turn-0', 'turn-1', 'turn-2'])
  })

  test('a turn removed before its item read retires the live tail and stale pager', async () => {
    fixture(['older'], 2)
    const id = 'rewound-turn-item-read'
    await store.loadSessionHistory(id)
    store.ingestLocalUserTurn(id, { text: 'latest', uuid: 'optimistic-latest' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId: id, turnId: 'removed', mode: 'requesting' })
    store.ingestChatEvent({ type: 'text_delta', sessionId: id, turnId: 'removed', text: 'partial answer' })
    store.ingestChatEvent({ type: 'interrupted', sessionId: id, turnId: 'removed' }, { userInterrupted: true })
    const summary = (turnId: string, ordinal: number) => ({
      id: turnId, ordinal, updatedAtOrdinal: ordinal + 2, itemsView: 'summary', status: 'completed',
    })
    api.historyPage = async () => ({
      messages: [row('older', 0), row('removed', 0)],
      turns: [summary('older', 0), summary('removed', 1000)],
      turnStatuses: { older: 'completed', removed: 'interrupted' },
      page: { hasMore: false, nextCursor: null },
    })
    await store.loadSessionHistory(id, { reconcile: true })
    expect(store.getSessionStream(id).savedTranscript!.entitiesByKey['turn:removed']).toBeDefined()
    expect(store.getSessionStream(id).interruptedLiveTurn).toEqual({ turnId: 'removed' })
    api.historyItems = async () => { throw new Error('unknown history turn') }
    api.historyPage = async () => ({
      messages: [row('older', 0)], turns: [summary('older', 0)],
      turnStatuses: { older: 'completed' }, page: { hasMore: false, nextCursor: null },
    })
    await store.loadTurnHistoryItems(id, 'removed')
    const state = store.getSessionStream(id)
    expect(state.savedTranscript!.entitiesByKey['turn:removed']).toBeUndefined()
    expect(state.liveUnits).toEqual([])
    expect(state.interruptedLiveTurn).toBeNull()
    expect(loadedIds(id)).toEqual(['older-0', 'older-1'])
  })

  test('only two summary previews run concurrently and the queue drains', async () => {
    const turns = ['a', 'b', 'c', 'd', 'e']
    fixture(turns, 3)
    const id = 'preview-concurrency'
    await store.loadSessionHistory(id)
    const read = api.historyItems, pending = deferred()
    let active = 0, maximum = 0, started = 0
    api.historyItems = async (...args: any[]) => {
      active++; started++; maximum = Math.max(maximum, active)
      await pending.promise
      active--
      return read(...args)
    }
    const loads = turns.map(turnId => store.loadTurnHistoryItems(id, turnId))
    await tick()
    expect(started).toBe(2)
    pending.resolve(null)
    await Promise.all(loads)
    expect(maximum).toBe(2)
    expect(started).toBe(5)
    for (const turnId of turns) expect(pager(id, turnId).hasLoadedOldest).toBe(true)
  })
})
