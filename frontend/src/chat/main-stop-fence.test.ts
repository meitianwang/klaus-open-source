import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { GoalInteractionClock } from './goals/draft-review'
import { noticeI18nKey } from './notice-codes'

;(globalThis as any).window = {
  addEventListener() {}, currentLang: 'en', klaus: { session: { history: async () => [] } },
}
const store = await import('./stream-store')
const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const handlers = ['requestTurnStop', 'handleChatEvent', 'foreignTerminalTurn'].map(name => {
  const handler = ast.statements.find(node => isFunctionDeclaration(node) && node.name?.text === name)
  if (!handler) throw new Error(`The ${name} handler is missing`)
  return handler.getText(ast)
})
const code = transpileModule(`${handlers.join('\n')}\n({ stop: requestTurnStop, receive: handleChatEvent });`,
  { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
let sequence = 0
function fixture(turnId: string | null = 'captured-turn') {
  const sessionId = `main-stop-fence-${++sequence}`
  store.ingestLocalUserTurn(sessionId, { text: 'Original user message' })
  if (turnId) store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId })
  const reply = deferred<any>()
  const calls: unknown[][] = [], toasts: string[] = []
  const stopping = new Set<string>(), interrupted = new Set<string>()
  const queued = Object.freeze({ id: 'queued-draft', text: 'Keep this queued message', state: 'paused' })
  const queue = Object.freeze({ revision: 7, rows: Object.freeze([queued]) })
  const pending = Object.freeze({ sessionId, id: 'pending-add', item: Object.freeze({ text: 'Keep this pending message' }) })
  const clientQueueBySession = new Map([[sessionId, queue]])
  const pendingQueueAdditions = new Map([['pending-add', pending]])
  const continueArmUntil = new Map<string, number>(), timers: (() => void)[] = []
  const terminalEffects: string[] = [], unread: string[] = []
  let renders = 0, clears = 0
  const context = {
    Error, stopPendingComposerSubmission: () => false, stopPendingFriendTask: () => false,
    creatingGoalSessions: new Set(), stoppingSessions: stopping, userInterruptedSessions: interrupted,
    goalInteractions: new GoalInteractionClock(), clearStopEscArm() {}, getSessionStream: store.getSessionStream,
    // Main-conversation fences never resolve a side runtime; the stop path only
    // consults it to route side-surface effects.
    sideRuntimeForSession: () => undefined,
    requestTurnInterrupt: store.requestTurnInterrupt,
    clearTurnInterruptRequest(id: string) { clears++; store.clearTurnInterruptRequest(id) },
    updateSendBtn() { renders++ }, showToast(message: string) { toasts.push(message) }, noticeI18nKey,
    clientQueueBySession, pendingQueueAdditions,
    window: { currentSessionId: sessionId, setTimeout(callback: () => void) { timers.push(callback) } },
    isSessionStreamRetired: () => false, isRunActivityEvent: () => false,
    isStoppedTurnFrame: store.isStoppedTurnFrame,
    continueArmUntil, CONTINUE_ARM_DELAY_MS: 700,
    ingestChatFrameEvent: store.ingestChatFrameEvent, specDocuments: { onEvent() {} },
    dropLiveTaskPending() {}, forgetLocallySentSteers() {}, stopEscArmedTurn: null,
    refreshTasksForSession: async () => {},
    refreshContextStatsThrottled() { terminalEffects.push('context') },
    scheduleWorkspaceReload() { terminalEffects.push('files') },
    inputEl: {}, focusComposerAfterTurn() { terminalEffects.push('focus') },
    updateSessionInList: async () => { terminalEffects.push('sessions') },
    isCronRunSession: () => false, surfacesBySession: new Map(),
    composerPredictions: undefined, markSidebarSessionCompleted(id: string) { unread.push(id) },
    klausApi: { chat: { interrupt(...args: unknown[]) {
      calls.push(args)
      if (calls.length === 1) return reply.promise
      // An unfenced retry would stop whatever turn won the race.
      const current = store.getSessionStream(sessionId).activeTurnId
      store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: current }, { userInterrupted: true })
      return Promise.resolve({ accepted: true, confirmed: true, interruptedTurnId: current })
    } } },
  }
  const { stop, receive } = runInNewContext(code, context) as {
    stop(sessionId: string): void
    receive(event: Record<string, unknown>): void
  }
  return {
    sessionId, stop, receive, reply, calls, toasts, stopping, interrupted, continueArmUntil, timers, terminalEffects, unread,
    state: () => store.getSessionStream(sessionId), renders: () => renders, clears: () => clears,
    expectQueueIntact() {
      expect(clientQueueBySession.get(sessionId)).toBe(queue)
      expect(clientQueueBySession.get(sessionId)?.rows[0]).toBe(queued)
      expect(pendingQueueAdditions.get('pending-add')).toBe(pending)
      expect(pendingQueueAdditions.size).toBe(1)
    },
  }
}

