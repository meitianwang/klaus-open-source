// Local turn windows include their items in one read. Oversized windows keep
// a bounded summary fallback, with each turn retaining its own detail cursor.
import type { TurnItemsPage, TurnItemsPagination } from './saved-transcript'

export const FIRST_PAGE_TURN_LIMIT = 5
export const OLDER_PAGE_TURN_LIMIT = 5
export const ITEM_PAGE_LIMIT = 100

export interface TranscriptPageEnvelope {
  nextCursor?: string | null
  backwardsCursor?: string | null
  hasMore?: boolean
  limit?: number
  order?: string
}

export interface TranscriptTurnShell {
  id: string
  ordinal?: number
  status?: string
  startedAtMs?: number
  finishedAtMs?: number
  durationMs?: number
  error?: string
  errorKind?: string
  cancelledTools?: string[]
  finalMessageId?: string
  firstUserItemId?: string
  finalAgentItemId?: string
  itemsView?: 'summary' | 'full' | 'notLoaded'
  updatedAtOrdinal?: number
}

export interface TranscriptPaginationState {
  /** Cursor for the next older turn page; null once the oldest page landed. */
  olderCursor: string | null
  oldestLoadedTurnId: string | null
  isLoadingOlder: boolean
  hasLoadedOldest: boolean
}

export interface TranscriptPageReply {
  messages?: unknown[]
  turns?: unknown[]
  page?: TranscriptPageEnvelope | null
  [key: string]: unknown
}

export interface PaginationApi {
  session: {
    historyPage: (sessionId: string, opts?: {
      cursor?: string | null
      limit?: number
      itemsView?: string
      sortDirection?: string
    }) => Promise<TranscriptPageReply>
    historyItems: (sessionId: string, opts: {
      turnId: string
      cursor?: string | null
      beforeItemId?: string
      limit?: number
      sortDirection?: string
    }) => Promise<TranscriptPageReply>
  }
}

const OVERSIZED_ITEM_ERROR = 'decoded message length too large'

function envelope(reply: TranscriptPageReply): TranscriptPageEnvelope {
  return reply.page && typeof reply.page === 'object' ? reply.page : {}
}

function shells(reply: TranscriptPageReply): TranscriptTurnShell[] {
  return Array.isArray(reply.turns)
    ? reply.turns.filter((turn): turn is TranscriptTurnShell => !!turn && typeof turn === 'object' && typeof (turn as TranscriptTurnShell).id === 'string')
    : []
}

function rows(reply: TranscriptPageReply): unknown[] {
  return Array.isArray(reply.messages) ? reply.messages : []
}

function paginationFrom(reply: TranscriptPageReply, fallbackOldest: string | null): TranscriptPaginationState {
  const page = envelope(reply)
  const turnShells = shells(reply)
  const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : null
  return {
    olderCursor: page.hasMore === true ? next : null,
    oldestLoadedTurnId: turnShells[0]?.id ?? fallbackOldest,
    isLoadingOlder: false,
    hasLoadedOldest: page.hasMore !== true || next === null,
  }
}

export interface TurnItemsResult {
  rows: unknown[]
  reply: TranscriptPageReply
}

/**
 * One turn's messages, oldest-first, under a shared item budget.
 *
 * Pages walk the turn from its newest message backwards; a page whose decode
 * the engine refuses as oversized is retried at half the limit, down to a
 * single message, before the turn's fill gives up with the error.
 */
export async function fetchTurnItems(
  api: PaginationApi,
  sessionId: string,
  turnId: string,
  budget: number,
): Promise<TurnItemsResult> {
  const collected: unknown[] = []
  let cursor: string | null = null
  let lastReply: TranscriptPageReply = {}
  let limit = Math.min(ITEM_PAGE_LIMIT, budget)
  for (;;) {
    const remaining = budget - collected.length
    if (remaining <= 0 || limit < 1) break
    let reply: TranscriptPageReply
    try {
      reply = await api.session.historyItems(sessionId, {
        turnId,
        ...(cursor ? { cursor } : {}),
        limit: Math.min(limit, remaining),
        sortDirection: 'desc',
      })
    } catch (error) {
      if (limit <= 1 || !String((error as { message?: unknown })?.message ?? '').includes(OVERSIZED_ITEM_ERROR)) throw error
      limit = Math.floor(limit / 2)
      continue
    }
    // Each page is chronological, but the cursor walks to earlier pages.
    // Prepend the page so the prompt stays before the response across pages.
    collected.unshift(...rows(reply))
    lastReply = reply
    const page = envelope(reply)
    const next = typeof page.nextCursor === 'string' && page.nextCursor.length > 0 ? page.nextCursor : null
    if (page.hasMore !== true || next === null) break
    if (next === cursor) throw new Error('thread items page returned an unchanged cursor')
    cursor = next
  }
  return { rows: collected, reply: lastReply }
}

