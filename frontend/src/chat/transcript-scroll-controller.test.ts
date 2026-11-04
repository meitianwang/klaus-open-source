import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/session-transcript-surface-vectors.json'
import {
  BOTTOM_TOLERANCE_PX, SHORT_CONTENT_OVERFLOW_PX, ResponseSpacerRegistry,
  TranscriptScrollController, distanceFromBottom, registerTranscriptScrollController, transcriptScrollControllerFor,
} from './transcript-scroll-controller'
import { ResponseSpacerController, placementHeight } from './transcript/response-spacer'

class ScrollElement extends EventTarget {
  contentHeight = 2000
  clientHeight = 800
  clientTop = 0
  offsetHeight = 800
  isConnected = true
  visible = true
  parentElement: ScrollElement | null = null
  children: ScrollElement[] = []
  spacer: ScrollElement | null = null
  private top = 0
  private properties = new Map<string, string>()
  style: { height: string; getPropertyValue: (name: string) => string; setProperty: (name: string, value: string) => void } = {
    height: '', getPropertyValue: name => this.properties.get(name) ?? '', setProperty: (name, value) => { this.properties.set(name, value) },
  }
  isContentEditable = false
  field = false
  get scrollHeight(): number { return this.contentHeight + (Number.parseFloat(this.spacer?.style.height ?? '') || 0) }
  get scrollTop(): number { return this.top }
  set scrollTop(value: number) { this.top = Math.min(Math.max(0, value), Math.max(0, this.scrollHeight - this.clientHeight)) }
  closest(): ScrollElement | null { return this.field ? this : null }
  getClientRects(): unknown[] { return this.visible ? [{}] : [] }
  getBoundingClientRect(): { top: number; bottom: number; height: number } { return { top: 0, bottom: this.clientHeight, height: this.clientHeight } }
  emit(type: string, fields: Record<string, unknown> = {}): void {
    const event = new Event(type, { cancelable: true })
    const { target, ...values } = fields
    if (target != null) Object.defineProperty(event, 'target', { value: target })
    Object.assign(event, values)
    this.dispatchEvent(event)
  }
  wheel(deltaY: number): void { this.emit('wheel', { deltaY, deltaX: 0, ctrlKey: false, shiftKey: false }) }
  moveToDistance(distance: number): void { this.scrollTop = this.scrollHeight - this.clientHeight - distance; this.emit('scroll') }
}

const globals = globalThis as any
const names = ['HTMLElement', 'document', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame']
const originals = Object.fromEntries(names.map(name => [name, globals[name]]))
let documentEvents: EventTarget
let observers: Array<{ fire(): void; disconnected: boolean }>
let frames: Map<number, FrameRequestCallback>
let nextFrame = 0
let frameTime = 0
const controllers: TranscriptScrollController[] = []
const asElement = (element: ScrollElement): HTMLElement => element as unknown as HTMLElement
const settle = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }
const tick = (ms = 16) => {
  frameTime += ms
  const pending = [...frames.values()]
  frames.clear()
  for (const frame of pending) frame(frameTime)
}
const fixture = (options: { distance?: number; spacer?: boolean; height?: number; client?: number; button?: HTMLElement; reducedMotion?: boolean } = {}) => {
  const element = new ScrollElement()
  element.contentHeight = options.height ?? 2000
  element.clientHeight = options.client ?? 800
  element.offsetHeight = element.clientHeight
  element.moveToDistance(options.distance ?? 0)
  const controller = new TranscriptScrollController({ scrollEl: asElement(element), initialDistanceFromBottomPx: options.distance ?? 0,
    responseSpacer: options.spacer, floatButton: options.button, prefersReducedMotion: () => options.reducedMotion !== false })
  controllers.push(controller)
  return { element, controller }
}

