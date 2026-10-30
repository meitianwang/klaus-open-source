import { Selection, TextSelection, type Command } from 'prosemirror-state'

const inCode = (state: Parameters<Command>[0]) => state.selection.$from.parent.type.spec.code
  && state.selection.$from.sameParent(state.selection.$to)

/** A modified newline stays inside the current code block. */
export const codeNewline: Command = (state, dispatch) => {
  if (!inCode(state)) return false
  dispatch?.(state.tr.insertText('\n').scrollIntoView())
  return true
}

/** Move to the following paragraph, creating one only when needed. */
export const leaveCode: Command = (state, dispatch) => {
  if (!inCode(state)) return false
  const { $from } = state.selection
  const after = $from.after(), paragraph = state.schema.nodes.paragraph
  const transaction = state.tr
  if (state.doc.nodeAt(after)?.type !== paragraph) {
    const parent = $from.node(-1), index = $from.indexAfter(-1)
    if (!parent.canReplaceWith(index, index, paragraph)) return false
    transaction.insert(after, paragraph.create())
  }
  dispatch?.(transaction.setSelection(TextSelection.create(transaction.doc, after + 1)).scrollIntoView())
  return true
}

export function indentCode(remove: boolean): Command {
  return (state, dispatch) => {
    if (!inCode(state)) return false
    const { $from, $to } = state.selection
    const text = $from.parent.textContent, start = $from.parentOffset, end = $to.parentOffset
    const first = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
    const last = end > start && text[end - 1] === '\n' ? end - 1 : end
    const lines = [first]
    for (let position = text.indexOf('\n', first); position >= 0 && position < last; position = text.indexOf('\n', position + 1)) lines.push(position + 1)
    const transaction = state.tr
    for (const position of lines.reverse()) {
      const at = $from.start() + position
      if (remove) {
        const prefix = /^(?:\t| {1,4})/.exec(text.slice(position))?.[0]
        if (prefix) transaction.delete(at, at + prefix.length)
      } else transaction.insertText('\t', at)
    }
    if (transaction.docChanged) dispatch?.(transaction.scrollIntoView())
    return true
  }
}

export const selectCode: Command = (state, dispatch) => {
  if (!inCode(state)) return false
  const { $from, from, to } = state.selection
  const start = $from.start(), end = $from.end()
  if (from === start && to === end) return false
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, start, end)))
  return true
}

/** Arrow navigation leaves visual boundaries and preserves logical line ends. */
export function codeArrow(direction: -1 | 1): Command {
  return (state, dispatch, view) => {
    if (!state.selection.empty) return false
    const { $from } = state.selection
    const edge = direction < 0 ? 'up' : 'down'
    if (!inCode(state)) {
      if (direction > 0 || $from.parent.type !== state.schema.nodes.paragraph || !view?.endOfTextblock('up', state)) return false
      const before = $from.before(), previous = state.doc.resolve(before).nodeBefore
      if (!previous?.type.spec.code) return false
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, before - 1)).scrollIntoView())
      return true
    }
    if (direction > 0 && $from.parentOffset === $from.parent.content.size) return leaveCode(state, dispatch, view)
    if (view?.endOfTextblock(edge, state)) {
      const boundary = direction < 0 ? $from.before() : $from.after()
      const selection = Selection.findFrom(state.doc.resolve(boundary), direction, true)
      const transaction = state.tr
      if (selection) transaction.setSelection(selection)
      else {
        const parent = $from.node(-1), index = direction < 0 ? $from.index(-1) : $from.indexAfter(-1)
        const paragraph = state.schema.nodes.paragraph
        if (!parent.canReplaceWith(index, index, paragraph)) return false
        transaction.insert(boundary, paragraph.create())
          .setSelection(TextSelection.create(transaction.doc, boundary + 1))
      }
      dispatch?.(transaction.scrollIntoView())
      return true
    }
    const text = $from.parent.textContent, offset = $from.parentOffset
    if (offset < text.length && text[offset] !== '\n') return false
    const lineStart = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1
    const target = direction < 0 ? lineStart - 1 : text.indexOf('\n', offset + 1)
    if (direction < 0 && target < 0 || direction > 0 && offset >= text.length) return false
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, $from.start() + (target < 0 ? text.length : target))).scrollIntoView())
    return true
  }
}
