import { expect, test } from 'bun:test'
import { visibleAntigravityModelOptions } from '../../../../shared/antigravity-presentation'
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
