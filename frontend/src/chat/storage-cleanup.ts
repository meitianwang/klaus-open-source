export interface StorageChangeTarget {
  currentId(): string | null | undefined
  leaveCurrent(): void
  remove(ids: ReadonlySet<string>): void
  forget(id: string): void
  refresh(): void
}

/** Only confirmed changes retire local state; skipped chats retain drafts and selection. */
export function applyStorageChange(value: unknown, target: StorageChangeTarget): void {
  if (!Array.isArray(value)) return
  const ids = new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))
  if (!ids.size) return
  const current = target.currentId()
  if (current && ids.has(current)) target.leaveCurrent()
  target.remove(ids)
  for (const id of ids) target.forget(id)
  target.refresh()
}
