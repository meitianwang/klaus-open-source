// Annotation mode: the USER pointing at part of a canvas and asking about it.
//
// This closes the one direction the SDK cannot. `SendToChatButton` only exists
// where the MODEL decided to put one, so without this the reader can only ask
// about the things the author anticipated. Annotation makes any element a
// starting point for the next question.
//
// It lives in the window chrome, not the SDK, and that placement is the design:
//   - A canvas must not be able to trigger it, suppress it, or read what the user
//     selected. Model-authored code deciding when the user gets to annotate is
//     backwards.
//   - It needs to hit-test the WHOLE canvas tree, including elements a canvas
//     rendered without any SDK involvement.
//
// The selected element is described by its visible text plus its position in the
// document, because that is what the model can actually act on. A CSS selector
// would be precise and useless — the next turn rewrites the file, so a path into
// the old DOM points at nothing.

import { useCallback, useEffect, useRef, useState } from 'react'

/** What the user picked, reduced to what is worth sending. */
export interface Annotation {
  /** Visible text of the picked element, trimmed and capped. */
  text: string
  /** The nearest heading above the element, for orientation. */
  section?: string
  /** The user's note. */
  note: string
}

/** Cap on quoted text. A whole table would bury the note underneath it. */
const MAX_QUOTE = 400

/**
 * Selector for elements that ARE the unit a person points at, whatever their
 * text length.
 *
 * Matched with `closest()` BEFORE any climbing, because a cell's own text is
 * short: clicking "query parse" in a table would otherwise satisfy the generic
 * rules at the cell and quote half a row. The row is the unit; the cell is part
 * of one.
 */
const NATURAL_UNIT_SELECTOR = 'tr, li, figure, blockquote, dd, dt'

/** Minimum text for a GENERIC element to count as a quotable unit on its own. */
const MIN_GENERIC_TEXT = 24

/**
 * Minimum text before a sibling-group boundary is allowed to stop the climb.
 *
 * Below this, an element is a fragment even if it has siblings — the value span
 * inside a stat sits beside its unit span, and "290" alone is not something the
 * model can act on.
 */
const MIN_SIBLING_TEXT = 8

function textOf(element: Element): string {
  return (element.textContent ?? '').trim()
}

/** How many element children carry text. Two or more means a collection. */
function textBearingChildren(element: Element): number {
  let count = 0
  for (const child of Array.from(element.children)) {
    if (textOf(child).length > 0) count += 1
  }
  return count
}

/**
 * The element the user actually meant.
 *
 * A raw `event.target` is usually a bare text span with two words in it, which
 * quotes badly. Walking up finds the unit a person would point at — "the row",
 * "the stat", "the callout".
 *
 * Four rules, in order:
 *   1. A structural unit ancestor (`tr`, `li`, …) wins outright.
 *   2. Never return something containing a HEADING. That means the climb reached
 *      a whole section, and quoting a section is the same as quoting the page.
 *   3. Enough text and height on its own → that is the unit.
 *   4. Otherwise stop at a SIBLING-GROUP boundary: if the parent holds two or
 *      more text-bearing children, this element is one item among peers, and
 *      climbing further would quote all of them. That is what turned a click on
 *      one stat into a quote of the whole three-stat grid.
 */
function meaningfulTarget(start: Element, root: Element): Element {
  const unit = start.closest(NATURAL_UNIT_SELECTOR)
  if (unit && root.contains(unit) && unit !== root) return unit

  let node: Element | null = start
  let best: Element = start
  while (node && node !== root) {
    if (node.querySelector('h1, h2, h3')) return best
    const text = textOf(node)
    if (text.length > 0) best = node
    if (text.length >= MIN_GENERIC_TEXT && node.getBoundingClientRect().height >= 18) {
      return node
    }
    const parent: Element | null = node.parentElement
    if (
      text.length >= MIN_SIBLING_TEXT &&
      parent &&
      parent !== root &&
      textBearingChildren(parent) >= 2
    ) {
      return node
    }
    node = parent
  }
  return best
}

/** The nearest preceding heading, for "which section is this in". */
function sectionOf(element: Element, root: Element): string | undefined {
  const headings = Array.from(root.querySelectorAll('h1, h2, h3'))
  if (headings.length === 0) return undefined
  let found: string | undefined
  for (const heading of headings) {
    // compareDocumentPosition: heading precedes element.
    if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const text = (heading.textContent ?? '').trim()
      if (text) found = text
    }
  }
  return found
}

/**
 * The text to quote back, as a reader sees it.
 *
 * `innerText`, not `textContent`. `textContent` concatenates sibling elements with
 * nothing between them, so a stat came out as "p95 after290ms" and a table row as
 * "index lookup108ms" — both garbled in a way that makes the quote harder to act
 * on. `innerText` is the RENDERED text: it puts breaks at block boundaries and
 * tabs between table cells, which normalizes to the spacing a person read.
 *
 * `textContent` stays as the fallback for elements that have no layout (SVG
 * nodes, anything detached), where `innerText` is unavailable or empty.
 */
function quote(element: Element): string {
  const rendered =
    element instanceof HTMLElement ? element.innerText : ''
  const source = rendered.trim().length > 0 ? rendered : (element.textContent ?? '')
  const text = source.replace(/\s+/g, ' ').trim()
  return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect()
  return { top: box.top, left: box.left, width: box.width, height: box.height }
}

