// Device storage accounting and versioned cleanup reviews for one profile.
import { randomUUID } from 'node:crypto'
import { promises as fileSystem, type Dirent } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

// Account for physical files, including archive containers. Electron's default
// filesystem expands .asar files into virtual directories with synthetic stats.
const { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } = process.versions.electron
  ? (require('original-fs') as typeof import('node:fs')).promises
  : fileSystem

export const STORAGE_CATEGORIES = ['threads', 'subagents', 'archived', 'worktrees', 'other'] as const
export type StorageCategory = (typeof STORAGE_CATEGORIES)[number]
export interface StorageCategorySize { category: string; bytes: number }
export interface StorageUsage {
  home: string
  totalBytes: number
  categories: StorageCategorySize[]
  sessionBytes: Record<string, number>
  sessionSubagentBytes: Record<string, number>
  subagentCounts: Record<string, number>
}
export interface StorageSnapshot {
  status: 'scanning' | 'ready' | 'error'
  measuredAt: number | null
  completedCategories: string[]
  usage: StorageUsage | null
  error?: string
  warning?: string
}
export interface SessionStorageMeta {
  id: string
  archived: boolean
  running: boolean
  pinned: boolean
  updatedAt: number
  workdir?: string
  parentSessionId?: string
  ephemeral?: boolean
  row: unknown
}
export interface StorageReviewRow {
  id: string
  archived: boolean
  running: boolean
  pinned: boolean
  updatedAt: number
  workdir: string | null
  bytes: number
  subagents: number
  row: unknown
}
export interface StorageCleanupSelection {
  id: string
  /** Presentation clock only; deletion authority belongs to the review token. */
  updatedAt?: number
}
export interface StorageCleanupOptions { reviewId: string; cutoffMs: number; archivedOnly: boolean }
export interface StorageCleanupResult {
  deleted: number
  skipped: number
  failed: number
  [key: string]: number
}

const CACHE_VERSION = 3
const CLEANUP_CONCURRENCY = 4
const REFRESH_AFTER_MS = 60_000
const ROLLOUT_FILE = /^(\d+)-(.+)\.jsonl(?:\.zst)?$/
const DATA_DIR = /^(\d+)-(.+)$/
const AGENT_FILE = /^agent-.+\.jsonl(?:\.zst)?$/
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const record = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
)
const storageId = (id: string): boolean => /^[a-zA-Z0-9_-]{1,256}$/.test(id)
const persistentId = (id: string): boolean => storageId(id) && !id.startsWith('__')
const sizeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const emptyBytes = (): Record<StorageCategory, number> => ({ threads: 0, subagents: 0, archived: 0, worktrees: 0, other: 0 })
const emptyMap = (): Record<string, number> => Object.create(null) as Record<string, number>

interface TreeSize {
  bytes: number
  subagents: number
  stamps: string[]
  newest: number
}
interface MeasuredSession {
  id: string
  archived: boolean
  own: number
  sub: number
  count: number
  rollout: boolean
  stamps: string[]
  newest: number
}
interface ReviewedSession { fingerprint: string; archived: boolean; pinned: boolean }
interface Review { sessions: Map<string, ReviewedSession> }
export interface DeviceStorageDeps {
  configRoot: string
  cachePath: string
  /** Must return authoritative current catalog metadata without snapshot recovery. */
  sessionMeta(): Promise<SessionStorageMeta[]>
  /** Targeted single-row refresh used to recheck one chat during cleanup. */
  sessionRow?(id: string): Promise<SessionStorageMeta | null>
  deleteSession(id: string): Promise<unknown>
  /** Fence new turn admission without interrupting work. Null means the chat is busy. */
  beforeDelete?(id: string): Promise<(() => void) | null>
  /** Notify observers once per completed batch, with confirmed deletions only. */
  onDeleted?(sessionIds: string[]): void
  diagnostic?(kind: string, detail: string): void
}

