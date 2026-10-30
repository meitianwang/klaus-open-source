import { Fragment, Slice, type Node as DocumentNode } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'

/** A pasted quote keeps its source data while each live occurrence owns its ID. */
export function pastedQuoteIdentities(slice: Slice, state: EditorState, nextId: () => string = () => crypto.randomUUID(),
  replacedRange: { from: number; to: number } | null = state.selection): Slice {
  const used = new Set<string>()
  state.doc.descendants((node, position) => {
    if (replacedRange && position >= replacedRange.from && position + node.nodeSize <= replacedRange.to) return false
    if (node.type.name === 'composer_token' && node.attrs.data?.kind === 'selected-text' && node.attrs.data.quoteId) used.add(node.attrs.data.quoteId)
    return true
  })
  const map = (node: DocumentNode): DocumentNode => {
    if (node.type.name === 'composer_token' && node.attrs.data?.kind === 'selected-text') {
      const data = node.attrs.data
      const quoteId = typeof data.quoteId === 'string' && data.quoteId && !used.has(data.quoteId) ? data.quoteId : nextId()
      used.add(quoteId)
      return node.type.create({ ...node.attrs, data: { ...data, quoteId } }, null, node.marks)
    }
    if (!node.childCount) return node
    const children: DocumentNode[] = []
    node.forEach(child => children.push(map(child)))
    return node.copy(Fragment.fromArray(children))
  }
  const content: DocumentNode[] = []
  slice.content.forEach(node => content.push(map(node)))
  return new Slice(Fragment.fromArray(content), slice.openStart, slice.openEnd)
}
