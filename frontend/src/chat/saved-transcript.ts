import {
  extendHistoryBoundary, insertHistorySegment, nextHistoryBoundary, ownsHistoryBoundary,
  type HistoryBoundary, type HistoryBoundaryRequest, type HistoryPolicy, type HistoryTopology,
} from './history-topology'
import type { TranscriptPageReply, TranscriptPaginationState, TranscriptTurnShell } from './transcript-pagination'

export interface TurnPageHandle { cursor: string; oldestLoadedTurnId: string | null; source: 'saved' }
export interface TurnItemsPagination {
  olderCursor: string | null
  olderItemId?: string
  evicted?: boolean
  isLoadingOlder: boolean
  hasLoadedOldest: boolean
  summaryItemIds?: string[]
  newestSnapshotItemId?: string
  oldestFetchedItemId?: string
  error?: string
  reconnect?: { stopItemId: string; olderCursorAfterReconnect: string | null; beforeItemId: string }
}
export interface SavedTurn {
  id: string
  auxiliary?: boolean
  position: number
  shell: TranscriptTurnShell
  items: any[]
  itemsPagination: TurnItemsPagination
}
export interface SavedTranscript extends HistoryTopology<string, TurnPageHandle> {
  entitiesByKey: Record<string, SavedTurn>
}
export type TurnBoundaryRequest = HistoryBoundaryRequest<TurnPageHandle>
export interface TurnItemsPage {
  rows: any[]
  reply: TranscriptPageReply
  nextCursor: string | null
  openingRows?: any[]
}

export const savedRowId = (row: any): string => typeof row?.uuid === 'string' && row.uuid
  ? row.uuid : typeof row?.id === 'string' ? row.id : ''

function uniqueRows(previous: any[], incoming: any[], mode: 'prepend' | 'append' | { snapshotBeforeItemId: string | null }): any[] {
  const existing = new Map(previous.map(row => [savedRowId(row), row]))
  const replacements = new Map<string, any>()
  const before = new Map<string, any[]>()
  const seen = new Set<string>()
  let pending: any[] = []
  let lastAnchor: string | null = null
  for (const row of incoming) {
    const id = savedRowId(row)
    if (id && seen.has(id)) continue
    if (id) seen.add(id)
    if (!id || !existing.has(id)) { pending.push(row); continue }
    replacements.set(id, row)
    lastAnchor = id
    if (pending.length) { before.set(id, pending); pending = [] }
  }
  const rows = previous.flatMap(row => [...(before.get(savedRowId(row)) ?? []), replacements.get(savedRowId(row)) ?? row])
  if (!pending.length) return rows
  if (typeof mode === 'object') {
    if (lastAnchor !== null) {
      const index = rows.findIndex(row => savedRowId(row) === lastAnchor) + 1
      return [...rows.slice(0, index), ...pending, ...rows.slice(index)]
    }
    if (mode.snapshotBeforeItemId !== null) {
      const index = rows.findIndex(row => savedRowId(row) === mode.snapshotBeforeItemId)
      if (index >= 0) return [...rows.slice(0, index), ...pending, ...rows.slice(index)]
    }
  }
  return replacements.size === 0 && mode === 'prepend' ? [...pending, ...rows] : [...rows, ...pending]
}

function boundary(cursor: string | null, oldest: string | null, boundaryId?: string): HistoryBoundary<TurnPageHandle> {
  return cursor === null ? { status: 'exhausted', boundaryId } : {
    status: 'available', boundaryId, progressKey: JSON.stringify([cursor, oldest]),
    handle: { cursor, oldestLoadedTurnId: oldest, source: 'saved' },
  }
}

function policy(entities: Record<string, SavedTurn>): HistoryPolicy<string> {
  return { identity: key => entities[key]?.id ?? null, position: entry => entities[entry.value]?.position ?? 0, merge: previous => previous }
}