export interface FirstPaintResult {
  /** Loaded rows, oldest-first, covering the first paint's turn window. */
  rows: unknown[]
  /** The raw first page reply: turn metadata maps and notifications ride it. */
  reply: TranscriptPageReply
  shells: TranscriptTurnShell[]
  pagination: TranscriptPaginationState
}

/** Read a small complete turn window, reducing only a rejected oversized payload. */
async function readTurnWindow(api: PaginationApi, sessionId: string, cursor: string | null, requestedLimit: number): Promise<TranscriptPageReply> {
  let limit = requestedLimit
  for (;;) {
    try {
      return await api.session.historyPage(sessionId, {
        ...(cursor ? { cursor } : {}), limit, itemsView: 'full', sortDirection: 'desc',
      })
    } catch (error) {
      if (!String((error as { message?: unknown })?.message ?? '').includes(OVERSIZED_ITEM_ERROR)) throw error
      if (limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue }
      // A single large turn is still readable through bounded item pages.
      return api.session.historyPage(sessionId, {
        ...(cursor ? { cursor } : {}), limit: 1, itemsView: 'summary', sortDirection: 'desc',
      })
    }
  }
}

/** Publish the newest local turn window without a separate item-read waterfall. */
export async function loadFirstPaint(api: PaginationApi, sessionId: string): Promise<FirstPaintResult> {
  const reply = await readTurnWindow(api, sessionId, null, FIRST_PAGE_TURN_LIMIT)
  const turnShells = shells(reply)
  return {
    rows: rows(reply),
    reply,
    shells: turnShells,
    pagination: paginationFrom(reply, null),
  }
}

export interface OlderPageResult {
  /** Rows older than everything loaded so far, oldest-first. */
  rows: unknown[]
  reply: TranscriptPageReply
  shells: TranscriptTurnShell[]
  pagination: TranscriptPaginationState
}

/**
 * The next older local turn window. Resolves null when the loaded
 * window already reaches the oldest turn, or while an older load is in flight.
 */
export async function loadOlderTurnsPage(
  api: PaginationApi,
  sessionId: string,
  current: TranscriptPaginationState,
): Promise<OlderPageResult | null> {
  if (current.hasLoadedOldest || current.isLoadingOlder || current.olderCursor === null) return null
  const reply = await readTurnWindow(api, sessionId, current.olderCursor, OLDER_PAGE_TURN_LIMIT)
  const turnShells = shells(reply)
  return {
    rows: rows(reply),
    reply,
    shells: turnShells,
    pagination: paginationFrom(reply, current.oldestLoadedTurnId),
  }
}

/** One page is committed before another page can be requested. */
export async function fetchTurnItemsPage(
  api: PaginationApi,
  sessionId: string,
  turnId: string,
  pagination: TurnItemsPagination,
): Promise<TurnItemsPage> {
  const read = async (cursor: string | null, requested: number, direction: 'asc' | 'desc', beforeItemId?: string) => {
    let limit = requested
    for (;;) {
      try {
        return await api.session.historyItems(sessionId, {
          turnId, ...(cursor ? { cursor } : beforeItemId ? { beforeItemId } : {}), limit, sortDirection: direction,
        })
      } catch (error) {
        if (limit <= 1 || !String((error as { message?: unknown })?.message ?? '').includes(OVERSIZED_ITEM_ERROR)) throw error
        limit = Math.floor(limit / 2)
      }
    }
  }
  const reply = await read(pagination.olderCursor, pagination.summaryItemIds ? ITEM_PAGE_LIMIT - 2 : ITEM_PAGE_LIMIT, 'desc', pagination.olderItemId)
  const page = envelope(reply)
  const next = page.hasMore === true && typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null
  if (next && next === pagination.olderCursor) throw new Error('thread items page returned an unchanged cursor')
  const opening = pagination.summaryItemIds && next !== null ? await read(null, 2, 'asc') : null
  return { rows: rows(reply), reply, nextCursor: next, ...(opening ? { openingRows: rows(opening) } : {}) }
}
