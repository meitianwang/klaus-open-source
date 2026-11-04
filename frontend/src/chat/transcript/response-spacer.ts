// Response spacer: room below a newly sent message so the reply can grow in
// place instead of pushing the conversation upward.
//
// Placing a sent message reserves min(2/3 of the visible height, visible
// height - 240px) below it and scrolls so the message sits near the top. The
// reply consumes that room as it grows. Reading upward trims the spacer by the
// scrolled distance; a spacer that has scrolled out of view collapses.

import type { TranscriptScrollController } from '../transcript-scroll-controller'
import { distanceFromBottom } from '../transcript-scroll-controller'

const PLACEMENT_FRACTION = 2 / 3
const PLACEMENT_MIN_CLEARANCE_PX = 240
const HIDDEN_TOLERANCE_PX = 1
/** Distance kept below the placed content so the view is not exactly "at the bottom". */
const PLACEMENT_REST_PX = 1
/** Critically damped spring settling in half a second (motion's bounce 0, duration 0.5). */
const SPRING_OMEGA = 18.47

export function scrollPaddingBottom(element: HTMLElement): number {
  const raw = element.style.getPropertyValue('--thread-scroll-padding-bottom')
    || (typeof getComputedStyle === 'function' ? getComputedStyle(element).getPropertyValue('--thread-scroll-padding-bottom') : '')
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : 0
}

/** Room a placement reserves: the visible height, or the default fraction of it. */
export function placementHeight(element: HTMLElement, fullHeight = false): number {
  const available = Math.max(0, element.clientHeight - scrollPaddingBottom(element))
  return fullHeight ? available : Math.max(0, Math.min(available * PLACEMENT_FRACTION, available - PLACEMENT_MIN_CLEARANCE_PX))
}

export class ResponseSpacerController {
  private controller: TranscriptScrollController
  private heightPx = 0
  private readonly heightListeners = new Set<() => void>()
  private element: HTMLElement | null = null
  private prefersReducedMotion = true
  private onReleased: (() => void) | undefined
  private stopPlacementAnimation: (() => void) | null = null
  private pendingUserScrollDecayPx = 0
  private pendingUserScrollElement: HTMLElement | null = null
  private userScrollDecayFrame: number | null = null
  private viewportHeightPx: number | null = null
  private scrollPaddingBottomPx: number | null = null
  private placementTarget: HTMLElement | undefined

  constructor(controller: TranscriptScrollController) {
    this.controller = controller
  }

  updateContext(controller: TranscriptScrollController, prefersReducedMotion: boolean, onReleased?: () => void): void {
    this.controller = controller
    this.prefersReducedMotion = prefersReducedMotion
    this.onReleased = onReleased
  }

  setElement = (element: HTMLElement | null): void => {
    this.element = element
    if (element) element.style.height = `${this.heightPx}px`
  }

  getElement = (): HTMLElement | null => this.element
  getHeightPx = (): number => this.heightPx

  onHeightChange(listener: () => void): () => void {
    this.heightListeners.add(listener)
    return () => { this.heightListeners.delete(listener) }
  }

  stop = (): void => {
    this.stopPlacementAnimation?.()
    this.stopPlacementAnimation = null
  }

  private writeHeight(height: number): void {
    if (height !== this.heightPx) {
      this.heightPx = height
      for (const listener of this.heightListeners) listener()
    }
    if (this.element) this.element.style.height = `${height}px`
  }

  /** The reply grew by `growth`; give that room back. */
  consumeGrowth = (growth: number): void => {
    this.writeHeight(Math.max(0, this.heightPx - Math.max(0, growth)))
  }

  /** Shrink to at most `height`, keeping the visible content where it is. */
  trimTo = (height: number): boolean => {
    const previous = this.heightPx
    const next = Math.max(0, Math.min(previous, height))
    if (previous <= next) return false
    const scrollEl = this.controller.getScrollElement()
    const distance = distanceFromBottom(scrollEl)
    this.writeHeight(next)
    this.controller.compensateScrollToDistanceFromBottomPx(Math.max(0, distance - (previous - next)))
    if (next === 0) this.onReleased?.()
    return true
  }

  cancelPendingUserScrollDecay = (): void => {
    if (this.userScrollDecayFrame != null) cancelAnimationFrame(this.userScrollDecayFrame)
    this.userScrollDecayFrame = null
    this.pendingUserScrollDecayPx = 0
    this.pendingUserScrollElement = null
  }

  clear = (): void => {
    this.stop()
    this.cancelPendingUserScrollDecay()
    this.writeHeight(0)
    this.placementTarget = undefined
  }

  /** Collapse once the spacer is entirely below the visible region. */
  collapseIfHidden = (): void => {
    const scrollEl = this.controller.getScrollElement()
    if (this.heightPx <= 0 || this.stopPlacementAnimation != null || this.element == null || scrollEl.clientHeight <= 0) return
    const box = scrollEl.getBoundingClientRect()
    const scale = box.height / scrollEl.clientHeight
    const visibleBottom = box.bottom - scrollPaddingBottom(scrollEl) * scale
    if (!(this.element.getBoundingClientRect().top < visibleBottom - HIDDEN_TOLERANCE_PX * scale)) this.trimTo(0)
  }

