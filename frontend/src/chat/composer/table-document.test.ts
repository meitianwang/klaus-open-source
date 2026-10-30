import { describe, expect, test } from 'bun:test'
import MarkdownIt from 'markdown-it'
import { Slice } from 'prosemirror-model'
import { EditorState, Selection, TextSelection } from 'prosemirror-state'
import { closeHistory, history, undo } from 'prosemirror-history'
import { composerDocumentFromText, composerDocumentSchema as schema, composerDocumentText, composerTokenNode,
  restoreComposerDocument, serializeComposerDocument, snapshotComposerDocument } from './document-model'
import { projectComposerDocument } from './document-projection'
import { convertTypedTable, pasteDocumentSlice, pipeTableRow } from './table-commands'
import { referencesFromEditor, resourceReference } from './resource-reference'
import { renderUserDocument } from '../transcript/user-document'
import vectors from '../../../../contracts/vectors/composer-table-vectors.json'
const cell = (value: string, attrs: object = {}) => schema.nodes.table_cell.create(attrs, value ? schema.text(value) : undefined)
const row = (...cells: ReturnType<typeof cell>[]) => schema.nodes.table_row.create(null, cells)
const table = (...rows: ReturnType<typeof row>[]) => schema.nodes.table.create(null, rows)
const doc = (...nodes: ReturnType<typeof table>[]) => schema.nodes.doc.create(null, nodes)
const markdown = new MarkdownIt({ html: true })

for (const vector of vectors.rowExamples) test(`typed pipe row parsing ${JSON.stringify(vector.source)}`, () => {
  expect(pipeTableRow(vector.source)?.map(cell => cell.text) ?? null).toEqual(vector.cells)
})

