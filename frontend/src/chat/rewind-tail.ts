// A rewind drops one sent message and everything that followed it. The screen
// keeps its own copy of that tail: a stopped turn stays in the live layer on
// purpose, and a history reload can still be holding the pre-rewind snapshot.
// This cut is the screen's record of what must not be drawn again.

export interface RewindCut {
  messageUuid: string
  turnId: string
  turnIds: string[]
}

const STATUS_FIELDS = [
  'turnStatuses', 'turnStartedAtMs', 'turnFinishedAtMs', 'turnDurations',
  'turnErrors', 'turnErrorKinds', 'turnErrorDetails', 'turnCancelledTools',
] as const

const pendingRewinds = new Map<string, RewindCut>()

function turnOf(row: { turnId?: unknown } | null | undefined): string {
  return typeof row?.turnId === 'string' ? row.turnId : ''
}

function rowKey(row: { uuid?: unknown; id?: unknown } | null | undefined): string {
  if (typeof row?.uuid === 'string' && row.uuid) return row.uuid
  return typeof row?.id === 'string' ? row.id : ''
}

export function cutIndex(rows: readonly any[] | null | undefined, cut: { messageUuid: string; turnId: string }): number {
  if (!rows?.length) return -1
  if (cut.messageUuid) {
    const byMessage = rows.findIndex(row => rowKey(row) === cut.messageUuid || row?.msg?.uuid === cut.messageUuid)
    if (byMessage >= 0) return byMessage
  }
  if (cut.turnId) {
    const byTurn = rows.findIndex(row => turnOf(row) === cut.turnId || row?.msg?.turnId === cut.turnId)
    if (byTurn >= 0) return byTurn
  }
  return -1
}

function collectTurnIds(rows: readonly any[] | null | undefined, index: number, into: Set<string>): void {
  if (!rows || index < 0) return
  for (const row of rows.slice(index)) {
    const id = turnOf(row) || turnOf(row?.msg)
    if (id) into.add(id)
  }
}

/** Which turns a rewind of this message removes, from the rows currently on screen. */
export function rewindCutFor(state: {
  history?: readonly any[] | null
  loadedRows?: readonly any[] | null
  liveUnits?: readonly any[] | null
}, messageUuid: string, turnId: string): RewindCut {
  const turnIds = new Set<string>()
  if (turnId) turnIds.add(turnId)
  collectTurnIds(state.history, cutIndex(state.history, { messageUuid, turnId }), turnIds)
  collectTurnIds(state.loadedRows, cutIndex(state.loadedRows, { messageUuid, turnId }), turnIds)
  const units = state.liveUnits ?? []
  const liveFrom = cutIndex(units, { messageUuid, turnId })
  if (liveFrom >= 0) {
    for (const unit of units.slice(liveFrom)) {
      const id = turnOf(unit) || turnOf(unit?.msg)
      if (id) turnIds.add(id)
    }
  }
  return { messageUuid, turnId, turnIds: [...turnIds] }
}

export function rowsBeforeRewind<T>(rows: readonly T[], cut: RewindCut): T[] {
  const index = cutIndex(rows, cut)
  if (index >= 0) return rows.slice(0, index)
  if (!cut.turnIds.length) return [...rows]
  const dropped = new Set(cut.turnIds)
  return rows.filter(row => !dropped.has(turnOf(row as { turnId?: unknown })))
}

export function unitsBeforeRewind<T>(units: readonly T[], cut: RewindCut): T[] {
  const index = cutIndex(units, cut)
  const head = index >= 0 ? units.slice(0, index) : units
  if (!cut.turnIds.length) return [...head]
  const dropped = new Set(cut.turnIds)
  return head.filter(unit => {
    const row = unit as { turnId?: unknown; msg?: { turnId?: unknown } }
    return !dropped.has(turnOf(row)) && !dropped.has(turnOf(row.msg))
  })
}

function omitTurns<T>(record: Record<string, T> | undefined, turnIds: readonly string[]): Record<string, T> | undefined {
  if (!record) return record
  const dropped = new Set(turnIds)
  if (![...Object.keys(record)].some(id => dropped.has(id))) return record
  return Object.fromEntries(Object.entries(record).filter(([id]) => !dropped.has(id)))
}

export function replyWithoutRewoundTail(reply: any, cut: RewindCut): any {
  if (Array.isArray(reply)) return rowsBeforeRewind(reply, cut)
  if (!reply || typeof reply !== 'object') return reply
  const messages = Array.isArray(reply.messages) ? rowsBeforeRewind(reply.messages, cut) : reply.messages
  const turns = Array.isArray(reply.turns)
    ? reply.turns.filter((turn: { id?: string }) => !cut.turnIds.includes(turn?.id ?? ''))
    : reply.turns
  const next: Record<string, unknown> = { ...reply, messages, turns }
  for (const field of STATUS_FIELDS) {
    const value = next[field]
    if (value && typeof value === 'object' && !Array.isArray(value)) next[field] = omitTurns(value as Record<string, unknown>, cut.turnIds)
  }
  return next
}

