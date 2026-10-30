import { describe, expect, test } from 'bun:test'
import {
  filterMentionRows,
  MENTION_GROUP_LIMIT,
  mentionRows,
  mentionSelectionKey,
  selectableEntries,
  type MentionSection,
} from './mention-sections'
import type { MentionEntry } from './slash-menu'

const entry = (name: string, extra: Partial<MentionEntry> = {}): MentionEntry =>
  ({ name, path: extra.path ?? name, rel: extra.rel ?? name, isDir: false, ...extra })

const section = (key: string, labelKey: string | null, rows: MentionEntry[], state?: MentionSection['state']): MentionSection =>
  ({ key, labelKey, rows, ...(state ? { state } : {}) })

describe('mention group sections', () => {
  test('a group with rows renders its heading then its items', () => {
    const rows = mentionRows([section('plugins', 'mention_group_plugins', [entry('a'), entry('b')])])
    expect(rows.map(r => r.kind)).toEqual(['heading', 'item', 'item'])
    expect(rows[0].kind === 'heading' && rows[0].labelKey).toBe('mention_group_plugins')
  })

  test('an empty group renders nothing — no bare heading, no placeholder', () => {
    // An empty group showing a heading would waste a line of the height-bounded
    // menu; only loading and error states earn a visible line.
    expect(mentionRows([section('plugins', 'mention_group_plugins', [], { kind: 'empty', labelKey: 'mention_group_empty' })])).toEqual([])
    expect(mentionRows([section('plugins', 'mention_group_plugins', [])])).toEqual([])
  })

  test('a loading group keeps its heading and shows its own placeholder', () => {
    // This is the visible half of "each group degrades on its own": a slow
    // source shows its own "Loading…" line, not a blank menu.
    const rows = mentionRows([section('devices', 'mention_group_devices', [], { kind: 'loading', labelKey: 'mention_group_devices_loading' })])
    expect(rows.map(r => r.kind)).toEqual(['heading', 'state'])
    expect(rows[1].kind === 'state' && rows[1].labelKey).toBe('mention_group_devices_loading')
  })

  test('an error group shows its own failure line, isolated from healthy groups', () => {
    const rows = mentionRows([
      section('plugins', 'mention_group_plugins', [entry('a')]),
      section('devices', 'mention_group_devices', [], { kind: 'error', labelKey: 'mention_group_devices_error' }),
      section('conversations', 'mention_group_conversations', [entry('c')]),
    ])
    // The healthy groups still render their items beside the failed group's line.
    expect(rows.map(r => r.kind)).toEqual(['heading', 'item', 'heading', 'state', 'heading', 'item'])
    const errorRow = rows.find(r => r.kind === 'state')
    expect(errorRow && errorRow.kind === 'state' && errorRow.labelKey).toBe('mention_group_devices_error')
  })

  test('a headingless group shows its items without a heading', () => {
    const rows = mentionRows([section('categories', null, [entry('a')])])
    expect(rows.map(r => r.kind)).toEqual(['item'])
  })

  test('only item rows are selectable — headings and state lines are skipped', () => {
    const rows = mentionRows([
      section('plugins', 'mention_group_plugins', [entry('a')]),
      section('devices', 'mention_group_devices', [], { kind: 'loading', labelKey: 'mention_group_devices_loading' }),
      section('conversations', 'mention_group_conversations', [entry('c')]),
    ])
    // Arrow navigation counts only real choices, never "Loading…".
    expect(selectableEntries(rows).map(e => e.name)).toEqual(['a', 'c'])
  })

  test('the selection key changes when a remote group fills in, and is stable for identical rows', () => {
    const before = mentionSelectionKey(mentionRows([section('devices', 'mention_group_devices', [], { kind: 'loading', labelKey: 'mention_group_devices_loading' })]))
    const after = mentionSelectionKey(mentionRows([section('devices', 'mention_group_devices', [entry('书房 Mac', { path: 'device-local' })])]))
    expect(before).not.toBe(after)
    // An identical re-fetch produces the same key, so the menu skips the redraw
    // and the user's arrow-key position survives.
    const again = mentionSelectionKey(mentionRows([section('devices', 'mention_group_devices', [entry('书房 Mac', { path: 'device-local' })])]))
    expect(after).toBe(again)
  })

  test('the selection key is language-stable (built from i18n keys and addresses, not resolved labels)', () => {
    const key = mentionSelectionKey(mentionRows([
      section('plugins', 'mention_group_plugins', [entry('a', { kind: 'plugin', path: 'plugin-a' })]),
    ]))
    // No resolved label text appears; only keys and entry identity do.
    expect(key).toContain('mention_group_plugins')
    expect(key).toContain('plugin:plugin-a:a')
  })
})

describe('filterMentionRows display cap', () => {
  const rows = Array.from({ length: 12 }, (_, i) => entry(`item-${i}`))

  test('an empty query returns the per-group first screen', () => {
    expect(filterMentionRows(rows, '').length).toBe(MENTION_GROUP_LIMIT)
    expect(MENTION_GROUP_LIMIT).toBe(4)
  })

  test('a query filters by name then caps, so the cap is display-side', () => {
    expect(filterMentionRows(rows, 'item-1').map(r => r.name)).toEqual(['item-1', 'item-10', 'item-11'])
    expect(filterMentionRows(rows, 'ITEM-11').map(r => r.name)).toEqual(['item-11'])
    expect(filterMentionRows(rows, 'nomatch')).toEqual([])
  })

  test('truncation never happens before the filter, so old rows stay findable', () => {
    // The regression this guards: capping first would hide item-5..item-9 from
    // any name search. Filtering the full set keeps every row addressable.
    expect(filterMentionRows(rows, 'item-9').map(r => r.name)).toEqual(['item-9'])
    expect(filterMentionRows(rows, 'item-11').map(r => r.name)).toEqual(['item-11'])
  })

  test('a query also matches row aliases, so a plugin is findable by slug and by product name', () => {
    // A plugin row shows the product name the plugin page shows while answering
    // to its raw slug and to its product name in the other language.
    const aliased = [entry('Diagrams', { path: 'digram@klaus-official', rel: 'digram', aliases: ['digram', '图表'] })]
    expect(filterMentionRows(aliased, 'dig').map(r => r.name)).toEqual(['Diagrams'])
    expect(filterMentionRows(aliased, '图表').map(r => r.name)).toEqual(['Diagrams'])
    expect(filterMentionRows(aliased, 'DIAG').map(r => r.name)).toEqual(['Diagrams'])
    expect(filterMentionRows(aliased, 'nomatch')).toEqual([])
  })
})
