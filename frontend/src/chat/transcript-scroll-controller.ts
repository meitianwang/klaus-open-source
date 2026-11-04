// Scroll controller for a transcript viewport.
//
// The position is modelled as the distance from the bottom of the content.
// Content inserted or resized above the reader leaves that distance unchanged,
// so prepending history and hydrating older turns never needs a correction.
//
// Ownership rules:
// - Only user input changes whether the view follows new content. A scroll
//   counts as user scrolling when its direction matches a recent wheel, key,
//   touch or scrollbar-drag intent. Programmatic writes record the resulting
//   distance synchronously, so the scroll event they cause carries no movement
//   and can never be mistaken for the reader.
// - Scrolling away from the bottom stops following. Scrolling toward the bottom
//   and ending within BOTTOM_TOLERANCE_PX resumes it.
// - Layout growth keeps the view at the bottom only while it is following and
//   the last recorded distance is exactly zero.
// - Reaching the top (by wheel, key, touch or a matching scroll) asks the
//   surface for older history in a bounded loop.

export const BOTTOM_TOLERANCE_PX = 24
/** Overflow below which the content is "short" and older history loads on its own. */
export const SHORT_CONTENT_OVERFLOW_PX = 64
const SCROLL_TO_BOTTOM_DURATION_MS = 260
const TOUCH_INTENT_THRESHOLD_PX = 8
const USER_INTENT_DECAY_MS = 1000

export type ScrollDirection = 'away' | 'toward'
export type ScrollSource = 'system' | 'user'
export type OlderHistoryLoader = () => Promise<'stop' | 'continue'>

export interface ScrollToBottomOptions {
  /** Defaults to true; false scrolls once without resuming following. */
  followContentGrowth?: boolean
  durationMs?: number
  onStop?: () => void
}

/** The latest turn's response spacer, as the scroll surface sees it. */
export interface RegisteredResponseSpacer {
  getHeightPx(): number
  holdViewport?(): void
  scrollToBottom(): void
}

/** One spacer at a time owns the surface; the latest registration wins. */
export class ResponseSpacerRegistry {
  private current: { spacer: RegisteredResponseSpacer | null; holdViewport?: () => void } | null = null
  private readonly listeners = new Set<() => void>()
  get(): RegisteredResponseSpacer | null | undefined { return this.current?.spacer }
  holdViewport = (): void => { this.current?.holdViewport?.() }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  register(spacer: RegisteredResponseSpacer | null): { clear(): void; notifyHeightChange(): void; dispose(): void } {
    const entry = { spacer, holdViewport: spacer?.holdViewport }
    this.current = entry
    queueMicrotask(this.notify)
    return {
      clear: () => { if (this.current === entry && entry.spacer != null) { entry.spacer = null; this.notify() } },
      notifyHeightChange: () => { if (this.current === entry) this.notify() },
      dispose: () => { if (this.current === entry) { this.current = null; queueMicrotask(this.notify) } },
    }
  }
  private notify = (): void => { for (const listener of this.listeners) listener() }
}

/** Where a message sent from the composer should leave the reader. */
export interface PendingLatestTurnPlacement {
  distanceFromBottomPx: number
  scrollHeightPx: number | null
  shouldPlaceLatestTurn: boolean
}
/** Sending within this distance of the latest content places the new turn near the top. */
export const PLACE_LATEST_TURN_MAX_DISTANCE_PX = 300

export interface TranscriptScrollControllerOptions {
  scrollEl: HTMLElement
  /** The floating "scroll to latest" control; shown while the view sits above the bottom. */
  floatButton?: HTMLElement | null
  /** Surfaces hidden with display:none must not show the float button. */
  isVisible?: () => boolean
  /** Reduced motion turns the animated return to the bottom into an instant write. */
  prefersReducedMotion?: () => boolean
  initialDistanceFromBottomPx?: number
  /** Surfaces with a latest-turn response spacer (the main conversation). */
  responseSpacer?: boolean
}

/** Distance between the bottom of the viewport and the bottom of the content. */
export function distanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
}

function scrollTopFor(element: HTMLElement, distance: number): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - Math.max(0, distance))
}

function writeDistance(element: HTMLElement, distance: number): void {
  const top = scrollTopFor(element, distance)
  if (element.scrollTop !== top) element.scrollTop = top
}

