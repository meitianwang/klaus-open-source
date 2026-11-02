/**
 * A small search index over the host's existing conversation snapshot.
 *
 * The composer menu opens on every mention and filters as the person types. It
 * must not read the engine directory per keystroke, so this catalog indexes the
 * snapshot `SessionService` already keeps after a successful session list read.
 * The index is rebuilt only when that snapshot array is replaced; a query then
 * filters compact `{id,title,sortAt}` rows and pages the matches.
 */
import type { Json } from '../ipc/contract';
import {
  buildSessionMentionEntries,
  pageSessionMentions,
  type SessionMentionCursor,
  type SessionMentionEntry,
  type SessionMentionPage,
} from '../../shared/session-mentions';

/**
 * Temporary host titles that outrank a snapshot for a bounded interval.
 *
 * Each entry carries the revision at which it was written. A snapshot read
 * captures the revision before it starts and prunes only entries at or below
 * that capture when it succeeds, so a title written while the read was in flight
 * survives. Once a later read converges, an external title in the new snapshot
 * wins again.
 */
export class MentionTitleOverrides {
  private readonly entries = new Map<string, { title: string; revision: number }>();
  private revision = 0;

  /** The watermark a snapshot read records before it begins. */
  capture(): number {
    return this.revision;
  }

  /** Write a title and return the revision that identifies this write. */
  set(id: string, title: string): number {
    if (!id || !title) return this.revision;
    this.entries.delete(id);
    const revision = ++this.revision;
    this.entries.set(id, { title, revision });
    while (this.entries.size > 512) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return revision;
  }

  get(id: string): string | undefined {
    return this.entries.get(id)?.title;
  }

  delete(id: string): void {
    this.entries.delete(id);
  }

  /** Drop titles that were present before the read and unchanged while it ran. */
  prune(throughRevision: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.revision <= throughRevision) this.entries.delete(id);
    }
  }
}

export interface SessionMentionCatalogDeps {
  /** Current host visibility, checked per page so a deleted row disappears at once. */
  visible(id: string): boolean;
  /** A newer host title (for example an acknowledged rename) outranks the snapshot. */
  titleFor(id: string, fallback: string): string;
}

interface IndexedSnapshot {
  source: readonly Json[];
  revision: number;
  entries: SessionMentionEntry[];
}

export class SessionMentionCatalog {
  private indexed?: IndexedSnapshot;
  private revision = 0;

  constructor(private readonly deps: SessionMentionCatalogDeps) {}

  /** Index a new snapshot array; reusing the same array keeps the same revision. */
  private indexFor(source: readonly Json[]): IndexedSnapshot {
    if (this.indexed?.source === source) return this.indexed;
    const entries = buildSessionMentionEntries(source);
    const indexed = { source, revision: ++this.revision, entries };
    this.indexed = indexed;
    return indexed;
  }

  page(source: readonly Json[], query: string, limit: number, cursor?: SessionMentionCursor): SessionMentionPage {
    const indexed = this.indexFor(source);
    const entries = indexed.entries
      .filter(entry => this.deps.visible(entry.id))
      .map(entry => ({ ...entry, title: this.deps.titleFor(entry.id, entry.title) }));
    return pageSessionMentions({ entries, query, limit, revision: indexed.revision, ...(cursor ? { cursor } : {}) });
  }
}
