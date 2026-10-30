import { sameGoalIntent, type GoalSnapshot, type GoalTurnMetadata } from './goals/types'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

const TASK_MUTATION_TOOLS = new Set(['TaskWrite', 'TaskCreate', 'TaskUpdate'])

/** Plan mutations have one visible result: the authoritative current plan. */
export function isTaskMutationTool(name: string | undefined): boolean {
  return TASK_MUTATION_TOOLS.has(name || '')
}

export interface TaskItem {
  id: string
  subject: string
  description?: string
  activeForm?: string
  owner?: string
  status: TaskStatus
  blockedBy: string[]
}

export type TaskPlanKind = 'plan' | 'tasks'

export interface TaskPlanIdentity {
  planId?: string
  planKind?: TaskPlanKind
}

interface TaskPlanState {
  tasks: TaskItem[]
  planId: string
  planKind: TaskPlanKind
  goalEpoch?: number
  carried?: boolean
}

const plansBySession = new Map<string, TaskPlanState>()
const goalsBySession = new Map<string, { goal: GoalSnapshot | null; epoch: number; automaticTurnId: string | null }>()
const listeners = new Set<() => void>()
let version = 0

/**
 * Live tool-call mutations are the second plan input: the change rides the
 * chat stream itself, so the visible plan
 * keeps moving mid-turn even when the authoritative `task_list` push is lost.
 * The engine snapshot stays authoritative — every accepted snapshot replaces
 * the whole list and clears the learned aliases — so a live-applied change
 * can never outrank the store, only fill the window until the next snapshot.
 */
interface LivePlanState {
  /** entryId (`t1`, `f4`) → engine task id, learned from tool results. */
  aliases: Map<string, string>
  /** In-flight Task* calls awaiting their result, keyed by tool call id. */
  pending: Map<string, { toolName: string; args: Record<string, unknown>; json: string }>
}
const liveBySession = new Map<string, LivePlanState>()

function liveState(sessionId: string): LivePlanState {
  let state = liveBySession.get(sessionId)
  if (!state) {
    state = { aliases: new Map(), pending: new Map() }
    liveBySession.set(sessionId, state)
  }
  return state
}

function mutationArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch { /* transport fragment; deltas complete it */ }
    return {}
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

function normalizeStatus(value: unknown): TaskStatus {
  return value === 'completed' || value === 'in_progress' ? value : 'pending'
}

function entryFromInput(raw: unknown): TaskItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const input = raw as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id : ''
  const subject = typeof input.subject === 'string' ? input.subject : ''
  if (!id || !subject) return null
  const item: TaskItem = { id, subject, status: normalizeStatus(input.status), blockedBy: [] }
  if (typeof input.description === 'string' && input.description) item.description = input.description
  if (typeof input.activeForm === 'string' && input.activeForm) item.activeForm = input.activeForm
  if (typeof input.owner === 'string' && input.owner) item.owner = input.owner
  return item
}

/** `#<id> <status>: <subject> [entryId: <alias>]` lines from Task* results. */
function parseResultLines(text: string): Array<{ id: string; status: TaskStatus; entryId?: string }> {
  const lines: Array<{ id: string; status: TaskStatus; entryId?: string }> = []
  for (const line of text.split('\n')) {
    const match = /^#(\S+)\s+(pending|in_progress|completed):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const entryId = /\[entryId:\s*([^\]]+)\]/.exec(match[3])?.[1]
    lines.push({ id: match[1], status: match[2] as TaskStatus, ...(entryId ? { entryId } : {}) })
  }
  return lines
}

function notifyChange(): void {
  version += 1
  for (const listener of listeners) listener()
}

function commitTasks(sessionId: string, tasks: TaskItem[]): void {
  const current = plansBySession.get(sessionId)
  plansBySession.set(sessionId, {
    tasks,
    planId: current?.planId || '',
    planKind: current?.planKind || 'tasks',
    goalEpoch: goalsBySession.get(sessionId)?.epoch,
  })
  notifyChange()
}

function resetCarriedTasks(sessionId: string): void {
  const current = plansBySession.get(sessionId)
  if (!current?.carried) return
  plansBySession.set(sessionId, { ...current, tasks: [], carried: false })
  notifyChange()
}

