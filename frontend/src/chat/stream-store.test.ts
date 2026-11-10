// stream-store 的「history 层与 live 层永不重叠」约束的单元测试。
//
// 这条约束就是转录不重复的全部依据：屏幕上的内容 = history 层 + live 层直接拼接
// （TranscriptView 先渲染 history 的 units，再渲染 LiveTail 的 liveUnits），渲染
// 层不做任何去重。所以两层各自持有同一条消息时，用户看到的就是同一条画两遍。
//
// 引擎在回合开始时就把 user 消息挂进了线程，回合期间任何一次 session.history 读取
// 都会带回本回合的消息，而本回合同时正由 live 层呈现 —— 每个用例都盯住这个交叠点。
import { describe, expect, test } from 'bun:test'

type Row = { id: string; role: 'user' | 'assistant'; text: string }

const userRow = (text: string): Row => ({ id: `u-${text}`, role: 'user', text })
const assistantRow = (text: string): Row => ({ id: `a-${text}`, role: 'assistant', text })

// session.history IPC 的替身：记录每次调用，返回体由用例现场决定（回合期间引擎
// 已经含本回合消息，用例正是靠这一点复现重复）。
const historyCalls: string[] = []
let respond: (sessionId: string) => Promise<any> = async () => []

;(globalThis as any).window = {
  addEventListener: () => {},
  klaus: {
    session: {
      history: (sessionId: string) => {
        historyCalls.push(sessionId)
        return respond(sessionId)
      },
    },
    agents: {
      history: (sessionId: string) => {
        historyCalls.push(sessionId)
        return respond(sessionId)
      },
      teammateMessages: (sessionId: string) => {
        historyCalls.push(sessionId)
        return respond(sessionId)
      },
    },
  },
}

const store = await import('./stream-store')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const userBubbles = (sessionId: string) =>
  store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-user')

test('later task-call registration coalesces lifecycle identity without changing its owning turn or child stream', () => {
  const sessionId = 'early-child-registration'
  store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'first' })
  store.ingestChatEvent({ type: 'tasks_changed', sessionId, tasks: { child: { agentId: 'child', description: 'Review', status: 'running', avatarId: 48 } } })
  const streamId = store.prepareSubagentStream(sessionId, 'child', store.getSessionStream(sessionId).agentTasks.child)
  store.ingestChatEvent({ type: 'agent_progress', sessionId, agentId: 'child', event: { type: 'stream_mode', mode: 'requesting', turnId: 'child-run' } })
  store.ingestChatEvent({ type: 'agent_progress', sessionId, agentId: 'child', event: { type: 'text_delta', messageId: 'child-text', text: 'Checking', phase: 'commentary' } })
  store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'next' })
  store.ingestChatEvent({ type: 'tasks_changed', sessionId, tasks: { dispatch: { agentId: 'child', description: 'Review', status: 'running' } } })
  const state = store.getSessionStream(sessionId)
  expect(Object.keys(state.agentTasks)).toEqual(['dispatch'])
  expect(state.agentTasks.dispatch.spawnTurnId).toBe('first')
  expect(state.agentTimeline.filter(row => row.status === 'started')).toHaveLength(1)
  expect(store.prepareSubagentStream(sessionId, 'dispatch', state.agentTasks.dispatch)).toBe(streamId)
  expect(store.getSessionStream(streamId).liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'Checking')).toBe(true)
})

describe('unread parent history', () => {
  test('older child activity cannot replace unread history while a later parent turn runs', async () => {
    const sessionId = 'unread-history-child-events'
    const earlier = [
      { ...userRow('original-request'), turnId: 'earlier-parent' },
      { ...assistantRow('earlier-work'), turnId: 'earlier-parent' },
    ]
    const task = { agentId: 'restored-child', description: 'Review files', status: 'running', spawnTurnId: 'earlier-parent' }
    store.seedSubagentTasks(sessionId, { task })
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'current-parent' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'current-parent' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'Current work', messageId: 'current-text', turnId: 'current-parent' })
    store.ingestChatEvent({ type: 'agent_progress', sessionId, agentId: task.agentId,
      event: { type: 'stream_mode', mode: 'requesting', turnId: 'child-run' } })
    store.ingestChatEvent({ type: 'agent_notification', sessionId, agentId: task.agentId,
      notificationId: 'restored-child-completed', source: 'background-task', status: 'completed', turnId: 'earlier-parent' })
    const unread = store.getSessionStream(sessionId)
    expect(unread.history).toBeNull()
    expect(unread.savedTranscript).toBeNull()
    expect(unread.agentTimeline.map(event => event.status)).toEqual(['started', 'completed'])

    respond = async () => ({ messages: [...earlier, { ...userRow('current-request'), turnId: 'current-parent' }] })
    historyCalls.length = 0
    await store.loadSessionHistory(sessionId)
    const loaded = store.getSessionStream(sessionId)
    expect(historyCalls).toEqual([sessionId])
    expect(loaded.history).toEqual(earlier)
    expect(loaded.running).toBe(true)
    expect(loaded.activeTurnId).toBe('current-parent')
    expect(loaded.liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'Current work')).toBe(true)
    expect(loaded.agentTimeline).toEqual(unread.agentTimeline)
  })

  test('child activity still appends to history after its initial read', async () => {
    const sessionId = 'loaded-history-child-events'
    const saved = [{ ...userRow('saved-request'), turnId: 'earlier-parent' }]
    respond = async () => ({ messages: saved })
    await store.loadSessionHistory(sessionId)
    store.seedSubagentTasks(sessionId, { task: { agentId: 'loaded-child', spawnTurnId: 'earlier-parent', status: 'running' } })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'current-parent' })
    store.ingestChatEvent({ type: 'agent_notification', sessionId, agentId: 'loaded-child',
      notificationId: 'loaded-child-completed', source: 'background-task', status: 'completed', turnId: 'earlier-parent' })
    const state = store.getSessionStream(sessionId)
    expect(state.history?.[0]).toEqual(saved[0])
    expect(state.history?.filter(message => message.kind === 'agent-event')).toHaveLength(1)
    expect(state.agentTimeline.map(event => event.status)).toEqual(['completed'])
  })
})

describe('current plan mutation display', () => {
  test('plan mutations keep the turn active without raw cards or empty tool groups', () => {
    const sessionId = 'current-plan-mutations'
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'plan-turn' })
    for (const toolName of ['TaskWrite', 'TaskCreate', 'TaskUpdate']) {
      const toolCallId = `call-${toolName}`
      store.ingestChatEvent({ type: 'tool_start', sessionId, toolName, toolCallId, args: {} })
      store.ingestChatEvent({ type: 'tool_input_delta', sessionId, toolCallId, delta: '{}' })
      store.ingestChatEvent({ type: 'tool_end', sessionId, toolName, toolCallId, isError: false })
    }
    const hidden = store.getSessionStream(sessionId)
    expect(hidden.running).toBe(true)
    expect(hidden.tools).toEqual({})
    expect(hidden.liveUnits.filter(unit => unit.type === 'live-tools')).toEqual([])

    store.ingestChatEvent({ type: 'tool_start', sessionId, toolName: 'Bash', toolCallId: 'visible-shell', args: {} })
    const state = store.getSessionStream(sessionId)
    expect(Object.keys(state.tools)).toEqual(['visible-shell'])
    expect(state.liveUnits.filter(unit => unit.type === 'live-tools').map(unit => unit.order)).toEqual([['visible-shell']])
  })
})
for (const kind of ['permission', 'elicit', 'ask'] as const) {
  test(`a late history load preserves recovered unresolved ${kind} only`, async () => {
    const sessionId = `recovered-${kind}-late-history`
    let finish!: (value: any) => void
    respond = () => new Promise(resolve => { finish = resolve })
    store.ingestLiveApproval(kind, { requestId: 'recover-write', sessionId, toolName: 'write', toolInput: { path: '/project/.klaus/specs/second.md' }, prompt: 'Include examples in the revised Spec?' })
    store.ingestLiveApproval('plan-review', { requestId: 'already-resolved', sessionId, toolName: 'exit_plan_mode' })
    const history = store.loadSessionHistory(sessionId)
    store.resolveLiveApproval(sessionId, 'already-resolved', { decision: 'allow' })
    finish([userRow('Write a second Spec')])
    await history
    const live = store.getSessionStream(sessionId).liveUnits
    expect(live).toHaveLength(1)
    expect(live[0].type).toBe(`live-${kind}`)
    expect('req' in live[0] && live[0].req.requestId).toBe('recover-write')
    expect(store.getSessionStream(sessionId).history).toEqual([userRow('Write a second Spec')])
  })
}

