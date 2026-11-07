import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mapCaretAroundToken, placeholderCount, shiftPositionAfterRemoval } from './slash-placeholder'

const STYLES_CSS = readFileSync(
  fileURLToPath(new URL('../../../css/styles.css', import.meta.url)),
  'utf8',
)

describe('composer mirror layer invariants', () => {
  test('the input hides its native scrollbar so both text layers wrap at the same width', () => {
    const start = STYLES_CSS.indexOf('#input[contenteditable="true"], :is(#side-input, #left-side-input)[contenteditable="true"] {')
    expect(start).toBeGreaterThanOrEqual(0)
    const rule = STYLES_CSS.slice(start, STYLES_CSS.indexOf('}', start))
    expect(rule).toContain('scrollbar-width: none;')
    expect(STYLES_CSS).toContain('#input[contenteditable="true"]::-webkit-scrollbar,')
  })
})

describe('slash chip placeholder geometry', () => {
  test('reserves at least four spaces and rounds up to whole spaces', () => {
    expect(placeholderCount(0, 4)).toBe(4)
    expect(placeholderCount(10, 4)).toBe(4) // ceil(12/4)=3, floored at 4
    expect(placeholderCount(14, 4)).toBe(4) // ceil(16/4)
    expect(placeholderCount(15, 4)).toBe(5) // ceil(17/4)
  })

  test('clamps degenerate space widths so a zero-width space cannot explode the run', () => {
    expect(placeholderCount(100, 0)).toBe(Math.ceil(102 / 3))
    expect(placeholderCount(100, -5)).toBe(Math.ceil(102 / 3))
  })

  test('keeps caret positions outside a resized placeholder and collapses inside ones', () => {
    const range = { start: 10, end: 20 }
    expect(mapCaretAroundToken(0, range, 4)).toBe(0)
    expect(mapCaretAroundToken(10, range, 4)).toBe(10)
    expect(mapCaretAroundToken(15, range, 4)).toBe(10)
    expect(mapCaretAroundToken(20, range, 4)).toBe(24)
    expect(mapCaretAroundToken(30, range, -3)).toBe(27)
  })

  test('shifts a trigger range captured before an existing chip removal', () => {
    // draft: "abc<chip 10 spaces>def /q" — chip removed with its trailing space
    const removed = { start: 3, end: 14 }
    expect(shiftPositionAfterRemoval(0, removed)).toBe(0)
    expect(shiftPositionAfterRemoval(3, removed)).toBe(3)
    expect(shiftPositionAfterRemoval(8, removed)).toBe(3)
    expect(shiftPositionAfterRemoval(20, removed)).toBe(9)
  })
})
