import { WINDOWS_SANDBOX_SETTING_KEY, type WindowsSandboxSetupMode, type WindowsSandboxReadinessResponse, type WindowsSandboxSetupCompletedNotification } from '../../../../contracts/windows-sandbox'

export type WindowsSetupMode = WindowsSandboxSetupMode
export type WindowsReadiness = WindowsSandboxReadinessResponse['status']
export type WindowsSetupPhase = 'idle' | 'startingElevated' | 'waitingElevated' | 'startingUnelevated' | 'waitingUnelevated' | 'retryUnelevated' | 'failed'
export type WindowsSetupError = 'config_load' | 'uac_canceled' | 'helper_launch' | 'helper_failed' | 'setup_timeout' | 'config_write' | 'setup_failed'
export type WindowsSetupCompleted = WindowsSandboxSetupCompletedNotification
export interface WindowsSetupEnvironment {
  platform: string
  local: boolean
  editorInWsl?: boolean
  engineInWsl?: boolean
  runInWsl?: boolean
}
export interface WindowsSetupState {
  readiness: WindowsReadiness | null
  checking: boolean
  readinessError: boolean
  phase: WindowsSetupPhase
  error: WindowsSetupError | null
  mode: WindowsSetupMode | null
  retained: boolean
  success: boolean
}
export interface WindowsSetupDependencies {
  readiness(): Promise<{ status: WindowsReadiness }>
  start(args: { mode: WindowsSetupMode; cwd?: string | null }): Promise<{ started: boolean }>
  onCompleted(handler: (event: WindowsSetupCompleted) => void): () => void
  readMode(): Promise<unknown>
  writeMode(mode: WindowsSetupMode): Promise<unknown>
  selectRequestApproval(): Promise<unknown>
  refreshPermissions(): void
  now?(): number
  schedule?(callback: () => void, delay: number): () => void
}

interface WindowsSetupAppApi {
  settings: {
    runtime: {
      windowsSandboxReadiness(): Promise<{ status: WindowsReadiness }>
      startWindowsSandboxSetup(args: { mode: WindowsSetupMode; cwd?: string | null }): Promise<{ started: boolean }>
      onWindowsSandboxSetupCompleted(handler: (event: WindowsSetupCompleted) => void): () => void
    }
    kv: { get(key: string): Promise<unknown>; set(key: string, value: string): Promise<unknown> }
  }
  session: { setPermissionMode(mode: 'default'): Promise<unknown> }
}

export function windowsSetupAppDependencies(api: WindowsSetupAppApi, refreshPermissions: () => void): WindowsSetupDependencies {
  return {
    readiness: () => api.settings.runtime.windowsSandboxReadiness(),
    start: args => api.settings.runtime.startWindowsSandboxSetup(args),
    onCompleted: handler => api.settings.runtime.onWindowsSandboxSetupCompleted(handler),
    readMode: () => api.settings.kv.get(WINDOWS_SANDBOX_SETTING_KEY),
    writeMode: mode => api.settings.kv.set(WINDOWS_SANDBOX_SETTING_KEY, mode),
    selectRequestApproval: () => api.session.setPermissionMode('default'),
    refreshPermissions,
  }
}

export const WINDOWS_SETUP_TIMING = { completion: 1_200_000, timedOutMode: 300_000, finalize: 500, success: 5_000 } as const

export function needsNativeWindowsSetup(environment: WindowsSetupEnvironment): boolean {
  return environment.local && environment.platform === 'win32' && !environment.editorInWsl && !environment.engineInWsl && !environment.runInWsl
}

export function windowsSetupCwd(cwd: string | null | undefined): string | null {
  return !cwd || cwd === '/' ? null : cwd
}

export function windowsSetupPending(phase: WindowsSetupPhase): boolean {
  return phase === 'startingElevated' || phase === 'waitingElevated' || phase === 'startingUnelevated' || phase === 'waitingUnelevated'
}

const helperLaunchErrors = new Set(['orchestrator_sandbox_dir_create_failed', 'orchestrator_elevation_check_failed', 'orchestrator_elevation_required', 'orchestrator_payload_serialize_failed', 'orchestrator_helper_launch_failed'])
const helperCompletionErrors = new Set(['orchestrator_helper_exit_nonzero', 'orchestrator_helper_report_read_failed', 'orchestrator_helper_incomplete'])
const configLoadMessage = /(?:^failed to load configuration|(?:^|\bError: )error loading (?:default )?config(?:\.toml)?(?: after config error)?)(?::\s*|$)/i