describe('history 层与 live 层不重叠', () => {
  test('a recovered approval keeps its owner when a later turn starts', () => {
    const sessionId = 'recovered-request-stable-owner'
    store.ingestLiveApproval('permission', { sessionId, requestId: 'recovered' })
    const before = store.getSessionStream(sessionId).liveUnits[0]
    store.ingestChatEvent({ sessionId, turnId: 'later-turn', type: 'text_delta', text: 'A later turn', messageId: 'later-message', phase: 'commentary' })
    const after = store.getSessionStream(sessionId).liveUnits.find(unit => unit.key === before.key)
    expect(before.turnId).toBe('request:recovered')
    expect(after).toBe(before)
  })

  test('新会话首条消息只留一个 user 气泡（history 层不抢在回合中途接管）', async () => {
    const sessionId = 'sess-first-send'
    // 引擎侧此刻已经落了本回合的 user 消息：旧实现把它拉进 history 层，于是
    // history 的 user 行 + 本地乐观气泡一起上屏，同一句话出现两个气泡。
    respond = async () => [userRow('你能操作我的电脑吗')]
    historyCalls.length = 0

    store.ingestLocalUserTurn(sessionId, { text: '你能操作我的电脑吗', timestamp: 1_700_000_000_000 })
    // 渲染方挂载时的首次拉取（TranscriptView 的 history === null 分支）。
    await store.loadSessionHistory(sessionId)

    const state = store.getSessionStream(sessionId)
    expect(userBubbles(sessionId).length).toBe(1)
    expect(userBubbles(sessionId)[0]?.type === 'live-user' ? userBubbles(sessionId)[0].msg.timestamp : 0).toBe(1_700_000_000_000)
    expect(state.history).toBeNull()
    expect(historyCalls).toEqual([])
  })

  test('回合中途的 message_complete 重拉不进渲染面，回合结束才整体移交', async () => {
    const sessionId = 'sess-turn-lifecycle'
    respond = async () => [userRow('old-q'), assistantRow('old-a')]
    await store.loadSessionHistory(sessionId)
    expect(store.getSessionStream(sessionId).history).toHaveLength(2)

    store.ingestLocalUserTurn(sessionId, { text: 'new-q' })
    // 引擎已落盘本回合的 user + assistant 消息。
    respond = async () => [userRow('old-q'), assistantRow('old-a'), userRow('new-q'), assistantRow('new-a')]
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'new-a' })
    store.ingestChatEvent({ type: 'message_complete', sessionId })
    await store.loadSessionHistory(sessionId)

    const midTurn = store.getSessionStream(sessionId)
    expect(midTurn.history).toHaveLength(2) // 冻结：本回合没被塞进历史层
    expect(midTurn.historyStale).toBe(true) // stale 留着，等 done 解冻
    expect(userBubbles(sessionId).length).toBe(1)

    // done 必须自己发起重拉：stale 从回合中途就是 true，渲染方的 stale 订阅已经
    // 没有边沿可触发，靠它重拉会永远等不到。
    store.ingestChatEvent({ type: 'done', sessionId })
    await flush()

    const settled = store.getSessionStream(sessionId)
    expect(settled.history).toHaveLength(4)
    expect(settled.liveUnits).toEqual([]) // 移交完成，live 层不再持有本回合
    expect(settled.historyStale).toBe(false)
  })

  test('done 只把明确匹配 finalMessageId 的 live text 标成最终回复', () => {
    const sessionId = 'sess-final-message-id'
    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'process' })
    store.ingestChatEvent({ type: 'message_complete', sessionId, messageId: 'a-process' })
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'call-1', toolName: 'bash', args: {} })
    store.ingestChatEvent({ type: 'tool_end', sessionId, toolCallId: 'call-1', isError: false })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'complete reply' })
    store.ingestChatEvent({ type: 'message_complete', sessionId, messageId: 'a-final' })
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'call-2', toolName: 'bash', args: {} })
    store.ingestChatEvent({ type: 'tool_end', sessionId, toolCallId: 'call-2', isError: false })
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-1', finalMessageId: 'a-final' })

    const texts = store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text')
    expect(texts).toHaveLength(2)
    expect(texts[0]?.type === 'live-text' ? texts[0].turnTail : null).toBeUndefined()
    expect(texts[1]?.type === 'live-text' ? texts[1].turnTail : null).toBeTruthy()
  })

  test('done without finalMessageId leaves tool-preface narration intermediate', () => {
    const sessionId = 'sess-no-final-message'
    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'process' })
    store.ingestChatEvent({ type: 'message_complete', sessionId, messageId: 'a-process' })
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'call-1', toolName: 'bash', args: {} })
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-2' })

    const text = store.getSessionStream(sessionId).liveUnits.find(unit => unit.type === 'live-text')
    expect(text?.type === 'live-text' ? text.turnTail : null).toBeUndefined()
  })

  test('加载横跨新回合开始时，history 应用但乐观气泡不被移交清掉', async () => {
    const sessionId = 'sess-crossing-load'
    let release: (rows: Row[]) => void = () => {}
    respond = () => new Promise<Row[]>(resolve => { release = rows => resolve(rows) })

    // 切进会话时发起加载（还没在跑），用户在它落地前就发了下一条消息。
    const pending = store.loadSessionHistory(sessionId)
    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    release([userRow('older')])
    await pending

    const state = store.getSessionStream(sessionId)
    expect(state.history).toHaveLength(1) // 这份 history 早于本回合，两层无交集
    expect(userBubbles(sessionId).length).toBe(1) // 乐观气泡保住了
  })

  test('live 层为空的在跑会话照常加载 history（客户端重启后接管在跑的会话）', async () => {
    const sessionId = 'sess-adopt-running'
    respond = async () => [userRow('q'), assistantRow('a')]

    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'adopted' })
    expect(store.getSessionStream(sessionId).running).toBe(true)
    await store.loadSessionHistory(sessionId)

    // 空集不与任何东西重叠：这里冻结只会让用户对着空白转录干等。
    expect(store.getSessionStream(sessionId).history).toHaveLength(2)
  })

  test('a teardown-killed Turn recovers from history as stopped, not as a red failure', async () => {
    const sessionId = 'sess-missed-terminal'
    respond = async () => ({
      messages: [{ ...userRow('q'), turnId: 'turn-failed' }],
      turnStatuses: { 'turn-failed': 'failed' },
      turnStartedAtMs: { 'turn-failed': 1_700_000_000_000 },
      turnFinishedAtMs: { 'turn-failed': 1_700_000_001_528 },
      turnDurations: { 'turn-failed': 1528 },
      turnErrors: { 'turn-failed': 'session shutdown closed Setup context admission' },
    })

    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-failed' })
    expect(store.getSessionStream(sessionId).activityVisible).toBe(true)

    await store.reconcileSessionWorking(sessionId, false)

    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(false)
    expect(state.activityVisible).toBe(false)
    expect(state.activeTurnId).toBeNull()
    expect(state.liveUnits).toEqual([])
    // The saved verdict names a shutdown-gate refusal: the session closed under
    // the Turn, so it reads as stopped — the engine-internal string never
    // reaches the transcript as a red error row.
    expect(state.turnStatuses['turn-failed']).toBe('interrupted')
    expect(state.turnErrors['turn-failed']).toBeUndefined()
    expect(state.turnStartedAtMs['turn-failed']).toBe(1_700_000_000_000)
    expect(state.turnFinishedAtMs['turn-failed']).toBe(1_700_000_001_528)
    expect(state.turnDurations['turn-failed']).toBe(1528)
    expect(store.canContinueTurn(sessionId)).toBe(true)
  })

  test('a teardown-killed Turn settles live as stopped with no error card', async () => {
    const sessionId = 'sess-teardown-live'
    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-teardown' })
    store.requestTurnInterrupt(sessionId)
    store.ingestChatEvent({
      type: 'api_error', sessionId, turnId: 'turn-teardown', terminal: true,
      error: 'session shutdown closed Setup context admission',
    })
    await flush()

    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(false)
    expect(state.lastTerminalStatus).toBe('interrupted')
    expect(state.liveUnits.some(unit => unit.type === 'live-error')).toBe(false)
    expect(state.liveUnits.some(unit => unit.type === 'live-turn-status' && unit.turnId === 'turn-teardown')).toBe(true)
  })

  test('a genuine provider failure still settles as failed with its error card', async () => {
    const sessionId = 'sess-real-failure'
    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-real' })
    store.ingestChatEvent({
      type: 'api_error', sessionId, turnId: 'turn-real', terminal: true,
      error: 'provider connection failed',
    })
    // The live error card and the failed verdict exist until the history reload
    // that a failed terminal triggers takes the layer over.
    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(false)
    expect(state.lastTerminalStatus).toBe('failed')
    expect(state.liveUnits.some(unit => unit.type === 'live-error')).toBe(true)
    expect(state.turnErrors['turn-real']).toBe('provider connection failed')
  })

  // An app relaunch for a permission grant SIGKILLs the engine child mid-Turn. The
  // Turn that was running can resume with a status but no transcript row of its own,
  // so the row walk that identifies "the last Turn" lands on the Turn before it.
  test('a restart-killed Turn with no rendered row still offers continue', async () => {
    const sessionId = 'sess-restart-killed-no-row'
    respond = async () => ({
      messages: [
        { ...userRow('q'), turnId: 'turn-done' },
        { ...assistantRow('all finished'), turnId: 'turn-done' },
      ],
      turnStatuses: { 'turn-done': 'completed', 'turn-killed': 'interrupted' },
      turnStartedAtMs: { 'turn-done': 1_700_000_000_000, 'turn-killed': 1_700_000_010_000 },
      // Resume INFERS the killed Turn's status, so it writes no finish time; the
      // completed Turn it followed does have one.
      turnFinishedAtMs: { 'turn-done': 1_700_000_005_000 },
      turnDurations: { 'turn-done': 5_000 },
    })

    await store.loadSessionHistory(sessionId)
    await flush()

    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(false)
    expect(state.turnStatuses['turn-killed']).toBe('interrupted')
    expect(state.history!.filter((row: any) => row.turnId === 'turn-killed')).toHaveLength(0)
    expect(store.canContinueTurn(sessionId)).toBe(true)
  })

  test('a Turn the user rewound past never comes back as a continue offer', async () => {
    const sessionId = 'sess-rewound-past-turn'
    respond = async () => ({
      messages: [
        { ...userRow('q'), turnId: 'turn-kept' },
        { ...assistantRow('kept'), turnId: 'turn-kept' },
      ],
      // The discarded Turn kept its RECORDED terminal status, which carries a
      // finish time. A later start time alone must not resurrect it.
      turnStatuses: { 'turn-kept': 'completed', 'turn-discarded': 'interrupted' },
      turnStartedAtMs: { 'turn-kept': 1_700_000_000_000, 'turn-discarded': 1_700_000_020_000 },
      turnFinishedAtMs: { 'turn-kept': 1_700_000_005_000, 'turn-discarded': 1_700_000_021_000 },
    })

    await store.loadSessionHistory(sessionId)
    await flush()

    expect(store.getSessionStream(sessionId).turnStatuses['turn-discarded']).toBe('interrupted')
    expect(store.canContinueTurn(sessionId)).toBe(false)
  })

  test('a rollout without turn start times stays on the row walk', async () => {
    const sessionId = 'sess-no-start-times'
    respond = async () => ({
      messages: [
        { ...userRow('q'), turnId: 'turn-done' },
        { ...assistantRow('all finished'), turnId: 'turn-done' },
      ],
      turnStatuses: { 'turn-done': 'completed', 'turn-killed': 'interrupted' },
    })

    await store.loadSessionHistory(sessionId)
    await flush()

    // No ordering signal means no way to prove which Turn is newest, so the
    // rendered tail decides and a completed Turn offers nothing.
    expect(store.canContinueTurn(sessionId)).toBe(false)
  })

  test('running history restores only an unfinished tail and preserves terminal evidence', async () => {
    for (const kind of ['unfinished', 'completed', 'finished', 'duration', 'cancelled', 'final', 'idle']) {
      const sessionId = `history-tail-${kind}`
      const messages = [{ ...assistantRow(''), turnId: 'tail', contentBlocks: [{ type: 'tool_use', id: 'read', name: 'read', input: { path: '/file' } }] }]
      respond = async () => ({ messages: kind === 'final' ? [...messages, { ...assistantRow('Final'), turnId: 'tail', isFinalReply: true }] : messages,
        turnStatuses: { tail: kind === 'completed' ? 'completed' : 'interrupted', old: 'interrupted' },
        ...(kind === 'finished' ? { turnFinishedAtMs: { tail: 123 } } : {}),
        ...(kind === 'duration' ? { turnDurations: { tail: 0 } } : {}),
        ...(kind === 'cancelled' ? { turnCancelledTools: { tail: ['read'] } } : {}),
      })
      // Running but unnamed, like the old bare `requesting` frame: the tail's identity is
      // still history's to restore.
      if (kind !== 'idle') store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: null })
      await store.loadSessionHistory(sessionId)
      const state = store.getSessionStream(sessionId)
      expect(state.activeTurnId).toBe(kind === 'unfinished' ? 'tail' : null)
      expect(state.turnStatuses.tail).toBe(kind === 'unfinished' ? undefined : kind === 'completed' ? 'completed' : 'interrupted')
      expect(state.turnStatuses.old).toBe('interrupted')
    }
  })

  test('history-owned tool results settle in place and survive an older in-flight history read', async () => {
    const sessionId = 'history-tool-result-race'
    const pending = { ...assistantRow(''), turnId: 'tail', contentBlocks: [{ type: 'tool_use', id: 'read', name: 'read', input: { path: '/empty' } }] }
    respond = async () => ({ messages: [pending] })
    store.ingestChatEvent({ type: 'requesting', sessionId })
    await store.loadSessionHistory(sessionId)
    let release!: (value: any) => void
    respond = () => new Promise(resolve => { release = resolve })
    const inFlight = store.loadSessionHistory(sessionId)
    store.ingestChatEvent({ type: 'tool_end', sessionId, turnId: 'other', toolCallId: 'read', content: 'wrong turn' })
    expect(store.getSessionStream(sessionId).history?.[0].contentBlocks[0].__result).toBeUndefined()
    store.ingestChatEvent({ type: 'tool_end', sessionId, turnId: 'tail', toolCallId: 'read', content: '', isError: false })
    const settled = store.getSessionStream(sessionId).history!
    expect(settled[0].contentBlocks[0].__result).toEqual({ content: [{ type: 'text', text: '' }], is_error: false })
    expect(pending.contentBlocks[0]).not.toHaveProperty('__result')
    expect(store.getSessionStream(sessionId).liveUnits).toEqual([])
    expect(store.getSessionStream(sessionId).tools).toEqual({})
    // The replacement fetch stays pending so the stale first response cannot
    // momentarily erase the locally observed completion.
    let finishRefresh!: (value: any) => void
    respond = () => new Promise(resolve => { finishRefresh = resolve })
    release({ messages: [pending] })
    await inFlight
    await flush()
    expect(store.getSessionStream(sessionId).history).toBe(settled)
    finishRefresh({ messages: settled })
    await flush()
    expect(store.getSessionStream(sessionId).history?.[0].contentBlocks[0].__result).toEqual(settled[0].contentBlocks[0].__result)
  })

  test('tool completion before the first history reply survives repeated pending snapshots', async () => {
    const sessionId = 'cold-history-result'
    const pending = { ...assistantRow(''), turnId: 'tail', contentBlocks: [
      { type: 'tool_use', id: 'read', name: 'read', input: { path: '/file' } },
      { type: 'tool_use', id: 'image', name: 'read', input: { path: '/image' } },
    ] }
    let release!: (value: any) => void
    respond = () => new Promise(resolve => { release = resolve })
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'tail' })
    const inFlight = store.loadSessionHistory(sessionId)
    store.ingestChatEvent({ type: 'tool_end', sessionId, turnId: 'tail', toolCallId: 'read', content: 'Permission denied', isError: true })
    store.ingestChatEvent({ type: 'tool_end', sessionId, turnId: 'tail', toolCallId: 'image', content: '', media: [{ path: '/image.png', mimeType: 'image/png' }] })
    release({ messages: [pending] })
    await inFlight
    expect(store.getSessionStream(sessionId).history?.[0].contentBlocks[0].__result.is_error).toBe(true)
    expect(store.getSessionStream(sessionId).history?.[0].contentBlocks[1].__result.content[1]).toEqual({ type: 'image', path: '/image.png', mimeType: 'image/png' })
    respond = async () => ({ messages: [pending] })
    await store.loadSessionHistory(sessionId)
    expect(store.getSessionStream(sessionId).history?.[0].contentBlocks[0].__result.is_error).toBe(true)
    expect(store.getSessionStream(sessionId).liveUnits).toEqual([])
    expect(store.getSessionStream(sessionId).tools).toEqual({})
  })

  test('authoritative failed history overrides an older live completion after both lifecycle pushes were missed', async () => {
    const sessionId = 'sess-missed-start-and-terminal'
    respond = async () => ({
      messages: [{ ...userRow('old'), turnId: 'turn-old' }, { ...assistantRow('done'), turnId: 'turn-old' }],
      turnStatuses: { 'turn-old': 'completed' },
    })
    store.ingestLocalUserTurn(sessionId, { text: 'old' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-old' })
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-old' })
    await flush()
    expect(store.getSessionStream(sessionId).lastTerminalStatus).toBe('completed')

    // The webview misses this Turn's start and terminal pushes. The shell's
    // live-turn registry still observes both edges and reconciliation reloads
    // the persisted failed status.
    await store.reconcileSessionWorking(sessionId, true)
    respond = async () => ({
      messages: [
        { ...userRow('old'), turnId: 'turn-old' },
        { ...assistantRow('done'), turnId: 'turn-old' },
        { ...userRow('new'), turnId: 'turn-failed' },
      ],
      turnStatuses: { 'turn-old': 'completed', 'turn-failed': 'failed' },
      turnErrors: { 'turn-failed': 'provider connection failed' },
    })
    await store.reconcileSessionWorking(sessionId, false)

    const recovered = store.getSessionStream(sessionId)
    expect(recovered.lastTerminalStatus).toBe('completed')
    expect(recovered.turnStatuses['turn-failed']).toBe('failed')
    expect(store.canContinueTurn(sessionId)).toBe(true)
  })

  test('interrupted 保留未落盘的 partial：不应用、不移交', async () => {
    const sessionId = 'sess-interrupted'
    respond = async () => [userRow('q')]
    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'partial…' })
    historyCalls.length = 0

    // A stop click records intent but does not impersonate a completed Turn.
    store.requestTurnInterrupt(sessionId)
    expect(store.getSessionStream(sessionId).running).toBe(true)
    expect(store.getSessionStream(sessionId).stopRequestedAt).toBeGreaterThan(0)
    store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'turn-interrupted' }, { userInterrupted: true })
    await flush()

    const state = store.getSessionStream(sessionId)
    expect(historyCalls).toEqual([])
    expect(state.liveUnits.some(unit => unit.type === 'live-text')).toBe(true)
    expect(state.liveUnits.some(unit => unit.type === 'live-turn-status' && unit.turnId === 'turn-interrupted')).toBe(true)
    expect(state.running).toBe(false)
    expect(state.stopRequestedAt).toBeNull()
    expect(userBubbles(sessionId).length).toBe(1)

    // Some drivers emit a legacy bare done after interrupted. It must not take
    // ownership of the partial Turn or erase its Turn-scoped terminal status.
    store.ingestChatEvent({ type: 'done', sessionId })
    await flush()
    const afterLegacyDone = store.getSessionStream(sessionId)
    expect(afterLegacyDone.liveUnits.some(unit => unit.type === 'live-turn-status' && unit.turnId === 'turn-interrupted')).toBe(true)
    expect(historyCalls).toEqual([])

    // The renderer keeps asking for history while it is stale (or never loaded).
    // Applying it here would swap the retained partial for the engine's snapshot,
    // which never contains the unpersisted reply — the transcript would go blank
    // except for the user bubble. This was observed in the desktop window.
    //
    // With history still null the load is no longer skipped outright: a session
    // that was interrupted mid-turn may still have earlier turns the live layer
    // can never show. The read happens, but these rows carry no turnId, so none
    // of them can be attributed to an EARLIER turn and the whole read is
    // discarded rather than applied. The invariant that matters is the one below
    // — the retained partial is untouched — not that the IPC was avoided.
    await store.loadSessionHistory(sessionId)
    const afterStaleLoad = store.getSessionStream(sessionId)
    expect(afterStaleLoad.liveUnits.some(unit => unit.type === 'live-text')).toBe(true)
    expect(afterStaleLoad.history).toBeNull()
    expect(userBubbles(sessionId).length).toBe(1)
  })

  test('运行中的会话也能翻到更早的回合（live 层只持有当前回合）', async () => {
    const sessionId = 'sess-running-earlier-turns'
    // 磁盘/引擎里有三个回合，第三个正在跑。投影行按 history.ts 的规则带 turnId。
    respond = async () => ({
      messages: [
        { ...userRow('q1'), turnId: 'turn-1' },
        { ...assistantRow('a1'), turnId: 'turn-1' },
        { ...userRow('q2'), turnId: 'turn-2' },
        { ...assistantRow('a2'), turnId: 'turn-2' },
        { ...userRow('q3'), turnId: 'turn-3' },
      ],
      turnStatuses: { 'turn-1': 'completed', 'turn-2': 'completed' },
    })

    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'turn-3' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-3' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'working…', turnId: 'turn-3' })
    expect(store.getSessionStream(sessionId).history).toBeNull()

    // 渲染方挂载时的首次拉取（TranscriptView 的 history === null 分支）。
    await store.loadSessionHistory(sessionId)

    const state = store.getSessionStream(sessionId)
    // 早于 live 回合的行进了 history 层：用户从会话开头就能往上翻。
    expect(state.history).toHaveLength(4)
    expect(state.history?.map((row: any) => row.id)).toEqual(['u-q1', 'a-a1', 'u-q2', 'a-a2'])
    // 当前回合仍由 live 层独家持有，两层无交集。
    expect(state.history?.some((row: any) => row.turnId === 'turn-3')).toBe(false)
    expect(state.liveUnits.some(unit => unit.type === 'live-text')).toBe(true)
    expect(state.running).toBe(true)
    expect(state.liveTurnId).toBe('turn-3')
    // 更早回合的状态照用，在跑那个回合的磁盘状态不得盖上来。
    expect(state.turnStatuses['turn-1']).toBe('completed')
    expect(state.turnStatuses['turn-3']).toBeUndefined()

    // history 已经有内容了，冻结期不再重复发注定作废的请求。
    historyCalls.length = 0
    await store.loadSessionHistory(sessionId)
    expect(historyCalls).toEqual([])

    // 回合收口后整体移交：history 拿全五个回合，live 层清空。
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-3' })
    await flush()
    const settled = store.getSessionStream(sessionId)
    expect(settled.history).toHaveLength(5)
    expect(settled.liveUnits).toEqual([])
    expect(settled.historyStale).toBe(false)
  })

  test('中断的 partial 在下一轮结束时才移交给 history', async () => {
    const sessionId = 'sess-interrupted-handoff'
    respond = async () => [userRow('q')]
    historyCalls.length = 0
    store.ingestLocalUserTurn(sessionId, { text: 'q' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'partial…' })
    store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'turn-1' }, { userInterrupted: true })
    await flush()
    expect(store.getSessionStream(sessionId).liveUnits.some(unit => unit.type === 'live-text')).toBe(true)

    // 下一轮开始：中断的那一轮不再由 live 层抢着，回合结束时整体交给 history。
    respond = async () => [userRow('q'), assistantRow('a'), userRow('q2'), assistantRow('a2')]
    store.ingestLocalUserTurn(sessionId, { text: 'q2' })
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-2' })
    await flush()

    const settled = store.getSessionStream(sessionId)
    expect(historyCalls).toEqual([sessionId])
    expect(settled.history).toHaveLength(4)
    expect(settled.liveUnits).toEqual([])
  })
})

