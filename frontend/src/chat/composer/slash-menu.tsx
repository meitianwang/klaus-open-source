import { ApprovalReviewDenialsMenu } from '../transcript/approval-review'
// Slash commands and workspace mentions share the same menu container.
// chat.ts detects triggers and handles keyboard navigation; this component
// loads candidates, renders groups, and handles selection. File and folder
// categories are local, plugins/devices/conversations have separate queries,
// and file search owns a persistent workspace snapshot. Loading and failures
// stay within each source's group.
import { createRoot } from 'react-dom/client'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { escapeHtml } from '../transcript/factories'
import { FriendAvatar } from '../../pages/friends/FriendsDialog'
import { useFriendsFeatureEnabled } from '../../pages/friends/feature-enabled'
import { pluginMentionNames } from '../../pages/skills/localize'
import { slashRowLabels } from './slash-row-labels'
import { useT } from '../../i18n'
import { queryClient } from '../../app/query-client'
import {
  conversationsQueryKey, CONVERSATIONS_STALE_MS, CONVERSATION_QUERY_DEBOUNCE_MS,
  devicesQueryKey, DEVICES_STALE_MS, friendsQueryKey, FRIENDS_STALE_MS, fetchFriendRows, projectFriendRows,
  fetchConversationRows, fetchDeviceRows, fetchPluginRows, browserTabsQueryOptions, subscribeBrowserTabMentionChanges, MENTION_BROWSER_TABS_KEY,
  pluginsQueryKey, PLUGINS_STALE_MS,
  projectConversationRows, projectDeviceRows, projectFileRows, projectPluginRows,
  type FileHitRow,
} from './mention-queries'
import { WorkspaceFileSearchSession } from './workspace-file-search-session'
import {
  filterMentionRows, mentionRows, mentionSelectionKey, selectableEntries, reconcileMentionActiveIndex,
  type MentionRow, type MentionSection,
} from './mention-sections'
import styles from './composer.module.css'
import { rawIconHtml } from '../../components/Icon'
import type { BrowserTabMention } from '../../../../shared/browser-tab-mention'
import { BrowserTabIcon } from './browser-tab-icon'
import { isManualCompactCommand, manualCompactPresentation, type ManualCompactState } from './manual-compact-command'
import { contextPieSvg } from '../../icons/dynamic'
import { browserTabMentionSection } from './browser-tab-section'
import { contextCommandQueryKey, contextMenuSections, shouldCloseEmptyContextMenu } from './context-menu-model'
import { claimOverlay, overlayIdForElement, registerOverlay } from '../../app/overlay-registry'

export interface MentionEntry {
  name: string
  path: string
  rel: string
  isDir: boolean
  /** Device mentions carry the account device id the chip addresses. */
  deviceId?: string
  /** Friend mentions address the accepted relationship, resolved by the host. */
  friendId?: string
  /** Conversation mentions carry the local session id the chip addresses. */
  conversationId?: string
  browserTab?: BrowserTabMention
  /** Friend rows show the friend's own avatar instead of a generic glyph. */
  avatarUrl?: string | null
  /** Category rows enter a search level instead of inserting a mention. */
  category?: 'files' | 'folders'
  /** Non-file mention entries insert plain text instead of attaching a path. */
  kind?: 'plugin' | 'device' | 'conversation' | 'category' | 'browser-tab' | 'friend' | 'mcp' | 'command' | 'action' | 'agent'
  command?: any
  action?: () => void
  icon?: string
  /** Extra names the row answers to besides `name` (a plugin's raw slug and its product name in the other language). */
  aliases?: string[]
}

/** What the `@` menu should show. chat.ts supplies the intent; this component fetches. */
export interface MentionRequest {
  query: string
  scope: 'files' | 'folders' | null
  sessionId: string | null
  /** Selected workspace for a draft that has no session yet. */
  root?: string
  activation?: 'typed' | 'synthetic'
}

export interface SlashMenuActions {
  manualCompactState?(): ManualCompactState
  subscribeCommandState?(listener: () => void): () => void
  commandIconSvg(command: any): string
  slashCommandDescription(command: any): string
  /** Localized product name a skill row leads with (same source as the chip). */
  slashCommandDisplayName(command: any): string
  slashCommandGroupLabel(key: string): string
  commandGroupKey(command: any): string
  folderIconSvg(): string
  fileIconSvg(name: string): string
  /** Plugin mention glyph. */
  pluginIconSvg(): string
  /** Account-device mention glyph. */
  deviceIconHtml(): string
  /** @-menu category row glyph. */
  categoryIconHtml(category: 'files' | 'folders'): string
  /** Conversation mention glyph. */
  conversationIconHtml(): string
  /** Open a workspace snapshot without promoting a draft into a chat. */
  openFileSearchSession(sessionId: string | null, root?: string): WorkspaceFileSearchSession | null
  contextCommands?(sessionId: string | null, root?: string): Promise<any[]>
  contextCatalogScope?: string
  contextMcp?(sessionId: string | null, root?: string): Promise<Array<{ name?: string }>>
  contextActions?(): MentionEntry[]
  onRequestClose?(): void
  /** Dismiss a settled empty query that has continued into prose. */
  onMentionMenuEmpty(): void
  onSelectCommand(command: any): void
  onSelectMention(entry: MentionEntry, intent?: 'insert' | 'complete'): void
}

