import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createBottomSticker } from './bottom-sticker'

// The sticker touches only a handful of element properties, so a hand-rolled
// stub keeps these tests free of a DOM. Two globals need stubbing:
// requestAnimationFrame, because the sticker coalesces stick writes to one per
// frame (flushFrames() plays the browser's frame boundary), and document,
// because the sticker registers a visibilitychange listener at mount.
// ResizeObserver / MutationObserver stay undefined on purpose: with them
// absent observeContentGrowth() is inert and the tests drive scrollToBottom()
// by hand, exactly like the content observer does in the app.

type Listener = (event: any) => void

let rafQueue: Array<() => void> = []
const savedRaf = (globalThis as any).requestAnimationFrame
const savedCancelRaf = (globalThis as any).cancelAnimationFrame
const savedDocument = (globalThis as any).document

beforeAll(() => {
  ;(globalThis as any).requestAnimationFrame = (cb: () => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  }
  ;(globalThis as any).cancelAnimationFrame = () => {}
  ;(globalThis as any).document = { addEventListener: () => {} }
})

afterAll(() => {
  ;(globalThis as any).requestAnimationFrame = savedRaf
  ;(globalThis as any).cancelAnimationFrame = savedCancelRaf
  ;(globalThis as any).document = savedDocument
})

const flushFrames = () => {
  const queue = rafQueue
  rafQueue = []
  for (const cb of queue) cb()
}

function makeScrollEl(scrollHeight: number, clientHeight: number) {
  const listeners: Record<string, Listener[]> = {}
  const state = { scrollHeight, clientHeight }
  let scrollTop = 0
  const el: any = {
    get scrollTop() { return scrollTop },
    // Real elements clamp writes to the scrollable range; the stub must too,
    // or "at the bottom" assertions would measure the stub, not the sticker.
    set scrollTop(value: number) {
      scrollTop = Math.min(Math.max(0, value), Math.max(0, state.scrollHeight - state.clientHeight))
    },
    get scrollHeight() { return state.scrollHeight },
    get clientHeight() { return state.clientHeight },
    children: [],
    addEventListener: (type: string, fn: Listener) => { (listeners[type] ||= []).push(fn) },
    removeEventListener: () => {},
    dispatch: (type: string, event: Record<string, unknown> = {}) => {
      for (const fn of listeners[type] ?? []) fn({ type, ...event })
    },
    grow: (delta: number) => {
      state.scrollHeight += delta
      el.scrollTop = scrollTop
    },
    resize: (height: number) => {
      state.clientHeight = height
      el.scrollTop = scrollTop
    },
  }
  return el
}

const atBottom = (el: any) => el.scrollTop === el.scrollHeight - el.clientHeight