describe('Turn collapse overrides', () => {
  test('preserves explicit expanded and collapsed choices as separate states', () => {
    const sessionId = 'sess-collapse-overrides'
    expect(store.getSessionStream(sessionId).turnCollapseOverrides['turn-1']).toBeUndefined()

    store.setTurnCollapsed(sessionId, 'turn-1', false)
    expect(store.getSessionStream(sessionId).turnCollapseOverrides['turn-1']).toBe(false)

    store.setTurnCollapsed(sessionId, 'turn-1', true)
    expect(store.getSessionStream(sessionId).turnCollapseOverrides['turn-1']).toBe(true)
  })
})

describe('Turn activity indicator', () => {
  test('keeps the trailing three-dot pulse visible while a tool runs', () => {
    const sessionId = 'sess-running-tool-activity'
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'tool-use' })
    store.ingestChatEvent({
      type: 'tool_start',
      sessionId,
      toolCallId: 'call-task-output',
      toolName: 'task_output',
      args: { task_id: 'task-1' },
    })

    const state = store.getSessionStream(sessionId)
    expect(state.tools['call-task-output']?.status).toBe('running')
    expect(state.activityVisible).toBe(true)
  })

  test('provider failure stays failed but offers Continue', () => {
    const sessionId = 'sess-provider-failure'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-failed' })
    store.ingestChatEvent({
      type: 'api_error',
      sessionId,
      turnId: 'turn-failed',
      terminal: true,
      error: 'connection refused',
      kind: 'network',
    })

    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(false)
    expect(state.activityVisible).toBe(false)
    expect(state.activeTurnId).toBeNull()
    expect(state.stopRequestedAt).toBeNull()
    expect(state.turnStatuses['turn-failed']).toBe('failed')
    expect(state.lastTerminalStatus).toBe('failed')
    expect(store.canContinueTurn(sessionId)).toBe(true)
  })

  test('a non-terminal operation error does not stop the active Turn', () => {
    const sessionId = 'sess-follow-up-error'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-running' })
    store.ingestChatEvent({ type: 'api_error', sessionId, error: 'follow-up failed' })

    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(true)
    expect(state.activeTurnId).toBe('turn-running')
    expect(store.canContinueTurn(sessionId)).toBe(false)
  })
})


