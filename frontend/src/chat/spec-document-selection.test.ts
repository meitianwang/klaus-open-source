import { describe, expect, test } from 'bun:test'
import { locateSpecAnnotation, specAnnotationSegments } from './spec-document-selection'

describe('Spec annotation navigation', () => {
  test('maps a quote across inline text nodes without highlighting surrounding text', () => {
    const nodes = ['Before ', 'a bold', ' and linked', ' phrase', ' after']
    const location = locateSpecAnnotation(nodes.join(''), { content: 'bold and linked phrase' })
    expect(location).toEqual({ start: 9, end: 31 })
    expect(specAnnotationSegments(nodes, location!)).toEqual([
      { nodeIndex: 1, start: 2, end: 6 },
      { nodeIndex: 2, start: 0, end: 11 },
      { nodeIndex: 3, start: 0, end: 7 },
    ])
  })

  test('preserves a repeated selection using validated rendered offsets', () => {
    const text = 'first result; second result'
    expect(locateSpecAnnotation(text, { content: 'result', startOffset: 21, endOffset: 27 })).toEqual({ start: 21, end: 27 })
  })

  test('uses the paragraph anchor when edits move a repeated quote', () => {
    const text = 'New result. First result. Target result here.'
    expect(locateSpecAnnotation(text, { content: 'result', startOffset: 4, endOffset: 10, anchorText: 'Target result here.' })).toEqual({ start: 33, end: 39 })
  })

  test('trims captured selection whitespace while honoring its original range', () => {
    expect(locateSpecAnnotation('Before  value  after', { content: 'value', startOffset: 7, endOffset: 15 })).toEqual({ start: 8, end: 13 })
  })

  test('does not select stale offsets when the quote has disappeared', () => {
    expect(locateSpecAnnotation('Completely changed', { content: 'Old text', startOffset: 0, endOffset: 8 })).toBeNull()
    expect(locateSpecAnnotation('Completely changed', { content: '  ' })).toBeNull()
  })

  test('keeps DOM UTF-16 offsets stable for Unicode and ignores empty nodes', () => {
    const nodes = ['说明😀', '', '新增段落']
    const location = locateSpecAnnotation(nodes.join(''), { content: '😀新增' })
    expect(location).toEqual({ start: 2, end: 6 })
    expect(specAnnotationSegments(nodes, location!)).toEqual([
      { nodeIndex: 0, start: 2, end: 4 },
      { nodeIndex: 2, start: 0, end: 2 },
    ])
  })

  test('rejects out-of-bounds and empty highlight ranges', () => {
    expect(specAnnotationSegments(['text'], { start: 0, end: 5 })).toEqual([])
    expect(specAnnotationSegments(['text'], { start: -1, end: 2 })).toEqual([])
    expect(specAnnotationSegments(['text'], { start: 2, end: 2 })).toEqual([])
  })
})