export interface SlashMenuApi {
  showApprovalReview(sessionId: string, currentSessionId: () => string | null, close: () => void): void
  showSlash(items: any[]): void
  showMention(request: MentionRequest): void
  hide(): void
  navigate(dir: number): void
  /** Activate the current row, optionally continuing a directory query. */
  clickActive(intent?: 'insert' | 'complete'): boolean
  isOpen(): boolean
  destroy?(): void
  activeIndex(): number
}

interface SlashMenuState {
  mode: null | 'slash' | 'workspace' | 'approval-review'
  approvalReviewRequest?: { sessionId: string; currentSessionId(): string | null; close(): void }
  slashItems: any[]
  mentionRequest: MentionRequest | null
  /**
   * The selectable mention rows in render order, written back by the component
   * so the imperative navigate/clickActive API can address them. Headings and
   * loading/error placeholders are excluded, so activeIdx counts real choices.
   */
  mentionSelectable: MentionEntry[]
  activeIdx: number
}

// slash 模式的分组展开（对齐旧 showSlashMenu 的四组顺序），返回带组头的扁平
// 渲染序列 + 可选择项的顺序表（active 索引按可选择项计）。
function groupSlashItems(items: any[], groupKeyOf: (c: any) => string): Array<{ heading?: string; item?: any }> {
  const groups: Array<{ key: string; items: any[] }> = [
    { key: 'shortcuts', items: [] },
    { key: 'skills', items: [] },
    { key: 'plugins', items: [] },
    { key: 'mcp', items: [] },
  ]
  const byKey = new Map(groups.map(g => [g.key, g]))
  for (const item of items) {
    const group = byKey.get(groupKeyOf(item)) || byKey.get('shortcuts')!
    group.items.push(item)
  }
  const out: Array<{ heading?: string; item?: any }> = []
  for (const group of groups) {
    if (group.items.length === 0) continue
    out.push({ heading: group.key })
    for (const item of group.items) out.push({ item })
  }
  return out
}

interface QueryLike<T> {
  data: T[] | undefined
  isFetching: boolean
  isError: boolean
}

/**
 * Turn one remote group's query state into a section. Rows win; with no rows the
 * section carries its own placeholder (error, then loading, then empty), which
 * is what lets a slow or failed group degrade alone. A disabled group has no
 * data and is not fetching, so it collapses to an empty section that mentionRows
 * drops entirely.
 */
function remoteSection<T>(
  key: string,
  labelKey: string,
  result: QueryLike<T>,
  project: (rows: T[]) => MentionEntry[],
  query: string,
  labels: { loading: string; error: string; empty: string },
): MentionSection {
  const projected = result.data ? project(result.data) : []
  const rows = filterMentionRows(projected, query, Number.MAX_SAFE_INTEGER)
  if (rows.length > 0) return { key, labelKey, rows }
  if (result.isError) return { key, labelKey, rows: [], state: { kind: 'error', labelKey: labels.error } }
  if (result.isFetching) return { key, labelKey, rows: [], state: { kind: 'loading', labelKey: labels.loading } }
  return { key, labelKey, rows: [], state: { kind: 'empty', labelKey: labels.empty } }
}

/** Keep one search snapshot per workspace; ignore results from an older owner. */
function useFileSearchSession(
  openFileSearchSession: (sessionId: string | null, root?: string) => WorkspaceFileSearchSession | null,
  enabled: boolean,
  sessionId: string | null,
  root: string | undefined,
  query: string,
): { data: FileHitRow[] | undefined; isError: boolean; isFetching: boolean } {
  const [state, setState] = useState<{
    data: FileHitRow[] | undefined
    isError: boolean
    settledFor: { owner: object; query: string } | null
  }>({ data: undefined, isError: false, settledFor: null })
  const sessionRef = useRef<WorkspaceFileSearchSession | null>(null)
  const available = enabled && !!(sessionId || root)
  const owner = useMemo(() => ({}), [available, sessionId, root, openFileSearchSession])

  useEffect(() => {
    if (!available) return
    const session = openFileSearchSession(sessionId, root)
    sessionRef.current = session
    return () => {
      if (sessionRef.current === session) sessionRef.current = null
      if (session) void session.close()
    }
  }, [owner, available, sessionId, root, openFileSearchSession])

  useEffect(() => {
    const session = sessionRef.current
    if (!session || !available) return
    let cancelled = false
    const settledFor = { owner, query }
    session.search(query, 40)
      .then(data => { if (!cancelled) setState({ data, isError: false, settledFor }) })
      .catch(() => { if (!cancelled) setState({ data: undefined, isError: true, settledFor }) })
    return () => { cancelled = true }
  }, [query, owner, available])

  const settled = available && state.settledFor?.query === query && state.settledFor.owner === owner
  return { data: settled ? state.data : undefined, isError: settled && state.isError, isFetching: available && !settled }
}

