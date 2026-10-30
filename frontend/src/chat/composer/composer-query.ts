import type { EditorState } from 'prosemirror-state'
import { projectComposerDocument } from './document-projection'

export interface ComposerQuery {
  prefix: '/' | '@' | '$'
  start: number
  end: number
  query: string
}

const QUERY = /(?:^|\s)([/@$])([\p{L}\p{N}\p{M}.:_/\\-]*)$/u
const SLASH_QUERY = /(?:^|\s)(\/)(?!\s)([\p{L}\p{N}\p{M}.:_\\ -]*)$/u

/** Match only the editable text immediately before an empty selection. */
export function composerQueryInText(text: string, start: number, end = start): ComposerQuery | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > text.length) return null
  const before = text.slice(0, start)
  const matches = [QUERY.exec(before), SLASH_QUERY.exec(before)].filter((match): match is RegExpExecArray => !!match)
  if (!matches.length) return null
  const match = matches.sort((a, b) => b.index - a.index)[0]
  return { prefix: match[1] as ComposerQuery['prefix'], query: match[2],
    start: start - match[2].length - 1, end: start }
}

/** Atoms, hard breaks and code blocks bound the text a picker can consume. */
export function composerQueryInDocument(state: EditorState, continuation?: { prefix: ComposerQuery['prefix']; position: number } | null): ComposerQuery | null {
  const { selection } = state
  if (!selection.empty || !selection.$from.parent.isTextblock || selection.$from.parent.type.spec.code) return null
  const { $from } = selection
  if (continuation && continuation.position < $from.pos) {
    const anchor = state.doc.resolve(continuation.position)
    const value = state.doc.textBetween(continuation.position, $from.pos, '\n', '\uFFFC')
    if (anchor.sameParent($from) && value[0] === continuation.prefix && /^[\p{L}\p{N}\p{M}.:_/\\ -]*$/u.test(value.slice(1))) {
      const projection = projectComposerDocument(state.doc)
      return { prefix: continuation.prefix, start: projection.textOffset(continuation.position),
        end: projection.textOffset($from.pos), query: value.slice(1) }
    }
  }
  let text = '', segmentFrom = $from.start()
  $from.parent.forEach((node, offset) => {
    if (offset >= $from.parentOffset) return
    if (node.isText) text += node.text!.slice(0, $from.parentOffset - offset)
    else { text = ''; segmentFrom = $from.start() + offset + node.nodeSize }
  })
  const query = composerQueryInText(text, text.length)
  if (!query) return null
  const projection = projectComposerDocument(state.doc)
  return { ...query, start: projection.textOffset(segmentFrom + query.start), end: projection.textOffset($from.pos) }
}

export function sameComposerQuery(left: ComposerQuery | null, right: ComposerQuery | null): boolean {
  return left?.prefix === right?.prefix && left?.start === right?.start && left?.end === right?.end && left?.query === right?.query
}
