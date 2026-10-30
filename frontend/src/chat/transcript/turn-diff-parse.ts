// Client-side unified-diff parsing for the per-turn change card's hover
// preview. The turn's own patch text rides inside the session's file-change
// record, so the preview needs no round trip: parse locally, cache the parse.
//
// Two cost classes, kept apart on purpose: counting what a patch would render
// is a line scan (cheap, every row), while building hunk structures is only
// worth it once a preview actually opens. Parsed results are cached in a
// bounded LRU keyed by the patch text, so re-hovering a row is free and a
// session full of large patches cannot grow the cache without limit.

export interface ParsedHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const CACHE_MAX_ENTRIES = 50
const CACHE_MAX_BYTES = 8 * 1024 * 1024
/** Patches estimated to render more lines than this get no inline preview. */
export const PREVIEW_LINE_LIMIT = 5000

const cache = new Map<string, ParsedHunk[]>()
let cacheBytes = 0

function cacheSet(key: string, hunks: ParsedHunk[]): void {
  const size = key.length
  while (cache.size >= CACHE_MAX_ENTRIES || cacheBytes + size > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cacheBytes -= oldest.value.length
    cache.delete(oldest.value)
  }
  cache.set(key, hunks)
  cacheBytes += size
}

/** Split a unified diff into hunks. Malformed input yields an empty list
 *  rather than a throw: a preview that cannot parse shows nothing, it never
 *  takes the row down with it. */
export function parseUnifiedDiff(text: string): ParsedHunk[] {
  const cached = cache.get(text)
  if (cached) return cached
  const hunks: ParsedHunk[] = []
  let current: ParsedHunk | null = null
  for (const raw of String(text ?? '').split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      current = {
        oldStart: Number(header[1]) || 0,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]) || 0,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    // A new file section ends the hunk run; so does anything that is not a
    // diff body line.
    if (raw.startsWith('diff --git ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) { current = null; continue }
    if (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ') || raw.startsWith('\\')) current.lines.push(raw)
    else if (raw === '') current.lines.push(' ')
    else current = null
  }
  cacheSet(text, hunks)
  return hunks
}

/** How many rows the patch would render, from its hunk ranges alone. */
export function estimateRenderedLines(text: string): number {
  let total = 0
  for (const raw of String(text ?? '').split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) total += header[4] === undefined ? 1 : Number(header[4])
  }
  return total
}

/** A patch too big to render inline: the estimate or the recorded change
 *  volume whichever is larger, against the inline limit. */
export function isLargeDiff(text: string, added: number | null, removed: number | null): boolean {
  const counted = (added ?? 0) + (removed ?? 0)
  return Math.max(estimateRenderedLines(text), counted) > PREVIEW_LINE_LIMIT
}
