export interface SpecDocument {
  sessionId: string
  path: string
  title: string
  content: string
  streaming: boolean
  error: string
  revision: number
}

export interface SpecDocumentEvent {
  type: string
  sessionId: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  delta?: string
  isError?: boolean
  terminal?: boolean
}

interface WriteOperation {
  sessionId: string
  name: string
  json: string
  args: Record<string, unknown>
  path?: string
  hasDraft: boolean
  patchPaths?: string[]
}

export const specPathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/$/, '')
export const specDocumentKey = (sessionId: string, path: string) => JSON.stringify([sessionId, specPathKey(path)])
export const specDocumentName = (path: string) => specPathKey(path).split('/').pop() || 'Spec'
export const isSpecDocumentPath = (path: string) => /(?:^|\/)\.klaus\/(?:specs|plans)\/.+\.md$/i.test(specPathKey(path))
const nameKey = (name: string) => (name.split(/[.:/]/).pop() || '').toLowerCase().replace(/[^a-z]/g, '')
const writerNames = new Set(['write', 'writefile', 'createfile', 'edit', 'editfile', 'multiedit', 'applypatch', 'editdesign', 'updatedesign', 'createspec', 'createplan'])
const specNames = new Set(['createspec', 'createplan', 'editdesign', 'updatedesign', 'exitplanmode', 'switchmode'])
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Decode completed string characters without inventing a truncated escape. */
export function partialJsonString(json: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(json)
  if (!match) return undefined
  let value = ''
  for (let i = match.index + match[0].length; i < json.length; i++) {
    const char = json[i]
    if (char === '"') return value
    if (char !== '\\') { value += char; continue }
    if (++i >= json.length) break
    if (json[i] === 'u') {
      const hex = json.slice(i + 1, i + 5)
      if (!/^[\da-f]{4}$/i.test(hex)) break
      value += String.fromCharCode(parseInt(hex, 16)); i += 4
    } else {
      const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }
      if (!(json[i] in escapes)) break
      value += escapes[json[i]]
    }
  }
  return value
}

function stringField(operation: WriteOperation, keys: string[]): string | undefined {
  for (const key of keys) {
    const partial = partialJsonString(operation.json, key)
    if (partial !== undefined) return partial
    if (typeof operation.args[key] === 'string') return operation.args[key] as string
  }
  return undefined
}

export interface SpecDocumentModelOptions {
  read(path: string): Promise<{ content?: string; error?: unknown } | undefined>
  resolvePath?(sessionId: string, path: string): string
  onChange?(): void
  onDiscover?(document: SpecDocument): void
  schedulePoll?(callback: () => void): () => void
}

/** A session-scoped document registry; approval state remains engine-owned. */
export class SpecDocumentModel {
  private documents = new Map<string, SpecDocument>()
  private writes = new Map<string, WriteOperation>()
  private readVersions = new Map<string, number>()
  private stopPolling: (() => void) | undefined
  private disposed = false

  constructor(private options: SpecDocumentModelOptions) {}

  resolvePath(sessionId: string, path: string): string {
    return specPathKey(this.options.resolvePath?.(sessionId, path) || path)
  }

  list(sessionId: string): SpecDocument[] {
    return [...this.documents.values()].filter(document => document.sessionId === sessionId)
  }

  get(sessionId: string, path: string): SpecDocument | undefined {
    return this.documents.get(specDocumentKey(sessionId, this.resolvePath(sessionId, path)))
  }

  register(sessionId: string, path: string, patch: Partial<Pick<SpecDocument, 'title' | 'content' | 'streaming'>> = {}): SpecDocument {
    path = this.resolvePath(sessionId, path)
    const key = specDocumentKey(sessionId, path)
    const existing = this.documents.get(key)
    const document = existing || { sessionId, path: specPathKey(path), title: specDocumentName(path), content: '', streaming: false, error: '', revision: 0 }
    if (patch.content !== undefined && patch.content !== document.content) { document.revision++; document.error = '' }
    Object.assign(document, patch)
    this.documents.set(key, document)
    this.options.onChange?.()
    return document
  }

  async refresh(sessionId: string, path: string): Promise<void> {
    path = this.resolvePath(sessionId, path)
    const key = specDocumentKey(sessionId, path)
    const document = this.get(sessionId, path)
    if (!document || this.disposed) return
    const request = (this.readVersions.get(key) || 0) + 1
    this.readVersions.set(key, request)
    const revision = document.revision
    try {
      const result = await this.options.read(document.path)
      if (!result || result.error) throw new Error(String(result?.error || 'Unable to read Spec document'))
      if (!this.isCurrent(key, document, request, revision)) return
      if (this.hasDraft(sessionId, path)) return
      const content = typeof result.content === 'string' ? result.content : ''
      if (content !== document.content) { document.content = content; document.revision++ }
      document.error = ''
    } catch (error) {
      if (!this.isCurrent(key, document, request, revision)) return
      if (!document.streaming) document.error = error instanceof Error ? error.message : String(error)
    }
    if (!this.disposed) this.options.onChange?.()
  }

  private isCurrent(key: string, document: SpecDocument, request: number, revision: number) {
    return !this.disposed && this.documents.get(key) === document && this.readVersions.get(key) === request && document.revision === revision
  }

