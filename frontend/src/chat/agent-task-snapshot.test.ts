import { expect, test } from 'bun:test'
import { createAgentTaskSnapshotBuilder } from './agent-task-snapshot'
import type { AgentTask } from './engine-events'
import type { AgentTimelineRecord } from './subagent-stream'

const event = (key: string, taskId: string, agentId?: string): AgentTimelineRecord => ({ key, taskId, agentId, name: key, status: 'started', timestamp: 1 })

test('indexes each owner once and preserves event order when task and agent identities overlap', () => {
  const build = createAgentTaskSnapshotBuilder()
  const timeline = [event('agent-only', 'alias', 'agent'), event('both', 'task', 'agent'), event('task-only', 'task', 'other'), event('unrelated', 'other')]
  const tasks: Record<string, AgentTask> = { task: { agentId: 'agent' }, other: { agentId: 'other' } }
  const result = build(tasks, () => 'owner', () => timeline)
  expect(result.task.activityEvents.map(row => row.key)).toEqual(['agent-only', 'both', 'task-only'])
  expect(result.other.activityEvents.map(row => row.key)).toEqual(['task-only', 'unrelated'])
})

test('reuses unchanged snapshots but observes replacement and removal inside the same mutable task map', () => {
  const build = createAgentTaskSnapshotBuilder()
  let timeline = [event('start', 'task')]
  const tasks: Record<string, AgentTask> = { task: { description: 'Before' } }
  const owner = () => 'owner'
  const read = () => timeline
  const first = build(tasks, owner, read)
  expect(build(tasks, owner, read)).toBe(first)
  build.forget(tasks)
  expect(build(tasks, owner, read)).not.toBe(first)
  tasks.task = { description: 'After' }
  const replacement = build(tasks, owner, read)
  expect(replacement).not.toBe(first)
  expect(replacement.task.description).toBe('After')
  timeline = [...timeline, event('done', 'task')]
  expect(build(tasks, owner, read).task.activityEvents).toHaveLength(2)
  delete tasks.task
  expect(build(tasks, owner, read)).toEqual({})
})