beforeAll(() => {
  globals.HTMLElement = ScrollElement
  globals.ResizeObserver = class {
    record: { fire(): void; disconnected: boolean }
    constructor(callback: () => void) { this.record = { fire: () => { if (!this.record.disconnected) callback() }, disconnected: false }; observers.push(this.record) }
    observe() {} unobserve() {}
    disconnect() { this.record.disconnected = true }
  }
  globals.MutationObserver = undefined
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id }
  globals.cancelAnimationFrame = (id: number) => { frames.delete(id) }
})
beforeEach(() => {
  documentEvents = new EventTarget()
  globals.document = Object.assign(documentEvents, { hidden: false })
  observers = []
  frames = new Map()
  frameTime = performance.now()
})
afterEach(() => { for (const controller of controllers.splice(0)) controller.destroy() })
afterAll(() => { for (const name of names) globals[name] = originals[name] })

describe('transcript scroll input ownership', () => {
  test('matches the committed boundary tolerances', () => {
    expect(BOTTOM_TOLERANCE_PX).toBe(vectors.presentation.bottomFollowTolerancePx)
    expect(SHORT_CONTENT_OVERFLOW_PX).toBe(vectors.presentation.historyBoundaryTolerancePx)
  })

  test('upward reading releases following and only a downward return within 24px resumes it', () => {
    const { element, controller } = fixture()
    element.wheel(-40); element.moveToDistance(40)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    element.wheel(10); element.moveToDistance(25)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    element.wheel(10); element.moveToDistance(24)
    expect(controller.shouldFollowContentGrowth()).toBe(true)
  })

  test('a programmatic compensation echo inside the input window never re-arms following', () => {
    const { element, controller } = fixture()
    const moves: number[] = []
    controller.addUserScrollListener(distance => moves.push(distance))
    element.wheel(-40); element.moveToDistance(40)
    element.wheel(5); element.moveToDistance(35)
    controller.compensateScrollToDistanceFromBottomPx(12)
    element.emit('scroll')
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    expect(moves).toEqual([40, 35])
    element.contentHeight += 200
    for (const observer of observers) observer.fire()
    expect(distanceFromBottom(asElement(element))).toBe(212)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
  })

  test('layout scrolling without user input does not change the follow decision', () => {
    const { element, controller } = fixture()
    element.moveToDistance(80)
    expect(controller.shouldFollowContentGrowth()).toBe(true)
    controller.holdViewport()
    element.moveToDistance(0)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
  })

  test('opposite-direction movement does not consume directional wheel intent', () => {
    const { element, controller } = fixture({ distance: 100 })
    const moves: number[] = []
    controller.addUserScrollListener(distance => moves.push(distance))
    element.wheel(-40); element.moveToDistance(10)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    expect(moves).toEqual([])
    element.moveToDistance(40)
    expect(moves).toEqual([40])
  })

  test('proxy scrollbar input has the same following boundary as wheel input', () => {
    const { element, controller } = fixture()
    controller.noteUserScrollIntent('away'); element.moveToDistance(300)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    controller.noteUserScrollIntent('toward'); element.moveToDistance(24)
    expect(controller.shouldFollowContentGrowth()).toBe(true)
  })

  test('native scrollbar movement is user input but a pointer-triggered layout collapse is not', () => {
    const { element, controller } = fixture()
    element.emit('pointerdown', { pointerType: 'mouse' }); element.moveToDistance(200)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    controller.scrollToBottom()
    element.emit('pointerdown', { pointerType: 'mouse' })
    element.contentHeight -= 400; element.moveToDistance(0)
    expect(controller.shouldFollowContentGrowth()).toBe(true)
  })

  test('keyboard reading and touch movement release following', () => {
    for (const input of ['keyboard', 'touch']) {
      const { element, controller } = fixture()
      if (input === 'keyboard') element.emit('keydown', { key: 'PageUp', repeat: false })
      else {
        element.emit('touchstart', { touches: [{ identifier: 1, clientX: 100, clientY: 100 }] })
        element.emit('touchmove', { touches: [{ identifier: 1, clientX: 102, clientY: 130 }] })
      }
      element.moveToDistance(60)
      expect(controller.shouldFollowContentGrowth()).toBe(false)
    }
  })

  test('keyboard input in an editable field and horizontal gestures do not hijack scrolling', () => {
    const { element, controller } = fixture({ distance: 100 })
    const field = new ScrollElement(); field.field = true
    element.emit('keydown', { key: 'End', repeat: false, target: field })
    element.moveToDistance(0)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    element.field = false
    element.emit('wheel', { deltaY: 5, deltaX: 50, ctrlKey: false, shiftKey: false })
    element.moveToDistance(40)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
  })

  test('growth keeps an exactly-bottom following viewport at the end', () => {
    const { element, controller } = fixture()
    element.contentHeight += 40
    for (const observer of observers) observer.fire()
    expect(distanceFromBottom(asElement(element))).toBe(0)
    expect(controller.shouldFollowContentGrowth()).toBe(true)
    element.emit('scroll')
    element.contentHeight += 200
    for (const observer of observers) observer.fire()
    expect(distanceFromBottom(asElement(element))).toBe(0)
  })

  test('switching conversations clears old input intent before restoring its reading distance', () => {
    const { element, controller } = fixture({ distance: 100 })
    element.wheel(50); element.moveToDistance(50)
    controller.resetForConversation(120)
    controller.compensateScrollToDistanceFromBottomPx(120); element.emit('scroll')
    element.moveToDistance(10)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    expect(controller.getLastScrollDistanceFromBottomPx()).toBe(10)
  })

  test('returning to latest animates, and new reader input cancels the motion once', () => {
    const { element, controller } = fixture({ distance: 400, reducedMotion: false })
    let stopped = 0
    controller.scrollToBottom({ onStop: () => { stopped++ } })
    expect(frames.size).toBe(1)
    tick(130)
    element.emit('scroll')
    expect(distanceFromBottom(asElement(element))).toBeGreaterThan(0)
    expect(distanceFromBottom(asElement(element))).toBeLessThan(400)
    element.wheel(-10)
    expect(stopped).toBe(1)
    expect(frames.size).toBe(0)
    controller.destroy()
    expect(stopped).toBe(1)
  })

  test('destroy removes event handling and disconnects geometry observers', () => {
    const { element, controller } = fixture()
    let moves = 0
    controller.addUserScrollListener(() => moves++)
    controller.destroy()
    element.wheel(-80); element.moveToDistance(80)
    for (const observer of observers) observer.fire()
    expect(moves).toBe(0)
    expect(observers.every(observer => observer.disconnected)).toBe(true)
  })

  test('newer surface registration survives cleanup of the previous owner', () => {
    const { element, controller } = fixture()
    const old = registerTranscriptScrollController(controller)
    const replacement = new TranscriptScrollController({ scrollEl: asElement(element) })
    controllers.push(replacement)
    const release = registerTranscriptScrollController(replacement)
    const child = new ScrollElement(); child.parentElement = element
    old()
    expect(transcriptScrollControllerFor(asElement(child))).toBe(replacement)
    release()
    expect(transcriptScrollControllerFor(asElement(child))).toBeNull()
  })
})

