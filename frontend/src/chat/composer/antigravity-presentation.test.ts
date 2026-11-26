import { expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/antigravity-model-variants.json'
import { antigravityPresentationFamily, latestAntigravityFamilyIds, visibleAntigravityModelOptions } from '../../../../shared/antigravity-presentation'
import { antigravityModelOptions } from '../../../../main/services/antigravity-model-options'
import { antigravityThinkingLevels, antigravityVariantForThinking, pickAntigravityModelMetadata } from '../../../../shared/antigravity-model-catalog'
import { modelOptionForValue } from '../../../../shared/cursor-model-catalog'
import { type JsonObject } from '../../../../main/services/service-types'

const row = (label: string, id: string, curated = true) => ({ label, value: `antigravity:${id}`, inRecommendedSort: curated })

test('menu mirrors the service curation flag and keeps other sources', () => {
  const items = [row('Gemini 4 Carbon', 'gemini-4-carbon-medium'), row('Gemini 4 Argon', 'gemini-4-argon-medium'),
    row('Gemini 2.5 Pro', 'gemini-2.5-pro', false), row('GPT-OSS 120B (Medium)', 'gpt-oss-120b-medium'),
    { label: 'Other source', value: 'codex:model' }]
  expect(visibleAntigravityModelOptions(items).map(item => item.label)).toEqual([
    'Gemini 4 Carbon', 'Gemini 4 Argon', 'GPT-OSS 120B (Medium)', 'Other source',
  ])
  // Saved selections outside the curated menu still resolve from the full list.
  expect(modelOptionForValue(items, 'antigravity:gemini-2.5-pro')?.label).toBe('Gemini 2.5 Pro')
})

test('without curation data every delivered row stays visible', () => {
  const items = [row('Gemini 2.5 Pro', 'gemini-2.5-pro', false), row('Gemini 4 Argon', 'gemini-4-argon-medium', false),
    { label: 'Other source', value: 'codex:model' }]
  expect(visibleAntigravityModelOptions(items).map(item => item.label)).toEqual([
    'Gemini 2.5 Pro', 'Gemini 4 Argon', 'Other source',
  ])
})

test('uncurated rows stay out of a curated menu, including routing aliases', () => {
  const alias = row('gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered', false)
  const family = { ...row('Gemini 3.8 Flash', 'gemini-3.8-flash-medium'), antigravityFamilyId: 'gemini-3.8-flash' }
  expect(visibleAntigravityModelOptions([alias, family])).toEqual([family])
  expect(visibleAntigravityModelOptions([family, alias])).toEqual([family])
})

test('unknown families group by label suffix and lone variants keep their service label', () => {
  const levels = ['low', 'medium', 'high']
  const entries: JsonObject[] = levels.map((level, index) => ({ key: `gemini-4-carbon-${level}`,
      display_name: `Gemini 4 Carbon (${level[0]!.toUpperCase()}${level.slice(1)})`,
      providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel: index + 1 } }))
  entries.push({ key: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)',
    providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_OPENAI', thinkingBudget: 8192 } })
  entries.push({ key: 'gemini-5-neon-ultra', display_name: 'Gemini 5 Neon (Ultra)',
    providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel: 9 } })
  const options = entries.map(entry => ({ value: `antigravity:${entry.key}`, label: entry.display_name, available: true }))
  const grouped = antigravityModelOptions(entries, options)
  const carbon = grouped.filter(item => item.label === 'Gemini 4 Carbon')
  expect(carbon).toHaveLength(1)
  const metadata = pickAntigravityModelMetadata(carbon[0])
  expect(antigravityThinkingLevels(metadata, options[0]!.value)).toEqual(levels)
  for (const level of levels) expect(antigravityVariantForThinking(metadata, options[0]!.value, level)?.value)
    .toBe(`antigravity:gemini-4-carbon-${level}`)
  // A lone declared variant is the model itself: raw service label, no family.
  expect(grouped.some(item => item.label === 'GPT-OSS 120B (Medium)' && !item.antigravityVariants)).toBe(true)
  // An unknown effort suffix degrades to a visible plain row instead of vanishing.
  expect(grouped.some(item => item.label === 'Gemini 5 Neon (Ultra)' && !item.antigravityVariants)).toBe(true)
})

