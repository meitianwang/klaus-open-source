// A conversation opened while its Turn runs reads saved history in the freeze
// window. The saved page names the running Turn twice: as rows (already sliced
// off by frozenHistorySlice) and as a turn shell. The shell must be dropped too:
// the Turn's start time is withheld from the history layer while it runs, so a
// kept shell sorted to the front of the transcript and the running Turn, user
// message included, drew above every older Turn and out of view.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

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

const OLDER = 'older-turn', LIVE = 'running-turn'
function savedPage(calls: any[]) {
  return async (_id: string, options: any) => {
    calls.push({ type: 'turns', ...options })
    return {
      messages: [
        { uuid: 'older-user', turnId: OLDER, role: 'user', text: 'earlier question' },
        { uuid: 'older-final', turnId: OLDER, role: 'assistant', text: 'earlier answer', isFinalReply: true },
        { uuid: 'running-user', turnId: LIVE, role: 'user', text: 'delivered message' },
      ],
      turns: [
        { id: OLDER, ordinal: 1, itemsView: 'summary', status: 'completed', startedAtMs: 1_000 },
        { id: LIVE, ordinal: 2, itemsView: 'summary', status: 'running', startedAtMs: 2_000 },
      ],
      turnStatuses: { [OLDER]: 'completed', [LIVE]: 'running' },
      turnStartedAtMs: { [OLDER]: 1_000, [LIVE]: 2_000 },
      page: { hasMore: false, nextCursor: null },
    }
  }
}
function runOffScreen(sessionId: string) {
  // The host's delivery frame, then the engine's lifecycle: nothing typed here.
  store.ingestChatEvent({ type: 'user_message', sessionId, message: { type: 'user', uuid: 'host-user', message: { role: 'user', content: 'delivered message' } } })
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: LIVE })
  store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: LIVE })
  store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'working', messageId: 'm1', turnId: LIVE })
}

describe('frozen history read of a running conversation', () => {
  test('the running Turn is held by the live layer only, rows and shell alike', async () => {
    const calls: any[] = []
    api = { historyPage: savedPage(calls), historyItems: async () => { throw new Error('no item page expected') } }
    const id = 'frozen-shells-running'
    runOffScreen(id)
    await store.loadSessionHistory(id)
    const stream = store.getSessionStream(id)
    expect(stream.history?.map(row => row.uuid)).toEqual(['older-user', 'older-final'])
    expect(Object.keys(stream.turnShells)).toEqual([OLDER])
    expect(Object.values(stream.savedTranscript!.entitiesByKey).map(turn => turn.id)).toEqual([OLDER])
    expect(stream.liveUnits.map(unit => unit.type)).toEqual(['live-user', 'live-text'])
    expect(stream.liveTurnId).toBe(LIVE)
    // The saved window has nothing left to page, so the running Turn's items are never fetched.
    expect(await store.loadOlderHistoryPage(id)).toBe('stop')
    expect(calls.filter(call => call.type !== 'turns')).toEqual([])
  })

  test('the Turn returns to the saved transcript once it ends', async () => {
    const calls: any[] = []
    api = { historyPage: savedPage(calls) }
    const id = 'frozen-shells-handoff'
    runOffScreen(id)
    await store.loadSessionHistory(id)
    store.ingestChatEvent({ type: 'done', sessionId: id, turnId: LIVE })
    await store.loadSessionHistory(id, { reconcile: true })
    const stream = store.getSessionStream(id)
    expect(Object.keys(stream.turnShells).sort()).toEqual([LIVE, OLDER].sort())
    expect(stream.history?.map(row => row.uuid)).toContain('running-user')
  })
})