function keyIntent(event: KeyboardEvent, scrollEl: HTMLElement): ScrollDirection | null {
  if (event.defaultPrevented || event.repeat) return null
  const target = event.target
  if (target instanceof HTMLElement && target !== scrollEl && (target.isContentEditable
    || target.closest('input, select, textarea') != null
    || (event.key === ' ' || event.key === 'Spacebar') && target.closest('button, [role="button"]') != null)) return null
  switch (event.key) {
    case 'ArrowUp': case 'Home': case 'PageUp': return 'away'
    case ' ': case 'Spacebar': return event.shiftKey ? 'away' : 'toward'
    case 'ArrowDown': case 'End': case 'PageDown': return 'toward'
    default: return null
  }
}

export class TranscriptScrollController {
  readonly scrollEl: HTMLElement
  private readonly floatButton: HTMLElement | null
  private readonly isVisible: () => boolean
  private readonly prefersReducedMotion: () => boolean
  private lastDistance: number
  private unrounded: { requested: number; actual: number } | null = null
  private scrolledFromBottom = false
  private following: boolean
  private intent: { direction: ScrollDirection; lastAtMs: number } | null = null
  private scrollbarDrag: { scrollHeightPx: number; scrollTopPx: number } | null = null
  private touchStart: Touch | null = null
  private animating = false
  private animationFrame = 0
  private animationStop: (() => void) | undefined
  private timedAnimation = false
  readonly responseSpacerController = new ResponseSpacerRegistry()
  private readonly usesResponseSpacer: boolean
  private readonly pendingPlacements = new Map<string, PendingLatestTurnPlacement>()
  private readonly scrollListeners = new Set<(distance: number) => void>()
  private readonly userScrollListeners = new Set<(distance: number, previous: number) => void>()
  private readonly olderHistoryLoaders = new Map<HTMLElement, { loader: OlderHistoryLoader; autoLoad: boolean }>()
  private historyLoopRunning = false
  private historyLoopToken: object | null = null
  private observedSize: { client: number; scroll: number } | null = null
  private floatShown: boolean | undefined
  private readonly abort = new AbortController()
  private readonly resizeObserver: ResizeObserver | null
  private readonly growthObserver: ResizeObserver | null
  private growthTop = 0
  private contentObservationFrame = 0
  private readonly observedContent = new Set<Element>()

