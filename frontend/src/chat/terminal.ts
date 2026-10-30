// Terminal 面板域（自 chat.ts 拆出，逻辑原样，strict 类型化）。
//
// xterm 懒加载 + 每会话终端组（terminalGroups）+ 面板开合编排 + pty 事件桥。
// sessions / artifacts 域仍在 chat.ts，经 initTerminal(deps) 注入；那两域
// 拆出后改为直接 import。window 桥（klausShowTerminalPanel 等）供
// panel-tabs 组件消费，在本模块装配。
import type { Terminal } from '@xterm/xterm'
import { tt } from '../app/i18n'
import { icon as klausIcon } from '../icons/registry'
import styles from './terminal.module.css'

// ---- window.klaus 最小面（bridge 无导出类型，结构化声明本域用到的通道） ----
interface TerminalResult { ok?: boolean; error?: string }
interface TerminalStartResult extends TerminalResult { cwd?: string; shell?: string }
interface KlausTerminalApi {
  terminal?: {
    start?: (opts: { id: string; cwd: string | null; cols: number; rows: number }) => Promise<TerminalStartResult>
    write?: (id: string, data: string) => Promise<TerminalResult>
    resize?: (id: string, cols: number, rows: number) => Promise<TerminalResult>
    kill?: (id: string) => Promise<TerminalResult>
  }
  session?: {
    getResolvedWorkdir?: (sessionId: string) => Promise<{ workdir?: string | null } | null>
  }
  on: {
    terminalData?: (cb: (payload: { id: string; data: string }) => void | Promise<void>) => unknown
    terminalExit?: (cb: (payload: { id: string; exitCode?: number; signal?: number }) => void) => unknown
  }
}
const klausApi = (window as unknown as { klaus: KlausTerminalApi }).klaus

interface KlausDialog { alert: (msg: string) => Promise<void> }
const klausDialog = () => (window as unknown as { klausDialog: KlausDialog }).klausDialog
const showToast = (message: string) => (window as unknown as { showToast?: (value: string) => void }).showToast?.(message)

// ---- 跨域依赖注入（sessions / artifacts / 视图编排仍在 chat.ts） ----
export interface TerminalDeps {
  ensureSession(): Promise<string | null | undefined>
  sessionWorkdir(sessionId: string): string | null
  normalizeProjectWorkdir(workdir: unknown): string | null
  currentSessionId(): string | null
  openArtifactsPanel(mode: string): void
  closeArtifactsPanel(): void
  /** settings 视图开着时先关掉（openTerminalPanelMode 前置）。 */
  closeSettingsIfActive(): void
  hideWorkspaceMainView(): void
  hideBtwPanel(): void
  setCurrentNonChatView(view: null): void
  syncTopModeButtons(): void
  renderSessionList(): void
  artifactsPanel(): HTMLElement | null
}
let deps!: TerminalDeps

// ---- DOM refs（index.html 静态骨架） ----
const terminalToggleBtn = document.getElementById('terminal-toggle')
const terminalPanel = document.getElementById('terminal-panel')
const terminalContainer = document.getElementById('terminal-container')
const terminalListCount = document.getElementById('terminal-list-count')
const terminalListBody = document.getElementById('terminal-list-body')
const terminalListNewBtn = document.getElementById('terminal-list-new')

// ---- 状态 ----
interface TerminalSessionView {
  id: string
  ownerSessionId: string
  term: Terminal
  element: HTMLElement
  dataDisposable: { dispose(): void } | null
  cwd: string | null
  shell: string | null
  title: string
  state: 'starting' | 'running' | 'exited'
  transportFailures: Set<string>
}
interface TerminalGroup {
  sessionId: string
  sessions: Map<string, TerminalSessionView>
  activeId: string | null
  open: boolean
}
const terminalSessions = new Map<string, TerminalSessionView>()
const terminalGroups = new Map<string, TerminalGroup>()
let terminalResizeTimer: ReturnType<typeof setTimeout> | null = null
let terminalCachedCell: { width: number; height: number } | null = null

