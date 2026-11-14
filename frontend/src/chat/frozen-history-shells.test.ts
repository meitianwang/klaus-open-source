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

describe('frozen history read while the running Turn streams', () => {
  test('older Turns apply even when the live layer changed during the read', async () => {
    const calls: any[] = []
    const id = 'frozen-streaming-during-read'
    const page = savedPage(calls)
    // The live Turn keeps streaming while the saved window is read, as a
    // continued Turn does after a restart; every delta changes the live layer.
    api = { historyPage: async (sessionId: string, options: any) => {
      store.ingestChatEvent({ type: 'text_delta', sessionId: id, text: ' more', messageId: 'm1', turnId: LIVE })
      store.flushChatFrames()
      return page(sessionId, options)
    } }
    runOffScreen(id)
    await store.loadSessionHistory(id)
    const stream = store.getSessionStream(id)
    expect(stream.history?.map(row => row.uuid)).toEqual(['older-user', 'older-final'])
    expect(Object.keys(stream.turnShells)).toEqual([OLDER])
    expect(stream.historyStale).toBe(false)
    expect(stream.liveTurnId).toBe(LIVE)
  })
})

describe('scheduled and host-authored startup window', () => {
  test('opening a scheduled run before turn/started keeps its trigger message through completion without duplication', async () => {
    const calls: any[] = []
    api = {
      historyPage: async (_id: string, options: any) => {
        calls.push(options)
        return { messages: [], turns: [], page: { hasMore: false, nextCursor: null } }
      },
      historyItems: async () => ({ messages: [], page: { hasMore: false } }),
    }
    const id = 'scheduled-startup-before-turn-id'
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: null, startedAtMs: 1_500, inputOrigin: 'user' })
    store.ingestChatEvent({
      type: 'user_message',
      sessionId: id,
      message: {
        type: 'user',
        uuid: 'local-trigger-uuid',
        timestamp: '2026-11-14T00:00:01.500Z',
        message: { role: 'user', content: 'Run the release check', localRender: { origin: 'automation', taskName: 'Release check' } },
      },
    })

    // Switching in while session MCP servers are still initializing skips the doomed read and keeps the bubble.
    await store.loadSessionHistory(id)
    expect(calls).toHaveLength(0)
    expect(store.getSessionStream(id).liveUnits.map(unit => unit.type)).toEqual(['live-user'])

    // Once preparation finishes, turn/started stamps the real engine turn UUID onto the trigger bubble.
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: LIVE })
    store.ingestChatEvent({ type: 'stream_mode', sessionId: id, mode: 'thinking', turnId: LIVE })
    store.ingestChatEvent({ type: 'thinking_delta', sessionId: id, thinking: 'Inspecting...', turnId: LIVE })
    expect(store.getSessionStream(id).liveUnits[0]?.turnId).toBe(LIVE)

    // When the turn settles, saved history takes over cleanly with a single user row.
    api.historyPage = async () => ({
      messages: [
        { uuid: 'saved-trigger-uuid', turnId: LIVE, role: 'user', text: 'Run the release check', localRender: { origin: 'automation', taskName: 'Release check' } },
        { uuid: 'saved-reply-uuid', turnId: LIVE, role: 'assistant', text: 'All clear.', isFinalReply: true },
      ],
      turns: [{ id: LIVE, ordinal: 1, itemsView: 'full', status: 'completed', startedAtMs: 1_500, finishedAtMs: 2_500, durationMs: 1_000 }],
      turnStatuses: { [LIVE]: 'completed' },
      page: { hasMore: false, nextCursor: null },
    })
    store.ingestChatEvent({ type: 'done', sessionId: id, turnId: LIVE })
    await store.loadSessionHistory(id, { reconcile: true })
    const settled = store.getSessionStream(id)
    expect(settled.liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(0)
    expect(settled.history?.filter(row => row.role === 'user').map(row => row.uuid)).toEqual(['saved-trigger-uuid'])
  })

  test('an initial empty disk read never wipes an unstamped trigger message', async () => {
    api = {
      historyPage: async () => ({ messages: [], turns: [], page: { hasMore: false, nextCursor: null } }),
      historyItems: async () => ({ messages: [], page: { hasMore: false } }),
    }
    const id = 'scheduled-empty-initial-read'
    store.ingestChatEvent({
      type: 'user_message',
      sessionId: id,
      message: {
        type: 'user',
        uuid: 'unstamped-trigger',
        timestamp: '2026-11-14T00:00:02.000Z',
        message: { role: 'user', content: 'Run check', localRender: { origin: 'automation' } },
      },
    })
    await store.loadSessionHistory(id)
    expect(store.getSessionStream(id).liveUnits.map(unit => unit.type)).toEqual(['live-user'])
  })

  test('a crossing initial read withholds an unfinished turn shell already written to disk', async () => {
    const id = 'scheduled-crossing-initial-read'
    let releaseRead!: (value: any) => void
    api = {
      historyPage: () => new Promise(resolve => { releaseRead = resolve }),
      historyItems: async () => ({ messages: [], page: { hasMore: false } }),
    }
    const reading = store.loadSessionHistory(id)
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId: null, startedAtMs: 2_000, inputOrigin: 'user' })
    store.ingestChatEvent({
      type: 'user_message',
      sessionId: id,
      message: {
        type: 'user',
        uuid: 'crossing-trigger',
        timestamp: '2026-11-14T00:00:02.000Z',
        message: { role: 'user', content: 'Immediate switch prompt', localRender: { origin: 'automation' } },
      },
    })
    releaseRead({
      messages: [],
      turns: [
        { id: `${id}-preamble`, ordinal: 0, itemsView: 'full', status: null },
        { id: LIVE, ordinal: 1, itemsView: 'full', status: 'interrupted', startedAtMs: 2_000, finishedAtMs: null, durationMs: null },
      ],
      turnStatuses: { [LIVE]: 'interrupted' },
      turnStartedAtMs: { [LIVE]: 2_000 },
      page: { hasMore: false, nextCursor: null },
    })
    await reading
    const state = store.getSessionStream(id)
    expect(Object.keys(state.turnShells)).toEqual([`${id}-preamble`])
    expect(state.liveUnits.map(unit => unit.type)).toEqual(['live-user'])
    expect(state.turnStatuses[LIVE]).toBeUndefined()
  })
})
