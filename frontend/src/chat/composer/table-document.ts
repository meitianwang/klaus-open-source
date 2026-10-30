import type { Node as DocumentNode, NodeSpec } from 'prosemirror-model'
import type { MarkdownSerializerState } from 'prosemirror-markdown'

export type TableAlignment = 'left' | 'center' | 'right' | null
export function tableAlignment(value: unknown): TableAlignment {
  return value === 'left' || value === 'center' || value === 'right' ? value : null
}
function validateAlignment(value: unknown): void {
  if (value !== null && tableAlignment(value) === null) throw new RangeError('Invalid table alignment')
}
function validateSpan(value: unknown): void {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10_000) throw new RangeError('Invalid table span')
}
function readSpan(value: string | null): number {
  const span = Number(value)
  return Number.isInteger(span) && span >= 1 && span <= 10_000 ? span : 1
}
export const tableNodeSpecs: Record<string, NodeSpec> = {
  table: { group: 'block', content: 'table_row+', isolating: true,
    parseDOM: [{ tag: 'table' }], toDOM: () => ['table', ['tbody', 0]] },
  table_row: { content: 'table_cell+', parseDOM: [{ tag: 'tr' }], toDOM: () => ['tr', 0] },
  table_cell: { content: 'inline*', isolating: true,
    attrs: { header: { default: false, validate: 'boolean' },
      align: { default: null, validate: validateAlignment },
      colspan: { default: 1, validate: validateSpan }, rowspan: { default: 1, validate: validateSpan } },
    parseDOM: [{ tag: 'td,th', getAttrs: element => ({ header: element.localName === 'th',
      align: tableAlignment((element as HTMLElement).style.textAlign || element.getAttribute('align')),
      colspan: readSpan(element.getAttribute('colspan')), rowspan: readSpan(element.getAttribute('rowspan')) }) }],
    toDOM: node => [node.attrs.header ? 'th' : 'td', {
      ...(node.attrs.align ? { style: `text-align: ${node.attrs.align}` } : {}),
      ...(node.attrs.colspan !== 1 ? { colspan: node.attrs.colspan } : {}),
      ...(node.attrs.rowspan !== 1 ? { rowspan: node.attrs.rowspan } : {}),
    }, 0] },
}

export function escapeTablePipes(value: string): string { return value.replace(/\|/g, '\\|') }

/** Each authored cell contributes once; merged spans remain part of the rich document. */
export function writeMarkdownTable(state: MarkdownSerializerState, table: DocumentNode,
  cellText: (cell: DocumentNode) => string, textWidth: (text: string) => number = text => text.length): void {
  const rows: string[][] = [], alignments: TableAlignment[] = [], widths: number[] = []
  for (let index = 0; index < table.childCount; index++) {
    const row = table.child(index)
    const cells: string[] = []
    for (let column = 0; column < row.childCount; column++) {
      const cell = row.child(column)
      const text = escapeTablePipes(cellText(cell).replace(/\n/g, '<br>'))
      cells.push(text)
      widths[column] = Math.max(widths[column] || 3, textWidth(text))
      if (index === 0) alignments[column] = tableAlignment(cell.attrs.align)
    }
    rows.push(cells)
  }
  const writeRow = (cells: string[], separator = false) => {
    state.write('| ')
    widths.forEach((width, column) => {
      let text = cells[column] || ''
      if (separator) {
        const align = alignments[column]
        text = (align === 'left' || align === 'center' ? ':' : '-')
          + '-'.repeat(Math.max(1, width - 2)) + (align === 'right' || align === 'center' ? ':' : '-')
      }
      state.write(text + ' '.repeat(Math.max(0, width - textWidth(text))) + ' |' + (column < widths.length - 1 ? ' ' : ''))
    })
    state.ensureNewLine()
  }
  rows.forEach((cells, index) => { writeRow(cells); if (index === 0) writeRow([], true) })
  state.closeBlock(table)
}
