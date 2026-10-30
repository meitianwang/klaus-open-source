import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { t } from '../../i18n'

;(globalThis as any).window ??= { addEventListener: () => {} }
const { PlanReviewCard } = await import('./approval-cards')
const { chatStreamStore, ingestChatEvent } = await import('../stream-store')

const request = {
  requestId: 'review-1', toolCallId: 'call-1', toolName: 'exit_plan_mode',
  toolInput: { plan: '# Complete design\nDetailed interface', planSummary: 'A short summary', planFilePath: '/project/.klaus/specs/plan.md' },
}

function card(resolved: null | { decision: string } = null, sessionId = 'session-1') {
  return renderToStaticMarkup(<PlanReviewCard req={request} startedAt={0} resolved={resolved} sessionId={sessionId} />)
}

describe('Spec review card', () => {
  test('shows the separate summary and prevents execution before full document loading', () => {
    const html = card()
    expect(html).toContain('A short summary')
    expect(html).not.toContain('Detailed interface')
    expect(html).toContain(t('spec_review_details'))
    expect(html).toContain(t('spec_review_loading'))
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*spec-review-execute/)
    expect(html).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
  })

  test('the summary never renders document markdown typography into the card', () => {
    const html = renderToStaticMarkup(<PlanReviewCard req={{
      requestId: 'review-md', toolCallId: 'call-md', toolName: 'exit_plan_mode',
      toolInput: { plan: '# Give Klaus cross-session messaging\n- wire the handoff tool\n> a quote\n\n---\nBody prose', planFilePath: '/project/.klaus/specs/plan.md' },
    }} startedAt={0} resolved={null} sessionId="session-md" />)
    expect(html).not.toMatch(/<h1[ >]/)
    expect(html).not.toMatch(/<blockquote[ >]/)
    expect(html).not.toContain('<hr')
    expect(html).toContain('Give Klaus cross-session messaging')
    expect(html).toContain('wire the handoff tool')
  })

  test('a settled card keeps its header and the details link instead of hollowing out', () => {
    const sessionId = 'settled-session'
    ingestChatEvent({ sessionId, type: 'tool_start', toolCallId: request.toolCallId, toolName: 'exit_plan_mode' })
    ingestChatEvent({ sessionId, type: 'tool_end', toolCallId: request.toolCallId, isError: false })
    const html = card({ decision: 'allow' }, sessionId)
    expect(html).toContain(t('spec_plan_review_title'))
    expect(html).toContain(t('spec_review_details'))
    expect(html).toContain(t('spec_review_ran'))
    expect(html).toContain('spec-review-title')
  })

  test('reflects an existing goal as a checked, locked option', () => {
    ;(globalThis as any).window.getSessionGoalSnapshot = () => ({ goalId: 'goal-1', status: 'active' })
    try {
      const html = card()
      expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""[^>]*checked=""/)
      expect(html).toContain(t('spec_review_goal_locked'))
    } finally {
      delete (globalThis as any).window.getSessionGoalSnapshot
    }
  })

  test('an acknowledgement stays Starting until the associated tool succeeds', () => {
    const sessionId = 'success-session'
    ingestChatEvent({ sessionId, type: 'tool_start', toolCallId: request.toolCallId, toolName: 'exit_plan_mode', args: request.toolInput })
    const starting = card({ decision: 'allow' }, sessionId)
    expect(starting).toContain(t('spec_review_starting'))
    expect(starting).not.toContain(t('spec_review_ran'))
    expect(starting).toMatch(/<button[^>]*disabled=""[^>]*spec-review-execute/)
    ingestChatEvent({ sessionId, type: 'tool_end', toolCallId: request.toolCallId, isError: false })
    const html = card({ decision: 'allow' }, sessionId)
    expect(html).toContain(t('spec_review_details'))
    expect(html).toContain(t('spec_review_ran'))
    // The summary block leaves the card body once settled; the header keeps the
    // document identity line so the settled card is not an empty shell.
    expect(html).not.toContain('spec-review-summary')
    expect(html).toContain('spec-review-title')
    expect(html).not.toContain('spec-review-execute')
    expect(html).toContain('data-review-pending="false"')
  })

  test('an engine failure is not a successful execution or a retryable permission', () => {
    const sessionId = 'failed-session'
    ingestChatEvent({ sessionId, type: 'tool_start', toolCallId: request.toolCallId, toolName: 'exit_plan_mode' })
    ingestChatEvent({ sessionId, type: 'tool_end', toolCallId: request.toolCallId, isError: true, content: 'Spec revision conflict' })
    const html = card({ decision: 'allow' }, sessionId)
    expect(html).toContain(t('spec_review_execution_failed'))
    expect(html).toContain(t('spec_review_failed'))
    expect(html).not.toContain(t('spec_review_ran'))
    expect(html).not.toContain('spec-review-execute')
    expect(card({ decision: 'allow' }, 'other-session')).toContain(t('spec_review_starting'))
  })

  test('interruption cancels an accepted execution', () => {
    const sessionId = 'interrupted-session'
    ingestChatEvent({ sessionId, type: 'tool_start', toolCallId: request.toolCallId, toolName: 'exit_plan_mode' })
    ingestChatEvent({ sessionId, type: 'interrupted' })
    expect(chatStreamStore.getState().sessions[sessionId].tools[request.toolCallId].status).toBe('interrupted')
    const html = card({ decision: 'allow' }, sessionId)
    expect(html).toContain(t('spec_review_cancelled'))
    expect(html).not.toContain(t('spec_review_ran'))
  })

  for (const decision of ['deny', 'cancelled']) test(`a ${decision} historical review has no live actions`, () => {
    const html = card({ decision })
    expect(html).toContain(t('spec_review_cancelled'))
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('spec-review-execute')
  })
})
