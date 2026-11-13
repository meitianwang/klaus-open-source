import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
if (typeof window === 'undefined') (globalThis as any).window = { addEventListener() {} }
const { catalogNeedsLoading, isThinkingLevelForModel, mainModelMenuValue } = await import('./model-select')
const { modelOptionForValue } = await import('../../../../shared/cursor-model-catalog')
const { isAutomaticCursorSelection } = await import('./model-selection-values')
const { isKiroRoutingAlias } = await import('../../../../shared/kiro-model-catalog')
const { createModelCatalogCache } = await import('./model-readiness')

// The composer model picker is scoped to the open conversation. Switching to a
// conversation reuses the state already resolved for it, holds the pending
// state when nothing was resolved yet, and persists a fallback when the stored
// model left the catalog — never the previous conversation's selection.
const source = createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
const names = [
  'applyComposerPreferences',
  'refreshComposerPreferences',
  'refreshCatalogSource',
  'resetComposerPreferencesForSessionChange',
  'applyCachedComposerPreferences',
  'cacheComposerPreferences',
  'concreteStoredModel',
  'reconcileUnavailableComposerModel',
]
const declarations = names.map(name => {
  const node = source.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)
  if (!node) throw new Error(`Missing composer preference function: ${name}`)
  return node.getText(source)
}).join('\n')
const script = transpileModule(`${declarations}\n({ ${names.join(',')} })`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

function fixture() {
  const sets: Array<{ items: any[]; opts: Record<string, unknown> }> = []
  const reads: string[] = []
  const writes: Array<Record<string, unknown> | undefined> = []
  const running = new Set<string>()
  const catalog = [{ value: 'codex:gpt-5.1', label: '5.1' }, { value: 'codex:gpt-6.1', label: '6.1' }]
  const storedModel = { value: 'codex:gpt-6.1' }
  const predictionCalls: string[] = []
  const context: any = {
    window: { currentSessionId: 'codex-chat', isSessionRunning: (id?: string | null) => !!id && running.has(id), dispatchEvent() { return true } },
    Event: globalThis.Event,
    revalidatingCatalogEvent: false,
    refreshAllSideComposerModels: async () => {},
    composerPreferencesRevision: 0,
    sideComposerModelRevision: 0,
    composerPreferencesSnapshot: null,
    composerPreferencesBySession: new Map(),
    mainModelApi: { setItems(items: any[], opts: Record<string, unknown>) { sets.push({ items, opts }) }, setValue() {}, setRuntime() {}, refresh() {}, close() {} },
    permissionSelectApi: { setValue() {}, setUnavailable() {}, refresh() {}, close() {} },
    predictionModelSelections: new Map(),
    composerPredictions: {
      invalidate(id?: string) { predictionCalls.push(`invalidate:${id ?? '*'}`) },
      recheck(id?: string) { predictionCalls.push(`recheck:${id ?? '*'}`) },
      refresh: async () => { predictionCalls.push('refresh') },
    },
    mainModelCatalogCache: { get: (requested: string) => requested === 'codex' ? catalog : null, invalidate() {}, revalidate: async () => catalog },
    composerModelReadinessCache: { remember() {}, invalidate() {} },
    buildMainModelItems: async (requested: string) => requested === 'codex' ? catalog : [],
    syncComposerInferenceStatus() {},
    catalogNeedsLoading,
    isThinkingLevelForModel,
    mainModelMenuValue,
    modelOptionForValue,
    isAutomaticCursorSelection,
    isKiroRoutingAlias,
    permissionPresetFromResponse: (value: { mode?: string }) => value.mode || null,
    console,
    tt: (key: string) => key,
    klausApi: { session: {
      getMainModel: async (sessionId: string, opts?: { resolve?: boolean }) => {
        reads.push(`${sessionId}:${opts?.resolve === false ? 'stored' : 'resolved'}`)
        return opts?.resolve === false
          ? { source: 'codex', mode: storedModel.value }
          : { source: 'codex', mode: storedModel.value, resolvedMode: 'codex:gpt-6.1' }
      },
      setMainModel: async (mode: string, sessionId?: string, source?: string) => { writes.push({ mode, sessionId, source }) },
      getThinkingLevel: async () => ({ level: 'high' }),
      getPermissionMode: async () => null,
      getFastMode: async () => ({ enabled: false }),
      getUltraMode: async () => ({ enabled: false }),
    } },
  }
  const api = runInNewContext(script, context) as Record<string, (...args: any[]) => any>
  return {
    api, context, sets, reads, writes, running, storedModel, catalog, predictionCalls,
    setSession(sessionId: string | null) { context.window.currentSessionId = sessionId },
    setSnapshot(snapshot: any) { context.composerPreferencesSnapshot = snapshot },
    snapshot() { return context.composerPreferencesSnapshot },
  }
}

const codexSnapshot = (sessionId: string | null, mode = 'codex:gpt-5.1') => ({
  sessionId, source: 'codex', items: [{ value: 'codex:gpt-5.1' }], mode,
  thinkingLevel: 'medium', ultraMode: false, fastMode: false, permissionMode: null, unavailable: false,
})

test('a session switch to an unresolved conversation holds the pending state', () => {
  const f = fixture()
  f.setSnapshot(codexSnapshot('qoder-chat', 'qoder:fast'))
  f.api.resetComposerPreferencesForSessionChange()
  expect(f.snapshot()).toBeNull()
  expect(f.sets.at(-1)).toEqual({ items: [], opts: { value: '', loading: true } })
})

test('a session switch reuses the state already resolved for that conversation', () => {
  const f = fixture()
  const cached = codexSnapshot('codex-chat', 'codex:gpt-6.1')
  f.api.cacheComposerPreferences(cached)
  f.setSnapshot(codexSnapshot('qoder-chat', 'qoder:fast'))
  f.api.resetComposerPreferencesForSessionChange()
  expect(f.snapshot()).toMatchObject({ sessionId: 'codex-chat', source: 'codex', mode: 'codex:gpt-6.1' })
  expect(f.snapshot()?.items).toEqual(f.catalog)
  expect(f.sets.at(-1)?.opts.value).toBe('codex:gpt-6.1')
  expect(f.sets.at(-1)?.opts.loading).toBeFalsy()
})

test('returning to the new chat composer also drops a conversation scoped model', () => {
  const f = fixture()
  f.setSession(null)
  f.setSnapshot(codexSnapshot('qoder-chat', 'qoder:fast'))
  f.api.resetComposerPreferencesForSessionChange()
  expect(f.snapshot()).toBeNull()
  expect(f.sets.at(-1)).toEqual({ items: [], opts: { value: '', loading: true } })
})

test('a session switch on the same source seeds the new session persisted model', async () => {
  const f = fixture()
  f.setSession('codex-other-chat')
  f.setSnapshot(codexSnapshot('codex-first-chat', 'codex:gpt-5.1'))
  await f.api.refreshComposerPreferences()
  const seed = f.sets.find(entry => entry.opts.value === 'codex:gpt-6.1')
  expect(seed?.items).toEqual([{ value: 'codex:gpt-5.1', label: '5.1' }, { value: 'codex:gpt-6.1', label: '6.1' }])
  expect(f.reads.slice(0, 2)).toEqual(['codex-other-chat:stored', 'codex-other-chat:resolved'])
})

test('a stored model that left the catalog is reconciled on that session only', async () => {
  const f = fixture()
  f.storedModel.value = 'codex:retired'
  f.setSession('codex-chat')
  await f.api.refreshComposerPreferences()
  expect(f.writes).toEqual([{ mode: 'codex:gpt-6.1', sessionId: 'codex-chat', source: 'codex' }])
})

test('auto selections and running turns are never rewritten by the reconciliation', async () => {
  const f = fixture()
  f.storedModel.value = 'auto'
  await f.api.refreshComposerPreferences()
  expect(f.writes).toEqual([])
  f.storedModel.value = 'codex:retired'
  f.running.add('codex-chat')
  await f.api.refreshComposerPreferences()
  expect(f.writes).toEqual([])
})

test('a stored model still in the catalog is not rewritten', async () => {
  const f = fixture()
  f.storedModel.value = 'codex:gpt-5.1'
  await f.api.refreshComposerPreferences()
  expect(f.writes).toEqual([])
})

test('a background catalog notification replaces baseline items without flashing the loading state', async () => {
  const f = fixture()
  let live = false
  const cache = createModelCatalogCache(async () => live
    ? [{ value: 'antigravity:gemini-4-carbon-medium', label: 'Gemini 4 Carbon' }, { value: 'antigravity:gemini-4-argon-medium', label: 'Gemini 4 Argon' }]
    : [{ value: 'antigravity:gemini-4-argon-medium', label: 'Gemini 4 Argon' }])
  f.context.mainModelCatalogCache = cache
  f.context.buildMainModelItems = (requested: string) => cache.load(requested)
  f.context.klausApi.session.getMainModel = async (_sessionId: string, opts?: { resolve?: boolean }) => opts?.resolve === false
    ? { source: 'antigravity', mode: 'antigravity:gemini-4-argon-medium' }
    : { source: 'antigravity', mode: 'antigravity:gemini-4-argon-medium', resolvedMode: 'antigravity:gemini-4-argon-medium' }

  await f.api.refreshComposerPreferences()
  expect(f.snapshot()?.items.map((item: { label: string }) => item.label)).toEqual(['Gemini 4 Argon'])

  f.sets.length = 0
  live = true
  await f.api.refreshCatalogSource('antigravity')
  // Wait for the concurrent refreshComposerPreferences microtasks to settle.
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(f.sets.some(call => call.opts.loading === true)).toBe(false)
  expect(f.snapshot()?.items.map((item: { label: string }) => item.label)).toEqual(['Gemini 4 Carbon', 'Gemini 4 Argon'])
})

test('switching models, model sources or composer modes never invalidates settled predictions', async () => {
  const f = fixture()
  f.api.applyComposerPreferences(codexSnapshot('codex-chat', 'codex:gpt-5.1'))
  expect(f.predictionCalls).toEqual([])
  f.api.applyComposerPreferences({ ...codexSnapshot('codex-chat', 'codex:gpt-5.1'), thinkingLevel: 'high', ultraMode: true, fastMode: true, permissionMode: 'auto' })
  expect(f.predictionCalls).toEqual([])
  f.api.applyComposerPreferences(codexSnapshot('codex-chat', 'codex:gpt-6.1'))
  f.api.applyComposerPreferences({ ...codexSnapshot('codex-chat', 'claude-sonnet'), source: 'subscription' })
  await f.api.refreshCatalogSource('codex')
  expect(f.predictionCalls.some(call => call.startsWith('invalidate:'))).toBe(false)
  expect(f.predictionCalls).toEqual(['recheck:codex-chat', 'recheck:codex-chat', 'recheck:*'])
})
