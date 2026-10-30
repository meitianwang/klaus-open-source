import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
;(globalThis as any).window ??= { addEventListener() {} }
const { segmentsFromBlocks, unitsFromMessages, StaticTranscriptView } = await import('../transcript/TranscriptView')
const { ingestChatEvent, ingestPlanningSnapshot, getSessionStream, chatStreamStore, mergePlanningHistoryUnits } = await import('../stream-store')
const { configurePlanningWorkflow } = await import('./runtime')
const goal = { goalId: 'complete-generation', threadId: 'complete-thread', objective: 'Finish the complete objective', status: 'complete', tokensUsed: 12345, tokenBudget: 20000, timeUsedSeconds: 123, createdAtMs: 1, updatedAtMs: 2 }
test('collapsed completed activity retains its plan and puts completion on the answer footer', () => {
  const previousDocument = (globalThis as any).document
  ;(globalThis as any).document = { createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) }
  try {
    const unexpected = async () => { throw Error('Rendering saved artifacts must not issue a workflow request') }
    configurePlanningWorkflow({ api: { get: unexpected, readDocument: unexpected, saveDocument: unexpected, accept: unexpected, feedback: unexpected, cancel: unexpected }, open() {}, download: unexpected })
    const plan = { id: 'persistent-plan', threadId: 'thread', turnId: 'turn', revision: 3, content: '# Reviewed deliverable', status: 'accepted' }
    const markup = renderToStaticMarkup(<StaticTranscriptView container={{} as HTMLElement} running={false} sessionId="thread" msgs={[
      { role: 'user', uuid: 'prompt', turnId: 'turn', text: 'Prepare the deliverable' },
      { role: 'assistant', uuid: 'process', turnId: 'turn', contentBlocks: [{ type: 'text', text: 'Private process detail', phase: 'commentary' }] },
      { role: 'assistant', uuid: 'artifact', turnId: 'turn', contentBlocks: [{ type: 'proposed_plan', plan }, { type: 'goal_completion', goal }] },
      { role: 'assistant', uuid: 'final', turnId: 'turn', isFinalReply: true, text: 'Delivery finished', contentBlocks: [{ type: 'text', text: 'Delivery finished', phase: 'final_answer' }] },
    ]} />)
    expect(markup).not.toContain('Private process detail')
    expect(markup).toContain('proposed-plan-card')
    expect(markup).toContain('Reviewed deliverable')
    expect(markup).not.toContain('Finish the complete objective')
    expect(markup).toContain('data-goal-completion')
    expect(markup.indexOf('Reviewed deliverable')).toBeLessThan(markup.indexOf('Delivery finished'))
    expect(markup.indexOf('Delivery finished')).toBeLessThan(markup.indexOf('data-goal-completion'))
  } finally {
    if (previousDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = previousDocument
  }
})
test('durable proposed plans and completion snapshots preserve their ordered history positions', () => {
  const plan = { id: 'history-plan', threadId: 'history-thread', turnId: 'history-turn', revision: 3, content: '# Full reviewed plan', status: 'accepted' }
  const segments = segmentsFromBlocks([{ type: 'text', text: 'Investigation' }, { type: 'proposed_plan', plan }, { type: 'text', text: 'Work complete' }, { type: 'goal_completion', goal }], undefined)
  expect(segments.map(segment => segment.kind)).toEqual(['text', 'proposed-plan', 'text', 'goal-completion'])
  expect(segments[1].plan).toEqual(plan)
  expect(segments[3].goal).toEqual(goal)
  const units = unitsFromMessages([{ role: 'assistant', turnId: 'history-turn', contentBlocks: [{ type: 'goal_completion', goal }] }])
  expect(units[0].type).toBe('goal-completion')
  expect(units[0].segment?.goal?.tokensUsed).toBe(12345)
})
test('live completion retains final generation/accounting after the live goal is cleared', () => {
  ingestChatEvent({ type: 'goal_completion', sessionId: 'completion-stream', goal })
  ingestChatEvent({ type: 'goal_completion', sessionId: 'completion-stream', goal })
  const units = getSessionStream('completion-stream').liveUnits
  expect(units.filter(unit => unit.type === 'live-goal-completion')).toHaveLength(1)
  const completion = units.find(unit => unit.type === 'live-goal-completion')
  expect(completion?.type === 'live-goal-completion' && completion.goal).toEqual(goal)
})
test('history owns a plan position while a newer live revision updates it once', () => {
  const plan = { id: 'plan', threadId: 'thread', turnId: 'turn', revision: 2, content: 'Saved', status: 'proposed' as const }
  const history = [{ uuid: 'source', role: 'assistant', turnId: 'turn', text: 'BeforeSavedAfter', contentBlocks: [{ type: 'text', text: 'Before' }, { type: 'proposed_plan', plan }, { type: 'text', text: 'After' }] }]
  const successor = { ...plan, revision: 3, content: 'Edited', status: 'accepted' as const }
  const other = { ...plan, id: 'new-plan', turnId: 'new-turn' }
  const result = mergePlanningHistoryUnits(history, [{ type: 'live-proposed-plan', key: 'proposed-plan:plan', plan: successor }, { type: 'live-proposed-plan', key: 'proposed-plan:new-plan', plan: other }])
  expect(result.history?.[0].contentBlocks.map((block: any) => block.type)).toEqual(['text', 'proposed_plan', 'text'])
  expect(result.history?.[0].contentBlocks[1].plan).toEqual(successor)
  expect(result.history?.[0].text).toBe('BeforeEditedAfter')
  expect(result.liveUnits.map(unit => unit.key)).toEqual(['proposed-plan:new-plan'])
  expect(history[0].contentBlocks[1].plan).toEqual(plan)
  const stale = mergePlanningHistoryUnits(result.history, [{ type: 'live-proposed-plan', key: 'proposed-plan:plan', plan }])
  expect(stale.history?.[0].contentBlocks[1].plan).toEqual(successor)
  expect(stale.liveUnits).toHaveLength(0)
})

