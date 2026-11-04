import type { WebContents, FindInPageOptions, Result } from 'electron';

export interface NativeFindOptions { forward?: boolean; findNext?: boolean; matchCase?: boolean }
export interface NativeFindMatch { matches: number; active: number }
export interface NativeFindResult extends NativeFindMatch { selectedText?: string }

export interface NativeFindInput { type: string; key: string; isComposing?: boolean }

/**
 * The narrow surface a {@link NativeContentFind} session needs from a page.
 * A native browser page can implement this directly; an Electron WebContents
 * is adapted by {@link ElectronFindPage}. Nothing here pretends to be a
 * WebContents.
 */
export interface NativeFindPage {
  /** Stable page identity; defaults to the adapter object itself. */
  readonly identity?: object;
  isDestroyed(): boolean;
  /** Execute a find against the page's own find helper. */
  find(query: string, options: Required<NativeFindOptions>, signal?: AbortSignal): Promise<NativeFindMatch>;
  /** End the current find session; clear selection only when requested. */
  stopFind(clear: boolean): void;
  /** Return the currently selected text, if any. */
  readSelection(): Promise<string>;
  onDestroyed(listener: () => void): () => void;
  onDidNavigate(listener: () => void): () => void;
  /** Optional: Electron pages can wire Escape to close the find session. */
  onEscape?(listener: (event: { preventDefault(): void }) => void): () => void;
}

export type NativeFindTarget = NativeFindPage | WebContents;

export const NATIVE_CONTENT_FIND_SELECTION = 'String(window.getSelection?.()?.toString() || "").slice(0, 16384)';

interface Owner {
  target: NativeFindPage;
  revision: number;
  dispose: () => void;
  pending?: { reject(error: Error): void };
}

function targetIdentity(page: NativeFindPage): object {
  return page.identity ?? page;
}

function isNativeFindPage(value: NativeFindTarget): value is NativeFindPage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NativeFindPage).readSelection === 'function' &&
    typeof (value as NativeFindPage).find === 'function' &&
    typeof (value as NativeFindPage).onDestroyed === 'function'
  );
}

/**
 * Legacy adapter for a plain Electron {@link WebContents}. Only this adapter
 * may use findInPage, stopFindInPage and executeJavaScript; native pages are
 * never wrapped in a fake WebContents.
 */
export class ElectronFindPage implements NativeFindPage {
  readonly identity: WebContents;

  constructor(private readonly contents: WebContents) {
    this.identity = contents;
  }

  isDestroyed(): boolean {
    return this.contents.isDestroyed();
  }

  find(query: string, options: Required<NativeFindOptions>, signal?: AbortSignal): Promise<NativeFindMatch> {
    return new Promise<NativeFindMatch>((resolve, reject) => {
      let requestId: number | undefined;
      let finished = false;

      const finish = (error?: Error, result?: NativeFindMatch): void => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        this.contents.removeListener('found-in-page', onFound);
        if (error) reject(error);
        else resolve(result!);
      };

      const onAbort = (): void =>
        finish(signal?.reason instanceof Error ? signal.reason : new Error('CONTENT_FIND_ABORTED'));

      const onFound = (_event: unknown, result: Result): void => {
        if (result.requestId !== requestId || !result.finalUpdate) return;
        finish(undefined, { matches: result.matches, active: result.activeMatchOrdinal });
      };

      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('CONTENT_FIND_ABORTED'));
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });
      this.contents.on('found-in-page', onFound);

      try {
        // The renderer option is inverted relative to the front-end intent:
        // findNext=true means "advance the existing session", which starts a
        // new renderer find session when false.
        const native: FindInPageOptions = {
          forward: options.forward,
          findNext: !options.findNext,
          matchCase: options.matchCase,
        };
        requestId = this.contents.findInPage(query, native);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  stopFind(clear: boolean): void {
    this.contents.stopFindInPage(clear ? 'clearSelection' : 'keepSelection');
  }

  async readSelection(): Promise<string> {
    const selected: unknown = await this.contents.executeJavaScript(NATIVE_CONTENT_FIND_SELECTION);
    return typeof selected === 'string' ? selected : '';
  }

  onDestroyed(listener: () => void): () => void {
    this.contents.on('destroyed', listener);
    return () => { this.contents.removeListener('destroyed', listener); };
  }

  onDidNavigate(listener: () => void): () => void {
    const nav = (details: { isMainFrame?: boolean; isSameDocument?: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) listener();
    };
    this.contents.on('did-start-navigation', nav);
    return () => { this.contents.removeListener('did-start-navigation', nav); };
  }

  onEscape(listener: (event: { preventDefault(): void }) => void): () => void {
    const escape = (event: { preventDefault(): void }, input: NativeFindInput): void => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || input.isComposing) return;
      listener(event);
    };
    this.contents.on('before-input-event', escape);
    return () => { this.contents.removeListener('before-input-event', escape); };
  }
}

/** A find session stays bound to one owner's page until it is explicitly closed. */
export class NativeContentFind {
  private readonly owners = new Map<number, Owner>();
  private readonly invalidated = new Set<number>();
  private readonly electronPages = new WeakMap<WebContents, ElectronFindPage>();
  private closed = false;

  constructor(private readonly options: {
    target(ownerId: number): NativeFindTarget | null;
    timeoutMs?: number;
    onClose?(ownerId: number): void;
  }) {}