test('native levels and legacy budgets both group Flash reasoning into one model', () => {
  for (const native of [false, true]) {
    const levels = ['low', 'medium', 'high']
    const entries = levels.map((level, index) => ({ key: `gemini-3.8-flash-${level}`,
      display_name: `Gemini 3.8 Flash (${level[0]!.toUpperCase()}${level.slice(1)})`,
      providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE',
        ...(native ? { thinkingLevel: index + 1 } : { thinkingBudget: [1000, 4000, -1][index] }) } }))
    const options = entries.map(entry => ({ value: `antigravity:${entry.key}`, label: entry.display_name, available: true }))
    const grouped = antigravityModelOptions(entries, options)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.label).toBe('Gemini 3.8 Flash')
    const metadata = pickAntigravityModelMetadata(grouped[0])
    expect(antigravityThinkingLevels(metadata, options[0]!.value)).toEqual(levels)
    for (const level of levels) expect(antigravityVariantForThinking(metadata, options[0]!.value, level)?.value)
      .toBe(`antigravity:gemini-3.8-flash-${level}`)
    if (native) {
      entries[0]!.providerMetadata = { ...entries[0]!.providerMetadata, thinkingLevel: 3 }
      const invalid = antigravityModelOptions(entries, options)
      expect(invalid.some(item => item.value === options[0]!.value && !item.antigravityVariants)).toBe(true)
    }
  }
})

test('Neon has one menu row with High as the default and four concrete selections', () => {
  const variants = [['high', 'High', 3], ['xhigh', 'XHigh', 100], ['medium', 'Medium', 2], ['low', 'Low', 1]] as const
  for (const available of [true, false]) {
    const entries = variants.map(([level, label, thinkingLevel]) => ({
      key: `gemini-4-neon-${level}`, display_name: `Gemini 4 Neon (${label})`, isDefault: level === 'high',
      providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel },
    }))
    const options = entries.map(entry => ({ value: `antigravity:${entry.key}`, label: entry.display_name, available, inRecommendedSort: true }))
    const grouped = antigravityModelOptions(entries, options)
    expect(grouped).toHaveLength(1)
    const model = grouped[0]!
    expect(model).toMatchObject({ label: 'Gemini 4 Neon', value: 'antigravity:gemini-4-neon-high', inRecommendedSort: true })
    const metadata = pickAntigravityModelMetadata(model)
    const value = 'antigravity:gemini-4-neon-high'
    expect(antigravityThinkingLevels(metadata, value)).toEqual(['low', 'medium', 'high', 'xhigh'])
    for (const [level] of variants) {
      expect(antigravityVariantForThinking(metadata, value, level)?.value).toBe(`antigravity:gemini-4-neon-${level}`)
    }
  }
})

test('an unselected family prefers Medium without replacing a catalog default or saved variant', () => {
  const entries = ['high', 'xhigh', 'medium', 'low'].map((level, index) => ({
    key: `gemini-4-hydrogen-${level}`, display_name: `Gemini 4 Hydrogen (${level})`,
    isDefault: false,
    providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel: [3, 100, 2, 1][index]! },
  }))
  for (const available of [true, false]) {
    const options = entries.map(row => ({ value: `antigravity:${row.key}`, label: row.display_name, available }))
    const model = antigravityModelOptions(entries, options)[0]!
    const medium = `antigravity:gemini-4-hydrogen-${vectors.familyDefault.otherwisePreferLevel}`
    expect(model.value).toBe(medium)
    expect(antigravityVariantForThinking(pickAntigravityModelMetadata(model), medium, 'xhigh')?.value)
      .toBe('antigravity:gemini-4-hydrogen-xhigh')
    const withDefault = [{ ...entries[0]!, isDefault: true }, ...entries.slice(1)]
    expect(antigravityModelOptions(withDefault, options)[0]!.value)
      .toBe(`antigravity:gemini-4-hydrogen-${vectors.familyDefault.defaultLevel}`)
    expect(antigravityModelOptions(entries.filter(row => !row.key.endsWith('-medium')), options)[0]!.value)
      .toBe(vectors.familyDefault.absenceOfMediumFallsBackToFirst ? options[0]!.value : undefined)
  }
})

