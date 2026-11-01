import { describe, expect, test } from 'bun:test'

let scheduledClockTick: (() => void) | null = null
let activeClockIntervals = 0

;(globalThis as any).window = {
  addEventListener: () => {},
  clearInterval: () => {
    activeClockIntervals -= 1
    scheduledClockTick = null
  },
  setInterval: (callback: () => void) => {
    activeClockIntervals += 1
    scheduledClockTick = callback
    return 1
  },
}

const section = await import('./subagents')
const avatars = await import('../subagent-avatar')
const status = await import('../agent-status')
const {
  isBackgroundSubagent,
  orderSubagents,
  subagentDisplayStatus,
  subagentClockSnapshot,
  subagentDuration,
  subagentRowDisplayKey,
  subscribeSubagentClock,
} = section
const {
  normalizeSubagentAvatarIds,
  preserveSubagentAvatarId,
  subagentAvatarHtml,
} = avatars
const {
  agentTasksEquivalent,
  observeMissingBackgroundAgents,
  preserveAgentLifecycle,
  reconcileAgentRuntimeState,
  reconcileAgentStatus,
} = status
type SubagentEntry = import('./subagents').SubagentEntry
type AgentTask = import('../engine-events').AgentTask

const entry = (id: string, task: Record<string, unknown>): SubagentEntry => [id, task as never]

describe('background subagent order', () => {
  test('keeps live runs ahead of terminal runs, then sorts each group oldest first', () => {
    const ordered = orderSubagents([
      entry('t1', { status: 'completed', startedAtMs: 4_000, completedAtMs: 9_000 }),
      entry('t2', { status: 'running', startedAtMs: 5_000 }),
      entry('t3', { status: 'running', startedAtMs: 1_000 }),
      entry('t4', { status: 'failed', startedAtMs: 2_000, completedAtMs: 3_000 }),
    ])
    expect(ordered.map(([id]) => id)).toEqual(['t3', 't2', 't4', 't1'])
  })

  test('places untimed rows after timed siblings and uses task id as the stable tie breaker', () => {
    const ordered = orderSubagents([
      entry('z', { status: 'running' }),
      entry('b', { status: 'running', startedAtMs: 1_000 }),
      entry('a', { status: 'running' }),
    ])
    expect(ordered.map(([id]) => id)).toEqual(['b', 'a', 'z'])
  })
})

