import { describe, expect, it } from 'bun:test'
import { clampedThinkingLevelFor, isThinkingHidden, isThinkingLevelValue, isThinkingToggle, itemThinkingLevels } from './thinking-ladder'

describe('native thinking ladder', () => {
  it('keeps missing, invalid and empty declarations empty', () => {
    for (const model of [null, {}, { supportedThinkingLevels: [] }, { supportedThinkingLevels: ['unknown', 'ultra'] }]) {
      expect(itemThinkingLevels(model)).toEqual([])
    }
  })
  it('returns exactly the declared native rungs in display order', () => {
    expect(itemThinkingLevels({ supportedThinkingLevels: ['high', 'low', 'ultra'] })).toEqual(['low', 'high'])
    expect(itemThinkingLevels({ supportedThinkingLevels: ['off', 'medium'] })).toEqual(['off', 'medium'])
  })
  it('hides single-rung controls and uses a toggle only for declared off and on', () => {
    expect(isThinkingHidden([])).toBe(true)
    expect(isThinkingHidden(['high'])).toBe(true)
    expect(isThinkingHidden(['low', 'high'])).toBe(false)
    expect(isThinkingToggle(['off', 'high'])).toBe(true)
    expect(isThinkingToggle(['low', 'high'])).toBe(false)
    expect(isThinkingToggle(['off', 'low', 'high'])).toBe(false)
  })
  it('does not disable thinking on unknown capability changes', () => {
    expect(clampedThinkingLevelFor({ supportedThinkingLevels: ['off'] }, 'max')).toBeNull()
    expect(clampedThinkingLevelFor(null, 'medium')).toBeNull()
  })
  it('prefers a declared default and otherwise a nearby enabled rung', () => {
    expect(clampedThinkingLevelFor({ supportedThinkingLevels: ['low', 'high'], defaultThinkingLevel: 'high' }, 'medium')).toBe('high')
    expect(clampedThinkingLevelFor({ supportedThinkingLevels: ['low', 'high'] }, 'medium')).toBe('low')
    expect(clampedThinkingLevelFor({ supportedThinkingLevels: ['low', 'high'] }, 'high')).toBeNull()
  })
  it('accepts native values and rejects orchestration as an effort', () => {
    for (const value of ['off', 'low', 'medium', 'high', 'xhigh', 'max']) expect(isThinkingLevelValue(value)).toBe(true)
    for (const value of ['ultra', 'turbo', '', null, 3]) expect(isThinkingLevelValue(value)).toBe(false)
  })
})
