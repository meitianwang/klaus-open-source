import type { AgentTask } from './engine-events'
import type { AgentTimelineRecord } from './subagent-stream'

type PositionedEvent = { index: number; event: AgentTimelineRecord }
type SnapshotTask = AgentTask & { activityEvents: AgentTimelineRecord[] }

/** Index each immutable owner timeline once and preserve the original OR filter order. */
export function createAgentTaskSnapshotBuilder() {
  const timelines = new WeakMap<AgentTimelineRecord[], { byTask: Map<string, PositionedEvent[]>; byAgent: Map<string, PositionedEvent[]> }>()
  const snapshots = new WeakMap<Record<string, AgentTask>, {
    rows: Array<{ id: string; task: AgentTask; owner: string; timeline: AgentTimelineRecord[]; snapshot: SnapshotTask }>
    snapshot: Record<string, SnapshotTask>
  }>()
  const eventsFor = (timeline: AgentTimelineRecord[], taskId: string, agentId?: string) => {
    let indexed = timelines.get(timeline)
    if (!indexed) {
      indexed = { byTask: new Map(), byAgent: new Map() }
      for (const [index, event] of timeline.entries()) {
        const row = { index, event }
        const taskRows = indexed.byTask.get(event.taskId) ?? []
        taskRows.push(row); indexed.byTask.set(event.taskId, taskRows)
        if (event.agentId) {
          const agentRows = indexed.byAgent.get(event.agentId) ?? []
          agentRows.push(row); indexed.byAgent.set(event.agentId, agentRows)
        }
      }
      timelines.set(timeline, indexed)
    }
    const byTask = indexed.byTask.get(taskId) ?? []
    const byAgent = agentId ? indexed.byAgent.get(agentId) ?? [] : []
    const events: AgentTimelineRecord[] = []
    let taskIndex = 0, agentIndex = 0
    while (taskIndex < byTask.length || agentIndex < byAgent.length) {
      const task = byTask[taskIndex], agent = byAgent[agentIndex]
      if (agent == null || task != null && task.index < agent.index) { events.push(task.event); taskIndex++ }
      else if (task == null || agent.index < task.index) { events.push(agent.event); agentIndex++ }
      else { events.push(task.event); taskIndex++; agentIndex++ }
    }
    return events
  }
  const build = (tasks: Record<string, AgentTask>, ownerOf: (task: AgentTask) => string, timelineOf: (owner: string) => AgentTimelineRecord[]) => {
    const previous = snapshots.get(tasks)
    const byId = new Map(previous?.rows.map(row => [row.id, row]))
    const rows = Object.entries(tasks).map(([id, task]) => {
      const owner = ownerOf(task)
      const timeline = timelineOf(owner)
      const old = byId.get(id)
      if (old?.task === task && old.owner === owner && old.timeline === timeline) return old
      return { id, task, owner, timeline, snapshot: { ...task, activityEvents: eventsFor(timeline, id, task.agentId) } }
    })
    if (previous && rows.length === previous.rows.length && rows.every((row, index) => row === previous.rows[index])) return previous.snapshot
    const snapshot = Object.fromEntries(rows.map(row => [row.id, row.snapshot]))
    snapshots.set(tasks, { rows, snapshot })
    return snapshot
  }
  return Object.assign(build, { forget: (tasks: Record<string, AgentTask>) => { snapshots.delete(tasks) } })
}
