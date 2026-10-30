import { describe, expect, test } from 'bun:test'
import { encodeSelectedTextEnvelope, parseSelectedTextEnvelope } from './selected-text-envelope'

describe('selected text envelope', () => {
  test('round-trips short and multiple selections', () => {
    const encoded = encodeSelectedTextEnvelope('Apply this change.', [
      { text: 'short quote' },
      { text: 'second\nquote' },
    ])
    expect(encoded).toBe('# Selected text:\n\n## Selection 1\nshort quote\n\n## Selection 2\nsecond\nquote\n\n## My request:\nApply this change.\n')
    expect(parseSelectedTextEnvelope(encoded)).toEqual({
      selectedTextAttachments: [{ text: 'short quote' }, { text: 'second\nquote' }],
      message: 'Apply this change.',
    })
  })

  test('leaves ordinary and malformed user text alone', () => {
    expect(encodeSelectedTextEnvelope('ordinary', [])).toBe('ordinary')
    expect(parseSelectedTextEnvelope('ordinary')).toBeNull()
    expect(parseSelectedTextEnvelope('# Selected text:\n\nnot an envelope')).toBeNull()
  })

  test('supports a quote-only request', () => {
    const encoded = encodeSelectedTextEnvelope('', [{ text: 'quoted' }])
    expect(parseSelectedTextEnvelope(encoded)).toEqual({
      selectedTextAttachments: [{ text: 'quoted' }],
      message: '',
    })
  })

  test('keeps slash commands at the start of the model input', () => {
    const encoded = encodeSelectedTextEnvelope('/review this', [{ text: 'quoted' }])
    expect(encoded).toBe('/review this\n\nquoted')
    expect(parseSelectedTextEnvelope(encoded)).toBeNull()
  })

  test('round-trips the positions of quotes interleaved with request text', () => {
    const encoded = encodeSelectedTextEnvelope('这是第一个 是咋回事', [
      { text: '引用一', requestOffset: 0 },
      { text: '引用二', requestOffset: 6 },
    ])
    expect(encoded).toContain('⟦Selection 1⟧这是第一个 ⟦Selection 2⟧是咋回事')
    expect(parseSelectedTextEnvelope(encoded)).toEqual({
      selectedTextAttachments: [
        { text: '引用一', requestOffset: 0 },
        { text: '引用二', requestOffset: 6 },
      ],
      message: '这是第一个 是咋回事',
    })
  })

  test('orders persisted selections by request position, not creation order', () => {
    const encoded = encodeSelectedTextEnvelope('前后', [
      { text: '后引用', requestOffset: 1 },
      { text: '前引用', requestOffset: 0 },
    ])
    expect(parseSelectedTextEnvelope(encoded)).toEqual({
      selectedTextAttachments: [
        { text: '前引用', requestOffset: 0 },
        { text: '后引用', requestOffset: 1 },
      ],
      message: '前后',
    })
  })

  test('preserves authored display order for adjacent selections at the same offset', () => {
    const encoded = encodeSelectedTextEnvelope('ab', [
      { text: 'later', requestOffset: 1, displayOrder: 1 },
      { text: 'first', requestOffset: 1, displayOrder: 0 },
    ])
    expect(parseSelectedTextEnvelope(encoded)).toEqual({
      selectedTextAttachments: [
        { text: 'first', requestOffset: 1 },
        { text: 'later', requestOffset: 1 },
      ],
      message: 'ab',
    })
  })
})
