import type { FileHitRow } from './mention-queries'

/**
 * Client-side manager for one persistent workspace file-search session.
 *
 * The native side walked the tree once at open; each {@link search} re-ranks that
 * snapshot for a new query instead of walking again. The session opens on entry
 * and each keystroke's query is pushed into it, rather than issuing a
 * request-response per keystroke.
 *
 * Lifecycle and the two guards that keep it honest:
 *
 * - `open()` is idempotent and coalesces concurrent callers onto one creation
 *   promise, so a fast double-entry never opens two native sessions.
 * - Every search carries a monotonically increasing token; results from a token
 *   that is no longer the latest are dropped. The native session also cancels a
 *   superseded query and resolves it empty, so a stale keystroke cannot paint
 *   over a newer one — the client-side token is the second line of that defense.
 * - `close()` stops the native session and invalidates the token so any in-flight
 *   search resolves empty rather than resurrecting a closed menu's rows.
 *
 * This is deliberately NOT a useQuery: a session is an imperative resource with
 * open/update/stop, and wrapping it in the query cache would model a per-query
 * snapshot cache on top of a thing that already owns its snapshot. The component
 * holds the rows in state and feeds them to the same section shape the query
 * groups use.
 */
export class WorkspaceFileSearchSession {
  private creation: Promise<string | null> | null = null
  private nativeSessionId: string | null = null
  private token = 0
  private closing = false

  constructor(
    private readonly engine: {
      workspaceFileSearchSessionStart(sessionId: string | undefined, deadlineMs?: number, root?: string): Promise<{ sessionId: string } | null>
      workspaceFileSearchSessionQuery(searchSessionId: string, query: string, limit?: number, deadlineMs?: number): Promise<FileHitRow[] | null>
      workspaceFileSearchSessionStop(searchSessionId: string): Promise<unknown>
    },
    private readonly sessionId: string | null,
    private readonly root?: string,
  ) {}

  /** Open the native session once. Returns the native id, or null if refused. */
  private ensureOpen(): Promise<string | null> {
    if (this.nativeSessionId) return Promise.resolve(this.nativeSessionId)
    if (this.creation) return this.creation
    this.creation = this.engine
      .workspaceFileSearchSessionStart(this.sessionId ?? undefined, 30_000, this.root)
      .then((info) => {
        // A close() that raced the create must not leave an orphan native session.
        if (this.closing) {
          if (info?.sessionId) void this.engine.workspaceFileSearchSessionStop(info.sessionId).catch(() => {})
          return null
        }
        this.nativeSessionId = info?.sessionId ?? null
        return this.nativeSessionId
      })
    return this.creation
  }

  /**
   * Re-rank the held snapshot for `query`. Resolves empty if a newer search or a
   * close superseded this one. A failure propagates so the caller can show the
   * file group's own error line.
   */
  async search(query: string, limit = 40): Promise<FileHitRow[]> {
    if (this.closing) return []
    const myToken = ++this.token
    const nativeId = await this.ensureOpen()
    if (!nativeId || myToken !== this.token || this.closing) return []
    const hits = await this.engine.workspaceFileSearchSessionQuery(nativeId, query, limit, 5_000)
    // Superseded by a newer keystroke or a close while the rank was in flight.
    if (myToken !== this.token || this.closing) return []
    return Array.isArray(hits) ? hits : []
  }

  /** Stop the native session. Idempotent; safe to call from an unmount or menu close. */
  async close(): Promise<void> {
    this.closing = true
    this.token++
    const nativeId = this.nativeSessionId
    this.nativeSessionId = null
    // If a create is still in flight, its .then sees closing and stops the session
    // itself; nothing further to do here for that case.
    if (nativeId) {
      try { await this.engine.workspaceFileSearchSessionStop(nativeId) } catch { /* already stopped */ }
    }
  }
}
