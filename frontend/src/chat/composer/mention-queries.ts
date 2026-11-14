import type { FriendSummary } from '../../../../shared/friends'
import type { MentionEntry } from './slash-menu'
import { queryClient } from '../../app/query-client'
import { friendDisplayName } from '../../pages/friends/display-name'
import { readFriendsFeatureEnabledFromHost } from '../../pages/friends/feature-enabled'
import type { BrowserTabMention } from '../../../../shared/browser-tab-mention'
import { BROWSER_TAB_MENTIONS_REFRESH_MS, browserTabDetail, browserTabLabel, normalizeBrowserTabMention } from './browser-tab-reference'

/**
 * The `@`-menu's remote data sources, expressed as react-query queries.
 *
 * Two rules shape this module, both from the incident where a stalled cloud
 * device call froze the whole picker:
 *
 * 1. A queryFn returns RAW structured rows and never resolves labels. Every
 *    user-facing string (the device platform/status line, the conversation
 *    detail) is projected at render time by the `project*` functions below,
 *    which take the caller's `t`. Building labels inside the queryFn — as the
 *    old imperative getters did with `tt()` — would freeze them in whatever
 *    language was active when the rows were fetched, so switching language
 *    while the menu is open would need a refetch to fix. Keeping the queryFn
 *    language-free means one fetch serves every language.
 *
 * 2. A failed fetch PROPAGATES instead of resolving to an empty list. Each
 *    group then shows its own error line and the healthy groups are unaffected.
 *    The old getters swallowed failures into `[]`, which made "the device
 *    service is down" indistinguishable from "you have no devices".
 *
 * Small resource lists share cached raw rows. Conversations and browser tabs
 * use query-scoped, bounded host searches so their full catalogs never cross
 * the renderer bridge. Conversation requests are debounced by the menu.
 */

export type Translate = (key: string) => string

// --- Raw row shapes (what a queryFn resolves; no labels) ---

export interface PluginRow { id: string; name: string }
export interface DeviceRow { id: string; name: string; platform: string; status: string; isCurrent: boolean }
export interface ConversationRow { id: string; title: string }
export interface BrowserTabsResult { tabs: BrowserTabMention[]; errors: Array<{ browserId: string; message: string; code?: string }> }
/** A file hit as the host returns it: a secondary root's rel is already prefixed. */
export interface FileHitRow { rel: string; name: string; isDir: boolean }

// --- Query keys ---

export const MENTION_PLUGINS_KEY = 'mention-plugins'
export const MENTION_FRIENDS_KEY = 'mention-friends'
export const MENTION_DEVICES_KEY = 'mention-devices'
export const MENTION_CONVERSATIONS_KEY = 'mention-conversations'
export const MENTION_BROWSER_TABS_KEY = 'mention-browser-tabs'

/** Plugins are listed per session (project-scoped skills differ), so the key carries it. */
export const pluginsQueryKey = (sessionId: string | null): readonly unknown[] => [MENTION_PLUGINS_KEY, sessionId]
export const friendsQueryKey = (): readonly unknown[] => [MENTION_FRIENDS_KEY]
export const devicesQueryKey = (): readonly unknown[] => [MENTION_DEVICES_KEY]
export const conversationsQueryKey = (query: string): readonly unknown[] => [MENTION_CONVERSATIONS_KEY, query.trim()]
// The host filters before applying the tab cap; each query needs its own result.
export const browserTabsQueryKey = (sessionId: string | null, query: string): readonly unknown[] => [MENTION_BROWSER_TABS_KEY, sessionId, query.trim()]

export function browserTabsQueryOptions(sessionId: string | null, query: string) {
  return {
    queryKey: browserTabsQueryKey(sessionId, query),
    queryFn: () => fetchBrowserTabRows(sessionId, query),
    staleTime: 0,
    refetchInterval: BROWSER_TAB_MENTIONS_REFRESH_MS,
    refetchIntervalInBackground: true,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: true,
  }
}

/** The subscription exists only while the picker is open and follows its conversation. */
export function subscribeBrowserTabMentionChanges(api: any, sessionId: string | null, refresh: () => void,
  focusWindow?: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): () => void {
  const unsubscribe = api?.on?.browserUseState?.((state: { conversationId?: string; tabInventoryChanged?: boolean }) => {
    if (state.tabInventoryChanged || state.conversationId === sessionId || !state.conversationId) refresh()
  })
  focusWindow?.addEventListener('focus', refresh)
  return () => {
    unsubscribe?.()
    focusWindow?.removeEventListener('focus', refresh)
  }
}
// The file group has no query key: it is driven by a persistent workspace search
// session (see workspace-file-search-session.ts), not a useQuery. The session
// owns its snapshot and its own staleness, so there is no query-cache entry to
// key.

