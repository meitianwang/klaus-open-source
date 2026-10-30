import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = { addEventListener: () => {} }
const { buildElicitAnswerValues, findElicitOtherOptionIndex } = await import('./approval-cards')

describe('ask_user custom answers', () => {
  test('recognizes supplied Chinese and English Other options', () => {
    expect(findElicitOtherOptionIndex(['A', '其他（请补充链接或截图）'])).toBe(1)
    expect(findElicitOtherOptionIndex(['A', 'Other (specify)'])).toBe(1)
    expect(findElicitOtherOptionIndex(['A', 'Otherwise continue'])).toBe(-1)
  })

  test('replaces the Other label with the typed answer', () => {
    const options = ['Memos', '其他（请说明）']
    expect(buildElicitAnswerValues(options, [1], 1, 'https://example.com')).toEqual([
      'https://example.com',
    ])
  })

  test('keeps selected options and appends a custom multi-select answer', () => {
    const options = ['One', 'Other (specify)']
    expect(buildElicitAnswerValues(options, [0, 1], 1, 'Three')).toEqual(['One', 'Three'])
  })

  test('does not submit an empty custom answer or the Other label', () => {
    expect(buildElicitAnswerValues(['One', 'Other'], [1], 1, '   ')).toEqual([])
  })
})
