// What one queued-message row says about itself.
//
// Split out as a pure module because the fallback chain has real branches worth
// testing: a row with no text still has to describe its attachments, and the
// description differs by kind (a paste shows its own preview, a selection or an
// image shows a count). Getting this wrong is silent — the row just says
// "Queued follow-up" and the user cannot tell which of their three queued
// messages is which.
//
// The media URL resolver is injected so this module stays free of `window` and can
// be exercised in a plain unit test.
import { ttCount } from '../../app/i18n'
import { normalizeComposerReferences, type ComposerReferenceToken } from './reference-token'

const tt = (key: string): string => (window as any).tt?.(key) || key

/** A stored attachment on a queued message. */
export interface QueuedAttachment {
  type?: string
  name?: string
  src?: string
  path?: string
}

/** A pasted-text or selected-text card stored with a queued message. */
export interface QueuedTextCard {
  text?: string
  preview?: string
  previewText?: string
}

export interface QueuedRowSource {
  displayText?: unknown
  finalText?: unknown
  media?: unknown
  liveAttachments?: unknown
  pastedCards?: unknown
  selectedTextAttachments?: unknown
  composerReferences?: unknown
}

/** Preview trimming moves reference ranges, while the queued request retains its original text. */
export function queuedComposerReferences(item: QueuedRowSource | null | undefined, preview: string): ComposerReferenceToken[] {
  const original = typeof item?.displayText === 'string' ? item.displayText : typeof item?.finalText === 'string' ? item.finalText : ''
  const removedLeading = original.length - original.trimStart().length
  return normalizeComposerReferences(preview, normalizeComposerReferences(original, item?.composerReferences).map(reference => ({
    ...reference, range: { start: reference.range.start - removedLeading, end: reference.range.end - removedLeading },
  })))
}

export interface QueuedRowContent {
  /**
   * The row's own text, when it has any. Rendered as markdown by the caller: the
   * pipeline escapes raw HTML, so a queued `<script>` stays inert text.
   */
  text: string
  /**
   * Shown instead of `text` when the row carries no words of its own — a count of
   * selections or images, or the preview of a large paste.
   */
  summary: string
  /** True when `summary` rather than `text` is what the row shows. */
  summaryOnly: boolean
  /** First inline image, as a loadable src plus an accessible name. */
  thumbnail: { src: string; alt: string } | null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cards(value: unknown): QueuedTextCard[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is QueuedTextCard => entry !== null && typeof entry === 'object')
}

function attachments(value: unknown): QueuedAttachment[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is QueuedAttachment => entry !== null && typeof entry === 'object')
}

/**
 * The first image an inline thumbnail can come from.
 *
 * Two places hold one, and they are not redundant: `liveAttachments` keeps the
 * renderer's own preview src (a blob URL while the composer still has it), while
 * `media` keeps the durable uploads path the engine will actually read. A row
 * restored after a reload has only the latter, because a blob URL died with the
 * page that minted it — which is exactly why the path is resolved through the
 * media channel instead of being used as a file URL.
 */
export function queuedRowThumbnail(
  item: QueuedRowSource | null | undefined,
  resolveMediaUrl: (path: string) => string,
): { src: string; alt: string } | null {
  const named = attachments(item?.liveAttachments).find(entry => entry.type === 'image' && (entry.src || ''))
  if (named?.src && !named.src.startsWith('blob:')) return { src: named.src, alt: textOf(named.name) || tt('follow_up_summary_image_alt') }
  const media = Array.isArray(item?.media) ? item.media : []
  for (const entry of media) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as { type?: unknown; path?: unknown; name?: unknown }
    if (row.type !== 'image' || typeof row.path !== 'string' || !row.path) continue
    const src = resolveMediaUrl(row.path)
    if (src) return { src, alt: textOf(row.name) || tt('follow_up_summary_image_alt') }
  }
  if (named?.src) return { src: named.src, alt: textOf(named.name) || tt('follow_up_summary_image_alt') }
  return null
}

/**
 * The row's visible content: its own text first, then a
 * paste preview, then the counts of what else it carries.
 *
 * `previewOf` is injected for the same reason as the media resolver — the
 * multi-line paste preview lives in chat.ts next to the composer that produces it.
 */
export function queuedRowContent(
  item: QueuedRowSource | null | undefined,
  options: {
    previewOf: (text: string) => string
    resolveMediaUrl: (path: string) => string
  },
): QueuedRowContent {
  const text = typeof item?.displayText === 'string' ? textOf(item.displayText) : textOf(item?.finalText)
  const thumbnail = queuedRowThumbnail(item, options.resolveMediaUrl)

  if (text) {
    return { text, summary: '', summaryOnly: false, thumbnail }
  }

  // A large paste has no displayable text by design (that is why it became a
  // card), so the row shows its preview and how many more rides along with it.
  const pasted = cards(item?.pastedCards)
  if (pasted.length > 0) {
    const preview = textOf(pasted[0]?.preview) || textOf(pasted[0]?.previewText) || options.previewOf(textOf(pasted[0]?.text))
    if (pasted.length === 1 && preview) {
      return { text: '', summary: preview, summaryOnly: true, thumbnail }
    }
    return {
      text: '',
      summary: ttCount('follow_up_summary_pasted_more', pasted.length - 1)
        .replace('{preview}', preview || tt('follow_up_summary_pasted')),
      summaryOnly: true,
      thumbnail,
    }
  }

  const selections = cards(item?.selectedTextAttachments).length
  if (selections > 0) {
    return { text: '', summary: ttCount('follow_up_summary_selections', selections), summaryOnly: true, thumbnail }
  }

  const liveCounts = new Map<string, number>(), mediaCounts = new Map<string, number>()
  const count = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) || 0) + 1)
  for (const image of (Array.isArray(item?.media) ? item.media : []).filter(entry => entry?.type === 'image')) {
    count(mediaCounts, image.name || image.fileName || image.path || 'unnamed')
  }
  for (const image of attachments(item?.liveAttachments).filter(entry => entry.type === 'image')) {
    count(liveCounts, image.name || image.path || 'unnamed')
  }
  const images = [...new Set([...liveCounts.keys(), ...mediaCounts.keys()])]
    .reduce((total, key) => total + Math.max(liveCounts.get(key) || 0, mediaCounts.get(key) || 0), 0)
  if (images > 0) {
    return { text: '', summary: ttCount('follow_up_summary_images', images), summaryOnly: true, thumbnail }
  }

  const files = attachments(item?.liveAttachments).filter(entry => entry.type !== 'image')
  if (files.length > 0) {
    const names = files.map(entry => textOf(entry.name)).filter(Boolean)
    if (names.length === files.length) {
      return { text: '', summary: names.join(', '), summaryOnly: true, thumbnail }
    }
    return { text: '', summary: ttCount('follow_up_summary_files', files.length), summaryOnly: true, thumbnail }
  }

  return { text: '', summary: tt('follow_up_empty_queued'), summaryOnly: true, thumbnail }
}
