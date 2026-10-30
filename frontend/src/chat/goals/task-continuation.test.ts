import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parse } from 'node-html-parser'
import { forgetTaskItems, setTaskItems, taskItems, taskPlanIdentity, taskProgress, type TaskItem } from '../task-state'
import type { GoalSnapshot } from './types'
;(globalThis as any).window ??= { addEventListener() {} }
const { chatStreamStore, getSessionStream, ingestChatEvent, ingestTaskGoalSnapshot } = await import('../stream-store')
const { LiveTail } = await import('../transcript/TranscriptView')

const goal: GoalSnapshot = { goalId: 'goal-a', threadId: 'thread-a', objective: 'Finish the feature', status: 'active', tokenBudget: null, tokensUsed: 100, timeUsedSeconds: 10, createdAtMs: 1, updatedAtMs: 1 }
const rows: TaskItem[] = [
  { id: 'read', subject: 'Read the source', status: 'completed', blockedBy: [] },
  { id: 'write', subject: 'Write the feature', activeForm: 'Writing the feature', status: 'in_progress', blockedBy: [] },
  { id: 'test', subject: 'Run the checks', status: 'pending', blockedBy: ['write'] },
]
let nextSession = 0
function fixture(tasks = rows) {
  const sessionId = `goal-task-continuation-${++nextSession}`
  ingestTaskGoalSnapshot(sessionId, goal)
  setTaskItems(sessionId, tasks, { planId: 'current-plan', planKind: 'tasks' })
  const start = (turnId = 'automatic-1', goalId = goal.goalId, inputOrigin: 'user' | 'automatic' = 'automatic') => ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId, goalContinuation: inputOrigin === 'automatic', inputOrigin, goalId })
  const empty = () => setTaskItems(sessionId, [], { planId: 'empty-turn-plan', planKind: 'plan' })
  return { sessionId, start, empty }
}

function renderContinuation(sessionId: string) {
  const initial = chatStreamStore.getInitialState(), sessions = initial.sessions
  try {
    initial.sessions = { ...sessions, [sessionId]: getSessionStream(sessionId) }
    return parse(renderToStaticMarkup(createElement(LiveTail, { sessionId, unitProps: {
      isThinkingExpanded: () => false, onToggleThinking: () => {}, archived: false,
      running: getSessionStream(sessionId).running, composerAuthored: false, readOnly: true, editTarget: null,
    } })))
  } finally { initial.sessions = sessions }
}

