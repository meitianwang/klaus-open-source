import type { Slice } from 'prosemirror-model'
import { NodeSelection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state'
import { dropPoint } from 'prosemirror-transform'
import { closeHistory } from 'prosemirror-history'
import { pastedQuoteIdentities } from './clipboard-identities'

/** Copying inserts another occurrence; the current selection remains in place. */
export function copiedQuoteDrop(state: EditorState, slice: Slice, position: number,
  nextId?: () => string): Transaction | null {
  let hasQuote = false
  slice.content.descendants(node => {
    if (node.type.name === 'composer_token' && node.attrs.data?.kind === 'selected-text') hasQuote = true
  })
  if (!hasQuote) return null
  const content = pastedQuoteIdentities(slice, state, nextId, null)
  const at = dropPoint(state.doc, position, content) ?? position
  const transaction = state.tr
  const singleNode = content.openStart === 0 && content.openEnd === 0 && content.content.childCount === 1
  if (singleNode) transaction.replaceRangeWith(at, at, content.content.firstChild!)
  else transaction.replaceRange(at, at, content)
  if (!transaction.docChanged) return null
  const start = transaction.doc.resolve(at)
  if (singleNode && NodeSelection.isSelectable(content.content.firstChild!) && start.nodeAfter?.sameMarkup(content.content.firstChild!)) {
    transaction.setSelection(new NodeSelection(start))
  } else {
    let end = at
    transaction.mapping.maps.at(-1)?.forEach((_oldStart, _oldEnd, _newStart, newEnd) => { end = newEnd })
    transaction.setSelection(TextSelection.between(start, transaction.doc.resolve(end)))
  }
  return closeHistory(transaction).setMeta('uiEvent', 'drop')
}
