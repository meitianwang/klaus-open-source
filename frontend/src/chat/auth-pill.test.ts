// The source pill names ONE conversation's provider. A mark read for another
// conversation must never paint over the visible one: while a session switch's
// read is still in flight the pill steps out of the composer row, the same
// rule the model trigger follows while its catalog loads.
import { describe, expect, test } from 'bun:test'
import { paintableAuthMode } from './auth-pill'

describe('paintableAuthMode', () => {
  test('hides until the first read lands', () => {
    expect(paintableAuthMode(null, undefined, 's1')).toBeNull()
    expect(paintableAuthMode('kimi', undefined, 's1')).toBeNull()
  })
  test('paints the mark read for the visible conversation', () => {
    expect(paintableAuthMode('kimi', 's1', 's1')).toBe('kimi')
    expect(paintableAuthMode('custom', null, null)).toBe('custom')
  })
  test('drops the previous conversation mark while a switch read is in flight', () => {
    expect(paintableAuthMode('custom', 's1', 's2')).toBeNull()
    expect(paintableAuthMode('custom', 's1', null)).toBeNull()
    expect(paintableAuthMode('kimi', null, 's2')).toBeNull()
  })
})
