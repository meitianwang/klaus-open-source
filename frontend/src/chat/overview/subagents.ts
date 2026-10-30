import { mountChangesEntry } from '../../pages/diff/changes-summary'
import reviewStyles from '../../pages/diff/diff.module.css'
import { tt } from '../../app/i18n'
import { icon } from '../../icons/registry'
import { subagentAvatarHtml } from '../subagent-avatar'
import { subagentDisplayName } from '../subagent-identity'
import type { AgentTask } from '../engine-events'
import { applyDefaultCollapseState, styles } from './shared'
import { createRowViewport, type RowViewport } from './row-viewport'
import {
  mountSubagentRowTitle,
  subagentRowTitleHtml,
  SUBAGENT_ROW_MARQUEE_GROUP_CLASS,
} from './subagent-row-title'

export type SubagentEntry = [string, AgentTask]
export type SubagentDisplayStatus = 'pending' | 'running' | 'paused' | 'completed' | 'budget_limited' | 'failed' | 'stopped'

export interface SubagentSectionDeps {
  currentSessionId(): string | null
  entries(): SubagentEntry[]
  onOpen(taskId: string): void
}

let deps: SubagentSectionDeps | null = null
let viewport: { element: HTMLElement; controller: RowViewport } | null = null
let subagentClockNow = Date.now()
let subagentClockTimer: number | null = null
const subagentClockListeners = new Set<() => void>()

export function subagentClockSnapshot(): number {
  return subagentClockNow
}

export function subscribeSubagentClock(listener: () => void): () => void {
  subagentClockListeners.add(listener)
  if (subagentClockListeners.size === 1) {
    subagentClockNow = Date.now()
    subagentClockTimer = window.setInterval(() => {
      subagentClockNow = Date.now()
      for (const notify of subagentClockListeners) notify()
    }, 1000)
  }
  listener()
  return () => {
    subagentClockListeners.delete(listener)
    if (subagentClockListeners.size > 0 || subagentClockTimer === null) return
    window.clearInterval(subagentClockTimer)
    subagentClockTimer = null
  }
}

export function initSubagentSection(injected: SubagentSectionDeps): void {
  deps = injected
}

export function subagentDisplayStatus(task: AgentTask): SubagentDisplayStatus {
  if (task.status === 'pending' || (task.status === 'running' && task.isIdle)) return 'pending'
  if (task.status === 'running') return 'running'
  if (task.status === 'paused') return 'paused'
  if (task.status === 'failed') return 'failed'
  if (task.status === 'budget_limited') return 'budget_limited'
  if (task.status === 'stopped' || task.status === 'killed' || task.status === 'cancelled') return 'stopped'
  return 'completed'
}

export function isBackgroundSubagent(task: AgentTask): boolean {
  return task.isBackground === true
}

export function isTerminalSubagentStatus(status: SubagentDisplayStatus): boolean {
  return status === 'completed' || status === 'budget_limited' || status === 'failed' || status === 'stopped'
}

export function orderSubagents(entries: SubagentEntry[]): SubagentEntry[] {
  return [...entries].sort(([aId, a], [bId, b]) => {
    const aTerminal = isTerminalSubagentStatus(subagentDisplayStatus(a))
    const bTerminal = isTerminalSubagentStatus(subagentDisplayStatus(b))
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1
    const aStarted = typeof a.startedAtMs === 'number' && Number.isFinite(a.startedAtMs)
      ? a.startedAtMs
      : Number.POSITIVE_INFINITY
    const bStarted = typeof b.startedAtMs === 'number' && Number.isFinite(b.startedAtMs)
      ? b.startedAtMs
      : Number.POSITIVE_INFINITY
    return aStarted - bStarted || aId.localeCompare(bId)
  })
}

export function subagentConversationId(taskId: string, task: AgentTask): string {
  return task.agentId || taskId
}

export { subagentDisplayName }

