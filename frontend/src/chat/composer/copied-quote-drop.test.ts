import { expect, test } from 'bun:test'
import { Fragment, Slice } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { history, undo } from 'prosemirror-history'
import { composerDocumentSchema as schema, composerDocumentText, composerTokenNode } from './document-model'
import { copiedQuoteDrop } from './copied-quote-drop'

const token = () => composerTokenNode({ value: '\uFFFC', label: 'Quote', data: {
  kind: 'selected-text', quoteId: 'original', text: 'Full passage', specAnnotation: { path: 'src/file.ts', line: 9 },
} })

test('copied drop retains the selected source and inserts another independent quote at the pointer', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('a '), token(), schema.text(' end')]))
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3, 4), plugins: [history()] })
  const slice = state.selection.content()
  const transaction = copiedQuoteDrop(state, slice, doc.content.size - 1, () => 'copied')!
  state = state.apply(transaction)
  expect(composerDocumentText(state.doc)).toBe('a \uFFFC end\uFFFC')
  const quotes: any[] = []
  state.doc.descendants(node => { if (node.attrs.data?.kind === 'selected-text') quotes.push(node.attrs.data) })
  expect(quotes.map(quote => quote.quoteId)).toEqual(['original', 'copied'])
  expect(quotes[1]).toEqual({ ...quotes[0], quoteId: 'copied' })
  expect(transaction.getMeta('uiEvent')).toBe('drop')
  expect(undo(state, change => { state = state.apply(change) })).toBe(true)
  expect(state.doc.eq(doc)).toBe(true)
})

test('external drops do not treat the selected destination quote as replaced', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [token(), schema.text(' tail')]))
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 2) })
  const transaction = copiedQuoteDrop(state, new Slice(Fragment.from(token()), 0, 0), 2, () => 'external')!
  const ids: string[] = []
  transaction.doc.descendants(node => { if (node.attrs.data?.quoteId) ids.push(node.attrs.data.quoteId) })
  expect(ids).toEqual(['original', 'external'])
})

test('nested block drops keep their structure, marks and source metadata', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('start')))
  const block = schema.nodes.blockquote.create(null, schema.nodes.paragraph.create(null, [schema.text('bold ', [schema.marks.strong.create()]), token()]))
  const state = EditorState.create({ doc })
  const transaction = copiedQuoteDrop(state, new Slice(Fragment.from(block), 0, 0), doc.content.size)!
  expect(transaction.doc.lastChild!.type.name).toBe('blockquote')
  expect(transaction.doc.lastChild!.firstChild!.firstChild!.marks[0].type.name).toBe('strong')
  expect(transaction.doc.lastChild!.firstChild!.lastChild!.attrs.data.specAnnotation.line).toBe(9)
})

test('ordinary text and resource drops keep the native editor path', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create())
  const state = EditorState.create({ doc })
  expect(copiedQuoteDrop(state, new Slice(Fragment.from(schema.text('text')), 0, 0), 1)).toBeNull()
  const resource = composerTokenNode({ value: '@resource', label: 'Resource', data: { kind: 'mcp', id: 'resource' } })
  expect(copiedQuoteDrop(state, new Slice(Fragment.from(resource), 0, 0), 1)).toBeNull()
})
