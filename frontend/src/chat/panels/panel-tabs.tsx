import { windowStateKey } from '../../app/window-state'
// Right-panel tab strip: the single owner of #artifacts-tabs（迁自 js/panel-tabs.js）。
//
// The panel used to be a mode switch — five hard-coded surfaces where each kind
// had exactly one instance, so a second browser page had nowhere to live at all.
// This registry replaces that with instance tabs: every surface is a closable
// tab that exists because the user opened it (side rail or the `+` menu) —
// Files, Changes and the terminal as single instances, browser pages and side
// tasks as many — and only the Monitor summary is pinned as a fixed tab.
//
// The terminal is deliberately ONE tab, not one per pty: shells are
// near-identical siblings, so listing them here filled the strip with rows of
// the same word. They live in the terminal surface's own side list instead, and
// the strip only tracks whether that surface still has a shell to show.
//
// Responsibilities kept here so no other module renders into the strip:
//   * descriptor list + active id (the source of truth for the strip);
//   * overflow: horizontal scroll plus a "more" menu listing every tab;
//   * per-tab context menu (close / close others / close right);
//   * per-session tab-set persistence with a schema-versioned envelope —
//     volatile kinds (terminal, side task) are never written to disk because a
//     dead pty or an expired side task cannot be faithfully recreated;
//   * panel maximize / restore.
//
// Surface ownership stays with chat.js / side-tasks: this module asks them to
// open, activate and tear down through window hooks, and they report back what
// exists. It never touches xterm, webviews or engine state directly.
//
// 绞杀式改造：数据面（注册表/MRU/持久化/激活路由）保持模块级 TS 函数原样，
// 渲染面（tab strip、more/new 菜单、右键菜单、拖拽标记）迁 React。旧版靠
// renderSignature 防止 badge 每秒 tick 重建整条 strip；React 协调天然等价
//（只 patch 变化的文本节点，hover/关闭手势不丢）。拖拽中的「冻结重建」约束
// 保留在 publish 层：draggingId 存续期间快照不发布，dragend 后补发。
import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { icon } from '../../icons/registry'
import { subagentAvatarHtml } from '../subagent-avatar'
import { subagentDisplayName } from '../subagent-identity'
import { subscribeSubagents } from '../subagent-state'
import styles from './panels.module.css'
import type { SideTaskQuotePanel } from '../../../../contracts/side-task-quotes'

const w = () => window as any
const tt = (key: string): string => w().tt?.(key) || key

const STORAGE_PREFIX = windowStateKey('klaus.panelTabs.')
const SCHEMA_VERSION = 1
const MAXIMIZED_KEY = windowStateKey('klaus_artifacts_maximized')
const DRAFT_IDENTITIES_KEY = windowStateKey('klaus.panelTabs.draftIdentities.v1')
const DRAFT_TABS_KEY = windowStateKey('klaus.panelTabs.draftTabs.v1')
const CLIENT_BINDINGS_KEY = windowStateKey('klaus.panelTabs.clientBindings.v1')
const MAX_RETAINED_SCOPES = 20
const MAX_DRAFT_CHECKPOINTS = 100
const MAX_CLIENT_BINDINGS = 1000

const artifactsPanel = document.getElementById('artifacts-panel')
const maximizeBtn = document.getElementById('artifacts-maximize-toggle')

// ── Kind table ────────────────────────────────────────────────────────────
// The only `fixed` tab is Monitor: always present, never closable, and never
// persisted (it is implied). Everything else is an instance tab that exists
// because the user opened it.
//
// `owned` marks the instance kinds whose EXISTENCE is published by their
// surface owner through a sync call: a Terminal tab exists while the
// conversation has shells (syncTerminals), a page while the host lists it
// (syncBrowserTabs), a side task while the engine holds it (syncSideTasks).
// The Changes and Files tabs have no such channel — the panel mode is the
// whole truth about them — so they are created from the mode instead.
const KINDS: Record<string, { fixed: boolean; mode: string; labelKey: string; persist: boolean; owned?: boolean }> = {
  monitor: { fixed: true, mode: 'monitor', labelKey: 'monitor_title', persist: false },
  workspace: { fixed: false, mode: 'workspace', labelKey: 'files_view_nav', persist: true },
  diff: { fixed: false, mode: 'diff', labelKey: 'diff_view_title', persist: true },
  browser: { fixed: false, mode: 'browser', labelKey: 'browser_settings', persist: true, owned: true },
  digram: { fixed: false, mode: 'digram', labelKey: 'digram_title', persist: false },
  model3d: { fixed: false, mode: 'model3d', labelKey: 'model3d_title', persist: false },
  terminal: { fixed: false, mode: 'terminal', labelKey: 'terminal_toggle', persist: false, owned: true },
  'side-task': { fixed: false, mode: 'side-chat', labelKey: 'side_task_untitled', persist: false, owned: true },
  subagent: { fixed: false, mode: 'subagent', labelKey: 'overview_subagents_title', persist: false, owned: true },
  'background-process': { fixed: false, mode: 'background-process', labelKey: 'overview_background_processes_title', persist: false, owned: true },
  planning: { fixed: false, mode: 'planning', labelKey: 'planning_title', persist: false, owned: true },
  goal: { fixed: false, mode: 'goal', labelKey: 'composer_goal', persist: false, owned: true },
  spec: { fixed: false, mode: 'spec', labelKey: 'spec_plan_review_title', persist: false, owned: true },
  canvas: { fixed: false, mode: 'canvas', labelKey: 'canvas_title', persist: false, owned: true },
  prototype: { fixed: false, mode: 'prototype', labelKey: 'prototype_title', persist: true, owned: true },
  'video-editing': { fixed: false, mode: 'video-editing', labelKey: 'video_editing_title', persist: true, owned: true },
  ppt: { fixed: false, mode: 'ppt', labelKey: 'ppt_title', persist: true, owned: true },
}

// Native editor surfaces keep their documents on the host while the owning
// chat is away, so their descriptors persist with that chat and come back on
// the next visit instead of leaving the surface unreachable.
const NATIVE_EDITOR_KINDS: readonly string[] = ['prototype', 'video-editing', 'ppt']
const NATIVE_RESUME_HOOK: Record<string, string> = {
  prototype: 'klausPrototypeResumeId',
  'video-editing': 'klausVideoEditingResumeId',
  ppt: 'klausPptResumeId',
}

const ICONS: Record<string, string> = {
  monitor: icon('monitor'),
  workspace: icon('workspace'),
  browser: icon('browser'),
  digram: icon('digram'),
  model3d: icon('model3d'),
  diff: icon('diff'),
  terminal: icon('terminal'),
  'side-task': icon('side-task'),
  subagent: icon('subagent-kind-background'),
  'background-process': icon('tool-bash'),
  spec: icon('spec'),
  planning: icon('plan'),
  goal: icon('goal'),
  canvas: icon('canvas'),
  prototype: icon('canvas'),
  'video-editing': icon('tool-generate-video'),
  ppt: icon('canvas'),
}

// ── State（数据面，按会话/草稿作用域隔离 + LRU 驻留） ──────────────────────
interface Tab {
  id: string
  kind: string
  key: string
  title: string
  badge: string
  url: string
  pending: boolean
  running?: boolean
  unread?: boolean
  placement?: 'left' | 'right'
  sessionId?: string | null
  revision?: number
}

interface StoredTabEntry {
  kind: string
  url?: string
  key?: string
  title?: string
}

interface StoredTopology {
  activeTabId: string | null
  open: boolean
  tabIds: string[]
  maximized?: boolean
}

interface StoredCheckpoint {
  version: number
  tabs: StoredTabEntry[]
  topology?: StoredTopology
}

interface ThreadTabScope {
  key: string
  sessionId: string | null
  tabs: Tab[]
  activeId: string | null
  leftActiveId: string | null
  // Most-recently-activated first. Drives where focus lands when a tab closes.
  mru: string[]
  hydrated: boolean
  lastStoredRaw: string | null
  disconnectToken: symbol
}

const scopes = new Map<string, ThreadTabScope>()
let draftSeq = 0
let draftClientThreadId: string | null = null
let cachedBindingsRaw: string | null = null
let cachedBindings: Record<string, string> = {}

// Bumped on every session switch. An in-flight restore compares its token
// against this before touching the strip, so a fast A→B→A switch cannot let a
// stale restore paint B's tabs over A's.
let restoreToken = 0
let activationToken = 0
let canvasOpenToken = 0
let maximized = localStorage.getItem(MAXIMIZED_KEY) === '1'
let draggingId: string | null = null
// Set while closeTab is tearing a surface down. A sync fired BY that teardown
// (the surface reporting itself gone) leaves the fallback choice to closeTab,
// so one close cannot activate a replacement surface twice.
let closingTabId: string | null = null
// klaus:lang-change 时 bump：快照变化驱动组件重渲，渲染期求值的 tt() 随之刷新。
let langTick = 0

const descriptorId = (kind: string, key: string) => (key ? `${kind}:${key}` : kind)
const isFixed = (tab: Tab) => !!KINDS[tab.kind]?.fixed
const panelOpen = () => !!artifactsPanel
  && !artifactsPanel.classList.contains('collapsed')
const currentMode = () => artifactsPanel?.getAttribute('data-mode') || 'monitor'

function defaultTitle(kind: string) {
  const key = KINDS[kind]?.labelKey
  return key ? tt(key) : kind
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage full / disabled: the tab set is a convenience, never a gate.
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore storage removal errors.
  }
}

function isClientDraftId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('draft:') && value.length > 6
}