function terminalGroupKey(sessionId: string | null = deps.currentSessionId()): string | null {
  return typeof sessionId === 'string' && sessionId ? sessionId : null
}

function terminalGroupFor(sessionId: string | null = deps.currentSessionId(), create = false): TerminalGroup | null {
  const key = terminalGroupKey(sessionId)
  if (!key) return null
  let group = terminalGroups.get(key)
  if (!group && create) {
    group = { sessionId: key, sessions: new Map(), activeId: null, open: false }
    terminalGroups.set(key, group)
  }
  return group || null
}

function currentTerminalGroup(create = false): TerminalGroup | null {
  return terminalGroupFor(deps.currentSessionId(), create)
}

async function ensureTerminalOwnerSession(): Promise<string | null> {
  const current = deps.currentSessionId()
  if (current) return current
  return (await deps.ensureSession()) || null
}

async function terminalInitialCwd(sessionId: string): Promise<string | null> {
  const listed = deps.sessionWorkdir(sessionId)
  if (listed) return listed
  const resolved = await klausApi.session?.getResolvedWorkdir?.(sessionId).catch((err: unknown) => {
    console.warn('[terminal] resolve workdir failed:', err)
    return null
  })
  return deps.normalizeProjectWorkdir(resolved?.workdir)
}

function terminalShortPath(cwd: string | null | undefined): string {
  const homePrefix = '/Users/'
  if (typeof cwd !== 'string' || !cwd) return tt('terminal_title')
  if (cwd.startsWith(homePrefix)) {
    const parts = cwd.split('/').filter(Boolean)
    if (parts.length >= 2) {
      const rest = parts.slice(2).join('/')
      return rest ? `~/${rest}` : '~'
    }
  }
  return cwd
}

function terminalCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function terminalTheme() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  return {
    background: terminalCssVar('--terminal-background', terminalCssVar('--bg', dark ? '#181818' : '#ffffff')),
    foreground: terminalCssVar('--terminal-foreground', terminalCssVar('--fg', dark ? '#ffffff' : '#1a1c1f')),
    cursor: terminalCssVar('--terminal-cursor', terminalCssVar('--fg', dark ? '#ffffff' : '#1a1c1f')),
    cursorAccent: terminalCssVar('--terminal-cursor-accent', terminalCssVar('--bg', dark ? '#181818' : '#ffffff')),
    selectionBackground: terminalCssVar('--terminal-selection', dark ? 'rgba(255,255,255,0.18)' : 'rgba(26,28,31,0.14)'),
    black: terminalCssVar('--terminal-ansi-black', dark ? '#0d0d0d' : '#1a1c1f'),
    red: terminalCssVar('--terminal-ansi-red', '#e02e2a'),
    green: terminalCssVar('--terminal-ansi-green', '#00a240'),
    yellow: terminalCssVar('--terminal-ansi-yellow', '#d18d00'),
    blue: terminalCssVar('--terminal-ansi-blue', '#0077c8'),
    magenta: terminalCssVar('--terminal-ansi-magenta', '#7c3aed'),
    cyan: terminalCssVar('--terminal-ansi-cyan', '#007f8c'),
    white: terminalCssVar('--terminal-ansi-white', dark ? '#d4d4d4' : '#5c5f66'),
    brightBlack: terminalCssVar('--terminal-ansi-bright-black', dark ? '#777777' : '#8a8d94'),
    brightRed: terminalCssVar('--terminal-ansi-bright-red', '#ff6764'),
    brightGreen: terminalCssVar('--terminal-ansi-bright-green', '#15b864'),
    brightYellow: terminalCssVar('--terminal-ansi-bright-yellow', '#f0b429'),
    brightBlue: terminalCssVar('--terminal-ansi-bright-blue', '#339cff'),
    brightMagenta: terminalCssVar('--terminal-ansi-bright-magenta', '#a06bff'),
    brightCyan: terminalCssVar('--terminal-ansi-bright-cyan', '#2aa7b8'),
    brightWhite: terminalCssVar('--terminal-ansi-bright-white', dark ? '#ffffff' : '#1a1c1f'),
  }
}

