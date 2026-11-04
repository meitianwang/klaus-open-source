import { BROWSER_IMPORT_CATEGORIES, BROWSER_IMPORT_DEFAULT_SELECTION, type BrowserImportCategory, type BrowserImportCounts, type BrowserImportIssue, type BrowserImportSelection } from '../../../../contracts/browser-import'
import type { BrowserImportJobSnapshot } from '../../../../contracts/browser-import-jobs'

export type ImportSelection = Required<BrowserImportSelection>
export type ImportSummary = { selection: ImportSelection; counts: BrowserImportCounts; errors: BrowserImportIssue[] }

export const IMPORT_UI_DEFAULTS: Readonly<ImportSelection> = Object.freeze({ ...BROWSER_IMPORT_DEFAULT_SELECTION })
export const IMPORT_MINIMUM_DURATION_MS = 750
export const IMPORT_ROW_INTERVAL_MS = 500

export function importIsTerminal(snapshot: BrowserImportJobSnapshot): boolean {
  return snapshot.stage === 'completed' || snapshot.stage === 'failed' || snapshot.stage === 'cancelled'
}

export function importCategoryErrors(summary: ImportSummary, category: BrowserImportCategory): BrowserImportIssue[] {
  if (!summary.selection[category]) return []
  return summary.errors.filter(issue => issue.category === category || issue.category === 'profile' || issue.category === 'discovery')
}

export function importRetrySelection(summary: ImportSummary): ImportSelection {
  return Object.fromEntries(BROWSER_IMPORT_CATEGORIES.map(category => [category, importCategoryErrors(summary, category).length > 0])) as ImportSelection
}

/** A retry replaces only attempted categories, retaining every other outcome. */
export function mergeImportSummary(previous: ImportSummary | null, selection: ImportSelection, snapshot: BrowserImportJobSnapshot): ImportSummary {
  const counts = { ...(previous?.counts ?? { cookies: 0, passwords: 0, history: 0, extensions: 0 }) }
  const combined = { ...(previous?.selection ?? { cookies: false, passwords: false, history: false, extensions: false }) }
  const errors: BrowserImportIssue[] = []
  for (const category of BROWSER_IMPORT_CATEGORIES) {
    if (selection[category]) {
      combined[category] = true
      counts[category] = snapshot.counts[category]
      for (const issue of snapshot.errors) {
        if (issue.category === category || issue.category === 'profile' || issue.category === 'discovery') errors.push({ ...issue, category })
      }
    } else if (previous?.selection[category]) {
      errors.push(...importCategoryErrors(previous, category).map(issue => ({ ...issue, category })))
    }
  }
  return { selection: combined, counts, errors }
}