test('a terminal provider failure marks its owning session unread without counting transient or foreign errors', () => {
  const f = fixture()
  f.receive({ type: 'api_error', sessionId: f.sessionId, turnId: 'captured-turn', terminal: false, error: 'Retrying' })
  f.receive({ type: 'api_error', sessionId: f.sessionId, turnId: 'foreign-turn', terminal: true, error: 'Old failure' })
  expect(f.unread).toEqual([])
  f.receive({ type: 'api_error', sessionId: f.sessionId, turnId: 'captured-turn', terminal: true, kind: 'rate_limit', error: 'Rate limit reached' })
  expect(f.unread).toEqual([f.sessionId])
  const stopped = fixture()
  stopped.receive({ type: 'interrupted', sessionId: stopped.sessionId, turnId: 'captured-turn' })
  expect(stopped.unread).toEqual([])
})

for (const confirmed of [true, undefined]) test(`main Stop never retargets a replacement after a refused captured fence, confirmed=${confirmed}`, async () => {
  const f = fixture()
  f.stop(f.sessionId)
  expect(f.calls).toEqual([[f.sessionId, 'captured-turn']])
  expect(f.state().stopRequestedAt).not.toBeNull()
  f.stop(f.sessionId)
  expect(f.calls).toHaveLength(1)
  store.ingestLocalUserTurn(f.sessionId, { text: 'A real replacement user message' })
  store.ingestChatEvent({ type: 'stream_mode', sessionId: f.sessionId, mode: 'requesting', turnId: 'replacement-turn' })
  store.ingestChatEvent({ type: 'text_delta', sessionId: f.sessionId, text: 'Replacement output' })
  f.reply.resolve({ accepted: false, confirmed, interruptedTurnId: null })
  await flush()
  expect(f.calls).toEqual([[f.sessionId, 'captured-turn']])
  expect(f.state().activeTurnId).toBe('replacement-turn')
  expect(f.state().running).toBe(true)
  expect(f.state().turnStatuses['replacement-turn']).toBeUndefined()
  expect(f.state().liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'Replacement output' && unit.streaming)).toBe(true)
  expect(f.stopping.has(f.sessionId)).toBe(false)
  expect(f.interrupted.has(f.sessionId)).toBe(false)
  expect(f.state().stopRequestedAt).toBeNull()
  expect(f.clears()).toBe(1)
  expect(f.renders()).toBe(2)
  expect(f.toasts).toEqual([])
  f.expectQueueIntact()
})

test('a refused Stop without an initial turn identity makes only its original request and retracts local intent', async () => {
  const f = fixture(null)
  const captured = f.state().activeTurnId
  expect(captured).toBeNull()
  f.stop(f.sessionId)
  f.reply.resolve({ accepted: false, confirmed: true, interruptedTurnId: null })
  await flush()
  expect(f.calls).toEqual([[f.sessionId, captured]])
  expect(f.stopping.has(f.sessionId)).toBe(false)
  expect(f.interrupted.has(f.sessionId)).toBe(false)
  expect(f.state().stopRequestedAt).toBeNull()
  expect(f.state().running).toBe(true)
  f.expectQueueIntact()
})

test('a refused Stop restores provisional tool failures without ending the captured turn or deleting queued drafts', async () => {
  const f = fixture()
  store.ingestChatEvent({ type: 'tool_start', sessionId: f.sessionId, toolCallId: 'tool', toolName: 'bash', args: { command: 'false' } })
  f.stop(f.sessionId)
  store.ingestChatEvent({ type: 'tool_end', sessionId: f.sessionId, toolCallId: 'tool', isError: true, content: 'Independent tool failure' })
  expect(f.state().tools.tool.status).toBe('interrupted')
  f.reply.resolve({ accepted: false, confirmed: true, interruptedTurnId: null })
  await flush()
  expect(f.calls).toEqual([[f.sessionId, 'captured-turn']])
  expect(f.state().tools.tool.status).toBe('error')
  expect(f.state().tools.tool.stopWindowFailure).toBeUndefined()
  expect(f.state().tools.tool.content).toBe('Independent tool failure')
  expect(f.state().activeTurnId).toBe('captured-turn')
  expect(f.state().running).toBe(true)
  f.expectQueueIntact()
})

