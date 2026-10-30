/** A bounded best-effort replay window; a flood cannot retain unbounded keys. */
export class RecentChannelMessages {
  private readonly entries = new Map<string, number>();
  constructor(private readonly capacity = 10_000, private readonly ttlMs = 60_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('Invalid channel deduplication limits');
  }
  has(key: string, now: number): boolean {
    const previous = this.entries.get(key);
    return previous !== undefined && now - previous < this.ttlMs;
  }
  add(key: string, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, now);
    if (this.entries.size > this.capacity) {
      for (const [entry, timestamp] of this.entries) if (now - timestamp >= this.ttlMs) this.entries.delete(entry);
      while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    }
  }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}
