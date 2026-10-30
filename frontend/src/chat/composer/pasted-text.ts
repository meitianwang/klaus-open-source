// Large composer pastes, aligned end to end with the host-owned file model:
// the composer keeps a reference (path, preview, character count) and the full
// text lives in a host file. Submission appends a reference section to the
// model-facing text instead of inlining the paste, so the wire payload and the
// transcript stay small and the transcript can reopen the full text from disk.

export const PASTE_CHAR_THRESHOLD = 5000
/** Restoring a paste into the editable composer is bounded; beyond it the
 *  text field is the wrong surface and the restore reports a failure. */
export const PASTE_RESTORE_CHAR_LIMIT = 25000
const PREVIEW_LIMIT = 80

export interface PastedTextCard {
  path?: string
  preview?: string
  characterCount?: number
  /** Legacy cards stored the full text inline before references existed. */
  text?: string
  previewText?: string
  requestOffset?: number
  displayOrder?: number
}

export function pastedCharCount(text: string): number {
  return String(text || '').length
}

/** A paste becomes an attachment by UTF-16 length alone; prose of any line
 *  shape below the threshold stays editable text in the composer. */
export function isLargePastedText(text: unknown): boolean {
  const value = String(text || '')
  return pastedCharCount(value) >= PASTE_CHAR_THRESHOLD
}

/** One-line, 80-character preview: trimmed, whitespace collapsed, ellipsized. */
export function pastedTextPreview(text: unknown): string {
  const collapsed = String(text || '').trim().replace(/\s+/g, ' ')
  if (!collapsed) return ''
  const chars = Array.from(collapsed)
  return chars.length <= PREVIEW_LIMIT ? collapsed : `${chars.slice(0, PREVIEW_LIMIT - 1).join('')}…`
}

export function pastedCardPreview(card: PastedTextCard | null | undefined): string {
  if (!card) return ''
  return String(card.preview || card.previewText || pastedTextPreview(card.text || '') || '')
}

export function pastedCardCharacterCount(card: PastedTextCard | null | undefined): number {
  if (!card) return 0
  if (Number.isFinite(card.characterCount)) return Number(card.characterCount)
  return pastedCharCount(card.text || '')
}

/**
 * The model-facing reference section appended after the user's own text.
 *
 * Each card contributes one `## "<preview>": <path>` line under the section
 * header; a submission whose body is empty adds the closing notice that the
 * pasted text carries the request itself. Legacy text-only cards (histories
 * written before references existed) are inlined verbatim so old transcripts
 * keep sending exactly what they sent before.
 */
export const PASTED_FILES_HEADER = '# Files pasted by the user:'
export const PASTED_FILES_CARRY_REQUEST = 'Pasted text contains the user\'s request.'

/** The reference section appended after the user's own text: one
 *  `## "<preview>": <path>` line per stored paste, plus the closing notice when
 *  the body itself is empty. */
export function pastedReferenceSection(cards: PastedTextCard[]): string {
  const referenced = (Array.isArray(cards) ? cards : []).filter(card => card && card.path)
  if (!referenced.length) return ''
  const lines = referenced.map(card => `\n## ${JSON.stringify(pastedCardPreview(card))}: ${card.path}\n`)
  return `\n${PASTED_FILES_HEADER}\n${lines.join('')}`
}

