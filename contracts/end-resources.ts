// Turn-end resources: the deliverables a completed turn hands back to the user.
//
// A turn ends with at most one family of resource cards, chosen from what the
// final reply and the turn's own file edits actually say:
//
//   1. Files. A final reply that cites a produced document, spreadsheet,
//      presentation, PDF or image through the file-citation directive, or that
//      links a local .docx/.pdf/.tex/.pptx/.xlsx, gets one file card per path.
//   2. Otherwise a website, when the final reply names exactly one local URL
//      with an explicit port (a dev server the turn started).
//   3. Otherwise a website, when the turn edited exactly one HTML page.
//
// Web links to the open internet are citations, not deliverables, and never
// become resources. An unfinished turn has no resources at all: the projection
// runs only once the turn settled as completed or failed.
//
// Pure module shared by the transcript cards, the changed-files card, the
// overview panel and the turn navigation preview, so every surface agrees on
// the same list.

import { parseFileCiteDirectives, parseFileCitation, fileExtension } from './file-citation'

export type EndResource =
  | { type: 'file'; path: string }
  | { type: 'website'; target: string }

/** Extensions a file-citation directive surfaces as a file card. */
export const CITED_OUTPUT_EXTENSIONS = new Set(['avif', 'csv', 'doc', 'docx', 'gif', 'jpeg', 'jpg', 'md', 'mdx', 'pdf', 'png', 'ppt', 'pptx', 'tsv', 'webp', 'xls', 'xlsm', 'xlsx'])
/** Extensions a plain markdown link surfaces as a file card. */
export const LINKED_OUTPUT_EXTENSIONS = new Set(['docx', 'pdf', 'tex', 'pptx', 'xlsx'])
/** Office documents whose "Open in" menu marks the system default application. */
export const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsm', 'xlsx'])
/** More than this many resources collapse behind a "Show N more" row. */
export const END_RESOURCE_VISIBLE_LIMIT = 4
export const END_RESOURCE_COLLAPSED_COUNT = 3

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'])
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>)"'`]+/gi
const TRAILING_PUNCTUATION = /[.,;!?]+$/u
const BRACKETS_IN_PATH = /[()[\]]/u
const HTML_PAGE = /\.html?$/i
// The conversation's own inline-visualization pages are rendered inline by
// their directive; they are never a deliverable of the turn that wrote them.
const VISUALIZATION_PAGE = /(?:^|[\\/])\.klaus[\\/]visualizations[\\/][A-Za-z0-9_-]+[\\/][a-z0-9]+(?:-[a-z0-9]+)*\.html$/

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host.endsWith('.localhost') || LOCAL_HOSTS.has(host)
}

/** An http(s) URL on this machine: loopback, unspecified or *.localhost. */
export function isLocalWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLocalHostname(url.hostname)
  } catch { return false }
}

/** A website resource target is either a local URL or a file path. */
export function isUrlTarget(target: string): boolean {
  return /^https?:\/\//i.test(target)
}

/**
 * The single local URL with an explicit port that a reply names, or null.
 *
 * Scans the raw reply text, so a URL inside a code span still counts: a dev
 * server address is usually quoted. Two distinct addresses are ambiguous and
 * yield nothing; so does an address without a port, because a bare
 * `http://localhost/` is not a server the turn started.
 */
export function singleLocalServerUrl(text: string | null | undefined): string | null {
  if (!text) return null
  const found = new Set<string>()
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, '')
    let url: URL
    try { url = new URL(candidate) } catch { continue }
    if (BRACKETS_IN_PATH.test(`${url.pathname}${url.search}${url.hash}`) || url.port.length === 0) continue
    if (!isLocalWebUrl(url.href)) continue
    found.add(url.href)
  }
  return found.size === 1 ? found.values().next().value ?? null : null
}

export interface LinkSpan {
  label: string
  destination: string
  syntax: 'link' | 'image' | 'inline-code'
  /** Character offsets of the link in its line. */
  start: number
  end: number
  line: number
}

function fenceMarker(line: string): '`' | '~' | null {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
  return match ? (match[1]!.startsWith('`') ? '`' : '~') : null
}

function skipSpaces(text: string, index: number): number {
  let cursor = index
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++
  return cursor
}

const ESCAPABLE = new Set(' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~')

