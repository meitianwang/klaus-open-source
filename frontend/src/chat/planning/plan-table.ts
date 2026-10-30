import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'

interface Node {
  type: string
  children?: Node[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

export interface PlanTableCell { from: number; to: number; content: string }

/** Cell edits splice only authored content, retaining delimiters and surrounding padding. */
export function planTableCells(source: string, offset = 0, tableFrom?: number): PlanTableCell[][] {
  const root = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as Node
  const find = (node: Node): Node | undefined => node.type === 'table' && (tableFrom === undefined || node.position?.start.offset === tableFrom) ? node : node.children?.map(find).find(Boolean)
  const table = find(root)
  return table?.children?.map(row => row.children?.map(cell => {
    let from = cell.children?.[0]?.position?.start.offset ?? cell.position?.start.offset ?? 0
    let to = cell.children?.at(-1)?.position?.end.offset ?? cell.position?.end.offset ?? from
    if (!cell.children?.length) {
      if (source[from] === '|') from++
      if (to > from && source[to - 1] === '|') to--
      while (from < to && /[\t ]/.test(source[from])) from++
      while (to > from && /[\t ]/.test(source[to - 1])) to--
    }
    return { from: from + offset, to: to + offset, content: source.slice(from, to) }
  }) ?? []) ?? []
}

/** A cell cannot introduce a row or an unescaped delimiter into its containing table. */
export function planTableInput(text: string): string {
  const flat = text.replace(/\r\n|[\r\n\t]/g, ' ')
  let escaped = '', slashes = 0
  for (const char of flat) {
    if (char === '|' && slashes % 2 === 0) escaped += '\\'
    escaped += char
    slashes = char === '\\' ? slashes + 1 : 0
  }
  return escaped
}