const turnKey = (id: string) => `turn:${id}`
const derivedRow = (row: any) => {
  const id = savedRowId(row)
  const local = row?.localRender ?? row?.message?.localRender
  // Friend display records come from the host ledger, outside engine item pages.
  const friendDisplay = id.startsWith('friend-')
    && (local?.externalFriendMessage === true || local?.friendOutgoingMessage === true)
  return row?.kind === 'approval-review' || id.startsWith('goal-completed-') || friendDisplay
}
const newestSourceItem = (rows: any[]) => savedRowId(rows.findLast(row => !derivedRow(row)))
const nextCursor = (reply: TranscriptPageReply) => reply.page?.hasMore === true && typeof reply.page.nextCursor === 'string' && reply.page.nextCursor ? reply.page.nextCursor : null
const pageShells = (reply: TranscriptPageReply) => Array.isArray(reply.turns)
  ? reply.turns.filter((turn): turn is TranscriptTurnShell => !!turn && typeof turn === 'object' && typeof (turn as TranscriptTurnShell).id === 'string') : []

// The saved index groups inherited messages under a preamble, while their
// renderer rows intentionally have no model turnId. Summary and item pages
// must still share that pagination owner instead of creating auxiliary copies.
const rowOwner = (row: any, preambleId?: string): string | undefined => row.turnId
  || (!derivedRow(row) ? preambleId : undefined)

function summaryTurn(shell: TranscriptTurnShell, rows: any[], previous: SavedTurn | undefined, position: number): SavedTurn {
  const preambleId = shell.id.endsWith('-preamble') ? shell.id : undefined
  const summary = rows.filter(row => rowOwner(row, preambleId) === shell.id)
  const full = shell.itemsView === 'full'
  const sameRevision = previous && shell.updatedAtOrdinal !== undefined
    && previous.shell.updatedAtOrdinal === shell.updatedAtOrdinal
  if (previous && sameRevision) return { ...previous, position, shell, items: uniqueRows(previous.items, summary, 'append'),
    itemsPagination: full ? { olderCursor: null, isLoadingOlder: false, hasLoadedOldest: true }
      : { ...previous.itemsPagination, isLoadingOlder: false } }
  const items = previous ? uniqueRows(previous.items, summary, 'append') : summary
  const previousPager = previous?.itemsPagination
  const lastId = previousPager?.reconnect?.stopItemId ?? previousPager?.newestSnapshotItemId ?? newestSourceItem(previous?.items ?? [])
  return {
    id: shell.id, shell, position, items,
    itemsPagination: {
      olderCursor: null, isLoadingOlder: false, hasLoadedOldest: full,
      oldestFetchedItemId: previousPager?.oldestFetchedItemId,
      newestSnapshotItemId: previousPager?.newestSnapshotItemId,
      ...(!full ? { summaryItemIds: summary.map(savedRowId).filter(Boolean) } : {}),
      ...(!full && lastId && (previousPager?.summaryItemIds === undefined || previousPager.reconnect) ? {
        reconnect: { stopItemId: lastId, olderCursorAfterReconnect: previousPager?.reconnect?.olderCursorAfterReconnect ?? previousPager?.olderCursor ?? null,
          beforeItemId: savedRowId(summary[0]) || lastId },
      } : {}),
    },
  }
}

function auxiliaryRows(entities: Record<string, SavedTurn>, rows: any[], shells: TranscriptTurnShell[], generation: number) {
  const selected = new Set(shells.map(shell => shell.id))
  const preambleId = shells.find(shell => shell.id.endsWith('-preamble'))?.id
  const added: { key: string; value: string }[] = []
  let position = shells.length ? entities[turnKey(shells[0].id)].position - 1 : 0
  let sequence = 0
  for (const [index, row] of rows.entries()) {
    const ownerId = rowOwner(row, preambleId)
    if (ownerId && selected.has(ownerId)) { position = entities[turnKey(ownerId)].position; sequence = 0; continue }
    const owner = ownerId ? entities[turnKey(ownerId)] : undefined
    if (owner && !owner.auxiliary) {
      entities[turnKey(owner.id)] = { ...owner, items: uniqueRows(owner.items, [row], 'append') }
      continue
    }
    const key = `row:${savedRowId(row) || `local:${generation}:${index}`}`
    const previous = entities[key]
    entities[key] = { id: key, auxiliary: true, position: previous?.position ?? position + ++sequence / 1_000_000,
      shell: { id: key, itemsView: 'full' }, items: [row],
      itemsPagination: { olderCursor: null, isLoadingOlder: false, hasLoadedOldest: true } }
    if (!previous) added.push({ key, value: key })
  }
  return added
}

