import { describe, expect, test } from 'bun:test'
import vectorData from '../../../contracts/vectors/legacy-ui-state.json'
import {
  LEGACY_UI_STATE_CONSUMED, LEGACY_UI_STATE_KV_KEY, LEGACY_UI_STATE_LOCAL_MARKER,
} from '../../../contracts/legacy-ui-state'
import { bootstrapLegacyUiState, restoreLegacyUiState, type MigrationStorage } from './legacy-ui-state'

const vectors = vectorData as unknown as {
  limits: { valueChars: number }
  cases: Array<{ name: string; expectedStage: Record<string, string>; electron: Record<string, string>; expectedRestore: Record<string, string> }>
}

function fixture(entries: Record<string, string>, initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: MigrationStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
  }
  let staged: unknown = JSON.stringify({ version: 1, state: 'staged', entries })
  const writes: Array<[string, string]> = []
  const kv = {
    get: async (key: string) => { expect(key).toBe(LEGACY_UI_STATE_KV_KEY); return staged },
    set: async (key: string, value: string) => { writes.push([key, value]); staged = value },
  }
  return { data, storage, kv, writes, raw: () => staged, replace: (value: unknown) => { staged = value } }
}

describe('legacy UI state bootstrap', () => {
  for (const vector of vectors.cases) test(vector.name, async () => {
    const f = fixture(vector.expectedStage, vector.electron)
    expect(await restoreLegacyUiState(f.kv, f.storage)).toBe('restored')
    expect(Object.fromEntries(f.data)).toEqual({ ...vector.expectedRestore, [LEGACY_UI_STATE_LOCAL_MARKER]: '1' })
    expect(f.writes).toEqual([[LEGACY_UI_STATE_KV_KEY, LEGACY_UI_STATE_CONSUMED]])
    expect(f.raw()).toBe(LEGACY_UI_STATE_CONSUMED)
  })

  test('missing and consumed snapshots do not recreate local state or write completion prematurely', async () => {
    for (const raw of [null, undefined, LEGACY_UI_STATE_CONSUMED]) {
      const f = fixture({}); f.replace(raw)
      expect(await restoreLegacyUiState(f.kv, f.storage)).toBe(raw == null ? 'missing' : 'complete')
      expect(f.data.size).toBe(0); expect(f.writes).toEqual([])
    }
  })

  test('the renderer rejects malformed envelopes and any key outside the UI contract', async () => {
    for (const raw of [
      '{broken',
      JSON.stringify({ version: 2, state: 'staged', entries: { klaus_sidebar_collapsed: '1' } }),
      JSON.stringify({ version: 1, state: 'staged', entries: { klaus_sidebar_collapsed: '1', auth_mode: 'fixture-auth' } }),
      JSON.stringify({ version: 1, state: 'staged', entries: { klaus_welcome_draft: 42 } }),
      JSON.stringify({ version: 1, state: 'staged', entries: { klaus_welcome_draft: 'x'.repeat(vectors.limits.valueChars + 1) } }),
    ]) {
      const f = fixture({}); f.replace(raw)
      expect(await restoreLegacyUiState(f.kv, f.storage)).toBe('invalid')
      expect(f.data.size).toBe(0); expect(f.writes).toEqual([])
    }
  })

  test('a quota failure preserves the stage and retry only fills entries that are still missing', async () => {
    const f = fixture({ klaus_sidebar_collapsed: '1', klaus_welcome_draft: 'fixture draft' })
    const setItem = f.storage.setItem
    f.storage.setItem = (key, value) => {
      if (key === 'klaus_welcome_draft') throw new Error('fixture quota exceeded')
      setItem(key, value)
    }
    const staged = f.raw()
    expect(await restoreLegacyUiState(f.kv, f.storage)).toBe('retry')
    expect(f.raw()).toBe(staged); expect(f.data.has(LEGACY_UI_STATE_LOCAL_MARKER)).toBe(false)
    f.data.set('klaus_sidebar_collapsed', '0'); f.storage.setItem = setItem
    expect(await restoreLegacyUiState(f.kv, f.storage)).toBe('restored')
    expect(f.data.get('klaus_sidebar_collapsed')).toBe('0')
    expect(f.data.get('klaus_welcome_draft')).toBe('fixture draft')
  })

  test('failure to persist the local completion marker does not consume the stage', async () => {
    const f = fixture({ klaus_welcome_draft: 'fixture draft' }), setItem = f.storage.setItem
    f.storage.setItem = (key, value) => {
      if (key === LEGACY_UI_STATE_LOCAL_MARKER) throw new Error('fixture marker write denied')
      setItem(key, value)
    }
    expect(await restoreLegacyUiState(f.kv, f.storage)).toBe('retry')
    expect(f.writes).toEqual([])
    expect(f.data.has(LEGACY_UI_STATE_LOCAL_MARKER)).toBe(false)
  })

  test('a failed consume retries without resurrecting keys deleted after a completed restore', async () => {
    const f = fixture({ klaus_welcome_draft: 'fixture draft' }), set = f.kv.set
    f.kv.set = async () => { throw new Error('fixture settings write unavailable') }
    expect(await restoreLegacyUiState(f.kv, f.storage)).toBe('retry')
    expect(f.data.get(LEGACY_UI_STATE_LOCAL_MARKER)).toBe('1')
    f.data.delete('klaus_welcome_draft'); f.kv.set = set
    expect(await restoreLegacyUiState(f.kv, f.storage)).toBe('restored')
    expect(f.data.has('klaus_welcome_draft')).toBe(false)
    expect(f.raw()).toBe(LEGACY_UI_STATE_CONSUMED)
  })

  test('UI evaluation waits for restore and preserves choices made while the KV read was pending', async () => {
    const f = fixture({ klaus_sidebar_collapsed: '1', klaus_welcome_draft: 'fixture draft' })
    let resolveRead!: (value: unknown) => void
    f.kv.get = () => new Promise(resolve => { resolveRead = resolve })
    let started = false
    const boot = bootstrapLegacyUiState(f.kv, () => f.storage, async () => {
      started = true
      expect(f.data.get('klaus_sidebar_collapsed')).toBe('0')
      expect(f.data.get('klaus_welcome_draft')).toBe('fixture draft')
      expect(f.raw()).toBe(LEGACY_UI_STATE_CONSUMED)
    })
    await Promise.resolve(); expect(started).toBe(false)
    f.data.set('klaus_sidebar_collapsed', '0')
    resolveRead(f.raw()); await boot
    expect(started).toBe(true)
  })

  test('unavailable host or localStorage still starts the application after the failed attempt', async () => {
    const f = fixture({}), states: string[] = []
    f.kv.get = async () => { states.push('read'); throw new Error('fixture host unavailable') }
    await bootstrapLegacyUiState(f.kv, () => f.storage, async () => { states.push('start') })
    expect(states).toEqual(['read', 'start'])
    states.length = 0
    await bootstrapLegacyUiState(f.kv, () => { throw new Error('fixture storage unavailable') }, async () => { states.push('start') })
    expect(states).toEqual(['start']); expect(f.writes).toEqual([])
  })
})
