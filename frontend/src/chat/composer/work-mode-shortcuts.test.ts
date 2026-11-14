import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  activateModeToggleShortcut,
  isOrchestrateShortcut,
  isUltraShortcut,
  withOrchestrateShortcut,
  withUltraShortcut,
} from './work-mode-shortcuts'
import { createPlanReviewController } from '../planning/plan-controller'
import { ProposedPlanReview } from '../planning/plan-card'
import { GlobalModelTiers } from '../../pages/settings/global-model-tiers'

const previousWindow = (globalThis as any).window
beforeAll(() => {
  ;(globalThis as any).window = {
    currentLang: 'zh',
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
    klaus: {
      settings: {
        advisor: { get: async () => ({ enabled: false, model: '' }) },
        orchestrator: { get: async () => ({ mode: 'use_medium', model: '', fallbackToMain: false }) },
      },
    },
  }
})
afterAll(() => {
  if (previousWindow === undefined) delete (globalThis as any).window
  else ;(globalThis as any).window = previousWindow
})

describe('work mode shortcuts', () => {
  test('deduplicates and identifies /orchestrate and /parallel (with /ultra alias) shortcuts', () => {
    const base = [
      { name: 'ORCHESTRATE', kind: 'command' as const, type: 'action' as const },
      { name: 'PARALLEL', kind: 'command' as const, type: 'action' as const },
      { name: 'ULTRA', kind: 'command' as const, type: 'action' as const },
      { name: 'review', kind: 'command' as const, type: 'action' as const },
    ]
    const list = withOrchestrateShortcut(withUltraShortcut(base, 'Parallel desc'), 'Orch desc')
    expect(list.map(item => item.name)).toEqual(['orchestrate', 'parallel', 'review'])
    expect(list[1].aliases).toEqual(['ultra'])
    expect(isOrchestrateShortcut(list[0])).toBe(true)
    expect(isUltraShortcut(list[1])).toBe(true)
    expect(isUltraShortcut({ name: 'ultra', source: list[1].source, kind: 'command', type: 'action' })).toBe(true)
    expect(isOrchestrateShortcut(list[2])).toBe(false)
  })

  test('strips only the command token when toggling succeeds without session drift', async () => {
    let draft = '/orchestrate   refactor payment retries'
    let caret = 0
    const ok = await activateModeToggleShortcut({
      sessionId: () => 'sess-1',
      readDraft: () => draft,
      toggle: async () => true,
      replaceDraft: (next, nextCaret) => { draft = next; caret = nextCaret },
    }, { start: 0, end: 12 })
    expect(ok).toBe(true)
    expect(draft).toBe('refactor payment retries')
    expect(caret).toBe(0)
  })

  test('aligns all four mode badges to concise labels and plain-language descriptions', async () => {
    const { I18N } = await import('../../i18n/messages')
    expect([
      I18N.zh.composer_plan,
      I18N.zh.composer_goal,
      I18N.zh.composer_orchestrate,
      I18N.zh.composer_ultra,
    ]).toEqual(['计划', '目标', '编排', '并行'])
    expect([
      I18N.en.composer_plan,
      I18N.en.composer_goal,
      I18N.en.composer_orchestrate,
      I18N.en.composer_ultra,
    ]).toEqual(['Plan', 'Goal', 'Orchestrate', 'Parallel'])
    expect(I18N.zh.ultra_mode_description).toBe('拆成多路子任务同时做，最后汇总结果')
    expect(I18N.zh.orchestrate_mode_description).toBe('主模型负责规划和验收，执行模型负责写代码和验证')
    expect(I18N.zh.planning_implement_goal).toBe('是，按目标实施')
    expect(I18N.zh.planning_implement_orchestrate).toBe('是，按编排实施')
    expect(I18N.zh.planning_implement_ultra).toBe('是，按并行实施')
  })
})

describe('plan implementation mode bridge', () => {
  test('prepares Goal, Orchestrate, Ultra, and Standard modes before accepting plan', async () => {
    const preparedModes: Array<{ sessionId: string; mode: string; content: string }> = []
    let acceptedCount = 0
    const plan = {
      id: 'plan-1',
      threadId: 'sess-1',
      turnId: 'turn-1',
      revision: 1,
      content: '# Payment retry plan\n1. Idempotency check',
      status: 'proposed' as const,
      reviewPending: true,
    }
    const controller = createPlanReviewController(
      'sess-1',
      plan,
      {
        get: async () => ({ planning: { mode: 'plan', revision: 1, plans: [plan], questions: [] } }),
        readDocument: async () => ({
          planning: { mode: 'plan', revision: 1, plans: [plan], questions: [] },
          document: { planId: 'plan-1', revision: 1, path: '/tmp/PLAN.md', content: plan.content },
        }),
        saveDocument: async () => { throw new Error('unused') },
        accept: async () => {
          acceptedCount++
          return { planning: { mode: 'default', revision: 2, plans: [{ ...plan, status: 'accepted', reviewPending: false }], questions: [] }, accepted: true }
        },
        feedback: async () => { throw new Error('unused') },
        cancel: async () => { throw new Error('unused') },
      },
      () => {},
      {
        goalState: () => ({ eligible: true, locked: false }),
        prepareMode: async (sessionId, mode, content) => {
          preparedModes.push({ sessionId, mode, content })
          return mode !== 'ultra'
        },
      },
    )

    // Cancelled mode preparation (e.g. declining Full Access dialog) aborts acceptance cleanly.
    expect(await controller.accept('ultra')).toBe(false)
    expect(acceptedCount).toBe(0)

    // Goal mode prepares the persistent goal before accepting the plan.
    expect(await controller.accept('goal')).toBe(true)
    expect(acceptedCount).toBe(1)
    expect(preparedModes.at(-1)?.mode).toBe('goal')

    const markup = renderToStaticMarkup(createElement(ProposedPlanReview, { controller }))
    expect(markup).toContain('data-plan-implement-more')
  })
})

