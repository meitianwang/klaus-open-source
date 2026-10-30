export interface InlineQuoteRange {
  start: number
  end: number
}

export interface InlineQuoteToken {
  kind?: string
  text?: string
  previewText?: string
  quoteId?: string
  range?: InlineQuoteRange
  requestOffset?: number
  displayOrder?: number
}

export interface PositionedQuote {
  text?: string
  previewText?: string
  quoteId?: string
  requestOffset: number
  displayOrder?: number
}

export interface OrderedDisplayCard {
  kind: 'pasted-text' | 'selected-text'
  text?: string
  displayOrder?: number
}

export function composerOffsetFromDisplayOffset(
  requestOffset: number,
  valueLength: number,
  slashRange?: InlineQuoteRange | null,
  slashCommandLength = 0,
  displayPrefixLength = 0,
): number {
  let offset = Math.max(0, (Number(requestOffset) || 0) - Math.max(0, displayPrefixLength))
  if (slashRange && slashCommandLength > 0) {
    const commandStart = slashRange.start
    const commandEnd = commandStart + slashCommandLength
    if (offset > commandStart && offset < commandEnd) offset = commandEnd
    if (offset >= commandEnd) offset += (slashRange.end - slashRange.start) - slashCommandLength
  }
  return Math.max(0, Math.min(valueLength, offset))
}

export function positionAfterRemovingInlineTokens(position: number, tokens: InlineQuoteToken[]): number {
  return tokens.reduce((next, token) => {
    const range = token.range
    return range && range.end <= position ? next - (range.end - range.start) : next
  }, position)
}

function validRange(value: string, range: InlineQuoteRange | null | undefined): range is InlineQuoteRange {
  return !!range && Number.isInteger(range.start) && Number.isInteger(range.end)
    && range.start >= 0 && range.end > range.start && range.end <= value.length
}

function orderedTokens(value: string, tokens: InlineQuoteToken[]) {
  return tokens
    .filter(token => validRange(value, token.range))
    .slice()
    .sort((a, b) => a.range!.start - b.range!.start)
}

function changedRange(previous: string, next: string) {
  if (previous === next) return null
  let prefix = 0
  const shortest = Math.min(previous.length, next.length)
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix++

  let previousSuffix = previous.length - 1
  let nextSuffix = next.length - 1
  while (
    previousSuffix >= prefix &&
    nextSuffix >= prefix &&
    previous[previousSuffix] === next[nextSuffix]
  ) {
    previousSuffix--
    nextSuffix--
  }
  return {
    previousStart: prefix,
    previousEnd: previousSuffix + 1,
    nextEnd: nextSuffix + 1,
  }
}

export function syncInlineQuoteRanges<T extends InlineQuoteToken>(previous: string, next: string, tokens: T[]): {
  tokens: T[]
  removed: T[]
} {
  const change = changedRange(previous, next)
  if (!change) return { tokens, removed: [] }
  const delta = (change.nextEnd - change.previousStart) - (change.previousEnd - change.previousStart)
  const kept: T[] = []
  const removed: T[] = []
  for (const token of tokens) {
    if (!validRange(previous, token.range)) {
      removed.push(token)
      continue
    }
    if (change.previousEnd <= token.range.start) {
      token.range = { start: token.range.start + delta, end: token.range.end + delta }
      kept.push(token)
    } else if (change.previousStart >= token.range.end) {
      kept.push(token)
    } else {
      removed.push(token)
    }
  }
  return { tokens: kept, removed }
}

export function replaceInlineTokenRange<T extends InlineQuoteToken>(
  start: number,
  end: number,
  replacementLength: number,
  tokens: T[],
): { tokens: T[]; removed: T[] } {
  const safeStart = Math.max(0, start)
  const safeEnd = Math.max(safeStart, end)
  const delta = Math.max(0, replacementLength) - (safeEnd - safeStart)
  const kept: T[] = []
  const removed: T[] = []
  for (const token of tokens) {
    const range = token.range
    if (!range) {
      removed.push(token)
    } else if (range.end <= safeStart) {
      kept.push(token)
    } else if (range.start >= safeEnd) {
      token.range = { start: range.start + delta, end: range.end + delta }
      kept.push(token)
    } else {
      removed.push(token)
    }
  }
  return { tokens: kept, removed }
}

export function expandSelectionAcrossInlineQuotes(
  start: number,
  end: number,
  tokens: InlineQuoteToken[],
  inputType = '',
): InlineQuoteRange {
  let expandedStart = start
  let expandedEnd = end
  if (start === end && inputType === 'deleteContentBackward') expandedStart = Math.max(0, start - 1)
  if (start === end && inputType === 'deleteContentForward') expandedEnd = end + 1

  let changed = true
  while (changed) {
    changed = false
    for (const token of tokens) {
      const range = token.range
      if (!range) continue
      if (expandedStart < range.end && expandedEnd > range.start) {
        const nextStart = Math.min(expandedStart, range.start)
        const nextEnd = Math.max(expandedEnd, range.end)
        changed = nextStart !== expandedStart || nextEnd !== expandedEnd
        expandedStart = nextStart
        expandedEnd = nextEnd
      }
    }
  }
  return { start: expandedStart, end: expandedEnd }
}

