// Shared contract for the `::klaus-inline-vis{…}` inline-visualization directive.
//
// The host gives the model a thread-scoped visualizations directory
// (join(configRoot, 'visualizations', <sessionId>) added to the session's
// sandbox_workspace_write.writable_roots and stated in the developer instructions), the agent
// writes a self-contained HTML file there, and it asks for inline presentation by
// emitting ONE directive line in its final response. The renderer parses the line,
// drops the paragraph, and mounts the page in a sandboxed iframe right in the
// transcript. The contract is carried by the developer instructions plus the
// browser skill rather than by a separately loaded plugin, which keeps it to one
// moving part — the enforcement rules below are what must not be simplified away.
//
// Everything here is parsed from model-authored text, which is untrusted input:
// anything that does not match exactly stays as visible text. Swallowing text the
// model wrote is worse than showing a directive that did not parse.

/** The directive name, without the `::` prefix. */
export const INLINE_VIS_DIRECTIVE = 'klaus-inline-vis'

/** The full directive prefix, used for scanning raw text. */
export const INLINE_VIS_PREFIX = `::${INLINE_VIS_DIRECTIVE}`

/** The single attribute the directive accepts. */
export const INLINE_VIS_PATH_ATTRIBUTE = 'path'

/**
 * A fragment is capped at 1 MB. The bound keeps a runaway page from freezing the
 * renderer's DOM walk, and it is the size the host refuses to serve.
 */
export const INLINE_VIS_MAX_BYTES = 1024 * 1024

/**
 * The character cap on the content carried inside a projected message block.
 * The host reads the page once, at projection time, under the same whitelist
 * as the URL grant, and ships the text with the message; the renderer never
 * re-reads the file. A page above the cap travels as `contents: null` with a
 * read error, the same shape as any other refused read.
 */
export const INLINE_VIS_MAX_CONTENT_CHARS = 5_000_000

/**
 * The block a projected message carries for one directive: the resolved path,
 * the page content read under the whitelist at projection time, or the reason
 * the read failed. `contents === null` is NOT "mount nothing silently" — the
 * renderer shows a failure card naming the page, never the raw directive.
 */
export interface InlineVisFragment {
  path: string
  contents: string | null
  readError?: string
}

/**
 * The host bridge the injected sandbox runtime exposes to the page as
 * `window.openai.callTool`. Names mirror the handshake a visualization page
 * needs: ready (the mount completes on it, with a bounded wait), intrinsic
 * height, page-side error, explicit external navigation and an explicit
 * download request. Every other tool call from the page is refused.
 */
export const INLINE_VIS_BRIDGE_READY = '__klaus_inline_visualization_ready__'
export const INLINE_VIS_BRIDGE_HEIGHT = '__klaus_inline_visualization_height__'
export const INLINE_VIS_BRIDGE_ERROR = '__klaus_inline_visualization_error__'
export const INLINE_VIS_BRIDGE_OPEN_EXTERNAL = '__klaus_inline_visualization_open_external__'
export const INLINE_VIS_BRIDGE_DOWNLOAD = '__klaus_inline_visualization_download__'

/** How long the mount waits for the page's ready handshake before failing. */
export const INLINE_VIS_READY_TIMEOUT_MS = 30_000

/**
 * The renderer iframe height cap for the inline surface. A finished page is
 * shown at its intrinsic height, so it never renders as a small scroll
 * window; only a page taller than this cap keeps its own scrollbar inside
 * the frame.
 */
export const INLINE_VIS_MAX_HEIGHT_PX = 10_000

/**
 * The floor for a reported intrinsic height. A degenerate report (an empty
 * or collapsing page) must not shrink the frame out of existence.
 */
export const INLINE_VIS_MIN_HEIGHT_PX = 10

/** The renderer iframe height before the page reports its intrinsic height. */
export const INLINE_VIS_DEFAULT_HEIGHT_PX = 240

/**
 * One directive on its own line: `::klaus-inline-vis{path="…"}`
 * (`mode="wide"` variant included — parsed and ignored; the transcript column is
 * single-width, so there is no wide surface to switch to).
 *
 * - Requires the whole line to be the directive. A directive glued into prose is
 *   left as text, because lifting it out would silently delete the surrounding
 *   sentence.
 * - The path must be absolute (the agent writes to the thread directory it was
 *   told to use; a relative path cannot be resolved from model text alone).
 * - Attribute values are double-quoted and may contain any character except a
 *   double quote and a newline. There is no escape syntax.
 */
const DIRECTIVE_LINE_RE = /^::klaus-inline-vis\{([^}\n]{1,4096})\}[ \t]*$/
const ATTRIBUTE_RE = /([A-Za-z][A-Za-z0-9-]*)="([^"\n]*)"/g

/** A parsed, unvalidated directive. `mode` is accepted and ignored. */
export interface InlineVisDirective {
  /** Absolute filesystem path of the visualization HTML file. */
  path: string
  /** The full matched text, so the caller can remove exactly what was consumed. */
  matched: string
}

/**
 * Parse one line of model output.
 *
 * Returns null when the line is not exactly one well-formed directive, so the
 * caller keeps the line as ordinary text.
 */
export function parseInlineVisDirective(line: string): InlineVisDirective | null {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed.startsWith(INLINE_VIS_PREFIX)) return null
  const match = DIRECTIVE_LINE_RE.exec(trimmed)
  if (!match) return null
  let path: string | null = null
  for (const attribute of match[1]!.matchAll(ATTRIBUTE_RE)) {
    const name = attribute[1], value = attribute[2]
    if (name === INLINE_VIS_PATH_ATTRIBUTE && path === null && value !== undefined) path = value
  }
  // The kebab-case file name and the size cap live in `inlineVisFileEligible`
  // (the host checks them against real bytes); the parser only pins the syntax.
  if (!path || !/^(?:\/|[A-Za-z]:[\\/])/.test(path) || path.includes('\0')) return null
  return { path, matched: trimmed }
}

/**
 * Whether a file qualifies for inline mounting, as pure validation the host and
 * the renderer can share.
 *
 * The read path enforces: the file NAME matches
 * `/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/` (kebab-case slug + extension), no
 * symbolic links anywhere on the path, the resolved path stays inside the
 * thread's visualization directory, and the content stays under 1 MB. The host
 * enforces directory containment, the symlink refusal and the size cap against
 * real bytes when it reads the page at projection time; the renderer calls
 * this predicate with the basename so a directive pointing at `Page.HTML` or
 * `my_page.html` is never projected as a fragment at all. A violation is NOT
 * an error — the directive line stays as text, exactly like a line that did
 * not parse.
 */
export function inlineVisFileEligible(basename: string, bytes: Uint8Array | undefined): boolean {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/u.test(basename)) return false
  if (bytes !== undefined && bytes.byteLength > INLINE_VIS_MAX_BYTES) return false
  return true
}
