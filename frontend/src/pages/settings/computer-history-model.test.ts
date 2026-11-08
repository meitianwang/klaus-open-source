import { describe, expect, test } from 'bun:test'
import { entryDomain, entrySource, formatEntryTime, parseEntriesPayload, parseHistorySnapshot } from './computer-history-model'

describe('computer history model', () => {
  test('snapshot parsing keeps the pinned shape and drops malformed members', () => {
    const snapshot = parseHistorySnapshot({
      status: { state: 'running', entryCount: 12, retentionMs: 172800000, managedDisabled: false, unavailableReason: '' },
      settings: { enabled: true, managedDisabled: false, policy: [
        { observe: 'exclude', scope: 'app', target: 'com.apple.notes' },
        { observe: 'nope', scope: 'app', target: 'bad' },
        { observe: 'include', scope: 'url', target: 'example.com' },
        'garbage',
      ] },
    })
    expect(snapshot.status.state).toBe('running')
    expect(snapshot.status.entryCount).toBe(12)
    expect(snapshot.status.unavailableReason).toBeUndefined()
    expect(snapshot.settings.policy).toEqual([
      { observe: 'exclude', scope: 'app', target: 'com.apple.notes' },
      { observe: 'include', scope: 'url', target: 'example.com' },
    ])
  })

  test('snapshot parsing rejects payloads without a usable state', () => {
    expect(() => parseHistorySnapshot(null)).toThrow()
    expect(() => parseHistorySnapshot({ status: {}, settings: {} })).toThrow()
    expect(() => parseHistorySnapshot({ status: { state: 'flying' }, settings: {} })).toThrow()
  })

  test('entries payloads keep valid rows only', () => {
    const entries = parseEntriesPayload({ entries: [
      { kind: 'app', at: 5, name: 'One' },
      { kind: 'window', at: 6, title: 'T', url: 'https://example.com/x' },
      { kind: 'bogus', at: 7 },
      { kind: 'app', at: 'soon' },
      'garbage',
    ] })
    expect(entries).toEqual([
      { kind: 'app', at: 5, name: 'One' },
      { kind: 'window', at: 6, title: 'T', url: 'https://example.com/x' },
    ])
    expect(parseEntriesPayload({})).toEqual([])
  })

  test('entry labels prefer names and expose http(s) domains only', () => {
    expect(entrySource({ kind: 'app', at: 1, name: 'Notes', bundleId: 'com.apple.Notes' })).toBe('Notes')
    expect(entrySource({ kind: 'app', at: 1, bundleId: 'com.apple.Notes' })).toBe('com.apple.Notes')
    expect(entryDomain({ kind: 'window', at: 1, url: 'https://www.example.com/page' })).toBe('www.example.com')
    expect(entryDomain({ kind: 'window', at: 1, url: 'file:///etc/passwd' })).toBeUndefined()
    expect(entryDomain({ kind: 'window', at: 1 })).toBeUndefined()
  })

  test('timeline labels render local HH:MM', () => {
    const at = new Date(2026, 10, 8, 9, 5).getTime()
    expect(formatEntryTime(at)).toBe('09:05')
  })
})
