import { normalizeComposerReferences, type ComposerReferenceToken } from './reference-token'

/** Reference labels stay atomic in a queued preview instead of becoming plugin links. */
export function renderReferencePreview(
  text: string,
  references: ComposerReferenceToken[] | undefined,
  renderMarkdown: (text: string) => string,
  renderReference: (reference: ComposerReferenceToken) => string,
): string {
  const normalized = normalizeComposerReferences(text, references)
  if (!normalized.length) return renderMarkdown(text)
  let prefix = 'KLAUS_QUEUED_REFERENCE_'
  while (text.includes(prefix)) prefix += '_'
  const markers = normalized.map((reference, index) => ({ reference, marker: `${prefix}${index}_TOKEN` }))
  let body = text
  for (const { reference, marker } of markers.slice().reverse()) {
    body = body.slice(0, reference.range.start) + marker + body.slice(reference.range.end)
  }
  let html = renderMarkdown(body)
  for (const { reference, marker } of markers) html = html.replace(marker, renderReference(reference))
  return html
}
