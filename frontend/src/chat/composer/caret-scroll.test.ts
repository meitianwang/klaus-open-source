import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { scrollCaretIntoView } from './caret-scroll'

const CHAT_TS = readFileSync(fileURLToPath(new URL('../chat.ts', import.meta.url)), 'utf8')

interface EditorGeometry {
  clientHeight: number
  scrollHeight: number
  scrollTop?: number
  boxTop?: number
  boxBottom?: number
  /** Caret rect in viewport coordinates; null means no selection at all. */
  caret?: { top: number; bottom: number } | null
  caretHeight?: number
  padTop?: number
  padBottom?: number
  /** False models a selection that belongs to some other surface. */
  selectionInEditor?: boolean
}

/**
 * A geometry-only stand-in for the composer. The rule under test is purely
 * arithmetic — how far the caret overflows the padded visible box — so the fake
 * models rectangles and scroll bounds and nothing else. `scrollTop` clamps like a
 * real scroll container, which is what makes the "already visible" and "no
 * overflow" cases assert something real rather than a tautology.
 */
function makeEditor(geometry: EditorGeometry) {
  const clientHeight = geometry.clientHeight
  const scrollHeight = geometry.scrollHeight
  const boxTop = geometry.boxTop ?? 0
  const boxBottom = boxTop + clientHeight
  const caret = geometry.caret
  const caretHeight = geometry.caretHeight ?? (caret ? caret.bottom - caret.top : 0)
  const inEditor = geometry.selectionInEditor ?? true

  const caretRect = caret
    ? { top: caret.top, bottom: caret.bottom, height: caretHeight, width: 1 }
    : { top: 0, bottom: 0, height: 0, width: 0 }

  const range = {
    endContainer: inEditor ? { __endContainer: true } : { __foreign: true },
    cloneRange() {
      return {
        collapse() {},
        getBoundingClientRect() { return caretRect },
        getClientRects() { return caretRect.height > 0 ? [caretRect] : [] },
      }
    },
  }

  const root: any = {
    clientHeight,
    scrollHeight,
    scrollTop: geometry.scrollTop ?? 0,
    getBoundingClientRect() { return { top: boxTop, bottom: boxBottom, height: clientHeight } },
    contains(node: any) { return inEditor && node?.__endContainer === true },
    ownerDocument: {
      defaultView: {
        getSelection() { return caret === null ? { rangeCount: 0 } : { rangeCount: 1, getRangeAt: () => range } },
        getComputedStyle() {
          return { paddingTop: `${geometry.padTop ?? 0}px`, paddingBottom: `${geometry.padBottom ?? 0}px` }
        },
      },
    },
  }
  return root
}

