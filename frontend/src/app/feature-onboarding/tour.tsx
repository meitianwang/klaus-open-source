// The spotlight walkthrough: a dimmed surround with one hole cut over the
// control being explained, plus a bubble that walks the user through the steps.
//
// Scope is deliberate. This is not a general tour engine and it does not try to
// describe the whole product — it exists for the handful of surfaces that are
// genuinely hard to discover from their entry point alone (registry `tour`
// arrays). A step whose anchor never appears is skipped rather than drawn on
// nothing, because these pages build their own content asynchronously.
//
// The hole is a single fixed element whose box-shadow paints everything outside
// it. That avoids an SVG mask and a four-rectangle assembly, and keeps the
// highlight's rounded corners crisp at any size.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ModalPortal } from '../../components/ModalPortal'
import { t } from '../../i18n'
import type { FeatureEntry, TourStep } from './registry'
import styles from './feature-onboarding.module.css'

/** Gap between the highlight and its bubble. */
const BUBBLE_GAP = 12
/** Padding around the anchored control, so the hole does not clip its focus
 *  ring. */
const HOLE_PADDING = 6
/** How long to keep re-measuring while a page finishes building the anchor.
 *
 *  Short on purpose. A step whose anchor never appears is skipped, and nothing
 *  is drawn during the wait, so this is dead screen time the user is staring at.
 *  A page's own island renders well inside this window; a control that is absent
 *  because the user is not signed in to that feature never appears at all, and
 *  waiting longer for it would only lengthen the gap. */
const ANCHOR_RETRY_MS = 300

interface Box { top: number; left: number; width: number; height: number }

function sameBox(a: Box | null, b: Box): boolean {
  return Boolean(a) && a!.top === b.top && a!.left === b.left
    && a!.width === b.width && a!.height === b.height
}

/** Measure a step's anchor, or null while it is absent or not laid out. */
function measureAnchor(step: TourStep): Box | null {
  const element = document.getElementById(step.anchor)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  if (!rect.width && !rect.height) return null
  return {
    top: rect.top - HOLE_PADDING,
    left: rect.left - HOLE_PADDING,
    width: rect.width + HOLE_PADDING * 2,
    height: rect.height + HOLE_PADDING * 2,
  }
}

/** Put the bubble beside the hole, preferring the step's placement and flipping
 *  to the opposite side when that edge has no room. Clamped to the viewport so a
 *  rail-anchored step never pushes the text off-screen. */
function placeBubble(box: Box, bubble: Box | null, preferred: TourStep['placement']): Box {
  const width = bubble?.width ?? 320
  const height = bubble?.height ?? 150
  const vw = window.innerWidth
  const vh = window.innerHeight
  const fits = (candidate: Box) =>
    candidate.top >= 8 && candidate.left >= 8
    && candidate.top + height <= vh - 8 && candidate.left + width <= vw - 8

  const left = { top: box.top + box.height / 2 - height / 2, left: box.left - BUBBLE_GAP - width, width, height }
  const right = { top: box.top + box.height / 2 - height / 2, left: box.left + box.width + BUBBLE_GAP, width, height }
  const bottom = { top: box.top + box.height + BUBBLE_GAP, left: box.left + box.width / 2 - width / 2, width, height }
  const top = { top: box.top - BUBBLE_GAP - height, left: box.left + box.width / 2 - width / 2, width, height }
  // Preferred side first, then the two sides that stay clear of the anchor's own
  // axis, then the opposite side last: flipping to directly across is the least
  // surprising fallback when the preferred edge is against a viewport boundary.
  const candidates = preferred === 'left' ? [left, bottom, top, right]
    : preferred === 'right' ? [right, bottom, top, left]
    : preferred === 'top' ? [top, left, right, bottom]
    : [bottom, left, right, top]

  for (const candidate of candidates) {
    if (fits(candidate)) return clamp(candidate, width, height)
  }
  return clamp(candidates[0], width, height)
}

function clamp(box: Box, width: number, height: number): Box {
  return {
    ...box,
    width,
    height,
    top: Math.min(Math.max(8, box.top), Math.max(8, window.innerHeight - height - 8)),
    left: Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8)),
  }
}

