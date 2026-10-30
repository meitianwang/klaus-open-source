import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/agent-lifecycle-presentation-vectors.json'
import type { AgentLifecycleStatus } from './agent-lifecycle'
import type { LiveUnit } from '../stream-store'

;(globalThis as any).window ||= { addEventListener: () => {} }
const { foldUnits, groupLiveActivityUnits, unitsFromMessages } = await import('./TranscriptView')

describe('child lifecycle process contract', () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) test(`flat saved commentary retains its phase beside a late ${status} receipt`, () => {
    const nodes = foldUnits(unitsFromMessages([
      { kind: 'agent-event', uuid: 'start', turnId: 'parent', agentEvent: { taskId: 'alpha', name: 'Review', status: 'started' } },
      { role: 'assistant', uuid: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer' },
      { role: 'assistant', uuid: 'next-final', turnId: 'next', text: 'Next answer', phase: 'final_answer' },
      { role: 'assistant', uuid: 'later-comment', turnId: 'parent', text: 'Ordinary later commentary', phase: 'commentary' },
      { kind: 'agent-event', uuid: 'terminal', turnId: 'parent', agentEvent: { taskId: 'alpha', name: 'Review', status } },
    ]), null, { parent: 'completed', next: 'completed' }, {})
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'agent-event')).toHaveLength(0)
    const folds = nodes.filter(node => node.kind === 'turn-fold')
    expect(folds).toHaveLength(1)
    expect(folds[0]).toMatchObject({ turnId: 'parent', open: false })
    expect(JSON.stringify(folds[0].items)).toContain(`"status":"${status}"`)
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'text').map(node => node.kind === 'unit' && node.unit.segment?.text)).toEqual(['Parent answer', 'Next answer', 'Ordinary later commentary'])
  })
  for (const status of ['completed', 'failed', 'cancelled'] as const) test(`live mixed resumed commentary and ${status} remain independently owned`, () => {
    const source: LiveUnit[] = [
      { type: 'live-text', key: 'checking', turnId: 'parent', text: 'Checking', phase: 'commentary', streaming: false },
      { type: 'live-text', key: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer', streaming: false },
      { type: 'live-text', key: 'next-final', turnId: 'next', text: 'Next answer', phase: 'final_answer', streaming: false },
      { type: 'live-text', key: 'later-comment', turnId: 'parent', text: 'Ordinary later commentary', phase: 'commentary', streaming: false },
      { type: 'live-agent-event', key: 'terminal', turnId: 'parent', taskId: 'alpha', name: 'Review', status, timestamp: 1 },
    ]
    const nodes = groupLiveActivityUnits(source, {}, false, false)
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'live-agent-event')).toHaveLength(0)
    const folds = nodes.filter(node => node.kind === 'turn')
    expect(folds).toHaveLength(1)
    expect(folds[0].kind === 'turn' && folds[0].preventAutoCollapse).toBe(false)
    expect(JSON.stringify(folds[0])).toContain(`"status":"${status}"`)
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'live-text').map(node => node.kind === 'unit' && node.unit.type === 'live-text' && node.unit.text)).toEqual(['Parent answer', 'Next answer', 'Ordinary later commentary'])
  })
  test('a completed turn without terminal markers folds while a later turn streams', () => {
    const tools = {
      bash1: { toolCallId: 'bash1', toolName: 'bash', args: {}, argsDelta: '', progress: [], status: 'ok' as const, agent: false, bgTask: false },
      bash2: { toolCallId: 'bash2', toolName: 'bash', args: {}, argsDelta: '', progress: [], status: 'running' as const, agent: false, bgTask: false },
    }
    const source: LiveUnit[] = [
      { type: 'live-user', key: 'u1', turnId: 'done', msg: { uuid: 'u1', role: 'user', text: 'Fix the layout' } },
      { type: 'live-tools', key: 't1', turnId: 'done', order: ['bash1'], sealed: true },
      { type: 'live-text', key: 'comment', turnId: 'done', text: 'Measuring', phase: 'commentary', streaming: false },
      { type: 'live-text', key: 'answer', turnId: 'done', text: 'Done: rows align', streaming: false },
      { type: 'live-user', key: 'u2', turnId: 'next', msg: { uuid: 'u2', role: 'user', text: 'Next thing' } },
      { type: 'live-tools', key: 't2', turnId: 'next', order: ['bash2'], sealed: false },
    ]
    // The finished turn keeps no turnTail / final_answer marker (a steered
    // delivery raced the terminal item update), yet it must fold exactly like
    // the saved-history projection once it is no longer the streaming tail.
    const nodes = groupLiveActivityUnits(source, tools, true, false)
    const folds = nodes.filter(node => node.kind === 'turn')
    expect(folds).toHaveLength(2)
    expect(folds[1]).toMatchObject({ turnId: 'next', running: true, preventAutoCollapse: true })
    expect(folds[0].kind === 'turn' && folds[0].turnId).toBe('done')
    expect(folds[0].kind === 'turn' && folds[0].preventAutoCollapse).toBe(false)
    // The positional fallback lifts the turn's last non-commentary text out of
    // the fold as the final reply; commentary and tools stay inside it.
    const foldItems = folds[0].kind === 'turn' ? folds[0].items : []
    expect(foldItems.map(item => item.key)).toEqual(['bash1', 'comment'])
    expect(nodes.map(node => node.key)).toEqual(['u1', 'turn:done', 'answer', 'u2', 'turn:next'])
    // The streaming tail uses the same disclosure and defaults to expanded.
    const tail = groupLiveActivityUnits(source.slice(0, 4), tools, true, false)
    expect(tail.find(node => node.kind === 'turn')).toMatchObject({ running: true, preventAutoCollapse: true })
    expect(tail.map(node => node.key)).toEqual(['u1', 'turn:done'])
  })
  test('a child resumed in a later parent cannot keep the older process open', () => {
    const previous = (window as any).KlausSubagentPanel
    ;(window as any).KlausSubagentPanel = { listTasks: () => [['alpha', { agentId: 'alpha', status: 'running', spawnTurnId: 'next' }]] }
    try {
      const source = unitsFromMessages([
        { kind: 'agent-event', uuid: 'start', turnId: 'parent', agentEvent: { taskId: 'alpha', agentId: 'alpha', name: 'Review', status: 'started' } },
        { role: 'assistant', uuid: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer' },
      ])
      expect(foldUnits(source, null, { parent: 'completed' }, {}).find(node => node.kind === 'turn-fold')).toMatchObject({ open: false })
    } finally { (window as any).KlausSubagentPanel = previous }
  })
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const persisted of ['record', 'notification'] as const) test(`${persisted} ${status} after another turn remains inside its owner fold`, () => {
      const event = { taskId: 'alpha', agentId: 'child-alpha', name: 'Review alpha', status }
      const notice = persisted === 'record'
        ? { kind: 'agent-event', uuid: 'late-alpha', turnId: 'parent', agentEvent: event }
        : { role: 'user', uuid: 'late-alpha', turnId: 'parent', text: `<task-notification><task-id>alpha</task-id><agent-id>child-alpha</agent-id><task-name>Review alpha</task-name><status>${status}</status></task-notification>` }
      const source = unitsFromMessages([
        { role: 'user', uuid: 'request', turnId: 'parent', text: 'Review' },
        { kind: 'agent-event', uuid: 'start-alpha', turnId: 'parent', agentEvent: { ...event, status: 'started' } },
        { role: 'assistant', uuid: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer' },
        { role: 'user', uuid: 'next-request', turnId: 'next', text: 'Next request' },
        { role: 'assistant', uuid: 'next-final', turnId: 'next', text: 'Next answer', phase: 'final_answer' },
        notice,
      ])
      for (const collapsed of [true, false]) {
        const nodes = foldUnits(source, null, { parent: 'completed', next: 'completed' }, { 'turn:parent': collapsed })
        expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'agent-event')).toHaveLength(0)
        const folds = nodes.filter(node => node.kind === 'turn-fold')
        expect(folds).toHaveLength(1)
        expect(folds[0]).toMatchObject({ turnId: 'parent', open: !collapsed })
        expect(JSON.stringify(folds[0].items)).toContain(`"status":"${status}"`)
        expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'text').map(node => node.kind === 'unit' && node.unit.segment?.text)).toEqual(['Parent answer', 'Next answer'])
      }
    })
  }
  test('a receipt naming an absent turn is dropped instead of stranding at the tail', () => {
    const source = unitsFromMessages([
      { role: 'user', uuid: 'request', turnId: 'parent', text: 'Review' },
      { role: 'assistant', uuid: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer' },
      { kind: 'agent-event', uuid: 'orphan', turnId: 'agent:orphan-child', agentEvent: { taskId: 'orphan', agentId: 'orphan-child', name: 'Orphan', status: 'completed' } },
      { kind: 'agent-event', uuid: 'orphan-uuid', turnId: '9f1c-child-turn', agentEvent: { taskId: 'orphan2', agentId: 'orphan2', name: 'Orphan2', status: 'completed' } },
    ])
    const nodes = foldUnits(source, null, { parent: 'completed' }, {})
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'agent-event')).toHaveLength(0)
    // The orphan row is gone entirely: no fold of its own, no tail group,
    // and the owner-less turn never appears as a segment of its own.
    expect(nodes.filter(node => node.kind === 'turn-fold')).toHaveLength(0)
    expect(nodes.filter(node => node.kind === 'unit' && node.unit.type === 'text').map(node => node.kind === 'unit' && node.unit.segment?.text)).toEqual(['Parent answer'])
    const live: LiveUnit[] = [
      { type: 'live-user', key: 'u', turnId: 'parent', msg: { uuid: 'u', role: 'user', text: 'Review' } },
      { type: 'live-text', key: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer', streaming: false },
      { type: 'live-agent-event', key: 'orphan', turnId: 'agent:orphan-child', taskId: 'orphan', name: 'Orphan', status: 'completed', timestamp: 5 },
      { type: 'live-agent-event', key: 'orphan-uuid', turnId: '9f1c-child-turn', taskId: 'orphan2', name: 'Orphan2', status: 'completed', timestamp: 6 },
    ]
    const projection = groupLiveActivityUnits(live, {}, false, false)
    expect(projection.filter(node => node.kind === 'unit' && node.unit.type === 'live-agent-event')).toHaveLength(0)
    expect(projection.map(node => node.key)).toEqual(['u', 'final'])
  })
  test('a receipt whose named turn still exists keeps its row even when the group is agent-only', () => {
    const source = unitsFromMessages([
      { role: 'user', uuid: 'request', turnId: 'parent', text: 'Review' },
      { role: 'assistant', uuid: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer' },
      { kind: 'agent-event', uuid: 'owned', turnId: 'parent', agentEvent: { taskId: 'alpha', agentId: 'alpha', name: 'Review', status: 'completed' } },
    ])
    const nodes = foldUnits(source, null, { parent: 'completed' }, {})
    const fold = nodes.find(node => node.kind === 'turn-fold')
    expect(fold?.kind === 'turn-fold' && fold.items.filter(node => node.kind === 'unit' && node.unit.type === 'agent-event')).toHaveLength(1)
  })
  for (const vector of vectors.cases) test(vector.name, () => {
    const previous = (window as any).KlausSubagentPanel
    const tasks = Object.fromEntries(Object.entries(vector.tasks || {}).map(([id, status]) => [id, { agentId: id, status }]))
    ;(window as any).KlausSubagentPanel = { listTasks: () => Object.entries(tasks), getTask: (id: string) => tasks[id] }
    try {
      // Separate notices with commentary to exercise settlement across rows,
      // rather than accidentally relying on adjacent-notice coalescing.
      const events = vector.events.map(([id, status], index) => ({ taskId: id, agentId: id,
        name: `Review ${id}`, status: status as AgentLifecycleStatus, key: `notice-${index}`, turnId: 'parent', timestamp: index }))
      const messages = events.flatMap(event => [
        { kind: 'agent-event', uuid: event.key, turnId: 'parent', agentEvent: event },
        { role: 'assistant', uuid: `comment-${event.key}`, turnId: 'parent', text: `Progress ${event.key}`, phase: 'commentary' },
      ])
      messages.push({ role: 'assistant', uuid: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer' } as any)
      const source = unitsFromMessages(messages)
      const history = foldUnits(source, null, { parent: 'completed' }, {})
      const fold = history.find(node => node.kind === 'turn-fold')
      expect(fold?.kind === 'turn-fold' && fold.open).toBe(vector.open)
      expect(fold?.kind === 'turn-fold' && fold.items.filter(node => node.kind === 'unit' && node.unit.type === 'agent-event')).toHaveLength(events.length)
      expect(history.some(node => node.kind === 'unit' && node.unit.segment?.text === 'Parent answer')).toBe(true)
      const reopened = foldUnits(source, null, { parent: 'completed' }, { 'turn:parent': false })
      expect(reopened.find(node => node.kind === 'turn-fold')).toMatchObject({ open: true, items: fold?.kind === 'turn-fold' ? fold.items : [] })
      const closed = foldUnits(source, null, { parent: 'completed' }, { 'turn:parent': true })
      expect(closed.find(node => node.kind === 'turn-fold')).toMatchObject({ open: false })
      const live: LiveUnit[] = events.flatMap(event => [
        { ...event, type: 'live-agent-event' as const },
        { type: 'live-text' as const, key: `comment-${event.key}`, turnId: 'parent', text: `Progress ${event.key}`, streaming: false, phase: 'commentary' as const },
      ])
      live.push({ type: 'live-text', key: 'final', turnId: 'parent', text: 'Parent answer', phase: 'final_answer', streaming: false })
      const projection = groupLiveActivityUnits(live, {}, false, false)
      expect(projection[0].kind === 'turn' && projection[0].preventAutoCollapse).toBe(vector.open)
      expect(projection[0].kind === 'turn' && projection[0].items.filter(node => node.kind === 'unit' && node.unit.type === 'live-agent-event')).toHaveLength(events.length)
      expect(projection.at(-1)?.key).toBe('final')
    } finally { (window as any).KlausSubagentPanel = previous }
  })
})
