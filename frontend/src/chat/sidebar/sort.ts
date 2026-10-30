// Sidebar sort modes.
//
// The sort menu offers Priority and chronological ("Last updated"). Priority
// ranks by attention state — waiting > unread > active > idle — ties broken by
// recency, then applies that order INSIDE every section (pinned, channels,
// project groups, recent) rather than reshuffling sections themselves. The
// comparator is:
//   [...rows].sort((a, b) => ATTENTION_RANK[a.attention] - ATTENTION_RANK[b.attention]
//                        || b.recencyAt - a.recencyAt)
// with the ranks defined in ./attention (waiting:0, unread:1, active:2, idle:3).

import { ATTENTION_RANK, type SessionAttentionState } from './attention'

export type SidebarSortMode = 'priority' | 'updated_at'

export interface SortableAttention {
  attention: SessionAttentionState
  recencyAt: number
}

export function compareByAttentionState(left: SortableAttention, right: SortableAttention): number {
  const rank = ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention]
  if (rank !== 0) return rank
  return right.recencyAt - left.recencyAt
}

/** Sort one section's rows under a mode. Non-mutating. */
export function sortSectionRows<T extends SortableAttention>(rows: readonly T[], mode: SidebarSortMode): T[] {
  const copy = [...rows]
  if (mode === 'priority') copy.sort(compareByAttentionState)
  return copy
}

const SORT_MODE_KEY = 'klaus_sidebar_sort_mode'

export function readStoredSortMode(): SidebarSortMode {
  try {
    return localStorage.getItem(SORT_MODE_KEY) === 'priority' ? 'priority' : 'updated_at'
  } catch {
    return 'updated_at'
  }
}

export function storeSortMode(mode: SidebarSortMode): void {
  try {
    if (mode === 'priority') localStorage.setItem(SORT_MODE_KEY, 'priority')
    else localStorage.removeItem(SORT_MODE_KEY)
  } catch { /* first paint mirror only; a failed write keeps the session mode */ }
}
