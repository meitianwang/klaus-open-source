import { describe, expect, test } from 'bun:test'
import { BrowserFrameScope } from './browser-frame-scope'

describe('browser frame ownership', () => {
  test('a frame needs the current task and its authoritative host revision', () => {
    const scope = new BrowserFrameScope()
    expect(scope.accepts({ sessionId: 'a', focusRevision: 1 }, 'a')).toBe(false)
    expect(scope.update({ conversationId: 'a', focusRevision: 1 }, 'a')).toBe(true)
    expect(scope.accepts({ sessionId: 'a', focusRevision: 1 }, 'a')).toBe(true)
    expect(scope.accepts({ sessionId: 'a', focusRevision: 1 }, 'b')).toBe(false)
    expect(scope.accepts({ sessionId: 'a', focusRevision: 2 }, 'a')).toBe(false)
  })

  test('an old image decode cannot paint after a task round trip', () => {
    const scope = new BrowserFrameScope()
    scope.update({ conversationId: 'a', focusRevision: 1 }, 'a')
    const decodingGeneration = scope.generation
    scope.invalidate()
    scope.update({ conversationId: 'b', focusRevision: 2 }, 'b')
    scope.invalidate()
    scope.update({ conversationId: 'a', focusRevision: 3 }, 'a')
    expect(scope.accepts({ sessionId: 'a', focusRevision: 1 }, 'a', decodingGeneration)).toBe(false)
    expect(scope.accepts({ sessionId: 'a', focusRevision: 3 }, 'a')).toBe(true)
    expect(scope.update({ conversationId: 'a', focusRevision: 1 }, 'a')).toBe(false)
  })

  test('background state cannot replace the visible task or lower the revision', () => {
    const scope = new BrowserFrameScope()
    scope.update({ conversationId: 'a', focusRevision: 4 }, 'a')
    expect(scope.update({ conversationId: 'b', focusRevision: 5 }, 'a')).toBe(false)
    expect(scope.update({ conversationId: 'a', focusRevision: 4 }, 'a')).toBe(false)
    expect(scope.accepts({ sessionId: 'b', focusRevision: 5 }, 'a')).toBe(false)
    expect(scope.accepts({ sessionId: 'a', focusRevision: 4 }, 'a')).toBe(false)
  })

  test('legacy unscoped frames still obey decode invalidation', () => {
    const scope = new BrowserFrameScope()
    const generation = scope.generation
    expect(scope.accepts({}, 'manual', generation)).toBe(true)
    scope.invalidate()
    expect(scope.accepts({}, 'manual', generation)).toBe(false)
  })
})
