// The local file-reference contract of the transcript renderer.
//
// A final reply cites a file the way GitHub-flavored markdown cites anything:
// as a link. The renderer turns a link whose destination is a LOCAL path into
// an interactive file citation (a chip that opens the file in the workspace
// panel at the cited line), and a markdown IMAGE whose source is a playable
// audio or video file into an inline player card instead of a broken picture.
// Both decisions start from the same question — "is this destination a local
// path, and where does it point?" — so the answer lives here, in one module
// both the render pipeline and the click delegate consume, rather than as two
// decision trees that drift.
//
// The destination shapes and the location-suffix grammar are the ones the
// product's own tools emit: `file://` URLs, absolute POSIX and Windows paths,
// `~/…`, `./…`, `../…`, UNC paths, and a trailing `#L12`, `#L12C3`,
// `#L12C3-L14C9`, `:12`, `:12:3` or `:12-14` location suffix. A destination
// that is not local-path-like stays an ordinary link.

export interface FileCitationLocation {
  line: number
  column?: number
  endLine?: number
  endColumn?: number
}

/**
 * The explicit file-citation directive: `:klaus-file-cite[Caption]{path="…"}`.
 *
 * The second citation channel beside the markdown link. A directive is
 * unambiguous where prose is not — it carries its own path attribute, an
 * optional caption for the chip label, and it survives any surrounding
 * punctuation — so a reply that cites a file never depends on the renderer
 * guessing which words were meant as a path. The renderer consumes the
 * directive text and leaves the chip in its place.
 */
export const FILE_CITE_PREFIX = ':klaus-file-cite'
const FILE_CITE_RE = /^:klaus-file-cite(\[[^\]\n]*\])?\{([^}\n]*)\}/
const FILE_CITE_PATH_RE = /(?:^|[,\s])path\s*=\s*(?:"([^"\n]*)"|([^\s",][^,\n]*))/

export interface FileCiteDirective {
  path: string
  caption?: string
}

/**
 * Match one file-citation directive at the START of `text`.
 *
 * The renderer's inline tokenizer works position by position, so the anchored
 * match is the primitive; the whole-text scan below is built on it. A
 * directive without a readable `path` attribute is not a directive: it stays
 * visible text, the same degradation an unparsable line gets everywhere else
 * in this contract. Other attributes are tolerated and ignored.
 */
export function matchFileCiteDirective(text: string): { directive: FileCiteDirective; length: number } | null {
  if (!text.startsWith(FILE_CITE_PREFIX)) return null
  const match = FILE_CITE_RE.exec(text)
  if (!match) return null
  const caption = match[1] ? match[1].slice(1, -1).trim() : undefined
  const pathMatch = FILE_CITE_PATH_RE.exec(match[2] || '')
  const path = (pathMatch?.[1] ?? pathMatch?.[2] ?? '').trim()
  if (!path) return null
  return { directive: { path, ...(caption ? { caption } : {}) }, length: match[0].length }
}

/** Find every well-formed file-citation directive in `text`, in order. */
export function parseFileCiteDirectives(text: string): Array<FileCiteDirective & { start: number; end: number }> {
  const out: Array<FileCiteDirective & { start: number; end: number }> = []
  if (!text || !text.includes(FILE_CITE_PREFIX)) return out
  let cursor = text.indexOf(FILE_CITE_PREFIX)
  while (cursor !== -1) {
    const match = matchFileCiteDirective(text.slice(cursor))
    if (match) {
      out.push({ ...match.directive, start: cursor, end: cursor + match.length })
      cursor = text.indexOf(FILE_CITE_PREFIX, cursor + match.length)
    } else {
      cursor = text.indexOf(FILE_CITE_PREFIX, cursor + FILE_CITE_PREFIX.length)
    }
  }
  return out
}

export interface FileCitation {
  /** Absolute path when it could be resolved against cwd/home, else the raw path text. */
  path: string
  /** The path text exactly as cited, before cwd/home resolution — what a relative chip shows. */
  citedPath: string
  location?: FileCitationLocation
}

const COLON_LOCATION_SUFFIX_RE = /:\d+(?::\d+)?(?:[-–]\d+(?::\d+)?)?$/
const HASH_LOCATION_SUFFIX_RE = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/

/** Extensions the inline player card serves as audio. The set is the one the
 *  media channel's MIME table and the workspace panel's player both serve, so
 *  a citation, a capability URL and a panel tab never disagree. */
export const PLAYABLE_AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus'])
/** Extensions the inline player card serves as video. The set is the one the
 *  workspace panel's own player serves, so a citation and a panel tab never
 *  disagree about what is playable. */
