/** Unread ledger for inbound friend messages.
 *
 *  Mirrors the turn-completion unread ledger in chat.ts but counts friend
 *  messages that arrived while their session was not open in a focused
 *  window. The sidebar row spec, the activity bell and the dock badge all
 *  read this ledger, so one arrival settles every attention surface at once.
 *  Each entry also remembers whether the newest arrival awaits a reply, so
 *  the row can park a static pill beside the unread badge.
 */
export const FRIEND_UNREAD_STORAGE_KEY = 'klaus_sidebar_friend_unread'

interface Entry {
  c: number
  w: boolean
}

export interface FriendUnreadLedger {
  add(sessionId: string, count?: number, wantReply?: boolean): number
  countOf(sessionId: string): number
  wantReplyOf(sessionId: string): boolean
  total(): number
  clearSession(sessionId: string): boolean
  clearAll(): void
}

function normalizeEntry(value: unknown): Entry | null {
  // A legacy numeric shape (count only) stays readable as plain unread.
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? { c: Math.min(99, Math.floor(value)), w: false } : null
  }
  if (value && typeof value === 'object') {
    const entry = value as Record<string, unknown>
    const count = Number(entry.c)
    if (Number.isFinite(count) && count > 0) return { c: Math.min(99, Math.floor(count)), w: entry.w === true }
  }
  return null
}

export function createFriendUnreadLedger(load: () => string | null, save: (value: string) => void): FriendUnreadLedger {
  let counts: Record<string, Entry> = {}
  try {
    const parsed = JSON.parse(load() || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = normalizeEntry(value)
        if (key && entry) counts[key] = entry
      }
    }
  } catch {
    counts = {}
  }
  const persist = () => {
    try { save(JSON.stringify(counts)) } catch { /* storage is best-effort */ }
  }
  return {
    add(sessionId: string, count = 1, wantReply = false) {
      if (!sessionId || count <= 0) return counts[sessionId]?.c || 0
      const entry = counts[sessionId] || { c: 0, w: false }
      entry.c = Math.min(99, entry.c + count)
      entry.w = wantReply
      counts[sessionId] = entry
      persist()
      return entry.c
    },
    countOf(sessionId: string) {
      return (sessionId && counts[sessionId]?.c) || 0
    },
    wantReplyOf(sessionId: string) {
      return !!sessionId && !!counts[sessionId]?.w
    },
    total() {
      return Object.values(counts).reduce((sum, entry) => sum + entry.c, 0)
    },
    clearSession(sessionId: string) {
      if (!sessionId || !(sessionId in counts)) return false
      delete counts[sessionId]
      persist()
      return true
    },
    clearAll() {
      counts = {}
      persist()
    },
  }
}

let shared: FriendUnreadLedger | null = null

/** The renderer-wide ledger. chat.ts writes it on arrival and clears it when a
 *  session opens; approvals.ts folds its total into the dock badge. */
export function sharedFriendUnread(): FriendUnreadLedger {
  if (!shared) {
    shared = createFriendUnreadLedger(
      () => (typeof localStorage === 'undefined' ? null : localStorage.getItem(FRIEND_UNREAD_STORAGE_KEY)),
      value => { if (typeof localStorage !== 'undefined') localStorage.setItem(FRIEND_UNREAD_STORAGE_KEY, value) },
    )
  }
  return shared
}