  constructor(options: TranscriptScrollControllerOptions) {
    this.scrollEl = options.scrollEl
    this.floatButton = options.floatButton ?? null
    this.isVisible = options.isVisible ?? (() => true)
    this.prefersReducedMotion = options.prefersReducedMotion
      ?? (() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
    const initial = Math.max(0, options.initialDistanceFromBottomPx ?? 0)
    this.lastDistance = initial > BOTTOM_TOLERANCE_PX ? initial : 0
    this.following = this.lastDistance <= BOTTOM_TOLERANCE_PX
    this.scrolledFromBottom = this.lastDistance > BOTTOM_TOLERANCE_PX
    this.usesResponseSpacer = options.responseSpacer === true
    this.responseSpacerController.subscribe(() => this.syncFloatButton())
    const listen = { passive: true, signal: this.abort.signal } as const
    const element = this.scrollEl
    element.addEventListener('scroll', this.onScroll, listen)
    element.addEventListener('wheel', this.onWheel, listen)
    element.addEventListener('keydown', this.onKeyDown, { signal: this.abort.signal })
    element.addEventListener('pointerdown', this.onPointerDown, listen)
    element.addEventListener('pointerup', this.clearScrollbarDrag, listen)
    element.addEventListener('pointercancel', this.clearScrollbarDrag, listen)
    element.addEventListener('touchstart', this.onTouchStart, listen)
    element.addEventListener('touchmove', this.onTouchMove, listen)
    element.addEventListener('touchend', this.clearTouch, listen)
    element.addEventListener('touchcancel', this.clearTouch, listen)
    this.floatButton?.addEventListener('click', () => {
      const spacer = this.getResponseSpacer()
      if (spacer == null) this.scrollToBottom()
      else spacer.scrollToBottom()
    }, { signal: this.abort.signal })
    if (typeof ResizeObserver === 'function') {
      // Short content: load older history until the viewport can scroll.
      this.resizeObserver = new ResizeObserver(this.onResizeForHistory)
      this.resizeObserver.observe(element)
      // Bottom-anchored growth: keep a following, exactly-bottom view at the bottom.
      this.growthTop = element.scrollTop
      this.growthObserver = new ResizeObserver(this.onGrowth)
      this.growthObserver.observe(element)
      this.observeContent()
    } else {
      this.resizeObserver = null
      this.growthObserver = null
    }
    if (typeof MutationObserver === 'function') {
      const mutations = new MutationObserver(() => this.observeContent())
      mutations.observe(element, { childList: true })
      this.abort.signal.addEventListener('abort', () => mutations.disconnect())
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange, { signal: this.abort.signal })
  }

  destroy(): void {
    this.cancelAnimation()
    this.abort.abort()
    this.resizeObserver?.disconnect()
    this.growthObserver?.disconnect()
    if (this.contentObservationFrame) cancelAnimationFrame(this.contentObservationFrame)
    this.historyLoopToken = null
  }

  // ---- read side ---------------------------------------------------------

  getScrollElement(): HTMLElement { return this.scrollEl }
  getLastScrollDistanceFromBottomPx(): number { return this.lastDistance }
  /** The fractional distance a previous instant write asked for, when layout rounded it. */
  getUnroundedScrollDistanceFromBottomPx(distance: number): number {
    return this.unrounded?.actual === distance ? this.unrounded.requested : distance
  }
  isScrolledFromBottom(): boolean { return this.scrolledFromBottom }
  /** The registered spacer, or null on surfaces without one. */
  getResponseSpacer(): RegisteredResponseSpacer | null {
    if (!this.usesResponseSpacer) return null
    return this.responseSpacerController.get() ?? null
  }
  shouldFollowContentGrowth(): boolean { return this.following }
  hasResponseSpacer(): boolean { return this.usesResponseSpacer }

  /** Subscribe to every recorded distance; the listener runs once immediately. */
  addScrollListener(listener: (distance: number) => void): () => void {
    this.scrollListeners.add(listener)
    listener(this.lastDistance)
    return () => { this.scrollListeners.delete(listener) }
  }

  /** Subscribe to scrolling that the reader caused. */
  addUserScrollListener(listener: (distance: number, previous: number) => void): () => void {
    this.userScrollListeners.add(listener)
    return () => { this.userScrollListeners.delete(listener) }
  }

  // ---- write side --------------------------------------------------------

  /**
   * Measured rows commit their wrapper and list heights in one transaction.
   * Outer content probes resume next frame so a shallower ResizeObserver is
   * never invalidated after it has already delivered this frame's observation.
   */
  prepareMeasuredLayout(): void {
    for (const content of this.observedContent) {
      this.growthObserver?.unobserve(content)
      this.resizeObserver?.unobserve(content)
    }
    if (this.contentObservationFrame) return
    this.contentObservationFrame = requestAnimationFrame(() => {
      this.contentObservationFrame = 0
      if (this.abort.signal.aborted) return
      for (const content of this.observedContent) {
        this.growthObserver?.observe(content)
        this.resizeObserver?.observe(content)
      }
      this.onResizeForHistory()
    })
  }

  /** A system or user request to show a specific distance from the bottom. */
  scrollToDistanceFromBottomPx(distancePx: number, behavior: ScrollBehavior = 'instant', source: ScrollSource = 'system'): void {
    const previous = this.lastDistance
    const distance = Math.max(0, distancePx)
    if (distance > BOTTOM_TOLERANCE_PX) this.cancelAnimation()
    if (distance === 0) this.following = true
    this.write(behavior, () => distance)
    if (source === 'user' && this.lastDistance !== previous) this.userScrolled(this.lastDistance, previous)
  }

  /** Keep a measured anchor in place after layout above or below it changed. */
  compensateScrollToDistanceFromBottomPx(distancePx: number): void {
    if (!this.animating) this.write('instant', () => distancePx)
  }

  /** Stop following and keep the current position (navigation, placement). */
  holdViewport(): void {
    this.cancelAnimation()
    this.following = false
    this.responseSpacerController.holdViewport()
  }

  /** Record where a message sent now from the composer leaves the reader. */
  prepareLatestTurnPlacement(conversationId: string): void {
    const distance = this.lastDistance
    const spacer = this.getResponseSpacer()?.getHeightPx() ?? 0
    this.pendingPlacements.set(conversationId, {
      distanceFromBottomPx: distance, scrollHeightPx: this.scrollEl.scrollHeight,
      shouldPlaceLatestTurn: distance - spacer <= PLACE_LATEST_TURN_MAX_DISTANCE_PX,
    })
  }

  movePendingLatestTurnPlacement(from: string, to: string): void {
    const pending = this.pendingPlacements.get(from)
    if (!pending || from === to) return
    this.pendingPlacements.delete(from)
    this.pendingPlacements.set(to, pending)
  }

  clearPendingLatestTurnPlacement(conversationId: string): void {
    this.pendingPlacements.delete(conversationId)
  }

  consumePendingLatestTurnPlacement(conversationId: string): PendingLatestTurnPlacement | null {
    const pending = this.pendingPlacements.get(conversationId) ?? null
    this.pendingPlacements.delete(conversationId)
    return pending
  }

  /** Return to the bottom: instant when already close, otherwise eased over a short duration. */
  scrollToBottom(options: ScrollToBottomOptions = {}): void {
    const element = this.scrollEl
    this.following = options.followContentGrowth !== false
    const start = distanceFromBottom(element)
    if (this.prefersReducedMotion() || start <= BOTTOM_TOLERANCE_PX) {
      this.write('instant', () => 0)
      this.cancelAnimation()
      options.onStop?.()
      return
    }
    this.beginAnimation()
    this.animationStop = options.onStop
    this.timedAnimation = options.durationMs != null
    const startedAt = performance.now()
    const step = (now: number) => {
      if (!this.scrollEl.isConnected) { this.cancelAnimation(); return }
      const progress = Math.min(1, (now - startedAt) / (options.durationMs ?? SCROLL_TO_BOTTOM_DURATION_MS))
      const eased = 1 - (1 - progress) ** 3
      writeDistance(element, start * (1 - eased))
      if (progress < 1 && (options.durationMs != null || distanceFromBottom(element) > BOTTOM_TOLERANCE_PX)) {
        this.animationFrame = requestAnimationFrame(step)
      } else {
        this.write('instant', () => 0)
        this.cancelAnimation()
      }
    }
    this.animationFrame = requestAnimationFrame(step)
  }

  /** A newly shown conversation starts at its saved distance (or the bottom). */
  resetForConversation(distanceFromBottomPx: number): void {
    this.cancelAnimation()
    this.unrounded = null
    this.intent = null
    this.scrollbarDrag = null
    const distance = distanceFromBottomPx > BOTTOM_TOLERANCE_PX ? distanceFromBottomPx : 0
    this.lastDistance = distance
    this.following = distance <= BOTTOM_TOLERANCE_PX
    this.scrolledFromBottom = distance > BOTTOM_TOLERANCE_PX
    this.syncFloatButton()
  }

  /**
   * Register an older-history reader for a transcript rendered inside this
   * surface. Several transcripts can share one surface (hidden side-chat tabs);
   * the reader whose owner is displayed loads.
   */
  setOlderHistoryLoader(owner: HTMLElement, loader: OlderHistoryLoader | null, autoLoad = true): () => void {
    if (loader == null) this.olderHistoryLoaders.delete(owner)
    else this.olderHistoryLoaders.set(owner, { loader, autoLoad })
    this.historyLoopToken = {}
    this.observedSize = null
    if (loader) queueMicrotask(() => this.onResizeForHistory())
    const registered = this.olderHistoryLoaders.get(owner)
    return () => { if (this.olderHistoryLoaders.get(owner) === registered) this.olderHistoryLoaders.delete(owner) }
  }

  private activeOlderHistory(): { loader: OlderHistoryLoader; autoLoad: boolean } | null {
    for (const [owner, entry] of this.olderHistoryLoaders) {
      if (owner.isConnected && owner.getClientRects().length > 0) return entry
    }
    return null
  }

  /** Recompute the float button after visibility or geometry changes outside scrolling. */
  syncFloatButton(): void {
    if (!this.floatButton) return
    const spacer = this.getResponseSpacer()
    const away = spacer == null ? this.scrolledFromBottom : this.lastDistance > spacer.getHeightPx() + BOTTOM_TOLERANCE_PX
    const show = this.isVisible() && away
    if (show === this.floatShown) return
    this.floatShown = show
    this.floatButton.classList.toggle('visible', show)
    this.floatButton.setAttribute('aria-hidden', show ? 'false' : 'true')
    this.floatButton.tabIndex = show ? 0 : -1
  }

  /** Scrollbar input outside the element (the column's proxy scrollbar) is reader intent too. */
  noteUserScrollIntent(direction: ScrollDirection): void {
    this.recordIntent(direction)
  }

  // ---- internals -----------------------------------------------------------

  private record(distance: number): void {
    // Hidden surfaces report a zero-size viewport; their last real position is kept.
    if (this.scrollEl.clientHeight === 0 && this.scrollEl.scrollHeight === 0) return
    if (this.unrounded?.actual !== distance) this.unrounded = null
    this.lastDistance = distance
    for (const listener of this.scrollListeners) listener(distance)
    this.scrolledFromBottom = distance > BOTTOM_TOLERANCE_PX
    this.syncFloatButton()
  }

  private cancelAnimation(): void {
    this.animating = false
    this.timedAnimation = false
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame)
    this.animationFrame = 0
    const stop = this.animationStop
    this.animationStop = undefined
    stop?.()
  }