/** Accounting pushes preserve eligibility; a different objective or stopped goal ends it. */
export function syncTaskGoal(sessionId: string, goal: GoalSnapshot | null): boolean {
  const previous = goalsBySession.get(sessionId)
  if (sameGoalIntent(previous?.goal ?? null, goal)) {
    goalsBySession.set(sessionId, { ...previous!, goal })
    return false
  }
  resetCarriedTasks(sessionId)
  goalsBySession.set(sessionId, { goal, epoch: (previous?.epoch ?? 0) + 1, automaticTurnId: null })
  return true
}

/** Only a turn explicitly admitted for this active goal can retain an empty task display. */
export function beginTaskTurn(sessionId: string, input: GoalTurnMetadata & { turnId: string }): boolean {
  const current = goalsBySession.get(sessionId)
  if (current?.goal?.status === 'active' && input.goalContinuation === true && input.inputOrigin === 'automatic' && input.goalId === current.goal.goalId) {
    current.automaticTurnId = input.turnId
    return true
  }
  resetTaskContinuation(sessionId)
  return false
}

export function resetTaskContinuation(sessionId: string): void {
  const current = goalsBySession.get(sessionId)
  if (current) current.automaticTurnId = null
  resetCarriedTasks(sessionId)
}

/** A live Task* call opened: remember its arguments until the result lands. */
export function noteLiveTaskToolStart(sessionId: string, toolCallId: string, toolName: string, args: unknown): void {
  if (!sessionId || !toolCallId || !TASK_MUTATION_TOOLS.has(toolName)) return
  const json = typeof args === 'string' ? args : ''
  liveState(sessionId).pending.set(toolCallId, { toolName, args: mutationArgs(args), json })
}

/** Streaming argument snapshots complete a Task* call whose args arrived fragmented. */
export function noteLiveTaskToolInputDelta(sessionId: string, toolCallId: string, delta: string): void {
  const pending = liveBySession.get(sessionId)?.pending.get(toolCallId)
  if (!pending) return
  try {
    const snapshot: unknown = JSON.parse(delta)
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      pending.args = { ...pending.args, ...(snapshot as Record<string, unknown>) }
      pending.json = delta
      return
    }
  } catch { pending.json += delta }
}

/** The live result of a Task* call: apply it to the stored plan. */
export function applyLiveTaskToolEnd(sessionId: string, toolCallId: string, isError: boolean, content: unknown): boolean {
  const state = liveBySession.get(sessionId)
  const pending = state?.pending.get(toolCallId)
  if (!state || !pending) return false
  state.pending.delete(toolCallId)
  if (isError) return false
  const text = typeof content === 'string' ? content : ''
  for (const line of parseResultLines(text)) {
    if (line.entryId && line.entryId !== line.id) state.aliases.set(line.entryId, line.id)
  }
  const resolve = (id: string): string => {
    const bare = id.replace(/^#/, '')
    return state.aliases.get(bare) ?? bare
  }
  const stored = plansBySession.get(sessionId)?.tasks
  const tasks = stored ? stored.map(task => ({ ...task, blockedBy: [...task.blockedBy] })) : []
  let changed = false
  const upsert = (item: TaskItem, fields: Partial<TaskItem>): void => {
    const index = tasks.findIndex(task => task.id === item.id)
    if (index === -1) { tasks.push({ ...item, ...fields }); changed = true; return }
    const row = tasks[index]
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      if ((row as Record<string, unknown>)[key] !== value) {
        ;(row as Record<string, unknown>)[key] = value
        changed = true
      }
    }
  }
  if (pending.toolName === 'TaskWrite') {
    const inputTasks = Array.isArray(pending.args.tasks) ? pending.args.tasks : []
    if (pending.args.merge !== true) {
      const replaced = inputTasks.map(entryFromInput).filter((item): item is TaskItem => item !== null)
      for (const line of parseResultLines(text)) {
        const alias = [...state.aliases].find(([, real]) => real === line.id)?.[0]
        const row = replaced.find(item => item.id === (alias ?? line.id))
        if (row) row.id = line.id
      }
      commitTasks(sessionId, replaced)
      return true
    }
    for (const raw of inputTasks) {
      const item = entryFromInput(raw)
      if (!item) continue
      const { id, ...fields } = item
      upsert({ ...item, id: resolve(id) }, fields)
    }
  } else if (pending.toolName === 'TaskUpdate') {
    const id = typeof pending.args.taskId === 'string' ? resolve(pending.args.taskId) : ''
    const index = tasks.findIndex(task => task.id === id)
    if (index === -1) return changed
    const row = tasks[index]
    for (const key of ['subject', 'description', 'activeForm', 'owner'] as const) {
      const value = pending.args[key]
      if (typeof value === 'string' && value && row[key] !== value) { row[key] = value; changed = true }
    }
    if (pending.args.status !== undefined) {
      const status = normalizeStatus(pending.args.status)
      if (row.status !== status) { row.status = status; changed = true }
    }
  } else if (pending.toolName === 'TaskCreate') {
    const created = /^Created task #(\S+?):\s*(.*)$/.exec(text.trim())
    const item = entryFromInput(pending.args)
    if (!created || !item) return changed
    upsert({ ...item, id: created[1] }, { subject: created[2] || item.subject })
  }
  if (!changed) return false
  commitTasks(sessionId, tasks)
  return true
}

