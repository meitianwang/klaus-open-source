import type { ComputerUsePipAlignment, ComputerUsePipAnchor, ComputerUsePipRect, ComputerUsePipState } from '../../bridge/types'

type Rect = ComputerUsePipRect
export const PIP_ALIGNMENTS: ComputerUsePipAlignment[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const MARGIN = 24
const OBSTACLE_GAP = 12
const FOOTPRINT = 250
const MAX_PASSES = 6

export function pipTaskActive(state: ComputerUsePipState, sessionId: string | null): boolean {
  return state.supported && sessionId !== null && state.activeTaskIds.includes(sessionId)
}

export function pipTaskShown(state: ComputerUsePipState, sessionId: string | null): boolean {
  return pipTaskActive(state, sessionId) && !state.alwaysHidePictureInPicture && state.taskVisibilities[sessionId!] === 'shown'
}

export function acceptPipState(current: ComputerUsePipState, incoming: ComputerUsePipState): ComputerUsePipState {
  return Number.isFinite(incoming.revision) && incoming.revision >= current.revision ? incoming : current
}

function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}

function clampRect(rect: Rect, host: Rect): Rect {
  return {
    ...rect,
    x: Math.min(Math.max(rect.x, MARGIN), Math.max(MARGIN, host.width - rect.width - MARGIN)),
    y: Math.min(Math.max(rect.y, MARGIN), Math.max(MARGIN, host.height - rect.height - MARGIN)),
  }
}

function candidates(alignment: ComputerUsePipAlignment, rect: Rect, obstacle: Rect): Rect[] {
  const down = { ...rect, y: obstacle.y + obstacle.height }
  const up = { ...rect, y: obstacle.y - rect.height }
  const right = { ...rect, x: obstacle.x + obstacle.width }
  const left = { ...rect, x: obstacle.x - rect.width }
  switch (alignment) {
    case 'top-left': return [down, right, left, up]
    case 'top-right': return [down, left, right, up]
    case 'bottom-left': return [up, right, left, down]
    case 'bottom-right': return [up, left, right, down]
  }
}

/** Native cards keep their own size. This footprint only plans unobstructed anchors. */
export function computePipAnchors(host: Rect, obstacles: Rect[], homeSurface: Rect | null): ComputerUsePipAnchor[] {
  const inflated = obstacles.map(rect => ({
    x: rect.x - host.x - OBSTACLE_GAP,
    y: rect.y - host.y - OBSTACLE_GAP,
    width: rect.width + OBSTACLE_GAP * 2,
    height: rect.height + OBSTACLE_GAP * 2,
  }))
  return PIP_ALIGNMENTS.map(alignment => {
    const right = alignment.endsWith('right')
    const bottom = alignment.startsWith('bottom')
    const source = clampRect({
      x: alignment === 'top-right' && homeSurface
        ? homeSurface.x - host.x + homeSurface.width - FOOTPRINT
        : right ? host.width - FOOTPRINT - MARGIN : MARGIN,
      y: alignment === 'top-right' && homeSurface
        ? homeSurface.y - host.y + homeSurface.height + OBSTACLE_GAP
        : bottom ? host.height - FOOTPRINT - MARGIN : MARGIN,
      width: FOOTPRINT,
      height: FOOTPRINT,
    }, host)
    let rect = source
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const obstacle = inflated.find(other => overlap(rect, other) > 0)
      if (!obstacle) break
      let bestScore = Number.POSITIVE_INFINITY
      for (const [priority, candidate] of candidates(alignment, rect, obstacle).entries()) {
        const next = clampRect(candidate, host)
        const area = inflated.reduce((total, other) => total + overlap(next, other), 0)
        const score = (area > 0 ? 1e9 : 0) + area * 1e4 + priority * 1e6
          + (next.x - source.x) ** 2 + (next.y - source.y) ** 2
        if (score < bestScore) {
          bestScore = score
          rect = next
        }
      }
    }
    return { alignment, point: { x: host.x + rect.x + (right ? rect.width : 0), y: host.y + rect.y + (bottom ? rect.height : 0) } }
  })
}

export function scaledPipRect(rect: Rect, zoomFactor: number): Rect {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
  return { x: rect.x / zoom, y: rect.y / zoom, width: rect.width / zoom, height: rect.height / zoom }
}
