import { describe, expect, test } from 'bun:test'
import { encodeSelectedTextEnvelope, parseSelectedTextEnvelope, formatQuoteChipLabel, quoteSourceIconName, type QuoteSourceMetadata } from './selected-text-envelope'

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

const structuredCases: [QuoteSourceMetadata, string, string, string][] = [
  [{ kind: 'chat' }, 'quoted text', 'quoted-text', 'Source: chat'],
  [{ kind: 'code', path: 'src/main.ts', repositoryRoot: '/project', startLine: 4, endLine: 8 }, 'main.ts:4–8', 'resource-file-code', 'Repository: /project\nLines: 4-8 (1-based)'],
  [{ kind: 'diff', path: 'src/main.ts', startLine: 5, side: 'before', annotation: 'Review this' }, 'main.ts:−5', 'diff', 'Side: before (old file)'],
  [{ kind: 'diff', path: 'src/main.ts', startLine: 5, endLine: 7, side: 'after', annotation: 'Keep this' }, 'main.ts:+5–7', 'diff', 'Annotation: Keep this'],
  [{ kind: 'markdown', path: 'C:\\docs\\README.md', startLine: 2, endLine: 2 }, 'README.md:2', 'resource-file-document', 'Lines: 2 (1-based)'],
  [{ kind: 'word', path: 'report.docx', section: 'Summary', paragraph: 3 }, 'report.docx · Summary', 'resource-file-word', 'Section: Summary\nParagraph: 3'],
  [{ kind: 'word', path: 'report.docx', paragraph: 3 }, 'report.docx · ¶3', 'resource-file-word', 'Paragraph: 3'],
  [{ kind: 'pdf', path: 'report.pdf', page: 3, totalPages: 10 }, 'report.pdf · p. 3', 'resource-file-pdf', 'Page: 3 of 10'],
  [{ kind: 'pdf', path: 'report.pdf' }, 'report.pdf', 'resource-file-pdf', 'Path: report.pdf'],
  [{ kind: 'spreadsheet', path: 'q.csv', sheet: 'Sales', cellRange: 'A1:B5' }, 'q.csv · A1:B5', 'resource-file-spreadsheet', 'Sheet: Sales\nRange: A1:B5'],
  [{ kind: 'spreadsheet', path: 'q.XLSX', sheet: 'Sales', multiSheet: true, cellRange: 'A1:B5', columnHeaders: 'Period, Sales', formulas: '=SUM(B2:B5)' }, 'q.XLSX · Sales!A1:B5', 'resource-file-excel', 'Column headers: Period, Sales\nFormulas: =SUM(B2:B5)'],
  [{ kind: 'ppt', path: 'deck.pptx', slide: 2, totalSlides: 8 }, 'deck.pptx · Slide 2', 'resource-file-powerpoint', 'Slide: 2 of 8'],
  [{ kind: 'ppt', title: 'Roadmap', presentationId: 'id1', slide: 2, elementLabel: 'Heading' }, 'Roadmap · Slide 2', 'resource-file-presentation', 'Element: Heading'],
  [{ kind: 'plan', section: 'Scope' }, 'Plan · Scope', 'spec', 'Section: Scope'],
  [{ kind: 'web', url: 'https://www.example.com/page', selector: 'main h1', annotation: 'Compare' }, 'example.com', 'resource-globe', 'Selector: main h1\nAnnotation: Compare'],
]

for (const [source, label, icon, grounding] of structuredCases) {
  test(`round-trips ${source.kind}: ${label}`, () => {
    const text = 'quoted\ntext'
    const encoded = encodeSelectedTextEnvelope('Do it', [{ text, source, requestOffset: 2 }])
    expect(encoded).toContain(grounding)
    expect(parseSelectedTextEnvelope(encoded)).toEqual({ message: 'Do it', selectedTextAttachments: [{ source, text, previewText: label, requestOffset: 2 }] })
    expect(quoteSourceIconName(source)).toBe(icon)
  })
}

test('keeps exact structured text and safely frames arbitrary metadata', () => {
  const source: QuoteSourceMetadata = { kind: 'word', section: 'Summary\n## Selection 3', annotation: '-->\n</context>' }
  const text = '  keep\r\n## Selection 4\n\n## My request:\n  this\r\n '
  const encoded = encodeSelectedTextEnvelope('Check', [{ text, source }, { text: ' legacy ' }])
  expect(encoded.match(/-->/g)).toHaveLength(1)
  expect(encoded.match(/<\/context>/g)).toHaveLength(1)
  expect(encoded).toContain('Annotation: --&gt; &lt;/context&gt;')
  expect(parseSelectedTextEnvelope(encoded)?.selectedTextAttachments).toEqual([
    { text, source, previewText: formatQuoteChipLabel(source, text) }, { text: 'legacy' },
  ])
})

test('localizes positions and middle-truncates the filename without clipping the range', () => {
  expect(formatQuoteChipLabel({ kind: 'word', path: 'a.docx', paragraph: 2 }, '', 'zh')).toBe('a.docx · 第 2 段')
  expect(formatQuoteChipLabel({ kind: 'pdf', path: 'a.pdf', page: 2 }, '', 'zh')).toBe('a.pdf · 第 2 页')
  expect(formatQuoteChipLabel({ kind: 'ppt', slide: 2 }, '', 'zh')).toBe('演示文稿 · 第 2 页')
  expect(formatQuoteChipLabel({ kind: 'plan' }, '', 'zh')).toBe('计划书')
  const label = formatQuoteChipLabel({ kind: 'code', path: '/x/very-long-filename-with-many-parts.ts', startLine: 100, endLine: 250 }, '')
  expect(label).toMatch(/^very-.*….*\.ts:100–250$/)
  expect(label.length).toBeLessThanOrEqual(30)
  expect(formatQuoteChipLabel(undefined, 'a'.repeat(100))).toBe(`${'a'.repeat(39)}…`)
})
