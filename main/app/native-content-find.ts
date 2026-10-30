import type { WebContents, FindInPageOptions, Result } from 'electron';

export interface NativeFindOptions { forward?: boolean; findNext?: boolean; matchCase?: boolean }
export interface NativeFindResult { matches: number; active: number; selectedText?: string }
type FindTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'findInPage' | 'stopFindInPage' | 'executeJavaScript' | 'on' | 'removeListener'>;
interface Owner {
  target: FindTarget;
  revision: number;
  dispose(): void;
  pending?: { reject(error: Error): void; cleanup(): void };
}

/** A find session stays bound to one owner's page until it is explicitly closed. */
export class NativeContentFind {
  private readonly owners = new Map<number, Owner>();
  private readonly invalidated = new Set<number>();
  private closed = false;

  constructor(private readonly options: { target(ownerId: number): FindTarget | null; timeoutMs?: number; onClose?(ownerId: number): void }) {}

  async find(ownerId: number, query: string, options: NativeFindOptions = {}): Promise<NativeFindResult> {
    if (this.closed) throw new Error('CONTENT_FIND_CLOSED');
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || typeof query !== 'string' || query.length > 16384) throw new Error('CONTENT_FIND_INVALID_REQUEST');
    if (this.invalidated.has(ownerId)) {
      if (query) throw new Error('CONTENT_FIND_TARGET_CHANGED');
      this.invalidated.delete(ownerId);
    }
    const target = this.options.target(ownerId);
    let owner = this.owners.get(ownerId);
    if (owner && (owner.target !== target || owner.target.isDestroyed())) {
      this.release(ownerId, false);
      this.invalidated.add(ownerId);
      throw new Error('CONTENT_FIND_TARGET_CHANGED');
    }
    if (!target || target.isDestroyed()) throw new Error('CONTENT_FIND_TARGET_UNAVAILABLE');
    if (!owner) {
      const gone = (): void => { this.release(ownerId, false); this.invalidated.add(ownerId); this.options.onClose?.(ownerId); };
      const navigating = (details: { isMainFrame?: boolean; isSameDocument?: boolean }): void => { if (details.isMainFrame && !details.isSameDocument) gone(); };
      const escape = (event: { preventDefault(): void }, input: { type: string; key: string; isComposing?: boolean }): void => {
        if (input.type !== 'keyDown' || input.key !== 'Escape' || input.isComposing || this.options.target(ownerId) !== target) return;
        event.preventDefault(); this.stop(ownerId); this.options.onClose?.(ownerId);
      };
      target.on('destroyed', gone);
      target.on('did-start-navigation', navigating);
      target.on('before-input-event', escape);
      owner = { target, revision: 0, dispose: () => { target.removeListener('destroyed', gone); target.removeListener('did-start-navigation', navigating); target.removeListener('before-input-event', escape); } };
      this.owners.set(ownerId, owner);
    }
    this.cancel(owner, new Error('CONTENT_FIND_SUPERSEDED'));
    const revision = ++owner.revision;
    if (!query) {
      const selected: unknown = await target.executeJavaScript('String(window.getSelection?.()?.toString() || "").slice(0, 16384)');
      if (this.owners.get(ownerId) !== owner || this.options.target(ownerId) !== target || target.isDestroyed()) throw new Error('CONTENT_FIND_TARGET_CHANGED');
      if (owner.revision !== revision) throw new Error('CONTENT_FIND_SUPERSEDED');
      target.stopFindInPage('clearSelection');
      return { matches: 0, active: 0, selectedText: typeof selected === 'string' ? selected : '' };
    }
    const current = owner;
    return new Promise<NativeFindResult>((resolve, reject) => {
      let requestId: number | undefined;
      const cleanup = (): void => {
        clearTimeout(timer);
        target.removeListener('found-in-page', found);
        if (current.pending?.cleanup === cleanup) delete current.pending;
      };
      const found = (_event: unknown, result: Result): void => {
        if (result.requestId !== requestId || !result.finalUpdate) return;
        cleanup();
        if (this.owners.get(ownerId) !== current || this.options.target(ownerId) !== target || target.isDestroyed()) { reject(new Error('CONTENT_FIND_TARGET_CHANGED')); return; }
        if (current.revision !== revision) { reject(new Error('CONTENT_FIND_SUPERSEDED')); return; }
        resolve({ matches: result.matches, active: result.activeMatchOrdinal });
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('CONTENT_FIND_TIMEOUT')); }, this.options.timeoutMs ?? 5000);
      current.pending = { reject, cleanup };
      target.on('found-in-page', found);
      try {
        // The native flag starts a session; the renderer flag advances a match.
        const native: FindInPageOptions = { forward: options.forward !== false, findNext: options.findNext !== true, matchCase: options.matchCase === true };
        requestId = target.findInPage(query, native);
      } catch (error) { cleanup(); reject(error); }
    });
  }

  stop(ownerId: number): void { this.release(ownerId, true); this.invalidated.delete(ownerId); }
  closeOwner(ownerId: number): void { this.stop(ownerId); }
  close(): void { this.closed = true; for (const id of this.owners.keys()) this.release(id, true); this.invalidated.clear(); }

  private cancel(owner: Owner, error: Error): void {
    const pending = owner.pending;
    if (!pending) return;
    pending.cleanup(); pending.reject(error);
  }

  private release(ownerId: number, clear: boolean): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    this.owners.delete(ownerId);
    this.cancel(owner, new Error('CONTENT_FIND_TARGET_CHANGED'));
    owner.dispose();
    // A transferred page may now belong to another window. Never change it.
    if (clear && !owner.target.isDestroyed() && this.options.target(ownerId) === owner.target) owner.target.stopFindInPage('clearSelection');
  }
}
