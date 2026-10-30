import { describe, expect, test } from 'bun:test'
import { captureTranscriptViewport, captureViewportAnchor, registerTranscriptViewport, restoredViewportRange, retireTranscriptViewport, scrollTopForViewportAnchor, transcriptViewportState, viewportRange, viewportRangeAtOffsets, type TranscriptViewportState } from './viewport-state'

const snapshot = (): TranscriptViewportState => ({
  distanceFromBottomPx: 1200,
  turnHeightsByKey: { middle: 300, last: 400 },
  renderedWindow: { anchorKey: 'middle', count: 2 },
  widthPx: 900,
})

describe('session-owned transcript viewport restoration', () => {
  test('a new transcript starts with a tail window and no empty placeholder range', () => {
    expect(viewportRange([0], 0, 600, 0)).toBeNull()
    expect(viewportRange([0, 400, 800, 1200, 1600], 0, 600, 0)).toEqual({ start: 2, end: 4 })
    expect(viewportRange([0, 400, 800, 1200, 1600], 800, 600, 0)).toEqual({ start: 0, end: 2 })
  })

  test('pixel windows preserve exact edges, empty rows and an available last row', () => {
    const offsets = [0, 100, 100, 200, 450]
    expect(viewportRangeAtOffsets(offsets, -50, 1)).toEqual({ start: 0, end: 1 })
    expect(viewportRangeAtOffsets(offsets, 99, 100)).toEqual({ start: 0, end: 1 })
    expect(viewportRangeAtOffsets(offsets, 100, 200)).toEqual({ start: 2, end: 3 })
    expect(viewportRangeAtOffsets(offsets, 100, 100)).toEqual({ start: 2, end: 3 })
    expect(viewportRangeAtOffsets(offsets, 200, 450)).toEqual({ start: 3, end: 4 })
    expect(viewportRangeAtOffsets(offsets, 900, 1200)).toEqual({ start: 3, end: 4 })
    expect(viewportRangeAtOffsets([0, 0, 0], 0, 0)).toEqual({ start: 1, end: 2 })
    expect(viewportRangeAtOffsets([0], 0, 100)).toBeNull()
  })

  test('locating a tail window does not read every preceding turn', () => {
    let reads = 0
    const offsets = new Proxy(new Array<number>(100_001), {
      get(target, key) {
        if (key === 'length') return target.length
        if (typeof key === 'string' && /^\d+$/.test(key)) { reads++; return Number(key) * 100 }
        return Reflect.get(target, key)
      },
    })
    expect(viewportRangeAtOffsets(offsets, 9_999_500, 10_000_000)).toEqual({ start: 99_995, end: 100_000 })
    expect(reads).toBeLessThan(50)
  })

  test('a saved window follows turn identities when earlier history is inserted', () => {
    const keys = ['older', 'first', 'middle', 'last']
    expect(restoredViewportRange(keys, [0, 100, 200, 500, 900], snapshot(), 600, 0)).toEqual({ start: 2, end: 4 })
    expect(restoredViewportRange(['other', 'last'], [0, 400, 800], snapshot(), 600, 0)).toEqual({ start: 0, end: 1 })
  })

  test('a virtual-window change preserves the anchor bottom distance instead of a clamped scrollTop', () => {
    const keys = ['first', 'middle', 'last']
    const oldOffsets = [0, 240, 480, 8520]
    const anchor = captureViewportAnchor(keys, oldOffsets, 8280, 672, 240, new Set(keys))!
    expect(anchor).toEqual({ key: 'last', bottomOffsetPx: 8520, distanceFromBottomPx: 240 })
    // The old window has already collapsed and clamped scrollTop to 2104 when
    // the new measurements arrive. Restoration must not consult that position.
    const measuredOffsets = [0, 3383, 3514, 12172]
    expect(scrollTopForViewportAnchor(anchor, keys, measuredOffsets, 12844, 672)).toBe(8280)
  })

  test('anchor capture handles boundaries and missing turns without inventing a position', () => {
    expect(captureViewportAnchor([], [0], 100, 600, 0, new Set())).toBeNull()
    expect(captureViewportAnchor(['only'], [0, 400], -20, 600, 0, new Set(['only']))).toEqual({ key: 'only', bottomOffsetPx: 400, distanceFromBottomPx: 0 })
    expect(captureViewportAnchor(['only'], [0, 400], 100, 600, 0, new Set())).toBeNull()
    expect(scrollTopForViewportAnchor({ key: 'missing', bottomOffsetPx: 400, distanceFromBottomPx: 40 }, ['only'], [0, 400], 1000, 600)).toBeNull()
  })

  test('captures each outgoing layout once and retires its measurements with its session', () => {
    const container = {} as HTMLElement
    let value = snapshot()
    const release = registerTranscriptViewport(container, 'viewport-capture-a', () => value)
    captureTranscriptViewport(container)
    value = { ...value, distanceFromBottomPx: 0 }
    captureTranscriptViewport(container)
    expect(transcriptViewportState('viewport-capture-a')?.distanceFromBottomPx).toBe(1200)
    retireTranscriptViewport('viewport-capture-a')
    captureTranscriptViewport(container)
    expect(transcriptViewportState('viewport-capture-a')).toBeUndefined()
    release()
  })

  test('a replacement reader owns subsequent snapshots without stale cleanup removing it', () => {
    const container = {} as HTMLElement
    const releaseA = registerTranscriptViewport(container, 'viewport-owner-a', snapshot)
    const releaseB = registerTranscriptViewport(container, 'viewport-owner-b', () => ({ ...snapshot(), distanceFromBottomPx: 48 }))
    releaseA()
    captureTranscriptViewport(container)
    expect(transcriptViewportState('viewport-owner-a')).toBeUndefined()
    expect(transcriptViewportState('viewport-owner-b')?.distanceFromBottomPx).toBe(48)
    releaseB()
    retireTranscriptViewport('viewport-owner-b')
  })
})
