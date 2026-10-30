import { expect, test } from 'bun:test'
import { Slice } from 'prosemirror-model'
import MarkdownIt from 'markdown-it'
import { composerDocumentSchema as schema, composerTokenNode } from './document-model'
import { clipboardHiddenLinkLength, clipboardLinkFallback } from './clipboard-link-budget'
import { clipboardAttachmentDocumentText, clipboardAttachmentText } from './clipboard-attachment-text'
import vectors from '../../../../contracts/vectors/composer-clipboard-semantic-vectors.json'

const paragraph = (text: string, href?: string, title: string | null = null) => schema.nodes.paragraph.create(null,
  text ? schema.text(text, href === undefined ? undefined : [schema.marks.link.create({ href, title })]) : undefined)
const document = (...nodes: ReturnType<typeof paragraph>[]) => schema.nodes.doc.create(null, nodes)
const slice = (...nodes: ReturnType<typeof paragraph>[]) => new Slice(document(...nodes).content, 0, 0)
const hrefOfLength = (length: number) => 'https://e.test/' + 'x'.repeat(length - 'https://e.test/'.length)

test('hidden link fallback observes both the exact and relative UTF-16 limits', () => {
  const limit = vectors.hiddenLink.minimumUnits
  expect(clipboardLinkFallback(slice(paragraph('label', hrefOfLength(limit - 1))), 'plain')).toBeNull()
  const content = slice(paragraph('label', hrefOfLength(limit)))
  expect(clipboardLinkFallback(content, 'plain')).toBe('plain')
  expect(clipboardLinkFallback(content, '')).toBe('label')
  expect(clipboardLinkFallback(content, 'x'.repeat(limit + 1))).toBeNull()
  expect(clipboardLinkFallback(slice(paragraph('x'.repeat(limit + 1), hrefOfLength(limit))), '')).toBeNull()
})

test('link cost coalesces other formatting but separates interrupted runs', () => {
  const href = hrefOfLength(3000), link = schema.marks.link.create({ href })
  const adjacent = schema.nodes.paragraph.create(null, [schema.text('one', [link]), schema.text('two', [link, schema.marks.strong.create()])])
  expect(clipboardHiddenLinkLength(slice(adjacent).content)).toBe(3000)
  const separated = schema.nodes.paragraph.create(null, [schema.text('one', [link]), schema.text(' / '), schema.text('two', [link])])
  expect(clipboardHiddenLinkLength(slice(separated).content)).toBe(6000)
  expect(clipboardLinkFallback(slice(separated), '')).toBe('one / two')
})

test('HTML-only hidden link fallback and long normalization retain hard breaks', () => {
  const link = schema.marks.link.create({ href: hrefOfLength(5000) })
  const broken = schema.nodes.paragraph.create(null, [schema.text('one', [link]), schema.nodes.hard_break.create(), schema.text('two', [link])])
  expect(clipboardLinkFallback(slice(broken), '')).toBe('one\ntwo')
  const short = schema.marks.link.create({ href: 'https://e.test' })
  const content = schema.nodes.paragraph.create(null, [schema.text('one', [short]), schema.nodes.hard_break.create(), schema.text('two')])
  expect(clipboardAttachmentText(slice(content), 'one\ntwo', '<a>one</a><br>two')).toBe('[one](https://e.test)\ntwo')
})

test('visible hrefs remove only their own cost and title changes end a run', () => {
  const href = 'https://e.test'
  expect(clipboardHiddenLinkLength(slice(paragraph(`see ${href}`, href)).content)).toBe(0)
  expect(clipboardHiddenLinkLength(slice(paragraph(href, href, 't'.repeat(5000))).content)).toBe(5000)
  const content = schema.nodes.paragraph.create(null, [schema.text('one', [schema.marks.link.create({ href, title: 'first' })]),
    schema.text('two', [schema.marks.link.create({ href, title: 'second' })])])
  expect(clipboardHiddenLinkLength(slice(content).content)).toBe(href.length * 2 + 11)
})

