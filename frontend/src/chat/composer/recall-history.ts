import { composerDocumentText, restoreComposerDocument } from './document-model'
import { normalizeComposerDraft, type ComposerDraft } from './slash-draft'

export const COMPOSER_HISTORY_LIMIT = 20
const HISTORY_SCOPE_LIMIT = 100
const NEW_CHAT_HISTORY = 'global'

export function composerHistoryScope(sessionId: string | null): string {
  return sessionId || NEW_CHAT_HISTORY
}

/** Bound old persisted data on load as well as on insertion. */
export function restoreComposerHistory(value: unknown): Map<string, ComposerDraft[]> {
  const stored = Array.isArray(value) ? { [NEW_CHAT_HISTORY]: value } : value
  const history = new Map<string, ComposerDraft[]>()
  if (stored && typeof stored === 'object') {
    for (const [scope, entries] of Object.entries(stored)) {
      if (Array.isArray(entries)) history.set(scope, entries.slice(-COMPOSER_HISTORY_LIMIT).map(normalizeComposerDraft))
    }
  }
  pruneHistoryScopes(history)
  return history
}

function pruneHistoryScopes(history: Map<string, ComposerDraft[]>): void {
  const sessions = [...history.keys()].filter(scope => scope !== NEW_CHAT_HISTORY)
  for (const scope of sessions.slice(0, Math.max(0, sessions.length - HISTORY_SCOPE_LIMIT))) history.delete(scope)
}

export function appendComposerHistory(history: Map<string, ComposerDraft[]>, sessionId: string | null,
  value: ComposerDraft | string, prepend = false): boolean {
  const draft = normalizeComposerDraft(value)
  const document = restoreComposerDocument(draft.document)
  if (!draft.text.trim() && (!document || !composerDocumentText(document).trim())) return false
  const scope = composerHistoryScope(sessionId), current = history.get(scope) || []
  const entries = prepend ? [draft, ...current] : [...current, draft]
  history.delete(scope)
  history.set(scope, entries.slice(-COMPOSER_HISTORY_LIMIT))
  pruneHistoryScopes(history)
  return true
}

/** -1 is the empty slot after the newest entry; null means no navigation. */
export function recalledHistoryIndex(current: number, direction: -1 | 1, count: number): number | null {
  if (!count || current < 0 && direction > 0) return null
  if (current < 0) return count - 1
  if (direction > 0 && current >= count - 1) return -1
  return (current + direction + count) % count
}