function MentionMenu({ request, actions, store }: {
  request: MentionRequest
  actions: SlashMenuActions
  store: StoreApi<SlashMenuState>
}) {
  const t = useT()
  const activeIdx = useStore(store, s => s.activeIdx)
  const { query, scope, sessionId, root } = request
  const selectMention = (entry: MentionEntry) => {
    const current = store.getState().mentionRequest
    if (current?.query === query && current.scope === scope && current.sessionId === sessionId && current.root === root) actions.onSelectMention(entry)
  }
  const isCategoryLevel = scope === null
  // useT() re-renders this component on a language change, but the `t` it
  // returns is a stable module-level function, so any memo keyed on `t` would
  // NOT recompute and would keep labels in the old language. Key the
  // label-bearing memos on the current language token instead — it flips on a
  // switch, and the re-render is already guaranteed by useT.
  const lang = (typeof window !== 'undefined' ? (window as any).currentLang : 'en') as string

  const commands = useQuery({
    queryKey: contextCommandQueryKey(actions.contextCatalogScope || 'scoped', sessionId, root),
    queryFn: () => actions.contextCommands?.(sessionId, root) ?? Promise.resolve([]),
    staleTime: PLUGINS_STALE_MS,
    enabled: isCategoryLevel,
  })
  const agents = useQuery({
    queryKey: ['composer-context-agents', sessionId],
    queryFn: async () => {
      const result = await window.klaus?.agents?.definitions?.list?.(sessionId || undefined)
      return Array.isArray(result?.agents) ? result.agents as Array<{ agentType?: string; filename?: string; whenToUse?: string }> : []
    },
    staleTime: PLUGINS_STALE_MS,
    enabled: isCategoryLevel,
  })
  const mcp = useQuery({
    queryKey: ['composer-context-mcp', sessionId, root],
    queryFn: () => actions.contextMcp?.(sessionId, root) ?? Promise.resolve([]),
    staleTime: PLUGINS_STALE_MS,
    enabled: isCategoryLevel,
  })
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['composer-context-commands'] })
      void queryClient.invalidateQueries({ queryKey: ['composer-context-mcp'] })
    }
    window.addEventListener('klaus:skills-changed', refresh)
    return () => window.removeEventListener('klaus:skills-changed', refresh)
  }, [])

  // Remote groups. Each is its own query with its own key and staleTime; the
  // list-group keys exclude the query text, so typing re-filters the cache
  // instead of refetching (the structural guarantee against a request storm).
  const plugins = useQuery({
    queryKey: pluginsQueryKey(sessionId),
    queryFn: () => fetchPluginRows(sessionId),
    staleTime: PLUGINS_STALE_MS,
    enabled: isCategoryLevel,
  })
  const devices = useQuery({
    queryKey: devicesQueryKey(),
    queryFn: () => fetchDeviceRows(),
    staleTime: DEVICES_STALE_MS,
    enabled: isCategoryLevel,
  })
  const friendsFeatureEnabled = useFriendsFeatureEnabled()
  useEffect(() => {
    const unsubscribe = window.klaus?.on?.klausAuthUpdated?.(() => {
      void queryClient.cancelQueries({ queryKey: friendsQueryKey() })
      queryClient.setQueryData(friendsQueryKey(), [])
      void queryClient.invalidateQueries({ queryKey: friendsQueryKey() })
    })
    return () => unsubscribe?.()
  }, [])
  useEffect(() => {
    if (!friendsFeatureEnabled) {
      void queryClient.cancelQueries({ queryKey: friendsQueryKey() })
      queryClient.removeQueries({ queryKey: friendsQueryKey() })
      return
    }
    void queryClient.invalidateQueries({ queryKey: friendsQueryKey() })
  }, [friendsFeatureEnabled])
  const friends = useQuery({
    queryKey: friendsQueryKey(),
    queryFn: fetchFriendRows,
    staleTime: FRIENDS_STALE_MS,
    enabled: isCategoryLevel && friendsFeatureEnabled,
  })
  const normalizedQuery = query.trim()
  const [conversationQuery, setConversationQuery] = useState('')
  useEffect(() => {
    if (!normalizedQuery) { setConversationQuery(''); return }
    const timer = window.setTimeout(() => setConversationQuery(normalizedQuery), CONVERSATION_QUERY_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [normalizedQuery])
  const conversations = useQuery({
    queryKey: conversationsQueryKey(conversationQuery),
    queryFn: ({ signal }) => fetchConversationRows(conversationQuery, signal),
    staleTime: CONVERSATIONS_STALE_MS,
    enabled: isCategoryLevel && !!normalizedQuery && conversationQuery === normalizedQuery,
  })
  const conversationData = normalizedQuery && conversationQuery === normalizedQuery ? conversations.data : undefined
  const conversationsPending = !!normalizedQuery && (conversationQuery !== normalizedQuery || conversations.isFetching)
  const conversationsFailed = !!normalizedQuery && conversationQuery === normalizedQuery && conversations.isError
  const browserTabs = useQuery({
    ...browserTabsQueryOptions(sessionId, query),
    enabled: isCategoryLevel,
  })
  useEffect(() => {
    if (!isCategoryLevel) return
    return subscribeBrowserTabMentionChanges((window as any).klaus, sessionId, () => {
      void queryClient.invalidateQueries({ queryKey: [MENTION_BROWSER_TABS_KEY, sessionId] })
    }, window)
  }, [isCategoryLevel, sessionId])
  const files = useFileSearchSession(actions.openFileSearchSession, !isCategoryLevel || !!normalizedQuery, sessionId, root, query)

  const sections = useMemo<MentionSection[]>(() => {
    if (!isCategoryLevel) {
      // Inside files/folders: a single headingless group.
      const projected = files.data ? projectFileRows(files.data) : []
      const rows = scope === 'folders' ? projected.filter(e => e.isDir) : projected
      const capped = rows.slice(0, 40)
      if (capped.length > 0) return [{ key: 'files', labelKey: null, rows: capped }]
      if (files.isError) return [{ key: 'files', labelKey: null, rows: [], state: { kind: 'error', labelKey: 'mention_group_files_error' } }]
      if (!sessionId && !root) return []
      if (files.isFetching) return [{ key: 'files', labelKey: null, rows: [], state: { kind: 'loading', labelKey: 'mention_group_files_loading' } }]
      // An honest "nothing matches" inside a category shows no rows; chat.ts's
      // empty-query rule still governs whether the menu stays open.
      return [{ key: 'files', labelKey: null, rows: [], state: { kind: 'empty', labelKey: 'mention_group_empty' } }]
    }
    const commandRows = (commands.data || []).map(command => ({
      name: actions.slashCommandDisplayName(command), path: `command:${command.name}`,
      rel: actions.slashCommandDescription(command), isDir: false, kind: 'command' as const,
      command,
      aliases: [String(command.name || ''), ...(Array.isArray(command.aliases) ? command.aliases.map((alias: unknown) => String(alias || '')).filter(Boolean) : [])],
      icon: actions.commandIconSvg(command),
    }))
    const sourceSections: MentionSection[] = [
      { key: 'context-actions', labelKey: 'composer_add_menu', rows: actions.contextActions?.() || [] },
      remoteSection('plugins', 'mention_group_plugins', plugins, rows => projectPluginRows(rows, pluginMentionNames), '', {
        loading: 'mention_group_plugins_loading', error: 'mention_group_plugins_error', empty: 'mention_group_empty',
      }),
      { key: 'mcp', labelKey: 'mcp', rows: (mcp.data || []).map(server => ({
        name: server.name || '', path: server.name || '', rel: '', isDir: false, kind: 'mcp' as const,
        icon: rawIconHtml('mcp-grid-fill'),
      })).filter(row => !!row.name), ...(mcp.isError ? { state: { kind: 'error' as const, labelKey: 'composer_load_failed' } }
        : !mcp.data && mcp.isFetching ? { state: { kind: 'loading' as const, labelKey: 'loading' } } : {}) },
      { key: 'agents', labelKey: 'agents', rows: (agents.data || []).filter(agent => !!agent.agentType).map(agent => ({
        name: agent.filename || agent.agentType!, path: agent.agentType!, rel: agent.whenToUse || '',
        isDir: false, kind: 'agent' as const, aliases: [agent.agentType!], icon: rawIconHtml('sb-nav-agents'),
      })), ...(agents.isError ? { state: { kind: 'error' as const, labelKey: 'composer_load_failed' } }
        : !agents.data && agents.isFetching ? { state: { kind: 'loading' as const, labelKey: 'loading' } } : {}) },
      browserTabMentionSection(browserTabs, t),
      remoteSection('devices', 'mention_group_devices', devices, (rows) => projectDeviceRows(rows, t), '', {
        loading: 'mention_group_devices_loading', error: 'mention_group_devices_error', empty: 'mention_group_empty',
      }),
      ...(friendsFeatureEnabled ? [remoteSection('friends', 'mention_group_friends', friends, (rows) => projectFriendRows(rows, t), '', {
        loading: 'mention_group_friends_loading', error: 'mention_group_friends_error', empty: 'mention_group_empty',
      })] : []),
      { key: 'commands', labelKey: 'composer_slash_commands', rows: commandRows.filter(row => actions.commandGroupKey(row.command) !== 'skills'),
        ...(commands.isError ? { state: { kind: 'error' as const, labelKey: 'composer_load_failed' } }
          : !commands.data && commands.isFetching ? { state: { kind: 'loading' as const, labelKey: 'loading' } } : {}) },
      remoteSection('conversations', 'mention_group_conversations', { data: conversationData, isFetching: conversationsPending, isError: conversationsFailed }, rows => projectConversationRows(rows, t), '', {
        loading: 'mention_group_conversations_loading', error: 'mention_group_conversations_error', empty: 'mention_group_empty',
      }),
      { key: 'skills', labelKey: 'skills', rows: commandRows.filter(row => actions.commandGroupKey(row.command) === 'skills') },
      remoteSection('files', 'mention_group_files', files, projectFileRows, '', {
        loading: 'mention_group_files_loading', error: 'mention_group_files_error', empty: 'mention_group_empty',
      }),
    ]
    return contextMenuSections(sourceSections, query)
  }, [isCategoryLevel, scope, sessionId, root, query, friendsFeatureEnabled,
    plugins.data, plugins.isFetching, plugins.isError, devices.data, devices.isFetching, devices.isError,
    friends.data, friends.isFetching, friends.isError, conversationData, conversationsPending, conversationsFailed,
    browserTabs.data, browserTabs.isFetching, browserTabs.isError, files.data, files.isFetching, files.isError,
    commands.data, commands.isFetching, commands.isError, mcp.data, mcp.isFetching, mcp.isError,
    agents.data, agents.isFetching, agents.isError, actions, t, lang])

  const rows = useMemo<MentionRow[]>(() => mentionRows(sections), [sections])
  const selectable = useMemo(() => selectableEntries(rows), [rows])
  const selectableIndexes = useMemo(() => new Map(selectable.map((entry, index) => [entry, index])), [selectable])

  // Publish the selectable rows so the imperative navigate/clickActive API can
  // address them. useLayoutEffect so it lands before the user can interact.
  const selectionKey = mentionSelectionKey(rows)
  const selectionRequest = JSON.stringify([query, scope, sessionId, root, request.activation])
  const previousSelectionRequest = useRef(selectionRequest)
  useLayoutEffect(() => {
    const previous = store.getState()
    const nextActiveIdx = previousSelectionRequest.current === selectionRequest
      ? reconcileMentionActiveIndex(previous.mentionSelectable, selectable, previous.activeIdx)
      : selectable.length ? 0 : -1
    previousSelectionRequest.current = selectionRequest
    store.setState({ mentionSelectable: selectable, activeIdx: nextActiveIdx })
  }, [store, selectable, selectionKey, selectionRequest])

  const isLoading = sections.some(section => section.state?.kind === 'loading')
  const hasPendingOrError = isLoading || sections.some(section => section.state?.kind === 'error')
  const closeEmpty = !hasPendingOrError && shouldCloseEmptyContextMenu(query, isLoading, selectable.length)
  useEffect(() => {
    if (closeEmpty && store.getState().mentionRequest === request) actions.onMentionMenuEmpty()
  }, [closeEmpty, request, actions, store])
  const hover = (index: number) => {
    if (store.getState().activeIdx !== index) store.setState({ activeIdx: index })
  }

  return (
    <>
      {rows.map((row, i) => {
        if (row.kind === 'heading') {
          // data-mention-heading is a stable semantic hook; the visual class is
          // hashed by CSS Modules, so tests and the harness locate a heading by
          // attribute, never by the hashed class name.
          return <div className={styles['context-menu-heading']} data-mention-heading={row.sectionKey} key={`h-${row.sectionKey}`}>{t(row.labelKey)}</div>
        }
        if (row.kind === 'state') {
          // data-state is the semantic hook (harness/tests locate a group's
          // loading vs error line by it); the visual variant is a real CSS-module
          // class via styles[], never a literal class name that a hashed module
          // rule could not match.
          return (
            <div
              className={`${styles['mention-menu-state']}` + (row.stateKind === 'error' ? ` ${styles['mention-menu-state-error']}` : '')}
              data-state={row.stateKind}
              data-section={row.sectionKey}
              key={`s-${row.sectionKey}`}
            >
              {t(row.labelKey)}
              {row.detail && <span className={styles['mention-menu-error-detail']}>{row.detail}</span>}
              {row.retry && <button type="button" className={styles['mention-menu-retry']} onMouseDown={event => event.preventDefault()} onClick={row.retry}>{t('mention_group_retry')}</button>}
            </div>
          )
        }
        const entry = row.entry
        // activeIdx addresses the selectable list, not the render list; find this
        // item's position among selectable rows.
        const selectableIndex = selectableIndexes.get(entry)!
        if (entry.kind === 'browser-tab' && entry.browserTab) {
          return <button
            type="button" key={`i-${row.sectionKey}-${entry.path}`} role="option"
            data-context-key={entry.path}
            className={`${styles['slash-menu-item']} workspace-mention-menu-item kls-select-item ${styles['mention-browser-tab']}` + (selectableIndex === activeIdx ? ' active' : '')}
            aria-selected={selectableIndex === activeIdx ? 'true' : 'false'}
            onMouseDown={event => event.preventDefault()}
            onMouseMove={() => hover(selectableIndex)}
            onClick={() => selectMention(entry)}
          >
            <span className={styles['mention-menu-icon']}><BrowserTabIcon faviconUrl={entry.browserTab.faviconUrl} /></span>
            <span className={styles['mention-menu-main']}>
              <span className={styles['mention-menu-name']}>{entry.name}</span>
              <span className={styles['mention-menu-path']}>{entry.rel}</span>
            </span>
          </button>
        }
        if (entry.kind === 'friend') {
          return <button
            type="button" key={`i-${row.sectionKey}-${entry.path}`} role="option"
            data-context-key={entry.path}
            className={`${styles['slash-menu-item']} workspace-mention-menu-item kls-select-item ${styles['mention-browser-tab']}` + (selectableIndex === activeIdx ? ' active' : '')}
            aria-selected={selectableIndex === activeIdx ? 'true' : 'false'}
            onMouseDown={event => event.preventDefault()}
            onMouseMove={() => hover(selectableIndex)}
            onClick={() => selectMention(entry)}
          >
            <span className={`${styles['mention-menu-icon']} ${styles['mention-friend-icon']}`}><FriendAvatar small name={entry.name} url={entry.avatarUrl ?? null} /></span>
            <span className={styles['mention-menu-main']}>
              <span className={styles['mention-menu-name']}>{entry.name}</span>
              <span className={styles['mention-menu-path']}>{entry.rel}</span>
            </span>
          </button>
        }
        const icon = entry.icon || (entry.kind === 'plugin'
          ? actions.pluginIconSvg()
          : entry.kind === 'device'
            ? actions.deviceIconHtml()
            : entry.kind === 'conversation'
              ? actions.conversationIconHtml()
              : entry.kind === 'category'
                ? actions.categoryIconHtml(entry.category || 'files')
                : entry.isDir ? actions.folderIconSvg() : actions.fileIconSvg(entry.name))
        const pathHtml = entry.rel && entry.rel !== entry.name
          ? `<span class="${styles['mention-menu-path']}">${escapeHtml(entry.rel)}</span>`
          : ''
        return (
          <button
            type="button" key={`i-${row.sectionKey}-${entry.path}-${selectableIndex}`} aria-label={entry.rel ? `${entry.name} · ${entry.rel}` : entry.name} role="option"
            data-context-key={entry.path}
            className={`${styles['slash-menu-item']} workspace-mention-menu-item kls-select-item` + (selectableIndex === activeIdx ? ' active' : '')}
            aria-selected={selectableIndex === activeIdx ? 'true' : 'false'}
            onMouseDown={event => event.preventDefault()}
            onMouseMove={() => hover(selectableIndex)}
            onClick={() => selectMention(entry)}
            dangerouslySetInnerHTML={{ __html: `<span class="${styles['mention-menu-icon']}">${icon}</span><span class="${styles['mention-menu-main']}"><span class="${styles['mention-menu-name']}">${escapeHtml(entry.name || entry.rel)}</span>${pathHtml}</span>` }}
          />
        )
      })}
      {isCategoryLevel && !normalizedQuery && <div className={styles['mention-menu-state']} data-context-search-hint>{t('mention_files_chats_search_hint')}</div>}
      {selectable.length === 0 && !hasPendingOrError && (!isCategoryLevel || !!normalizedQuery) && <div className={styles['mention-menu-state']} data-context-empty>{t('mention_group_empty')}</div>}
    </>
  )
}

export interface SlashMenuAnchor {
  wrapper: HTMLElement
  input: HTMLElement
  trigger?: HTMLElement | null
}

function ManualCompactRing({ percent }: { percent: number | null }) {
  const element = useRef<HTMLSpanElement>(null)
  // Keep the arc mounted so usage updates can animate its dash offset.
  const markup = useMemo(() => ({ __html: contextPieSvg(0) }), [])
  useLayoutEffect(() => {
    const progress = element.current?.querySelector('.ctx-usage-progress')
    const used = percent ?? 0
    progress?.setAttribute('stroke-dashoffset', String(100 - used))
    progress?.setAttribute('opacity', used === 0 ? '0' : '1')
  }, [percent])
  return <span ref={element} className={styles['slash-menu-icon']} aria-hidden="true"
    dangerouslySetInnerHTML={markup} />
}

function SlashMenuBody({ store, actions, container, anchorElements }: {
  store: StoreApi<SlashMenuState>
  actions: SlashMenuActions
  container: HTMLElement
  anchorElements?: SlashMenuAnchor
}) {
  const t = useT()
  const [, updateCommandState] = useState(0)
  const mode = useStore(store, s => s.mode)
  useEffect(() => {
    if (!mode) return
    return actions.subscribeCommandState?.(() => updateCommandState(value => value + 1))
  }, [actions, mode])
  const approvalReviewRequest = useStore(store, s => s.approvalReviewRequest)
  const slashItems = useStore(store, s => s.slashItems)
  const mentionRequest = useStore(store, s => s.mentionRequest)
  const activeIdx = useStore(store, s => s.activeIdx)

  // Anchor to the input card, not the full stack of goals and queued messages.
  // Fixed positioning keeps the menu outside the composer's scroll clipping.
  useLayoutEffect(() => {
    if (!mode) return
    const wrapper = anchorElements?.wrapper || container.ownerDocument.getElementById('input-wrapper')
    const anchor = anchorElements?.input || wrapper?.querySelector<HTMLElement>('#input-area')
    if (!wrapper || !anchor) return
    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const edge = 8, gap = mode === 'workspace' ? 12 : 6
      const above = Math.max(0, rect.top - gap - 48)
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - edge)
      const openAbove = above >= Math.min(120, below)
      const width = Math.min(window.innerWidth - edge * 2, rect.width)
      container.style.width = `${width}px`
      container.style.left = `${Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge))}px`
      container.style.right = 'auto'
      const available = openAbove ? above : below
      container.style.setProperty('--composer-overlay-available-height', `${available}px`)
      container.style.maxHeight = mode === 'workspace' ? 'min(var(--context-menu-max-height), var(--composer-overlay-available-height))' : `${Math.min(280, available)}px`
      container.style.top = openAbove ? 'auto' : `${rect.bottom + gap}px`
      container.style.bottom = openAbove ? `${window.innerHeight - rect.top + gap}px` : 'auto'
    }
    const onScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.contains(anchor)) {
        store.setState({ mode: null, slashItems: [], mentionRequest: null, mentionSelectable: [], activeIdx: -1 })
      }
    }
    position()
    let positionFrame: number | null = null
    const schedulePosition = () => {
      if (positionFrame !== null) return
      positionFrame = requestAnimationFrame(() => { positionFrame = null; position() })
    }
    const observer = new ResizeObserver(schedulePosition)
    observer.observe(wrapper)
    observer.observe(anchor)
    window.addEventListener('resize', schedulePosition)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      if (positionFrame !== null) cancelAnimationFrame(positionFrame)
      window.removeEventListener('resize', schedulePosition)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [anchorElements, container, mode, store])

  // active 项滚动可见（对齐 navigateSlashMenu 的 scrollIntoView nearest）。
  useEffect(() => {
    container.querySelector(`.${styles['slash-menu-item']}.active`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, mode])

  if (!mode) return null

  if (mode === 'approval-review') return approvalReviewRequest ? <ApprovalReviewDenialsMenu {...approvalReviewRequest} /> : null

  if (mode === 'workspace') {
    // A request is always present when mode is workspace; the fallback keeps the
    // type narrow without inventing a second render path.
    return mentionRequest
      ? <MentionMenu request={mentionRequest} actions={actions} store={store} />
      : null
  }

  const rows = groupSlashItems(slashItems, actions.commandGroupKey)
  const singleCompact = slashItems.length === 1 && isManualCompactCommand(slashItems[0])
  let itemIndex = -1
  return (
    <>
      {rows.map((row, i) => {
        if (row.heading !== undefined) {
          if (singleCompact) return null
          return <div className={styles['slash-menu-group']} key={`h-${i}`}>{actions.slashCommandGroupLabel(row.heading)}</div>
        }
        itemIndex++
        const idx = itemIndex
        const s = row.item
        const compact = isManualCompactCommand(s)
          ? manualCompactPresentation(actions.manualCompactState?.() || { sessionId: null, percent: null }, t) : null
        if (compact) return (
          <button type="button" key={`i-${i}`} role="option"
            className={`${styles['slash-menu-item']} ${styles['compact-command-row']} kls-select-item` + (idx === activeIdx ? ' active' : '')}
            aria-selected={idx === activeIdx ? 'true' : 'false'}
            onMouseDown={event => event.preventDefault()} onClick={() => actions.onSelectCommand(s)}>
            <ManualCompactRing percent={compact.percent} />
            <span className={styles['slash-menu-copy']}>
              <span className={styles['slash-menu-item-name']}>{compact.title}</span>
              <span className={styles['slash-menu-item-desc']}>{compact.description}</span>
            </span>
          </button>
        )
        const description = actions.slashCommandDescription(s)
        // Rows lead with the localized product name the inserted chip shows
        // (shortcuts and skills included); a row whose display name equals its
        // token renders exactly as before.
        const labels = slashRowLabels(String(s.name || ''), actions.slashCommandDisplayName(s))
        return (
          <button
            type="button" key={`i-${i}`} role="option"
            className={`${styles['slash-menu-item']} kls-select-item` + (idx === activeIdx ? ' active' : '')}
            aria-selected={idx === activeIdx ? 'true' : 'false'}
            onMouseDown={event => event.preventDefault()}
            onClick={() => actions.onSelectCommand(s)}
            dangerouslySetInnerHTML={{
              __html: `
        <span class="${styles['slash-menu-icon']}" aria-hidden="true">${actions.commandIconSvg(s)}</span>
        <span class="${styles['slash-menu-copy']}">
          <span class="${styles['slash-menu-item-name']}">/${escapeHtml(labels.token)}</span>
          ${labels.slug ? `<span class="${styles['slash-menu-item-slug']}">${escapeHtml(labels.slug)}</span>` : ''}
          ${description ? `<span class="${styles['slash-menu-item-desc']}">${escapeHtml(description)}</span>` : ''}
        </span>
      `,
            }}
          />
        )
      })}
    </>
  )
}

