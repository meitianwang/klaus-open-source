import { describe, expect, test } from 'bun:test'
import { createRowViewport, type RowViewportEnvironment } from './row-viewport'

function fixture() {
  let width = 300
  let hidden = false
  let heights: number[] = []
  let elements: HTMLElement[] = []
  let nextFrame = 0
  let resize = () => {}
  const frames = new Map<number, FrameRequestCallback>()
  const observed = new Set<Element>()
  const listeners = new Map<string, () => void>()
  const style = {
    maxHeight: '',
    overflowY: '',
    removeProperty(name: string) { if (name === 'max-height') this.maxHeight = ''; if (name === 'overflow-y') this.overflowY = ''; return '' },
  }
  const viewport = {
    scrollTop: 0,
    style,
    getBoundingClientRect: () => ({ top: 100, width: hidden ? 0 : width }),
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as HTMLElement
  const environment: RowViewportEnvironment = {
    requestFrame(callback) { frames.set(++nextFrame, callback); return nextFrame },
    cancelFrame: handle => { frames.delete(handle) },
    observeResize(callback) {
      resize = callback
      return { observe: element => { observed.add(element) }, disconnect: () => observed.clear() }
    },
  }
  const controller = createRowViewport(viewport, environment)
  const replace = (next: number[]) => {
    heights = next
    // Removing existing children can clamp scrollTop before new rows arrive.
    viewport.scrollTop = 0
    elements = heights.map((_, index) => ({
      getBoundingClientRect: () => ({
        height: hidden ? 0 : heights[index],
        bottom: hidden ? 0 : 100 + 1 + 5 + heights.slice(0, index + 1).reduce((a, b) => a + b, 0) + index * 3 - viewport.scrollTop,
      }),
    }) as HTMLElement)
    return elements
  }
  return {
    controller, viewport, style, observed, frames, listeners,
    rows: () => elements,
    render: (identity: string, next: number[]) => controller.render(identity, () => replace(next)),
    flush() {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback(0)
    },
    resize(nextWidth: number, nextHeights = heights) { width = nextWidth; heights = nextHeights; resize() },
    hide() { hidden = true; viewport.scrollTop = 0; resize() },
    show() { hidden = false; resize() },
    scroll(top: number) { viewport.scrollTop = top; listeners.get('scroll')?.() },
  }
}

const variableRows = [17, 42, 21, 58, 24, 31, 99, 25, 50]

describe('Overview row viewport', () => {
  test('fits six actual variable-height rows including gaps and insets, keeping later rows', () => {
    const view = fixture()
    view.render('session-a/plan-a', variableRows)
    view.flush()
    expect(view.style.maxHeight).toBe('214px')
    expect(view.style.overflowY).toBe('auto')
    expect(view.rows()).toHaveLength(9)
    expect(view.observed.size).toBe(10)
  })

  test('recalculates wrapped row heights after a width change and coalesces resize bursts', () => {
    const view = fixture()
    view.render('session-a/plan-a', variableRows)
    view.flush()
    view.resize(180, [68, ...variableRows.slice(1)])
    view.resize(180)
    expect(view.frames.size).toBe(1)
    view.flush()
    expect(view.style.maxHeight).toBe('265px')
  })

  test('observes replacement rows and preserves scroll through consecutive status refreshes', () => {
    const view = fixture()
    view.render('session-a/plan-a', variableRows)
    view.flush()
    const previousRows = view.rows()
    view.scroll(120)
    view.render('session-a/plan-a', variableRows)
    view.render('session-a/plan-a', variableRows)
    view.flush()
    expect(view.viewport.scrollTop).toBe(120)
    expect(view.style.maxHeight).toBe('214px')
    expect(previousRows.every(row => !view.observed.has(row))).toBe(true)
    expect(view.rows().every(row => view.observed.has(row))).toBe(true)
    view.resize(250)
    view.flush()
    expect(view.style.maxHeight).toBe('214px')
    expect(view.viewport.scrollTop).toBe(120)
  })

  test('resets scroll on session or plan identity changes and through the lifecycle API', () => {
    const view = fixture()
    view.render('session-a/plan-a', variableRows)
    view.flush()
    for (const identity of ['session-a/plan-b', 'session-b/plan-b']) {
      view.scroll(120)
      view.render(identity, variableRows)
      view.flush()
      expect(view.viewport.scrollTop).toBe(0)
    }
    view.scroll(120)
    view.controller.reset()
    view.flush()
    expect(view.viewport.scrollTop).toBe(0)
  })

  test('clears the cap when six or fewer rows remain, including the empty state', () => {
    const view = fixture()
    for (const count of [6, 1, 0]) {
      view.render('session-a/plan-a', variableRows)
      view.flush()
      expect(view.style.maxHeight).toBe('214px')
      view.render('session-a/plan-a', variableRows.slice(0, count))
      view.flush()
      expect(view.style.maxHeight).toBe('')
      expect(view.style.overflowY).toBe('')
      expect(view.observed.size).toBe(count + 1)
    }
  })

  test('does not save zero measurements while hidden and restores after row changes and reshow', () => {
    const view = fixture()
    view.render('session-a/plan-a', variableRows)
    view.flush()
    view.scroll(120)
    view.hide()
    view.flush()
    expect(view.style.maxHeight).toBe('214px')
    view.render('session-a/plan-a', [68, ...variableRows.slice(1)])
    view.flush()
    expect(view.style.maxHeight).toBe('214px')
    view.show()
    view.flush()
    expect(view.style.maxHeight).toBe('265px')
    expect(view.viewport.scrollTop).toBe(120)
  })

  test('handles the first render while the panel is hidden', () => {
    const view = fixture()
    view.hide()
    view.render('session-a/plan-a', variableRows)
    view.flush()
    expect(view.style.maxHeight).toBe('')
    view.show()
    view.flush()
    expect(view.style.maxHeight).toBe('214px')
  })

  test('rounds fractional row bounds up without clipping the sixth row', () => {
    const view = fixture()
    view.render('session-a/plan-a', [17.2, ...variableRows.slice(1)])
    view.flush()
    expect(view.style.maxHeight).toBe('215px')
  })

  test('disposes observers and pending work when the viewport element is replaced', () => {
    const view = fixture()
    view.render('session-a/plan-a', variableRows)
    view.controller.dispose()
    expect(view.observed.size).toBe(0)
    expect(view.frames.size).toBe(0)
    expect(view.listeners.size).toBe(0)
    view.resize(100)
    expect(view.frames.size).toBe(0)
  })

  test('keeps section measurements and scrolling independent during refresh and session switches', () => {
    const agents = fixture()
    const processes = fixture()
    agents.render('session-a', variableRows)
    processes.render('session-a', Array(14).fill(30))
    agents.flush()
    processes.flush()
    expect(agents.style.maxHeight).toBe('214px')
    expect(processes.style.maxHeight).toBe('201px')
    agents.scroll(90)
    processes.scroll(210)
    agents.render('session-a', variableRows)
    agents.flush()
    expect(agents.viewport.scrollTop).toBe(90)
    expect(processes.viewport.scrollTop).toBe(210)
    processes.render('session-b', Array(14).fill(30))
    processes.flush()
    expect(processes.viewport.scrollTop).toBe(0)
    expect(agents.viewport.scrollTop).toBe(90)
    expect(processes.rows()).toHaveLength(14)
  })

  test('remeasures an empty section when its first long list arrives', () => {
    const view = fixture()
    view.render('session-a', [])
    view.flush()
    expect(view.style.maxHeight).toBe('')
    view.render('session-a', variableRows)
    view.flush()
    expect(view.style.maxHeight).toBe('214px')
    expect(view.viewport.scrollTop).toBe(0)
    expect(view.rows()).toHaveLength(9)
  })
})
