// Unit tests for the sidebar sort modes (Codex sortMenu: priority vs updated).
import { describe, expect, test } from 'bun:test'
import { compareByAttentionState, sortSectionRows, storeSortMode, readStoredSortMode } from './sort'

function item(id: string, attention: 'waiting' | 'unread' | 'active' | 'idle', recencyAt: number) {
  return { id, attention, recencyAt }
}

describe('priority sort inside one section', () => {
  test('waiting rows lead, recency breaks ties, updated_at keeps host order', () => {
    const rows = [
      item('idle-old', 'idle', 10),
      item('active-new', 'active', 500),
      item('waiting-old', 'waiting', 20),
      item('unread-new', 'unread', 400),
      item('waiting-new', 'waiting', 300),
    ]
    const priority = sortSectionRows(rows, 'priority')
    expect(priority.map(r => r.id)).toEqual(['waiting-new', 'waiting-old', 'unread-new', 'active-new', 'idle-old'])
    // updated_at is a no-op: the host snapshot order stands.
    expect(sortSectionRows(rows, 'updated_at').map(r => r.id)).toEqual(rows.map(r => r.id))
  })

  test('the comparator never reorders equal entries (stable by host order)', () => {
    const a = item('a', 'unread', 100)
    const b = item('b', 'unread', 100)
    expect(compareByAttentionState(a, b)).toBe(0)
    const sorted = sortSectionRows([b, a], 'priority')
    expect(sorted.map(r => r.id)).toEqual(['b', 'a'])
  })
})

describe('sort mode persistence', () => {
  test('priority is remembered; updated_at clears the key', () => {
    const globalAny = globalThis as unknown as { localStorage?: Storage }
    const store = new Map<string, string>()
    const previous = globalAny.localStorage
    globalAny.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      get length() { return store.size },
    } as Storage
    try {
      storeSortMode('priority')
      expect(readStoredSortMode()).toBe('priority')
      storeSortMode('updated_at')
      expect(readStoredSortMode()).toBe('updated_at')
    } finally {
      globalAny.localStorage = previous
    }
  })
})