export class DeviceStorageService {
  private readonly deps: DeviceStorageDeps
  private readonly root: string
  private value: StorageSnapshot = { status: 'scanning', usage: null, completedCategories: [], measuredAt: null }
  private initialization: Promise<void> | null = null
  private scan: Promise<void> | null = null
  private controller: AbortController | null = null
  private refreshAfter = 0
  private rescanRequested = false
  private measured = new Map<string, MeasuredSession>()
  private readonly reviews = new Map<string, Review>()
  private readonly deleted = new Set<string>()
  private cleanupQueue: Promise<void> = Promise.resolve()

  constructor(deps: DeviceStorageDeps) {
    this.deps = deps
    this.root = resolve(deps.configRoot)
  }

  async read(): Promise<StorageSnapshot> {
    await this.initialize()
    if (!this.scan && Date.now() >= this.refreshAfter) this.start()
    return this.value
  }

  /** Start or join one scan; callers poll read() for category completion. */
  async refresh(): Promise<StorageSnapshot> {
    await this.initialize()
    this.start()
    return this.value
  }

  async reviewInventory(): Promise<{
    reviewId: string; inventory: SessionStorageMeta[]
    sessionBytes: Record<string, number>; subagentCounts: Record<string, number>
  }> {
    const snapshot = await this.read()
    if (snapshot.status === 'error' || !snapshot.usage
      || !['threads', 'subagents', 'archived'].every(category => snapshot.completedCategories.includes(category))) {
      throw new Error('Chat storage has not been completely measured yet')
    }
    const measured = this.measured
    const inventory: SessionStorageMeta[] = []
    const sessions = new Map<string, ReviewedSession>()
    const counts = new Map<string, number>()
    const catalog = await this.deps.sessionMeta()
    const currentRows = await this.scanSessions(new AbortController().signal, emptyBytes())
    const currentById = new Map<string, MeasuredSession[]>()
    for (const item of currentRows) currentById.set(item.id, [...(currentById.get(item.id) ?? []), item])
    for (const meta of catalog) counts.set(meta.id, (counts.get(meta.id) ?? 0) + 1)
    for (const meta of catalog) {
      const original = measured.get(meta.id)
      if (!this.reviewable(meta) || counts.get(meta.id) !== 1 || !original?.rollout
        || original.archived !== meta.archived || this.deleted.has(meta.id)) continue
      const candidates = currentById.get(meta.id)
      const current = candidates?.length === 1 ? candidates[0] : undefined
      if (!current || this.fingerprint(current) !== this.fingerprint(original)) continue
      const updatedAt = Math.max(current.newest, Number.isFinite(meta.updatedAt) ? meta.updatedAt : 0)
      if (!(updatedAt > 0)) continue
      inventory.push({ ...meta, updatedAt })
      sessions.set(meta.id, { fingerprint: this.fingerprint(current), archived: meta.archived, pinned: meta.pinned })
    }
    while (this.reviews.size >= 8) this.reviews.delete(this.reviews.keys().next().value!)
    const reviewId = randomUUID()
    this.reviews.set(reviewId, { sessions })
    return { reviewId, inventory, sessionBytes: snapshot.usage.sessionBytes, subagentCounts: snapshot.usage.subagentCounts }
  }

  cleanup(selection: StorageCleanupSelection[], options: StorageCleanupOptions): Promise<StorageCleanupResult> {
    // Validate before touching the catalog or filesystem: a bare id is never delete authority.
    try { this.requireReview(options) } catch (error) { return Promise.reject(error) }
    if (!Array.isArray(selection) || selection.some(item => !item || typeof item.id !== 'string' || !persistentId(item.id))) {
      return Promise.reject(new Error('Invalid cleanup selection'))
    }
    const run = this.cleanupQueue.then(() => this.cleanupNow(selection, options))
    this.cleanupQueue = run.then(() => {}, () => {})
    return run
  }