export function windowsSetupError(error: unknown, fallback?: WindowsSetupError): WindowsSetupError {
  if (fallback !== undefined) return fallback
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null
  const data = typeof record?.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : null
  const optionalLocation = (value: unknown) => value == null || typeof value === 'number' && Number.isInteger(value) && value > 0
  if (data?.reason === 'configLoad' && typeof data.detail === 'string'
    && (data.filePath == null || typeof data.filePath === 'string') && optionalLocation(data.line) && optionalLocation(data.column)) return 'config_load'
  const message = typeof error === 'string' ? error : typeof record?.message === 'string' ? record.message : null
  if (message === null || message.trim().length === 0) return 'setup_failed'
  if (configLoadMessage.test(message)) return 'config_load'
  const colon = message.indexOf(':')
  const prefix = colon === -1 ? null : message.slice(0, colon)
  if (prefix === 'orchestrator_helper_launch_canceled') return 'uac_canceled'
  if (prefix !== null && helperLaunchErrors.has(prefix)) return 'helper_launch'
  if (prefix !== null && (prefix.startsWith('helper_') || helperCompletionErrors.has(prefix))) return 'helper_failed'
  if (message === 'Timed out waiting for Windows sandbox setup completion') return 'setup_timeout'
  if (message.startsWith('failed to persist windows sandbox mode:')) return 'config_write'
  return 'setup_failed'
}

function ensureSuccess(value: unknown): void {
  if (value && typeof value === 'object') {
    const result = value as { ok?: boolean; error?: unknown }
    if (result.ok === false || result.error) throw Error(String(result.error || 'Windows setup configuration failed'))
  }
}

interface SetupOperation {
  mode: WindowsSetupMode
  finished: boolean
  cancelTimeout?: () => void
  resolve(value: WindowsSetupCompleted): void
  reject(error: Error): void
}

/** One local engine owns a single completion stream shared by every composer. */
export class WindowsSandboxController {
  private state: WindowsSetupState = { readiness: null, checking: false, readinessError: false, phase: 'idle', error: null, mode: null, retained: false, success: false }
  private readonly listeners = new Set<() => void>()
  private readonly timedOutModes = new Map<WindowsSetupMode, number>()
  private operation?: SetupOperation
  private unsubscribeCompleted?: () => void
  private cancelSuccess?: () => void
  private cancelFinalize?: () => void
  private resolveFinalize?: () => void
  private query?: Promise<void>
  private querySequence = 0
  private disposed = false

  constructor(private readonly deps: WindowsSetupDependencies) {}

