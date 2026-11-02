import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/composer-query-vectors.json'
import { EditorState, TextSelection } from 'prosemirror-state'
import { composerDocumentFromText, composerDocumentSchema as schema, composerTokenNode } from './document-model'
import { composerQueryInDocument, composerQueryInText } from './composer-query'

describe('composer picker queries', () => {
  for (const row of vectors.queries) test(`query contract ${row.text}`, () => {
    const query = composerQueryInText(row.text, row.caret, row.selectionEnd ?? row.caret)
    if (row.prefix) expect(query).toMatchObject({ prefix: row.prefix, query: row.query, start: row.start, end: row.caret })
    else expect(query).toBeNull()
  })
  test('accepts Unicode, paths and each supported prefix at the caret', () => {
    for (const prefix of ['/', '@', '$']) expect(composerQueryInText(`Please ${prefix}审查-tools`, 16))
      .toMatchObject({ prefix, query: '审查-tools', start: 7, end: 16 })
    expect(composerQueryInText('@src/components/', 16)?.query).toBe('src/components/')
    expect(composerQueryInText('email a@b.com', 13)).toBeNull()
    expect(composerQueryInText('/review', 0, 7)).toBeNull()
  })

  test('a selected target cannot become part of a following query', () => {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [
      schema.text('prefix '), composerTokenNode({ value: '@opaque-target', label: 'Target' }), schema.text(' /review'),
    ]))
    const state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) })
    expect(composerQueryInDocument(state)).toEqual({ prefix: '/', start: 22, end: 29, query: 'review' })
  })

  test('query matching stays within the current paragraph and excludes code', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, schema.text('/previous')),
      schema.nodes.paragraph.create(null, schema.text('current')),
      schema.nodes.code_block.create(null, schema.text('@src/file.ts')),
    ])
    expect(composerQueryInDocument(EditorState.create({ doc, selection: TextSelection.atEnd(doc) }))).toBeNull()
    const literal = composerDocumentFromText('/old\ncurrent')
    expect(composerQueryInDocument(EditorState.create({ doc: literal, selection: TextSelection.atEnd(literal) }))).toBeNull()
  })

  test('directory completion can continue a path containing spaces without spanning an atom', () => {
    const doc = composerDocumentFromText('use @My Folder/src/')
    const state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) })
    expect(composerQueryInDocument(state)).toEqual({ prefix: '@', start: 4, end: 19, query: 'My Folder/src/' })
    expect(composerQueryInDocument(state, { prefix: '@', position: 5 })).toEqual({ prefix: '@', start: 4, end: 19, query: 'My Folder/src/' })
  })
})