function activeTerminalSession(): TerminalSessionView | null {
  const group = currentTerminalGroup(false)
  return group?.activeId ? group.sessions.get(group.activeId) || null : null
}

function terminalSessionTitle(session: TerminalSessionView | null | undefined): string {
  return session?.title || terminalShortPath(session?.cwd) || tt('terminal_title')
}

function updateTerminalPanelState(): void {
  terminalPanel?.setAttribute('data-terminal-state', activeTerminalSession()?.state || 'idle')
}

function showCurrentTerminalElements(): void {
  const group = currentTerminalGroup(false)
  const activeId = group?.activeId || null
  const activeOwner = group?.sessionId || null
  for (const session of terminalSessions.values()) {
    session.element.hidden = session.ownerSessionId !== activeOwner || session.id !== activeId
  }
}

// Every pty of this conversation is a row in the terminal surface's own side
// list; the panel strip carries a single Terminal tab for the surface as a
// whole. Shells are near-identical, so one outer tab each said nothing while
// crowding out Monitor / Files.
function terminalRowLabel(session: TerminalSessionView): string {
  const shell = typeof session.shell === 'string' ? session.shell.split('/').filter(Boolean).pop() : ''
  return shell || tt('terminal_title')
}

function buildTerminalRow(session: TerminalSessionView, active: boolean): HTMLElement {
  const label = terminalRowLabel(session)
  const row = document.createElement('div')
  row.className = styles['terminal-row']
  row.dataset.terminalId = session.id
  row.dataset.state = session.state
  row.setAttribute('role', 'tab')
  row.tabIndex = 0
  row.classList.toggle('active', active)
  row.setAttribute('aria-selected', active ? 'true' : 'false')
  // The row shows the shell; expose the working directory to assistive
  // technology without adding hover noise to the panel.
  row.setAttribute('aria-label', terminalSessionTitle(session))

  const labelEl = document.createElement('span')
  labelEl.className = styles['terminal-row-label']
  labelEl.textContent = label
  row.appendChild(labelEl)

  const actions = document.createElement('span')
  actions.className = styles['terminal-row-actions']
  const close = document.createElement('button')
  close.type = 'button'
  close.className = styles['terminal-row-close']
  close.setAttribute('aria-label', `${tt('terminal_close')}: ${label}`)
  close.innerHTML = klausIcon('row-close-x')
  close.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void closeTerminalSession(session.id)
  })
  actions.appendChild(close)
  row.appendChild(actions)

  row.addEventListener('click', () => activateTerminalSession(session.id))
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    activateTerminalSession(session.id)
  })
  return row
}

export function renderTerminalList(): void {
  const group = currentTerminalGroup(false)
  const sessions = [...(group?.sessions.values() || [])]
  if (terminalListCount) {
    terminalListCount.textContent = tt('terminal_count').replace('{count}', String(sessions.length))
  }
  terminalListBody?.replaceChildren(
    ...sessions.map(session => buildTerminalRow(session, session.id === group?.activeId)),
  )
  const panelTabs = (window as unknown as { KlausPanelTabs?: { syncTerminals?: (count: number) => void } }).KlausPanelTabs
  panelTabs?.syncTerminals?.(sessions.length)
  updateTerminalPanelState()
}

// ==================== xterm 懒加载 ====================
// xterm.js（~480KB）从启动脚本链移除：终端面板默认关闭，首帧解析它纯属浪费。
// 首次打开终端时注入；启动后空闲预热（requestIdleCallback）把解析挪到闲时，
// 首次打开终端通常不用等。单例 Promise 幂等；失败置空允许下次重试。
type TerminalCtor = typeof Terminal
let xtermCtor: TerminalCtor | null = null
let xtermLoadPromise: Promise<void> | null = null
function ensureXtermLoaded(): Promise<void> {
  if (xtermCtor) return Promise.resolve()
  if (xtermLoadPromise) return xtermLoadPromise
  // @xterm/xterm 走动态 import：Vite 自动切成独立 chunk，语义与旧 script 注入一致
  //（不进启动包、按需拉取）；xterm.css 也随这个 chunk 进来。失败置空允许下次重试。
  xtermLoadPromise = Promise.all([import('@xterm/xterm'), import('@xterm/xterm/css/xterm.css')])
    .then(([mod]) => { xtermCtor = mod.Terminal })
    .catch((err: unknown) => {
      xtermLoadPromise = null
      throw new Error('failed to load xterm.js: ' + ((err as Error | null)?.message || err))
    })
  return xtermLoadPromise
}

