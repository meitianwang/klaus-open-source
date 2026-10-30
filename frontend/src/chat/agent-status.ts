// Reconcile the renderer's sticky task accumulator (tasksBySession) against the
// engine's authoritative background-agent summaries (Session.backgroundAgentSummaries()).
//
// Drift root cause: a background sub-agent's `task` tool returns immediately (fire-and-forget),
// so the accumulator marks it `completed` at once even while it keeps running; and
// autoTerminateVanishedRunningTasks retires a running task the moment its id drops out of a
// snapshot ("子agent状态卡缺口"). The engine's summaries are the source of truth for liveness.
//
// KEY (this is what the first version got wrong): the accumulator is keyed by the *task
// tool_call's item.id*, whereas a summary's `id` is the *agentId (uuid)*. They are NOT equal —
// the agentId lives on the accumulator entry's `.agentId` field (foreground fills it via
// agent_progress, background via the task result). So we index accumulator entries by their
// `.agentId` and match summaries against that, not against the map key.
//
// Rules (klaus only — cc/codex produce no background summaries):
//   - authoritative `running` id      → force task.status='running', task.isIdle=info.idle,
//     unless it also carries completedAtMs; a completion timestamp is terminal
//     evidence and wins over a stale status label
//   - authoritative `completed`/`failed`/`stopped` id → align task.status to the authoritative value
//   - either way the summary's wall-clock timestamps are copied onto the entry: the accumulator
//     is built from tool-call frames, which carry no time at all, so the lifecycle record is the
//     only place the dock's stopwatch and "X ago" can come from
//   - summary whose agentId no accumulator entry carries → skip (the panel renders from the
//     accumulator; fabricating a bare task would lose color/type/description/messages)
//   - accumulator entry no summary covers (fork / foreground / already-cleaned) → left untouched
//
// Pure: never mutates its inputs, returns a fresh object.
//（迁自 js/agent-status.js，逻辑原样。）
import { lifecycleIsOlder, lifecycleVersion } from '../../../contracts/agent-lifecycle'

interface AccumulatorTask {
  agentId?: string
  status?: string
  isIdle?: boolean
  isBackground?: boolean
  lifecycleUpdatedAtMs?: number
  [key: string]: unknown
}

interface AuthoritativeSummary {
  parentAgentId?: string
  spawnTurnId?: string
  depth?: number
  id?: string
  status?: string
  idle?: boolean
  model?: string
  modelSource?: string
  startedAtMs?: number | null
  updatedAtMs?: number | null
  completedAtMs?: number | null
}

// Only finite numbers are carried over. A null (the shell's "not reported") or a
// stray string must leave whatever the entry already had alone, rather than
// overwriting a known start time with an unusable one.
function timestamps(info: AuthoritativeSummary): Record<string, number> {
  const out: Record<string, number> = {}
  for (const field of ['startedAtMs', 'updatedAtMs', 'completedAtMs'] as const) {
    const value = info[field]
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value
  }
  if (typeof info.updatedAtMs === 'number' && Number.isFinite(info.updatedAtMs)) {
    out.recencyAtMs = info.updatedAtMs
  }
  return out
}

/** Presentation-only snapshots must retain the last confirmed lifecycle clock. */
export function preserveAgentLifecycle<T extends AccumulatorTask>(previous: T | undefined, incoming: T): T {
  if (!previous) return incoming
  if (lifecycleIsOlder(previous, { updatedAtMs: incoming.lifecycleUpdatedAtMs })) return previous
  const at = incoming.lifecycleUpdatedAtMs
  if (typeof at === 'number' && Number.isFinite(at)) return incoming
  const before = previous.lifecycleUpdatedAtMs
  return typeof before === 'number' && Number.isFinite(before)
    ? { ...incoming, lifecycleUpdatedAtMs: before }
    : incoming
}

