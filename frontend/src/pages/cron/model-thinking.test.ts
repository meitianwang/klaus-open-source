import { expect, test } from 'bun:test'
import type { CursorModelMetadata } from '../../../../shared/cursor-model-catalog'
import vectors from '../../../../contracts/vectors/cursor-grouped-parameters-vectors.json'
import { cronThinkingItems, cronThinkingLevels, cronThinkingSelection, cronThinkingValue } from './model-thinking'

const options = [vectors.model as typeof vectors.model & CursorModelMetadata]

test('task reasoning shows the native default and maps an explicit choice to a real exact member', () => {
  const selected = vectors.savedSelection
  expect(cronThinkingValue(options, selected, 'low')).toBe('high')
  expect(cronThinkingLevels(options, selected)).toEqual(['medium', 'high'])
  expect(cronThinkingSelection(options, selected, 'medium')).toEqual({ model: vectors.model.cursorVariants[3]!.value, thinking: 'medium' })
  expect(cronThinkingSelection(options, selected, 'off')).toBeUndefined()
  expect(cronThinkingSelection(options, selected, 'ultra')).toBeUndefined()
})

test('task reasoning preserves native context restrictions and other source defaults', () => {
  const selected = vectors.model.cursorVariants[5]!.value
  expect(cronThinkingLevels(options, selected)).toEqual(['high'])
  expect(cronThinkingSelection(options, selected, 'medium')).toBeUndefined()
  expect(cronThinkingLevels([], 'custom:configured')).toEqual([])
  expect(cronThinkingSelection([], 'custom:configured', 'medium')).toBeUndefined()
  expect(cronThinkingValue([], 'custom:configured', 'low')).toBe('low')
  expect(cronThinkingLevels([], 'cursor:removed')).toEqual([])
  expect(cronThinkingValue([], 'cursor:removed', 'high')).toBe('high')
})


test('boolean task reasoning uses On and Off while retaining native variant values', () => {
  const variants = [false, true].map(enabled => ({ value: `cursor:boolean[thinking=${enabled}]`, label: 'Boolean model', parameters: { thinking: String(enabled) }, maxMode: false }))
  const model = { value: variants[1]!.value, cursorModelId: 'boolean', cursorVariants: variants }
  expect(cronThinkingItems([model], model.value, key => ({ thinking_off: 'Off', thinking_on: 'On' } as Record<string, string>)[key] || key)).toEqual([{ value: 'off', label: 'Off' }, { value: 'high', label: 'On' }])
  expect(cronThinkingSelection([model], model.value, 'off')).toEqual({ model: variants[0]!.value, thinking: 'off' })
})
