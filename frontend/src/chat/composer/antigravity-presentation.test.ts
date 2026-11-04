import { expect, test } from 'bun:test'
import { visibleAntigravityModelOptions } from '../../../../shared/antigravity-presentation'
import { antigravityModelOptions } from '../../../../main/services/antigravity-model-options'
import { antigravityThinkingLevels, antigravityVariantForThinking, pickAntigravityModelMetadata } from '../../../../shared/antigravity-model-catalog'
import { modelOptionForValue } from '../../../../shared/cursor-model-catalog'

const row = (label: string, id: string) => ({ label, value: `antigravity:${id}` })

test('menus keep the latest main families and Flash while saved older models still resolve', () => {
  const items = [row('Claude Opus 4.6', 'claude-opus-4-6-thinking'), row('Claude Opus 5.5', 'claude-opus-5-5-high'),
    row('Claude Sonnet 5.5', 'claude-sonnet-5-5-low'), row('Gemini 4 Argon', 'gemini-4-argon-medium'),
    row('Gemini 3.8 Flash', 'gemini-3.8-flash-high'), row('Gemini 3 Flash', 'gemini-3-flash'),
    row('Gemini 2.5 Pro', 'gemini-2.5-pro'), row('GPT-OSS 120B', 'gpt-oss-120b-medium'),
    row('Gemini 3.5 Flash Lite', 'gemini-3.5-flash-lite'), { label: 'Other source', value: 'codex:model' }]
  expect(visibleAntigravityModelOptions(items).map(item => item.label)).toEqual([
    'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Gemini 4 Argon', 'Gemini 3.8 Flash', 'Other source',
  ])
  expect(modelOptionForValue(items, 'antigravity:claude-opus-4-6-thinking')?.label).toBe('Claude Opus 4.6')
  const future = [...items, row('Claude Opus 5.10', 'claude-opus-5-10-high'), row('Gemini 4.2 Argon', 'gemini-4.2-argon-high')]
  expect(visibleAntigravityModelOptions(future).map(item => item.label)).toEqual([
    'Claude Sonnet 5.5', 'Gemini 3.8 Flash', 'Other source', 'Claude Opus 5.10', 'Gemini 4.2 Argon',
  ])
})

test('automatic aliases do not duplicate a full reasoning family in the menu', () => {
  const alias = row('gemini-3.8-flash-tiered', 'gemini-3.8-flash-tiered')
  const family = { ...row('Gemini 3.8 Flash', 'gemini-3.8-flash-medium'), antigravityFamilyId: 'gemini-3.8-flash' }
  expect(visibleAntigravityModelOptions([alias, family])).toEqual([family])
  expect(visibleAntigravityModelOptions([family, alias])).toEqual([family])
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