describe('subagent lifecycle model', () => {
  test('shares one clock snapshot across independently rendered surfaces', () => {
    const originalNow = Date.now
    let now = 100_000
    Date.now = () => now
    let firstNow = 0
    let secondNow = 0
    const disposeFirst = subscribeSubagentClock(() => { firstNow = subagentClockSnapshot() })
    const disposeSecond = subscribeSubagentClock(() => { secondNow = subagentClockSnapshot() })
    try {
      expect(activeClockIntervals).toBe(1)
      expect(secondNow).toBe(firstNow)
      now += 1_000
      scheduledClockTick?.()
      expect(firstNow).toBe(now)
      expect(secondNow).toBe(now)
      const task = { status: 'running', startedAtMs: firstNow - 65_000 } as const
      expect(subagentDuration(task, firstNow)).toBe(subagentDuration(task, secondNow))
    } finally {
      disposeSecond()
      disposeFirst()
      Date.now = originalNow
    }
    expect(activeClockIntervals).toBe(0)
  })

  test('preserves waiting, paused, failed and stopped instead of folding them into done', () => {
    expect(subagentDisplayStatus({ status: 'running' })).toBe('running')
    expect(subagentDisplayStatus({ status: 'running', isIdle: true })).toBe('pending')
    expect(subagentDisplayStatus({ status: 'pending' })).toBe('pending')
    expect(subagentDisplayStatus({ status: 'paused' })).toBe('paused')
    expect(subagentDisplayStatus({ status: 'completed' })).toBe('completed')
    expect(subagentDisplayStatus({ status: 'failed' })).toBe('failed')
    expect(subagentDisplayStatus({ status: 'killed' })).toBe('stopped')
    expect(subagentDisplayStatus({ status: 'cancelled' })).toBe('stopped')
  })

  test('only an authoritative marker puts a task in the Monitor section', () => {
    expect(isBackgroundSubagent({ isBackground: true })).toBe(true)
    expect(isBackgroundSubagent({ agentType: 'background' })).toBe(false)
    expect(isBackgroundSubagent({ agentId: 'child' })).toBe(false)
  })

  test('formats a terminal duration from lifecycle timestamps', () => {
    expect(subagentDuration({ status: 'completed', startedAtMs: 1_000, completedAtMs: 66_000 }, 100_000)).toBe('1m 5s')
    expect(subagentDuration({ status: 'running' }, 100_000)).toBe('')
  })

  test('background lifecycle reconciliation marks the matched accumulator task', () => {
    expect(reconcileAgentStatus(
      { call: { agentId: 'child', status: 'completed' } },
      [{ id: 'child', status: 'running', idle: false, startedAtMs: 10 }],
    )).toEqual({
      call: { agentId: 'child', status: 'running', isIdle: false, isBackground: true, startedAtMs: 10 },
    })
  })

  test('the resolved child model rides the authoritative summary onto the row', () => {
    const next = reconcileAgentStatus(
      { call: { agentId: 'child', status: 'running' } },
      [{ id: 'child', status: 'running', idle: false, model: 'tier-resolved-model', modelSource: 'codex', startedAtMs: 10 }],
    )
    expect(next.call.model).toBe('tier-resolved-model')
    expect(next.call.modelSource).toBe('codex')
    // A later stamp on the same child repaints; an unchanged stamp does not.
    expect(agentTasksEquivalent(next, reconcileAgentStatus(next, [
      { id: 'child', status: 'running', idle: false, model: 'tier-resolved-model', startedAtMs: 10 },
    ]))).toBe(true)
    const changed = reconcileAgentStatus(next, [
      { id: 'child', status: 'running', idle: false, model: 'other-model', startedAtMs: 10 },
    ])
    expect(changed.call.model).toBe('other-model')
    expect(agentTasksEquivalent(next, changed)).toBe(false)
    // Rows whose lifecycle predates the stamp keep whatever they had.
    expect(reconcileAgentStatus(changed, [
      { id: 'child', status: 'running', idle: false, startedAtMs: 10 },
    ]).call.model).toBe('other-model')
  })

  test('a completion timestamp retires a stale running summary', () => {
    expect(reconcileAgentRuntimeState(
      { call: { agentId: 'child', status: 'running' } },
      [{
        id: 'child',
        status: 'running',
        idle: false,
        startedAtMs: 10,
        updatedAtMs: 20,
        completedAtMs: 20,
      }],
    )).toEqual({
      tasks: {
        call: {
          agentId: 'child',
          status: 'completed',
          isIdle: false,
          isBackground: true,
          startedAtMs: 10,
          updatedAtMs: 20,
          completedAtMs: 20,
          recencyAtMs: 20,
          lifecycleUpdatedAtMs: 20,
        },
      },
      working: false,
    })
  })

  test('an interrupted lifecycle summary clears the running state', () => {
    expect(reconcileAgentRuntimeState(
      { call: { agentId: 'child', status: 'running' } },
      [{ id: 'child', status: 'stopped', completedAtMs: 20 }],
    )).toEqual({
      tasks: {
        call: {
          agentId: 'child',
          status: 'stopped',
          isIdle: false,
          isBackground: true,
          completedAtMs: 20,
          lifecycleUpdatedAtMs: 20,
        },
      },
      working: false,
    })
  })

  for (const cachedStatus of ['stopped', 'killed', 'cancelled']) {
    for (const authoritativeStatus of ['completed', 'failed', 'budget_limited']) {
      test(`authoritative ${authoritativeStatus} corrects cached ${cachedStatus}`, () => {
        const next = reconcileAgentStatus({
          call: { agentId: 'child', status: cachedStatus, updatedAtMs: 20_000, completedAtMs: 20_000 },
        }, [{ id: 'child', status: authoritativeStatus, updatedAtMs: 9_000, completedAtMs: 9_000 }])
        expect(next.call.status).toBe(authoritativeStatus)
        expect(next.call.lifecycleUpdatedAtMs).toBe(9_000)
        expect(next.call.completedAtMs).toBe(9_000)
      })
    }
  }

  test('late older lifecycle snapshots cannot overwrite a confirmed terminal state', () => {
    const stopped = { call: {
      agentId: 'child', status: 'stopped', lifecycleUpdatedAtMs: 9_000,
      updatedAtMs: 9_000, completedAtMs: 9_000,
    } }
    const next = reconcileAgentStatus(stopped, [{
      id: 'child', status: 'completed', updatedAtMs: 8_000, completedAtMs: 8_000,
    }])
    expect(next).toEqual(stopped)
    expect(agentTasksEquivalent(stopped, next)).toBe(true)
    const done = { call: { ...stopped.call, status: 'completed' } }
    expect(reconcileAgentStatus(done, [{
      id: 'child', status: 'stopped', completedAtMs: 8_000,
    }])).toEqual(done)
  })

  test('optimistic presentation stops do not advance the lifecycle version', () => {
    const next = reconcileAgentStatus({
      call: { agentId: 'child', status: 'stopped', lifecycleUpdatedAtMs: 8_000,
        updatedAtMs: 20_000, completedAtMs: 20_000 },
    }, [{ id: 'child', status: 'completed', updatedAtMs: 9_000, completedAtMs: 9_000 }])
    expect(next.call.status).toBe('completed')
    expect(next.call.lifecycleUpdatedAtMs).toBe(9_000)
  })

  test('equal or missing clocks use the explicit authoritative terminal state', () => {
    const cached = { call: { agentId: 'child', status: 'stopped', lifecycleUpdatedAtMs: 9_000 } }
    expect(reconcileAgentStatus(cached, [{
      id: 'child', status: 'completed', updatedAtMs: 9_000,
    }]).call.status).toBe('completed')
    expect(reconcileAgentStatus(cached, [{
      id: 'child', status: 'failed', updatedAtMs: Number.NaN,
    }]).call.status).toBe('failed')
    expect(reconcileAgentStatus(cached, [{
      id: 'child', status: 'budget_limited',
    }]).call.status).toBe('budget_limited')
  })

  test('a newer authoritative stop remains stopped and a resumed run clears old completion', () => {
    const done = { call: { agentId: 'child', status: 'completed',
      lifecycleUpdatedAtMs: 8_000, completedAtMs: 8_000 } }
    const stopped = reconcileAgentStatus(done, [{
      id: 'child', status: 'stopped', updatedAtMs: 9_000, completedAtMs: 9_000,
    }])
    expect(stopped.call.status).toBe('stopped')
    const resumed = reconcileAgentRuntimeState(stopped, [{
      id: 'child', status: 'running', updatedAtMs: 10_000, completedAtMs: null,
    }])
    expect(resumed.working).toBe(true)
    expect(resumed.tasks.call.completedAtMs).toBeUndefined()
    expect(resumed.tasks.call.lifecycleUpdatedAtMs).toBe(10_000)
  })

  test('a newer lifecycle can correct a stop synthesized from a missing snapshot', () => {
    const next = reconcileAgentStatus({
      call: { agentId: 'child', status: 'stopped', lifecycleUpdatedAtMs: 2_000 },
    }, [{ id: 'child', status: 'completed', updatedAtMs: 3_000, completedAtMs: 3_000 }])
    expect(next.call.status).toBe('completed')
  })

  test('incoming task snapshots cannot replace a newer confirmed lifecycle row', () => {
    const previous: AgentTask = { agentId: 'child', status: 'completed', lifecycleUpdatedAtMs: 9_000,
      updatedAtMs: 9_000, completedAtMs: 9_000, notified: true }
    expect(preserveAgentLifecycle(previous, {
      agentId: 'child', status: 'stopped', lifecycleUpdatedAtMs: 8_000,
      updatedAtMs: 8_000, completedAtMs: 8_000,
    })).toBe(previous)
  })

  test('presentation snapshots retain the lifecycle watermark despite their own clock', () => {
    const previous: AgentTask = { agentId: 'child', status: 'completed', lifecycleUpdatedAtMs: 9_000 }
    const merged = preserveAgentLifecycle(previous, {
      agentId: 'child', status: 'stopped', updatedAtMs: 20_000, completedAtMs: 20_000,
    })
    expect(merged.status).toBe('stopped')
    expect(merged.lifecycleUpdatedAtMs).toBe(9_000)
    expect(reconcileAgentStatus({ call: merged }, [{
      id: 'child', status: 'failed', updatedAtMs: 8_000, completedAtMs: 8_000,
    }]).call).toEqual(merged)
  })

  test('newer and unversioned task snapshots retain their presentation updates', () => {
    const previous = { agentId: 'child', status: 'stopped', lifecycleUpdatedAtMs: 9_000 }
    const incoming = { agentId: 'child', status: 'running', lifecycleUpdatedAtMs: 10_000 }
    expect(preserveAgentLifecycle(previous, incoming)).toBe(incoming)
    const unversioned = { agentId: 'child', status: 'running' }
    expect(preserveAgentLifecycle(undefined, unversioned)).toBe(unversioned)
  })

  test('a vanished background run needs two authoritative omissions before retirement', () => {
    const tasks = { call: { agentId: 'child', status: 'running', isBackground: true } }
    const first = observeMissingBackgroundAgents(tasks, [], undefined)
    expect(first.observations).toEqual({ child: 1 })
    expect(first.confirmed.size).toBe(0)
    expect(reconcileAgentRuntimeState(tasks, [], first.confirmed).working).toBe(true)

    const second = observeMissingBackgroundAgents(tasks, [], first.observations)
    expect(second.observations).toEqual({ child: 2 })
    expect([...second.confirmed]).toEqual(['child'])
    expect(reconcileAgentRuntimeState(tasks, [], second.confirmed)).toEqual({
      tasks: { call: { agentId: 'child', status: 'completed', isBackground: true, isIdle: false } },
      working: false,
    })
  })

  test('present authoritative agents and foreground tasks never accrue missing evidence', () => {
    const tasks = {
      foreground: { agentId: 'foreground-child', status: 'running' },
      background: { agentId: 'background-child', status: 'running', isBackground: true },
    }
    const observed = observeMissingBackgroundAgents(tasks, [{ id: 'background-child', status: 'running' }], { 'background-child': 1 })
    expect(observed.observations).toEqual({})
    expect(reconcileAgentRuntimeState(tasks, [], new Set(['foreground-child']))).toEqual({ tasks, working: true })
  })

  test('assigns stable collision-free avatar identities in task order', () => {
    const tasks: Record<string, AgentTask> = {
      later: { startedAtMs: 20 },
      earlier: { startedAtMs: 10 },
      untimed: {},
    }
    expect(normalizeSubagentAvatarIds(tasks)).toBe(true)
    expect(tasks).toEqual({
      later: { startedAtMs: 20, avatarId: 1 },
      earlier: { startedAtMs: 10, avatarId: 0 },
      untimed: { avatarId: 2 },
    })
    expect(normalizeSubagentAvatarIds(tasks)).toBe(false)
  })

  test('preserves valid identities and repairs invalid or duplicate persisted ones', () => {
    const tasks: Record<string, AgentTask> = {
      kept: { startedAtMs: 10, avatarId: 7 },
      duplicate: { startedAtMs: 20, avatarId: 7 },
      invalid: { startedAtMs: 30, avatarId: -1 },
      next: { startedAtMs: 40 },
    }
    normalizeSubagentAvatarIds(tasks)
    expect(tasks.kept.avatarId).toBe(7)
    expect(new Set(Object.values(tasks).map(task => task.avatarId)).size).toBe(4)
    expect(Object.values(tasks).every((task) => {
      const avatarId = task.avatarId
      return typeof avatarId === 'number' && Number.isSafeInteger(avatarId) && avatarId >= 0
    })).toBe(true)
  })

  test('does not reuse an avatar identity across a large session ledger', () => {
    const tasks: Record<string, AgentTask> = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [`task-${index}`, { startedAtMs: index }]),
    )
    normalizeSubagentAvatarIds(tasks)
    const avatarIds = Object.values(tasks).map(task => task.avatarId)
    expect(new Set(avatarIds).size).toBe(avatarIds.length)
  })

  test('carries the persisted avatar identity across engine snapshot replacement', () => {
    expect(preserveSubagentAvatarId(
      { agentId: 'child', avatarId: 12, messages: ['old'] },
      { agentId: 'child', status: 'running' },
    )).toEqual({ agentId: 'child', avatarId: 12, status: 'running' })
  })

  test('keeps static avatars identical across status changes', () => {
    expect(subagentAvatarHtml(3, 20, 'running')).toBe(subagentAvatarHtml(3, 20, 'completed'))
    expect(subagentAvatarHtml(3, 20)).not.toBe(subagentAvatarHtml(4, 20))
    expect(subagentAvatarHtml(3, 20)).toContain('orb-3.webp')
    expect(subagentAvatarHtml(3, 20, 'completed')).toContain('data-avatar-id="3"')
  })
})