test('missing session snapshots remain stable through unrelated store updates', () => {
  const sessionId = 'goal-first-mount-not-yet-created'
  const before = store.selectSessionStream(store.chatStreamStore.getState(), sessionId)
  const updates: unknown[] = []
  const unsubscribe = store.chatStreamStore.subscribe(state => {
    updates.push(store.selectSessionStream(state, sessionId))
  })
  store.chatStreamStore.setState({ currentSessionId: 'another-session' })
  store.chatStreamStore.setState({ currentSessionId: null })
  unsubscribe()
  expect(updates).toHaveLength(2)
  for (const snapshot of updates) expect(snapshot).toBe(before)
  expect(store.getSessionStream(sessionId).turnStatuses).toBe(before.turnStatuses)
  expect(store.getSessionStream(sessionId).turnCollapseOverrides).toBe(before.turnCollapseOverrides)
})

describe('message phase and disclosure identity', () => {
  test('native commentary and final deltas remain separate before completion', () => {
    const sessionId = 'phase-stream'
    store.ingestLocalUserTurn(sessionId, { text: 'Go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-phase' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'c', phase: 'commentary', text: 'Checking' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'f', phase: 'final_answer', text: 'Done' })
    const texts = store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text')
    expect(texts.map(unit => [unit.messageId, unit.phase, unit.text])).toEqual([['c', 'commentary', 'Checking'], ['f', 'final_answer', 'Done']])
    expect(texts.map(unit => unit.streaming)).toEqual([false, true])
    expect(store.getSessionStream(sessionId).running).toBe(true)
  })
  test('a child notice does not leave prior commentary streaming across a tool or final boundary', () => {
    const sessionId = 'phase-child-notice'
    const send = (event: any) => store.ingestChatEvent({ sessionId, ...event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'parent-turn' })
    send({ type: 'text_delta', messageId: 'comment', phase: 'commentary', text: 'Checking' })
    send({ type: 'tasks_changed', tasks: { reviewer: { agentId: 'reviewer', description: 'Reviewer', status: 'running' } } })
    send({ type: 'tool_start', toolCallId: 'command', toolName: 'exec_command', args: {} })
    expect(store.getSessionStream(sessionId).liveUnits.find(unit => unit.type === 'live-text')).toMatchObject({ streaming: false })
    send({ type: 'tool_end', toolCallId: 'command', content: 'OK' })
    send({ type: 'text_delta', messageId: 'comment-next', phase: 'commentary', text: 'Finishing' })
    send({ type: 'tasks_changed', tasks: { reviewer: { agentId: 'reviewer', description: 'Reviewer', status: 'completed' } } })
    send({ type: 'text_delta', messageId: 'final', phase: 'final_answer', text: 'Done' })
    send({ type: 'done', turnId: 'parent-turn', finalMessageId: 'final' })
    expect(store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text').map(unit => unit.streaming)).toEqual([false, false, false])
  })
  test('terminal settlement preserves turn and tool disclosure keys until history owns the turn', () => {
    const sessionId = 'phase-handoff'
    store.ingestLocalUserTurn(sessionId, { text: 'Go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-handoff' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'f', phase: 'final_answer', text: 'Done' })
    store.setTurnCollapsed(sessionId, 'turn:turn-handoff', false)
    store.setTurnCollapsed(sessionId, 'tool:call-1', false)
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-handoff', finalMessageId: 'f' })
    const state = store.getSessionStream(sessionId)
    expect(state.activeTurnId).toBeNull()
    expect(state.liveTurnId).toBe('turn-handoff')
    expect(state.turnDurations['turn-handoff']).toBeGreaterThanOrEqual(0)
    expect(state.turnCollapseOverrides).toMatchObject({ 'turn:turn-handoff': false, 'tool:call-1': false })
  })
  test('late phase metadata updates the matching message without appending or relabeling later commentary', () => {
    const sessionId = 'phase-late'
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'first', text: 'First' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'second', phase: 'commentary', text: 'Second' })
    store.ingestChatEvent({ type: 'message_complete', sessionId, messageId: 'first', phase: 'final_answer' })
    const texts = store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text')
    expect(texts.map(unit => [unit.messageId, unit.phase])).toEqual([['first', 'final_answer'], ['second', 'commentary']])
  })
})


