export interface SpecAnnotationLocation {
  content: string
  startOffset?: number
  endOffset?: number
  anchorText?: string
}

export interface SpecTextRange { start: number; end: number }
export interface SpecTextSegment extends SpecTextRange { nodeIndex: number }

function occurrences(text: string, selected: string): SpecTextRange[] {
  const ranges: SpecTextRange[] = []
  if (!selected) return ranges
  for (let start = text.indexOf(selected); start >= 0; start = text.indexOf(selected, start + 1)) {
    ranges.push({ start, end: start + selected.length })
  }
  return ranges
}

/** Revalidate stored offsets against text; an edited document can move a quote. */
export function locateSpecAnnotation(text: string, annotation: SpecAnnotationLocation): SpecTextRange | null {
  const selected = annotation.content.trim()
  if (!selected) return null
  let candidates = occurrences(text, selected)
  if (!candidates.length) return null
  const anchors = occurrences(text, annotation.anchorText?.trim() || '')
  const anchored = candidates.filter(candidate => anchors.some(anchor => candidate.start >= anchor.start && candidate.end <= anchor.end))
  if (anchored.length) candidates = anchored
  const start = annotation.startOffset
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return candidates[0]
  const end = annotation.endOffset
  if (typeof end === 'number' && end >= start && end <= text.length) {
    const original = text.slice(start, end)
    if (original.trim() === selected) {
      const trimmedStart = start + original.indexOf(selected)
      const exact = candidates.find(candidate => candidate.start === trimmedStart)
      if (exact) return exact
    }
  }
  return candidates.reduce((best, candidate) => Math.abs(candidate.start - start) < Math.abs(best.start - start) ? candidate : best)
}

/** Split a rendered-text range without extending it to whole inline elements. */
export function specAnnotationSegments(nodes: readonly string[], range: SpecTextRange): SpecTextSegment[] {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start) return []
  const segments: SpecTextSegment[] = []
  let offset = 0
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const length = nodes[nodeIndex].length
    const start = Math.max(0, range.start - offset)
    const end = Math.min(length, range.end - offset)
    if (start < end) segments.push({ nodeIndex, start, end })
    offset += length
  }
  return range.end <= offset ? segments : []
}

/** Return marks in reading order; the caller owns scrolling and their lifetime. */
export function markSpecAnnotation(root: HTMLElement, annotation: SpecAnnotationLocation): HTMLElement[] {
  const owner = root.ownerDocument
  const walker = owner.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  const texts = nodes.map(node => node.data)
  const location = locateSpecAnnotation(texts.join(''), annotation)
  if (!location) return []
  const marks: HTMLElement[] = []
  for (const segment of specAnnotationSegments(texts, location).reverse()) {
    const range = owner.createRange()
    range.setStart(nodes[segment.nodeIndex], segment.start)
    range.setEnd(nodes[segment.nodeIndex], segment.end)
    const mark = owner.createElement('mark')
    mark.className = 'spec-annotated'
    range.surroundContents(mark)
    marks.unshift(mark)
  }
  return marks
}
