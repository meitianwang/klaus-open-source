import { ByteBudgetLru, retainedBytes } from '../byte-budget'

export interface TranscriptViewportState {
  distanceFromBottomPx: number
  turnHeightsByKey: Record<string, number>
  renderedWindow: { anchorKey: string; count: number } | null
  widthPx: number
}

export interface TranscriptViewportAnchor {
  key: string
  bottomOffsetPx: number
  distanceFromBottomPx: number
}

/** Capture a measured visible turn before a virtual window replaces its spacers. */
export function captureViewportAnchor(keys: readonly string[], offsets: readonly number[], scrollTop: number, viewportHeightPx: number, distanceFromBottomPx: number, measuredKeys: ReadonlySet<string>): TranscriptViewportAnchor | null {
  const count = Math.min(keys.length, offsets.length - 1)
  const viewportBottom = scrollTop + Math.max(0, viewportHeightPx)
  for (let index = 0; index < count; index++) {
    if (!measuredKeys.has(keys[index])) continue
    if (offsets[index] >= viewportBottom || offsets[index + 1] <= scrollTop) continue
    return { key: keys[index], bottomOffsetPx: offsets[index + 1], distanceFromBottomPx: Math.max(0, distanceFromBottomPx) }
  }
  return null
}

/** Keep the anchor's bottom distance stable across old and new layout measurements. */
export function scrollTopForViewportAnchor(anchor: TranscriptViewportAnchor, keys: readonly string[], offsets: readonly number[], scrollHeight: number, viewportHeightPx: number): number | null {
  const index = keys.indexOf(anchor.key)
  if (index < 0 || !Number.isFinite(offsets[index + 1])) return null
  const distanceFromBottomPx = Math.max(0, anchor.distanceFromBottomPx + offsets[index + 1] - anchor.bottomOffsetPx)
  return Math.max(0, scrollHeight - Math.max(0, viewportHeightPx) - distanceFromBottomPx)
}

const snapshots = new ByteBudgetLru<string, TranscriptViewportState>(1024 * 1024, 32)
const readers = new Map<HTMLElement, { sessionId: string; read(): TranscriptViewportState | null; captured: boolean }>()

export function transcriptViewportState(sessionId: string): TranscriptViewportState | undefined {
  return snapshots.get(sessionId)
}

export function registerTranscriptViewport(container: HTMLElement, sessionId: string, read: () => TranscriptViewportState | null): () => void {
  const reader = { sessionId, read, captured: false }
  readers.set(container, reader)
  return () => { if (readers.get(container) === reader) readers.delete(container) }
}

/** Capture before the outgoing conversation's layout or DOM can be replaced. */
export function captureTranscriptViewport(container: HTMLElement): void {
  const reader = readers.get(container)
  if (!reader || reader.captured) return
  const snapshot = reader.read()
  if (!snapshot) return
  reader.captured = true
  snapshots.set(reader.sessionId, snapshot, retainedBytes(snapshot))
  snapshots.trim()
}

export function retireTranscriptViewport(sessionId: string): void {
  snapshots.delete(sessionId)
  for (const [container, reader] of readers) if (reader.sessionId === sessionId) readers.delete(container)
}

/** Initial windows are derived from the saved bottom distance, never stale scrollTop. */
export function viewportRange(offsets: readonly number[], distanceFromBottomPx: number, viewportHeightPx: number, overscanPx: number): { start: number; end: number } | null {
  const count = offsets.length - 1
  if (count <= 0) return null
  const bottom = Math.max(0, offsets[count] - Math.max(0, distanceFromBottomPx))
  const top = Math.max(0, bottom - viewportHeightPx - overscanPx)
  return viewportRangeAtOffsets(offsets, top, bottom + overscanPx)
}

/** Locate pixel boundaries without walking every preceding turn on each scroll. */
export function viewportRangeAtOffsets(offsets: readonly number[], top: number, bottom: number): { start: number; end: number } | null {
  const count = offsets.length - 1
  if (count <= 0) return null
  let low = 1, high = count
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle] <= top) low = middle + 1
    else high = middle
  }
  const start = low - 1
  low = start
  high = count
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle] < bottom) low = middle + 1
    else high = middle
  }
  return { start, end: Math.max(start + 1, low) }
}

export function restoredViewportRange(keys: readonly string[], offsets: readonly number[], snapshot: TranscriptViewportState | undefined, viewportHeightPx: number, overscanPx: number): { start: number; end: number } | null {
  const anchor = snapshot?.renderedWindow
  const start = anchor ? keys.indexOf(anchor.anchorKey) : -1
  if (start >= 0 && anchor) return { start, end: Math.min(keys.length, start + anchor.count) }
  return viewportRange(offsets, snapshot?.distanceFromBottomPx ?? 0, viewportHeightPx, overscanPx)
}
