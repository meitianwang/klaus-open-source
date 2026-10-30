// Geometry and stable-node contracts complement the native pointer fixture.
import { describe, expect, test } from 'bun:test'
import * as navigation from './turn-navigation'
import vectors from '../../../contracts/vectors/turn-navigation.json'

describe('turn navigation geometry', () => {
  test('rail visibility threshold matches the committed vector', () => {
    expect(navigation.MIN_TURNS).toBe(vectors.minimumTurns)
  })

  test('keeps a long assistant response assigned to the preceding user turn', () => {
    const anchors = [120, 680, 4_800, 7_200]

    expect(navigation.findActiveTurnIndex(anchors, 0)).toBe(0)
    expect(navigation.findActiveTurnIndex(anchors, 679)).toBe(0)
    expect(navigation.findActiveTurnIndex(anchors, 680)).toBe(1)
    expect(navigation.findActiveTurnIndex(anchors, 4_799)).toBe(1)
    expect(navigation.findActiveTurnIndex(anchors, 99_000)).toBe(3)
  })

  test('highlights all intersecting turns without treating the bottom edge as another turn', () => {
    for (const value of vectors.visibleRanges) expect(navigation.findVisibleTurnRange(value.tops, value.scrollTop, value.clientHeight)).toEqual(value.expected)
    expect(navigation.findVisibleTurnRange([], 0, 826)).toEqual([-1, -1])
  })

  test('selects the final turn when the transcript reaches the bottom', () => {
    const anchors = [0, 600, 1_200, 1_800, 2_400]

    expect(navigation.resolveActiveTurnIndex(anchors, 2_000, 500, 2_500)).toBe(4)
    expect(navigation.resolveActiveTurnIndex(anchors, 1_500, 500, 2_500)).toBe(2)
  })
})

describe('turn navigation suspension gate', () => {
  test('only resumes after the final nested lease is released', () => {
    const gate = navigation.createSuspensionGate()
    const sessionLease = gate.suspend('session-switch')
    const stagingLease = gate.suspend('subagent-staging')

    expect(gate.isSuspended()).toBe(true)
    expect(gate.release(sessionLease)).toBe(false)
    expect(gate.isSuspended()).toBe(true)
    expect(gate.release(stagingLease)).toBe(true)
    expect(gate.isSuspended()).toBe(false)
    expect(gate.release(stagingLease)).toBe(false)
  })
})

describe('turn navigation preview text', () => {
  test('caps an excerpt at the requested compact limit', () => {
    const preview = navigation.normalizePreviewText('A'.repeat(200), 120)

    expect(preview.length).toBe(120)
    expect(preview.endsWith('…')).toBe(true)
  })
})