export function reconcileAgentStatus(
  accumulatorTasks: Record<string, AccumulatorTask> | null | undefined,
  authoritative: AuthoritativeSummary[] | null | undefined,
  confirmedMissingAgentIds: ReadonlySet<string> = new Set(),
): Record<string, AccumulatorTask> {
  const result: Record<string, AccumulatorTask> = {}
  const src = (accumulatorTasks && typeof accumulatorTasks === 'object') ? accumulatorTasks : {}
  for (const [id, task] of Object.entries(src)) result[id] = task
  // agentId(uuid) → accumulator map key(tool_call item.id)
  const keyByAgentId = new Map<string, string>()
  for (const [key, task] of Object.entries(result)) {
    if (task && task.agentId) keyByAgentId.set(task.agentId, key)
  }
  const list = Array.isArray(authoritative) ? authoritative : []
  for (const info of list) {
    if (!info || !info.id) continue
    const key = keyByAgentId.get(info.id)
    if (!key) continue
    const prev = result[key]
    if (lifecycleIsOlder(prev, info)) continue
    const times = { ...timestamps(info), ...lifecycleVersion(info) }
    // The engine stamps the concrete model the child run resolved to; carry
    // it onto the row so the sub-agent view can name it. Rows written before
    // the stamp existed simply omit it.
    const attribution = typeof info.model === 'string' && info.model
      ? { model: info.model, ...(typeof info.modelSource === 'string' && info.modelSource ? { modelSource: info.modelSource } : {}) }
      : {}
    const model = { ...attribution,
      ...(typeof info.parentAgentId === 'string' ? { parentAgentId: info.parentAgentId } : {}),
      ...(typeof info.spawnTurnId === 'string' && (!prev.spawnTurnId || prev.parentAgentId !== info.parentAgentId) ? { spawnTurnId: info.spawnTurnId } : {}),
      ...(typeof info.depth === 'number' ? { depth: info.depth } : {}) }
    const hasCompletedAt = typeof info.completedAtMs === 'number' && Number.isFinite(info.completedAtMs)
    if (info.status === 'running' && hasCompletedAt) {
      const stopped = prev.status === 'stopped' || prev.status === 'killed' || prev.status === 'cancelled'
      const failed = prev.status === 'failed'
      result[key] = {
        ...prev,
        ...times,
        ...model,
        status: stopped ? 'stopped' : failed ? 'failed' : 'completed',
        isIdle: false,
        isBackground: true,
      }
    } else if (info.status === 'running') {
      result[key] = { ...prev, ...times, ...model, status: 'running', isIdle: !!info.idle, isBackground: true }
      if (info.completedAtMs === null) delete result[key].completedAtMs
    } else if (info.status === 'completed' || info.status === 'failed' || info.status === 'stopped' || info.status === 'budget_limited') {
      result[key] = { ...prev, ...times, ...model, status: info.status, isIdle: false, isBackground: true }
    }
  }
  for (const [key, task] of Object.entries(result)) {
    if (!task?.agentId || task.isBackground !== true || !confirmedMissingAgentIds.has(task.agentId)) continue
    if (task.status === 'pending' || task.status === 'running') {
      result[key] = { ...task, status: 'completed', isIdle: false }
    }
  }
  return result
}

/** Require two successful authoritative omissions before retiring a cached background run. */
export function observeMissingBackgroundAgents(
  accumulatorTasks: Record<string, AccumulatorTask> | null | undefined,
  authoritative: AuthoritativeSummary[] | null | undefined,
  previous: Record<string, number> | null | undefined,
): { observations: Record<string, number>; confirmed: Set<string> } {
  const authoritativeIds = new Set((Array.isArray(authoritative) ? authoritative : [])
    .map(info => info?.id).filter((id): id is string => typeof id === 'string' && !!id))
  const observations: Record<string, number> = {}
  const confirmed = new Set<string>()
  for (const task of Object.values(accumulatorTasks || {})) {
    if (!task?.agentId || task.isBackground !== true || !['pending', 'running'].includes(String(task.status))
      || authoritativeIds.has(task.agentId)) continue
    const count = (previous?.[task.agentId] || 0) + 1
    observations[task.agentId] = count
    if (count >= 2) confirmed.add(task.agentId)
  }
  return { observations, confirmed }
}

// The reconcile path runs on a timer while any background run is live. Without
// a real change check, every successful poll republishes `tasks_changed` and
// repaints the panel on a fixed cadence, turning a repair path into the update
// path. The comparison covers exactly the fields reconcileAgentStatus can write
// plus the identity fields the dock rows render (avatar, name, status label),
// so a snapshot that differs only in untouched bookkeeping counts as unchanged.
const EQUIVALENCE_FIELDS = [
  'agentId',
  'parentAgentId',
  'spawnTurnId',
  'depth',
  'status',
  'isIdle',
  'isBackground',
  'avatarId',
  'description',
  'objective',
  'model',
  'modelSource',
  'startedAtMs',
  'updatedAtMs',
  'completedAtMs',
  'lifecycleUpdatedAtMs',
  'recencyAtMs',
  'lastAssistantMessageAtMs',
] as const

function equivalenceValue(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? value.toString() : 'nan'
  if (value === undefined || value === null) return 'none'
  return String(value)
}

/** True when two snapshots of one session's task map render identically. */
export function agentTasksEquivalent(
  previous: Record<string, AccumulatorTask> | null | undefined,
  next: Record<string, AccumulatorTask> | null | undefined,
): boolean {
  const before = previous ?? {}
  const after = next ?? {}
  const beforeKeys = Object.keys(before)
  if (beforeKeys.length !== Object.keys(after).length) return false
  for (const key of beforeKeys) {
    const prevTask = before[key]
    const nextTask = after[key]
    if (!nextTask) return false
    for (const field of EQUIVALENCE_FIELDS) {
      if (equivalenceValue(prevTask?.[field]) !== equivalenceValue(nextTask[field])) return false
    }
  }
  return true
}

export function reconcileAgentRuntimeState(
  accumulatorTasks: Record<string, AccumulatorTask> | null | undefined,
  authoritative: AuthoritativeSummary[] | null | undefined,
  confirmedMissingAgentIds: ReadonlySet<string> = new Set(),
): { tasks: Record<string, AccumulatorTask>; working: boolean } {
  const tasks = reconcileAgentStatus(accumulatorTasks, authoritative, confirmedMissingAgentIds)
  const working = Object.values(tasks).some((task) =>
    task?.status === 'pending' || (task?.status === 'running' && !task?.isIdle),
  )
  return { tasks, working }
}

// classic-script 时代的跨文件全局；chat.js 仍经 window 消费。
if (typeof window !== 'undefined') Object.assign(window, { reconcileAgentStatus, reconcileAgentRuntimeState })
