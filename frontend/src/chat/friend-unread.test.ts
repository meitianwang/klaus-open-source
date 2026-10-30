import { describe, expect, test } from 'bun:test'
import { friendMessageUnreadTracker } from './friend-unread'

function fixture() {
  const rows = new Map<string, string>()
  const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value) } }
  const incoming = (id: string, extra = {}) => ({ sessionId: 'friend-chat', message: { uuid: id, message: { localRender: { externalFriendMessage: true, friendIntent: 'notice', ...extra } } } })
  return { storage, incoming }
}

describe('friend display message unread identities', () => {
  test('claims a notice once across replay and reload without a model completion', () => {
    const f = fixture(), tracker = friendMessageUnreadTracker(f.storage, 'seen')
    expect(tracker.accept(f.incoming('notice-one'))).toBe(true)
    expect(tracker.accept(f.incoming('notice-one'))).toBe(false)
    expect(friendMessageUnreadTracker(f.storage, 'seen').accept(f.incoming('notice-one'))).toBe(false)
    expect(tracker.accept(f.incoming('notice-two'))).toBe(true)
  })
  test('does not mark local sends, ordinary user input, or missing identities', () => {
    const f = fixture(), tracker = friendMessageUnreadTracker(f.storage, 'seen')
    expect(tracker.accept(f.incoming('local', { friendOutgoingMessage: true }))).toBe(false)
    expect(tracker.accept({ sessionId: 's', message: { uuid: 'owner', message: { localRender: {} } } })).toBe(false)
    expect(tracker.accept({ sessionId: 's', message: { message: { localRender: { externalFriendMessage: true } } } })).toBe(false)
  })
  test('keeps reply identities per conversation and limits persisted history', () => {
    const f = fixture(), tracker = friendMessageUnreadTracker(f.storage, 'seen', 2)
    expect(tracker.accept(f.incoming('reply-one', { friendIntent: 'request', replyType: 'completed' }))).toBe(true)
    expect(tracker.accept({ ...f.incoming('reply-one'), sessionId: 'different-chat' })).toBe(true)
    expect(tracker.accept(f.incoming('reply-two'))).toBe(true)
    const stored = JSON.parse(f.storage.getItem('seen')!)
    expect(stored).toHaveLength(2)
    expect(stored[0]).toContain('different-chat')
  })
})
