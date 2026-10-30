interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** A replayed display message must not become unread again after it was viewed. */
export function friendMessageUnreadTracker(storage: StorageLike, key: string, limit = 2048) {
  let saved: unknown
  try { saved = JSON.parse(storage.getItem(key) || '[]') } catch { saved = [] }
  const consumed = new Set<string>(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string').slice(-limit) : [])
  return {
    accept(event: { sessionId?: string; message?: any }): boolean {
      const row = event.message
      const metadata = row?.message?.localRender || row?.localRender
      const id = row?.uuid || metadata?.messageId || metadata?.requestId
      if (!event.sessionId || typeof id !== 'string' || !id || metadata?.externalFriendMessage !== true || metadata.friendOutgoingMessage === true) return false
      const identity = JSON.stringify([event.sessionId, id])
      if (consumed.has(identity)) return false
      consumed.add(identity)
      while (consumed.size > limit) consumed.delete(consumed.values().next().value!)
      try { storage.setItem(key, JSON.stringify([...consumed])) } catch { /* The live guard remains valid if local storage is full. */ }
      return true
    },
  }
}
