import { describe, expect, test } from 'bun:test'
import cursorVectors from '../../../../contracts/vectors/cursor-grouped-parameters-vectors.json'
import tierVectors from '../../../../contracts/vectors/global-model-tier-vectors.json'
import type { GlobalModelTierMapping, GlobalModelTierOptions, ModelTierName, ModelTierReference } from '../../../bridge/types'
import { FOLLOW_CHAT_MODEL, GlobalModelTiersState, type TierSettingsApi } from './global-model-tiers-state'
import { loadGlobalModelTierMappings, loadGlobalModelTierOptions, mappedModelTiers, modelReferenceLabel, saveGlobalModelTier } from './model-shared'

const initial = (): GlobalModelTierMapping => ({
  version: 1, revision: 7,
  high: { source: 'codex', modelId: 'strong' },
  medium: { source: 'custom', modelId: 'balanced' },
  low: null,
})
const options = (): GlobalModelTierOptions => ({
  ok: true,
  sources: [
    { source: 'codex', status: 'ready', options: [{ modelId: 'strong', label: 'Strong model' }] },
    { source: 'custom', status: 'ready', options: [{ modelId: 'balanced', label: 'Balanced model' }, { modelId: 'strong', label: 'Other strong model' }] },
    { source: 'local', status: 'unavailable', reason: 'No installed models', options: [] },
  ],
  tiers: { high: { status: 'ready', label: 'Strong model' }, medium: { status: 'ready', label: 'Balanced model' }, low: { status: 'inherit' } },
})
function host() {
  let persisted = initial()
  const writes: Array<{ tier: ModelTierName; target: ModelTierReference | null; revision: number }> = []
  const api: TierSettingsApi = {
    get: async () => structuredClone(persisted),
    options: async () => options(),
    set: async (tier, target, revision) => {
      writes.push({ tier, target, revision })
      if (revision !== persisted.revision) throw new Error('MODEL_TIERS_REVISION_CONFLICT')
      persisted = { ...persisted, revision: persisted.revision + 1, [tier]: target }
      return structuredClone(persisted)
    },
  }
  return { api, writes, persisted: () => persisted, replace: (value: GlobalModelTierMapping) => { persisted = value } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('shared model tier editor', () => {
  test('saves one structured source-local reference atomically and reloads it', async () => {
    const mock = host()
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    state.selectSource('custom')
    expect(state.getSnapshot().editor?.modelId).toBe('')
    expect(state.canSave()).toBe(false)
    state.selectModel('balanced')
    expect(await state.save()).toBe(true)
    expect(mock.writes).toEqual([{ tier: 'high', target: { source: 'custom', modelId: 'balanced' }, revision: 7 }])
    expect(mock.persisted().medium).toEqual(initial().medium)
    expect(mock.persisted().low).toBeNull()
    expect(state.getSnapshot().editor).toBeNull()
    const reopened = new GlobalModelTiersState(mock.api)
    await reopened.load()
    reopened.open('high')
    expect(reopened.getSnapshot().editor).toEqual({ tier: 'high', source: 'custom', modelId: 'balanced', revision: 8 })
  })

  test('cancelling a changed source or model never writes', async () => {
    const mock = host()
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    state.selectSource('custom')
    state.selectModel('balanced')
    state.close()
    expect(mock.writes).toEqual([])
    expect(mock.persisted()).toEqual(initial())
    state.open('high')
    expect(state.getSnapshot().editor?.source).toBe('codex')
  })

  test('an explicit follow-chat choice writes null, not auto or an empty model ID', async () => {
    const mock = host()
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    state.selectSource(FOLLOW_CHAT_MODEL)
    expect(await state.save()).toBe(true)
    expect(mock.writes[0]).toEqual({ tier: 'high', target: null, revision: 7 })
    expect(mock.persisted().medium).toEqual(initial().medium)
  })

  test('a save failure keeps the editor and persisted selection, with no success result', async () => {
    const mock = host()
    mock.api.set = async () => { throw new Error('Source unavailable') }
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    state.selectSource('custom')
    state.selectModel('balanced')
    expect(await state.save()).toBe(false)
    expect(state.getSnapshot().saveError).toBe('Failed')
    expect(state.getSnapshot().editor?.modelId).toBe('balanced')
    expect(state.getSnapshot().mapping).toEqual(initial())
    expect(mock.persisted()).toEqual(initial())
    expect(state.canSave()).toBe(true)
  })

  test('a revision conflict preserves other tiers and requires a review before retry', async () => {
    const mock = host()
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    state.selectSource('custom')
    state.selectModel('balanced')
    mock.replace({ ...initial(), revision: 8, low: { source: 'codex', modelId: 'strong' } })
    expect(await state.save()).toBe(false)
    expect(state.getSnapshot().saveError).toBe('Failed')
    expect(state.getSnapshot().mapping?.low).toEqual({ source: 'codex', modelId: 'strong' })
    expect(state.getSnapshot().editor?.revision).toBe(7)
    expect(state.canSave()).toBe(false)
    expect(await state.save()).toBe(false)
    expect(mock.writes).toHaveLength(1)
    state.open('high')
    state.selectSource('custom')
    state.selectModel('balanced')
    expect(await state.save()).toBe(true)
    expect(mock.persisted().low).toEqual({ source: 'codex', modelId: 'strong' })
  })

  test('catalog models can save without a local credential availability decision', async () => {
    const mock = host()
    mock.api.options = async () => {
      const result = options()
      result.sources[1]!.options[0]!.available = false
      result.sources[1]!.options[0]!.reasonCode = 'MODEL_CREDENTIAL_MISSING'
      return result
    }
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    state.selectSource('custom')
    state.selectModel('balanced')
    expect(state.canSave()).toBe(true)
    expect(await state.save()).toBe(true)
    expect(mock.persisted().high).toEqual({ source: 'custom', modelId: 'balanced' })
    state.open('high')
    state.selectModel('strong')
    expect(state.canSave()).toBe(true)
    expect(await state.save()).toBe(true)
    expect(mock.persisted().high).toEqual({ source: 'custom', modelId: 'strong' })
  })

  test('a deleted model retains its reference and never selects the catalog head', async () => {
    const mock = host()
    mock.replace({ ...initial(), high: { source: 'custom', modelId: 'deleted' } })
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    expect(state.getSnapshot().editor?.modelId).toBe('deleted')
    expect(state.canSave()).toBe(false)
    expect(state.getSnapshot().mapping?.high?.modelId).toBe('deleted')
  })

  test('a logged-out source keeps the selected target and can explicitly follow chat instead', async () => {
    const mock = host()
    mock.api.options = async () => ({ ...options(), sources: [{ source: 'codex', status: 'unavailable', reason: 'Sign in', options: [] }] })
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    expect(state.getSnapshot().editor?.modelId).toBe('strong')
    expect(state.canSave()).toBe(false)
    state.selectSource(FOLLOW_CHAT_MODEL)
    expect(state.canSave()).toBe(true)
    expect(mock.writes).toEqual([])
  })

  test('a failed catalog read does not discard the mapping or permit a catalog fallback', async () => {
    const mock = host()
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    mock.api.options = async () => { throw new Error('Catalog failed') }
    await state.load()
    state.open('high')
    expect(state.getSnapshot().mapping).toEqual(initial())
    expect(state.getSnapshot().options).toBeNull()
    expect(state.getSnapshot().optionsError).toBe('Could not load this setting. Please try again.')
    expect(state.canSave()).toBe(false)
  })

  test('late loads cannot overwrite a newer source catalog or draft', async () => {
    const mock = host()
    const lateMapping = deferred<GlobalModelTierMapping>()
    const lateOptions = deferred<GlobalModelTierOptions>()
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    mock.api.get = () => lateMapping.promise
    mock.api.options = () => lateOptions.promise
    const oldLoad = state.load()
    mock.api.get = async () => ({ ...initial(), revision: 9 })
    mock.api.options = async () => ({ ...options(), sources: [] })
    await state.load()
    state.open('high')
    state.selectSource('custom')
    lateMapping.resolve(initial())
    lateOptions.resolve(options())
    await oldLoad
    expect(state.getSnapshot().mapping?.revision).toBe(9)
    expect(state.getSnapshot().options?.sources).toEqual([])
    expect(state.getSnapshot().editor?.source).toBe('custom')
    expect(state.getSnapshot().editor?.modelId).toBe('')
  })

  test('unmount invalidates pending reads and late successful save notifications', async () => {
    const mock = host()
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    const write = deferred<GlobalModelTierMapping>()
    mock.api.set = () => write.promise
    const save = state.save()
    state.cancelPending()
    write.resolve({ ...initial(), revision: 8 })
    expect(await save).toBe(false)
    expect(state.getSnapshot().mapping?.revision).toBe(7)
  })

  test('saving blocks cancelling and duplicate writes until the host confirms', async () => {
    const mock = host()
    const write = deferred<GlobalModelTierMapping>()
    mock.api.set = () => write.promise
    const state = new GlobalModelTiersState(mock.api)
    await state.load()
    state.open('high')
    const save = state.save()
    expect(state.canSave()).toBe(false)
    state.close()
    state.selectSource('custom')
    expect(state.getSnapshot().editor?.source).toBe('codex')
    expect(await state.save()).toBe(false)
    write.resolve({ ...initial(), revision: 8 })
    expect(await save).toBe(true)
  })
})

describe('shared model tier projection', () => {
  test('badges compare source and source-local ID and keep three tiers for one model', () => {
    const ref = { source: 'codex', modelId: 'same' }
    const mapping = { ...initial(), high: ref, medium: ref, low: ref }
    expect(mappedModelTiers(mapping, 'codex', 'same')).toEqual(['high', 'medium', 'low'])
    expect(mappedModelTiers(mapping, 'custom', 'same')).toEqual([])
  })

  test('reads and writes use named tier APIs, not auth_mode or legacy key-value maps', async () => {
    const previousWindow = (globalThis as any).window
    const mock = host()
    ;(globalThis as any).window = {
      settingsApi: {
        kv: { get: () => { throw new Error('Do not read legacy keys') }, set: () => { throw new Error('Do not write legacy keys') } },
        models: {
          getTiers: async () => ({ ok: true, mapping: await mock.api.get() }),
          tierOptions: async () => mock.api.options(),
          setTier: async (...args: Parameters<TierSettingsApi['set']>) => ({ ok: true, mapping: await mock.api.set(...args) }),
        },
      },
    }
    try {
      expect(await loadGlobalModelTierMappings()).toEqual(initial())
      expect(await loadGlobalModelTierOptions()).toEqual(options())
      expect(modelReferenceLabel({ source: 'custom', modelId: 'strong' }, options())).toBe('Other strong model')
      expect(modelReferenceLabel({ source: 'custom', modelId: 'removed' }, options())).toBe('removed')
      expect((await saveGlobalModelTier('low', { source: 'custom', modelId: 'balanced' }, 7)).revision).toBe(8)
      expect(mock.writes[0].target?.modelId).toBe('balanced')
    } finally {
      ;(globalThis as any).window = previousWindow
    }
  })

  test('a structured failed write surfaces the host error instead of claiming success', async () => {
    const previousWindow = (globalThis as any).window
    ;(globalThis as any).window = { settingsApi: { models: { setTier: async () => ({ ok: false, error: 'MODEL_TIERS_REVISION_CONFLICT' }) } } }
    try {
      expect(await saveGlobalModelTier('high', null, 7).then(() => '', error => error.message)).toBe('Failed')
    } finally {
      ;(globalThis as any).window = previousWindow
    }
  })
})


test('a saved Cursor member remains available and saves its exact parameters without load-time writes', async () => {
  const writes: unknown[] = []
  const modelId = cursorVectors.savedSelection.slice('cursor:'.length)
  const mapping: GlobalModelTierMapping = { version: 1, revision: 4, high: { source: 'cursor', modelId }, medium: null, low: null }
  const catalog = { ok: true, sources: [{ source: 'cursor', status: 'ready', options: [{ ...cursorVectors.model, modelId: cursorVectors.model.value.slice('cursor:'.length) }] }], tiers: { high: { status: 'ready' }, medium: { status: 'inherit' }, low: { status: 'inherit' } } } as GlobalModelTierOptions
  const state = new GlobalModelTiersState({
    get: async () => mapping, options: async () => catalog,
    set: async (tier, target, revision) => { writes.push({ tier, target, revision }); return { ...mapping, revision: revision + 1, [tier]: target } },
  })
  await state.load()
  state.open('high')
  expect(state.getSnapshot().editor?.modelId).toBe(modelId)
  expect(state.canSave()).toBe(true)
  expect(modelReferenceLabel(mapping.high, catalog)).toBe('Fixture Model')
  expect(writes).toEqual([])
  expect(await state.save()).toBe(true)
  expect(writes).toEqual([{ tier: 'high', target: { source: 'cursor', modelId }, revision: 4 }])
})


test('tier editing remains explicit while media defaults use conditional dropdowns', () => {
  expect(tierVectors.settingsUi.tierControl).toBe('cards-with-edit-modal')
  expect(tierVectors.settingsUi.tierDraftRequiresSave).toBe(true)
  expect(tierVectors.settingsUi.tierCancelWrites).toBe(false)
  expect(tierVectors.settingsUi.sharedImageModel).toBe(true)
  expect(tierVectors.settingsUi.sourceConfigurationOnDefaults).toBe(false)
  expect(tierVectors.settingsUi.nativeMediaModelsOnSources).toBe(false)
  expect(tierVectors.settingsUi.mediaControl).toBe('function-card-or-single-dropdown')
  expect(tierVectors.settingsUi.singleModelFunctionDropdowns).toBe(1)
  expect(tierVectors.settingsUi.multipleModelFunctionDropdowns).toBe(2)
})


test('restricted Antigravity targets can save exact native members while account state stays false', async () => {
  const mock = host()
  const modelId = 'gemini-3.8-flash-low'
  const row = { modelId: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash', available: false, reason: 'Account restricted',
    antigravityFamilyId: 'gemini-3.8-flash', antigravityVariants: [
      { value: 'antigravity:gemini-3.8-flash-high', thinkingLevel: 'high', available: false },
      { value: `antigravity:${modelId}`, thinkingLevel: 'low', available: false, reason: 'Account restricted' },
    ] }
  mock.api.options = async () => ({ ...options(), sources: [{ source: 'antigravity', status: 'ready', options: [row] }] })
  const state = new GlobalModelTiersState(mock.api)
  await state.load(); state.open('high'); state.selectSource('antigravity'); state.selectModel(modelId)
  expect(state.canSave()).toBe(true)
  expect(await state.save()).toBe(true)
  expect(mock.writes).toEqual([{ tier: 'high', target: { source: 'antigravity', modelId }, revision: 7 }])
  expect(row.available).toBe(false)
  state.open('high'); state.selectModel('unknown-member'); expect(state.canSave()).toBe(false)
  mock.api.options = async () => ({ ...options(), sources: [{ source: 'antigravity', status: 'unavailable', options: [row] }] })
  await state.load(); state.selectModel(modelId); expect(state.canSave()).toBe(false)
})
