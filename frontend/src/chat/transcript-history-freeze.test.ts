// Contract for the running-conversation history freeze, pinned by
// contracts/vectors/transcript-history-freeze-vectors.json.
//
// A frozen history layer used to skip the read entirely, so a long session could
// not page up to its earlier turns until the in-flight turn settled. The freeze is
// now a SLICE: earlier turns may join history while the live layer keeps the
// current turn. The renderer concatenates history and live with no dedup, so the
// slice boundary is what keeps a row from being painted twice.
import { describe, expect, test } from 'bun:test'

import vectors from '../../../contracts/vectors/transcript-history-freeze-vectors.json'

// stream-store pulls in the renderer window surface; stub it before importing,
// exactly as stream-store.test.ts does.
;(globalThis as any).window = { addEventListener: () => {}, klaus: { session: {}, agents: {} } }
const { frozenHistorySlice, shouldReadHistoryDuringFreeze } = await import('./stream-store')

describe('transcript history freeze contract', () => {
  test('gate matches the committed vectors', () => {
    for (const vector of vectors.gate.cases) {
      expect({
        name: vector.name,
        read: shouldReadHistoryDuringFreeze(vector.input),
      }).toEqual({ name: vector.name, read: vector.expected })
    }
  })

  test('slice matches the committed vectors', () => {
    for (const vector of vectors.slice.cases) {
      const slice = frozenHistorySlice(vector.input)
      const expected = vector.expected as { apply: boolean; reason?: string; rowCount?: number }
      if (!expected.apply) {
        expect({ name: vector.name, slice: { apply: slice.apply, reason: (slice as any).reason } })
          .toEqual({ name: vector.name, slice: { apply: false, reason: expected.reason } })
      } else {
        expect({ name: vector.name, rowCount: (slice as any).rowCount })
          .toEqual({ name: vector.name, rowCount: expected.rowCount })
        // The taken rows must never include a live-owned turn.
        const excluded = new Set(vector.input.liveTurnIds)
        for (const row of (slice as any).rows) {
          expect(excluded.has(row.turnId)).toBe(false)
        }
      }
    }
  })

  test('the taken slice is a prefix of the read, so ordering survives', () => {
    const rows = [
      { turnId: 'turn-1' },
      { turnId: 'turn-1' },
      { turnId: 'turn-2' },
      { turnId: 'turn-3' },
    ]
    const slice = frozenHistorySlice({ liveTurnIds: ['turn-3'], rows, ownedRowCount: null })
    expect(slice.apply).toBe(true)
    expect((slice as any).rows).toEqual(rows.slice(0, 3))
  })
})
