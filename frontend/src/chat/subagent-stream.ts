import type { AgentNotification, AgentTask } from './engine-events'
import { parseAgentLifecycleNotification, type AgentLifecycleEvent, type AgentLifecycleStatus } from './transcript/agent-lifecycle'

export type AgentEventStatus = AgentLifecycleStatus
export interface AgentTimelineRecord extends AgentLifecycleEvent {
  key: string
  taskId: string
  agentId?: string
  name: string
  status: AgentEventStatus
  timestamp: number
  turnId?: string
  afterMessageId?: string
  afterToolCallId?: string
  notificationId?: string
  source?: AgentNotification['source']
}

/** Internal child progress from older sidecars was never a delivered notice. */
export function isVisibleAgentActivity(event: AgentTimelineRecord): boolean {
  return event.status !== 'updated' || !!event.notificationId
}

export function sameAgentActivity(a: Pick<AgentTimelineRecord, 'taskId' | 'agentId'>, b: Pick<AgentTimelineRecord, 'taskId' | 'agentId'>): boolean {
  return a.agentId && b.agentId ? a.agentId === b.agentId : a.taskId === b.taskId
}

/** Task registration can arrive after a delivery or after history hydration. */
export function resolveAgentActivityTask<T extends AgentLifecycleEvent>(event: T, tasks: Record<string, AgentTask>): T {
  const nameMatches = Object.keys(tasks).filter(id => tasks[id].agentName === event.name
    && (!event.agentId || !tasks[id].agentId || tasks[id].agentId === event.agentId))
  const taskId = Object.keys(tasks).find(id => tasks[id].agentId && tasks[id].agentId === (event.agentId || event.taskId))
      || (nameMatches.length === 1 ? nameMatches[0] : undefined)
      || (tasks[event.taskId] && (!event.agentId || !tasks[event.taskId].agentId) ? event.taskId : undefined)
  if (!taskId) return event
  const task = tasks[taskId]
  return { ...event, taskId, agentId: task.agentId || event.agentId, name: task.description || event.name }
}

/** Preserve local anchors while merging the durable delivery ledger. */
export function mergeAgentActivityRecords(current: AgentTimelineRecord[], incoming: AgentTimelineRecord[]): AgentTimelineRecord[] {
  const result = current.filter(isVisibleAgentActivity)
  for (const record of incoming.filter(isVisibleAgentActivity)) {
    const reverseIndex = [...result].reverse().findIndex(existing => existing.key === record.key
      || !!record.notificationId && existing.notificationId === record.notificationId
      || record.status !== 'updated' && record.status !== 'started' && record.status === existing.status
        && (!record.notificationId || !existing.notificationId)
        && record.turnId === existing.turnId
        && sameAgentActivity(record, existing))
    const index = reverseIndex < 0 ? -1 : result.length - reverseIndex - 1
    if (index < 0) result.push(record)
    else result[index] = { ...record, ...result[index],
      notificationId: result[index].notificationId || record.notificationId,
      source: result[index].source || record.source }
  }
  return result.sort((a, b) => a.timestamp - b.timestamp)
}

export function agentNotificationActivity(notification: AgentNotification, tasks: Record<string, AgentTask>): Omit<AgentTimelineRecord, 'key'> | null {
  if (!notification || typeof notification.notificationId !== 'string' || !notification.notificationId
    || !['background-task', 'team-mailbox'].includes(notification.source)
    || !['updated', 'completed', 'failed', 'cancelled'].includes(notification.status)) return null
  const taskId = notification.agentId || notification.taskId || notification.agentName
  if (!taskId) return null
  const resolved = resolveAgentActivityTask({ taskId, agentId: notification.agentId,
    name: notification.agentName || '', status: notification.status }, tasks)
  return {
    ...resolved, name: resolved.name || agentTaskName(tasks[resolved.taskId], resolved.taskId),
    status: notification.status, notificationId: notification.notificationId, source: notification.source,
    timestamp: typeof notification.timestamp === 'number' && Number.isFinite(notification.timestamp) ? notification.timestamp : Date.now(),
    ...(notification.turnId ? { turnId: notification.turnId } : {}),
  }
}

