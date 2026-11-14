// The source pill names ONE conversation's provider. A mark read for another
// conversation must never paint over the visible one: while a session switch's
// read is still in flight the pill steps out of the composer row, the same
// rule the model trigger follows while its catalog loads.
import { describe, expect, test } from 'bun:test'
import { paintableAuthMode, promoteWelcomeSourceMemory } from './auth-pill'

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

describe('promoteWelcomeSourceMemory', () => {
  const pillAfterSwitch = (memory: Map<string | null, string>, sessionId: string) =>
    paintableAuthMode(memory.get(sessionId) ?? null, sessionId, sessionId)

  test('promoting a welcome draft keeps the source pill painted on the new conversation', () => {
    const memory = new Map<string | null, string>([[null, 'kimi']])
    promoteWelcomeSourceMemory(memory, { sessionId: 's-new', promotedFromWelcome: true })
    expect(memory.get('s-new')).toBe('kimi')
    expect(pillAfterSwitch(memory, 's-new')).toBe('kimi')
  })

  test('promotion never overwrites a source already remembered for the target', () => {
    const memory = new Map<string | null, string>([[null, 'kimi'], ['s-new', 'custom']])
    promoteWelcomeSourceMemory(memory, { sessionId: 's-new', promotedFromWelcome: true })
    expect(memory.get('s-new')).toBe('custom')
  })

  test('ordinary session switches never inherit the welcome source', () => {
    const memory = new Map<string | null, string>([[null, 'kimi']])
    promoteWelcomeSourceMemory(memory, { sessionId: 's-other' })
    promoteWelcomeSourceMemory(memory, { sessionId: 's-other', promotedFromWelcome: false })
    promoteWelcomeSourceMemory(memory, null)
    promoteWelcomeSourceMemory(memory, undefined)
    expect(memory.has('s-other')).toBe(false)
    expect(memory.get(null)).toBe('kimi')
  })
})
