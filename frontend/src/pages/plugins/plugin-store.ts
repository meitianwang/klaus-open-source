import { canCancelPluginOperation, type PluginTransferProgress } from './plugin-transfer'

export interface PluginContributions {
  skills?: string[]
  agents?: string[]
  commands?: string[]
  outputStyles?: string[]
  hooks?: string[]
  mcpServers?: string[]
}

export interface PluginItem {
  id: string
  name?: string
  description?: string
  enabled?: boolean
  installed?: boolean
  category?: string
  author?: string
  homepage?: string
  iconDataUrl?: string
  version?: string
  installedVersion?: string
  availableVersion?: string
  updateAvailable?: boolean
  badges?: string[]
  hasLsp?: boolean
  lspCommands?: string[]
  lspExtensions?: string[]
  contributions?: PluginContributions
  marketplace?: string
  source?: string
  readme?: string
  releaseNotes?: string
  compatibility?: string
}

export interface UpdateCheck { checking: boolean; checkedAt?: number; error?: string }
export interface PluginData {
  plugins: PluginItem[]
  marketplaceError: string
  restartRequired: boolean
  updateCheck?: UpdateCheck
}
export type PluginAction = 'update' | 'install' | 'toggle' | 'uninstall'
export interface MutationResult {
  ok?: boolean
  cancelled?: boolean
  error?: string
  version?: string
  name?: string
  enabled?: boolean
  restartRequired?: boolean
  activationScope?: string
  appliedToCurrentSession?: boolean
  warning?: string
  warningCode?: string
  /** Absolute path of the host-written failure record, present on failed receipts. */
  diagnosticLog?: string
}
export interface PluginOperation {
  action: PluginAction
  phase: 'queued' | 'running' | 'success' | 'error'
  cancelling?: boolean
  progress?: PluginTransferProgress
  error?: string
  version?: string
  result?: MutationResult
  /** Host-written failure record path, offered to a diagnosing conversation. */
  diagnosticLog?: string
  /** Distinguishes consecutive failures of the same plugin for dialog bookkeeping. */
  failedAt?: number
}
export interface PluginSnapshot {
  data: PluginData | null
  loadError: string | null
  readError: string | null
  refreshError: string | null
  checking: boolean
  operations: Record<string, PluginOperation>
  batch: { total: number; completed: number; failed: number; running: boolean } | null
}
interface PluginApi {
  market(): Promise<unknown>
  refresh(options?: { ifStale?: boolean }): Promise<unknown>
  update(id: string, options: { version: string; installedVersion?: string }): Promise<MutationResult>
  install(id: string, options?: { sessionId?: string }): Promise<MutationResult>
  cancel?(id: string): Promise<{ ok?: boolean; cancelled?: boolean; active?: boolean }>
  toggle(id: string, enabled: boolean, sessionId?: string): Promise<MutationResult>
  uninstall(id: string, sessionId?: string): Promise<MutationResult>
}
interface StoreDeps {
  api: () => PluginApi
  sessionId?: () => string | undefined
  invalidate?: () => void
  onProgress?: (listener: (progress: PluginTransferProgress) => void) => (() => void) | undefined
}

export const operationPending = (operation?: PluginOperation): boolean => operation?.phase === 'queued' || operation?.phase === 'running'
const message = (error: unknown): string => error instanceof Error ? error.message : String(error || 'Unknown plugin error')
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' ? value as Record<string, any> : {}

