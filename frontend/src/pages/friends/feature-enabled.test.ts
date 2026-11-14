import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FRIENDS_ENABLED_KEY, isFriendsFeatureEnabled } from '../../../../shared/friends'
import { fetchFriendRows } from '../../chat/composer/mention-queries'
import {
  getFriendsFeatureEnabled,
  initFriendsSidebarGate,
  refreshFriendsFeatureEnabled,
  resetFriendsFeatureEnabledForTest,
  setFriendsFeatureEnabled,
} from './feature-enabled'

const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window')
const previousWindow = (globalThis as any).window

beforeEach(() => {
  resetFriendsFeatureEnabledForTest(false)
  ;(globalThis as any).window = {}
})

afterAll(() => {
  resetFriendsFeatureEnabledForTest(false)
  if (hadWindow) (globalThis as any).window = previousWindow
  else delete (globalThis as any).window
})

describe('isFriendsFeatureEnabled', () => {
  test('defaults off when absent and recognizes on/off switch variants', () => {
    for (const unset of [undefined, null, '', '   ']) {
      expect(isFriendsFeatureEnabled(unset)).toBe(false)
    }
    for (const on of ['on', 'ON', ' on ', '1', 'true', 'yes', 'enabled']) {
      expect(isFriendsFeatureEnabled(on)).toBe(true)
    }
    for (const off of ['off', 'OFF', ' off ', '0', 'false', 'no', 'disable', 'disabled']) {
      expect(isFriendsFeatureEnabled(off)).toBe(false)
    }
  })

  test('the sidebar entry starts hidden in index.html to match the default-off setting', () => {
    const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')
    expect(html).toMatch(/id="btn-friends"\s+hidden/)
  })
})

describe('friends feature visibility state', () => {
  test('syncs sidebar visibility and leaves the friends view when turned off via settings or host push', async () => {
    let kvValue: string | undefined
    const preferenceListeners = new Set<(payload: { key?: string }) => void>()
    ;(globalThis as any).window = {
      klaus: {
        settings: { kv: { get: async (key: string) => (key === FRIENDS_ENABLED_KEY ? kvValue : undefined) } },
        on: {
          appPreferencesChanged: (cb: (payload: { key?: string }) => void) => {
            preferenceListeners.add(cb)
            return () => preferenceListeners.delete(cb)
          },
        },
      },
    }

    const visibleStates: boolean[] = []
    let disabledCount = 0
    const gate = initFriendsSidebarGate({
      setEntryVisible: visible => visibleStates.push(visible),
      onFriendsDisabled: () => { disabledCount += 1 },
    })

    // Unset row stays off.
    await gate.refresh()
    expect(getFriendsFeatureEnabled()).toBe(false)
    expect(visibleStates.at(-1)).toBe(false)

    // Turning on reveals the sidebar entry.
    kvValue = 'on'
    for (const listener of preferenceListeners) listener({ key: FRIENDS_ENABLED_KEY })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getFriendsFeatureEnabled()).toBe(true)
    expect(visibleStates.at(-1)).toBe(true)

    // Unrelated preference notifications do not disable Friends.
    kvValue = 'off'
    for (const listener of preferenceListeners) listener({ key: 'theme' })
    await Promise.resolve()
    expect(getFriendsFeatureEnabled()).toBe(true)

    // Host broadcast for `friends.enabled` hides the entry and evicts an open Friends page.
    const beforeDisabledCount = disabledCount
    for (const listener of preferenceListeners) listener({ key: FRIENDS_ENABLED_KEY })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getFriendsFeatureEnabled()).toBe(false)
    expect(visibleStates.at(-1)).toBe(false)
    expect(disabledCount).toBe(beforeDisabledCount + 1)

    // Optimistic toggle back on restores the sidebar entry immediately.
    setFriendsFeatureEnabled(true)
    expect(getFriendsFeatureEnabled()).toBe(true)
    expect(visibleStates.at(-1)).toBe(true)

    gate.dispose()
  })

  test('newer optimistic toggle wins over an older in-flight kv read', async () => {
    let resolveRead!: (value: string) => void
    ;(globalThis as any).window = {
      klaus: {
        settings: {
          kv: {
            get: () => new Promise<string>(resolve => { resolveRead = resolve }),
          },
        },
      },
    }

    const inflight = refreshFriendsFeatureEnabled()
    setFriendsFeatureEnabled(false)
    resolveRead('on')
    await inflight
    expect(getFriendsFeatureEnabled()).toBe(false)
  })

  test('mention candidate query skips friends.list when unset or disabled', async () => {
    let listCalls = 0
    let kvValue: string | undefined
    ;(globalThis as any).window = {
      klaus: {
        settings: { kv: { get: async (key: string) => (key === FRIENDS_ENABLED_KEY ? kvValue : undefined) } },
        friends: {
          list: async () => {
            listCalls += 1
            return {
              signedIn: true,
              friends: [{
                id: 'friendship-1', userId: 'u1', displayName: 'Alice', avatarUrl: null,
                status: 'accepted', allowIncomingAgentTasks: false, peerAllowsAgentTasks: true, online: true,
              }],
            }
          },
        },
      },
    }

    expect(await fetchFriendRows()).toEqual([])
    expect(listCalls).toBe(0)

    kvValue = 'off'
    expect(await fetchFriendRows()).toEqual([])
    expect(listCalls).toBe(0)

    kvValue = 'on'
    const rows = await fetchFriendRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('friendship-1')
    expect(listCalls).toBe(1)
  })
})
