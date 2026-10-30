import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Json } from '../ipc/contract'
import { toolText } from './cron-tools'

const MAX_CODE_BYTES = 128 * 1024
const MAX_DATA_BYTES = 16 * 1024
const MAX_REVISIONS = 32
const MAX_SESSION_REVISIONS = 256
const MAX_SESSION_WIDGETS = 32
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const inside = (path: string, root: string) => {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Widget arguments must be an object.')
  return value as Record<string, unknown>
}
const text = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max) throw new Error(`${label} must be a non-empty string of at most ${max} bytes.`)
  return value
}

function widgetData(value: unknown): string {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 12) throw new Error('Widget data is too deeply nested.')
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) { if (item.length > 1000) throw new Error('Widget data is too large.'); for (const child of item) visit(child, depth + 1); return }
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Widget data must be plain JSON.')
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Widget data contains an unsafe key.')
      visit(child, depth + 1)
    }
  }
  visit(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > MAX_DATA_BYTES) throw new Error('Widget data is too large.')
  return json.replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export interface WidgetSnapshot {
  kind: 'klaus-widget'
  sessionId: string
  toolCallId: string
  widgetId: string
  title: string
  revision: number
  path: string
  nonce: string
}

export const SHOW_WIDGET_TOOL_SPEC: Json = {
  type: 'function', name: 'show_widget',
  description: 'Show a session-owned interactive HTML widget in the conversation. Use replace with widget_code or a restricted widget_path, or patch one uniquely matching old_html in the previous revision. The widget is sandboxed and cannot send a chat message without the user confirming it.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Stable widget title within this chat.' },
      mode: { type: 'string', enum: ['replace', 'patch'] },
      widget_code: { type: 'string', description: 'Complete HTML or an HTML fragment for replace.' },
      widget_path: { type: 'string', description: 'HTML template in this project .klaus/widgets or user skills directory.' },
      old_html: { type: 'string', description: 'Exact HTML fragment to replace once in a patch.' },
      new_html: { type: 'string', description: 'Replacement HTML fragment for a patch.' },
      data: { type: 'object', description: 'Plain JSON exposed to the widget as __WIDGET_DATA__.' },
    }, required: ['title'], additionalProperties: false,
  },
}