export function subagentStreamId(parentSessionId: string, agentId: string): string {
  return `subagent:${encodeURIComponent(parentSessionId)}:${encodeURIComponent(agentId)}`
}

export function agentTerminalStatus(status: unknown): AgentEventStatus | null {
  if (status === 'completed' || status === 'done') return 'completed'
  // A budget ceiling ended the child's stream for good; it is terminal, and
  // the partial text it left behind is its answer, not an error.
  if (status === 'budget_limited') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'killed' || status === 'cancelled' || status === 'stopped' || status === 'interrupted') return 'cancelled'
  return null
}

export function agentTaskName(task: Partial<AgentTask> | undefined, fallback: string): string {
  return String(task?.description || fallback)
}

// Synthetic activity is presentation state, never model input. Split a replay
// message at its actual tool/message boundary so history handoff does not move
// every child update below the parent's final answer.
export function mergeAgentTimeline(history: any[], timeline: AgentTimelineRecord[]): any[] {
  if (!timeline.length) return history
  const notifications = history.flatMap(message => {
    const notification = typeof message.text === 'string' ? parseAgentLifecycleNotification(message.text) : null
    return notification ? [{ ...notification, turnId: message.turnId }] : []
  })
  const pending = timeline.filter(event => isVisibleAgentActivity(event) && !notifications.some(notification =>
    notification.status === event.status && event.status !== 'updated'
      && notification.turnId === event.turnId
      && (notification.taskId === event.taskId || !!event.agentId && notification.agentId === event.agentId)))
  const result: any[] = []
  const row = (event: AgentTimelineRecord) => ({
    kind: 'agent-event', role: 'assistant', uuid: event.key,
    timestamp: event.timestamp, turnId: event.turnId, agentEvent: event,
  })
  for (const message of history) {
    const blocks = message.contentBlocks
    if (!Array.isArray(blocks)) { result.push(message); continue }
    let segment: any[] = []
    let part = 0
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]
      segment.push(block)
      const matching = pending.filter(event => (!event.turnId || !message.turnId || event.turnId === message.turnId) && (
        event.afterToolCallId ? block.type === 'tool_use' && block.id === event.afterToolCallId
          : event.afterMessageId && block.messageId === event.afterMessageId
            && blocks[index + 1]?.messageId !== event.afterMessageId))
      if (!matching.length) continue
      result.push({ ...message, uuid: `${message.uuid || message.id || 'activity'}:part:${part++}`, contentBlocks: segment })
      segment = []
      for (const event of matching) {
        result.push(row(event))
        pending.splice(pending.indexOf(event), 1)
      }
    }
    if (segment.length) result.push(part ? { ...message, contentBlocks: segment } : message)
  }
  for (const event of pending) {
    // History rows carry no timestamp — the saved projection zeroes it — so a
    // timestamp scan alone strands every unanchored notice at the transcript
    // tail. A failed turn's late deliveries would then form a turn group AFTER
    // the conversation's real last turn, and foldUnits renders that group's
    // failure pill and file card as if the session ended in error. Turn
    // ownership is durable: place the notice at the end of its own turn first;
    // timestamps only order notices whose turn has no rows at all.
    let index = -1
    if (typeof event.turnId === 'string' && event.turnId) {
      for (let position = result.length - 1; position >= 0; position--) {
        if (result[position]?.turnId === event.turnId) { index = position + 1; break }
      }
    }
    if (index < 0) {
      index = result.findIndex(message => {
        const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp || '')
        return Number.isFinite(timestamp) && timestamp > event.timestamp
      })
    }
    if (index < 0) result.push(row(event))
    else result.splice(index, 0, row(event))
  }
  return result
}
