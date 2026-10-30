// Unit tests for the sidebar attention model: state collapse, sort order,
// trailing-indicator selection, and the 60s snooze ledger.
import { describe, expect, test } from 'bun:test'
import {
  ATTENTION_RANK,
  INPUT_SNOOZE_MS,
  compareByAttention,
  downgradeWaitingForUnread,
  forgetInputSnoozes,
  inputSnoozeRemaining,
  isInputRequestSnoozed,
  liveApprovalsOf,
  rowIndicator,
  sessionAttentionState,
  snoozeInputRequest,
  takeExpiredSnooze,
} from './attention'

describe('attention state collapse', () => {
  test('waiting beats unread beats active beats idle', () => {
    expect(ATTENTION_RANK.waiting).toBeLessThan(ATTENTION_RANK.unread)
    expect(ATTENTION_RANK.unread).toBeLessThan(ATTENTION_RANK.active)
    expect(ATTENTION_RANK.active).toBeLessThan(ATTENTION_RANK.idle)
  })

  test('any parked request makes the session waiting', () => {
    expect(sessionAttentionState({ waitingKind: 'approval', waitingCount: 1, unread: false, working: true })).toBe('waiting')
    expect(sessionAttentionState({ waitingKind: 'input', waitingCount: 2, unread: true, working: false })).toBe('waiting')
  })

  test('unread wins over active; active over idle', () => {
    expect(sessionAttentionState({ waitingKind: null, waitingCount: 0, unread: true, working: true })).toBe('unread')
    expect(sessionAttentionState({ waitingKind: null, waitingCount: 0, unread: false, working: true })).toBe('active')
    expect(sessionAttentionState({ waitingKind: null, waitingCount: 0, unread: false, working: false })).toBe('idle')
  })
})

describe('sort comparator', () => {
  test('ranks waiting first, recency breaks ties', () => {
    const waitingOld = { attention: 'waiting' as const, recencyAt: 100 }
    const waitingNew = { attention: 'waiting' as const, recencyAt: 200 }
    const unreadNew = { attention: 'unread' as const, recencyAt: 999 }
    const active = { attention: 'active' as const, recencyAt: 999 }
    const idle = { attention: 'idle' as const, recencyAt: 999 }
    const sorted = [idle, active, waitingOld, unreadNew, waitingNew].sort(compareByAttention)
    expect(sorted.map(s => s.attention)).toEqual(['waiting', 'waiting', 'unread', 'active', 'idle'])
    expect(sorted[0]).toBe(waitingNew)
  })
})

describe('row trailing indicator', () => {
  const labels = { spinner: 'Working', unreadDot: 'Completed' }

  test('waiting rows show nothing extra (the pill replaces the indicator)', () => {
    expect(rowIndicator({ waitingCount: 1, unread: true, working: true }, labels)).toBeNull()
  })

  test('count badge caps at 99 and wins over spinner and dot', () => {
    expect(rowIndicator({ waitingCount: 0, unread: true, working: true, unreadCount: 150 }, labels)).toEqual({ kind: 'unreadCount', count: 99 })
  })

  test('spinner over unread dot', () => {
    expect(rowIndicator({ waitingCount: 0, unread: true, working: true }, labels)).toEqual({ kind: 'spinner', label: 'Working' })
  })

  test('plain unread renders the dot', () => {
    expect(rowIndicator({ waitingCount: 0, unread: true, working: false }, labels)).toEqual({ kind: 'unreadDot', label: 'Completed' })
  })

  test('idle rows render nothing', () => {
    expect(rowIndicator({ waitingCount: 0, unread: false, working: false }, labels)).toBeNull()
  })
})

describe('live approval enumeration', () => {
  test('unresolved cards count, resolved do not, duplicate request ids dedupe', () => {
    const units = [
      { type: 'live-permission', req: { requestId: 'p1', toolName: 'Bash' }, resolved: null },
      { type: 'live-elicit', req: { requestId: 'e1' }, resolved: null },
      { type: 'live-ask', req: { requestId: 'a1' }, resolved: null },
      { type: 'live-permission', req: { requestId: 'p2' }, resolved: { decision: 'allow', allowSession: false, savedRules: false } },
      { type: 'live-permission', req: { requestId: 'p1' }, resolved: null },
    ]
    const live = liveApprovalsOf(units as unknown as Array<Record<string, unknown>>)
    expect(live.map(u => u.requestId)).toEqual(['p1', 'e1', 'a1'])
    expect(live.find(u => u.requestId === 'p1')!.kind).toBe('approval')
    expect(live.find(u => u.requestId === 'e1')!.kind).toBe('input')
    expect(live.find(u => u.requestId === 'a1')!.kind).toBe('input')
  })

  test('AskUserQuestion permission cards are input, not approval', () => {
    const units = [{ type: 'live-permission', req: { requestId: 'q1', toolName: 'AskUserQuestion' }, resolved: null }]
    expect(liveApprovalsOf(units as unknown as Array<Record<string, unknown>>)[0]!.kind).toBe('input')
  })
})

describe('input snooze ledger (60s window)', () => {
  test('snoozed requests hide then resurface after the window', () => {
    forgetInputSnoozes(['req-1'])
    expect(isInputRequestSnoozed('req-1', 1000)).toBe(false)
    snoozeInputRequest('req-1', 1000)
    expect(isInputRequestSnoozed('req-1', 1000 + INPUT_SNOOZE_MS - 1)).toBe(true)
    expect(inputSnoozeRemaining('req-1', 1000 + 30_000)).toBe(30_000)
    // Deadline passes: the wait resurfaces and the entry clears.
    expect(takeExpiredSnooze('req-1', 1000 + INPUT_SNOOZE_MS)).toBe(true)
    expect(isInputRequestSnoozed('req-1', 1000 + INPUT_SNOOZE_MS + 1)).toBe(false)
  })

  test('the window is exactly 60000 ms', () => {
    expect(INPUT_SNOOZE_MS).toBe(60_000)
  })
})

describe('pinned downgrade rule', () => {
  test('waiting never downgrades; active with unseen turn reads unread', () => {
    expect(downgradeWaitingForUnread('waiting', true)).toBe('waiting')
    expect(downgradeWaitingForUnread('active', true)).toBe('unread')
    expect(downgradeWaitingForUnread('active', false)).toBe('active')
  })
})