  private beginAnimation(): void {
    this.cancelAnimation()
    this.intent = null
    this.unrounded = null
    this.animating = true
  }

  private userScrolled(distance: number, previous: number): void {
    this.following = distance < previous && distance <= BOTTOM_TOLERANCE_PX
    for (const listener of this.userScrollListeners) listener(distance, previous)
  }

  private write(behavior: ScrollBehavior, target: (element: HTMLElement) => number): void {
    const element = this.scrollEl
    const distance = Math.max(0, target(element))
    if (distance !== distanceFromBottom(element)) { this.unrounded = null; this.intent = null }
    const top = scrollTopFor(element, distance)
    if (element.scrollTop !== top) {
      if (behavior === 'instant' || typeof element.scrollTo !== 'function') element.scrollTop = top
      else element.scrollTo({ behavior, top })
    }
    const actual = distanceFromBottom(element)
    this.unrounded = behavior === 'instant' && actual !== distance && distance > 0
      && distance < element.scrollHeight - element.clientHeight ? { requested: distance, actual } : null
    this.record(actual)
    this.growthTop = element.scrollTop
  }

  private nearTop(): boolean {
    return this.scrollEl.scrollTop <= SHORT_CONTENT_OVERFLOW_PX
  }

  private loadOlderHistory = (): void => {
    if (this.historyLoopRunning || !this.activeOlderHistory()) return
    const token = this.historyLoopToken
    this.historyLoopRunning = true
    void (async () => {
      try {
        while (this.historyLoopToken === token && this.nearTop()) {
          const active = this.activeOlderHistory()
          if (!active) break
          if (await active.loader() === 'stop' || !active.autoLoad) break
        }
      } catch {
        // A failed page is reported by the surface; the loop simply ends.
      } finally {
        this.historyLoopRunning = false
        if (this.historyLoopToken !== token) this.onResizeForHistory()
      }
    })()
  }

