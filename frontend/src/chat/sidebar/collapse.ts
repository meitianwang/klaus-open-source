// Pure sidebar collapse / pagination / badge logic.
//
// Semantics:
//
//   - A project group renders OPEN unless it was EXPLICITLY collapsed. The
//     persisted value is tri-state (`undefined` = never set = open, `true`,
//     `false`), and only an explicit `false` folds a group.
//   - Sections collapse independently, persisted as one object row.
//   - "Show more" inside a group is incremental pagination: the preview limit,
//     then +10 rows per press (5 → 15 → 25 …). The expanded flag is persisted
//     per project; the page counter is in-memory and restarts at 1, so the
//     visible count is `limit + step * page` once expanded.
//   - A collapsed group/section surfaces an aggregate status badge: waiting or
//     unread wins over active. There is no numeric count badge on
//     project/section headers, so none is modelled here.
//
// This module is I/O free so every rule is unit-testable. chat.ts owns the
// localStorage/KV reads and writes and calls into these functions.

import { SIDEBAR_SECTION_KEYS, type SidebarSectionKey } from '../../../../contracts/sidebar-collapse'

export { SIDEBAR_SECTION_KEYS, type SidebarSectionKey }


/** Rows shown before the first "show more". */
export const PROJECT_THREAD_PREVIEW_LIMIT = 5
/** Additional rows revealed per "show more" press. */
export const PROJECT_THREAD_PAGE_STEP = 10

// --- project group expansion (tri-state) ---

/** A project's persisted expansion. `undefined` = never set (defaults open);
 *  `true`/`false` = an explicit user choice. */
export type ProjectExpansion = boolean | undefined

export function parseProjectExpansionMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[key] = value
    }
  }
  return out
}

