import { describe, expect, test } from 'bun:test'
import { mergeAgentTimeline, subagentStreamId, type AgentTimelineRecord } from './subagent-stream'
import streamVectors from '../../../contracts/vectors/subagent-stream-vectors.json'

;(globalThis as any).window ||= {}
;(globalThis as any).window.addEventListener ||= () => {}
const stream = await import('./stream-store')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('child conversation streaming', () => {
  test('pre-start child terminal vectors retain failure and cancellation without settling the parent', () => {
    const cases = streamVectors.cases.filter(row => row.event.type === 'turn.failed')
    expect(cases.length).toBe(2)
    for (const row of cases) {
      const sessionId = `pre-start-child-${row.name}`
      stream.ingestLocalUserTurn(sessionId, { text: 'Review the workspace' })
      stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'parent-run' })
      for (const event of row.expected) stream.ingestChatEvent({ ...event, sessionId })
      const child = stream.getSessionStream(subagentStreamId(sessionId, 'child-agent'))
      const failed = row.event.error?.code === 'invalid_input'
      expect(child.running).toBe(false)
      expect(child.lastTerminalStatus).toBe(failed ? 'failed' : 'interrupted')
      expect(stream.getSessionStream(sessionId).running).toBe(true)
      expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual([failed ? 'failed' : 'cancelled'])
      const errors = child.liveUnits.filter(unit => unit.type === 'live-error')
      expect(errors.length).toBe(failed ? 1 : 0)
      if (errors[0]?.type === 'live-error') expect(errors[0].text).toBe(row.event.error?.message)
    }
  })

  test('run start is emitted once across request rounds, updates and late task registration', () => {
    const sessionId = 'child-start-rounds'
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'parent-run' })
    const send = (event: any) => stream.ingestChatEvent({ type: 'agent_progress', sessionId, agentId: 'child-start', label: 'Review API', event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'child-run' })
    stream.ingestChatEvent({ sessionId, type: 'agent_notification', agentId: 'child-start', notificationId: 'start-update', source: 'team-mailbox', status: 'updated' })
    send({ type: 'stream_mode', mode: 'requesting' })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'child-run' })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { agentId: 'child-start', description: 'Review API', status: 'running' } } })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started', 'updated'])
    expect(stream.getSessionStream(sessionId).agentTimeline[0]).toMatchObject({ taskId: 'task', turnId: 'parent-run' })
  })

  test('resumed child becomes running immediately and its notices keep the new parent turn', async () => {
    const sessionId = 'child-resume-owner'
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'first-parent' })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { agentId: 'resumed-child', description: 'Review API', status: 'running' } } })
    const send = (event: any) => stream.ingestChatEvent({ type: 'agent_progress', sessionId, agentId: 'resumed-child', event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'first-child' })
    send({ type: 'done', turnId: 'first-child' })
    await flush()
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'second-parent' })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'second-child' })
    expect(stream.getSessionStream(subagentStreamId(sessionId, 'resumed-child')).running).toBe(true)
    expect(stream.getSessionStream(sessionId).agentTasks.task).toMatchObject({ status: 'running', spawnTurnId: 'second-parent' })
    send({ type: 'done', turnId: 'second-child' })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => [event.status, event.turnId])).toEqual([
      ['started', 'first-parent'], ['completed', 'first-parent'], ['started', 'second-parent'], ['completed', 'second-parent'],
    ])
  })

  test('older task snapshots cannot manufacture completion and restart', () => {
    const sessionId = 'stale-child-snapshot'
    const task = { agentId: 'versioned-child', description: 'Review API', status: 'running', lifecycleUpdatedAtMs: 200 }
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { ...task, status: 'completed', lifecycleUpdatedAtMs: 100 } } })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
    expect(stream.getSessionStream(sessionId).agentTasks.task.status).toBe('running')
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started'])
  })

  test('late terminal events from an old child turn cannot complete its resumed run', () => {
    const sessionId = 'late-old-child-terminal'
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'first-parent' })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { agentId: 'continued-child', status: 'running' } } })
    const send = (event: any) => stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: 'continued-child', event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'first-child' })
    send({ type: 'done', turnId: 'first-child' })
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'second-parent' })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'second-child' })
    for (const type of ['done', 'interrupted', 'api_error']) send({ type, turnId: 'first-child', terminal: true, error: 'Old failure' })
    expect(stream.getSessionStream(subagentStreamId(sessionId, 'continued-child'))).toMatchObject({ running: true, activeTurnId: 'second-child' })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => [event.status, event.turnId])).toEqual([
      ['started', 'first-parent'], ['completed', 'first-parent'], ['started', 'second-parent'],
    ])
  })

  test('equal-clock completion from a previous run cannot terminate a resumed stream', () => {
    const sessionId = 'same-clock-child-resume'
    stream.seedSubagentTasks(sessionId, { task: { agentId: 'same-clock-child', status: 'completed', lifecycleUpdatedAtMs: 200, spawnTurnId: 'old-parent' } })
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'new-parent' })
    stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: 'same-clock-child', event: { type: 'stream_mode', mode: 'requesting', turnId: 'new-child' } })
    const stale = { agentId: 'same-clock-child', status: 'completed', lifecycleUpdatedAtMs: 200, spawnTurnId: 'old-parent' }
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: stale } })
    stream.seedSubagentTasks(sessionId, { task: stale })
    expect(stream.getSessionStream(subagentStreamId(sessionId, 'same-clock-child')).running).toBe(true)
    expect(stream.getSessionStream(sessionId).agentTasks.task).toMatchObject({ status: 'running', spawnTurnId: 'new-parent' })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started'])
  })

  test('panel reseeding preserves ownership and late completion cannot split the active parent turn', () => {
    const sessionId = 'late-completion-other-turn'
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'old-parent' })
    const task = { agentId: 'late-child', description: 'Review API', status: 'running' }
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
    // Mirror chatEvent -> mergeAgentTasks -> seedSubagentTasks using raw panel rows.
    stream.seedSubagentTasks(sessionId, { task })
    expect(stream.getSessionStream(sessionId).agentTasks.task.spawnTurnId).toBe('old-parent')
    stream.ingestChatEvent({ sessionId, type: 'text_delta', messageId: 'old-comment', text: 'Old progress', phase: 'commentary' })
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'new-parent' })
    stream.ingestChatEvent({ sessionId, type: 'text_delta', messageId: 'new-comment', text: 'New progress', phase: 'commentary' })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { ...task, status: 'completed' } } })
    const state = stream.getSessionStream(sessionId)
    expect(state.liveUnits.at(-1)).toMatchObject({ type: 'live-text', messageId: 'new-comment', turnId: 'new-parent' })
    expect(state.agentTimeline.at(-1)).toMatchObject({ status: 'completed', turnId: 'old-parent', afterMessageId: 'old-comment' })
    expect(state.agentTimeline.at(-1)?.afterToolCallId).toBeUndefined()
  })

  test('a saved old-turn anchor cannot insert its notice into a newer turn', () => {
    const history = [
      { role: 'assistant', uuid: 'old-final', turnId: 'old-parent', text: 'Old answer' },
      { role: 'assistant', uuid: 'new-progress', turnId: 'new-parent', contentBlocks: [{ type: 'text', messageId: 'new-anchor', text: 'New progress' }] },
    ]
    const event: AgentTimelineRecord = { key: 'late-old', taskId: 'task', name: 'Review API', status: 'completed', timestamp: 200,
      turnId: 'old-parent', afterMessageId: 'new-anchor' }
    expect(mergeAgentTimeline(history, [event]).map(row => [row.kind || row.role, row.turnId])).toEqual([
      ['assistant', 'old-parent'], ['agent-event', 'old-parent'], ['assistant', 'new-parent'],
    ])
  })

  test('a prior-turn persisted completion cannot suppress a later run completion', () => {
    const history = [{ role: 'user', uuid: 'old-notice', turnId: 'first-parent',
      text: '<task-notification><task-id>task</task-id><status>completed</status></task-notification>' }]
    const event: AgentTimelineRecord = { key: 'new-completion', taskId: 'task', name: 'Review API', status: 'completed', timestamp: 200, turnId: 'second-parent' }
    expect(mergeAgentTimeline(history, [event]).at(-1)).toMatchObject({ kind: 'agent-event', turnId: 'second-parent' })
    expect(mergeAgentTimeline(history, [{ ...event, turnId: 'first-parent' }])).toEqual(history)
  })

  test('child deltas and tool progress use the main reducer without changing the parent run', () => {
    const parent = 'child-stream-parent'
    const agentId = 'child-A'
    const send = (event: any) => stream.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId, event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'child-turn' })
    send({ type: 'thinking_delta', thinking: 'Inspecting the source' })
    const id = subagentStreamId(parent, agentId)
    expect(stream.getSessionStream(id).thinkingText).toBe('Inspecting the source')
    send({ type: 'text_delta', messageId: 'child-message', text: 'First ', phase: 'commentary' })
    send({ type: 'text_delta', messageId: 'child-message', text: 'update', phase: 'commentary' })
    send({ type: 'tool_start', toolCallId: 'read-1', toolName: 'read', args: { file_path: '/project/main.ts' } })
    send({ type: 'progress', toolCallId: 'read-1', content: 'line 1\n' })
    const child = stream.getSessionStream(id)
    expect(child.liveUnits.find(unit => unit.type === 'live-text')?.text).toBe('First update')
    expect(child.tools['read-1'].progress).toEqual(['line 1\n'])
    expect(child.running).toBe(true)
    expect(stream.getSessionStream(parent).running).toBe(false)
    expect(stream.getSessionStream(parent).tools).toEqual({})
  })

  test('history uses the child endpoint and preserves disclosure choices through terminal handoff', async () => {
    const parent = 'child-history-parent'
    const agentId = 'child-history'
    const calls: unknown[] = []
    const history = [{ role: 'assistant', uuid: 'child-final', contentBlocks: [{ type: 'text', text: 'Done' }] }]
    ;(window as any).klaus = { agents: { history: async (...args: unknown[]) => { calls.push(args); return { messages: history } } } }
    const id = stream.prepareSubagentStream(parent, 'spawn-1', { agentId, status: 'running' })
    stream.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId, event: { type: 'text_delta', text: 'Done' } })
    stream.setTurnCollapsed(id, 'tool:read-1', false)
    stream.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId, event: { type: 'done' } })
    await flush()
    expect(calls).toEqual([[parent, agentId]])
    expect(stream.getSessionStream(id).history).toEqual(history)
    expect(stream.getSessionStream(id).liveUnits).toEqual([])
    expect(stream.getSessionStream(id).turnCollapseOverrides['tool:read-1']).toBe(false)
  })

  test('child-owned notifications stay inside the child and survive message-only task snapshots', async () => {
    const parent = 'nested-notice-parent', agentId = 'recipient-child'
    const notice = { notificationId: 'child-received', source: 'team-mailbox', status: 'updated', agentName: 'Nested reviewer', timestamp: 20, turnId: 'child-turn' }
    stream.seedSubagentTasks(parent, { child: { agentId, type: 'in_process_teammate', status: 'running', messages: [{ role: 'assistant', text: 'Cached text only' }] } })
    ;(window as any).klaus = { agents: { history: async () => ({ messages: [{ role: 'assistant', text: 'Durable child reply', timestamp: 30 }], agentNotifications: [notice] }) } }
    stream.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId, event: { type: 'agent_notification', ...notice } })
    const childId = subagentStreamId(parent, agentId)
    expect(stream.getSessionStream(parent).agentTimeline).toEqual([])
    expect(stream.getSessionStream(childId).agentTimeline).toHaveLength(1)
    stream.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId, event: { type: 'done' } })
    await flush()
    const child = stream.getSessionStream(childId)
    expect(child.agentTimeline).toHaveLength(1)
    expect(child.history?.map(row => row.kind || row.text)).toEqual(['agent-event', 'Durable child reply'])
    expect(stream.getSessionStream(parent).agentTimeline.map(event => event.status)).toEqual(['completed'])
  })

  test('persistent teammate run completion settles the process while the teammate remains reusable', () => {
    const sessionId = 'persistent-child-run'
    const task = { agentId: 'persistent-child', description: 'Review API', type: 'in_process_teammate', status: 'running' }
    const send = (event: any) => stream.ingestChatEvent({ sessionId, ...event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'first-parent' })
    send({ type: 'tasks_changed', tasks: { task } })
    send({ type: 'agent_progress', agentId: task.agentId, event: { type: 'stream_mode', mode: 'requesting', turnId: 'first-child' } })
    send({ type: 'agent_progress', agentId: task.agentId, event: { type: 'done', turnId: 'first-child' } })
    send({ type: 'tasks_changed', tasks: { task: { ...task, isIdle: true } } })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started', 'completed'])
    expect(stream.getSessionStream(sessionId).agentTasks.task).toMatchObject({ status: 'running', isIdle: true })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'second-parent' })
    send({ type: 'agent_progress', agentId: task.agentId, event: { type: 'stream_mode', mode: 'requesting', turnId: 'second-child' } })
    send({ type: 'agent_progress', agentId: task.agentId, event: { type: 'done', turnId: 'second-child' } })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => [event.status, event.turnId])).toEqual([
      ['started', 'first-parent'], ['completed', 'first-parent'], ['started', 'second-parent'], ['completed', 'second-parent'],
    ])
  })

  test('persistent teammate idle snapshot settles a run even without its terminal stream event', () => {
    const sessionId = 'persistent-child-idle'
    const task = { agentId: 'idle-child', description: 'Review API', type: 'in_process_teammate', status: 'running' }
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
    stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: task.agentId, event: { type: 'stream_mode', mode: 'requesting', turnId: 'child-run' } })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { ...task, isIdle: true } } })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { ...task, isIdle: true } } })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started', 'completed'])
    expect(stream.getSessionStream(subagentStreamId(sessionId, task.agentId)).running).toBe(false)
    expect(stream.getSessionStream(sessionId).agentTasks.task.status).toBe('running')
  })

  test('persistent teammate idle snapshot retains the interrupted run outcome', () => {
    const sessionId = 'persistent-child-interrupted'
    const task = { agentId: 'interrupted-teammate', type: 'in_process_teammate', status: 'running' }
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
    stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: task.agentId, event: { type: 'stream_mode', mode: 'requesting', turnId: 'child-run' } })
    stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: task.agentId, event: { type: 'interrupted', turnId: 'child-run' } })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { ...task, isIdle: true } } })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started', 'cancelled'])
  })

  test('a snapshot-only teammate run does not inherit the preceding run failure', () => {
    const sessionId = 'persistent-child-next-snapshot'
    const task = { agentId: 'recovering-teammate', type: 'in_process_teammate', status: 'running' }
    const send = (event: any) => stream.ingestChatEvent({ sessionId, ...event })
    send({ type: 'tasks_changed', tasks: { task } })
    send({ type: 'agent_progress', agentId: task.agentId, event: { type: 'stream_mode', mode: 'requesting', turnId: 'failed-child' } })
    send({ type: 'agent_progress', agentId: task.agentId, event: { type: 'api_error', terminal: true, turnId: 'failed-child', error: 'Unavailable' } })
    send({ type: 'tasks_changed', tasks: { task: { ...task, isIdle: true } } })
    send({ type: 'tasks_changed', tasks: { task: { ...task, isIdle: false } } })
    send({ type: 'tasks_changed', tasks: { task: { ...task, isIdle: true } } })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started', 'failed', 'started', 'completed'])
  })

  test('failed child snapshots display their error or a nonempty fallback', () => {
    for (const error of ['Provider request timed out', undefined]) {
      const sessionId = `child-snapshot-error-${error ?? 'missing'}`
      const task = { agentId: 'snapshot-child', status: 'running' }
      stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
      stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { ...task, status: 'failed', error } } })
      const child = stream.getSessionStream(subagentStreamId(sessionId, task.agentId))
      const failure = child.liveUnits.find(unit => unit.type === 'live-error')
      expect(child.lastTerminalStatus).toBe('failed')
      expect(failure?.type).toBe('live-error')
      if (failure?.type === 'live-error') {
        expect(failure.text.trim().length).toBeGreaterThan(0)
        if (error) expect(failure.text).toBe(error)
      }
    }
  })

  test('pending task registration does not claim the child has started working', () => {
    const sessionId = 'pending-child-start'
    const task = { agentId: 'queued-child', status: 'pending' }
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
    expect(stream.getSessionStream(sessionId).agentTimeline).toEqual([])
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task: { ...task, status: 'running' } } })
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started'])
  })

  test('a previous teammate idle snapshot cannot settle a new child turn', () => {
    const sessionId = 'persistent-child-stale-idle'
    const task = { agentId: 'resumed-teammate', type: 'in_process_teammate', status: 'running', isIdle: true, lifecycleUpdatedAtMs: 200 }
    stream.seedSubagentTasks(sessionId, { task })
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'parent-run' })
    stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: task.agentId, event: { type: 'stream_mode', mode: 'requesting', turnId: 'child-run' } })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { task } })
    stream.seedSubagentTasks(sessionId, { task })
    expect(stream.getSessionStream(sessionId).agentTasks.task.isIdle).toBe(false)
    expect(stream.getSessionStream(subagentStreamId(sessionId, task.agentId)).running).toBe(true)
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['started'])
  })

  test('delivery IDs deduplicate across intervening parent output and completion is recorded once', async () => {
    const parent = 'child-lifecycle-parent'
    const task = { agentId: 'agent-B', agentName: 'Audit', status: 'running' }
    ;(window as any).klaus = { agents: { history: async () => ({ messages: [] }) } }
    stream.ingestChatEvent({ type: 'tasks_changed', sessionId: parent, tasks: { 'spawn-B': task } })
    const update = (notificationId = 'notice-one') => stream.ingestChatEvent({ type: 'agent_notification', sessionId: parent, agentId: 'agent-B', notificationId, source: 'team-mailbox', status: 'updated' })
    update()
    update()
    stream.ingestChatEvent({ type: 'text_delta', sessionId: parent, text: 'Parent progress', messageId: 'parent-message' })
    update()
    update('notice-two')
    const done = { type: 'tasks_changed', sessionId: parent, tasks: { 'spawn-B': { ...task, status: 'completed' } } }
    stream.ingestChatEvent(done)
    stream.ingestChatEvent(done)
    await flush()
    expect(stream.getSessionStream(parent).agentTimeline.map(event => event.status)).toEqual(['started', 'updated', 'updated', 'completed'])
    expect(stream.getSessionStream(parent).liveUnits.map(unit => unit.type)).toEqual(['live-agent-event', 'live-agent-event', 'live-text', 'live-agent-event', 'live-agent-event'])
  })
})

