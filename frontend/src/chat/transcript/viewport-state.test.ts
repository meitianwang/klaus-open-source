import { describe, expect, test } from 'bun:test'
import { activateTranscriptViewport, captureTranscriptViewport, registerTranscriptViewport, retireTranscriptViewport, transcriptViewportState, type TranscriptViewportState } from './viewport-state'

const snapshot = (): TranscriptViewportState => ({
  distanceFromBottomPx: 1200,
  turnHeightsByKey: { middle: 300, last: 400 },
  renderedWindow: { anchorKey: 'middle', count: 2 },
  widthPx: 900,
})

describe('session-owned transcript viewport restoration', () => {
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

  test('a retained tab captures a fresh position on every activation', () => {
    const container = {} as HTMLElement
    let distance = 1200
    const release = registerTranscriptViewport(container, 'retained-tab', () => ({ ...snapshot(), distanceFromBottomPx: distance }))
    captureTranscriptViewport(container)
    distance = 800
    activateTranscriptViewport(container)
    captureTranscriptViewport(container)
    expect(transcriptViewportState('retained-tab')?.distanceFromBottomPx).toBe(800)
    release()
    retireTranscriptViewport('retained-tab')
  })
})
