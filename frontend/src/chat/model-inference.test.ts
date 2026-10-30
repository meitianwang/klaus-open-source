import { describe, expect, test } from 'bun:test'
import { inferenceSnapshot, nextModelUpdate } from './model-inference'
import type { ModelUpdateState } from '../../bridge/types'

const preparing: ModelUpdateState = { status: 'preparing', changeId: 'change-B', preferenceRevision: 10 }
const ready: ModelUpdateState = { ...preparing, status: 'ready', revision: 8 }

describe('model update event order', () => {
  test('a stale completion cannot clear a newer preparing state', () => {
    const newer = { ...preparing, preferenceRevision: 11, changeId: 'change-C' }
    expect(nextModelUpdate(newer, ready)).toBe(newer)
    expect(nextModelUpdate(newer, { ...ready, status: 'failed' })).toBe(newer)
  })

  test('a stale completion with another change id cannot clear a same-revision fence', () => {
    const newer = { ...preparing, changeId: 'change-C' }
    expect(nextModelUpdate(newer, ready)).toBe(newer)
    expect(nextModelUpdate(preparing, newer)).toEqual(newer)
  })

  test('terminal confirmation does not regress to preparing or stale failure', () => {
    expect(nextModelUpdate(ready, preparing)).toBe(ready)
    expect(nextModelUpdate(ready, { ...ready, status: 'failed' })).toBe(ready)
    expect(nextModelUpdate(preparing, ready)).toEqual(ready)
  })

  test('a direct ready event is accepted without synthesizing a captured request', () => {
    expect(nextModelUpdate(null, ready)).toEqual(ready)
  })

  test('rejects malformed update metadata instead of losing the known state', () => {
    for (const invalid of [null, {}, { ...ready, preferenceRevision: -1 }, { ...ready, changeId: '' }, { ...ready, status: 'applied' }]) {
      expect(nextModelUpdate(preparing, invalid)).toBe(preparing)
    }
  })
})

describe('public inference snapshot normalization', () => {
  test('preserves non-secret attribution only', () => {
    const inference = { revision: 8, changeId: 'change-B', model: 'same-model', source: 'codex' }
    expect(inferenceSnapshot({ ...inference, tier: 'high', selection: 'high', credential: 'secret', apiKey: 'secret' }))
      .toEqual({ ...inference, tier: 'high', selection: 'high' })
  })

  test('legacy and invalid snapshots are unknown, not guessed from preferences', () => {
    for (const invalid of [undefined, {}, { revision: 7 }, { revision: -1, model: 'A' }, { revision: 1.5, model: 'A' }]) {
      expect(inferenceSnapshot(invalid)).toBeNull()
    }
  })
})