export function insertInlineQuotePlaceholder(
  value: string,
  start: number,
  end: number,
  placeholder: string,
) {
  const safeStart = Math.max(0, Math.min(start, value.length))
  const safeEnd = Math.max(safeStart, Math.min(end, value.length))
  const prefix = value.slice(0, safeStart)
  const suffix = value.slice(safeEnd)
  const rangeStart = prefix.length
  const rangeEnd = rangeStart + placeholder.length
  return {
    value: `${prefix}${placeholder}${suffix}`,
    range: { start: rangeStart, end: rangeEnd },
    caret: rangeEnd,
  }
}

export function composeInlineQuotes(value: string, tokens: InlineQuoteToken[], trim = true): {
  text: string
  quotes: PositionedQuote[]
} {
  const ordered = orderedTokens(value, tokens)
  let cursor = 0
  let text = ''
  const quotes: PositionedQuote[] = []
  for (const token of ordered) {
    const range = token.range!
    if (range.start < cursor) continue
    text += value.slice(cursor, range.start)
    quotes.push({
      text: token.text,
      ...(token.previewText ? { previewText: token.previewText } : {}),
      ...(token.quoteId ? { quoteId: token.quoteId } : {}),
      requestOffset: text.length,
      ...(Number.isInteger(token.displayOrder) ? { displayOrder: token.displayOrder } : {}),
    })
    cursor = range.end
  }
  text += value.slice(cursor)

  const leadingTrim = trim ? text.length - text.trimStart().length : 0
  const trimmed = trim ? text.trim() : text
  for (const quote of quotes) {
    quote.requestOffset = Math.max(0, Math.min(trimmed.length, quote.requestOffset - leadingTrim))
  }
  return { text: trimmed, quotes }
}

// Persist the positions of identified attachment tokens for optimistic rendering
// and history replay. Compose before trimming: leading placeholders are spaces.
export function composeInlineQuoteSubmission(value: string, tokens: InlineQuoteToken[], displayText?: string) {
  const entries = orderedTokens(value, tokens)
  entries.forEach((entry, index) => { entry.displayOrder = index })
  const composed = composeInlineQuotes(value, entries)
  const prefix = displayText?.endsWith(composed.text) ? displayText.length - composed.text.length : 0
  const byId = new Map(composed.quotes.filter(quote => quote.quoteId).map(quote => [quote.quoteId, quote]))
  for (const entry of entries) {
    const quote = byId.get(entry.quoteId)
    if (quote) entry.requestOffset = prefix + quote.requestOffset
  }
  return composed
}

// Pasted-text composition moved to ./pasted-text with the host-file reference
// model; re-exported here because this module owns the composer token algebra
// and existing imports resolve through it.
export { composePastedTextRequest } from './pasted-text'
export type { PastedTextCard as PositionedPastedText } from './pasted-text'
export interface PastedTextComposition {
  text: string
  requestOffsetFor: (displayOffset: number, displayOrder?: number) => number
}

export function composeSlashTextCards<T extends OrderedDisplayCard>(value: string, cards: T[]): string {
  const orderedText = cards
    .map((card, originalIndex) => ({ card, originalIndex }))
    .filter(({ card }) => String(card.text || '').trim())
    .sort((a, b) => Number(a.card.displayOrder ?? a.originalIndex) - Number(b.card.displayOrder ?? b.originalIndex))
    .map(({ card }) => String(card.text || '').trim())
  return [String(value || ''), ...orderedText].filter(Boolean).join('\n\n')
}

export function restoreInlineQuotePlaceholders<T extends InlineQuoteToken>(
  text: string,
  tokens: T[],
  placeholderFor: (token: T) => string,
  offsetFor: (token: T) => number | undefined = token => (token as T & { requestOffset?: number }).requestOffset,
) {
  const ordered = tokens
    .filter(token => Number.isInteger(offsetFor(token)))
    .slice()
    .sort((a, b) => {
      const offsetDelta = Number(offsetFor(a)) - Number(offsetFor(b))
      return offsetDelta || Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0)
    })
  let value = text
  let added = 0
  for (const token of ordered) {
    const offset = Math.max(0, Math.min(text.length, Number(offsetFor(token))))
    const placeholder = placeholderFor(token)
    const start = offset + added
    value = value.slice(0, start) + placeholder + value.slice(start)
    token.range = { start, end: start + placeholder.length }
    added += placeholder.length
  }
  return value
}