/** Merge a new summary window without discarding previously accepted islands. */
export function commitSavedSnapshot(previous: SavedTranscript | null, reply: TranscriptPageReply, generation: number, replace = false): SavedTranscript {
  const shells = pageShells(reply)
  const rows = Array.isArray(reply.messages) ? reply.messages : []
  const cursor = nextCursor(reply)
  const retain = previous && !replace && cursor !== null && shells.length > 0 ? previous : null
  const entitiesByKey: Record<string, SavedTurn> = { ...(retain?.entitiesByKey ?? {}) }
  const existing = Object.values(entitiesByKey)
  const overlapping = shells.findIndex(shell => entitiesByKey[turnKey(shell.id)])
  const fallback = overlapping >= 0 ? entitiesByKey[turnKey(shells[overlapping].id)].position - overlapping
    : existing.reduce((latest, turn) => Math.max(latest, turn.position + 1), 0)
  const entries = shells.map((shell, index) => {
    const key = turnKey(shell.id)
    const position = shell.ordinal ?? entitiesByKey[key]?.position ?? fallback + index
    entitiesByKey[key] = summaryTurn(shell, rows, previous?.entitiesByKey[key], position)
    return { key, value: key }
  })
  entries.push(...auxiliaryRows(entitiesByKey, rows, shells, generation))
  const initial: SavedTranscript = { generation, isComplete: false, islands: retain?.islands ?? [], entitiesByKey }
  return { ...insertHistorySegment(initial, `snapshot:${generation}`, {
    entries, olderBoundary: boundary(cursor, shells[0]?.id ?? null), newerBoundary: { status: 'exhausted' },
  }, policy(entitiesByKey)), entitiesByKey }
}

export function savedRows(history: SavedTranscript): any[] {
  return history.islands.flatMap(island => island.entries.flatMap(entry => history.entitiesByKey[entry.value]?.items ?? []))
}
export function savedShells(history: SavedTranscript): Record<string, TranscriptTurnShell> {
  return Object.fromEntries(Object.values(history.entitiesByKey).filter(turn => !turn.auxiliary).map(turn => [turn.id, turn.shell]))
}
export function savedTurns(history: SavedTranscript): SavedTurn[] {
  return history.islands.flatMap(island => island.entries.flatMap(entry => history.entitiesByKey[entry.value] ? [history.entitiesByKey[entry.value]] : []))
}
export function savedPagination(history: SavedTranscript, isLoadingOlder = false): TranscriptPaginationState {
  const request = nextHistoryBoundary(history, true)
  const first = savedTurns(history)[0]?.id ?? null
  return { olderCursor: request?.handle.cursor ?? null, oldestLoadedTurnId: request?.handle.oldestLoadedTurnId ?? first,
    isLoadingOlder, hasLoadedOldest: request === null }
}
export const savedBoundary = (history: SavedTranscript) => nextHistoryBoundary(history, true)
export const ownsSavedBoundary = (history: SavedTranscript, request: TurnBoundaryRequest) => ownsHistoryBoundary(history, request,
  (left, right) => left.cursor === right.cursor && left.source === right.source && left.oldestLoadedTurnId === right.oldestLoadedTurnId)

export function commitOlderTurns(previous: SavedTranscript, request: TurnBoundaryRequest, reply: TranscriptPageReply): SavedTranscript | null {
  if (!ownsSavedBoundary(previous, request)) return null
  const shells = pageShells(reply)
  const rows = Array.isArray(reply.messages) ? reply.messages : []
  const entitiesByKey = { ...previous.entitiesByKey }
  const island = previous.islands.find(island => island.id === request.islandId)
  const anchor = island?.entries[0]?.value
  const firstPosition = anchor ? entitiesByKey[anchor]?.position ?? 0 : 0
  const entries = shells.map((shell, index) => {
    const key = turnKey(shell.id)
    entitiesByKey[key] = summaryTurn(shell, rows, entitiesByKey[key], shell.ordinal ?? entitiesByKey[key]?.position ?? firstPosition + index - shells.length)
    return { key, value: key }
  })
  entries.push(...auxiliaryRows(entitiesByKey, rows, shells, previous.generation))
  const next = nextCursor(reply)
  if (next === request.handle.cursor) throw new Error('thread turns page returned an unchanged cursor')
  const result = extendHistoryBoundary(previous, request, {
    entries,
    olderBoundary: boundary(next, shells[0]?.id ?? request.handle.oldestLoadedTurnId),
    newerBoundary: { status: 'exhausted' },
  }, policy(entitiesByKey))
  return result.status === 'applied' ? { ...result.history, entitiesByKey } : null
}

