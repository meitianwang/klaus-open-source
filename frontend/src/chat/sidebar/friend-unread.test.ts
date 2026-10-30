import { describe, expect, test } from 'bun:test'
import { createFriendUnreadLedger } from './friend-unread'

function memoryLedger() {
  let stored: string | null = null
  return {
    ledger: createFriendUnreadLedger(() => stored, value => { stored = value }),
    raw: () => stored,
  }
}

describe('friend unread ledger', () => {
  test('counts arrivals per session and across sessions', () => {
    const { ledger } = memoryLedger()
    expect(ledger.add('friend-a')).toBe(1)
    expect(ledger.add('friend-a')).toBe(2)
    expect(ledger.add('friend-b')).toBe(1)
    expect(ledger.countOf('friend-a')).toBe(2)
    expect(ledger.countOf('friend-b')).toBe(1)
    expect(ledger.countOf('missing')).toBe(0)
    expect(ledger.total()).toBe(3)
  })

  test('clearing one session leaves the others and reaches zero total', () => {
    const { ledger } = memoryLedger()
    ledger.add('friend-a', 2)
    ledger.add('friend-b')
    expect(ledger.clearSession('friend-a')).toBe(true)
    expect(ledger.clearSession('friend-a')).toBe(false)
    expect(ledger.countOf('friend-a')).toBe(0)
    expect(ledger.total()).toBe(1)
    ledger.clearAll()
    expect(ledger.total()).toBe(0)
  })

  test('persists across ledger instances and survives corrupt storage', () => {
    const first = memoryLedger()
    first.ledger.add('friend-a', 3)
    const stored = first.raw()
    expect(stored).toContain('friend-a')
    let backing = stored
    const reopened = createFriendUnreadLedger(() => backing, value => { backing = value })
    expect(reopened.countOf('friend-a')).toBe(3)
    const corrupt = createFriendUnreadLedger(() => '{not json', () => {})
    expect(corrupt.total()).toBe(0)
    const arrayish = createFriendUnreadLedger(() => '["friend-a"]', () => {})
    expect(arrayish.total()).toBe(0)
  })

  test('caps counts at the sidebar display ceiling and ignores bad adds', () => {
    const { ledger } = memoryLedger()
    expect(ledger.add('friend-a', 200)).toBe(99)
    expect(ledger.add('friend-a')).toBe(99)
    expect(ledger.add('', 5)).toBe(0)
    expect(ledger.add('friend-b', 0)).toBe(0)
    expect(ledger.total()).toBe(99)
  })

  test('tracks whether the newest arrival awaits a reply', () => {
    const { ledger } = memoryLedger()
    ledger.add('friend-a', 1, true)
    expect(ledger.wantReplyOf('friend-a')).toBe(true)
    ledger.add('friend-a', 1, false)
    expect(ledger.wantReplyOf('friend-a')).toBe(false)
    ledger.add('friend-b')
    expect(ledger.wantReplyOf('friend-b')).toBe(false)
    expect(ledger.wantReplyOf('missing')).toBe(false)
  })

  test('round-trips the want-reply flag and reads legacy numeric entries as plain unread', () => {
    const first = memoryLedger()
    first.ledger.add('friend-a', 2, true)
    let backing = first.raw()
    const reopened = createFriendUnreadLedger(() => backing, value => { backing = value })
    expect(reopened.wantReplyOf('friend-a')).toBe(true)
    expect(reopened.countOf('friend-a')).toBe(2)
    const legacy = createFriendUnreadLedger(() => '{"friend-old":4}', () => {})
    expect(legacy.countOf('friend-old')).toBe(4)
    expect(legacy.wantReplyOf('friend-old')).toBe(false)
  })
})
