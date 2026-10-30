import { expect, test } from 'bun:test'
import { Fragment, Slice } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import { composerDocumentSchema as schema, composerTokenNode } from './document-model'
import { pastedQuoteIdentities } from './clipboard-identities'

const quote = () => composerTokenNode({ value: '\uFFFC', label: 'Quote', data: { kind: 'selected-text', quoteId: 'original', text: 'full selection', specAnnotation: { path: 'src/file.ts', line: 3 } } })

test('pasted copies get independent occurrence IDs while selected replacements retain identity', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [quote(), schema.text(' end')]))
  const copied = new Slice(Fragment.from(quote()), 0, 0)
  const append = EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size - 1) })
  const added = pastedQuoteIdentities(copied, append, () => 'new-occurrence')
  expect(added.content.firstChild!.attrs.data).toEqual({ ...copied.content.firstChild!.attrs.data, quoteId: 'new-occurrence' })
  const replace = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 2) })
  expect(pastedQuoteIdentities(copied, replace).content.firstChild!.attrs.data.quoteId).toBe('original')
})

test('repeated quotes in one incoming slice remain distinct across nested blocks', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create())
  const state = EditorState.create({ doc })
  const content = Fragment.fromArray([schema.nodes.paragraph.create(null, quote()), schema.nodes.blockquote.create(null, schema.nodes.paragraph.create(null, quote()))])
  const result = pastedQuoteIdentities(new Slice(content, 0, 0), state, () => 'nested-copy')
  expect(result.content.firstChild!.firstChild!.attrs.data.quoteId).toBe('original')
  expect(result.content.lastChild!.firstChild!.firstChild!.attrs.data.quoteId).toBe('nested-copy')
})
