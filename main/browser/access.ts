import type { BrowserAccess, BrowserResource } from '../../contracts/browser-settings';
import { BrowserError } from './types';

interface PendingAccess { promise: Promise<boolean>; controller: AbortController }

export class BrowserAccessController {
  private readonly grants = new Set<string>();
  private readonly pending = new Map<string, PendingAccess>();
  private readonly generations = new Map<string, number>();
  private revision = 0;
  constructor(private readonly options: {
    access(url: string, resource: BrowserResource): BrowserAccess;
    request(sessionId: string, origin: string, resource: BrowserResource, signal?: AbortSignal): Promise<boolean>;
  }) {}

  async authorize(sessionId: string, url: string, resource: BrowserResource = 'browsing', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (url === 'about:blank') return;
    let origin: string;
    try { origin = new URL(url).origin; } catch { throw new BrowserError('invalid_request', 'A valid website URL is required.'); }
    const policy = this.options.access(url, resource);
    if (policy === 'allow') return;
    if (policy === 'deny') throw new BrowserError('refused_by_policy', `Website ${resource} access is blocked for ${origin}.`);
    const key = JSON.stringify([sessionId, origin, resource]), revision = this.revision, generation = this.generations.get(sessionId) ?? 0;
    if (this.grants.has(key)) return;
    let entry = this.pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      let promise: Promise<boolean>;
      try { promise = this.options.request(sessionId, origin, resource, controller.signal); }
      catch (error) { signal?.removeEventListener('abort', abort); throw error; }
      entry = { promise, controller };
      this.pending.set(key, entry);
      const current = entry;
      void promise.finally(() => {
        signal?.removeEventListener('abort', abort);
        if (this.pending.get(key) === current) this.pending.delete(key);
      }).catch(() => {});
      if (signal?.aborted) abort();
    }
    const request = entry.promise;
    const allowed = await (signal ? new Promise<boolean>((resolve, reject) => {
      const aborted = () => reject(signal.reason ?? new BrowserError('cancelled', 'Browser access was cancelled.'));
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      void request!.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    }) : request);
    signal?.throwIfAborted();
    if (!allowed || revision !== this.revision || generation !== (this.generations.get(sessionId) ?? 0) || this.options.access(url, resource) === 'deny') throw new BrowserError('refused_by_policy', `Website ${resource} access was not approved for ${origin}.`);
    this.grants.add(key);
  }
  invalidate(): void {
    this.revision++; this.grants.clear();
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
  }
  release(sessionId: string): void {
    for (const key of this.grants) if (JSON.parse(key)[0] === sessionId) this.grants.delete(key);
    for (const [key, entry] of this.pending) if (JSON.parse(key)[0] === sessionId) {
      entry.controller.abort();
      this.pending.delete(key);
    }
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
  }
}
