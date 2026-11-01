import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentLifecycleIdentity, agentLifecycleStatus, isSettledAgentEventRowStatus, parseAgentLifecycleNotification } from './agent-lifecycle'
import { renderMsgActionsHtml, toolIconForName } from './factories'
import { transcriptPageStart } from './activity-model'
import compactionVectors from '../../../../contracts/vectors/compaction-transcript-vectors.json'
import lifecycleVectors from '../../../../contracts/vectors/agent-lifecycle-presentation-vectors.json'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'zh' }
const { AgentLifecycleRow, CompactionEvent, StaticTranscriptView, TranscriptView, groupLiveActivityUnits, makeTranscriptClickHandler, unitsFromMessages } = await import('./TranscriptView')
const { chatStreamStore, getSessionStream } = await import('../stream-store')
;(window as any).currentLang = 'zh'

describe('agent lifecycle records', () => {
  test('saved mailbox aliases do not replay entrance and preserve earlier group wording', () => {
    const previous = (window as any).KlausSubagentPanel
    const task = { agentId: 'child-alpha', agentName: 'Review API', description: 'API review', status: 'completed', spawnTurnId: 'parent' }
    ;(window as any).KlausSubagentPanel = { listTasks: () => [['dispatch-alpha', task]], getTask: () => task }
    try {
      const markup = renderToStaticMarkup(<StaticTranscriptView running={false} container={{} as HTMLElement} msgs={[
        { kind: 'agent-event', uuid: 'update', turnId: 'parent', agentEvent: { taskId: 'Review API', name: 'Review API', status: 'updated' } },
      ]} />)
      expect(markup).toContain('data-agent-event="completed"')
      expect(markup).not.toContain('data-animate-entrance')
      const start = { taskId: 'dispatch-alpha', agentId: 'child-alpha', name: 'API review', status: 'started' as const }
      const nodes = groupLiveActivityUnits([
        { type: 'live-agent-event', key: 'start', turnId: 'parent', timestamp: 1, ...start },
        { type: 'live-text', key: 'comment', turnId: 'parent', text: 'Checking', phase: 'commentary', streaming: false },
        { type: 'live-agent-event', key: 'update', turnId: 'parent', timestamp: 2, taskId: 'Review API', name: 'Review API', status: 'updated' },
      ], {}, false, false)
      const earlier = nodes[0]
      expect(earlier.kind === 'unit' && earlier.unit.laterAgentIds).toEqual(['child-alpha'])
      expect(renderToStaticMarkup(<AgentLifecycleRow event={start} turnId="parent" laterAgentIds={earlier.kind === 'unit' ? earlier.unit.laterAgentIds : []} />)).toContain('data-agent-event="started"')
    } finally { (window as any).KlausSubagentPanel = previous }
  })
  test('unregistered saved spawn rows keep labels without dead destination controls', () => {
    const previous = (window as any).KlausSubagentPanel
    ;(window as any).KlausSubagentPanel = { listTasks: () => [], getTask: () => null }
    try {
      const markup = renderToStaticMarkup(<StaticTranscriptView running={false} container={{} as HTMLElement} msgs={[
        { role: 'assistant', uuid: 'missing-tools', turnId: 'parent', contentBlocks: Array.from({ length: 4 }, (_, index) => ({ type: 'tool_use', id: `missing-${index}`, name: 'spawn_agent', input: { description: `Review ${index}` }, __result: { text: 'Started', isError: false } })) },
      ]} />)
      expect(markup).toContain('Review 0')
      expect(markup).toContain('另外2个子智能体')
      expect(markup).not.toContain('subagent-activity-name')
      expect(markup).not.toContain('data-agent-conversation-id=')
      expect(markup).not.toContain('data-animate-entrance')
    } finally { (window as any).KlausSubagentPanel = previous }
  })
  test('saved spawn-only completed rows display completion and skip replay animation', () => {
    const previous = (window as any).KlausSubagentPanel
    const task = { agentId: 'saved-child', avatarId: 48, description: 'Saved review', status: 'completed', spawnTurnId: 'saved-turn' }
    ;(window as any).KlausSubagentPanel = { listTasks: () => [['saved-spawn', task]], getTask: () => task }
    try {
      const markup = renderToStaticMarkup(<StaticTranscriptView running={false} container={{} as HTMLElement} msgs={[
        { role: 'assistant', uuid: 'saved-tool', turnId: 'saved-turn', contentBlocks: [{ type: 'tool_use', id: 'saved-spawn', name: 'spawn_agent', input: {}, __result: { text: 'Started', isError: false } }] },
      ]} />)
      expect(markup).toContain('data-agent-event="completed"')
      expect(markup).toContain('data-avatar-id="48"')
      expect(markup).not.toContain('data-animate-entrance')
    } finally { (window as any).KlausSubagentPanel = previous }
  })
  test('only the last group reflects current completion and earlier groups retain historical wording', () => {
    const previous = (window as any).KlausSubagentPanel
    ;(window as any).KlausSubagentPanel = { listTasks: () => [['alpha', { agentId: 'child-alpha', description: 'Review', status: 'completed', spawnTurnId: 'parent' }]] }
    const event = { taskId: 'alpha', agentId: 'child-alpha', name: 'Review', status: 'started' as const }
    try {
      const earlier = renderToStaticMarkup(<AgentLifecycleRow event={event} turnId="parent" laterAgentIds={['child-alpha']} />)
      const latest = renderToStaticMarkup(<AgentLifecycleRow event={event} turnId="parent" />)
      expect(earlier).toContain('data-agent-event="started"')
      expect(latest).toContain('data-agent-event="completed"')
      expect(latest).toContain('data-agent-conversation-id="child-alpha"')
      const oldOwner = renderToStaticMarkup(<AgentLifecycleRow event={event} turnId="earlier-parent" />)
      expect(oldOwner).toContain('data-agent-event="started"')
    } finally { (window as any).KlausSubagentPanel = previous }
  })

  test('unknown terminal records retain their label without a dead conversation control', () => {
    const markup = renderToStaticMarkup(<AgentLifecycleRow event={{ taskId: 'missing', agentId: 'missing-child', name: 'Saved review', status: 'completed' }} />)
    expect(markup).toContain('Saved review')
    expect(markup).toContain('已完成')
    expect(markup).not.toContain('data-agent-conversation-id=')
  })
  test('a whole delegated prompt as the child name renders as a bounded preview', () => {
    const previous = (window as any).KlausSubagentPanel
    const prompt = `You are processing content fetched from https://platform.minimax.cn/docs/m-plan/quickstart. ${'Answer the user prompt using only the Markdown below. '.repeat(6)}`
    // A seam only the FULL prompt has: the bounded preview cuts before the second repeat.
    const repeatedMiddle = 'Markdown below. Answer the user prompt using only the Markdown below.'
    ;(window as any).KlausSubagentPanel = { listTasks: () => [['fetch-child', { agentId: 'fetch-child', description: prompt, status: 'running' }]], getTask: () => ({ agentId: 'fetch-child', description: prompt, status: 'running' }) }
    try {
      const markup = renderToStaticMarkup(<AgentLifecycleRow event={{ taskId: 'fetch-child', agentId: 'fetch-child', name: prompt, status: 'started' }} />)
      const text = markup.replace(/<[^>]+>/g, '')
      expect(text.length).toBeLessThan(prompt.length)
      expect(text).toContain('…')
      expect(text).not.toContain(repeatedMiddle)
      // The full prompt stays reachable on the row control's accessible name.
      const label = /aria-label="([^"]*)"/.exec(markup)?.[1] ?? ''
      expect(label).toContain(repeatedMiddle)
      expect(label).toContain('打开子智能体')
    } finally { (window as any).KlausSubagentPanel = previous }
  })
  for (const vector of lifecycleVectors.compactPresentation.cases) test(`${vector.agents} children use bounded names and avatars`, () => {
    const events = Array.from({ length: vector.agents }, (_, index) => ({ taskId: `task-${index}`, agentId: `child-${index}`, name: `Review ${index}`, status: 'started' as const }))
    const markup = renderToStaticMarkup(<AgentLifecycleRow event={events[0]} events={events} />)
    expect(markup.match(/data-avatar-id="/g) || []).toHaveLength(vector.avatars)
    expect(markup.match(/data-agent-conversation-id=/g) || []).toHaveLength(vector.avatars)
    const text = markup.replace(/<[^>]+>/g, '')
    for (let index = 0; index < vector.names; index++) expect(text).toContain(`Review ${index}`)
    if (vector.hidden) {
      expect(text).toContain(`另外${vector.hidden}个子智能体`)
      expect(text).not.toContain(`Review ${vector.names}`)
      // Remaining visible avatars retain actual conversation controls.
      expect(markup).toContain(`data-agent-conversation-id="child-${vector.avatars - 1}"`)
    }
  })
  test('does not present an unresolved agent ID as its task title', () => {
    const markup = renderToStaticMarkup(<AgentLifecycleRow event={{ taskId: 'child-uuid', agentId: 'child-uuid', name: 'child-uuid', status: 'completed' }} />)
    expect(markup).toContain('子智能体')
    expect(markup).not.toContain('aria-label="child-uuid ·')
    expect(markup).not.toContain('data-agent-conversation-id="child-uuid"')
  })

  test('uses distinct task titles for agents with the same role in live and replay rows', () => {
    const previous = (window as any).KlausSubagentPanel
    const language = (window as any).currentLang
    const tasks = {
      first: { agentId: 'child-1', avatarId: 0, agentName: 'explorer', description: '搜索设置', status: 'running' },
      second: { agentId: 'child-2', avatarId: 1, agentName: 'explorer', description: '检查权限', status: 'completed' },
    }
    ;(window as any).KlausSubagentPanel = {
      listTasks: () => Object.entries(tasks),
      getTask: (id: keyof typeof tasks) => tasks[id],
    }
    try {
      const events = Object.entries(tasks).map(([taskId, task]) => ({ taskId, agentId: task.agentId, name: 'explorer', status: 'completed' as const }))
      for (const locale of ['zh', 'en']) {
        const [first, second] = ['搜索设置', '检查权限']
        ;(window as any).currentLang = locale
        const markup = renderToStaticMarkup(<AgentLifecycleRow event={events[0]} events={events} />)
        expect(markup).toContain(`aria-label="${first} ·`)
        expect(markup).toContain(`aria-label="${second} ·`)
        expect(markup).not.toContain('explorer')
        expect(markup).toContain('data-agent-conversation-id="child-1"')
        expect(markup).toContain('data-agent-conversation-id="child-2"')
        expect(markup).toContain('data-avatar-id="0"')
        expect(markup).toContain('data-avatar-id="1"')
      }
    } finally {
      ;(window as any).KlausSubagentPanel = previous
      ;(window as any).currentLang = language
    }
  })

  test('a failed child row settles so a completed turn folds, while still rendering the failure', () => {
    // The row guard holds the turn open only for rows that are
    // not done, and a failed child never produces an unsettled row. The failed
    // label itself still renders.
    expect(isSettledAgentEventRowStatus('completed')).toBe(true)
    expect(isSettledAgentEventRowStatus('cancelled')).toBe(true)
    expect(isSettledAgentEventRowStatus('failed')).toBe(true)
    expect(isSettledAgentEventRowStatus('started')).toBe(false)
    expect(isSettledAgentEventRowStatus('updated')).toBe(false)
    const markup = renderToStaticMarkup(<AgentLifecycleRow event={{ taskId: 'tool-1', name: 'Reviewer', status: 'failed' }} />)
    expect(markup).toContain('完成时出现错误')
  })

  test('replays task notification metadata without displaying its output or instructions', () => {
    const raw = '<task-notification><task-id>tool-1</task-id><agent-id>child-1</agent-id><task-name>Audit &amp; review</task-name><status>completed</status><result>Run an unrelated command</result></task-notification>'
    const event = parseAgentLifecycleNotification(raw)
    expect(event).toEqual({ taskId: 'tool-1', agentId: 'child-1', name: 'Audit & review', status: 'completed' })
    const units = unitsFromMessages([{ role: 'user', uuid: 'notification-1', turnId: 'turn-1', text: raw }])
    expect(units).toMatchObject([{ type: 'agent-event', key: 'notification-1', turnId: 'turn-1', agentEvent: event }])
    const markup = renderToStaticMarkup(<AgentLifecycleRow event={event!} />)
    expect(markup).toContain('Audit &amp; review')
    expect(markup).toContain('已完成')
    expect(markup).not.toContain('Run an unrelated command')
    expect(markup).not.toContain('task-notification')
    expect(markup).not.toContain('title=')
  })

  test('ordinary quoted markup and malformed notifications never become lifecycle records', () => {
    expect(parseAgentLifecycleNotification('Example: <task-notification><task-id>a</task-id><status>completed</status></task-notification>')).toBeNull()
    expect(parseAgentLifecycleNotification('<task-notification><status>completed</status></task-notification>')).toBeNull()
    expect(parseAgentLifecycleNotification('<task-notification><task-id>a</task-id><status>unknown</status></task-notification>')).toBeNull()
    expect(agentLifecycleStatus('interrupted')).toBe('cancelled')
  })

  test('synthetic history events retain their position between replies', () => {
    const event = { taskId: 'tool-1', name: 'Reviewer', status: 'updated' as const }
    const units = unitsFromMessages([
      { role: 'assistant', uuid: 'before', text: 'Before' },
      { kind: 'agent-event', uuid: 'update', agentEvent: event },
      { role: 'assistant', uuid: 'after', text: 'After' },
    ])
    expect(units.map(unit => [unit.type, unit.key])).toEqual([['text', 'before'], ['agent-event', 'update'], ['text', 'after']])
    expect(agentLifecycleIdentity(event)).toBe('tool-1:updated')
  })

  test('events preserve historical status even when the current child state has advanced', () => {
    ;(window as any).KlausSubagentPanel = { getTask: () => ({ agentId: 'child', status: 'completed', agentName: 'Reviewer' }) }
    try {
      for (const [status, label] of [['started', '开始工作'], ['updated', '有了更新'], ['completed', '已完成']] as const) {
        const markup = renderToStaticMarkup(<AgentLifecycleRow event={{ taskId: 'tool-1', name: 'Reviewer', status }} />)
        expect(markup).toContain(label)
        expect(markup).toContain(`data-agent-event="${status}"`)
      }
    } finally { delete (window as any).KlausSubagentPanel }
  })

  test('spawn yields to lifecycle rows and completed process retains them', () => {
    const tool = { toolCallId: 'task', toolName: 'spawn_agent', args: { name: 'Reviewer' }, argsDelta: '', progress: [], status: 'ok' as const, agent: true, bgTask: false }
    const nodes = groupLiveActivityUnits([
      { type: 'live-tools', key: 'tools', order: ['task'], sealed: true },
      { type: 'live-agent-event', key: 'start', taskId: 'task', name: 'Reviewer', status: 'started' },
      { type: 'live-text', key: 'comment', text: 'Checking', streaming: false, phase: 'commentary' },
      { type: 'live-agent-event', key: 'done', taskId: 'task', name: 'Reviewer', status: 'completed' },
      { type: 'live-agent-event', key: 'update', taskId: 'task', name: 'Reviewer', status: 'updated' },
    ], { task: tool }, true, false)
    // The settled spawn row yields to the child's own inline lifecycle rows:
    // the same child must not appear twice.
    expect(nodes[0].kind === 'turn' && nodes[0].items.map(node => node.key)).toEqual(['start', 'comment', 'done'])
    const receipt = nodes[0].kind === 'turn' ? nodes[0].items[2] : null
    expect(receipt).toMatchObject({ kind: 'unit', unit: { status: 'completed' } })
    expect(receipt?.kind === 'unit' && receipt.unit.agentEvents).toMatchObject([{ status: 'completed' }, { status: 'updated' }])
    const running = groupLiveActivityUnits([
      { type: 'live-tools', key: 'tools', order: ['task'], sealed: true },
      { type: 'live-agent-event', key: 'start', taskId: 'task', name: 'Reviewer', status: 'started' },
    ], { task: { ...tool, status: 'running' } }, true, false)
    expect(running[0].kind === 'turn' && running[0].items.map(node => node.key)).toEqual(['task'])
    // Late completion stays inside the owning turn's process disclosure.
    const late = groupLiveActivityUnits([
      { type: 'live-tools', key: 'tools', order: ['task'], sealed: true },
      { type: 'live-text', key: 'answer', text: 'All done', streaming: false, phase: 'final_answer', turnTail: { ts: 1, meta: null } },
      { type: 'live-agent-event', key: 'done', taskId: 'task', name: 'Reviewer', status: 'completed', turnId: 'turn-1' },
    ], { task: tool }, false, false)
    expect(late.map(node => node.key)).toEqual(['turn:turn-1', 'answer'])
    expect(late[0].kind === 'turn' && late[0].items[0].key).toBe('done')
    expect(late[0].kind === 'turn' && late[0].preventAutoCollapse).toBe(false)
    // A child still working in an active turn remains visible and prevents folding.
    const unsettled = groupLiveActivityUnits([
      { type: 'live-text', key: 'answer', text: 'All done', streaming: false, phase: 'final_answer', turnTail: { ts: 1, meta: null } },
      { type: 'live-agent-event', key: 'update', taskId: 'task', name: 'Reviewer', status: 'updated', turnId: 'turn-1' },
    ], { task: tool }, true, false)
    expect(unsettled[0].kind === 'turn' && unsettled[0].preventAutoCollapse).toBe(true)
    const replay = unitsFromMessages([
      { role: 'assistant', uuid: 'spawn', contentBlocks: [{ type: 'tool_use', id: 'task', name: 'spawn_agent', input: {}, __result: { text: 'Started', isError: false } }] },
      { kind: 'agent-event', uuid: 'start', agentEvent: { taskId: 'task', name: 'Reviewer', status: 'started' } },
      { kind: 'agent-event', uuid: 'done', agentEvent: { taskId: 'task', name: 'Reviewer', status: 'completed' } },
    ])
    expect(replay.map(unit => unit.type)).toEqual(['tools', 'agent-event', 'agent-event'])
    expect(replay[1].agentEvent?.status).toBe('started')
    expect(replay[2].agentEvent?.status).toBe('completed')
  })
})

