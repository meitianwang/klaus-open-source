import { afterEach, describe, expect, test } from 'bun:test'
import { liveApprovalsOf } from './sidebar/attention'
import { resolvedQuestionPresentation } from './transcript/question-state'

const badgeCounts: number[] = []

;(globalThis as any).window = {
  addEventListener: () => {},
  klaus: {
    app: { setApprovalBadge: async (count: number) => { badgeCounts.push(count) } },
    permission: { respond: () => {}, pending: async () => [] },
    elicit: { pending: async () => [] },
    memorySnapshot: { respond: () => {} },
    session: { history: async () => [] },
  },
}

const store = await import('./stream-store')
const { initApprovals, showPermissionRequest, showElicitRequest, untrackApprovalRequest, untrackApprovalRequestsOfSession } = await import('./approvals')
import type { ApprovalsDeps } from './approvals'

const CURRENT = 'session-current'

function makeDeps(): ApprovalsDeps {
  return {
    currentSessionId: () => CURRENT,
    isCronRunSession: () => false,
    markCronRunUnread: () => {},
    renderSessionList: () => {},
    pendingPermissionsBySession: new Map(),
    pendingElicitsBySession: new Map(),
  }
}

initApprovals(makeDeps())

afterEach(() => {
  untrackApprovalRequestsOfSession(CURRENT)
  untrackApprovalRequestsOfSession('session-background')
})

/** The unit kind a request was routed into, or null when nothing mounted. */
function routedKind(sessionId: string, requestId: string): string | null {
  const unit = store.getSessionStream(sessionId).liveUnits.find(
    candidate => 'req' in candidate && candidate.req?.requestId === requestId,
  )
  return unit?.type ?? null
}

describe('Permission request routing', () => {
  test('a permission request cannot create a proposed plan item', () => {
    const requestId = 'ordinary-permission'
    showPermissionRequest({ requestId, sessionId: CURRENT, toolCallId: requestId, toolName: 'write', toolInput: { path: '/project/PLAN.md' } })
    expect(routedKind(CURRENT, requestId)).toBe('live-permission')
    expect(store.getSessionStream(CURRENT).liveUnits.some(unit => unit.type === 'live-proposed-plan')).toBe(false)
  })

  // A tool that merely has the name inside it must not be mistaken for the
  // plan handshake, or an MCP server could mint a document review card.
  test('a namespaced look-alike stays an ordinary permission card', () => {
    const requestId = 'look-alike'
    showPermissionRequest({
      requestId,
      sessionId: CURRENT,
      toolCallId: requestId,
      toolName: 'mcp__remote__create_plan',
      toolInput: { planFilePath: '/project/.klaus/specs/other.md' },
    })
    expect(routedKind(CURRENT, requestId)).toBe('live-permission')
  })

  test('an unrelated tool keeps the ordinary permission card', () => {
    const requestId = 'plain-write'
    showPermissionRequest({
      requestId,
      sessionId: CURRENT,
      toolCallId: requestId,
      toolName: 'write',
      toolInput: { path: '/project/src/index.ts' },
    })
    expect(routedKind(CURRENT, requestId)).toBe('live-permission')
  })

  // A background session must not mount into the viewed conversation.
  test('a permission from another session queues instead of mounting here', () => {
    const deps = makeDeps()
    initApprovals(deps)
    const requestId = 'plan-review-background'
    showPermissionRequest({
      requestId,
      sessionId: 'session-background',
      toolCallId: requestId,
      toolName: 'create_plan',
      toolInput: { planFilePath: '/project/.klaus/specs/bg.md' },
    })
    expect(routedKind(CURRENT, requestId)).toBeNull()
    expect(deps.pendingPermissionsBySession.get('session-background')?.[0]?.requestId).toBe(requestId)
  })
})