describe('bottom-sticker follow release', () => {
  test('renders float feedback from cached viewport geometry without measuring stream bursts', () => {
    const el = makeScrollEl(3000, 800)
    let reads = 0, writes = 0, visible = false
    Object.defineProperty(el, 'scrollHeight', { get: () => { reads++; return 3000 } })
    const button = {
      classList: { toggle: (_name: string, show: boolean) => { writes++; visible = show } },
      setAttribute: () => { writes++ },
      set tabIndex(_value: number) { writes++ },
      addEventListener() {},
    } as unknown as HTMLElement
    const sticker = createBottomSticker({ scrollEl: el, floatBtn: button })
    for (let i = 0; i < 1000; i++) sticker.syncFloatBtn()
    expect(reads).toBe(1)
    expect(visible).toBe(true)
    expect(writes).toBe(3)
    sticker.syncFloatBtn()
    flushFrames()
    expect(reads).toBe(1)
    expect(writes).toBe(3)
    el.scrollTop = 2200
    el.dispatch('scroll')
    expect(visible).toBe(false)
    expect(reads).toBe(2)
    expect(writes).toBe(6)
  })

  test('hiding the surface updates the float synchronously without measuring hidden content', () => {
    const el = makeScrollEl(3000, 800)
    let visible = true, shown = true, reads = 0
    Object.defineProperty(el, 'scrollHeight', { get: () => { reads++; return 3000 } })
    const button = {
      classList: { toggle: (_name: string, show: boolean) => { shown = show } },
      setAttribute() {}, tabIndex: 0, addEventListener() {},
    } as unknown as HTMLElement
    const sticker = createBottomSticker({ scrollEl: el, floatBtn: button, isVisible: () => visible })
    sticker.syncFloatBtn()
    visible = false
    sticker.syncFloatBtn()
    expect(reads).toBe(1)
    expect(shown).toBe(false)
  })

  test('resize notifications update the cached float while preserving a reading viewport', () => {
    const originalObserver = (globalThis as any).ResizeObserver
    const observers: Array<{ notify: () => void; targets: unknown[] }> = []
    ;(globalThis as any).ResizeObserver = class {
      entry: typeof observers[number]
      constructor(notify: () => void) { this.entry = { notify, targets: [] }; observers.push(this.entry) }
      observe(target: unknown) { this.entry.targets.push(target) }
    }
    try {
      const el = makeScrollEl(3000, 800)
      let shown = false
      const button = { classList: { toggle: (_name: string, show: boolean) => { shown = show } },
        setAttribute() {}, tabIndex: 0, addEventListener() {} } as unknown as HTMLElement
      const sticker = createBottomSticker({ scrollEl: el, floatBtn: button })
      sticker.lockForNavigation()
      const notify = observers.find(observer => observer.targets.includes(el))!.notify
      notify()
      expect(shown).toBe(true)
      el.resize(3000)
      notify()
      expect(shown).toBe(false)
      el.grow(800)
      notify()
      expect(shown).toBe(true)
      flushFrames()
      expect(el.scrollTop).toBe(0)
    } finally { (globalThis as any).ResizeObserver = originalObserver }
  })

  test('restoration and immediate return update the float before the next frame', () => {
    const el = makeScrollEl(3000, 800)
    let shown = false
    const button = { classList: { toggle: (_name: string, show: boolean) => { shown = show } },
      setAttribute() {}, tabIndex: 0, addEventListener() {} } as unknown as HTMLElement
    const sticker = createBottomSticker({ scrollEl: el, floatBtn: button })
    sticker.resetForSession(1000)
    sticker.restoreViewport(1000)
    expect(shown).toBe(true)
    sticker.scrollToBottom({ force: true, immediate: true })
    expect(shown).toBe(false)
    expect(atBottom(el)).toBe(true)
  })

  for (const hasResizeObserver of [true, false]) test(`content mutations defer geometry to ${hasResizeObserver ? 'size notifications' : 'one fallback frame'}`, () => {
    const originalResize = (globalThis as any).ResizeObserver
    const originalMutation = (globalThis as any).MutationObserver
    let notifyResize = () => {}, notifyMutation = () => {}, reads = 0
    ;(globalThis as any).ResizeObserver = hasResizeObserver ? class {
      constructor(notify: () => void) { notifyResize = notify }
      observe() {}
    } : undefined
    ;(globalThis as any).MutationObserver = class {
      constructor(notify: () => void) { notifyMutation = notify }
      observe() {}
    }
    try {
      const el = makeScrollEl(3000, 800)
      Object.defineProperty(el, 'scrollHeight', { get: () => { reads++; return 3000 } })
      const sticker = createBottomSticker({ scrollEl: el })
      sticker.lockForNavigation()
      for (let i = 0; i < 1000; i++) notifyMutation()
      expect(reads).toBe(1)
      if (hasResizeObserver) {
        flushFrames()
        expect(reads).toBe(1)
        notifyResize()
      } else flushFrames()
      expect(reads).toBe(2)
      expect(el.scrollTop).toBe(0)
    } finally {
      ;(globalThis as any).ResizeObserver = originalResize
      ;(globalThis as any).MutationObserver = originalMutation
    }
  })

  test('restores saved bottom distance without converting a reading viewport to following', () => {
    const el = makeScrollEl(3000, 800)
    const sticker = createBottomSticker({ scrollEl: el })
    sticker.resetForSession(1200)
    expect(sticker.restoreViewport(1200)).toBe(true)
    expect(el.scrollTop).toBe(1000)
    expect(sticker.isFollowing()).toBe(false)
    el.grow(300)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(1000)
    sticker.resetForSession(0)
    expect(sticker.restoreViewport(0)).toBe(true)
    expect(sticker.isFollowing()).toBe(true)
    expect(atBottom(el)).toBe(true)
  })

  test('user input or navigation takes priority over pending position restoration', () => {
    for (const interrupt of ['input', 'navigation']) {
      const el = makeScrollEl(3000, 800)
      const sticker = createBottomSticker({ scrollEl: el })
      sticker.resetForSession(1200)
      if (interrupt === 'input') sticker.noteUpwardScrollGesture()
      else sticker.lockForNavigation()
      expect(sticker.restoreViewport(1200)).toBe(false)
      expect(el.scrollTop).toBe(0)
    }
  })

  test('initial layout can follow before the next animation frame', () => {
    const el = makeScrollEl(2000, 800)
    const sticker = createBottomSticker({ scrollEl: el })
    sticker.scrollToBottom({ immediate: true })
    expect(el.scrollTop).toBe(1200)
    el.dispatch('scroll')
    el.grow(200)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(1400)
  })

  test('immediate layout respects navigation locks and upward reading gestures', () => {
    for (const pause of ['navigation', 'gesture']) {
      const el = makeScrollEl(2000, 800)
      el.scrollTop = 400
      const sticker = createBottomSticker({ scrollEl: el })
      if (pause === 'navigation') sticker.lockForNavigation()
      else sticker.noteUpwardScrollGesture()
      sticker.scrollToBottom({ immediate: true })
      expect(el.scrollTop).toBe(400)
      sticker.scrollToBottom({ force: true, immediate: true })
      expect(el.scrollTop).toBe(1200)
    }
  })

  test('streaming growth keeps the view pinned to the bottom', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    el.grow(400)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(1600)
  })

  test('content growth alone never breaks following', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    // Growth moves the bottom away without touching scrollTop: the resulting
    // scroll event (from the stick write catching up) nets to zero user
    // movement and must not read as "the user scrolled away".
    el.grow(40)
    el.dispatch('scroll')
    el.grow(400)
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })

  test('collapsing content keeps following after the browser clamps scrollTop', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    el.grow(-400)
    el.dispatch('scroll')
    expect(atBottom(el)).toBe(true)
    el.grow(300)
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })

  test('expanding the viewport keeps following after the browser clamps scrollTop', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    el.resize(1000)
    el.dispatch('scroll')
    el.grow(300)
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })

  test('a layout adjustment away from the bottom without user input keeps following', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    // A history replacement can move the browser's scroll anchor before the
    // observer catches up. That negative movement is not a reading gesture.
    el.scrollTop = 900
    el.dispatch('scroll')
    el.grow(300)
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })

  test('a pointer-triggered collapse at the bottom does not count as scrolling up', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    el.dispatch('pointerdown')
    el.grow(-400)
    el.dispatch('scroll')
    el.grow(300)
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })

  test('upward movement after scrollbar input still pauses following', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    sticker.noteUserScrollIntent()
    el.scrollTop = 600
    el.dispatch('scroll')
    el.grow(300)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(600)
  })

  test('an upward wheel breaks following even when the same-frame scroll event nets to zero', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    // The regression this pins: on a high-refresh display the stick write and
    // the user's upward scroll land in one frame, so the browser reports a
    // single scroll event whose net delta is zero and direction-from-scrollTop
    // never sees "up". The wheel gesture has to break following on its own.
    el.dispatch('wheel', { deltaY: -12 })
    el.dispatch('scroll')
    el.grow(400)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(1200)
  })

  test('upward pointer drag breaks following too', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    // Pointer moving down the glass pulls content down = scrolling toward top.
    el.dispatch('pointerdown', { clientY: 300 })
    el.dispatch('pointermove', { clientY: 340 })
    el.grow(400)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(1200)
  })

  test('upward key and touch gestures break following too', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    el.dispatch('keydown', { key: 'ArrowUp' })
    el.grow(400)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(1200)

    const touchEl = makeScrollEl(2000, 800)
    touchEl.scrollTop = 1200
    const touchSticker = createBottomSticker({ scrollEl: touchEl })
    // Finger moving down the glass pulls content down = scrolling toward top.
    touchEl.dispatch('touchstart', { touches: [{ clientY: 300 }] })
    touchEl.dispatch('touchmove', { touches: [{ clientY: 340 }] })
    touchEl.grow(400)
    touchSticker.scrollToBottom()
    flushFrames()
    expect(touchEl.scrollTop).toBe(1200)
  })

  test('scrolling back to the bottom resumes following', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    el.dispatch('wheel', { deltaY: -120 })
    el.scrollTop = 400
    el.dispatch('scroll')
    // Downward movement back into the sticky band re-arms following. The
    // intermediate event matters: direction is measured against the previous
    // scroll position, so a jump from far above straight to the bottom would
    // read as "up" and keep following released.
    el.scrollTop = 1200
    el.dispatch('scroll')
    el.scrollTop = 1600
    el.dispatch('scroll')
    el.grow(200)
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })

  test('a downward scroll that stops short of the band does not resume following', () => {
    const el = makeScrollEl(4000, 800)
    el.scrollTop = 3200
    const sticker = createBottomSticker({ scrollEl: el })
    el.dispatch('wheel', { deltaY: -120 })
    el.scrollTop = 2000
    el.dispatch('scroll')
    el.grow(400)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(2000)
  })

  test('navigation lock keeps the viewport pinned until explicitly resumed', () => {
    const el = makeScrollEl(4000, 800)
    el.scrollTop = 2000
    const sticker = createBottomSticker({ scrollEl: el })
    sticker.lockForNavigation()
    el.dispatch('wheel', { deltaY: -12 })
    el.grow(400)
    sticker.scrollToBottom()
    flushFrames()
    expect(el.scrollTop).toBe(2000)
    sticker.resumeFollowing()
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })

  test('force scroll returns to the bottom and re-arms following', () => {
    const el = makeScrollEl(2000, 800)
    el.scrollTop = 1200
    const sticker = createBottomSticker({ scrollEl: el })
    el.dispatch('wheel', { deltaY: -120 })
    el.scrollTop = 400
    el.dispatch('scroll')
    sticker.scrollToBottom({ force: true })
    flushFrames()
    expect(atBottom(el)).toBe(true)
    el.grow(300)
    sticker.scrollToBottom()
    flushFrames()
    expect(atBottom(el)).toBe(true)
  })
})
