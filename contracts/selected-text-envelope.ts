export type QuoteSourceKind = 'chat' | 'code' | 'diff' | 'markdown' | 'word' | 'pdf' | 'spreadsheet' | 'ppt' | 'plan' | 'web'

export interface QuoteSourceMetadata {
  kind: QuoteSourceKind
  path?: string
  repositoryRoot?: string
  url?: string
  title?: string
  presentationId?: string
  startLine?: number
  endLine?: number
  side?: 'before' | 'after'
  section?: string
  paragraph?: number
  page?: number
  totalPages?: number
  slide?: number
  totalSlides?: number
  elementLabel?: string
  sheet?: string
  multiSheet?: boolean
  cellRange?: string
  columnHeaders?: string
  formulas?: string
  selector?: string
  annotation?: string
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const baseName = (path: string) => path.split(/[\\/]/).pop() || path
function truncateMiddle(text: string, max: number): string {
  const chars = Array.from(oneLine(text))
  if (chars.length <= max) return chars.join('')
  const left = Math.ceil((max - 1) / 2)
  const right = max - 1 - left
  return chars.slice(0, left).join('') + '…' + chars.slice(chars.length - right).join('')
}

export function formatQuoteChipLabel(source: QuoteSourceMetadata | undefined, fallbackText: string, lang?: string): string {
  if (!source || source.kind === 'chat') {
    const chars = Array.from(oneLine(fallbackText))
    return chars.length > 40 ? chars.slice(0, 39).join('') + '…' : chars.join('')
  }
  const zh = /^zh(?:-|$)/i.test(lang || '')
  let base = source.path ? baseName(source.path) : source.title || source.kind
  let location = ''
  switch (source.kind) {
    case 'code': case 'diff': case 'markdown':
      if (source.startLine != null) location = `:${source.kind === 'diff' ? source.side === 'before' ? '−' : '+' : ''}${source.startLine}${source.endLine != null && source.endLine !== source.startLine ? `–${source.endLine}` : ''}`
      break
    case 'word':
      location = source.section?.trim() ? truncateMiddle(source.section, 14) : source.paragraph ? zh ? `第 ${source.paragraph} 段` : `¶${source.paragraph}` : ''
      break
    case 'pdf': location = source.page ? zh ? `第 ${source.page} 页` : `p. ${source.page}` : ''; break
    case 'spreadsheet': location = source.cellRange ? `${source.multiSheet && source.sheet ? `${source.sheet}!` : ''}${source.cellRange}` : ''; break
    case 'ppt':
      if (!source.path && !source.title) base = zh ? '演示文稿' : 'Presentation'
      location = source.slide ? zh ? `第 ${source.slide} 页` : `Slide ${source.slide}` : ''
      break
    case 'plan':
      if (!source.path && !source.title) base = zh ? '计划书' : 'Plan'
      location = source.section?.trim() ? truncateMiddle(source.section, 14) : ''
      break
    case 'web':
      base = source.title || 'Web'
      try { base = new URL(source.url || '').hostname.replace(/^www\./i, '') || base } catch {}
      break
  }
  const suffix = location ? location.startsWith(':') ? location : ` · ${oneLine(location)}` : ''
  return truncateMiddle(base, Math.max(1, 30 - Array.from(suffix).length)) + suffix
}

export function quoteSourceIconName(source?: QuoteSourceMetadata): string {
  switch (source?.kind) {
    case 'code': return 'resource-file-code'
    case 'diff': return 'diff'
    case 'markdown': return 'resource-file-document'
    case 'word': return 'resource-file-word'
    case 'pdf': return 'resource-file-pdf'
    case 'spreadsheet': return /\.xlsx?$/i.test(source.path || '') ? 'resource-file-excel' : 'resource-file-spreadsheet'
    case 'ppt': return source.path ? 'resource-file-powerpoint' : 'resource-file-presentation'
    case 'plan': return 'spec'
    case 'web': return 'resource-globe'
    default: return 'quoted-text'
  }
}

function isQuoteSource(source: Partial<QuoteSourceMetadata>): source is QuoteSourceMetadata {
  return ['chat', 'code', 'diff', 'markdown', 'word', 'pdf', 'spreadsheet', 'ppt', 'plan', 'web'].includes(source.kind || '')
    && (['path', 'repositoryRoot', 'url', 'title', 'presentationId', 'section', 'elementLabel', 'sheet',
      'cellRange', 'columnHeaders', 'formulas', 'selector', 'annotation'] as const)
      .every(key => source[key] === undefined || typeof source[key] === 'string')
    && (['startLine', 'endLine', 'paragraph', 'page', 'totalPages', 'slide', 'totalSlides'] as const)
      .every(key => source[key] === undefined || Number.isSafeInteger(source[key]))
    && (source.side === undefined || source.side === 'before' || source.side === 'after')
    && (source.multiSheet === undefined || typeof source.multiSheet === 'boolean')
}

function grounding(source: QuoteSourceMetadata): string[] {
  const line = source.startLine
  const fields: [string, string | number | undefined][] = [
    ['Source', source.kind], ['Path', source.path], ['Repository', source.repositoryRoot],
    ['URL', source.url], ['Title', source.title], ['Presentation ID', source.presentationId],
    ['Lines', line == null ? undefined : `${line}${source.endLine != null && source.endLine !== line ? `-${source.endLine}` : ''} (1-based)`],
    ['Side', source.side === 'before' ? 'before (old file)' : source.side === 'after' ? 'after (new file)' : undefined],
    ['Sheet', source.sheet], ['Range', source.cellRange], ['Column headers', source.columnHeaders], ['Formulas', source.formulas],
    ['Page', source.page == null ? undefined : `${source.page}${source.totalPages ? ` of ${source.totalPages}` : ''}`],
    ['Slide', source.slide == null ? undefined : `${source.slide}${source.totalSlides ? ` of ${source.totalSlides}` : ''}`],
    ['Element', source.elementLabel], ['Section', source.section], ['Paragraph', source.paragraph],
    ['Selector', source.selector], ['Annotation', source.annotation],
  ]
  return fields.flatMap(([label, value]) => value == null || !String(value).trim() ? [] : [`${label}: ${oneLine(String(value))}`])
}

export function formatQuoteReaderText(source: QuoteSourceMetadata | undefined, text: string): string {
  if (!source) return text
  const location = formatQuoteChipLabel(source, '')
  const header = [source.path || source.url, location, source.annotation && oneLine(source.annotation)].filter(Boolean)
  return header.length ? `${[...new Set(header)].join(' · ')}\n\n${text}` : text
}

function encodeQuoteBody(text: string, source?: QuoteSourceMetadata): string {
  if (!source) return text
  // Length framing keeps selection-like headings inside the quoted text intact.
  const json = JSON.stringify({ ...source, textLength: text.length }).replace(/[<>]/g, char => char === '<' ? '\\u003c' : '\\u003e')
  const context = grounding(source).map(line => line.replace(/</g, '&lt;').replace(/>/g, '&gt;')).join('\n')
  return `<!-- klaus-quote: ${json} -->\n<context>\n${context}\n</context>\n${text}`
}

export interface SelectedTextAttachment {
  text: string
  source?: QuoteSourceMetadata
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
        text: selection?.source && typeof selection.text === 'string' ? selection.text : selectionText(selection),
        source: selection?.source as QuoteSourceMetadata | undefined,
        requestOffset: selection && typeof selection === 'object' && Number.isInteger((selection as { requestOffset?: unknown }).requestOffset)
          ? Number((selection as { requestOffset: number }).requestOffset)
          : null,
        displayOrder: selection && typeof selection === 'object' && Number.isInteger((selection as { displayOrder?: unknown }).displayOrder)
          ? Number((selection as { displayOrder: number }).displayOrder)
          : null,
      })).filter(entry => entry.text.trim())
    : []
  const quotes = entries.map(entry => encodeQuoteBody(entry.text, entry.source))
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
  const blocks = orderedEntries.map((entry, index) => `${SELECTION_HEADING_PREFIX}${index + 1}\n${encodeQuoteBody(entry.text, entry.source)}`)
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
export function parseSelectedTextEnvelope(value: unknown, lang?: string): {
  selectedTextAttachments: SelectedTextAttachment[]
  message: string
} | null {
  const raw = String(value || '')
  // Legacy envelopes normalized line endings before parsing.
  const text = raw.includes('<!-- klaus-quote: ') ? raw : raw.replace(/\r\n?/g, '\n')
  if (!text.startsWith(`${SELECTED_TEXT_HEADING}\n`)) return null

  const requestAt = text.lastIndexOf(REQUEST_SEPARATOR)
  if (requestAt < 0) return null
  const selectionSection = text.slice(SELECTED_TEXT_HEADING.length, requestAt).trimStart()
  const heading = /^## Selection ([1-9]\d*)\n/gm
  const selectedTextAttachments: SelectedTextAttachment[] = []
  let match = heading.exec(selectionSection)
  if (!match || match.index !== 0) return null
  while (match) {
    const start = heading.lastIndex
    const metadata = /^<!-- klaus-quote: (\{[^\n]*\}) -->\n(?:<context>\n[\s\S]*?\n<\/context>\n)?/.exec(selectionSection.slice(start))
    let source: QuoteSourceMetadata | undefined
    let length: number | undefined
    if (metadata) {
      try {
        const { textLength, ...parsed } = JSON.parse(metadata[1]!)
        if (isQuoteSource(parsed)) {
          source = parsed
          if (Number.isSafeInteger(textLength) && textLength >= 0) length = textLength
        }
      } catch {}
    }
    const bodyStart = start + (source && metadata ? metadata[0].length : 0)
    if (length != null && bodyStart + length > selectionSection.length) return null
    heading.lastIndex = bodyStart + (length ?? 0)
    match = heading.exec(selectionSection)
    const body = length != null ? selectionSection.slice(bodyStart, bodyStart + length)
      : selectionSection.slice(bodyStart, match?.index ?? selectionSection.length).trim()
    if (!body) return null
    selectedTextAttachments.push(source ? { text: body, source, previewText: formatQuoteChipLabel(source, body, lang) } : { text: body })
  }

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
