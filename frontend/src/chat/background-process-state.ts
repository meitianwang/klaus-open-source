export type BackgroundProcessStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

export interface BackgroundProcess {
  shellId: string
  taskId?: string
  command: string
  title?: string
  cwd: string
  pid?: number
  status: BackgroundProcessStatus
  startedAtMs?: number
  updatedAtMs?: number
  completedAtMs?: number
  exitCode?: number
  terminationSignal?: string
  failure?: string
  stopRequested?: boolean
  outputStartOffset?: number
  outputNextOffset?: number
  droppedBytes?: number
  outputAvailable?: boolean
}

export interface BackgroundProcessChangedPayload {
  sessionId: string
  event: {
    subtype?: string
    type?: string
    shellId?: string
    process?: unknown
    processes?: unknown[]
    output?: string
    afterOffset?: number
    nextOffset?: number
    droppedBytes?: number
  }
}

export interface BackgroundProcessOutputState {
  text: string
  cursor: number
  droppedBytes: number
  eof: boolean
}

export interface BackgroundProcessWorkspaceSnapshot {
  sessionId: string
  shellId: string
  output: BackgroundProcessOutputState
  stopping: boolean
  error: string
}

const STATUS_VALUES = new Set<BackgroundProcessStatus>([
  'pending', 'running', 'paused', 'completed', 'failed', 'stopped',
])

const numberField = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const stringField = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

export function normalizeBackgroundProcess(value: unknown): BackgroundProcess | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const shellId = stringField(row.shellId) || stringField(row.taskId) || stringField(row.id) || ''
  if (!shellId) return null
  const rawStatus = String(row.status || '').toLowerCase() as BackgroundProcessStatus
  const status = STATUS_VALUES.has(rawStatus) ? rawStatus : 'pending'
  return {
    shellId,
    ...(stringField(row.taskId) ? { taskId: stringField(row.taskId) } : {}),
    command: stringField(row.command) || stringField(row.title) || shellId,
    ...(stringField(row.title) ? { title: stringField(row.title) } : {}),
    cwd: stringField(row.cwd) || '',
    ...(numberField(row.pid) !== undefined ? { pid: numberField(row.pid) } : {}),
    status,
    ...(numberField(row.startedAtMs ?? row.startedAt) !== undefined ? { startedAtMs: numberField(row.startedAtMs ?? row.startedAt) } : {}),
    ...(numberField(row.updatedAtMs ?? row.updatedAt) !== undefined ? { updatedAtMs: numberField(row.updatedAtMs ?? row.updatedAt) } : {}),
    ...(numberField(row.completedAtMs ?? row.completedAt) !== undefined ? { completedAtMs: numberField(row.completedAtMs ?? row.completedAt) } : {}),
    ...(numberField(row.exitCode) !== undefined ? { exitCode: numberField(row.exitCode) } : {}),
    ...(stringField(row.terminationSignal) ? { terminationSignal: stringField(row.terminationSignal) } : {}),
    ...(stringField(row.failure) ? { failure: stringField(row.failure) } : {}),
    stopRequested: row.stopRequested === true,
    ...(numberField(row.outputStartOffset) !== undefined ? { outputStartOffset: numberField(row.outputStartOffset) } : {}),
    ...(numberField(row.outputNextOffset) !== undefined ? { outputNextOffset: numberField(row.outputNextOffset) } : {}),
    ...(numberField(row.droppedBytes) !== undefined ? { droppedBytes: numberField(row.droppedBytes) } : {}),
    outputAvailable: row.outputAvailable === true,
  }
}

export function normalizeBackgroundProcessSnapshot(reply: unknown): BackgroundProcess[] {
  const value = reply && typeof reply === 'object' && !Array.isArray(reply)
    ? reply as Record<string, any>
    : null
  const rows: unknown[] = Array.isArray(reply)
    ? reply
    : Array.isArray(value?.backgroundProcesses?.processes)
      ? value.backgroundProcesses.processes
      : Array.isArray(value?.processes)
        ? value.processes
        : []
  return rows.map(normalizeBackgroundProcess).filter((row): row is BackgroundProcess => !!row)
}