describe('inline compaction and read-only transcript', () => {
  test('compaction without restored files is a state label without an empty disclosure', () => {
    const completed = renderToStaticMarkup(<CompactionEvent loading={false} trigger="auto" />)
    expect(completed).toContain('上下文已自动压缩')
    expect(completed).not.toContain('<button')
    expect(completed).not.toContain('aria-expanded')
    const pending = renderToStaticMarkup(<CompactionEvent loading trigger="manual" />)
    expect(pending).toContain('上下文正在压缩')
    expect(pending).toContain('role="status"')
    expect(pending).not.toContain('<button')
  })

  test('recovered files belong to the compaction disclosure, not a pasted user bubble', () => {
    const restored = 'Fresh contents of recently-touched files:\n\n<file path="/work/example.ts">\n' + 'const value = 1\n'.repeat(100) + '</file>'
    const units = unitsFromMessages([
      { kind: 'compaction', uuid: 'boundary', role: 'user', text: '', compactionTrigger: 'auto' },
      { kind: 'compact-file-restore', uuid: 'restore', role: 'user', text: restored },
      { uuid: 'real', role: 'user', text: 'Please continue' },
    ])
    expect(units.map(unit => unit.type)).toEqual(['compaction', 'user'])
    expect(units[0].restoredText).toBe(restored)
    const transcript = renderToStaticMarkup(<StaticTranscriptView container={{} as HTMLElement} running={false} msgs={[
      { kind: 'compaction', uuid: 'boundary', role: 'user', text: '', compactionTrigger: 'auto' },
      { kind: 'compact-file-restore', uuid: 'restore', role: 'user', text: restored },
      { uuid: 'real', role: 'user', text: 'Please continue' },
    ]} />)
    expect(transcript).toContain('上下文已自动压缩')
    expect(transcript).toContain('Please continue')
    expect(transcript).not.toContain('Fresh contents')
    expect(transcript).not.toContain('is-pasted')
    const collapsed = renderToStaticMarkup(<CompactionEvent loading={false} trigger="auto" restoredText={restored} />)
    expect(collapsed).not.toContain('Fresh contents')
    expect(collapsed).not.toContain('is-pasted')
    expect(collapsed).toContain('aria-expanded="false"')
    expect(collapsed).toContain('压缩后重新读取的文件')
  })

  const coldOpenVectors = compactionVectors.coldOpenLongTurnCases.map(vector => {
    const turn = vector.withTurnIds ? { turnId: 'latest-turn' } : {}
    return {
      name: vector.name,
      messages: [
        { uuid: 'old-user', role: 'user', text: 'An earlier conversation', ...(vector.withTurnIds ? { turnId: 'old-turn' } : {}) },
        { uuid: 'latest-user', role: 'user', text: 'Latest real user request', ...turn },
        ...Array.from({ length: vector.beforeCompactionRows }, (_, index) => ({ uuid: `before-${index}`, role: 'assistant', text: `Earlier reply ${index}`, ...turn })),
        { uuid: 'long-compaction', role: 'user', kind: 'compaction', text: '', compactionTrigger: 'auto', ...turn },
        { uuid: 'long-summary', role: 'user', kind: 'compact-summary', text: 'Summary of compacted context', ...turn },
        { uuid: 'long-restore', role: 'user', kind: 'compact-file-restore', text: 'restored-long-turn-files', ...turn },
        ...Array.from({ length: vector.afterCompactionRows }, (_, index) => ({ uuid: `after-${index}`, role: 'assistant', text: index === vector.afterCompactionRows - 1 ? 'Latest actual reply' : `Later reply ${index}`, ...turn })),
      ],
    }
  })
  for (const vector of coldOpenVectors) {
    test(vector.name, () => {
      const start = transcriptPageStart(vector.messages, vector.messages.length - 100)
      const visible = vector.messages.slice(start).map(message => message.text)
      expect(visible).toContain('Latest real user request')
      expect(visible).toContain('Latest actual reply')
    })
  }
  for (const vector of compactionVectors.cases) {
    test(vector.name, () => {
      const sessionId = 'compaction-transcript-vector'
      const initial = chatStreamStore.getInitialState()
      const previousSessions = initial.sessions
      const previousDocument = (globalThis as any).document
      initial.sessions = {
        ...previousSessions,
        [sessionId]: {
          ...getSessionStream('missing-compaction-vector'),
          history: vector.messages,
          compactionPendingTrigger: vector.pendingTrigger ?? null,
        },
      }
      ;(globalThis as any).document = { getElementById: () => null }
      try {
        const primary = renderToStaticMarkup(<TranscriptView sessionId={sessionId} container={{} as HTMLElement} />)
        const readonly = renderToStaticMarkup(<StaticTranscriptView container={{} as HTMLElement} running={false} msgs={vector.messages} />)
        for (const transcript of [primary, readonly]) {
          let previousIndex = -1
          for (const text of vector.visibleText) {
            const index = transcript.indexOf(text)
            expect(index).toBeGreaterThan(previousIndex)
            previousIndex = index
          }
          for (const text of vector.hiddenText) expect(transcript).not.toContain(text)
          // A checkpoint body is provider context: the saved transcript shows the
          // summary card, never an assistant answer nobody asked for.
          if ('expectNoAssistantBubble' in vector && vector.expectNoAssistantBubble) expect(transcript).not.toContain('msg-group assistant')
          expect(transcript.split('上下文已自动压缩').length - 1).toBeGreaterThanOrEqual(vector.boundaries)
          expect(transcript).not.toContain('展开压缩历史')
        }
        if (vector.pendingTrigger) expect(primary).toContain('上下文正在压缩')
      } finally {
        initial.sessions = previousSessions
        if (previousDocument === undefined) delete (globalThis as any).document
        else (globalThis as any).document = previousDocument
      }
    })
  }

  test('live compaction stays after earlier text and before subsequent activity', () => {
    const nodes = groupLiveActivityUnits([
      { type: 'live-text', key: 'before', text: 'Before', streaming: false, phase: 'commentary' },
      { type: 'live-compaction', key: 'compact', trigger: 'auto', state: 'completed' },
      { type: 'live-text', key: 'after', text: 'After', streaming: true, phase: 'commentary' },
    ], {}, true, false)
    expect(nodes[0].kind === 'turn' && nodes[0].items.map(node => node.key)).toEqual(['before', 'compact', 'after'])
  })

  test('child transcript retains content copying without parent conversation mutations or tooltips', () => {
    const actions = renderMsgActionsHtml({ ts: 0, copyText: 'Child prompt', uuid: 'child-msg', kind: 'user', archived: false, running: false, readOnly: true })
    expect(actions).toContain('msg-action-btn')
    expect(actions).not.toContain('data-action=')
    expect(actions).not.toContain('title=')
    const markup = renderToStaticMarkup(<StaticTranscriptView container={{} as HTMLElement} running={false} msgs={[
      { role: 'user', uuid: 'child-prompt', text: 'Child prompt' },
    ]} />)
    expect(markup).toContain('Child prompt')
    expect(markup).not.toContain('data-action="branch"')
    expect(markup).not.toContain('data-action="rewind"')
  })

  test('message copy click writes the assistant markdown source and visibly acknowledges success', async () => {
    const copied: string[] = []
    const attributes = new Map<string, string>()
    const bar = { dataset: { copyText: 'fallback text' } }
    const group = { dataset: {}, querySelector: () => ({ dataset: { md: '**exact answer**' } }) }
    const button: any = {
      disabled: false,
      dataset: {},
      innerHTML: '',
      classList: { add: () => {}, remove: () => {} },
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      closest: (selector: string) => selector === '.msg-action-btn' ? button : selector === '.msg-actions' ? bar : selector === '.msg-group' ? group : null,
    }
    const formerElement = globalThis.Element
    const formerTimeout = globalThis.setTimeout
    let resetFeedback: (() => void) | undefined
    globalThis.setTimeout = ((callback: () => void) => { resetFeedback = callback; return 0 }) as unknown as typeof setTimeout
    ;(globalThis as any).Element = class FixtureElement {}
    let stopped = false
    try {
      makeTranscriptClickHandler('', async text => { copied.push(text) })({
        target: button,
        stopPropagation: () => { stopped = true },
      } as unknown as Event)
      await Promise.resolve()
      expect(stopped).toBe(true)
      expect(copied).toEqual(['**exact answer**'])
      expect(button.innerHTML).toContain('<svg')
      expect(attributes.has('aria-label')).toBe(true)
      expect(resetFeedback).toBeDefined()
      resetFeedback!()
      expect(button.innerHTML).toContain('<svg')
    } finally {
      globalThis.setTimeout = formerTimeout
      if (formerElement) globalThis.Element = formerElement
      else delete (globalThis as any).Element
    }
  })

  test('directory and read icons differ while existing command and search glyphs stay semantic', () => {
    expect(toolIconForName('ls')).not.toBe(toolIconForName('read'))
    expect(toolIconForName('ls')).toBe(toolIconForName('list_directory'))
    expect(toolIconForName('bash')).toBe(toolIconForName('exec_command'))
    expect(toolIconForName('grep')).not.toBe(toolIconForName('ls'))
  })
})
