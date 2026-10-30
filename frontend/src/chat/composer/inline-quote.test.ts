import { describe, expect, test } from 'bun:test'
import {
  composeInlineQuotes,
  composePastedTextRequest,
  composeSlashTextCards,
  composerOffsetFromDisplayOffset,
  expandSelectionAcrossInlineQuotes,
  insertInlineQuotePlaceholder,
  positionAfterRemovingInlineTokens,
  replaceInlineTokenRange,
  restoreInlineQuotePlaceholders,
  syncInlineQuoteRanges,
} from './inline-quote'

describe('inline quote composition', () => {
  test('draft serialization preserves whitespace while submission still trims it', () => {
    const value = '\n  before    after\t\n'
    const quotes = [{ text: 'quoted', range: { start: 9, end: 13 } }]
    const draft = composeInlineQuotes(value, quotes, false)
    expect(draft.text).toBe('\n  beforeafter\t\n')
    expect(draft.quotes[0].requestOffset).toBe(9)
    expect(composeInlineQuotes(value, quotes).text).toBe('beforeafter')
  })
  test('keeps quote and text order when several quotes are interleaved', () => {
    const first = insertInlineQuotePlaceholder('', 0, 0, '    ')
    const second = insertInlineQuotePlaceholder(first.value + '这是第一个 ', first.value.length + 6, first.value.length + 6, '     ')
    const tokens: Array<{ text: string; range: { start: number; end: number } }> = [
      { text: '引用一', range: first.range },
      { text: '引用二', range: second.range },
    ]
    const result = composeInlineQuotes(second.value + '是咋回事', tokens)
    expect(result.text).toBe('这是第一个 是咋回事')
    expect(result.quotes.map(quote => ({ text: quote.text, requestOffset: quote.requestOffset }))).toEqual([
      { text: '引用一', requestOffset: 0 },
      { text: '引用二', requestOffset: 6 },
    ])
  })

  test('moves later quote ranges and drops a quote when its placeholder is edited', () => {
    const tokens: Array<{ text: string; range: { start: number; end: number } }> = [
      { text: 'one', range: { start: 2, end: 6 } },
      { text: 'two', range: { start: 9, end: 13 } },
    ]
    const shifted = syncInlineQuoteRanges('a     b      c', 'prefix a     b      c', tokens)
    expect(shifted.tokens.map(token => token.range)).toEqual([
      { start: 9, end: 13 },
      { start: 16, end: 20 },
    ])
    const removed = syncInlineQuoteRanges('prefix a     b      c', 'prefix a b      c', shifted.tokens)
    expect(removed.removed.map(token => token.text)).toEqual(['one'])
  })

  test('keeps a non-breaking-space token when adjacent prose whitespace changes', () => {
    const placeholder = '\u00a0'.repeat(4)
    const token = { text: 'payload', range: { start: 2, end: 6 } }
    const removedSeparator = syncInlineQuoteRanges(`a ${placeholder}b`, `a${placeholder}b`, [token])
    expect(removedSeparator.removed).toEqual([])
    expect(token.range).toEqual({ start: 1, end: 5 })

    const addedSeparator = syncInlineQuoteRanges(`a${placeholder}b`, `a ${placeholder}b`, [token])
    expect(addedSeparator.removed).toEqual([])
    expect(token.range).toEqual({ start: 2, end: 6 })
  })

  test('keeps same-offset tokens separate when restored one at a time', () => {
    const placeholder = '\u00a0'.repeat(4)
    const first = insertInlineQuotePlaceholder('ab', 1, 1, placeholder)
    const token = { text: 'later', range: first.range }
    insertInlineQuotePlaceholder(first.value, 1, 1, placeholder)
    const synced = replaceInlineTokenRange(1, 1, placeholder.length, [token])

    expect(synced.removed).toEqual([])
    expect(token.range).toEqual({ start: 5, end: 9 })
  })

  test('deletes the selected adjacent token instead of an identical sibling', () => {
    const first = { text: 'first', range: { start: 1, end: 5 } }
    const second = { text: 'second', range: { start: 5, end: 9 } }
    const result = replaceInlineTokenRange(1, 5, 0, [first, second])

    expect(result.removed).toEqual([first])
    expect(second.range).toEqual({ start: 1, end: 5 })
  })

  test('expands deletion and restores persisted offsets as atomic placeholders', () => {
    const range = expandSelectionAcrossInlineQuotes(5, 5, [{ text: 'quote', range: { start: 1, end: 5 } }], 'deleteContentBackward')
    expect(range).toEqual({ start: 1, end: 5 })

    const tokens: Array<{ text: string; requestOffset: number; range?: { start: number; end: number } }> = [
      { text: 'first', requestOffset: 0 },
      { text: 'third', requestOffset: 3 },
    ]
    const value = restoreInlineQuotePlaceholders('abc', tokens, () => '    ')
    expect(value).toBe('    abc    ')
    expect(tokens.map(token => token.range)).toEqual([
      { start: 0, end: 4 },
      { start: 7, end: 11 },
    ])
  })

  test('restores mixed chips at the same offset in display order', () => {
    const tokens: Array<{ text: string; requestOffset: number; displayOrder: number; range?: { start: number; end: number } }> = [
      { text: 'second', requestOffset: 1, displayOrder: 1 },
      { text: 'first', requestOffset: 1, displayOrder: 0 },
    ]
    const value = restoreInlineQuotePlaceholders('ab', tokens, token => `[${token.text}]`)

    expect(value).toBe('a[first][second]b')
  })

  test('places pasted text after the prose that introduces it', () => {
    const cards = [{
      text: 'curl -X POST https://example.test',
      requestOffset: '给我配置一个自定义模型，请求如下：'.length,
      displayOrder: 0,
    }]
    const result = composePastedTextRequest('给我配置一个自定义模型，请求如下：', cards)

    expect(result.text).toBe('给我配置一个自定义模型，请求如下：\n\ncurl -X POST https://example.test')
  })

  test('shifts later quote offsets past inserted pasted text', () => {
    const result = composePastedTextRequest('请求如下：继续处理', [{
      text: 'curl request',
      requestOffset: 5,
      displayOrder: 0,
    }])

    expect(result.text).toBe('请求如下：\n\ncurl request\n\n继续处理')
    expect(result.requestOffsetFor(5, 1)).toBe('请求如下：\n\ncurl request\n\n'.length)
  })

  test('keeps pasted cards with the same display offset in authored order', () => {
    const result = composePastedTextRequest('请求如下：', [
      { text: 'first payload', requestOffset: 5, displayOrder: 0 },
      { text: 'second payload', requestOffset: 5, displayOrder: 1 },
    ])

    expect(result.text).toBe('请求如下：\n\nfirst payload\n\nsecond payload')
  })

  test('keeps a slash command first and flattens mixed cards in authored order', () => {
    expect(composeSlashTextCards('/push-code', [
      { kind: 'selected-text', text: 'quote', displayOrder: 1 },
      { kind: 'pasted-text', text: 'paste', displayOrder: 0 },
    ])).toBe('/push-code\n\npaste\n\nquote')
  })

  test('maps display offsets around a slash chip back into the composer placeholder', () => {
    const slashRange = { start: 0, end: 20 }
    expect(composerOffsetFromDisplayOffset(0, 40, slashRange, 10)).toBe(0)
    expect(composerOffsetFromDisplayOffset(5, 40, slashRange, 10)).toBe(20)
    expect(composerOffsetFromDisplayOffset(10, 40, slashRange, 10)).toBe(20)
    expect(composerOffsetFromDisplayOffset(12, 40, slashRange, 10)).toBe(22)
    expect(composerOffsetFromDisplayOffset(30, 40, slashRange, 10, 8)).toBe(32)
  })

  test('moves a slash range left when an inline card precedes it', () => {
    expect(positionAfterRemovingInlineTokens(14, [{ range: { start: 0, end: 4 } }])).toBe(10)
  })
})
