import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection } from 'prosemirror-state'
import { history, redo, undo } from 'prosemirror-history'
import { composerDocumentFromText, composerDocumentSchema as schema, composerDocumentText,
  composerClipboardTokenAttributes, COMPOSER_DOCUMENT_TOKEN_DATA_LIMIT,
  composerTokenNode, mergeComposerDocuments, restoreComposerDocument, serializeComposerDocument, snapshotComposerDocument } from './document-model'
import { resourceReference } from './resource-reference'
import vectors from '../../../../contracts/vectors/composer-document-vectors.json'
import clipboardVectors from '../../../../contracts/vectors/composer-clipboard-vectors.json'

describe('structured composer documents', () => {
  for (const value of vectors.whitespaceDrafts) test(`literal whitespace survives a document snapshot ${JSON.stringify(value)}`, () => {
    const document = composerDocumentFromText(value)
    const restored = restoreComposerDocument(JSON.parse(JSON.stringify(snapshotComposerDocument(document))))!
    expect(composerDocumentText(restored)).toBe(value)
  })

  test('one history transaction restores reference identity and surrounding text', () => {
    const reference = resourceReference('plugin', 'Design', 'plugin-id')
    const token = composerTokenNode({ value: reference.value, label: reference.name, data: reference })
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('before '), token, schema.text(' after')]))
    let state = EditorState.create({ doc, plugins: [history()] })
    state = state.apply(state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)).deleteSelection())
    expect(composerDocumentText(state.doc)).toBe('')
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.eq(doc)).toBe(true)
    expect(composerDocumentText(state.doc, true)).toBe('before Design after')
    expect(redo(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(composerDocumentText(state.doc)).toBe('')
  })

  test('formatting, code, lists and reference targets survive serialization and document restore', () => {
    const reference = resourceReference('skill', 'Review', 'review')
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text('Important', [schema.marks.strong.create()]), schema.text(' '),
        composerTokenNode({ value: reference.value, label: reference.name, data: reference })]),
      schema.nodes.code_block.create({ params: 'ts' }, schema.text('const answer = 42')),
      schema.nodes.bullet_list.create(null, [schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text('one')))]),
    ])
    const serialized = serializeComposerDocument(doc)
    expect(serialized.text).toContain('**Important**')
    expect(serialized.text).toContain('```ts\nconst answer = 42\n```')
    expect(serialized.text).toContain('* one')
    expect(serialized.text.slice(serialized.tokens[0].start, serialized.tokens[0].end)).toBe(reference.value)
    expect(restoreComposerDocument(snapshotComposerDocument(doc))!.eq(doc)).toBe(true)
  })

  test('quoted text and commands remain semantic nodes through deletion and undo', () => {
    const quote = composerTokenNode({ value: '\uFFFC', label: 'Quoted passage', data: { kind: 'selected-text', quoteId: 'quote-1', text: 'Full quoted passage' } })
    const command = composerTokenNode({ value: '/review', label: 'Review command', data: { kind: 'command', command: { name: 'review' } } })
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [quote, schema.text(' use '), command]))
    let state = EditorState.create({ doc, plugins: [history()] })
    state = state.apply(state.tr.delete(1, 2))
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.eq(doc)).toBe(true)
    expect(composerDocumentText(state.doc, true)).toBe('Quoted passage use Review command')
    const serialized = serializeComposerDocument(state.doc)
    expect(serialized.text).toBe(' use /review')
    expect((serialized.tokens[0].data as any).quoteId).toBe('quote-1')
  })

  test('invalid saved documents fall back instead of accepting malformed token attributes', () => {
    expect(restoreComposerDocument({ version: 2, content: {} })).toBeNull()
    expect(restoreComposerDocument({ version: 1, content: { type: 'doc', content: [{ type: 'composer_token', attrs: { value: 12, label: 'invalid' } }] } })).toBeNull()
  })

  test('decoded clipboard atom size is inclusive in UTF-16 units', () => {
    const prefix = '{"value":"target","label":"Quote","data":{"text":"', suffix = '"}}'
    const length = COMPOSER_DOCUMENT_TOKEN_DATA_LIMIT - prefix.length - suffix.length
    const text = '😀'.repeat(Math.floor(length / 2)) + 'x'.repeat(length % 2)
    const raw = prefix + text + suffix
    expect(raw.length).toBe(COMPOSER_DOCUMENT_TOKEN_DATA_LIMIT)
    const token = composerClipboardTokenAttributes(raw)!
    expect((token.data as { text: string }).text === text).toBe(true)
    expect(composerClipboardTokenAttributes(raw + ' ') === null).toBe(true)
  })

  test('deep clipboard metadata cannot enter recursive rendering or saved documents', () => {
    const nested = '{"x":'.repeat(12_000) + 'null' + '}'.repeat(12_000)
    const raw = '{"value":"target","label":"Quote","data":{"kind":"selected-text","quoteId":"deep","text":"Keep visible text","extra":' + nested + '}}'
    expect(raw.length < 100_000).toBe(true)
    expect(composerClipboardTokenAttributes(raw) === null).toBe(true)
    const attrs = JSON.parse(raw)
    expect(restoreComposerDocument({ version: 1, content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'composer_token', attrs }] },
    ] } }) === null).toBe(true)
  })

  test('object and array metadata depth stays bounded at the editable boundary', () => {
    for (const [open, close] of [['{"x":', '}'], ['[', ']']]) {
      for (const extra of [0, 1]) {
        const depth = clipboardVectors.identity.maximumMetadataDepth + extra
        const raw = '{"value":"target","label":"Metadata","data":' + open.repeat(depth) + 'null' + close.repeat(depth) + '}'
        expect(composerClipboardTokenAttributes(raw) !== null).toBe(extra === 0)
      }
    }
    const data: { self?: unknown } = {}
    data.self = data
    expect(restoreComposerDocument({ version: 1, content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'composer_token', attrs: { value: 'target', label: 'Metadata', data } }] },
    ] } })).toBeNull()
  })
})


