import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/update-notice-vectors.json'
import {
  DISMISS_TTL_MS, PROGRESS_DIALOG_DELAY_MS, displayPercent, formatBytes, initialNoticeState, isDismissed,
  noticeFor, parseDismissRecord, remainingTime, settingsActionFor, settingsHintFor, surfacesFor,
  type UpdateStatus,
} from './model'

function statusFor(entry: {
  state: string; supported?: boolean; version?: string | null; collapsed?: boolean; postponed?: boolean
  explicit?: boolean; errorKind?: string; observedTransfer?: boolean
}): UpdateStatus {
  return {
    supported: entry.supported !== false,
    state: entry.state as UpdateStatus['state'],
    currentVersion: '1.0.0',
    // A case may pin the version to null to prove an offer needs one.
    availableVersion: entry.version === null ? null : '1.1.0',
    error: entry.state === 'error' ? 'fixture failure' : null,
    errorKind: (entry.errorKind ?? null) as UpdateStatus['errorKind'],
    explicit: entry.explicit === true,
    progress: null,
  }
}

describe('update notice contract', () => {
  test('the pinned pacing constants are the ones the model uses', () => {
    expect(PROGRESS_DIALOG_DELAY_MS).toBe(vectors.delayGateMs)
    expect(DISMISS_TTL_MS).toBe(vectors.dismissTtlMs)
  })

  for (const entry of vectors.surfaceCases) {
    test(`surface: ${entry.name}`, () => {
      const surfaces = surfacesFor({
        status: statusFor(entry),
        progressHidden: entry.collapsed,
        dismissed: entry.postponed,
        observedTransfer: entry.observedTransfer === true,
      })
      expect(surfaces).toEqual(entry.expect)
    })
  }

  for (const entry of vectors.noticeCases) {
    test(`notice: ${entry.name}`, () => {
      const notice = noticeFor(statusFor(entry), initialNoticeState())
      expect(notice?.kind ?? null).toBe(entry.expect)
    })
  }

  for (const entry of vectors.settingsActionCases) {
    test(`settings action: ${entry.name}`, () => {
      expect(settingsActionFor(statusFor(entry), false, false)).toBe(entry.expect)
    })
  }

  for (const entry of vectors.settingsHintCases) {
    test(`settings hint: ${entry.name}`, () => {
      expect(settingsHintFor(statusFor(entry), false)).toBe(entry.expect)
    })
  }

  for (const entry of vectors.remainingTimeCases) {
    test(`remaining time: ${entry.name}`, () => {
      expect(remainingTime(entry.speed, entry.transferred, entry.total)).toEqual(entry.expect)
    })
  }

  for (const entry of vectors.byteCases) {
    test(`bytes: ${entry.bytes}`, () => {
      expect(formatBytes(entry.bytes)).toBe(entry.expect)
    })
  }
})

describe('update notice behaviour beyond the pinned cases', () => {
  test('a repeated push is not a new event, so a notice fires once per outcome', () => {
    const state = initialNoticeState()
    const status = statusFor({ state: 'idle', explicit: true })
    expect(noticeFor(status, state)?.kind).toBe('up-to-date')
    expect(noticeFor(status, state)).toBeNull()
  })

  test('progress ticks inside one phase never re-announce a result', () => {
    const state = initialNoticeState()
    const base = statusFor({ state: 'downloading', explicit: true })
    expect(noticeFor({ ...base, progress: { percent: 10, bytesPerSecond: 1, transferred: 1, total: 10, installing: false } }, state)).toBeNull()
    expect(noticeFor({ ...base, progress: { percent: 40, bytesPerSecond: 1, transferred: 4, total: 10, installing: false } }, state)).toBeNull()
  })

  test('a new offer for a different version is a new event', () => {
    const state = initialNoticeState()
    noticeFor({ ...statusFor({ state: 'idle', explicit: true }), currentVersion: '1.0.0' }, state)
    expect(noticeFor({ ...statusFor({ state: 'idle', explicit: true }), currentVersion: '1.0.1' }, state)?.kind).toBe('up-to-date')
  })

  test('a failure without a classified kind still reports a failure, not silence', () => {
    const notice = noticeFor({ ...statusFor({ state: 'error', explicit: true }), errorKind: null }, initialNoticeState())
    expect(notice).toEqual({ kind: 'failure', failure: 'check-unavailable', detail: 'fixture failure' })
  })

  test('postponing is per version and expires with its window', () => {
    const record = { version: '1.1.0', timestamp: 1_000 }
    expect(isDismissed(record, '1.1.0', 1_000)).toBe(true)
    expect(isDismissed(record, '1.1.0', 1_000 + DISMISS_TTL_MS - 1)).toBe(true)
    expect(isDismissed(record, '1.1.0', 1_000 + DISMISS_TTL_MS)).toBe(false)
    expect(isDismissed(record, '1.2.0', 1_000)).toBe(false)
    expect(isDismissed(null, '1.1.0', 1_000)).toBe(false)
    // A clock that moved backwards must not silence a fresh offer forever.
    expect(isDismissed(record, '1.1.0', 500)).toBe(false)
  })

  test('a malformed or partial dismiss record is ignored rather than trusted', () => {
    expect(parseDismissRecord(null)).toBeNull()
    expect(parseDismissRecord('not json')).toBeNull()
    expect(parseDismissRecord('{}')).toBeNull()
    expect(parseDismissRecord('{"version":"1.1.0"}')).toBeNull()
    expect(parseDismissRecord('{"version":"","timestamp":1}')).toBeNull()
    expect(parseDismissRecord('{"version":"1.1.0","timestamp":"now"}')).toBeNull()
    expect(parseDismissRecord('{"version":"1.1.0","timestamp":5}')).toEqual({ version: '1.1.0', timestamp: 5 })
  })

  test('the displayed percent is clamped and rounded without inventing progress', () => {
    expect(displayPercent(null)).toBe(0)
    expect(displayPercent({ percent: Number.NaN, bytesPerSecond: 0, transferred: 0, total: 0, installing: false })).toBe(0)
    expect(displayPercent({ percent: -5, bytesPerSecond: 0, transferred: 0, total: 0, installing: false })).toBe(0)
    expect(displayPercent({ percent: 140, bytesPerSecond: 0, transferred: 0, total: 0, installing: false })).toBe(100)
    expect(displayPercent({ percent: 11.6, bytesPerSecond: 0, transferred: 0, total: 0, installing: false })).toBe(12)
  })

  test('a local check in flight names checking without overriding a real transfer', () => {
    expect(settingsActionFor(statusFor({ state: 'idle' }), true, false)).toBe('checking')
    expect(settingsActionFor(statusFor({ state: 'downloading' }), true, false)).toBe('downloading')
    expect(settingsActionFor(statusFor({ state: 'downloaded' }), false, true)).toBe('installing')
  })

  test('a failed manual check explains itself even before the host reports a phase', () => {
    expect(settingsHintFor(statusFor({ state: 'idle' }), true)).toBe('check-unavailable')
  })

  test('an unknown speed never produces a negative or infinite estimate', () => {
    expect(remainingTime(Number.NaN, 0, 100)).toEqual({ kind: 'calculating' })
    expect(remainingTime(10, 0, 0)).toEqual({ kind: 'calculating' })
    expect(remainingTime(-5, 0, 100)).toEqual({ kind: 'calculating' })
  })
})