export class WidgetService {
  private readonly calls = new Map<string, WidgetSnapshot>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly configRoot: string, private readonly sessionWorkdir: (sessionId: string) => string) {}

  private async directory(sessionId: string): Promise<string> {
    if (!SESSION_ID.test(sessionId)) throw new Error('Invalid widget session id.')
    const root = join(this.configRoot, 'widgets')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const realRoot = await realpath(root)
    const dir = join(root, sessionId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const realDir = await realpath(dir)
    if (!inside(realDir, realRoot) || relative(realRoot, realDir) !== sessionId) throw new Error('Widget directory escaped its session.')
    return realDir
  }

  private async latest(dir: string, id: string): Promise<{ revision: number; code: string } | null> {
    const files = await readdir(dir)
    const versions = files.map(name => {
      const match = new RegExp(`^${id}-r([0-9]+)-[a-f0-9]{16}\\.source$`).exec(name)
      return match ? { revision: Number(match[1]), name } : null
    }).filter((item): item is { revision: number; name: string } => !!item && item.revision <= MAX_REVISIONS)
      .sort((a, b) => b.revision - a.revision)
    for (const item of versions) {
      const source = join(dir, item.name)
      const html = source.slice(0, -'.source'.length) + '.html'
      try {
        if (await realpath(source) !== source || await realpath(html) !== html) continue
        const info = await stat(html)
        if (!info.isFile() || info.size > MAX_CODE_BYTES * 2) continue
        const code = await readFile(source, 'utf8')
        if (Buffer.byteLength(code, 'utf8') <= MAX_CODE_BYTES) return { revision: item.revision, code }
      } catch { /* Incomplete snapshots are not a revision. */ }
    }
    return null
  }

  private async template(sessionId: string, value: string): Promise<string> {
    const workdir = this.sessionWorkdir(sessionId)
    const roots = [join(workdir, '.klaus', 'widgets'), join(this.configRoot, 'skills')]
    const candidate = isAbsolute(value) ? value : resolve(workdir, value)
    const realFile = await realpath(candidate)
    if (!realFile.toLowerCase().endsWith('.html')) throw new Error('Widget templates must be HTML files.')
    let permitted = false
    for (const root of roots) {
      try { if (inside(realFile, await realpath(root))) permitted = true } catch { /* An absent root cannot grant access. */ }
    }
    if (!permitted) throw new Error('Widget template is outside an allowed directory.')
    const info = await stat(realFile)
    if (!info.isFile() || info.size > MAX_CODE_BYTES) throw new Error('Widget template is not a small regular file.')
    return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(realFile))
  }

  private wrapper(code: string, data: string, snapshot: Omit<WidgetSnapshot, 'path'>): string {
    const context = JSON.stringify({ sessionId: snapshot.sessionId, widgetId: snapshot.widgetId, revision: snapshot.revision, nonce: snapshot.nonce })
    const bridge = `<script>window.__WIDGET_DATA__=${data};window.sendToAgent=function(data,options){parent.postMessage({type:'klaus-widget:send',context:${context},data:data,options:options||{}},'*')};</script>`
    return /<head(?:\s[^>]*)?>/i.test(code) ? code.replace(/<head(?:\s[^>]*)?>/i, match => match + bridge) : bridge + code
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve()
    const work = before.catch(() => {}).then(action)
    this.locks.set(key, work)
    try { return await work } finally { if (this.locks.get(key) === work) this.locks.delete(key) }
  }

  async run(args: Json, sessionId: string, toolCallId: string): Promise<Json> {
    const fields = object(args)
    const title = text(fields.title, 'Widget title', 128).trim()
    const id = sha(title)
    const callKey = `${sessionId}:${toolCallId}`
    const previous = this.calls.get(callKey)
    if (previous) return toolText(JSON.stringify(previous), true)
    return this.withLock(`${sessionId}:${id}`, async () => {
      const dir = await this.directory(sessionId)
      const latest = await this.latest(dir, id)
      const sources = (await readdir(dir)).filter(name => /^[a-f0-9]{64}-r[0-9]+-[a-f0-9]{16}\.source$/.test(name))
      if (sources.length >= MAX_SESSION_REVISIONS || !latest
        && new Set(sources.map(name => name.slice(0, 64))).size >= MAX_SESSION_WIDGETS) {
        throw new Error('Widget storage limit reached for this conversation.')
      }
      const mode = fields.mode ?? 'replace'
      let code: string
      if (mode === 'replace') {
        if ((fields.widget_code === undefined) === (fields.widget_path === undefined)) throw new Error('Replace requires exactly one of widget_code or widget_path.')
        code = fields.widget_path === undefined ? text(fields.widget_code, 'widget_code', MAX_CODE_BYTES)
          : await this.template(sessionId, text(fields.widget_path, 'widget_path', 2048))
      } else if (mode === 'patch') {
        if (!latest || fields.widget_code !== undefined || fields.widget_path !== undefined) throw new Error('Patch requires a previous revision and no replacement template.')
        const oldHtml = text(fields.old_html, 'old_html', MAX_CODE_BYTES)
        const newHtml = typeof fields.new_html === 'string' ? fields.new_html : ''
        if (Buffer.byteLength(newHtml, 'utf8') > MAX_CODE_BYTES || latest.code.split(oldHtml).length !== 2) throw new Error('old_html must appear exactly once, and new_html must be small.')
        code = latest.code.replace(oldHtml, newHtml)
      } else throw new Error('Widget mode must be replace or patch.')
      if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) throw new Error('Widget HTML is too large.')
      const revision = (latest?.revision ?? 0) + 1
      if (revision > MAX_REVISIONS) throw new Error('Widget revision limit reached.')
      const data = widgetData(fields.data ?? {})
      const nonce = randomBytes(24).toString('base64url')
      const identity = { kind: 'klaus-widget' as const, sessionId, toolCallId, widgetId: id, title, revision, nonce }
      const html = this.wrapper(code, data, identity)
      if (Buffer.byteLength(html, 'utf8') > MAX_CODE_BYTES * 2) throw new Error('Widget snapshot is too large.')
      const prefix = `${id}-r${revision}-${sha(html).slice(0, 16)}`
      const path = join(dir, `${prefix}.html`)
      const snapshot: WidgetSnapshot = { ...identity, path }
      await writeFile(join(dir, `${prefix}.source`), code, { flag: 'wx', mode: 0o600 })
      await writeFile(path, html, { flag: 'wx', mode: 0o600 })
      this.calls.set(callKey, snapshot)
      return toolText(JSON.stringify(snapshot), true)
    })
  }

  async snapshotPath(sessionId: string, widgetId: string, revision: number, path: string): Promise<{ path: string; root: string; currentRevision: number }> {
    const root = await this.directory(sessionId)
    if (!/^[a-f0-9]{64}$/.test(widgetId) || !Number.isSafeInteger(revision) || revision < 1 || revision > MAX_REVISIONS || typeof path !== 'string') throw new Error('Invalid widget snapshot request.')
    const canonical = await realpath(path)
    const name = relative(root, canonical)
    const match = new RegExp(`^${widgetId}-r${revision}-([a-f0-9]{16})\\.html$`).exec(name)
    if (!inside(canonical, root) || !match) throw new Error('Widget snapshot does not belong to this session and revision.')
    const info = await stat(canonical)
    if (!info.isFile() || info.size > MAX_CODE_BYTES * 2) throw new Error('Widget snapshot is unavailable or too large.')
    if (sha(await readFile(canonical)).slice(0, 16) !== match[1]) throw new Error('Widget snapshot was modified.')
    const latest = await this.latest(root, widgetId)
    if (!latest) throw new Error('Widget has no complete revision.')
    return { path: canonical, root, currentRevision: latest.revision }
  }

  releaseSession(sessionId: string): void {
    for (const [key, call] of this.calls) if (call.sessionId === sessionId) this.calls.delete(key)
  }
}
