import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { FRIENDS_ENABLED_KEY, isFriendsFeatureEnabled } from '../../../../shared/friends'
import { fetchFriendRows } from '../../chat/composer/mention-queries'
import { isPinnedSession, partitionSidebarSessions } from '../../chat/sidebar/model'
import { sharedFriendUnread } from '../../chat/sidebar/friend-unread'
import { chatFunctionFixture } from '../../chat/test-support/chat-function-fixture'
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

  test('hides friend project groups, pinned friend chats, search entries, and unread badges while disabled and restores them when enabled', async () => {
    let listCalls = 0
    const sessions = [
      { id: 'friend-chat', title: 'Friend task', updatedAt: 30, workdir: '/workspace/alpha', workspaceId: 'ws-1', friendGroupId: 'friendship-1' },
      { id: 'pinned-friend-chat', title: 'Pinned friend task', updatedAt: 25, sidebarPinnedAt: 100, friendGroupId: 'friendship-1' },
      { id: 'project-chat', title: 'Repo work', updatedAt: 20, workdir: '/workspace/alpha' },
      { id: 'recent-chat', title: 'Quick note', updatedAt: 10 },
    ]
    const classes = new Set<string>()
    const activityBtn = {
      setAttribute: () => {},
      classList: {
        toggle: (name: string, active?: boolean) => {
          if (active) classes.add(name)
          else classes.delete(name)
        },
      },
    }
    const state: { friendDirectory: Array<{ id: string; userId?: string; name: string; avatarUrl?: string | null }> } = {
      friendDirectory: [{ id: 'friendship-1', userId: 'u1', name: 'Alex', avatarUrl: null }],
    }
    const fixture = chatFunctionFixture<{
      refreshFriendDirectory(): Promise<void>
      friendRowsForSidebar(): Array<{ id: string; name: string; updatedAt: number }>
      workspaceConversationSessions(id: string): Array<{ id: string }>
      projectRowsFromSessions(): Array<{ workdir: string; name: string }>
      projectlessConversationSessions(): Array<{ id: string }>
      sectionSessionIdsForBadge(section: string): string[]
      commandMenuVisibleSessions(): Array<{ id: string }>
      allSidebarRowSpecs(): Array<{ id: string }>
      syncSidebarToolbar(): void
      getDirectory(): Array<{ id: string; name: string }>
    }>(
      [
        'regularLocalSessions',
        'groupedLocalSessions',
        'friendDirectoryName',
        'refreshFriendDirectory',
        'friendConversationSessions',
        'isSidebarFriendSessionVisible',
        'friendRowsForSidebar',
        'workspaceConversationSessions',
        'projectRowsFromSessions',
        'projectConversationSessions',
        'projectlessConversationSessions',
        'sectionSessionIdsForBadge',
        'commandMenuVisibleSessions',
        'allSidebarRowSpecs',
        'syncSidebarToolbar',
      ],
      {
        get friendDirectory() { return state.friendDirectory },
        set friendDirectory(next) { state.friendDirectory = next },
        sessions,
        projectRoots: ['/workspace/alpha'],
        projectLabels: {},
        projectWorkspaces: [{ id: 'ws-1', name: 'Main Workspace', roots: ['/workspace/beta'] }],
        sidebarActivityOpen: false,
        getFriendsFeatureEnabled,
        isPinnedSession,
        partitionSidebarSessions,
        detectChannelPrefix: () => null,
        normalizeProjectWorkdir: (dir?: string | null) => (dir ? String(dir) : null),
        basenameOf: (dir: string) => dir.split('/').filter(Boolean).pop() || dir,
        sessionProjectKey: (session: { workspaceId?: string; friendGroupId?: string; workdir?: string }) =>
          session.workspaceId || session.friendGroupId ? null : (session.workdir ?? null),
        projectStateKey: (key?: string | null) => key || null,
        workspaceContainerKey: (id: string) => `ws:${id}`,
        friendDisplayName: (row: { remark?: string; displayName?: string }) => row.remark || row.displayName || 'Friend',
        updateFriendsRuntime: () => {},
        sidebarSessionRowSpec: (session: { id: string }) => ({ id: session.id }),
        sharedFriendUnread,
        isSidebarSessionWaiting: (id: string) => id === 'friend-chat',
        isSidebarSessionCompleteUnread: () => false,
        tt: (key: string) => key,
        document: { getElementById: (id: string) => (id === 'titlebar-activity' ? activityBtn : null) },
        klausApi: {
          friends: {
            list: async () => {
              listCalls += 1
              return {
                signedIn: true,
                friends: [{ id: 'friendship-1', userId: 'u1', displayName: 'Alex', status: 'accepted' }],
              }
            },
            runtime: async () => ({}),
          },
        },
      },
      `{
        refreshFriendDirectory,
        friendRowsForSidebar,
        workspaceConversationSessions,
        projectRowsFromSessions,
        projectlessConversationSessions,
        sectionSessionIdsForBadge,
        commandMenuVisibleSessions,
        allSidebarRowSpecs,
        syncSidebarToolbar,
        getDirectory: () => friendDirectory,
      }`,
    )

    sharedFriendUnread().clearAll()
    sharedFriendUnread().add('friend-chat', 2, true)
    const badgeCounts: number[] = []
    ;(globalThis as any).window = {
      addEventListener: () => {},
      klaus: {
        app: { setApprovalBadge: async (count: number) => { badgeCounts.push(count) } },
      },
    }
    const { syncApprovalBadge } = await import('../../chat/approvals')

    // Disabled even with a pre-populated directory: friend group and friend chats stay hidden without spilling into other buckets.
    expect(fixture.friendRowsForSidebar()).toEqual([])
    expect(fixture.workspaceConversationSessions('ws-1').map(s => s.id)).toEqual([])
    expect(fixture.projectRowsFromSessions().map(p => p.workdir)).toEqual(['/workspace/alpha'])
    expect(fixture.projectlessConversationSessions().map(s => s.id)).toEqual(['recent-chat'])
    expect(fixture.sectionSessionIdsForBadge('projects')).toEqual(['project-chat'])
    expect(fixture.sectionSessionIdsForBadge('pinned')).toEqual([])
    expect(fixture.commandMenuVisibleSessions().map(s => s.id)).toEqual(['project-chat', 'recent-chat'])
    expect(fixture.allSidebarRowSpecs().map(s => s.id)).toEqual(['project-chat', 'recent-chat'])
    fixture.syncSidebarToolbar()
    expect(classes.has('is-attention')).toBe(false)
    syncApprovalBadge()
    expect(badgeCounts.at(-1)).toBe(0)

    // Refreshing the directory while disabled skips `friends.list` and clears cached entries.
    await fixture.refreshFriendDirectory()
    expect(listCalls).toBe(0)
    expect(fixture.getDirectory()).toEqual([])

    // Turning Friends on invokes `onFriendsEnabled` so the sidebar reloads the directory and restores the friend group.
    let enabledSignals = 0
    const gate = initFriendsSidebarGate({
      setEntryVisible: () => {},
      onFriendsDisabled: () => { state.friendDirectory = [] },
      onFriendsEnabled: () => { enabledSignals += 1 },
    })
    expect(enabledSignals).toBe(0)
    setFriendsFeatureEnabled(true)
    expect(enabledSignals).toBe(1)
    await fixture.refreshFriendDirectory()
    expect(listCalls).toBe(1)
    expect(fixture.friendRowsForSidebar().map(r => r.name)).toEqual(['Alex'])
    expect(fixture.sectionSessionIdsForBadge('projects')).toEqual(['project-chat'])
    expect(fixture.sectionSessionIdsForBadge('pinned')).toEqual([])
    expect(fixture.commandMenuVisibleSessions().map(s => s.id)).toEqual(['pinned-friend-chat', 'friend-chat', 'project-chat', 'recent-chat'])
    expect(fixture.allSidebarRowSpecs().map(s => s.id)).toEqual(['pinned-friend-chat', 'friend-chat', 'project-chat', 'recent-chat'])
    fixture.syncSidebarToolbar()
    expect(classes.has('is-attention')).toBe(true)
    syncApprovalBadge()
    expect(badgeCounts.at(-1)).toBe(2)

    // Turning Friends back off clears the directory and hides the friend group immediately.
    setFriendsFeatureEnabled(false)
    expect(fixture.getDirectory()).toEqual([])
    expect(fixture.friendRowsForSidebar()).toEqual([])
    fixture.syncSidebarToolbar()
    expect(classes.has('is-attention')).toBe(false)
    syncApprovalBadge()
    expect(badgeCounts.at(-1)).toBe(0)

    sharedFriendUnread().clearAll()
    gate.dispose()
  })
})
