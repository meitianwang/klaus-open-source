import { describe, expect, test } from 'bun:test'
import type { ComputerUsePipState } from '../../bridge/types'
import { acceptPipState, computePipAnchors, pipTaskActive, pipTaskShown, scaledPipRect } from './computer-use-pip-model'

const state = (changes: Partial<ComputerUsePipState> = {}): ComputerUsePipState => ({
  supported: true, revision: 4, activeTaskIds: ['a', 'b'],
  taskVisibilities: { a: 'shown', b: 'hidden' }, alwaysHidePictureInPicture: false,
  maxDisplaySize: 200, ...changes,
})

describe('native picture in picture state', () => {
  test('activity exists before any frame and is independent of visibility', () => {
    expect(pipTaskActive(state(), 'a')).toBe(true)
    expect(pipTaskActive(state(), 'b')).toBe(true)
    expect(pipTaskShown(state(), 'a')).toBe(true)
    expect(pipTaskShown(state(), 'b')).toBe(false)
  })
  test('switching to an inactive task or empty draft never inherits another task', () => {
    for (const id of ['c', null]) {
      expect(pipTaskActive(state(), id)).toBe(false)
      expect(pipTaskShown(state(), id)).toBe(false)
    }
  })
  test('global hidden and unavailable host suppress shown tasks', () => {
    expect(pipTaskShown(state({ alwaysHidePictureInPicture: true }), 'a')).toBe(false)
    expect(pipTaskActive(state({ supported: false }), 'a')).toBe(false)
    expect(pipTaskShown(state({ taskVisibilities: {} }), 'a')).toBe(false)
  })
  test('late initial reads and action replies cannot undo a newer native push', () => {
    const pushed = state({ revision: 9, taskVisibilities: { a: 'hidden' } })
    expect(acceptPipState(pushed, state())).toBe(pushed)
    expect(acceptPipState(pushed, state({ revision: Number.NaN }))).toBe(pushed)
    const next = state({ revision: 10 })
    expect(acceptPipState(pushed, next)).toBe(next)
  })
})

describe('native picture in picture layout vectors', () => {
  const host = { x: 100, y: 50, width: 1200, height: 900 }
  test('four anchors refer to corresponding corners with a 24 point inset', () => {
    expect(computePipAnchors(host, [], null)).toEqual([
      { alignment: 'top-left', point: { x: 124, y: 74 } },
      { alignment: 'top-right', point: { x: 1276, y: 74 } },
      { alignment: 'bottom-left', point: { x: 124, y: 926 } },
      { alignment: 'bottom-right', point: { x: 1276, y: 926 } },
    ])
  })
  test('top corners prefer moving down and bottom corners prefer moving up', () => {
    const anchors = computePipAnchors(host, [
      { x: 120, y: 70, width: 260, height: 260 },
      { x: 1020, y: 670, width: 260, height: 260 },
    ], null)
    expect(anchors[0].point).toEqual({ x: 124, y: 342 })
    expect(anchors[3].point).toEqual({ x: 1276, y: 658 })
  })
  test('a home surface anchors the top right below its bottom with a 12 point gap', () => {
    const home = { x: 950, y: 60, width: 300, height: 220 }
    expect(computePipAnchors(host, [home], home)[1]).toEqual({
      alignment: 'top-right', point: { x: 1250, y: 292 },
    })
  })
  test('collision scoring finds a clear horizontal candidate when downward movement is blocked', () => {
    const anchors = computePipAnchors(host, [
      { x: 100, y: 50, width: 280, height: 400 },
      { x: 100, y: 400, width: 280, height: 550 },
    ], null)
    expect(anchors[0].point).toEqual({ x: 392, y: 74 })
  })
  test('a viewport smaller than the planning footprint still yields finite anchors', () => {
    const anchors = computePipAnchors({ x: 0, y: 0, width: 180, height: 140 }, [], null)
    expect(anchors[0].point).toEqual({ x: 24, y: 24 })
    expect(anchors[3].point).toEqual({ x: 274, y: 274 })
  })
  test('webview zoom scales host and obstacle geometry without using display pixel ratio', () => {
    expect(scaledPipRect({ x: 100, y: 50, width: 800, height: 600 }, 1.25))
      .toEqual({ x: 80, y: 40, width: 640, height: 480 })
    expect(scaledPipRect(host, 0)).toEqual(host)
  })
})
