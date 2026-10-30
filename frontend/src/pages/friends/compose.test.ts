import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { replaceComposerReferenceRange } from '../../chat/composer/reference-token'
import { FRIEND_COMPOSE_EVENT, composeFriendTask, takeQueuedFriendCompose } from './compose'

let previousWindow: unknown
beforeEach(() => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = new EventTarget()
  takeQueuedFriendCompose()
})
afterEach(() => {
  takeQueuedFriendCompose()
  ;(globalThis as any).window = previousWindow
})

describe('friend composer handoff', () => {
  test('retains a request until the chat listener is mounted and consumes it once', () => {
    composeFriendTask('friend-1', 'Alice')
    const request = takeQueuedFriendCompose()!
    expect(request).toMatchObject({ friendId: 'friend-1', name: 'Alice' })
    expect(takeQueuedFriendCompose()).toBeNull()
    const inserted = replaceComposerReferenceRange('', 0, 0, '', {
      kind: 'friend', id: request.friendId, name: request.name, value: request.value,
    })
    expect(inserted.text).toBe(`${request.value} `)
    expect(inserted.caret).toBe(inserted.text.length)
    expect(inserted.reference).toMatchObject({ kind: 'friend', id: 'friend-1', range: { start: 0, end: request.value.length } })
  })
  test('publishes the request after queuing it so the listener can drain synchronously', () => {
    const seen: unknown[] = []
    window.addEventListener(FRIEND_COMPOSE_EVENT, event => {
      seen.push((event as CustomEvent).detail)
      expect(takeQueuedFriendCompose()).toEqual((event as CustomEvent).detail)
    })
    composeFriendTask('friend-2', 'Bob')
    expect(seen).toHaveLength(1)
    expect(takeQueuedFriendCompose()).toBeNull()
  })
})
