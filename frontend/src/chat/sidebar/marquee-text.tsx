// MarqueeText: a title that scrolls when it overflows its row.
//
// Structure and numbers are exact rather than approximated:
//   - four layers (viewport / clipViewport / track / content), motion is a
//     translateX on the track, never text-indent or scrollLeft;
//   - speed is constant in em/second (2em/s), so a bigger font scrolls faster
//     in px and the perceived pace stays the same;
//   - duration = 0.35s lead-in + travel + (1.85s tail for loop mode);
//   - easing is emitted as a 34-stop `linear()` sampling of
//     cubic-bezier(.49,.6,.7,1), because CSS cannot apply a bezier to only
//     part of a timeline that also contains a fixed lead-in;
//   - `stop-at-end` runs once and holds the final position (iteration-count 1
//     + fill-mode forwards) while the right fade lifts over the last quarter;
//   - `loop` mode duplicates the content and travels content + gap so the seam
//     is invisible;
//   - overflow is measured in device pixels and a sub-pixel remainder (<1px)
//     counts as not overflowing, so a title that merely fits never animates.
//
// The sidebar uses `animateOnGroupHover` for thread rows:
// the row carries the `kls-marquee-group` marker and the title scrolls while
// the pointer is over that row.

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import styles from './sidebar-marquee.module.css'

const FALLBACK_FONT_SIZE = 13
const FALLBACK_SPEED_EM_PER_SECOND = 2
/** Must equal `--marquee-gap`, which is in em. */
export const MARQUEE_GAP_EM = 1.15
export const MARQUEE_LEAD_IN_SECONDS = 0.35
export const MARQUEE_LOOP_TAIL_SECONDS = 1.85
/** `linear()` sample count: 33 intervals → 34 stops. */
export const MARQUEE_BEZIER_SAMPLES = 32
export const MARQUEE_BEZIER = { x1: 0.49, y1: 0.6, x2: 0.7, y2: 1 }

const LEAD_IN_SECONDS = MARQUEE_LEAD_IN_SECONDS
const LOOP_TAIL_SECONDS = MARQUEE_LOOP_TAIL_SECONDS
const BEZIER_SAMPLES = MARQUEE_BEZIER_SAMPLES
const BEZIER = MARQUEE_BEZIER
const GAP_EM = MARQUEE_GAP_EM

export type MarqueeScrollMode = 'stop-at-end' | 'loop'

type MarqueeMeasure = {
  contentWidth: number
  scrollDistance: number
  speedPxPerSecond: number
}

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Round to whole device pixels, so a fractional DPR (1.25, 1.5) cannot leave
 *  the travel distance a fraction of a pixel off from what was measured. */
export function roundToDevicePx(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr
}

function devicePixelRatio(): number {
  const ratio = typeof window === 'undefined' ? undefined : window.devicePixelRatio
  return typeof ratio === 'number' && ratio > 0 ? ratio : 1
}

function prefersReducedMotion(): boolean {
  return !!window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
}

/** One `linear()` stop: progress at a point in the total timeline. */
export function timingStop(progress: number, seconds: number, total: number): string {
  return `${progress.toFixed(4)} ${((seconds / total) * 100).toFixed(4)}%`
}

/** Sample cubic-bezier(.49,.6,.7,1) across the travel window. The x of the
 *  bezier maps to elapsed time, the y to travelled progress. */
export function bezierStops(leadIn: number, travel: number, total: number): string[] {
  return Array.from({ length: BEZIER_SAMPLES + 1 }, (_, index) => {
    const t = index / BEZIER_SAMPLES
    const inv = 1 - t
    const p1 = 3 * inv ** 2 * t
    const p2 = 3 * inv * t ** 2
    const p3 = t ** 3
    return timingStop(
      p1 * BEZIER.y1 + p2 * BEZIER.y2 + p3,
      leadIn + travel * (p1 * BEZIER.x1 + p2 * BEZIER.x2 + p3),
      total,
    )
  })
}

/** The custom properties that drive the animation, from the measured travel
 *  distance and the constant em/second speed. */
