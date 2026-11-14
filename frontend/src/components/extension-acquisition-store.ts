// Shared serialized acquisition store for Skills and Sub-agents, mirroring
// PluginStore's lifecycle so in-flight downloads, queued updates, batch updates
// and user cancellations survive tab switches and page remounts.
import { canCancelPluginOperation, type PluginTransferProgress } from '../pages/plugins/plugin-transfer'

export interface ExtensionAcquisitionItem {
  action: 'install' | 'update'
  phase: 'queued' | 'running' | 'success' | 'error'
  cancelling?: boolean
  progress?: PluginTransferProgress
  error?: string
  version?: string
}

export interface ExtensionBatchState {
  total: number
  completed: number
  failed: number
  running: boolean
}

export interface ExtensionAcquisitionSnapshot {
  operations: Record<string, ExtensionAcquisitionItem>
  batch: ExtensionBatchState | null
  availableUpdates: number
}

export interface AcquisitionOutcome {
  ok?: boolean
  cancelled?: boolean
  installed?: boolean
  error?: string
  version?: string
  [key: string]: any
}

export interface ExtensionAcquisitionDeps {
  cancel?: (id: string) => Promise<{ ok?: boolean; cancelled?: boolean; active?: boolean }>
  onProgress?: (listener: (progress: PluginTransferProgress) => void) => (() => void) | undefined
}

export const acquisitionPending = (op?: ExtensionAcquisitionItem): boolean =>
  op?.phase === 'queued' || op?.phase === 'running'

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error || 'Unknown extension error')

export class ExtensionAcquisitionStore {
  private snapshot: ExtensionAcquisitionSnapshot = {
    operations: {},
    batch: null,
    availableUpdates: 0,
  }
  private listeners = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()
  private pending = new Map<string, Promise<AcquisitionOutcome>>()
  private tokens = new Map<string, { cancelled: boolean }>()
  private progressUnsubscribe: (() => void) | null = null
  private active = false

  constructor(private readonly deps: ExtensionAcquisitionDeps) {}

  private ensureProgressSubscription(): void {
    if (this.progressUnsubscribe) return
    this.progressUnsubscribe = this.deps.onProgress?.(progress => this.applyProgress(progress)) ?? null
  }

  getSnapshot = (): ExtensionAcquisitionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.ensureProgressSubscription()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private patch(patch: Partial<ExtensionAcquisitionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private setOperation(id: string, value: ExtensionAcquisitionItem): void {
    this.patch({ operations: { ...this.snapshot.operations, [id]: value } })
  }

  clearOperation = (id: string): void => {
    if (!(id in this.snapshot.operations)) return
    const operations = { ...this.snapshot.operations }
    delete operations[id]
    this.patch({ operations })
  }

  setAvailableUpdates = (count: number): void => {
    const normalized = Math.max(0, Math.floor(count || 0))
    if (this.snapshot.availableUpdates === normalized) return
    this.patch({ availableUpdates: normalized })
  }

  applyProgress = (event: PluginTransferProgress): void => {
    if (!event || typeof event.id !== 'string') return
    const current = this.snapshot.operations[event.id]
    if (!current || current.phase !== 'running') return
    this.setOperation(event.id, { ...current, progress: event })
  }

  enqueue(
    id: string,
    action: 'install' | 'update',
    task: () => Promise<AcquisitionOutcome>,
  ): Promise<AcquisitionOutcome> {
    this.ensureProgressSubscription()
    const existing = this.pending.get(id)
    if (existing) return existing
    if (this.snapshot.batch && !this.snapshot.batch.running) this.patch({ batch: null })
    const token = { cancelled: false }
    this.tokens.set(id, token)
    this.setOperation(id, { action, phase: this.active || this.pending.size ? 'queued' : 'running' })

    const run = async (): Promise<AcquisitionOutcome> => {
      if (token.cancelled) return { ok: false, cancelled: true }
      this.active = true
      const current = this.snapshot.operations[id]
      this.setOperation(id, { action, phase: 'running', ...(current?.cancelling ? { cancelling: true } : {}) })
      try {
        const result = await task()
        if (result?.cancelled === true || (token.cancelled && result?.ok !== true && result?.installed !== true)) {
          token.cancelled = true
          if (this.tokens.get(id) === token) this.clearOperation(id)
          return { ok: false, cancelled: true }
        }
        if (result?.ok === true || result?.installed === true) {
          this.setOperation(id, { action, phase: 'success', version: result.version })
          return result
        }
        this.setOperation(id, { action, phase: 'error', error: result?.error })
        return result ?? { ok: false }
      } catch (error) {
        if (token.cancelled && /cancel/i.test(errMessage(error))) {
          if (this.tokens.get(id) === token) this.clearOperation(id)
          return { ok: false, cancelled: true }
        }
        const msg = errMessage(error)
        this.setOperation(id, { action, phase: 'error', error: msg })
        return { ok: false, error: msg }
      } finally {
        this.active = false
        if (this.pending.get(id) === promise) this.pending.delete(id)
        if (this.tokens.get(id) === token) this.tokens.delete(id)
      }
    }

    const promise = this.queue.then(run, run)
    this.pending.set(id, promise)
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
    this.setOperation(id, { ...current!, cancelling: true })
    try {
      const reply = await this.deps.cancel?.(id)
      return reply?.cancelled !== false
    } catch {
      return false
    }
  }

  async runBatch(ids: string[], updateOne: (id: string) => Promise<AcquisitionOutcome>): Promise<void> {
    if (this.snapshot.batch?.running) return
    const targets = ids.filter(id => id && !this.pending.has(id))
    if (!targets.length) return
    this.patch({ batch: { total: targets.length, completed: 0, failed: 0, running: true } })
    await Promise.all(targets.map(async id => {
      const outcome = await updateOne(id)
      const failed = !outcome.ok && !outcome.installed && !outcome.cancelled
      const batch = this.snapshot.batch!
      this.patch({ batch: { ...batch, completed: batch.completed + 1, failed: batch.failed + (failed ? 1 : 0) } })
    }))
    this.patch({ batch: { ...this.snapshot.batch!, running: false } })
  }
}

const w = () => window as any

export const skillAcquisitionStore = new ExtensionAcquisitionStore({
  cancel: id => Promise.resolve(w().klaus?.skills?.cancel?.(id)),
  onProgress: listener => w().klaus?.on?.skillProgress?.(listener),
})

export const agentAcquisitionStore = new ExtensionAcquisitionStore({
  cancel: id => Promise.resolve(w().klaus?.agents?.cancel?.(id)),
  onProgress: listener => w().klaus?.on?.agentProgress?.(listener),
})