  private flushUserScrollDecay = (): void => {
    this.userScrollDecayFrame = null
    const decay = this.pendingUserScrollDecayPx
    const element = this.pendingUserScrollElement
    this.pendingUserScrollDecayPx = 0
    this.pendingUserScrollElement = null
    if (element === this.controller.getScrollElement() && this.trimTo(this.heightPx - decay)) this.collapseIfHidden()
  }

  /** Content no longer overflows and the view is at the bottom: nothing to reserve. */
  handleScroll = (distance: number): void => {
    const scrollEl = this.controller.getScrollElement()
    if (this.heightPx > 0 && scrollEl.scrollHeight <= scrollEl.clientHeight
      && this.controller.getUnroundedScrollDistanceFromBottomPx(distance) === 0) this.clear()
  }

  /** Reading upward spends the spacer; returning to the bottom clears it. */
  handleUserScroll = (distance: number, previous: number): void => {
    this.stop()
    if (distance === 0) { this.clear(); return }
    const moved = distance - previous
    if (moved <= 0) return
    const scrollEl = this.controller.getScrollElement()
    if (this.pendingUserScrollElement !== scrollEl) this.cancelPendingUserScrollDecay()
    this.pendingUserScrollDecayPx += moved
    if (this.userScrollDecayFrame == null) {
      this.pendingUserScrollElement = scrollEl
      this.userScrollDecayFrame = requestAnimationFrame(this.flushUserScrollDecay)
    }
  }

  /** The viewport or footer changed size: re-fit the spacer and any running placement. */
  reconcileViewport = (): void => {
    const scrollEl = this.controller.getScrollElement()
    if (scrollEl.clientHeight <= 0) return
    const height = scrollEl.clientHeight, padding = scrollPaddingBottom(scrollEl)
    const changed = height !== this.viewportHeightPx || padding !== this.scrollPaddingBottomPx
    this.viewportHeightPx = height
    this.scrollPaddingBottomPx = padding
    const restart = changed && this.stopPlacementAnimation != null
    if (restart) this.stop()
    const trimmed = this.trimTo(placementHeight(scrollEl, this.placementTarget != null))
    if (restart) {
      if (!trimmed) this.controller.compensateScrollToDistanceFromBottomPx(distanceFromBottom(scrollEl))
      this.animatePlacement()
    }
  }

  /** Reserve room below the newest content and bring it near the top of the view. */
  place = (target?: HTMLElement): void => {
    const scrollEl = this.controller.getScrollElement()
    this.cancelPendingUserScrollDecay()
    this.stop()
    this.placementTarget = target
    this.viewportHeightPx = scrollEl.clientHeight
    this.scrollPaddingBottomPx = scrollPaddingBottom(scrollEl)
    const previous = this.heightPx
    const distance = distanceFromBottom(scrollEl)
    const placementDistance = this.placementDistance(scrollEl)
    this.controller.holdViewport()
    this.writeHeight(target == null ? placementHeight(scrollEl) : Math.max(0, previous - placementDistance + PLACEMENT_REST_PX))
    // Start the motion from where the content was, then ease it into place.
    if (!this.prefersReducedMotion) this.controller.compensateScrollToDistanceFromBottomPx(distance + this.heightPx - previous)
    this.animatePlacement()
  }

  private animatePlacement(): void {
    const scrollEl = this.controller.getScrollElement()
    const target = Math.max(PLACEMENT_REST_PX, this.placementDistance(scrollEl))
    if (!this.prefersReducedMotion) {
      const travel = this.controller.getLastScrollDistanceFromBottomPx() - target
      if (travel > 0) {
        let applied = 0, stopped = false, frame = 0, startedAt: number | null = null
        const step = (now: number) => {
          if (stopped) return
          startedAt ??= now
          const t = (now - startedAt) / 1000
          const progress = 1 - (1 + SPRING_OMEGA * t) * Math.exp(-SPRING_OMEGA * t)
          const done = progress >= 0.999 || t >= 1
          const value = done ? travel : travel * progress
          const current = this.controller.getUnroundedScrollDistanceFromBottomPx(this.controller.getLastScrollDistanceFromBottomPx())
          this.controller.compensateScrollToDistanceFromBottomPx(Math.max(PLACEMENT_REST_PX, current - (value - applied)))
          applied = value
          if (done) {
            this.stopPlacementAnimation = null
            this.controller.compensateScrollToDistanceFromBottomPx(this.controller.getUnroundedScrollDistanceFromBottomPx(this.controller.getLastScrollDistanceFromBottomPx()))
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
        this.stopPlacementAnimation = () => { stopped = true; cancelAnimationFrame(frame) }
        return
      }
    }
    this.controller.scrollToDistanceFromBottomPx(target, 'instant')
  }

  private placementDistance(scrollEl: HTMLElement): number {
    if (this.placementTarget == null) return PLACEMENT_REST_PX
    const box = scrollEl.getBoundingClientRect()
    const scale = box.height / (scrollEl.offsetHeight || scrollEl.clientHeight)
    const paddingTop = Number.parseFloat(getComputedStyle(scrollEl).paddingTop) || 0
    return distanceFromBottom(scrollEl) - (this.placementTarget.getBoundingClientRect().top - box.top) / scale + scrollEl.clientTop + paddingTop
  }
}