export function composePastedTextRequest(text: string, cards: PastedTextCard[]): {
  text: string
  requestOffsetFor(displayOffset: number, displayOrder?: number): number
} {
  const source = String(text || '')
  const all = (Array.isArray(cards) ? cards : []).filter(card => card && (card.path || String(card.text || '').trim()))
  const positioned = all
    .map((card, originalIndex) => ({ card, originalIndex }))
    .filter(({ card }) => !card.path && Number.isInteger(card.requestOffset))
    .sort((a, b) => {
      const offsetDelta = Number(a.card.requestOffset) - Number(b.card.requestOffset)
      if (offsetDelta) return offsetDelta
      const orderDelta = Number(a.card.displayOrder ?? a.originalIndex) - Number(b.card.displayOrder ?? b.originalIndex)
      return orderDelta || a.originalIndex - b.originalIndex
    })
  const unpositionedInline = all.filter(card => !card.path && !Number.isInteger(card.requestOffset))
  const referenced = all.filter(card => card.path)
  const inserted: Array<{ displayOffset: number; displayOrder: number; length: number }> = []
  let composed = source
  let added = 0

  // Legacy inline cards keep their authored positions: each group is spliced
  // into the body at its display offset, separated by blank lines.
  for (let index = 0; index < positioned.length;) {
    const displayOffset = Math.max(0, Math.min(source.length, Number(positioned[index].card.requestOffset)))
    const group: typeof positioned = []
    while (
      index < positioned.length
      && Math.max(0, Math.min(source.length, Number(positioned[index].card.requestOffset))) === displayOffset
    ) {
      group.push(positioned[index])
      index++
    }
    const before = composed.slice(0, displayOffset + added)
    const after = composed.slice(displayOffset + added)
    const leading = before && !/\n\s*\n$/.test(before) ? '\n\n' : ''
    const trailing = after && !/^\n\s*\n/.test(after) ? '\n\n' : ''
    const contents = group.map(({ card }) => String(card.text || '').replace(/\r\n?/g, '\n').trim())
    const insertion = `${leading}${contents.join('\n\n')}${trailing}`
    composed = before + insertion + after
    group.forEach(({ card, originalIndex }, groupIndex) => {
      const contentLength = contents[groupIndex]!.length
      const prefixLength = groupIndex === 0 ? leading.length : 2
      inserted.push({
        displayOffset,
        displayOrder: Number(card.displayOrder ?? originalIndex),
        length: prefixLength + contentLength + (groupIndex === group.length - 1 ? trailing.length : 0),
      })
    })
    added += insertion.length
  }

  for (const card of unpositionedInline) {
    const content = String(card.text || '').replace(/\r\n?/g, '\n').trim()
    if (!content) continue
    composed = [composed.trimEnd(), content].filter(Boolean).join('\n\n')
  }

  // Referenced cards ride as a path section after the body; the model opens
  // them with its own read tool, so the wire payload never carries the paste.
  if (referenced.length) {
    const lines = referenced.map(card => `\n## ${JSON.stringify(pastedCardPreview(card))}: ${card.path}\n`)
    const bodyEnd = composed.replace(/\n$/, '')
    composed = bodyEnd ? `${bodyEnd}\n${PASTED_FILES_HEADER}\n${lines.join('')}` : `${PASTED_FILES_HEADER}\n${lines.join('')}`
    if (!bodyEnd.trim()) composed += `\n${PASTED_FILES_CARRY_REQUEST}\n`
  }

  return {
    text: composed,
    requestOffsetFor(displayOffset: number, displayOrder = Number.MAX_SAFE_INTEGER) {
      const safeOffset = Math.max(0, Math.min(source.length, Number(displayOffset) || 0))
      return inserted.reduce((offset, insertion) => {
        const comesBefore = insertion.displayOffset < safeOffset
          || (insertion.displayOffset === safeOffset && insertion.displayOrder < displayOrder)
        return comesBefore ? offset + insertion.length : offset
      }, safeOffset)
    },
  }
}

/**
 * Rebuild reference cards from a stored model-facing text.
 *
 * Histories written after references existed carry the section in the message
 * text itself, so a replay without a display snapshot can restore the cards
 * from the section instead of guessing by size.
 */
export function parsePastedReferenceSection(text: unknown): { cards: PastedTextCard[]; displayText: string } | null {
  const value = String(text || '')
  const at = value.indexOf(`\n${PASTED_FILES_HEADER}\n`)
  const start = at >= 0 ? at : (value.startsWith(`${PASTED_FILES_HEADER}\n`) ? -1 : -2)
  if (start === -2) return null
  const section = value.slice(start + 1 + PASTED_FILES_HEADER.length + 1)
  const body = start < 0 ? '' : value.slice(0, start)
  const cards: PastedTextCard[] = []
  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('## ')) continue
    if (trimmed === PASTED_FILES_CARRY_REQUEST) continue
    const match = /^## ("(?:[^"\\]|\\.)*"): (\S+)$/.exec(trimmed)
    if (!match) continue
    let preview = ''
    try { preview = String(JSON.parse(match[1]!)) } catch { preview = match[1]! }
    cards.push({ path: match[2], preview, characterCount: 0 })
  }
  if (!cards.length) return null
  return { cards, displayText: body.replace(/\n$/, '') }
}
