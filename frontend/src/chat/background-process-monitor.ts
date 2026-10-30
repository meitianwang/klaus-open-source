import { tt } from '../app/i18n'
import {
  applyBackgroundProcessOutput,
  createBackgroundProcessWorkspaceController,
  emptyBackgroundProcessOutput,
  isActiveBackgroundProcess,
  isTerminalBackgroundProcessStatus,
  mergeBackgroundProcessEvent,
  normalizeBackgroundProcessSnapshot,
  type BackgroundProcess,
  type BackgroundProcessChangedPayload,
  type BackgroundProcessOutputState,
} from './background-process-state'
import {
  backgroundProcessClockSnapshot,
  backgroundProcessDisplayTitle,
  backgroundProcessStatusText,
  initBackgroundProcessSection,
  renderBackgroundProcessSection,
  subscribeBackgroundProcessClock,
} from './overview/background-processes'
import { createBackgroundLifecyclePoller } from './background-lifecycle-poll'

export interface BackgroundProcessMonitorDeps {
  api: any
  currentSessionId(): string | null
  switchSession(sessionId: string): Promise<void>
  openPanel(mode: string): void
}

const outputKey = (sessionId: string, shellId: string) => `${sessionId}\u0000${shellId}`

export function initBackgroundProcessMonitor(deps: BackgroundProcessMonitorDeps) {
  const processesBySession = new Map<string, BackgroundProcess[]>()
  const outputs = new Map<string, BackgroundProcessOutputState>()
  const refreshVersions = new Map<string, number>()
  let activeSessionId: string | null = null
  let activeShellId: string | null = null
  let detailClockDispose: (() => void) | null = null

  const processes = (sessionId: string | null) => sessionId ? processesBySession.get(sessionId) || [] : []
  const findProcess = (sessionId: string, shellId: string) => processes(sessionId).find(process => process.shellId === shellId) || null
  const lifecyclePoller = createBackgroundLifecyclePoller(sessionId => refreshSession(sessionId))
  const syncWorking = (sessionId: string) => {
    const working = processes(sessionId).some(isActiveBackgroundProcess)
    lifecyclePoller.update(sessionId, working)
    return working
  }

  const renderCurrent = (sessionId: string) => {
    if (sessionId !== deps.currentSessionId()) return
    renderBackgroundProcessSection()
    if (activeSessionId === sessionId && activeShellId) paintDetail()
  }

  const controller = createBackgroundProcessWorkspaceController({
    readOutput: (sessionId, shellId, afterOffset) =>
      deps.api.session.backgroundProcessOutput(sessionId, shellId, { afterOffset, maxBytes: 256 * 1024 }),
    stop: (sessionId, shellId) => deps.api.session.stopBackgroundProcess(sessionId, shellId),
    changed(snapshot) {
      if (snapshot.sessionId && snapshot.shellId) outputs.set(outputKey(snapshot.sessionId, snapshot.shellId), snapshot.output)
      paintDetail()
    },
  })

  function paintDetail() {
    const commandEl = document.getElementById('background-process-panel-command')
    const statusEl = document.getElementById('background-process-panel-status')
    const pidRow = document.getElementById('background-process-panel-pid-row')
    const pidEl = document.getElementById('background-process-panel-pid')
    const cwdEl = document.getElementById('background-process-panel-cwd')
    const outputEl = document.getElementById('background-process-panel-output')
    const stopButton = document.getElementById('background-process-panel-stop') as HTMLButtonElement | null
    const errorEl = document.getElementById('background-process-panel-error')
    if (!activeSessionId || !activeShellId) return
    const process = findProcess(activeSessionId, activeShellId)
    const workspace = controller.snapshot()
    if (commandEl) commandEl.textContent = process ? backgroundProcessDisplayTitle(process) : activeShellId
    if (statusEl) statusEl.textContent = process ? backgroundProcessStatusText(process, backgroundProcessClockSnapshot()) : ''
    if (pidRow) pidRow.hidden = typeof process?.pid !== 'number'
    if (pidEl) pidEl.textContent = typeof process?.pid === 'number' ? String(process.pid) : ''
    if (cwdEl) cwdEl.textContent = process?.cwd || ''
    if (outputEl) {
      const atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 40
      if (outputEl.textContent !== workspace.output.text) outputEl.textContent = workspace.output.text
      if (atBottom) outputEl.scrollTop = outputEl.scrollHeight
    }
    const terminal = !process || isTerminalBackgroundProcessStatus(process.status)
    if (stopButton) {
      stopButton.hidden = terminal
      stopButton.disabled = terminal || workspace.stopping
      stopButton.textContent = tt(workspace.stopping ? 'background_process_stopping' : 'background_process_stop')
    }
    if (errorEl) {
      errorEl.hidden = !workspace.error
      errorEl.textContent = workspace.error
    }
    if (process && terminal) controller.terminal()
  }

  async function refreshSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false
    const version = (refreshVersions.get(sessionId) || 0) + 1
    refreshVersions.set(sessionId, version)
    try {
      const reply = await deps.api.session.backgroundProcesses(sessionId)
      if (refreshVersions.get(sessionId) !== version) return processes(sessionId).some(isActiveBackgroundProcess)
      const snapshot = normalizeBackgroundProcessSnapshot(reply)
      processesBySession.set(sessionId, snapshot)
      syncWorking(sessionId)
      renderCurrent(sessionId)
      if (activeSessionId === sessionId && activeShellId) void controller.refreshOutput()
      return snapshot.some(isActiveBackgroundProcess)
    } catch (error) {
      console.warn('[background-process] snapshot failed:', error)
      return processes(sessionId).some(isActiveBackgroundProcess)
    }
  }

  function applyChanged(payload: BackgroundProcessChangedPayload) {
    const sessionId = payload?.sessionId || ''
    if (!sessionId) return
    const current = processes(sessionId)
    const next = mergeBackgroundProcessEvent(current, payload.event)
    processesBySession.set(sessionId, next)
    const subtype = payload.event?.subtype || payload.event?.type || ''
    const shellId = payload.event?.shellId || (payload.event?.process as any)?.shellId || ''
    if (shellId && typeof payload.event?.output === 'string') {
      const key = outputKey(sessionId, shellId)
      const chunk = {
        found: true,
        output: payload.event.output,
        afterOffset: payload.event.afterOffset,
        nextOffset: payload.event.nextOffset,
        droppedBytes: payload.event.droppedBytes,
        eof: false,
      }
      outputs.set(key, applyBackgroundProcessOutput(outputs.get(key) || emptyBackgroundProcessOutput(payload.event.afterOffset || 0), chunk))
      if (activeSessionId === sessionId && activeShellId === shellId) controller.applyOutput(chunk)
    }
    syncWorking(sessionId)
    if (activeSessionId === sessionId && activeShellId) {
      const active = findProcess(sessionId, activeShellId)
      if (active && isTerminalBackgroundProcessStatus(active.status)) controller.terminal()
      if (activeShellId === shellId || subtype === 'background_tasks_changed') void controller.refreshOutput()
    }
    renderCurrent(sessionId)
  }

  async function activate(shellId: string) {
    const sessionId = deps.currentSessionId() || ''
    const process = findProcess(sessionId, shellId)
    if (!sessionId || !process) return
    activeSessionId = sessionId
    activeShellId = shellId
    deps.openPanel('background-process')
    detailClockDispose?.()
    detailClockDispose = isTerminalBackgroundProcessStatus(process.status)
      ? null
      : subscribeBackgroundProcessClock(paintDetail)
    controller.open(sessionId, shellId, outputs.get(outputKey(sessionId, shellId)) || emptyBackgroundProcessOutput(process.outputStartOffset || 0))
    paintDetail()
  }

  function close(shellId: string) {
    if (activeShellId !== shellId) return
    activeSessionId = null
    activeShellId = null
    detailClockDispose?.()
    detailClockDispose = null
    controller.close()
  }

  function closeAll() {
    activeSessionId = null
    activeShellId = null
    detailClockDispose?.()
    detailClockDispose = null
    controller.close()
    window.KlausPanelTabs?.clearBackgroundProcesses?.()
  }

  function forgetSession(sessionId: string) {
    lifecyclePoller.cancel(sessionId)
    processesBySession.delete(sessionId)
    refreshVersions.delete(sessionId)
    for (const key of [...outputs.keys()]) if (key.startsWith(`${sessionId}\u0000`)) outputs.delete(key)
    if (activeSessionId === sessionId) closeAll()
  }

  function open(shellId: string) {
    const sessionId = deps.currentSessionId() || ''
    const process = findProcess(sessionId, shellId)
    if (!process) return
    void window.KlausPanelTabs?.openBackgroundProcess?.(shellId, backgroundProcessDisplayTitle(process))
  }

  initBackgroundProcessSection({
    currentSessionId: () => deps.currentSessionId(),
    entries: () => processes(deps.currentSessionId()),
    onOpen: open,
  })
  deps.api.on.backgroundProcessChanged?.((payload: BackgroundProcessChangedPayload) => applyChanged(payload))
  document.getElementById('background-process-panel-stop')?.addEventListener('click', () => {
    void controller.requestStop()
  })

  const api = {
    refreshSession,
    applyChanged,
    forgetSession,
    closeAll,
    open,
    activateByShellId: activate,
    closeByShellId: close,
    getActiveShellId: () => activeShellId,
    getProcess: (sessionId: string, shellId: string) => findProcess(sessionId, shellId),
    count: (sessionId: string, activeOnly = false) => activeOnly
      ? processes(sessionId).filter(isActiveBackgroundProcess).length
      : processes(sessionId).length,
    requestStop: () => controller.requestStop(),
    output: (sessionId: string, shellId: string) => outputs.get(outputKey(sessionId, shellId)) || emptyBackgroundProcessOutput(),
    async openForSession(sessionId: string, shellId: string) {
      if (sessionId !== deps.currentSessionId()) await deps.switchSession(sessionId)
      if (!findProcess(sessionId, shellId)) await refreshSession(sessionId)
      open(shellId)
    },
  }
  ;(window as any).KlausBackgroundProcessPanel = api
  ;(window as any).klausOpenBackgroundProcess = (shellId: string, sessionId?: string) =>
    api.openForSession(sessionId || deps.currentSessionId() || '', shellId)
  return api
}