  private onResizeForHistory = (): void => {
    const element = this.scrollEl
    const active = this.activeOlderHistory()
    if (!active || !active.autoLoad || this.historyLoopRunning) return
    const client = element.clientHeight, scroll = element.scrollHeight
    if (client <= 0 || scroll - client > SHORT_CONTENT_OVERFLOW_PX) return
    if (this.observedSize && this.observedSize.client === client && this.observedSize.scroll === scroll) return
    this.observedSize = { client, scroll }
    this.loadOlderHistory()
  }

  /** Observe the surface's content blocks (one transcript root, or one slot per side tab). */
  private observeContent(): void {
    const children = new Set(Array.from(this.scrollEl.children))
    for (const content of this.observedContent) {
      if (children.has(content)) continue
      this.growthObserver?.unobserve(content)
      this.resizeObserver?.unobserve(content)
      this.observedContent.delete(content)
    }
    for (const content of children) {
      if (this.observedContent.has(content)) continue
      this.observedContent.add(content)
      this.growthObserver?.observe(content)
      this.resizeObserver?.observe(content)
    }
  }

  private onGrowth = (): void => {
    const element = this.scrollEl
    const scrolled = Math.abs(this.growthTop - element.scrollTop) > 1
    this.growthTop = element.scrollTop
    const current = distanceFromBottom(element)
    if (this.following && this.lastDistance === 0 && current > 0 && !scrolled && this.intent?.direction !== 'away') {
      this.compensateScrollToDistanceFromBottomPx(0)
      this.growthTop = element.scrollTop
    }
  }

