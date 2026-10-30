export type HistoryEdge = 'older' | 'newer'

export type HistoryBoundary<Handle> =
  | { status: 'available'; boundaryId?: string; progressKey: string; handle: Handle }
  | { status: 'exhausted' | 'unknown'; boundaryId?: string }

export interface HistoryEntry<Value> { key: string; value: Value }
export interface HistorySegment<Value, Handle> {
  entries: HistoryEntry<Value>[]
  olderBoundary: HistoryBoundary<Handle>
  newerBoundary: HistoryBoundary<Handle>
}
export interface HistoryIsland<Value, Handle> extends HistorySegment<Value, Handle> { id: string }
export interface HistoryTopology<Value, Handle> {
  generation: number
  isComplete: boolean
  islands: HistoryIsland<Value, Handle>[]
}
export interface HistoryBoundaryRequest<Handle> {
  generation: number
  islandId: string
  edge: HistoryEdge
  boundaryId: string
  progressKey: string
  handle: Handle
}
export interface HistoryPolicy<Value> {
  identity(value: Value): string | null
  position(entry: HistoryEntry<Value>): number
  merge(previous: Value, incoming: Value): Value
}

const compare = (left: number, right: number) => left < right ? -1 : Number(left > right)

function mergeEntries<Value>(previous: HistoryEntry<Value>[], incoming: HistoryEntry<Value>[], policy: HistoryPolicy<Value>): HistoryEntry<Value>[] {
  const entries: HistoryEntry<Value>[] = []
  const positions = new Map<string, number>()
  for (const entry of [...previous, ...incoming]) {
    const identity = policy.identity(entry.value)
    const index = identity === null ? undefined : positions.get(identity)
    if (index === undefined) {
      if (identity !== null) positions.set(identity, entries.length)
      entries.push(entry)
    } else {
      const existing = entries[index]
      entries[index] = { ...existing, value: policy.merge(existing.value, entry.value) }
    }
  }
  return entries.sort((left, right) => compare(policy.position(left), policy.position(right)))
}

function range<Value, Handle>(island: HistoryIsland<Value, Handle>, policy: HistoryPolicy<Value>): { first: number; last: number } | null {
  if (!island.entries.length) return null
  const positions = island.entries.map(entry => policy.position(entry))
  return { first: Math.min(...positions), last: Math.max(...positions) }
}

function validate<Value, Handle>(islands: HistoryIsland<Value, Handle>[]): void {
  const identities = new Set<string>()
  const boundaries = new Set<string>()
  for (const island of islands) {
    if (identities.has(island.id)) throw new Error(`Duplicate history island ID: ${island.id}`)
    identities.add(island.id)
    for (const boundary of [island.olderBoundary, island.newerBoundary]) {
      if (!boundary.boundaryId) continue
      if (boundaries.has(boundary.boundaryId)) throw new Error(`Duplicate history boundary ID: ${boundary.boundaryId}`)
      boundaries.add(boundary.boundaryId)
    }
  }
}

function place<Value, Handle>(islands: HistoryIsland<Value, Handle>[], incoming: HistoryIsland<Value, Handle>, policy: HistoryPolicy<Value>, replacing?: HistoryIsland<Value, Handle>): HistoryIsland<Value, Handle>[] {
  const incomingRange = range(incoming, policy)
  if (!incomingRange && islands.some(island => island !== replacing)) throw new Error('Cannot place an empty history island')
  const overlaps = incomingRange ? islands.filter(island => {
    if (island === replacing) return false
    const existing = range(island, policy)
    return existing !== null && existing.first <= incomingRange.last && incomingRange.first <= existing.last
  }) : []
  const removed = new Set(overlaps)
  if (replacing) removed.add(replacing)
  let merged = incoming
  if (overlaps.length) {
    const candidates = [...overlaps, incoming]
    const oldest = candidates.reduce((left, right) => (range(left, policy)?.first ?? 0) <= (range(right, policy)?.first ?? 0) ? left : right)
    const newest = candidates.reduce((left, right) => (range(left, policy)?.last ?? 0) >= (range(right, policy)?.last ?? 0) ? left : right)
    merged = {
      id: newest.id,
      entries: mergeEntries(overlaps.flatMap(island => island.entries), incoming.entries, policy),
      olderBoundary: oldest.olderBoundary,
      newerBoundary: newest.newerBoundary,
    }
  }
  const result = [...islands.filter(island => !removed.has(island)), merged]
    .sort((left, right) => compare(range(left, policy)?.first ?? 0, range(right, policy)?.first ?? 0))
  validate(result)
  return result
}

