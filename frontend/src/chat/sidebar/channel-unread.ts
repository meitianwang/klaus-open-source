/** Unread message ledger for external IM channel conversations.
 *
 *  Counts inbound channel messages (and background assistant completions when
 *  no inbound arrival was counted yet in the same turn) while a channel
 *  session is not open in the visible chat view. Cleared when the session is
 *  opened, deleted, or marked read remotely.
 */
export const CHANNEL_UNREAD_STORAGE_KEY = 'klaus_sidebar_channel_unread'

const MAX_STORED_CHANNEL_UNREAD = 999
const SEEN_FRAME_RING_LIMIT = 512

export interface InboundChannelFrameEvent {
  type?: string
  sessionId?: string
  message?: {
    uuid?: unknown
    clientMessageId?: unknown
    isMeta?: unknown
    localRender?: unknown
    message?: {
      steered?: unknown
      questionAnswer?: unknown
      localRender?: unknown
    }
  }
}

export interface ChannelUnreadLedger {
  add(sessionId: string, count?: number): number
  noteInboundFrame(
    event: InboundChannelFrameEvent,
    options: { knownChannel: boolean | null; baselineUnread?: boolean },
  ): boolean
  noteTurnCompleted(sessionId: string, options: { knownChannel: boolean | null }): boolean
  noteTurnAborted(sessionId: string): void
  reconcileKnownSessions(classify: (sessionId: string) => boolean | null): boolean
  countOf(sessionId: string): number
  clearSession(sessionId: string): boolean
  clearAll(): void
}

function clampUnreadCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_STORED_CHANNEL_UNREAD, Math.floor(value))
}

export function extractInboundHostTurnFrame(
  event: InboundChannelFrameEvent | null | undefined,
): { sessionId: string; frameId: string } | null {
  if (!event || event.type !== 'user_message') return null
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : ''
  if (!sessionId) return null
  const outer = event.message
  if (!outer || outer.isMeta === true || outer.clientMessageId) return null
  const inner = outer.message
  if (inner?.steered === true || inner?.questionAnswer) return null
  const rawRender = inner?.localRender ?? outer.localRender
  if (!rawRender || typeof rawRender !== 'object' || Array.isArray(rawRender)) return null
  const localRender = rawRender as Record<string, unknown>
  if (localRender.inputPresentation !== 'turn') return null
  if (localRender.clientMessageId || localRender.externalFriendMessage === true) return null
  const frameId = typeof outer.uuid === 'string' ? outer.uuid : ''
  return { sessionId, frameId }
}

export function createChannelUnreadLedger(
  load: () => string | null,
  save: (value: string) => void,
): ChannelUnreadLedger {
  let counts: Record<string, number> = {}
  const provisionalCounts = new Map<string, number>()
  const countedActiveTurns = new Set<string>()
  const seenFrames = new Set<string>()

  try {
    const parsed = JSON.parse(load() || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalized = clampUnreadCount(Number(value))
        if (key && normalized > 0) counts[key] = normalized
      }
    }
  } catch {
    counts = {}
  }

  const persist = () => {
    try { save(JSON.stringify(counts)) } catch { /* storage is best-effort */ }
  }

  const add = (sessionId: string, count = 1): number => {
    if (!sessionId || count <= 0) return counts[sessionId] || 0
    const next = clampUnreadCount((counts[sessionId] || 0) + count)
    if (next <= 0) return 0
    counts[sessionId] = next
    persist()
    return next
  }

  return {
    add,
    noteInboundFrame(event, { knownChannel, baselineUnread = false }) {
      const frame = extractInboundHostTurnFrame(event)
      if (!frame || knownChannel === false) return false
      if (frame.frameId) {
        const dedupKey = JSON.stringify([frame.sessionId, frame.frameId])
        if (seenFrames.has(dedupKey)) return false
        seenFrames.add(dedupKey)
        while (seenFrames.size > SEEN_FRAME_RING_LIMIT) {
          seenFrames.delete(seenFrames.values().next().value!)
        }
      }
      countedActiveTurns.add(frame.sessionId)
      if (knownChannel === true) {
        const seed = !counts[frame.sessionId] && baselineUnread ? 1 : 0
        add(frame.sessionId, seed + 1)
        return true
      }
      const current = provisionalCounts.get(frame.sessionId) ?? (baselineUnread ? 1 : 0)
      provisionalCounts.set(frame.sessionId, clampUnreadCount(current + 1))
      return true
    },
    noteTurnCompleted(sessionId, { knownChannel }) {
      if (!sessionId) return false
      if (countedActiveTurns.delete(sessionId)) return false
      if (knownChannel === false) return false
      if (knownChannel === true) {
        add(sessionId, 1)
        return true
      }
      provisionalCounts.set(sessionId, clampUnreadCount((provisionalCounts.get(sessionId) || 0) + 1))
      return true
    },
    noteTurnAborted(sessionId) {
      if (sessionId) countedActiveTurns.delete(sessionId)
    },
    reconcileKnownSessions(classify) {
      let changed = false
      for (const [sessionId, pending] of [...provisionalCounts.entries()]) {
        const verdict = classify(sessionId)
        if (verdict === true) {
          provisionalCounts.delete(sessionId)
          add(sessionId, pending)
          changed = true
        } else if (verdict === false) {
          provisionalCounts.delete(sessionId)
          countedActiveTurns.delete(sessionId)
        }
      }
      return changed
    },
    countOf(sessionId) {
      if (!sessionId) return 0
      return clampUnreadCount((counts[sessionId] || 0) + (provisionalCounts.get(sessionId) || 0))
    },
    clearSession(sessionId) {
      if (!sessionId) return false
      countedActiveTurns.delete(sessionId)
      const hadProvisional = provisionalCounts.delete(sessionId)
      const hadStored = sessionId in counts
      if (hadStored) {
        delete counts[sessionId]
        persist()
      }
      return hadStored || hadProvisional
    },
    clearAll() {
      counts = {}
      provisionalCounts.clear()
      countedActiveTurns.clear()
      persist()
    },
  }
}

let shared: ChannelUnreadLedger | null = null

export function sharedChannelUnread(): ChannelUnreadLedger {
  if (!shared) {
    shared = createChannelUnreadLedger(
      () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(CHANNEL_UNREAD_STORAGE_KEY)),
      value => { if (typeof localStorage !== 'undefined') localStorage.setItem(CHANNEL_UNREAD_STORAGE_KEY, value) },
    )
  }
  return shared
}