test('late item events update the history-owned artifact without recreating a live card', () => {
  const sessionId = 'late-plan-item-history-owner'
  const plan = { id: 'late-item', threadId: 'thread', turnId: 'turn', revision: 2, content: 'Saved', status: 'proposed' as const }
  const history = [{ role: 'assistant', turnId: 'turn', text: 'BeforeSavedAfter', contentBlocks: [{ type: 'text', text: 'Before' }, { type: 'proposed_plan', plan }, { type: 'text', text: 'After' }] }]
  chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...getSessionStream(sessionId), history } } }))
  const successor = { ...plan, revision: 3, content: 'Accepted', status: 'accepted' as const }
  ingestChatEvent({ type: 'proposed_plan', sessionId, plan: successor })
  ingestChatEvent({ type: 'proposed_plan', sessionId, plan })
  const state = getSessionStream(sessionId)
  expect(state.liveUnits).toHaveLength(0)
  expect(state.history?.[0].contentBlocks[1].plan).toEqual(successor)
  expect(state.history?.[0].text).toBe('BeforeAcceptedAfter')
})

test('terminal snapshots update persisted-only artifacts without introducing live cards', () => {
  for (const status of ['accepted', 'superseded', 'interrupted'] as const) {
    const sessionId = `persisted-plan-${status}`
    const plan = { id: status, threadId: 'thread', turnId: 'turn', revision: 2, content: 'Saved', status: 'proposed' as const }
    const history = [{ role: 'assistant', turnId: 'turn', text: 'BeforeSavedAfter', contentBlocks: [{ type: 'text', text: 'Before' }, { type: 'proposed_plan', plan }, { type: 'text', text: 'After' }] }]
    chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [sessionId]: { ...getSessionStream(sessionId), history } } }))
    const successor = { ...plan, revision: 3, content: 'Final', status }
    ingestPlanningSnapshot(sessionId, { mode: 'default', revision: 3, plans: [successor] })
    const state = getSessionStream(sessionId)
    expect(state.liveUnits).toHaveLength(0)
    expect(state.history?.[0].contentBlocks.map((block: any) => block.type)).toEqual(['text', 'proposed_plan', 'text'])
    expect(state.history?.[0].contentBlocks[1].plan).toEqual(successor)
    expect(state.history?.[0].text).toBe('BeforeFinalAfter')
  }
})
