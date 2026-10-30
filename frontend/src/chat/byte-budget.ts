/** Conservative UTF-16 accounting for retained source and parsed data. */
export function retainedBytes(value: unknown): number {
  const seen = new Set<object>()
  const visit = (item: unknown): number => {
    if (typeof item === 'string') return item.length * 2
    if (item == null) return 0
    if (typeof item !== 'object') return 8
    if (seen.has(item)) return 0
    seen.add(item)
    if (Array.isArray(item)) return 24 + item.reduce((sum, value) => sum + 8 + visit(value), 0)
    return 32 + Object.entries(item).reduce((sum, [key, value]) => sum + key.length * 2 + 8 + visit(value), 0)
  }
  return visit(value)
}

/** Protected entries may exceed the budget; callers decide what is safe to release. */
export class ByteBudgetLru<K, V> {
  private entries = new Map<K, { value: V; bytes: number }>()
  bytes = 0
  constructor(readonly maxBytes: number, readonly maxEntries = Number.POSITIVE_INFINITY) {}
  get size() { return this.entries.size }
  has(key: K) { return this.entries.has(key) }
  get(key: K): V | undefined {
    const row = this.entries.get(key)
    if (!row) return undefined
    this.entries.delete(key)
    this.entries.set(key, row)
    return row.value
  }
  set(key: K, value: V, bytes: number) {
    this.delete(key)
    const row = { value, bytes: Math.max(0, bytes) }
    this.entries.set(key, row)
    this.bytes += row.bytes
  }
  delete(key: K) {
    const row = this.entries.get(key)
    if (!row) return
    this.entries.delete(key)
    this.bytes -= row.bytes
  }
  clear() { this.entries.clear(); this.bytes = 0 }
  deleteWhere(predicate: (key: K, value: V) => boolean) {
    for (const [key, row] of this.entries) if (predicate(key, row.value)) this.delete(key)
  }
  trim(protectedEntry: (key: K, value: V) => boolean = () => false): Array<[K, V]> {
    const evicted: Array<[K, V]> = []
    if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) return evicted
    // The count limit applies to idle records; active records are additional.
    let protectedCount = 0
    for (const [key, row] of this.entries) if (protectedEntry(key, row.value)) protectedCount++
    for (const [key, row] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size - protectedCount <= this.maxEntries) break
      if (protectedEntry(key, row.value)) continue
      this.delete(key)
      evicted.push([key, row.value])
    }
    return evicted
  }
}