for (const confirmed of [false, undefined]) test(`an unconfirmed main Stop releases loading while retaining captured intent, confirmed=${confirmed}`, async () => {
  const f = fixture()
  f.stop(f.sessionId)
  const requestedAt = f.state().stopRequestedAt
  f.reply.resolve({ accepted: true, confirmed, interruptedTurnId: 'captured-turn', goalPauseError: 'The saved goal could not be paused',
    ...(confirmed ? {} : { interruptionError: 'The engine interruption could not be confirmed' }),
  })
  await flush()
  expect(f.calls).toEqual([[f.sessionId, 'captured-turn']])
  expect(f.toasts).toEqual(confirmed ? ['The saved goal could not be paused'] : ['The engine interruption could not be confirmed', 'The saved goal could not be paused'])
  expect(f.stopping.has(f.sessionId)).toBe(false)
  expect(f.interrupted.has(f.sessionId)).toBe(true)
  expect(f.state().stopRequestedAt).toBe(requestedAt)
  expect(f.state().running).toBe(true)
  expect(f.clears()).toBe(0)
  f.expectQueueIntact()
})

test('confirmed main Stop settles immediately while cleanup and history persistence are still pending', async () => {
  const f = fixture()
  store.ingestChatEvent({ type: 'text_delta', sessionId: f.sessionId, text: 'Partial answer' })
  store.ingestChatEvent({ type: 'tool_start', sessionId: f.sessionId, toolCallId: 'failed', toolName: 'bash', args: {} })
  store.ingestChatEvent({ type: 'tool_end', sessionId: f.sessionId, toolCallId: 'failed', isError: true, content: 'Independent failure' })
  store.ingestChatEvent({ type: 'tool_start', sessionId: f.sessionId, toolCallId: 'running', toolName: 'bash', args: {} })
  f.stop(f.sessionId)
  expect(f.state().running).toBe(true)
  expect(f.stopping.has(f.sessionId)).toBe(true)
  f.reply.resolve({ accepted: true, confirmed: true, interruptedTurnId: 'captured-turn',
    goalPauseError: 'The saved goal could not be paused' })
  await flush()
  expect(f.state().running).toBe(false)
  expect(f.state().activityVisible).toBe(false)
  expect(f.state().thinkingActive).toBe(false)
  expect(f.state().interruptedLiveTurn).toEqual({ turnId: 'captured-turn' })
  expect(f.state().stopRequestedAt).toBeNull()
  expect(f.state().tools.running.status).toBe('interrupted')
  expect(f.state().tools.failed.status).toBe('error')
  expect(f.state().liveUnits.some(unit => unit.type === 'live-user')).toBe(true)
  expect(f.state().liveUnits.some(unit => unit.type === 'live-text' && unit.text === 'Partial answer')).toBe(true)
  expect(f.stopping.has(f.sessionId)).toBe(false)
  expect(f.interrupted.has(f.sessionId)).toBe(false)
  expect(f.toasts).toEqual(['The saved goal could not be paused'])
  expect(f.terminalEffects).toEqual(['context', 'files', 'focus', 'sessions'])
  expect(f.continueArmUntil.get(f.sessionId)).toBeGreaterThan(Date.now())
  await store.loadSessionHistory(f.sessionId)
  expect(f.state().liveUnits.some(unit => unit.type === 'live-user')).toBe(true)
  const before = f.state(), armedUntil = f.continueArmUntil.get(f.sessionId)
  // The actual terminal frame arrives only after the engine flushes its rollout.
  f.receive({ type: 'interrupted', sessionId: f.sessionId, turnId: 'captured-turn' })
  expect(f.state()).toBe(before)
  expect(f.continueArmUntil.get(f.sessionId)).toBe(armedUntil)
  expect(f.terminalEffects).toHaveLength(4)
  expect(f.timers).toHaveLength(1)
  f.expectQueueIntact()
})

test('a late confirmation and terminal frame cannot stop a replacement or clear its pending Stop', async () => {
  const f = fixture()
  f.stop(f.sessionId)
  store.ingestLocalUserTurn(f.sessionId, { text: 'Replacement input' })
  store.ingestChatEvent({ type: 'stream_mode', sessionId: f.sessionId, mode: 'requesting', turnId: 'replacement-turn' })
  store.requestTurnInterrupt(f.sessionId)
  const before = f.state()
  f.reply.resolve({ accepted: true, confirmed: true, interruptedTurnId: 'captured-turn' })
  await flush()
  f.receive({ type: 'interrupted', sessionId: f.sessionId, turnId: 'captured-turn' })
  expect(f.state()).toBe(before)
  expect(f.state().running).toBe(true)
  expect(f.stopping.has(f.sessionId)).toBe(true)
  expect(f.interrupted.has(f.sessionId)).toBe(true)
  expect(f.continueArmUntil.has(f.sessionId)).toBe(false)
  expect(f.terminalEffects).toEqual([])
  f.expectQueueIntact()
})