test('live units retain separate turn identities before history catches up', () => {
  const sessionId = 'delayed-history-turns'
  for (const turnId of ['one', 'two']) {
    store.ingestLocalUserTurn(sessionId, { text: turnId })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId })
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: turnId, phase: 'final_answer', text: turnId })
    store.ingestChatEvent({ type: 'done', sessionId, turnId, finalMessageId: turnId })
  }
  expect(store.getSessionStream(sessionId).liveUnits.map(unit => unit.turnId)).toEqual(['one', 'one', 'two', 'two'])
})

test('one provider message split by tools preserves text order and unique keys', () => {
  const sessionId = 'interleaved-message'
  store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'm', text: 'Before' })
  store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'r', toolName: 'read', args: { path: '/a' } })
  store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'm', text: 'After' })
  store.ingestChatEvent({ type: 'message_complete', sessionId, messageId: 'm' })
  const units = store.getSessionStream(sessionId).liveUnits
  expect(units.map(unit => unit.type)).toEqual(['live-text', 'live-tools', 'live-text'])
  const text = units.filter(unit => unit.type === 'live-text')
  expect(text.map(unit => [unit.key, unit.text])).toEqual([['message:m', 'Before'], ['message:m:segment:1', 'After']])
})


test('an older history response cannot erase a later completed turn', async () => {
  const sessionId = 'history-crosses-complete-turn'
  const releases: Array<(rows: any[]) => void> = []
  respond = () => new Promise(resolve => releases.push(resolve))
  // Saved rows carry turn identity, the shape real history reads have: turn
  // ownership is keyed on turnId, so identity-less rows could never take over
  // the live units of the turn they settle.
  const savedUser = (text: string) => ({ ...userRow(text), uuid: `u-${text}`, turnId: text })
  const savedAssistant = (text: string) => ({ ...assistantRow(text), uuid: `a-${text}`, turnId: text })
  const run = (turnId: string) => {
    store.ingestLocalUserTurn(sessionId, { text: turnId })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId })
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: turnId, text: turnId })
    store.ingestChatEvent({ type: 'done', sessionId, turnId, finalMessageId: turnId })
  }
  run('A')
  run('B')
  expect(releases).toHaveLength(1)
  releases[0]([savedUser('A'), savedAssistant('A')])
  await flush()
  // The first read was issued before turn B streamed, so its response is
  // invalidated wholesale — the live layer advanced while the read was in
  // flight — and every live unit survives untouched. The older response
  // cannot erase the later completed turn.
  expect(store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text').map(unit => unit.text)).toEqual(['A', 'B'])
  expect(releases).toHaveLength(2)
  releases[1]([savedUser('A'), savedAssistant('A'), savedUser('B'), savedAssistant('B')])
  await flush()
  // The covering follow-up takes over both turns: saved rows own their turn's
  // live units by turnId, so the handoff leaves nothing to render twice.
  expect(store.getSessionStream(sessionId).liveUnits).toHaveLength(0)
  expect(store.getSessionStream(sessionId).history).toHaveLength(4)
})