function closeAfterTitle(text: string, index: number, value: string): { value: string; nextIndex: number } | null {
  let cursor = skipSpaces(text, index)
  while (cursor < text.length) {
    const char = text[cursor]!
    if (char === '\n' || char === '\r') break
    if (char === '\\') { cursor += text[cursor + 1] == null ? 1 : 2; continue }
    if (char === ')') return { value, nextIndex: cursor + 1 }
    cursor++
  }
  return null
}

function readDestination(text: string, index: number): { value: string; nextIndex: number } | null {
  let cursor = skipSpaces(text, index)
  if (text[cursor] === '<') {
    const parts: string[] = []
    cursor++
    while (cursor < text.length) {
      const char = text[cursor]!
      if (char === '\n' || char === '\r') break
      if (char === '\\' && ESCAPABLE.has(text[cursor + 1] ?? '')) { parts.push(text[cursor + 1]!); cursor += 2; continue }
      if (char === '>') return closeAfterTitle(text, cursor + 1, parts.join('').trim())
      parts.push(char)
      cursor++
    }
    return null
  }
  const parts: string[] = []
  let depth = 0
  while (cursor < text.length) {
    const char = text[cursor]!
    if (char === '\n' || char === '\r') break
    if (char === '\\' && ESCAPABLE.has(text[cursor + 1] ?? '')) { parts.push(text[cursor + 1]!); cursor += 2; continue }
    if (char === '(') { depth++; parts.push(char); cursor++; continue }
    if (char === ')') {
      if (depth === 0) return { value: parts.join('').trim(), nextIndex: cursor + 1 }
      depth--; parts.push(char); cursor++; continue
    }
    if ((char === ' ' || char === '\t') && depth === 0) {
      const next = text[skipSpaces(text, cursor)]
      if (next === '"' || next === "'" || next === '(') return closeAfterTitle(text, cursor, parts.join('').trim())
    }
    parts.push(char)
    cursor++
  }
  return null
}

/** Parse `[label](destination)` starting at the opening bracket. */
function readLink(text: string, index: number): { label: string; destination: string; nextIndex: number } | null {
  const label: string[] = []
  let depth = 0
  let cursor = index + 1
  let labelEnd = -1
  while (cursor < text.length) {
    const char = text[cursor]!
    if (char === '\n' || char === '\r') break
    if (char === '\\') { label.push(text[cursor + 1] ?? char); cursor += text[cursor + 1] == null ? 1 : 2; continue }
    if (char === '[') { depth++; label.push(char); cursor++; continue }
    if (char === ']') {
      if (depth === 0) { labelEnd = cursor + 1; break }
      depth--; label.push(char); cursor++; continue
    }
    label.push(char)
    cursor++
  }
  if (labelEnd < 0 || text[labelEnd] !== '(') return null
  const destination = readDestination(text, labelEnd + 1)
  if (!destination) return null
  return { label: label.join('').trim(), destination: destination.value, nextIndex: destination.nextIndex }
}

/**
 * Every inline markdown link in a reply, outside fenced code.
 *
 * A code span whose whole content is one link still counts as that link: a
 * reply often wraps a path in backticks to keep it readable. Any other code
 * span is skipped.
 */
export function markdownLinks(text: string | null | undefined): LinkSpan[] {
  if (!text || !text.includes('](')) return []
  const links: LinkSpan[] = []
  let fence: '`' | '~' | null = null
  text.split(/\r?\n/u).forEach((line, lineIndex) => {
    const marker = fenceMarker(line)
    if (marker) { fence = fence ? null : marker; return }
    if (fence) return
    let cursor = 0
    while (cursor < line.length) {
      if (line[cursor] === '`') {
        let ticks = 0
        while (line[cursor + ticks] === '`') ticks++
        const close = line.indexOf('`'.repeat(ticks), cursor + ticks)
        if (close !== -1) {
          const inner = line.slice(cursor + ticks, close).trim()
          const link = inner.startsWith('[') ? readLink(inner, 0) : null
          if (link && link.nextIndex === inner.length) {
            links.push({ label: link.label, destination: link.destination, syntax: 'inline-code', start: cursor, end: close + ticks, line: lineIndex })
          }
          cursor = close + ticks
          continue
        }
      }
      const open = line[cursor] === '!' && line[cursor + 1] === '[' ? cursor + 1 : cursor
      if (line[open] === '[') {
        const link = readLink(line, open)
        if (link) {
          links.push({ label: link.label, destination: link.destination, syntax: open === cursor ? 'link' : 'image', start: cursor, end: link.nextIndex, line: lineIndex })
          cursor = link.nextIndex
          continue
        }
      }
      cursor++
    }
  })
  return links
}