export function isTerminalBackgroundProcessStatus(status: BackgroundProcessStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

export function isActiveBackgroundProcess(process: BackgroundProcess): boolean {
  return process.status === 'pending' || process.status === 'running' || process.status === 'paused'
}

export function orderBackgroundProcesses(processes: BackgroundProcess[]): BackgroundProcess[] {
  return [...processes].sort((a, b) => {
    const terminalDelta = Number(isTerminalBackgroundProcessStatus(a.status)) - Number(isTerminalBackgroundProcessStatus(b.status))
    if (terminalDelta !== 0) return terminalDelta
    const aStarted = a.startedAtMs ?? Number.POSITIVE_INFINITY
    const bStarted = b.startedAtMs ?? Number.POSITIVE_INFINITY
    return aStarted - bStarted || (a.shellId || a.taskId || '').localeCompare(b.shellId || b.taskId || '')
  })
}

export function mergeBackgroundProcessEvent(
  current: BackgroundProcess[],
  rawEvent: BackgroundProcessChangedPayload['event'] | null | undefined,
): BackgroundProcess[] {
  const event = rawEvent || {}
  const subtype = event.subtype || event.type || ''
  if (subtype === 'background_tasks_changed' && Array.isArray(event.processes)) {
    return normalizeBackgroundProcessSnapshot({ processes: event.processes })
  }
  const process = normalizeBackgroundProcess(event.process)
  if (!process) return current
  const next = [...current]
  const index = next.findIndex(item => item.shellId === process.shellId)
  if (index < 0) next.push(process)
  else next[index] = { ...next[index], ...process }
  return next
}

export function emptyBackgroundProcessOutput(cursor = 0): BackgroundProcessOutputState {
  return { text: '', cursor: Math.max(0, cursor), droppedBytes: 0, eof: false }
}

export function applyBackgroundProcessOutput(
  current: BackgroundProcessOutputState,
  reply: unknown,
): BackgroundProcessOutputState {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return current
  const value = reply as Record<string, unknown>
  if (value.found === false) return { ...current, eof: true }
  const afterOffset = numberField(value.afterOffset) ?? current.cursor
  const nextOffset = numberField(value.nextOffset) ?? afterOffset
  if (nextOffset <= current.cursor) {
    return { ...current, eof: value.eof === true || current.eof, droppedBytes: Math.max(current.droppedBytes, numberField(value.droppedBytes) ?? 0) }
  }
  const output = typeof value.output === 'string' ? value.output : ''
  return {
    text: current.text + output,
    cursor: nextOffset,
    droppedBytes: Math.max(current.droppedBytes, numberField(value.droppedBytes) ?? 0),
    eof: value.eof === true,
  }
}

export function backgroundProcessShellIdFromToolResult(toolName: string, output: unknown): string | null {
  const name = String(toolName || '').toLowerCase()
  if (name !== 'bash' && name !== 'exec_command') return null
  const text = typeof output === 'string' ? output : ''
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed?.shellId === 'string' && parsed.shellId) return parsed.shellId
    if (typeof parsed?.sessionId === 'string' && parsed.sessionId) return parsed.sessionId
  } catch {}
  const match = text.match(/["']?(?:shellId|sessionId)["']?\s*[:=]\s*["']([^"'\s,}]+)["']/i)
  if (match?.[1]) return match[1]
  return text.match(/\[session\s+([^\s\]]+)\s+still running/i)?.[1] || null
}

export interface BackgroundProcessWorkspaceDeps {
  readOutput(sessionId: string, shellId: string, afterOffset: number): Promise<unknown>
  stop(sessionId: string, shellId: string): Promise<any>
  changed(snapshot: BackgroundProcessWorkspaceSnapshot): void
}

export function createBackgroundProcessWorkspaceController(deps: BackgroundProcessWorkspaceDeps) {
  let state: BackgroundProcessWorkspaceSnapshot = {
    sessionId: '', shellId: '', output: emptyBackgroundProcessOutput(), stopping: false, error: '',
  }
  let readInFlight = false
  let readAgain = false
  let generation = 0
  const publish = () => deps.changed({ ...state, output: { ...state.output } })

  const refreshOutput = async () => {
    if (!state.sessionId || !state.shellId) return
    if (readInFlight) { readAgain = true; return }
    const requestGeneration = generation
    const sessionId = state.sessionId
    const shellId = state.shellId
    readInFlight = true
    try {
      const reply = await deps.readOutput(sessionId, shellId, state.output.cursor)
      if (requestGeneration !== generation || sessionId !== state.sessionId || shellId !== state.shellId) return
      state = { ...state, output: applyBackgroundProcessOutput(state.output, reply) }
      publish()
    } finally {
      readInFlight = false
      if (readAgain && requestGeneration === generation) {
        readAgain = false
        void refreshOutput()
      }
    }
  }

  return {
    open(sessionId: string, shellId: string, output = emptyBackgroundProcessOutput()) {
      generation += 1
      readAgain = false
      state = { sessionId, shellId, output: { ...output }, stopping: false, error: '' }
      publish()
      void refreshOutput()
    },
    close() {
      generation += 1
      readAgain = false
      state = { sessionId: '', shellId: '', output: emptyBackgroundProcessOutput(), stopping: false, error: '' }
      publish()
    },
    refreshOutput,
    applyOutput(reply: unknown) {
      state = { ...state, output: applyBackgroundProcessOutput(state.output, reply) }
      publish()
    },
    terminal() {
      if (!state.stopping) return
      state = { ...state, stopping: false, error: '' }
      publish()
    },
    async requestStop() {
      if (!state.sessionId || !state.shellId || state.stopping) return false
      state = { ...state, stopping: true, error: '' }
      publish()
      try {
        const reply = await deps.stop(state.sessionId, state.shellId)
        if (reply?.found === false || reply?.accepted === false) {
          throw new Error(typeof reply?.error === 'string' ? reply.error : 'stop was not accepted')
        }
        return true
      } catch (error) {
        state = { ...state, stopping: false, error: error instanceof Error ? error.message : String(error) }
        publish()
        return false
      }
    },
    snapshot: () => ({ ...state, output: { ...state.output } }),
  }
}