describe('older history loading', () => {
  test('short content loads pages until it can scroll beyond the 64px boundary', async () => {
    const { element, controller } = fixture({ height: 820 })
    let pages = 0
    controller.setOlderHistoryLoader(asElement(element), async () => {
      pages++; element.contentHeight += 20; element.scrollTop += 20
      return 'continue'
    })
    await settle()
    expect(pages).toBe(3)
  })

  test('remaining near the top continues loading even when content already overflows', async () => {
    const { element, controller } = fixture({ height: 2000, distance: 1200 })
    let pages = 0
    controller.setOlderHistoryLoader(asElement(element), async () => {
      pages++
      if (pages === 3) element.scrollTop = 100
      return 'continue'
    })
    element.wheel(-40)
    await settle()
    expect(pages).toBe(3)
  })

  for (const input of ['wheel', 'keyboard', 'touch']) test(`${input} at the top asks for older history without a scroll event`, async () => {
    const { element, controller } = fixture({ height: 2000, distance: 1200 })
    let pages = 0
    controller.setOlderHistoryLoader(asElement(element), async () => { pages++; return 'stop' })
    if (input === 'wheel') element.wheel(-20)
    else if (input === 'keyboard') element.emit('keydown', { key: 'Home', repeat: false })
    else {
      element.emit('touchstart', { touches: [{ identifier: 1, clientX: 0, clientY: 0 }] })
      element.emit('touchmove', { touches: [{ identifier: 1, clientX: 0, clientY: 20 }] })
    }
    await settle()
    expect(pages).toBe(1)
  })

  test('a matched upward scroll reaches the older-page boundary at 64px, not 65px', async () => {
    const { element, controller } = fixture({ height: 2000, distance: 1120 })
    let pages = 0
    controller.setOlderHistoryLoader(asElement(element), async () => { pages++; return 'stop' })
    element.wheel(-20); element.moveToDistance(1135)
    await settle(); expect(pages).toBe(0)
    element.moveToDistance(1136)
    await settle(); expect(pages).toBe(1)
  })

  test('only visible owners load and a rejected page can be retried by a new gesture', async () => {
    const { element, controller } = fixture({ height: 2000, distance: 1200 })
    const hidden = new ScrollElement(); hidden.visible = false
    let hiddenCalls = 0, calls = 0
    controller.setOlderHistoryLoader(asElement(hidden), async () => { hiddenCalls++; return 'stop' })
    const release = controller.setOlderHistoryLoader(asElement(element), async () => { calls++; throw new Error('fixture read failure') })
    element.wheel(-20); await settle()
    element.wheel(-20); await settle()
    expect(calls).toBe(2)
    expect(hiddenCalls).toBe(0)
    release(); element.wheel(-20); await settle()
    expect(calls).toBe(2)
  })

  test('a pending request is not duplicated and teardown prevents its next page', async () => {
    const { element, controller } = fixture({ height: 820 })
    let resolve!: (outcome: 'continue') => void
    let calls = 0
    controller.setOlderHistoryLoader(asElement(element), () => { calls++; return new Promise(done => { resolve = done }) })
    await settle()
    element.scrollTop = 0; element.wheel(-20); element.emit('keydown', { key: 'Home', repeat: false })
    expect(calls).toBe(1)
    controller.destroy(); resolve('continue'); await settle()
    expect(calls).toBe(1)
  })
})