function withIslands<Value, Handle>(history: HistoryTopology<Value, Handle>, islands: HistoryIsland<Value, Handle>[]): HistoryTopology<Value, Handle> {
  const only = islands.length === 1 ? islands[0] : null
  return { ...history, islands, isComplete: only?.olderBoundary.status === 'exhausted' && only.newerBoundary.status === 'exhausted' }
}

export function insertHistorySegment<Value, Handle>(history: HistoryTopology<Value, Handle>, id: string, segment: HistorySegment<Value, Handle>, policy: HistoryPolicy<Value>): HistoryTopology<Value, Handle> {
  if (history.islands.some(island => island.id === id)) throw new Error(`Duplicate history island ID: ${id}`)
  const island = {
    id,
    entries: mergeEntries([], segment.entries, policy),
    olderBoundary: { ...segment.olderBoundary, boundaryId: segment.olderBoundary.boundaryId ?? `${id}:older` },
    newerBoundary: { ...segment.newerBoundary, boundaryId: segment.newerBoundary.boundaryId ?? `${id}:newer` },
  }
  return withIslands(history, place(history.islands, island, policy))
}

function matches<Value, Handle>(island: HistoryIsland<Value, Handle>, request: HistoryBoundaryRequest<Handle>): boolean {
  const boundary = request.edge === 'older' ? island.olderBoundary : island.newerBoundary
  return boundary.status === 'available' && boundary.boundaryId === request.boundaryId && boundary.progressKey === request.progressKey
}

export function ownsHistoryBoundary<Value, Handle>(history: HistoryTopology<Value, Handle>, request: HistoryBoundaryRequest<Handle>, sameHandle: (left: Handle, right: Handle) => boolean): boolean {
  const island = history.islands.find(island => island.id === request.islandId)
  const boundary = request.edge === 'older' ? island?.olderBoundary : island?.newerBoundary
  return history.generation === request.generation && boundary?.status === 'available'
    && boundary.boundaryId === request.boundaryId && boundary.progressKey === request.progressKey
    && sameHandle(boundary.handle, request.handle)
}

export function extendHistoryBoundary<Value, Handle>(history: HistoryTopology<Value, Handle>, request: HistoryBoundaryRequest<Handle>, segment: HistorySegment<Value, Handle>, policy: HistoryPolicy<Value>): { status: 'stale' | 'rejected' | 'applied'; history: HistoryTopology<Value, Handle> } {
  if (request.generation !== history.generation) return { status: 'stale', history }
  const exact = history.islands.find(island => island.id === request.islandId)
  const candidates = exact ? matches(exact, request) ? [exact] : [] : history.islands.filter(island => matches(island, request))
  if (candidates.length !== 1) return { status: 'rejected', history }
  const island = candidates[0]
  const next = request.edge === 'older' ? segment.olderBoundary : segment.newerBoundary
  if (next.status === 'available' && next.progressKey === request.progressKey) return { status: 'rejected', history }
  const updated = { ...next, boundaryId: request.boundaryId }
  return {
    status: 'applied',
    history: withIslands(history, place(history.islands, {
      id: island.id,
      entries: mergeEntries(island.entries, segment.entries, policy),
      olderBoundary: request.edge === 'older' ? updated : island.olderBoundary,
      newerBoundary: request.edge === 'newer' ? updated : island.newerBoundary,
    }, policy, island)),
  }
}

export function nextHistoryBoundary<Value, Handle>(history: HistoryTopology<Value, Handle>, complete = false): HistoryBoundaryRequest<Handle> | null {
  const islands = complete ? history.islands : history.islands.slice(0, 1)
  for (const island of islands) {
    for (const edge of (complete ? ['older', 'newer'] : ['older']) as HistoryEdge[]) {
      const boundary = edge === 'older' ? island.olderBoundary : island.newerBoundary
      if (boundary.status === 'available' && boundary.boundaryId) return { ...boundary, boundaryId: boundary.boundaryId, edge, generation: history.generation, islandId: island.id }
    }
  }
  return null
}
