import { expect, test } from 'bun:test'
import { SUBSCRIPTION_WEB_SEARCH_SOURCES } from '../../../../contracts/web-search-settings'
import { enqueueSearchSource, searchSourceItems, type SearchSourceSnapshot } from './search-source-state'

test('search choices are the verified subscriptions and never filter on credentials', () => {
  expect(searchSourceItems('codex').map(item => item.value)).toEqual([...SUBSCRIPTION_WEB_SEARCH_SOURCES])
  expect(searchSourceItems('codex').every(item => !item.disabled)).toBe(true)
  expect(searchSourceItems(null).map(item => item.value)).toEqual([...SUBSCRIPTION_WEB_SEARCH_SOURCES])
  expect(searchSourceItems('builtin').map(item => item.value)).toEqual(['builtin', ...SUBSCRIPTION_WEB_SEARCH_SOURCES])
  expect(searchSourceItems('builtin').find(item => item.value === 'builtin')).toEqual({ value: 'builtin', disabled: true })
  expect(searchSourceItems('codex').map(item => item.value)).not.toContain('custom')
})

test('rapid search choices persist in order and a failed final save restores the preceding success', async () => {
  let snapshot: SearchSourceSnapshot = { source: 'builtin' }
  let finish!: (value: { ok: boolean }) => void
  const delayed = new Promise<{ ok: boolean }>(resolve => { finish = resolve })
  const calls: string[] = [], frames: SearchSourceSnapshot[] = []
  const update = (fn: (current: SearchSourceSnapshot) => SearchSourceSnapshot) => { snapshot = fn(snapshot); frames.push(snapshot) }
  let settled = 0
  const api = { set: async (source: string) => { calls.push(source); return calls.length === 1 ? delayed : { ok: false, error: 'Credential expired' } }, settled: () => { settled++ }, error: 'Save failed' }
  const first = enqueueSearchSource(snapshot, 'native', update, api)
  expect(snapshot.source).toBe('native')
  const second = enqueueSearchSource(snapshot, 'codex', update, api)
  expect(snapshot.source).toBe('codex')
  expect(calls).toEqual(['native'])
  finish({ ok: true }); await Promise.all([first, second])
  expect(calls).toEqual(['native', 'codex'])
  expect(snapshot).toEqual({ source: 'native', error: 'Credential expired', saveError: true })
  expect(frames.every(frame => Boolean(frame.source))).toBe(true)
  expect(settled).toBe(1)
})
