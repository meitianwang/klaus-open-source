import { describe, expect, test } from 'bun:test'
import {
  extendHistoryBoundary,
  insertHistorySegment,
  nextHistoryBoundary,
  ownsHistoryBoundary,
  type HistoryBoundary,
  type HistoryBoundaryRequest,
  type HistoryPolicy,
  type HistorySegment,
  type HistoryTopology,
} from './history-topology'

interface Message {
  id: string | null
  position: number
  text: string
  revision: number
}

type History = HistoryTopology<Message, string>
const policy: HistoryPolicy<Message> = {
  identity: message => message.id,
  position: entry => entry.value.position,
  merge: (previous, incoming) => incoming.revision >= previous.revision ? incoming : previous,
}
const empty = (generation = 4): History => ({ generation, isComplete: false, islands: [] })
const exhausted = (): HistoryBoundary<string> => ({ status: 'exhausted' })
const available = (cursor: string): HistoryBoundary<string> => ({ status: 'available', progressKey: cursor, handle: cursor })
const entry = (position: number, text = `message ${position}`, revision = 1, key = `render:${position}`) => ({
  key, value: { id: `m${position}`, position, text, revision },
})
const segment = (
  positions: number[],
  olderBoundary: HistoryBoundary<string> = exhausted(),
  newerBoundary: HistoryBoundary<string> = exhausted(),
): HistorySegment<Message, string> => ({ entries: positions.map(position => entry(position)), olderBoundary, newerBoundary })
const messages = (history: History) => history.islands.flatMap(island => island.entries.map(value => value.value))
const positions = (history: History) => messages(history).map(message => message.position)
function request(history: History, complete = false): HistoryBoundaryRequest<string> {
  const value = nextHistoryBoundary(history, complete)
  if (!value) throw new Error('Expected an available history boundary')
  return value
}

function splitHistory(): History {
  const newest = insertHistorySegment(empty(), 'newest', segment([30, 31], available('before-30')), policy)
  return insertHistorySegment(newest, 'oldest', segment([10, 11], exhausted(), available('after-11')), policy)
}

describe('history segment placement', () => {
  test('orders disconnected islands and only marks history complete when a bridge joins both ends', () => {
    const before = splitHistory()
    expect(positions(before)).toEqual([10, 11, 30, 31])
    expect(before.islands.map(island => island.id)).toEqual(['oldest', 'newest'])
    expect(before.isComplete).toBe(false)

    const bridge = insertHistorySegment(before, 'bridge', segment([11, 20, 30], available('bridge-old'), available('bridge-new')), policy)
    expect(bridge.islands).toHaveLength(1)
    expect(positions(bridge)).toEqual([10, 11, 20, 30, 31])
    expect(bridge.isComplete).toBe(true)
    expect(nextHistoryBoundary(bridge, true)).toBeNull()
    expect(before.islands).toHaveLength(2)
    expect(positions(before)).toEqual([10, 11, 30, 31])
  })

  test('merges a segment spanning three islands without losing rows outside the incoming window', () => {
    let history = insertHistorySegment(empty(), 'left', segment([1, 3], available('older-left'), available('newer-left')), policy)
    history = insertHistorySegment(history, 'middle', segment([8, 9], available('older-middle'), available('newer-middle')), policy)
    history = insertHistorySegment(history, 'right', segment([14, 15], available('older-right'), available('newer-right')), policy)
    history = insertHistorySegment(history, 'spanning', segment([3, 7, 10, 14], available('older-bridge'), available('newer-bridge')), policy)

    expect(positions(history)).toEqual([1, 3, 7, 8, 9, 10, 14, 15])
    expect(history.islands).toHaveLength(1)
    const older = request(history)
    expect(older.handle).toBe('older-left')
    const expanded = extendHistoryBoundary(history, older, segment([0], exhausted()), policy)
    expect(expanded.status).toBe('applied')
    expect(request(expanded.history, true).handle).toBe('newer-right')
  })

  test('uses entity identity for deduplication while retaining the original render key and newest content', () => {
    const original = insertHistorySegment(empty(), 'original', segment([1, 2]), policy)
    const incoming = segment([2, 3])
    incoming.entries[0] = entry(2, 'revised content', 2, 'replacement-render-key')
    const merged = insertHistorySegment(original, 'overlap', incoming, policy)

    expect(positions(merged)).toEqual([1, 2, 3])
    expect(merged.islands[0].entries.find(item => item.value.id === 'm2')).toEqual({
      key: 'render:2', value: { id: 'm2', position: 2, text: 'revised content', revision: 2 },
    })
    const olderRevision = segment([2])
    olderRevision.entries[0] = entry(2, 'stale content', 1, 'third-render-key')
    const replayed = insertHistorySegment(merged, 'replay', olderRevision, policy)
    expect(messages(replayed).find(message => message.id === 'm2')?.text).toBe('revised content')
    expect(positions(original)).toEqual([1, 2])
    expect(messages(original)[1].text).toBe('message 2')
  })

  test('keeps distinct identities and anonymous messages even when their content and position match', () => {
    const first = { key: 'anonymous:first', value: { id: null, position: 1, text: 'same text', revision: 1 } }
    const second = { key: 'anonymous:second', value: { ...first.value } }
    const named = { key: 'named:first', value: { ...first.value, id: 'first' } }
    const other = { key: 'named:second', value: { ...first.value, id: 'second' } }
    const history = insertHistorySegment(empty(), 'messages', {
      ...segment([]), entries: [first, second, named, other],
    }, policy)
    expect(history.islands[0].entries.map(item => item.key)).toEqual([
      'anonymous:first', 'anonymous:second', 'named:first', 'named:second',
    ])
  })
})