describe('inference snapshots and model publication', () => {
  test('preparing and ready do not start a turn or rewrite an already captured request', () => {
    const sessionId = 'model-update-idle'
    const update = { type: 'model_update', sessionId, changeId: 'change-B', preferenceRevision: 2 }
    store.ingestChatEvent({ ...update, status: 'preparing' })
    expect(store.getSessionStream(sessionId).running).toBe(false)
    expect(store.getSessionStream(sessionId).liveUnits).toEqual([])
    const inferenceA = { revision: 1, changeId: 'change-A', model: 'same-model', source: 'custom' }
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'model-turn', inference: inferenceA })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'A text', messageId: 'model-message-A' })
    store.ingestChatEvent({ ...update, status: 'ready', revision: 2 })
    const state = store.getSessionStream(sessionId)
    expect(state.currentInference).toEqual(inferenceA)
    expect(state.liveUnits.find(unit => unit.type === 'live-text')?.inference).toEqual(inferenceA)
    expect(state.modelUpdate?.status).toBe('ready')
  })

  test('the next request in the same turn captures B while old text and tools retain A', () => {
    const sessionId = 'model-update-next-request'
    const inferenceA = { revision: 1, changeId: 'change-A', model: 'same-model', source: 'custom' }
    const inferenceB = { revision: 2, changeId: 'change-B', model: 'same-model', source: 'codex' }
    const send = (event: any) => store.ingestChatEvent({ sessionId, ...event })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'model-turn', inference: inferenceA })
    send({ type: 'text_delta', text: 'A', messageId: 'same-message' })
    send({ type: 'tool_start', toolName: 'Bash', toolCallId: 'model-tool', args: {} })
    send({ type: 'model_update', status: 'ready', changeId: 'change-B', preferenceRevision: 2, revision: 2 })
    send({ type: 'stream_mode', mode: 'requesting', turnId: 'model-turn', inference: inferenceB })
    send({ type: 'text_delta', text: 'B', messageId: 'same-message' })
    const state = store.getSessionStream(sessionId)
    expect(state.currentInference).toEqual(inferenceB)
    expect(state.activeTurnId).toBe('model-turn')
    expect(state.tools['model-tool'].inference).toEqual(inferenceA)
    expect(state.liveUnits.filter(unit => unit.type === 'live-text').map(unit => [unit.text, unit.inference]))
      .toEqual([['A', inferenceA], ['B', inferenceB]])
  })

  test('a legacy requesting boundary does not inherit the previous request model', () => {
    const sessionId = 'model-update-legacy'
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', inference: { revision: 1, model: 'A' } })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'unknown request' })
    expect(store.getSessionStream(sessionId).currentInference).toBeNull()
    expect(store.getSessionStream(sessionId).liveUnits.find(unit => unit.type === 'live-text')?.inference).toBeUndefined()
  })

  test('off-screen update failures are session-scoped and survive stop', () => {
    const sessionId = 'model-update-offscreen'
    const update = { type: 'model_update', sessionId, changeId: 'change-B', preferenceRevision: 2 }
    store.ingestChatEvent({ ...update, status: 'preparing' })
    store.ingestChatEvent({ ...update, status: 'failed', error: 'provider unavailable' })
    store.ingestChatEvent({ type: 'interrupted', sessionId })
    expect(store.getSessionStream(sessionId).modelUpdate?.error).toBe('provider unavailable')
    expect(store.getSessionStream('model-update-unrelated').modelUpdate).toBeNull()
    expect(store.getSessionStream(sessionId).running).toBe(false)
  })

  test('a quiet sign-out failure keeps its marker in the session stream', () => {
    const sessionId = 'model-update-quiet'
    store.ingestChatEvent({ type: 'model_update', sessionId, status: 'failed', changeId: 'change-B', preferenceRevision: 2, error: 'signed out', quiet: true })
    const state = store.getSessionStream(sessionId)
    expect(state.modelUpdate?.status).toBe('failed')
    expect(state.modelUpdate?.quiet).toBe(true)
  })

  test('request completion clears current attribution but not the next-config failure', () => {
    const sessionId = 'model-update-terminal'
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'model-turn', inference: { revision: 1, model: 'A' } })
    store.ingestChatEvent({ type: 'model_update', sessionId, status: 'failed', changeId: 'change-B', preferenceRevision: 2, error: 'prepare timed out' })
    store.ingestChatEvent({ type: 'api_error', sessionId, terminal: true, turnId: 'model-turn', error: 'request failed' })
    expect(store.getSessionStream(sessionId).currentInference).toBeNull()
    expect(store.getSessionStream(sessionId).modelUpdate?.error).toBe('prepare timed out')
  })
})

describe('engine status badge convergence', () => {
  test('reconnecting and error both yield to ok only when a real recovery event arrives', () => {
    store.ingestEngineStatus({ status: 'reconnecting' })
    expect(store.chatStreamStore.getState().engineStatus).toBe('reconnecting')
    store.ingestEngineStatus({ status: 'ok' })
    expect(store.chatStreamStore.getState().engineStatus).toBe('ok')
    store.ingestEngineStatus({ status: 'error' })
    expect(store.chatStreamStore.getState().engineStatus).toBe('error')
    store.ingestEngineStatus({ status: 'ok' })
    expect(store.chatStreamStore.getState().engineStatus).toBe('ok')
  })

  test('an unknown payload falls back to ok instead of latching a stale state', () => {
    store.ingestEngineStatus({ status: 'error' })
    store.ingestEngineStatus({})
    expect(store.chatStreamStore.getState().engineStatus).toBe('ok')
  })
})

describe('subagent handoff keeps sealed live content when disk is empty', () => {
  test('an empty child history read preserves the sealed live transcript', async () => {
    const parent = 'sess-child-handoff'
    const streamId = store.prepareSubagentStream(parent, 'task-1', { agentId: 'agent-1', status: 'running' })
    store.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId: 'agent-1', event: { type: 'text_delta', text: 'child work' } })
    // The child's sidechain never reached disk: the endpoint answers empty.
    // Set BEFORE the terminal event so the handoff read it triggers sees it.
    respond = async () => ({ messages: [] })
    store.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId: 'agent-1', event: { type: 'done', terminal: true } })
    await flush()

    const state = store.getSessionStream(streamId)
    expect(state.running).toBe(false)
    expect(state.history).toEqual([])
    // The sealed live layer survives the handoff instead of being cleared.
    expect(state.liveUnits.length).toBeGreaterThan(0)
    expect(state.historyStale).toBe(false)
    expect(state.historyLoading).toBe(false)
    expect(state.liveUnits.find(unit => unit.type === 'live-text')).toMatchObject({ phase: 'final_answer', turnTail: { meta: null } })
  })

  test('a non-empty child history read still takes ownership from the live layer', async () => {
    const parent = 'sess-child-handoff-disk'
    const streamId = store.prepareSubagentStream(parent, 'task-2', { agentId: 'agent-2', status: 'running' })
    store.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId: 'agent-2', event: { type: 'text_delta', delta: 'child work' } })
    respond = async () => ({ messages: [assistantRow('from disk')] })
    store.ingestChatEvent({ type: 'agent_progress', sessionId: parent, agentId: 'agent-2', event: { type: 'done', terminal: true } })
    await flush()

    const state = store.getSessionStream(streamId)
    expect(state.history).toHaveLength(1)
    expect(state.liveUnits).toEqual([])
  })
})