// Minimal DOM stub: enough surface for createTurnNavigationController so the
// streaming-path invariants (incremental marker diff, no inline style writes)
// are pinned without a browser.
describe('turn navigation rail rebuild', () => {
  function fakeStyle() {
    const calls: string[] = []
    return {
      calls,
      setProperty: (name: string) => { calls.push(name) },
      removeProperty: () => {},
    }
  }

  function fakeEl(tag: string, doc: any) {
    const el: any = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      innerHTML: '',
      eventHandlers: {} as Record<string, Function>,
      children: [] as any[],
      parentElement: null as any,
      dataset: {} as Record<string, string>,
      style: fakeStyle(),
      attributes: {} as Record<string, string>,
      hidden: false,
      inert: false,
      tabIndex: -1,
      type: '',
      className: '',
      id: '',
      textContent: '',
      isConnected: true,
      scrollTop: 0,
      clientHeight: 500,
      scrollHeight: 1000,
      ownerDocument: doc,
      classList: {
        set: new Set<string>(),
        add(name: string) { this.set.add(name) },
        remove(name: string) { this.set.delete(name) },
        toggle(name: string, on?: boolean) { on ? this.set.add(name) : this.set.delete(name) },
        contains(name: string) { return this.set.has(name) },
      },
      setAttribute(name: string, value: string) { el.attributes[name] = String(value) },
      removeAttribute(name: string) { delete el.attributes[name] },
      getAttribute(name: string) { return el.attributes[name] ?? null },
      appendChild(child: any) { child.parentElement = el; el.children.push(child); return child },
      removeChild(child: any) {
        const at = el.children.indexOf(child)
        if (at >= 0) el.children.splice(at, 1)
        return child
      },
      remove() { el.parentElement?.removeChild(el); el.parentElement = null },
      insertBefore(child: any, before: any) {
        child.parentElement?.removeChild(child)
        const at = before ? el.children.indexOf(before) : el.children.length
        el.children.splice(at, 0, child)
        child.parentElement = el
        return child
      },
      get lastElementChild() { return el.children.at(-1) ?? null },
      querySelectorAll(selector: string) {
        const found: any[] = []
        const visit = (root: any) => { for (const child of root.children) { if (child.matches(selector)) found.push(child); visit(child) } }
        visit(el)
        return found
      },
      matches(selector: string) {
        if (selector === 'button') return el.tagName === 'BUTTON'
        if (selector === '[data-nav-turn="true"]') return el.dataset.navTurn === 'true'
        if (selector.startsWith('.')) return String(el.className).split(' ').includes(selector.slice(1))
        return selector.startsWith('[') && Object.hasOwn(el.attributes, selector.slice(1, -1))
      },
      replaceChildren(...nodes: any[]) { el.children = nodes; nodes.forEach((n: any) => { n.parentElement = el }) },
      get lastChild() { return el.children[el.children.length - 1] ?? null },
      contains(node: any) { return node === el || el.children.some((child: any) => child.contains(node)) },
      getBoundingClientRect: () => ({ top: el.children.indexOf(el) * 100, left: 60, width: 32, height: 10 }),
      addEventListener: (name: string, fn: Function) => { el.eventHandlers[name] = fn },
      removeEventListener: (name: string) => { delete el.eventHandlers[name] },
      setPointerCapture: () => {},
      releasePointerCapture: () => {},
      hasPointerCapture: () => false,
      focus: () => {},
      scrollTo: () => {},
      closest(selector: string) {
        for (let node = el; node; node = node.parentElement) {
          if (selector.split(',').some(part => node.matches(part.trim()))) return node
        }
        return null
      },
      querySelector: (selector: string) => el.querySelectorAll(selector)[0] ?? null,
    }
    return el
  }

  function fakeDoc() {
    const doc: any = {
      createElement: (tag: string) => fakeEl(tag, doc),
      createDocumentFragment: () => fakeEl('fragment', doc),
      createTreeWalker: () => ({ nextNode: () => null }),
      activeElement: null,
      Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
      defaultView: null as any,
    }
    const win: any = {
      // Synchronous rAF returning a falsy handle: the controller's
      // `if (refreshFrame) return` coalescing must not latch across calls.
      requestAnimationFrame: (cb: FrameRequestCallback) => { cb(0); return 0 },
      cancelAnimationFrame: () => {},
      matchMedia: () => ({ matches: false }),
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
      NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
      innerHeight: 800,
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: (cb: () => void) => setTimeout(cb, 0),
      clearTimeout: (id: unknown) => clearTimeout(id as any),
    }
    doc.defaultView = win
    return doc
  }

  function makeRail(turnCount: number) {
    const doc = fakeDoc()
    const scrollEl = fakeEl('div', doc)
    for (let index = 0; index < turnCount; index += 1) {
      const anchor = fakeEl('div', doc)
      anchor.dataset.navTurn = 'true'
      anchor.parentElement = scrollEl
      anchor.getBoundingClientRect = () => ({ top: index * 400, left: 120, width: 600, height: 380 })
      scrollEl.children.push(anchor)
    }
    const railEl = fakeEl('nav', doc)
    const listEl = fakeEl('div', doc)
    const tooltipEl = fakeEl('div', doc)
    const controller = navigation.createTurnNavigationController({
      scrollEl, railEl, listEl, tooltipEl,
      translate: (_key, fallback) => fallback || '',
      onNavigate: () => true,
    })
    return { controller, scrollEl, listEl, tooltipEl, doc }
  }

  test('appends one marker per new turn and keeps existing marker identity', () => {
    const { controller, scrollEl, listEl, doc } = makeRail(5)
    expect(listEl.querySelectorAll('button').length).toBe(5)
    const before = listEl.querySelectorAll('button')

    // Streaming appends a turn: the MutationObserver path collapses into one
    // structure refresh, which must diff instead of replacing every marker.
    const anchor = fakeEl('div', doc)
    anchor.dataset.navTurn = 'true'
    anchor.parentElement = scrollEl
    anchor.getBoundingClientRect = () => ({ top: 2000, left: 60, width: 600, height: 380 })
    scrollEl.children.push(anchor)
    controller!.refresh()

    expect(listEl.querySelectorAll('button').length).toBe(6)
    for (let index = 0; index < 5; index += 1) {
      expect(listEl.querySelectorAll('button')[index]).toBe(before[index])
    }
    controller!.destroy()
  })

  test('keeps website icons in hover previews when repeated outputs share a turn', () => {
    const { controller, scrollEl, listEl, doc, tooltipEl } = makeRail(3)
    const anchors = [...scrollEl.children]
    const markers = [...listEl.querySelectorAll('button')]
    const wrapper = fakeEl('div', doc)
    wrapper.setAttribute('data-klaus-transcript-turn', '')
    scrollEl.insertBefore(wrapper, anchors[1])
    wrapper.appendChild(anchors[1])
    scrollEl.removeChild(anchors[1])
    const card = fakeEl('div', doc)
    card.setAttribute('data-site-reference', '')
    card.dataset.siteTitle = 'Team dashboard'
    card.dataset.siteUrl = 'https://example.com/dashboard'
    wrapper.appendChild(card)
    const repeated = fakeEl('div', doc)
    repeated.setAttribute('data-site-reference', '')
    repeated.dataset.siteTitle = card.dataset.siteTitle
    repeated.dataset.siteUrl = card.dataset.siteUrl
    wrapper.appendChild(repeated)
    controller!.refresh()

    expect(listEl.querySelectorAll('button')).toEqual(markers)
    expect(markers[1].getAttribute('data-turn-output')).toBe('website')
    expect(markers[1].querySelectorAll('[data-turn-output-icon]')).toHaveLength(vectors.websiteOutputs.markerIconsPerTurn)
    expect(markers[1].getAttribute('aria-label')).toBe('User message 2 of 3 · Website')
    expect(markers[0].getAttribute('data-turn-output')).toBeNull()
    expect(navigation.websiteOutputForTurn(anchors[1])).toEqual({ title: 'Team dashboard', url: 'https://example.com/dashboard' })
    controller!.setChatActive(true)
    listEl.eventHandlers.focusin({ target: markers[1] })
    expect(tooltipEl.querySelector('[data-turn-output-icon]')?.parentElement?.lastElementChild?.textContent).toBe('Website · Team dashboard')
    expect(tooltipEl.querySelectorAll('[data-turn-output-icon]')).toHaveLength(Number(vectors.websiteOutputs.previewIncludesIcon))
    expect(tooltipEl.querySelector('[data-turn-output-icon]')?.innerHTML).toContain('<svg')

    card.remove()
    repeated.remove()
    controller!.refresh()
    expect(listEl.querySelectorAll('button')).toEqual(markers)
    expect(markers[1].getAttribute('data-turn-output')).toBeNull()
    expect(markers[1].querySelectorAll('[data-turn-output-icon]')).toHaveLength(0)
    expect(markers[1].getAttribute('aria-label')).toBe('User message 2 of 3')
    controller!.destroy()
  })

  test('attaches website output to only the first existing marker when a turn has steering messages', () => {
    const { controller, scrollEl, listEl, doc } = makeRail(3)
    const first = scrollEl.children[0]
    const steering = scrollEl.children[1]
    const wrapper = fakeEl('div', doc)
    wrapper.setAttribute('data-klaus-transcript-turn', '')
    scrollEl.insertBefore(wrapper, first)
    wrapper.appendChild(first)
    wrapper.appendChild(steering)
    scrollEl.removeChild(first)
    scrollEl.removeChild(steering)
    const card = fakeEl('div', doc)
    card.setAttribute('data-site-reference', '')
    card.dataset.siteTitle = 'Team dashboard'
    card.dataset.siteUrl = 'https://example.com/dashboard'
    wrapper.appendChild(card)
    controller!.refresh()

    const markers = listEl.querySelectorAll('button')
    expect(markers).toHaveLength(3)
    expect(markers.filter((marker: any) => marker.getAttribute('data-turn-output') === 'website')).toHaveLength(vectors.websiteOutputs.markersPerTurn)
    expect(markers[0].getAttribute('data-turn-output')).toBe('website')
    expect(markers[1].getAttribute('data-turn-output')).toBeNull()
    expect(navigation.websiteOutputForTurn(steering)).toBeNull()
    controller!.destroy()
  })

  test('a resumed logical turn decorates its original marker across chronological segments', () => {
    const { controller, scrollEl, listEl, doc } = makeRail(3)
    const anchors = [...scrollEl.children]
    const original = fakeEl('div', doc)
    original.setAttribute('data-klaus-transcript-turn', '')
    original.setAttribute('data-klaus-transcript-turn-id', 'a')
    scrollEl.insertBefore(original, anchors[0]); original.appendChild(anchors[0]); scrollEl.removeChild(anchors[0])
    const resumed = fakeEl('div', doc)
    resumed.setAttribute('data-klaus-transcript-turn', '')
    resumed.setAttribute('data-klaus-transcript-turn-id', 'a')
    scrollEl.insertBefore(resumed, anchors[2]); resumed.appendChild(anchors[2]); scrollEl.removeChild(anchors[2])
    const card = fakeEl('div', doc)
    card.setAttribute('data-site-reference', '')
    card.dataset.siteTitle = 'Resumed dashboard'; card.dataset.siteUrl = 'https://example.com/dashboard'
    resumed.appendChild(card); controller!.refresh()
    const markers = listEl.querySelectorAll('button')
    expect(markers[0].getAttribute('data-turn-output')).toBe('website')
    expect(markers[1].getAttribute('data-turn-output')).toBeNull()
    expect(markers[2].getAttribute('data-turn-output')).toBeNull()
    expect(navigation.websiteOutputForTurn(anchors[0])?.title).toBe('Resumed dashboard')
    controller!.destroy()
  })

  test('does not mark a turn for hidden website cards', () => {
    const { controller, scrollEl, listEl, doc } = makeRail(2)
    const anchor = scrollEl.children[0]
    const wrapper = fakeEl('div', doc)
    wrapper.setAttribute('data-klaus-transcript-turn', '')
    scrollEl.insertBefore(wrapper, anchor)
    wrapper.appendChild(anchor)
    scrollEl.removeChild(anchor)
    const card = fakeEl('div', doc)
    card.setAttribute('data-site-reference', '')
    card.setAttribute('hidden', '')
    wrapper.appendChild(card)
    controller!.refresh()

    expect(navigation.websiteOutputForTurn(anchor)).toBeNull()
    expect(listEl.querySelectorAll('button')[0].getAttribute('data-turn-output')).toBeNull()
    controller!.destroy()
  })

  test('never writes per-marker inline styles; active turn is an attribute', () => {
    const { controller, scrollEl, listEl } = makeRail(5)
    controller!.setChatActive(true)
    for (const button of listEl.querySelectorAll('button')) {
      expect(button.style.calls).toEqual([])
    }
    // Bottom of the transcript: the final turn owns aria-current.
    scrollEl.scrollTop = scrollEl.scrollHeight
    controller!.refresh()
    const currents = listEl.querySelectorAll('button').filter((b: any) => b.getAttribute('aria-current') === 'location')
    expect(currents.length).toBe(1)
    expect(listEl.querySelectorAll('button').indexOf(currents[0])).toBe(4)
    for (const button of listEl.querySelectorAll('button')) {
      expect(button.style.calls).toEqual([])
    }
    controller!.destroy()
  })
})
