import { describe, expect, test } from 'bun:test'
import {
  entryDomain,
  entrySource,
  formatEntryTime,
  groupTimelineByDay,
  normalizeDomainInput,
  parseEntriesPayload,
  parseHistorySnapshot,
  splitPolicyGroups,
  subdomainPreviewExample,
} from './computer-history-model'

describe('computer history model', () => {
  test('snapshot parsing keeps the pinned shape and drops malformed members', () => {
    const snapshot = parseHistorySnapshot({
      status: { state: 'running', entryCount: 12, retentionMs: 172800000, managedDisabled: false, unavailableReason: '' },
      settings: {
        enabled: true,
        managedDisabled: false,
        policy: [
          { observe: 'exclude', scope: 'app', target: 'com.apple.notes' },
          { observe: 'nope', scope: 'app', target: 'bad' },
          { observe: 'include', scope: 'url', target: 'example.com' },
          'garbage',
        ],
      },
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
    const entries = parseEntriesPayload({
      entries: [
        { kind: 'app', at: 5, name: 'One' },
        { kind: 'window', at: 6, title: 'T', url: 'https://example.com/x' },
        { kind: 'bogus', at: 7 },
        { kind: 'app', at: 'soon' },
        'garbage',
      ],
    })
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

  test('normalizeDomainInput extracts bare domains from URLs and rejects invalid input', () => {
    expect(normalizeDomainInput('https://www.GitHub.com/meitianwang/klaus?tab=readme')).toBe('github.com')
    expect(normalizeDomainInput('  docs.example.com:8443/guide  ')).toBe('docs.example.com')
    expect(normalizeDomainInput('github.com.')).toBe('github.com')
    expect(normalizeDomainInput('ftp://example.com')).toBeNull()
    expect(normalizeDomainInput('not a domain')).toBeNull()
    expect(normalizeDomainInput('localhost')).toBeNull()
    expect(subdomainPreviewExample('github.com')).toBe('gist.github.com')
    expect(subdomainPreviewExample('linear.app')).toBe('app.linear.app')
  })

  test('splitPolicyGroups orders include rules ahead of exclude rules', () => {
    const groups = splitPolicyGroups([
      { observe: 'exclude', scope: 'app', target: 'com.apple.notes' },
      { observe: 'include', scope: 'url', target: 'github.com' },
    ])
    expect(groups.includeEntries).toEqual([{ observe: 'include', scope: 'url', target: 'github.com' }])
    expect(groups.excludeEntries).toEqual([{ observe: 'exclude', scope: 'app', target: 'com.apple.notes' }])
  })

  test('groupTimelineByDay collapses consecutive duplicates and orders newest first by day', () => {
    const todayNoon = new Date(2026, 10, 13, 12, 0).getTime()
    const todayMorning = new Date(2026, 10, 13, 9, 30).getTime()
    const yesterdayEvening = new Date(2026, 10, 12, 21, 15).getTime()
    const groups = groupTimelineByDay([
      { kind: 'window', at: yesterdayEvening, name: 'Safari', title: 'Spec' },
      { kind: 'window', at: todayMorning, name: 'Safari', title: 'PR #12', url: 'https://github.com/a/b/pull/12' },
      { kind: 'window', at: todayNoon, name: 'Safari', title: 'PR #12', url: 'https://github.com/a/b/pull/12' },
    ], todayNoon + 60_000, 'zh-CN', { today: '今天', yesterday: '昨天' })

    expect(groups.map(group => group.label)).toEqual(['今天', '昨天'])
    expect(groups[0]!.entries).toHaveLength(1)
    expect(groups[0]!.entries[0]!.at).toBe(todayNoon)
    expect(groups[1]!.entries[0]!.at).toBe(yesterdayEvening)
  })
})