describe('history boundary requests', () => {
  test('rejects a response from an earlier generation without changing current history', () => {
    const history = insertHistorySegment(empty(), 'window', segment([10], available('cursor-1')), policy)
    const pending = request(history)
    const refreshed = { ...history, generation: history.generation + 1 }
    expect(ownsHistoryBoundary(refreshed, pending, (a, b) => a === b)).toBe(false)
    const result = extendHistoryBoundary(refreshed, pending, segment([9], exhausted()), policy)
    expect(result.status).toBe('stale')
    expect(result.history).toBe(refreshed)
    expect(positions(result.history)).toEqual([10])
  })

  test('rejects stale progress after another response advances the same boundary', () => {
    const history = insertHistorySegment(empty(), 'window', segment([10], available('cursor-1')), policy)
    const pending = request(history)
    expect(ownsHistoryBoundary(history, pending, (a, b) => a === b)).toBe(true)
    expect(ownsHistoryBoundary(history, { ...pending, handle: 'other-source' }, (a, b) => a === b)).toBe(false)
    const first = extendHistoryBoundary(history, pending, segment([9], available('cursor-2')), policy)
    expect(first.status).toBe('applied')
    expect(positions(first.history)).toEqual([9, 10])
    expect(ownsHistoryBoundary(first.history, pending, (a, b) => a === b)).toBe(false)
    const stale = extendHistoryBoundary(first.history, pending, segment([8], exhausted()), policy)
    expect(stale.status).toBe('rejected')
    expect(stale.history).toBe(first.history)
    expect(request(stale.history).handle).toBe('cursor-2')
  })

  test('rejects a page that repeats its progress token even when it contains new rows', () => {
    const history = insertHistorySegment(empty(), 'window', segment([10], available('cursor-1')), policy)
    const repeated = extendHistoryBoundary(history, request(history), segment([9], available('cursor-1')), policy)
    expect(repeated.status).toBe('rejected')
    expect(repeated.history).toBe(history)
    expect(positions(repeated.history)).toEqual([10])
    expect(request(repeated.history).handle).toBe('cursor-1')
  })

  test('accepts an empty terminal page once and never reuses the exhausted boundary', () => {
    const history = insertHistorySegment(empty(), 'window', segment([10], available('cursor-1')), policy)
    const pending = request(history)
    const result = extendHistoryBoundary(history, pending, segment([], exhausted()), policy)
    expect(result.status).toBe('applied')
    expect(positions(result.history)).toEqual([10])
    expect(result.history.isComplete).toBe(true)
    expect(nextHistoryBoundary(result.history, true)).toBeNull()
    expect(extendHistoryBoundary(result.history, pending, segment([9]), policy).status).toBe('rejected')
  })

  test('keeps an outstanding outer boundary usable after an overlap changes its island owner', () => {
    let history = insertHistorySegment(empty(), 'older', segment([1, 2], available('before-1'), available('after-2')), policy)
    const pending = request(history)
    history = insertHistorySegment(history, 'newer', segment([5, 6], available('before-5')), policy)
    history = insertHistorySegment(history, 'bridge', segment([2, 3, 5]), policy)
    expect(history.islands.map(island => island.id)).toEqual(['newer'])
    const applied = extendHistoryBoundary(history, pending, segment([0], exhausted()), policy)
    expect(applied.status).toBe('applied')
    expect(positions(applied.history)).toEqual([0, 1, 2, 3, 5, 6])
    expect(applied.history.isComplete).toBe(true)
  })

  test('complete traversal can fill an interior gap when the oldest outer edge is exhausted', () => {
    const history = splitHistory()
    expect(nextHistoryBoundary(history)).toBeNull()
    const gap = request(history, true)
    expect(gap.edge).toBe('newer')
    expect(gap.handle).toBe('after-11')
    const applied = extendHistoryBoundary(history, gap, segment([11, 20, 30], exhausted(), available('after-30')), policy)
    expect(applied.status).toBe('applied')
    expect(positions(applied.history)).toEqual([10, 11, 20, 30, 31])
    expect(applied.history.isComplete).toBe(true)
  })
})