function createTerminalSessionView(id: string, ownerSessionId: string, dims: { cols: number; rows: number }): TerminalSessionView | null {
  if (!terminalContainer || !xtermCtor) return null
  const element = document.createElement('div')
  element.className = styles['terminal-view']
  element.hidden = true
  terminalContainer.appendChild(element)
  const term = new xtermCtor({
    allowTransparency: true,
    // Born at the size the pty is told. xterm's own default is 80x24, and a
    // shell that prints its prompt into a wider pty than the screen it lands on
    // wraps that first line — zsh's end-of-line mark then survives as a stray
    // reverse `%` above the prompt.
    cols: dims.cols,
    rows: dims.rows,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    letterSpacing: 0,
    lineHeight: 1.45,
    macOptionIsMeta: true,
    scrollback: 10000,
    theme: terminalTheme(),
  })
  term.open(element)
  const dataDisposable = term.onData((data: string) => {
    const session = terminalSessions.get(id)
    if (!session || session.state === 'exited') return
    void writeTerminalInput(session, data)
  })
  term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f') return false
    return true
  })
  return {
    id,
    ownerSessionId,
    term,
    element,
    dataDisposable,
    cwd: null,
    shell: null,
    title: tt('terminal_starting'),
    state: 'starting',
    transportFailures: new Set(),
  }
}

function terminalFailureText(key: 'write' | 'resize' | 'kill', error?: unknown): string {
  const fallback = tt(key === 'write'
    ? 'terminal_write_failed'
    : key === 'resize'
      ? 'terminal_resize_failed'
      : 'terminal_close_failed')
  const detail = error && typeof error === 'object' && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : typeof error === 'string'
      ? error
      : ''
  return detail ? `${fallback}: ${detail}` : fallback
}

function reportTerminalTransportFailure(session: TerminalSessionView, key: 'write' | 'resize', error?: unknown): void {
  if (session.transportFailures.has(key)) return
  session.transportFailures.add(key)
  session.term.writeln(`\r\n[${terminalFailureText(key, error)}]`)
  if (key === 'write') {
    session.state = 'exited'
      session['title'] = tt('terminal_exited')
    if (session.ownerSessionId === terminalGroupKey()) renderTerminalList()
  }
}

async function writeTerminalInput(session: TerminalSessionView, data: string): Promise<void> {
  try {
    const result = await klausApi.terminal?.write?.(session.id, data)
    if (result?.ok === false) reportTerminalTransportFailure(session, 'write', result.error)
  } catch (error) {
    reportTerminalTransportFailure(session, 'write', error)
  }
}

async function resizeTerminalHost(session: TerminalSessionView, cols: number, rows: number): Promise<void> {
  try {
    const result = await klausApi.terminal?.resize?.(session.id, cols, rows)
    if (result?.ok === false) reportTerminalTransportFailure(session, 'resize', result.error)
  } catch (error) {
    reportTerminalTransportFailure(session, 'resize', error)
  }
}

function terminalMeasureCell(): { width: number; height: number } {
  if (terminalCachedCell) return terminalCachedCell
  const probe = document.createElement('span')
  probe.textContent = 'W'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, monospace'
  probe.style.fontSize = '13px'
  probe.style.lineHeight = '18.85px'
  document.body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  terminalCachedCell = {
    width: Math.max(7, rect.width || 8),
    height: 18.85,
  }
  return terminalCachedCell
}

function terminalDimensions(): { cols: number; rows: number } {
  const rect = terminalContainer?.getBoundingClientRect()
  const style = terminalContainer ? getComputedStyle(terminalContainer) : null
  const paddingX = style ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) : 0
  const paddingY = style ? (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) : 0
  const cell = terminalMeasureCell()
  const width = Math.max(160, (rect?.width || 720) - paddingX)
  const height = Math.max(80, (rect?.height || 160) - paddingY)
  return {
    cols: Math.max(20, Math.floor((width - 4) / cell.width)),
    rows: Math.max(4, Math.floor(height / cell.height)),
  }
}

