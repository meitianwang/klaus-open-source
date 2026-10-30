import { expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/model-readiness-vectors.json'
import { checkComposerModelConfiguration, createModelCatalogCache, createModelReadinessCache, isLikelyNetworkError, openComposerModelSettings, readModelReadiness } from './model-readiness'

test('a timeout reading the catalog is flagged as a network problem', () => {
  // The subscription backends sit behind networks that may need a proxy; a timeout must
  // surface as "check your network/proxy", not a bare "try again".
  expect(isLikelyNetworkError(new Error('app-server request timed out: codex/models'))).toBe(true)
  expect(isLikelyNetworkError(new Error('fetch failed'))).toBe(true)
  expect(isLikelyNetworkError(new Error('connect ETIMEDOUT 104.18.0.1:443'))).toBe(true)
  expect(isLikelyNetworkError(new Error('app-server client closed'))).toBe(true)
})

test('a genuine configuration or auth failure is NOT flagged as a network problem', () => {
  expect(isLikelyNetworkError(new Error('The selected provider is unavailable'))).toBe(false)
  expect(isLikelyNetworkError(new Error('Codex login needs renewal; reuse the local login'))).toBe(false)
  expect(isLikelyNetworkError(new Error('invalid mode'))).toBe(false)
})

for (const row of vectors.cases) {
  test(row.name, async () => {
    const result = await readModelReadiness(async () => {
      if (row.error) throw new Error(row.error)
      return row.items || []
    })
    expect(result.status).toBe(row.status)
  })
}

test('a retry can recover without changing model configuration', async () => {
  const failed = await readModelReadiness(async () => { throw new Error('app-server client closed') })
  const recovered = await readModelReadiness(async () => [{ value: 'codex:model' }])
  expect(failed.status).toBe('unavailable')
  expect(recovered.status).toBe('ready')
})

for (const row of vectors.sourceRouting) {
  test(`${row.name}: send and empty-picker actions use the effective source`, async () => {
    const global = globalThis as any
    const previousWindow = global.window
    global.window = {
      currentSessionId: 'main',
      klaus: {
        session: { getMainModel: async (id: string) => ({
          mode: 'auto',
          source: !id ? row.defaultSource : id === row.sessionId ? row.savedSource : 'qoder',
          resolvedMode: null,
        }) },
        settings: { kv: { get: async () => row.defaultSource } },
      },
    }
    const readSources: string[] = []
    const opened: string[] = []
    const failures: unknown[] = []
    const openSettings = (source: string) => { opened.push(source) }
    try {
      // A failed transport must keep the draft on the current screen.
      expect(await checkComposerModelConfiguration(row.sessionId, {
        loadItems: async source => { readSources.push(source); throw new Error('app-server client closed') },
        openSettings,
        onUnavailable: error => { failures.push(error) },
      })).toBe(false)
      expect(readSources).toEqual([row.expectedSource])
      expect(opened).toEqual([])
      expect(failures).toHaveLength(1)

      // Real missing setup and an explicit empty-picker click open Codex,
      // even though the separately remembered default source is Qoder.
      await checkComposerModelConfiguration(row.sessionId, {
        loadItems: async () => [], openSettings, onUnavailable: () => {},
      })
      await openComposerModelSettings(row.sessionId, openSettings)
      expect(opened).toEqual([row.expectedSource, row.expectedSource])
    } finally {
      global.window = previousWindow
    }
  })
}

test('an unreadable session source preserves the draft without opening another source', async () => {
  const global = globalThis as any
  const previousWindow = global.window
  global.window = {
    klaus: { session: { getMainModel: async () => { throw new Error('session unavailable') } } },
  }
  const loaded: string[] = []
  const opened: string[] = []
  const failures: unknown[] = []
  try {
    expect(await checkComposerModelConfiguration('session-1', {
      loadItems: async source => { loaded.push(source); return [] },
      openSettings: source => { opened.push(source) },
      onUnavailable: error => { failures.push(error) },
    })).toBe(false)
    expect(loaded).toEqual([])
    expect(opened).toEqual([])
    expect(failures).toHaveLength(1)
  } finally {
    global.window = previousWindow
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('concurrent cold pickers and sends share one catalog and a warm send reuses successful readiness', async () => {
  const read = deferred<Array<{ value: string }>>()
  let catalogs = 0, sources = 0
  const catalog = createModelCatalogCache(async (_source: string) => { catalogs++; return read.promise })
  const readiness = createModelReadinessCache({
    loadSource: async () => { sources++; return 'codex' }, loadItems: source => catalog.load(source),
  })
  const first = readiness.read('side')
  const second = readiness.read('side')
  const picker = catalog.load('codex')
  await Promise.resolve(); await Promise.resolve()
  read.resolve([{ value: 'codex:fixture' }])
  expect((await first).readiness.status).toBe('ready')
  expect(await second).toEqual(await first)
  expect(await picker).toEqual([{ value: 'codex:fixture' }])
  expect((await readiness.read('side')).readiness.status).toBe('ready')
  expect(catalogs).toBe(vectors.cache.successfulCatalogReads)
  expect(sources).toBe(vectors.cache.successfulSourceReads)
})

test('failed or unconfigured readiness remains retryable and does not cache failure', async () => {
  let attempts = 0
  const readiness = createModelReadinessCache({ loadSource: async () => 'codex', loadItems: async () => {
    attempts++
    if (attempts === 1) throw new Error('app-server client closed')
    if (attempts === 2) return []
    return [{ value: 'codex:fixture' }]
  } })
  expect((await readiness.read('side')).readiness.status).toBe('unavailable')
  expect((await readiness.read('side')).readiness.status).toBe('unconfigured')
  expect((await readiness.read('side')).readiness.status).toBe('ready')
  expect(attempts).toBe(vectors.cache.retryAttempts)
})

test('an invalidation during a pending source read cannot admit a send with the previous source', async () => {
  const oldSource = deferred<string>()
  let sourceReads = 0
  const loaded: string[] = []
  const readiness = createModelReadinessCache({
    loadSource: async () => ++sourceReads === 1 ? oldSource.promise : 'custom',
    loadItems: async source => { loaded.push(source); return [{ value: `${source}:fixture` }] },
  })
  const pending = readiness.read('side')
  await Promise.resolve()
  readiness.invalidate()
  oldSource.resolve('codex')
  expect((await pending).source).toBe(vectors.cache.sourceAfterInvalidation)
  expect((await readiness.read('side')).source).toBe('custom')
  expect(sourceReads).toBe(2)
  expect(loaded.at(-1)).toBe('custom')
})

test('an invalidated catalog result never replaces the current catalog', async () => {
  const stale = deferred<Array<{ value: string }>>()
  let reads = 0
  const catalog = createModelCatalogCache(async () => ++reads === 1 ? stale.promise : [{ value: 'codex:new' }])
  const pending = catalog.load('codex')
  await Promise.resolve()
  catalog.invalidate()
  const fresh = catalog.load('codex')
  stale.resolve([{ value: 'codex:old' }])
  expect(await pending).toEqual(await fresh)
  expect(catalog.get('codex')).toEqual([{ value: 'codex:new' }])
})

test('per-session readiness retains source isolation while a source catalog is shared', async () => {
  const readiness = createModelReadinessCache({
    loadSource: async id => id === 'main' ? 'custom' : 'codex',
    loadItems: async source => [{ value: `${source}:fixture` }],
  })
  readiness.remember('main', 'custom', [{ value: 'custom:fixture' }])
  expect((await readiness.read('main')).source).toBe('custom')
  expect((await readiness.read('side')).source).toBe('codex')
})
