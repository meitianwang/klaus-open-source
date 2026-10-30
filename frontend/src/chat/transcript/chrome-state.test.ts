import { describe, expect, test } from 'bun:test'
import { transcriptChromeState, transcriptContentPresence } from './chrome-state'
import vectors from '../../../../contracts/vectors/session-transcript-surface-vectors.json'

const state = (overrides: Partial<Parameters<typeof transcriptChromeState>[0]> = {}) => transcriptChromeState({
  sessionId: 'persisted-session',
  draftOnly: false,
  running: false,
  liveUnitCount: 0,
  history: null,
  ...overrides,
})

describe('transcript chrome state', () => {
  test('matches the committed session surface contract', () => {
    for (const vector of vectors.cases) {
      expect({ name: vector.name, state: transcriptChromeState(vector.input) })
        .toEqual({ name: vector.name, state: vector.expected })
    }
  })

  test('reserves the welcome surface for a real new-chat draft', () => {
    expect(state({ sessionId: null })).toBe('welcome')
    expect(state({ draftOnly: true })).toBe('welcome')
  })

  test('keeps an existing session in loading state until history answers', () => {
    expect(state({ history: null })).toBe('loading')
    expect(state({ history: undefined })).toBe('loading')
  })

  test('renders an empty transcript surface for a proven empty real conversation', () => {
    expect(state({ history: [] })).toBe('transcript')
    expect(state({ history: [{ role: 'user', text: 'Existing content' }] })).toBe('transcript')
    expect(transcriptContentPresence({ running: false, liveUnitCount: 0, history: null })).toBe('unknown')
    expect(transcriptContentPresence({ running: false, liveUnitCount: 0, history: [] })).toBe('empty')
    expect(transcriptContentPresence({ running: false, liveUnitCount: 0, history: [{}] })).toBe('present')
  })

  test('live or running work always owns the transcript surface', () => {
    expect(state({ running: true, history: null })).toBe('transcript')
    expect(state({ liveUnitCount: 1, history: null })).toBe('transcript')
  })
})
