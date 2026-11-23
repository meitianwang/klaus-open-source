import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  activateModeToggleShortcut,
} from './work-mode-shortcuts'
import { executionModeFlags, resolveSessionExecutionMode } from '../run-context'
import { createPlanReviewController } from '../planning/plan-controller'
import { ProposedPlanReview } from '../planning/plan-card'
import { GlobalModelTiers } from '../../pages/settings/global-model-tiers'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'

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
  test('does not expose /orchestrate or /parallel slash shortcuts anymore', async () => {
    const shortcutsModule = await import('./work-mode-shortcuts')
    expect('withOrchestrateShortcut' in shortcutsModule).toBe(false)
    expect('withUltraShortcut' in shortcutsModule).toBe(false)
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

  test('strips the command token before the toggle resolves and keeps text typed meanwhile', async () => {
    let draft = 'refactor payment retries /orchestrate'
    let caret = 0
    const sessionIds = ['sess-1', 'sess-1', 'sess-1']
    let release: (ok: boolean) => void = () => {}
    const pending = new Promise<boolean>(resolve => { release = resolve })
    const running = activateModeToggleShortcut({
      sessionId: () => sessionIds.shift() ?? 'sess-1',
      readDraft: () => draft,
      toggle: async () => pending,
      replaceDraft: (next, nextCaret) => { draft = next; caret = nextCaret },
    }, { start: 25, end: 37 })
    // The trigger is already gone while the toggle is still pending.
    expect(draft).toBe('refactor payment retries ')
    expect(caret).toBe(25)
    // Text typed during the wait survives the toggle completing.
    draft = 'refactor payment retries and add metrics'
    release(true)
    expect(await running).toBe(true)
    expect(draft).toBe('refactor payment retries and add metrics')
  })

  test('restores the original draft when a refused toggle left the draft untouched', async () => {
    let draft = 'refactor /ultra retries'
    let caret = 0
    const ok = await activateModeToggleShortcut({
      sessionId: () => 'sess-1',
      readDraft: () => draft,
      toggle: async () => false,
      replaceDraft: (next, nextCaret) => { draft = next; caret = nextCaret },
    }, { start: 9, end: 15 })
    expect(ok).toBe(false)
    expect(draft).toBe('refactor /ultra retries')
    expect(caret).toBe(15)
  })

  test('a refused toggle leaves the draft alone once the user typed or the conversation moved on', async () => {
    let draft = '/orchestrate refactor'
    let caret = 0
    let session = 'sess-1'
    let release: (ok: boolean) => void = () => {}
    const pending = new Promise<boolean>(resolve => { release = resolve })
    const running = activateModeToggleShortcut({
      sessionId: () => session,
      readDraft: () => draft,
      toggle: async () => pending,
      replaceDraft: (next, nextCaret) => { draft = next; caret = nextCaret },
    }, { start: 0, end: 12 })
    expect(draft).toBe('refactor')
    draft = 'refactor plus more'
    session = 'sess-2'
    release(false)
    expect(await running).toBe(false)
    expect(draft).toBe('refactor plus more')
  })

  test('exposes top-right execution mode labels alongside Plan and Goal labels', async () => {
    const { I18N } = await import('../../i18n/messages')
    expect([
      I18N.zh.exec_mode_default,
      I18N.zh.exec_mode_orchestrate,
      I18N.zh.exec_mode_parallel,
    ]).toEqual(['默认模式', '编排模式', '并行模式'])
    expect([
      I18N.en.exec_mode_default,
      I18N.en.exec_mode_orchestrate,
      I18N.en.exec_mode_parallel,
    ]).toEqual(['Default mode', 'Orchestrate mode', 'Parallel mode'])
    expect([I18N.zh.composer_plan, I18N.zh.composer_goal]).toEqual(['计划', '目标'])
    expect([I18N.en.composer_plan, I18N.en.composer_goal]).toEqual(['Plan', 'Goal'])
    expect(I18N.zh.ultra_mode_description).toBe('拆成多路子任务同时做，最后汇总结果')
    expect(I18N.zh.orchestrate_mode_description).toBe('主模型负责规划和验收，执行模型负责写代码和验证')
    expect(I18N.zh.planning_implement_goal).toBe('是，按目标实施')
    expect('planning_implement_orchestrate' in I18N.zh).toBe(false)
    expect('planning_implement_ultra' in I18N.zh).toBe(false)
  })
})

