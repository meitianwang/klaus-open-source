import { describe, expect, test } from 'bun:test'
import {
  createUsageSnapshotCache,
  driveUsageDashboardLoad,
  rerenderUsageDashboardIfDisplayed,
  type UsageSnapshotBase,
  type UsageStorageLike,
} from './usage-popover-cache'

interface TestSnapshot extends UsageSnapshotBase {
  mode: string
  provider: {
    state: string
    usedPercent?: number
    accounts?: Array<{ id: string; state: string; usedPercent?: number }>
  }
}

function createMemoryStorage(): UsageStorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
    dump: () => Object.fromEntries(map.entries()),
  }
}

function createFakeElement() {
  const classes = new Set<string>()
  const attrs = new Map<string, string>()
  return {
    innerHTML: '',
    isConnected: true,
    classList: {
      add: (cls: string) => { classes.add(cls) },
      remove: (cls: string) => { classes.delete(cls) },
      contains: (cls: string) => classes.has(cls),
    },
    setAttribute: (k: string, v: string) => { attrs.set(k, v) },
    removeAttribute: (k: string) => { attrs.delete(k) },
    getAttribute: (k: string) => attrs.get(k) ?? null,
  } as unknown as HTMLElement
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('usage popover stale-while-revalidate cache', () => {
  test('renders cold loading once, then paints cached snapshot in 0ms on reopen while spinning refresh icon', async () => {
    let now = 10_000
    let activeSession = 's-1'
    const storage = createMemoryStorage()
    const cache = createUsageSnapshotCache<TestSnapshot>(storage)
    const firstBody = createFakeElement()
    const firstBtn = createFakeElement()
    const firstFetch = deferred<{ ok: boolean; snapshot: TestSnapshot }>()

    const open1 = driveUsageDashboardLoad<TestSnapshot>({
      body: firstBody,
      refreshBtn: firstBtn,
      sessionId: activeSession,
      currentSessionId: () => activeSession,
      expectedMode: 'antigravity',
      reason: 'open',
      cache,
      fetchSnapshot: () => firstFetch.promise,
      renderSnapshot: snap => `bars:${snap.mode}:${snap.provider.usedPercent}`,
      renderLoading: () => 'LOADING_SPINNER',
      renderError: msg => `ERR:${msg}`,
      now: () => now,
    })

    // Cold open has no snapshot yet -> shows loading spinner and marks refresh busy.
    expect(firstBody.innerHTML).toBe('LOADING_SPINNER')
    expect(firstBtn.classList.contains('is-loading')).toBe(true)
    expect(firstBtn.getAttribute('aria-busy')).toBe('true')

    firstFetch.resolve({
      ok: true,
      snapshot: { mode: 'antigravity', provider: { state: 'ok', usedPercent: 18 } },
    })
    await open1

    expect(firstBody.innerHTML).toBe('bars:antigravity:18')
    expect(firstBtn.classList.contains('is-loading')).toBe(false)
    expect(firstBtn.getAttribute('aria-busy')).toBeNull()

    // Simulate closing and reopening (even from a newly hydrated storage-backed cache!).
    now += 45_000
    const hydratedCache = createUsageSnapshotCache<TestSnapshot>(storage)
    const secondBody = createFakeElement()
    const secondBtn = createFakeElement()
    const secondFetch = deferred<{ ok: boolean; snapshot: TestSnapshot }>()
    const seenOpts: Array<{ force?: boolean } | undefined> = []

    const open2 = driveUsageDashboardLoad<TestSnapshot>({
      body: secondBody,
      refreshBtn: secondBtn,
      sessionId: activeSession,
      currentSessionId: () => activeSession,
      expectedMode: 'antigravity',
      reason: 'open',
      cache: hydratedCache,
      fetchSnapshot: (_sid, opts) => {
        seenOpts.push(opts)
        return secondFetch.promise
      },
      renderSnapshot: snap => `bars:${snap.mode}:${snap.provider.usedPercent}`,
      renderLoading: () => 'LOADING_SPINNER',
      renderError: msg => `ERR:${msg}`,
      now: () => now,
    })

    // Synchronous 0ms render BEFORE IPC resolves — never flashes LOADING_SPINNER!
    expect(secondBody.innerHTML).toBe('bars:antigravity:18')
    expect(secondBtn.classList.contains('is-loading')).toBe(true)
    expect(seenOpts).toEqual([undefined])

    secondFetch.resolve({
      ok: true,
      snapshot: { mode: 'antigravity', provider: { state: 'ok', usedPercent: 24 } },
    })
    await open2

    expect(secondBody.innerHTML).toBe('bars:antigravity:24')
    expect(secondBtn.classList.contains('is-loading')).toBe(false)
  })

  test('same-mode session switch skips redundant fetch within freshness window, while manual refresh forwards force=true', async () => {
    let now = 50_000
    let activeSession = 's-a'
    let calls = 0
    const seenCalls: Array<{ sid?: string | null; force?: boolean }> = []
    const cache = createUsageSnapshotCache<TestSnapshot>(createMemoryStorage())
    const body = createFakeElement()
    const btn = createFakeElement()

    await driveUsageDashboardLoad<TestSnapshot>({
      body,
      refreshBtn: btn,
      sessionId: activeSession,
      currentSessionId: () => activeSession,
      expectedMode: 'antigravity',
      reason: 'open',
      cache,
      fetchSnapshot: async (sid, opts) => {
        calls++
        seenCalls.push({ sid, force: opts?.force })
        return { ok: true, snapshot: { mode: 'antigravity', provider: { state: 'ok', usedPercent: 10 * calls } } }
      },
      renderSnapshot: snap => `bars:${snap.mode}:${snap.provider.usedPercent}`,
      renderLoading: () => 'LOADING',
      renderError: msg => `ERR:${msg}`,
      now: () => now,
    })
    expect(calls).toBe(1)
    expect(body.innerHTML).toBe('bars:antigravity:10')

    // Switch to another session using the same model source 5s later -> 0 calls, 0 flicker!
    now += 5_000
    activeSession = 's-b'
    await driveUsageDashboardLoad<TestSnapshot>({
      body,
      refreshBtn: btn,
      sessionId: activeSession,
      currentSessionId: () => activeSession,
      expectedMode: 'antigravity',
      reason: 'session-change',
      cache,
      fetchSnapshot: async (sid, opts) => {
        calls++
        seenCalls.push({ sid, force: opts?.force })
        return { ok: true, snapshot: { mode: 'antigravity', provider: { state: 'ok', usedPercent: 99 } } }
      },
      renderSnapshot: snap => `bars:${snap.mode}:${snap.provider.usedPercent}`,
      renderLoading: () => 'LOADING',
      renderError: msg => `ERR:${msg}`,
      now: () => now,
    })
    expect(calls).toBe(1)
    expect(body.innerHTML).toBe('bars:antigravity:10')

    // Explicit click on refresh button -> keeps existing bars while in-flight and passes { force: true }!
    const manualDeferred = deferred<{ ok: boolean; snapshot: TestSnapshot }>()
    const manualPromise = driveUsageDashboardLoad<TestSnapshot>({
      body,
      refreshBtn: btn,
      sessionId: activeSession,
      currentSessionId: () => activeSession,
      expectedMode: 'antigravity',
      reason: 'refresh',
      cache,
      fetchSnapshot: (sid, opts) => {
        calls++
        seenCalls.push({ sid, force: opts?.force })
        return manualDeferred.promise
      },
      renderSnapshot: snap => `bars:${snap.mode}:${snap.provider.usedPercent}`,
      renderLoading: () => 'LOADING',
      renderError: msg => `ERR:${msg}`,
      now: () => now,
    })
    expect(body.innerHTML).toBe('bars:antigravity:10')
    expect(btn.classList.contains('is-loading')).toBe(true)
    expect(seenCalls[1]).toEqual({ sid: 's-b', force: true })

    manualDeferred.resolve({
      ok: true,
      snapshot: { mode: 'antigravity', provider: { state: 'ok', usedPercent: 42 } },
    })
    await manualPromise
    expect(body.innerHTML).toBe('bars:antigravity:42')
    expect(btn.classList.contains('is-loading')).toBe(false)

    // Language switch re-renders the displayed snapshot synchronously.
    rerenderUsageDashboardIfDisplayed<TestSnapshot>(body, snap => `zh-bars:${snap.mode}:${snap.provider.usedPercent}`)
    expect(body.innerHTML).toBe('zh-bars:antigravity:42')
  })

  test('background revalidation failure keeps cached bars, forced refresh surfaces errors, and auth-change purges cache', async () => {
    const storage = createMemoryStorage()
    const cache = createUsageSnapshotCache<TestSnapshot>(storage)
    cache.put({ mode: 'subscription', provider: { state: 'ok', usedPercent: 33 } }, 1_000)

    const body = createFakeElement()
    const btn = createFakeElement()

    // Open with cached bars when background IPC rejects -> preserves cached bars instead of blanking to error!
    await driveUsageDashboardLoad<TestSnapshot>({
      body,
      refreshBtn: btn,
      sessionId: 's-1',
      currentSessionId: () => 's-1',
      expectedMode: 'subscription',
      reason: 'open',
      cache,
      fetchSnapshot: async () => { throw new Error('network down') },
      renderSnapshot: snap => `bars:${snap.mode}:${snap.provider.usedPercent}`,
      renderLoading: () => 'LOADING',
      renderError: msg => `ERR:${msg}`,
      now: () => 2_000,
    })
    expect(body.innerHTML).toBe('bars:subscription:33')
    expect(btn.classList.contains('is-loading')).toBe(false)

    // Explicit manual refresh failure DOES surface the error truthfully!
    await driveUsageDashboardLoad<TestSnapshot>({
      body,
      refreshBtn: btn,
      sessionId: 's-1',
      currentSessionId: () => 's-1',
      expectedMode: 'subscription',
      reason: 'refresh',
      cache,
      fetchSnapshot: async () => { throw new Error('network down') },
      renderSnapshot: snap => `bars:${snap.mode}:${snap.provider.usedPercent}`,
      renderLoading: () => 'LOADING',
      renderError: msg => `ERR:${msg}`,
      now: () => 3_000,
    })
    expect(body.innerHTML).toBe('ERR:network down')

    // Auth change clears persisted cache so signed-out account never flashes old snapshot.
    await driveUsageDashboardLoad<TestSnapshot>({
      body,
      refreshBtn: btn,
      sessionId: 's-1',
      currentSessionId: () => 's-1',
      expectedMode: 'subscription',
      reason: 'auth-change',
      cache,
      fetchSnapshot: async () => ({ ok: true, snapshot: { mode: 'subscription', provider: { state: 'signed_out' } } }),
      renderSnapshot: snap => `state:${snap.provider.state}`,
      renderLoading: () => 'LOADING',
      renderError: msg => `ERR:${msg}`,
      now: () => 4_000,
    })
    expect(body.innerHTML).toBe('state:signed_out')
    expect(cache.get('subscription', 4_000)).toBeNull()
    expect(storage.dump()).toEqual({})
  })
})
