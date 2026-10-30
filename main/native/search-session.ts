import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NativeHostBinding } from './binding';
import { validDeadline } from './pty';

export interface FileHitShape { rel: string; name: string; isDir: boolean }
export interface SearchSessionQueryResult { hits: FileHitShape[]; scanned: number }

/**
 * One persistent workspace file search.
 *
 * The native side walked the tree once at creation; every {@link query} re-ranks
 * that held snapshot instead of walking again, which is what makes a picker that
 * searches on every keystroke affordable. The snapshot is frozen for this
 * object's lifetime — a file created after the session opened is not offered
 * until a new session is opened.
 *
 * Queries return their result rather than arriving on an event stream: ranking a
 * snapshot produces exactly one complete result per query, so there is nothing to
 * pump, and the IPC layer needs no push channel. A picker wants latest-wins, so a
 * new query cancels the previous in-flight one; a cancelled query resolves empty
 * rather than rejecting, matching the one-shot channel's superseded-search result.
 */
export class NativeSearchSession {
  private closing = false;
  private readonly queries = new Map<string, { result: Promise<SearchSessionQueryResult>; cancel: () => boolean }>();

  constructor(
    private readonly host: NativeHostBinding,
    readonly sessionId: string,
    readonly info: { roots: number; scanned: number; truncated: boolean },
    /** Workspace roots in order; a hit's rootIndex selects which to prefix with. */
    private readonly roots: string[],
  ) {}

  get stopped(): boolean {
    return this.closing;
  }

  /**
   * Re-rank the snapshot for a new query. Cancels any in-flight query for this
   * session first, so fast typing never stacks up against the native per-session
   * concurrency cap. Non-primary-root hits are rebased onto their root, matching
   * the one-shot handler's `path.join(root, rel)` so the renderer sees one shape.
   */
  query(queryText: string, limit: number, deadlineMs: number, operationId = randomUUID()): { operationId: string; result: Promise<SearchSessionQueryResult>; cancel: () => boolean } {
    if (this.closing) throw new Error('CLOSED: search session is stopped');
    validDeadline(deadlineMs);
    // Latest-wins: a newer keystroke supersedes the one still ranking.
    for (const [, entry] of this.queries) entry.cancel();

    const cancel = () => this.queries.has(operationId) && this.host.cancelSearchSessionQuery(this.sessionId, operationId);
    const result = this.host
      .searchSessionQuery({ sessionId: this.sessionId, operationId, query: queryText, limit, deadlineMs })
      .then((value): SearchSessionQueryResult => ({
        scanned: value.scanned,
        hits: value.hits.map((hit) => {
          const prefix = hit.rootIndex > 0 ? this.roots[hit.rootIndex] : undefined;
          return prefix
            ? { rel: path.join(prefix, hit.rel), name: hit.name, isDir: hit.isDir }
            : { rel: hit.rel, name: hit.name, isDir: hit.isDir };
        }),
      }))
      // A superseded query reports CANCELLED; that is an expected outcome of
      // latest-wins, not a failure, so resolve it empty like the one-shot path
      // resolves a superseded search. Genuine errors still reject.
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        if (text.includes('CANCELLED')) return { hits: [] as FileHitShape[], scanned: 0 };
        throw error;
      });
    this.queries.set(operationId, { result, cancel });
    void result.finally(() => {
      if (this.queries.get(operationId)?.result === result) this.queries.delete(operationId);
    }).catch(() => undefined);
    return { operationId, result, cancel };
  }

  /**
   * Stop the session and drop it from the native registry. Cancels in-flight
   * queries; idempotent, so a leaked caller cannot double-stop or resurrect it.
   */
  async stop(): Promise<{ complete: boolean; pendingOperations: string[] }> {
    this.closing = true;
    this.host.stopSearchSession(this.sessionId);
    const pending = [...this.queries.values()].map((entry) => entry.result);
    await Promise.allSettled(pending);
    return { complete: this.queries.size === 0, pendingOperations: [...this.queries.keys()] };
  }
}