test('joining structured drafts retains block structure, literal whitespace and independent atoms', () => {
  const quote = (id: string) => composerTokenNode({ value: '\uFFFC', label: id, data: { kind: 'selected-text', quoteId: id, text: 'same selected text' } })
  const left = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('left ', [schema.marks.strong.create()]), quote('left-quote')]))
  const right = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [quote('right-quote'), schema.text(' right')]), schema.nodes.code_block.create(null, schema.text('  code\n\tend'))])
  const merged = restoreComposerDocument(mergeComposerDocuments({ document: snapshotComposerDocument(left), text: 'unused' }, { document: snapshotComposerDocument(right), text: 'unused' }))!
  expect(merged.childCount).toBe(3)
  expect(merged.firstChild!.firstChild!.marks[0].type.name).toBe('strong')
  expect(merged.child(0).lastChild!.attrs.data.quoteId).toBe('left-quote')
  expect(merged.child(1).firstChild!.attrs.data.quoteId).toBe('right-quote')
  expect(merged.lastChild!.textContent).toBe('  code\n\tend')
  expect(composerDocumentText(merged)).toBe('left \uFFFC\n\uFFFC right\n  code\n\tend')
})

test('joining a legacy draft promotes its explicit token data and ignores an empty paragraph', () => {
  const token = { start: 0, end: 1, value: '\uFFFC', label: 'Quote', data: { kind: 'selected-text', quoteId: 'legacy', text: 'quoted' } }
  const merged = restoreComposerDocument(mergeComposerDocuments({ text: '' }, { text: '\uFFFC text', tokens: [token] }))!
  expect(merged.childCount).toBe(1)
  expect(merged.firstChild!.firstChild!.attrs.data.quoteId).toBe('legacy')
})