/** Keeps accepted operations alive when their page is hidden or remounted. */
export class PluginStore {
  private snapshot: PluginSnapshot = { data: null, loadError: null, readError: null, refreshError: null, checking: false, operations: {}, batch: null }
  private listeners = new Set<() => void>()
  private loadSequence = 0
  private checkPromise: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, Promise<boolean>>()
  private tokens = new Map<string, { cancelled: boolean }>()
  private progressUnsubscribe: (() => void) | null = null
  private active = false
  constructor(private deps: StoreDeps) {}
  private ensureProgressSubscription(): void {
    if (this.progressUnsubscribe) return
    this.progressUnsubscribe = this.deps.onProgress?.(progress => this.applyProgress(progress)) ?? null
  }
  getSnapshot = (): PluginSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.ensureProgressSubscription()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private patch(patch: Partial<PluginSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }
  private operation(id: string, value: PluginOperation): void { this.patch({ operations: { ...this.snapshot.operations, [id]: value } }) }
  private clearOperation(id: string): void {
    if (!(id in this.snapshot.operations)) return
    const operations = { ...this.snapshot.operations }
    delete operations[id]
    this.patch({ operations })
  }
  applyProgress = (event: PluginTransferProgress): void => {
    if (!event || typeof event.id !== 'string') return
    const current = this.snapshot.operations[event.id]
    if (!current || current.phase !== 'running') return
    this.operation(event.id, { ...current, progress: event })
  }
  async load(): Promise<void> {
    const sequence = ++this.loadSequence
    try {
      const raw = await this.deps.api().market(), data = object(raw)
      const plugins = Array.isArray(raw) ? raw : data.plugins
      if (!Array.isArray(plugins)) throw new Error('Plugin catalog returned an invalid response')
      if (sequence !== this.loadSequence) return
      this.patch({ data: { plugins, marketplaceError: data.error || '', restartRequired: data.restartRequired === true, ...(data.updateCheck ? { updateCheck: data.updateCheck } : {}) }, loadError: null, readError: null,
        ...(data.updateCheck && !data.updateCheck.checking ? { refreshError: data.updateCheck.error || null } : {}) })
    } catch (error) {
      if (sequence !== this.loadSequence) return
      this.patch(this.snapshot.data ? { readError: message(error) } : { loadError: message(error) })
    }
  }
  check(force = false): Promise<void> {
    if (this.checkPromise) return this.checkPromise
    this.patch({ checking: true })
    this.checkPromise = (async () => {
      try {
        const result = object(await this.deps.api().refresh({ ifStale: !force }))
        const sourceError = result.klausOfficial?.ok === false ? result.klausOfficial.error : result.official?.ok === false ? result.official.error : null
        this.patch({ refreshError: result.ok === false || sourceError || result.updateCheck?.error ? String(sourceError || result.error || result.updateCheck?.error || 'Plugin update check failed') : null })
      } catch (error) { this.patch({ refreshError: message(error) }) }
      // A catalog read failure does not change the outcome of an update check.
      await this.load()
    })().finally(() => { this.checkPromise = null; this.patch({ checking: false }) })
    return this.checkPromise
  }
  private commit(id: string, action: PluginAction, selected: PluginItem, result: MutationResult, enabled?: boolean): void {
    ++this.loadSequence
    const data = this.snapshot.data
    if (!data) return
    const plugins = data.plugins.map(plugin => {
      if (plugin.id !== id) return plugin
      if (action === 'uninstall') return { ...plugin, installed: false, enabled: false, installedVersion: undefined, updateAvailable: false }
      if (action === 'toggle') return { ...plugin, enabled }
      const version = result.version || selected.availableVersion || selected.version
      return { ...plugin, installed: true, installedVersion: version, enabled: action === 'install' ? result.enabled !== false : plugin.enabled,
        updateAvailable: plugin.availableVersion !== version && plugin.updateAvailable === true }
    })
    this.patch({ data: { ...data, plugins, restartRequired: data.restartRequired || result.restartRequired === true } })
  }
  dismiss(id: string): void {
    if (operationPending(this.snapshot.operations[id])) return
    const operations = { ...this.snapshot.operations }
    delete operations[id]
    this.patch({ operations })
  }
  private enqueue(plugin: PluginItem, action: PluginAction, enabled?: boolean): Promise<boolean> {
    this.ensureProgressSubscription()
    const existing = this.pending.get(plugin.id)
    if (existing) return existing
    if (this.snapshot.batch && !this.snapshot.batch.running) this.patch({ batch: null })
    const token = { cancelled: false }
    this.tokens.set(plugin.id, token)
    this.operation(plugin.id, { action, phase: this.active || this.pending.size ? 'queued' : 'running' })
    const run = async (): Promise<boolean> => {
      if (token.cancelled) return false
      this.active = true
      const current = this.snapshot.operations[plugin.id]
      this.operation(plugin.id, { action, phase: 'running', ...(current?.cancelling ? { cancelling: true } : {}) })
      try {
        const api = this.deps.api(), sessionId = this.deps.sessionId?.()
        const result = action === 'update' ? await api.update(plugin.id, { version: plugin.availableVersion!, installedVersion: plugin.installedVersion })
          : action === 'install' ? await api.install(plugin.id, { sessionId })
            : action === 'toggle' ? await api.toggle(plugin.id, enabled!, sessionId) : await api.uninstall(plugin.id, sessionId)
        if (result?.cancelled === true || (token.cancelled && result?.ok !== true)) {
          token.cancelled = true
          if (this.tokens.get(plugin.id) === token) this.clearOperation(plugin.id)
          return false
        }
        if (result?.ok !== true) {
          // The receipt carries the user-facing message and the diagnostic log
          // path; the page surfaces them as a toast-sized dialog, not a strip.
          this.operation(plugin.id, { action, phase: 'error', error: result?.error || 'Plugin change was not confirmed', diagnosticLog: result?.diagnosticLog, failedAt: Date.now() })
          return false
        }
        this.commit(plugin.id, action, plugin, result, enabled)
        this.operation(plugin.id, { action, phase: 'success', version: result.version || plugin.availableVersion, result })
        try { this.deps.invalidate?.() } catch { /* Cache invalidation cannot undo persistence. */ }
        // Persistence is already confirmed. Failed display refreshes must not invite a duplicate write.
        void this.load()
        return true
      } catch (error) {
        if (token.cancelled && /cancel/i.test(message(error))) {
          if (this.tokens.get(plugin.id) === token) this.clearOperation(plugin.id)
          return false
        }
        this.operation(plugin.id, { action, phase: 'error', error: message(error), failedAt: Date.now() })
        return false
      } finally {
        this.active = false
        if (this.pending.get(plugin.id) === promise) this.pending.delete(plugin.id)
        if (this.tokens.get(plugin.id) === token) this.tokens.delete(plugin.id)
      }
    }
    const promise = this.queue.then(run, run)
    this.pending.set(plugin.id, promise)
    this.queue = promise.catch(() => {})
    return promise
  }
  cancel = async (id: string): Promise<boolean> => {
    const current = this.snapshot.operations[id]
    if (!canCancelPluginOperation(current)) return false
    const token = this.tokens.get(id)
    if (token) token.cancelled = true
    if (current!.phase === 'queued') {
      this.pending.delete(id)
      this.tokens.delete(id)
      this.clearOperation(id)
      return true
    }
    this.operation(id, { ...current!, cancelling: true })
    try {
      const reply = await this.deps.api().cancel?.(id)
      return reply?.cancelled !== false
    } catch {
      return false
    }
  }
  update = (plugin: PluginItem): Promise<boolean> => plugin.updateAvailable && plugin.availableVersion ? this.enqueue(plugin, 'update') : Promise.resolve(false)
  install = (plugin: PluginItem): Promise<boolean> => this.enqueue(plugin, 'install')
  toggle = (plugin: PluginItem, enabled: boolean): Promise<boolean> => this.enqueue(plugin, 'toggle', enabled)
  uninstall = (plugin: PluginItem): Promise<boolean> => this.enqueue(plugin, 'uninstall')
  async updateAll(): Promise<void> {
    if (this.snapshot.batch?.running) return
    const plugins = (this.snapshot.data?.plugins ?? []).filter(plugin => plugin.installed && plugin.updateAvailable && plugin.availableVersion && !this.pending.has(plugin.id))
    if (!plugins.length) return
    this.patch({ batch: { total: plugins.length, completed: 0, failed: 0, running: true } })
    await Promise.all(plugins.map(async plugin => {
      const ok = await this.update(plugin)
      const wasFailed = this.snapshot.operations[plugin.id]?.phase === 'error'
      const batch = this.snapshot.batch!
      this.patch({ batch: { ...batch, completed: batch.completed + 1, failed: batch.failed + (!ok && wasFailed ? 1 : 0) } })
    }))
    this.patch({ batch: { ...this.snapshot.batch!, running: false } })
  }
}

const browserWindow = () => window as any
export const pluginStore = new PluginStore({
  api: () => browserWindow().klaus.plugins,
  sessionId: () => browserWindow().currentSessionId,
  invalidate: () => browserWindow().invalidatePluginMentionCache?.(),
  onProgress: listener => browserWindow().klaus?.on?.pluginProgress?.(listener),
})

/** The primary error stays readable; diagnostic text is available on demand. */
export function pluginErrorKey(error: string): string {
  if (/release changed|installed plugin changed|version changed|no newer|not an updatable|not found/i.test(error)) return 'plugins_error_stale'
  if (/timeout|timed out|network|fetch|HTTP|offline|ENOTFOUND|ECONN|download/i.test(error)) return 'plugins_error_network'
  if (/manifest|checksum|hash|invalid|package|symlink|escaping|outside|not available for download/i.test(error)) return 'plugins_error_package'
  if (/persist|engine|closed|connection|disconnect/i.test(error)) return 'plugins_error_connection'
  return 'plugins_error_unknown'
}
