// Session-scoped Markdown rendering shares one pipeline for live and saved text.
// Settled HTML is bounded by bytes and count; live parsing runs in a worker and
// retains only each message's stable prefix.
import { Marked } from 'marked'
import { ByteBudgetLru } from './byte-budget'
import { normalizeImageHrefToPath, resolveImageSrc } from './markdown-media'
import { createMarkdownPipeline } from './markdown-pipeline'
import { fileExtension } from '../../../contracts/file-citation'
import { fileIconSvg } from './file-icon'

function escapeHtml(str: unknown): string {
  return str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : ''
}

export { normalizeImageHrefToPath, resolveImageSrc } from './markdown-media'

// 三个函数共用同一套 markdown 图 token 解析（覆盖 file://、尖括号、title 写法）。
// `hrefRaw` 是括号里的原样内容，尖括号写法要先脱壳。
const DOUBLE_TILDE_STRIKETHROUGH = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/
const imageLexer = new Marked({
  gfm: true,
  tokenizer: {
    del(src: string) {
      const cap = DOUBLE_TILDE_STRIKETHROUGH.exec(src)
      if (!cap) return undefined
      return { type: 'del', raw: cap[0], text: cap[2], tokens: this.lexer.inlineTokens(cap[2]) } as any
    },
  },
})
type ImageToken = { raw: string; href: string; text: string; title?: string | null }

// Use Markdown tokens so reference images work and examples inside code remain
// literal. Protected raw spans include their delimiters, not just their text.
function imageSpans(text: string): Array<{ start: number; end: number; token: ImageToken }> {
  const images: ImageToken[] = []
  const protectedRaw: string[] = []
  imageLexer.walkTokens(imageLexer.lexer(text), token => {
    if (token.type === 'image') images.push(token as ImageToken)
    if (token.type === 'code' || token.type === 'codespan' || token.type === 'html') protectedRaw.push(token.raw)
  })
  const protectedSpans: Array<[number, number]> = []
  for (const raw of protectedRaw) {
    if (!raw) continue
    for (let at = text.indexOf(raw); at >= 0; at = text.indexOf(raw, at + raw.length)) protectedSpans.push([at, at + raw.length])
  }
  const spans = new Map<number, { start: number; end: number; token: ImageToken }>()
  for (const token of images) {
    if (!token.raw) continue
    for (let at = text.indexOf(token.raw); at >= 0; at = text.indexOf(token.raw, at + token.raw.length)) {
      if (!protectedSpans.some(([start, end]) => at >= start && at < end)) spans.set(at, { start: at, end: at + token.raw.length, token })
    }
  }
  return [...spans.values()].sort((a, b) => a.start - b.start)
}

function rewriteImages(text: string, replace: (token: ImageToken) => string): string {
  const spans = imageSpans(text)
  let end = 0
  let result = ''
  for (const span of spans) {
    if (span.start < end) continue
    result += text.slice(end, span.start) + replace(span.token)
    end = span.end
  }
  return result + text.slice(end)
}

// 工具卡已经把同一路径的图出进正文层时，模型在回答里再贴 `![](同路径)` 会
// 让同一张图渲染两遍。渲染正文前把这些重复的 markdown 图 token 剥掉；
// 工具结果没带图的回合集合为空，原样返回，markdown 仍是兜底出图通道。
export function stripMarkdownImagesForPaths(text: string, paths: ReadonlySet<string>): string {
  if (!text || !paths || paths.size === 0) return text
  return rewriteImages(text, token => {
    const path = normalizeImageHrefToPath(token.href)
    return path && paths.has(path) ? '' : token.raw
  })
}

// 收正文里 markdown 图的本地路径集合。用途是工具卡让位判定：最终回复已嵌
// 同路径的图时工具卡不再出产物图（工具卡会进回合折叠，最终回复才是恒可见面）。
const imagePathCache = new ByteBudgetLru<string, readonly string[]>(2 * 1024 * 1024, 512)

export function collectMarkdownImagePaths(text: string): Set<string> {
  // Every Markdown image includes an exclamation mark, including reference images.
  if (!text.includes('!')) return new Set()
  const cached = imagePathCache.get(text)
  if (cached) return new Set(cached)
  const paths = new Set<string>()
  for (const { token } of imageSpans(text)) {
    const path = normalizeImageHrefToPath(token.href)
    if (path) paths.add(path)
  }
  const values = [...paths]
  imagePathCache.set(text, values, text.length * 2 + values.reduce((bytes, path) => bytes + path.length * 2 + 8, 24))
  imagePathCache.trim()
  return paths
}

/** Aliases come only from the bytes paired with an exact tool-reported saved path. */
export function collectImageSourceAliases(items: Iterable<{ path?: string; sourcePath?: string }>): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const item of items) {
    if (!item.path || !item.sourcePath) continue
    const prior = aliases.get(item.sourcePath)
    aliases.set(item.sourcePath, prior === undefined || prior === item.path ? item.path : '')
  }
  return aliases
}