describe('upgraded model division & orchestration settings', () => {
  test('renders Orchestration fallback toggle, Sub-agent tiers, and Advisor without exposing technical guardrails', () => {
    const html = renderToStaticMarkup(createElement(GlobalModelTiers, { configureSource: () => {} }))
    expect(html).toContain('data-orchestrator-models')
    expect(html).toContain('id="orchestrator-fallback-to-main"')
    expect(html).toContain('data-advisor-models')
    expect(html).not.toContain('30')
  })
})

describe('orchestrator fallback confirmation modal lifecycle', () => {
  test('routes background session prompts to pending queue, parks on session switch, and submits continue/pause decisions', async () => {
    const { Window } = await import('happy-dom')
    const happy = new Window({ url: 'http://localhost/' })
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'requestAnimationFrame']) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      ;(globalThis as any)[key] = key === 'window' ? happy
        : key === 'requestAnimationFrame' ? happy.requestAnimationFrame.bind(happy)
        : (happy as any)[key]
    }
    try {
      let activeSession: string | null = 'sess-a'
      const responses: Array<{ requestId: string; response: any }> = []
      ;(happy as any).currentLang = 'zh'
      ;(happy as any).klaus = {
        app: { setApprovalBadge: async () => {} },
        permission: { respond: () => {}, pending: async () => [] },
        elicit: {
          pending: async () => [],
          respond: async (requestId: string, response: any) => {
            responses.push({ requestId, response })
            return { ok: true }
          },
        },
        memorySnapshot: { respond: () => {} },
      }
      const approvals = await import('../approvals')
      const pendingElicitsBySession = new Map<string, any[]>()
      approvals.initApprovals({
        currentSessionId: () => activeSession,
        isCronRunSession: () => false,
        markCronRunUnread: () => {},
        renderSessionList: () => {},
        pendingPermissionsBySession: new Map(),
        pendingElicitsBySession,
      })

      // 1. Background session queues in pendingElicitsBySession without mounting modal on sess-a
      approvals.showElicitRequest({
        requestId: 'req-bg',
        sessionId: 'sess-b',
        metadata: { kind: 'orchestrator_fallback', failedModel: 'qwen3-coder', mainModel: 'opus-5.5', reasonCode: 'quota' },
      })
      expect(happy.document.querySelector('[data-orchestrator-fallback-dialog]')).toBeNull()
      expect(pendingElicitsBySession.get('sess-b')?.length).toBe(1)

      // 2. Active session mounts modal with localized reason, parks when switching away, and reopens on return
      approvals.showElicitRequest({
        requestId: 'req-fg',
        sessionId: 'sess-a',
        metadata: { kind: 'orchestrator_fallback', failedModel: 'qwen3-coder', mainModel: 'opus-5.5', reasonCode: 'quota' },
      })
      const modal1 = happy.document.querySelector('[data-orchestrator-fallback-dialog="req-fg"]')
      expect(modal1).not.toBeNull()
      expect(modal1?.textContent).toContain('qwen3-coder')
      expect(modal1?.textContent).toContain('额度已用完')
      expect(modal1?.textContent).toContain('opus-5.5')

      activeSession = 'sess-b'
      approvals.parkOrchestratorFallbackPrompts('sess-b')
      expect(happy.document.querySelector('[data-orchestrator-fallback-dialog="req-fg"]')).toBeNull()
      expect(pendingElicitsBySession.get('sess-a')?.[0]?.requestId).toBe('req-fg')

      // Switch back to sess-a and accept "continue with chat model"
      activeSession = 'sess-a'
      const queued = pendingElicitsBySession.get('sess-a') || []
      pendingElicitsBySession.delete('sess-a')
      for (const req of queued) approvals.showElicitRequest(req)
      const continueBtn = happy.document.querySelector('[data-orchestrator-fallback-choice="continue"]') as HTMLElement | null
      expect(continueBtn).not.toBeNull()
      continueBtn!.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(responses).toEqual([{
        requestId: 'req-fg',
        response: { kind: 'accept', values: ['continue_with_main'] },
      }])

      // 3. Clicking "Pause for now" sends decline
      approvals.showElicitRequest({
        requestId: 'req-pause',
        sessionId: 'sess-a',
        metadata: { kind: 'orchestrator_fallback', failedModel: 'codex-mini', mainModel: 'opus-5.5', reasonCode: 'auth' },
      })
      const pauseBtn = happy.document.querySelector('[data-orchestrator-fallback-choice="pause"]') as HTMLElement | null
      expect(pauseBtn).not.toBeNull()
      pauseBtn!.click()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(responses.at(-1)).toEqual({
        requestId: 'req-pause',
        response: { kind: 'decline', reason: 'paused_by_user' },
      })
    } finally {
      await happy.happyDOM.cancelAsync()
      happy.close()
      for (const [key, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, key, desc)
        else delete (globalThis as any)[key]
      }
    }
  })
})