test('a terminal frame before the Stop reply settles once', async () => {
  const f = fixture()
  f.stop(f.sessionId)
  f.receive({ type: 'interrupted', sessionId: f.sessionId, turnId: 'captured-turn' })
  const before = f.state(), armedUntil = f.continueArmUntil.get(f.sessionId)
  f.reply.resolve({ accepted: true, confirmed: true, interruptedTurnId: 'captured-turn' })
  await flush()
  expect(f.state()).toBe(before)
  expect(f.continueArmUntil.get(f.sessionId)).toBe(armedUntil)
  expect(f.terminalEffects).toHaveLength(4)
  expect(f.timers).toHaveLength(1)
})

test('old stopped-turn frames cannot adopt a successor before its engine identity arrives', async () => {
  const f = fixture()
  f.stop(f.sessionId)
  f.reply.resolve({ accepted: true, confirmed: true, interruptedTurnId: 'captured-turn' })
  await flush()
  store.beginPendingUserTurn(f.sessionId, { text: 'The next request', uuid: 'next-user' })
  const pending = f.state(), armedUntil = f.continueArmUntil.get(f.sessionId)
  expect(pending.running).toBe(true)
  expect(pending.activeTurnId).toBeNull()
  expect(pending.interruptedLiveTurn).toBeNull()
  for (const event of [
    { type: 'interrupted' },
    { type: 'done' },
    { type: 'api_error', terminal: true, error: 'Late settlement failure' },
    { type: 'compaction_error', error: 'Late compaction failure' },
    { type: 'session_runtime_status', status: 'idle' },
    { type: 'session_runtime_status', status: 'active' },
    { type: 'stream_mode', mode: 'requesting' },
    { type: 'text_delta', text: 'Stale output' },
    { type: 'tool_start', toolCallId: 'stale', toolName: 'bash', args: {} },
  ]) {
    // Direct ingestion also serves child streams and must apply the same fence.
    store.ingestChatEvent({ ...event, sessionId: f.sessionId, turnId: 'captured-turn' })
    expect(f.state()).toBe(pending)
    f.receive({ ...event, sessionId: f.sessionId, turnId: 'captured-turn' })
    expect(f.state()).toBe(pending)
  }
  expect(f.continueArmUntil.get(f.sessionId)).toBe(armedUntil)
  expect(f.terminalEffects).toHaveLength(4)
  store.ingestChatEvent({ type: 'session_runtime_status', sessionId: f.sessionId, status: 'active', turnId: 'successor-turn' })
  expect(f.state().running).toBe(true)
  expect(f.state().activeTurnId).toBe('successor-turn')
  expect(f.state().liveUnits.find(unit => unit.type === 'live-user' && unit.msg.uuid === 'next-user')?.turnId).toBe('successor-turn')
})

test('transport rejection releases loading and keeps the captured stop fence without retargeting', async () => {
  const f = fixture()
  f.stop(f.sessionId)
  const requestedAt = f.state().stopRequestedAt
  f.reply.reject(new Error('The host reply was lost'))
  await flush()
  expect(f.calls).toEqual([[f.sessionId, 'captured-turn']])
  expect(f.toasts).toEqual(['The host reply was lost'])
  expect(f.stopping.has(f.sessionId)).toBe(false)
  expect(f.interrupted.has(f.sessionId)).toBe(true)
  expect(f.state().stopRequestedAt).toBe(requestedAt)
  expect(f.state().running).toBe(true)
  expect(f.clears()).toBe(0)
  f.expectQueueIntact()
})

test('an old refused request cannot unlock a newer turn Stop in its finally block', async () => {
  const f = fixture()
  f.stop(f.sessionId)
  store.ingestLocalUserTurn(f.sessionId, { text: 'Replacement input' })
  store.ingestChatEvent({ type: 'stream_mode', sessionId: f.sessionId, mode: 'requesting', turnId: 'replacement-turn' })
  store.requestTurnInterrupt(f.sessionId)
  const before = f.state()
  f.reply.resolve({ accepted: false, confirmed: true, interruptedTurnId: null })
  await flush()
  expect(f.state()).toBe(before)
  expect(f.stopping.has(f.sessionId)).toBe(true)
  expect(f.interrupted.has(f.sessionId)).toBe(true)
  expect(f.clears()).toBe(0)
  f.expectQueueIntact()
})
