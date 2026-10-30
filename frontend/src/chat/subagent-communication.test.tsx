import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../contracts/vectors/subagent-communication-vectors.json'
import hierarchy from '../../../contracts/vectors/subagent-hierarchy-vectors.json'
import { subagentCommunication } from '../../../contracts/subagent-communication'
import { subagentStreamId } from './subagent-stream'

;(globalThis as any).window ||= {}
;(window as any).addEventListener ||= () => {}
;(window as any).currentLang = 'en'
const stream = await import('./stream-store')
const { StaticTranscriptView, editTargetFor, foldUnits, unitsFromMessages, segmentsFromBlocks } = await import('./transcript/TranscriptView')
const { agentActionLabel, agentActionPresentation } = await import('./transcript/activity-agent-action-model')
const valid = vectors.cases[0]!
const rawMessage = (uuid: string) => ({ uuid, isMeta: true, message: { content: valid.content } })
const savedMessage = (uuid: string) => ({ role: 'user', uuid, kind: 'agent-message', agentMessage: valid.expected, text: valid.expected!.text, turnId: 'child-turn' })

describe('received agent communication', () => {
  test('outgoing recipient context tracks direct ancestry without assigning a parent to the root', () => {
    const root = 'outgoing-ancestry'
    const task = { agentId: 'outgoing-child', status: 'running' }
    stream.seedSubagentTasks(root, { call: task })
    const id = stream.prepareSubagentStream(root, 'call', task)
    expect(stream.selectSubagentParentId(stream.chatStreamStore.getState(), root)).toBeUndefined()
    expect(stream.selectSubagentParentId(stream.chatStreamStore.getState(), id)).toBe(root)
    stream.ingestChatEvent({ sessionId: root, type: 'tasks_changed', tasks: { call: { ...task, parentAgentId: 'direct-parent', depth: 2 } } })
    expect(stream.selectSubagentParentId(stream.chatStreamStore.getState(), id)).toBe('direct-parent')
  })
  test('saved message action reports successful sending and preserves its queued acknowledgement after reopen', () => {
    const queued = vectors.queuedAction
    const segments = segmentsFromBlocks([{ type: 'tool_use', id: 'saved-send', name: queued.toolName, input: queued.arguments,
      __result: { content: [{ type: 'text', text: queued.modelText }], agentCommunication: queued.output } }], undefined)
    const tool = segments[0].tools![0]
    const action = agentActionPresentation({ toolName: tool.toolName, toolCallId: tool.toolCallId, state: 'done', args: tool.args, output: tool.output!.text })
    expect(action?.state).toBe('done')
    expect(JSON.parse(action!.output)).toMatchObject(queued.output)
    for (const [locale, label] of Object.entries(queued.labels)) expect(agentActionLabel(action!.action, action!.state, locale)).toBe(label)
    expect(action?.agents.map(agent => agent.id)).toEqual(['child'])
  })
  test('late ancestry moves legacy root activity to its direct owner exactly once', () => {
    const root = 'legacy-ancestry'
    const activity = { key: 'legacy-start', taskId: 'old-call', agentId: 'legacy-nested', name: 'Nested review',
      status: 'started' as const, timestamp: 1, turnId: 'old-root-turn' }
    stream.seedSubagentTasks(root, { 'old-call': { agentId: 'legacy-nested', status: 'running', spawnTurnId: 'old-root-turn', activityEvents: [activity] } })
    expect(stream.getSessionStream(root).agentTimeline).toHaveLength(1)
    stream.ingestChatEvent({ sessionId: root, type: 'tasks_changed', tasks: { 'new-call': { agentId: 'legacy-nested', parentAgentId: 'legacy-parent', depth: 2, status: 'running', spawnTurnId: 'owner-turn' } } })
    expect(stream.getSessionStream(root).agentTimeline).toEqual([])
    expect(stream.getSessionStream(root).history?.filter(row => row.kind === 'agent-event') || []).toEqual([])
    expect(stream.getSessionStream(subagentStreamId(root, 'legacy-parent')).agentTimeline).toHaveLength(1)
    expect(stream.getSessionStream(subagentStreamId(root, 'legacy-parent')).agentTimeline[0].turnId).toBe('owner-turn')
    stream.seedSubagentTasks(root, { 'new-call': { agentId: 'legacy-nested', parentAgentId: 'legacy-parent', depth: 2, status: 'running', spawnTurnId: 'owner-turn' } })
    expect(stream.getSessionStream(subagentStreamId(root, 'legacy-parent')).agentTimeline).toHaveLength(1)
  })
  test('live ancestry corrections persist in the registry before a later event omits hierarchy', () => {
    for (const withSpawnTurn of [false, true]) {
      const root = `live-ancestry-correction-${withSpawnTurn}`
      const owner = subagentStreamId(root, 'direct-parent')
      stream.ingestChatEvent({ sessionId: owner, type: 'stream_mode', mode: 'requesting', turnId: 'owner-turn' })
      stream.seedSubagentTasks(root, { call: { agentId: 'nested', status: 'running', spawnTurnId: 'root-turn',
        activityEvents: [{ key: 'legacy-live-start', taskId: 'call', agentId: 'nested', name: 'Nested review', status: 'started', timestamp: 1, turnId: 'root-turn' }] } })
      stream.ingestChatEvent({ sessionId: root, type: 'agent_progress', agentId: 'nested', parentAgentId: 'direct-parent', depth: 2, ...(withSpawnTurn ? { spawnTurnId: 'owner-turn' } : {}),
        event: { type: 'stream_mode', mode: 'requesting', turnId: 'nested-run' } })
      expect(stream.getSessionStream(root).agentTasks.call.parentAgentId).toBe('direct-parent')
      expect(stream.getSessionStream(root).agentTasks.call.spawnTurnId).toBe('owner-turn')
      expect(stream.getSessionStream(owner).agentTasks.call.parentAgentId).toBe('direct-parent')
      stream.ingestChatEvent({ sessionId: root, type: 'agent_progress', agentId: 'nested', event: { type: 'done', turnId: 'nested-run' } })
      expect(stream.getSessionStream(root).agentTimeline).toEqual([])
      expect(stream.getSessionStream(owner).agentTimeline.every(row => row.turnId === 'owner-turn')).toBe(true)
      expect(stream.getSessionStream(owner).agentTimeline.at(-1)?.status).toBe('completed')
    }
  })
  test('a parent first discovered through a nested snapshot gains canonical history and running state on open', async () => {
    const root = 'nested-snapshot-first'
    const parentTask = { agentId: 'snapshot-parent', description: 'Parent review', status: 'running' }
    stream.seedSubagentTasks(root, { 'parent-call': parentTask,
      'nested-call': { agentId: 'snapshot-grandchild', parentAgentId: parentTask.agentId, depth: 2, status: 'running' } })
    const id = stream.prepareSubagentStream(root, 'parent-call', parentTask)
    expect(stream.getSessionStream(id).running).toBe(true)
    const calls: unknown[][] = []
    ;(window as any).klaus = { agents: { history: async (...args: unknown[]) => { calls.push(args); return { messages: [] } } } }
    await stream.loadSessionHistory(id)
    expect(calls).toEqual([[root, parentTask.agentId]])
  })
  test('nested streams and lifecycle remain with their direct parent before registration and after snapshot restore', () => {
    const root = hierarchy.root
    const parent = subagentStreamId(root, hierarchy.parentAgentId)
    const child = subagentStreamId(root, hierarchy.agentId)
    stream.ingestLocalUserTurn(root, { text: 'Delegate a nested review' })
    stream.ingestChatEvent({ sessionId: root, type: 'stream_mode', mode: 'requesting', turnId: 'root-turn' })
    stream.ingestChatEvent({ sessionId: root, type: 'agent_progress', agentId: hierarchy.parentAgentId, depth: 1,
      event: { type: 'stream_mode', mode: 'requesting', turnId: hierarchy.parentTurnId } })
    const send = (event: any) => stream.ingestChatEvent({ sessionId: root, type: 'agent_progress', agentId: hierarchy.agentId,
      parentAgentId: hierarchy.parentAgentId, depth: hierarchy.depth, event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: hierarchy.childTurnId })
    send(hierarchy.expectedEvent)
    send({ type: 'done', turnId: hierarchy.childTurnId })
    expect(stream.getSessionStream(root).agentTimeline.some(row => row.agentId === hierarchy.agentId)).toBe(false)
    expect(stream.getSessionStream(parent).agentTimeline.map(row => [row.agentId, row.status, row.turnId])).toEqual([
      [hierarchy.agentId, 'started', hierarchy.parentTurnId], [hierarchy.agentId, 'completed', hierarchy.parentTurnId],
    ])
    expect(stream.getSessionStream(child).liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'Nested progress')).toBe(true)
    expect(stream.getSessionStream(parent).liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'Nested progress')).toBe(false)
    expect(stream.getSessionStream(root).running).toBe(true)
    const task = { agentId: hierarchy.agentId, parentAgentId: hierarchy.parentAgentId, depth: hierarchy.depth,
      description: 'Nested review', status: 'completed', activityEvents: stream.getSessionStream(parent).agentTimeline }
    stream.ingestChatEvent({ sessionId: root, type: 'tasks_changed', tasks: { 'nested-call': task } })
    expect(stream.getSessionStream(parent).agentTimeline).toHaveLength(2)
    expect(stream.getSessionStream(root).agentTimeline.some(row => row.agentId === hierarchy.agentId)).toBe(false)
    const reopened = 'hierarchy-reopened'
    stream.seedSubagentTasks(reopened, { 'nested-call': task })
    expect(stream.getSessionStream(reopened).agentTimeline).toEqual([])
    expect(stream.getSessionStream(subagentStreamId(reopened, hierarchy.parentAgentId)).agentTimeline).toHaveLength(2)
  })
  for (const row of vectors.cases) test(row.name, () => {
    expect(subagentCommunication(row.content, row.isMeta)).toEqual(row.expected)
  })

  test('received context does not alter the child transcript or its active tool', () => {
    const parent = 'communication-isolation'
    stream.ingestLocalUserTurn(parent, { text: 'Review the module' })
    stream.ingestChatEvent({ sessionId: parent, type: 'stream_mode', mode: 'requesting', turnId: 'parent-turn' })
    const send = (event: any, agentId = 'child') => stream.ingestChatEvent({ sessionId: parent, type: 'agent_progress', agentId, event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'child-turn' })
    send({ type: 'tool_start', toolCallId: 'working-tool', toolName: 'exec_command', args: { cmd: 'inspect' } })
    send({ type: 'progress', toolCallId: 'working-tool', content: 'first output' })
    const parentUnits = stream.getSessionStream(parent).liveUnits
    send({ type: 'user_message', message: rawMessage('delivered-1') })
    send({ type: 'user_message', message: rawMessage('delivered-1') })
    send({ type: 'progress', toolCallId: 'working-tool', content: 'second output' })
    const child = stream.getSessionStream(subagentStreamId(parent, 'child'))
    expect(child.liveUnits.map(unit => unit.type)).toEqual(['live-tools'])
    expect(child.liveUnits[0]).toMatchObject({ order: ['working-tool'], sealed: false })
    expect(child.tools['working-tool'].status).toBe('running')
    expect(child.tools['working-tool'].progress).toEqual(['first output', 'second output'])
    expect(child.running).toBe(true)
    expect(stream.getSessionStream(parent).liveUnits).toEqual(parentUnits)
    expect(stream.getSessionStream(subagentStreamId(parent, 'sibling')).liveUnits).toEqual([])
  })

  test('a received message never becomes the human edit target or starts an idle turn', () => {
    const id = 'idle-communication'
    stream.ingestChatEvent({ sessionId: id, type: 'user_message', message: rawMessage('idle-received') })
    const state = stream.getSessionStream(id)
    expect(state.running).toBe(false)
    expect(state.activeTurnId).toBeNull()
    expect(editTargetFor(unitsFromMessages([{ role: 'user', uuid: 'human', turnId: 'human-turn', text: 'Original request' }, savedMessage('received')]), state.liveUnits)).toMatchObject({ uuid: 'human' })
  })

  test('meta housekeeping stays hidden in the live stream', () => {
    const id = 'hidden-housekeeping'
    for (const row of vectors.cases.filter(row => row.isMeta && !row.expected)) {
      stream.ingestChatEvent({ sessionId: id, type: 'user_message', message: { uuid: row.name, isMeta: true, message: { content: row.content } } })
    }
    expect(stream.getSessionStream(id).liveUnits).toEqual([])
  })
  test('incoming context neither seals nor interrupts the visible reasoning stream', () => {
    const id = 'reasoning-communication'
    stream.ingestChatEvent({ sessionId: id, type: 'thinking_delta', thinking: 'Before delivery' })
    stream.ingestChatEvent({ sessionId: id, type: 'user_message', message: rawMessage('reasoning-inbound') })
    const delivered = stream.getSessionStream(id)
    expect(delivered.liveUnits).toEqual([])
    expect(delivered.thinkingText).toBe('Before delivery')
    expect(delivered.thinkingActive).toBe(true)
    stream.ingestChatEvent({ sessionId: id, type: 'thinking_delta', thinking: 'After delivery' })
    const resumed = stream.getSessionStream(id)
    expect(resumed.thinkingText).toBe('Before deliveryAfter delivery')
    expect(resumed.thinkingActive).toBe(true)
    expect(resumed.liveUnits).toEqual([])
  })

  test('received context stays out of completed turns even when its body contains markup', () => {
    const received = { ...savedMessage('literal'), agentMessage: vectors.cases[1]!.expected, text: vectors.cases[1]!.expected!.text }
    const units = unitsFromMessages([
      { role: 'user', uuid: 'request', text: 'Task', turnId: 'child-turn' },
      { role: 'assistant', uuid: 'work', text: 'Investigating', turnId: 'child-turn' },
      received,
      { role: 'assistant', uuid: 'answer', text: 'Answer', phase: 'final_answer', isFinalReply: true, turnId: 'child-turn' },
    ])
    expect(units.some(unit => unit.msg?.uuid === received.uuid)).toBe(false)
    expect(units.some(unit => unit.msg?.text === received.text)).toBe(false)
    const nodes = foldUnits(units, null, { 'child-turn': 'completed' }, {})
    const fold = nodes.find(node => node.kind === 'turn-fold')
    expect(fold?.kind === 'turn-fold' && fold.items.some(node => node.kind === 'unit' && node.unit.msg?.uuid === received.uuid)).toBe(false)
  })

  test('completed history handoff deduplicates delivered communication using the actual persistent child identity', async () => {
    const parent = 'communication-handoff'
    const id = stream.prepareSubagentStream(parent, 'task-call', { agentId: 'actual-child', type: 'in_process_teammate', status: 'running' })
    const calls: unknown[][] = []
    ;(window as any).klaus = { agents: { history: async (...args: unknown[]) => { calls.push(args); return { messages: [savedMessage('handoff-message')] } } } }
    stream.ingestChatEvent({ sessionId: id, type: 'stream_mode', mode: 'requesting', turnId: 'child-turn' })
    stream.ingestChatEvent({ sessionId: id, type: 'user_message', message: rawMessage('handoff-message') })
    stream.ingestChatEvent({ sessionId: id, type: 'done', turnId: 'child-turn' })
    await stream.loadSessionHistory(id)
    expect(calls).toEqual([[parent, 'actual-child']])
    expect(stream.getSessionStream(id).history?.filter(row => row.kind === 'agent-message')).toHaveLength(1)
    expect(unitsFromMessages(stream.getSessionStream(id).history || [])).toEqual([])
    stream.ingestChatEvent({ sessionId: id, type: 'user_message', message: rawMessage('handoff-message') })
    expect(unitsFromMessages(stream.getSessionStream(id).history || [])).toEqual([])
  })

  test('received context has no sender header body or copy control on either transcript surface', () => {
    const presentation = vectors.presentation
    for (const locale of ['en', 'zh']) for (const sessionId of [presentation.sessionId, subagentStreamId(presentation.sessionId, 'child')]) {
      ;(window as any).currentLang = locale
      const msgs = [
        { role: 'user', uuid: 'human', text: 'Review request', turnId: 'review-turn' },
        { ...savedMessage('hidden'), turnId: 'review-turn', text: presentation.body,
          agentMessage: { senderId: presentation.senderId, text: presentation.body } },
        { role: 'assistant', uuid: 'answer', text: 'Review complete', turnId: 'review-turn', phase: 'final_answer' },
      ]
      const units = unitsFromMessages(msgs)
      expect(units.map(unit => unit.msg?.text || unit.segment?.text)).toEqual(['Review request', 'Review complete'])
      const html = renderToStaticMarkup(<StaticTranscriptView msgs={[msgs[1]]} container={{} as HTMLElement} running={false} sessionId={sessionId} />)
      expect(html.includes(presentation.body)).toBe(presentation.bodyVisible)
      expect(html.includes('data-agent-message-id')).toBe(presentation.transcriptVisible)
      expect(html).not.toContain('Message provenance')
    }
    ;(window as any).currentLang = 'en'
  })
})