function mintClientDraftId(): string {
  return `draft:${++draftSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function loadClientBindings(): Record<string, string> {
  const raw = readStorage(CLIENT_BINDINGS_KEY)
  if (raw === cachedBindingsRaw) return cachedBindings
  cachedBindingsRaw = raw
  if (!raw) {
    cachedBindings = {}
    return cachedBindings
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      cachedBindings = {}
      return cachedBindings
    }
    const next: Record<string, string> = {}
    for (const [sessionId, clientId] of Object.entries(parsed)) {
      if (sessionId && isClientDraftId(clientId)) next[sessionId] = clientId
    }
    cachedBindings = next
    return cachedBindings
  } catch {
    cachedBindings = {}
    return cachedBindings
  }
}

function boundClientThreadId(sessionId: string): string | null {
  if (!sessionId) return null
  return loadClientBindings()[sessionId] ?? null
}

function persistDraftIdentity(clientId: string | null): void {
  if (!clientId) {
    removeStorage(DRAFT_IDENTITIES_KEY)
    return
  }
  writeStorage(DRAFT_IDENTITIES_KEY, JSON.stringify({ 'new-conversation': clientId }))
}

function recordClientBinding(sessionId: string, clientId: string): void {
  if (!sessionId || !isClientDraftId(clientId)) return
  const current = loadClientBindings()
  if (current[sessionId] !== clientId) {
    const entries = Object.entries(current).filter(([key]) => key !== sessionId).slice(-(MAX_CLIENT_BINDINGS - 1))
    entries.push([sessionId, clientId])
    cachedBindings = Object.fromEntries(entries)
    cachedBindingsRaw = JSON.stringify(cachedBindings)
    writeStorage(CLIENT_BINDINGS_KEY, cachedBindingsRaw)
  }
  if (draftClientThreadId === clientId) {
    draftClientThreadId = mintClientDraftId()
    persistDraftIdentity(draftClientThreadId)
  }
}

function forgetClientBinding(sessionId: string): string | null {
  if (!sessionId) return null
  const current = loadClientBindings()
  const bound = current[sessionId] ?? null
  if (!bound) return null
  const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== sessionId))
  cachedBindings = next
  if (Object.keys(next).length === 0) {
    cachedBindingsRaw = null
    removeStorage(CLIENT_BINDINGS_KEY)
  } else {
    cachedBindingsRaw = JSON.stringify(next)
    writeStorage(CLIENT_BINDINGS_KEY, cachedBindingsRaw)
  }
  return bound
}

function ensureDraftClientThreadId(): string {
  const boundSet = new Set(Object.values(loadClientBindings()))
  if (draftClientThreadId && !boundSet.has(draftClientThreadId)) return draftClientThreadId
  const raw = readStorage(DRAFT_IDENTITIES_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      const stored = parsed?.['new-conversation']
      if (isClientDraftId(stored) && !boundSet.has(stored)) {
        draftClientThreadId = stored
        return stored
      }
    } catch {
      // Ignore malformed draft identity.
    }
  }
  draftClientThreadId = mintClientDraftId()
  persistDraftIdentity(draftClientThreadId)
  return draftClientThreadId
}

function rotateDraftClientThreadId(expectedClientId?: string): string {
  if (expectedClientId && draftClientThreadId && draftClientThreadId !== expectedClientId) {
    return draftClientThreadId
  }
  draftClientThreadId = mintClientDraftId()
  persistDraftIdentity(draftClientThreadId)
  return draftClientThreadId
}

function scopeKeyForSession(sessionId: string | null): string {
  if (!sessionId) return ensureDraftClientThreadId()
  return boundClientThreadId(sessionId) ?? `local:${sessionId}`
}

function rawWindowSessionId(): string | null {
  const fn = w().getCurrentSessionId
  if (typeof fn === 'function') return fn() || null
  if (typeof w().currentSessionId === 'string' && w().currentSessionId) return w().currentSessionId
  return null
}

let switchedSessionId: string | null = rawWindowSessionId()
let switchedAtWindowSessionId: string | null = switchedSessionId

function activeSessionId(): string | null {
  const winId = rawWindowSessionId()
  if (winId !== switchedAtWindowSessionId) {
    switchedSessionId = winId
    switchedAtWindowSessionId = winId
  }
  return switchedSessionId
}

function createScope(key: string, sessionId: string | null): ThreadTabScope {
  const monitorTab: Tab = {
    id: 'monitor',
    kind: 'monitor',
    key: '',
    title: defaultTitle('monitor'),
    badge: '',
    url: '',
    pending: false,
    running: false,
    unread: false,
    placement: 'right',
  }
  return {
    key,
    sessionId,
    tabs: [monitorTab],
    activeId: 'monitor',
    leftActiveId: null,
    mru: ['monitor'],
    hydrated: false,
    lastStoredRaw: null,
    disconnectToken: Symbol(),
  }
}

function evictOverflowScopes(keepKey: string): void {
  while (scopes.size > MAX_RETAINED_SCOPES) {
    const oldestKey = scopes.keys().next().value as string | undefined
    if (!oldestKey || oldestKey === keepKey) break
    const evicted = scopes.get(oldestKey)
    scopes.delete(oldestKey)
    if (!evicted) continue
    if (evicted === boundScope) {
      flushViewToScope()
      boundScope = null
      pruneVolatileTabsOnLeave(evicted)
    }
    if (evicted.hydrated) {
      if (evicted.sessionId) saveScopeForSession(evicted, evicted.sessionId)
      else saveDraftScope(evicted)
    }
  }
}

function getOrCreateScope(sessionId: string | null, { hydrate = true } = {}): ThreadTabScope {
  const key = scopeKeyForSession(sessionId)
  let scope = scopes.get(key)
  if (scope) {
    scopes.delete(key)
    scopes.set(key, scope)
    if (sessionId && scope.sessionId !== sessionId) {
      scope.sessionId = sessionId
      for (const tab of scope.tabs) {
        if (NATIVE_EDITOR_KINDS.includes(tab.kind) && !tab.sessionId) tab.sessionId = sessionId
      }
    }
  } else {
    scope = createScope(key, sessionId)
    scopes.set(key, scope)
    evictOverflowScopes(key)
  }
  bindScope(scope)
  if (hydrate) ensureScopeHydrated(scope)
  return scope
}

// ── Active-scope binding ────────────────────────────────────────────────────
// The data plane below is written against one module-level tab set. Those
// identifiers are the live view of the bound scope: `tabs` and `mru` alias the
// scope's arrays by reference (in-place mutation lands in the scope directly),
// and the two active-id primitives are written back whenever the binding moves
// or the scope is checkpointed.
let boundScope: ThreadTabScope | null = null
let tabs: Tab[] = []
let activeId: string | null = null
let leftActiveId: string | null = null
let mru: string[] = []

function refreshViewFromScope(scope: ThreadTabScope): void {
  tabs = scope.tabs
  mru = scope.mru
  activeId = scope.activeId
  leftActiveId = scope.leftActiveId
}

function flushViewToScope(): void {
  if (!boundScope) return
  boundScope.tabs = tabs
  boundScope.mru = mru
  boundScope.activeId = activeId
  boundScope.leftActiveId = leftActiveId
}

// Leaving a scope is the checkpoint moment: write the view back, prune the
// surfaces that cannot survive the session leave, then persist what is durable.
function leaveBoundScope(): void {
  const leaving = boundScope
  if (!leaving) return
  flushViewToScope()
  // Detach BEFORE pruning so the save below reads the pruned scope instead of
  // flushing the stale view primitives back over it.
  boundScope = null
  pruneVolatileTabsOnLeave(leaving)
  if (leaving.hydrated) {
    if (leaving.sessionId) saveScopeForSession(leaving, leaving.sessionId)
    else saveDraftScope(leaving)
  }
}

function bindScope(scope: ThreadTabScope): void {
  if (boundScope === scope) return
  leaveBoundScope()
  boundScope = scope
  refreshViewFromScope(scope)
}

function activeScope(): ThreadTabScope {
  const sid = activeSessionId()
  const bound = boundScope
  // Fast path: while the bound scope still owns the active session (or is the
  // live draft), skip the key resolution and every storage read.
  if (bound && (sid !== null
    ? bound.sessionId === sid
    : bound.sessionId === null && bound.key === draftClientThreadId)) {
    return bound
  }
  return getOrCreateScope(sid)
}

const findInScope = (scope: ThreadTabScope, kind: string, key: string) =>
  scope.tabs.find(tab => tab.id === descriptorId(kind, key)) || null
const findByIdInScope = (scope: ThreadTabScope, id: string) =>
  scope.tabs.find(tab => tab.id === id) || null
const find = (kind: string, key: string) => findInScope(activeScope(), kind, key)
const findById = (id: string) => findByIdInScope(activeScope(), id)

// ── Render snapshot（渲染面唯一入口） ─────────────────────────────────────
interface TabView extends Tab {
  fixed: boolean
  active: boolean
  iconHtml: string
}

function tabPresentation(tab: Tab): { title: string; iconHtml: string } {
  if (tab.kind === 'subagent') {
    const task = w().KlausSubagentPanel?.getTask?.(tab.key)
    if (task) return {
      title: subagentDisplayName(tab.key, task),
      iconHtml: subagentAvatarHtml(task.avatarId, 16, task.status, task.agentId || tab.key),
    }
  }
  return { title: tab.title, iconHtml: ICONS[tab.kind] || '' }
}

interface StripSnapshot {
  tabs: TabView[]
  activeId: string | null
  leftActiveId: string | null
  panelOpen: boolean
  maximized: boolean
  lang: number
}

const store = createStore<StripSnapshot>(() => ({
  tabs: [],
  activeId: null,
  leftActiveId: null,
  panelOpen: false,
  maximized,
  lang: 0,
})) as StoreApi<StripSnapshot>

// A rebuild mid-drag would delete the element the pointer is dragging and
// silently cancel the gesture, so the strip holds still until the drop.
let pendingPublish = false

function publish() {
  activeScope()
  window.dispatchEvent(new CustomEvent('klaus:panel-tabs-change'))
  if (draggingId) {
    pendingPublish = true
    return
  }
  const open = panelOpen()
  const leftHost = document.getElementById('left-side-tabs')
  if (leftHost) leftHost.hidden = !tabs.some(tab => tab.placement === 'left')
  store.setState({
    tabs: tabs.map(tab => ({ ...tab, ...tabPresentation(tab), fixed: isFixed(tab),
      active: tab.placement === 'left' ? leftActiveId === tab.id : open && activeId === tab.id })),
    activeId,
    leftActiveId,
    panelOpen: open,
    maximized,
    lang: langTick,
  }, true)
  // Maximize only means anything while the panel is open, so the body flag is
  // re-derived here instead of being latched at click time.
  document.body.classList.toggle('artifacts-maximized', maximized && open)
  syncMaximizeBtn()
}

function syncMaximizeBtn() {
  if (!maximizeBtn) return
  const key = maximized ? 'artifacts_restore' : 'artifacts_maximize'
  ;(maximizeBtn as HTMLElement).dataset.i18nAriaLabel = key
  maximizeBtn.setAttribute('aria-label', tt(key))
  maximizeBtn.setAttribute('aria-pressed', String(maximized))
}

// ── Registry mutation ─────────────────────────────────────────────────────
function ensureInScope(scope: ThreadTabScope, kind: string, key = '', patch: Partial<Tab> = {}): Tab | null {
  if (!KINDS[kind]) return null
  let tab = findInScope(scope, kind, key)
  if (!tab) {
    tab = {
      id: descriptorId(kind, key),
      kind,
      key: key || '',
      title: kind === 'side-task' ? patch.title ?? defaultTitle(kind) : patch.title || defaultTitle(kind),
      badge: patch.badge || '',
      url: patch.url || '',
      pending: !!patch.pending,
      running: !!patch.running,
      unread: !!patch.unread,
      placement: patch.placement || 'right',
    }
    // Fixed tabs lead the strip in declaration order; instance tabs append in
    // creation order, which is what makes "close right" meaningful.
    if (isFixed(tab)) {
      const firstInstance = scope.tabs.findIndex(item => !isFixed(item))
      if (firstInstance < 0) scope.tabs.push(tab)
      else scope.tabs.splice(firstInstance, 0, tab)
    } else {
      scope.tabs.push(tab)
    }
  } else {
    if (patch.title != null && (kind === 'side-task' || patch.title)) tab.title = patch.title
    if ('badge' in patch) tab.badge = patch.badge || ''
    if ('url' in patch) tab.url = patch.url || ''
    if ('pending' in patch) tab.pending = !!patch.pending
    if ('running' in patch) tab.running = !!patch.running
    if ('unread' in patch) tab.unread = !!patch.unread
    if ('placement' in patch) tab.placement = patch.placement || 'right'
  }
  return tab
}

function ensure(kind: string, key = '', patch: Partial<Tab> = {}) {
  return ensureInScope(activeScope(), kind, key, patch)
}

function remove(kind: string, key = '') {
  activeScope()
  const index = tabs.findIndex(tab => tab.id === descriptorId(kind, key))
  if (index < 0) return null
  const [removed] = tabs.splice(index, 1)
  forgetMru(removed.id)
  if (activeId === removed.id) activeId = null
  return removed
}

// ── Activation order ───────────────────────────────────────────────────
// Closing a tab hands focus to the most recently used surviving tab, not to a
// positional neighbour: after hopping between two terminals, closing one should
// land back on the other rather than on whatever happens to sit beside it.
function setActiveId(id: string | null) {
  activeScope()
  activeId = id || null
  if (!activeId) return
  const at = mru.indexOf(activeId)
  if (at >= 0) mru.splice(at, 1)
  mru.unshift(activeId)
}

function forgetMru(id: string) {
  activeScope()
  const at = mru.indexOf(id)
  if (at >= 0) mru.splice(at, 1)
}

function mostRecentTab(excludeId: string) {
  activeScope()
  for (const id of mru) {
    if (id === excludeId) continue
    const tab = tabs.find(item => item.id === id)
    if (tab && tab.placement !== 'left' && !isFixed(tab)) return tab
  }
  return null
}

// ── Activation ────────────────────────────────────────────────────────────
// Route a user click to the surface owner. Every path funnels through the same
// window hooks the rail buttons use, so a tab click and a rail click cannot
// diverge.
async function activateTab(tab: Tab | null, { reloadCanvas = false } = {}) {
  if (!tab) return false
  activeScope()
  if (tab.kind === 'side-task' && tab.placement === 'left') {
    await w().KlausSideTasks?.activateById?.(tab.key)
    leftActiveId = tab.id
    publish()
    return true
  }
  const activation = ++activationToken
  switch (tab.kind) {
    case 'monitor':
      w().klausOpenMonitorPanel?.()
      break
    case 'workspace':
      w().showWorkspaceMainView?.({ openPanel: true })
      break
    case 'diff':
      w().klausOpenDiffPanel?.()
      break
    case 'terminal':
      w().klausShowTerminalPanel?.()
      break
    case 'digram':
      w().klausOpenDigramPanel?.()
      break
    case 'model3d':
      w().klausOpenModel3DPanel?.()
      break
    case 'browser':
      if (tab.pending) {
        // Keep the descriptor until the host confirms that it created the page.
        // Otherwise a transient failure destroys the only retry affordance.
        const url = tab.url
        const opened = await w().klausOpenBrowserTab?.({ url })
        if (!opened) return false
        remove('browser', tab.key)
        publish()
        return true
      }
      await w().klausOpenBrowserTab?.({ tabId: tab.key })
      break
    case 'side-task':
      await w().KlausSideTasks?.activateById?.(tab.key)
      break
    case 'subagent':
      await w().KlausSubagentPanel?.activateByTaskId?.(tab.key)
      break
    case 'background-process':
      await w().KlausBackgroundProcessPanel?.activateByShellId?.(tab.key)
      break
    case 'planning':
      if (await w().klausActivatePlanningPanel?.({ sessionId: tab.sessionId, planId: tab.url, revision: tab.revision }) === false) return false
      break
    case 'goal':
      if (await w().klausActivateGoalPanel?.({ sessionId: tab.sessionId, goalId: tab.key }) === false) return false
      break
    case 'spec': {
      const token = restoreToken
      const path = tab.key
      const sessionId = w().getCurrentSessionId?.() ?? null
      await w().klausActivateSpecPanel?.({ sessionId: tab.sessionId ?? w().getCurrentSessionId?.() ?? null, path: tab.key })
      // Reading a document may finish after its tab was closed, another
      // document was selected, or the user changed session or panel surface.
      if (token !== restoreToken || !tabs.includes(tab) || tab.key !== path || sessionId !== (w().getCurrentSessionId?.() ?? null) || currentMode() !== 'spec') return false
      break
    }
    case 'canvas': {
      const token = restoreToken
      const sessionId = w().getCurrentSessionId?.() ?? null
      const presented = await w().klausActivateCanvasPanel?.({ path: tab.key, title: tab.title, reload: reloadCanvas })
      if (presented !== true) return false
      if (activation !== activationToken || token !== restoreToken || !tabs.includes(tab)
        || sessionId !== (w().getCurrentSessionId?.() ?? null) || currentMode() !== 'canvas'
        || w().klausActiveCanvasPath?.() !== tab.key) return false
      break
    }
    case 'ppt':
    case 'prototype':
    case 'video-editing': {
      const token = restoreToken
      const sessionId = w().getCurrentSessionId?.() ?? null
      if (tab.sessionId !== sessionId) return false
      const activateHook = tab.kind === 'ppt'
        ? w().klausActivatePptPanel
        : tab.kind === 'prototype'
          ? w().klausActivatePrototypePanel
          : w().klausActivateVideoEditingPanel
      const activeIdHook = tab.kind === 'ppt'
        ? w().klausActivePptId
        : tab.kind === 'prototype'
          ? w().klausActivePrototypeId
          : w().klausActiveVideoEditingId
      const mode = KINDS[tab.kind].mode
      const presented = await activateHook?.({ id: tab.key, title: tab.title, sessionId })
      if (presented !== true || activation !== activationToken || token !== restoreToken || !tabs.includes(tab)
        || sessionId !== (w().getCurrentSessionId?.() ?? null) || currentMode() !== mode
        || activeIdHook?.() !== tab.key) {
        if (presented !== true && activation === activationToken && token === restoreToken
          && sessionId === (w().getCurrentSessionId?.() ?? null)) {
          forgetMru(tab.id)
          void reconcileNativeEditorTabs(tab.kind, sessionId, token)
          if (currentMode() === mode || activeId === tab.id) {
            await activateTab(mostRecentTab(tab.id) || find('monitor', ''))
          }
        }
        return false
      }
      break
    }
    default:
      break
  }
  setActiveId(tab.id)
  publish()
  return true
}

async function closeTab(tab: Tab | null) {
  if (!tab || isFixed(tab)) return
  activeScope()
  if (tab.kind === 'canvas') { activationToken++; canvasOpenToken++ }
  if (tab.kind === 'prototype' || tab.kind === 'video-editing' || tab.kind === 'ppt') activationToken++
  const closingSessionToken = restoreToken
  const left = tab.placement === 'left'
  // Read this BEFORE the surface owner runs: tearing a surface down can move
  // the mode (and with it the active tab) on its own, and some owners also
  // collapse the panel on the way out. Whether the closed tab HAD focus is the
  // only thing that decides if a fallback is owed, so it is captured first.
  const wasActive = left ? leftActiveId === tab.id : activeId === tab.id
  closingTabId = tab.id
  try {
    switch (tab.kind) {
      case 'workspace':
        // The files surface keeps an .active view of its own; closing the tab
        // must exit it, or it would linger behind whatever tab comes next.
        if (w().isWorkspaceMainViewActive?.()) w().hideWorkspaceMainView?.()
        break
      case 'diff':
        w().klausCloseDiffPanel?.()
        break
      case 'digram':
        // A single-instance surface like Files/Changes: closing the tab exits
        // the surface and lets the fallback re-open the panel on Monitor.
        w().klausCloseDigramPanel?.()
        break
      case 'model3d':
        // Same single-instance rule. Closing also releases the WebGL context:
        // a browser caps them, and a leaked one survives every tab switch.
        w().klausCloseModel3DPanel?.()
        break
      case 'terminal':
        // Closing the surface takes its shells with it: they are only reachable
        // from this tab, so leaving them alive would leak invisible ptys.
        await w().klausCloseTerminalPanel?.()
        break
      case 'browser':
        if (!tab.pending) await w().klausCloseBrowserTab?.(tab.key)
        break
      case 'side-task':
        if (await w().KlausSideTasks?.closeById?.(tab.key) === false) return
        break
      case 'subagent':
        w().KlausSubagentPanel?.closeByTaskId?.(tab.key)
        break
      case 'background-process':
        w().KlausBackgroundProcessPanel?.closeByShellId?.(tab.key)
        break
      case 'planning':
        if (await w().klausClosePlanningPanel?.() === false) return
        break
      case 'goal':
        w().klausCloseGoalPanel?.()
        break
      case 'spec':
        w().klausCloseSpecPanel?.(tab.key)
        break
      case 'canvas':
        await w().klausCloseCanvasPanel?.(tab.key)
        break
      case 'prototype':
        await w().klausClosePrototypePanel?.(tab.key)
        break
      case 'video-editing':
        if (await w().klausCloseVideoEditingPanel?.(tab.key) === false) return
        break
      case 'ppt':
        await w().klausClosePptPanel?.(tab.key)
        break
      default:
        break
    }
  } finally {
    closingTabId = null
  }
  if ((tab.kind === 'prototype' || tab.kind === 'video-editing' || tab.kind === 'ppt') && (closingSessionToken !== restoreToken || !tabs.includes(tab))) return
  // Surface owners remove their own descriptor as they tear down; anything
  // left (pending placeholders) is dropped here.
  if (find(tab.kind, tab.key)) remove(tab.kind, tab.key)
  forgetMru(tab.id)
  if (left) {
    if (wasActive) {
      const next = tabs.find(item => item.placement === 'left')
      if (next) await activateTab(next)
      else { leftActiveId = null; w().KlausSideTasks?.showParent?.() }
    }
    publish()
    return
  }
  // Activating the fallback also re-opens the panel, so closing a tab can never
  // shut the whole surface — the summary is always there to land on.
  if (wasActive || !activeId) {
    await activateTab(mostRecentTab(tab.id) || find('monitor', ''))
    return
  }
  publish()
}

async function closeMany(list: Tab[]) {
  for (const tab of list) {
    if (isFixed(tab)) continue
    // eslint-disable-next-line no-await-in-loop
    await closeTab(tab)
  }
}

// ── Drag to reorder ───────────────────────────────────────────────────────
// Only instance tabs move, and they can only land inside the instance run:
// the fixed Monitor tab anchors the head of the strip, so an instance can
// never be dropped in front of it.
function firstInstanceIndex() {
  const index = tabs.findIndex(tab => !isFixed(tab))
  return index < 0 ? tabs.length : index
}

function moveTab(fromId: string, toId: string, after: boolean) {
  activeScope()
  const from = tabs.findIndex(tab => tab.id === fromId)
  if (from < 0 || isFixed(tabs[from])) return false
  const [moved] = tabs.splice(from, 1)
  let target = tabs.findIndex(tab => tab.id === toId)
  if (target < 0) target = tabs.length - 1
  let insert = after ? target + 1 : target
  insert = Math.max(firstInstanceIndex(), Math.min(insert, tabs.length))
  tabs.splice(insert, 0, moved)
  publish()
  persistCurrent()
  return true
}

// ── Maximize ──────────────────────────────────────────────────────────────
// Maximize gives the panel the whole content ROW: the chat column collapses to
// zero width (keeping its scroll state) and the panel fills the rest. The
// sidebar and window chrome stay put: maximize only trades the chat column for
// the artifact area and never folds the rail.
function applyMaximized() {
  publish()
  w().klausOnArtifactsLayoutChange?.()
}

function setMaximized(next: boolean, { persist = true } = {}) {
  const value = !!next
  if (value === maximized) { applyMaximized(); return }
  maximized = value
  if (persist) localStorage.setItem(MAXIMIZED_KEY, maximized ? '1' : '0')
  applyMaximized()
}

maximizeBtn?.addEventListener('click', () => setMaximized(!maximized))

// ── Persistence ───────────────────────────────────────────────────────────
function storageKey(sessionId: string) {
  return `${STORAGE_PREFIX}${sessionId}`
}

// Loopback preview servers may stop between visits; only live host tabs are restored.
function isTransientLocalPage(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

// ── Persistence: one checkpoint per scope ────────────────────────────────
// A session's checkpoint lives under its own storage key; an unpromoted
// draft's checkpoint lives under its client-side draft id inside the shared
// draft map. A checkpoint records the durable tab routes plus the strip
// topology (order and selection), so a cold scope rebuilds exactly what the
// user last saw. Volatile surfaces are never written: a dead pty or an
// expired side task cannot be faithfully recreated.
function serializeScope(scope: ThreadTabScope): StoredTabEntry[] {
  const sessionId = scope.sessionId
  return scope.tabs
    .filter(tab => KINDS[tab.kind]?.persist && (tab.kind !== 'browser' || !isTransientLocalPage(tab.url)))
    .flatMap(tab => {
      if (tab.kind === 'browser') return [{ kind: 'browser', url: tab.url || '' }]
      // A native editor descriptor is meaningless without the document it
      // points at, so the stored entry carries its key and display title. A
      // document owned by another chat never rides along in this checkpoint.
      if (NATIVE_EDITOR_KINDS.includes(tab.kind)) {
        if (!tab.key || (sessionId && tab.sessionId && tab.sessionId !== sessionId)) return []
        return [{ kind: tab.kind, key: tab.key, title: tab.title }]
      }
      return [{ kind: tab.kind }]
    })
}

function checkpointForScope(scope: ThreadTabScope): StoredCheckpoint | null {
  const entries = serializeScope(scope)
  if (entries.length === 0) return null
  return {
    version: SCHEMA_VERSION,
    tabs: entries,
    topology: {
      activeTabId: scope.activeId,
      // Panel openness and maximization are recorded for checkpoint
      // completeness; chat.js owns restoring them per session (and maximize
      // stays an app-wide preference), so hydration never applies these two.
      open: panelOpen(),
      tabIds: scope.tabs.map(tab => tab.id),
      maximized,
    },
  }
}

function sanitizeTopology(value: any): StoredTopology | undefined {
  if (!value || typeof value !== 'object') return undefined
  return {
    activeTabId: typeof value.activeTabId === 'string' ? value.activeTabId : null,
    open: value.open === true,
    tabIds: Array.isArray(value.tabIds) ? value.tabIds.filter((id: any): id is string => typeof id === 'string') : [],
    maximized: value.maximized === true,
  }
}

function sanitizeCheckpoint(value: any): StoredCheckpoint | null {
  // A stored envelope from a different schema is discarded outright rather
  // than half-read: a partially understood tab set is worse than none.
  if (!value || value.version !== SCHEMA_VERSION) return null
  const list = Array.isArray(value.tabs) ? value.tabs : []
  return {
    version: SCHEMA_VERSION,
    tabs: list.filter((entry: any) => entry && KINDS[entry.kind]?.persist
      && (!NATIVE_EDITOR_KINDS.includes(entry.kind) || (typeof entry.key === 'string' && entry.key))),
    topology: sanitizeTopology(value.topology),
  }
}

function parseStoredJson(raw: string | null): any {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function readSessionCheckpoint(sessionId: string): StoredCheckpoint | null {
  const raw = readStorage(storageKey(sessionId))
  if (!raw) return null
  const checkpoint = sanitizeCheckpoint(parseStoredJson(raw))
  if (!checkpoint) removeStorage(storageKey(sessionId))
  return checkpoint
}

function readDraftCheckpoints(): Record<string, any> {
  const parsed = parseStoredJson(readStorage(DRAFT_TABS_KEY))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function readDraftCheckpoint(clientId: string): StoredCheckpoint | null {
  return sanitizeCheckpoint(readDraftCheckpoints()[clientId] ?? null)
}

function writeDraftCheckpoint(clientId: string, checkpoint: StoredCheckpoint | null): void {
  const map = readDraftCheckpoints()
  delete map[clientId]
  if (checkpoint) map[clientId] = checkpoint
  // Re-inserting a key moves it to the newest slot; trim from the oldest so
  // the draft store cannot grow without bound.
  const keys = Object.keys(map)
  while (keys.length > MAX_DRAFT_CHECKPOINTS) {
    const oldest = keys.shift()
    if (oldest !== undefined) delete map[oldest]
  }
  if (Object.keys(map).length === 0) removeStorage(DRAFT_TABS_KEY)
  else writeStorage(DRAFT_TABS_KEY, JSON.stringify(map))
}

function forgetDraftCheckpoint(clientId: string): void {
  writeDraftCheckpoint(clientId, null)
}

function saveScopeForSession(scope: ThreadTabScope, sessionId: string): void {
  if (!sessionId) return
  if (scope === boundScope) flushViewToScope()
  const checkpoint = checkpointForScope(scope)
  const raw = checkpoint ? JSON.stringify(checkpoint) : null
  if (raw === scope.lastStoredRaw) return
  scope.lastStoredRaw = raw
  if (raw === null) removeStorage(storageKey(sessionId))
  else writeStorage(storageKey(sessionId), raw)
}

function saveDraftScope(scope: ThreadTabScope): void {
  if (scope.sessionId || !isClientDraftId(scope.key)) return
  if (scope === boundScope) flushViewToScope()
  const checkpoint = checkpointForScope(scope)
  const raw = checkpoint ? JSON.stringify(checkpoint) : null
  if (raw === scope.lastStoredRaw) return
  scope.lastStoredRaw = raw
  writeDraftCheckpoint(scope.key, checkpoint)
}

function persistScope(scope: ThreadTabScope): void {
  if (!scope.hydrated) return
  if (scope.sessionId) saveScopeForSession(scope, scope.sessionId)
  else saveDraftScope(scope)
}

// Save the tab set of the given session's OWN scope — never the live view
// under a foreign id. A session whose scope is not resident has no live state
// to save, and its stored envelope is left untouched.
function saveFor(sessionId: string) {
  if (!sessionId) return
  const scope = scopes.get(scopeKeyForSession(sessionId))
  if (!scope || !scope.hydrated) return
  saveScopeForSession(scope, sessionId)
}

function forgetSession(sessionId: string) {
  if (!sessionId) return
  const clientId = forgetClientBinding(sessionId)
  if (clientId) forgetDraftCheckpoint(clientId)
  const key = clientId ?? `local:${sessionId}`
  const scope = scopes.get(key)
  if (scope) {
    scopes.delete(key)
    if (scope === boundScope) {
      // The visible conversation was deleted: detach WITHOUT checkpointing
      // (its rows are being destroyed) and rebind the active session.
      boundScope = null
      removeStorage(storageKey(sessionId))
      activeScope()
      publish()
      return
    }
  }
  removeStorage(storageKey(sessionId))
}

async function listNativeEditorDocuments(kind: string, sessionId: string): Promise<Array<{ id: string; title: string }> | null> {
  const klaus = w().klaus
  if (kind === 'ppt' && typeof klaus?.ppt?.list === 'function') {
    const res = await klaus.ppt.list(sessionId)
    return Array.isArray(res?.presentations) ? res.presentations : null
  }
  if (kind === 'prototype' && typeof klaus?.prototype?.list === 'function') {
    const res = await klaus.prototype.list(sessionId)
    return Array.isArray(res?.prototypes) ? res.prototypes : null
  }
  if (kind === 'video-editing' && typeof klaus?.videoEditing?.list === 'function') {
    const res = await klaus.videoEditing.list(sessionId)
    return Array.isArray(res?.videos) ? res.videos : null
  }
  return null
}

async function reconcileNativeEditorTabs(kind: string, sessionId: string, token: number) {
  let rows: Array<{ id: string; title: string }> | null = null
  try {
    rows = await listNativeEditorDocuments(kind, sessionId)
  } catch {
    return
  }
  if (!rows || token !== restoreToken) return
  const currentSession = w().getCurrentSessionId?.()
  if (currentSession !== undefined && currentSession !== sessionId) return
  activeScope()
  const live = new Map<string, string>()
  for (const row of rows) {
    const id = row?.id
    const title = row?.title
    if (typeof id === 'string' && id) {
      live.set(id, typeof title === 'string' ? title : '')
    }
  }
  let changed = false
  let removedActiveId: string | null = null
  for (const tab of [...tabs]) {
    if (tab.kind !== kind || tab.sessionId !== sessionId) continue
    if (!live.has(tab.key)) {
      if (activeId === tab.id) removedActiveId = tab.id
      remove(kind, tab.key)
      changed = true
    } else {
      const liveTitle = live.get(tab.key)
      if (liveTitle && tab.title !== liveTitle) {
        tab.title = liveTitle
        changed = true
      }
    }
  }
  if (!changed) return
  saveFor(sessionId)
  const mode = KINDS[kind]?.mode
  if (removedActiveId || (mode && currentMode() === mode && !nativeEditorCandidate(kind))) {
    await activateTab(mostRecentTab(removedActiveId || '') || find('monitor', ''))
    return
  }
  publish()
}

// ── Hydration: cold scope → checkpoint ────────────────────────────────────
// Restore is descriptor-only: a browser page comes back as a pending tab that
// creates its webview when the user actually clicks it, so switching sessions
// never spawns a pile of invisible webviews. Which tab ends up active stays
// the panel mode's call (chat.js restores that separately); the stored
// topology only pre-selects the strip until then.
function ensureScopeHydrated(scope: ThreadTabScope): void {
  if (scope.hydrated) return
  scope.hydrated = true
  const checkpoint = scope.sessionId
    ? readSessionCheckpoint(scope.sessionId)
    : readDraftCheckpoint(scope.key)
  if (checkpoint) applyCheckpoint(scope, checkpoint)
  if (scope === boundScope) refreshViewFromScope(scope)
}

function restoredNativeKinds(scope: ThreadTabScope): Set<string> {
  const kinds = new Set<string>()
  for (const tab of scope.tabs) {
    if (NATIVE_EDITOR_KINDS.includes(tab.kind)) kinds.add(tab.kind)
  }
  return kinds
}

function applyCheckpoint(scope: ThreadTabScope, checkpoint: StoredCheckpoint): void {
  for (const entry of checkpoint.tabs) {
    if (entry.kind === 'browser') {
      const url = typeof entry.url === 'string' ? entry.url : ''
      if (isTransientLocalPage(url)) continue
      ensureInScope(scope, 'browser', `restored:${url || 'blank'}`, { url, pending: true, title: browserTitleFor(url) })
    } else if (NATIVE_EDITOR_KINDS.includes(entry.kind)) {
      // The document itself lives on the host; the descriptor only points
      // back at it and remembers which chat owns the activation.
      const { key, title: storedTitle } = entry
      const title = typeof storedTitle === 'string' && storedTitle ? storedTitle : defaultTitle(entry.kind)
      const tab = ensureInScope(scope, entry.kind, key || '', { title })
      if (tab && scope.sessionId) tab.sessionId = scope.sessionId
    } else {
      ensureInScope(scope, entry.kind, '')
    }
  }
  const topology = checkpoint.topology
  if (!topology) return
  if (topology.tabIds.length > 0) {
    // Re-apply the stored strip order; ids the checkpoint does not list keep
    // their creation order at the end (Array#sort is stable).
    const order = new Map(topology.tabIds.map((id, index) => [id, index] as const))
    const rank = (tab: Tab) => order.get(tab.id) ?? Number.MAX_SAFE_INTEGER
    const fixed = scope.tabs.filter(isFixed)
    const instances = scope.tabs.filter(tab => !isFixed(tab))
    instances.sort((a, b) => rank(a) - rank(b))
    scope.tabs.splice(0, scope.tabs.length, ...fixed, ...instances)
  }
  const restored = topology.activeTabId
  if (restored && scope.tabs.some(tab => tab.id === restored)) {
    scope.activeId = restored
    const at = scope.mru.indexOf(restored)
    if (at >= 0) scope.mru.splice(at, 1)
    scope.mru.unshift(restored)
  }
}

// Surfaces that cannot survive the session leave (shells are gone; engine
// state belongs to that chat) drop out of the resident scope, and live browser
// descriptors fold back into the same pending placeholders a cold restore
// produces — so a warm scope reuse can never offer a webview the host already
// tore down, and the strip a return visit shows matches the storage round-trip.
function pruneVolatileTabsOnLeave(scope: ThreadTabScope): void {
  const kept: Tab[] = []
  const remap = new Map<string, string>()
  for (const tab of scope.tabs) {
    if (isFixed(tab)) { kept.push(tab); continue }
    if (!KINDS[tab.kind]?.persist) continue
    if (tab.kind === 'browser') {
      const url = tab.url || ''
      // Loopback preview servers may stop between visits; only live host tabs
      // are restored, so a transient page does not survive the leave either.
      if (isTransientLocalPage(url)) continue
      if (tab.pending) {
        if (!kept.some(item => item.id === tab.id)) kept.push(tab)
        continue
      }
      const key = `restored:${url || 'blank'}`
      const id = descriptorId('browser', key)
      remap.set(tab.id, id)
      if (!kept.some(item => item.id === id)) {
        kept.push({ ...tab, id, key, pending: true, title: browserTitleFor(url, tab.title) })
      }
      continue
    }
    if (NATIVE_EDITOR_KINDS.includes(tab.kind) && scope.sessionId && tab.sessionId && tab.sessionId !== scope.sessionId) {
      // A document owned by another chat never rides along with this scope.
      continue
    }
    kept.push(tab)
  }
  scope.tabs.splice(0, scope.tabs.length, ...kept)
  const surviving = new Set(scope.tabs.map(tab => tab.id))
  const remapped = (id: string) => remap.get(id) ?? id
  scope.mru = scope.mru
    .map(remapped)
    .filter((id, index, list) => surviving.has(id) && list.indexOf(id) === index)
  scope.activeId = scope.activeId && surviving.has(remapped(scope.activeId)) ? remapped(scope.activeId) : null
  scope.leftActiveId = scope.leftActiveId && surviving.has(scope.leftActiveId) ? scope.leftActiveId : null
}

function browserTitleFor(url: string, title = '') {
  if (title) return title
  if (!url || url === 'about:blank') return defaultTitle('browser')
  try {
    return new URL(url).hostname || defaultTitle('browser')
  } catch {
    return defaultTitle('browser')
  }
}

// ── Session switch: leave → bind → reconcile, one transaction ────────────
// The outgoing scope is checkpointed and pruned inside the bind; the target
// scope hydrates once (cold) or is reused as-is (resident). Every switch then
// revalidates the native-editor descriptors against the host document lists,
// so a document that disappeared while the chat was away self-heals instead of
// surfacing a dead editor on click.
function beginSessionSwitch(previousSessionId: string | null, nextSessionId: string | null) {
  activationToken++
  canvasOpenToken++
  const token = ++restoreToken
  // Pin the latch to the target before the window's current-session marker
  // catches up, so every scope resolution inside this transaction (and any
  // owner sync it kicks) already addresses the next conversation. The outgoing
  // scope checkpoints under its own identity during the bind below.
  void previousSessionId
  switchedSessionId = nextSessionId
  switchedAtWindowSessionId = rawWindowSessionId()
  const scope = getOrCreateScope(nextSessionId)
  publish()
  if (!nextSessionId) return
  for (const kind of restoredNativeKinds(scope)) {
    void reconcileNativeEditorTabs(kind, nextSessionId, token)
  }
}

// Write the live tab set for whichever scope owns it right now — used after
// an in-place change (drag reorder) that no session switch will capture.
function persistCurrent() {
  persistScope(activeScope())
}

// ── Draft promotion ───────────────────────────────────────────────────────
// A draft conversation materializes into a real session id IN PLACE: the scope
// the user was already building tabs in is bound to the new id (nothing is
// recreated or lost), its checkpoint moves to the session storage, and the
// new-chat identity rotates so the next draft starts clean. Callers run this
// BEFORE the window's current-session marker flips to the new id.
function promoteDraftSession(sessionId: string) {
  if (!sessionId) return
  if (boundClientThreadId(sessionId)) return
  const draft = boundScope && boundScope.sessionId === null && isClientDraftId(boundScope.key)
    ? boundScope
    : scopes.get(draftClientThreadId ?? '') ?? null
  const clientId = draft?.key ?? ensureDraftClientThreadId()
  const staleLocal = scopes.get(`local:${sessionId}`)
  if (staleLocal && staleLocal !== draft) {
    // A placeholder scope materialized before the binding existed; the
    // promoted scope supersedes it.
    scopes.delete(`local:${sessionId}`)
    if (staleLocal === boundScope) boundScope = null
  }
  recordClientBinding(sessionId, clientId)
  switchedSessionId = sessionId
  switchedAtWindowSessionId = rawWindowSessionId()
  if (draft) {
    if (draft === boundScope) flushViewToScope()
    draft.sessionId = sessionId
    for (const tab of draft.tabs) {
      if (NATIVE_EDITOR_KINDS.includes(tab.kind) && !tab.sessionId) tab.sessionId = sessionId
    }
    // The checkpoint moves to a different storage key, so the write-dedup
    // cache (which is per key) must not suppress the session-side write.
    draft.lastStoredRaw = null
    saveScopeForSession(draft, sessionId)
    forgetDraftCheckpoint(clientId)
  } else {
    // Cold promotion: migrate the stored draft checkpoint instead.
    const checkpoint = readDraftCheckpoint(clientId)
    if (checkpoint) {
      writeStorage(storageKey(sessionId), JSON.stringify(checkpoint))
      forgetDraftCheckpoint(clientId)
    }
  }
}

// ── Sync entry points used by the surface owners ──────────────────────────
// Terminals: one tab for the whole surface, present exactly while the active
// conversation has a live shell. chat.js owns the inner list, so all the strip
// is told is how many shells are left.
function syncTerminals(count = 0) {
  const tab = find('terminal', '')
  if (count > 0) {
    const next = ensure('terminal', '')
    if (currentMode() === 'terminal' && next) setActiveId(next.id)
    publish()
    return
  }
  if (!tab) { publish(); return }
  const wasActive = activeId === tab.id
  remove('terminal', '')
  // The last shell dying takes the surface with it, so focus is owed a
  // landing spot — the same fallback a manual tab close uses.
  if (wasActive && closingTabId !== tab.id) {
    void activateTab(mostRecentTab(tab.id) || find('monitor', ''))
    return
  }
  publish()
}

// Browser pages: one outer tab per host-side tab in the active conversation.
function syncBrowserTabs(list: Array<{ id: string; url?: string; title?: string }> = [], activeTabId: string | null = null) {
  activeScope()
  const live = Array.isArray(list) ? list : []
  const liveIds = new Set(live.map(item => item.id))
  const liveUrls = new Set(live.map(item => item.url || ''))
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i]
    if (tab.kind !== 'browser') continue
    // A pending placeholder is superseded the moment a live page with the same
    // URL exists — that is the restore completing, not a second page.
    if (tab.pending) {
      if (liveUrls.has(tab.url || '')) { forgetMru(tab.id); tabs.splice(i, 1) }
      continue
    }
    if (!liveIds.has(tab.key)) { forgetMru(tab.id); tabs.splice(i, 1) }
  }
  for (const item of live) {
    ensure('browser', item.id, { url: item.url || '', title: browserTitleFor(item.url || '', item.title) })
  }
  if (currentMode() === 'browser' && activeTabId) {
    const tab = find('browser', activeTabId)
    if (tab) setActiveId(tab.id)
  }
  if (activeId && !tabs.some(tab => tab.id === activeId)) activeId = null
  publish()
}

// Side tasks publish their independent lifecycle and attention state.
function syncSideTasks(list: Array<{ id: string; title?: string; badge?: string; running?: boolean; unread?: boolean; placement?: 'left' | 'right' }> = [], activeSideId: string | null = null, leftSideId: string | null = null) {
  activeScope()
  leftActiveId = leftSideId ? descriptorId('side-task', leftSideId) : null
  const live = new Set(list.map(item => item.id))
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i]
    if (tab.kind === 'side-task' && !live.has(tab.key)) {
      forgetMru(tab.id)
      tabs.splice(i, 1)
    }
  }
  for (const item of list) {
    ensure('side-task', item.id, {
      title: item.title ?? defaultTitle('side-task'),
      badge: item.badge || '',
      running: !!item.running,
      unread: !!item.unread,
      placement: item.placement || 'right',
    })
  }
  if (currentMode() === 'side-chat' && activeSideId) {
    const tab = find('side-task', activeSideId)
    if (tab) setActiveId(tab.id)
  }
  if (activeId && !tabs.some(tab => tab.id === activeId)) activeId = null
  publish()
}

async function moveSideTask(tab: Tab, placement: 'left' | 'right') {
  activeScope()
  const token = restoreToken
  if (await w().KlausSideTasks?.moveTo?.(tab.key, placement) === false || token !== restoreToken) return
  tab.placement = placement
  if (placement === 'left') {
    leftActiveId = tab.id
    if (activeId === tab.id) {
      activeId = null
      await activateTab(mostRecentTab(tab.id) || find('monitor', ''))
    }
  } else {
    if (leftActiveId === tab.id) leftActiveId = null
    setActiveId(tab.id)
  }
  publish()
}

function dropSideTask(event: React.DragEvent | DragEvent, placement: 'left' | 'right') {
  const tab = findById(event.dataTransfer?.getData('text/plain') || draggingId || '')
  if (tab?.kind !== 'side-task' || tab.placement === placement) return
  event.preventDefault()
  event.stopPropagation()
  draggingId = null
  pendingPublish = false
  void moveSideTask(tab, placement).catch(error => w().showToast?.(String(error)))
}

function sideTaskQuotePanels(): SideTaskQuotePanel[] {
  activeScope()
  const active = activeId ? findById(activeId) : null
  return [{
    placement: 'right',
    activeId: active?.kind === 'side-task' ? active.key : null,
    tabs: tabs.filter(tab => tab.kind === 'side-task' && tab.placement !== 'left').map(tab => tab.key),
  }]
}

async function openSubagent(taskId: string, title = '') {
  if (!taskId) return
  const tab = ensure('subagent', taskId, { title: title || defaultTitle('subagent') })
  await activateTab(tab)
}

function remapSubagentTasks(aliases: Record<string, string>) {
  for (const [alias, taskId] of Object.entries(aliases)) {
    const tab = find('subagent', alias)
    if (!tab) continue
    const previousId = tab.id
    const canonical = find('subagent', taskId)
    if (canonical && canonical !== tab) tabs.splice(tabs.indexOf(canonical), 1)
    tab.key = taskId
    tab.id = descriptorId('subagent', taskId)
    for (let index = 0; index < mru.length; index++) if (mru[index] === previousId) mru[index] = tab.id
    if (activeId === previousId || activeId === canonical?.id) activeId = tab.id
  }
  mru.splice(0, mru.length, ...new Set(mru))
  publish()
}

async function openBackgroundProcess(shellId: string, title = '') {
  if (!shellId) return
  const tab = ensure('background-process', shellId, { title: title || defaultTitle('background-process') })
  await activateTab(tab)
}

async function openSpec({ path, sessionId }: { path?: string; title?: string; sessionId?: string | null } = {}) {
  if (!path) return
  activeScope()
  // Spec owns a document selector inside one surface. Switching documents must
  // not tear down the annotation drafts belonging to the previous document.
  const existing = tabs.find(tab => tab.kind === 'spec')
  if (existing && existing.key !== path) {
    const previousId = existing.id
    existing.key = path
    existing.id = descriptorId('spec', path)
    for (let index = 0; index < mru.length; index++) if (mru[index] === previousId) mru[index] = existing.id
    if (activeId === previousId) activeId = existing.id
  }
  const tab = ensure('spec', path, { title: 'Spec' })
  if (tab) tab.sessionId = sessionId ?? w().getCurrentSessionId?.() ?? null
  await activateTab(tab)
}

async function openPlanning({ sessionId, planId, revision }: { sessionId: string; planId: string; revision: number }) {
  activeScope()
  const current = tabs.find(tab => tab.kind === 'planning')
  if (current && current.key !== `${planId}:${revision}`) {
    if (await w().klausClosePlanningPanel?.() === false) return false
    remove('planning', current.key)
  }
  const tab = ensure('planning', `${planId}:${revision}`, { title: tt('planning_title'), url: planId })
  if (!tab) return false
  tab.sessionId = sessionId
  tab.revision = revision
  return activateTab(tab)
}

async function openGoal({ sessionId, goalId }: { sessionId: string; goalId: string }) {
  const tab = ensure('goal', goalId, { title: tt('composer_goal') })
  if (!tab) return false
  tab.sessionId = sessionId
  return activateTab(tab)
}
function closeGoal() {
  activeScope()
  for (const tab of [...tabs]) if (tab.kind === 'goal') { w().klausCloseGoalPanel?.(); remove('goal', tab.key) }
  if (currentMode() === 'goal') void activateTab(find('monitor', ''))
}

async function closeSpec(path: string) {
  if (!path) return
  await closeTab(find('spec', path))
}

async function openCanvas({ path, title }: { path?: string; title?: string } = {}) {
  if (!path) return false
  const token = ++canvasOpenToken
  const sessionId = w().getCurrentSessionId?.() ?? null
  const existingForPath = find('canvas', path)
  for (const existing of [...tabs]) {
    if (existing.kind !== 'canvas' || existing.key === path) continue
    await w().klausCloseCanvasPanel?.(existing.key)
    if (token !== canvasOpenToken || sessionId !== (w().getCurrentSessionId?.() ?? null)) return false
    remove(existing.kind, existing.key)
  }
  const tab = ensure('canvas', path, { title: title || defaultTitle('canvas') })
  return activateTab(tab, { reloadCanvas: !!existingForPath })
}

async function closeCanvas(path: string) {
  if (!path) return
  await closeTab(find('canvas', path))
}

async function clearCanvases() {
  activeScope()
  canvasOpenToken++
  activationToken++
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (tabs[i].kind !== 'canvas') continue
    forgetMru(tabs[i].id)
    tabs.splice(i, 1)
  }
  if (activeId?.startsWith('canvas:')) activeId = null
  await w().klausCloseCanvasPanel?.()
  publish()
}

async function openPrototype({ id, title, sessionId }: { id: string; title?: string; sessionId: string }) {
  if (!id || !sessionId || sessionId !== w().getCurrentSessionId?.()) return false
  const tab = ensure('prototype', id, { title: title || defaultTitle('prototype') })
  if (!tab) return false
  tab.sessionId = sessionId
  return activateTab(tab)
}

function clearPrototypes() {
  activeScope()
  activationToken++
  for (const tab of [...tabs]) if (tab.kind === 'prototype') remove('prototype', tab.key)
  publish()
}

async function openVideoEditing({ id, title, sessionId }: { id: string; title?: string; sessionId: string }) {
  if (!id || !sessionId || sessionId !== w().getCurrentSessionId?.()) return false
  const tab = ensure('video-editing', id, { title: title || defaultTitle('video-editing') })
  if (!tab) return false
  tab.sessionId = sessionId
  return activateTab(tab)
}

async function openPpt({ id, title, sessionId }: { id: string; title?: string; sessionId: string }) {
  if (!id || !sessionId || sessionId !== w().getCurrentSessionId?.()) return false
  const tab = ensure('ppt', id, { title: title || defaultTitle('ppt') })
  if (!tab) return false
  tab.sessionId = sessionId
  return activateTab(tab)
}

function clearVideoEditings() {
  activeScope()
  activationToken++
  for (const tab of [...tabs]) if (tab.kind === 'video-editing') remove('video-editing', tab.key)
  publish()
}

function clearPresentations() {
  activeScope()
  activationToken++
  for (const tab of [...tabs]) if (tab.kind === 'ppt') remove('ppt', tab.key)
  publish()
}

function clearSpecs() {
  activeScope()
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (!['spec', 'planning', 'goal'].includes(tabs[i].kind)) continue
    forgetMru(tabs[i].id)
    tabs.splice(i, 1)
  }
  if (activeId && /^(spec|planning|goal):/.test(activeId)) activeId = null
  publish()
}

function clearBackgroundProcesses() {
  activeScope()
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (tabs[i].kind !== 'background-process') continue
    forgetMru(tabs[i].id)
    tabs.splice(i, 1)
  }
  if (activeId?.startsWith('background-process:')) activeId = null
  publish()
}

function clearSubagents() {
  activeScope()
  for (let i = tabs.length - 1; i >= 0; i--) {
    if (tabs[i].kind !== 'subagent') continue
    forgetMru(tabs[i].id)
    tabs.splice(i, 1)
  }
  if (activeId?.startsWith('subagent:')) activeId = null
  publish()
}

// Called by chat.js whenever the panel mode changes, so the strip follows the
// panel even when something other than a tab click moved it.
function onModeChanged(mode: string) {
  const kind = Object.keys(KINDS).find(name => KINDS[name].mode === mode) || 'monitor'
  if (KINDS[kind].fixed) {
    ensure(kind, '')
    setActiveId(descriptorId(kind, ''))
    publish()
    return
  }
  const key = kind === 'browser'
    ? (w().klausActiveBrowserTabId?.() || '')
    : kind === 'side-task'
      ? (w().KlausSideTasks?.getActiveSideId?.() || '')
      : kind === 'subagent'
        ? (w().KlausSubagentPanel?.getActiveTaskId?.() || '')
        : kind === 'background-process'
          ? (w().KlausBackgroundProcessPanel?.getActiveShellId?.() || '')
        : kind === 'planning'
          ? (w().klausActivePlanningKey?.() || '')
        : kind === 'goal'
          ? (w().klausActiveGoalId?.() || '')
        : kind === 'spec'
          ? (w().klausActiveSpecPath?.() || '')
        : kind === 'canvas'
          ? (w().klausActiveCanvasPath?.() || '')
        : kind === 'prototype'
          ? (w().klausActivePrototypeId?.() || '')
        : kind === 'video-editing'
          ? (w().klausActiveVideoEditingId?.() || '')
        : kind === 'ppt'
          ? (w().klausActivePptId?.() || '')
        : ''
  // An owner-published kind is only SELECTED here, never created: entering the
  // mode happens before the surface has anything in it (terminal mode opens,
  // then the shell starts), and a tab minted from the mode alone described a
  // surface that did not exist yet. The owner's very next sync reported zero
  // shells, withdrew that tab, and — because it held focus — handed the panel
  // back to Monitor, so the new terminal landed behind the Monitor tab.
  const tab = KINDS[kind].owned ? find(kind, key) : ensure(kind, key)
  if (!tab && NATIVE_EDITOR_KINDS.includes(kind)) {
    // Returning to a chat restores its editor descriptors before the surface
    // owner reports an active document again. Entering the mode then lands on
    // that chat's own parked editor instead of an empty body.
    const candidate = nativeEditorCandidate(kind)
    if (candidate) {
      setActiveId(candidate.id)
      publish()
      void activateTab(candidate)
      return
    }
  }
  setActiveId(tab ? tab.id : null)
  publish()
}

// The parked editor a restored mode should re-activate: the document the
// surface owner last held for this chat, else the chat's first editor tab.
function nativeEditorCandidate(kind: string): Tab | null {
  const sessionId = w().getCurrentSessionId?.() ?? null
  if (!sessionId) return null
  const owned = tabs.filter(tab => tab.kind === kind && tab.sessionId === sessionId)
  if (!owned.length) return null
  const hook = w()[NATIVE_RESUME_HOOK[kind]]
  const resumeId = typeof hook === 'function' ? String(hook() || '') : ''
  return (resumeId ? owned.find(tab => tab.key === resumeId) : undefined) || owned[0] || null
}

// ── Header menu / context menu item shapes ────────────────────────────────
interface MenuItem {
  kind: string
  label: string
  iconHtml?: string
  active?: boolean
  disabled?: boolean
  run?: () => unknown
}

interface CtxItem {
  label: string
  disabled?: boolean
  separated?: boolean
  run: () => unknown
}

// ── "More" menu: every tab reachable even when the strip is clipped ───────
function buildMoreItems(): MenuItem[] {
  activeScope()
  return tabs.map(tab => ({
    kind: tab.kind,
    label: tabPresentation(tab).title,
    iconHtml: tabPresentation(tab).iconHtml,
    active: activeId === tab.id,
    run: () => activateTab(tab),
  }))
}

// ── `+` menu: one entry point that CREATES a new surface ──────────────────
// Entries are named after the surface itself (the same label its tab carries),
// not "New <surface>": the `+` already says what the menu does, so repeating it
// on every row only makes them longer to read.
// A surface that cannot be created right now is left OUT rather than listed
// greyed: this menu is the create action, so an entry that cannot act does not
// belong in it. Side tasks fork the main task, so they need a user message
// first — the row appears with the same timing as its side-rail entry.
function buildNewItems(): MenuItem[] {
  const side = w().KlausSideTasks
  const items: MenuItem[] = []
  if (side?.canCreate?.()) {
    items.push({ kind: 'side-task', label: defaultTitle('side-task'), run: () => side?.create?.() })
  }
  items.push(
    { kind: 'workspace', label: defaultTitle('workspace'), run: () => w().showWorkspaceMainView?.({ openPanel: true }) },
    { kind: 'browser', label: defaultTitle('browser'), run: () => w().klausNewBrowserTab?.() },
    { kind: 'terminal', label: defaultTitle('terminal'), run: () => w().klausNewTerminal?.() },
    { kind: 'diff', label: defaultTitle('diff'), run: () => w().klausOpenDiffPanel?.() },
  )
  return items
}

// ── Context menu: close / close others / close right ─────────────────────
function buildContextItems(tab: Tab): CtxItem[] {
  activeScope()
  const index = tabs.findIndex(item => item.id === tab.id)
  const others = tabs.filter(item => item.id !== tab.id && !isFixed(item) && item.placement === tab.placement)
  const right = tabs.slice(index + 1).filter(item => !isFixed(item) && item.placement === tab.placement)
  const items: CtxItem[] = [
    { label: tt('artifacts_tab_close'), disabled: isFixed(tab), run: () => closeTab(tab) },
    { label: tt('artifacts_tab_close_others'), disabled: others.length === 0, run: () => closeMany(others) },
    { label: tt('artifacts_tab_close_right'), disabled: right.length === 0, run: () => closeMany(right) },
  ]
  // A side task is temporary by design; converting it forks its transcript into
  // a standalone session, which is the only way to keep it.
  if (tab.kind === 'side-task') {
    const target = tab.placement === 'left' ? 'right' : 'left'
    items.push({ label: tt(target === 'left' ? 'side_task_move_left' : 'side_task_move_right'),
      separated: true, run: () => moveSideTask(tab, target) })
  }
  return items
}

// ── Components ────────────────────────────────────────────────────────────
// Both header dropdowns (`+` and `more`) hang from their own trigger, down and
// to the left, instead of being pinned to the panel's right edge — a menu that
// opens 600px away from the button it belongs to reads as a stray box.
function anchorMenuToTrigger(menu: HTMLElement | null, trigger: HTMLElement | null) {
  if (!menu || !trigger) return
  const host = menu.offsetParent as HTMLElement | null
  if (!host) return
  const hostRect = host.getBoundingClientRect()
  const btnRect = trigger.getBoundingClientRect()
  const width = menu.offsetWidth
  const margin = 8
  const wanted = btnRect.right - hostRect.left - width
  const maxLeft = Math.max(margin, hostRect.width - width - margin)
  menu.style.right = 'auto'
  menu.style.left = `${Math.max(margin, Math.min(wanted, maxLeft))}px`
  menu.style.top = `${Math.round(btnRect.bottom - hostRect.top) + 4}px`
}

// The embedded browser is a NATIVE view: it paints above every HTML layer, so
// no z-index can put a menu in front of it. While a header menu is open the
// runtime steps aside, and it comes back when the menu closes.
//
// One implementation serves both dropdowns: same metrics, same icon column,
// same dismissal.
function HeaderMenu({ id, labelledBy, items, menuRef, onClose }: {
  id: string
  labelledBy: string
  items: MenuItem[] | null
  menuRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
}) {
  const open = !!items
  useLayoutEffect(() => {
    if (!open) return
    const trigger = document.getElementById(labelledBy)
    anchorMenuToTrigger(menuRef.current, trigger)
  }, [open, items])
  useEffect(() => {
    if (!open) return
    void w().klausSuspendBrowserForOverlay?.()
    void w().klausSuspendCanvasForOverlay?.()
    void w().klausSuspendPrototypeForOverlay?.()
    void w().klausSuspendVideoEditingForOverlay?.()
    void w().klausSuspendPptForOverlay?.()
    return () => {
      void w().klausResumeBrowserAfterOverlay?.()
      void w().klausResumeCanvasAfterOverlay?.()
      void w().klausResumePrototypeAfterOverlay?.()
      void w().klausResumeVideoEditingAfterOverlay?.()
      void w().klausResumePptAfterOverlay?.()
    }
  }, [open])
  return (
    <div id={id} className={`${styles['artifacts-menu']}${open ? '' : ' hidden'}`} role="menu" aria-labelledby={labelledBy} ref={menuRef}>
      {(items || []).map((item, index) => (
        <button
          key={index}
          type="button"
          className={`${styles['artifacts-menu-item']}${item.active ? ' active' : ''}`}
          role="menuitem"
          disabled={!!item.disabled}
          aria-disabled={item.disabled ? 'true' : undefined}
          onClick={item.disabled ? undefined : (event) => {
            event.stopPropagation()
            onClose()
            Promise.resolve(item.run?.()).catch(error => {
              console.warn('[panel-tabs] menu action failed:', error)
            })
          }}
        >
          <span className={styles['artifacts-menu-icon']} aria-hidden="true" dangerouslySetInnerHTML={{ __html: item.iconHtml ?? ICONS[item.kind] ?? '' }} />
          <span className={styles['artifacts-menu-label']}>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

function TabContextMenu({ x, y, items, onClose }: { x: number; y: number; items: CtxItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const menu = ref.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    const margin = 8
    menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`
    menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`
  }, [x, y])
  useEffect(() => {
    void w().klausSuspendCanvasForOverlay?.()
    void w().klausSuspendPrototypeForOverlay?.()
    void w().klausSuspendVideoEditingForOverlay?.()
    void w().klausSuspendPptForOverlay?.()
    const menu = ref.current
    const onPointerDown = (ev: PointerEvent) => { if (menu && !menu.contains(ev.target as Node)) onClose() }
    const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    const onResize = () => onClose()
    const timer = setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('resize', onResize, true)
    }, 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onResize, true)
      void w().klausResumeCanvasAfterOverlay?.()
      void w().klausResumePrototypeAfterOverlay?.()
      void w().klausResumeVideoEditingAfterOverlay?.()
      void w().klausResumePptAfterOverlay?.()
    }
  }, [])
  // Same class as the workspace tab menu so both strips share one visual.
  return (
    <div className="workspace-context-menu workspace-tab-context-menu" role="menu" ref={ref}>
      {items.map((item, index) => (
        <Fragment key={index}>
          {item.separated ? <div className={styles['workspace-context-menu-divider']} /> : null}
          <button
            type="button"
            role="menuitem"
            disabled={!!item.disabled}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onClose()
              void item.run()
            }}
          >
            <span>{item.label}</span>
          </button>
        </Fragment>
      ))}
    </div>
  )
}

function clearDropMarkers(scroller: HTMLElement | null) {
  for (const el of scroller?.querySelectorAll(`.${styles['artifacts-tab']}`) || []) {
    el.classList.remove('drop-before', 'drop-after')
  }
}

function SideTabStatus({ view }: { view: TabView }) {
  return <>
    <span className={styles['artifacts-tab-icon']} aria-hidden="true">
      {view.running ? <span className={styles['artifacts-tab-spinner']} />
        : <span dangerouslySetInnerHTML={{ __html: view.iconHtml }} />}
      {view.unread && !view.running ? <span className={styles['artifacts-tab-unread-dot']} /> : null}
    </span>
    {view.running || view.unread ? <span className={styles['artifacts-tab-status']}>
      {tt(view.running ? 'side_task_running' : 'side_task_unread')}
    </span> : null}
  </>
}

function LeftSideTabsStrip() {
  const snap = useStore(store)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null)
  const left = snap.tabs.filter(view => view.placement === 'left')
  if (!left.length) return null
  return <>
    <div className={styles['artifacts-tabs-scroll']} role="tablist"
      onDragOver={event => { if (findById(draggingId || '')?.kind === 'side-task') event.preventDefault() }}
      onDrop={event => dropSideTask(event, 'left')}>
      <div className={`${styles['artifacts-tab']} ${!snap.leftActiveId ? 'active' : ''}`}>
        <button type="button" className={styles['artifacts-tab-trigger']} role="tab" aria-selected={!snap.leftActiveId}
          onClick={() => { leftActiveId = null; w().KlausSideTasks?.showParent?.(); publish() }}>{tt('side_task_parent')}</button>
      </div>
      {left.map(view => <div key={view.id} className={`${styles['artifacts-tab']} ${styles['artifacts-tab-instance']} ${view.active ? 'active' : ''}`}
        data-tab-id={view.id} data-panel-tab="side-task" draggable
        onDragStart={event => { draggingId = view.id; event.dataTransfer.setData('text/plain', view.id); event.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { draggingId = null; if (pendingPublish) { pendingPublish = false; publish() } }}
        onContextMenu={event => { event.preventDefault(); const tab = findById(view.id); if (tab) setCtxMenu({ x: event.clientX, y: event.clientY, items: buildContextItems(tab) }) }}
        onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void closeTab(findById(view.id)) } }}>
        <button type="button" className={styles['artifacts-tab-trigger']} role="tab" aria-selected={view.active}
          onClick={() => { void activateTab(findById(view.id)) }}><SideTabStatus view={view} /><span className={styles['artifacts-tab-label']}>{view.title}</span></button>
        <button type="button" className={styles['artifacts-tab-close']} aria-label={`${tt('artifacts_tab_close')}: ${view.title}`}
          onClick={() => { void closeTab(findById(view.id)) }} dangerouslySetInnerHTML={{ __html: icon('row-close-x') }} />
      </div>)}
    </div>
    {ctxMenu ? <TabContextMenu {...ctxMenu} onClose={() => setCtxMenu(null)} /> : null}
  </>
}

function PanelTabsStrip() {
  const snap = useStore(store)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const moreBtnRef = useRef<HTMLButtonElement | null>(null)
  const moreMenuRef = useRef<HTMLDivElement | null>(null)
  const newMenuRef = useRef<HTMLDivElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [moreItems, setMoreItems] = useState<MenuItem[] | null>(null)
  const [newItems, setNewItems] = useState<MenuItem[] | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null)
  // Last active id the strip scrolled into view, so a repaint does not re-reveal
  // (and thereby undo the user's own scrolling).
  const revealedRef = useRef<string | null>(null)
  const [, bump] = useReducer((x: number) => x + 1, 0)

  // Overflow re-measures after every commit（等价旧版每次 render 都 syncOverflow），
  // ResizeObserver 覆盖面板拉伸/折叠导致的尺寸变化。
  // ⚠ no-deps layout effect 里的 setState 必须带值守卫：React 对相同值也会再
  // 渲染组件本体一次（bail-out 只保证不深入子树），无守卫即永动机（#185）。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    // A collapsed panel has zero-width chrome: measuring it would report every
    // tab as clipped and pin the `more` trigger on permanently.
    //
    // An OPEN panel whose scroller measures 0 is different: the strip is mid
    // CSS-transition or squeezed out by its own `more` trigger. Treating that
    // as "not overflowing" closed a feedback loop — more shows → scroller hits
    // 0 → "not overflowing" → more hides → scroller is clipped again → more
    // shows … — which the old imperative strip rode as a per-frame flicker and
    // React turns into a nested-update crash. Unmeasurable is NOT "fits": keep
    // the last verdict until the strip has real width again.
    if (snap.panelOpen && scroller.clientWidth === 0) return
    const measurable = snap.panelOpen && scroller.clientWidth > 0
    const next = measurable && scroller.scrollWidth - scroller.clientWidth > 1
    if (next !== overflowing) setOverflowing(next)
    if (!next && moreItems) setMoreItems(null)
    // Reveal the active tab when the SELECTION moves, not on every repaint:
    // doing it unconditionally fought the user, snapping the strip back to the
    // active tab every time anything re-rendered while they scrolled.
    if (!next || revealedRef.current === snap.activeId) return
    revealedRef.current = snap.activeId
    scroller.querySelector(`.${styles['artifacts-tab']}.active`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })

  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => bump())
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  // A clipped strip scrolls under the wheel: vertical wheel deltas are the only
  // ones a trackpad-less mouse produces, and there is nothing to scroll
  // vertically here.（passive:false 必须原生监听，React 合成 wheel 不能 preventDefault。）
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onWheel = (event: WheelEvent) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      event.preventDefault()
      scroller.scrollLeft += delta
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [])

  // Dismiss on outside click / Escape for every header menu at once.
  useEffect(() => {
    if (!moreItems && !newItems) return
    const entries: Array<{ menu: HTMLElement | null; trigger: HTMLElement | null; close: () => void }> = [
      { menu: moreMenuRef.current, trigger: moreBtnRef.current, close: () => setMoreItems(null) },
      { menu: newMenuRef.current, trigger: document.getElementById('artifacts-new-tab'), close: () => setNewItems(null) },
    ]
    const onClick = (event: MouseEvent) => {
      for (const { menu, trigger, close } of entries) {
        if (!menu || menu.classList.contains('hidden')) continue
        if (trigger && (event.target === trigger || trigger.contains(event.target as Node))) continue
        if (menu.contains(event.target as Node)) continue
        close()
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMoreItems(null); setNewItems(null) }
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [moreItems, newItems])

  const onTabDragStart = (view: TabView) => (event: React.DragEvent<HTMLDivElement>) => {
    draggingId = view.id
    event.currentTarget.classList.add('dragging')
    event.dataTransfer?.setData('text/plain', view.id)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  }
  const onTabDragEnd = () => (event: React.DragEvent<HTMLDivElement>) => {
    draggingId = null
    event.currentTarget.classList.remove('dragging')
    clearDropMarkers(scrollerRef.current)
    if (pendingPublish) { pendingPublish = false; publish() }
  }
  const onTabDragOver = (view: TabView) => (event: React.DragEvent<HTMLDivElement>) => {
    if (!draggingId || draggingId === view.id) return
    // A fixed tab is not a drop target: dropping there would put an instance
    // ahead of the anchors.
    if (view.fixed) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientX > rect.left + rect.width / 2
    clearDropMarkers(scrollerRef.current)
    event.currentTarget.classList.add(after ? 'drop-after' : 'drop-before')
  }
  const onTabDragLeave = () => (event: React.DragEvent<HTMLDivElement>) => {
    event.currentTarget.classList.remove('drop-before', 'drop-after')
  }
  const onTabDrop = (view: TabView) => (event: React.DragEvent<HTMLDivElement>) => {
    if (!draggingId || view.fixed) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const after = event.clientX > rect.left + rect.width / 2
    const sourceId = draggingId
    draggingId = null
    clearDropMarkers(scrollerRef.current)
    if (pendingPublish) { pendingPublish = false; publish() }
    moveTab(sourceId, view.id, after)
  }

  return (
    <>
      <div id="artifacts-tabs-scroll" className={styles['artifacts-tabs-scroll']} ref={scrollerRef} role="tablist"
        onDragOver={event => { if (findById(draggingId || '')?.placement === 'left') event.preventDefault() }}
        onDrop={event => dropSideTask(event, 'right')}>
        {snap.tabs.filter(view => view.placement !== 'left').map(view => (
          <div
            key={view.id}
            className={[
              styles['artifacts-tab'],
              view.fixed ? 'artifacts-tab-fixed' : styles['artifacts-tab-instance'],
              view.kind === 'side-task' ? 'artifacts-tab-side' : '',
              view.active ? 'active' : '',
            ].filter(Boolean).join(' ')}
            data-tab-id={view.id}
            data-panel-tab={view.kind}
            role="presentation"
            draggable={!view.fixed}
            onClick={() => { void activateTab(findById(view.id)) }}
            // Middle click closes, matching every tab strip the user already knows.
            onAuxClick={(event) => {
              if (event.button !== 1 || view.fixed) return
              event.preventDefault()
              void closeTab(findById(view.id))
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const tab = findById(view.id)
              if (!tab) return
              setCtxMenu({ x: event.clientX, y: event.clientY, items: buildContextItems(tab) })
            }}
            onDragStart={view.fixed ? undefined : onTabDragStart(view)}
            onDragEnd={view.fixed ? undefined : onTabDragEnd()}
            onDragOver={onTabDragOver(view)}
            onDragLeave={onTabDragLeave()}
            onDrop={onTabDrop(view)}
          >
            <button type="button" className={styles['artifacts-tab-trigger']} role="tab" aria-selected={view.active ? 'true' : 'false'}>
              <SideTabStatus view={view} />
              <span className={styles['artifacts-tab-label']}>{view.title}</span>
              {view.badge ? <span className={styles['artifacts-tab-countdown']}>{view.badge}</span> : null}
            </button>
            {!view.fixed ? (
              <span className={styles['artifacts-tab-actions']}>
                <button
                  type="button"
                  className={styles['artifacts-tab-close']}
                  aria-label={`${tt('artifacts_tab_close')}: ${view.title}`}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void closeTab(findById(view.id))
                  }}
                  dangerouslySetInnerHTML={{ __html: icon('row-close-x') }}
                />
              </span>
            ) : null}
          </div>
        ))}
      </div>
      {/* Overflow affordance: the strip scrolls, and this lists every tab so a
          clipped one is still reachable. */}
      <button
        id="artifacts-tabs-more"
        className={`${styles['artifacts-tab']} ${styles['artifacts-tab-more']}`}
        type="button"
        hidden={!overflowing}
        data-i18n-aria-label="artifacts_tab_more"
        aria-label={tt('artifacts_tab_more')}
        aria-haspopup="menu"
        aria-expanded={moreItems ? 'true' : 'false'}
        ref={moreBtnRef}
        onClick={(event) => {
          event.stopPropagation()
          setMoreItems(moreItems ? null : buildMoreItems())
        }}
      >
        <span className="kls-icon-host" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('panel-tab-more') }} />
      </button>
      <button
        id="artifacts-new-tab"
        className={`${styles['artifacts-tab']} ${styles['artifacts-tab-new']}`}
        type="button"
        data-i18n-aria-label="artifacts_new_tab"
        aria-label={tt('artifacts_new_tab')}
        aria-haspopup="menu"
        aria-expanded={newItems ? 'true' : 'false'}
        onClick={(event) => {
          event.stopPropagation()
          setNewItems(newItems ? null : buildNewItems())
        }}
      >
        <span className="kls-icon-host" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon('panel-tab-new') }} />
      </button>
      <HeaderMenu id="artifacts-tabs-more-menu" labelledBy="artifacts-tabs-more" items={moreItems ? buildMoreItems() : null} menuRef={moreMenuRef} onClose={() => setMoreItems(null)} />
      <HeaderMenu id="artifacts-new-menu" labelledBy="artifacts-new-tab" items={newItems} menuRef={newMenuRef} onClose={() => setNewItems(null)} />
      {ctxMenu ? createPortal(
        <TabContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={() => setCtxMenu(null)} />,
        document.body,
      ) : null}
    </>
  )
}

// ── Boot ──────────────────────────────────────────────────────────────────
ensure('monitor', '')
setActiveId(descriptorId('monitor', ''))

const stripHost = document.getElementById('artifacts-tabs')
if (stripHost) {
  stripHost.replaceChildren()
  createRoot(stripHost).render(<PanelTabsStrip />)
}
const leftStripHost = document.getElementById('left-side-tabs')
if (leftStripHost) {
  createRoot(leftStripHost).render(<LeftSideTabsStrip />)
  const main = document.getElementById('main')
  main?.addEventListener('dragover', event => {
    if (findById(draggingId || '')?.kind === 'side-task' && !artifactsPanel?.contains(event.target as Node)) event.preventDefault()
  })
  main?.addEventListener('drop', event => {
    if (!artifactsPanel?.contains(event.target as Node)) dropSideTask(event, 'left')
  })
}

window.addEventListener('klaus:lang-change', () => {
  activeScope()
  for (const tab of tabs) {
    // Owner-titled kinds keep their own titles (browser page and side-task
    // title); fixed surfaces follow the UI language.
    if (tab.kind !== 'browser' && tab.kind !== 'side-task' && tab.kind !== 'subagent' && tab.kind !== 'background-process' && tab.kind !== 'spec' && tab.kind !== 'canvas' && tab.kind !== 'prototype' && tab.kind !== 'video-editing' && tab.kind !== 'ppt') tab.title = defaultTitle(tab.kind)
  }
  langTick++
  publish()
})
window.addEventListener('klaus:session-change', clearSpecs)
subscribeSubagents(publish)
publish()
if (maximized) applyMaximized()

// Consumed by chat.js (mode + session lifecycle, terminals, browser pages) and
// side-tasks (side-task family, which supplies the `+` menu's side-task
// entry). Nothing else may render into the strip.
;(window as any).KlausPanelTabs = {
  canStep: () => { activeScope(); return tabs.length > 1 },
  step: (delta: number) => {
    activeScope()
    if (tabs.length < 2) return
    const index = tabs.findIndex(tab => tab.id === activeId)
    const tab = tabs[(Math.max(0, index) + delta + tabs.length) % tabs.length]
    if (tab) return activateTab(tab)
  },
  remove,
  render: publish,
  beginSessionSwitch,
  promoteDraftSession,
  saveFor,
  forgetSession,
  syncTerminals,
  syncBrowserTabs,
  syncSideTasks,
  moveSideTask: (id: string, placement: 'left' | 'right') => { const tab = find('side-task', id); if (tab) return moveSideTask(tab, placement) },
  sideTaskQuotePanels,
  openSubagent,
  remapSubagentTasks,
  clearSubagents,
  openBackgroundProcess,
  clearBackgroundProcesses,
  openPlanning,
  openGoal,
  closeGoal,
  openSpec,
  closeSpec,
  clearSpecs,
  openCanvas,
  closeCanvas,
  clearCanvases,
  openPrototype,
  clearPrototypes,
  openVideoEditing,
  clearVideoEditings,
  openPpt,
  clearPresentations,
  onModeChanged,
}
