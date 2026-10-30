import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mergeTurnSequence, type TurnSequenceRef } from './turn-sequence'

function r(key: string, savedIndex: number | null, turnId: string | null, startMs: number, savedKey?: string): TurnSequenceRef {
  return { key, savedIndex, savedKey, turnId, startMs }
}

function keys(frames: TurnSequenceRef[]) {
  return frames.map(f => f.key)
}

describe('mergeTurnSequence', () => {
  test('saved frames keep their order', () => {
    const saved = [r('s1', 0, 't1', 1000), r('s2', 1, 't2', 2000)]
    expect(keys(mergeTurnSequence(saved, [], []))).toEqual(['s1', 's2'])
  })

  test('a live-only older turn is placed before its saved continuation by observed order', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('stopped', null, 'stopped', 1000)]
    expect(keys(mergeTurnSequence(saved, live, ['stopped', 'continued']))).toEqual(['stopped', 'c'])
  })

  test('a live-only older turn stays in place when the continuation still exists live', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('stopped', null, 'stopped', 1000), r('c-live', 0, 'continued', 5000, 'c')]
    expect(keys(mergeTurnSequence(saved, live, ['stopped', 'continued']))).toEqual(['stopped', 'c'])
  })

  test('a newer live-only turn is appended after saved frames', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('newer', null, 'newer', 9000)]
    expect(keys(mergeTurnSequence(saved, live, ['continued', 'newer']))).toEqual(['c', 'newer'])
  })

  test('a trailing live-only run falls back to start time when not in observed order', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('stopped', null, 'stopped', 1000)]
    expect(keys(mergeTurnSequence(saved, live, []))).toEqual(['stopped', 'c'])
  })

  test('a trailing live-only run appends when it starts after every saved frame', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('stopped', null, 'stopped', 10000)]
    expect(keys(mergeTurnSequence(saved, live, []))).toEqual(['c', 'stopped'])
  })

  test('multiple live-only runs keep their order and anchor separately', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('a', null, 'a', 1000), r('b', null, 'b', 2000), r('c-live', 0, 'continued', 5000, 'c')]
    expect(keys(mergeTurnSequence(saved, live, ['a', 'b', 'continued']))).toEqual(['a', 'b', 'c'])
  })

  test('live frames that duplicate saved frames fold into the saved position', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('c-live', 0, 'continued', 5000, 'c')]
    expect(keys(mergeTurnSequence(saved, live, []))).toEqual(['c'])
  })

  test('live frames without a turn id are ordered by their live position anchors', () => {
    const saved = [r('c', 0, 'continued', 5000)]
    const live = [r('orphan', null, null, 1000), r('c-live', 0, 'continued', 5000, 'c')]
    expect(keys(mergeTurnSequence(saved, live, []))).toEqual(['orphan', 'c'])
  })
})
