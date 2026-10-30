// 审批挂起期间工具行状态与卡片位置的单元测试。
//
// 两条约束都来自同一个事实：引擎先发 tool_start、再走权限判定，所以一次被审批
// 拦住的调用在屏幕上已经有一行工具了。那一行此刻什么都没在跑，不能标「执行中」；
// 而问「是否允许」的卡片属于它下面，展开那一行看到的就是正在被审批的输入。
import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = {
  addEventListener: () => {},
  klaus: { session: { history: async () => [] } },
}

const store = await import('./stream-store')

const startTool = (sessionId: string, toolCallId: string) => {
  store.ingestChatEvent({
    type: 'tool_start', sessionId, toolName: 'write', toolCallId,
    args: { path: '/Users/me/.klaus/sessions/x.txt', content: 'test\n' },
  })
}
const statusOf = (sessionId: string, toolCallId: string) =>
  store.getSessionStream(sessionId).tools[toolCallId]?.status

describe('审批挂起的工具行', () => {
  test('卡片挂起期间工具行标等待批准，而不是执行中', () => {
    const sessionId = 'sess-parked'
    startTool(sessionId, 'call-1')
    expect(statusOf(sessionId, 'call-1')).toBe('running')

    store.markToolAwaitingApproval(sessionId, 'call-1')

    expect(statusOf(sessionId, 'call-1')).toBe('awaiting-approval')
  })

  test('批准后回到执行中，tool_end 再收终态', () => {
    const sessionId = 'sess-allowed'
    startTool(sessionId, 'call-2')
    store.markToolAwaitingApproval(sessionId, 'call-2')
    store.ingestLiveApproval('permission', { requestId: 'req-2', sessionId, toolName: 'write', toolCallId: 'call-2' })

    store.resolveLiveApproval(sessionId, 'req-2', { decision: 'allow', allowSession: false, savedRules: false })
    expect(statusOf(sessionId, 'call-2')).toBe('running')

    store.ingestChatEvent({ type: 'tool_end', sessionId, toolCallId: 'call-2', isError: false, content: 'ok' })
    expect(statusOf(sessionId, 'call-2')).toBe('ok')
  })

  test('引擎撤销待处理审批（用户 Stop）同样解除挂起，失败态由 tool_end 决定', () => {
    const sessionId = 'sess-cancelled'
    startTool(sessionId, 'call-3')
    store.markToolAwaitingApproval(sessionId, 'call-3')
    store.ingestLiveApproval('permission', { requestId: 'req-3', sessionId, toolName: 'write', toolCallId: 'call-3' })

    store.ingestChatEvent({ type: 'permission_cancelled', sessionId, requestId: 'req-3' })
    expect(statusOf(sessionId, 'call-3')).toBe('running')

    store.ingestChatEvent({ type: 'tool_end', sessionId, toolCallId: 'call-3', isError: true, content: 'Denied by user.' })
    expect(statusOf(sessionId, 'call-3')).toBe('error')
  })

  test('Diagram 产物只挂到对应的成功 toolCallId', () => {
    const sessionId = 'sess-diagram'
    startTool(sessionId, 'call-diagram-a')
    startTool(sessionId, 'call-diagram-b')

    store.ingestChatEvent({
      type: 'tool_end', sessionId, toolCallId: 'call-diagram-b', isError: false,
      artifact: { kind: 'diagram', id: 'dgm-b', title: 'B' },
    })
    store.ingestChatEvent({
      type: 'tool_end', sessionId, toolCallId: 'call-diagram-a', isError: true,
      artifact: { kind: 'diagram', id: 'dgm-a', title: 'A' },
    })

    const tools = store.getSessionStream(sessionId).tools
    expect(tools['call-diagram-b'].artifact).toEqual({ kind: 'diagram', id: 'dgm-b', title: 'B' })
    expect(tools['call-diagram-a'].artifact).toBeUndefined()
  })

  test('自动放行的调用没被挂住：找不到对应工具行时不写任何状态', () => {
    const sessionId = 'sess-auto-allowed'
    startTool(sessionId, 'call-4')

    store.markToolAwaitingApproval(sessionId, 'call-unknown')
    store.markToolAwaitingApproval('', 'call-4')

    expect(statusOf(sessionId, 'call-4')).toBe('running')
    expect(store.getSessionStream(sessionId).tools['call-unknown']).toBeUndefined()
  })

  test('按引擎顺序到达时，审批卡排在它挡住的那一行工具之后', () => {
    const sessionId = 'sess-order'
    startTool(sessionId, 'call-5')
    store.ingestLiveApproval('permission', { requestId: 'req-5', sessionId, toolName: 'write', toolCallId: 'call-5' })

    const kinds = store.getSessionStream(sessionId).liveUnits.map(unit => unit.type)
    expect(kinds).toEqual(['live-tools', 'live-permission'])
  })
})