describe('activity continuity', () => {
  test('distinct deliveries survive repeated terminal states across continued agent turns', () => {
    const sessionId = 'continued-agent-notifications'
    const notify = (notificationId: string, turnId: string) => stream.ingestChatEvent({ sessionId, type: 'agent_notification',
      agentId: 'continued-agent', notificationId, turnId, source: 'background-task', status: 'completed' })
    notify('first-completion', 'first-turn')
    notify('second-completion', 'second-turn')
    notify('first-completion', 'first-turn')
    expect(stream.getSessionStream(sessionId).agentTimeline.map(record => record.notificationId)).toEqual(['first-completion', 'second-completion'])
  })

  test('interleaved internal progress stays in child streams until actual inbox delivery', () => {
    const sessionId = 'two-busy-children'
    const send = (agentId: string, event: any) => stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId, event })
    for (let round = 0; round < 50; round++) {
      for (const agentId of ['audit-one', 'audit-two']) {
        send(agentId, { type: 'text_delta', messageId: `message-${round}`, text: 'Inspecting source' })
        send(agentId, { type: 'message_complete', messageId: `message-${round}` })
        send(agentId, { type: 'tool_start', toolCallId: `read-${round}`, toolName: 'read', args: { file_path: `/src/file-${round}.ts` } })
        send(agentId, { type: 'tool_end', toolCallId: `read-${round}`, content: 'Source contents' })
      }
    }
    expect(stream.getSessionStream(sessionId).agentTimeline).toEqual([])
    expect(stream.getSessionStream(sessionId).liveUnits).toEqual([])
    for (const agentId of ['audit-one', 'audit-two']) {
      const child = stream.getSessionStream(subagentStreamId(sessionId, agentId))
      expect(Object.keys(child.tools)).toHaveLength(50)
      expect(child.liveUnits.filter(unit => unit.type === 'live-text')).toHaveLength(50)
      stream.ingestChatEvent({ sessionId, type: 'agent_notification', agentId, source: 'team-mailbox', status: 'updated', notificationId: `delivered-${agentId}` })
    }
    expect(stream.getSessionStream(sessionId).agentTimeline).toHaveLength(2)
    expect(stream.getSessionStream(sessionId).running).toBe(false)
  })

  test('history delivery IDs merge with local anchors and legacy synthetic updates are removed', async () => {
    const sessionId = 'notification-replay'
    const delivered = { notificationId: 'inbox-1', agentId: 'audit', agentName: 'Audit', source: 'team-mailbox', status: 'updated', timestamp: 20, turnId: 'turn-1' }
    const anchored = { ...delivered, key: 'local-event', taskId: 'spawn', name: 'Audit', afterToolCallId: 'read-first' }
    const legacy = { key: 'legacy-event', taskId: 'spawn', name: 'Audit', status: 'updated', timestamp: 15 }
    const messages = [{ role: 'assistant', uuid: 'response', turnId: 'turn-1', contentBlocks: [
      { type: 'tool_use', id: 'read-first', name: 'read' }, { type: 'text', messageId: 'answer', text: 'Final answer' },
    ] }]
    ;(window as any).klaus = { session: { history: async () => ({ messages, agentNotifications: [delivered, delivered] }) } }
    stream.seedSubagentTasks(sessionId, { spawn: { agentId: 'audit', agentName: 'Audit', status: 'running', activityEvents: [legacy, anchored] } } as any)
    await stream.loadSessionHistory(sessionId)
    await stream.loadSessionHistory(sessionId)
    const state = stream.getSessionStream(sessionId)
    expect(state.agentTimeline).toHaveLength(1)
    expect(state.agentTimeline[0]).toMatchObject({ key: 'local-event', afterToolCallId: 'read-first', notificationId: 'inbox-1' })
    expect(state.history?.map(row => row.kind || row.role)).toEqual(['assistant', 'agent-event', 'assistant'])
    expect(mergeAgentTimeline(messages, [legacy] as any)).toEqual(messages)
  })

  test('a cold history load restores delivered notifications without a renderer sidecar', async () => {
    const sessionId = 'cold-delivery-history'
    ;(window as any).klaus = { session: { history: async () => ({ messages: [], agentNotifications: [
      { notificationId: 'cold-notice', agentName: 'Mobile audit', source: 'team-mailbox', status: 'updated', timestamp: 20, turnId: 'original-turn' },
    ] }) } }
    await stream.loadSessionHistory(sessionId)
    expect(stream.getSessionStream(sessionId).history?.[0]).toMatchObject({ kind: 'agent-event', turnId: 'original-turn', agentEvent: { name: 'Mobile audit' } })
    stream.seedSubagentTasks(sessionId, { 'registered-task': { agentId: 'registered-agent', agentName: 'Mobile audit' } })
    expect(stream.getSessionStream(sessionId).history?.[0].agentEvent).toMatchObject({ taskId: 'registered-task', agentId: 'registered-agent' })
  })

  test('a child that finishes before task registration produces one completion', async () => {
    const sessionId = 'fast-child-registration'
    ;(window as any).klaus = { agents: { history: async () => ({ messages: [] }) } }
    stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: 'fast-child', event: { type: 'done' } })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: { 'spawn-fast': { agentId: 'fast-child', agentName: 'Fast audit', status: 'completed' } } })
    await flush()
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => event.status)).toEqual(['completed'])
  })

  test('an asynchronous child notice does not split the parent Markdown stream', () => {
    const sessionId = 'interleaved-parent-text'
    stream.ingestChatEvent({ sessionId, type: 'text_delta', messageId: 'parent-text', text: '**Still ' })
    stream.ingestChatEvent({ sessionId, type: 'agent_notification', agentId: 'interleaved-child', notificationId: 'interleaved-notice', source: 'team-mailbox', status: 'updated' })
    stream.ingestChatEvent({ sessionId, type: 'text_delta', messageId: 'parent-text', text: 'working**' })
    stream.ingestChatEvent({ sessionId, type: 'message_complete', messageId: 'parent-text' })
    const units = stream.getSessionStream(sessionId).liveUnits
    expect(units.map(unit => unit.type)).toEqual(['live-text', 'live-agent-event'])
    expect(units[0]).toMatchObject({ text: '**Still working**', streaming: false })
  })

  test('workflow siblings sharing a tool retain distinct names and lifecycle ownership', () => {
    const sessionId = 'workflow-siblings'
    stream.seedSubagentTasks(sessionId, {
      'agent-one': { agentId: 'agent-one', agentName: 'explorer', description: 'First audit', status: 'running' },
      'agent-two': { agentId: 'agent-two', agentName: 'explorer', description: 'Second audit', status: 'running' },
    } as any)
    for (const agentId of ['agent-one', 'agent-two']) {
      stream.ingestChatEvent({ sessionId, type: 'agent_notification', agentId, taskId: 'agent-one', notificationId: `notice-${agentId}`, source: 'team-mailbox', status: 'updated' })
    }
    expect(stream.getSessionStream(sessionId).agentTimeline.map(event => [event.taskId, event.name]))
      .toEqual([['agent-one', 'First audit'], ['agent-two', 'Second audit']])
  })

  test('children settling after their turn ended anchor back to the spawning turn', () => {
    const sessionId = 'late-settle-attribution'
    stream.ingestChatEvent({ sessionId, type: 'stream_mode', mode: 'requesting', turnId: 'parent-turn' })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: {
      'spawn-a': { agentId: 'child-a', agentName: 'First audit', status: 'running' },
      'spawn-b': { agentId: 'child-b', agentName: 'Second audit', status: 'running' },
    } })
    expect(stream.getSessionStream(sessionId).agentTasks['spawn-a'].spawnTurnId).toBe('parent-turn')
    // The turn ends; the children settle afterwards with no active turn.
    stream.ingestChatEvent({ sessionId, type: 'done', turnId: 'parent-turn', terminal: true })
    stream.ingestChatEvent({ sessionId, type: 'tasks_changed', tasks: {
      'spawn-a': { agentId: 'child-a', agentName: 'First audit', status: 'cancelled' },
      'spawn-b': { agentId: 'child-b', agentName: 'Second audit', status: 'cancelled' },
    } })
    const timeline = stream.getSessionStream(sessionId).agentTimeline
    expect(timeline.map(record => [record.taskId, record.turnId, record.status]))
      .toEqual([['spawn-a', 'parent-turn', 'started'], ['spawn-b', 'parent-turn', 'started'],
        ['spawn-a', 'parent-turn', 'cancelled'], ['spawn-b', 'parent-turn', 'cancelled']])
  })

  test('teammate completion is process evidence without synthesizing a delivered message', async () => {
    const sessionId = 'persistent-teammate'
    ;(window as any).klaus = { agents: { history: async () => ({ messages: [] }) } }
    stream.seedSubagentTasks(sessionId, { mate: { agentId: 'mate', agentName: 'Teammate', type: 'in_process_teammate', status: 'running' } } as any)
    stream.ingestChatEvent({ sessionId, type: 'agent_progress', agentId: 'mate', event: { type: 'done' } })
    await flush()
    expect(stream.getSessionStream(sessionId).agentTimeline).toMatchObject([{ taskId: 'mate', status: 'completed' }])
    expect(stream.getSessionStream(sessionId).agentTimeline[0].notificationId).toBeUndefined()
    expect(stream.getSessionStream(sessionId).agentTimeline[0].source).toBeUndefined()
  })

  test('restored activity survives history load and retains its original turn ownership', async () => {
    const sessionId = 'restored-agent-history'
    const record: AgentTimelineRecord = { key: 'saved-notice', taskId: 'spawn', name: 'Audit', status: 'completed', timestamp: 20, turnId: 'old-turn', afterMessageId: 'final' }
    ;(window as any).klaus = { session: { history: async () => ({ messages: [{ role: 'assistant', uuid: 'old-message', turnId: 'old-turn', contentBlocks: [{ type: 'text', messageId: 'final', text: 'Done' }] }] }) } }
    stream.seedSubagentTasks(sessionId, { spawn: { agentId: 'agent', status: 'completed', activityEvents: [record] } } as any)
    stream.seedSubagentTasks(sessionId, { spawn: { agentId: 'agent', status: 'completed', activityEvents: [record] } } as any)
    await stream.loadSessionHistory(sessionId)
    const state = stream.getSessionStream(sessionId)
    expect(state.agentTimeline).toHaveLength(1)
    expect(state.history?.at(-1)).toMatchObject({ kind: 'agent-event', turnId: 'old-turn', uuid: 'saved-notice' })
  })

  test('replay places child updates at their actual tool boundary', () => {
    const record: AgentTimelineRecord = { key: 'event-1', notificationId: 'delivered-1', source: 'team-mailbox', taskId: 'spawn-1', name: 'Audit', status: 'updated', timestamp: 20, afterToolCallId: 'read-1' }
    const history = [{ uuid: 'assistant-1', role: 'assistant', contentBlocks: [
      { type: 'tool_use', id: 'read-1', name: 'read' },
      { type: 'text', messageId: 'final', phase: 'final_answer', text: 'Final answer' },
    ] }]
    const merged = mergeAgentTimeline(history, [record])
    expect(merged.map(row => row.kind || row.role)).toEqual(['assistant', 'agent-event', 'assistant'])
    expect(merged[0].contentBlocks[0].id).toBe('read-1')
    expect(merged[2].contentBlocks[0].text).toBe('Final answer')
    expect(history).toHaveLength(1)
  })

  test('a failed turn\'s late notices stay inside that turn, never after the transcript tail', () => {
    // Saved history rows carry timestamp 0, so timestamp-only placement appends
    // every unanchored notice to the tail. A failed turn's deliveries would then
    // form a turn group AFTER the real last turn, and the transcript ends with
    // that turn's failure pill and file card.
    const history = [
      { uuid: 'u1', role: 'user', turnId: 'failed-turn', text: 'go', contentBlocks: [{ type: 'text', text: 'go' }] },
      { uuid: 'a1', role: 'assistant', turnId: 'failed-turn', contentBlocks: [{ type: 'text', text: 'working' }] },
      { uuid: 'u2', role: 'user', turnId: 'last-turn', text: 'again', contentBlocks: [{ type: 'text', text: 'again' }] },
      { uuid: 'a2', role: 'assistant', turnId: 'last-turn', contentBlocks: [{ type: 'text', messageId: 'final', phase: 'final_answer', text: 'done' }] },
    ]
    const notice: AgentTimelineRecord = { key: 'late-notice', notificationId: 'n-1', source: 'team-mailbox', taskId: 'spawn', name: 'Audit', status: 'updated', timestamp: 5, turnId: 'failed-turn' }
    const merged = mergeAgentTimeline(history, [notice])
    expect(merged.map(row => row.turnId || row.kind || row.role))
      .toEqual(['failed-turn', 'failed-turn', 'failed-turn', 'last-turn', 'last-turn'])
  })

  test('compaction transitions in place and a no-op end does not claim a completed compaction', () => {
    const sessionId = 'compaction-live-order'
    stream.ingestChatEvent({ sessionId, type: 'text_delta', text: 'Working' })
    stream.ingestChatEvent({ sessionId, type: 'compaction_start', trigger: 'auto' })
    const running = stream.getSessionStream(sessionId).liveUnits.at(-1)
    expect(running?.type).toBe('live-compaction')
    stream.ingestChatEvent({ sessionId, type: 'compact_boundary', trigger: 'auto' })
    const completed = stream.getSessionStream(sessionId).liveUnits.at(-1)
    expect(completed?.key).toBe(running?.key)
    expect(completed?.type === 'live-compaction' && completed.state).toBe('completed')
    stream.ingestChatEvent({ sessionId, type: 'compaction_end' })
    expect(stream.getSessionStream(sessionId).liveUnits.at(-1)?.key).toBe(running?.key)
    stream.ingestChatEvent({ sessionId, type: 'compaction_start', trigger: 'auto' })
    stream.ingestChatEvent({ sessionId, type: 'compaction_end' })
    expect(stream.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-compaction')).toHaveLength(1)
    expect(stream.getSessionStream(sessionId).compactionPendingTrigger).toBeNull()
  })
})
