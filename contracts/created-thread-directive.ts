// Shared contract for the `::created-thread{…}` inline directive.
//
// The host tells the model to emit this line in its final response
// (`threadCoordinationDirective` in main/services/session-init.ts, and the
// `create_thread` tool description); the renderer parses it into a clickable card
// that opens the conversation just created (`postProcessHtml` in
// frontend/src/chat/transcript/TranscriptView.tsx). The syntax therefore has to be
// spelled the same way on both sides, which is why it lives here rather than being
// duplicated as a literal in each — the same reason `thread-delegation.ts` exists.
//
// The directive is deliberately NOT a general-purpose templating feature. It is
// one name with one or two attributes, parsed from model-authored text, which is
// untrusted input: everything that does not match exactly is left alone as visible
// text. Swallowing text the model wrote is worse than showing a directive that did
// not parse.

/** The directive name, without the `::` prefix. */
export const CREATED_THREAD_DIRECTIVE = 'created-thread'

/** The full directive prefix, used for scanning raw text. */
export const CREATED_THREAD_PREFIX = `::${CREATED_THREAD_DIRECTIVE}`

/**
 * The single attribute the directive accepts.
 *
 * Codex also has `clientThreadId` for a creation whose worktree is still being
 * set up, so the real thread id does not exist yet. Klaus has no equivalent: its
 * `create_thread` creates the worktree FIRST and only then starts the
 * conversation (`thread-tools.ts` awaits `createWorktree` before `newSession`),
 * so the tool always returns a real `threadId` and never a pending client id.
 * Accepting a second attribute here would mean rendering a card for an id that
 * nothing can resolve, so the syntax stays one attribute wide.
 */
export const CREATED_THREAD_ID_ATTRIBUTE = 'threadId'

/** A directive recognized in a line of model output. */
export interface CreatedThreadDirective {
  /** The conversation to open. */
  threadId: string
  /** The full matched text, so the caller can remove exactly what was consumed. */
  matched: string
}

/**
 * One directive on its own line: `::created-thread{threadId="…"}`.
 *
 * - Requires the whole line to be the directive. Codex asks for "its own line"
 *   and the model does not always comply; a directive glued into prose is left as
 *   text, because lifting it out would silently delete the surrounding sentence.
 * - Attribute values are double-quoted and may contain any character except a
 *   double quote and a newline. There is no escape syntax: a thread id is a uuid,
 *   so needing one would already mean the text is not a real directive.
 * - Rejects an empty or over-long id rather than emitting a card that would
 *   navigate nowhere.
 */
const DIRECTIVE_LINE_RE = /^::created-thread\{threadId="([^"\n]{1,512})"\}[ \t]*$/

/**
 * Parse one line of model output.
 *
 * Returns null when the line is not exactly one well-formed directive, so the
 * caller keeps the line as ordinary text.
 */
export function parseCreatedThreadDirective(line: string): CreatedThreadDirective | null {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed.startsWith(CREATED_THREAD_PREFIX)) return null
  const match = DIRECTIVE_LINE_RE.exec(trimmed)
  if (!match) return null
  const id = match[1]
  if (!id || !id.trim()) return null
  return { threadId: id, matched: trimmed }
}

// Parsing stops here on purpose. Whether a directive line became its own
// paragraph, and whether a fenced block is code, are decided by the markdown
// renderer — so the renderer walks its own DOM and feeds each candidate's
// `textContent` to `parseCreatedThreadDirective`. Re-implementing fence or
// paragraph rules here would create a second parser that can disagree with
// `marked`, and a disagreement shows up either as protocol syntax leaked into
// the transcript or as a card raised for a directive the user was merely
// discussing. `textContent` (never `innerHTML`) is what makes `&quot;` come back
// decoded and match the syntax above.