  private hasDraft(sessionId: string, path: string) {
    return [...this.writes.values()].some(write => write.sessionId === sessionId && write.path === this.resolvePath(sessionId, path) && write.hasDraft)
  }

  onEvent(event: SpecDocumentEvent) {
    if (this.disposed || !event.sessionId) return
    const id = JSON.stringify([event.sessionId, event.toolCallId])
    if (event.type === 'tool_start' && event.toolCallId) {
      const name = nameKey(event.toolName || '')
      if (!writerNames.has(name) && !specNames.has(name)) return
      const write = { sessionId: event.sessionId, name, args: object(event.args), json: typeof event.args === 'string' ? event.args : '', hasDraft: false }
      this.writes.set(id, write)
      this.updateWrite(write)
    } else if (event.type === 'tool_input_delta') {
      const write = this.writes.get(id)
      if (write) {
        const delta = event.delta || ''
        // The host publishes complete argument snapshots. True transport
        // fragments are still accepted while their JSON is incomplete.
        try {
          const snapshot: unknown = JSON.parse(delta)
          if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Not an argument snapshot')
          write.args = { ...write.args, ...object(snapshot) }
          write.json = delta
        } catch {
          write.json += delta
        }
        this.updateWrite(write)
      }
    } else if (event.type === 'tool_end') {
      const write = this.writes.get(id)
      this.writes.delete(id)
      if (write) this.finishWrite(write)
    } else if (event.type === 'done' || event.type === 'interrupted' || event.type === 'session_closed' || (event.type === 'api_error' && event.terminal)) {
      for (const [key, write] of this.writes) {
        if (write.sessionId !== event.sessionId) continue
        this.writes.delete(key)
        this.finishWrite(write)
      }
    }
    this.syncPolling()
  }

  private updateWrite(write: WriteOperation) {
    if (write.name === 'applypatch') {
      const patch = stringField(write, ['patch', 'input']) || write.json
      const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map(match => this.resolvePath(write.sessionId, match[1].trim()))
        .filter(path => this.get(write.sessionId, path) || isSpecDocumentPath(path))
      write.patchPaths = [...new Set(paths)]
      for (const path of write.patchPaths) {
        const existing = this.get(write.sessionId, path)
        const document = this.register(write.sessionId, path, { streaming: true })
        if (!existing) this.options.onDiscover?.(document)
        void this.refresh(write.sessionId, path)
      }
      return
    }
    const rawPath = stringField(write, ['specFilePath', 'spec_file_path', 'planFilePath', 'plan_file_path', 'file_path', 'filePath', 'path'])
    // A partial path must not create a second document for every character.
    if (!rawPath || !/\.md$/i.test(rawPath)) return
    const path = this.resolvePath(write.sessionId, rawPath)
    const existing = this.get(write.sessionId, path)
    if (!existing && !isSpecDocumentPath(path) && !specNames.has(write.name)) return
    write.path = path
    const canWrite = writerNames.has(write.name)
    const content = ['write', 'writefile', 'createfile', 'createspec', 'createplan'].includes(write.name)
      ? stringField(write, ['content', 'text', 'plan', 'markdown']) : undefined
    write.hasDraft = canWrite && content !== undefined
    const document = this.register(write.sessionId, path, { streaming: canWrite, ...(content !== undefined ? { content } : {}) })
    if (!existing) this.options.onDiscover?.(document)
    if (!write.hasDraft) void this.refresh(write.sessionId, path)
  }

  private finishWrite(write: WriteOperation) {
    for (const path of write.patchPaths || (write.path ? [write.path] : [])) {
      const document = this.get(write.sessionId, path)
      if (!document) continue
      document.streaming = [...this.writes.values()].some(other => other.sessionId === write.sessionId && (other.path === path || other.patchPaths?.includes(path)) && writerNames.has(other.name))
      this.options.onChange?.()
      void this.refresh(write.sessionId, path)
    }
  }

  private syncPolling() {
    const active = [...this.writes.values()].some(write => (write.path || write.patchPaths?.length) && !write.hasDraft && writerNames.has(write.name))
    if (!active) { this.stopPolling?.(); this.stopPolling = undefined; return }
    if (this.stopPolling) return
    const poll = () => {
      const paths = new Set<string>()
      for (const write of this.writes.values()) {
        if (write.hasDraft || !writerNames.has(write.name)) continue
        for (const path of write.patchPaths || (write.path ? [write.path] : [])) {
          const key = specDocumentKey(write.sessionId, path)
          if (paths.has(key)) continue
          paths.add(key)
          void this.refresh(write.sessionId, path)
        }
      }
    }
    this.stopPolling = this.options.schedulePoll?.(poll) || (() => {
      const timer = setInterval(poll, 500)
      return () => clearInterval(timer)
    })()
  }

  dispose() {
    this.disposed = true
    this.stopPolling?.()
    this.writes.clear()
    this.documents.clear()
    this.readVersions.clear()
  }
}

export function findSpecMatches(text: string, query: string): Array<{ start: number; end: number }> {
  if (!query) return []
  const lower = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const matches = []
  for (let start = lower.indexOf(needle); start >= 0; start = lower.indexOf(needle, start + needle.length)) matches.push({ start, end: start + needle.length })
  return matches
}

export const isNearSpecBottom = (scrollHeight: number, clientHeight: number, scrollTop: number) => Math.abs(scrollHeight - clientHeight - scrollTop) <= 12