export const PLAYABLE_VIDEO_EXTENSIONS = new Set(['mp4', 'ogv', 'webm', 'mov', 'm4v'])

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() || ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 'audio' | 'video' for the extensions the inline player card serves, else null. */
export function playableMediaKind(path: string): 'audio' | 'video' | null {
  const extension = fileExtension(path)
  if (PLAYABLE_AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (PLAYABLE_VIDEO_EXTENSIONS.has(extension)) return 'video'
  return null
}

/**
 * Split a trailing location suffix off a cited path.
 *
 * The hash form wins when both are present so `notes.md#L10` is not misread as
 * a path ending in `:10`. Colons elsewhere in the path are left alone because
 * the suffix must sit at the very end; that is also what keeps a Windows drive
 * letter (`C:/…`) from reading as a location.
 */
export function splitLocationSuffix(pathText: string): { path: string; location?: FileCitationLocation; suffix: string } {
  const hashAt = pathText.lastIndexOf('#')
  if (hashAt > 0) {
    const fragment = pathText.slice(hashAt + 1)
    if (HASH_LOCATION_SUFFIX_RE.test(fragment)) {
      return { path: pathText.slice(0, hashAt), location: parseHashLocation(fragment), suffix: `#${fragment}` }
    }
  }
  const match = COLON_LOCATION_SUFFIX_RE.exec(pathText)
  if (match) {
    const suffix = match[0]
    return { path: pathText.slice(0, pathText.length - suffix.length), location: parseColonLocation(suffix.slice(1)), suffix }
  }
  return { path: pathText, suffix: '' }
}

function parseHashLocation(fragment: string): FileCitationLocation | undefined {
  const match = /^L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/.exec(fragment)
  if (!match) return undefined
  const [, line, column, endLine, endColumn] = match
  return {
    line: Number(line),
    ...(column ? { column: Number(column) } : {}),
    ...(endLine ? { endLine: Number(endLine) } : {}),
    ...(endColumn ? { endColumn: Number(endColumn) } : {}),
  }
}

function parseColonLocation(body: string): FileCitationLocation | undefined {
  const parts = body.split(/[-–]/)
  const start = parts[0]!.split(':').map(Number)
  const end = parts[1]?.split(':').map(Number)
  if (!start.length || start.some(value => !Number.isFinite(value))) return undefined
  if (end && (!end.length || end.some(value => !Number.isFinite(value)))) return undefined
  return {
    line: start[0]!,
    ...(start[1] !== undefined ? { column: start[1] } : {}),
    ...(end ? { endLine: end[0]! } : {}),
    ...(end && end[1] !== undefined ? { endColumn: end[1] } : {}),
  }
}

/**
 * Whether a link destination is a local path reference rather than a URL.
 *
 * `file://` plus the bare path shapes a reply can carry. A `//host` start is a
 * UNC path on Windows, not a protocol-relative URL, because this predicate is
 * only consulted for destinations the markdown already produced as a link.
 */
export function isLocalPathLikeHref(href: string): boolean {
  const value = String(href || '').trim()
  if (!value) return false
  if (/^file:/i.test(value)) return true
  if (value.startsWith('/') || value.startsWith('~/') || value === '~' || value.startsWith('./') || value.startsWith('../') || value.startsWith('\\\\')) return true
  return /^[a-zA-Z]:[\\/]/.test(value)
}

/**
 * Resolve a local link destination to a file citation.
 *
 * Returns null when the destination is not local-path-like or a `file://` URL
 * will not parse into a path. `cwd` and `homeDir` resolve the relative and
 * `~/…` shapes; a destination that resolves against neither keeps its raw path
 * text so the chip still opens through the panel's own scope check, which is
 * the honest refusal surface.
 */
export function parseFileCitation(href: string, cwd?: string, homeDir?: string): FileCitation | null {
  const value = String(href || '').trim()
  if (!isLocalPathLikeHref(value)) return null
  let pathText = value
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value)
      if (url.username || url.password || url.port) return null
      let pathname = decodeURIComponent(url.pathname)
      if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) pathname = pathname.slice(1)
      // The fragment is NOT part of pathname, and it is where a `#L12C3`
      // location suffix lives; carry it back so the split below can see it.
      const fragment = url.hash ? decodeURIComponent(url.hash) : ''
      pathText = (url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}${pathname}` : pathname) + fragment
    } catch { return null }
  } else {
    try { pathText = decodeURI(value).replace(/%23/g, '#') } catch { /* Keep malformed escapes literal. */ }
  }
  const split = splitLocationSuffix(pathText)
  const citedPath = split.path
  return { path: resolveLocalPath(split.path, cwd, homeDir), citedPath, ...(split.location ? { location: split.location } : {}) }
}

function resolveLocalPath(path: string, cwd?: string, homeDir?: string): string {
  if (path === '~') return homeDir || path
  if (path.startsWith('~/')) return homeDir ? joinPath(homeDir, path.slice(2)) : path
  if (path.startsWith('./') || path.startsWith('../')) return cwd ? joinPath(cwd, path) : path
  return path
}

function joinPath(base: string, relative: string): string {
  const segments: string[] = []
  for (const part of `${base.replace(/[/\\]+$/, '')}/${relative}`.split(/[/\\]/)) {
    if (!part || part === '.') continue
    if (part === '..') { segments.pop(); continue }
    segments.push(part)
  }
  const prefix = base.startsWith('\\\\') ? '\\\\' : base.startsWith('/') ? '/' : ''
  return prefix + segments.join('/')
}