function resizeTerminalNow(): void {
  const group = currentTerminalGroup(false)
  if (!group || group.sessions.size === 0 || terminalPanel?.hidden) return
  const { cols, rows } = terminalDimensions()
  for (const session of group.sessions.values()) {
    if (session.term.cols !== cols || session.term.rows !== rows) {
      session.term.resize(cols, rows)
    }
    if (session.state !== 'exited') void resizeTerminalHost(session, cols, rows)
  }
}

export function scheduleTerminalResize(): void {
  if (terminalResizeTimer) clearTimeout(terminalResizeTimer)
  terminalResizeTimer = setTimeout(() => {
    terminalResizeTimer = null
    resizeTerminalNow()
  }, 80)
}

// A box that is still moving cannot be measured. Opening the panel animates its
// width (.2s), so a size taken in the same tick describes a panel that is still
// 0px wide and terminalDimensions() answers with its floor clamps — a 20-column
// screen for a panel that is about to be 33 wide.
//
// The panel's own width transition is the signal, read through getAnimations():
// waiting for the measurement to "stop changing" across a few frames looks
// equivalent and is not, because it resolves mid-animation on any machine where
// frames are cheaper than the .2s it is trying to outlast.
function waitTerminalSurfaceSized(): Promise<unknown> {
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
  // One frame first: the transition is created by the style recalc that follows
  // the class change, so asking before it exists finds nothing to wait for.
  return frame()
    .then(() => Promise.all((deps.artifactsPanel()?.getAnimations?.() || [])
      .filter((animation): animation is CSSTransition => (animation as CSSTransition).transitionProperty === 'width')
      .map(animation => animation.finished.catch(() => {}))))
    .then(frame)
}

function applyTerminalPanelOpen(open: boolean): void {
  if (!terminalPanel) return
  // The terminal now lives inside the right panel (data-mode="terminal"):
  // it is only truly visible when the panel is expanded in terminal mode;
  // group.open only describes the session group itself. Switching to other
  // modes keeps xterm instances alive — they are merely hidden.
  const panel = deps.artifactsPanel()
  const panelShowsTerminal = !!panel
    && !panel.classList.contains('collapsed')
    && panel.getAttribute('data-mode') === 'terminal'
  const effective = !!open && panelShowsTerminal
  const wasHidden = terminalPanel.hidden
  terminalPanel.hidden = !effective
  terminalToggleBtn?.classList.toggle('active', panelShowsTerminal)
  terminalToggleBtn?.setAttribute('aria-expanded', panelShowsTerminal ? 'true' : 'false')
  if (effective && wasHidden) requestAnimationFrame(() => {
    resizeTerminalNow()
    activeTerminalSession()?.term.focus()
  })
}

export function setTerminalOpen(open: boolean): void {
  const group = currentTerminalGroup(open)
  if (!group) {
    showCurrentTerminalElements()
    renderTerminalList()
    applyTerminalPanelOpen(false)
    return
  }
  group.open = open
  if (open && !group.activeId && group.sessions.size > 0) {
    group.activeId = group.sessions.keys().next().value || null
  }
  showCurrentTerminalElements()
  renderTerminalList()
  applyTerminalPanelOpen(open && group.sessions.size > 0)
}

export function syncTerminalPanelForCurrentSession(): void {
  const group = currentTerminalGroup(false)
  if (group?.activeId && !group.sessions.has(group.activeId)) {
    group.activeId = group.sessions.keys().next().value || null
  }
  if (group && !group.activeId && group.sessions.size > 0) {
    group.activeId = group.sessions.keys().next().value || null
  }
  showCurrentTerminalElements()
  renderTerminalList()
  applyTerminalPanelOpen(!!(group?.open && group.sessions.size > 0))
}

