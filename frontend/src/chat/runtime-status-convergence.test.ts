// Acceptance tests for the running-state convergence contract
// (contracts/vectors/turn-termination-vectors.json: runtimeStatusProjection,
// terminalEventDelivery). The running indicator is a turn-lifecycle fact: it opens
// on the host's `session_runtime_status` active frame (projected from turn/started)
// or on turn submission, settles on terminal events and idle frames, and can no
// longer be opened by bare activity frames or killed by a terminal event that
// names a different turn.
import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = {
  addEventListener: () => {},
  currentLang: 'en',
  klaus: { session: { history: async () => [] } },
}

const store = await import('./stream-store')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('session_runtime_status convergence', () => {
  test('an active frame opens the running state under the engine-named turn', () => {
    const sessionId = 'runtime-status-active'
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'turn-9' })
    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(true)
    expect(state.activeTurnId).toBe('turn-9')
  })

  test('activity frames alone cannot open the running state', () => {
    const sessionId = 'runtime-status-activity'
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'noise' })
    store.ingestChatEvent({ type: 'progress', sessionId, text: 'still noise' })
    expect(store.getSessionStream(sessionId).running).toBe(false)
  })

  test('an idle frame settles a drifted running indicator without a terminal event', async () => {
    const sessionId = 'runtime-status-idle'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'partial' })
    expect(store.getSessionStream(sessionId).running).toBe(true)
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'idle', turnId: 'turn-1' })
    await flush()
    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(false)
    expect(state.activeTurnId).toBe(null)
  })

  test('an idle frame naming a foreign turn cannot settle the live turn', () => {
    const sessionId = 'runtime-status-foreign-idle'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'idle', turnId: 'turn-OTHER' })
    expect(store.getSessionStream(sessionId).running).toBe(true)
  })

  test('a terminal event naming a foreign turn cannot settle the live turn', () => {
    const sessionId = 'runtime-status-foreign-done'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-OLD' })
    expect(store.getSessionStream(sessionId).running).toBe(true)
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-1' })
    expect(store.getSessionStream(sessionId).running).toBe(false)
  })

  test('an unnamed terminal event settles the active turn', () => {
    const sessionId = 'runtime-status-unnamed-done'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'done', sessionId })
    expect(store.getSessionStream(sessionId).running).toBe(false)
  })
})