  readonly snapshot = (): WindowsSetupState => this.state
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private update(patch: Partial<WindowsSetupState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private now(): number { return this.deps.now?.() ?? Date.now() }
  private schedule(callback: () => void, delay: number): () => void {
    if (this.deps.schedule) return this.deps.schedule(callback, delay)
    const timer = setTimeout(callback, delay)
    return () => clearTimeout(timer)
  }

  check(environment: WindowsSetupEnvironment, retry = false): Promise<void> {
    if (!needsNativeWindowsSetup(environment) || this.disposed) return Promise.resolve()
    if (this.query) return this.query
    if (!retry && (this.state.readiness !== null || this.state.readinessError)) return Promise.resolve()
    this.unsubscribeCompleted ??= this.deps.onCompleted(event => this.complete(event))
    const sequence = ++this.querySequence
    this.update({ checking: true, readinessError: false })
    const query = (async () => {
      try {
        const result = await this.deps.readiness()
        if (!['ready', 'notConfigured', 'updateRequired'].includes(result.status)) throw Error('Invalid Windows setup readiness')
        if (sequence === this.querySequence) this.update({ readiness: result.status, checking: false })
      } catch {
        if (sequence === this.querySequence) this.update({ checking: false, readinessError: true })
      }
      try {
        const mode = await this.deps.readMode()
        if (sequence === this.querySequence) this.update({ mode: mode === 'elevated' || mode === 'unelevated' ? mode : null })
      } catch { /* A missing mode is independent from readiness and does not create a frontend default. */ }
    })()
    this.query = query
    void query.finally(() => { if (this.query === query) this.query = undefined })
    return query
  }

  private complete(event: WindowsSetupCompleted): void {
    const operation = this.operation
    if (!operation || operation.mode !== event.mode) { this.timedOutModes.delete(event.mode); return }
    if (operation.finished) return
    operation.finished = true
    operation.cancelTimeout?.()
    if (this.operation === operation) this.operation = undefined
    operation.resolve(event)
  }

  private async start(mode: WindowsSetupMode, cwd: string | null): Promise<WindowsSetupCompleted | null> {
    for (const [mode, expiry] of this.timedOutModes) if (this.now() >= expiry) this.timedOutModes.delete(mode)
    if (this.operation && !this.operation.finished) throw Error('Windows sandbox setup already in progress')
    if (this.timedOutModes.has(mode)) throw Error('Cannot retry the same Windows sandbox setup mode immediately after a timeout')
    let resolve!: (value: WindowsSetupCompleted) => void, reject!: (error: Error) => void
    const completion = new Promise<WindowsSetupCompleted>((done, fail) => { resolve = done; reject = fail })
    const operation: SetupOperation = { mode, finished: false, resolve, reject }
    // Register before sending: the completion notification may precede the start acknowledgement.
    this.operation = operation
    try {
      const result = await this.deps.start({ mode, cwd })
      if (!result.started) {
        operation.finished = true
        if (this.operation === operation) this.operation = undefined
        return null
      }
      if (!operation.finished) operation.cancelTimeout = this.schedule(() => {
        this.timedOutModes.set(mode, this.now() + WINDOWS_SETUP_TIMING.timedOutMode)
        operation.finished = true
        if (this.operation === operation) this.operation = undefined
        operation.reject(Error('Timed out waiting for Windows sandbox setup completion'))
      }, WINDOWS_SETUP_TIMING.completion)
      this.update({ phase: mode === 'elevated' ? 'waitingElevated' : 'waitingUnelevated' })
      return await completion
    } catch (error) {
      operation.finished = true
      operation.cancelTimeout?.()
      if (this.operation === operation) this.operation = undefined
      throw error
    }
  }

  async continue(cwd: string | null | undefined): Promise<void> {
    if (this.disposed || windowsSetupPending(this.state.phase)) return
    const update = this.state.readiness === 'updateRequired'
    const mode: WindowsSetupMode = !update && (this.state.phase === 'retryUnelevated' || this.state.phase === 'failed') ? 'unelevated' : 'elevated'
    const allowFallback = !update && mode === 'elevated'
    let setupFinished = false
    let failureCode: WindowsSetupError | undefined
    this.cancelSuccess?.()
    this.update({ retained: true, success: false, error: null, phase: mode === 'elevated' ? 'startingElevated' : 'startingUnelevated' })
    try {
      const completed = await this.start(mode, windowsSetupCwd(cwd))
      if (!completed?.success) throw Error(completed?.error || 'Windows sandbox setup did not start')
      setupFinished = true
      if (!update) {
        const previousMode = this.state.mode
        this.update({ mode })
        try { ensureSuccess(await this.deps.writeMode(mode)) }
        catch (error) { this.update({ mode: previousMode }); failureCode = 'config_write'; throw error }
        if (this.disposed) return
        ensureSuccess(await this.deps.selectRequestApproval())
        if (this.disposed) return
        await new Promise<void>(resolve => { this.resolveFinalize = resolve; this.cancelFinalize = this.schedule(resolve, WINDOWS_SETUP_TIMING.finalize) })
        this.cancelFinalize = undefined
        this.resolveFinalize = undefined
        if (this.disposed) return
        this.deps.refreshPermissions()
      }
      if (this.disposed) return
      this.querySequence++
      this.update({ readiness: 'ready', checking: false, readinessError: false, phase: 'idle', error: null, success: true })
      this.cancelSuccess = this.schedule(() => this.dismiss(), WINDOWS_SETUP_TIMING.success)
    } catch (error) {
      this.update({ phase: allowFallback && !setupFinished ? 'retryUnelevated' : 'failed', error: windowsSetupError(error, failureCode), success: false })
    }
  }

  dismiss(): void {
    if (windowsSetupPending(this.state.phase)) return
    this.cancelSuccess?.()
    this.cancelSuccess = undefined
    this.update({ retained: false, success: false, phase: 'idle', error: null })
  }

  dispose(): void {
    this.disposed = true
    this.querySequence++
    this.unsubscribeCompleted?.()
    this.cancelSuccess?.()
    this.cancelFinalize?.()
    this.resolveFinalize?.()
    this.operation?.cancelTimeout?.()
    this.operation?.reject(Error('Windows setup controller disposed'))
    this.listeners.clear()
  }
}
