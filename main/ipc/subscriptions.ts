interface Waiter { ownerId: number; channel: string; finish(error?: Error): void }

/** Wait for the particular consumer, not an unrelated invoke or a loaded document. */
export class RendererSubscriptions {
  private readonly active = new Map<number, Set<string>>();
  private readonly waiters = new Set<Waiter>();
  private closed = false;
  set(ownerId: number, channel: string, enabled: boolean): void {
    if (this.closed) return;
    const channels = this.active.get(ownerId) ?? new Set<string>();
    if (enabled) channels.add(channel); else channels.delete(channel);
    if (channels.size) this.active.set(ownerId, channels); else this.active.delete(ownerId);
    if (enabled) for (const waiter of this.waiters) {
      if (waiter.ownerId === ownerId && waiter.channel === channel) waiter.finish();
    }
  }
  wait(ownerId: number, channel: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<void> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Renderer subscription wait was cancelled'));
    if (this.active.get(ownerId)?.has(channel)) return Promise.resolve();
    if (this.waiters.size >= 128) return Promise.reject(new Error('Renderer subscription wait capacity exceeded'));
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => waiter.finish(new Error('Renderer subscription wait was cancelled'));
      const timer = setTimeout(() => waiter.finish(new Error('Renderer did not subscribe before the deadline')), timeoutMs);
      const waiter: Waiter = { ownerId, channel, finish: error => {
        if (!this.waiters.delete(waiter)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      } };
      this.waiters.add(waiter); signal?.addEventListener('abort', abort, { once: true });
    });
  }
  clearOwner(ownerId: number): void {
    this.active.delete(ownerId);
    for (const waiter of this.waiters) if (waiter.ownerId === ownerId) waiter.finish(new Error('Renderer changed before subscribing'));
  }
  close(): void {
    this.closed = true; this.active.clear();
    for (const waiter of this.waiters) waiter.finish(new Error('Renderer subscription service closed'));
  }
}