test('same-goal empty automatic turns retain the measured in-progress display and open real stream loading', () => {
  const { sessionId, start, empty } = fixture()
  start()
  ingestChatEvent({ type: 'user_message', sessionId, message: { isMeta: true, uuid: 'internal-input', message: { content: 'Continue pursuing the goal' } } })
  empty()
  expect(taskProgress(taskItems(sessionId))).toEqual({ completed: 1, total: 3, entries: [
    { step: 'Read the source', status: 'completed' }, { step: 'Writing the feature', status: 'in_progress' }, { step: 'Run the checks', status: 'pending' },
  ] })
  expect(taskPlanIdentity(sessionId)).toEqual({ planId: 'current-plan', planKind: 'tasks' })
  expect(getSessionStream(sessionId)).toMatchObject({ running: true, activityVisible: true, streamMode: 'requesting', activeTurnId: 'automatic-1', goalContinuationId: goal.goalId })
  expect(getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(0)
  ingestChatEvent({ type: 'done', sessionId, turnId: 'automatic-1' })
  expect(taskItems(sessionId)).toEqual(rows)
  ingestTaskGoalSnapshot(sessionId, { ...goal, tokensUsed: 200, timeUsedSeconds: 12, updatedAtMs: 2 })
  start('automatic-2')
  empty()
  expect(taskItems(sessionId)).toEqual(rows)
  expect(getSessionStream(sessionId).activeTurnId).toBe('automatic-2')
})

test('a real user item resets carried display even when its text resembles an internal continuation', () => {
  const { sessionId, start, empty } = fixture()
  start(); empty()
  expect(getSessionStream(sessionId).goalContinuationId).toBe(goal.goalId)
  ingestChatEvent({ type: 'user_message', sessionId, message: { uuid: 'human-input', message: { content: 'Continue pursuing the goal' } } })
  expect(taskItems(sessionId)).toEqual([])
  expect(getSessionStream(sessionId).goalContinuationId).toBeNull()
  expect(getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(1)
  empty()
  expect(taskProgress(taskItems(sessionId))).toBeNull()
})

test('a new generation or changed objective cannot inherit a carried task display', () => {
  for (const replacement of [{ ...goal, goalId: 'goal-b' }, { ...goal, objective: 'A new objective' }]) {
    const { sessionId, start, empty } = fixture()
    start(); empty()
    ingestTaskGoalSnapshot(sessionId, replacement)
    expect(taskItems(sessionId)).toEqual([])
    empty()
    expect(taskProgress(taskItems(sessionId))).toBeNull()
  }
})

for (const status of ['paused', 'blocked', 'usage_limited', 'budget_limited', 'complete', null] as const) test(`the ${status ?? 'cleared'} goal state drops only transient carried tasks`, () => {
  const carried = fixture()
  carried.start(); carried.empty()
  expect(getSessionStream(carried.sessionId).goalContinuationId).toBe(goal.goalId)
  ingestTaskGoalSnapshot(carried.sessionId, status ? { ...goal, status } : null)
  expect(taskItems(carried.sessionId)).toEqual([])
  expect(getSessionStream(carried.sessionId).goalContinuationId).toBeNull()
  const durable = fixture()
  ingestTaskGoalSnapshot(durable.sessionId, status ? { ...goal, status } : null)
  expect(taskItems(durable.sessionId)).toEqual(rows)
  durable.start(); durable.empty()
  expect(taskItems(durable.sessionId)).toEqual([])
  expect(getSessionStream(durable.sessionId).goalContinuationId).toBeNull()
})

for (const status of ['pending', 'completed'] as const) test(`an empty continuation does not retain a ${status}-only task list`, () => {
  const { sessionId, start, empty } = fixture([{ ...rows[1], status }])
  start(); empty()
  expect(taskItems(sessionId)).toEqual([])
})

test('ordinary or mismatched-goal turns reset carry while another session remains intact', () => {
  const ordinary = fixture(), mismatched = fixture(), unrelated = fixture()
  for (const current of [ordinary, mismatched, unrelated]) { current.start(); current.empty() }
  ingestChatEvent({ type: 'done', sessionId: ordinary.sessionId, turnId: 'automatic-1' })
  ordinary.start('user-turn', goal.goalId, 'user')
  ingestChatEvent({ type: 'done', sessionId: mismatched.sessionId, turnId: 'automatic-1' })
  mismatched.start('wrong-generation', 'other-goal')
  expect(taskItems(ordinary.sessionId)).toEqual([])
  expect(taskItems(mismatched.sessionId)).toEqual([])
  expect(taskItems(unrelated.sessionId)).toEqual(rows)
})

for (const type of ['interrupted', 'api_error'] as const) test(`${type} ends transient carry before a later goal snapshot arrives`, () => {
  const { sessionId, start, empty } = fixture()
  start(); empty()
  ingestChatEvent({ type, sessionId, turnId: 'automatic-1', terminal: true, error: 'The turn stopped' })
  expect(taskItems(sessionId)).toEqual([])
  expect(getSessionStream(sessionId).running).toBe(false)
})

test('a nonempty authoritative task list replaces carried rows and order without merging', () => {
  const { sessionId, start, empty } = fixture()
  start(); empty()
  const next: TaskItem[] = [{ id: 'new-step', subject: 'Final verification', status: 'in_progress', blockedBy: [] }]
  setTaskItems(sessionId, next, { planId: 'next-plan', planKind: 'plan' })
  expect(taskItems(sessionId)).toEqual(next)
  expect(taskPlanIdentity(sessionId)).toEqual({ planId: 'next-plan', planKind: 'plan' })
  empty()
  expect(taskItems(sessionId)).toEqual(next)
})

test('only the exact captured automatic goal metadata enables task carry', () => {
  for (const metadata of [{}, { goalContinuation: true }, { goalContinuation: false, inputOrigin: 'automatic', goalId: goal.goalId },
    { goalContinuation: true, inputOrigin: 'user', goalId: goal.goalId }, { goalContinuation: 'true', inputOrigin: 'automatic', goalId: goal.goalId }]) {
    const { sessionId, empty } = fixture()
    ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'unclassified-turn', ...metadata })
    empty()
    expect(taskItems(sessionId)).toEqual([])
    expect(getSessionStream(sessionId).goalContinuationId).toBeNull()
  }
})