describe('history read failure flag (Codex historyLoadFailed semantics)', () => {
  test('a rejected session.history read raises the flag and the next attempt clears it', async () => {
    const sessionId = 'sess-history-failure'
    respond = () => Promise.reject(new Error('simulated read failure'))
    await store.loadSessionHistory(sessionId)
    expect(store.getSessionStream(sessionId).historyLoadFailed).toBe(true)
    expect(store.getSessionStream(sessionId).historyLoading).toBe(false)

    respond = async () => [userRow('back-online'), assistantRow('recovered')]
    await store.loadSessionHistory(sessionId)
    const state = store.getSessionStream(sessionId)
    expect(state.historyLoadFailed).toBe(false)
    expect(state.history).toHaveLength(2)
  })
})

describe('retractLocalUserTurn (worktree-init send rollback)', () => {
  test('retraction removes the optimistic bubble and clears the running flag', () => {
    const sessionId = 'sess-retract-optimistic'
    store.ingestLocalUserTurn(sessionId, { text: 'first message' })
    expect(store.getSessionStream(sessionId).running).toBe(true)
    expect(userBubbles(sessionId)).toHaveLength(1)

    store.retractLocalUserTurn(sessionId)
    const state = store.getSessionStream(sessionId)
    expect(userBubbles(sessionId)).toHaveLength(0)
    expect(state.running).toBe(false)
    expect(state.activityVisible).toBe(false)
  })

  test('retraction keeps engine-contributed units and their running state', () => {
    const sessionId = 'sess-retract-keeps-engine-units'
    store.ingestLocalUserTurn(sessionId, { text: 'first message' })
    store.ingestChatEvent({ type: 'notice', sessionId, content: 'engine notice' })
    expect(store.getSessionStream(sessionId).liveUnits).toHaveLength(2)

    store.retractLocalUserTurn(sessionId)
    const state = store.getSessionStream(sessionId)
    expect(userBubbles(sessionId)).toHaveLength(0)
    expect(state.liveUnits.map(unit => unit.type)).toEqual(['live-notice'])
    expect(state.running).toBe(true)
  })

  test('retracting a session without an optimistic bubble is a no-op', () => {
    const sessionId = 'sess-retract-noop'
    store.ingestChatEvent({ type: 'notice', sessionId, content: 'only engine content' })
    const before = store.getSessionStream(sessionId)
    store.retractLocalUserTurn(sessionId)
    const after = store.getSessionStream(sessionId)
    expect(after.liveUnits).toEqual(before.liveUnits)
    expect(after.running).toBe(before.running)
  })
})


test('optimistic user messages preserve the authored document for replay and edit', () => {
  const sessionId = 'authored-document-preservation'
  const snapshot = { version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'strong' }] }] }] } }
  store.ingestLocalUserTurn(sessionId, { text: '**bold**', displayText: '**bold**', composerDocument: snapshot })
  const row = userBubbles(sessionId).at(-1) as any
  expect(JSON.parse(JSON.stringify(row.msg.localRender)).composerDocument).toEqual(snapshot)
})

describe('pending user submission ownership', () => {
  test('a provisional submit displays immediately and resists startup idle until its real turn adopts the acceptance clock', async () => {
    const sessionId = 'pending-startup-clock'
    const beforeCalls = historyCalls.length
    const previousNow = Date.now
    let now = 10_000
    Date.now = () => now
    try {
      store.beginPendingUserTurn(sessionId, { text: 'Start this work', uuid: 'pending-startup', timestamp: now }, { provisional: true })
      const initial = store.getSessionStream(sessionId)
      expect(initial.provisional).toBe(true)
      expect(initial.history).toEqual([])
      expect(initial.running).toBe(true)
      expect(initial.activityVisible).toBe(true)
      expect(userBubbles(sessionId)[0].msg.timestamp).toBe(10_000)
      await store.loadSessionHistory(sessionId, { reconcile: true })
      now = 12_000
      store.ingestEngineStatus({ status: 'ok' })
      store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'idle' })
      await store.reconcileSessionWorking(sessionId, false)
      store.finishPendingUserTurn(sessionId, 'pending-startup', 'accepted')
      store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'idle' })
      expect(store.getSessionStream(sessionId).running).toBe(true)
      expect(store.getSessionStream(sessionId).turnStartedAt).toBe(10_000)
      expect(historyCalls.length).toBe(beforeCalls)
      now = 15_000
      store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'real-startup-turn' })
      now = 16_000
      store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'real-startup-turn' })
      expect(store.getSessionStream(sessionId).turnStartedAt).toBe(10_000)
      expect(store.getSessionStream(sessionId).turnWorkStartedAtMs['real-startup-turn']).toBe(10_000)
      expect(userBubbles(sessionId)[0].pendingUserTurn).toBeUndefined()
    } finally { Date.now = previousNow }
  })

  test('promotion transfers one stable row while preserving authoritative events that raced the session reply', () => {
    const sourceId = 'pending-transfer-preview', targetId = 'pending-transfer-real'
    store.beginPendingUserTurn(sourceId, { text: 'Write the report', uuid: 'transfer-input', timestamp: 1_000 }, { provisional: true })
    const preview = userBubbles(sourceId)[0]
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId: targetId, status: 'active', turnId: 'transfer-turn' })
    store.ingestChatEvent({ type: 'text_delta', sessionId: targetId, messageId: 'early-output', text: 'I have started.' })
    store.movePendingUserTurn(sourceId, targetId, 'transfer-input')
    const actual = store.getSessionStream(targetId)
    expect(store.chatStreamStore.getState().sessions[sourceId]).toBeUndefined()
    expect(actual.provisional).toBe(false)
    expect(userBubbles(targetId)[0].key).toBe(preview.key)
    expect(userBubbles(targetId)[0].msg.timestamp).toBe(1_000)
    expect(actual.liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'I have started.')).toBe(true)
    expect(actual.activeTurnId).toBe('transfer-turn')
    expect(actual.turnStartedAt).toBe(1_000)
    expect(actual.turnWorkStartedAtMs['transfer-turn']).toBe(1_000)
    store.finishPendingUserTurn(targetId, 'transfer-input', 'accepted')
    expect(store.getSessionStream(targetId).activeTurnId).toBe('transfer-turn')
  })

  test('a delayed ordinary promotion keeps idle reconciliation from erasing the pending message', async () => {
    const sourceId = 'pending-delayed-preview', targetId = 'pending-delayed-real'
    const beforeCalls = historyCalls.length
    store.beginPendingUserTurn(sourceId, { text: 'Create a game', uuid: 'delayed-input', timestamp: 2_000 }, { provisional: true })
    store.movePendingUserTurn(sourceId, targetId, 'delayed-input')
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId: targetId, status: 'idle' })
    await store.reconcileSessionWorking(targetId, false)
    await store.loadSessionHistory(targetId)
    expect(store.getSessionStream(targetId).running).toBe(true)
    expect(store.getSessionStream(targetId).turnStartedAt).toBe(2_000)
    expect(userBubbles(targetId)).toHaveLength(1)
    expect(historyCalls.length).toBe(beforeCalls)
    store.finishPendingUserTurn(targetId, 'delayed-input', 'cancelled')
    expect(store.getSessionStream(targetId).running).toBe(false)
  })

  test('a goal receipt reconciles an early authoritative echo and cancellation removes only the owned row', () => {
    const sessionId = 'pending-goal-echo'
    store.ingestChatEvent({ type: 'user_message', sessionId, turnId: 'previous-turn', message: { uuid: 'previous-input', message: { content: 'Earlier question' } } })
    store.beginPendingUserTurn(sessionId, { text: 'Full objective', displayText: 'Full objective', uuid: 'goal-preview', timestamp: 3_000 })
    const optimistic = userBubbles(sessionId).find(unit => unit.msg.uuid === 'goal-preview')!
    store.ingestChatEvent({ type: 'user_message', sessionId, message: { uuid: 'goal-user-receipt', message: { content: 'Full objective' } } })
    store.bindPendingUserTurn(sessionId, 'goal-preview', 'goal-user-receipt')
    const reconciled = userBubbles(sessionId)
    expect(reconciled).toHaveLength(2)
    const objective = reconciled.find(unit => unit.msg.uuid === 'goal-user-receipt')!
    expect(objective.key).toBe(optimistic.key)
    expect(objective.msg.timestamp).toBe(3_000)
    expect(objective.msg.localRender.displayText).toBe('Full objective')
    store.ingestChatEvent({ type: 'user_message', sessionId, message: { uuid: 'goal-user-receipt', message: { content: 'Full objective' } } })
    expect(userBubbles(sessionId)).toHaveLength(2)
    store.finishPendingUserTurn(sessionId, 'goal-preview', 'cancelled')
    expect(userBubbles(sessionId).map(unit => unit.msg.uuid)).toEqual(['previous-input'])
    expect(store.getSessionStream(sessionId).running).toBe(false)
  })

  test('a failed provisional submit retains exact input and a reviewable error without querying a fake host identity', async () => {
    const sessionId = 'pending-failed-preview'
    const beforeCalls = historyCalls.length
    store.beginPendingUserTurn(sessionId, { text: 'Keep the failed request', uuid: 'failed-input', timestamp: 4_000 }, { provisional: true })
    store.finishPendingUserTurn(sessionId, 'failed-input', 'failed', 'The session could not start')
    const failed = store.getSessionStream(sessionId)
    expect(failed.running).toBe(false)
    expect(failed.activityVisible).toBe(false)
    expect(userBubbles(sessionId).map(unit => unit.msg.text)).toEqual(['Keep the failed request'])
    expect(failed.liveUnits.some(unit => unit.type === 'live-error' && unit.text === 'The session could not start')).toBe(true)
    await store.loadSessionHistory(sessionId, { reconcile: true })
    expect(historyCalls.length).toBe(beforeCalls)
  })

  test('a pending follow-up preserves an already running turn and its clock on failure or cancellation', () => {
    const sessionId = 'pending-running-followup'
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'existing-turn' })
    const initial = store.getSessionStream(sessionId)
    store.beginPendingUserTurn(sessionId, { text: 'An additional request', uuid: 'running-extra', timestamp: initial.turnStartedAt + 9_000 })
    expect(store.getSessionStream(sessionId).turnStartedAt).toBe(initial.turnStartedAt)
    store.finishPendingUserTurn(sessionId, 'running-extra', 'failed', 'Could not apply this request')
    expect(store.getSessionStream(sessionId).running).toBe(true)
    expect(store.getSessionStream(sessionId).activeTurnId).toBe('existing-turn')
    expect(store.getSessionStream(sessionId).turnStartedAt).toBe(initial.turnStartedAt)
    store.beginPendingUserTurn(sessionId, { text: 'Cancel this additional request', uuid: 'running-cancel' })
    store.finishPendingUserTurn(sessionId, 'running-cancel', 'cancelled')
    expect(store.getSessionStream(sessionId).running).toBe(true)
    expect(userBubbles(sessionId).map(unit => unit.msg.uuid)).toEqual(['running-extra'])
  })

  test('first final text records its arrival once and a late send reply cannot restart a completed turn', () => {
    const sessionId = 'pending-final-clock'
    const previousNow = Date.now
    const previousRespond = respond
    let now = 20_000
    Date.now = () => now
    respond = async () => []
    try {
      store.beginPendingUserTurn(sessionId, { text: 'Answer this', uuid: 'final-input', timestamp: now })
      now = 22_000
      store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'final-turn' })
      now = 24_000
      store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'commentary-message', text: 'Working', phase: 'commentary' })
      now = 27_000
      store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'answer-message', text: 'The answer', phase: 'final_answer' })
      now = 29_000
      store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'answer-message', text: ' is ready.', phase: 'final_answer' })
      const texts = store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text')
      expect(texts.map(unit => unit.startedAtMs)).toEqual([24_000, 27_000])
      expect(store.getSessionStream(sessionId).turnWorkStartedAtMs['final-turn']).toBe(20_000)
      now = 30_000
      store.ingestChatEvent({ type: 'done', sessionId, turnId: 'final-turn', finalMessageId: 'answer-message' })
      store.finishPendingUserTurn(sessionId, 'final-input', 'accepted')
      const settled = store.getSessionStream(sessionId)
      expect(settled.running).toBe(false)
      expect(settled.activeTurnId).toBeNull()
      expect(settled.lastTerminalStatus).toBe('completed')
      expect(settled.turnDurations['final-turn']).toBe(10_000)
      expect(settled.turnWorkCompletedAtMs['final-turn']).toBe(27_000)
      const answer = settled.liveUnits.find(unit => unit.type === 'live-text' && unit.messageId === 'answer-message')
      expect(answer?.type === 'live-text' && answer.startedAtMs).toBe(27_000)
    } finally { Date.now = previousNow; respond = previousRespond }
  })
})

