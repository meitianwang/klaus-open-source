import { expect, test } from 'bun:test'
import taskVectors from '../../../../contracts/vectors/task-list-live-vectors.json'
import type { ProgressPlan } from './types'
;(globalThis as any).window ??= { addEventListener() {} }
const { ingestChatEvent, ingestPlanningSnapshot, getSessionStream } = await import('../stream-store')
const plan = { id: 'plan-stream', threadId: 'thread-stream', turnId: 'turn-stream', revision: 1, content: '', status: 'writing' as const }
test('ordinary assistant text and streamed proposed plan retain ordered distinct identities', () => {
  const sessionId = 'plan-stream-order'
  ingestChatEvent({ type: 'text_delta', sessionId, text: 'Investigation summary' })
  ingestChatEvent({ type: 'proposed_plan', phase: 'started', sessionId, plan })
  ingestChatEvent({ type: 'proposed_plan_delta', sessionId, planId: plan.id, revision: 1, delta: '# Complete plan\n' })
  ingestChatEvent({ type: 'proposed_plan_delta', sessionId, planId: plan.id, revision: 1, delta: '\nImplementation details' })
  const units = getSessionStream(sessionId).liveUnits
  expect(units.map(unit => unit.type)).toEqual(['live-text', 'live-proposed-plan'])
  expect(units[1].type === 'live-proposed-plan' && units[1].plan.content).toBe('# Complete plan\n\nImplementation details')
  ingestPlanningSnapshot(sessionId, { mode: 'plan', revision: 2, plans: [{ ...plan, content: '# Complete plan\n\nImplementation details', status: 'proposed' }] })
  expect(getSessionStream(sessionId).liveUnits).toHaveLength(2)
})
test('progress updates keep the existing conversation without adding a checklist', () => {
  const sessionId = 'progress-stream-order'
  ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'turn-progress' })
  ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-progress' })
  ingestChatEvent({ type: 'text_delta', sessionId, text: 'I found the affected code.' })
  const units = [...getSessionStream(sessionId).liveUnits]
  for (const progress of taskVectors.progressPresentation.snapshots) {
    ingestChatEvent({ type: 'progress_plan', sessionId, progress })
    expect(getSessionStream(sessionId).liveUnits).toEqual(units)
  }
})
test('planning recovery restores proposals without adding a progress checklist in active or idle sessions', () => {
  for (const running of [true, false]) {
    const sessionId = `progress-snapshot-${running}`
    if (running) ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: plan.turnId })
    expect(getSessionStream(sessionId).running).toBe(running)
    ingestChatEvent({ type: 'text_delta', sessionId, text: 'Existing conversation.' })
    for (const [revision, progress] of taskVectors.progressPresentation.snapshots.entries()) {
      ingestPlanningSnapshot(sessionId, { mode: 'plan', revision, plans: [{ ...plan, status: 'proposed' }], progress: progress as ProgressPlan })
      expect(getSessionStream(sessionId).liveUnits.map(unit => unit.type)).toEqual(['live-text', 'live-proposed-plan'])
    }
  }
})
