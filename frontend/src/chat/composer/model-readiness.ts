export type ModelReadiness =
  | { status: 'ready' | 'unconfigured' }
  | { status: 'unavailable'; error: unknown }

export interface SourceReadiness { source: string; readiness: ModelReadiness }

/** Share successful catalogs without holding on to transport failures or empty setup. */
export function createModelCatalogCache<T extends { value: string }>(load: (source: string) => Promise<T[]>) {
  let revision = 0
  const values = new Map<string, T[]>()
  const pending = new Map<string, Promise<T[]>>()
  const cache = {
    get: (source: string) => values.get(source),
    invalidate() { revision++; values.clear(); pending.clear() },
    load(source: string): Promise<T[]> {
      const saved = values.get(source)
      if (saved) return Promise.resolve(saved)
      const existing = pending.get(source)
      if (existing) return existing
      const startedAt = revision
      const request = Promise.resolve().then(() => load(source)).then(items => {
        if (revision !== startedAt) return cache.load(source)
        if (hasConfiguredModel(items)) values.set(source, items)
        return items
      }, error => {
        if (revision !== startedAt) return cache.load(source)
        throw error
      }).finally(() => { if (pending.get(source) === request) pending.delete(source) })
      pending.set(source, request)
      return request
    },
  }
  return cache
}

/** A ready result is valid until a model, configuration, auth or engine change. */
export function createModelReadinessCache(actions: {
  loadSource: (sessionId: string | null | undefined) => Promise<string>
  loadItems: (source: string) => Promise<Array<{ value: string }>>
}) {
  let revision = 0
  const ready = new Map<string, SourceReadiness>()
  const pending = new Map<string, Promise<SourceReadiness>>()
  const key = (sessionId: string | null | undefined) => sessionId || ''
  const cache = {
    invalidate() { revision++; ready.clear(); pending.clear() },
    remember(sessionId: string | null | undefined, source: string, items: Array<{ value: string }>) {
      if (source && hasConfiguredModel(items)) {
        ready.set(key(sessionId), { source, readiness: { status: 'ready' } })
      }
    },
    read(sessionId: string | null | undefined): Promise<SourceReadiness> {
      const id = key(sessionId)
      const saved = ready.get(id)
      if (saved) return Promise.resolve(saved)
      const existing = pending.get(id)
      if (existing) return existing
      const startedAt = revision
      const request = Promise.resolve().then(async () => {
        const source = await actions.loadSource(sessionId)
        const readiness = await readModelReadiness(() => actions.loadItems(source))
        if (revision !== startedAt) return cache.read(sessionId)
        const result = { source, readiness }
        if (readiness.status === 'ready') ready.set(id, result)
        return result
      }).catch(error => {
        if (revision !== startedAt) return cache.read(sessionId)
        throw error
      }).finally(() => { if (pending.get(id) === request) pending.delete(id) })
      pending.set(id, request)
      return request
    },
  }
  return cache
}

// Only a successful empty catalog means setup is missing. Failed reads must
// leave the draft in place and report the failure instead of opening settings.
export async function readModelReadiness(
  loadItems: () => Promise<Array<{ value: string }>>,
): Promise<ModelReadiness> {
  try {
    const items = await loadItems()
    return { status: hasConfiguredModel(items) ? 'ready' : 'unconfigured' }
  } catch (error) {
    return { status: 'unavailable', error }
  }
}

export async function openComposerModelSettings(
  sessionId: string | null | undefined,
  openSettings: (source: string) => void,
): Promise<void> {
  openSettings(await effectiveModelSource(sessionId))
}

export async function checkComposerModelConfiguration(
  sessionId: string | null | undefined,
  actions: {
    loadItems: (source: string) => Promise<Array<{ value: string }>>
    openSettings: (source: string) => void
    onUnavailable: (error: unknown) => void
    cache?: ReturnType<typeof createModelReadinessCache>
  },
): Promise<boolean> {
  let source: string, readiness: ModelReadiness
  try {
    if (actions.cache) ({ source, readiness } = await actions.cache.read(sessionId))
    else {
      source = await effectiveModelSource(sessionId)
      readiness = await readModelReadiness(() => actions.loadItems(source))
    }
  } catch (error) {
    actions.onUnavailable(error)
    return false
  }
  if (readiness.status === 'ready') return true
  if (readiness.status === 'unavailable') {
    actions.onUnavailable(readiness.error)
    return false
  }
  actions.openSettings(source)
  return false
}

// The subscription backends sit behind networks that often need a proxy. When the
// model catalog read fails with a timeout / unreachable error, the actionable fix is
// the network or proxy, not "try again", so the UI says so explicitly.
export function isLikelyNetworkError(error: unknown): boolean {
  const message = ((error as Error | null)?.message || String(error ?? '')).toLowerCase()
  return /timed?\s*out|timeout|network|enotfound|econnrefused|econnreset|econnaborted|etimedout|unreachable|fetch failed|socket|dns|proxy|no route|client closed/.test(message)
}
import { effectiveModelSource } from '../../pages/settings/model-shared'
import { isAutomaticCursorSelection } from './model-selection-values'

function hasConfiguredModel(items: Array<{ value: string }>): boolean {
  return items.some(item => item.value && item.value !== 'auto' && !isAutomaticCursorSelection(item.value))
}
