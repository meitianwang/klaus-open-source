import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import {
  PREDICTIONS_ACCEPTED_KEY,
  PREDICTIONS_ENABLED_KEY,
  recheckComposerPredictionState,
} from './predictions'

const chatSource = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', chatSource, ScriptTarget.ESNext, true)

function extractFunction(name: string): string {
  const node = ast.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!node) throw new Error(`Missing function in chat.ts: ${name}`)
  return node.getText(ast)
}

function extractBetween(startMarker: string, endMarker: string): string {
  const start = chatSource.indexOf(startMarker)
  const end = chatSource.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`Missing slice in chat.ts: ${startMarker}`)
  return chatSource.slice(start, end)
}

const harnessSource = transpileModule([
  extractBetween("window.addEventListener('klaus:auth-mode-changed'", '// 欢迎屏问候语'),
  extractFunction('applyPlanningUpdated'),
  extractFunction('invalidateComposerPreferenceReads'),
  extractFunction('refreshCatalogSource'),
  extractFunction('applyComposerPreferences'),
  extractBetween('const COMPOSER_PREFERENCE_KEYS = new Set([', '// Friend folders rename themselves'),
].join('\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

describe('composer prediction preservation across model and mode switches', () => {
  function createHarness() {
    const windowListeners = new Map<string, Array<() => void>>()
    let preferencesListener: ((payload: { key?: string }) => void) | null = null
    const actions: string[] = []
    const context: Record<string, any> = {
      PREDICTIONS_ENABLED_KEY,
      PREDICTIONS_ACCEPTED_KEY,
      SIDEBAR_PROJECT_EXPANDED_KEY: 'sidebar_project_expanded',
      SIDEBAR_SECTIONS_COLLAPSED_KEY: 'sidebar_sections_collapsed',
      SIDEBAR_PROJECT_ORDER_CHANGED_KEY: 'sidebar_project_order',
      followUpModeHelper: { FOLLOW_UP_QUEUE_MODE_KEY: 'follow_up_queue_mode' },
      isFastModePreferenceKey: (key: string) => key.startsWith('fast_mode:'),
      loadFollowUpQueueMode: async () => {},
      applyRemoteSidebarCollapseChange: async () => {},
      applyRemoteSidebarProjectOrder: async () => {},
      composerPreferencesRevision: 0,
      sidePaneRuntimes: new Map(),
      mainModelCatalogCache: { invalidate() {}, revalidate: async () => {} },
      composerModelReadinessCache: { invalidate() {} },
      refreshComposerPreferences: async () => {},
      refreshAllSideComposerModels: async () => {},
      predictionModelSelections: new Map<string, string>(),
      mainModelApi: { setItems() {} },
      permissionSelectApi: { setValue() {}, setUnavailable() {} },
      syncWorkModeBadgesFromPreferences() {},
      receivePlanningSnapshot: () => true,
      ingestPlanningSnapshot() {},
      composerSpecEnabled: false,
      composerGoalEnabled: false,
      setComposerGoalEnabled() {},
      clearWorkModesForPlan() {},
      updateSpecBadge() {},
      Event: globalThis.Event,
      console,
      window: {
        currentSessionId: 'session-a',
        addEventListener(name: string, fn: () => void) {
          const list = windowListeners.get(name) ?? []
          list.push(fn)
          windowListeners.set(name, list)
        },
        dispatchEvent(event: Event) {
          for (const fn of windowListeners.get(event.type) ?? []) fn()
          return true
        },
      },
      klausApi: {
        on: {
          appPreferencesChanged(fn: (payload: { key?: string }) => void) {
            preferencesListener = fn
          },
        },
      },
      composerPredictions: {
        invalidate(sessionId?: string) { actions.push(`invalidate:${sessionId ?? '*'}`) },
        recheck(sessionId?: string) { actions.push(`recheck:${sessionId ?? '*'}`) },
        suspend(sessionId?: string) { actions.push(`suspend:${sessionId ?? '*'}`) },
        refresh: async () => { actions.push('refresh') },
        reloadSettings: async () => { actions.push('reloadSettings') },
      },
    }
    const api = runInNewContext(
      `${harnessSource}\n({ applyPlanningUpdated, refreshCatalogSource, applyComposerPreferences, isSpec: () => composerSpecEnabled })`,
      context,
    ) as {
      applyPlanningUpdated(detail: { sessionId: string; planning: { mode: 'plan' | 'default'; revision: number; plans: never[] } }): void
      refreshCatalogSource(source: string): Promise<void>
      applyComposerPreferences(snapshot: Record<string, unknown>): void
      isSpec(): boolean
    }
    return {
      api,
      actions,
      dispatchWindow(type: string) { context.window.dispatchEvent(new Event(type)) },
      emitPreference(key: string) { preferencesListener?.({ key }) },
    }
  }

  test('auth-mode, model, thinking, fast, ultra, orchestration, permission and catalog changes never call invalidate', async () => {
    const h = createHarness()
    h.dispatchWindow('klaus:auth-mode-changed')
    h.dispatchWindow('klaus:models-changed')
    await h.api.refreshCatalogSource('codex')
    const base = {
      sessionId: 'session-a', source: 'codex', items: [], mode: 'codex:gpt-5.2',
      thinkingLevel: 'medium', ultraMode: false, orchestrationMode: false, fastMode: false, permissionMode: 'default', unavailable: false,
    }
    h.api.applyComposerPreferences(base)
    h.api.applyComposerPreferences({ ...base, thinkingLevel: 'high', ultraMode: true, orchestrationMode: true, fastMode: true, permissionMode: 'auto' })
    h.api.applyComposerPreferences({ ...base, mode: 'codex:gpt-5.3' })
    h.api.applyComposerPreferences({ ...base, source: 'subscription', mode: 'claude-opus-4-6' })

    for (const key of [
      'composer.main_model',
      'composer.thinking_level',
      'composer.ultra_mode',
      'composer.orchestration_mode',
      'composer.codex_fast_mode',
      'fast_mode:antigravity',
      'composer.permission_mode',
      'auth_mode',
      'modelProviders',
      'feature_models',
      'model_tiers:global',
    ]) {
      h.emitPreference(key)
    }

    expect(h.actions.some(action => action.startsWith('invalidate:'))).toBe(false)
    expect(h.actions).toEqual([
      'recheck:*',
      'recheck:*',
      'recheck:*',
      'recheck:session-a',
      'recheck:session-a',
      'recheck:*',
      'recheck:*',
      'recheck:*',
      'recheck:*',
    ])
  })

  test('entering Plan mode suspends without invalidating, and leaving Plan mode refreshes', () => {
    const h = createHarness()
    h.api.applyPlanningUpdated({ sessionId: 'session-a', planning: { mode: 'plan', revision: 1, plans: [] } })
    expect(h.api.isSpec()).toBe(true)
    h.api.applyPlanningUpdated({ sessionId: 'session-a', planning: { mode: 'default', revision: 2, plans: [] } })
    expect(h.api.isSpec()).toBe(false)
    expect(h.actions).toEqual(['suspend:session-a', 'refresh'])
  })

  test('recheck state helper keeps settled suggestions and null/sampled-out entries while dropping model-dependent failures', () => {
    expect(recheckComposerPredictionState({ suggestion: 'Run the test suite.' })).toBe('keep')
    expect(recheckComposerPredictionState({ suggestion: null })).toBe('keep')
    expect(recheckComposerPredictionState({ suggestion: null, reason: 'sampled_out' })).toBe('keep')
    for (const reason of ['unavailable', 'unsupported_model', 'prediction_failed', 'configuration_unavailable', 'timeout', 'invalid_response', 'cancelled', 'stale_turn']) {
      expect(recheckComposerPredictionState({ suggestion: null, reason })).toBe('retry')
    }
  })
})
