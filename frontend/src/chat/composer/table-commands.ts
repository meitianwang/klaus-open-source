import { Fragment, Slice } from 'prosemirror-model'
import type { Node as DocumentNode } from 'prosemirror-model'
import { TextSelection, type Command, type EditorState } from 'prosemirror-state'
import type { TableAlignment } from './table-document'

interface PipeCell { from: number; to: number; text: string; escapes: number[] }
export function pipeTableRow(value: string): PipeCell[] | null {
  const first = value.length - value.trimStart().length, end = value.trimEnd().length
  if (value[first] !== '|' || value[end - 1] !== '|' || end - first < 2) return null
  const cells: PipeCell[] = []
  let start = first + 1, escapes: number[] = []
  const append = (finish: number) => {
    const source = value.slice(start, finish), from = start + source.length - source.trimStart().length
    const to = Math.max(from, start + source.trimEnd().length)
    cells.push({ from, to, text: value.slice(from, to).replace(/\\\|/g, '|'), escapes: escapes.filter(position => position >= from && position < to) })
  }
  for (let offset = start; offset < end - 1; offset++) {
    if (value[offset] === '\\' && value[offset + 1] === '|') { escapes.push(offset); offset++; continue }
    if (value[offset] === '|') { append(offset); start = offset + 1; escapes = [] }
  }
  append(end - 1)
  return cells.length >= 2 ? cells : null
}
function cellContent(node: DocumentNode, cell: PipeCell): Fragment {
  let content = Fragment.empty, start = cell.from
  for (const position of cell.escapes) { content = content.append(node.content.cut(start, position)); start = position + 1 }
  return content.append(node.content.cut(start, cell.to))
}

/** Three complete prose rows become a table only at the last row's end caret. */
export const convertTypedTable: Command = (state, send) => {
  const { $from, empty } = state.selection, { schema } = state
  if (!schema.nodes.table || !schema.nodes.table_row || !schema.nodes.table_cell) return false
  if (!empty || $from.depth !== 1 || $from.parent.type !== schema.nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false
  const index = $from.index(0)
  if (index < 2) return false
  const nodes = [state.doc.child(index - 2), state.doc.child(index - 1), state.doc.child(index)]
  if (nodes.some(node => {
    let prose = node.type === schema.nodes.paragraph
    node.forEach(child => { prose &&= child.isText })
    return !prose
  })) return false
  const rows = nodes.map(node => pipeTableRow(node.textContent)), header = rows[0], separator = rows[1], body = rows[2]
  if (!header || !separator || !body || separator.length !== header.length || body.length !== header.length
    || !separator.every(cell => /^:?-{3,}:?$/.test(cell.text))) return false
  if (!send) return true
  const alignments: TableAlignment[] = separator.map(cell => cell.text.startsWith(':')
    ? cell.text.endsWith(':') ? 'center' : 'left' : cell.text.endsWith(':') ? 'right' : null)
  const table = schema.nodes.table.create(null, [header, body].map((cells, row) => schema.nodes.table_row.create(null,
    cells.map((cell, column) => schema.nodes.table_cell.create({ header: row === 0, align: alignments[column] }, cellContent(nodes[row ? 2 : 0], cell))))))
  const start = $from.before(1) - nodes[0].nodeSize - nodes[1].nodeSize
  const transaction = state.tr.replaceWith(start, $from.after(1), [table, schema.nodes.paragraph.create()])
  send(transaction.setSelection(TextSelection.create(transaction.doc, start + table.nodeSize + 1)).scrollIntoView())
  return true
}

/** A block table pasted outside a cell leaves an ordinary editable paragraph after it. */
export function pasteDocumentSlice(state: EditorState, slice: Slice) {
  let insideTable = false
  for (let depth = state.selection.$from.depth; depth > 0; depth--) insideTable ||= state.selection.$from.node(depth).type.name === 'table'
  const trailingTable = !insideTable && slice.content.lastChild?.type.name === 'table'
  const transaction = state.tr.replaceSelection(trailingTable ? new Slice(slice.content, slice.openStart, 0) : slice)
  if (trailingTable) {
    let insertedEnd: number | undefined
    transaction.mapping.maps.at(-1)?.forEach((...positions) => { insertedEnd ??= positions[3] })
    if (insertedEnd !== undefined && transaction.doc.resolve(insertedEnd).nodeBefore?.type.name === 'table') {
      if (transaction.doc.nodeAt(insertedEnd)?.type !== state.schema.nodes.paragraph) transaction.insert(insertedEnd, state.schema.nodes.paragraph.create())
      transaction.setSelection(TextSelection.create(transaction.doc, insertedEnd + 1))
    }
  }
  return transaction
}
