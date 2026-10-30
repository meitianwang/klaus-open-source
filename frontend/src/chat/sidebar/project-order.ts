// Pure ordering rules for the sidebar's Projects section.
//
// The section holds three kinds of row — a multi-folder workspace container, a
// friend group, and an ordinary project — and the user orders all of them in one
// list by dragging. This module owns the decisions that turn a pointer position
// into a new key order, and a stored order plus the rows that exist right now
// into the order to render. It is I/O free so every rule is unit-testable;
// chat.ts owns the reads and writes and session-list.tsx owns the gesture.
//
// Vocabulary: the section is described by its VISIBLE KEYS, the `key` of each
// row top to bottom (`ws:<id>`, `friend:<id>`, or a normalized project workdir).
// A drop is expressed as "move the dragged key BEFORE this other key", where a
// null before-key means "move to the end". That form survives rows appearing and
// disappearing between the drag and the write, which an index pair does not.

/** Which side of the hovered row the dragged row will land on. */
export type DropPlacement = 'before' | 'after'

export interface RowRect {
  top: number
  bottom: number
}

/**
 * Which half of the hovered row the pointer is in.
 *
 * The pointer wins over the dragged row's centre because the pointer is what the
 * user is looking at: once a row has been dragged far from where it was picked
 * up, its own centre no longer describes the intent, while the cursor does. The
 * centre of the dragged row is the fallback for a keyboard drag, where there is
 * no pointer to read.
 */
export function dropPlacement(activeRect: RowRect, pointerY: number | null, targetRect: RowRect): DropPlacement {
  const readAt = pointerY ?? (activeRect.top + activeRect.bottom) / 2
  return readAt < (targetRect.top + targetRect.bottom) / 2 ? 'before' : 'after'
}

/**
 * The key the dragged row must land before, or null when this drag changes
 * nothing.
 *
 * Returning null for a no-op is load-bearing rather than tidy: the caller treats
 * "no target" as "cancel the drag", so a drag released on its own row, on the
 * row it already neighbours, or outside the list restores the original order
 * instead of committing a write that reorders nothing.
 *
 * `placement` says which side of `overKey` the pointer is on; the answer is the
 * next key after that side, because a drop is expressed as "before X".
 */
export function dropTargetFrom(
  visibleKeys: readonly string[],
  activeKey: string | null,
  overKey: string | null,
  placement: DropPlacement,
): { beforeKey: string | null } | null {
  if (activeKey == null || overKey == null || activeKey === overKey) return null
  const others = visibleKeys.filter(key => key !== activeKey)
  const overIndex = others.indexOf(overKey)
  if (overIndex === -1) return null
  const beforeKey = others[overIndex + (placement === 'after' ? 1 : 0)] ?? null
  // Already there: the dragged row sits immediately before `beforeKey` today.
  if (visibleKeys.includes(activeKey) && sameKeys(visibleKeys, moveBefore(visibleKeys, activeKey, beforeKey))) return null
  return { beforeKey }
}

/**
 * The key order after moving `activeKey` to sit immediately before
 * `beforeKey` (null = end). Non-mutating.
 *
 * The dragged key is lifted out first, so `beforeKey` is located in the SHORTER
 * list — resolving it against the original list would place the row one slot too
 * far down when dragging downwards.
 */
export function moveBefore(visibleKeys: readonly string[], activeKey: string, beforeKey: string | null): string[] {
  const others = visibleKeys.filter(key => key !== activeKey)
  const index = beforeKey == null ? others.length : others.indexOf(beforeKey)
  if (index === -1) return [...visibleKeys]
  return [...others.slice(0, index), activeKey, ...others.slice(index)]
}

/** Move the item at `index` to `nextIndex`. Non-mutating; a negative
 *  `nextIndex` counts from the end. */
export function arrayMove<T>(items: readonly T[], index: number, nextIndex: number): T[] {
  const copy = items.slice()
  copy.splice(nextIndex < 0 ? copy.length + nextIndex : nextIndex, 0, copy.splice(index, 1)[0]!)
  return copy
}

/**
 * The order to render, given the stored order and the keys that exist now.
 *
 * Three rules, each of which a naive `storedOrder.filter(exists)` breaks:
 *
 *  1. Stored keys keep their stored relative order, and keys that vanished
 *     (a removed project, a friendship with no conversations left) drop out —
 *     otherwise the list grows forever and a stale key would claim a slot.
 *  2. Keys that exist but were never stored come FIRST, in their natural order.
 *     A newly added project is registered at the head of the host's own order
 *     list for the same reason, so both layers agree that new work appears at
 *     the top rather than buried under everything the user arranged earlier.
 *  3. The result always contains exactly `currentKeys`, once each — so the
 *     caller can index rows by it without a fallback path.
 *
 * With no stored order yet this is the identity on `currentKeys`, which is what
 * makes the first paint match the order the host produced.
 */
export function reconcileOrder(storedOrder: readonly string[], currentKeys: readonly string[]): string[] {
  const present = new Set(currentKeys)
  const ordered = storedOrder.filter(key => present.has(key))
  const orderedSet = new Set(ordered)
  return [...currentKeys.filter(key => !orderedSet.has(key)), ...ordered]
}

/** Whether two key lists are equal in length and element order. */
export function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/** Decode a persisted order row. Anything that is not an array of non-empty
 *  strings degrades to an empty order rather than throwing at paint time. */
export function parseStoredOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((key): key is string => typeof key === 'string' && key.length > 0)
}