test('opaque authored quote and resource data does not spend the external link budget', () => {
  const quote = composerTokenNode({ value: '\uFFFC', label: 'Quote', data: { kind: 'selected-text', text: 'q'.repeat(6000), quoteId: 'retained' } })
  const resource = composerTokenNode({ value: '@plugin', label: 'Plugin', data: { kind: 'plugin', id: 'p'.repeat(6000) } })
  expect(clipboardLinkFallback(slice(schema.nodes.paragraph.create(null, [quote, resource])), '')).toBeNull()
})

for (const vector of vectors.links) test(`attachment text retains the link target for ${vector.label}`, () => {
  expect(clipboardAttachmentDocumentText(document(paragraph(vector.label, vector.href, vector.title)))).toBe(vector.text)
})

test('titled links retain literal title punctuation and whitespace destinations', () => {
  const text = clipboardAttachmentDocumentText(document(paragraph('A[B]', 'https://e.test/path', 'A "title")')))!
  const link = new MarkdownIt().parseInline(text, {})[0].children!.find(token => token.type === 'link_open')!
  expect(link.attrGet('href')).toBe('https://e.test/path')
  expect(link.attrGet('title')).toBe('A "title")')
  expect(clipboardAttachmentDocumentText(document(paragraph('label', 'https://e.test/a b', 'title')))).toContain('<https://e.test/a b>')
})

test('nested lists retain order, continuation indentation and links without prose formatting', () => {
  const item = (...nodes: ReturnType<typeof paragraph>[]) => schema.nodes.list_item.create(null, nodes)
  const nested = schema.nodes.bullet_list.create(null, item(paragraph('N')))
  const list = schema.nodes.ordered_list.create({ order: 3 }, [item(paragraph('A'), paragraph('B'), nested), item(paragraph('C'))])
  expect(clipboardAttachmentDocumentText(document(list))).toBe(vectors.nestedList)
  const strong = schema.nodes.paragraph.create(null, schema.text('bold', [schema.marks.strong.create()]))
  expect(clipboardAttachmentDocumentText(document(strong))).toBe('bold')
})

test('code fences, hard breaks and block separators retain readable source text', () => {
  const code = schema.nodes.code_block.create({ params: 'js' }, schema.text('x\n```\ny'))
  const breaks = schema.nodes.paragraph.create(null, [schema.text('A'), schema.nodes.hard_break.create(), schema.text('B')])
  const quoted = schema.nodes.blockquote.create(null, paragraph('quoted'))
  expect(clipboardAttachmentDocumentText(document(code, breaks, schema.nodes.horizontal_rule.create(), quoted)))
    .toBe('````js\nx\n```\ny\n````\nA\nB\nquoted')
})

test('normalization requires matching visible text and bounded eligible HTML', () => {
  const content = slice(paragraph('a  b', 'https://e.test'))
  expect(clipboardAttachmentText(content, 'a\nb', '<p><a href="https://e.test">a  b</a></p>')).toBe('[a  b](https://e.test)')
  expect(clipboardAttachmentText(content, 'different', '<a>')).toBe('different')
  expect(clipboardAttachmentText(content, 'a\nb', '<p>')).toBe('a\nb')
  expect(clipboardAttachmentText(content, 'a\nb', '<a>' + 'x'.repeat(100_000))).toBe('a\nb')
})

test('unsupported table and authored atom content retain the original plain attachment text', () => {
  const cell = schema.nodes.table_cell.create(null, schema.text('kept'))
  const table = schema.nodes.table.create(null, schema.nodes.table_row.create(null, cell))
  expect(clipboardAttachmentText(slice(table), 'kept', '<table><a>kept</a></table>')).toBe('kept')
  const atom = composerTokenNode({ value: '@exact', label: 'Exact', data: { kind: 'device', id: 'exact' } })
  expect(clipboardAttachmentText(slice(schema.nodes.paragraph.create(null, atom)), 'Exact', '<a>Exact</a>')).toBe('Exact')
})
