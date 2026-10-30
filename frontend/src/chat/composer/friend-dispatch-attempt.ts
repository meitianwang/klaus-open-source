export interface FriendDispatchAttempt { key: string; id: string }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** A lost acknowledgement must reuse the same immutable delivery identity after reload. */
export function friendDispatchAttempts(storage: StorageLike, scope: string) {
  const storageKey = 'klaus_friend_dispatch_attempts:' + scope
  const load = (): FriendDispatchAttempt[] => {
    try {
      const rows: unknown = JSON.parse(storage.getItem(storageKey) || '[]')
      return Array.isArray(rows) ? rows.filter((row): row is FriendDispatchAttempt => !!row && typeof row.key === 'string' && typeof row.id === 'string') : []
    } catch { return [] }
  }
  return {
    acquire(key: string): FriendDispatchAttempt {
      const rows = load()
      const existing = rows.find(row => row.key === key)
      if (existing) return existing
      const attempt = { key, id: crypto.randomUUID() }
      storage.setItem(storageKey, JSON.stringify([...rows, attempt]))
      return attempt
    },
    accepted(attempt: FriendDispatchAttempt): void {
      const rows = load().filter(row => row.key !== attempt.key || row.id !== attempt.id)
      if (rows.length) storage.setItem(storageKey, JSON.stringify(rows))
      else storage.removeItem(storageKey)
    },
  }
}
