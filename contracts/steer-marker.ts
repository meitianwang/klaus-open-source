// Shared contract for the marker that tags a steered user message in history.
//
// A mid-turn follow-up (`session/steer`, `delivery:"user"`) is persisted by the
// engine as its OWN user message inside the running turn — the same shape a
// cross-conversation delegation takes when it arrives while the thread is idle.
// The transcript must still tell the two apart: the edit rule ("the last
// message the user sent is editable") counts only messages that OPENED a turn,
// and a steer is an injection into a turn that was already running. Without a
// durable marker the host and the renderer would have to guess from position,
// and position alone cannot separate "steered into turn N" from "opened turn N".
//
// The marker rides the message's own content as a leading text block, exactly
// like the delegation envelope does: the engine stores whatever blocks the host
// submits, so no engine change is needed and a resume replays the same stream.
// It is stripped from every user-facing projection (the transcript bubble, the
// composer refill, the text export) the same way the delegation wrapper is.

/** Text of the leading block the host prepends to a steered message's input. */
export const STEER_HISTORY_MARKER = '<!-- klaus-steered-message -->'

/** Whether one content block is the steer marker block. */
export function isSteerMarkerBlock(block: unknown): boolean {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return false
  const row = block as Record<string, unknown>
  return row.type === 'text' && typeof row.text === 'string' && row.text.trim() === STEER_HISTORY_MARKER
}

/** Drop the marker block from a content array, leaving everything else in order. */
export function withoutSteerMarker<T>(content: T[]): T[] {
  return content.filter(block => !isSteerMarkerBlock(block))
}

/** Prepend the marker to an input the engine will persist as a user message. */
export function withSteerMarker(input: unknown): unknown[] {
  const blocks = Array.isArray(input) ? input : [{ type: 'text', text: String(input) }]
  return [{ type: 'text', text: STEER_HISTORY_MARKER }, ...blocks]
}
