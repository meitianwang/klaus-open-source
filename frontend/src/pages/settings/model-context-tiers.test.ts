import { describe, expect, test } from 'bun:test'
import {
  compactTokens, CONTEXT_TIER_CUSTOM, CONTEXT_TIER_DEFAULT, CONTEXT_TIER_OPTIONS, contextTierForTokens,
} from './model-shared'

// The context-window picker replaced a free-form number input: vendors publish
// a handful of fixed windows, so the form offers exactly those plus an escape
// hatch. These cases pin the tier table and the read-back formatter the model
// cards share with the picker.

describe('compactTokens reads vendor windows the way vendors print them', () => {
  test('decimal windows keep their advertised thousands', () => {
    expect(compactTokens(200000)).toBe('200K')
    expect(compactTokens(1000000)).toBe('1M')
    expect(compactTokens(128000)).toBe('128K')
  })

  test('binary windows read in kibis', () => {
    expect(compactTokens(32768)).toBe('32K')
    expect(compactTokens(65536)).toBe('64K')
    expect(compactTokens(131072)).toBe('128K')
    expect(compactTokens(262144)).toBe('256K')
    expect(compactTokens(1048576)).toBe('1M')
    expect(compactTokens(8192)).toBe('8K')
  })

  test('garbage in reads as zero, not NaN', () => {
    expect(compactTokens(undefined)).toBe('0K')
    expect(compactTokens('abc')).toBe('0K')
  })
})

describe('the context tier table is internally consistent', () => {
  test('every option value round-trips to its token count', () => {
    for (const item of CONTEXT_TIER_OPTIONS) {
      expect(Number(item.value)).toBe(item.tokens)
    }
  })

  test('labels are unique and non-empty', () => {
    const labels = CONTEXT_TIER_OPTIONS.map(item => item.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.every(label => label.length > 0)).toBe(true)
  })

  test('the default tier is one of the fixed options', () => {
    expect(CONTEXT_TIER_OPTIONS.some(item => item.value === CONTEXT_TIER_DEFAULT)).toBe(true)
  })
})

describe('contextTierForTokens maps stored windows onto the picker', () => {
  test('fixed windows select their tier', () => {
    expect(contextTierForTokens(200000)).toBe('200000')
    expect(contextTierForTokens(1048576)).toBe('1048576')
    expect(contextTierForTokens(131072)).toBe('131072')
  })

  test('off-table values fall back to custom so the number survives', () => {
    expect(contextTierForTokens(8192)).toBe(CONTEXT_TIER_CUSTOM)
    expect(contextTierForTokens(32768)).toBe(CONTEXT_TIER_CUSTOM)
    expect(contextTierForTokens(160000)).toBe(CONTEXT_TIER_CUSTOM)
  })

  test('missing or broken values land on the default tier', () => {
    expect(contextTierForTokens(undefined)).toBe(CONTEXT_TIER_DEFAULT)
    expect(contextTierForTokens(0)).toBe(CONTEXT_TIER_DEFAULT)
    expect(contextTierForTokens('abc')).toBe(CONTEXT_TIER_DEFAULT)
  })
})