export function patchSavedTurn(history: SavedTranscript, turnId: string, patch: (turn: SavedTurn) => SavedTurn): SavedTranscript {
  const key = turnKey(turnId), turn = history.entitiesByKey[key]
  return turn ? { ...history, entitiesByKey: { ...history.entitiesByKey, [key]: patch(turn) } } : history
}
export const savedTurn = (history: SavedTranscript | null, turnId: string): SavedTurn | undefined => history?.entitiesByKey[turnKey(turnId)]

/** Preserve rows updated after a request began while replacing its snapshot. */
export function commitTurnItems(history: SavedTranscript, turnId: string, expected: TurnItemsPagination, capturedRows: any[], page: TurnItemsPage): SavedTranscript | null {
  const turn = savedTurn(history, turnId)
  if (!turn || turn.itemsPagination !== expected) return null
  const captured = new Map(capturedRows.map(row => [savedRowId(row), row]))
  const concurrent = new Map(turn.items.filter(row => captured.get(savedRowId(row)) !== row).map(row => [savedRowId(row), row]))
  const isUnowned = (row: any) => row.turnId && row.turnId !== turnId || !row.turnId && derivedRow(row)
  const unowned = uniqueRows([], [...page.rows, ...(page.openingRows ?? [])].filter(isUnowned), 'append')
  const bodyRows = page.rows.filter(row => !isUnowned(row))
  const summaryIds = new Set(expected.summaryItemIds ?? [])
  let previous = expected.summaryItemIds ? turn.items.filter(row => !summaryIds.has(savedRowId(row)) || concurrent.has(savedRowId(row))) : turn.items
  const stop = expected.reconnect?.stopItemId
  const reachedStop = !!stop && page.rows.some(row => savedRowId(row) === stop)
  const cursor = reachedStop ? expected.reconnect?.olderCursorAfterReconnect ?? null : page.nextCursor
  let items = uniqueRows(previous, bodyRows, expected.reconnect
    ? { snapshotBeforeItemId: expected.reconnect.beforeItemId }
    : expected.oldestFetchedItemId ? { snapshotBeforeItemId: expected.oldestFetchedItemId } : 'prepend')
  if (page.openingRows?.length) items = uniqueRows(items, page.openingRows.filter(row => !isUnowned(row)), 'prepend')
  items = items.map(row => concurrent.get(savedRowId(row)) ?? row)
  const entitiesByKey = { ...history.entitiesByKey }
  const added = auxiliaryRows(entitiesByKey, unowned, [], history.generation)
  let withAuxiliary: SavedTranscript = { ...history, entitiesByKey }
  if (added.length) {
    const owner = history.islands.find(island => island.entries.some(entry => entry.value === turnKey(turnId)))
    if (owner) {
      for (const entry of added) entitiesByKey[entry.value].position = turn.position + 0.5
      withAuxiliary = { ...withAuxiliary, islands: history.islands.map(island => island !== owner ? island : { ...island,
        entries: [...island.entries, ...added].sort((left, right) => entitiesByKey[left.value].position - entitiesByKey[right.value].position),
      }) }
    }
  }
  return patchSavedTurn(withAuxiliary, turnId, current => ({ ...current, items, itemsPagination: {
    olderCursor: cursor, isLoadingOlder: false, hasLoadedOldest: cursor === null,
    ...(expected.evicted && cursor !== null ? { evicted: true } : {}),
    newestSnapshotItemId: expected.newestSnapshotItemId ?? newestSourceItem(bodyRows),
    oldestFetchedItemId: expected.reconnect ? expected.oldestFetchedItemId : savedRowId(page.rows[0]) || expected.oldestFetchedItemId,
    ...(cursor !== null && expected.reconnect && !reachedStop ? { reconnect: {
      ...expected.reconnect, beforeItemId: savedRowId(page.rows[0]) || expected.reconnect.beforeItemId,
    } } : {}),
  } }))
}
