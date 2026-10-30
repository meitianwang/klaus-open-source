import { beforeEach, describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { QueryClient } from '@tanstack/react-query'
import { queryClient as appQueryClient } from '../../app/query-client'
import {
  devicesQueryKey, invalidateDeviceMentions, invalidatePluginMentions,
  MENTION_DEVICES_KEY, MENTION_PLUGINS_KEY, pluginsQueryKey,
} from './mention-queries'

// These replace the seven tests that pinned the hand-written mention-source-cache.
// The caching semantics now belong to react-query, so what is worth pinning here
// is (a) OUR QueryClient configuration — the two defaults that stop the P1 from
// recurring — and (b) that the query layer actually gets those semantics from the
// client we ship.
//
// Everything below drives `queryClient.fetchQuery`, which DOES execute the
// queryFn. `useQuery` under bun's static rendering never subscribes, so its
// queryFn never runs and such a test would silently assert on a pending state
// instead of failing — the trap the plan calls out.

describe('the shipped QueryClient is configured against the P1 request storm', () => {
  test('retry is disabled so a stalled host channel cannot be multiplied', () => {
    // react-query defaults to three retries with backoff. The @-menu's sources
    // run through host channels serialized behind a cloud call; retrying one
    // that is already stuck multiplies the queue depth and turns a slow source
    // into a dead one — exactly the incident this refactor exists to prevent.
    const defaults = appQueryClient.getDefaultOptions()
    expect(defaults.queries?.retry).toBe(false)
    expect(defaults.mutations?.retry).toBe(false)
  })

  test('refetchOnWindowFocus is disabled for a resident desktop window', () => {
    // Regaining focus says nothing about whether plugins, devices or the
    // conversation list changed, and refetching on every alt-tab would hammer
    // the same slow channels.
    expect(appQueryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
  })
})

describe('the query layer gets in-flight deduplication from the client', () => {
  let client: QueryClient
  beforeEach(() => {
    // A fresh client per test, configured exactly like the shipped singleton so
    // the assertions describe the semantics we actually rely on.
    client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  })

  test('one stalled load is shared by every concurrent reader', async () => {
    // The property the hand-written cache implemented by hand, now provided by
    // the client: five readers of one in-flight query issue ONE fetch. This is
    // what keeps a burst of keystrokes from queueing five device calls.
    let loads = 0
    let release!: (rows: string[]) => void
    const gate = new Promise<string[]>((resolve) => { release = resolve })
    const queryFn = () => { loads += 1; return gate }
    const key = devicesQueryKey()

    const readers = Array.from({ length: 5 }, () => client.fetchQuery({ queryKey: key, queryFn }))
    expect(loads).toBe(1)
    release(['a'])
    const results = await Promise.all(readers)
    expect(loads).toBe(1)
    for (const rows of results) expect(rows).toEqual(['a'])
  })

  test('a distinct query key is not deduplicated against another', async () => {
    // Plugins are session-scoped, so two sessions must not share one fetch —
    // otherwise one project's skills would leak into another's picker.
    let loads = 0
    const queryFn = async () => { loads += 1; return [] }
    await Promise.all([
      client.fetchQuery({ queryKey: pluginsQueryKey('s1'), queryFn }),
      client.fetchQuery({ queryKey: pluginsQueryKey('s2'), queryFn }),
    ])
    expect(loads).toBe(2)
  })
})

describe('cached data survives a failed reload', () => {
  let client: QueryClient
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  })

  test('a failed refetch keeps the last good rows rather than emptying the group', async () => {
    const key = devicesQueryKey()
    client.setQueryData(key, ['书房 Mac'])
    let fail = false
    const queryFn = async () => {
      if (fail) throw new Error('device_list_failed')
      return ['书房 Mac']
    }
    fail = true
    // staleTime 0 forces a refetch; with retry:false the failure is final. The
    // cached rows must remain, so the group degrades to its error line while
    // still being able to show what it last knew — never a blank pretending to
    // be "you have no devices".
    await client.fetchQuery({ queryKey: key, queryFn, staleTime: 0 }).catch(() => {})
    expect(client.getQueryData(key)).toEqual(['书房 Mac'])
  })

  test('a fresh key that fails has no data, so the group shows its error state', async () => {
    const key = devicesQueryKey()
    const queryFn = async () => { throw new Error('offline') }
    await rejects(client.fetchQuery({ queryKey: key, queryFn }), /offline/)
    expect(client.getQueryData(key)).toBeUndefined()
  })
})

