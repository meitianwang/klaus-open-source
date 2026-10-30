// Pure helpers for the settings storage page: display category folding, byte
// formatting, cleanup review eligibility and paging. No DOM or window access,
// so unit tests can import this module directly.

export const STORAGE_DISPLAY_CATEGORIES = ['threads', 'subagents', 'archived', 'worktrees', 'other'] as const
export type StorageDisplayCategory = (typeof STORAGE_DISPLAY_CATEGORIES)[number]

export interface StorageCategorySize {
  category: string
  bytes: number
}

export interface StorageUsageWire {
  home: string
  totalBytes: number
  categories: StorageCategorySize[]
  sessionBytes: Record<string, number>
  sessionSubagentBytes: Record<string, number>
  subagentCounts: Record<string, number>
}

export interface StorageSnapshotWire {
  status: 'scanning' | 'ready' | 'error'
  measuredAt: number | null
  completedCategories: string[]
  usage: StorageUsageWire | null
}

export interface StorageReviewRowWire {
  id: string
  archived: boolean
  running: boolean
  pinned: boolean
  updatedAt: number
  workdir: string | null
  bytes: number
  subagents: number
  row: unknown
}

/**
 * The displayed chart keeps five named categories; an unclassified bucket on
 * the wire folds into "other" instead of growing a sixth segment.
 */
export function displayCategories(categories: StorageCategorySize[]): Array<{ category: StorageDisplayCategory; bytes: number }> {
  const unclassified = categories.find(entry => entry.category === 'unclassified')
  const known = categories.filter(entry => (STORAGE_DISPLAY_CATEGORIES as readonly string[]).includes(entry.category))
  return known.map(entry => ({
    category: entry.category as StorageDisplayCategory,
    bytes: entry.category === 'other' && unclassified ? entry.bytes + unclassified.bytes : entry.bytes,
  }))
}

const BYTE_UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const

/** Disk sizes use binary thresholds and the current UI locale's unit labels. */
export function formatStorageBytes(bytes: number, locale = 'en'): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'long' }).format(0)
  if (bytes < 1024) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'long' }).format(bytes)
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit++ }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'unit', unit: BYTE_UNITS[unit]!, unitDisplay: 'short' }).format(value)
}

export const REVIEW_DAY_OPTIONS = [30, 90, 180, 365] as const
export const REVIEW_PAGE_SIZE = 50

export function reviewCutoffMs(days: number, nowMs: number): number {
  return nowMs - days * 86_400_000
}

/** Idle chats of the chosen archive state, last updated before the cutoff, oldest first. */
export function eligibleReviewRows(
  inventory: StorageReviewRowWire[],
  cutoffMs: number,
  archivedOnly: boolean,
): StorageReviewRowWire[] {
  return inventory
    .filter(row => (
      (!archivedOnly || row.archived)
      && !row.running
      && Number.isFinite(row.updatedAt)
      && row.updatedAt > 0
      && row.updatedAt < cutoffMs
    ))
    .sort((a, b) => a.updatedAt - b.updatedAt)
}

export function selectionSubagentTotal(rows: StorageReviewRowWire[], selected: ReadonlySet<string>): number {
  let total = 0
  for (const row of rows) if (selected.has(row.id)) total += row.subagents
  return total
}

/** A legend size is authoritative once its category finished in the live scan. */
export function categoryCompleted(snapshot: StorageSnapshotWire, category: string): boolean {
  if (!snapshot.completedCategories.includes(category)) return false
  if (category !== 'other') return true
  const hasUnclassified = snapshot.usage?.categories.some(entry => entry.category === 'unclassified') === true
  return !hasUnclassified || snapshot.completedCategories.includes('unclassified')
}

/** The cleanup row is actionable only with a complete chat measurement in hand. */
export function cleanupReady(snapshot: StorageSnapshotWire | null): boolean {
  if (!snapshot || snapshot.status === 'error' || !snapshot.usage) return false
  return ['threads', 'subagents', 'archived'].every(category => snapshot.completedCategories.includes(category))
}
