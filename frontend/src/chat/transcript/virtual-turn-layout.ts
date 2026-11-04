// Geometry for the virtualized turn list.
//
// Positions are expressed as distance from the bottom of the list. A turn
// inserted or resized ABOVE the reading position therefore never changes the
// reader's distance from the bottom; only rows at or below the reading anchor
// do. That single property is what keeps the viewport still while older pages
// prepend, while summaries hydrate into full turns above the viewport, and
// while the newest turn streams below it.

export const DEFAULT_TURN_ESTIMATE_PX = 280
export const TURN_OVERSCAN_COUNT = 2
export const INITIAL_VIEWPORT_HEIGHT_PX = 800
/** Same tolerance the scroll controller uses for "at the bottom". */
export const BOTTOM_TOLERANCE_PX = 24

export interface TurnLayoutEntry {
  key: string
  estimatedHeightPx?: number
  minHeightPx?: number
  gapBeforePx?: number
  turnId?: string | null
  historyGap?: boolean
  firstProtectedItemId?: string | null
}

export interface TurnLayout {
  turnKeys: string[]
  turnIndexByKey: Map<string, number>
  heightsPx: number[]
  gapsBeforePx: number[]
  topOffsetsPx: number[]
  bottomOffsetsPx: number[]
  totalHeightPx: number
}

export interface TurnRange { startIndex: number; endIndex: number }

export interface TurnWindowState {
  distanceFromBottomPx: number
  renderedRange: TurnRange
  turnKeys: string[]
  viewportHeightPx: number
}

export interface TurnRestoreState {
  turnHeightsByKey: Record<string, number>
  renderedWindow: { anchorKey: string; count: number } | null
}

/** Snap to device pixels so measured and estimated geometry agree with layout. */
function snap(value: number, pixelScale: number | null): number {
  return pixelScale == null ? value : Math.round(value * pixelScale) / pixelScale
}

export function buildTurnLayout(entries: readonly TurnLayoutEntry[], measuredHeightsByKey: Readonly<Record<string, number>>,
  options: { gapPx?: number; pixelScale?: number | null } = {}): TurnLayout {
  const gapPx = options.gapPx ?? 0
  const pixelScale = options.pixelScale ?? null
  const turnKeys: string[] = [], heightsPx: number[] = [], gapsBeforePx: number[] = [], topOffsetsPx: number[] = []
  const turnIndexByKey = new Map<string, number>()
  let total = 0
  for (const [index, entry] of entries.entries()) {
    const height = snap(Math.max(entry.minHeightPx ?? 0, measuredHeightsByKey[entry.key] ?? entry.estimatedHeightPx ?? DEFAULT_TURN_ESTIMATE_PX), pixelScale)
    const gap = index > 0 ? snap(entry.gapBeforePx ?? gapPx, pixelScale) : 0
    total += gap
    gapsBeforePx.push(gap)
    turnIndexByKey.set(entry.key, index)
    turnKeys.push(entry.key)
    topOffsetsPx.push(total)
    heightsPx.push(height)
    total += height
  }
  return {
    turnKeys, turnIndexByKey, heightsPx, gapsBeforePx, topOffsetsPx,
    bottomOffsetsPx: topOffsetsPx.map((top, index) => total - top - heightsPx[index]),
    totalHeightPx: total,
  }
}

/** First index whose bottom offset is below `distance` (bottom offsets decrease with index). */
function firstIndexBelow(bottomOffsets: readonly number[], distance: number): number {
  let low = 0, high = bottomOffsets.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((bottomOffsets[middle] ?? 0) < distance) high = middle
    else low = middle + 1
  }
  return low
}

/** First index whose top edge (bottom offset + height) is at or below `distance`. */
function firstIndexWithTopBelow(bottomOffsets: readonly number[], heights: readonly number[], distance: number): number {
  let low = 0, high = bottomOffsets.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((bottomOffsets[middle] ?? 0) + (heights[middle] ?? 0) <= distance) high = middle
    else low = middle + 1
  }
  return low
}

/** Turns intersecting [distance, distance + viewport] from the bottom, plus `overscan` turns each side. */
export function turnRangeForDistance(layout: TurnLayout, distanceFromBottomPx: number, viewportHeightPx: number, overscan: number): TurnRange {
  const count = layout.turnKeys.length
  if (count === 0) return { startIndex: 0, endIndex: 0 }
  const bottom = Math.min(Math.max(0, distanceFromBottomPx), layout.totalHeightPx)
  const top = Math.min(bottom + Math.max(0, viewportHeightPx), layout.totalHeightPx)
  const first = firstIndexBelow(layout.bottomOffsetsPx, top)
  const last = firstIndexWithTopBelow(layout.bottomOffsetsPx, layout.heightsPx, bottom)
  return { startIndex: Math.max(0, first - overscan), endIndex: Math.min(count, Math.max(last, first + 1) + overscan) }
}

/** After keys change, keep the previous first rendered turn as the window start. */
export function rangeAnchoredOnKey(layout: TurnLayout, anchorKey: string, previous: TurnRange): TurnRange | null {
  const index = layout.turnIndexByKey.get(anchorKey)
  return index == null ? null : { startIndex: index, endIndex: Math.min(layout.turnKeys.length, index + previous.endIndex - previous.startIndex) }
}