/** A terminal turn drops in-flight Task* calls; their results will not arrive. */
export function dropLiveTaskPending(sessionId: string): void {
  const state = liveBySession.get(sessionId)
  if (!state?.pending.size) return
  state.pending.clear()
}

export function taskItems(sessionId: string | null | undefined): TaskItem[] {
  return sessionId ? plansBySession.get(sessionId)?.tasks || [] : []
}

export function hasTaskItems(sessionId: string): boolean {
  return plansBySession.has(sessionId)
}

export function taskPlanIdentity(sessionId: string | null | undefined): TaskPlanIdentity {
  const plan = sessionId ? plansBySession.get(sessionId) : undefined
  return { planId: plan?.planId || '', planKind: plan?.planKind || 'tasks' }
}

/** Structured tasks show their stable ID; ordinary plan steps have no number. */
export function taskNumberLabel(task: TaskItem, index: number, kind: TaskPlanKind): string | null {
  return kind === 'tasks' ? `#${task.id || index + 1}` : null
}

export function setTaskItems(sessionId: string, tasks: unknown[], identity: TaskPlanIdentity = {}): void {
  // Nonempty engine snapshots own membership and order. An empty automatic
  // continuation can temporarily retain its same-goal in-progress display.
  const current = plansBySession.get(sessionId)
  const goal = goalsBySession.get(sessionId)
  const carry = tasks.length === 0 && !!goal?.automaticTurnId && goal.goal?.status === 'active'
    && current?.goalEpoch === goal.epoch && current.tasks.some(task => task.status === 'in_progress')
  plansBySession.set(sessionId, carry ? { ...current, carried: true } : {
    tasks: [...tasks] as TaskItem[], planId: identity.planId || '',
    planKind: identity.planKind === 'plan' ? 'plan' : 'tasks', goalEpoch: goal?.epoch,
  })
  // The snapshot is authoritative: learned entry aliases and in-flight live
  // calls describe the state it already supersedes.
  liveBySession.delete(sessionId)
  version += 1
  for (const listener of listeners) listener()
}

export function forgetTaskItems(sessionId: string): void {
  liveBySession.delete(sessionId)
  goalsBySession.delete(sessionId)
  if (!plansBySession.delete(sessionId)) return
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeTaskItems(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function taskItemsVersion(): number {
  return version
}

export interface TaskProgress {
  completed: number
  total: number
  entries: Array<{ step: string; status: TaskStatus }>
}

export function taskProgress(tasks: TaskItem[]): TaskProgress | null {
  if (tasks.length === 0) return null
  return {
    completed: tasks.filter(task => task.status === 'completed').length,
    total: tasks.length,
    entries: tasks.map(task => ({
      step: task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject,
      status: task.status,
    })),
  }
}
