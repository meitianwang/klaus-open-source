// A rewind removes one sent message and every turn after it. The screen keeps
// its own copies of that tail (a stopped turn stays live on purpose, and the
// saved-transcript cache is append-only), so the cut has to reach all of them
// at once and stale snapshots must not repaint the undone turn.
import { describe, expect, test } from 'bun:test'

type Row = { uuid: string; role: 'user' | 'assistant'; text: string; turnId: string }

const row = (uuid: string, role: Row['role'], text: string, turnId: string): Row => ({ uuid, role, text, turnId })

const historyCalls: string[] = []
let respond: (sessionId: string) => Promise<any> = async () => ({ messages: [] })

;(globalThis as any).window = {
  addEventListener: () => {},
  klaus: {
    session: {
      history: (sessionId: string) => {
        historyCalls.push(sessionId)
        return respond(sessionId)
      },
    },
    agents: {
      history: (sessionId: string) => {
        historyCalls.push(sessionId)
        return respond(sessionId)
      },
      teammateMessages: (sessionId: string) => {
        historyCalls.push(sessionId)
        return respond(sessionId)
      },
    },
  },
}

const store = await import('./stream-store')
const cuts = await import('./rewind-tail')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function stoppedTurn(sessionId: string, turnId: string, messageUuid: string): void {
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId })
  store.ingestChatEvent({ type: 'user_message', sessionId, message: { uuid: messageUuid, message: { content: 'undo me' } } })
  store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: `${turnId}-text`, turnId, text: 'partial answer' })
  store.ingestChatEvent({ type: 'interrupted', sessionId, turnId })
}

describe('rewind cut', () => {
  test('forgetRewoundTurn drops the stopped tail, its statuses and its shell at once', () => {
    const sessionId = 'rewind-cut-immediate'
    stoppedTurn(sessionId, 'turn-undo', 'msg-undo')
    store.ingestChatEvent({ type: 'turn_lifecycle', sessionId, turnId: 'turn-undo', status: 'interrupted', durationMs: 2934000 })
    const before = store.getSessionStream(sessionId)
    expect(before.liveUnits.some(unit => unit.type === 'live-user')).toBe(true)
    expect(before.interruptedLiveTurn).toEqual({ turnId: 'turn-undo' })

    store.forgetRewoundTurn(sessionId, 'msg-undo', 'turn-undo')
    const after = store.getSessionStream(sessionId)
    expect(after.liveUnits).toEqual([])
    expect(after.interruptedLiveTurn).toBeNull()
    expect(after.lastTerminalStatus).toBeNull()
    expect(after.turnStatuses['turn-undo']).toBeUndefined()
    expect(after.turnDurations['turn-undo']).toBeUndefined()
    expect(after.liveTurnId).toBeNull()
    expect(after.history?.some(message => message.turnId === 'turn-undo') ?? false).toBe(false)
  })

  test('a stale snapshot that still names the rewound turn cannot repaint it', async () => {
    const sessionId = 'rewind-cut-stale-snapshot'
    stoppedTurn(sessionId, 'turn-stale', 'msg-stale')
    store.forgetRewoundTurn(sessionId, 'msg-stale', 'turn-stale')
    respond = async () => ({
      messages: [row('msg-stale', 'user', 'undo me', 'turn-stale'), row('a-stale', 'assistant', 'partial answer', 'turn-stale')],
      turnStatuses: { 'turn-stale': 'interrupted' },
      turnDurations: { 'turn-stale': 2934000 },
      turns: [{ id: 'turn-stale', itemsView: 'full' }],
    })
    await store.loadSessionHistory(sessionId, { reconcile: true, rewoundLiveTail: true })
    await flush()
    const state = store.getSessionStream(sessionId)
    expect(state.history?.some(message => message.turnId === 'turn-stale')).toBe(false)
    expect(state.turnStatuses['turn-stale']).toBeUndefined()
    expect(state.turnShells['turn-stale']).toBeUndefined()
    expect(state.liveUnits).toEqual([])
    expect(state.interruptedLiveTurn).toBeNull()
    // The cut stays armed until a snapshot without the tail arrives.
    expect(cuts.peekRewindCut(sessionId)?.turnIds).toEqual(['turn-stale'])
  })

  test('a clean snapshot retires the pending cut and keeps earlier turns', async () => {
    const sessionId = 'rewind-cut-clean-snapshot'
    stoppedTurn(sessionId, 'turn-clean', 'msg-clean')
    store.forgetRewoundTurn(sessionId, 'msg-clean', 'turn-clean')
    respond = async () => ({
      messages: [row('msg-old', 'user', 'earlier', 'turn-old'), row('a-old', 'assistant', 'earlier answer', 'turn-old')],
      turnStatuses: { 'turn-old': 'completed' },
      turns: [{ id: 'turn-old', itemsView: 'full' }],
    })
    await store.loadSessionHistory(sessionId, { reconcile: true, rewoundLiveTail: true })
    await flush()
    const state = store.getSessionStream(sessionId)
    expect(state.history?.map(message => message.uuid)).toEqual(['msg-old', 'a-old'])
    expect(state.turnStatuses).toEqual({ 'turn-old': 'completed' })
    expect(cuts.peekRewindCut(sessionId)).toBeUndefined()
  })

  test('rowsBeforeRewind keeps rows of unrelated turns when the message is unknown', () => {
    const rows = [row('m1', 'user', 'one', 't1'), row('m2', 'user', 'two', 't2')]
    const cut = { messageUuid: 'missing', turnId: 't2', turnIds: ['t2'] }
    expect(cuts.rowsBeforeRewind(rows, cut).map(r => r.uuid)).toEqual(['m1'])
  })
})
