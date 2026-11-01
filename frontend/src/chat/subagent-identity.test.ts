import { describe, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/subagent-identity-vectors.json'
import type { AgentTask } from './engine-events'
import { subagentDisplayName } from './subagent-identity'
import { normalizeSubagentAvatarIds, preserveSubagentAvatarId, subagentAvatarHtml } from './subagent-avatar'

describe('task-based subagent identity', () => {
  test('uses task titles and localized pending placeholders from the committed vectors', () => {
    for (const row of vectors.cases) expect(subagentDisplayName('task', row.task, row.locale)).toBe(row.expected)
  })

  test('keeps authored titles, avatar identities and peer addresses intact when switching language', () => {
    const task = { description: '检查权限', avatarId: 0, agentName: 'reviewer', agentId: 'child' }
    const original = structuredClone(task)
    const avatar = subagentAvatarHtml(task.avatarId, 20, 'completed', task.agentId)
    for (const locale of ['en', 'zh-CN', 'en']) {
      expect(subagentDisplayName('task', task, locale)).toBe('检查权限')
      expect(subagentAvatarHtml(task.avatarId, 20, 'completed', task.agentId)).toBe(avatar)
    }
    expect(task).toEqual(original)
  })

  test('keeps task titles across snapshot replacement and serialized history reload', () => {
    const tasks: Record<string, AgentTask> = {
      first: { description: '搜索设置', agentType: 'explorer', startedAtMs: 1 },
      second: { description: '检查权限', agentType: 'explorer', startedAtMs: 2 },
    }
    normalizeSubagentAvatarIds(tasks)
    tasks.first = preserveSubagentAvatarId(tasks.first, { ...tasks.first, agentId: 'new-child', status: 'completed' })
    const reloaded = JSON.parse(JSON.stringify(tasks)) as Record<string, AgentTask>
    normalizeSubagentAvatarIds(reloaded)
    expect(Object.entries(reloaded).map(([id, task]) => subagentDisplayName(id, task, 'zh'))).toEqual(['搜索设置', '检查权限'])
  })

  test('shows the task title before the avatar identity is assigned', () => {
    const tasks = { spawn: { agentId: 'child', description: '定位崩溃原因' } }
    expect(subagentDisplayName('spawn', tasks.spawn, 'zh')).toBe('定位崩溃原因')
    normalizeSubagentAvatarIds(tasks)
    expect(subagentDisplayName('spawn', tasks.spawn, 'zh')).toBe('定位崩溃原因')
  })
})