export function savedTranscriptWithoutTurns<T extends {
  entitiesByKey: Record<string, { id: string; items?: any[] }>
  islands: { entries: { key: string; value: string }[] }[]
}>(saved: T | null, turnIds: readonly string[]): T | null {
  if (!saved || !turnIds.length) return saved
  const dropped = new Set(turnIds)
  const dropKeys = new Set<string>()
  for (const [key, turn] of Object.entries(saved.entitiesByKey)) {
    if (dropped.has(turn.id) || turn.items?.some(item => dropped.has(turnOf(item)))) dropKeys.add(key)
  }
  if (!dropKeys.size) return saved
  const entitiesByKey = Object.fromEntries(Object.entries(saved.entitiesByKey).filter(([key]) => !dropKeys.has(key)))
  const islands = saved.islands.flatMap(island => {
    const entries = island.entries.filter(entry => !dropKeys.has(entry.value) && !dropKeys.has(entry.key))
    return entries.length ? [{ ...island, entries }] : []
  })
  return { ...saved, entitiesByKey, islands }
}

export function sessionWithoutRewoundTail<T extends {
  history: any[] | null
  loadedRows: any[] | null
  liveUnits: any[]
  savedTranscript: any
  turnShells: Record<string, unknown>
  turnSequence: string[]
  turnStatuses: Record<string, unknown>
  turnStartedAtMs: Record<string, unknown>
  turnWorkStartedAtMs: Record<string, unknown>
  turnWorkCompletedAtMs: Record<string, unknown>
  turnFinishedAtMs: Record<string, unknown>
  turnDurations: Record<string, unknown>
  turnErrors: Record<string, unknown>
  turnErrorKinds: Record<string, unknown>
  turnErrorDetails: Record<string, unknown>
  turnCancelledTools: Record<string, unknown>
  turnCollapseOverrides: Record<string, unknown>
  interruptedLiveTurn: { turnId: string | null } | null
  lastTerminalStatus: string | null
  stopRequestedAt: number | null
  liveTurnId: string | null
  activeTurnId: string | null
}>(state: T, cut: RewindCut): Partial<T> {
  const ids = new Set(cut.turnIds)
  const liveUnits = unitsBeforeRewind(state.liveUnits ?? [], cut)
  const interruptedId = state.interruptedLiveTurn?.turnId
  const clearInterrupted = (interruptedId ? ids.has(interruptedId) : false)
    || (!interruptedId && state.interruptedLiveTurn != null && liveUnits.length !== (state.liveUnits ?? []).length)
  return {
    history: state.history == null ? null : rowsBeforeRewind(state.history, cut),
    loadedRows: state.loadedRows == null ? null : rowsBeforeRewind(state.loadedRows, cut),
    liveUnits,
    savedTranscript: savedTranscriptWithoutTurns(state.savedTranscript, cut.turnIds),
    turnShells: omitTurns(state.turnShells, cut.turnIds) ?? {},
    turnSequence: (state.turnSequence ?? []).filter(id => !ids.has(id)),
    turnStatuses: omitTurns(state.turnStatuses, cut.turnIds) ?? {},
    turnStartedAtMs: omitTurns(state.turnStartedAtMs, cut.turnIds) ?? {},
    turnWorkStartedAtMs: omitTurns(state.turnWorkStartedAtMs, cut.turnIds) ?? {},
    turnWorkCompletedAtMs: omitTurns(state.turnWorkCompletedAtMs, cut.turnIds) ?? {},
    turnFinishedAtMs: omitTurns(state.turnFinishedAtMs, cut.turnIds) ?? {},
    turnDurations: omitTurns(state.turnDurations, cut.turnIds) ?? {},
    turnErrors: omitTurns(state.turnErrors, cut.turnIds) ?? {},
    turnErrorKinds: omitTurns(state.turnErrorKinds, cut.turnIds) ?? {},
    turnErrorDetails: omitTurns(state.turnErrorDetails, cut.turnIds) ?? {},
    turnCancelledTools: omitTurns(state.turnCancelledTools, cut.turnIds) ?? {},
    turnCollapseOverrides: omitTurns(state.turnCollapseOverrides, cut.turnIds) ?? {},
    ...(clearInterrupted ? { interruptedLiveTurn: null, lastTerminalStatus: null, stopRequestedAt: null } : {}),
    ...(state.liveTurnId && ids.has(state.liveTurnId) ? { liveTurnId: null } : {}),
    ...(state.activeTurnId && ids.has(state.activeTurnId) ? { activeTurnId: null } : {}),
  } as Partial<T>
}

export function rememberRewindCut(sessionId: string, cut: RewindCut): void {
  pendingRewinds.set(sessionId, cut)
}

export function peekRewindCut(sessionId: string): RewindCut | undefined {
  return pendingRewinds.get(sessionId)
}

/** Drop the pending cut once a snapshot no longer contains the rewound tail. */
export function settleRewindCut(sessionId: string, reply: any): RewindCut | null {
  const cut = pendingRewinds.get(sessionId)
  if (!cut) return null
  const messages = Array.isArray(reply) ? reply : (Array.isArray(reply?.messages) ? reply.messages : [])
  const turns = Array.isArray(reply?.turns) ? reply.turns : []
  const dropped = new Set(cut.turnIds)
  const hit = cutIndex(messages, cut) >= 0
    || messages.some((row: { turnId?: unknown }) => dropped.has(turnOf(row)))
    || turns.some((turn: { id?: string }) => dropped.has(turn?.id ?? ''))
  if (!hit) {
    pendingRewinds.delete(sessionId)
    return null
  }
  return cut
}

export function clearRewindCut(sessionId: string): void {
  pendingRewinds.delete(sessionId)
}
