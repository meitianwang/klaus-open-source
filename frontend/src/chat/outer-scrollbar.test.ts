import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mountOuterScrollbar } from './outer-scrollbar'

type Listener = (event: any) => void
let pendingScroll = new Set<MockElement>()

// DOM scroll events arrive after the property write. Keep the delayed event
// queue and range clamping here: synchronous events hide the feedback bug.
class MockElement {
  style: Record<string, string> = {}
  children: MockElement[] = []
  className = ''
  tabIndex = 0
  classList = { add() {}, remove() {} }
  private top = 0
  private listeners = new Map<string, Listener[]>()
  height = 400
  contentHeight: number | null = null

  get firstElementChild() { return this.children[0] ?? null }
  get clientHeight() { return Number.parseFloat(this.style.height) || this.height }
  get scrollHeight() { return this.contentHeight ?? (Number.parseFloat(this.firstElementChild?.style.height ?? '') || 0) }
  get scrollTop() {
    this.scrollTop = this.top
    return this.top
  }
  set scrollTop(value: number) {
    const next = Math.min(Math.max(0, value), Math.max(0, this.scrollHeight - this.clientHeight))
    if (next !== this.top) pendingScroll.add(this)
    this.top = next
  }
  getBoundingClientRect() { return { top: 0, height: this.height } }
  setAttribute() {}
  appendChild(child: MockElement) { this.children.push(child) }
  remove() {}
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(fn => fn !== listener))
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event })
  }
}

function flushScrollEvents() {
  for (let round = 0; pendingScroll.size && round < 20; round++) {
    const events = [...pendingScroll]
    pendingScroll.clear()
    for (const element of events) element.dispatch('scroll')
  }
  expect(pendingScroll.size).toBe(0)
}

const savedDocument = globalThis.document
const savedWindow = globalThis.window
const savedResizeObserver = globalThis.ResizeObserver
const savedMutationObserver = globalThis.MutationObserver

beforeEach(() => {
  pendingScroll = new Set()
  ;(globalThis as any).document = { createElement: () => new MockElement() }
  ;(globalThis as any).window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout: () => 1, clearTimeout() {},
  }
  ;(globalThis as any).ResizeObserver = undefined
  ;(globalThis as any).MutationObserver = undefined
})

afterEach(() => {
  ;(globalThis as any).document = savedDocument
  ;(globalThis as any).window = savedWindow
  ;(globalThis as any).ResizeObserver = savedResizeObserver
  ;(globalThis as any).MutationObserver = savedMutationObserver
})

function fixture() {
  const source = new MockElement()
  source.contentHeight = 2000
  source.scrollTop = 1600
  pendingScroll.clear()
  const region = new MockElement()
  const intents: Array<'up' | 'down' | undefined> = []
  const handle = mountOuterScrollbar({
    scrollEl: source as unknown as HTMLElement,
    region: region as unknown as HTMLElement,
    onUserScrollIntent: direction => intents.push(direction),
  })!
  const proxy = region.children[0]
  return { source, proxy, intents, handle }
}

