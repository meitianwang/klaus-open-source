export interface UsageSnapshotBase {
  mode: string
  fetchedAt?: number
  provider?: {
    state?: string
    accounts?: Array<{ state?: string }>
  }
}

export interface UsageCacheEntry<TSnapshot extends UsageSnapshotBase = UsageSnapshotBase> {
  snapshot: TSnapshot
  cachedAt: number
}

export interface UsageStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface UsageSnapshotCache<TSnapshot extends UsageSnapshotBase = UsageSnapshotBase> {
  get(mode: string, now?: number): UsageCacheEntry<TSnapshot> | null
  put(snapshot: TSnapshot, now?: number): void
  clear(): void
}

export type UsageLoadReason = 'open' | 'refresh' | 'session-change' | 'auth-change'

export const USAGE_SNAPSHOT_STORAGE_KEY = 'klaus.usage_snapshot_cache.v1'
export const USAGE_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const USAGE_SESSION_SWITCH_FRESH_MS = 30_000
const MAX_PERSISTED_MODES = 16

export function isCacheableUsageSnapshot(snapshot: UsageSnapshotBase | null | undefined): boolean {
  if (!snapshot || typeof snapshot.mode !== 'string' || !snapshot.mode) return false
  const provider = snapshot.provider
  if (!provider) return false
  if (provider.state === 'ok') return true
  if (Array.isArray(provider.accounts) && provider.accounts.some(acc => acc?.state === 'ok')) return true
  return false
}

export function createUsageSnapshotCache<TSnapshot extends UsageSnapshotBase = UsageSnapshotBase>(
  storage?: UsageStorageLike | null,
): UsageSnapshotCache<TSnapshot> {
  const entries = new Map<string, UsageCacheEntry<TSnapshot>>()
  let hydrated = false

  function hydrate(now: number) {
    if (hydrated) return
    hydrated = true
    if (!storage) return
    try {
      const raw = storage.getItem(USAGE_SNAPSHOT_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, { snapshot?: TSnapshot; cachedAt?: number }>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const [mode, item] of Object.entries(parsed)) {
        if (!item || typeof item.cachedAt !== 'number' || !Number.isFinite(item.cachedAt)) continue
        if (now < item.cachedAt || now - item.cachedAt >= USAGE_SNAPSHOT_MAX_AGE_MS) continue
        if (!item.snapshot || item.snapshot.mode !== mode || !isCacheableUsageSnapshot(item.snapshot)) continue
        entries.set(mode, { snapshot: item.snapshot, cachedAt: item.cachedAt })
      }
    } catch {
      // Ignore malformed local storage entries.
    }
  }

  function persist() {
    if (!storage) return
    try {
      const sorted = [...entries.entries()]
        .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
        .slice(0, MAX_PERSISTED_MODES)
      if (!sorted.length) {
        storage.removeItem(USAGE_SNAPSHOT_STORAGE_KEY)
        return
      }
      const out: Record<string, UsageCacheEntry<TSnapshot>> = {}
      for (const [mode, entry] of sorted) out[mode] = entry
      storage.setItem(USAGE_SNAPSHOT_STORAGE_KEY, JSON.stringify(out))
    } catch {
      // Quota or disabled storage does not block in-memory caching.
    }
  }

  return {
    get(mode: string, now = Date.now()) {
      if (!mode) return null
      hydrate(now)
      const entry = entries.get(mode)
      if (!entry) return null
      if (now < entry.cachedAt || now - entry.cachedAt >= USAGE_SNAPSHOT_MAX_AGE_MS) {
        entries.delete(mode)
        persist()
        return null
      }
      return entry
    },
    put(snapshot: TSnapshot, now = Date.now()) {
      if (!snapshot || typeof snapshot.mode !== 'string' || !snapshot.mode) return
      hydrate(now)
      if (isCacheableUsageSnapshot(snapshot)) {
        entries.set(snapshot.mode, { snapshot, cachedAt: now })
        persist()
      } else if (snapshot.provider?.state === 'signed_out') {
        if (entries.delete(snapshot.mode)) persist()
      }
    },
    clear() {
      hydrated = true
      entries.clear()
      try {
        storage?.removeItem(USAGE_SNAPSHOT_STORAGE_KEY)
      } catch {
        // Ignore storage errors on clear.
      }
    },
  }
}

interface PopoverBodyState<TSnapshot extends UsageSnapshotBase> {
  revision: number
  displayedMode: string | null
  displayedSnapshot: TSnapshot | null
}

const bodyStates = new WeakMap<HTMLElement, PopoverBodyState<UsageSnapshotBase>>()

