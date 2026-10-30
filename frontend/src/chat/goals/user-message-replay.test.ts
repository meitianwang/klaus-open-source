import { afterAll, beforeAll, expect, test } from 'bun:test'
import { setTaskItems, taskItems, taskPlanIdentity } from '../task-state'
let previousWindow: any
let store: typeof import('../stream-store')
beforeAll(async () => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = { ...previousWindow, addEventListener() {}, klaus: { session: { history: async () => ({ messages: [] }) } } }
  store = await import('../stream-store')
})
afterAll(() => { (globalThis as any).window = previousWindow })
const row = { role: 'user', uuid: 'goal-objective-id', turnId: 'goal-turn', text: 'Complete the exact authored objective', contentBlocks: [{ type: 'text', text: 'Complete the exact authored objective' }] }
const frame = (sessionId: string) => ({ type: 'user_message', sessionId, message: { uuid: row.uuid, message: { content: row.contentBlocks } } })
const rows = (sessionId: string) => {
  const state = store.getSessionStream(sessionId)
  return [...(state.history || []).filter(message => message.role === 'user'), ...state.liveUnits.filter(unit => unit.type === 'live-user').map(unit => unit.msg)]
}

test('repeated canonical goal objective frames create one visible user item', () => {
  const sessionId = 'goal-user-live-dedup'
  store.ingestChatEvent(frame(sessionId)); store.ingestChatEvent(frame(sessionId))
  expect(rows(sessionId).map(message => message.uuid)).toEqual([row.uuid])
  expect(rows(sessionId)[0].text).toBe(row.text)
})

test('fresh saved history rejects a late canonical goal user frame by its stable UUID', async () => {
  const sessionId = 'goal-user-restart-dedup'
  ;(window.klaus as any).session.history = async () => ({ messages: [row] })
  await store.loadSessionHistory(sessionId)
  store.ingestChatEvent(frame(sessionId)); store.ingestChatEvent(frame(sessionId))
  expect(rows(sessionId).map(message => message.uuid)).toEqual([row.uuid])
  expect(store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-user')).toEqual([])
})

test('a late history acknowledgement moves the canonical user UUID out of live without duplicating it', async () => {
  const sessionId = 'goal-user-late-history'
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: row.turnId })
  store.ingestChatEvent(frame(sessionId))
  ;(window.klaus as any).session.history = async () => ({ messages: [row] })
  await store.loadSessionHistory(sessionId)
  expect(rows(sessionId).map(message => message.uuid)).toEqual([row.uuid])
  store.ingestChatEvent(frame(sessionId))
  expect(rows(sessionId).map(message => message.uuid)).toEqual([row.uuid])
})

test('automatic metadata frames remain hidden rather than masquerading as explicit objectives', () => {
  const sessionId = 'goal-user-meta-hidden'
  const event = frame(sessionId)
  store.ingestChatEvent({ ...event, message: { ...event.message, isMeta: true } })
  store.ingestChatEvent({ ...event, message: { ...event.message, message: { ...event.message.message, is_meta: true } } })
  expect(rows(sessionId)).toEqual([])
})

 test('a delayed canonical objective replay cannot reset an active automatic goal continuation or its carried tasks', async () => {
  const sessionId = 'goal-user-replay-active-continuation'
  ;(window.klaus as any).session.history = async () => ({ messages: [row] })
  await store.loadSessionHistory(sessionId)
  store.ingestTaskGoalSnapshot(sessionId, { goalId: 'goal-generation', threadId: sessionId, objective: row.text, status: 'active', tokenBudget: null, tokensUsed: 5, timeUsedSeconds: 1, createdAtMs: 1, updatedAtMs: 1 })
  const tasks = [{ id: 'working', subject: 'Working task', status: 'in_progress' as const, blockedBy: [] }]
  setTaskItems(sessionId, tasks, { planId: 'existing-task-plan', planKind: 'tasks' })
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'automatic-goal-turn', goalContinuation: true, inputOrigin: 'automatic', goalId: 'goal-generation' })
  setTaskItems(sessionId, [], { planId: 'internal-empty-plan', planKind: 'plan' })
  const before = store.getSessionStream(sessionId)
  expect(before.goalContinuationId).toBe('goal-generation')
  store.ingestChatEvent(frame(sessionId))
  expect(store.getSessionStream(sessionId)).toMatchObject({ goalContinuationId: 'goal-generation', activeTurnId: 'automatic-goal-turn', running: true, activityVisible: true })
  expect(taskItems(sessionId)).toEqual(tasks)
  expect(taskPlanIdentity(sessionId)).toEqual({ planId: 'existing-task-plan', planKind: 'tasks' })
  expect(rows(sessionId).map(message => message.uuid)).toEqual([row.uuid])
})
