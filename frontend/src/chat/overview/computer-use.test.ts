import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = { addEventListener: () => {} }
const { bindPipMenuPositionDismissal, computerUseSummaryVisible } = await import('./computer-use')

function surface(options: { hidden?: boolean; route?: string; panelMode?: string; collapsed?: boolean; missingPanel?: boolean; detail?: boolean } = {}) {
  return {
    hidden: options.hidden ?? false,
    body: { classList: { contains: (name: string) => name === options.route } },
    querySelector: () => options.detail ? {} : null,
    getElementById: () => options.missingPanel ? null : {
      getAttribute: () => options.panelMode ?? 'monitor',
      classList: { contains: () => options.collapsed ?? false },
    },
  } as unknown as Pick<Document, 'hidden' | 'body' | 'querySelector' | 'getElementById'>
}

describe('picture in picture summary menu lifetime', () => {
  test('a programmatic route change dismisses the menu without changing the active task', () => {
    expect(computerUseSummaryVisible(surface())).toBe(true)
    expect(computerUseSummaryVisible(surface({ route: 'settings-open' }))).toBe(false)
    expect(computerUseSummaryVisible(surface({ route: 'non-chat-view' }))).toBe(false)
    expect(computerUseSummaryVisible(surface({ detail: true }))).toBe(false)
  })
  test('changing or hiding the summary panel invalidates its portal', () => {
    for (const panelMode of ['workspace', 'diff', 'browser', 'terminal', 'side-chat']) {
      expect(computerUseSummaryVisible(surface({ panelMode }))).toBe(false)
    }
    expect(computerUseSummaryVisible(surface({ collapsed: true }))).toBe(false)
    expect(computerUseSummaryVisible(surface({ missingPanel: true }))).toBe(false)
    expect(computerUseSummaryVisible(surface({ hidden: true }))).toBe(false)
  })
  test('scrolling or resizing dismisses a positioned menu and disposal removes both listeners', () => {
    const root = new EventTarget()
    const viewport = new EventTarget()
    let closes = 0
    const stop = bindPipMenuPositionDismissal(() => { closes += 1 }, root, viewport)
    root.dispatchEvent(new Event('scroll'))
    viewport.dispatchEvent(new Event('resize'))
    expect(closes).toBe(2)
    stop()
    root.dispatchEvent(new Event('scroll'))
    viewport.dispatchEvent(new Event('resize'))
    expect(closes).toBe(2)
  })
})