export function readProjectExpansion(
  map: Readonly<Record<string, boolean>> | null | undefined,
  key: string,
): ProjectExpansion {
  if (!map) return undefined
  const value = map[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Whether a group renders open. Only an explicit `false` collapses it. */
export function isProjectOpen(expansion: ProjectExpansion): boolean {
  return expansion !== false
}

/** Return a new map with `key` set to `expanded`, or removed when `undefined`
 *  (back to "never set"). Never mutates the input. */
export function withProjectExpansion(
  map: Readonly<Record<string, boolean>>,
  key: string,
  expanded: boolean | undefined,
): Record<string, boolean> {
  const next: Record<string, boolean> = { ...map }
  if (expanded === undefined) delete next[key]
  else next[key] = expanded
  return next
}

// --- section collapse ---

export type SectionsCollapsed = Record<SidebarSectionKey, boolean>

export function parseSectionsCollapsed(raw: unknown): SectionsCollapsed {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = {} as SectionsCollapsed
  for (const key of SIDEBAR_SECTION_KEYS) out[key] = source[key] === true
  return out
}

export function isSectionCollapsed(
  state: Readonly<SectionsCollapsed> | null | undefined,
  key: SidebarSectionKey,
): boolean {
  return !!state && state[key] === true
}

/** Seed section state from the pre-rework booleans.
 *
 *  Before sections were foldable, two localStorage flags recorded the same two
 *  choices: `klaus_projects_collapsed` folded the project groups, and
 *  `klaus_conversations_collapsed` folded the projectless list. Only `'1'` means
 *  folded. This runs once, on the first launch after the rework when no mirror
 *  row exists yet, so an upgrading user does not lose a fold they had set.
 */
export function seedSectionsFromLegacy(
  legacyProjectsCollapsed: string | null,
  legacyConversationsCollapsed: string | null,
): SectionsCollapsed {
  const seeded = parseSectionsCollapsed(null)
  if (legacyProjectsCollapsed === '1') seeded.projects = true
  if (legacyConversationsCollapsed === '1') seeded.recent = true
  return seeded
}

export function withSectionCollapsed(
  state: Readonly<SectionsCollapsed>,
  key: SidebarSectionKey,
  collapsed: boolean,
): SectionsCollapsed {
  return { ...state, [key]: collapsed }
}

// --- reveal on session switch / new chat ---

/** Whether revealing a session should force its group open.
 *
 *  Revealing unfolds the containing section, treats an already-expanded group
 *  as a no-op, and refuses to pry open a group the user EXPLICITLY collapsed
 *  when the only reason is a draft (`client-local-thread` with no
 *  conversationId yet). A real session always reveals. */
export function revealDecision(expansion: ProjectExpansion, draft: boolean): 'expand' | 'noop' {
  if (expansion === true) return 'noop'
  if (expansion === false && draft) return 'noop'
  return 'expand'
}

// --- serialized optimistic persistence ---

export interface CollapseWriteQueuePorts {
  /** Authoritative store (settings.db via IPC in production). */
  writeStore(value: string): Promise<unknown>
  /** Mirror for the synchronous first paint (localStorage in production). */
  writeMirror(value: string): void
  /** Commit a value into live state. */
  apply(value: string): void
  /** The live value as it would be serialized — the rollback guard reads this. */
  current(): string
  /** Repaint after a rollback so the UI matches the reverted state. */
  render(): void
  /** `settings:kv:set` can answer with an error envelope instead of rejecting. */
  isError(result: unknown): boolean
  describeError(result: unknown): string
  /** Surface a failed write to the user. */
  onFailure(error: string): void
}

/** Optimistic, serialized collapse writes.
 *
 *  Two rules, both of which a naive fire-and-forget write breaks:
 *
 *  1. The UI never waits on IPC: `apply` + mirror happen synchronously on click,
 *     and only the durable write trails.
 *  2. Writes to one row are chained. Fold-then-unfold in quick succession issues
 *     two IPC calls; unserialized they can land out of order and leave
 *     settings.db holding the OLDER value, so the next launch restores a fold the
 *     user had already undone. Chaining makes the last click win.
 *
 *  On failure the rollback is guarded: an older write's error must not revert a
 *  newer click that has since been applied (the same invariant the sidebar pins
 *  for pinning, `staleRefreshCannotRevertAcknowledgedPin`). The row reverts to
 *  the last value confirmed durable, and only when that is still the live one. */
export class CollapseWriteQueue {
  private tail: Promise<void> = Promise.resolve()
  /** Last value confirmed written to the store; the rollback target. */
  private durable: string

  constructor(private readonly ports: CollapseWriteQueuePorts, initialDurable: string) {
    this.durable = initialDurable
  }

  /** Apply optimistically now, persist in order. */
  commit(value: string): void {
    this.ports.apply(value)
    this.ports.writeMirror(value)
    this.tail = this.tail.then(() => this.flush(value))
  }

  /** Await every queued write (seeding, shutdown, tests). */
  idle(): Promise<void> {
    return this.tail
  }

  /** Record a value as already durable without writing it. Used after hydrate
   *  reads the authoritative row back, so a later failure rolls back to that row
   *  rather than to the pre-hydrate mirror guess. */
  noteDurable(value: string): void {
    this.durable = value
  }

  private async flush(value: string): Promise<void> {
    try {
      const result = await this.ports.writeStore(value)
      if (this.ports.isError(result)) throw new Error(this.ports.describeError(result))
      this.durable = value
    } catch (error) {
      const message = (error as Error | null)?.message || String(error)
      // A newer click may already be applied and queued; leave it alone.
      if (this.ports.current() === value) {
        this.ports.apply(this.durable)
        this.ports.writeMirror(this.durable)
        this.ports.render()
      }
      this.ports.onFailure(message)
    }
  }
}

// --- async apply guard ---

/** Whether a state read that was already in flight may still be applied.
 *
 *  Both the boot hydrate and a cross-window preference push capture the current
 *  revision before awaiting IPC. If a local click landed during that flight it
 *  bumped the revision, and applying the older read would silently undo the
 *  user's action — so the reader must yield. */
export function mayApplyAsyncState(capturedRevision: number, currentRevision: number): boolean {
  return capturedRevision === currentRevision
}

// --- show-more pagination ---

export interface ShowMoreState {
  /** Persisted per project: has "show more" been pressed at least once. */
  expanded: boolean
  /** In-memory page counter, 1-based. Only consulted when `expanded`. */
  page: number
}

/** Rows visible for a group. `expanded=false` → the preview limit; once
 *  expanded, `limit + step*page` (5 → 15 → 25 …). */
export function projectThreadVisibleCount(state: ShowMoreState): number {
  if (!state.expanded) return PROJECT_THREAD_PREVIEW_LIMIT
  const page = state.page > 0 ? state.page : 1
  return PROJECT_THREAD_PREVIEW_LIMIT + PROJECT_THREAD_PAGE_STEP * page
}

/** Effect of one "show more" press. The first press flips expanded on and pins
 *  the page to 1; later presses only advance the page. */
export function showMoreAfterPress(state: ShowMoreState): ShowMoreState {
  if (!state.expanded) return { expanded: true, page: 1 }
  return { expanded: true, page: (state.page > 0 ? state.page : 1) + 1 }
}

/** Whether a "show more" button should render: rows remain beyond the window. */
export function hasMoreProjectThreads(total: number, state: ShowMoreState): boolean {
  return total > projectThreadVisibleCount(state)
}

/** An out-of-window row that must still render
 *  (the active session). Returns the visible slice plus, if a forced row lies
 *  beyond it, that row appended once. Rows inside the window are never
 *  duplicated. */
export function projectThreadWindow<T>(
  rows: readonly T[],
  state: ShowMoreState,
  isForced: (row: T) => boolean,
): T[] {
  const limit = projectThreadVisibleCount(state)
  const head = rows.slice(0, limit)
  if (rows.length <= limit) return head
  const forced = rows.slice(limit).find(isForced)
  return forced === undefined ? head : [...head, forced]
}

// --- aggregate collapsed badge ---

export interface SessionActivity {
  /** `active` — a turn / sub-agent / background process is running. */
  working: boolean
  /** `unread` — completed but not yet seen. */
  unread: boolean
  /** `waiting` — an approval / elicitation is pending a reply. */
  waiting: boolean
}

/** A collapsed group/section's status badge. `'unread'` renders a dot,
 *  `'loading'` a spinner, `null` nothing. waiting/unread beats active. No
 *  numeric count badge exists on project/section heads. */
export type CollapsedBadge = 'unread' | 'loading' | null

export function reduceCollapsedBadge(sessions: Iterable<SessionActivity>): CollapsedBadge {
  let anyActive = false
  for (const session of sessions) {
    if (session.waiting || session.unread) return 'unread'
    if (session.working) anyActive = true
  }
  return anyActive ? 'loading' : null
}
