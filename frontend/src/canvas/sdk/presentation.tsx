// Interactive slides.
//
// A distinct deliverable from a report, not a styled variant of one: a
// presentation is paced by the presenter, so exactly one slide is visible, and
// navigation has to work from the keyboard without the user hunting for a
// control.
//
// Slides are mounted lazily but kept mounted once visited. Rendering all of them
// up front makes a 30-slide deck pay for every chart at once; unmounting on exit
// throws away any state the viewer built up on a slide they are coming back to.

import type { CSSProperties, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { IconButton, Row, Stack, Text } from './core-primitives'
import { useCanvasState, useHostTheme } from './hooks'

/**
 * The reveal step of the slide currently on screen, plus the way a fragment tells
 * the deck it exists.
 *
 * A context rather than props because a fragment can sit arbitrarily deep inside
 * a slide's content — inside a Card, inside a Grid cell — and threading the step
 * down by hand would mean every intermediate component in a model-authored slide
 * has to forward it.
 */
interface FragmentScope {
  step: number
  claim: (at: number) => void
}

const FragmentContext = createContext<FragmentScope | null>(null)

export interface PresentationFragmentProps {
  children?: ReactNode
  /**
   * Which forward press reveals this. 1 is the first press after the slide
   * appears. Explicit rather than derived from mount order, because mount order
   * in a conditional tree is not the order the reader sees.
   */
  at?: number
  /** How it arrives. `fade` is the default; `none` for an instant appearance. */
  effect?: 'fade' | 'rise' | 'none'
  style?: CSSProperties
}

/**
 * A part of a slide that appears on a later forward press.
 *
 * Outside a `Presentation` it renders its children plainly — a fragment that
 * vanished because someone reused the slide body elsewhere would be a silent
 * content loss, which is worse than showing it early.
 *
 * Hidden fragments keep their layout box (`visibility`, not `display`) so the
 * slide does not jump as each one arrives.
 */
export function PresentationFragment({
  children,
  at = 1,
  effect = 'fade',
  style,
}: PresentationFragmentProps) {
  const scope = useContext(FragmentContext)
  const step = Math.max(1, Math.round(at))
  useEffect(() => {
    scope?.claim(step)
  }, [scope, step])
  if (!scope) return <div style={style}>{children}</div>
  const shown = scope.step >= step
  return (
    <div
      aria-hidden={shown ? undefined : true}
      style={{
        visibility: shown ? 'visible' : 'hidden',
        opacity: effect === 'none' ? 1 : shown ? 1 : 0,
        transform:
          effect === 'rise' && !shown ? 'translateY(6px)' : undefined,
        transition: effect === 'none' ? undefined : 'opacity 180ms ease, transform 180ms ease',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export interface PresentationStackProps {
  children?: ReactNode
  /** Box height. Required in spirit: stacked children cannot size the box. */
  height?: number | string
  style?: CSSProperties
}

/**
 * Overlap children in one box instead of stacking them down the page.
 *
 * For a diagram that builds up: wrap each layer in a `PresentationFragment` and
 * put them here, and layer two lands ON layer one rather than below it. Without
 * this, every revealed fragment pushes the slide taller and the diagram walks
 * down the screen as the presenter talks.
 */
export function PresentationStack({ children, height = 260, style }: PresentationStackProps) {
  return (
    <div style={{ position: 'relative', height, ...style }}>
      {(Array.isArray(children) ? children.flat(4) : [children]).map((child, index) => (
        <div key={index} style={{ position: 'absolute', inset: 0 }}>
          {child as ReactNode}
        </div>
      ))}
    </div>
  )
}

export interface PresentationSlideProps {
  /** Slide title, rendered by the slide chrome. */
  title?: ReactNode
  /** A short line under the title. */
  subtitle?: ReactNode
  children?: ReactNode
  /** Center the content block vertically. Right for a title or section slide. */
  centered?: boolean
  /** Presenter-only text, shown in the notes strip when notes are on. */
  notes?: ReactNode
  style?: CSSProperties
}

/**
 * One slide. Rendered by `Presentation`, which reads these props off its
 * children — so a slide is a declaration, not a component that draws itself.
 */
export function PresentationSlide(_props: PresentationSlideProps): null {
  return null
}

export interface PresentationProps {
  children: ReactNode
  /** Deck title, shown in the chrome alongside the slide counter. */
  title?: ReactNode
  /** Persist the position under this key so a reload returns to the same slide. */
  stateKey?: string
  /** Show the presenter notes strip. */
  showNotes?: boolean
  /** Slide area height. The deck does not grow with its longest slide. */
  height?: number
  style?: CSSProperties
}

interface ResolvedSlide extends PresentationSlideProps {
  key: string
}

/**
 * Read the slide declarations out of `children`.
 *
 * Done by inspecting element props rather than by rendering, so a slide's content
 * is not evaluated until that slide is shown. `React.Children` is not imported —
 * the children arrive as an array or a single element, and flattening that here
 * avoids pulling the whole Children API into the bundle for one use.
 */
function resolveSlides(children: ReactNode): ResolvedSlide[] {
  const flat: unknown[] = Array.isArray(children) ? children.flat(4) : [children]
  const slides: ResolvedSlide[] = []
  for (const entry of flat) {
    const element = entry as { type?: unknown; props?: PresentationSlideProps } | null
    if (!element || typeof element !== 'object' || !element.props) continue
    if (element.type !== PresentationSlide) continue
    slides.push({ ...element.props, key: String(slides.length) })
  }
  return slides
}

export function Presentation({
  children,
  title,
  stateKey = 'presentation',
  showNotes = false,
  height = 420,
  style,
}: PresentationProps) {
  const { tokens } = useHostTheme()
  const slides = useMemo(() => resolveSlides(children), [children])
  const [index, setIndex] = useCanvasState(`${stateKey}:slide`, 0)
  const container = useRef<HTMLDivElement | null>(null)

  const total = slides.length
  // Clamp on read rather than on write: a deck edited from 8 slides to 3 leaves a
  // stored index of 7, and clamping at the setter would never see it.
  const current = Math.min(Math.max(0, index), Math.max(0, total - 1))

  const [visited, setVisited] = useState<Set<number>>(() => new Set([current]))
  useEffect(() => {
    setVisited((previous) => (previous.has(current) ? previous : new Set(previous).add(current)))
  }, [current])

  // Reveal step within the current slide, and the highest step its fragments have
  // claimed. Kept in component state, not canvas state: returning to a deck should
  // land on the slide you left, fully revealed, rather than mid-build with the
  // presenter's next click hidden.
  const [step, setStep] = useState(0)
  const claimed = useRef<Map<number, number>>(new Map())
  const [maxStep, setMaxStep] = useState(0)

  const claim = useCallback(
    (at: number) => {
      const highest = claimed.current.get(current) ?? 0
      if (at <= highest) return
      claimed.current.set(current, at)
      setMaxStep(at)
    },
    [current],
  )
  const scope = useMemo<FragmentScope>(() => ({ step, claim }), [step, claim])

  const go = useCallback(
    (next: number) => {
      const target = Math.min(Math.max(0, next), Math.max(0, total - 1))
      setIndex(target)
      // A slide arrives unrevealed, and `maxStep` has to come from that slide's own
      // fragments — keeping the previous slide's count would let one forward press
      // stall on a slide with nothing left to reveal.
      setStep(0)
      setMaxStep(claimed.current.get(target) ?? 0)
    },
    [setIndex, total],
  )

  // Forward means "reveal the next thing", and only when there is nothing left to
  // reveal does it mean "next slide". Backward is the mirror. Getting this order
  // wrong is what makes a build-up deck skip its own build.
  const forward = useCallback(() => {
    if (step < maxStep) setStep(step + 1)
    else go(current + 1)
  }, [step, maxStep, go, current])

  const backward = useCallback(() => {
    if (step > 0) setStep(step - 1)
    else go(current - 1)
  }, [step, go, current])

  // Keyboard navigation is scoped to the deck, not the window: a canvas can hold
  // a presentation next to other content, and swallowing global arrow keys would
  // break scrolling everywhere else on the page.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          event.preventDefault()
          forward()
          return
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          event.preventDefault()
          backward()
          return
        case 'Home':
          event.preventDefault()
          go(0)
          return
        case 'End':
          event.preventDefault()
          go(total - 1)
          return
        default:
      }
    },
    [forward, backward, go, total],
  )

  if (total === 0) {
    return (
      <Text tone="tertiary" size="small">
        This presentation has no slides.
      </Text>
    )
  }

  const slide = slides[current]

  return (
    <div
      ref={container}
      tabIndex={0}
      role="group"
      aria-roledescription="slide deck"
      aria-label={typeof title === 'string' ? title : 'Presentation'}
      onKeyDown={onKeyDown}
      style={{
        border: `1px solid ${tokens.stroke.primary}`,
        borderRadius: tokens.radius.sm,
        background: tokens.bg.elevated,
        overflow: 'hidden',
        // The deck owns focus for its own keys, but a focus ring on a big panel
        // is noise; the ring is drawn on the border instead.
        outline: 'none',
        ...style,
      }}
      onFocus={(event) => {
        if (event.currentTarget === event.target) {
          event.currentTarget.style.borderColor = tokens.accent.highlight
        }
      }}
      onBlur={(event) => {
        event.currentTarget.style.borderColor = tokens.stroke.primary
      }}
    >
      <Row
        justify="space-between"
        style={{
          padding: '7px 10px',
          background: tokens.bg.chrome,
          borderBottom: `1px solid ${tokens.stroke.primary}`,
        }}
      >
        <Text tone="secondary" size="small" truncate>
          {title}
        </Text>
        <Row gap="micro">
          <Text tone="quaternary" size="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {current + 1} / {total}
          </Text>
          <IconButton size="sm" title="Back" disabled={current === 0 && step === 0} onClick={backward}>
            ‹
          </IconButton>
          <IconButton
            size="sm"
            title={step < maxStep ? 'Reveal next' : 'Next slide'}
            disabled={current === total - 1 && step >= maxStep}
            onClick={forward}
          >
            ›
          </IconButton>
        </Row>
      </Row>

      <div
        data-canvas-scroll
        style={{
          height,
          overflow: 'auto',
          padding: 24,
          display: slide.centered ? 'flex' : 'block',
          alignItems: slide.centered ? 'center' : undefined,
          justifyContent: slide.centered ? 'center' : undefined,
        }}
      >
        {/* Every visited slide stays in the tree; only the current one is shown.
            `hidden` rather than unmounting preserves scroll and control state on
            a slide the viewer returns to. */}
        {slides.map((entry, position) =>
          visited.has(position) ? (
            <div
              key={entry.key}
              hidden={position !== current}
              // Always centred horizontally. The reading-measure cap is right for
              // slide text at any window width, but a capped column pinned left in
              // a wide window leaves dead space down one side — which only became
              // visible once `canvasConfig` let a deck run full-bleed. Vertical
              // centring stays on `centered`, which is what that prop means; this
              // also reads `entry`, not `slide`, so a kept-mounted slide is laid out
              // by its own declaration rather than the current one's.
              style={{ width: '100%', maxWidth: 900, margin: '0 auto' }}
            >
              <Stack gap="block">
                {entry.title || entry.subtitle ? (
                  <Stack gap="micro">
                    {entry.title ? (
                      <span
                        style={{
                          fontSize: tokens.fontSize.title,
                          fontWeight: tokens.weight.semibold,
                          color: tokens.text.primary,
                          lineHeight: 1.3,
                        }}
                      >
                        {entry.title}
                      </span>
                    ) : null}
                    {entry.subtitle ? (
                      <Text tone="secondary" size="small">
                        {entry.subtitle}
                      </Text>
                    ) : null}
                  </Stack>
                ) : null}
                <div style={entry.style}>
                  {/* Only the slide on screen gets a live step. A visited slide
                      kept in the tree renders with its fragments revealed, so
                      returning to it shows the finished build rather than a page
                      with holes in it. */}
                  <FragmentContext.Provider
                    value={position === current ? scope : { step: Number.MAX_SAFE_INTEGER, claim }}
                  >
                    {entry.children}
                  </FragmentContext.Provider>
                </div>
              </Stack>
            </div>
          ) : null,
        )}
      </div>

      {/* Progress rail: one segment per slide, clickable. A dot row stops being
          usable past about 20 slides, and decks get longer than that. */}
      <div style={{ display: 'flex', gap: 1, height: 3, background: tokens.fill.tertiary }}>
        {slides.map((entry, position) => (
          <button
            key={entry.key}
            type="button"
            title={typeof entry.title === 'string' ? entry.title : `Slide ${position + 1}`}
            aria-label={`Go to slide ${position + 1}`}
            onClick={() => go(position)}
            style={{
              flex: 1,
              padding: 0,
              border: 'none',
              cursor: 'pointer',
              background: position <= current ? tokens.accent.primary : 'transparent',
            }}
          />
        ))}
      </div>

      {showNotes ? (
        <div
          style={{
            padding: '8px 10px',
            borderTop: `1px solid ${tokens.stroke.primary}`,
            background: tokens.bg.chrome,
          }}
        >
          {slide.notes ? (
            <Text tone="secondary" size="small">
              {slide.notes}
            </Text>
          ) : (
            <Text tone="quaternary" size="small">
              No notes for this slide.
            </Text>
          )}
        </div>
      ) : null}
    </div>
  )
}
