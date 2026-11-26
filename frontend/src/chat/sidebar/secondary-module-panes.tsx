import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import { sortTasksFlat, type CronStatus, type CronTask } from '../../pages/cron/data'
import { isChannelConfigured, type ChannelPresentationState } from '../../pages/channels/channel-state'
import { MEMORY_DREAM_EVENT, friendlyMemoryName, getCurrentDream, type DreamRun } from '../../pages/memory/data'
import '../../pages/team-collaboration/i18n'
import { COLLABORATION_REFRESH, allPages, request as collaborationRequest, useCollaborationRoute, type CollaborationProject } from '../../pages/team-collaboration/data'
import { FriendAvatar } from '../../pages/friends/FriendsDialog'
import { friendDisplayName } from '../../pages/friends/display-name'
import { startGuestSignin } from './guest-signin'
import type { PrimaryRailSection } from './rail-navigation'
import styles from './secondary-module-panes.module.css'

export const RAIL_SECTION_CHANGE_EVENT = 'klaus:rail-section-change'
export const CRON_SIDEBAR_SYNC_EVENT = 'klaus:cron-sidebar-sync'
export const CRON_SIDEBAR_ACTION_EVENT = 'klaus:cron-sidebar-action'
export const CRON_SIDEBAR_SESSIONS_EVENT = 'klaus:cron-sidebar-sessions'
export const CRON_SIDEBAR_SELECT_EMPTY_EVENT = 'klaus:cron-sidebar-select-empty'
export const CHANNELS_SIDEBAR_SYNC_EVENT = 'klaus:channels-sidebar-sync'
export const CHANNELS_SIDEBAR_OPEN_EVENT = 'klaus:channels-sidebar-open'
export const CHANNELS_SIDEBAR_SESSIONS_EVENT = 'klaus:channels-sidebar-sessions'
export const CHANNELS_SIDEBAR_SELECT_EMPTY_EVENT = 'klaus:channels-sidebar-select-empty'
export const MEMORY_SIDEBAR_SYNC_EVENT = 'klaus:memory-sidebar-sync'
export const MEMORY_SIDEBAR_FILTER_EVENT = 'klaus:memory-sidebar-filter'
export const FRIENDS_SIDEBAR_SYNC_EVENT = 'klaus:friends-sidebar-sync'
export const FRIENDS_SIDEBAR_ACTION_EVENT = 'klaus:friends-sidebar-action'
export const FRIENDS_SIDEBAR_SESSIONS_EVENT = 'klaus:friends-sidebar-sessions'
export const SIDEBAR_REVEAL_SESSION_EVENT = 'klaus:sidebar-reveal-session'
export interface PendingSidebarReveal {
  module: 'chats' | 'channels' | 'friends' | 'cron'
  sessionId: string
}

function flushPendingSidebarScroll(module: PendingSidebarReveal['module']): boolean {
  const state = window as Window & { __klausPendingSidebarReveal?: PendingSidebarReveal | null }
  const pending = state.__klausPendingSidebarReveal
  if (pending?.module !== module) return false
  const rows = document.getElementById('sidebar-secondary')?.querySelectorAll<HTMLElement>('[data-session-id]')
  const hit = Array.from(rows ?? []).find(row => row.dataset.sessionId === pending.sessionId)
  if (!hit) return false
  state.__klausPendingSidebarReveal = null
  hit.scrollIntoView?.({ block: 'nearest' })
  return true
}

function listenForSidebarReveal(
  module: PendingSidebarReveal['module'],
  reveal: (sessionId: string) => boolean,
) {
  const state = window as Window & { __klausPendingSidebarReveal?: PendingSidebarReveal | null }
  const consume = (event?: Event) => {
    const detail = (event as CustomEvent<PendingSidebarReveal> | undefined)?.detail
    if (detail?.module === module) state.__klausPendingSidebarReveal = detail
    const request = detail?.module === module ? detail : state.__klausPendingSidebarReveal
    if (request?.module !== module || !reveal(request.sessionId)) return
    if (!flushPendingSidebarScroll(module)) {
      requestAnimationFrame(() => {
        if (!flushPendingSidebarScroll(module)) requestAnimationFrame(() => { flushPendingSidebarScroll(module) })
      })
    }
  }
  consume()
  window.addEventListener(SIDEBAR_REVEAL_SESSION_EVENT, consume)
  return { consume, dispose: () => window.removeEventListener(SIDEBAR_REVEAL_SESSION_EVENT, consume) }
}

export const FRIENDS_SIDEBAR_SELECT_EMPTY_EVENT = 'klaus:friends-sidebar-select-empty'

interface CronSyncState {
  tasks: CronTask[]
  status: CronStatus
  statusFilter?: 'all' | 'enabled' | 'paused'
  selectedId?: string
  emptyTaskId?: string | null
}

export interface CronSessionItem {
  id: string
  taskId: string
  title: string
  updatedAt: number
  unread: boolean
  working: boolean
  waitingInput: boolean
}

export interface CronSessionsSnapshot {
  tasks?: CronTask[]
  sessionsByTask: Record<string, CronSessionItem[]>
  orphanSessions: CronSessionItem[]
  activeSessionId: string | null
  inSetupView: boolean
}

export interface ChannelRowMeta {
  id: string
  label: string
  icon: string
  requiredKeys: string[]
}

export interface ChannelSessionItem {
  id: string
  channelId: string
  title: string
  updatedAt: number
  unread: boolean
  unreadCount?: number
  working: boolean
  waitingInput?: boolean
}

export function sumChannelUnreadCount(
  sessions: readonly Pick<ChannelSessionItem, 'unread' | 'unreadCount'>[],
): number {
  let total = 0
  for (const item of sessions) {
    const count = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread ? 1 : 0)
    if (count > 0) total += count
  }
  return total
}

export function formatChannelUnreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null
  const whole = Math.floor(count)
  return whole > 99 ? '99+' : String(whole)
}

export interface ChannelSessionsSnapshot {
  sessionsByChannel: Record<string, ChannelSessionItem[]>
  activeSessionId: string | null
  inSetupView: boolean
}

// Keep icon filenames byte-identical to buildChannelDefs() in ChannelsPage.tsx.
export const CHANNEL_ROWS: readonly ChannelRowMeta[] = [
  { id: 'wechat', label: 'WeChat', icon: 'wechat-icon.png', requiredKeys: [] },
  { id: 'wecom', label: 'WeCom', icon: 'wecom-icon.png', requiredKeys: ['bot_id', 'secret'] },
  { id: 'qq', label: 'QQ', icon: 'qq-icon.png', requiredKeys: ['app_id', 'client_secret'] },
  { id: 'feishu', label: 'Feishu / Lark', icon: 'feishu.png', requiredKeys: ['app_id', 'app_secret'] },
  { id: 'dingtalk', label: 'DingTalk', icon: 'dingtalk.png', requiredKeys: ['client_id', 'client_secret'] },
  { id: 'telegram', label: 'Telegram', icon: 'telegram-icon.png', requiredKeys: ['bot_token'] },
  { id: 'discord', label: 'Discord', icon: 'discord-icon.svg', requiredKeys: ['bot_token'] },
  { id: 'whatsapp', label: 'WhatsApp', icon: 'whatsapp-icon.png', requiredKeys: [] },
]

export interface MemorySidebarFileEntry {
  path: string
  title: string
  hook: string
}

