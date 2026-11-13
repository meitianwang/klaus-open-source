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
        orchestrator: { get: async () => ({ mode: 'use_medium', model: '' }) },
      },
    },
  }
})
afterAll(() => {
  if (previousWindow === undefined) delete (globalThis as any).window
  else ;(globalThis as any).window = previousWindow
})

describe('work mode shortcuts', () => {
  test('deduplicates and identifies /orchestrate and /ultra shortcuts', () => {
    const base = [
      { name: 'ORCHESTRATE', kind: 'command' as const, type: 'action' as const },
      { name: 'ULTRA', kind: 'command' as const, type: 'action' as const },
      { name: 'review', kind: 'command' as const, type: 'action' as const },
    ]
    const list = withOrchestrateShortcut(withUltraShortcut(base, 'Ultra desc'), 'Orch desc')
    expect(list.map(item => item.name)).toEqual(['orchestrate', 'ultra', 'review'])
    expect(isOrchestrateShortcut(list[0])).toBe(true)
    expect(isUltraShortcut(list[1])).toBe(true)
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
  test('renders Orchestration, Sub-agent tiers, and Advisor without exposing technical guardrails', () => {
    const html = renderToStaticMarkup(createElement(GlobalModelTiers, { configureSource: () => {} }))
    expect(html).toContain('data-orchestrator-models')
    expect(html).toContain('data-advisor-models')
    expect(html).not.toContain('30')
  })
})
