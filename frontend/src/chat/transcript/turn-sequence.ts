/**
 * One ordered sequence for saved and live Turns.
 *
 * A session receives Turn data from two sources: saved pages that arrive in
 * turn order, and live units that arrive as the Turn streams. Rendering them as
 * two stacked layers makes the order depend on which layer currently holds a
 * Turn, so a Turn that outlived a page boundary can move. This module folds
 * both sources into one list. Saved Turns keep their saved order; a live Turn
 * that a saved frame already holds folds into that frame; a run of live-only
 * Turns is emitted immediately before the next Turn the session observed after
 * them that has a saved position. A trailing run with no such anchor keeps its
 * order by start time, then falls after everything else.
 */
export interface TurnSequenceRef {
  /** Stable render key shared by a saved frame and its live overlay. */
  key: string
  /** Position in the saved window, or null for a Turn that is live only. */
  savedIndex: number | null
  /** Render key of the saved frame this live ref folds into, when it has one. */
  savedKey?: string | null
  /** Turn identity, used to find the next saved position in the observed order. */
  turnId: string | null
  /** Start time, used only when the observed order cannot anchor a run. */
  startMs: number
}

export function mergeTurnSequence(
  saved: readonly TurnSequenceRef[],
  live: readonly TurnSequenceRef[],
  observedOrder: readonly string[],
): TurnSequenceRef[] {
  const savedByTurn = new Map<string, TurnSequenceRef>()
  for (const frame of saved) if (frame.turnId) savedByTurn.set(frame.turnId, frame)

  const insertBefore = new Map<string, TurnSequenceRef[]>()
  const place = (anchorKey: string, rows: TurnSequenceRef[]) => {
    if (!rows.length) return
    const existing = insertBefore.get(anchorKey)
    if (existing) existing.push(...rows)
    else insertBefore.set(anchorKey, [...rows])
  }

  let pending: TurnSequenceRef[] = []
  for (const frame of live) {
    if (frame.savedIndex != null) {
      // The saved frame owns this Turn; emit anything buffered before it.
      place(frame.savedKey ?? frame.key, pending)
      pending = []
      continue
    }
    pending.push(frame)
  }

  let trailing: TurnSequenceRef[] = []
  if (pending.length) {
    const anchor = orderAnchor(pending, observedOrder, savedByTurn)
      ?? startAnchor(pending, saved)
    if (anchor) place(anchor.key, pending)
    else trailing = pending
  }

  const result: TurnSequenceRef[] = []
  for (const frame of saved) {
    const rows = insertBefore.get(frame.key)
    if (rows) result.push(...rows)
    result.push(frame)
  }
  result.push(...trailing)
  return result
}

/** The first Turn observed after the run that already has a saved position. */
function orderAnchor(
  run: TurnSequenceRef[],
  observedOrder: readonly string[],
  savedByTurn: ReadonlyMap<string, TurnSequenceRef>,
): TurnSequenceRef | null {
  const lastTurnId = [...run].reverse().find(frame => frame.turnId)?.turnId
  if (!lastTurnId) return null
  let index = observedOrder.lastIndexOf(lastTurnId)
  if (index < 0) return null
  for (index += 1; index < observedOrder.length; index += 1) {
    const anchor = savedByTurn.get(observedOrder[index])
    if (anchor) return anchor
  }
  return null
}

/** Start-time fallback for a run the observed order cannot anchor. */
function startAnchor(run: TurnSequenceRef[], saved: readonly TurnSequenceRef[]): TurnSequenceRef | null {
  let start = Number.POSITIVE_INFINITY
  for (const frame of run) if (Number.isFinite(frame.startMs)) start = Math.min(start, frame.startMs)
  if (!Number.isFinite(start)) return null
  return saved.find(frame => Number.isFinite(frame.startMs) && frame.startMs > start) ?? null
}