export function subagentTaskText(task: AgentTask): string {
  const description = typeof task.description === 'string' ? task.description.trim() : ''
  const objective = typeof task.objective === 'string' ? task.objective.trim() : ''
  return description || objective
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function subagentDuration(task: AgentTask, now = Date.now()): string {
  if (typeof task.startedAtMs !== 'number' || !Number.isFinite(task.startedAtMs)) return ''
  const status = subagentDisplayStatus(task)
  const terminalAt = task.completedAtMs ?? task.updatedAtMs
  const end = isTerminalSubagentStatus(status) && typeof terminalAt === 'number' && Number.isFinite(terminalAt)
    ? terminalAt
    : now
  return formatDuration(end - task.startedAtMs)
}

export function subagentStatusText(task: AgentTask, now = Date.now()): string {
  const status = subagentDisplayStatus(task)
  const label = tt(`subagent_status_${status}`)
  const duration = subagentDuration(task, now)
  return duration ? `${label} · ${duration}` : label
}

function statusIcon(status: SubagentDisplayStatus): string {
  if (status === 'completed') return icon('plan-mark-completed')
  if (status === 'budget_limited') return icon('plan-mark-pending')
  if (status === 'running') return icon('plan-mark-in-progress')
  if (status === 'pending' || status === 'paused') return icon('plan-mark-pending')
  return icon('follow-up-paused')
}

// ---- Keyed row reuse ----
//
// The section repaints on every tasks_changed and on every reconcile tick while
// a background run is live. Rebuilding the whole list each time replaced every
// row node, which restarted the running row's spin animation and remounted each
// marquee title root — a visible blink on a fixed cadence. Rows are therefore
// kept alive per task id: a render whose identity fields (avatar, conversation,
// name) are unchanged leaves the row node untouched, status changes patch only
// the status cluster, and order changes move just the rows that are out of
// place. Only a genuinely new or re-identified task builds a fresh row.

interface RowHandle {
  taskId: string
  task: AgentTask
  row: HTMLElement
  group: HTMLElement
  changesDispose: (() => void) | null
  displayKey: string
  status: SubagentDisplayStatus | null
  statusWrap: HTMLElement
  statusIconHost: HTMLElement
  statusLabel: HTMLElement
  clockDispose: (() => void) | null
  titleDispose: (() => void) | null
}

const rowHandles = new Map<string, RowHandle>()
let listEl: HTMLElement | null = null

/** Identity of everything a row shows apart from its live status cluster. */
export function subagentRowDisplayKey(taskId: string, task: AgentTask): string {
  return [
    String(task.avatarId ?? ''),
    subagentConversationId(taskId, task),
    subagentDisplayName(taskId, task),
  ].join('')
}

function paintStatusLabel(handle: RowHandle): void {
  handle.statusLabel.textContent = subagentStatusText(handle.task, subagentClockSnapshot())
}

/** Move a row to a new display status: patch the status cluster in place and
 *  re-arm the per-second clock only when the row crosses into or out of a
 *  terminal state. The row node itself is never replaced, so the running
 *  spin animation keeps running across repaints. */
function setStatus(handle: RowHandle, status: SubagentDisplayStatus): void {
  if (handle.status === status) return
  handle.status = status
  handle.row.dataset.status = status
  handle.statusWrap.dataset.status = status
  handle.statusIconHost.innerHTML = statusIcon(status)
  if (handle.clockDispose) {
    handle.clockDispose()
    handle.clockDispose = null
  }
  if (isTerminalSubagentStatus(status)) paintStatusLabel(handle)
  else handle.clockDispose = subscribeSubagentClock(() => paintStatusLabel(handle))
}

function buildRow(taskId: string, task: AgentTask): RowHandle {
  const status = subagentDisplayStatus(task)
  const conversationId = subagentConversationId(taskId, task)
  const name = subagentDisplayName(taskId, task)
  const row = document.createElement('button')
  row.type = 'button'
  row.className = `${styles['subagent-row']} ${SUBAGENT_ROW_MARQUEE_GROUP_CLASS}`
  row.dataset.taskId = taskId
  row.innerHTML = `
    <span class="${styles['subagent-row-avatar']}">${subagentAvatarHtml(task.avatarId, 20, status, conversationId)}</span>
    ${subagentRowTitleHtml()}
    <span class="${styles['subagent-row-status']}" data-status="${status}">
      <span class="${styles['subagent-row-status-icon']}" aria-hidden="true">${statusIcon(status)}</span>
      <span data-subagent-status-label></span>
    </span>
  `
  const group = document.createElement('div')
  group.className = reviewStyles['changes-agent-group']
  const changesHost = document.createElement('div')
  group.append(row, changesHost)
  const handle: RowHandle = {
    taskId,
    task,
    row,
    group,
    changesDispose: mountChangesEntry(changesHost, conversationId),
    displayKey: subagentRowDisplayKey(taskId, task),
    status: null,
    statusWrap: row.querySelector<HTMLElement>(`.${styles['subagent-row-status']}`) as HTMLElement,
    statusIconHost: row.querySelector<HTMLElement>(`.${styles['subagent-row-status-icon']}`) as HTMLElement,
    // Semantic anchor, not a CSS-module class: the label span carries no style
    // of its own, and a module key with no rule would hash to `undefined`.
    statusLabel: row.querySelector<HTMLElement>('[data-subagent-status-label]') as HTMLElement,
    clockDispose: null,
    titleDispose: null,
  }
  const titleHost = row.querySelector<HTMLElement>(`.${styles['subagent-row-title']}`)
  if (titleHost) handle.titleDispose = mountSubagentRowTitle(titleHost, name)
  row.addEventListener('click', () => deps?.onOpen(taskId))
  row.setAttribute('aria-label', name)
  setStatus(handle, status)
  return handle
}

function disposeHandle(handle: RowHandle): void {
  handle.changesDispose?.()
  handle.changesDispose = null
  handle.clockDispose?.()
  handle.titleDispose?.()
  handle.clockDispose = null
  handle.titleDispose = null
}

let renderedSessionId: string | null = null

export function renderSubagentSection(): void {
  const section = document.getElementById('monitor-section-subagents')
  const body = document.getElementById('monitor-subagents-body')
  if (!section || !body) return

  // The panel follows the open session. Rows of another session must not
  // survive a switch, and their marquee roots and clock subscriptions go with
  // them; the viewport identity below resets the scroll position as before.
  const sessionId = deps?.currentSessionId() || ''
  if (renderedSessionId !== sessionId) {
    renderedSessionId = sessionId
    for (const handle of rowHandles.values()) disposeHandle(handle)
    rowHandles.clear()
    listEl = null
    body.replaceChildren()
  }

  section.hidden = false
  if (viewport?.element !== body) {
    viewport?.controller.dispose()
    viewport = { element: body, controller: createRowViewport(body) }
  }

  const entries = orderSubagents((deps?.entries() || []).filter(([, task]) => isBackgroundSubagent(task)))
  viewport.controller.render(sessionId, () => {
    if (entries.length === 0) {
      for (const handle of rowHandles.values()) disposeHandle(handle)
      rowHandles.clear()
      listEl = null
      const empty = document.createElement('div')
      empty.className = 'ctx-empty'
      empty.textContent = tt('overview_subagents_empty')
      body.replaceChildren(empty)
      return []
    }

    const nextKeys = new Map<string, string>()
    for (const [taskId, task] of entries) nextKeys.set(taskId, subagentRowDisplayKey(taskId, task))

    // Retire rows that left the list or whose identity changed; a rebuilt row
    // is the only case that may restart its animation.
    for (const [taskId, handle] of [...rowHandles]) {
      if (nextKeys.get(taskId) !== handle.displayKey) {
        disposeHandle(handle)
        rowHandles.delete(taskId)
        handle.group.remove()
      }
    }

    const rows: HTMLElement[] = []
    for (const [taskId, task] of entries) {
      let handle = rowHandles.get(taskId)
      if (!handle) {
        handle = buildRow(taskId, task)
        rowHandles.set(taskId, handle)
      } else {
        handle.task = task
        setStatus(handle, subagentDisplayStatus(task))
      }
      rows.push(handle.group)
    }

    if (!listEl || listEl.parentElement !== body) {
      listEl = document.createElement('div')
      listEl.className = styles['subagent-list']
      body.replaceChildren(listEl)
    }
    // Walk the expected order and move only rows that are out of place; an
    // unchanged order leaves every node where it is.
    let cursor = listEl.firstElementChild as HTMLElement | null
    for (const row of rows) {
      if (cursor === row) {
        cursor = row.nextElementSibling as HTMLElement | null
        continue
      }
      listEl.insertBefore(row, cursor)
    }
    while (cursor) {
      const next = cursor.nextElementSibling as HTMLElement | null
      cursor.remove()
      cursor = next
    }
    return rows
  })
  applyDefaultCollapseState('monitor-section-subagents')
}
