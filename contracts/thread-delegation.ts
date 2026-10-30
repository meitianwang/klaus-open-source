// Shared contract for the cross-conversation delegation envelope.
//
// The host (main/services/thread-tools.ts) encodes it when `send_message_to_thread`
// delivers into another conversation; the renderer
// (frontend/src/chat/transcript/factories.ts) parses it to fold the protocol
// wrapper and show only the prompt the sending conversation actually wrote.
// Both sides must agree on the tag names and the escaping, so the regex lives
// here rather than being duplicated — the same reason `sidebar-collapse.ts`
// exists.
//
// Follows Klaus's existing in-message envelope convention (`<teammate-message>`
// from the swarm inbox, `<fork-boilerplate>` from sub-agent forks): the wrapper
// is model-visible plain text, so it survives engines that only store text
// blocks, and the UI folds it instead of showing protocol markup to the user.
//
// Nested tags rather than attributes because the payload is arbitrary text:
// escaping `& < >` is enough for element text, while an attribute would also
// need quote escaping.

/** Wrapper element around a delegated prompt. */
export const DELEGATION_TAG = 'klaus-delegation'
/** Element carrying the sending conversation's id, so the recipient can reply
 *  with `send_message_to_thread` without being told the id in prose. */
export const DELEGATION_SOURCE_TAG = 'source-thread-id'
/** Element carrying the sending device's id for a cross-host reply. */
export const DELEGATION_SOURCE_HOST_TAG = 'source-host-id'
/** Element carrying the prompt verbatim. */
export const DELEGATION_INPUT_TAG = 'input'

/** Provider-invisible display metadata for a task submitted on the owner's behalf. */
export function initialDelegationMetadata(displayText: string) {
  return { delegationKind: 'initial-input' as const, displayText }
}

/**
 * The wrapper's opening tag as written, for cheap substring tests.
 *
 * The renderer needs to spot a delegated message before parsing it — the same
 * `<fork-boilerplate>` / `<teammate-message` substring checks that route the other
 * two in-message envelopes. Deriving it here rather than retyping the literal in
 * the renderer is what stops the two spellings from drifting apart, which would
 * show protocol markup to a user.
 */
export const DELEGATION_TAG_OPEN = `<${DELEGATION_TAG}>`

/**
 * Escape element text. `&` MUST go first, or a literal `&lt;` in the payload
 * would become `&amp;lt;` after the `<` pass and decode back to `&lt;` — the
 * user's text would survive one round trip but not two.
 */
export function escapeDelegationText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * The exact inverse of {@link escapeDelegationText}. `&amp;` MUST go last for
 * the same reason `&` goes first when escaping: decoding it first would turn an
 * escaped literal `&lt;` (stored as `&amp;lt;`) into a real tag.
 */
