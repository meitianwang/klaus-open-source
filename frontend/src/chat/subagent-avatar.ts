import type { AgentTask } from './engine-events'

const FALLBACK_AVATAR_BASE = 1_000_000_000

export function validSubagentAvatarId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function taskOrder([aId, a]: [string, AgentTask], [bId, b]: [string, AgentTask]): number {
  const aStarted = typeof a.startedAtMs === 'number' && Number.isFinite(a.startedAtMs)
    ? a.startedAtMs
    : Number.POSITIVE_INFINITY
  const bStarted = typeof b.startedAtMs === 'number' && Number.isFinite(b.startedAtMs)
    ? b.startedAtMs
    : Number.POSITIVE_INFINITY
  return aStarted - bStarted || aId.localeCompare(bId)
}

/** Assigns one persistent, non-recycled avatar identity to every task in a session ledger. */
export function normalizeSubagentAvatarIds(tasks: Record<string, AgentTask>): boolean {
  const entries = Object.entries(tasks).sort(taskOrder)
  const assigned = new Map<string, number>()
  const used = new Set<number>()
  let changed = false

  for (const [taskId, task] of entries) {
    const avatarId = validSubagentAvatarId(task.avatarId)
    if (avatarId === null || used.has(avatarId)) continue
    assigned.set(taskId, avatarId)
    used.add(avatarId)
  }

  let nextId = 0
  for (const [taskId, task] of entries) {
    let avatarId = assigned.get(taskId)
    if (avatarId === undefined) {
      while (used.has(nextId)) nextId += 1
      avatarId = nextId
      used.add(avatarId)
      assigned.set(taskId, avatarId)
    }
    if (task.avatarId === avatarId) continue
    tasks[taskId] = { ...task, avatarId }
    changed = true
  }
  return changed
}

export function preserveSubagentAvatarId(previous: AgentTask | undefined, next: AgentTask): AgentTask {
  const avatarId = validSubagentAvatarId(previous?.avatarId)
  return avatarId === null ? next : { ...next, avatarId }
}

function hashSeed(seed: string): number {
  let hash = 2_166_136_261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

export function subagentAvatarId(value: unknown, fallbackSeed = ''): number {
  return validSubagentAvatarId(value) ?? (FALLBACK_AVATAR_BASE + hashSeed(fallbackSeed))
}

// Each identity draws a small mirrored 4x4 mark (left columns reflected onto the
// right) in one of a fixed set of hues. The bits and the hue come from mixing the
// identity, so neighbouring ids look unrelated and the same id always draws the
// same mark. Colours are CSS variables, so the theme switches without new assets.
export const SUBAGENT_AVATAR_HUES = 12

function mix(value: number): number {
  let x = value >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** The cells (column, row) of the mark for an identity, plus its hue index. */
export function subagentAvatarPattern(avatarId: number): { hue: number; cells: Array<[number, number]> } {
  const bits = mix(avatarId)
  const cells: Array<[number, number]> = []
  // 8 bits fill the left two columns of a 4x4 grid; the right half mirrors them.
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      if (bits & (1 << (row * 2 + column))) cells.push([column, row], [3 - column, row])
    }
  }
  // An empty mark would read as a missing image; fall back to a centred bar.
  if (cells.length === 0) cells.push([1, 1], [2, 1], [1, 2], [2, 2])
  return { hue: (bits >>> 8) % SUBAGENT_AVATAR_HUES, cells }
}

export function subagentAvatarHtml(
  value: unknown,
  size: number,
  _status = 'completed',
  fallbackSeed = '',
): string {
  const avatarId = subagentAvatarId(value, fallbackSeed)
  const { hue, cells } = subagentAvatarPattern(avatarId)
  const dimension = Number.isFinite(size) && size > 0 ? size : 20
  const rects = cells.map(([column, row]) => `<rect x="${2 + column * 3}" y="${2 + row * 3}" width="3" height="3" rx="0.6"/>`).join('')
  return `<span class="subagent-avatar" style="--subagent-avatar-size:${dimension}px" data-avatar-id="${avatarId}" data-avatar-hue="${hue}" aria-hidden="true">`
    + `<svg viewBox="0 0 16 16" width="${dimension}" height="${dimension}" focusable="false">`
    + `<rect class="subagent-avatar-tile" width="16" height="16" rx="4"/>`
    + `<g class="subagent-avatar-mark">${rects}</g>`
    + `</svg></span>`
}