const questions = [{ id: 'platforms', question: 'Which platforms?', options: [] }]
function findRequest(sessionId: string, requestId: string) {
  return store.getSessionStream(sessionId).liveUnits.find(unit => 'req' in unit && unit.req?.requestId === requestId)
}
function resolution(sessionId: string, requestId: string) {
  const unit = findRequest(sessionId, requestId)
  return unit && 'resolved' in unit ? unit.resolved : undefined
}

test('remote elicitation settles a question and clears waiting and badge state', () => {
  const requestId = 'remote-elicit'
  showElicitRequest({ requestId, sessionId: CURRENT, toolName: 'ask_user', toolInput: { questions } })
  expect(badgeCounts.at(-1)).toBe(1)
  const waiting = () => liveApprovalsOf(store.getSessionStream(CURRENT).liveUnits as unknown as Array<Record<string, unknown>>).filter(row => row.requestId === requestId)
  expect(waiting()).toHaveLength(1)
  store.ingestChatEvent({ type: 'elicit_resolved', sessionId: CURRENT, requestId, response: { kind: 'answers', answers: { platforms: 'macOS' } } })
  const unit = findRequest(CURRENT, requestId)
  if (unit?.type !== 'live-ask' || !unit.resolved) throw new Error('Expected a settled question')
  expect(unit.resolved).toEqual({ mode: 'submitted', answers: { platforms: 'macOS' } })
  expect(resolvedQuestionPresentation(questions, unit.resolved).rows).toEqual([{ index: 1, question: 'Which platforms?', answer: 'macOS' }])
  expect(waiting()).toHaveLength(0)
  untrackApprovalRequest(requestId)
  expect(badgeCounts.slice(-2)).toEqual([1, 0])
})

test('remote permission answers are normalized by question ID', () => {
  const requestId = 'remote-permission-question'
  showPermissionRequest({ requestId, sessionId: CURRENT, toolName: 'AskUserQuestion', toolInput: { questions } })
  store.ingestChatEvent({ type: 'permission_resolved', sessionId: CURRENT, requestId, decision: 'allow', updatedInput: { answers: { 'Which platforms?': 'macOS' } } })
  expect(resolution(CURRENT, requestId)).toEqual({ mode: 'submitted', answers: { platforms: 'macOS' } })
})

test('an echoed resolution preserves the local answer object', () => {
  const requestId = 'local-elicit'
  showElicitRequest({ requestId, sessionId: CURRENT, toolName: 'ask_user', toolInput: { questions } })
  store.resolveLiveApproval(CURRENT, requestId, { mode: 'submitted', answers: { platforms: 'macOS' } })
  const local = resolution(CURRENT, requestId)
  expect(local).toBeDefined()
  store.ingestChatEvent({ type: 'elicit_resolved', sessionId: CURRENT, requestId, response: { kind: 'decline' } })
  expect(resolution(CURRENT, requestId)).toBe(local)
})

test('remote approval preserves rule flags and releases a parked background tool', () => {
  for (const sessionId of [CURRENT, 'session-background']) {
    const requestId = `allow-${sessionId}`, toolCallId = `tool-${sessionId}`
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId, toolName: 'write', args: {} })
    showPermissionRequest({ requestId, sessionId, toolCallId, toolName: 'write', toolInput: {} })
    const toolStatus = () => Object.values(store.getSessionStream(sessionId).tools).find(tool => tool.status === 'awaiting-approval' || tool.status === 'running')?.status
    expect(toolStatus()).toBe('awaiting-approval')
    expect(routedKind(sessionId, requestId)).toBe(sessionId === CURRENT ? 'live-permission' : null)
    store.ingestChatEvent({ type: 'permission_resolved', sessionId, requestId, toolCallId, decision: 'allow', allowSession: true, savedRules: true })
    expect(toolStatus()).toBe('running')
    if (sessionId === CURRENT) expect(resolution(sessionId, requestId)).toEqual({ decision: 'allow', allowSession: true, savedRules: true })
  }
})
