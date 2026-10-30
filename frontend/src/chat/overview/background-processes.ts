import { tt } from '../../app/i18n'
import { icon } from '../../icons/registry'
import {
  isTerminalBackgroundProcessStatus,
  orderBackgroundProcesses,
  type BackgroundProcess,
  type BackgroundProcessStatus,
} from '../background-process-state'
import { applyDefaultCollapseState, styles } from './shared'
import { createRowViewport, type RowViewport } from './row-viewport'

export interface BackgroundProcessSectionDeps {
  currentSessionId(): string | null
  entries(): BackgroundProcess[]
  onOpen(shellId: string): void
}

let deps: BackgroundProcessSectionDeps | null = null
let viewport: { element: HTMLElement; controller: RowViewport } | null = null
let rowDisposers: Array<() => void> = []
let processClockNow = Date.now()
let processClockTimer: number | null = null
const processClockListeners = new Set<() => void>()

export function initBackgroundProcessSection(injected: BackgroundProcessSectionDeps): void {
  deps = injected
}

export function backgroundProcessClockSnapshot(): number {
  return processClockNow
}

export function subscribeBackgroundProcessClock(listener: () => void): () => void {
  processClockListeners.add(listener)
  if (processClockListeners.size === 1) {
    processClockNow = Date.now()
    processClockTimer = window.setInterval(() => {
      processClockNow = Date.now()
      for (const notify of processClockListeners) notify()
    }, 1000)
  }
  listener()
  return () => {
    processClockListeners.delete(listener)
    if (processClockListeners.size > 0 || processClockTimer === null) return
    window.clearInterval(processClockTimer)
    processClockTimer = null
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

export function backgroundProcessDuration(process: BackgroundProcess, now = Date.now()): string {
  if (typeof process.startedAtMs !== 'number') return ''
  const end = isTerminalBackgroundProcessStatus(process.status)
    ? (process.completedAtMs ?? process.updatedAtMs ?? now)
    : now
  return formatDuration(end - process.startedAtMs)
}

export function backgroundProcessStatusText(process: BackgroundProcess, now = Date.now()): string {
  const label = tt(`background_process_status_${process.status}`)
  const duration = backgroundProcessDuration(process, now)
  return duration ? `${label} · ${duration}` : label
}

export function backgroundProcessDisplayTitle(process: BackgroundProcess): string {
  return (process.title || process.command || process.shellId).trim()
}

function statusIcon(status: BackgroundProcessStatus): string {
  if (status === 'completed') return icon('plan-mark-completed')
  if (status === 'failed' || status === 'stopped') return icon('follow-up-paused')
  if (status === 'paused') return icon('plan-mark-pending')
  return ''
}

function processRow(process: BackgroundProcess): HTMLElement {
  const row = document.createElement('button')
  const title = backgroundProcessDisplayTitle(process)
  row.type = 'button'
  row.className = styles['background-process-row']
  row.dataset.shellId = process.shellId
  row.dataset.status = process.status
  row.innerHTML = `
    <span class="${styles['background-process-icon']}" aria-hidden="true">${icon('tool-bash')}</span>
    <span class="${styles['background-process-title']}"></span>
    <span class="${styles['background-process-status']}" data-status="${process.status}">
      ${process.status === 'running' ? `<span class="${styles['background-process-pulse']}" aria-hidden="true"></span>` : `<span class="${styles['background-process-status-icon']}" aria-hidden="true">${statusIcon(process.status)}</span>`}
      <span data-bgprocess-status-label></span>
    </span>
  `
  const titleEl = row.querySelector<HTMLElement>(`.${styles['background-process-title']}`)
  if (titleEl) titleEl.textContent = title
  // Semantic anchor, not a CSS-module class: the label span carries no style of
  // its own, and a module key with no rule would hash to `undefined` at runtime.
  const statusLabel = row.querySelector<HTMLElement>('[data-bgprocess-status-label]')
  const updateStatus = () => {
    if (statusLabel) statusLabel.textContent = backgroundProcessStatusText(process, backgroundProcessClockSnapshot())
  }
  if (!isTerminalBackgroundProcessStatus(process.status)) rowDisposers.push(subscribeBackgroundProcessClock(updateStatus))
  else updateStatus()
  row.addEventListener('click', () => deps?.onOpen(process.shellId))
  row.setAttribute('aria-label', `${title}, ${backgroundProcessStatusText(process)}`)
  return row
}

function disposeRows(): void {
  for (const dispose of rowDisposers) dispose()
  rowDisposers = []
}

export function renderBackgroundProcessSection(): void {
  const section = document.getElementById('monitor-section-background-processes')
  const body = document.getElementById('monitor-background-processes-body')
  if (!section || !body) return
  disposeRows()
  const entries = orderBackgroundProcesses(deps?.entries() || [])
  section.hidden = false
  if (viewport?.element !== body) {
    viewport?.controller.dispose()
    viewport = { element: body, controller: createRowViewport(body) }
  }
  viewport.controller.render(deps?.currentSessionId() || '', () => {
    if (entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'ctx-empty'
      empty.textContent = tt('overview_background_processes_empty')
      body.replaceChildren(empty)
      return []
    }
    const list = document.createElement('div')
    list.className = styles['background-process-list']
    const rows = entries.map(processRow)
    list.append(...rows)
    body.replaceChildren(list)
    return rows
  })
  applyDefaultCollapseState('monitor-section-background-processes')
}