export function parseMemoryIndexMarkdown(markdown: string, dirPrefix = ''): MemorySidebarFileEntry[] {
  const entries: MemorySidebarFileEntry[] = []
  const seen = new Set<string>()
  const normalizedPrefix = dirPrefix ? `${dirPrefix.replace(/\/+$/, '')}/` : ''
  const lineRe = /^\s*-\s+\[([^\]]+)\]\(([^)\s]+\.md)\)(?:\s*[—–-]\s*(.+))?\s*$/gm
  let match: RegExpExecArray | null
  while ((match = lineRe.exec(markdown)) !== null) {
    const title = match[1].trim()
    const relPath = match[2].trim().replace(/^\.\//, '')
    const hook = (match[3] || '').trim()
    if (!relPath || relPath.includes('..')) continue
    const fullPath = `${normalizedPrefix}${relPath}`
    if (seen.has(fullPath)) continue
    seen.add(fullPath)
    entries.push({ path: fullPath, title, hook })
  }
  return entries
}

export function stripChannelTitlePrefix(title: string, channelLabel: string): string {
  const trimmed = (title || '').trim()
  const prefix = `${channelLabel} · `
  if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
    return trimmed.slice(prefix.length).trim()
  }
  return trimmed
}

export function formatCronSessionTitle(rawTitle: string, taskName: string, timestampMs: number): string {
  const trimmed = (rawTitle || '').trim()
  const cleanTask = (taskName || '').trim()
  let candidate = trimmed
  if (cleanTask) {
    const prefix = `${cleanTask} · `
    if (candidate.startsWith(prefix) && candidate.length > prefix.length) {
      candidate = candidate.slice(prefix.length).trim()
    }
  }
  if (candidate && candidate !== cleanTask) {
    return candidate
  }
  if (Number.isFinite(timestampMs) && timestampMs > 0) {
    const d = new Date(timestampMs)
    const p2 = (n: number) => String(n).padStart(2, '0')
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  return candidate || cleanTask
}

function readInitialCronSessionsSnapshot(): CronSessionsSnapshot {
  const cached = (window as unknown as { __klausCronSidebarSessions?: CronSessionsSnapshot }).__klausCronSidebarSessions
  return cached || { sessionsByTask: {}, orphanSessions: [], activeSessionId: null, inSetupView: true }
}

function readInitialChannelSessionsSnapshot(): ChannelSessionsSnapshot {
  const cached = (window as unknown as { __klausChannelSidebarSessions?: ChannelSessionsSnapshot }).__klausChannelSidebarSessions
  return cached || { sessionsByChannel: {}, activeSessionId: null, inSetupView: true }
}

const ORPHAN_CRON_GROUP_ID = '__removed_cron_tasks__'

type ModuleSidebarGroupScope = 'cron' | 'channels' | 'friends'
type ModuleGroupExpansionMap = Record<string, boolean>
type ModuleExpansionState = { expansion: ModuleGroupExpansionMap; lastActiveChatId: string | null | undefined }

export function parseModuleGroupExpansionMap(raw: unknown): ModuleGroupExpansionMap {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return {} }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === 'boolean'))
}

export function isModuleGroupOpen(map: Readonly<ModuleGroupExpansionMap>, groupId: string, hasSessions: boolean, openEmptyGroupId?: string | null): boolean {
  if (!hasSessions) return openEmptyGroupId === groupId
  return typeof map[groupId] === 'boolean' ? map[groupId] : true
}

export function toggleModuleGroupExpansion(map: Readonly<ModuleGroupExpansionMap>, groupId: string): ModuleGroupExpansionMap {
  return { ...map, [groupId]: !isModuleGroupOpen(map, groupId, true) }
}

export function revealModuleGroupExpansion(map: Readonly<ModuleGroupExpansionMap>, groupId: string): ModuleGroupExpansionMap {
  return map[groupId] === false ? { ...map, [groupId]: true } : map
}

export function reconcileModuleExpansionOnSessions(state: ModuleExpansionState, activeChatId: string | null, ownerGroupId: string | undefined): ModuleExpansionState {
  const shouldReveal = state.lastActiveChatId !== undefined && activeChatId && activeChatId !== state.lastActiveChatId && ownerGroupId
  return {
    expansion: shouldReveal ? revealModuleGroupExpansion(state.expansion, ownerGroupId) : state.expansion,
    lastActiveChatId: activeChatId,
  }
}

function createModuleExpansionStore(scope: ModuleSidebarGroupScope) {
  const key = `klaus_${scope}_group_expansion_v1`
  const listeners = new Set<() => void>()
  let state: ModuleExpansionState | undefined
  let lastProcessedDetail: object | undefined
  const read = (): ModuleExpansionState => {
    if (!state) {
      let expansion: ModuleGroupExpansionMap = {}
      try { expansion = parseModuleGroupExpansionMap(window.localStorage.getItem(key)) } catch {}
      state = { expansion, lastActiveChatId: undefined }
    }
    return state
  }
  const update = (next: ModuleExpansionState) => {
    const changed = read().expansion !== next.expansion
    state = next
    if (!changed) return
    try { window.localStorage.setItem(key, JSON.stringify(next.expansion)) } catch {}
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => read().expansion,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    toggle(groupId: string) { update({ ...read(), expansion: toggleModuleGroupExpansion(read().expansion, groupId) }) },
    reveal(groupId: string) { update({ ...read(), expansion: revealModuleGroupExpansion(read().expansion, groupId) }) },
    reconcile(detail: object, activeId: string | null, owner: string | undefined) {
      if (detail === lastProcessedDetail) return
      lastProcessedDetail = detail
      update(reconcileModuleExpansionOnSessions(read(), activeId, owner))
    },
    reset() {
      state = undefined
      lastProcessedDetail = undefined
      try { window.localStorage.removeItem(key) } catch {}
      listeners.forEach(listener => listener())
    },
  }
}

const moduleExpansionStores = {
  cron: createModuleExpansionStore('cron'),
  channels: createModuleExpansionStore('channels'),
  friends: createModuleExpansionStore('friends'),
}