test('automatic preparation displays localized loading until actual output or settlement', () => {
  const previousLocale = (window as any).currentLang
  try {
    for (const [locale, label] of [['en', 'Continuing toward the goal…'], ['zh', '正在继续推进目标…']]) {
      const { sessionId, start } = fixture()
      ;(window as any).currentLang = locale
      start()
      const prepared = renderContinuation(sessionId)
      const statuses = prepared.querySelectorAll('[role="status"]')
      expect(statuses).toHaveLength(1)
      // The sweep duplicates the label visually but contributes no accessible text.
      statuses[0].querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove())
      expect(statuses[0].textContent).toBe(label)
      expect(prepared.querySelectorAll('[data-work-divider]')).toHaveLength(1)
      expect(prepared.querySelectorAll('[data-work-label="working"]')).toHaveLength(1)
      expect(getSessionStream(sessionId).activeTurnId).toBe('automatic-1')
      ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'responding', turnId: 'automatic-1' })
      expect(getSessionStream(sessionId).goalContinuationId).toBeNull()
      expect(renderContinuation(sessionId).textContent).not.toContain(label)
      ingestChatEvent({ type: 'text_delta', sessionId, turnId: 'automatic-1', phase: 'final_answer', text: 'The next result' })
      const output = renderContinuation(sessionId)
      expect(output.querySelectorAll('[role="status"]')).toHaveLength(0)
      expect(output.textContent).toContain('The next result')
      ingestChatEvent({ type: 'done', sessionId, turnId: 'automatic-1' })
      expect(getSessionStream(sessionId).running).toBe(false)
    }
  } finally { (window as any).currentLang = previousLocale }
})

test('settlement before the first output removes both the goal wait and active work header', () => {
  const { sessionId, start } = fixture()
  start()
  ingestChatEvent({ type: 'done', sessionId, turnId: 'automatic-1' })
  const settled = renderContinuation(sessionId)
  expect(settled.querySelectorAll('[role="status"]')).toHaveLength(0)
  expect(settled.querySelectorAll('[data-work-divider]')).toHaveLength(0)
  expect(getSessionStream(sessionId).goalContinuationId).toBeNull()
})

test('a late foreign lifecycle cannot reset the current automatic task display', () => {
  const { sessionId, start, empty } = fixture()
  start(); empty()
  ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'obsolete-user-turn', goalContinuation: false, inputOrigin: 'user' })
  ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'obsolete-user-turn' })
  expect(taskItems(sessionId)).toEqual(rows)
  expect(getSessionStream(sessionId)).toMatchObject({ running: true, activeTurnId: 'automatic-1', goalContinuationId: goal.goalId })
})

test('a restored authoritative task snapshot replaces transient carry without replaying old tool history', () => {
  const { sessionId, start, empty } = fixture()
  start(); empty()
  expect(taskItems(sessionId)).toEqual(rows)
  forgetTaskItems(sessionId)
  expect(taskItems(sessionId)).toEqual([])
  ingestTaskGoalSnapshot(sessionId, { ...goal, tokensUsed: 300, updatedAtMs: 3 })
  const restored: TaskItem[] = [{ id: 'persisted-task', subject: 'Current saved work', status: 'in_progress', blockedBy: [] }]
  setTaskItems(sessionId, restored, { planId: 'persisted-plan', planKind: 'tasks' })
  expect(taskItems(sessionId)).toEqual(restored)
  expect(taskPlanIdentity(sessionId)).toEqual({ planId: 'persisted-plan', planKind: 'tasks' })
  start()
  empty()
  expect(taskItems(sessionId)).toEqual(restored)
})

test('text, reasoning, tool calls and measured progress end the preparation label without erasing task carry', () => {
  for (const output of [{ type: 'text_delta', text: 'Working on the implementation' }, { type: 'thinking_delta', thinking: 'Review the source' },
    { type: 'tool_start', toolName: 'TaskUpdate', toolCallId: 'update-task', args: { taskId: 'write', status: 'in_progress' } },
    { type: 'tool_start', toolName: 'read_file', toolCallId: 'read-source', args: { path: '/project/source.ts' } },
    { type: 'progress_plan', progress: { plan: [{ step: 'Write the feature', status: 'in_progress' }] } }]) {
    const { sessionId, start, empty } = fixture()
    start(); empty()
    ingestChatEvent({ sessionId, ...output })
    expect(getSessionStream(sessionId).goalContinuationId).toBeNull()
    expect(taskItems(sessionId)).toEqual(rows)
  }
})
