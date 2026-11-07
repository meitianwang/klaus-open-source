import { SUBSCRIPTION_WEB_SEARCH_SOURCES, type WebSearchSource } from '../../../../contracts/web-search-settings'
import { logHostDiagnostic } from './settings-error-text'

interface PendingSearchSource { confirmed: WebSearchSource; changes: WebSearchSource[]; done?: Promise<void> }
export interface SearchSourceSnapshot { source: WebSearchSource | null; pending?: PendingSearchSource; error?: string; saveError?: boolean }
type Update = (update: (current: SearchSourceSnapshot) => SearchSourceSnapshot) => void

export function searchSourceItems(current: WebSearchSource | null) {
  const items = SUBSCRIPTION_WEB_SEARCH_SOURCES.map(value => ({ value, disabled: false }))
  // A stored source from before the subscription-only catalog stays visible as
  // the current choice so the control never paints blank; it cannot be re-picked.
  return current && !items.some(item => item.value === current)
    ? [{ value: current, disabled: true }, ...items]
    : items
}

/** Keep rapid choices ordered and retain the pending selection across page remounts. */
export function enqueueSearchSource(snapshot: SearchSourceSnapshot, source: WebSearchSource, update: Update, api: {
  set(source: WebSearchSource): Promise<{ ok?: boolean; error?: string }>; settled(): void; error: string
}): Promise<void> {
  if (!snapshot.source || source === snapshot.source) return Promise.resolve()
  const pending = snapshot.pending ?? { confirmed: snapshot.source, changes: [] }
  pending.changes.push(source)
  update(() => ({ source, pending }))
  if (!pending.done) pending.done = (async () => {
    let error: string | undefined
    while (pending.changes.length) {
      const next = pending.changes.shift()!
      try {
        const result = await api.set(next)
        if (result?.ok !== true) { logHostDiagnostic('search-source', result?.error); throw new Error(api.error) }
        pending.confirmed = next
        error = undefined
      } catch (cause) { logHostDiagnostic('search-source', cause); error = api.error }
    }
    update(current => current.pending === pending ? { source: pending.confirmed, ...(error ? { error, saveError: true } : {}) } : current)
    api.settled()
  })()
  return pending.done
}