export function mountSlashMenu(container: HTMLElement | null, actions: SlashMenuActions, anchorElements?: SlashMenuAnchor): SlashMenuApi | null {
  if (!container) return null
  // Every editor needs the same positioned, scrollable panel shell.
  container.classList.add('slash-menu', 'kls-select-panel')
  container.setAttribute('role', 'listbox')
  const store = createStore<SlashMenuState>(() => ({
    mode: null,
    slashItems: [],
    mentionRequest: null,
    mentionSelectable: [],
    activeIdx: -1,
  })) as StoreApi<SlashMenuState>
  const overlay = container.id === 'slash-menu' ? 'slash-menu' : overlayIdForElement(container, 'composer-context')
  const closeState = () => {
    if (store.getState().mode) store.setState({ mode: null, slashItems: [], mentionRequest: null, mentionSelectable: [], activeIdx: -1 })
  }
  const unregister = registerOverlay(overlay, () => { actions.onRequestClose?.(); closeState() })

  // 显隐与皮肤类同步到既有容器（CSS 沿用 .slash-menu/.workspace-mention-menu/.hidden）。
  const unsubscribe = store.subscribe((state) => {
    container.classList.toggle('hidden', !state.mode)
    container.classList.toggle('workspace-mention-menu', state.mode === 'workspace')
    container.classList.toggle('manual-compact-menu', state.mode === 'slash' && state.slashItems.length === 1 && isManualCompactCommand(state.slashItems[0]))
    const trigger = anchorElements?.trigger || (!anchorElements ? container.ownerDocument.getElementById('composer-plus-btn') : null)
    const buttonOpen = state.mode === 'workspace' && state.mentionRequest?.activation === 'synthetic'
    trigger?.classList.toggle('open', buttonOpen)
    trigger?.setAttribute('aria-expanded', buttonOpen ? 'true' : 'false')
  })

  const root = createRoot(container)
  root.render(
    <QueryClientProvider client={queryClient}>
      <SlashMenuBody store={store} actions={actions} container={container} anchorElements={anchorElements} />
    </QueryClientProvider>,
  )

  const selectableCount = () => {
    const s = store.getState()
    return s.mode === 'workspace' ? s.mentionSelectable.length : s.slashItems.length
  }

  return {
    destroy() { unregister(); unsubscribe(); queueMicrotask(() => root.unmount()) },
    showApprovalReview(sessionId, currentSessionId, close) { claimOverlay(overlay); store.setState({ mode: 'approval-review', approvalReviewRequest: { sessionId, currentSessionId, close }, slashItems: [], activeIdx: 0 }) },
    showSlash(items) {
      claimOverlay(overlay)
      store.setState({ mode: 'slash', slashItems: items, mentionRequest: null, mentionSelectable: [], activeIdx: 0 })
    },
    showMention(request) {
      claimOverlay(overlay)
      // Keep the current highlight when only the query changed (a refill of the
      // same menu); reset to the first row when the menu is newly opened or the
      // scope changed.
      const previous = store.getState()
      const sameMenu = previous.mode === 'workspace'
        && previous.mentionRequest?.scope === request.scope
        && previous.mentionRequest?.sessionId === request.sessionId
        && previous.mentionRequest?.root === request.root
      const sameQuery = sameMenu && previous.mentionRequest?.query === request.query
      if (sameQuery && previous.mentionRequest?.activation === request.activation) return
      store.setState({ mode: 'workspace', mentionRequest: request, slashItems: [],
        mentionSelectable: sameQuery ? previous.mentionSelectable : [], activeIdx: sameQuery ? previous.activeIdx : -1 })
    },
    hide() {
      closeState()
    },
    navigate(dir) {
      if (store.getState().mode === 'approval-review') {
        const items = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-review-choice]:not(:disabled)'))
        if (!items.length) return
        const active = container.querySelector<HTMLElement>('[data-review-choice].active')
        const index = items.indexOf(active as HTMLButtonElement)
        items.forEach(item => { item.classList.remove('active'); item.setAttribute('aria-selected', 'false') })
        const next = items[(index + dir + items.length) % items.length]!
        next.classList.add('active'); next.setAttribute('aria-selected', 'true'); next.scrollIntoView({ block: 'nearest' })
        return
      }
      const count = selectableCount()
      if (!count) return
      const s = store.getState()
      store.setState({ activeIdx: (s.activeIdx + dir + count) % count })
    },
    clickActive(intent = 'insert') {
      const s = store.getState()
      if (!s.mode || s.activeIdx < 0) return false
      if (s.mode === 'approval-review') {
        const item = container.querySelector<HTMLButtonElement>('[data-review-choice].active:not(:disabled)') ?? container.querySelector<HTMLButtonElement>('[data-review-choice]:not(:disabled)')
        item?.click(); return !!item
      }
      if (s.mode === 'workspace') {
        const entry = s.mentionSelectable[s.activeIdx]
        if (!entry) return false
        actions.onSelectMention(entry, intent)
        return true
      }
      // slash 模式 active 索引按「分组展开后的可选择项顺序」计——与渲染一致。
      const rows = groupSlashItems(s.slashItems, actions.commandGroupKey).filter(r => r.item !== undefined)
      const row = rows[s.activeIdx]
      if (!row) return false
      actions.onSelectCommand(row.item)
      return true
    },
    isOpen() {
      return !!store.getState().mode
    },
    activeIndex() {
      return store.getState().activeIdx
    },
  }
}
