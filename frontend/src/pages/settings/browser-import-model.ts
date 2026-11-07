import { BROWSER_IMPORT_CATEGORIES, BROWSER_IMPORT_DEFAULT_SELECTION, type BrowserImportCategory, type BrowserImportCounts, type BrowserImportIssue, type BrowserImportSelection } from '../../../../contracts/browser-import'
import type { BrowserImportJobSnapshot } from '../../../../contracts/browser-import-jobs'

export type ImportSelection = Required<BrowserImportSelection>
export type ImportSummary = { selection: ImportSelection; counts: BrowserImportCounts; errors: BrowserImportIssue[] }

export const IMPORT_UI_DEFAULTS: Readonly<ImportSelection> = Object.freeze({ ...BROWSER_IMPORT_DEFAULT_SELECTION })

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

/** Localized copy for known import issue codes. Unknown codes render nothing: raw diagnostics never reach the user. */
const IMPORT_ISSUE_LABEL_KEYS: Record<string, string> = {
  app_bound_encryption_unsupported: 'browser_import_app_bound_unsupported',
  extension_file_limit: 'browser_import_extension_file_limit',
  extension_size_limit: 'browser_import_extension_size_limit',
  snapshot_unstable: 'browser_import_source_changed',
  snapshot_corrupted: 'browser_import_source_changed',
  keychain_auth_cancelled: 'browser_import_passwords_locked',
  keychain_auth_failed: 'browser_import_passwords_locked',
  keychain_interaction_not_allowed: 'browser_import_passwords_locked',
  keychain_item_not_found: 'browser_import_passwords_locked',
  keychain_item_invalid: 'browser_import_passwords_locked',
  keychain_error: 'browser_import_passwords_locked',
  key_derivation_failed: 'browser_import_passwords_locked',
  test_key_missing: 'browser_import_passwords_locked',
}

export function importIssueLabelKey(code: string): string | null {
  return IMPORT_ISSUE_LABEL_KEYS[code] ?? null
}
