import { describe, expect, test } from 'bun:test'

const globalWindow = globalThis as any
globalWindow.window = globalWindow

const data = await import('./data')

function fulfilled(value: unknown): PromiseFulfilledResult<unknown> {
  return { status: 'fulfilled', value }
}

function rejected(reason: unknown): PromiseRejectedResult {
  return { status: 'rejected', reason }
}

function reset() {
  data.invalidateSkillsDataCache()
  globalWindow.klaus = { skills: {} }
}

describe('skills data lifecycle', () => {
  test('normalization preserves usable sections and exposes every partial failure', () => {
    reset()
    const result = data.normalizeSkillsData(
      rejected(new Error('installed offline')),
      fulfilled({ items: [{ name: 'market' }], nextCursor: 'next', isRemote: true, error: 'remote degraded' }),
      fulfilled({ items: [{ name: 'builtin' }], error: { message: 'engine roster unavailable' } }),
    )
    expect(result.installed).toEqual([])
    expect(result.market).toEqual([{ name: 'market' }])
    expect(result.builtin).toEqual([{ name: 'builtin' }])
    expect(result.errors).toEqual({
      installed: 'installed offline',
      market: 'remote degraded',
      builtin: 'engine roster unavailable',
    })
    expect(result.marketNextCursor).toBe('next')
    expect(result.marketIsRemote).toBe(true)
  })

  test('one rejected endpoint does not hide the other skill sections', async () => {
    reset()
    globalWindow.klaus.skills = {
      list: () => Promise.reject(new Error('list failed')),
      market: () => Promise.resolve({ items: [{ name: 'market' }], nextCursor: null, isRemote: false }),
      builtin: () => Promise.resolve({ items: [{ name: 'builtin' }], error: null }),
    }
    const result = await data.loadSkillsData()
    expect(result.market).toHaveLength(1)
    expect(result.builtin).toHaveLength(1)
    expect(result.errors.installed).toBe('list failed')
  })

  test('an invalid response is reported instead of silently becoming an empty list', async () => {
    reset()
    globalWindow.klaus.skills = {
      list: () => Promise.resolve({ rows: [] }),
      market: () => Promise.resolve({ items: [], nextCursor: null, isRemote: false }),
      builtin: () => Promise.resolve({ items: [], error: null }),
    }
    const result = await data.loadSkillsData()
    expect(result.errors.installed).toContain('invalid response')
  })

  test('invalidating during an in-flight prewarm prevents stale cache resurrection', async () => {
    reset()
    let finishList!: (value: unknown) => void
    const list = new Promise(resolve => { finishList = resolve })
    globalWindow.klaus.skills = {
      list: () => list,
      market: () => Promise.resolve({ items: [], nextCursor: null, isRemote: true }),
      builtin: () => Promise.resolve({ items: [], error: null }),
    }
    const pending = data.loadSkillsData()
    data.invalidateSkillsDataCache()
    finishList([])
    await pending
    expect(data.getSkillsCache()).toBeNull()
    expect(data.marketCursor).toBeNull()
    expect(data.marketIsRemote).toBe(false)
  })

  test('replacing a remote query updates its pagination and transport state together', async () => {
    reset()
    globalWindow.klaus.skills = {
      list: () => Promise.resolve([]),
      market: () => Promise.resolve({ items: [], nextCursor: 'old', isRemote: true }),
      builtin: () => Promise.resolve({ items: [], error: null }),
    }
    await data.loadSkillsData()
    data.replaceMarketInCache([{ name: 'fallback' }], null, false)
    expect(data.getSkillsCache()?.market).toEqual([{ name: 'fallback' }])
    expect(data.marketCursor).toBeNull()
    expect(data.marketIsRemote).toBe(false)
  })
})
