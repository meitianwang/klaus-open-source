import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LiveUnit, ToolCardState } from '../stream-store'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en' }
const { WorkflowRecordView, workflowRecordFromTool, workflowRecordPath, formatWorkflowDuration } = await import('./workflow-records')
const { foldUnits, groupLiveActivityUnits, historyWorkflowIdsForMessages, unitsFromMessages } = await import('./TranscriptView')

const success = (toolName: string, args: unknown, text = 'Plan approved; exiting plan mode.', id = 'call-1') => ({
  toolName, toolCallId: id, args, state: 'done', output: { text, isError: false },
})
const liveCard = (tool: ReturnType<typeof success>): ToolCardState => ({
  toolCallId: tool.toolCallId, toolName: tool.toolName, args: tool.args,
  content: tool.output.text, status: 'ok', argsDelta: '', progress: [], agent: false, bgTask: false,
})
const history = (tools: ReturnType<typeof success>[]) => [{
  uuid: 'assistant-1', role: 'assistant', turnId: 'turn-1',
  contentBlocks: tools.map(tool => ({
    type: 'tool_use', id: tool.toolCallId, name: tool.toolName,
    input: tool.args, __result: tool.output,
  })),
}]
const live = (cards: ToolCardState[]) => ({
  units: [{ type: 'live-tools', key: 'tools-1', order: cards.map(card => card.toolCallId), sealed: true }] as LiveUnit[],
  tools: Object.fromEntries(cards.map(card => [card.toolCallId, card])),
})
const read = (id: string) => success('read', { file_path: `${id}.ts` }, 'file', id)

describe('workflow result records', () => {
  test('only successful native workflow calls produce records', () => {
    const approved = success('exit_plan_mode', { planFilePath: '/plans/first.md' })
    expect(workflowRecordFromTool(approved)).toEqual({ kind: 'spec-execution', toolCallId: 'call-1', path: '/plans/first.md' })
    expect(workflowRecordFromTool({ ...approved, state: 'running' })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, state: 'awaiting-approval' })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, state: 'interrupted' })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, output: null })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, output: { text: 'Rejected', isError: true } })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, output: { text: '{"ok":false}', isError: false } })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, toolName: 'mcp__remote__exit_plan_mode' })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, toolName: 'functions.exit_plan_mode' })).toBeNull()
  })

  // The plan handshake moved from exit_plan_mode to create_plan. Both must resolve
  // to a spec-execution record: the new name for live calls, the old one for
  // transcripts recorded before the rename.
  test('create_plan produces the same Spec record as the pre-rename tool', () => {
    const approved = success('create_plan', { planFilePath: '/plans/created.md' })
    expect(workflowRecordFromTool(approved)).toEqual({ kind: 'spec-execution', toolCallId: 'call-1', path: '/plans/created.md' })
    expect(workflowRecordFromTool({ ...approved, toolName: 'CreatePlan' })).toEqual({ kind: 'spec-execution', toolCallId: 'call-1', path: '/plans/created.md' })
    // A rejected create_plan records nothing: the session stayed in plan mode.
    expect(workflowRecordFromTool({ ...approved, output: { text: 'Rejected', isError: true } })).toBeNull()
    expect(workflowRecordFromTool({ ...approved, toolName: 'mcp__remote__create_plan' })).toBeNull()
  })

  test('Spec paths use the exact call binding and never another plan result', () => {
    const first = workflowRecordFromTool(success('exit_plan_mode', { planFilePath: '/plans/first.md' }, '', 'first'))!
    const second = workflowRecordFromTool(success('exit_plan_mode', {}, '{"planFilePath":"/untrusted/last.md"}', 'second'))!
    if (first.kind !== 'spec-execution' || second.kind !== 'spec-execution') throw new Error('Expected Spec records')
    const calls: string[][] = []
    const resolve = (sessionId: string, callId: string) => { calls.push([sessionId, callId]); return `/plans/${callId}.md` }
    expect(workflowRecordPath(first, 'session-1', resolve)).toBe('/plans/first.md')
    expect(calls).toEqual([])
    expect(workflowRecordPath(second, 'session-1', resolve)).toBe('/plans/second.md')
    expect(calls).toEqual([['session-1', 'second']])
    expect(workflowRecordPath(second, '', resolve)).toBeNull()
    expect(workflowRecordPath(second, 'session-1')).toBeNull()
  })

  test('goal completion uses result duration and refuses incomplete or failed updates', () => {
    expect(workflowRecordFromTool(success('update_goal', { status: 'complete' }, 'Goal complete: used 44676 tokens over 1175 seconds.\n\nObjective: done')))
      .toEqual({ kind: 'goal-completed', toolCallId: 'call-1', durationSeconds: 1175 })
    expect(workflowRecordFromTool(success('update_goal', { status: 'complete' }, '{"ok":true,"goal":{"status":"complete","timeUsedSeconds":0}}'))?.kind).toBe('goal-completed')
    expect(workflowRecordFromTool(success('update_goal', { status: 'complete' }, '{"ok":true,"goal":{"status":"complete","timeUsedSeconds":0}}')))
      .toMatchObject({ durationSeconds: 0 })
    expect(workflowRecordFromTool(success('update_goal', { status: 'blocked' }, 'Goal [blocked]'))).toBeNull()
    expect(workflowRecordFromTool(success('update_goal', { status: 'complete' }, '{"goal":{"status":"active"}}'))).toBeNull()
    expect(workflowRecordFromTool(success('get_goal', {}, '{"goal":{"status":"complete"}}'))).toBeNull()
    expect(workflowRecordFromTool(success('update_goal', { status: 'complete' }, 'complete'))).toMatchObject({ durationSeconds: null })
    expect(formatWorkflowDuration(1175, 'en')).toBe('19 min 35 sec')
    expect(formatWorkflowDuration(0, 'en')).toBe('0 sec')
  })

  test('a settled Spec record renders the review card shell, not a second bubble', () => {
    const markup = renderToStaticMarkup(<WorkflowRecordView sessionId="session-1"
      record={{ kind: 'spec-execution', toolCallId: 'spec-1', path: '/plans/<plan>.md' }} />)
    expect(markup).toContain('spec-review-surface')
    expect(markup).toContain('permission-resolved')
    expect(markup).toContain('data-review-pending="false"')
    expect(markup).toContain('spec-review-details')
    // The old duplicate bubble row is gone.
    expect(markup).not.toContain('spec-execution-bubble')
    expect(markup).not.toContain('Execute')
    const missingPath = renderToStaticMarkup(<WorkflowRecordView sessionId="session-1"
      record={{ kind: 'spec-execution', toolCallId: 'spec-2', path: null }} />)
    expect(missingPath).toContain('spec-review-surface')
    expect(missingPath).not.toContain('spec-review-details')
    const goal = renderToStaticMarkup(<WorkflowRecordView sessionId="session-1"
      record={{ kind: 'goal-completed', toolCallId: 'goal-1', durationSeconds: null }} />)
    expect(goal).toBe('')
    expect(goal).not.toContain('0 sec')
  })
})