test('Carbon and Hydrogen families parse and group XHigh reasoning without leaving stray rows', () => {
  expect(antigravityPresentationFamily('antigravity:gemini-4-carbon-medium')).toEqual({
    category: 'gemini', id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', version: [4, 0],
  })
  expect(antigravityPresentationFamily('Gemini 4 Hydrogen (XHigh)')).toEqual({
    category: 'gemini', id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', version: [4, 0],
  })
  const neon = antigravityPresentationFamily('antigravity:gemini-4-neon-xhigh')
  expect(neon).toEqual({ category: 'gemini', id: 'gemini-4-neon', label: 'Gemini 4 Neon', version: [4, 0] })
  const families = [
    neon!,
    antigravityPresentationFamily('gemini-4-hydrogen-high')!,
    antigravityPresentationFamily('gemini-4-argon-medium')!,
    antigravityPresentationFamily('gemini-4-carbon-medium')!,
    antigravityPresentationFamily('gemini-3.8-flash-high')!,
  ]
  expect([...latestAntigravityFamilyIds(families)]).toEqual(['gemini-4-neon', 'gemini-3.8-flash'])

  const hydrogenEntries: JsonObject[] = [
    { key: 'gemini-4-hydrogen-low', display_name: 'Gemini 4 Hydrogen (Low)', providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel: 1 } },
    { key: 'gemini-4-hydrogen-medium', display_name: 'Gemini 4 Hydrogen (Medium)', providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel: 2 } },
    { key: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)', providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel: 3 } },
    { key: 'gemini-4-hydrogen-xhigh', display_name: 'Gemini 4 Hydrogen (XHigh)', providerMetadata: { supportsThinking: true, modelProvider: 'MODEL_PROVIDER_GOOGLE', thinkingLevel: 100 } },
  ]
  const options = hydrogenEntries.map(entry => ({ value: `antigravity:${entry.key}`, label: entry.display_name, available: true }))
  const grouped = antigravityModelOptions(hydrogenEntries, options)
  expect(grouped).toHaveLength(1)
  expect(grouped[0]!.label).toBe('Gemini 4 Hydrogen')
  const metadata = pickAntigravityModelMetadata(grouped[0])
  expect(antigravityThinkingLevels(metadata, options[0]!.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
  expect(antigravityVariantForThinking(metadata, options[0]!.value, 'xhigh')?.value).toBe('antigravity:gemini-4-hydrogen-xhigh')
})

test('Claude menus expose Max when the account catalog declares it', () => {
  const { maxKeys, withoutMax, withMax } = vectors.claude5_5Efforts
  for (const maxKey of maxKeys) {
    const prefix = maxKey.slice(0, -3)
    for (const declared of [false, true]) {
      const rows = vectors.entries.filter(entry => entry.key.startsWith(prefix) && (declared || entry.key !== maxKey))
      const entries: JsonObject[] = rows.map(entry => ({
        key: entry.key, display_name: entry.display_name,
        providerMetadata: { thinkingLevel: entry.providerMetadata.thinkingLevel ?? null },
      }))
      const options = rows.map(entry => ({ value: `antigravity:${entry.key}`, label: entry.display_name, available: entry.disabled !== true }))
      const grouped = antigravityModelOptions(entries, options)
      expect(grouped).toHaveLength(1)
      const model = grouped[0]!
      const metadata = pickAntigravityModelMetadata(model)
      expect(antigravityThinkingLevels(metadata, String(model.value))).toEqual(declared ? withMax : withoutMax)
      expect(antigravityVariantForThinking(metadata, String(model.value), 'max')?.value).toBe(declared ? `antigravity:${maxKey}` : undefined)
    }
  }
})
