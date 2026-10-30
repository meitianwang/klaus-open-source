import type { Node as DocumentNode } from 'prosemirror-model'
import type { InlineTokenSnapshot } from './inline-token'

interface Piece {
  from: number
  to: number
  start: number
  end: number
  text: string
  atomic?: boolean
}

/** Maps the editor's tree positions to the legacy UTF-16 text interface. */
export function projectComposerDocument(document: DocumentNode) {
  const pieces: Piece[] = []
  const tokens: InlineTokenSnapshot[] = []
  const boundaries: Array<{ position: number; offset: number }> = []
  let text = '', previousEnd: number | null = null
  const append = (value: string, from: number, to: number, atomic = false) => {
    const start = text.length
    text += value
    pieces.push({ from, to, start, end: text.length, text: value, atomic })
    return start
  }
  document.descendants((node, position) => {
    if (!node.isTextblock) return true
    const from = position + 1
    if (previousEnd !== null) append('\n', previousEnd, from, true)
    boundaries.push({ position: from, offset: text.length })
    node.forEach((child, offset) => {
      const childFrom = from + offset
      if (child.isText) append(child.text || '', childFrom, childFrom + child.nodeSize)
      else if (child.type.name === 'composer_token') {
        const value = String(child.attrs.value)
        const start = append(value, childFrom, childFrom + child.nodeSize, true)
        tokens.push({ start, end: text.length, value, ...(child.attrs.data == null ? {} : { data: child.attrs.data }) })
      } else if (child.type.name === 'hard_break') append('\n', childFrom, childFrom + 1)
    })
    previousEnd = from + node.content.size
    boundaries.push({ position: previousEnd, offset: text.length })
    return false
  })
  const documentPosition = (rawOffset: number, bias = 1) => {
    const offset = Math.max(0, Math.min(text.length, rawOffset))
    for (const piece of pieces) {
      if (offset < piece.start || offset > piece.end) continue
      if (offset === piece.start) return piece.from
      if (offset === piece.end) return piece.to
      return piece.atomic ? (bias < 0 ? piece.from : piece.to) : piece.from + offset - piece.start
    }
    return boundaries.find(boundary => boundary.offset === offset)?.position ?? 1
  }
  const textOffset = (position: number, bias = 1) => {
    for (const piece of pieces) {
      if (position < piece.from || position > piece.to) continue
      if (position === piece.from) return piece.start
      if (position === piece.to) return piece.end
      return piece.atomic ? (bias < 0 ? piece.start : piece.end) : piece.start + position - piece.from
    }
    let nearest = boundaries[0]
    for (const boundary of boundaries) {
      if (!nearest || Math.abs(boundary.position - position) < Math.abs(nearest.position - position)) nearest = boundary
    }
    return nearest?.offset ?? 0
  }
  return { text, tokens, documentPosition, textOffset }
}