export interface AnnotationLayerProps {
  /** The scroll container holding the canvas. Hit-testing is scoped to it. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Turn the mode off — the layer asks for this after submit or cancel. */
  onExit: () => void
  /** Called with the finished annotation. Returns false to report a failure. */
  onSubmit: (annotation: Annotation) => Promise<boolean>
}

/**
 * The pick-and-note overlay. Mounted only while annotation mode is on.
 *
 * Two phases: hovering (highlight follows the pointer) and picked (highlight
 * frozen, note box open). Escape leaves at either phase, because a mode with no
 * visible way out is a trap.
 */
export function AnnotationLayer({ containerRef, onExit, onSubmit }: AnnotationLayerProps) {
  const [hover, setHover] = useState<Rect | null>(null)
  const [picked, setPicked] = useState<{ rect: Rect; text: string; section?: string } | null>(null)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<'idle' | 'sending' | 'failed'>('idle')
  const input = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (picked) input.current?.focus()
  }, [picked])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onExit()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onExit])

  // The overlay sits ON TOP of the canvas, so it has to hit-test by coordinate
  // rather than by receiving the event: `pointer-events: none` on itself, then
  // `elementFromPoint` to find what is underneath. Letting the canvas receive the
  // events instead would fire its own onClick handlers while the user is only
  // trying to point at something.
  const locate = useCallback(
    (clientX: number, clientY: number) => {
      const root = containerRef.current
      if (!root) return null
      const under = document.elementFromPoint(clientX, clientY)
      if (!under || !root.contains(under)) return null
      return meaningfulTarget(under, root)
    },
    [containerRef],
  )

  useEffect(() => {
    if (picked) return
    const onMove = (event: PointerEvent) => {
      const element = locate(event.clientX, event.clientY)
      setHover(element ? rectOf(element) : null)
    }
    const onClick = (event: MouseEvent) => {
      const root = containerRef.current
      const element = locate(event.clientX, event.clientY)
      if (!element || !root) return
      event.preventDefault()
      event.stopPropagation()
      setPicked({ rect: rectOf(element), text: quote(element), section: sectionOf(element, root) })
    }
    document.addEventListener('pointermove', onMove)
    // Capture phase: the canvas's own handlers must not run for this click.
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('click', onClick, true)
    }
  }, [containerRef, locate, picked])

  const submit = useCallback(async () => {
    if (!picked || !note.trim()) return
    setPhase('sending')
    const ok = await onSubmit({ text: picked.text, section: picked.section, note: note.trim() })
    if (ok) {
      onExit()
      return
    }
    setPhase('failed')
  }, [note, onExit, onSubmit, picked])

  const box = picked?.rect ?? hover
  // Put the note card below the selection, or above it when there is no room.
  const below = picked ? picked.rect.top + picked.rect.height + 8 : 0
  const cardTop = picked
    ? below + 150 > window.innerHeight
      ? Math.max(8, picked.rect.top - 158)
      : below
    : 0

  return (
    <>
      <div className="cv-annotate-scrim" aria-hidden="true" />
      {box ? (
        <div
          className={picked ? 'cv-annotate-box is-picked' : 'cv-annotate-box'}
          aria-hidden="true"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      ) : null}
      {!picked ? (
        <div className="cv-annotate-hint" role="status">
          Click anything to ask about it · Esc to cancel
        </div>
      ) : null}
      {picked ? (
        <div
          className="cv-annotate-card"
          role="dialog"
          aria-label="Ask about this"
          style={{ top: cardTop, left: Math.min(picked.rect.left, window.innerWidth - 380) }}
        >
          <p className="cv-annotate-quote">{picked.text}</p>
          <textarea
            ref={input}
            className="cv-annotate-input"
            rows={2}
            value={note}
            placeholder="What do you want to know about this?"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line: the same contract as the
              // chat composer this text is headed for.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
          />
          <div className="cv-annotate-actions">
            {phase === 'failed' ? (
              <span className="cv-annotate-failed">Could not reach the chat</span>
            ) : null}
            <button type="button" className="cv-action" onClick={onExit}>
              Cancel
            </button>
            <button
              type="button"
              className="cv-action is-primary"
              disabled={!note.trim() || phase === 'sending'}
              onClick={() => void submit()}
            >
              {phase === 'sending' ? 'Sending…' : 'Ask'}
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * The message an annotation becomes.
 *
 * Blockquote for the element's text so the model can tell the user's words from
 * the canvas's, and the canvas file path last so a follow-up edit knows which
 * file to open. The section name is included when there is one — "the 290ms" is
 * ambiguous in a report with four latency tables.
 */
export function annotationMessage(annotation: Annotation, filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath
  const lines: string[] = []
  lines.push(annotation.note)
  lines.push('')
  if (annotation.section) {
    lines.push(`About this, under "${annotation.section}" in ${name}:`)
  } else {
    lines.push(`About this, in ${name}:`)
  }
  lines.push(`> ${annotation.text}`)
  lines.push('')
  lines.push(filePath)
  return lines.join('\n')
}
