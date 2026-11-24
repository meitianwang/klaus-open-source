interface ViewInterest { sessionId: string }

/** Renderer-owned tokens keep independent mounted views from retiring each other. */
export class SessionViewInterests {
  private readonly owners = new Map<number, Map<string, ViewInterest>>();
  private readonly counts = new Map<string, number>();

  constructor(private readonly changed: (sessionId: string) => void) {}

  retain(ownerId: number, sessionId: string, viewId: string): void {
    let views = this.owners.get(ownerId);
    const current = views?.get(viewId);
    if (current) {
      if (current.sessionId !== sessionId) throw new Error('A view token cannot change its conversation');
      return;
    }
    if ((views?.size ?? 0) >= 256) throw new Error('Too many mounted conversation views');
    if (!views) { views = new Map(); this.owners.set(ownerId, views); }
    views.set(viewId, { sessionId });
    this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + 1);
    this.changed(sessionId);
  }

  release(ownerId: number, sessionId: string, viewId: string): void {
    const views = this.owners.get(ownerId);
    if (views?.get(viewId)?.sessionId !== sessionId) return;
    views.delete(viewId);
    if (!views.size) this.owners.delete(ownerId);
    const remaining = (this.counts.get(sessionId) ?? 1) - 1;
    if (remaining) this.counts.set(sessionId, remaining); else this.counts.delete(sessionId);
    this.changed(sessionId);
  }

  releaseOwner(ownerId: number): void {
    const views = this.owners.get(ownerId);
    if (!views) return;
    for (const [viewId, { sessionId }] of views) this.release(ownerId, sessionId, viewId);
  }

  has(sessionId: string): boolean { return this.counts.has(sessionId); }
  ownersOf(sessionId: string): number[] {
    if (!this.counts.has(sessionId)) return [];
    const ids: number[] = [];
    for (const [ownerId, views] of this.owners) {
      for (const { sessionId: current } of views.values()) {
        if (current === sessionId) { ids.push(ownerId); break; }
      }
    }
    return ids;
  }
  clear(): void { this.owners.clear(); this.counts.clear(); }
}