function useModuleGroupExpansion(scope: ModuleSidebarGroupScope) {
  const store = moduleExpansionStores[scope]
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

function toggleScopedModuleGroup(scope: ModuleSidebarGroupScope, groupId: string) {
  moduleExpansionStores[scope].toggle(groupId)
}

function revealScopedModuleGroup(scope: ModuleSidebarGroupScope, groupId: string) {
  moduleExpansionStores[scope].reveal(groupId)
}

export function resetModuleGroupExpansionForTests(): void {
  Object.values(moduleExpansionStores).forEach(store => store.reset())
}

function findCronGroup(snap: CronSessionsSnapshot, sessionId: string) {
  return Object.entries(snap.sessionsByTask).find(([, rows]) => rows.some(row => row.id === sessionId))?.[0] ?? (snap.orphanSessions.some(row => row.id === sessionId) ? ORPHAN_CRON_GROUP_ID : undefined)
}

function reconcileCronExpansion(detail: CronSessionsSnapshot) {
  const activeId = detail.inSetupView ? null : detail.activeSessionId
  moduleExpansionStores.cron.reconcile(detail, activeId, activeId ? findCronGroup(detail, activeId) : undefined)
}

function CronSecondaryPane() {
  const t = useT()
  const [tasks, setTasks] = useState<CronTask[]>(() => readInitialCronSessionsSnapshot().tasks ?? [])
  const [status, setStatus] = useState<CronStatus>({ nextRuns: {}, running: [] })
  const [filter, setFilter] = useState<'all' | 'enabled' | 'paused'>('all')
  const [sessionsSnap, setSessionsSnap] = useState<CronSessionsSnapshot>(readInitialCronSessionsSnapshot)
  const [selectedEmptyTaskId, setSelectedEmptyTaskId] = useState<string | null>(null)
  const [openEmptyTaskId, setOpenEmptyTaskId] = useState<string | null>(null)
  const expansionMap = useModuleGroupExpansion('cron')

  const loadCronState = useCallback(() => {
    const api = (window as unknown as {
      klaus?: {
        settings?: {
          cron?: {
            list?: () => Promise<CronTask[] | { tasks?: CronTask[] }>
            status?: () => Promise<CronStatus>
          }
        }
      }
    }).klaus?.settings?.cron
    void Promise.all([api?.list?.(), api?.status?.()])
      .then(([listRes, statusRes]) => {
        const list = Array.isArray(listRes) ? listRes : Array.isArray(listRes?.tasks) ? listRes.tasks : null
        if (list) setTasks(list)
        if (statusRes) setStatus(statusRes)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let latestSnapshot = readInitialCronSessionsSnapshot()
    reconcileCronExpansion(latestSnapshot)
    loadCronState()
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<CronSyncState>).detail
      if (!detail) return
      if (Array.isArray(detail.tasks)) setTasks(detail.tasks)
      if (detail.status) setStatus(detail.status)
      if ('emptyTaskId' in detail) {
        const nextEmpty = detail.emptyTaskId ?? null
        if (!nextEmpty) setOpenEmptyTaskId(null)
        setSelectedEmptyTaskId(nextEmpty)
      }
    }
    const reveal = listenForSidebarReveal('cron', sessionId => {
      const groupId = findCronGroup(latestSnapshot, sessionId)
      if (!groupId) return false
      setFilter('all')
      setOpenEmptyTaskId(null)
      setSelectedEmptyTaskId(null)
      revealScopedModuleGroup('cron', groupId)
      return true
    })
    const onSessions = (event: Event) => {
      const detail = (event as CustomEvent<CronSessionsSnapshot>).detail
      if (!detail) return
      if (Array.isArray(detail.tasks) && detail.tasks.length > 0) {
        setTasks(prev => prev.length > 0 ? prev : detail.tasks!)
      }
      latestSnapshot = detail
      reconcileCronExpansion(detail)
      setSessionsSnap(detail)
      reveal.consume()
      if (!detail.inSetupView) {
        setOpenEmptyTaskId(null)
        setSelectedEmptyTaskId(null)
      }
    }
    window.addEventListener(CRON_SIDEBAR_SYNC_EVENT, onSync)
    window.addEventListener(CRON_SIDEBAR_SESSIONS_EVENT, onSessions)
    return () => {
      reveal.dispose()
      window.removeEventListener(CRON_SIDEBAR_SYNC_EVENT, onSync)
      window.removeEventListener(CRON_SIDEBAR_SESSIONS_EVENT, onSessions)
    }
  }, [loadCronState])

  useEffect(() => { flushPendingSidebarScroll('cron') }, [tasks, sessionsSnap, expansionMap, openEmptyTaskId, filter])

  const enabledCount = tasks.filter(task => !!task.enabled).length
  const setupNavActive = sessionsSnap.inSetupView && !selectedEmptyTaskId

  const openSetupOverview = () => {
    setOpenEmptyTaskId(null)
    setSelectedEmptyTaskId(null)
    ;(window as unknown as { klausOpenCronSetup?: () => void }).klausOpenCronSetup?.()
    window.dispatchEvent(new CustomEvent(CRON_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { taskId: null } }))
  }

  const switchCronSession = (sessionId: string) => {
    setOpenEmptyTaskId(null)
    setSelectedEmptyTaskId(null)
    window.dispatchEvent(new CustomEvent(CRON_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { taskId: null } }))
    void (window as unknown as { klausSwitchSession?: (id: string) => Promise<void> | void }).klausSwitchSession?.(sessionId)
  }

  const handleTaskGroupClick = (taskId: string, taskSessions: CronSessionItem[]) => {
    if (taskSessions.length > 0) {
      toggleScopedModuleGroup('cron', taskId)
      return
    }
    if (openEmptyTaskId === taskId) {
      setOpenEmptyTaskId(null)
      if (selectedEmptyTaskId === taskId) {
        setSelectedEmptyTaskId(null)
        window.dispatchEvent(new CustomEvent(CRON_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { taskId: null } }))
      }
      return
    }
    setOpenEmptyTaskId(taskId)
    setSelectedEmptyTaskId(taskId)
    ;(window as unknown as { klausOpenCronSetup?: () => void }).klausOpenCronSetup?.()
    window.dispatchEvent(new CustomEvent(CRON_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { taskId } }))
  }

  const visibleTasks = sortTasksFlat(
    tasks.filter(task => {
      if (filter === 'enabled') return !!task.enabled
      if (filter === 'paused') return !task.enabled
      return true
    }),
    status,
  )

  const showOrphans = filter === 'all' && sessionsSnap.orphanSessions.length > 0

  return (
    <div className={styles.pane}>
      <div className={styles.navBlock}>
        <button
          type="button"
          className={`${styles.row}${setupNavActive ? ` ${styles.rowActive}` : ''}`}
          onClick={openSetupOverview}
        >
          <Icon name="settings-nav-preferences" />
          <span>{t('cron_setup_nav')}</span>
          {tasks.length > 0 && <span className={styles.barMeta}>{enabledCount}/{tasks.length}</span>}
        </button>
      </div>
      <div className={styles.divider} />

      <div className={styles.pills}>
        {(['all', 'enabled', 'paused'] as const).map(f => (
          <button
            key={f}
            type="button"
            className={`${styles.pill}${filter === f ? ` ${styles.pillActive}` : ''}`}
            onClick={() => setFilter(f)}
          >
            {t(`cron_filter_${f}`)}
          </button>
        ))}
      </div>

      <div className={styles.scroll}>
        {visibleTasks.length === 0 && !showOrphans ? (
          <div className={styles.empty}>
            {filter !== 'all' ? t('cron_search_empty') : t('no_cron')}
          </div>
        ) : (
          <>
            {visibleTasks.map(task => {
              const taskSessions = sessionsSnap.sessionsByTask[task.id] || []
              const running = status.running.includes(task.id) || taskSessions.some(s => s.working)
              const isOpen = isModuleGroupOpen(expansionMap, task.id, taskSessions.length > 0, openEmptyTaskId)
              const hasActiveSession = !sessionsSnap.inSetupView && taskSessions.some(s => s.id === sessionsSnap.activeSessionId)
              const isEmptySelected = sessionsSnap.inSetupView && selectedEmptyTaskId === task.id
              const rowHighlighted = isEmptySelected || (hasActiveSession && !isOpen)
              const label = task.name || task.id
              return (
                <div key={task.id} className={styles.channelGroup}>
                  <button
                    type="button"
                    className={`${styles.row}${rowHighlighted ? ` ${styles.rowActive}` : ''}`}
                    aria-expanded={isOpen}
                    onClick={() => handleTaskGroupClick(task.id, taskSessions)}
                  >
                    <span
                      className={`${styles.dot}${running ? ` ${styles.dotBusy}` : task.enabled ? ` ${styles.dotOk}` : ''}`}
                      aria-hidden="true"
                    />
                    <span className={styles.rowStack}>
                      <span className={styles.rowLabel}>{label}</span>
                    </span>
                    <span className={`${styles.chevron}${isOpen ? ` ${styles.chevronOpen}` : ''}`} aria-hidden="true">
                      <Icon name="chevron-down" />
                    </span>
                  </button>
                  {isOpen && (
                    <div className={styles.subList}>
                      {taskSessions.length === 0 ? (
                        <div className={styles.subEmpty}>{t('ch_no_sessions_short')}</div>
                      ) : taskSessions.map(item => {
                        const isCurrent = !sessionsSnap.inSetupView && sessionsSnap.activeSessionId === item.id
                        return (
                          <button
                            key={item.id}
                            type="button"
                            data-session-id={item.id}
                            className={`${styles.subRow}${isCurrent ? ` ${styles.subRowActive}` : ''}`}
                            onClick={() => switchCronSession(item.id)}
                          >
                            {(item.working || item.waitingInput || item.unread) && (
                              <span
                                className={`${styles.dot} ${item.working ? styles.dotBusy : styles.dotAttn}`}
                                aria-hidden="true"
                              />
                            )}
                            <span className={styles.subRowTitle}>{item.title}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}

            {showOrphans && (() => {
              const orphanSessions = sessionsSnap.orphanSessions
              const isOpen = isModuleGroupOpen(expansionMap, ORPHAN_CRON_GROUP_ID, orphanSessions.length > 0, openEmptyTaskId)
              const hasActiveSession = !sessionsSnap.inSetupView && orphanSessions.some(s => s.id === sessionsSnap.activeSessionId)
              const rowHighlighted = hasActiveSession && !isOpen
              return (
                <div className={styles.channelGroup}>
                  <button
                    type="button"
                    className={`${styles.row}${rowHighlighted ? ` ${styles.rowActive}` : ''}`}
                    aria-expanded={isOpen}
                    onClick={() => handleTaskGroupClick(ORPHAN_CRON_GROUP_ID, orphanSessions)}
                  >
                    <span className={styles.dot} aria-hidden="true" />
                    <span className={styles.rowStack}>
                      <span className={styles.rowLabel}>{t('cron_deleted_tasks_group')}</span>
                    </span>
                    <span className={`${styles.chevron}${isOpen ? ` ${styles.chevronOpen}` : ''}`} aria-hidden="true">
                      <Icon name="chevron-down" />
                    </span>
                  </button>
                  {isOpen && (
                    <div className={styles.subList}>
                      {orphanSessions.map(item => {
                        const isCurrent = !sessionsSnap.inSetupView && sessionsSnap.activeSessionId === item.id
                        return (
                          <button
                            key={item.id}
                            type="button"
                            data-session-id={item.id}
                            className={`${styles.subRow}${isCurrent ? ` ${styles.subRowActive}` : ''}`}
                            onClick={() => switchCronSession(item.id)}
                          >
                            {(item.working || item.waitingInput || item.unread) && (
                              <span
                                className={`${styles.dot} ${item.working ? styles.dotBusy : styles.dotAttn}`}
                                aria-hidden="true"
                              />
                            )}
                            <span className={styles.subRowTitle}>{item.title}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}
          </>
        )}
      </div>
    </div>
  )
}

function findChannelGroup(snap: ChannelSessionsSnapshot, sessionId: string) {
  return Object.entries(snap.sessionsByChannel).find(([, rows]) => rows.some(row => row.id === sessionId))?.[0]
}

function reconcileChannelExpansion(detail: ChannelSessionsSnapshot) {
  const activeId = detail.inSetupView ? null : detail.activeSessionId
  moduleExpansionStores.channels.reconcile(detail, activeId, activeId ? findChannelGroup(detail, activeId) : undefined)
}

function ChannelsSecondaryPane() {
  const t = useT()
  const [filter, setFilter] = useState<'all' | 'active' | 'connected'>('all')
  const [states, setStates] = useState<Map<string, ChannelPresentationState>>(new Map())
  const [sessionsSnap, setSessionsSnap] = useState<ChannelSessionsSnapshot>(readInitialChannelSessionsSnapshot)
  const [selectedEmptyChannelId, setSelectedEmptyChannelId] = useState<string | null>(null)
  const [openEmptyChannelId, setOpenEmptyChannelId] = useState<string | null>(null)
  const expansionMap = useModuleGroupExpansion('channels')

  const loadChannels = useCallback(() => {
    const api = (window as unknown as { klaus?: { channels?: { list?: () => Promise<Array<ChannelPresentationState & { id: string }>> } } }).klaus?.channels
    void api?.list?.()
      .then(list => {
        if (!Array.isArray(list)) return
        setStates(new Map(list.map(entry => [entry.id, entry])))
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let latestSnapshot = readInitialChannelSessionsSnapshot()
    reconcileChannelExpansion(latestSnapshot)
    loadChannels()
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<{ channels?: Array<ChannelPresentationState & { id: string }>; emptyChannelId?: string | null }>).detail
      if (Array.isArray(detail?.channels)) {
        setStates(new Map(detail.channels.map(entry => [entry.id, entry])))
      }
      if (detail && 'emptyChannelId' in detail) {
        const nextEmpty = detail.emptyChannelId ?? null
        if (!nextEmpty) setOpenEmptyChannelId(null)
        setSelectedEmptyChannelId(nextEmpty)
      }
    }
    const reveal = listenForSidebarReveal('channels', sessionId => {
      const groupId = findChannelGroup(latestSnapshot, sessionId)
      if (!groupId) return false
      setFilter('all')
      setOpenEmptyChannelId(null)
      setSelectedEmptyChannelId(null)
      revealScopedModuleGroup('channels', groupId)
      return true
    })
    const onSessions = (event: Event) => {
      const detail = (event as CustomEvent<ChannelSessionsSnapshot>).detail
      if (!detail) return
      latestSnapshot = detail
      reconcileChannelExpansion(detail)
      setSessionsSnap(detail)
      reveal.consume()
      if (!detail.inSetupView) {
        setOpenEmptyChannelId(null)
        setSelectedEmptyChannelId(null)
      }
    }
    window.addEventListener(CHANNELS_SIDEBAR_SYNC_EVENT, onSync)
    window.addEventListener(CHANNELS_SIDEBAR_SESSIONS_EVENT, onSessions)
    return () => {
      reveal.dispose()
      window.removeEventListener(CHANNELS_SIDEBAR_SYNC_EVENT, onSync)
      window.removeEventListener(CHANNELS_SIDEBAR_SESSIONS_EVENT, onSessions)
    }
  }, [loadChannels])

  useEffect(() => { flushPendingSidebarScroll('channels') }, [sessionsSnap, expansionMap, openEmptyChannelId, filter])

  const connectedCount = CHANNEL_ROWS.filter(row => isChannelConfigured(states.get(row.id), row.requiredKeys)).length
  const setupNavActive = sessionsSnap.inSetupView && !selectedEmptyChannelId

  const openSetupOverview = () => {
    setOpenEmptyChannelId(null)
    setSelectedEmptyChannelId(null)
    ;(window as unknown as { klausOpenChannelsSetup?: () => void }).klausOpenChannelsSetup?.()
    window.dispatchEvent(new CustomEvent(CHANNELS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { channelId: null } }))
  }

  const switchChannelSession = (sessionId: string) => {
    setOpenEmptyChannelId(null)
    setSelectedEmptyChannelId(null)
    window.dispatchEvent(new CustomEvent(CHANNELS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { channelId: null } }))
    void (window as unknown as { klausSwitchSession?: (id: string) => Promise<void> | void }).klausSwitchSession?.(sessionId)
  }

  const handleChannelClick = (row: ChannelRowMeta) => {
    const channelSessions = sessionsSnap.sessionsByChannel[row.id] || []
    if (channelSessions.length > 0) {
      toggleScopedModuleGroup('channels', row.id)
      return
    }
    if (openEmptyChannelId === row.id) {
      setOpenEmptyChannelId(null)
      if (selectedEmptyChannelId === row.id) {
        setSelectedEmptyChannelId(null)
        window.dispatchEvent(new CustomEvent(CHANNELS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { channelId: null } }))
      }
      return
    }
    setOpenEmptyChannelId(row.id)
    setSelectedEmptyChannelId(row.id)
    ;(window as unknown as { klausOpenChannelsSetup?: () => void }).klausOpenChannelsSetup?.()
    window.dispatchEvent(new CustomEvent(CHANNELS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { channelId: row.id } }))
  }

  const rows = CHANNEL_ROWS.filter(row => {
    const channelSessions = sessionsSnap.sessionsByChannel[row.id] || []
    if (filter === 'active') return channelSessions.length > 0
    if (filter === 'connected') return isChannelConfigured(states.get(row.id), row.requiredKeys)
    return true
  })

  return (
    <div className={styles.pane}>
      <div className={styles.navBlock}>
        <button
          type="button"
          className={`${styles.row}${setupNavActive ? ` ${styles.rowActive}` : ''}`}
          onClick={openSetupOverview}
        >
          <Icon name="settings-nav-preferences" />
          <span>{t('ch_setup_nav')}</span>
          <span className={styles.barMeta}>{connectedCount}/{CHANNEL_ROWS.length}</span>
        </button>
      </div>
      <div className={styles.divider} />

      <div className={styles.pills}>
        <button
          type="button"
          className={`${styles.pill}${filter === 'all' ? ` ${styles.pillActive}` : ''}`}
          onClick={() => setFilter('all')}
        >
          {t('cron_filter_all')}
        </button>
        <button
          type="button"
          className={`${styles.pill}${filter === 'active' ? ` ${styles.pillActive}` : ''}`}
          onClick={() => setFilter('active')}
        >
          {t('ch_filter_with_chats')}
        </button>
        <button
          type="button"
          className={`${styles.pill}${filter === 'connected' ? ` ${styles.pillActive}` : ''}`}
          onClick={() => setFilter('connected')}
        >
          {t('ch_connected')}
        </button>
      </div>

      <div className={styles.scroll}>
        {rows.length === 0 ? (
          <div className={styles.empty}>{t('ch_no_sessions_short')}</div>
        ) : rows.map(row => {
          const channelSessions = sessionsSnap.sessionsByChannel[row.id] || []
          const unreadBadge = formatChannelUnreadBadge(sumChannelUnreadCount(channelSessions))
          const isOpen = isModuleGroupOpen(expansionMap, row.id, channelSessions.length > 0, openEmptyChannelId)
          const hasActiveSession = !sessionsSnap.inSetupView && channelSessions.some(s => s.id === sessionsSnap.activeSessionId)
          const isEmptySelected = sessionsSnap.inSetupView && selectedEmptyChannelId === row.id
          const rowHighlighted = isEmptySelected || (hasActiveSession && !isOpen)
          return (
            <div key={row.id} className={styles.channelGroup}>
              <button
                type="button"
                className={`${styles.row}${rowHighlighted ? ` ${styles.rowActive}` : ''}`}
                aria-expanded={isOpen}
                onClick={() => handleChannelClick(row)}
              >
                <img src={row.icon} alt="" className={styles.channelIcon} />
                <span className={styles.rowStack}>
                  <span className={styles.rowLabel}>{row.label}</span>
                </span>
                {unreadBadge && (
                  <span className={styles.countBadge}>{unreadBadge}</span>
                )}
                <span className={`${styles.chevron}${isOpen ? ` ${styles.chevronOpen}` : ''}`} aria-hidden="true">
                  <Icon name="chevron-down" />
                </span>
              </button>
              {isOpen && (
                <div className={styles.subList}>
                  {channelSessions.length === 0 ? (
                    <div className={styles.subEmpty}>{t('ch_no_sessions_short')}</div>
                  ) : channelSessions.map(item => {
                    const active = !sessionsSnap.inSetupView && item.id === sessionsSnap.activeSessionId
                    const displayTitle = stripChannelTitlePrefix(item.title, row.label)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-session-id={item.id}
                        className={`${styles.subRow}${active ? ` ${styles.subRowActive}` : ''}`}
                        onClick={() => switchChannelSession(item.id)}
                      >
                        {(item.working || item.waitingInput || item.unread) && (
                          <span className={`${styles.dot}${item.working ? ` ${styles.dotBusy}` : ` ${styles.dotAttn}`}`} aria-hidden="true" />
                        )}
                        <span className={styles.subRowTitle}>{displayTitle}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MemorySecondaryPane() {
  const t = useT()
  const [range, setRange] = useState<string>('all')
  const [dream, setDream] = useState<DreamRun | null>(() => getCurrentDream())
  const [files, setFiles] = useState<MemorySidebarFileEntry[]>([])
  const [indexPaths, setIndexPaths] = useState<string[]>([])

  const loadMemoryFiles = useCallback(async () => {
    const win = window as unknown as {
      klaus?: {
        memory?: { readFile?: (relPath: string) => Promise<{ ok?: boolean; content?: string }> }
        projects?: { list?: () => Promise<{ roots?: Array<string | { path?: string }> } | null | undefined> }
      }
    }
    const readFile = win.klaus?.memory?.readFile
    if (typeof readFile !== 'function') return

    const candidateDirs = ['agent-memory']
    try {
      const proj = await win.klaus?.projects?.list?.()
      const roots = Array.isArray(proj?.roots) ? proj.roots : []
      for (const item of roots) {
        const rootPath = typeof item === 'string' ? item : item?.path
        if (!rootPath) continue
        const slug = rootPath.replace(/[^A-Za-z0-9]/g, '-')
        const dir = `projects/${slug}/memory`
        if (!candidateDirs.includes(dir)) candidateDirs.push(dir)
      }
    } catch {}

    const discoveredIndexes: string[] = []
    const collectedEntries: MemorySidebarFileEntry[] = []
    const seenPaths = new Set<string>()

    for (const dir of candidateDirs) {
      try {
        const indexRel = `${dir}/MEMORY.md`
        const res = await readFile(indexRel)
        if (!res?.ok || typeof res.content !== 'string' || !res.content.trim()) continue
        discoveredIndexes.push(indexRel)
        for (const entry of parseMemoryIndexMarkdown(res.content, dir)) {
          if (seenPaths.has(entry.path)) continue
          seenPaths.add(entry.path)
          collectedEntries.push(entry)
        }
      } catch {}
    }

    setIndexPaths(discoveredIndexes)
    setFiles(collectedEntries)
  }, [])

  useEffect(() => {
    void loadMemoryFiles()
    const onDream = (event: Event) => {
      const next = ((event as CustomEvent).detail as DreamRun | null) ?? null
      setDream(next)
      if (next && next.status !== 'running') void loadMemoryFiles()
    }
    const onSync = (event: Event) => {
      const next = (event as CustomEvent<{ timeRange?: string }>).detail?.timeRange
      if (next) setRange(next)
    }
    window.addEventListener(MEMORY_DREAM_EVENT, onDream)
    window.addEventListener(MEMORY_SIDEBAR_SYNC_EVENT, onSync)
    return () => {
      window.removeEventListener(MEMORY_DREAM_EVENT, onDream)
      window.removeEventListener(MEMORY_SIDEBAR_SYNC_EVENT, onSync)
    }
  }, [loadMemoryFiles])

  const running = dream?.status === 'running'
  const ranges: Array<{ value: string; key: string }> = [
    { value: 'all', key: 'memory_filter_all' },
    { value: 'today', key: 'memory_filter_today' },
    { value: 'week', key: 'memory_filter_week' },
    { value: 'month', key: 'memory_filter_month' },
  ]

  const openMemoryFile = (relPath: string) => {
    const api = (window as unknown as { klaus?: { memory?: { openWindow?: (p: string) => Promise<unknown> } }; showToast?: (msg: string) => void })
    void api.klaus?.memory?.openWindow?.(relPath)?.catch((err: unknown) => {
      api.showToast?.(err instanceof Error ? err.message : t('settings_failed'))
    })
  }

  return (
    <div className={styles.pane}>
      {running && (
        <div className={styles.statusCard}>
          <span className={`${styles.dot} ${styles.dotBusy}`} aria-hidden="true" />
          <span>{t('memory_dream_title')}</span>
        </div>
      )}

      <div className={styles.groupLabel}>{t('memory_history')}</div>
      <div className={styles.pills}>
        {ranges.map(item => (
          <button
            key={item.value}
            type="button"
            className={`${styles.pill}${range === item.value ? ` ${styles.pillActive}` : ''}`}
            onClick={() => {
              setRange(item.value)
              window.dispatchEvent(new CustomEvent(MEMORY_SIDEBAR_FILTER_EVENT, { detail: { timeRange: item.value } }))
            }}
          >
            {t(item.key)}
          </button>
        ))}
      </div>

      <div className={styles.scroll}>
        <div className={styles.groupLabel}>{t('context_cat_memory')}</div>
        {indexPaths.length === 0 && files.length === 0 ? (
          <div className={styles.empty}>{t('memory_sidebar_files_empty')}</div>
        ) : (
          <>
            {indexPaths[0] && (
              <button
                type="button"
                className={styles.row}
                onClick={() => openMemoryFile(indexPaths[0]!)}
              >
                <Icon name="overview-ref-memory" />
                <span className={styles.rowStack}>
                  <span className={styles.rowLabel}>{friendlyMemoryName('MEMORY.md')}</span>
                  <span className={styles.rowMeta}>MEMORY.md</span>
                </span>
              </button>
            )}
            {files.map(entry => (
              <button
                key={entry.path}
                type="button"
                className={styles.row}
                onClick={() => openMemoryFile(entry.path)}
              >
                <Icon name="chat-file" />
                <span className={styles.rowStack}>
                  <span className={styles.rowLabel}>{entry.title}</span>
                  {entry.hook ? <span className={styles.rowMeta}>{entry.hook}</span> : null}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function TeamCollaborationSecondaryPane() {
  const t = useT()
  const { route, navigate } = useCollaborationRoute()
  const [projects, setProjects] = useState<CollaborationProject[]>([])

  const loadProjects = useCallback(() => {
    void allPages(cursor => collaborationRequest({ type: 'projects.list', archived: route.archived, cursor, limit: 100 }))
      .then(list => setProjects(list))
      .catch(() => setProjects([]))
  }, [route.archived])

  useEffect(() => {
    loadProjects()
    window.addEventListener(COLLABORATION_REFRESH, loadProjects)
    return () => window.removeEventListener(COLLABORATION_REFRESH, loadProjects)
  }, [loadProjects])

  return (
    <div className={styles.pane}>
      <div className={styles.pillsBar}>
        <div className={styles.pillsInline}>
          <button
            type="button"
            className={`${styles.pill}${!route.archived ? ` ${styles.pillActive}` : ''}`}
            onClick={() => navigate({ ...route, projectId: null, archived: false, inviteToken: null })}
          >
            {t('tc_active')}
          </button>
          <button
            type="button"
            className={`${styles.pill}${route.archived ? ` ${styles.pillActive}` : ''}`}
            onClick={() => navigate({ ...route, projectId: null, archived: true, inviteToken: null })}
          >
            {t('tc_archived')}
          </button>
        </div>
      </div>

      <div className={styles.scroll}>
        {projects.length === 0 ? (
          <div className={styles.empty}>
            {route.archived ? t('tc_archived_empty') : t('tc_empty')}
          </div>
        ) : projects.map(project => (
          <button
            key={project.id}
            type="button"
            className={`${styles.row}${route.projectId === project.id ? ` ${styles.rowActive}` : ''}`}
            onClick={() => navigate({ ...route, projectId: project.id, archived: !!project.archivedAt, inviteToken: null })}
          >
            <Icon name="folder" />
            <span className={styles.rowStack}>
              <span className={styles.rowLabel}>{project.name}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export interface FriendDirectorySyncItem {
  id: string
  userId?: string
  name: string
  avatarUrl?: string | null
  online?: boolean
  peerAllowsAgentTasks?: boolean
}

export interface FriendConversationItem {
  id: string
  friendshipId: string
  title: string
  updatedAt: number
  unread: boolean
  working: boolean
  waitingInput: boolean
  awaitingReply: boolean
}

export interface FriendGroupItem {
  id: string
  name: string
  avatarUrl?: string | null
  online?: boolean
  peerAllowsAgentTasks?: boolean
  attentionCount: number
  updatedAt: number
  sessions: FriendConversationItem[]
}

export interface FriendSidebarSessionsSnapshot {
  groups: FriendGroupItem[]
  activeSessionId: string | null
  inManagementView: boolean
}

interface FriendsSidebarSyncDetail {
  accepted: number
  requests: number
  signedIn?: boolean
  acceptedFriends?: FriendDirectorySyncItem[]
  emptyFriendId?: string | null
}

function readInitialFriendSessionsSnapshot(): FriendSidebarSessionsSnapshot {
  const cached = (window as unknown as { __klausFriendSidebarSessions?: FriendSidebarSessionsSnapshot }).__klausFriendSidebarSessions
  return cached || { groups: [], activeSessionId: null, inManagementView: true }
}

function findFriendGroup(snap: FriendSidebarSessionsSnapshot, sessionId: string) {
  return snap.groups.find(group => group.sessions.some(row => row.id === sessionId))?.id
}

function reconcileFriendExpansion(detail: FriendSidebarSessionsSnapshot) {
  const activeId = detail.inManagementView ? null : detail.activeSessionId
  moduleExpansionStores.friends.reconcile(detail, activeId, activeId ? findFriendGroup(detail, activeId) : undefined)
}

function FriendsSecondaryPane() {
  const t = useT()
  const [requestsCount, setRequestsCount] = useState(0)
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [activeManagementSection, setActiveManagementSection] = useState<'list' | 'requests'>('list')
  const [filter, setFilter] = useState<'all' | 'active' | 'attention'>('all')
  const [selectedEmptyFriendId, setSelectedEmptyFriendId] = useState<string | null>(null)
  const [sessionsSnap, setSessionsSnap] = useState<FriendSidebarSessionsSnapshot>(readInitialFriendSessionsSnapshot)
  const [fallbackFriends, setFallbackFriends] = useState<FriendDirectorySyncItem[]>([])
  const [openEmptyFriendId, setOpenEmptyFriendId] = useState<string | null>(null)
  const expansionMap = useModuleGroupExpansion('friends')

  const loadFriendsList = useCallback(() => {
    const api = (window as unknown as {
      klaus?: {
        friends?: {
          list?: () => Promise<{
            signedIn?: boolean
            friends?: Array<{
              id?: string
              userId?: string
              displayName?: string
              remark?: string
              email?: string
              avatarUrl?: string | null
              status?: string
              online?: boolean
              peerAllowsAgentTasks?: boolean
            }>
          } | null | undefined>
        }
      }
    }).klaus?.friends
    void api?.list?.()
      .then(snapshot => {
        if (!snapshot) return
        if (typeof snapshot.signedIn === 'boolean') setSignedIn(snapshot.signedIn)
        const rows = Array.isArray(snapshot.friends) ? snapshot.friends : []
        setRequestsCount(rows.filter(r => r?.id && r.status !== 'accepted').length)
        setFallbackFriends(
          rows
            .filter((r): r is NonNullable<typeof r> & { id: string } => Boolean(r?.id && r.status === 'accepted'))
            .map(r => ({
              id: r.id,
              userId: r.userId,
              name: friendDisplayName(r),
              avatarUrl: r.avatarUrl,
              online: r.online,
              peerAllowsAgentTasks: r.peerAllowsAgentTasks,
            })),
        )
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let latestSnapshot = readInitialFriendSessionsSnapshot()
    reconcileFriendExpansion(latestSnapshot)
    loadFriendsList()
    const authApi = (window as unknown as {
      klaus?: {
        klausAuth?: { status?: () => Promise<{ loggedIn?: boolean } | null | undefined> }
        on?: {
          klausAuthUpdated?: (cb: (payload: { user?: unknown }) => void) => () => void
          friendsChanged?: (cb: () => void) => () => void
        }
      }
    }).klaus
    void authApi?.klausAuth?.status?.()
      .then(res => {
        if (res && typeof res.loggedIn === 'boolean') setSignedIn(prev => prev ?? res.loggedIn!)
      })
      .catch(() => {})
    const offAuth = authApi?.on?.klausAuthUpdated?.(payload => {
      setSignedIn(Boolean(payload?.user))
      setSigningIn(false)
      loadFriendsList()
    })
    const offFriends = authApi?.on?.friendsChanged?.(() => {
      loadFriendsList()
    })
    const onSync = (event: Event) => {
      const detail = (event as CustomEvent<FriendsSidebarSyncDetail>).detail
      if (!detail) return
      if (typeof detail.requests === 'number') setRequestsCount(detail.requests)
      if (typeof detail.signedIn === 'boolean') setSignedIn(detail.signedIn)
      if (Array.isArray(detail.acceptedFriends)) setFallbackFriends(detail.acceptedFriends)
      if ('emptyFriendId' in detail) {
        const nextEmpty = detail.emptyFriendId ?? null
        if (!nextEmpty) setOpenEmptyFriendId(null)
        setSelectedEmptyFriendId(nextEmpty)
      }
    }
    const reveal = listenForSidebarReveal('friends', sessionId => {
      const groupId = findFriendGroup(latestSnapshot, sessionId)
      if (!groupId) return false
      setFilter('all')
      setOpenEmptyFriendId(null)
      setSelectedEmptyFriendId(null)
      revealScopedModuleGroup('friends', groupId)
      return true
    })
    const onSessions = (event: Event) => {
      const detail = (event as CustomEvent<FriendSidebarSessionsSnapshot>).detail
      if (!detail) return
      latestSnapshot = detail
      reconcileFriendExpansion(detail)
      setSessionsSnap(detail)
      reveal.consume()
      if (!detail.inManagementView) {
        setOpenEmptyFriendId(null)
        setSelectedEmptyFriendId(null)
      }
    }
    window.addEventListener(FRIENDS_SIDEBAR_SYNC_EVENT, onSync)
    window.addEventListener(FRIENDS_SIDEBAR_SESSIONS_EVENT, onSessions)
    return () => {
      offAuth?.()
      offFriends?.()
      reveal.dispose()
      window.removeEventListener(FRIENDS_SIDEBAR_SYNC_EVENT, onSync)
      window.removeEventListener(FRIENDS_SIDEBAR_SESSIONS_EVENT, onSessions)
    }
  }, [loadFriendsList])

  useEffect(() => { flushPendingSidebarScroll('friends') }, [fallbackFriends, sessionsSnap, expansionMap, openEmptyFriendId, filter])

  const mergedGroups: FriendGroupItem[] = (() => {
    if (sessionsSnap.groups.length === 0 && fallbackFriends.length === 0) return []
    const byId = new Map<string, FriendGroupItem>()
    for (const group of sessionsSnap.groups) {
      byId.set(group.id, group)
    }
    for (const friend of fallbackFriends) {
      const existing = byId.get(friend.id)
      if (existing) {
        byId.set(friend.id, {
          ...existing,
          name: friend.name || existing.name,
          avatarUrl: friend.avatarUrl ?? existing.avatarUrl,
          online: friend.online ?? existing.online,
          peerAllowsAgentTasks: friend.peerAllowsAgentTasks ?? existing.peerAllowsAgentTasks,
        })
      } else {
        byId.set(friend.id, {
          id: friend.id,
          name: friend.name,
          avatarUrl: friend.avatarUrl,
          online: friend.online,
          peerAllowsAgentTasks: friend.peerAllowsAgentTasks,
          attentionCount: 0,
          updatedAt: 0,
          sessions: [],
        })
      }
    }
    return [...byId.values()].sort((a, b) => {
      if ((a.sessions.length > 0) !== (b.sessions.length > 0)) {
        return a.sessions.length > 0 ? -1 : 1
      }
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
      return a.name.localeCompare(b.name)
    })
  })()

  const openManagementView = (section: 'list' | 'requests') => {
    setActiveManagementSection(section)
    setOpenEmptyFriendId(null)
    setSelectedEmptyFriendId(null)
    ;(window as unknown as { klausOpenFriendsManagement?: () => void }).klausOpenFriendsManagement?.()
    window.dispatchEvent(new CustomEvent(FRIENDS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { friendId: null } }))
    window.dispatchEvent(new CustomEvent(FRIENDS_SIDEBAR_ACTION_EVENT, { detail: { action: section } }))
  }

  const switchFriendSession = (sessionId: string) => {
    setOpenEmptyFriendId(null)
    setSelectedEmptyFriendId(null)
    window.dispatchEvent(new CustomEvent(FRIENDS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { friendId: null } }))
    void (window as unknown as { klausSwitchSession?: (id: string) => Promise<void> | void }).klausSwitchSession?.(sessionId)
  }

  const handleFriendGroupClick = (group: FriendGroupItem) => {
    if (group.sessions.length > 0) {
      toggleScopedModuleGroup('friends', group.id)
      return
    }
    if (openEmptyFriendId === group.id) {
      setOpenEmptyFriendId(null)
      if (selectedEmptyFriendId === group.id) {
        setSelectedEmptyFriendId(null)
        window.dispatchEvent(new CustomEvent(FRIENDS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { friendId: null } }))
      }
      return
    }
    setOpenEmptyFriendId(group.id)
    setSelectedEmptyFriendId(group.id)
    ;(window as unknown as { klausOpenFriendsManagement?: () => void }).klausOpenFriendsManagement?.()
    window.dispatchEvent(new CustomEvent(FRIENDS_SIDEBAR_SELECT_EMPTY_EVENT, { detail: { friendId: group.id } }))
  }

  const handleGuestSignIn = () => {
    if (signingIn) return
    setSigningIn(true)
    void startGuestSignin().finally(() => setSigningIn(false))
  }

  const filteredGroups = mergedGroups.filter(group => {
    if (filter === 'active') return group.sessions.length > 0
    if (filter === 'attention') {
      return (!sessionsSnap.inManagementView && group.sessions.some(s => s.id === sessionsSnap.activeSessionId)) || group.attentionCount > 0 || group.sessions.some(s => s.waitingInput || s.awaitingReply || s.unread)
    }
    return true
  })

  const manageListActive = sessionsSnap.inManagementView && activeManagementSection === 'list' && !selectedEmptyFriendId
  const manageRequestsActive = sessionsSnap.inManagementView && activeManagementSection === 'requests' && !selectedEmptyFriendId

  return (
    <div className={styles.pane}>
      <div className={styles.navBlock}>
        <button
          type="button"
          className={`${styles.row}${manageListActive ? ` ${styles.rowActive}` : ''}`}
          onClick={() => openManagementView('list')}
        >
          <Icon name="sb-nav-friends" />
          <span>{t('friends_manage_nav')}</span>
          {mergedGroups.length > 0 && <span className={styles.barMeta}>{mergedGroups.length}</span>}
        </button>

        {requestsCount > 0 && (
          <button
            type="button"
            className={`${styles.row}${manageRequestsActive ? ` ${styles.rowActive}` : ''}`}
            onClick={() => openManagementView('requests')}
          >
            <Icon name="sidebar-activity" />
            <span>{t('friends_requests')}</span>
            <span className={`${styles.countBadge} ${styles.countBadgeAttn}`}>{requestsCount}</span>
          </button>
        )}
      </div>
      <div className={styles.divider} />

      {signedIn !== false && (
        <div className={styles.pills}>
          <button
            type="button"
            className={`${styles.pill}${filter === 'all' ? ` ${styles.pillActive}` : ''}`}
            onClick={() => setFilter('all')}
          >
            {t('cron_filter_all')}
          </button>
          <button
            type="button"
            className={`${styles.pill}${filter === 'active' ? ` ${styles.pillActive}` : ''}`}
            onClick={() => setFilter('active')}
          >
            {t('ch_filter_with_chats')}
          </button>
          <button
            type="button"
            className={`${styles.pill}${filter === 'attention' ? ` ${styles.pillActive}` : ''}`}
            onClick={() => setFilter('attention')}
          >
            {t('friends_filter_attention')}
          </button>
        </div>
      )}

      <div className={styles.scroll}>
        {signedIn === false && mergedGroups.length === 0 ? (
          !sessionsSnap.inManagementView ? (
            <div className={styles.guestCard}>
              <p className={styles.guestCardText}>{t('friends_sign_in')}</p>
              <button
                type="button"
                className={styles.guestCardBtn}
                disabled={signingIn}
                onClick={handleGuestSignIn}
              >
                {t(signingIn ? 'friends_sign_in_pending' : 'friends_sign_in_action')}
              </button>
            </div>
          ) : (
            <div className={styles.empty}>{t('friends_empty')}</div>
          )
        ) : filteredGroups.length === 0 ? (
          <div className={styles.empty}>
            {mergedGroups.length === 0 ? t('friends_empty') : t('ch_no_sessions_short')}
          </div>
        ) : filteredGroups.map(group => {
          const isOpen = isModuleGroupOpen(expansionMap, group.id, group.sessions.length > 0, openEmptyFriendId)
          const hasActiveSession = !sessionsSnap.inManagementView && group.sessions.some(s => s.id === sessionsSnap.activeSessionId)
          const isEmptySelected = sessionsSnap.inManagementView && selectedEmptyFriendId === group.id
          const rowHighlighted = isEmptySelected || (hasActiveSession && !isOpen)
          return (
            <div key={group.id} className={styles.channelGroup}>
              <button
                type="button"
                className={`${styles.row}${rowHighlighted ? ` ${styles.rowActive}` : ''}`}
                aria-expanded={isOpen}
                onClick={() => handleFriendGroupClick(group)}
              >
                <span className={styles.friendAvatarSlot}>
                  <FriendAvatar small name={group.name} url={group.avatarUrl ?? null} />
                  {group.online && <span className={styles.friendOnlineDot} aria-hidden="true" />}
                </span>
                <span className={styles.rowStack}>
                  <span className={styles.rowLabel}>{group.name}</span>
                </span>
                <span className={`${styles.chevron}${isOpen ? ` ${styles.chevronOpen}` : ''}`} aria-hidden="true">
                  <Icon name="chevron-down" />
                </span>
              </button>
              {isOpen && (
                <div className={styles.subList}>
                  {group.sessions.length === 0 ? (
                    <div className={styles.subEmpty}>{t('ch_no_sessions_short')}</div>
                  ) : group.sessions.map(item => {
                    const isCurrent = !sessionsSnap.inManagementView && sessionsSnap.activeSessionId === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-session-id={item.id}
                        className={`${styles.subRow}${isCurrent ? ` ${styles.subRowActive}` : ''}`}
                        onClick={() => switchFriendSession(item.id)}
                      >
                        {(item.working || item.waitingInput || item.awaitingReply || item.unread) && (
                          <span
                            className={`${styles.dot} ${item.working ? styles.dotOk : styles.dotAttn}`}
                            aria-hidden="true"
                          />
                        )}
                        <span className={styles.subRowTitle}>{item.title}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SecondaryModulePanes() {
  const [section, setSection] = useState<PrimaryRailSection>(() => {
    const attr = document.getElementById('sidebar')?.getAttribute('data-rail-section') as PrimaryRailSection | null
    return attr || 'chats'
  })

  useEffect(() => {
    const onSection = (event: Event) => {
      const next = (event as CustomEvent<{ section: PrimaryRailSection }>).detail?.section
      if (next) setSection(next)
    }
    reconcileCronExpansion(readInitialCronSessionsSnapshot())
    const onCronSessions = (event: Event) => {
      const detail = (event as CustomEvent<CronSessionsSnapshot>).detail
      if (detail) reconcileCronExpansion(detail)
    }
    window.addEventListener(CRON_SIDEBAR_SESSIONS_EVENT, onCronSessions)
    reconcileChannelExpansion(readInitialChannelSessionsSnapshot())
    const onChannelsSessions = (event: Event) => {
      const detail = (event as CustomEvent<ChannelSessionsSnapshot>).detail
      if (detail) reconcileChannelExpansion(detail)
    }
    window.addEventListener(CHANNELS_SIDEBAR_SESSIONS_EVENT, onChannelsSessions)
    reconcileFriendExpansion(readInitialFriendSessionsSnapshot())
    const onFriendsSessions = (event: Event) => {
      const detail = (event as CustomEvent<FriendSidebarSessionsSnapshot>).detail
      if (detail) reconcileFriendExpansion(detail)
    }
    window.addEventListener(FRIENDS_SIDEBAR_SESSIONS_EVENT, onFriendsSessions)
    window.addEventListener(RAIL_SECTION_CHANGE_EVENT, onSection)
    return () => {
      window.removeEventListener(RAIL_SECTION_CHANGE_EVENT, onSection)
      window.removeEventListener(CRON_SIDEBAR_SESSIONS_EVENT, onCronSessions)
      window.removeEventListener(CHANNELS_SIDEBAR_SESSIONS_EVENT, onChannelsSessions)
      window.removeEventListener(FRIENDS_SIDEBAR_SESSIONS_EVENT, onFriendsSessions)
    }
  }, [])

  if (section === 'cron') return <CronSecondaryPane />
  if (section === 'channels') return <ChannelsSecondaryPane />
  if (section === 'memory') return <MemorySecondaryPane />
  if (section === 'teamCollaboration') return <TeamCollaborationSecondaryPane />
  if (section === 'friends') return <FriendsSecondaryPane />
  return null
}

let mountedHost: Element | null = null

export function mountSecondaryModulePanes(): void {
  const host = document.getElementById('sidebar-module-panes')
  if (!host || mountedHost === host) return
  mountedHost = host
  createRoot(host).render(<SecondaryModulePanes />)
}
