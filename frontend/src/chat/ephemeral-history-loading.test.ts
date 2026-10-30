import { afterAll, beforeAll, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/thread-history-source-vectors.json'

const previousWindow = (globalThis as any).window
let store: typeof import('./stream-store')
let api: any
beforeAll(async () => {
  ;(globalThis as any).window = { addEventListener() {}, klaus: { session: {
    history: (...args: any[]) => api.history(...args),
    historyPage: (...args: any[]) => api.historyPage(...args),
    historyItems: (...args: any[]) => api.historyItems(...args),
  }, agents: { history: (...args: any[]) => api.agentHistory(...args) } } }
  store = await import('./stream-store')
})
afterAll(() => { (globalThis as any).window = previousWindow })

function deferred() {
  let resolve!: (reply: any) => void, reject!: (error: Error) => void
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const rows = (text: string) => [{ uuid: `user-${text}`, role: 'user', text, turnId: 'turn' },
  { uuid: `answer-${text}`, role: 'assistant', text: `Answer ${text}`, turnId: 'turn', isFinalReply: true }]
function fixture() {
  const calls: string[] = []
  api = {
    history: async (id: string) => { calls.push(`live:${id}`); return { messages: rows(id), turnStatuses: { turn: 'completed' } } },
    historyPage: async (id: string) => { calls.push(`saved:${id}`); throw new Error(`No saved rollout for ${id}`) },
    historyItems: async () => { throw new Error('An ephemeral snapshot has no item pages') },
    agentHistory: async () => ({ messages: [] }),
  }
  return calls
}

test('ephemeral history uses the live endpoint with a production-shaped paged bridge', async () => {
  const calls = fixture(), id = 'ephemeral-first-open'
  store.prepareEphemeralSessionStream(id)
  await store.loadSessionHistory(id)
  const state = store.getSessionStream(id)
  expect(calls).toEqual([`live:${id}`])
  expect(state.history).toEqual(rows(id))
  expect(state.historyLoadFailed).toBe(false)
  expect(state.savedTranscript).toBeNull()
  expect(state.turnsPagination).toBeNull()
  expect(vectors.source.ephemeralTranscriptSource).toBe('session/history')
})

test('a real live read failure preserves accepted rows and retries the same source', async () => {
  const calls = fixture(), id = 'ephemeral-retry'
  store.prepareEphemeralSessionStream(id)
  await store.loadSessionHistory(id)
  const accepted = store.getSessionStream(id).history
  const read = api.history
  api.history = async () => { throw new Error('Connection closed') }
  await store.loadSessionHistory(id)
  expect(store.getSessionStream(id).historyLoadFailed).toBe(true)
  expect(store.getSessionStream(id).history).toBe(accepted)
  api.history = read
  await store.retryHistoryLoad(id)
  expect(store.getSessionStream(id).historyLoadFailed).toBe(false)
  expect(store.getSessionStream(id).historyRetry).toBeNull()
  expect(calls).toEqual([`live:${id}`, `live:${id}`])
})

test('source registration invalidates a pending saved read and is idempotent', async () => {
  const calls = fixture(), id = 'ephemeral-source-race', pending = deferred()
  api.historyPage = (sid: string) => { calls.push(`saved:${sid}`); return pending.promise }
  const stale = store.loadSessionHistory(id)
  store.prepareEphemeralSessionStream(id)
  await store.loadSessionHistory(id)
  const accepted = store.getSessionStream(id)
  store.prepareEphemeralSessionStream(id)
  expect(store.getSessionStream(id)).toBe(accepted)
  pending.reject(new Error('No saved rollout'))
  await stale
  expect(store.getSessionStream(id).historyLoadFailed).toBe(false)
  expect(store.getSessionStream(id).history).toEqual(rows(id))
  expect(calls).toEqual([`saved:${id}`, `live:${id}`])
})

test('a closing ephemeral endpoint cannot be resurrected by a delayed live reply', async () => {
  fixture()
  const id = 'ephemeral-retired', pending = deferred()
  api.history = () => pending.promise
  store.prepareEphemeralSessionStream(id)
  const stale = store.loadSessionHistory(id)
  store.retireSessionStream(id)
  pending.resolve({ messages: rows(id) })
  await stale
  expect(store.chatStreamStore.getState().sessions[id]).toBeUndefined()
})

test('live snapshot publication during a running turn does not duplicate its user or text', async () => {
  fixture()
  const id = 'ephemeral-running', turnId = 'active'
  store.prepareEphemeralSessionStream(id)
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId: id, status: 'active', turnId })
  store.ingestChatEvent({ type: 'user_message', sessionId: id, turnId,
    message: { uuid: 'active-user', message: { content: [{ type: 'text', text: 'Live question' }] } } })
  store.ingestChatEvent({ type: 'text_delta', sessionId: id, turnId, messageId: 'active-answer', text: 'Working', phase: 'commentary' })
  api.history = async () => ({ messages: [
    { uuid: 'active-user', role: 'user', text: 'Live question', turnId },
    { uuid: 'active-answer', role: 'assistant', text: 'Working', turnId },
  ] })
  await store.loadSessionHistory(id)
  const state = store.getSessionStream(id)
  expect(state.historyLoadFailed).toBe(false)
  expect((state.history || []).filter(message => message.turnId === turnId)).toEqual([])
  expect(state.liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(1)
  expect(state.liveUnits.filter(unit => unit.type === 'live-text')).toHaveLength(1)
})

test('saved conversations and subagents retain independent history sources', async () => {
  const calls = fixture()
  api.historyPage = async (id: string) => { calls.push(`saved:${id}`); return { messages: rows(id), turns: [{ id: 'turn', itemsView: 'full' }], page: { hasMore: false } } }
  const id = 'promoted-saved-conversation'
  await store.loadSessionHistory(id)
  const child = store.prepareSubagentStream(id, 'task', { agentId: 'child', status: 'completed' })
  api.agentHistory = async () => { calls.push('child'); return { messages: rows('child') } }
  await store.loadSessionHistory(child)
  expect(calls).toEqual([`saved:${id}`, 'child'])
  expect(store.getSessionStream(id).historySource).toBe('saved')
  expect(store.getSessionStream(id).savedTranscript).not.toBeNull()
})