// --- staleTime per group ---
//
// The whole list is cached and re-filtered on every keystroke, so staleTime here
// bounds how often a source is re-fetched while the menu stays open — NOT how
// often typing triggers work (typing never changes these keys). A short
// staleTime is therefore cheap and keeps passively-changing data fresh.

/** Conversation titles appear the moment a chat is created; keep this short. */
export const CONVERSATIONS_STALE_MS = 5_000
/** Device online/offline drifts on its own (the settings island polls it), so keep this short too. */
export const FRIENDS_STALE_MS = 5_000
export const DEVICES_STALE_MS = 5_000
/** The plugin set changes only on install/enable/disable, which invalidates explicitly; a longer window is safe. */
export const PLUGINS_STALE_MS = 30_000

// --- Query functions (fetch raw rows; propagate failures) ---

function klaus(): any {
  return typeof window !== 'undefined' ? (window as any).klaus : null
}

/** Enabled plugins, as raw rows. An absent plugin API yields no rows, not an error. */
export async function fetchPluginRows(sessionId: string | null): Promise<PluginRow[]> {
  const api = klaus()?.plugins
  if (!api?.list) return []
  const listed = await api.list(sessionId)
  return (Array.isArray(listed) ? listed : [])
    .filter((row: any) => row?.installed && row?.enabled)
    .map((row: any) => {
      const name = String(row.name || row.id || '')
      return { id: String(row.id || name), name }
    })
    .filter((row: PluginRow) => !!row.name)
}

/** Friend requests are management-only; mention choices are accepted relationships. */
export async function fetchFriendRows(): Promise<FriendSummary[]> {
  const hostEnabled = readFriendsFeatureEnabledFromHost()
  if (hostEnabled && !(await hostEnabled)) return []
  const api = klaus()?.friends
  if (!api?.list) throw new Error('friends_unavailable')
  const snapshot = await api.list()
  return (Array.isArray(snapshot?.friends) ? snapshot.friends : [])
    .filter((row: FriendSummary) => row?.id && row.status === 'accepted')
}

/** Account devices, as raw rows. An absent mobile-bridge API yields no rows, not an error. */
export async function fetchDeviceRows(): Promise<DeviceRow[]> {
  const api = klaus()?.settings?.mobileBridge
  if (!api?.devices) return []
  const result = await api.devices()
  if (!result?.ok) {
    // A structured "not ok" (unlinked account, service refused) is a real
    // failure the group should surface, not a silent empty list.
    throw new Error(String(result?.error || 'device_list_failed'))
  }
  return (Array.isArray(result.devices) ? result.devices : [])
    .filter((row: any) => row?.id && row?.name)
    .map((row: any): DeviceRow => ({
      id: String(row.id),
      name: String(row.name),
      platform: String(row.platform || ''),
      status: String(row.status || 'offline'),
      isCurrent: row.isCurrent === true,
    }))
}

export const CONVERSATION_CANDIDATE_LIMIT = 50
export const CONVERSATION_QUERY_DEBOUNCE_MS = 100

/** Read a bounded title-search page; the full session catalog stays in the host. */
export async function fetchConversationRows(query: string, signal?: AbortSignal): Promise<ConversationRow[]> {
  const needle = query.trim()
  if (!needle || needle.length > 256) return []
  signal?.throwIfAborted()
  const api = klaus()?.session
  if (!api?.mentionCandidates) throw new Error('conversation_search_unavailable')
  const result = await api.mentionCandidates({ query: needle, limit: CONVERSATION_CANDIDATE_LIMIT })
  signal?.throwIfAborted()
  return (Array.isArray(result?.items) ? result.items : []).slice(0, CONVERSATION_CANDIDATE_LIMIT)
    .filter((row: any) => row?.id && typeof row.title === 'string' && row.title.trim())
    .map((row: any): ConversationRow => ({ id: String(row.id), title: String(row.title) }))
}

/** One failed browser keeps its notice alongside healthy browser candidates. */
export async function fetchBrowserTabRows(sessionId: string | null, query: string): Promise<BrowserTabsResult> {
  const api = klaus()?.browserUse
  if (!api?.mentionTabs) throw new Error('browser_tab_mentions_unavailable')
  const result = await api.mentionTabs({ sessionId, query: query.trim() })
  if (!result?.ok) throw new Error(String(result?.error || 'browser_tab_list_failed'))
  const tabs = (Array.isArray(result.tabs) ? result.tabs : [])
    .map(normalizeBrowserTabMention)
    .filter((row: BrowserTabMention | null): row is BrowserTabMention => row !== null)
  const errors = (Array.isArray(result.errors) ? result.errors : [])
    .filter((row: any) => typeof row?.browserId === 'string' && typeof row?.message === 'string')
    .map((row: any) => ({ browserId: row.browserId, message: row.message, ...(typeof row.code === 'string' ? { code: row.code } : {}) }))
  return { tabs, errors }
}