export function marqueeVars(scrollDistance: number, speedPxPerSecond: number, mode: MarqueeScrollMode): CSSProperties {
  const travel = scrollDistance / speedPxPerSecond
  const total = LEAD_IN_SECONDS + travel + (mode === 'loop' ? LOOP_TAIL_SECONDS : 0)
  const stops = [
    timingStop(0, 0, total),
    ...bezierStops(LEAD_IN_SECONDS, travel, total),
    ...(mode === 'loop' ? [timingStop(1, total, total)] : []),
  ]
  return {
    '--marquee-duration': `${total.toFixed(3)}s`,
    '--marquee-scroll-distance': `${scrollDistance}px`,
    '--marquee-scroll-timing': `linear(${stops.join(', ')})`,
  } as CSSProperties
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useLayoutEffect(() => {
    const query = window?.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const onChange = () => setReduced(query.matches)
    onChange()
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}

export function MarqueeText({
  children,
  className,
  id,
  animate = false,
  animateOnGroupHover = false,
  scrollMode = 'stop-at-end',
  style,
  ...rest
}: {
  children: ReactNode
  className?: string
  id?: string
  animate?: boolean
  animateOnGroupHover?: boolean
  scrollMode?: MarqueeScrollMode
  style?: CSSProperties
} & Omit<HTMLAttributes<HTMLSpanElement>, 'id' | 'className' | 'style' | 'children'>) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLSpanElement>(null)
  const copyRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const [measure, setMeasure] = useState<MarqueeMeasure | null>(null)
  const reducedMotion = usePrefersReducedMotion()

  const measureNow = useCallback(() => {
    const root = rootRef.current
    const content = contentRef.current
    if (!root || !content) return
    const dpr = devicePixelRatio()

    const contentBox = content.getBoundingClientRect()
    const roundedContent = roundToDevicePx(contentBox.width, dpr)
    const contentWidth = roundedContent > 0 ? roundedContent : content.scrollWidth
    const roundedViewport = roundToDevicePx(root.getBoundingClientRect().width, dpr)
    const viewportWidth = roundedViewport > 0 ? roundedViewport : root.clientWidth

    if (viewportWidth <= 0 || contentWidth - viewportWidth < 1) {
      setMeasure(null)
      return
    }

    const computed = getComputedStyle(content)
    const parsedFontSize = Number.parseFloat(computed.fontSize)
    const fontSize = Number.isFinite(parsedFontSize) ? parsedFontSize : FALLBACK_FONT_SIZE
    const parsedSpeed = Number.parseFloat(computed.getPropertyValue('--marquee-speed-em-per-second'))
    const speedEmPerSecond = Number.isFinite(parsedSpeed) && parsedSpeed > 0 ? parsedSpeed : FALLBACK_SPEED_EM_PER_SECOND

    let scrollDistance = contentWidth - viewportWidth
    if (scrollMode === 'loop') {
      scrollDistance = contentWidth + fontSize * GAP_EM
      const copy = copyRef.current
      if (copy) {
        const gap = roundToDevicePx(copy.getBoundingClientRect().left - contentBox.left, dpr)
        if (gap > 0) scrollDistance = gap
      }
    }

    const speedPxPerSecond = fontSize * speedEmPerSecond
    setMeasure(previous => (
      previous?.contentWidth === contentWidth
      && previous.scrollDistance === scrollDistance
      && previous.speedPxPerSecond === speedPxPerSecond
        ? previous
        : { contentWidth, scrollDistance, speedPxPerSecond }
    ))
  }, [scrollMode])

  useLayoutEffect(() => {
    measureNow()
    if (typeof ResizeObserver === 'undefined') return
    // The root, the content, the loop copy and the track all subscribe to
    // one shared ResizeObserver rather than re-measuring on every render: a
    // title change that does not change any box needs no new measurement, and
    // one that does is caught by the observer.
    const observer = new ResizeObserver(measureNow)
    for (const el of [rootRef.current, contentRef.current, copyRef.current, trackRef.current]) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [measureNow])

  const overflowing = measure != null
  const animatable = overflowing && !reducedMotion
  const loopCopy = scrollMode === 'loop' && overflowing && !reducedMotion
  const vars = animatable ? marqueeVars(measure!.scrollDistance, measure!.speedPxPerSecond, scrollMode) : undefined

  return (
    <span
      {...rest}
      id={id}
      ref={rootRef}
      className={cx(
        styles.viewport,
        animate && styles.animate,
        animateOnGroupHover && styles.animateOnGroupHover,
        scrollMode === 'stop-at-end' && styles.stopAtEnd,
        className,
      )}
      style={style}
      data-marquee-text=""
      data-marquee-overflowing={overflowing || undefined}
      data-marquee-animatable={animatable || undefined}
      draggable={false}
    >
      <span className={cx(styles.clipViewport, overflowing && styles.overflowingViewport)} style={vars}>
        <span ref={trackRef} className={cx(styles.track, animatable && styles.scrolling)}>
          <span ref={contentRef} className={styles.content} data-marquee-content="">{children}</span>
          {loopCopy ? (
            <span ref={copyRef} className={styles.content} aria-hidden="true" data-marquee-copy="" inert>
              {children}
            </span>
          ) : null}
        </span>
      </span>
    </span>
  )
}