/** The distance that keeps `anchorKey`'s top edge where it was across two layouts. */
export function distanceKeepingAnchor(anchorKey: string, distanceFromBottomPx: number, previous: TurnLayout, next: TurnLayout): number | null {
  const before = previous.turnIndexByKey.get(anchorKey), after = next.turnIndexByKey.get(anchorKey)
  if (before == null || after == null) return null
  const previousTop = (previous.bottomOffsetsPx[before] ?? 0) + (previous.heightsPx[before] ?? 0)
  const nextTop = (next.bottomOffsetsPx[after] ?? 0) + (next.heightsPx[after] ?? 0)
  return Math.max(0, distanceFromBottomPx + nextTop - previousTop)
}

/** Distance that centers a turn in the viewport. */
export function distanceCenteringTurn(layout: TurnLayout, turnKey: string, viewportHeightPx: number): number | null {
  const index = layout.turnIndexByKey.get(turnKey)
  return index == null ? null : Math.max(0, (layout.bottomOffsetsPx[index] ?? 0) - viewportHeightPx / 2 + (layout.heightsPx[index] ?? 0) / 2)
}

export function rangeCovers(current: TurnRange, required: TurnRange): boolean {
  return current.startIndex <= required.startIndex && current.endIndex >= required.endIndex
}

export function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left === right || left.length === right.length && left.every((key, index) => key === right[index])
}

/** Keep the current rendered range while it still covers what the viewport needs. */
export function nextWindowState(current: TurnWindowState, distanceFromBottomPx: number, layout: TurnLayout, viewportHeightPx: number): TurnWindowState {
  const distance = Math.min(distanceFromBottomPx, layout.totalHeightPx)
  const required = turnRangeForDistance(layout, distance, viewportHeightPx, TURN_OVERSCAN_COUNT)
  const range = rangeCovers(current.renderedRange, required) ? current.renderedRange : required
  return current.distanceFromBottomPx === distance && current.viewportHeightPx === viewportHeightPx
    && current.renderedRange.startIndex === range.startIndex && current.renderedRange.endIndex === range.endIndex
    && sameKeys(current.turnKeys, layout.turnKeys)
    ? current
    : { distanceFromBottomPx: distance, renderedRange: range, turnKeys: layout.turnKeys, viewportHeightPx }
}

/** First window: saved anchor identity when known, otherwise the range at the saved distance. */
export function initialWindowState(layout: TurnLayout, distanceFromBottomPx: number, restore: TurnRestoreState | null | undefined): TurnWindowState {
  const viewportHeightPx = INITIAL_VIEWPORT_HEIGHT_PX
  const distance = Math.min(distanceFromBottomPx, layout.totalHeightPx)
  const computed = turnRangeForDistance(layout, distance, viewportHeightPx, TURN_OVERSCAN_COUNT)
  const saved = restore?.renderedWindow
  const anchored = saved ? rangeAnchoredOnKey(layout, saved.anchorKey, {
    startIndex: 0, endIndex: Math.min(saved.count, computed.endIndex - computed.startIndex),
  }) : null
  return { distanceFromBottomPx: distance, renderedRange: anchored ?? computed, turnKeys: layout.turnKeys, viewportHeightPx }
}

/**
 * The turn whose position the viewport must preserve: the first measured turn
 * fully inside the viewport, else the first partially visible one. Near the
 * bottom, the latest visible turn anchors instead.
 */
export function viewportAnchorKey({ distanceFromBottomPx, preferLatestVisible, layout, measuredHeightsByKey, nextLayout, viewportHeightPx }: {
  distanceFromBottomPx: number
  preferLatestVisible: boolean
  layout: TurnLayout
  measuredHeightsByKey: Readonly<Record<string, number>>
  nextLayout: TurnLayout
  viewportHeightPx: number
}): string | null {
  const range = turnRangeForDistance(layout, distanceFromBottomPx, Math.max(0, viewportHeightPx + Math.min(0, distanceFromBottomPx)), 0)
  let candidate: string | null = null
  for (let index = range.startIndex; index < range.endIndex; index++) {
    const key = layout.turnKeys[index]
    const bottom = layout.bottomOffsetsPx[index] ?? 0
    const height = layout.heightsPx[index] ?? 0
    if (key == null || measuredHeightsByKey[key] == null || !nextLayout.turnIndexByKey.has(key)) continue
    if (bottom >= distanceFromBottomPx + viewportHeightPx || bottom + height <= distanceFromBottomPx) continue
    if (preferLatestVisible) candidate = key
    else {
      candidate ??= key
      if (bottom + height <= distanceFromBottomPx + viewportHeightPx) return key
    }
  }
  return candidate
}

/** Saved measurements for a later visit: only keys still present, plus the rendered window anchor. */
export function captureRestoreState(heights: Readonly<Record<string, number>>, keys: readonly string[], range: TurnRange): TurnRestoreState | null {
  const turnHeightsByKey: Record<string, number> = {}
  for (const key of keys) if (heights[key] != null) turnHeightsByKey[key] = heights[key]
  const anchorKey = keys[range.startIndex]
  return Object.keys(turnHeightsByKey).length === 0 || anchorKey == null ? null
    : { renderedWindow: { anchorKey, count: range.endIndex - range.startIndex }, turnHeightsByKey }
}