function stateFor<TSnapshot extends UsageSnapshotBase>(body: HTMLElement): PopoverBodyState<TSnapshot> {
  let state = bodyStates.get(body) as PopoverBodyState<TSnapshot> | undefined
  if (!state) {
    state = { revision: 0, displayedMode: null, displayedSnapshot: null }
    bodyStates.set(body, state as PopoverBodyState<UsageSnapshotBase>)
  }
  return state
}

function setRefreshBusy(button: HTMLElement | null | undefined, busy: boolean) {
  if (!button) return
  if (busy) {
    button.classList.add('is-loading')
    button.setAttribute('aria-busy', 'true')
  } else {
    button.classList.remove('is-loading')
    button.removeAttribute('aria-busy')
  }
}

export function rerenderUsageDashboardIfDisplayed<TSnapshot extends UsageSnapshotBase>(
  body: HTMLElement | null | undefined,
  renderSnapshot: (snapshot: TSnapshot) => string,
): void {
  if (!body || !body.isConnected) return
  const state = stateFor<TSnapshot>(body)
  if (state.displayedSnapshot) {
    body.innerHTML = renderSnapshot(state.displayedSnapshot)
  }
}

export interface DriveUsageDashboardOptions<TSnapshot extends UsageSnapshotBase> {
  body: HTMLElement
  refreshBtn?: HTMLElement | null
  sessionId: string | null | undefined
  currentSessionId: () => string | null | undefined
  expectedMode: string | null
  reason: UsageLoadReason
  cache: UsageSnapshotCache<TSnapshot>
  fetchSnapshot: (
    sessionId?: string | null,
    options?: { force?: boolean },
  ) => Promise<{ ok?: boolean; snapshot?: TSnapshot; error?: string } | undefined> | undefined
  renderSnapshot: (snapshot: TSnapshot) => string
  renderLoading: () => string
  renderError: (message: string) => string
  onResolvedMode?: (sessionId: string | null | undefined, mode: string) => void
  now?: () => number
}

export async function driveUsageDashboardLoad<TSnapshot extends UsageSnapshotBase>(
  options: DriveUsageDashboardOptions<TSnapshot>,
): Promise<void> {
  const {
    body,
    refreshBtn,
    sessionId,
    currentSessionId,
    expectedMode,
    reason,
    cache,
    fetchSnapshot,
    renderSnapshot,
    renderLoading,
    renderError,
    onResolvedMode,
  } = options
  const now = options.now ?? Date.now
  const state = stateFor<TSnapshot>(body)
  const revision = ++state.revision
  const force = reason === 'refresh'

  if (reason === 'auth-change') {
    cache.clear()
    state.displayedMode = null
    state.displayedSnapshot = null
  }

  const nowMs = now()
  const cached = expectedMode && reason !== 'auth-change' ? cache.get(expectedMode, nowMs) : null

  if (
    reason === 'session-change'
    && expectedMode
    && state.displayedMode === expectedMode
    && cached
    && nowMs - cached.cachedAt < USAGE_SESSION_SWITCH_FRESH_MS
  ) {
    setRefreshBusy(refreshBtn, false)
    return
  }

  if (expectedMode && state.displayedMode === expectedMode && state.displayedSnapshot) {
    // Keep the currently visible snapshot in place while revalidating.
  } else if (cached) {
    body.innerHTML = renderSnapshot(cached.snapshot)
    state.displayedMode = cached.snapshot.mode
    state.displayedSnapshot = cached.snapshot
  } else {
    body.innerHTML = renderLoading()
    state.displayedMode = null
    state.displayedSnapshot = null
  }

  const isCurrent = () =>
    body.isConnected && state.revision === revision && sessionId === currentSessionId()

  setRefreshBusy(refreshBtn, true)
  try {
    const res = await fetchSnapshot(sessionId, force ? { force: true } : undefined)
    if (!isCurrent()) return
    setRefreshBusy(refreshBtn, false)
    if (!res?.ok || !res.snapshot) throw new Error(res?.error || 'unavailable')
    cache.put(res.snapshot, now())
    onResolvedMode?.(sessionId, res.snapshot.mode)
    body.innerHTML = renderSnapshot(res.snapshot)
    state.displayedMode = res.snapshot.mode
    state.displayedSnapshot = res.snapshot
  } catch (err) {
    if (!isCurrent()) return
    setRefreshBusy(refreshBtn, false)
    const canKeepCached = !force && state.displayedSnapshot !== null && isCacheableUsageSnapshot(state.displayedSnapshot)
    if (!canKeepCached) {
      state.displayedMode = null
      state.displayedSnapshot = null
      body.innerHTML = renderError((err as Error | null)?.message || String(err))
    }
  }
}
