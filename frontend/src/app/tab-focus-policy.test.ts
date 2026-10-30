import { describe, expect, test } from 'bun:test'
import { isTabFocusTraversal, installTabFocusPolicy } from './tab-focus-policy'

describe('tab focus policy', () => {
  test('only unmodified Tab requests are focus traversal', () => {
    expect(isTabFocusTraversal({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
    expect(isTabFocusTraversal({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false, shiftKey: true } as any)).toBe(true)
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(isTabFocusTraversal({ key: 'Tab', ctrlKey: false, metaKey: false, altKey: false, [modifier]: true } as any)).toBe(false)
    }
    expect(isTabFocusTraversal({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
  })

  test('cancels the browser default without consuming the keydown', () => {
    const listeners = new Set<(event: KeyboardEvent) => void>()
    const target = {
      addEventListener: (_type: string, listener: (event: KeyboardEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: KeyboardEvent) => void) => listeners.delete(listener),
    }
    const dispose = installTabFocusPolicy(target as unknown as Window)
    const calls = { defaultPrevented: 0, stopped: 0 }
    const event = {
      key: 'Tab', ctrlKey: false, metaKey: false, altKey: false,
      preventDefault: () => { calls.defaultPrevented += 1 },
      stopImmediatePropagation: () => { calls.stopped += 1 },
    } as unknown as KeyboardEvent
    for (const listener of listeners) listener(event)
    expect(calls).toEqual({ defaultPrevented: 1, stopped: 0 })
    dispose()
  })
})
