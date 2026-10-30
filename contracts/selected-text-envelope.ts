export interface SelectedTextAttachment {
  text: string
  previewText?: string
  requestOffset?: number
  displayOrder?: number
}

const SELECTED_TEXT_HEADING = '# Selected text:'
const SELECTION_HEADING_PREFIX = '## Selection '
const REQUEST_HEADING = '## My request:'
const REQUEST_SEPARATOR = `\n${REQUEST_HEADING}\n`
const INLINE_SELECTION_RE = /⟦Selection ([1-9]\d*)⟧/g

function inlineSelectionMarker(index: number): string {
  return `⟦Selection ${index + 1}⟧`
}

function selectionText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
    return String((value as { text: string }).text).trim()
  }
  return ''
}

/**
 * Persist selected transcript text in the user message itself. The stable text
 * envelope is model-visible and survives engines that only store text blocks.
 */
export function encodeSelectedTextEnvelope(prompt: unknown, selections: unknown): string {
  const entries = Array.isArray(selections)
    ? selections.map((selection) => ({
        text: selectionText(selection),
        requestOffset: selection && typeof selection === 'object' && Number.isInteger((selection as { requestOffset?: unknown }).requestOffset)
          ? Number((selection as { requestOffset: number }).requestOffset)
          : null,
        displayOrder: selection && typeof selection === 'object' && Number.isInteger((selection as { displayOrder?: unknown }).displayOrder)
          ? Number((selection as { displayOrder: number }).displayOrder)
          : null,
      })).filter(entry => entry.text)
    : []
  const quotes = entries.map(entry => entry.text)
  const request = String(prompt || '')
  if (quotes.length === 0) return request
  // Slash commands must remain the first token so the host/engine can expand
  // them. Keep the legacy flattened form for this rare combination rather than
  // turning a working command into ordinary prose.
  if (request.trimStart().startsWith('/')) return [request, ...quotes].join('\n\n')

  const orderedEntries = entries.every(entry => entry.requestOffset !== null)
    ? entries
      .map((entry, originalIndex) => ({ ...entry, originalIndex }))
      .sort((a, b) => (a.requestOffset! - b.requestOffset!)
        || ((a.displayOrder ?? a.originalIndex) - (b.displayOrder ?? b.originalIndex))
        || (a.originalIndex - b.originalIndex))
    : entries.map((entry, originalIndex) => ({ ...entry, originalIndex }))
  const blocks = orderedEntries.map((entry, index) => `${SELECTION_HEADING_PREFIX}${index + 1}\n${entry.text}`)
  let markedRequest = request
  if (entries.every(entry => entry.requestOffset !== null)) {
    let added = 0
    for (const [index, entry] of orderedEntries.entries()) {
      const offset = Math.max(0, Math.min(request.length, entry.requestOffset!)) + added
      const marker = inlineSelectionMarker(index)
      markedRequest = markedRequest.slice(0, offset) + marker + markedRequest.slice(offset)
      added += marker.length
    }
  }
  return `${SELECTED_TEXT_HEADING}\n\n${blocks.join('\n\n')}\n\n${REQUEST_HEADING}\n${markedRequest}\n`
}

/** Parse the envelope emitted by encodeSelectedTextEnvelope during replay. */
export function parseSelectedTextEnvelope(value: unknown): {
  selectedTextAttachments: SelectedTextAttachment[]
  message: string
} | null {
  const text = String(value || '').replace(/\r\n?/g, '\n')
  if (!text.startsWith(`${SELECTED_TEXT_HEADING}\n`)) return null

  const requestAt = text.lastIndexOf(REQUEST_SEPARATOR)
  if (requestAt < 0) return null
  const selectionSection = text.slice(SELECTED_TEXT_HEADING.length, requestAt).trim()
  const heading = /^## Selection ([1-9]\d*)\n/gm
  const matches = Array.from(selectionSection.matchAll(heading))
  if (matches.length === 0 || matches[0]!.index !== 0) return null

  const selectedTextAttachments: SelectedTextAttachment[] = matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : selectionSection.length
    return { text: selectionSection.slice(start, end).trim() }
  }).filter(entry => entry.text)
  if (selectedTextAttachments.length !== matches.length) return null

  const markedRequest = text.slice(requestAt + REQUEST_SEPARATOR.length).trim()
  const markerMatches = Array.from(markedRequest.matchAll(INLINE_SELECTION_RE))
  const markerNumbers = markerMatches.map(match => Number(match[1]))
  if (markerMatches.length === selectedTextAttachments.length
    && new Set(markerNumbers).size === selectedTextAttachments.length
    && markerNumbers.every(number => number >= 1 && number <= selectedTextAttachments.length)) {
    let removed = 0
    for (const match of markerMatches) {
      selectedTextAttachments[Number(match[1]) - 1]!.requestOffset = (match.index || 0) - removed
      removed += match[0].length
    }
    return {
      selectedTextAttachments,
      message: markedRequest.replace(INLINE_SELECTION_RE, ''),
    }
  }
  return { selectedTextAttachments, message: markedRequest }
}
