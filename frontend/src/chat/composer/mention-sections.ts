import type { MentionEntry } from './slash-menu'

/**
 * One group of the `@` mention menu:
 * `{ id, title, items, emptyState, isLoading }`.
 *
 * The section is pure data with no resolved strings — every label is an i18n
 * KEY resolved at render time, never at build time. Building the label here (as
 * the old imperative getters did with `tt(...)`) would freeze it in whatever
 * language was active when the rows were constructed, so switching language
 * while the menu is open would leave stale text. The React layer resolves these
 * keys with `useT()`, which re-renders on `klaus:lang-change`.
 *
 * `labelKey` is null for a group that never shows a heading. `state` is the
 * group's own placeholder while it has no rows: loading (still fetching), error
 * (the source failed), or empty (loaded, nothing matched). Keeping it per-section
 * is what lets one slow or failed source degrade on its own instead of taking the
 * whole menu down — the property the whole refactor exists for.
 */
export interface MentionSectionState {
  kind: 'loading' | 'error' | 'empty'
  /** i18n key for the placeholder line, e.g. `mention_group_plugins_loading`. */
  labelKey: string
  detail?: string
  retry?: () => void
}

export interface MentionSection {
  /** Stable id, also the React key and the selection-key component. */
  key: string
  /** i18n key for the heading, or null for a headingless group. */
  labelKey: string | null
  /** Matched entries, already display-filtered and capped by {@link filterMentionRows}. */
  rows: MentionEntry[]
  /** Placeholder shown instead of rows; omitted once rows exist. */
  state?: MentionSectionState
}

/** A flattened render row. Headings and state lines are not selectable. */
export type MentionRow =
  | { kind: 'heading'; sectionKey: string; labelKey: string }
  | { kind: 'item'; sectionKey: string; entry: MentionEntry }
  | { kind: 'state'; sectionKey: string; stateKind: MentionSectionState['kind']; labelKey: string; detail?: string; retry?: () => void }

/** Display cap per group. The menu is height-bounded (280px) and shows up to
 * five headings, so each group offers a short first screen rather than eight. */
export const MENTION_GROUP_LIMIT = 4

/**
 * Filter cached rows by a mention query. An empty query returns the first
 * {@link MENTION_GROUP_LIMIT} rows so each group's first screen stays short.
 *
 * The cap belongs here, at display, never inside a loader: truncating before
 * caching would lock every later title search to the first few rows, so an older
 * conversation or plugin could never be found by name.
 *
 * Rows may carry `aliases` — extra names the same entry answers to. A plugin row
 * shows the product name the plugin page shows while staying findable by its raw
 * package slug and by its product name in the other language, so the name a user
 * typed in any of those forms associates the same entry.
 */
export function filterMentionRows<T extends { name: string; aliases?: string[] }>(rows: T[], query: string, limit = MENTION_GROUP_LIMIT): T[] {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return rows.slice(0, limit)
  return rows.filter(row => String(row.name || '').toLowerCase().includes(needle)
    || (row.aliases || []).some(alias => String(alias).toLowerCase().includes(needle))).slice(0, limit)
}

/**
 * Flatten sections into the render sequence: heading, then items, or the
 * section's own state line when it has no items.
 *
 * A section collapses to nothing — no heading, no state line — when it has no
 * rows and nothing worth announcing (empty). A loading or error state IS worth
 * announcing, so those keep their heading and show the placeholder; that is the
 * visible half of "each group degrades on its own". An empty group showing a
 * bare heading would only waste a line of the height-bounded menu.
 */
export function mentionRows(sections: MentionSection[]): MentionRow[] {
  const rows: MentionRow[] = []
  for (const section of sections) {
    const hasItems = section.rows.length > 0
    const state = section.state
    const showState = !!state && state.kind !== 'empty'
    if (!hasItems && !showState) continue
    if (section.labelKey) rows.push({ kind: 'heading', sectionKey: section.key, labelKey: section.labelKey })
    if (hasItems) {
      for (const entry of section.rows) rows.push({ kind: 'item', sectionKey: section.key, entry })
    }
    if (state && (showState || !hasItems)) {
      rows.push({ kind: 'state', sectionKey: section.key, stateKind: state.kind, labelKey: state.labelKey,
        ...(state.detail ? { detail: state.detail } : {}), ...(state.retry ? { retry: state.retry } : {}) })
    }
  }
  return rows
}

/**
 * The rows the keyboard can land on. Headings and state placeholders are
 * excluded, so `activeIdx` counts only real choices and arrow navigation never
 * stops on "Loading…".
 */
export function selectableEntries(rows: MentionRow[]): MentionEntry[] {
  return rows.flatMap(row => row.kind === 'item' ? [row.entry] : [])
}

function entryIdentity(entry: MentionEntry): string {
  const tab = entry.browserTab
  return tab ? JSON.stringify(['browser-tab', tab.source, tab.browserId, tab.tabId]) : JSON.stringify([entry.kind, entry.path])
}

/** Live tab recency changes must never move keyboard focus onto a different tab. */
export function reconcileMentionActiveIndex(previous: MentionEntry[], next: MentionEntry[], activeIdx: number): number {
  if (next.length === 0) return -1
  if (previous.length === 0) return 0
  const selected = previous[activeIdx]
  if (!selected) return -1
  return next.findIndex(entry => entryIdentity(entry) === entryIdentity(selected))
}

/**
 * Stable identity of a rendered row set.
 *
 * Replaces the old `workspaceMentionRowsSignature` in chat.ts. When a remote
 * group fills in, the row set genuinely changes and the menu must redraw; when a
 * re-fetch returns identical rows, the signature is unchanged so the redraw is
 * skipped and the user's arrow-key position survives. Identity is built from
 * i18n keys and entry addresses, not resolved labels, so it is language-stable.
 */
export function mentionSelectionKey(rows: MentionRow[]): string {
  return rows.map(row => {
    if (row.kind === 'heading') return `h:${row.labelKey}`
    if (row.kind === 'state') return `s:${row.sectionKey}:${row.stateKind}:${row.labelKey}:${row.detail || ''}`
    const entry = row.entry
    return `i:${entry.kind ?? (entry.isDir ? 'folder' : 'file')}:${entry.path}:${entry.name}:${entry.rel}`
  }).join('\u0001')
}