function escapedImageHref(path: string): string {
  const windowsPath = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(path)
  if (!windowsPath && !/[%?#<>]/.test(path)) return /[()\s]/.test(path) ? `<${path}>` : path
  const normalized = windowsPath ? path.replace(/\\/g, '/') : path
  const prefix = normalized.startsWith('//') ? 'file:' : /^[a-zA-Z]:\//.test(normalized) ? 'file:///' : 'file://'
  return `<${prefix}${encodeURI(normalized).replace(/[?#]/g, char => encodeURIComponent(char))}>`
}

/**
 * Rewrite relative image hrefs and recovered source paths in `text`, using the paths
 * this turn's tools actually produced. An absolute reference whose parent directory
 * was mistyped can also recover through a unique confirmed basename; ambiguous names
 * remain untouched rather than guessing which image the reply meant.
 *
 * Why: a model that just generated an image often writes `![](image-178997….png)`
 * — the bare filename it saw in the tool result — instead of the absolute path.
 * `resolveImageSrc` cannot resolve a relative href (a pure render pipeline has no
 * base directory), so the final answer showed only its alt text: a sentence where
 * the picture should be, with the picture itself left inside the folded tool card.
 *
 * The rewrite is limited to paths THIS TURN'S TOOLS reported, which is what keeps
 * it safe without needing a base directory: a rewritten href only ever points at a
 * file a tool already said it wrote, so it cannot invent a broken image. Matching
 * is by basename, and a basename produced in two different places is left alone
 * rather than guessed at — an unresolvable relative href still renders its alt
 * text, which is the honest outcome.
 *
 * Rewriting the TEXT (rather than teaching the renderer to resolve) keeps the
 * markdown pipeline free of session state: the renderer stays a pure
 * text-to-HTML function, and the turn-scoped knowledge stays with the caller
 * that has it. It also makes the resolved path visible in the copy source.
 */
export function resolveRelativeImagePaths(text: string, produced: ReadonlySet<string>, aliases: ReadonlyMap<string, string> = new Map()): string {
  if (!text || !produced || produced.size === 0) return text
  // basename → the one absolute path carrying it, or '' when two paths share the
  // name and the choice would be a guess.
  const byName = new Map<string, string>()
  const addName = (path: string, target: string) => {
    const name = path.split(/[\\/]/).pop() || ''
    if (!name) return
    const prior = byName.get(name)
    byName.set(name, prior === undefined || prior === target ? target : '')
  }
  for (const path of produced) if (path) addName(path, path)
  for (const [source, path] of aliases) if (path && produced.has(path)) addName(source, path)
  if (byName.size === 0) return text
  return rewriteImages(text, token => {
    const raw = token.href
    const absolute = normalizeImageHrefToPath(raw)
    if (/^(?:https?:|blob:|data:)/i.test(raw)) return token.raw
    let decoded = raw.trim()
    try { decoded = decodeURIComponent(decoded) } catch { /* A malformed escape keeps its raw spelling. */ }
    const exactAlias = absolute ? aliases.get(absolute) : undefined
    const resolved = exactAlias && produced.has(exactAlias)
      ? exactAlias
      : byName.get((absolute || decoded).split(/[\\/]/).pop() || '')
    if (!resolved) return token.raw
    // A bare href ends at the first space or paren, so an absolute path carrying
    // one (`/Users/me/My Documents/a.png`, which is what the model's own
    // workspace paths look like) would be truncated by the markdown parser and
    // render a broken image. The angle-bracket form is CommonMark's escape for
    // exactly that; it stays off when the path needs no escaping, so the common
    // case keeps the clean spelling a user copies out of the message.
    const href = escapedImageHref(resolved)
    // Splice by index instead of a second replace: a path containing `$` is
    // otherwise read as a replacement pattern.
    const alt = token.text.replace(/([\\\[\]])/g, '\\$1')
    const title = token.title ? ` "${token.title.replace(/([\\"])/g, '\\$1')}"` : ''
    return `![${alt}](${href}${title})`
  })
}

/**
 * Which of `candidates` (paths this turn produced) the final reply actually
 * REPORTS, by naming them — full path or bare filename, anywhere in its text.
 *
 * This is the gate between a deliverable and a process artifact. A turn writes
 * many files and emits many images; only the ones the reply puts in front of the
 * user are things the user was told about, so only those belong on the turn's
 * always-visible end. Everything else stays where process work stays: inside the
 * folded tool card, one expansion away. Matching is a plain substring test on the
 * path and on its basename, bounded to this turn's own produced set, so it cannot
 * promote a file the turn never touched; a basename that also appears in prose
 * about something else is the accepted cost of reading the reply the way a user
 * does.
 */
export function collectReportedPaths(text: string, candidates: ReadonlySet<string>, aliases: ReadonlyMap<string, string> = new Map()): Set<string> {
  const reported = new Set<string>()
  if (!text || !candidates || candidates.size === 0) return reported
  for (const path of candidates) {
    if (!path) continue
    if (text.includes(path)) { reported.add(path); continue }
    const name = path.split(/[\\/]/).pop() || ''
    if (name && text.includes(name)) reported.add(path)
  }
  for (const [source, path] of aliases) {
    if (!path || !candidates.has(path)) continue
    const name = source.split(/[\\/]/).pop() || ''
    if (text.includes(source) || name && text.includes(name)) reported.add(path)
  }
  return reported
}

/** Cache settled HTML by source and rendering scope, under an explicit byte budget. */
export interface MarkdownMemoizedRenderer {
  (text: unknown): string
  prime(text: string, html: string): void
  cached(text: string): string | undefined
  forget(predicate: (key: string) => boolean): void
  stats(): { entries: number; bytes: number; maxBytes: number }
}

export function createMarkdownMemoizer(rawRender: (text: string) => string, max?: number, keyFn?: (text: string) => string, maxBytes = 16 * 1024 * 1024): MarkdownMemoizedRenderer {
  const cache = new ByteBudgetLru<string, string>(maxBytes, typeof max === 'number' && max > 0 ? max : 500)
  const keys = new Set<string>()
  const prime = (key: string, html: string) => {
    const bytes = 48 + (key.length + html.length) * 2
    if (bytes > maxBytes) return
    cache.set(key, html, bytes)
    keys.add(key)
    for (const [evicted] of cache.trim()) keys.delete(evicted)
  }
  const render = (text: unknown) => {
    const source = typeof text === 'string' ? text : String(text == null ? '' : text)
    const key = keyFn ? keyFn(source) : source
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const html = rawRender(source)
    prime(key, html)
    return html
  }
  return Object.assign(render, {
    prime(text: string, html: string) { prime(keyFn ? keyFn(text) : text, html) },
    cached(text: string) { return cache.get(keyFn ? keyFn(text) : text) },
    forget(predicate: (key: string) => boolean) {
      for (const key of keys) if (predicate(key)) { cache.delete(key); keys.delete(key) }
    },
    stats: () => ({ entries: cache.size, bytes: cache.bytes, maxBytes: cache.maxBytes }),
  })
}

export function buildPipeline(sessionId: string) {
  return createMarkdownPipeline(sessionId, { resolveImageSrc, fileIconSvg })
}

const previewPipelines = new Map<string, ReturnType<typeof createMarkdownPipeline>>()
/** Preserve first-paint Markdown layout while expensive code coloring is pending. */
export function renderMarkdownPreview(source: string, sessionId: string): string {
  let pipeline = previewPipelines.get(sessionId)
  if (!pipeline) {
    pipeline = createMarkdownPipeline(sessionId, { resolveImageSrc, fileIconSvg, highlightCode: false })
    previewPipelines.set(sessionId, pipeline)
    if (previewPipelines.size > 8) previewPipelines.delete(previewPipelines.keys().next().value!)
  }
  return pipeline(source)
}

// Memoize markdown rendering by raw text. Switching sessions re-renders the
// whole transcript and historical messages never change, so caching skips
// repeated marked + KaTeX + highlight.js passes on long conversations.
// The key carries the session on screen: local-image URLs are minted with the
// current session's scope (see resolveImageSrc → klaus.media.url), so the same
// text rendered under another session must not reuse a cache entry whose URLs
// were scoped to the previous one.
const pipelines = new Map<string, (text: string) => string>()
const renderScoped = createMarkdownMemoizer(key => {
  const [sessionId, source] = JSON.parse(key) as [string, string]
  let pipeline = pipelines.get(sessionId)
  if (!pipeline) {
    pipeline = buildPipeline(sessionId)
    pipelines.set(sessionId, pipeline)
    if (pipelines.size > 16) pipelines.delete(pipelines.keys().next().value!)
  }
  return pipeline(source)
}, 500)

export function renderMarkdownHtml(text: unknown, sessionId?: string): string {
  const owner = sessionId ?? (typeof window !== 'undefined' ? (window as unknown as { currentSessionId?: string }).currentSessionId : '') ?? ''
  const source = typeof text === 'string' ? text : String(text ?? '')
  return renderScoped(JSON.stringify([owner, source]))
}

/** Worker results seed the same settled cache, so history handoff does not parse twice. */
export function primeMarkdownHtml(text: string, sessionId: string, html: string): void {
  renderScoped.prime(JSON.stringify([sessionId, text]), html)
}

/** Read settled HTML without parsing or replacing it with a structural preview. */
export function cachedMarkdownHtml(text: string, sessionId: string): string | undefined {
  return renderScoped.cached(JSON.stringify([sessionId, text]))
}

export function forgetMarkdownSession(sessionId: string): void {
  pipelines.delete(sessionId)
  previewPipelines.delete(sessionId)
  renderScoped.forget(key => { try { return JSON.parse(key)[0] === sessionId } catch { return false } })
}

export function markdownCacheStats() { return renderScoped.stats() }

/** React 组件消费口：历史消息不可变，按原文记忆化后直接同步返回 HTML。 */
export function useMarkdown(text: string, sessionId?: string): string {
  return renderMarkdownHtml(text, sessionId)
}

export { setMarkdownWorkerFactory, waitForMarkdownWorkerIdle, markdownWorkerStats } from './markdown-async'