function newTerminalId(): string {
  return `klaus-terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function activateTerminalSession(id: string): void {
  const session = terminalSessions.get(id)
  if (!session) return
  const group = terminalGroups.get(session.ownerSessionId)
  if (!group || !group.sessions.has(id)) return
  group.activeId = id
  group.open = true
  if (session.ownerSessionId === terminalGroupKey()) {
    showCurrentTerminalElements()
    renderTerminalList()
    applyTerminalPanelOpen(true)
  }
}

async function closeTerminalSession(id: string): Promise<void> {
  const session = terminalSessions.get(id)
  if (!session) return
  if (session.state !== 'exited') {
    try {
      const result = await klausApi.terminal?.kill?.(id)
      if (result?.ok === false) throw new Error(result.error || tt('terminal_close_failed'))
    } catch (error) {
      showToast(terminalFailureText('kill', error))
      return
    }
  } else {
    void klausApi.terminal?.kill?.(id).catch(() => {})
  }
  const group = terminalGroups.get(session.ownerSessionId)
  const ids = [...(group?.sessions.keys() || [])]
  const index = ids.indexOf(id)
  terminalSessions.delete(id)
  group?.sessions.delete(id)
  session.dataDisposable?.dispose?.()
  session.term.dispose()
  session.element.remove()

  if (group?.activeId === id) {
    const nextId = ids[index + 1] || ids[index - 1] || null
    group.activeId = nextId && group.sessions.has(nextId) ? nextId : null
  }
  if (group && group.sessions.size === 0) {
    group.activeId = null
    group.open = false
    terminalGroups.delete(group.sessionId)
  }
  if (session.ownerSessionId === terminalGroupKey()) {
    syncTerminalPanelForCurrentSession()
  }
}

export function forgetTerminalGroup(sessionId: string | null): void {
  if (!sessionId) return
  const group = terminalGroups.get(sessionId)
  if (!group) return
  for (const id of [...group.sessions.keys()]) {
    const session = terminalSessions.get(id)
    terminalSessions.delete(id)
    if (!session) continue
    session.dataDisposable?.dispose?.()
    session.term.dispose()
    session.element.remove()
    klausApi.terminal?.kill?.(id).catch(() => {})
  }
  terminalGroups.delete(sessionId)
  if (sessionId === terminalGroupKey()) syncTerminalPanelForCurrentSession()
}

async function startTerminalSession(): Promise<void> {
  if (!terminalPanel) return
  // xterm 懒加载：首次打开终端时才注入（通常已被空闲预热命中，等于立即就绪）。
  // 加载失败不在这里弹错——下面既有的构造器守卫会走 terminal_unavailable
  // 提示，与过去 vendor 脚本缺失时的行为完全一致。
  await ensureXtermLoaded().catch(() => {})
  if (!terminalContainer || !xtermCtor) {
    await klausDialog().alert(tt('terminal_unavailable'))
    return
  }
  const ownerSessionId = await ensureTerminalOwnerSession()
  if (!ownerSessionId || ownerSessionId !== deps.currentSessionId()) return
  const group = terminalGroupFor(ownerSessionId, true)
  if (!group) return
  group.open = true
  // One measurement, handed to both sides: the surface is shown first so the
  // container has a real box (a hidden one measures zero and terminalDimensions
  // falls back to a guess), then the SAME cols/rows go to xterm's constructor
  // and to the pty. The shell prints its prompt the instant it starts, so any
  // disagreement between the two is visible in that very first line.
  applyTerminalPanelOpen(true)
  await waitTerminalSurfaceSized()
  const dims = terminalDimensions()
  const id = newTerminalId()
  const session = createTerminalSessionView(id, ownerSessionId, dims)
  if (!session) return
  group.sessions.set(id, session)
  terminalSessions.set(id, session)
  activateTerminalSession(id)

  const cwd = await terminalInitialCwd(ownerSessionId)
  const result = await klausApi.terminal?.start?.({ id, cwd, cols: dims.cols, rows: dims.rows }).catch((err: unknown): TerminalStartResult => ({ ok: false, error: String(err) }))
  const current = terminalSessions.get(id)
  if (!current) return
  if (!result?.ok) {
    current.state = 'exited'
    current.title = tt('terminal_exited')
    current.term.writeln(`\r\n${tt('terminal_start_failed')}: ${result?.error || tt('error')}\r\n`)
    renderTerminalList()
    return
  }
  current.state = 'running'
  current.cwd = result.cwd || null
  current.shell = result.shell || null
  current.title = terminalShortPath(result.cwd)
  renderTerminalList()
  resizeTerminalNow()
  current.term.focus()
}

// Terminal-as-panel-mode open/close orchestration: shared by the side-rail
// button and the panel header tab.
export function isTerminalPanelModeOpen(): boolean {
  const panel = deps.artifactsPanel()
  return !!panel
    && !panel.classList.contains('collapsed')
    && panel.getAttribute('data-mode') === 'terminal'
}

export function openTerminalPanelMode(): void {
  deps.closeSettingsIfActive()
  deps.hideWorkspaceMainView()
  deps.hideBtwPanel()
  deps.setCurrentNonChatView(null)
  deps.openArtifactsPanel('terminal')
  const group = currentTerminalGroup(false)
  if (!group || group.sessions.size === 0) void startTerminalSession()
  else setTerminalOpen(true)
  deps.syncTopModeButtons()
  deps.renderSessionList()
}

function syncTerminalThemeTokens(): void {
  terminalCachedCell = null
  for (const session of terminalSessions.values()) session.term.options.theme = terminalTheme()
  scheduleTerminalResize()
}

export function initTerminal(injected: TerminalDeps): void {
  deps = injected

  // 启动后空闲预热：不挣首帧，也不让首次打开终端等加载。失败静默——
  // 真正打开终端时 startTerminalSession 会重试并走既有的不可用提示。
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
    || ((cb: () => void) => setTimeout(cb, 3000))
  idle(() => { void ensureXtermLoaded().catch(() => {}) })

  terminalToggleBtn?.addEventListener('click', () => {
    if (isTerminalPanelModeOpen()) deps.closeArtifactsPanel()
    else openTerminalPanelMode()
  })
  // Panel-strip hooks: the Terminal tab shows the surface, its × tears the whole
  // surface down (its shells are only reachable from here), and the `+` menu
  // always spins up another shell. Which shell is active is the inner list's
  // business, so the strip never names one.
  const w = window as unknown as Record<string, unknown>
  w.klausShowTerminalPanel = () => {
    deps.openArtifactsPanel('terminal')
    setTerminalOpen(true)
  }
  w.klausCloseTerminalPanel = () => forgetTerminalGroup(terminalGroupKey())
  w.klausNewTerminal = () => {
    deps.closeSettingsIfActive()
    deps.hideWorkspaceMainView()
    deps.hideBtwPanel()
    deps.setCurrentNonChatView(null)
    deps.openArtifactsPanel('terminal')
    return startTerminalSession()
  }
  terminalListNewBtn?.addEventListener('click', () => { void startTerminalSession() })
  window.addEventListener('resize', scheduleTerminalResize)
  new ResizeObserver(scheduleTerminalResize).observe(document.getElementById('main') || document.body)
  const panel = deps.artifactsPanel()
  if (panel) new ResizeObserver(scheduleTerminalResize).observe(panel)
  new MutationObserver(syncTerminalThemeTokens).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  window.addEventListener('klaus:theme-change', syncTerminalThemeTokens)
  klausApi.on.terminalData?.(({ id, data }) => {
    const session = terminalSessions.get(id)
    if (!session || typeof data !== 'string') return
    return new Promise<void>(resolve => session.term.write(data, resolve))
  })
  klausApi.on.terminalExit?.(({ id, exitCode, signal }) => {
    const session = terminalSessions.get(id)
    if (!session) return
    session.state = 'exited'
    const reason = signal ? `${tt('terminal_signal')} ${signal}` : `${tt('terminal_exit_code')} ${exitCode ?? 0}`
    session.term.writeln(`\r\n[${tt('terminal_exited')}: ${reason}]`)
    if (session.ownerSessionId === terminalGroupKey()) renderTerminalList()
  })
}