  private async cleanupNow(selection: StorageCleanupSelection[], options: StorageCleanupOptions): Promise<StorageCleanupResult> {
    const review = this.requireReview(options)
    const result: StorageCleanupResult = { deleted: 0, skipped: 0, failed: 0 }
    const seen = new Set<string>()
    const work: Array<{ slot: number; item: StorageCleanupSelection; original: ReviewedSession }> = []
    for (const item of selection) {
      const original = review.sessions.get(item.id)
      if (seen.has(item.id) || !original || this.deleted.has(item.id)) { result.skipped++; continue }
      seen.add(item.id)
      work.push({ slot: work.length, item, original })
    }
    // Read the catalog once per batch. Re-reading the whole catalog for every
    // selected chat made cleanup cost scale with catalog size times selection
    // size; per-chat drift is rechecked below with a targeted single-row read.
    const catalog = new Map<string, SessionStorageMeta[]>()
    try {
      for (const meta of await this.deps.sessionMeta()) catalog.set(meta.id, [...(catalog.get(meta.id) ?? []), meta])
    } catch {
      result.failed += work.length
      return result
    }
    const deletedAt: Array<string | undefined> = new Array(work.length)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= work.length) return
        const { slot, item, original } = work[index]!
        let release: (() => void) | null | undefined
        try {
          if (this.deps.beforeDelete) {
            release = await this.deps.beforeDelete(item.id)
            if (!release) { result.skipped++; continue }
          }
          const matches = catalog.get(item.id) ?? []
          const meta = matches[0]
          if (matches.length !== 1 || !meta || !this.reviewable(meta)
            || meta.archived !== original.archived || meta.pinned !== original.pinned
            || (options.archivedOnly && !meta.archived)) { result.skipped++; continue }
          const fresh = this.deps.sessionRow ? await this.deps.sessionRow(item.id) : meta
          if (!fresh || fresh.running || fresh.archived !== original.archived || fresh.pinned !== original.pinned
            || (options.archivedOnly && !fresh.archived)) { result.skipped++; continue }
          const current = await this.inspectSession(item.id)
          const activity = Math.max(current?.newest ?? 0, Number.isFinite(fresh.updatedAt) ? fresh.updatedAt : 0)
          if (!current || !current.rollout || current.archived !== meta.archived
            || this.fingerprint(current) !== original.fingerprint || activity <= 0 || activity >= options.cutoffMs) {
            result.skipped++; continue
          }
          await this.deps.deleteSession(item.id)
          this.deleted.add(item.id)
          for (const entry of this.reviews.values()) entry.sessions.delete(item.id)
          result.deleted++
          deletedAt[slot] = item.id
        } catch {
          result.failed++
        } finally { release?.() }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CLEANUP_CONCURRENCY, work.length) }, () => worker()))
    const deletedIds = deletedAt.filter((id): id is string => typeof id === 'string')
    if (result.deleted) {
      this.measured = new Map()
      this.refreshAfter = 0
      if (this.scan) this.rescanRequested = true
      else this.start()
      this.notifyDeleted(deletedIds)
    }
    return result
  }

  private notifyDeleted(sessionIds: string[]): void {
    try { this.deps.onDeleted?.([...sessionIds]) } catch (error) {
      const kind = 'storage-chats-deleted-notification-failed'
      const detail = JSON.stringify({ sessionIds, error: message(error) })
      try {
        if (this.deps.diagnostic) this.deps.diagnostic(kind, detail)
        else console.error(kind, detail)
      } catch (diagnosticError) {
        console.error(kind, detail, 'Diagnostic observer failed:', message(diagnosticError))
      }
    }
  }

  private requireReview(options: StorageCleanupOptions): Review {
    if (!options || typeof options.reviewId !== 'string' || !sizeNumber(options.cutoffMs)
      || options.cutoffMs === 0 || options.cutoffMs > Date.now() || typeof options.archivedOnly !== 'boolean') {
      throw new Error('A valid storage review and cutoff are required')
    }
    const review = this.reviews.get(options.reviewId)
    if (!review) throw new Error('Storage review is unavailable; review the chats again')
    return review
  }

  private reviewable(meta: SessionStorageMeta): boolean {
    const row = record(meta.row)
    return persistentId(meta.id) && !meta.ephemeral && !meta.parentSessionId
      && row?.ephemeral !== true && row?.isEphemeral !== true
      && !row?.parentSessionId && !row?.parentThreadId && !row?.parent_thread_id
      && (!row?.role || row.role === 'main')
  }

  private initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.loadCache().catch(error => {
      this.value = { ...this.value, warning: `Storage cache: ${message(error)}` }
    })
    return this.initialization
  }

  private async loadCache(): Promise<void> {
    let text: string
    try { text = await readFile(this.deps.cachePath, 'utf8') } catch (error) { if (missing(error)) return; throw error }
    const raw = record(JSON.parse(text))
    // Older accounting did not recognize compressed rollouts; refresh it quietly.
    if (raw?.version === 2) return
    const usage = record(raw?.usage)
    if (raw?.version !== CACHE_VERSION || !sizeNumber(raw.measuredAt) || raw.measuredAt === 0 || !usage
      || usage.home !== this.root || !sizeNumber(usage.totalBytes) || !Array.isArray(usage.categories)
      || usage.categories.length !== STORAGE_CATEGORIES.length) throw new Error('Invalid storage cache')
    const categories = usage.categories.map(record)
    if (categories.some(item => !item || !sizeNumber(item.bytes))
      || STORAGE_CATEGORIES.some(category => categories.filter(item => item?.category === category).length !== 1)
      || categories.reduce((sum, item) => sum + Number(item!.bytes), 0) !== usage.totalBytes) throw new Error('Invalid storage cache totals')
    for (const key of ['sessionBytes', 'sessionSubagentBytes', 'subagentCounts']) {
      const entries = record(usage[key])
      if (!entries || Object.entries(entries).some(([id, bytes]) => !storageId(id) || !sizeNumber(bytes))) throw new Error('Invalid storage cache session sizes')
    }
    const sessionBytes = usage.sessionBytes as Record<string, number>
    if (Object.values(sessionBytes).reduce((sum, bytes) => sum + bytes, 0) > usage.totalBytes
      || Object.entries(usage.sessionSubagentBytes as Record<string, number>).some(([id, bytes]) => bytes > (sessionBytes[id] ?? -1))
      || Object.keys(usage.subagentCounts as Record<string, number>).some(id => !Object.hasOwn(sessionBytes, id))) {
      throw new Error('Invalid storage cache session totals')
    }
    this.value = { status: 'ready', usage: usage as unknown as StorageUsage, completedCategories: [], measuredAt: raw.measuredAt }
  }

  private start(): void {
    if (this.scan) return
    const controller = new AbortController()
    this.controller = controller
    this.rescanRequested = false
    this.value = { ...this.value, status: 'scanning', completedCategories: [], error: undefined }
    this.scan = this.measure(controller.signal).then(async () => {
      if (this.controller !== controller || this.rescanRequested) return
      this.value = { ...this.value, measuredAt: Date.now() }
      this.refreshAfter = Date.now() + REFRESH_AFTER_MS
      try {
        await this.saveCache()
        this.value = { ...this.value, warning: undefined }
      } catch (error) {
        this.value = { ...this.value, warning: `Storage cache: ${message(error)}` }
      }
      if (!this.rescanRequested) this.value = { ...this.value, status: 'ready' }
    }).catch(error => {
      if (this.controller === controller) {
        controller.abort()
        this.value = { ...this.value, status: 'error', error: message(error) }
        this.refreshAfter = Date.now() + REFRESH_AFTER_MS
      }
    }).finally(() => {
      if (this.controller !== controller) return
      this.controller = null
      this.scan = null
      if (this.rescanRequested) this.start()
    })
  }

  private publish(bytes: Record<StorageCategory, number>, completed: string[], signal: AbortSignal, extra?: Partial<StorageUsage>): void {
    signal.throwIfAborted()
    if (this.controller?.signal !== signal || this.rescanRequested) return
    const previous = this.value.usage
    const categories = STORAGE_CATEGORIES.map(category => ({ category, bytes: bytes[category] }))
    this.value = { ...this.value, usage: {
      home: this.root, totalBytes: categories.reduce((sum, entry) => sum + entry.bytes, 0), categories,
      sessionBytes: extra?.sessionBytes ?? previous?.sessionBytes ?? emptyMap(),
      sessionSubagentBytes: extra?.sessionSubagentBytes ?? previous?.sessionSubagentBytes ?? emptyMap(),
      subagentCounts: extra?.subagentCounts ?? previous?.subagentCounts ?? emptyMap(),
    }, completedCategories: [...new Set([...this.value.completedCategories, ...completed])] }
  }

  private async measure(signal: AbortSignal): Promise<void> {
    const top = await readdir(this.root, { withFileTypes: true })
    signal.throwIfAborted()
    const bytes = emptyBytes()
    const sessions = await this.scanSessions(signal, bytes)
    const sessionBytes = emptyMap(), sessionSubagentBytes = emptyMap(), subagentCounts = emptyMap()
    const grouped = new Map<string, MeasuredSession[]>()
    for (const item of sessions) {
      sessionBytes[item.id] = (sessionBytes[item.id] ?? 0) + item.own + item.sub
      sessionSubagentBytes[item.id] = (sessionSubagentBytes[item.id] ?? 0) + item.sub
      subagentCounts[item.id] = (subagentCounts[item.id] ?? 0) + item.count
      grouped.set(item.id, [...(grouped.get(item.id) ?? []), item])
    }
    if (!this.rescanRequested) this.measured = new Map([...grouped].filter(([, rows]) => rows.length === 1).map(([id, rows]) => [id, rows[0]!]))
    this.publish(bytes, ['threads', 'subagents', 'archived'], signal, { sessionBytes, sessionSubagentBytes, subagentCounts })
    const worktrees = top.filter(entry => !entry.isSymbolicLink() && entry.name === 'worktrees')
    const other = top.filter(entry => !entry.isSymbolicLink() && entry.name !== 'sessions' && entry.name !== 'worktrees')
    const results = await Promise.allSettled([
      this.walkCategory('other', other.map(entry => join(this.root, entry.name)), bytes, signal),
      this.walkCategory('worktrees', worktrees.map(entry => join(this.root, entry.name)), bytes, signal),
    ])
    signal.throwIfAborted()
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }

  private async scanSessions(signal: AbortSignal, bytes: Record<StorageCategory, number>, onlyId?: string): Promise<MeasuredSession[]> {
    const root = join(this.root, 'sessions')
    const sessions: MeasuredSession[] = []
    for (const archived of [false, true]) {
      const tree = archived ? join(root, 'archived') : root
      const entries = await this.directoryEntries(tree)
      const local = new Map<string, MeasuredSession>()
      for (const entry of entries) {
        signal.throwIfAborted()
        if (entry.isSymbolicLink() || (!archived && ['archived', 'background-processes'].includes(entry.name))) continue
        const file = entry.isFile() ? entry.name.match(ROLLOUT_FILE) : null
        const data = entry.isDirectory() ? entry.name.match(DATA_DIR) : null
        const match = file ?? data
        if (!match) {
          if (onlyId === undefined) bytes.other += (await this.walkTree(join(tree, entry.name), signal)).bytes
          continue
        }
        if (onlyId !== undefined && match[2] !== onlyId) continue
        const stem = file ? entry.name.replace(/\.jsonl(?:\.zst)?$/, '') : entry.name
        let session = local.get(stem)
        if (!session) {
          session = { id: match[2]!, archived, own: 0, sub: 0, count: 0, rollout: false, stamps: [], newest: 0 }
          local.set(stem, session)
        }
        const path = join(tree, entry.name)
        if (file) {
          const measured = await this.walkTree(path, signal)
          session.rollout = measured.stamps.length > 0
          session.own += measured.bytes
          session.stamps.push(...measured.stamps)
          session.newest = Math.max(session.newest, measured.newest)
        } else {
          const children = await this.directoryEntries(path)
          for (const child of children) {
            const measured = await this.walkTree(join(path, child.name), signal)
            const subagents = child.name === 'subagents' && child.isDirectory()
            if (subagents) { session.sub += measured.bytes; session.count += measured.subagents }
            else session.own += measured.bytes
            session.stamps.push(...measured.stamps)
            session.newest = Math.max(session.newest, measured.newest)
          }
        }
      }
      sessions.push(...local.values())
    }
    const background = join(root, 'background-processes')
    const entries = await this.directoryEntries(background)
    for (const entry of entries) {
      signal.throwIfAborted()
      if (entry.isSymbolicLink() || (onlyId !== undefined && entry.name !== onlyId)) continue
      const measured = await this.walkTree(join(background, entry.name), signal)
      const owners = sessions.filter(session => session.id === entry.name)
      if (owners.length === 1) {
        owners[0]!.own += measured.bytes
        owners[0]!.stamps.push(...measured.stamps)
        owners[0]!.newest = Math.max(owners[0]!.newest, measured.newest)
      } else if (onlyId === undefined) bytes.other += measured.bytes
    }
    for (const session of sessions) {
      if (session.archived) bytes.archived += session.own + session.sub
      else { bytes.threads += session.own; bytes.subagents += session.sub }
    }
    return sessions
  }

  private async inspectSession(id: string): Promise<MeasuredSession | null> {
    const sessions = await this.scanSessions(new AbortController().signal, emptyBytes(), id)
    return sessions.length === 1 && sessions[0]!.rollout ? sessions[0]! : null
  }

  private async directoryEntries(path: string): Promise<Dirent[]> {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) return []
      // readdir preserves ENOTDIR and permission failures as authoritative errors.
      return await readdir(path, { withFileTypes: true })
    } catch (error) { if (missing(error)) return []; throw error }
  }

  private fingerprint(session: MeasuredSession): string {
    return JSON.stringify([session.archived, ...session.stamps.toSorted()])
  }

  private async walkCategory(category: 'other' | 'worktrees', paths: string[], bytes: Record<StorageCategory, number>, signal: AbortSignal): Promise<void> {
    for (const path of paths) {
      bytes[category] += (await this.walkTree(path, signal)).bytes
      this.publish(bytes, [], signal)
    }
    this.publish(bytes, [category], signal)
  }

  private async walkTree(path: string, signal: AbortSignal): Promise<TreeSize> {
    signal.throwIfAborted()
    let info
    try { info = await lstat(path, { bigint: true }) } catch (error) {
      if (missing(error)) return { bytes: 0, subagents: 0, stamps: [], newest: 0 }
      throw error
    }
    signal.throwIfAborted()
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) return { bytes: 0, subagents: 0, stamps: [], newest: 0 }
    const stamp = JSON.stringify([relative(this.root, path), info.isDirectory() ? 'directory' : 'file', String(info.size), String(info.mtimeNs), String(info.dev), String(info.ino)])
    if (info.isFile()) return {
      bytes: Number(info.size), subagents: AGENT_FILE.test(basename(path)) ? 1 : 0,
      stamps: [stamp], newest: Number(info.mtimeNs / 1_000_000n),
    }
    const result: TreeSize = { bytes: 0, subagents: 0, stamps: [stamp], newest: 0 }
    let entries: Dirent[]
    try { entries = await readdir(path, { withFileTypes: true }) } catch (error) {
      if (missing(error)) return { bytes: 0, subagents: 0, stamps: [], newest: 0 }
      throw error
    }
    const plainFiles = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name))
    for (const entry of entries) {
      const child = await this.walkTree(join(path, entry.name), signal)
      result.bytes += child.bytes
      const duplicateRepresentation = entry.name.endsWith('.jsonl.zst') && plainFiles.has(entry.name.slice(0, -4))
      result.subagents += duplicateRepresentation ? 0 : child.subagents
      result.stamps.push(...child.stamps)
      result.newest = Math.max(result.newest, child.newest)
    }
    return result
  }

  private async saveCache(): Promise<void> {
    if (!this.value.usage || !this.value.measuredAt) return
    const payload = JSON.stringify({ version: CACHE_VERSION, measuredAt: this.value.measuredAt, usage: this.value.usage })
    await mkdir(dirname(this.deps.cachePath), { recursive: true })
    const tmp = `${this.deps.cachePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.deps.cachePath)
    } catch (error) {
      try { await unlink(tmp) } catch (cleanup) {
        if (!missing(cleanup)) throw new AggregateError([error, cleanup], 'Storage cache write and temporary-file cleanup failed')
      }
      throw error
    }
  }
}
