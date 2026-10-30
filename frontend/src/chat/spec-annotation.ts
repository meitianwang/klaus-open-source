export interface SpecAnnotation {
  path: string
  content: string
  comment: string
  startOffset?: number
  endOffset?: number
  anchorText?: string
}

/** The envelope remains readable after persistence, queuing, and history replay. */
export function serializeSpecAnnotation(annotation: SpecAnnotation): string {
  const location = Number.isInteger(annotation.startOffset) && Number.isInteger(annotation.endOffset)
    ? `Rendered text range: ${annotation.startOffset}-${annotation.endOffset}` : ''
  return [
    'Spec annotation',
    `File: ${annotation.path}`,
    location,
    annotation.anchorText ? `Anchor: ${annotation.anchorText}` : '',
    `Selected text:\n${annotation.content}`,
    `Comment:\n${annotation.comment}`,
  ].filter(Boolean).join('\n\n')
}