describe('newest response space', () => {
  test('matches the committed viewport and footer geometry', () => {
    for (const item of vectors.scrollBehavior.spacerCases) {
      const element = new ScrollElement()
      element.clientHeight = item.heightPx
      element.style.setProperty('--thread-scroll-padding-bottom', String(item.paddingPx))
      expect({ name: item.name, height: placementHeight(asElement(element)) }).toEqual({ name: item.name, height: item.expectedPx })
    }
  })

  test('placement is captured before the optimistic message and consumed once', () => {
    const { element, controller } = fixture({ distance: 700, spacer: true })
    controller.responseSpacerController.register({ getHeightPx: () => 400, scrollToBottom() {} })
    controller.prepareLatestTurnPlacement('chat-a')
    element.contentHeight += 300
    expect(controller.consumePendingLatestTurnPlacement('chat-a')).toEqual({ distanceFromBottomPx: 700, scrollHeightPx: 2000, shouldPlaceLatestTurn: true })
    expect(controller.consumePendingLatestTurnPlacement('chat-a')).toBeNull()
    controller.resetForConversation(701)
    controller.prepareLatestTurnPlacement('chat-a')
    expect(controller.consumePendingLatestTurnPlacement('chat-a')?.shouldPlaceLatestTurn).toBe(false)
    controller.prepareLatestTurnPlacement('chat-a'); controller.clearPendingLatestTurnPlacement('chat-a')
    expect(controller.consumePendingLatestTurnPlacement('chat-a')).toBeNull()
  })

  test('promoting a draft transfers the captured placement without recapturing layout', () => {
    const { element, controller } = fixture({ distance: 200 })
    controller.prepareLatestTurnPlacement('draft')
    element.contentHeight += 300
    controller.movePendingLatestTurnPlacement('draft', 'admitted')
    expect(controller.consumePendingLatestTurnPlacement('draft')).toBeNull()
    expect(controller.consumePendingLatestTurnPlacement('admitted')).toEqual({ distanceFromBottomPx: 200, scrollHeightPx: 2000, shouldPlaceLatestTurn: true })
  })

  test('the floating latest control subtracts the visible response space', () => {
    let shown = false, click = () => {}, pressed = 0
    const button = { classList: { toggle: (_name: string, value: boolean) => { shown = value } }, setAttribute() {}, tabIndex: 0,
      addEventListener: (_name: string, listener: () => void) => { click = listener } } as unknown as HTMLElement
    const { controller } = fixture({ distance: 424, spacer: true, button })
    const registration = controller.responseSpacerController.register({ getHeightPx: () => 400, scrollToBottom: () => { pressed++ } })
    controller.syncFloatButton(); expect(shown).toBe(false)
    controller.compensateScrollToDistanceFromBottomPx(425); expect(shown).toBe(true)
    click(); expect(pressed).toBe(1)
    registration.dispose(); controller.syncFloatButton(); expect(shown).toBe(true)
  })

  test('response growth consumes the reserve while preserving a held reading viewport', () => {
    const { element, controller } = fixture({ spacer: true, client: 900 })
    const spacerElement = new ScrollElement(); element.spacer = spacerElement
    const spacer = new ResponseSpacerController(controller)
    spacer.setElement(asElement(spacerElement))
    spacer.place()
    expect(spacer.getHeightPx()).toBe(600)
    expect(distanceFromBottom(asElement(element))).toBe(1)
    expect(controller.shouldFollowContentGrowth()).toBe(false)
    const top = element.scrollTop
    element.contentHeight += 160; spacer.consumeGrowth(160)
    expect(spacer.getHeightPx()).toBe(440)
    expect(element.scrollTop).toBe(top)
    spacer.consumeGrowth(-40); expect(spacer.getHeightPx()).toBe(440)
    spacer.consumeGrowth(1000); expect(spacer.getHeightPx()).toBe(0)
  })

  test('upward reading trims reserved space on the next frame without moving the reading position', () => {
    const { element, controller } = fixture({ spacer: true, client: 900 })
    const spacerElement = new ScrollElement(); element.spacer = spacerElement
    const spacer = new ResponseSpacerController(controller)
    spacer.setElement(asElement(spacerElement)); spacer.place()
    element.moveToDistance(101)
    spacer.handleUserScroll(101, 1)
    element.moveToDistance(141)
    const top = element.scrollTop
    spacer.handleUserScroll(141, 101)
    expect(spacer.getHeightPx()).toBe(600)
    tick()
    expect(spacer.getHeightPx()).toBe(460)
    expect(element.scrollTop).toBe(top)
    spacer.clear(); expect(frames.size).toBe(0)
  })

  test('viewport shrink refits reserved response space and clear cancels pending decay', () => {
    const { element, controller } = fixture({ spacer: true, client: 900 })
    const spacerElement = new ScrollElement(); element.spacer = spacerElement
    const spacer = new ResponseSpacerController(controller)
    spacer.setElement(asElement(spacerElement)); spacer.place()
    element.clientHeight = 600; element.offsetHeight = 600; spacer.reconcileViewport()
    expect(spacer.getHeightPx()).toBe(360)
    spacer.handleUserScroll(100, 0); spacer.clear(); tick()
    expect(spacer.getHeightPx()).toBe(0)
    expect(spacerElement.style.height).toBe('0px')
  })

  test('spacer registration cleanup cannot remove a newer owner', async () => {
    const registry = new ResponseSpacerRegistry()
    let holds = 0
    const old = registry.register({ getHeightPx: () => 100, holdViewport: () => { holds += 100 }, scrollToBottom() {} })
    const latest = registry.register({ getHeightPx: () => 200, holdViewport: () => { holds++ }, scrollToBottom() {} })
    old.clear(); old.dispose()
    expect(registry.get()?.getHeightPx()).toBe(200)
    registry.holdViewport(); expect(holds).toBe(1)
    latest.clear(); expect(registry.get()).toBeNull()
    await settle()
  })
})