  private recordIntent(direction: ScrollDirection): void {
    const element = this.scrollEl
    this.cancelAnimation()
    this.unrounded = null
    const canMove = direction === 'away' ? element.scrollTop > 0 : distanceFromBottom(element) > 0
    this.intent = canMove ? { direction, lastAtMs: performance.now() } : null
  }

  private onWheel = (event: WheelEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.shiftKey) return
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    if (event.deltaY < 0 && this.scrollEl.scrollTop <= 0) this.loadOlderHistory()
    this.recordIntent(event.deltaY < 0 ? 'away' : 'toward')
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const direction = keyIntent(event, this.scrollEl)
    if (direction == null) return
    this.recordIntent(direction)
    if (direction === 'away' && this.scrollEl.scrollTop <= 0) this.loadOlderHistory()
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.scrollbarDrag = null
    this.intent = null
    // A mouse press on the scroll element itself (not its content) is the native scrollbar.
    if (event.pointerType === 'mouse' && event.target === this.scrollEl) {
      this.cancelAnimation()
      this.unrounded = null
      this.scrollbarDrag = { scrollHeightPx: this.scrollEl.scrollHeight, scrollTopPx: this.scrollEl.scrollTop }
    }
  }

  private clearScrollbarDrag = (): void => { this.scrollbarDrag = null }

  private onTouchStart = (event: TouchEvent): void => {
    this.touchStart = event.touches.length === 1 ? event.touches[0] : null
  }

  private onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches.length === 1 ? event.touches[0] : null
    const start = this.touchStart
    if (start == null || touch == null || touch.identifier !== start.identifier) { this.touchStart = null; return }
    const dx = touch.clientX - start.clientX, dy = touch.clientY - start.clientY
    if (Math.max(Math.abs(dx), Math.abs(dy)) < TOUCH_INTENT_THRESHOLD_PX) return
    this.touchStart = null
    if (Math.abs(dy) > Math.abs(dx)) this.recordIntent(dy > 0 ? 'away' : 'toward')
    if (dy > Math.abs(dx) && this.scrollEl.scrollTop <= 0) this.loadOlderHistory()
  }

  private clearTouch = (): void => { this.touchStart = null }

  private settle(): void {
    const distance = distanceFromBottom(this.scrollEl)
    if (distance <= BOTTOM_TOLERANCE_PX && !this.timedAnimation) this.cancelAnimation()
    this.record(distance)
  }

  private onScroll = (): void => {
    const element = this.scrollEl
    const previous = this.lastDistance
    const drag = this.scrollbarDrag
    if (drag != null) {
      this.scrollbarDrag = null
      const current = distanceFromBottom(element)
      if (element.scrollHeight === drag.scrollHeightPx && element.scrollTop !== drag.scrollTopPx && current !== previous) {
        this.intent = { direction: current > previous ? 'away' : 'toward', lastAtMs: performance.now() }
      }
    }
    const intent = this.intent
    if (intent == null) { this.settle(); return }
    const now = performance.now()
    if (now - intent.lastAtMs > USER_INTENT_DECAY_MS) { this.intent = null; this.settle(); return }
    this.settle()
    const current = distanceFromBottom(element)
    const direction = current > previous ? 'away' : current < previous ? 'toward' : null
    if (direction !== intent.direction) return
    intent.lastAtMs = now
    if (current > previous && this.nearTop()) this.loadOlderHistory()
    this.userScrolled(current, previous)
    if (current <= BOTTOM_TOLERANCE_PX) this.intent = null
  }

  private onVisibilityChange = (): void => {
    // A hidden window throttles frames; when it returns, a following view settles at the bottom.
    if (document.hidden || !this.isVisible()) { this.syncFloatButton(); return }
    if (this.following && this.lastDistance === 0) this.compensateScrollToDistanceFromBottomPx(0)
    else this.record(distanceFromBottom(this.scrollEl))
  }
}

const controllers = new WeakMap<HTMLElement, TranscriptScrollController>()

export function registerTranscriptScrollController(controller: TranscriptScrollController): () => void {
  controllers.set(controller.scrollEl, controller)
  return () => { if (controllers.get(controller.scrollEl) === controller) controllers.delete(controller.scrollEl) }
}

/** The controller of the scroll surface that contains `element` (or is it). */
export function transcriptScrollControllerFor(element: HTMLElement | null): TranscriptScrollController | null {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const controller = controllers.get(node)
    if (controller) return controller
  }
  return null
}