describe('reconcile change gate', () => {
  const base = {
    t1: { agentId: 'a1', status: 'running', isIdle: false, isBackground: true, avatarId: 0, description: 'probe', startedAtMs: 1_000 },
  } as Record<string, AgentTask>

  test('treats an identical snapshot as unchanged', () => {
    expect(agentTasksEquivalent(base, { ...base, t1: { ...base.t1 } })).toBe(true)
  })

  test('detects status, idle and timestamp movement', () => {
    expect(agentTasksEquivalent(base, { t1: { ...base.t1, status: 'completed', completedAtMs: 9_000 } })).toBe(false)
    expect(agentTasksEquivalent(base, { t1: { ...base.t1, isIdle: true } })).toBe(false)
    expect(agentTasksEquivalent(base, { t1: { ...base.t1, updatedAtMs: 5_000 } })).toBe(false)
    expect(agentTasksEquivalent(base, { t1: { ...base.t1, lifecycleUpdatedAtMs: 5_000 } })).toBe(false)
  })

  test('detects added, removed and renamed tasks', () => {
    expect(agentTasksEquivalent(base, { ...base, t2: { ...base.t1, agentId: 'a2' } })).toBe(false)
    expect(agentTasksEquivalent(base, {})).toBe(false)
    expect(agentTasksEquivalent(base, { t1: { ...base.t1, description: 'renamed' } })).toBe(false)
  })

  test('ignores fields the rows never render', () => {
    expect(agentTasksEquivalent(base, { t1: { ...base.t1, messages: ['x'], statusSummary: 'busy' } })).toBe(true)
  })
})

describe('subagent row display key', () => {
  test('stays stable across status and timestamp changes', () => {
    const running: AgentTask = { agentId: 'a1', avatarId: 3, description: 'probe', status: 'running' }
    const done: AgentTask = { ...running, status: 'completed', completedAtMs: 9_000 }
    expect(subagentRowDisplayKey('t1', running)).toBe(subagentRowDisplayKey('t1', done))
  })

  test('changes when the identity the row paints changes', () => {
    const task: AgentTask = { agentId: 'a1', avatarId: 3, description: 'probe', status: 'running' }
    expect(subagentRowDisplayKey('t1', task)).not.toBe(subagentRowDisplayKey('t1', { ...task, avatarId: 4 }))
    expect(subagentRowDisplayKey('t1', task)).not.toBe(subagentRowDisplayKey('t1', { ...task, description: 'other' }))
    expect(subagentRowDisplayKey('t1', task)).not.toBe(subagentRowDisplayKey('t2', { ...task, agentId: 'a2' }))
  })
})