function geometryNotifications() {
  const callbacks: Array<() => void> = []
  const Observer = class {
    constructor(callback: () => void) { callbacks.push(callback) }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;(globalThis as any).ResizeObserver = Observer
  ;(globalThis as any).MutationObserver = Observer
  return callbacks
}

describe('retained outer scrollbar visibility', () => {
  test('inactive notifications and proxy gestures never write the transcript or proxy geometry', () => {
    const callbacks = geometryNotifications()
    const { source, proxy, intents, handle } = fixture()
    flushScrollEvents()
    handle.setActive(false)
    const range = proxy.firstElementChild!.style.height
    const geometry = { ...proxy.style }
    source.contentHeight = 2400; source.scrollTop = 1900
    proxy.scrollTop = 100
    source.dispatch('scroll')
    proxy.dispatch('scroll'); proxy.dispatch('wheel', { deltaY: -10 })
    proxy.dispatch('pointerdown')
    for (const callback of callbacks) callback()
    handle.sync()
    flushScrollEvents()
    expect(source.scrollTop).toBe(1900)
    expect(proxy.scrollTop).toBe(100)
    expect(proxy.firstElementChild!.style.height).toBe(range)
    expect(proxy.style).toEqual(geometry)
    expect(intents).toEqual([])
    handle.destroy()
  })

  test('reactivation keeps the same proxy and follows the restored source instead of its parked thumb', () => {
    const callbacks = geometryNotifications()
    const { source, proxy, intents, handle } = fixture()
    flushScrollEvents()
    const old = [...callbacks]
    handle.setActive(false)
    proxy.scrollTop = 100
    source.contentHeight = 2400; source.scrollTop = 1900
    handle.setActive(true)
    flushScrollEvents()
    expect(proxy.scrollTop).toBe(1900)
    expect(source.scrollTop).toBe(1900)
    expect(proxy.firstElementChild!.style.height).toBe('2400px')
    expect(intents).toEqual([])
    source.contentHeight = 2600; source.scrollTop = 2100
    for (const callback of old) callback()
    expect(proxy.firstElementChild!.style.height).toBe('2400px')
    for (const callback of callbacks.slice(old.length)) callback()
    flushScrollEvents()
    expect(source.scrollTop).toBe(2100)
    expect(proxy.scrollTop).toBe(2100)
    proxy.scrollTop = 2000
    flushScrollEvents()
    expect(source.scrollTop).toBe(2000)
    expect(intents).toEqual(['up'])
    handle.destroy()
  })

  test('destroyed inactive proxies cannot reconnect listeners or layout observation', () => {
    const callbacks = geometryNotifications()
    const { source, proxy, intents, handle } = fixture()
    flushScrollEvents()
    handle.setActive(false); handle.destroy(); handle.setActive(true)
    const range = proxy.firstElementChild!.style.height
    source.contentHeight = 2400; source.scrollTop = 1900
    proxy.scrollTop = 100
    for (const callback of callbacks) callback()
    handle.sync()
    flushScrollEvents()
    expect(source.scrollTop).toBe(1900)
    expect(proxy.scrollTop).toBe(100)
    expect(proxy.firstElementChild!.style.height).toBe(range)
    expect(intents).toEqual([])
  })
})

describe('outer scrollbar synchronization', () => {
  test('mounting reflects the existing transcript position without user intent', () => {
    const { source, proxy, intents } = fixture()
    flushScrollEvents()
    expect(proxy.scrollTop).toBe(source.scrollTop)
    expect(intents).toEqual([])
  })

  test('growth updates the proxy range before syncing and never writes a stale position back', () => {
    const { source, proxy, intents } = fixture()
    source.dispatch('scroll')
    flushScrollEvents()
    intents.length = 0
    for (let step = 0; step < 3; step++) {
      source.contentHeight! += 240
      source.scrollTop = source.scrollHeight
      flushScrollEvents()
      expect(source.scrollTop).toBe(source.scrollHeight - source.clientHeight)
      expect(proxy.scrollTop).toBe(source.scrollTop)
    }
    expect(intents).toEqual([])
  })

  test('a delayed proxy echo cannot roll back a newer transcript position', () => {
    const { source, proxy, intents } = fixture()
    source.dispatch('scroll')
    flushScrollEvents()
    intents.length = 0
    source.contentHeight! += 240
    source.scrollTop = source.scrollHeight
    pendingScroll.delete(source)
    source.dispatch('scroll')
    source.contentHeight! += 240
    source.scrollTop = source.scrollHeight
    pendingScroll.delete(proxy)
    proxy.dispatch('scroll')
    expect(source.scrollTop).toBe(2080)
    flushScrollEvents()
    expect(proxy.scrollTop).toBe(2080)
    expect(intents).toEqual([])
  })

  test('geometry clamps after a collapse do not report an upward user scroll', () => {
    const { source, proxy, intents, handle } = fixture()
    source.dispatch('scroll')
    flushScrollEvents()
    intents.length = 0
    source.contentHeight = 1100
    handle.sync()
    flushScrollEvents()
    expect(source.scrollTop).toBe(700)
    expect(proxy.scrollTop).toBe(700)
    expect(intents).toEqual([])
  })

  test('real proxy movement still reports direction and scrolls the transcript', () => {
    const { source, proxy, intents } = fixture()
    source.dispatch('scroll')
    flushScrollEvents()
    intents.length = 0
    proxy.dispatch('pointerdown')
    proxy.scrollTop = 1000
    flushScrollEvents()
    expect(source.scrollTop).toBe(1000)
    expect(intents).toEqual([undefined, 'up'])
    proxy.scrollTop = 1600
    flushScrollEvents()
    expect(source.scrollTop).toBe(1600)
    expect(intents).toEqual([undefined, 'up', 'down'])
  })

  test('geometry synchronization preserves an upward drag whose scroll event is pending', () => {
    const { source, proxy, intents, handle } = fixture()
    flushScrollEvents()
    proxy.dispatch('pointerdown')
    proxy.scrollTop = 1000
    handle.sync()
    flushScrollEvents()
    expect(source.scrollTop).toBe(1000)
    expect(proxy.scrollTop).toBe(1000)
    expect(intents).toEqual([undefined, 'up'])
  })

  test('a queued follow event cannot erase an upward drag before its proxy event arrives', () => {
    const { source, proxy, intents } = fixture()
    flushScrollEvents()
    source.contentHeight! += 240
    source.scrollTop = source.scrollHeight
    proxy.scrollTop = 1000
    // The source event was queued first. It must consume the pending movement
    // before synchronizing its position back into the thumb.
    flushScrollEvents()
    expect(source.scrollTop).toBe(1000)
    expect(proxy.scrollTop).toBe(1000)
    expect(intents).toEqual(['up'])
  })
})