describe('plan implementation mode bridge', () => {
  test('offers only Standard and Goal implementation choices on proposed plans', async () => {
    const preparedModes: Array<{ sessionId: string; mode: string; content: string }> = []
    let acceptedCount = 0
    let allowGoal = false
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
          return mode !== 'goal' || allowGoal
        },
      },
    )

    // Cancelled Goal preparation aborts acceptance cleanly.
    expect(await controller.accept('goal')).toBe(false)
    expect(acceptedCount).toBe(0)

    const markup = renderToStaticMarkup(createElement(ProposedPlanReview, { controller }))
    expect(markup).toContain('data-plan-implement-more')

    allowGoal = true
    expect(await controller.accept('goal')).toBe(true)
    expect(acceptedCount).toBe(1)
    expect(preparedModes.at(-1)?.mode).toBe('goal')
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
      // i18n initializes `currentLang` at module load, so re-assert the locale after the import.
      ;(happy as any).currentLang = 'zh'
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

// Work modes chosen on the new chat screen are a draft: they must stay local
// until a conversation exists, survive preference pushes that still report the
// defaults, and be inherited when that draft is promoted to a session.
describe('welcome work mode draft lifecycle', () => {
  const source = createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
  const names = [
    'toggleComposerSpecEnabled',
    'currentComposerExecutionMode',
    'syncExecutionModeSelect',
    'effectiveWelcomeWorkModes',
    'patchCachedSessionWorkModes',
    'seedPromotedComposerPreferences',
    'setComposerExecutionMode',
    'setComposerOrchestrateMode',
    'setComposerUltraMode',
    'syncWorkModeBadgesFromPreferences',
    'cacheComposerPreferences',
  ]
  const declarations = names.map(name => {
    const node = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)
    if (!node) throw new Error(`Missing work mode function: ${name}`)
    return node.getText(source)
  }).join('\n')
  const script = transpileModule(`${declarations}\n({ ${names.join(',')}, get composerOrchestrateEnabled() { return composerOrchestrateEnabled }, get composerUltraEnabled() { return composerUltraEnabled }, get composerSpecEnabled() { return composerSpecEnabled } })`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

  function fixture() {
    const orchestrationCalls: unknown[] = []
    const ultraCalls: unknown[] = []
    const ensureSessionCalls: string[] = []
    const setItems: unknown[] = []
    const executionSelectValues: string[] = []
    let runContextVisible = true
    const context: any = {
      window: { currentSessionId: null as string | null },
      currentSessionId: null,
      specModeRevision: 0,
      composerSpecEnabled: false,
      composerGoalEnabled: false,
      composerUltraEnabled: false,
      composerOrchestrateEnabled: false,
      welcomeWorkMode: null,
      workModeMutationRevision: 0,
      composerPreferencesRevision: 0,
      composerPreferencesSnapshot: null,
      composerPreferencesBySession: new Map<string | null, any>(),
      executionModeFlags,
      resolveSessionExecutionMode,
      isComposerRunContextVisible: () => runContextVisible,
      executionModeApi: { setValue: (v: string) => executionSelectValues.push(v) },
      ensureSession: async () => { ensureSessionCalls.push('ensure'); context.window.currentSessionId = 'created-session'; return 'created-session' },
      showToast() {},
      updateWorkModeBadges() { api.syncExecutionModeSelect() },
      setComposerGoalEnabled(enabled: boolean) { context.composerGoalEnabled = enabled },
      applyPlanningUpdated({ planning }: { planning?: { mode?: string } }) {
        const isPlan = planning?.mode === 'plan'
        context.composerSpecEnabled = isPlan
      },
      tt: (key: string) => key,
      klausApi: { session: {
        setOrchestrationMode: async (enabled: boolean, sessionId?: string | null, options?: unknown) => {
          orchestrationCalls.push({ enabled, sessionId, ...(options !== undefined ? { options } : {}) })
        },
        setUltraMode: async (enabled: boolean, sessionId?: string | null, options?: unknown) => {
          ultraCalls.push({ enabled, sessionId, ...(options !== undefined ? { options } : {}) })
        },
        setCollaborationMode: async (_id: string, mode: string) => ({ planning: { mode } }),
      } },
      mainModelApi: { setItems: (items: unknown, opts: unknown) => setItems.push({ items, opts }) },
      mainModelCatalogCache: { get: () => null, invalidate() {}, revalidate: async () => [] },
      composerModelReadinessCache: { invalidate() {}, remember() {} },
      mainModelMenuValue: () => '',
      sidePaneRuntimes: new Map(),
    }
    const api = runInNewContext(script, context) as Record<string, any>
    return {
      api,
      context,
      orchestrationCalls,
      ultraCalls,
      ensureSessionCalls,
      setItems,
      executionSelectValues,
      setRunContextVisible: (next: boolean) => { runContextVisible = next },
    }
  }

  test('a welcome orchestration pick persists the default without creating a session and survives an older defaults push', async () => {
    const f = fixture()
    const ok = await f.api.setComposerExecutionMode('orchestrate')
    expect(ok).toBe(true)
    expect(f.ensureSessionCalls).toEqual([])
    expect(f.orchestrationCalls).toEqual([{ enabled: true, sessionId: null }])
    expect(f.api.composerOrchestrateEnabled).toBe(true)
    expect(f.api.currentComposerExecutionMode()).toBe('orchestrate')
    expect(f.executionSelectValues.at(-1)).toBe('orchestrate')

    f.api.syncWorkModeBadgesFromPreferences({ sessionId: null, orchestrationMode: false, ultraMode: false } as any)
    expect(f.api.composerOrchestrateEnabled).toBe(true)
    expect(f.api.composerUltraEnabled).toBe(false)

    // Switching back to Default clears both flags and remembered defaults.
    expect(await f.api.setComposerExecutionMode('default')).toBe(true)
    expect(f.api.currentComposerExecutionMode()).toBe('default')
    expect(f.executionSelectValues.at(-1)).toBe('default')
  })

  test('Plan mode composes with Orchestrate and Parallel without clearing the draft execution mode, and running sessions reject edits', async () => {
    const f = fixture()
    f.context.composerPreferencesBySession.set(null, { sessionId: null, ultraMode: false, orchestrationMode: false })
    f.context.window.currentSessionId = 'sess-1'
    expect(await f.api.setComposerExecutionMode('parallel')).toBe(true)
    expect(f.ultraCalls).toEqual([{ enabled: true, sessionId: 'sess-1' }])
    expect(f.context.composerPreferencesBySession.has(null)).toBe(false)

    f.ultraCalls.length = 0
    await f.api.toggleComposerSpecEnabled()
    expect(f.ultraCalls).toEqual([])
    expect(f.api.composerSpecEnabled).toBe(true)
    expect(f.api.composerUltraEnabled).toBe(true)
    expect(f.api.currentComposerExecutionMode()).toBe('parallel')

    // Once the conversation starts running, run-context hides and rejects edits.
    f.setRunContextVisible(false)
    expect(await f.api.setComposerExecutionMode('orchestrate')).toBe(false)
    expect(f.orchestrationCalls).toEqual([])
    expect(f.api.currentComposerExecutionMode()).toBe('parallel')
  })

  test('promoting a welcome draft seeds the promoted session with the picked mode', () => {
    const f = fixture()
    f.context.composerPreferencesSnapshot = {
      sessionId: null, source: 'codex', items: [], mode: 'codex:gpt-6.1', thinkingLevel: 'medium',
      ultraMode: false, orchestrationMode: false, fastMode: false, permissionMode: null, unavailable: false,
    }
    f.api.seedPromotedComposerPreferences('promoted-1', 'orchestrate')
    expect(f.context.composerPreferencesBySession.get('promoted-1')).toMatchObject({
      sessionId: 'promoted-1',
      orchestrationMode: true,
      ultraMode: false,
    })
    expect(f.context.composerPreferencesBySession.get('promoted-1')?.mode).toBe('codex:gpt-6.1')
  })
})