  async find(ownerId: number, query: string, options: NativeFindOptions = {}): Promise<NativeFindResult> {
    if (this.closed) throw new Error('CONTENT_FIND_CLOSED');
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || typeof query !== 'string' || query.length > 16384) {
      throw new Error('CONTENT_FIND_INVALID_REQUEST');
    }
    if (this.invalidated.has(ownerId)) {
      if (query) throw new Error('CONTENT_FIND_TARGET_CHANGED');
      this.invalidated.delete(ownerId);
    }

    const target = this.resolve(ownerId);
    let owner = this.owners.get(ownerId);
    if (owner && !target) {
      this.release(ownerId, false);
      this.invalidated.add(ownerId);
      throw new Error('CONTENT_FIND_TARGET_CHANGED');
    }
    if (owner && (targetIdentity(owner.target) !== targetIdentity(target!) || owner.target.isDestroyed())) {
      this.release(ownerId, false);
      this.invalidated.add(ownerId);
      throw new Error('CONTENT_FIND_TARGET_CHANGED');
    }
    if (!target || target.isDestroyed()) throw new Error('CONTENT_FIND_TARGET_UNAVAILABLE');

    if (!owner) {
      const gone = (): void => { this.release(ownerId, false); this.invalidated.add(ownerId); this.options.onClose?.(ownerId); };
      const disposers: Array<() => void> = [];
      disposers.push(target.onDestroyed(gone));
      disposers.push(target.onDidNavigate(gone));
      if (target.onEscape) {
        disposers.push(
          target.onEscape(event => {
            const current = this.owners.get(ownerId)?.target;
            if (!current || targetIdentity(current) !== targetIdentity(target)) return;
            event.preventDefault();
            this.stop(ownerId);
            this.options.onClose?.(ownerId);
          })
        );
      }
      owner = { target, revision: 0, dispose: () => { for (const dispose of disposers) dispose(); } };
      this.owners.set(ownerId, owner);
    }

    this.cancel(owner, new Error('CONTENT_FIND_SUPERSEDED'));
    const revision = ++owner.revision;

    const normalized: Required<NativeFindOptions> = {
      forward: options.forward !== false,
      findNext: options.findNext === true,
      matchCase: options.matchCase === true,
    };

    if (!query) {
      const selected = await target.readSelection();
      const current = this.resolve(ownerId);
      if (this.owners.get(ownerId) !== owner || !current || targetIdentity(current) !== targetIdentity(target) || target.isDestroyed()) {
        throw new Error('CONTENT_FIND_TARGET_CHANGED');
      }
      if (owner.revision !== revision) throw new Error('CONTENT_FIND_SUPERSEDED');
      target.stopFind(true);
      return { matches: 0, active: 0, selectedText: typeof selected === 'string' ? selected.slice(0, 16384) : '' };
    }

    const controller = new AbortController();
    return new Promise<NativeFindResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pending: { reject(error: Error): void };

      const settle = (error?: Error, result?: NativeFindMatch): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (owner?.pending === pending) delete owner.pending;
        if (error) {
          controller.abort();
          reject(error);
          return;
        }
        resolve({ matches: result!.matches, active: result!.active });
      };

      pending = { reject: (error: Error) => settle(error) };
      owner!.pending = pending;
      timer = setTimeout(() => settle(new Error('CONTENT_FIND_TIMEOUT')), this.options.timeoutMs ?? 5000);

      Promise.resolve()
        .then(() => target.find(query, normalized, controller.signal))
        .then(result => {
          const current = this.resolve(ownerId);
          if (this.owners.get(ownerId) !== owner || !current || targetIdentity(current) !== targetIdentity(target) || target.isDestroyed()) {
            settle(new Error('CONTENT_FIND_TARGET_CHANGED'));
            return;
          }
          if (owner!.revision !== revision) {
            settle(new Error('CONTENT_FIND_SUPERSEDED'));
            return;
          }
          settle(undefined, result);
        }, error => settle(error instanceof Error ? error : new Error(String(error))));
    });
  }

  stop(ownerId: number): void { this.release(ownerId, true); this.invalidated.delete(ownerId); }
  closeOwner(ownerId: number): void { this.stop(ownerId); }
  close(): void { this.closed = true; for (const id of this.owners.keys()) this.release(id, true); this.invalidated.clear(); }

  /** Adapt a plain WebContents explicitly; native pages never take this path. */
  electronFindPage(contents: WebContents): NativeFindPage {
    let page = this.electronPages.get(contents);
    if (!page) {
      page = new ElectronFindPage(contents);
      this.electronPages.set(contents, page);
    }
    return page;
  }

  private resolve(ownerId: number): NativeFindPage | null {
    let raw: NativeFindTarget | null;
    try { raw = this.options.target(ownerId); } catch { return null; }
    if (!raw) return null;
    return isNativeFindPage(raw) ? raw : this.electronFindPage(raw);
  }

  private cancel(owner: Owner, error: Error): void {
    const pending = owner.pending;
    if (!pending) return;
    pending.reject(error);
  }

  private release(ownerId: number, clear: boolean): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    this.owners.delete(ownerId);
    this.cancel(owner, new Error('CONTENT_FIND_TARGET_CHANGED'));
    owner.dispose();
    // A transferred page may now belong to another window. Never change it.
    const current = this.resolve(ownerId);
    if (clear && !owner.target.isDestroyed() && current && targetIdentity(current) === targetIdentity(owner.target)) owner.target.stopFind(true);
  }
}