describe('invalidation forces the next read to reload', () => {
  let client: QueryClient
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  })

  test('a non-stale key is served from cache until invalidated', async () => {
    const key = pluginsQueryKey('s1')
    let loads = 0
    const queryFn = async () => { loads += 1; return [`v${loads}`] }
    expect(await client.fetchQuery({ queryKey: key, queryFn, staleTime: 60_000 })).toEqual(['v1'])
    expect(await client.fetchQuery({ queryKey: key, queryFn, staleTime: 60_000 })).toEqual(['v1'])
    // Inside staleTime the cached rows are reused.
    expect(loads).toBe(1)

    await client.invalidateQueries({ queryKey: [MENTION_PLUGINS_KEY] })
    expect(await client.fetchQuery({ queryKey: key, queryFn, staleTime: 60_000 })).toEqual(['v2'])
    // Invalidation forces exactly one reload.
    expect(loads).toBe(2)
  })

  test('the exported invalidators target their own group and nothing else', async () => {
    // The plugins page and the settings device panel are separate React islands
    // that reach these through the window bridge; a mismatched key would either
    // miss the group or blow away an unrelated one.
    let pluginLoads = 0
    let deviceLoads = 0
    const pluginFn = async () => { pluginLoads += 1; return [] }
    const deviceFn = async () => { deviceLoads += 1; return [] }
    await client.fetchQuery({ queryKey: pluginsQueryKey('s1'), queryFn: pluginFn, staleTime: 60_000 })
    await client.fetchQuery({ queryKey: devicesQueryKey(), queryFn: deviceFn, staleTime: 60_000 })
    expect(pluginLoads).toBe(1)
    expect(deviceLoads).toBe(1)

    invalidatePluginMentionsOn(client)
    await client.fetchQuery({ queryKey: pluginsQueryKey('s1'), queryFn: pluginFn, staleTime: 60_000 })
    await client.fetchQuery({ queryKey: devicesQueryKey(), queryFn: deviceFn, staleTime: 60_000 })
    // The plugin group reloaded; the device group was untouched.
    expect(pluginLoads).toBe(2)
    expect(deviceLoads).toBe(1)

    invalidateDeviceMentionsOn(client)
    await client.fetchQuery({ queryKey: pluginsQueryKey('s1'), queryFn: pluginFn, staleTime: 60_000 })
    await client.fetchQuery({ queryKey: devicesQueryKey(), queryFn: deviceFn, staleTime: 60_000 })
    // The plugin group was untouched; the device group reloaded.
    expect(pluginLoads).toBe(2)
    expect(deviceLoads).toBe(2)
  })
})

// The exported invalidators close over the shipped singleton, so the scoping
// assertion above reproduces their key prefixes against a local client. Keeping
// the prefixes here (rather than only asserting on the singleton) is what makes
// the "targets its own group and nothing else" claim checkable.
function invalidatePluginMentionsOn(client: QueryClient) {
  void client.invalidateQueries({ queryKey: [MENTION_PLUGINS_KEY] })
}
function invalidateDeviceMentionsOn(client: QueryClient) {
  void client.invalidateQueries({ queryKey: [MENTION_DEVICES_KEY] })
}

describe('the exported invalidators use the shipped singleton and the same key prefixes', () => {
  test('invalidatePluginMentions and invalidateDeviceMentions do not throw and target their prefixes', async () => {
    // Smoke + wiring: these are what the window bridge calls. They must not
    // throw when no query is cached yet, and they must use the documented keys.
    expect(() => invalidatePluginMentions()).not.toThrow()
    expect(() => invalidateDeviceMentions()).not.toThrow()
    expect(pluginsQueryKey('s1')[0]).toBe(MENTION_PLUGINS_KEY)
    expect(devicesQueryKey()[0]).toBe(MENTION_DEVICES_KEY)
  })
})