export function FeatureTour({ entry, onFinish }: {
  entry: FeatureEntry
  onFinish: (completed: boolean) => void
}) {
  const steps = entry.tour ?? []
  const [index, setIndex] = useState(0)
  const [box, setBox] = useState<Box | null>(null)
  const [bubbleBox, setBubbleBox] = useState<Box | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const finished = useRef(false)

  const finish = useCallback((completed: boolean) => {
    if (finished.current) return
    finished.current = true
    onFinish(completed)
  }, [onFinish])

  const step = steps[index]
  const isLast = index === steps.length - 1

  // Measure the current step, retrying while its page is still building. A step
  // that never materialises is skipped instead of leaving the user staring at a
  // hole over nothing.
  useLayoutEffect(() => {
    if (!step) return undefined
    let cancelled = false
    const started = Date.now()
    const attempt = () => {
      if (cancelled) return
      const measured = measureAnchor(step)
      if (measured) { setBox(measured); return }
      if (Date.now() - started > ANCHOR_RETRY_MS) {
        if (isLast) finish(false)
        else setIndex(current => current + 1)
        return
      }
      requestAnimationFrame(attempt)
    }
    step.reveal?.()
    // Two frames: the first lets the reveal's own React commit land, the second
    // lets layout settle. Measuring earlier reads the pre-navigation geometry.
    requestAnimationFrame(() => requestAnimationFrame(attempt))
    return () => { cancelled = true }
  }, [step, index, isLast, finish])

  // Keep the hole glued to the anchor while the window or the layout moves.
  // The comparison is value-based on purpose: `setBox` with a fresh object would
  // re-run this effect, whose own re-measure produces another fresh object, and
  // the pair would ping-pong until the tour is dismissed.
  useEffect(() => {
    if (!step) return undefined
    const remeasure = () => {
      const measured = measureAnchor(step)
      if (!measured) return
      setBox(current => (sameBox(current, measured) ? current : measured))
    }
    window.addEventListener('resize', remeasure)
    // Capturing, because the surfaces a step points at scroll inside their own
    // containers rather than the window.
    window.addEventListener('scroll', remeasure, true)
    return () => {
      window.removeEventListener('resize', remeasure)
      window.removeEventListener('scroll', remeasure, true)
    }
  }, [step])

  // Escape leaves the walkthrough. Exiting counts as done: the user has declined,
  // and replaying on their next visit turns a dismissal into a recurring
  // interruption.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [finish])

  useEffect(() => {
    const element = bubbleRef.current
    if (!element || !box) return
    setBubbleBox({
      top: 0, left: 0,
      width: element.offsetWidth,
      height: element.offsetHeight,
    })
  }, [box, index])

  if (!step || !box) return null
  const placed = placeBubble(box, bubbleBox, step.placement)

  return (
    <ModalPortal>
      <div
        className={styles['tour-hole']}
        style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        aria-hidden="true"
      />
      <div
        ref={bubbleRef}
        className={styles['tour-bubble']}
        style={{ top: placed.top, left: placed.left }}
        role="dialog"
        aria-modal="false"
        aria-label={t(step.titleKey)}
      >
        <span className={styles['tour-step-count']}>
          {t('onb_tour_step').replace('{i}', String(index + 1)).replace('{n}', String(steps.length))}
        </span>
        <h2 className={styles['tour-title']}>{t(step.titleKey)}</h2>
        <p className={styles['tour-body']}>{t(step.bodyKey)}</p>
        <div className={styles['tour-progress']} aria-hidden="true">
          {steps.map((_, position) => (
            <span
              key={position}
              className={styles['tour-pip']}
              data-current={position === index ? '1' : '0'}
            />
          ))}
        </div>
        <div className={styles['tour-footer']}>
          <button type="button" className={styles['tour-skip']} onClick={() => finish(false)}>
            {t('onb_tour_skip')}
          </button>
          <div className={styles['tour-nav']}>
            {index > 0 && (
              <button
                type="button" className="kls-btn kls-btn-secondary"
                onClick={() => setIndex(current => current - 1)}
              >{t('onb_tour_prev')}</button>
            )}
            <button
              type="button" className="kls-btn kls-btn-primary"
              onClick={() => { if (isLast) finish(true); else setIndex(current => current + 1) }}
            >{isLast ? t('onb_tour_done') : t('onb_tour_next')}</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