export function unescapeDelegationText(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

/**
 * Wrap a prompt for delivery into another conversation.
 *
 * An empty `sourceThreadId` omits the source element rather than emitting an
 * empty tag: a recipient with nothing to reply to should not see a blank id it
 * might treat as a malformed-but-present value.
 */
export function encodeDelegationEnvelope(input: string, sourceThreadId?: string | null, sourceHostId?: string | null): string {
  const source = typeof sourceThreadId === 'string' ? sourceThreadId.trim() : ''
  const host = typeof sourceHostId === 'string' ? sourceHostId.trim() : ''
  const lines = [`<${DELEGATION_TAG}>`]
  if (source) lines.push(`  <${DELEGATION_SOURCE_TAG}>${escapeDelegationText(source)}</${DELEGATION_SOURCE_TAG}>`)
  if (host) lines.push(`  <${DELEGATION_SOURCE_HOST_TAG}>${escapeDelegationText(host)}</${DELEGATION_SOURCE_HOST_TAG}>`)
  lines.push(`  <${DELEGATION_INPUT_TAG}>${escapeDelegationText(input)}</${DELEGATION_INPUT_TAG}>`)
  lines.push(`</${DELEGATION_TAG}>`)
  return lines.join('\n')
}

/**
 * Matches a whole delegation envelope. Non-greedy on the payload so two
 * envelopes inside one message stay separate, mirroring `TEAMMATE_MSG_RE`.
 *
 * Deliberately does not anchor to the start of the string: the UI needs to find
 * an envelope embedded in a message that may carry other text.
 */
export const DELEGATION_RE = new RegExp(
  `<${DELEGATION_TAG}>\\s*(?:<${DELEGATION_SOURCE_TAG}>([\\s\\S]*?)</${DELEGATION_SOURCE_TAG}>\\s*)?(?:<${DELEGATION_SOURCE_HOST_TAG}>([^<>]*?)</${DELEGATION_SOURCE_HOST_TAG}>\\s*)?<${DELEGATION_INPUT_TAG}>([\\s\\S]*?)</${DELEGATION_INPUT_TAG}>\\s*</${DELEGATION_TAG}>`,
  'g',
)

export interface DelegationEnvelope {
  /** The sending conversation's id, or null when the envelope carried none. */
  sourceThreadId: string | null
  /** The sending device's id. Absent on legacy and same-host deliveries. */
  sourceHostId?: string
  /** The prompt, unescaped. */
  input: string
}

/**
 * Parse one delegation envelope. Returns null for anything that is not exactly
 * one well-formed envelope, so a half-written or nested wrapper is left as
 * visible text instead of being silently swallowed — losing user-visible text
 * is worse than showing protocol markup.
 *
 * The regex is stateful (`g`), so it is reset before and after use; a shared
 * instance leaking `lastIndex` across renders would skip envelopes.
 */
/** One envelope found inside a larger text, with what surrounds it. */
export interface EmbeddedDelegation {
  /** Text before this envelope. */
  before: string
  /** The envelope exactly as stored, so a caller can show the raw form if it must. */
  raw: string
  /** The parsed envelope. */
  parsed: DelegationEnvelope
}

/**
 * Find every delegation envelope inside a text that also carries other content.
 *
 * {@link parseDelegationEnvelope} refuses anything that is not EXACTLY one envelope,
 * which is right for a delivered message but wrong for a tool result: the engine
 * drains a mid-turn delegation into the output of the turn's last tool call, so the
 * stored text is the tool's own output followed by the envelope. A renderer that
 * only knows the exact-match parser therefore shows that envelope as raw XML —
 * protocol markup where the user expects to read their command's output.
 *
 * Returns the segments in order so a caller can interleave ordinary text with a
 * folded card. Text that holds no well-formed envelope yields an empty array, which
 * is how a caller distinguishes "nothing to fold" from "folded something".
 */
export function findEmbeddedDelegationEnvelopes(text: string): EmbeddedDelegation[] {
  if (typeof text !== 'string' || !text.includes(DELEGATION_TAG_OPEN)) return []
  DELEGATION_RE.lastIndex = 0
  const found: EmbeddedDelegation[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  // The regex is global, so this loop consumes every envelope and resets lastIndex
  // before returning: a shared instance leaking lastIndex across renders would skip
  // envelopes in the next call, exactly as in {@link parseDelegationEnvelope}.
  while ((match = DELEGATION_RE.exec(text)) !== null) {
    const source = typeof match[1] === 'string' ? unescapeDelegationText(match[1]).trim() : ''
    const host = typeof match[2] === 'string' ? unescapeDelegationText(match[2]).trim() : undefined
    // A present but empty host is malformed, same rule as the exact-match parser.
    if (host !== undefined && !host) continue
    found.push({
      before: text.slice(cursor, match.index),
      raw: match[0],
      parsed: { sourceThreadId: source || null, ...(host === undefined ? {} : { sourceHostId: host }), input: unescapeDelegationText(match[3] ?? '') },
    })
    cursor = match.index + match[0].length
  }
  DELEGATION_RE.lastIndex = 0
  return found
}

export function parseDelegationEnvelope(text: string): DelegationEnvelope | null {
  if (typeof text !== 'string') return null
  DELEGATION_RE.lastIndex = 0
  const match = DELEGATION_RE.exec(text)
  DELEGATION_RE.lastIndex = 0
  if (!match) return null
  // Reject surrounding content: `<input>` may legitimately contain text, but an
  // envelope glued to other prose is not the shape this tool emits.
  const before = text.slice(0, match.index).trim()
  const after = text.slice(match.index + match[0].length).trim()
  if (before || after) return null
  const source = typeof match[1] === 'string' ? unescapeDelegationText(match[1]).trim() : ''
  const host = typeof match[2] === 'string' ? unescapeDelegationText(match[2]).trim() : undefined
  // A present but empty host must not become a link to a same-id local thread.
  if (host !== undefined && !host) return null
  return { sourceThreadId: source || null, ...(host === undefined ? {} : { sourceHostId: host }), input: unescapeDelegationText(match[3] ?? '') }
}