// --- Projections (raw rows -> MentionEntry, resolved at render time) ---

/** The page-facing product name of a plugin plus the extra names a mention row answers to. */
export interface PluginMentionNames { display: string; aliases: string[] }

/**
 * Plugin mention rows. With a name resolver the row shows the same product name
 * the plugin page shows and keeps the raw slug as its secondary line and search
 * alias; without one the row falls back to the raw slug everywhere.
 */
export function projectPluginRows(rows: PluginRow[], names?: (row: PluginRow) => PluginMentionNames): MentionEntry[] {
  return rows.map(row => {
    const resolved = names?.(row)
    const display = resolved?.display || row.name
    const aliases = resolved?.aliases?.length ? { aliases: resolved.aliases } : {}
    return { name: display, path: row.id, rel: row.name, isDir: false, kind: 'plugin' as const, ...aliases }
  })
}

function devicePlatformLabel(platform: string, t: Translate): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform || t('mobile_bridge_desktop_device')
}

function deviceStatusLabel(status: string, t: Translate): string {
  if (status === 'online') return t('mobile_bridge_device_online')
  if (status === 'reconnecting') return t('mobile_bridge_device_reconnecting')
  return t('mobile_bridge_device_offline')
}

export function projectFriendRows(rows: FriendSummary[], t: Translate): MentionEntry[] {
  return rows.map(row => ({
    name: friendDisplayName(row),
    path: row.id,
    friendId: row.id,
    rel: `${t(row.online ? 'friends_online' : 'friends_offline')} · ${t(row.peerAllowsAgentTasks ? 'friends_peer_authorized' : 'friends_peer_not_authorized')}`,
    avatarUrl: row.avatarUrl,
    isDir: false,
    kind: 'friend',
  }))
}

export function invalidateFriendMentions(): void {
  void queryClient.invalidateQueries({ queryKey: friendsQueryKey() })
}

export function projectDeviceRows(rows: DeviceRow[], t: Translate): MentionEntry[] {
  return rows.map((row): MentionEntry => ({
    name: row.name,
    path: row.id,
    rel: [
      row.isCurrent ? t('mobile_bridge_current_device') : '',
      `${devicePlatformLabel(row.platform, t)} · ${deviceStatusLabel(row.status, t)}`,
    ].filter(Boolean).join(' · '),
    isDir: false,
    deviceId: row.id,
    kind: 'device' as const,
  }))
}

export function projectConversationRows(rows: ConversationRow[], t: Translate): MentionEntry[] {
  return rows.map((row): MentionEntry => ({
    name: row.title,
    path: row.id,
    rel: t('mention_conversation_detail'),
    isDir: false,
    conversationId: row.id,
    kind: 'conversation' as const,
  }))
}

export function projectBrowserTabRows(rows: BrowserTabMention[]): MentionEntry[] {
  return rows.map(row => ({
    name: browserTabLabel(row),
    path: row.mention,
    rel: browserTabDetail(row),
    isDir: false,
    kind: 'browser-tab',
    browserTab: row,
  }))
}

/** File hits are already host-prefixed; the projection only tags kind/isDir. */
export function projectFileRows(rows: FileHitRow[]): MentionEntry[] {
  return rows.map((row): MentionEntry => ({
    name: row.name,
    path: row.rel,
    rel: row.rel,
    isDir: row.isDir,
  }))
}

// --- Invalidation ---
//
// Cross-island: the plugins page and the settings device panel are separate
// React islands with no shared import path to this module, so they reach these
// through the window bridge (see chat.ts / chat-window.d.ts). The QueryClient is
// a module singleton, so invalidating from any island hits the same cache the
// picker reads.

/** Plugins changed (install/uninstall/enable/disable): drop the cached list. */
export function invalidatePluginMentions(): void {
  void queryClient.invalidateQueries({ queryKey: [MENTION_PLUGINS_KEY] })
}

/**
 * Devices changed (rename/remove from the settings panel): drop the cached list
 * so the picker does not show a stale name for up to DEVICES_STALE_MS. Status
 * drift is covered by the short staleTime; this covers explicit user edits.
 *
 * Conversations have no equivalent hook on purpose: the conversation list has no
 * single mutation point to observe (a chat can be created, renamed or deleted
 * from many places, including other hosts), so it relies on its short staleTime
 * rather than an invalidation line that would have to be threaded everywhere.
 */
export function invalidateDeviceMentions(): void {
  void queryClient.invalidateQueries({ queryKey: devicesQueryKey() })
}
