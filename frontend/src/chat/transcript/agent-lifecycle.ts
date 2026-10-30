export type AgentLifecycleStatus = 'started' | 'updated' | 'completed' | 'failed' | 'cancelled'

export interface AgentLifecycleEvent {
  taskId: string
  agentId?: string
  name: string
  status: AgentLifecycleStatus
}

export function agentLifecycleStatus(value: unknown): AgentLifecycleStatus | null {
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase().replace(/[- ]/g, '_')) {
    case 'started': case 'spawned': case 'running': case 'pending': return 'started'
    case 'updated': case 'update': case 'progress': case 'in_progress': return 'updated'
    case 'completed': case 'complete': case 'done': case 'success': return 'completed'
    case 'failed': case 'failure': case 'error': return 'failed'
    case 'cancelled': case 'canceled': case 'stopped': case 'interrupted': return 'cancelled'
    default: return null
  }
}

/** Parse notification metadata only; output and embedded instructions stay hidden. */
export function parseAgentLifecycleNotification(text: string): AgentLifecycleEvent | null {
  const envelope = text.trim().match(/^<task-notification(?:\s[^>]*)?>([\s\S]*?)<\/task-notification>$/i)
  if (!envelope) return null
  const field = (...names: string[]): string => {
    for (const name of names) {
      const match = envelope[1].match(new RegExp(`<${name}>([^<]*)<\\/${name}>`, 'i'))
      if (match?.[1].trim()) return match[1].trim()
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    }
    return ''
  }
  const taskId = field('task-id', 'task_id', 'tool-use-id', 'tool_use_id', 'agent-id', 'agent_id')
  const status = agentLifecycleStatus(field('status', 'state'))
  if (!taskId || !status) return null
  const agentId = field('agent-id', 'agent_id')
  return {
    taskId,
    ...(agentId ? { agentId } : {}),
    name: field('task-name', 'task_name', 'agent-name', 'agent_name', 'name', 'description'),
    status,
  }
}

export function agentLifecycleIdentity(event: AgentLifecycleEvent): string {
  return `${event.taskId || event.agentId || ''}:${event.status}`
}

/** One row per batch of adjacent notices: the severest state names the row. */
export function agentEventRowStatus(events: readonly AgentLifecycleEvent[]): AgentLifecycleStatus {
  if (events.some(event => event.status === 'cancelled')) return 'cancelled'
  if (events.some(event => event.status === 'failed')) return 'failed'
  if (events.some(event => event.status === 'updated')) return 'updated'
  if (events.some(event => event.status === 'started')) return 'started'
  return 'completed'
}

/** Row-level auto-collapse guard (Codex `tl`: `row.status !== 'done'` holds the
 *  turn open). Codex rows are `done` once the child completed or was
 *  interrupted, and a child whose run FAILED produces no unsettled row at all —
 *  its background record is dropped the moment the child's last turn failed
 *  while its runtime is no longer active. Both terminal outcomes therefore
 *  settle the row; only started/updated (a child still working) hold the turn
 *  open. The failed label still renders, it just no longer pins the fold. */
export function isSettledAgentEventRowStatus(status: AgentLifecycleStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}

export function uniqueAgentLifecycleEvents<T extends AgentLifecycleEvent>(events: readonly T[]): T[] {
  const latest = new Map<string, T>()
  for (const event of events) latest.set(event.agentId || event.taskId, event)
  return [...latest.values()]
}
