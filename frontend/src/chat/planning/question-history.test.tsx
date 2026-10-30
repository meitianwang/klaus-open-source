import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { planningQuestionHistory, planningQuestionHistoryOwns } from './question-history'
import type { PlanningQuestionRequest } from './questions-state'

;(globalThis as any).window ??= { addEventListener() {} }
const runtime = await import('./questions-runtime')
const stream = await import('../stream-store')
const questions = [{ id: 'format', header: 'Format', question: 'Choose?', options: [{ label: 'Web', description: 'Browser' }, { label: 'App', description: 'Desktop' }] }]
const answers = { format: { answers: ['Web'] } }
const block = { type: 'tool_use', name: 'request_user_input', id: 'original-tool', input: { questions } }
const request = (sessionId: string, extra: Partial<PlanningQuestionRequest> = {}): PlanningQuestionRequest => ({
  sessionId, turnId: 'original-turn', toolCallId: block.id, requestId: 'elicitation-identity', questions, status: 'pending', ...extra,
})

test('saved answers decode every supported text envelope and retain the original tool identity', () => {
  const value = { status: 'answered', answers }
  const text = JSON.stringify(value)
  for (const result of [text, { content: text }, { content: [{ type: 'text', text }] }, { text }, value]) {
    expect(planningQuestionHistory({ ...block, __result: result })).toEqual({ toolCallId: block.id, requestId: undefined, questions, ...value })
  }
})

test('missing or malformed saved results never fabricate expiration or accepted answers', () => {
  for (const result of [undefined, { content: 'tool error' }, { content: 'null' }, { answers: { unknown: { answers: ['Web'] } } }]) {
    const value = planningQuestionHistory({ ...block, __result: result })
    expect(value.status).toBe('pending')
    expect(value.answers).toBeUndefined()
    expect(value.requestId).toBeUndefined()
  }
  expect(planningQuestionHistory({ ...block, __result: { answers } }).status).toBe('answered')
  expect(planningQuestionHistory({ ...block, __result: { answers: { format: { answers: [] } } } }).status).toBe('skipped')
})

test('explicit terminal receipts remain authoritative even without answer entries', () => {
  for (const status of ['skipped', 'cancelled', 'expired']) {
    expect(planningQuestionHistory({ ...block, __result: { status } }).status).toBe(status)
  }
  const text = JSON.stringify({ status: 'answered', answers })
  expect(planningQuestionHistory({ ...block, __result: { status: 'ok', content: [{ type: 'text', text }] } }).status).toBe('answered')
})

test('history joins a genuine request by session, turn and tool rather than inventing a request ID', () => {
  const source = request('history-identity', { status: 'answered', answers })
  runtime.receivePlanningQuestion(source)
  expect(runtime.planningQuestionForTool(source.sessionId, block.id, source.turnId)?.requestId).toBe('elicitation-identity')
  const html = renderToStaticMarkup(<runtime.PlanningQuestionHistoryView sessionId={source.sessionId} turnId={source.turnId} block={block} />)
  expect(html).toContain('data-planning-question-status="answered"')
  expect(html).toContain('>Web</dd>')
  expect(html).not.toContain('Expired')
  expect(runtime.planningQuestionForTool('different-session', block.id, source.turnId)).toBeUndefined()
  expect(runtime.planningQuestionForTool(source.sessionId, block.id, 'different-turn')).toBeUndefined()
  runtime.receivePlanningQuestion({ ...source, turnId: 'second-turn', requestId: 'second-request' })
  expect(runtime.planningQuestionForTool(source.sessionId, block.id)).toBeUndefined()
})

test('read-only pending history stays unresolved without exposing answer controls', () => {
  const source = request('read-only-history')
  runtime.receivePlanningQuestion(source)
  const html = renderToStaticMarkup(<runtime.PlanningQuestionView request={source} readOnly />)
  expect(html).toContain('data-planning-question-status="pending"')
  expect(html).not.toContain('Expired')
  expect(html).not.toContain('<button')
})

test('saved history owns the original question position before a plan during handoff and late resolution', () => {
  const source = request('history-handoff')
  const history = [{ role: 'assistant', turnId: source.turnId, contentBlocks: [block, { type: 'text', text: 'Plan follows' }] }]
  const unit = { type: 'live-planning-question' as const, key: 'pending-question', turnId: source.turnId, request: source }
  expect(planningQuestionHistoryOwns(history, source)).toBe(true)
  expect(planningQuestionHistoryOwns(history, { ...source, turnId: 'different-turn' })).toBe(false)
  const merged = stream.mergePlanningHistoryUnits(history, [unit])
  expect(merged.history).toBe(history)
  expect(merged.liveUnits).toEqual([])
  stream.chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [source.sessionId]: { ...stream.getSessionStream(source.sessionId), history, liveUnits: [unit] } } }))
  stream.ingestPlanningQuestion({ ...source, status: 'answered', answers })
  expect(stream.getSessionStream(source.sessionId).liveUnits).toEqual([])
  expect(stream.getSessionStream(source.sessionId).history).toBe(history)
  stream.ingestPlanningQuestion({ ...source, turnId: 'different-turn' })
  expect(stream.getSessionStream(source.sessionId).liveUnits).toHaveLength(1)
})

test('an early history read preserves a pending question until its tool call is saved', async () => {
  const source = request('history-pending-handoff')
  const previous = (window as any).klaus
  let rows: any[] = []
  ;(window as any).klaus = { ...previous, session: { ...previous?.session, history: async () => rows } }
  try {
    stream.ingestPlanningQuestion(source)
    await stream.loadSessionHistory(source.sessionId)
    expect(stream.getSessionStream(source.sessionId).liveUnits.filter(unit => unit.type === 'live-planning-question')).toHaveLength(1)
    rows = [{ role: 'assistant', turnId: source.turnId, contentBlocks: [block] }]
    await stream.loadSessionHistory(source.sessionId)
    expect(stream.getSessionStream(source.sessionId).liveUnits.filter(unit => unit.type === 'live-planning-question')).toHaveLength(0)
  } finally { (window as any).klaus = previous }
})
