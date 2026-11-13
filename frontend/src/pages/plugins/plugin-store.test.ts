import { describe, expect, test } from 'bun:test'
import { PluginStore, operationPending, type PluginItem, type MutationResult } from './plugin-store'

const row = (id: string): PluginItem => ({ id, installed: true, enabled: false, installedVersion: '1.0.0', availableVersion: '2.0.0', updateAvailable: true })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  let rows = [row('a@local'), { ...row('b@local'), enabled: true }]
  const pending: Array<{ id: string; resolve(value: MutationResult): void }> = []
  const calls: string[] = []
  let failRead = false
  const api = {
    market: async () => { if (failRead) throw new Error('Catalog unavailable'); return { plugins: structuredClone(rows) } },
    refresh: async () => ({ ok: true }),
    update: (id: string) => {
      calls.push(id)
      return new Promise<MutationResult>(resolve => pending.push({ id, resolve: result => {
        if (result.ok) rows = rows.map(item => item.id === id ? { ...item, installedVersion: '2.0.0', updateAvailable: false } : item)
        resolve(result)
      } }))
    },
    install: async () => ({ ok: true }), toggle: async () => ({ ok: true }), uninstall: async () => ({ ok: true }),
  }
  const store = new PluginStore({ api: () => api })
  return { store, api, calls, pending, failReads: () => { failRead = true }, get rows() { return rows } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('plugin operation lifecycle', () => {
  test('separate updates are accepted while the writer serializes them and repeated clicks share one request', async () => {
    const f = fixture(); await f.store.load()
    const first = f.store.update(f.rows[0]!), duplicate = f.store.update(f.rows[0]!), second = f.store.update(f.rows[1]!)
    expect(first).toBe(duplicate)
    expect(operationPending(f.store.getSnapshot().operations['a@local'])).toBe(true)
    expect(f.store.getSnapshot().operations['b@local']?.phase).toBe('queued')
    await tick(); expect(f.calls).toEqual(['a@local'])
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0', activationScope: 'next_turn' })
    expect(await first).toBe(true)
    await tick(); expect(f.calls).toEqual(['a@local', 'b@local'])
    expect(f.store.getSnapshot().operations['a@local']?.phase).toBe('success')
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0', activationScope: 'next_turn' })
    expect(await second).toBe(true)
    expect(f.store.getSnapshot().data?.plugins.map(item => item.enabled)).toEqual([false, true])
  })

  test('operations finish with no mounted subscriber and keep their result for a later view', async () => {
    const f = fixture(); await f.store.load()
    const unsubscribe = f.store.subscribe(() => {})
    const operation = f.store.update(f.rows[0]!)
    unsubscribe(); await tick()
    f.pending.shift()!.resolve({ ok: true, activationScope: 'next_turn', version: '2.0.0' })
    await operation
    expect(f.store.getSnapshot().operations['a@local']?.result?.activationScope).toBe('next_turn')
    expect(f.store.getSnapshot().data?.plugins[0]?.installedVersion).toBe('2.0.0')
  })

  test('a persisted update remains successful when its follow-up catalog read fails', async () => {
    const f = fixture(); await f.store.load()
    const operation = f.store.update(f.rows[0]!); await tick(); f.failReads()
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0', restartRequired: true })
    expect(await operation).toBe(true)
    const state = f.store.getSnapshot()
    expect(state.operations['a@local']?.phase).toBe('success')
    expect(state.data?.plugins[0]?.installedVersion).toBe('2.0.0')
    expect(state.data?.plugins[0]?.updateAvailable).toBe(false)
    expect(state.data?.restartRequired).toBe(true)
    expect(state.readError).toBe('Catalog unavailable')
  })

  test('a failed item preserves the installed version and can retry without blocking the next item', async () => {
    const f = fixture(); await f.store.load()
    const first = f.store.update(f.rows[0]!), second = f.store.update(f.rows[1]!); await tick()
    f.pending.shift()!.resolve({ ok: false, error: 'Network connection failed' })
    expect(await first).toBe(false); await tick()
    expect(f.store.getSnapshot().data?.plugins[0]?.installedVersion).toBe('1.0.0')
    expect(f.store.getSnapshot().operations['a@local']?.error).toBe('Network connection failed')
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0' }); await second
    const retry = f.store.update(f.rows[0]!); await tick()
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0' }); expect(await retry).toBe(true)
    expect(f.calls).toEqual(['a@local', 'b@local', 'a@local'])
  })

  test('a failed receipt keeps its diagnostic log path and timestamp on the operation', async () => {
    const f = fixture(); await f.store.load()
    const first = f.store.update(f.rows[0]!); await tick()
    f.pending.shift()!.resolve({ ok: false, error: 'Install validation failed', diagnosticLog: '/tmp/plugin-failure.log' })
    expect(await first).toBe(false)
    const operation = f.store.getSnapshot().operations['a@local']
    expect(operation?.phase).toBe('error')
    expect(operation?.error).toBe('Install validation failed')
    expect(operation?.diagnosticLog).toBe('/tmp/plugin-failure.log')
    expect(typeof operation?.failedAt).toBe('number')
  })

  test('batch updates count partial success, retain failures and do not submit a second batch', async () => {
    const f = fixture(); await f.store.load()
    const batch = f.store.updateAll(); await f.store.updateAll(); await tick()
    f.pending.shift()!.resolve({ ok: false, error: 'Package checksum failed' }); await tick()
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0' }); await batch
    expect(f.calls).toEqual(['a@local', 'b@local'])
    expect(f.store.getSnapshot().batch).toEqual({ total: 2, completed: 2, failed: 1, running: false })
    expect(f.store.getSnapshot().operations['a@local']?.phase).toBe('error')
    expect(f.store.getSnapshot().operations['b@local']?.phase).toBe('success')
    const retry = f.store.update(f.rows[0]!)
    expect(f.store.getSnapshot().batch).toBe(null)
    await tick(); f.pending.shift()!.resolve({ ok: true, version: '2.0.0' }); await retry
  })

  test('checks coalesce while in flight and a check failure keeps cached plugins visible', async () => {
    const f = fixture(), pending = deferred<unknown>(); await f.store.load()
    f.api.refresh = () => pending.promise as Promise<{ ok: boolean }>
    const first = f.store.check(), second = f.store.check(true)
    expect(first).toBe(second)
    pending.resolve({ ok: false, error: 'Network unavailable' }); await first
    expect(f.store.getSnapshot().data?.plugins).toHaveLength(2)
    expect(f.store.getSnapshot().refreshError).toBe('Network unavailable')
    expect(f.store.getSnapshot().checking).toBe(false)
  })

  test('slow display reads do not hold the writer queue or swallow an accepted follow-up toggle', async () => {
    const f = fixture(); await f.store.load()
    const blocked = deferred<{ plugins: PluginItem[] }>()
    f.api.market = () => blocked.promise
    let toggles = 0
    f.api.toggle = async () => { toggles++; return { ok: true } }
    const first = f.store.update(f.rows[0]!), second = f.store.update(f.rows[1]!); await tick()
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0' })
    expect(await first).toBe(true); await tick()
    expect(f.calls).toEqual(['a@local', 'b@local'])
    const toggle = f.store.toggle(f.rows[0]!, true)
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0' }); await second; await toggle
    expect(toggles).toBe(1)
    blocked.resolve({ plugins: f.rows })
  })

  test('a successful background check clears an earlier visible check failure', async () => {
    const f = fixture()
    let error: string | undefined = 'Network unavailable'
    const store = new PluginStore({ api: () => ({ ...f.api,
      refresh: async () => ({ ok: false, error }),
      market: async () => ({ plugins: f.rows, updateCheck: { checking: false, error } }),
    }) })
    await store.check()
    expect(store.getSnapshot().refreshError).toBe('Network unavailable')
    error = undefined
    await store.load()
    expect(store.getSnapshot().refreshError).toBe(null)
  })

  test('late pre-update reads cannot revert a confirmed installed version', async () => {
    const f = fixture(); await f.store.load()
    const pending = deferred<{ plugins: PluginItem[] }>()
    const previousMarket = f.api.market
    f.api.market = () => pending.promise
    const oldRead = f.store.load()
    const update = f.store.update(f.rows[0]!); await tick()
    f.api.market = previousMarket
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0' }); await update
    pending.resolve({ plugins: [row('a@local'), row('b@local')] }); await oldRead
    expect(f.store.getSnapshot().data?.plugins[0]?.installedVersion).toBe('2.0.0')
  })

  test('attaches live progress only to running operations and drops stale post-settle pushes', async () => {
    let listener: ((event: any) => void) | undefined
    const f = fixture()
    const store = new PluginStore({
      api: () => f.api,
      onProgress: cb => { listener = cb; return () => { listener = undefined } },
    })
    await store.load()
    const op = store.update(f.rows[0]!); await tick()
    listener?.({ id: 'a@local', action: 'update', stage: 'downloading', percent: 41, transferred: 50, total: 100, bytesPerSecond: 25, cancellable: true })
    expect(store.getSnapshot().operations['a@local']?.progress?.percent).toBe(41)
    f.pending.shift()!.resolve({ ok: true, version: '2.0.0' })
    expect(await op).toBe(true)
    listener?.({ id: 'a@local', action: 'update', stage: 'extracting', percent: 92, transferred: 100, total: 100, bytesPerSecond: 0, cancellable: true })
    expect(store.getSnapshot().operations['a@local']?.progress).toBeUndefined()
  })

  test('cancelling a queued item skips IPC and cancelling a running item clears without a failure receipt', async () => {
    const cancelledCalls: string[] = []
    const f = fixture()
    const store = new PluginStore({
      api: () => ({
        ...f.api,
        cancel: async (id: string) => { cancelledCalls.push(id); return { ok: true, cancelled: true } },
      }),
    })
    await store.load()
    const first = store.update(f.rows[0]!)
    const second = store.update(f.rows[1]!)
    await tick()
    expect(store.getSnapshot().operations['b@local']?.phase).toBe('queued')
    expect(await store.cancel('b@local')).toBe(true)
    expect(store.getSnapshot().operations['b@local']).toBeUndefined()

    expect(await store.cancel('a@local')).toBe(true)
    expect(store.getSnapshot().operations['a@local']?.cancelling).toBe(true)
    expect(cancelledCalls).toEqual(['a@local'])
    f.pending.shift()!.resolve({ ok: false, cancelled: true })
    expect(await first).toBe(false)
    expect(await second).toBe(false)
    expect(f.calls).toEqual(['a@local'])
    expect(store.getSnapshot().operations['a@local']).toBeUndefined()
  })
})