describe('authored tables', () => {
  test('alignment, rich content and spans survive snapshot restoration', () => {
    const original = doc(table(row(cell('Header', { header: true, align: 'center', colspan: 2 })),
      row(cell('😀', { rowspan: 2 }), cell('literal **stars**'))))
    expect(restoreComposerDocument(snapshotComposerDocument(original))!.eq(original)).toBe(true)
    const rendered = renderUserDocument(snapshotComposerDocument(original))!
    expect(rendered.html).toContain('<table><thead><tr><th style="text-align: center" colspan="2">Header</th>')
    expect(rendered.html).toContain('<td rowspan="2">😀</td>')
    expect(rendered.html).toContain('literal **stars**')
  })
  test('malformed saved table spans and alignment are rejected', () => {
    for (const attrs of [{ colspan: 0 }, { rowspan: -1 }, { colspan: 1.5 }, { colspan: 10001 }, { align: 'right; color: red' }, { header: 'yes' }]) {
      const snapshot = snapshotComposerDocument(doc(table(row(cell('safe')))))
      snapshot.content.content[0].content[0].content[0].attrs = attrs
      expect(restoreComposerDocument(snapshot)).toBeNull()
    }
  })
  test('submitted Copy retains authored header cells independently of presentation', () => {
    const original = snapshotComposerDocument(doc(table(row(cell('A'), cell('B', { header: true })),
      row(cell('Row', { header: true }), cell('value')))))
    const display = renderUserDocument(original)!, clipboard = renderUserDocument(original, undefined, { preserveTableHeaders: true })!
    expect(display.html).toContain('<thead><tr><th>A</th><th>B</th></tr></thead>')
    expect(clipboard.html).toContain('<thead><tr><td>A</td><th>B</th></tr></thead>')
    expect(clipboard.html).toContain('<tbody><tr><th>Row</th><td>value</td></tr></tbody>')
  })
  test('submitted table targets render exactly once in authored row order', () => {
    const target = (id: string) => schema.nodes.table_cell.create(null, composerTokenNode({ value: `@${id}`, label: id, data: { kind: 'device', id } }))
    const original = snapshotComposerDocument(doc(table(row(target('first'), cell('')), row(target('second'), target('third')))))
    const visited: string[] = []
    renderUserDocument(original, token => { visited.push((token.data as { id: string }).id); return token.label })
    expect(visited).toEqual(['first', 'second', 'third'])
  })
  test('inline cells reject nested block content rather than inventing block-cell editing', () => {
    expect(() => snapshotComposerDocument(doc(table(row(schema.nodes.table_cell.create(null,
      schema.nodes.paragraph.create(null, schema.text('nested')))))))).toThrow()
  })
  test('empty and emoji cells use the same UTF-16 projection as ordinary blocks', () => {
    const original = doc(schema.nodes.paragraph.create(null, schema.text('before')), table(
      row(cell('😀'), cell('')), row(cell(''), cell('last'))), schema.nodes.paragraph.create())
    const projection = projectComposerDocument(original)
    expect(projection.text).toBe('before\n😀\n\n\nlast\n')
    expect(composerDocumentText(original)).toBe(projection.text)
    for (let offset = 0; offset <= projection.text.length; offset++) {
      expect(projection.textOffset(projection.documentPosition(offset))).toBe(offset)
      expect(original.resolve(projection.documentPosition(offset)).parent.isTextblock).toBe(true)
    }
  })
  test('Markdown retains literal pipes, backslashes, formatting and cell breaks', () => {
    const rich = schema.nodes.table_cell.create({ align: 'right' }, [schema.text('a\\|b'), schema.nodes.hard_break.create(),
      schema.text('strong', [schema.marks.strong.create()]), schema.text(' x|y', [schema.marks.code.create()])])
    const original = doc(table(row(cell('Name'), cell('Content', { align: 'right' })), row(cell('a'), rich)))
    const serialized = serializeComposerDocument(original)
    const html = markdown.render(serialized.text)
    expect(html).toContain('<table>')
    expect(html).toContain('a\\|b<br>')
    expect(html).toContain('<strong>strong</strong>')
    expect(html).toContain('<code> x|y</code>')
    expect(html).toContain('style="text-align:right"')
  })
  test('later-cell resource identities and zero-width quotes use final Markdown offsets', () => {
    const reference = resourceReference('file', 'a|b.ts', '/source/a|b.ts')
    const quote = { value: '\uFFFC', label: 'quote', data: { kind: 'selected-text', quoteId: 'table-quote', text: 'full selected text' } }
    const content = schema.nodes.table_cell.create(null, [composerTokenNode({ value: reference.value, label: reference.name, data: reference }),
      schema.text(' $& '), composerTokenNode(quote), schema.text(' tail')])
    const original = doc(table(row(cell('Name'), cell('Value')), row(cell('target'), content)))
    const serialized = serializeComposerDocument(original), [file, selected] = serialized.tokens
    expect(serialized.text.slice(file.start, file.end)).toBe(file.value)
    expect(file.value).toContain('\\|')
    expect(selected.start).toBe(selected.end)
    expect(selected.data).toEqual(quote.data)
    expect(referencesFromEditor(serialized.text, serialized.tokens)[0].id).toBe(reference.id)
    const renderedIds: string[] = []
    const rendered = renderUserDocument(snapshotComposerDocument(original), token => { renderedIds.push(String((token.data as any).id || (token.data as any).quoteId)); return token.label })!
    expect(renderedIds).toEqual([reference.id!, 'table-quote'])
    expect(rendered.html.match(/data-klaus-document-token=/g)).toHaveLength(2)
    expect(rendered.clipboardText).toContain(reference.value)
    const projection = projectComposerDocument(original)
    expect(projection.tokens.map(token => token.data)).toEqual([reference, quote.data])
    expect(projection.text.slice(projection.tokens[0].start, projection.tokens[0].end)).toBe(reference.value)
  })
  test('marker-looking link attributes cannot capture a later semantic atom', () => {
    const original = doc(schema.nodes.paragraph.create(null, [schema.text('link', [schema.marks.link.create({ href: 'https://example.test/KLSDOCTOKEN0END' })]),
      composerTokenNode({ value: '@exact', label: 'Exact', data: { kind: 'device', id: 'exact' } })]))
    const serialized = serializeComposerDocument(original)
    expect(serialized.text).toContain('https://example.test/KLSDOCTOKEN0END')
    expect(serialized.text.slice(serialized.tokens[0].start, serialized.tokens[0].end)).toBe('@exact')
  })
  test('table serialization remains block-scoped inside a quotation', () => {
    const original = doc(schema.nodes.blockquote.create(null, table(row(cell('A'), cell('B')), row(cell('1'), cell('2')))))
    const html = markdown.render(serializeComposerDocument(original).text)
    expect(html).toContain('<blockquote>\n<table>')
    expect(html).toContain('<td>2</td>')
  })
  test('plain pipe and tab text stays literal prose through draft construction', () => {
    for (const text of ['| A | B |\n| --- | --- |\n| 1 | 2 |', 'A\tB\n1\t2']) {
      const original = composerDocumentFromText(text)
      expect(original.firstChild!.type.name).toBe('paragraph')
      expect(composerDocumentText(original)).toBe(text)
    }
  })
})

