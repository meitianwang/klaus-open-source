import { describe, expect, test } from 'bun:test'
import {
  INLINE_VIS_DEFAULT_HEIGHT_PX, INLINE_VIS_DIRECTIVE, INLINE_VIS_MAX_BYTES, INLINE_VIS_MAX_HEIGHT_PX,
  INLINE_VIS_MIN_HEIGHT_PX, INLINE_VIS_PREFIX, INLINE_VIS_PATH_ATTRIBUTE, INLINE_VIS_READY_TIMEOUT_MS,
  inlineVisFileEligible, parseInlineVisDirective,
} from './inline-visualization'
import vectors from './vectors/inline-visualization-vectors.json'

describe('the ::klaus-inline-vis directive contract', () => {
  test('the committed directive vectors match the parser exactly', () => {
    for (const vector of vectors) {
      const parsed = parseInlineVisDirective(vector.source)
      if (vector.parses) {
        expect(parsed).not.toBe(null)
        expect(parsed!.path).toBe(vector.path)
      } else {
        expect(parsed).toBe(null)
      }
    }
  })

  test('committed vectors carry only the reasons the contract allows', () => {
    const reasons = new Set(vectors.map(vector => vector.reason))
    for (const reason of reasons) {
      expect([
        'well-formed', 'prose-glued', 'relative-path', 'empty-path',
        'missing-path-attribute', 'unknown-attribute-only', 'wide-mode',
        'nested-path', 'line-with-trailing-space',
      ]).toContain(reason)
    }
  })

  test('the directive name and prefix are the pinned spellings', () => {
    expect(INLINE_VIS_DIRECTIVE).toBe('klaus-inline-vis')
    expect(INLINE_VIS_PREFIX).toBe('::klaus-inline-vis')
    expect(INLINE_VIS_PATH_ATTRIBUTE).toBe('path')
  })

  // Bounds raised on 2026-10-28: the inline surface sizes itself to the page's
  // intrinsic height, so the cap only bounds pathological pages and the ready
  // wait covers slow self-contained documents.
  test('the presentation bounds are the pinned values', () => {
    expect(INLINE_VIS_MAX_BYTES).toBe(1024 * 1024)
    expect(INLINE_VIS_MAX_HEIGHT_PX).toBe(10_000)
    expect(INLINE_VIS_MIN_HEIGHT_PX).toBe(10)
    expect(INLINE_VIS_DEFAULT_HEIGHT_PX).toBe(240)
    expect(INLINE_VIS_READY_TIMEOUT_MS).toBe(30_000)
  })

  test('inlineVisFileEligible enforces the kebab-case name and the size cap', () => {
    expect(inlineVisFileEligible('home-dashboard.html', undefined)).toBe(true)
    expect(inlineVisFileEligible('home-dashboard.html', new Uint8Array(INLINE_VIS_MAX_BYTES))).toBe(true)
    expect(inlineVisFileEligible('home-dashboard.html', new Uint8Array(INLINE_VIS_MAX_BYTES + 1))).toBe(false)
    expect(inlineVisFileEligible('Home-Dashboard.html', undefined)).toBe(false)
    expect(inlineVisFileEligible('home_dashboard.html', undefined)).toBe(false)
    expect(inlineVisFileEligible('page.htm', undefined)).toBe(false)
    expect(inlineVisFileEligible('a/b.html', undefined)).toBe(false)
  })

  test('mode="wide" parses but carries no behavior', () => {
    const parsed = parseInlineVisDirective('::klaus-inline-vis{path="/tmp/a/vis.html" mode="wide"}')
    expect(parsed).not.toBe(null)
    expect(parsed!.path).toBe('/tmp/a/vis.html')
    expect(Object.hasOwn(parsed!, 'mode')).toBe(false)
  })
})
