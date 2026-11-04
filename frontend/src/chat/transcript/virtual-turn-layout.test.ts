import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/session-transcript-surface-vectors.json'
import {
  DEFAULT_TURN_ESTIMATE_PX, TURN_OVERSCAN_COUNT, buildTurnLayout, captureRestoreState,
  distanceCenteringTurn, distanceKeepingAnchor, initialWindowState, nextWindowState,
  rangeAnchoredOnKey, turnRangeForDistance, viewportAnchorKey,
} from './virtual-turn-layout'

const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `turn-${index}`, estimatedHeightPx: 100 }))

describe('virtual transcript geometry', () => {
  test('matches the committed estimates and turn-count overscan', () => {
    expect(DEFAULT_TURN_ESTIMATE_PX).toBe(vectors.presentation.defaultTurnEstimatePx)
    expect(TURN_OVERSCAN_COUNT).toBe(vectors.presentation.virtualTurnOverscan)
    const layout = buildTurnLayout(entries(20), {})
    expect(turnRangeForDistance(layout, 700, 200, 0)).toEqual({ startIndex: 11, endIndex: 13 })
    expect(turnRangeForDistance(layout, 700, 200, TURN_OVERSCAN_COUNT)).toEqual({ startIndex: 9, endIndex: 15 })
    expect(turnRangeForDistance(layout, 0, 200, TURN_OVERSCAN_COUNT)).toEqual({ startIndex: 16, endIndex: 20 })
  })

  test('total geometry includes measured heights, gaps and minimum heights', () => {
    const layout = buildTurnLayout([{ key: 'a' }, { key: 'gap', estimatedHeightPx: 144, gapBeforePx: 8 },
      { key: 'b', estimatedHeightPx: 200, minHeightPx: 240 }], { a: 123.3, b: 100 }, { pixelScale: 2 })
    expect(layout.heightsPx).toEqual([123.5, 144, 240])
    expect(layout.topOffsetsPx).toEqual([0, 131.5, 275.5])
    expect(layout.bottomOffsetsPx).toEqual([392, 240, 0])
    expect(layout.totalHeightPx).toBe(515.5)
  })

  test('history prepends do not change the reading distance for an existing anchor', () => {
    const old = buildTurnLayout(entries(20), {})
    const next = buildTurnLayout([{ key: 'older', estimatedHeightPx: 500 }, ...entries(20)], {})
    expect(distanceKeepingAnchor('turn-12', 700, old, next)).toBe(700)
    const enlargedBelow = buildTurnLayout(entries(20), { 'turn-19': 300 })
    expect(distanceKeepingAnchor('turn-12', 700, old, enlargedBelow)).toBe(900)
    const enlargedAbove = buildTurnLayout(entries(20), { 'turn-0': 300 })
    expect(distanceKeepingAnchor('turn-12', 700, old, enlargedAbove)).toBe(700)
  })

  test('the visible measured turn anchors across insertion and resizing', () => {
    const layout = buildTurnLayout(entries(8), {})
    const args = { distanceFromBottomPx: 150, viewportHeightPx: 220, layout, nextLayout: layout,
      measuredHeightsByKey: { 'turn-4': 100, 'turn-5': 100, 'turn-6': 100 }, preferLatestVisible: false }
    expect(viewportAnchorKey(args)).toBe('turn-5')
    expect(viewportAnchorKey({ ...args, preferLatestVisible: true })).toBe('turn-6')
    expect(viewportAnchorKey({ ...args, measuredHeightsByKey: {} })).toBeNull()
    const removed = buildTurnLayout(entries(8).filter(entry => entry.key !== 'turn-5'), {})
    expect(viewportAnchorKey({ ...args, nextLayout: removed })).toBe('turn-6')
  })

  test('an already sufficient render window survives small scrolling changes', () => {
    const layout = buildTurnLayout(entries(20), {})
    const state = { distanceFromBottomPx: 700, viewportHeightPx: 200, turnKeys: layout.turnKeys,
      renderedRange: { startIndex: 8, endIndex: 16 } }
    const moved = nextWindowState(state, 710, layout, 200)
    expect(moved.renderedRange).toBe(state.renderedRange)
    expect(nextWindowState(moved, 710, layout, 200)).toBe(moved)
    expect(nextWindowState(moved, 1600, layout, 200).renderedRange).toEqual({ startIndex: 0, endIndex: 6 })
  })

  test('restoration follows stable turn keys when older pages are added', () => {
    const original = buildTurnLayout(entries(20), {})
    const state = captureRestoreState({ 'turn-8': 150, 'turn-9': 160, removed: 999 }, original.turnKeys,
      { startIndex: 8, endIndex: 12 })!
    expect(state).toEqual({ turnHeightsByKey: { 'turn-8': 150, 'turn-9': 160 }, renderedWindow: { anchorKey: 'turn-8', count: 4 } })
    const next = buildTurnLayout([{ key: 'older' }, ...entries(20)], state.turnHeightsByKey)
    expect(initialWindowState(next, 700, state).renderedRange).toEqual({ startIndex: 9, endIndex: 13 })
    expect(rangeAnchoredOnKey(next, 'removed', { startIndex: 8, endIndex: 12 })).toBeNull()
    expect(captureRestoreState({}, [], { startIndex: 0, endIndex: 0 })).toBeNull()
  })

  test('empty lists and targets removed during navigation have no invented geometry', () => {
    const layout = buildTurnLayout([], {})
    expect(turnRangeForDistance(layout, 900, 500, 2)).toEqual({ startIndex: 0, endIndex: 0 })
    expect(distanceCenteringTurn(layout, 'missing', 600)).toBeNull()
    expect(distanceKeepingAnchor('missing', 50, layout, layout)).toBeNull()
    const populated = buildTurnLayout(entries(20), {})
    expect(distanceCenteringTurn(populated, 'turn-10', 600)).toBe(650)
  })
})
