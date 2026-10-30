import { describe, expect, test } from 'bun:test'
import { browserOpenGuard, type BrowserOpenSurface } from './browser-open-request'

describe('scoped browser opens', () => {
  test('an open addressed to one task never opens in another task', () => {
    const surface: BrowserOpenSurface = { sessionId: 'a', visible: true, generation: 1 }
    const guard = browserOpenGuard({ sessionId: 'a', targetId: 'page-a', focusRevision: 7 }, () => surface)
    expect(guard()).toBe(true)
    surface.sessionId = 'b'
    expect(guard()).toBe(false)
  })

  test('an awaited open is invalid after leaving and returning to the same task', async () => {
    const surface: BrowserOpenSurface = { sessionId: 'a', visible: true, generation: 1 }
    const guard = browserOpenGuard({ sessionId: 'a' }, () => surface)
    await Promise.resolve()
    surface.generation += 2
    expect(guard()).toBe(false)
    expect(browserOpenGuard({ sessionId: 'a' }, () => surface)()).toBe(true)
  })

  test('hidden routes reject scoped opens while manual opens retain their behavior', () => {
    const surface: BrowserOpenSurface = { sessionId: 'a', visible: false, generation: 0 }
    expect(browserOpenGuard({ sessionId: 'a' }, () => surface)()).toBe(false)
    expect(browserOpenGuard({ sessionId: '' }, () => surface)()).toBe(false)
    expect(browserOpenGuard(undefined, () => surface)()).toBe(true)
  })
})