const FILE_PATH_SHAPE = /(?:^|[\\/])[^\\/]+\.(?!\d+$)[^\\/.]+$/i
const LONG_EXTENSIONS = new Set(['docbook', 'markdown', 'notebook', 'storyboard', 'sqlite3'])

/** A link destination that names a file, rather than a URL or a word. */
function looksLikeFilePath(path: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^www\./i.test(path) || /^(?:mailto|tel):/i.test(path)) return false
  if (!FILE_PATH_SHAPE.test(path)) return false
  const hasSeparator = /[\\/]/.test(path)
  const name = path.split(/[\\/]/).pop() ?? ''
  const extension = name.includes('.') ? name.split('.').pop() ?? '' : ''
  if (!extension) return false
  if (!hasSeparator && /[a-z]/.test(extension) && /[A-Z]/.test(extension.slice(1))) return false
  if (!hasSeparator && extension.length > 4 && !LONG_EXTENSIONS.has(extension.toLowerCase())) return false
  return true
}

function joinPath(base: string, relative: string): string {
  const segments: string[] = []
  const unc = base.startsWith('\\\\')
  for (const part of `${base.replace(/[/\\]+$/, '')}/${relative}`.split(/[/\\]/)) {
    if (!part || part === '.') continue
    if (part === '..') { segments.pop(); continue }
    segments.push(part)
  }
  const prefix = unc ? '\\\\' : base.startsWith('/') ? '/' : ''
  return prefix + segments.join('/')
}

/** Normalized absolute form used to compare two references to one file. */
export function normalizeResourcePath(path: string, cwd?: string | null): string {
  const absolute = /^(?:[/\\]|[a-zA-Z]:[\\/])/.test(path) || !cwd ? path : joinPath(cwd, path)
  const unc = absolute.startsWith('\\\\')
  const drive = /^[a-zA-Z]:/.test(absolute)
  const segments: string[] = []
  for (const part of absolute.split(/[/\\]/)) {
    if (!part || part === '.') continue
    if (part === '..') { segments.pop(); continue }
    segments.push(part)
  }
  if (unc) return `\\\\${segments.join('/')}`
  if (drive) return segments.join('/')
  return `${absolute.startsWith('/') ? '/' : ''}${segments.join('/')}`
}

