import type { OfficeDocBlock, OfficePdfPreview } from '../../../contracts/office-preview'

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim()
function blockText(block: OfficeDocBlock): string {
  if (block.kind === 'paragraph') return block.runs.map(run => run.br ? `\n${run.text}` : run.text).join('')
  if (block.kind === 'table') return block.rows.flatMap(row => row.cells.flatMap(cell => cell.blocks.map(blockText))).join(' ')
  return ''
}

export function findPdfQuotePage(pdf: OfficePdfPreview, text: string): number | undefined {
  const needle = normalize(text)
  if (!needle) return undefined
  const matches = pdf.pages.filter(page => normalize(page.blocks.map(blockText).join(' ')).includes(needle))
  return matches.length === 1 ? matches[0]?.index : undefined
}