describe('composer caret scroll', () => {
  test('leaves scroll alone when the content fits the box', () => {
    // No overflow: the box grew to fit, so there is nothing to scroll and an
    // adjustment here would only fight the height the app just set.
    const root = makeEditor({ clientHeight: 200, scrollHeight: 120, caret: { top: 100, bottom: 121 } })
    scrollCaretIntoView(root)
    expect(root.scrollTop).toBe(0)
  })

  test('scrolls down by exactly the overflow when the caret is below the box', () => {
    // The shift+Enter regression: content 575 tall in a 200 box, caret on the
    // last line well under the bottom edge. It must come up by the overflow only,
    // not snap to an arbitrary bottom.
    const root = makeEditor({
      clientHeight: 200, scrollHeight: 575, boxTop: 43,
      caret: { top: 590, bottom: 611 },
    })
    scrollCaretIntoView(root)
    // Caret bottom 611 vs view bottom 243 → scroll down 368.
    expect(root.scrollTop).toBe(368)
    // And the caret now sits inside the visible box.
    const caretTopAfter = 590 - 368
    const caretBottomAfter = 611 - 368
    expect(caretTopAfter).toBeGreaterThanOrEqual(43)
    expect(caretBottomAfter).toBeLessThanOrEqual(243)
  })

  test('scrolls up by exactly the overflow when the caret is above the box', () => {
    // Undo or a click on an earlier line can put the caret above the visible
    // area; forcing the bottom there would be jarring, so the move is upward and
    // minimal.
    const root = makeEditor({
      clientHeight: 200, scrollHeight: 575, boxTop: 43, scrollTop: 300,
      caret: { top: 20, bottom: 41 },
    })
    scrollCaretIntoView(root)
    // Caret top 20 vs view top 43 → scroll up 23.
    expect(root.scrollTop).toBe(277)
  })

  test('does not move when the caret is already fully visible', () => {
    const root = makeEditor({
      clientHeight: 200, scrollHeight: 575, boxTop: 43, scrollTop: 150,
      caret: { top: 100, bottom: 121 },
    })
    scrollCaretIntoView(root)
    expect(root.scrollTop).toBe(150)
  })

  test('keeps the caret inside the padding, not merely inside the border box', () => {
    // The composer has 4px vertical padding. Measuring to the border box would
    // leave the caret clipped by the padding edge, so the target is the inset box.
    const root = makeEditor({
      clientHeight: 200, scrollHeight: 575, boxTop: 43, padTop: 4, padBottom: 4,
      caret: { top: 236, bottom: 241 },
    })
    scrollCaretIntoView(root)
    // View bottom is 243 - 4 = 239; caret bottom 241 overflows by 2.
    expect(root.scrollTop).toBe(2)
  })

  test('ignores a selection that belongs to another surface', () => {
    // autoResize also runs on session switch and window resize, when the composer
    // is not the focused editor. Acting on some other selection would scroll the
    // composer to a position the user never chose.
    const root = makeEditor({
      clientHeight: 200, scrollHeight: 575, boxTop: 43, scrollTop: 90,
      caret: { top: 900, bottom: 921 }, selectionInEditor: false,
    })
    scrollCaretIntoView(root)
    expect(root.scrollTop).toBe(90)
  })

  test('leaves scroll untouched for an unmeasurable caret', () => {
    // An empty last line reports a zero-height caret rect. Guessing the bottom
    // here would be worse than staying put — it could fire mid-IME, when the
    // composer's input listener also runs this on composition updates — so the
    // honest move is none.
    const root = makeEditor({
      clientHeight: 200, scrollHeight: 575, boxTop: 43, scrollTop: 90,
      caret: { top: 0, bottom: 0 }, caretHeight: 0,
    })
    scrollCaretIntoView(root)
    expect(root.scrollTop).toBe(90)
  })

  test('does nothing when there is no selection to measure', () => {
    const root = makeEditor({ clientHeight: 200, scrollHeight: 575, boxTop: 43, caret: null })
    expect(() => scrollCaretIntoView(root)).not.toThrow()
    expect(root.scrollTop).toBe(0)
  })

  test('tolerates a missing or detached editor', () => {
    expect(() => scrollCaretIntoView(null)).not.toThrow()
    expect(() => scrollCaretIntoView(undefined)).not.toThrow()
  })

  test('both composers call it from their resize chokepoint', () => {
    // The fix has to run wherever the app rewrote the value, and every such path
    // funnels through autoResize / sideAutoResize. Asserting the wiring keeps a
    // future refactor from dropping the call and silently reopening the bug.
    const mainResize = CHAT_TS.slice(CHAT_TS.indexOf('function autoResize() {'))
    expect(mainResize.slice(0, mainResize.indexOf('\n}'))).toContain('scrollCaretIntoView(inputEl)')
    const sideResize = CHAT_TS.slice(CHAT_TS.indexOf('function sideAutoResize() {'))
    expect(sideResize.slice(0, sideResize.indexOf('\n  }'))).toContain('scrollCaretIntoView(sideInput)')
    // The scroll must land before the mirror layer reads scrollTop, otherwise the
    // chip layer paints at the old offset and desyncs from the text.
    const scrollCall = mainResize.indexOf('scrollCaretIntoView(inputEl)')
    const mirrorSync = mainResize.indexOf('syncComposerTokenScroll()')
    expect(scrollCall).toBeGreaterThan(-1)
    expect(mirrorSync).toBeGreaterThan(scrollCall)
  })
})
