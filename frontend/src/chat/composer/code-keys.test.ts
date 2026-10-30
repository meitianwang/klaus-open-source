import { describe, expect, test } from 'bun:test'
import { EditorState, TextSelection, type Command } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { composerDocumentSchema as schema } from './document-model'
import { codeArrow, codeNewline, indentCode, leaveCode, selectCode } from './code-keys'
import vectors from '../../../../contracts/vectors/composer-document-vectors.json'

function fixture(text: string, from = 0, to = from, trailing?: string) {
  const code = schema.nodes.code_block.create(null, text ? schema.text(text) : null)
  const doc = schema.nodes.doc.create(null, [code, ...(trailing === undefined ? [] : [schema.nodes.paragraph.create(null, trailing ? schema.text(trailing) : null)])])
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, from + 1, to + 1) })
  return {
    state: () => state,
    run: (command: Command, edge = false) => command(state, transaction => { state = state.apply(transaction) }, { endOfTextblock: () => edge } as unknown as EditorView),
  }
}

describe('code editing keys', () => {
  for (const row of vectors.codeKeys.indentCases) test(`indent selected logical lines ${JSON.stringify(row.text)}`, () => {
    const editor = fixture(row.text, row.from, row.to)
    expect(editor.run(indentCode(false))).toBe(true)
    expect(editor.state().doc.firstChild!.textContent).toBe(row.result)
  })
  for (const row of vectors.codeKeys.outdentCases) test(`outdent consumes the key ${JSON.stringify(row.text)}`, () => {
    const editor = fixture(row.text, row.from, Math.min(row.to, row.text.length))
    expect(editor.run(indentCode(true))).toBe(true)
    expect(editor.state().doc.firstChild!.textContent).toBe(row.result)
  })
  test('a modified newline replaces a code selection without leaving the block', () => {
    const editor = fixture('first replace last', 6, 13)
    expect(editor.run(codeNewline)).toBe(true)
    expect(editor.state().doc.firstChild!.textContent).toBe('first \n last')
    expect(editor.state().doc.childCount).toBe(1)
  })
  test('leaving code reuses a following paragraph or creates exactly one', () => {
    for (const trailing of [undefined, 'following']) {
      const editor = fixture('code', 2, 2, trailing)
      expect(editor.run(leaveCode)).toBe(true)
      expect(editor.state().doc.childCount).toBe(2)
      expect(editor.state().selection.$from.parent.type.name).toBe('paragraph')
      expect(editor.state().selection.$from.parentOffset).toBe(0)
      expect(editor.state().doc.lastChild!.textContent).toBe(trailing || '')
    }
  })
  test('select all first selects code contents then yields to document selection', () => {
    const editor = fixture('code', 2, 2, 'other')
    expect(editor.run(selectCode)).toBe(true)
    expect([editor.state().selection.from, editor.state().selection.to]).toEqual([1, 5])
    expect(editor.run(selectCode)).toBe(false)
    expect(fixture('').run(selectCode)).toBe(false)
  })
  test('line-end arrows retain the logical line-end column', () => {
    const editor = fixture('first\nx\nlast', 5)
    expect(editor.run(codeArrow(1))).toBe(true)
    expect(editor.state().selection.$from.parentOffset).toBe(7)
    expect(editor.run(codeArrow(-1))).toBe(true)
    expect(editor.state().selection.$from.parentOffset).toBe(5)
  })
  test('visual boundary arrows create accessible paragraphs beside code', () => {
    const up = fixture('code')
    expect(up.run(codeArrow(-1), true)).toBe(true)
    expect(up.state().doc.firstChild!.type.name).toBe('paragraph')
    const down = fixture('code', 4)
    expect(down.run(codeArrow(1), true)).toBe(true)
    expect(down.state().doc.lastChild!.type.name).toBe('paragraph')
    expect(down.run(codeArrow(-1), true)).toBe(true)
    expect(down.state().selection.$from.parent.type.name).toBe('code_block')
    expect(down.state().selection.$from.parentOffset).toBe(4)
  })
})
