import { describe, expect, test } from 'bun:test'
import {
  createChannelUnreadLedger,
  extractInboundHostTurnFrame,
  type InboundChannelFrameEvent,
} from './channel-unread'
import { formatChannelUnreadBadge, sumChannelUnreadCount } from './secondary-module-panes'

function memoryLedger() {
  let stored: string | null = null
  return {
    ledger: createChannelUnreadLedger(() => stored, value => { stored = value }),
    raw: () => stored,
  }
}

function inboundFrame(sessionId: string, uuid: string, extraRender: Record<string, unknown> = {}): InboundChannelFrameEvent {
  return {
    type: 'user_message',
    sessionId,
    message: {
      uuid,
      message: {
        localRender: { inputPresentation: 'turn', ...extraRender },
      },
    },
  }
}

describe('channel unread ledger', () => {
  test('counts sequential inbound channel turns without double-counting turn completion or engine echoes', () => {
    const { ledger } = memoryLedger()
    expect(ledger.noteInboundFrame(inboundFrame('wechat-1', 'u-1'), { knownChannel: true })).toBe(true)
    expect(ledger.countOf('wechat-1')).toBe(1)

    // Duplicate delivery of the same frame id or canonical engine echo without host inputPresentation is ignored.
    expect(ledger.noteInboundFrame(inboundFrame('wechat-1', 'u-1'), { knownChannel: true })).toBe(false)
    expect(ledger.noteInboundFrame({
      type: 'user_message',
      sessionId: 'wechat-1',
      message: { uuid: 'engine-item-1', message: {} },
    }, { knownChannel: true })).toBe(false)

    // Turn completion consumes the active inbound turn flag instead of incrementing a second time.
    expect(ledger.noteTurnCompleted('wechat-1', { knownChannel: true })).toBe(false)
    expect(ledger.countOf('wechat-1')).toBe(1)

    // Subsequent inbound messages keep accumulating on the same session.
    expect(ledger.noteInboundFrame(inboundFrame('wechat-1', 'u-2'), { knownChannel: true })).toBe(true)
    expect(ledger.noteTurnCompleted('wechat-1', { knownChannel: true })).toBe(false)
    expect(ledger.noteInboundFrame(inboundFrame('wechat-1', 'u-3'), { knownChannel: true })).toBe(true)
    expect(ledger.noteTurnCompleted('wechat-1', { knownChannel: true })).toBe(false)
    expect(ledger.countOf('wechat-1')).toBe(3)
  })

  test('ignores composer-authored, friend-authored, steered, and non-channel frames', () => {
    const { ledger } = memoryLedger()
    expect(extractInboundHostTurnFrame(inboundFrame('s1', 'u1', { clientMessageId: 'local-1' }))).toBeNull()
    expect(extractInboundHostTurnFrame(inboundFrame('s1', 'u2', { externalFriendMessage: true }))).toBeNull()
    expect(extractInboundHostTurnFrame({
      type: 'user_message',
      sessionId: 's1',
      message: { uuid: 'u3', message: { steered: true, localRender: { inputPresentation: 'turn' } } },
    })).toBeNull()
    expect(ledger.noteInboundFrame(inboundFrame('chat-1', 'u4'), { knownChannel: false })).toBe(false)
    expect(ledger.countOf('chat-1')).toBe(0)
  })

  test('buffers brand-new sessions until session metadata classifies them', () => {
    const { ledger, raw } = memoryLedger()
    expect(ledger.noteInboundFrame(inboundFrame('new-ch', 'u1'), { knownChannel: null })).toBe(true)
    expect(ledger.noteInboundFrame(inboundFrame('new-cron', 'u2'), { knownChannel: null })).toBe(true)
    expect(raw()).toBeNull()
    expect(ledger.countOf('new-ch')).toBe(1)

    expect(ledger.reconcileKnownSessions(id => (id === 'new-ch' ? true : id === 'new-cron' ? false : null))).toBe(true)
    expect(ledger.countOf('new-ch')).toBe(1)
    expect(ledger.countOf('new-cron')).toBe(0)
    expect(raw()).toContain('new-ch')
    expect(raw()).not.toContain('new-cron')
  })

  test('opening a session mid-turn clears unread and lets a later off-screen completion count', () => {
    const { ledger } = memoryLedger()
    ledger.noteInboundFrame(inboundFrame('wechat-1', 'u1'), { knownChannel: true })
    expect(ledger.countOf('wechat-1')).toBe(1)

    // User opens the session while the reply is still running, then navigates away before done.
    expect(ledger.clearSession('wechat-1')).toBe(true)
    expect(ledger.countOf('wechat-1')).toBe(0)
    expect(ledger.noteTurnCompleted('wechat-1', { knownChannel: true })).toBe(true)
    expect(ledger.countOf('wechat-1')).toBe(1)
  })

  test('seeds baseline completion unread and persists across reloads', () => {
    const first = memoryLedger()
    first.ledger.noteInboundFrame(inboundFrame('wechat-legacy', 'u1'), { knownChannel: true, baselineUnread: true })
    expect(first.ledger.countOf('wechat-legacy')).toBe(2)

    let backing = first.raw()
    const reopened = createChannelUnreadLedger(() => backing, value => { backing = value })
    expect(reopened.countOf('wechat-legacy')).toBe(2)
  })

  test('sums unread message counts across channel sessions and formats display badges', () => {
    expect(sumChannelUnreadCount([])).toBe(0)
    expect(sumChannelUnreadCount([
      { unread: false, unreadCount: 0 },
      { unread: false },
    ])).toBe(0)
    expect(sumChannelUnreadCount([
      { unread: true, unreadCount: 3 },
      { unread: true, unreadCount: 2 },
      { unread: false, unreadCount: 0 },
    ])).toBe(5)
    expect(sumChannelUnreadCount([{ unread: true }])).toBe(1)

    expect(formatChannelUnreadBadge(0)).toBeNull()
    expect(formatChannelUnreadBadge(1)).toBe('1')
    expect(formatChannelUnreadBadge(99)).toBe('99')
    expect(formatChannelUnreadBadge(120)).toBe('99+')
  })
})
