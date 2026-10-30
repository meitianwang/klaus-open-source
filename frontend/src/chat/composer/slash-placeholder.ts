// Pure geometry behind the composer's slash-command chip placeholder.
//
// The chip occupies a run of spaces in the draft value, sized so the invisible
// input text wraps exactly like the mirror layer that paints the visible chip.
// Three pieces of arithmetic keep the two layers in sync:
//
// - placeholderCount: spaces needed for a chip of a measured pixel width.
// - mapCaretAroundToken: caret/selection positions survive a placeholder
//   resize (positions inside the run collapse onto its start).
// - shiftPositionAfterRemoval: a trigger range captured before an existing
//   chip was removed must move with the removed span.

/** Spaces that reserve `chipWidth` pixels of line width. */
export function placeholderCount(chipWidth: number, spaceWidth: number): number {
  const safeSpace = Math.max(3, spaceWidth)
  return Math.max(4, Math.ceil((chipWidth + 2) / safeSpace))
}

/** Map a caret position through a token-range resize of `delta` characters. */
export function mapCaretAroundToken(position: number, range: { start: number; end: number }, delta: number): number {
  if (position <= range.start) return position
  if (position >= range.end) return position + delta
  return range.start
}

/** Map a position through the removal of `removed` (inclusive of trimmed whitespace). */
export function shiftPositionAfterRemoval(position: number, removed: { start: number; end: number }): number {
  if (position <= removed.start) return position
  if (position >= removed.end) return position - (removed.end - removed.start)
  return removed.start
}