describe('workflow visibility in transcript folding', () => {
  const spec = success('exit_plan_mode', { planFilePath: '/plans/plan.md' }, 'Plan approved', 'spec-1')
  const goal = success('update_goal', { status: 'complete' }, 'Goal complete: used 9 tokens over 61 seconds.', 'goal-1')
  const tools = [read('read-1'), read('read-2'), spec, read('read-3'), goal, read('read-4')]

  test('completed history preserves records in their original order outside activity folds', () => {
    const nodes = foldUnits(unitsFromMessages(history(tools)), null, { 'turn-1': 'completed' }, {})
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'workflow-record')
      .map(node => node.kind === 'unit' && node.unit.workflowRecord?.toolCallId)).toEqual(['spec-1'])
    const recordsInFolds = nodes.flatMap(node => node.kind === 'activity-fold' ? node.items : [])
      .filter(item => item.kind === 'unit' && item.unit.type === 'workflow-record')
    expect(recordsInFolds).toEqual([])
    const readTools = (rows: typeof nodes): unknown[] => rows.flatMap(node => node.kind === 'unit'
      ? node.unit.segment?.tools || [] : 'items' in node ? readTools(node.items as typeof nodes) : [])
    const laterTools = readTools(nodes) as Array<{ toolCallId: string }>
    expect(laterTools.some(tool => tool.toolCallId === 'read-4')).toBe(true)
  })

  test('live records match history and split contiguous activity without count thresholds', () => {
    const many = [...Array.from({ length: 50 }, (_, i) => read(`before-${i}`)), spec,
      ...Array.from({ length: 50 }, (_, i) => read(`after-${i}`)), goal]
    const liveState = live(many.map(liveCard))
    const projected = groupLiveActivityUnits(liveState.units, liveState.tools, true, false)
    expect(projected[0]).toMatchObject({ kind: 'turn', running: true, preventAutoCollapse: true })
    const nodes = projected.flatMap(node => node.kind === 'turn' ? node.items : [node])
    expect(nodes.map(node => node.kind)).toEqual(['activity', 'workflow-record', 'activity'])
    expect(nodes.filter(node => node.kind === 'workflow-record').map(node => node.kind === 'workflow-record' && node.record.toolCallId))
      .toEqual(['spec-1'])
    expect(nodes.filter(node => node.kind === 'activity').map(node => node.key))
      .toEqual(['before-0', 'after-0'])
    const historyNodes = foldUnits(unitsFromMessages(history(many)), { turnId: 'turn-1' }, {}, {}).flatMap(node => node.kind === 'turn-fold' ? node.items : [node])
    expect(historyNodes.map(node => node.kind === 'unit' ? node.unit.type : node.kind))
      .toEqual(['activity-fold', 'workflow-record', 'activity-fold'])
  })

  test('replayed or live duplicate tool ids produce one record across handoff', () => {
    const nodes = foldUnits(unitsFromMessages(history([spec, spec, goal, goal])), null, {}, {})
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'workflow-record')).toHaveLength(1)
    const liveState = live([spec, spec, goal, goal].map(liveCard))
    const liveNodes = groupLiveActivityUnits(liveState.units, liveState.tools, false, false)
    expect(liveNodes.filter(node => node.kind === 'workflow-record')).toHaveLength(1)
    const handedOff = groupLiveActivityUnits(liveState.units, liveState.tools, false, false, undefined, new Set(['spec-1']))
    expect(handedOff.filter(node => node.kind === 'workflow-record').map(node => node.kind === 'workflow-record' && node.record.toolCallId))
      .toEqual([])
  })

  test('workflow records stay visible when the final answer collapses the process', () => {
    const messages = history(tools)
    messages[0].contentBlocks.push({ type: 'text', text: 'Done', messageId: 'final', phase: 'final_answer' } as any)
    const units = unitsFromMessages(messages)
    const collapsed = foldUnits(units, null, {}, {})
    const closedFold = collapsed.find(node => node.kind === 'turn-fold')
    const opened = foldUnits(units, null, {}, { 'turn:turn-1': false })
    expect(opened.filter(node => node.kind === 'unit' && node.unit.type === 'workflow-record'))
      .toHaveLength(0)
    const fold = opened.find(node => node.kind === 'turn-fold')
    expect(fold?.kind === 'turn-fold' && fold.items.filter(node => node.kind === 'unit' && node.unit.type === 'workflow-record')
      .map(node => node.kind === 'unit' && node.unit.workflowRecord?.toolCallId)).toEqual(['spec-1'])
    expect(closedFold?.kind === 'turn-fold' && closedFold.items).toEqual(fold?.kind === 'turn-fold' && fold.items)
  })
})

 describe('canonical goal completion identity', () => {
  const completed = { goalId: 'durable-goal', threadId: 'thread', objective: 'Saved exact objective', status: 'complete', tokenBudget: 1000, tokensUsed: 946, timeUsedSeconds: 61, createdAtMs: 1, updatedAtMs: 2 }
  const call = success('update_goal', { status: 'complete' }, JSON.stringify({ ok: true, goal: completed }), 'complete-tool')
  const saved = () => [{ ...history([call])[0], contentBlocks: [...history([call])[0].contentBlocks, { type: 'goal_completion', goal: completed }] }]
  const flatten = (nodes: any[]): any[] => nodes.flatMap(node => [node, ...(node.items ? flatten(node.items) : [])])
  test('durable completion preserves its exact snapshot and suppresses its successful tool outcome', () => {
    const messages = saved(), units = unitsFromMessages(messages)
    const nodes = flatten(foldUnits(units, null, {}, {}))
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'workflow-record')).toHaveLength(0)
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'goal-completion')).toEqual([])
    expect(units.find(unit => unit.type === 'goal-completion')?.segment?.goal).toEqual(completed)
    expect(workflowRecordFromTool(call)).toMatchObject({ goalId: completed.goalId, durationSeconds: 61 })
  })
  test('live completion owns one outcome even if the successful tool and repeated snapshot arrive together', () => {
    const current = live([liveCard(call)])
    const completion = { type: 'live-goal-completion', key: 'completion', goal: completed } as LiveUnit
    const nodes = flatten(groupLiveActivityUnits([...current.units, completion, completion], current.tools, false, false))
    expect(nodes.filter(node => node.kind === 'workflow-record')).toHaveLength(0)
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'live-goal-completion')).toHaveLength(0)
  })
  test('fresh replay and a late live echo render only the durable completion', () => {
    const messages = saved(), ids = historyWorkflowIdsForMessages(messages), current = live([liveCard(call)])
    const completion = { type: 'live-goal-completion', key: 'completion', goal: completed } as LiveUnit
    expect(ids.has(`goal:${completed.goalId}`)).toBe(true)
    const nodes = flatten(groupLiveActivityUnits([...current.units, completion], current.tools, false, false, false, ids))
    expect(nodes.filter(node => node.kind === 'workflow-record' || node.kind === 'unit' && node.unit.type === 'live-goal-completion')).toEqual([])
    expect(unitsFromMessages([...messages, ...messages]).filter(unit => unit.type === 'goal-completion')).toHaveLength(1)
  })
})
