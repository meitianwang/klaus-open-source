import { describe, expect, test } from 'bun:test'
import { composerDocumentFromText, composerDocumentSchema as schema, composerTokenNode } from './document-model'
import { projectComposerDocument } from './document-projection'

describe('document position projection', () => {
  test('UTF-16 offsets preserve whitespace and non-BMP characters', () => {
    const value = '  a\n\t😀\n\n'
    const projection = projectComposerDocument(composerDocumentFromText(value))
    expect(projection.text).toBe(value)
    for (let offset = 0; offset <= value.length; offset++) {
      expect(projection.textOffset(projection.documentPosition(offset))).toBe(offset)
    }
  })

  test('long canonical targets occupy one atomic tree position', () => {
    const token = { start: 2, end: 14, value: '@device-long', data: { kind: 'device', id: 'long' } }
    const projection = projectComposerDocument(composerDocumentFromText('a @device-long z', [token]))
    expect(projection.tokens).toEqual([token])
    expect(projection.documentPosition(5, -1)).toBe(3)
    expect(projection.documentPosition(5, 1)).toBe(4)
    expect(projection.textOffset(4)).toBe(14)
  })

  test('paragraph, code and nested-list boundaries map to editable positions', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(),
      schema.nodes.code_block.create(null, schema.text('a\nb')),
      schema.nodes.bullet_list.create(null, schema.nodes.list_item.create(null,
        schema.nodes.paragraph.create(null, [schema.text('c'), composerTokenNode({ value: '/review', label: 'Review' })]))),
      schema.nodes.paragraph.create(),
    ])
    const projection = projectComposerDocument(doc)
    expect(projection.text).toBe('\na\nb\nc/review\n')
    for (const offset of [0, 1, 2, 3, 4, 5, 6, 13, 14]) {
      const position = projection.documentPosition(offset)
      expect(doc.resolve(position).parent.isTextblock).toBe(true)
      expect(projection.textOffset(position)).toBe(offset)
    }
  })
})
