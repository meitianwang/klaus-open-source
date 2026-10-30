import { describe, expect, test } from 'bun:test'
import { coalesceSubagentTaskAliases, navigateToSubagentConversation } from './subagent-navigation'
import type { AgentTask } from './engine-events'

describe('subagent conversation navigation', () => {
  function fixture(initial: Record<string, AgentTask> = {}) {
    let selected = 'parent'
    let tasks = initial
    const opened: string[] = []
    let unavailable = 0
    let requests = 0
    const navigation = {
      selectedSessionId: () => selected,
      tasks: () => tasks,
      snapshot: async (_sessionId: string) => { requests++; return { tasks: { discovered: { agentId: 'child', status: 'running' } } } },
      merge: (_sessionId: string, incoming: Record<string, AgentTask>) => { tasks = coalesceSubagentTaskAliases({ ...tasks, ...incoming }) },
      open: (taskId: string) => { opened.push(taskId) },
      unavailable: () => { unavailable++ },
    }
    return { navigation, opened, select: (id: string) => { selected = id }, counts: () => ({ requests, unavailable }), tasks: () => tasks }
  }
  test('registered child opens its task directly without a snapshot', async () => {
    const value = fixture({ registered: { agentId: 'child' } })
    await navigateToSubagentConversation('child', value.navigation)
    expect(value.opened).toEqual(['registered'])
    expect(value.counts()).toEqual({ requests: 0, unavailable: 0 })
  })
  test('a real child preceding registration hydrates and opens the discovered task', async () => {
    const value = fixture()
    await navigateToSubagentConversation('child', value.navigation)
    expect(value.opened).toEqual(['discovered'])
    expect(value.counts()).toEqual({ requests: 1, unavailable: 0 })
  })
  test('a missing child reports unavailable instead of silently doing nothing', async () => {
    const value = fixture()
    await navigateToSubagentConversation('missing', value.navigation)
    expect(value.opened).toEqual([])
    expect(value.counts()).toEqual({ requests: 1, unavailable: 1 })
  })
  test('a failed snapshot reports unavailable', async () => {
    const value = fixture()
    value.navigation.snapshot = async () => { throw new Error('Unavailable') }
    await navigateToSubagentConversation('child', value.navigation)
    expect(value.opened).toEqual([])
    expect(value.counts().unavailable).toBe(1)
  })
  test('changing parent during hydration cannot open a child in another parent', async () => {
    const value = fixture()
    value.navigation.snapshot = async () => { value.select('other'); return { tasks: { discovered: { agentId: 'child', status: 'running' } } } }
    await navigateToSubagentConversation('child', value.navigation)
    expect(value.opened).toEqual([])
    expect(value.tasks()).toEqual({})
    expect(value.counts().unavailable).toBe(0)
  })
  test('later task registration coalesces early identity without losing messages or avatar', () => {
    expect(coalesceSubagentTaskAliases({
      child: { agentId: 'child', avatarId: 48, messages: ['first'], notified: true },
      dispatch: { agentId: 'child', description: 'Review', status: 'completed' },
    })).toEqual({ dispatch: { agentId: 'child', avatarId: 48, messages: ['first'], notified: true, description: 'Review', status: 'completed' } })
  })
})
