import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = {
  addEventListener: () => {},
  klaus: {
    app: { setApprovalBadge: async () => {} },
    permission: { respond: () => {}, pending: async () => [] },
    elicit: { pending: async () => [] },
    memorySnapshot: { respond: () => {} },
    session: { history: async () => [] },
  },
}

const store = await import('./stream-store')
const { initApprovals, showPermissionRequest } = await import('./approvals')
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
