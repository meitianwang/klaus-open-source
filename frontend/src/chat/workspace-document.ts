export interface DocumentWriteResult {
  ok?: boolean
  error?: string
  conflict?: boolean
  content?: string
  mtimeMs?: number | null
  truncated?: boolean
}

export interface DocumentSnapshot {
  content: string
  savedContent: string
  mtimeMs: number | null
  saving: boolean
  error: string
  conflict: { content: string; mtimeMs: number | null; truncated?: boolean } | null
}

export interface DocumentOptions {
  content: string
  mtimeMs?: number | null
  delay?: number
  write(content: string, expectedMtimeMs: number | null): Promise<DocumentWriteResult>
  onChange(snapshot: DocumentSnapshot): void
}

/** Serialize captured document revisions; a completed write never acknowledges newer edits. */
export class WorkspaceDocument {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<boolean> | undefined
  private disposed = false
  private value: DocumentSnapshot

  constructor(private readonly options: DocumentOptions) {
    this.value = { content: options.content, savedContent: options.content, mtimeMs: options.mtimeMs ?? null, saving: false, error: '', conflict: null }
  }

  get snapshot(): DocumentSnapshot { return { ...this.value } }
  get dirty(): boolean { return this.value.content !== this.value.savedContent }

  update(content: string): void {
    if (this.disposed || content === this.value.content) return
    this.value.content = content
    this.value.error = ''
    this.emit()
    this.schedule()
  }

  syncExternal(content: string, mtimeMs: number | null): void {
    if (this.disposed) return
    if (content === this.value.savedContent) {
      this.value.mtimeMs = mtimeMs
    } else if (!this.dirty || content === this.value.content) {
      this.value = { ...this.value, content, savedContent: content, mtimeMs, conflict: null, error: '' }
    } else {
      this.clearTimer()
      this.value.conflict = { content, mtimeMs }
    }
    this.emit()
  }

  resolveConflict(choice: 'disk' | 'local'): void {
    const disk = this.value.conflict
    if (!disk) return
    this.value.savedContent = disk.content
    this.value.mtimeMs = disk.mtimeMs
    this.value.conflict = null
    this.value.error = ''
    if (choice === 'disk') this.value.content = disk.content
    this.emit()
    this.schedule()
  }

  flush(): Promise<boolean> {
    this.clearTimer()
    if (this.disposed || this.value.conflict) return Promise.resolve(false)
    if (this.pending) return this.pending
    const pending = this.drain()
    this.pending = pending
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined })
    return pending
  }

  async dispose(discard = false): Promise<boolean> {
    this.clearTimer()
    if (!discard && !await this.flush()) return false
    this.disposed = true
    this.clearTimer()
    return true
  }

  private async drain(): Promise<boolean> {
    while (this.dirty && !this.disposed && !this.value.conflict) {
      const content = this.value.content
      const mtimeMs = this.value.mtimeMs
      this.value.saving = true
      this.value.error = ''
      this.emit()
      let result: DocumentWriteResult
      try { result = await this.options.write(content, mtimeMs) }
      catch (error) { result = { ok: false, error: error instanceof Error ? error.message : String(error) } }
      if (this.disposed) return false
      this.value.saving = false
      if (result.conflict) {
        this.value.conflict = { content: result.content ?? this.value.savedContent, mtimeMs: result.mtimeMs ?? null, truncated: result.truncated }
        this.emit()
        return false
      }
      if (!result.ok) {
        this.value.error = result.error || 'Could not save this file'
        this.emit()
        return false
      }
      this.value.savedContent = content
      this.value.mtimeMs = result.mtimeMs ?? null
      this.emit()
    }
    return !this.dirty && !this.value.conflict
  }

  private schedule(): void {
    this.clearTimer()
    if (this.disposed || !this.dirty || this.value.conflict) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, this.options.delay ?? 3000)
  }

  private clearTimer(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined }
  private emit(): void { this.options.onChange(this.snapshot) }
}
