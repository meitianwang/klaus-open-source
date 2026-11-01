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

// Refractive orb artwork is rendered once during asset generation. At runtime a
// row is only an image: no canvas, GPU device, animation frame, or observer.
export const SUBAGENT_AVATAR_VARIANTS = 28

export function subagentAvatarHtml(
  value: unknown,
  size: number,
  _status = 'completed',
  fallbackSeed = '',
): string {
  const avatarId = subagentAvatarId(value, fallbackSeed)
  const variant = avatarId % SUBAGENT_AVATAR_VARIANTS
  const dimension = Number.isFinite(size) && size > 0 ? size : 20
  return `<span class="subagent-avatar" style="--subagent-avatar-size:${dimension}px" data-avatar-id="${avatarId}" aria-hidden="true">`
    + `<img class="subagent-avatar-image" src="./subagent-avatars/orb-${variant}.webp" width="${dimension}" height="${dimension}" alt="" draggable="false">`
    + `</span>`
}
