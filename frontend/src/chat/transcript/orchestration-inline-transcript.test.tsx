import { expect, test } from 'bun:test'
import { semanticActivity, semanticActivityLabel } from './activity-semantic'

test('execution stage labels show the description in both languages', () => {
  const activity = semanticActivity('orchestrate_execution', { description: '  Inspect files  ' })!
  expect(activity.category).toBe('orchestration')
  const states = ['running', 'done', 'error', 'awaiting-approval']
  expect(states.map(state => semanticActivityLabel(activity, state, 'en'))).toEqual([
    'Running stage', 'Completed stage', 'Failed to run stage', 'Awaiting approval to run stage',
  ].map(label => `${label} · Inspect files`))
  expect(states.map(state => semanticActivityLabel(activity, state, 'zh'))).toEqual([
    '正在执行阶段', '已执行阶段', '执行阶段失败', '等待批准执行阶段',
  ].map(label => `${label} · Inspect files`))
})

;(globalThis as any).window ||= { addEventListener: () => {} }
const store = await import('../stream-store')
const transcript = await import('./TranscriptView')

test('inline stage approval resolves against the scoped Bash card', () => {
  const sessionId = 'inline-stage-test'
  for (const [toolCallId, toolName] of [['stage-1', 'orchestrate_execution'], ['orch:stage-1:read', 'Read'], ['orch:stage-1:cmd-1', 'Bash']]) {
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId, toolName, args: {} })
  }
  store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'orch:stage-1:m1', phase: 'commentary', text: 'Working' })
  const status = () => store.getSessionStream(sessionId).tools['orch:stage-1:cmd-1']?.status
  expect(status()).toBe('running')
  store.markToolAwaitingApproval(sessionId, 'cmd-1')
  store.ingestLiveApproval('permission', { requestId: 'approval', sessionId, toolName: 'Bash', toolCallId: 'cmd-1' })
  expect(status()).toBe('awaiting-approval')
  store.resolveLiveApproval(sessionId, 'approval', { decision: 'allow' })
  expect(status()).toBe('running')
})

test('saved stage activity folds under the completed parent turn', () => {
  const contentBlocks = [
    { type: 'tool_use', id: 'stage', name: 'orchestrate_execution', input: {} },
    { type: 'text', text: 'Working', phase: 'commentary' },
    { type: 'tool_use', id: 'orch:stage:read', name: 'Read', input: {} },
  ]
  expect(transcript.segmentsFromBlocks(contentBlocks, undefined)).not.toHaveLength(0)
  const nodes = transcript.foldUnits(transcript.unitsFromMessages([
    { role: 'assistant', uuid: 'stage', turnId: 'parent', contentBlocks },
    { role: 'assistant', uuid: 'final', turnId: 'parent', text: 'Done', phase: 'final_answer' },
  ]), null, { parent: 'completed' }, {})
  const fold = nodes.find(node => node.kind === 'turn-fold')
  expect(fold).toMatchObject({ turnId: 'parent', open: false })
  expect(JSON.stringify(fold)).toContain('orch:stage:read')
  expect(JSON.stringify(fold)).toContain('Working')
})