test('local work clocks survive authoritative history timing and late final-phase metadata', async () => {
  const sessionId = 'pending-history-work-clock'
  const previousNow = Date.now, previousRespond = respond
  let now = 40_000
  Date.now = () => now
  respond = async () => ({ messages: [
    { role: 'user', uuid: 'history-clock-input', turnId: 'history-clock-turn', text: 'Answer this' },
    { role: 'assistant', uuid: 'history-clock-answer', turnId: 'history-clock-turn', text: 'Answer', isFinalReply: true },
  ], turnStartedAtMs: { 'history-clock-turn': 42_000 }, turnFinishedAtMs: { 'history-clock-turn': 49_000 }, turnDurations: { 'history-clock-turn': 7_000 } })
  try {
    store.beginPendingUserTurn(sessionId, { text: 'Answer this', uuid: 'history-clock-input', timestamp: now })
    now = 42_000
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'history-clock-turn' })
    store.finishPendingUserTurn(sessionId, 'history-clock-input', 'accepted')
    now = 45_000
    store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'history-clock-answer', text: 'Answer' })
    now = 47_000
    store.ingestChatEvent({ type: 'message_complete', sessionId, messageId: 'history-clock-answer', phase: 'final_answer' })
    expect(store.getSessionStream(sessionId).turnWorkCompletedAtMs['history-clock-turn']).toBe(45_000)
    now = 49_000
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'history-clock-turn', finalMessageId: 'history-clock-answer' })
    await store.loadSessionHistory(sessionId)
    const settled = store.getSessionStream(sessionId)
    expect(settled.turnStartedAtMs['history-clock-turn']).toBe(42_000)
    expect(settled.turnDurations['history-clock-turn']).toBe(7_000)
    expect(settled.turnWorkStartedAtMs['history-clock-turn']).toBe(40_000)
    expect(settled.turnWorkCompletedAtMs['history-clock-turn']).toBe(45_000)
    expect(settled.liveUnits).toEqual([])
  } finally { Date.now = previousNow; respond = previousRespond }
})

test('the observed turn order outlives the live units history takes over', () => {
  const sessionId = 'turn-sequence-ledger'
  store.ingestLocalUserTurn(sessionId, { text: 'first', uuid: 'ledger-user-1' })
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'ledger-stopped' })
  store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'ledger-stopped' }, { userInterrupted: true })
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'ledger-continued' })
  expect(store.getSessionStream(sessionId).turnSequence).toEqual(['ledger-stopped', 'ledger-continued'])
  // History owns the continuation and its live units are dropped; the captured
  // order still anchors the stopped turn above it.
  store.chatStreamStore.setState(current => ({
    sessions: { ...current.sessions, [sessionId]: { ...current.sessions[sessionId], liveUnits: [] } },
  }))
  expect(store.getSessionStream(sessionId).liveUnits).toEqual([])
  expect(store.getSessionStream(sessionId).turnSequence).toEqual(['ledger-stopped', 'ledger-continued'])
})

test('reviving a tombstoned stream resumes ingestion for a session that is still alive', () => {
  const sessionId = 'revive-after-retire'
  store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'm1', text: 'before' })
  store.retireSessionStream(sessionId)
  expect(store.isSessionStreamRetired(sessionId)).toBe(true)
  store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'm2', text: 'dropped' })
  expect(store.getSessionStream(sessionId).liveUnits).toHaveLength(0)
  expect(store.reviveSessionStream(sessionId)).toBe(true)
  expect(store.reviveSessionStream(sessionId)).toBe(false)
  store.ingestChatEvent({ type: 'text_delta', sessionId, messageId: 'm3', text: 'after' })
  const texts = store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text').map(unit => unit.text)
  expect(texts).toEqual(['after'])
})