describe('table editing transactions', () => {
  const paragraphs = () => [schema.nodes.paragraph.create(null, [schema.text('| '), schema.text('A\\|B', [schema.marks.strong.create()]), schema.text(' | C |')]),
    schema.nodes.paragraph.create(null, schema.text('| :--- | ---: |')), schema.nodes.paragraph.create(null, schema.text('| 😀 | value |'))]
  test('Enter recognizes exactly three text paragraphs, preserves marks and leaves an end caret', () => {
    const original = doc(...paragraphs())
    let state = EditorState.create({ doc: original, selection: Selection.atEnd(original), plugins: [history()] })
    expect(convertTypedTable(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.firstChild!.type.name).toBe('table')
    const first = state.doc.firstChild!.firstChild!.firstChild!
    expect(first.textContent).toBe('A|B')
    expect(first.firstChild!.marks[0].type.name).toBe('strong')
    expect(first.attrs.align).toBe('left')
    expect(state.doc.firstChild!.child(1).child(1).attrs.align).toBe('right')
    expect(state.selection.$from.parent.type.name).toBe('paragraph')
    expect(state.selection.$from.parent.content.size).toBe(0)
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.eq(original)).toBe(true)
  })
  test('conversion declines invalid counts, marked atoms, partial rows and selected text', () => {
    const original = doc(...paragraphs())
    for (const selection of [TextSelection.create(original, 1), TextSelection.create(original, 1, 2)]) {
      expect(convertTypedTable(EditorState.create({ doc: original, selection }))).toBe(false)
    }
    const invalid = doc(...paragraphs().slice(0, 2), schema.nodes.paragraph.create(null, schema.text('| one | two | three |')))
    expect(convertTypedTable(EditorState.create({ doc: invalid, selection: Selection.atEnd(invalid) }))).toBe(false)
    const atom = doc(...paragraphs().slice(0, 2), schema.nodes.paragraph.create(null, [schema.text('| a | '), composerTokenNode({ value: '@x', label: 'x' }), schema.text(' |')]))
    expect(convertTypedTable(EditorState.create({ doc: atom, selection: Selection.atEnd(atom) }))).toBe(false)
  })
  test('a final pasted table gets one following paragraph with selection and history intact', () => {
    const original = composerDocumentFromText('before')
    let state = EditorState.create({ doc: original, selection: Selection.atEnd(original), plugins: [history()] })
    const block = table(row(cell('A'), cell('B')), row(cell('1'), cell('2')))
    state = state.apply(closeHistory(pasteDocumentSlice(state, new Slice(block.type.schema.nodes.doc.create(null, block).content, 0, 0))))
    expect(state.doc.lastChild!.type.name).toBe('paragraph')
    expect(state.selection.$from.parent).toBe(state.doc.lastChild!)
    expect(state.doc.childCount).toBe(3)
    expect(undo(state, transaction => { state = state.apply(transaction) })).toBe(true)
    expect(state.doc.eq(original)).toBe(true)
  })
})