/** Resolve a link destination to a local file path, or null for a URL or a word. */
export function linkedFilePath(destination: string, cwd?: string | null, homeDir?: string | null): string | null {
  let value = destination
  try { value = decodeURI(destination) } catch { /* Keep malformed escapes literal. */ }
  const citation = parseFileCitation(value, cwd ?? undefined, homeDir ?? undefined)
  if (citation) return normalizeResourcePath(citation.path, cwd)
  if (!looksLikeFilePath(value)) return null
  const bare = value.replace(/(?:#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?|:\d+(?::\d+)?(?:[-–]\d+(?::\d+)?)?)$/u, '')
  return normalizeResourcePath(bare, cwd)
}

function withoutCode(text: string): string {
  let fence: '`' | '~' | null = null
  return text.split(/\r?\n/u).map(line => {
    const marker = fenceMarker(line)
    if (marker) { fence = fence ? null : marker; return '' }
    if (fence) return ''
    return line.replace(/(`+)[\s\S]*?\1/g, '')
  }).join('\n')
}

/** Paths the reply cites through the file-citation directive. */
export function citedFilePaths(text: string | null | undefined, cwd?: string | null, homeDir?: string | null): string[] {
  if (!text) return []
  const paths: string[] = []
  for (const directive of parseFileCiteDirectives(withoutCode(text))) {
    const citation = parseFileCitation(directive.path, cwd ?? undefined, homeDir ?? undefined)
    const raw = citation?.path ?? (looksLikeFilePath(directive.path) ? directive.path : null)
    if (raw) paths.push(normalizeResourcePath(raw, cwd))
  }
  return paths
}

export interface EndResourceInput {
  /** True only for a turn that settled as completed or failed. */
  complete: boolean
  /** The turn's final reply text. */
  finalText: string | null | undefined
  /** Every path the turn's own file edits touched. */
  editedPaths?: readonly string[]
  cwd?: string | null
  homeDir?: string | null
}

export function endResources({ complete, finalText, editedPaths = [], cwd, homeDir }: EndResourceInput): EndResource[] {
  if (!complete) return []
  const files: EndResource[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    if (seen.has(path)) return
    seen.add(path)
    files.push({ type: 'file', path })
  }
  for (const path of citedFilePaths(finalText, cwd, homeDir)) {
    if (CITED_OUTPUT_EXTENSIONS.has(fileExtension(path))) add(path)
  }
  for (const link of markdownLinks(finalText)) {
    if (link.syntax === 'image') continue
    const path = linkedFilePath(link.destination, cwd, homeDir)
    if (path && LINKED_OUTPUT_EXTENSIONS.has(fileExtension(path))) add(path)
  }
  if (files.length > 0) return files
  const server = singleLocalServerUrl(finalText)
  if (server) return [{ type: 'website', target: server }]
  const pages = new Set<string>()
  for (const raw of editedPaths) {
    if (!HTML_PAGE.test(raw) || VISUALIZATION_PAGE.test(raw)) continue
    pages.add(normalizeResourcePath(raw, cwd))
  }
  return pages.size === 1 ? [{ type: 'website', target: pages.values().next().value! }] : []
}

/** The file paths among a turn's resources. */
export function endResourceFilePaths(resources: readonly EndResource[]): string[] {
  return resources.flatMap(resource => resource.type === 'file' ? [resource.path] : [])
}

/**
 * Whether the turn's resource cards already present every file it edited, in
 * which case the changed-files card adds nothing and is not shown.
 */
export function endResourcesCoverEdits(resources: readonly EndResource[], editedPaths: readonly string[], cwd?: string | null): boolean {
  if (resources.length === 0 || editedPaths.length === 0) return false
  const covered = new Set<string>()
  for (const resource of resources) {
    if (resource.type === 'file') {
      const extension = fileExtension(resource.path)
      if (extension === 'md' || extension === 'mdx' || !CITED_OUTPUT_EXTENSIONS.has(extension)) continue
      covered.add(normalizeResourcePath(resource.path, cwd))
    } else if (!isUrlTarget(resource.target)) covered.add(normalizeResourcePath(resource.target, cwd))
  }
  return editedPaths.every(path => covered.has(normalizeResourcePath(path, cwd)))
}

const DECORATION_ONLY = /^\s*(?:\d+[.)]\s*)?[\s*_~>#.,;:!?()[\]{}+-]*$/

/**
 * Drop reply lines whose only content is a link to a file the turn-end card
 * already shows. The card is the presentation of that file; a bullet that
 * repeats it as a bare link says the same thing twice. Lines with any other
 * words stay intact, and fenced code is never touched.
 */
export function stripEndResourceLinkLines(text: string, filePaths: readonly string[], cwd?: string | null, homeDir?: string | null): string {
  if (!text || filePaths.length === 0 || (!text.includes('](') && !text.includes(':klaus-file-cite'))) return text
  const shown = new Set(filePaths.map(path => normalizeResourcePath(path, cwd)))
  const lines = text.split('\n')
  const spansByLine = new Map<number, Array<{ start: number; end: number }>>()
  for (const link of markdownLinks(text)) {
    if (link.syntax === 'image') continue
    const path = linkedFilePath(link.destination, cwd, homeDir)
    if (!path || !shown.has(path)) continue
    const spans = spansByLine.get(link.line) ?? []
    spans.push({ start: link.start, end: link.end })
    spansByLine.set(link.line, spans)
  }
  let fence: '`' | '~' | null = null
  const kept: string[] = []
  lines.forEach((line, index) => {
    const marker = fenceMarker(line)
    if (marker) { fence = fence ? null : marker; kept.push(line); return }
    if (fence) { kept.push(line); return }
    const spans = [...(spansByLine.get(index) ?? [])]
    for (const directive of parseFileCiteDirectives(line)) {
      const citation = parseFileCitation(directive.path, cwd ?? undefined, homeDir ?? undefined)
      if (citation && shown.has(normalizeResourcePath(citation.path, cwd))) spans.push({ start: directive.start, end: directive.end })
    }
    if (spans.length === 0) { kept.push(line); return }
    let remainder = line
    for (const span of spans.sort((a, b) => b.start - a.start)) remainder = remainder.slice(0, span.start) + remainder.slice(span.end)
    if (!DECORATION_ONLY.test(remainder)) kept.push(line)
  })
  return kept.join('\n')
}

/** Overview label of a website resource: host and path for a URL, file name for a page. */
export function websiteResourceLabel(target: string): string {
  if (!isUrlTarget(target)) {
    const name = target.split(/[\\/]/).pop() ?? ''
    return name || target
  }
  try {
    const url = new URL(target)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}${url.search}`
  } catch { return target }
}

export type EndResourceFileKind = 'word' | 'excel' | 'powerpoint' | 'pdf' | 'spreadsheet' | 'presentation' | 'document' | 'image' | 'code' | 'html' | 'audio' | 'latex' | 'file'

const SPREADSHEET = new Set(['csv', 'tsv', 'xls', 'xlsm', 'xlsx'])
const TEXT_DOCUMENT = new Set(['dotenv', 'env', 'gitignore', 'lock', 'markdown', 'md', 'mdown', 'mdx', 'mkd', 'rtf', 'txt'])
const AUDIO = new Set(['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba', 'wma'])
const IMAGE = new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpg', 'jpeg', 'jfif', 'png', 'svg', 'tif', 'tiff', 'webp'])
const CODE = new Set(['bash', 'c', 'cc', 'cpp', 'cs', 'css', 'cxx', 'go', 'h', 'hh', 'hpp', 'java', 'js', 'jsx', 'json', 'jsonc', 'kt', 'less', 'lua', 'mjs', 'php', 'pl', 'ps1', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'swift', 'toml', 'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml', 'zsh'])

/** The type a file card names under its title. */
export function endResourceFileKind(path: string): EndResourceFileKind {
  const extension = fileExtension(path)
  if (extension === 'tex') return 'latex'
  if (extension === 'pdf') return 'pdf'
  if (extension === 'xls' || extension === 'xlsm' || extension === 'xlsx') return 'excel'
  if (SPREADSHEET.has(extension)) return 'spreadsheet'
  if (extension === 'ppt' || extension === 'pptx') return 'powerpoint'
  if (extension === 'key') return 'presentation'
  if (extension === 'doc' || extension === 'docx') return 'word'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (CODE.has(extension)) return 'code'
  if (TEXT_DOCUMENT.has(extension)) return 'document'
  if (AUDIO.has(extension)) return 'audio'
  if (IMAGE.has(extension)) return 'image'
  return 'file'
}

/** Directory shown under a file whose type has no specific name. */
export function resourceDirectoryLabel(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (slash < 0) return '/'
  return `${path.slice(0, slash) || ''}/`
}

/** Page title and icon reference parsed from a page's own markup. */
export function pageTitleAndIcon(html: string): { title: string | null; icon: string | null } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const decoded = title ? decodeEntities(title).replace(/\s+/g, ' ').trim() : ''
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(match => match[0])
  const relOf = (tag: string) => /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
  const hrefOf = (tag: string) => /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
  const pick = (kind: string) => links.find(tag => {
    const rel = relOf(tag)
    return (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? '').toLowerCase().split(/\s+/).includes(kind) && hrefOf(tag)
  })
  const tag = pick('icon') ?? pick('apple-touch-icon')
  const href = tag ? hrefOf(tag) : null
  const icon = href ? decodeEntities(href[1] ?? href[2] ?? href[3] ?? '').trim() : ''
  return { title: decoded || null, icon: icon || null }
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39|nbsp);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos' || lower === '#39') return "'"
    if (lower === 'nbsp') return ' '
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : whole
  })
}

const IMAGE_FILE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i

/**
 * Where a page's declared icon lives: a data image, a file next to the page,
 * or nowhere. Remote and protocol-relative icons are never fetched.
 */
export function pageIconSource(icon: string | null, pagePath: string): { type: 'url'; src: string } | { type: 'file'; path: string } | null {
  if (!icon || icon.startsWith('//')) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(icon)) {
    return /^data:image\//i.test(icon) ? { type: 'url', src: icon } : null
  }
  let relative = icon.split(/[?#]/u)[0] ?? ''
  try { relative = decodeURIComponent(relative) } catch { /* Keep the literal reference. */ }
  if (/^(?:[/\\]|[a-zA-Z]:[\\/])/.test(relative) || relative.split(/[\\/]/).includes('..')) return null
  const slash = Math.max(pagePath.lastIndexOf('/'), pagePath.lastIndexOf('\\'))
  const path = normalizeResourcePath(relative, slash >= 0 ? pagePath.slice(0, slash) : '.')
  return IMAGE_FILE.test(path) ? { type: 'file', path } : null
}

export const PAGE_ICON_MAX_BYTES = 256 * 1024
