import { ByteBudgetLru, retainedBytes } from '../byte-budget'

export interface TranscriptViewportState {
  distanceFromBottomPx: number
  turnHeightsByKey: Record<string, number>
  renderedWindow: { anchorKey: string; count: number } | null
  widthPx: number
  latestTurn?: { key: string; followMode: import('./latest-turn-follow').FollowMode; phase: import('./latest-turn-follow').LatestTurnPhase; heightPx: number | null; followContentHeightPx?: number | null } | null
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

/** An already-mounted hidden tab becomes visible again and may be captured on its next departure. */
export function activateTranscriptViewport(container: HTMLElement): void {
  const reader = readers.get(container)
  if (reader) reader.captured = false
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
