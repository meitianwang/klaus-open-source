// Acceptance tests for the stop (user interrupt) interaction, driven by the
// committed reference vectors in transcript/stop-interaction-vectors.json.
//
// The vectors are the contract: each rule records the required behaviour, the
// reason for it, and what Klaus must render. These tests read the vectors
// and assert the implementation against them, so changing behaviour forces the
// vector (and its stated reason) to change in the same commit.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isArrowFunction, isIdentifier, isPropertyAssignment, isStringLiteral, ModuleKind, ScriptKind, ScriptTarget, transpileModule, type Node } from 'typescript'
import vectors from './transcript/stop-interaction-vectors.json'
import { I18N } from '../i18n/messages'
import { LIBRARY as icons } from '../icons/library'

;(globalThis as any).window = {
  addEventListener: () => {},
  currentLang: 'en',
  klaus: { session: { history: async () => [] } },
}

const store = await import('./stream-store')
const { editTargetFor, foldUnits, resolveSubagentActivities, terminalDurationLabel, unitsFromMessages } = await import('./transcript/TranscriptView')

type Rule = (typeof vectors)['rules'][number]
const rule = (id: string): Rule => {
  const found = vectors.rules.find(entry => entry.id === id)
  if (!found) throw new Error(`vector rule missing: ${id}`)
  return found
}
const trajectory = (id: string) => {
  const found = vectors.trajectories.find(entry => entry.id === id)
  if (!found) throw new Error(`vector trajectory missing: ${id}`)
  return found
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

// One stopped Turn, driven through the same events the shell emits.
type Trajectory = 'text' | 'thinking' | 'tool' | 'subagent'
function runStoppedTurn(sessionId: string, kind: Trajectory, turnId = 'turn-1') {
  store.ingestLocalUserTurn(sessionId, { text: 'go' })
  store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId })
  if (kind === 'text') {
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'partial answer' })
  }
  if (kind === 'thinking') {
    store.ingestChatEvent({ type: 'thinking_delta', sessionId, thinking: 'weighing options' })
  }
  if (kind === 'tool' || kind === 'subagent') {
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'first I will look' })
    store.ingestChatEvent({
      type: 'tool_start',
      sessionId,
      toolCallId: 'call-1',
      toolName: kind === 'subagent' ? 'Task' : 'bash',
      args: kind === 'subagent' ? { subagent_type: 'Search', description: 'find it' } : { command: 'sleep 30' },
    })
  }
  store.requestTurnInterrupt(sessionId)
  if (kind === 'tool' || kind === 'subagent') {
    // The engine synthesises a failing result for every call an abort left
    // unhandled; it arrives BEFORE the Turn's terminal event.
    store.ingestChatEvent({
      type: 'tool_end',
      sessionId,
      toolCallId: 'call-1',
      isError: true,
      content: 'Tool execution was interrupted.',
    })
  }
  store.ingestChatEvent({ type: 'interrupted', sessionId, turnId }, { userInterrupted: true })
  return store.getSessionStream(sessionId)
}

describe('stop interaction vectors: wording and duration', () => {
  test('the stopped label is the user-attributed sentence from the vectors', () => {
    const spec = rule('status-label-wording')
    expect(I18N.en[spec.klaus.i18nKey!]).toBe(spec.klaus.en)
    expect(I18N.zh[spec.klaus.i18nKey!]).toBe(spec.klaus.zh)
    // Both locales must keep the placeholder, otherwise the elapsed time is
    // silently dropped in one language.
    expect(I18N.en[spec.klaus.i18nKey!]).toContain('{duration}')
    expect(I18N.zh[spec.klaus.i18nKey!]).toContain('{duration}')
  })

  test('duration wording matches every captured sample', () => {
    for (const sample of rule('status-label-duration-format').klaus.samples!) {
      expect(terminalDurationLabel(sample.durationMs)).toBe(sample.en)
    }
  })

  test('a negative or non-finite duration has no label at all', () => {
    expect(terminalDurationLabel(-1)).toBeNull()
    expect(terminalDurationLabel(Number.NaN)).toBeNull()
  })
})

describe('stop interaction vectors: four stop trajectories', () => {
  test('text streaming: the partial answer survives and the Turn carries the status', () => {
    const spec = trajectory('text-streaming')
    const state = runStoppedTurn('stop-text', 'text')
    const text = state.liveUnits.find(unit => unit.type === 'live-text')
    expect(text && 'text' in text ? text.text : '').toBe('partial answer')
    expect(text && 'aborted' in text ? text.aborted : false).toBe(true)
    expect(text && 'streaming' in text ? text.streaming : true).toBe(false)
    // The partial answer is copyable/branchable like a completed one, and carries no
    // usage meta because the abort produced none.
    const tail = text && 'turnTail' in text ? text.turnTail : null
    expect(tail).toBeTruthy()
    expect(tail?.meta).toBeNull()
    const status = state.liveUnits.filter(unit => unit.type === 'live-turn-status')
    expect(status.length).toBe(1)
    expect(status[0] && 'turnId' in status[0] ? status[0].turnId : '').toBe('turn-1')
    expect(status[0] && 'finishedAt' in status[0] ? status[0].finishedAt : 0).toBe(tail?.ts)
    expect(state.turnStatuses['turn-1']).toBe(spec.klaus.turnStatus)
  })

  test('thinking: the sealed reasoning block stays and the Turn carries the status', () => {
    const state = runStoppedTurn('stop-thinking', 'thinking')
    const thinking = state.liveUnits.find(unit => unit.type === 'live-thinking-done')
    expect(thinking && 'text' in thinking ? thinking.text : '').toBe('weighing options')
    expect(state.thinkingActive).toBe(false)
    expect(state.liveUnits.filter(unit => unit.type === 'live-turn-status').length).toBe(1)
    expect(state.turnStatuses['turn-1']).toBe(trajectory('thinking').klaus.turnStatus)
  })

  test('tool running: the unfinished tool reads interrupted, not failed', () => {
    const spec = trajectory('tool-running')
    const state = runStoppedTurn('stop-tool', 'tool')
    expect(state.tools['call-1'].status).toBe(spec.klaus.toolStatus)
    expect(state.tools['call-1'].content).toBe('Tool execution was interrupted.')
    expect(state.liveUnits.some(unit => unit.type === 'live-tools')).toBe(true)
    expect(state.turnStatuses['turn-1']).toBe(spec.klaus.turnStatus)
  })

  test('subagent: the spawn row reads interrupted so the panel shows stopped', () => {
    const state = runStoppedTurn('stop-subagent', 'subagent')
    expect(state.tools['call-1'].status).toBe('interrupted')
    expect(state.tools['call-1'].agent).toBe(true)
    expect(state.turnStatuses['turn-1']).toBe(trajectory('subagent').klaus.turnStatus)
  })

  test('a stale running task snapshot cannot keep a stopped subagent row alive', () => {
    const spawn = {
      toolName: 'Task',
      toolCallId: 'call-1',
      args: { subagent_type: 'Search', description: 'find it' },
      state: 'interrupted',
      output: null,
      agent: true,
      activityKind: 'spawn' as const,
    }
    // The panel's last snapshot still claims the subagent is running: the stop
    // took it down without a terminal task update.
    const withTask = (task: any) => {
      ;(globalThis as any).window.KlausSubagentPanel = { getTask: () => task }
    }
    try {
      withTask({ status: 'running', isIdle: false, agentName: 'Search', agentType: 'Search' })
      expect(resolveSubagentActivities([spawn as any])[0].status)
        .toBe(trajectory('subagent').klaus.subagentDisplayStatus)
      // A task that DID report a terminal state keeps it.
      withTask({ status: 'failed', agentName: 'Search' })
      expect(resolveSubagentActivities([spawn as any])[0].status).toBe('failed')
      // The spawn call itself normally finishes long before the subagent does, so
      // an interrupted TURN is what settles the row.
      const finishedSpawn = { ...spawn, state: 'done' }
      withTask({ status: 'running', isIdle: false, agentName: 'Search', type: 'foreground' })
      expect(resolveSubagentActivities([finishedSpawn as any])[0].status).toBe('running')
      expect(resolveSubagentActivities([finishedSpawn as any], true)[0].status).toBe('stopped')
      // `isBackground` is stamped on every engine-confirmed run, foreground spawns
      // included, so it must NOT exempt a row from the Turn's terminal state.
      withTask({ status: 'running', isIdle: false, isBackground: true, type: 'foreground', agentName: 'Search' })
      expect(resolveSubagentActivities([finishedSpawn as any], true)[0].status).toBe('stopped')
      // A deliberately detached run keeps its own status.
      withTask({ status: 'running', isIdle: false, agentType: 'background', agentName: 'Search' })
      expect(resolveSubagentActivities([finishedSpawn as any], true)[0].status).toBe('running')
    } finally {
      delete (globalThis as any).window.KlausSubagentPanel
    }
  })

  test('a tool that failed BEFORE the stop keeps its failure', () => {
    const sessionId = 'stop-pre-failure'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'bad', toolName: 'bash', args: {} })
    store.ingestChatEvent({ type: 'tool_end', sessionId, toolCallId: 'bad', isError: true, content: 'exit 1' })
    store.requestTurnInterrupt(sessionId)
    store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'turn-1' }, { userInterrupted: true })
    expect(store.getSessionStream(sessionId).tools.bad.status).toBe('error')
  })

  test('a Turn that finished anyway gives the failure back to the tool', () => {
    const spec = rule('unfinished-tool-terminal-state')
    expect(spec.klaus.stopWindowAttributionIsProvisional).toBe(true)
    const sessionId = 'stop-lost-race'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'bad', toolName: 'bash', args: {} })
    store.requestTurnInterrupt(sessionId)
    // The click landed first, so the row reads stopped rather than flashing red.
    store.ingestChatEvent({ type: 'tool_end', sessionId, toolCallId: 'bad', isError: true, content: 'exit 1' })
    expect(store.getSessionStream(sessionId).tools.bad.status).toBe('interrupted')
    // ...but the engine got to the end of the Turn before the abort landed. The
    // Turn was never stopped, so the failure was the tool's own after all.
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-1' })
    const settled = store.getSessionStream(sessionId)
    expect(settled.tools.bad.status).toBe('error')
    expect(settled.tools.bad.stopWindowFailure).toBeUndefined()
    expect(settled.interruptedLiveTurn).toBeNull()
    expect(settled.turnStatuses['turn-1']).toBeUndefined()
  })

  test('a refused stop also gives the failure back to the tool', () => {
    const sessionId = 'stop-refused-failure'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'bad', toolName: 'bash', args: {} })
    store.requestTurnInterrupt(sessionId)
    store.ingestChatEvent({ type: 'tool_end', sessionId, toolCallId: 'bad', isError: true, content: 'exit 1' })
    expect(store.getSessionStream(sessionId).tools.bad.status).toBe('interrupted')
    store.clearTurnInterruptRequest(sessionId)
    expect(store.getSessionStream(sessionId).tools.bad.status).toBe('error')
  })
})

describe('stop interaction vectors: transcript shape', () => {
  test('an interrupted Turn is collapsible and keeps every unit inside the fold', () => {
    const spec = rule('interrupted-turn-is-collapsible')
    expect(spec.klaus.partialTextRetained).toBe(true)
    const units = unitsFromMessages([
      { uuid: 'u1', role: 'user', text: 'q', turnId: 'turn-1' },
      { uuid: 'a1', role: 'assistant', text: 'narration', turnId: 'turn-1' },
      {
        uuid: 'a2',
        role: 'assistant',
        turnId: 'turn-1',
        contentBlocks: [{ type: 'tool_use', id: 'call-1', name: 'bash', input: {} }],
      },
    ])
    const nodes = foldUnits(units, null, { 'turn-1': 'interrupted' }, {}, {}, { 'turn-1': 12_000 })
    const fold = nodes.find(node => node.kind === 'turn-fold')
    expect(fold?.kind).toBe('turn-fold')
    expect(fold && 'open' in fold ? fold.open : true).toBe(false)
    const status = nodes.filter(node => node.kind === 'unit' && node.unit.type === 'turn-status')
    expect(status.length).toBe(1)
    expect(status[0].kind === 'unit' ? status[0].unit.msg?.durationMs : 0).toBe(12_000)
  })

  test('the stop leaves no detached transcript entry', () => {
    const spec = rule('no-detached-stop-message')
    // The removed unit kinds must not exist anywhere in the projection.
    const units = unitsFromMessages([
      { uuid: 'u1', role: 'user', text: 'q', turnId: 'turn-1' },
      { uuid: 's1', role: 'system', text: '[Request interrupted by user]', turnId: 'turn-1' },
    ])
    for (const removed of spec.klaus.removed!) {
      expect(units.some(unit => (unit.type as string) === removed)).toBe(false)
    }
    // The engine's interrupt marker message is dropped outright: it is not a
    // message the user wrote and not a status the Turn owns.
    expect(units.filter(unit => unit.type === 'user').length).toBe(1)
    expect(units.length).toBe(1)
  })

  test('a completed Turn gets no stopped status row', () => {
    const units = unitsFromMessages([
      { uuid: 'u1', role: 'user', text: 'q', turnId: 'turn-1' },
      { uuid: 'a1', role: 'assistant', text: 'answer', turnId: 'turn-1' },
    ])
    const nodes = foldUnits(units, null, { 'turn-1': 'completed' }, {}, {}, { 'turn-1': 9_000 })
    expect(nodes.some(node => node.kind === 'unit' && node.unit.type === 'turn-status')).toBe(false)
  })

  test('on reload the Turn cancelled-call list reclassifies its tool rows', () => {
    const message = {
      uuid: 'a1',
      role: 'assistant',
      turnId: 'turn-1',
      contentBlocks: [{
        type: 'tool_use',
        id: 'call-1',
        name: 'bash',
        input: {},
        __result: { isError: true, content: 'Tool execution was interrupted.' },
      }],
    }
    const toolStates = (cancelled: Record<string, string[]>) => {
      const nodes = foldUnits(
        unitsFromMessages([{ uuid: 'u1', role: 'user', text: 'q', turnId: 'turn-1' }, { ...message }]),
        null,
        { 'turn-1': 'interrupted' },
        {},
        {},
        { 'turn-1': 8_000 },
        cancelled,
      )
      const collect = (node: any): string[] => {
        if (node.kind === 'unit' && node.unit.type === 'tools') return (node.unit.segment?.tools || []).map((tool: any) => tool.state)
        if (node.kind === 'turn-fold' || node.kind === 'activity-fold') return node.items.flatMap((item: any) => collect(item))
        return []
      }
      return nodes.flatMap(collect)
    }
    // Without the Turn's cancelled list the engine's error is all history has, so
    // the row stays a failure. Naming the call is what makes it read as stopped.
    expect(toolStates({})).toEqual(['error'])
    expect(toolStates({ 'turn-1': ['call-1'] })).toEqual(['interrupted'])
    // A call the Turn did NOT cancel keeps its failure.
    expect(toolStates({ 'turn-1': ['other-call'] })).toEqual(['error'])
  })

  test('a stop does not take the message actions away', () => {
    const spec = rule('message-actions-survive-cancellation')
    expect(spec.klaus.partialAnswerGetsActionRow).toBe(true)
    // Live layer: the partial answer carries the same action row anchor a
    // completed reply gets, so the actions do not appear only after a reload.
    const live = runStoppedTurn('stop-actions-live', 'text')
    const partial = live.liveUnits.find(unit => unit.type === 'live-text')
    expect(partial && 'turnTail' in partial ? partial.turnTail : null).toBeTruthy()
    // History layer after the same Turn reloads: the row is there too.
    const units = unitsFromMessages([
      { uuid: 'u1', role: 'user', text: 'q', turnId: 'turn-1' },
      { uuid: 'a1', role: 'assistant', text: 'partial answer', turnId: 'turn-1' },
    ])
    const nodes = foldUnits(units, null, { 'turn-1': 'interrupted' }, {}, {}, { 'turn-1': 5_000 })
    const text = nodes.find(node => node.kind === 'unit' && node.unit.type === 'text')
    expect(text && text.kind === 'unit' ? text.unit.hasActions : false).toBe(true)
    // The gate is the Turn's running flag, never its cancelled status: the
    // interrupted terminal event clears running, which is what re-enables the row.
    expect(live.running).toBe(false)
  })

  test('an unfinished write is never presented as a landed change', () => {
    const spec = rule('stopped-file-creation-is-not-a-completed-change')
    expect(spec.klaus.unfinishedWriteShowsDiffStats).toBe(false)
    const sessionId = 'stop-write'
    store.ingestLocalUserTurn(sessionId, { text: 'write it' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({
      type: 'tool_start',
      sessionId,
      toolCallId: 'call-w',
      toolName: 'Write',
      args: { file_path: '/tmp/new.txt', content: 'a\nb\nc\n' },
    })
    store.requestTurnInterrupt(sessionId)
    store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'turn-1' }, { userInterrupted: true })
    const card = store.getSessionStream(sessionId).tools['call-w']
    // The row reads stopped, and it holds no result of its own: the content the
    // call was going to write is input, and input never becomes an output block.
    expect(card.status).toBe('interrupted')
    expect(card.content).toBeUndefined()
    expect(card.progress.length).toBe(0)
  })
})

describe('stop interaction vectors: repeated stop and late events', () => {
  test('a second stop request while the first is outstanding changes nothing', () => {
    const spec = rule('stop-button-duplicate-guard')
    expect(spec.klaus.secondClickDropped).toBe(true)
    const sessionId = 'stop-double'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.requestTurnInterrupt(sessionId)
    const first = store.getSessionStream(sessionId).stopRequestedAt
    expect(first).not.toBeNull()
    store.requestTurnInterrupt(sessionId)
    expect(store.getSessionStream(sessionId).stopRequestedAt).toBe(first)
  })

  test('a refused stop clears the request so the button recovers', () => {
    const sessionId = 'stop-refused'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.requestTurnInterrupt(sessionId)
    store.clearTurnInterruptRequest(sessionId)
    expect(store.getSessionStream(sessionId).stopRequestedAt).toBeNull()
    expect(store.getSessionStream(sessionId).running).toBe(true)
  })

  test('a stop request before any Turn is running is ignored', () => {
    const sessionId = 'stop-idle'
    store.requestTurnInterrupt(sessionId)
    expect(store.getSessionStream(sessionId).stopRequestedAt).toBeNull()
  })

  test('a legacy bare done after the interrupted event does not erase the partial Turn', () => {
    const sessionId = 'stop-late-done'
    const state = runStoppedTurn(sessionId, 'text')
    const before = state.liveUnits.length
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-1' })
    const after = store.getSessionStream(sessionId)
    expect(after.liveUnits.length).toBe(before)
    expect(after.historyStale).toBe(false)
    expect(after.turnStatuses['turn-1']).toBe('interrupted')
  })

  test('stream activity arriving after the stop is dropped, not appended below the status', () => {
    const sessionId = 'stop-late-activity'
    const state = runStoppedTurn(sessionId, 'text')
    const before = state.liveUnits.length
    const tail = state.liveUnits[before - 1]
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: ' and more' })
    store.ingestChatEvent({ type: 'thinking_delta', sessionId, thinking: 'late thought' })
    store.ingestChatEvent({ type: 'tool_start', sessionId, toolCallId: 'late', toolName: 'bash', args: {} })
    const after = store.getSessionStream(sessionId)
    expect(after.liveUnits.length).toBe(before)
    // The Turn's status stays the LAST thing in the Turn.
    expect(after.liveUnits[after.liveUnits.length - 1]).toBe(tail)
    expect(after.tools.late).toBeUndefined()
    expect(after.running).toBe(false)
    expect(after.thinkingActive).toBe(false)
  })
})

describe('stop interaction vectors: history handover', () => {
  test('history stays frozen while the interrupted Turn owns its partial output', async () => {
    const sessionId = 'stop-history-frozen'
    runStoppedTurn(sessionId, 'text')
    await store.loadSessionHistory(sessionId)
    await flush()
    const state = store.getSessionStream(sessionId)
    expect(state.history).toBeNull()
    expect(state.liveUnits.some(unit => unit.type === 'live-text')).toBe(true)
  })

  test('the next Turn hands the interrupted Turn over to history', async () => {
    const sessionId = 'stop-history-handover'
    runStoppedTurn(sessionId, 'text')
    // A new user Turn releases the live layer's ownership.
    store.ingestLocalUserTurn(sessionId, { text: 'keep going' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-2' })
    expect(store.getSessionStream(sessionId).interruptedLiveTurn).toBeNull()
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'ok' })
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-2' })
    await flush()
    const state = store.getSessionStream(sessionId)
    expect(state.history).not.toBeNull()
    expect(state.liveUnits.length).toBe(0)
  })
})

describe('stop interaction vectors: continue entry', () => {
  test('the composer offers continue after the last Turn was stopped or failed', () => {
    const spec = rule('resume-entry')
    expect(I18N.en[spec.klaus.i18nKey!]).toBe(spec.klaus.en)
    expect(I18N.zh[spec.klaus.i18nKey!]).toBe(spec.klaus.zh)
    const sessionId = 'continue-eligible'
    expect(store.canContinueTurn(sessionId)).toBe(false)
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    // Running: continuing makes no sense yet.
    expect(store.canContinueTurn(sessionId)).toBe(false)
    store.requestTurnInterrupt(sessionId)
    store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'turn-1' }, { userInterrupted: true })
    expect(store.canContinueTurn(sessionId)).toBe(true)
    // Once the next Turn starts the offer goes away again.
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-2' })
    expect(store.canContinueTurn(sessionId)).toBe(false)

    const failedSessionId = 'continue-failed'
    store.ingestLocalUserTurn(failedSessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId: failedSessionId, mode: 'requesting', turnId: 'turn-failed' })
    store.ingestChatEvent({
      type: 'api_error',
      sessionId: failedSessionId,
      turnId: 'turn-failed',
      terminal: true,
      error: 'provider connection failed',
      kind: 'network',
    })
    expect(store.getSessionStream(failedSessionId).turnStatuses['turn-failed']).toBe('failed')
    expect(store.canContinueTurn(failedSessionId)).toBe(true)
  })

  test('a completed Turn never offers continue', () => {
    const sessionId = 'continue-completed'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-1' })
    store.ingestChatEvent({ type: 'text_delta', sessionId, text: 'answer' })
    store.ingestChatEvent({ type: 'done', sessionId, turnId: 'turn-1' })
    expect(store.canContinueTurn(sessionId)).toBe(false)
  })

  test('continue is NOT a re-send: the channel is its own', () => {
    const spec = rule('resume-entry')
    expect(spec.klaus.channel).toBe('chat:continue')
    expect(spec.klaus.notARepeatSend).toBe(true)
  })

  test('one Continue click stays visibly pending until the new Turn starts', () => {
    const spec = rule('resume-entry')
    expect(spec.klaus.inFlight!.disabled).toBe(true)
    expect(spec.klaus.inFlight!.cssClass).toBe('continuing')
    expect(spec.klaus.inFlight!.glyph).toContain('send-stopping')
    expect(I18N.en[spec.klaus.inFlight!.labelKey!]).toBe('Continuing…')
    expect(I18N.zh[spec.klaus.inFlight!.labelKey!]).toBe('正在继续…')
    expect(spec.klaus.postStopRoleDelayScope).toBe('session')
    expect(spec.klaus.appearance!.shape).toBe('rounded-square')
    expect(spec.klaus.appearance!.border).toBe('none')

    const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
    const arm = chat.indexOf('continueArmUntil.set(event.sessionId, Date.now() + CONTINUE_ARM_DELAY_MS)')
    const ingest = chat.indexOf('ingestChatFrameEvent(event, { userInterrupted:')
    expect(arm).toBeGreaterThan(-1)
    expect(arm).toBeLessThan(ingest)
    expect(chat).toContain('const continueArmUntil = new Map<string, number>()')
    expect(chat).toContain('const armUntil = continueArmUntil.get(sessionId) || 0')
    expect(chat).toContain("btnSend.classList.toggle('continuing', continuePending)")
    expect(chat).toContain('continuingSessions.delete(event.sessionId)\n      updateSendBtn()')
    expect(chat).toContain('setSessionRunning(change.sessionId, change.running)')
    expect(chat).not.toContain("event.type === 'done' || event.type === 'interrupted' || event.type === 'compaction_error') {\n      stoppingSessions.delete(event.sessionId)\n      continuingSessions.delete(event.sessionId)")
    expect(chat).not.toContain('}).finally(() => {\n    continuingSessions.delete(sessionId)')

    const css = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')
    expect(css).toContain('#send.continue.continuing .icon-stopping')
    expect(css).toContain(`width: ${spec.klaus.appearance!.hitTargetPx}px;\n  height: ${spec.klaus.appearance!.hitTargetPx}px;`)
    expect(spec.klaus.appearance!.visualSurfacePx).toBe(16)
    expect(css).toContain('background-clip: content-box;')
    expect(css).toContain('height: 30px;\n  padding: 7px;')
    expect(css).toContain('border-radius: var(--radius-xs);')
    expect(css).toContain('background-color: var(--bg-hover);\n  color: var(--fg-secondary);')
    expect(css).toContain('#send.continue:focus-visible')
  })

  test('the real composer role refreshes after switching sessions and loading history', () => {
    const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
    const cacheStart = chat.indexOf('let composerContinueOffered = false')
    const cacheEnd = chat.indexOf('// Number of live-approval units', cacheStart)
    const functionsStart = chat.indexOf('function sessionContinueMode(')
    const functionsEnd = chat.indexOf('// ==================== Input events', functionsStart)
    const subscriberStart = chat.indexOf('chatStreamStore.subscribe((state, previousState) => {')
    const refreshStart = chat.indexOf('  const offered = composerContinueMode()', subscriberStart)
    const refreshEnd = chat.indexOf('\n})', refreshStart)
    for (const index of [cacheStart, cacheEnd, functionsStart, functionsEnd, subscriberStart, refreshStart, refreshEnd]) expect(index).toBeGreaterThanOrEqual(0)

    const expectedRoles = JSON.parse(readFileSync(new URL('../../../contracts/vectors/turn-termination-vectors.json', import.meta.url), 'utf8')).composerContinue.roleAcrossSessionSwitchAndDraft as boolean[]
    const classes = new Set<string>()
    const button = {
      disabled: false, title: '',
      classList: {
        toggle: (name: string, active: boolean) => { if (active) classes.add(name); else classes.delete(name) },
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
      },
    }
    const eligible = new Set(['first'])
    let inputText = ''
    const sandbox = { currentPendingComposerSubmission: () => undefined,
      voiceChatUi: undefined,
      window: { currentSessionId: 'first', addEventListener: () => {} }, busy: false, composerPredictions: undefined, composerReferenceEntries: () => [], friendSendInFlight: false,
      btnSend: button, creatingGoalSessions: new Set(), stoppingSessions: new Set(), continuingSessions: new Set(),
      continueArmUntil: new Map(), pendingFiles: [],
      canContinueTurn: (sessionId: string) => eligible.has(sessionId),
      hasComposerText: () => inputText.length > 0,
      // An edit of a sent message owns the composer, so `composerContinueMode` consults
      // it; no edit is open in this fixture, which is the ordinary continue path under test.
      hasUploadInFlight: () => false, stopEscArmed: () => false, tt: (key: string) => key,
    }
    const source = [chat.slice(cacheStart, cacheEnd), chat.slice(functionsStart, functionsEnd),
      `function syncFromStore() { ${chat.slice(refreshStart, refreshEnd)} }`,
      // Friend compose controls are not under test here; neutralise the module-level
      // refresher so the send/continue role checks do not pull in friend state.
      'function updateFriendComposeControls() {}',
      '({ updateSendBtn, syncFromStore })'].join('\n')
    const code = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText
    const fixture = runInNewContext(code, sandbox) as { updateSendBtn(): void; syncFromStore(): void }

    const observedRoles: boolean[] = []
    fixture.updateSendBtn()
    observedRoles.push(classes.has('continue'))
    sandbox.window.currentSessionId = 'second'
    fixture.updateSendBtn()
    observedRoles.push(classes.has('continue'))
    eligible.add('second')
    fixture.syncFromStore()
    observedRoles.push(classes.has('continue'))
    inputText = 'another request'
    fixture.updateSendBtn()
    observedRoles.push(classes.has('continue'))
    inputText = ''
    fixture.updateSendBtn()
    observedRoles.push(classes.has('continue'))
    expect(observedRoles).toEqual(expectedRoles)
  })

  test('a stopped Turn gets no in-transcript retry button', () => {
    expect(rule('no-per-turn-retry-entry').klaus.addsInTranscriptRetryButton).toBe(false)
  })

  test('typing after a stop takes the button back to send, and the send still works', async () => {
    const sessionId = 'continue-then-type'
    runStoppedTurn(sessionId, 'text')
    expect(store.canContinueTurn(sessionId)).toBe(true)
    // Sending a new message is the OTHER thing the user can do after a stop; the
    // store must accept it while the stopped Turn is still on screen.
    store.ingestLocalUserTurn(sessionId, { text: 'different question' })
    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(true)
    expect(state.interruptedLiveTurn).toBeNull()
    expect(store.canContinueTurn(sessionId)).toBe(false)
    // Both the stopped Turn's status row and the new user bubble are on screen: the
    // new send must not erase what was stopped.
    expect(state.liveUnits.filter(unit => unit.type === 'live-turn-status').length).toBe(1)
    expect(state.liveUnits.filter(unit => unit.type === 'live-user').length).toBe(2)
    expect(state.liveUnits.some(unit => unit.type === 'live-text')).toBe(true)
  })
})

// The composer's stop affordance lives in chat.ts, which owns the real DOM and is
// not importable here. These pin the RULES the implementation is written against,
// so a behaviour change has to move this file and the vector together.
describe('stop interaction vectors: composer stop affordance', () => {
  test('the in-flight stop is disabled and shows a spinner, not a pressable glyph', () => {
    const spec = rule('stop-button-in-flight-appearance')
    expect(spec.klaus.disabled).toBe(true)
    expect(spec.klaus.cssClass).toBe('stopping')
    expect(spec.klaus.glyph).toContain('send-stopping')
    expect(I18N.en[spec.klaus.labelKey!]).toBe('Stopping…')
    expect(I18N.zh[spec.klaus.labelKey!]).toBe('正在停止…')
    // The glyph and the key hint the composer switches between must both exist in
    // the icon library, or the button renders an empty circle.
    expect(icons['send-stopping']).toBeTruthy()
    expect(icons['send-continue']).toBeTruthy()
  })

  test('Escape arms the stop for a bounded window before it can fire', () => {
    const spec = rule('escape-arms-then-stops')
    expect(spec.klaus.armWindowMs).toBe(2000)
    expect(spec.klaus.armedCssClass).toBe('esc-armed')
    expect(spec.klaus.scopedToTurn).toBe(true)
    expect(spec.klaus.clearedWhenTurnEnds).toBe(true)
    expect(spec.klaus.clearedOnDirectClick).toBe(true)
    // Escape is a dismiss key elsewhere in the composer; every consumer named here
    // must still get it first.
    expect(spec.klaus.yieldsToOtherEscapeConsumers).toContain('slash menu')
    expect(spec.klaus.yieldsToOtherEscapeConsumers).not.toContain('composer history browsing')
    expect(spec.klaus.ignoresRepeatToStop).toBe(true)
  })

  test('the composer implements exactly those rules', () => {
    const spec = rule('escape-arms-then-stops')
    const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
    expect(chat).toContain(`const STOP_ESC_ARM_MS = ${spec.klaus.armWindowMs}`)
    // Armed only after a press that had nothing else to dismiss, and only while a
    // Turn is actually running.
    expect(chat).toContain("if (e.key === 'Escape' && busy)")
    // The second press stops; the first only arms.
    expect(chat).toContain('if (stopEscArmed()) {')
    expect(chat).toContain('armStopEsc(sessionId)')
    // A direct click never needs arming, and the arm dies with the Turn.
    expect(chat).toContain('clearStopEscArm()\n  stoppingSessions.add(sessionId)')
    expect(chat).toContain('if (stopEscArmedTurn?.sessionId === event.sessionId) clearStopEscArm()')
    // The arm is scoped to the Turn, so it cannot outlive it and stop the next one.
    expect(chat).toContain('stopEscArmedTurn = { sessionId, turnId: getSessionStream(sessionId).activeTurnId }')
    expect(chat).toContain('return stopEscArmedTurn.turnId === getSessionStream(sessionId).activeTurnId')
    const css = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')
    expect(css).toContain(`#send.${spec.klaus.armedCssClass} .send-esc-hint`)
    expect(css).toContain('#send.busy.stopping .icon-stopping')
  })

  test('the stop request names the Turn it means to stop', async () => {
    const spec = rule('interrupt-request-names-the-turn')
    expect(spec.klaus.staleRequestRefused).toBe(true)
    expect(spec.klaus.settledRequestRefused).toBe(true)
    expect(spec.klaus.request!.expectedTurnId).toBe('string | undefined')
    const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
    expect(chat).toContain('const expectedTurnId = getSessionStream(sessionId).activeTurnId')
    expect(chat).toContain('klausApi.chat.interrupt(sessionId, expectedTurnId)')
    expect(chat).toContain("event.type === 'api_error' && event.terminal === true")
    const bridge = readFileSync(new URL('../../bridge/klaus-api.ts', import.meta.url), 'utf8')
    const routeSource = readFileSync(new URL('../../../main/ipc/handlers/sessions.ts', import.meta.url), 'utf8')
    const arrow = (source: string, name: string, sandbox: Record<string, unknown>) => {
      const ast = createSourceFile('stop-wire.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
      const matches: string[] = []
      const visit = (node: Node) => {
        if (isPropertyAssignment(node) && (isIdentifier(node.name) || isStringLiteral(node.name))
            && node.name.text === name && isArrowFunction(node.initializer)) matches.push(node.initializer.getText(ast))
        forEachChild(node, visit)
      }
      visit(ast)
      expect(matches).toHaveLength(1)
      const code = transpileModule(`(${matches[0]})`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
      return runInNewContext(code, sandbox) as (...args: any[]) => Promise<unknown>
    }
    const ipcCalls: { channel: string; body: Record<string, unknown> }[] = []
    const stops: { sessionId: string; expectedTurnId?: string; origin: string }[] = []
    const reply = { ok: true, accepted: true, confirmed: false, interruptionError: 'Outcome unavailable' }
    const route = arrow(routeSource, 'chat:interrupt', {
      payload: (context: { args: Record<string, unknown>[] }) => context.args[0],
      requiredString: (value: Record<string, unknown>, key: string) => {
        expect(typeof value[key]).toBe('string')
        return value[key] as string
      },
      IpcHandlerError: Error,
      sessions: { interrupt: async (sessionId: string, expectedTurnId: string | undefined, origin: string) => {
        stops.push({ sessionId, expectedTurnId, origin })
        return reply
      } },
    })
    const interrupt = arrow(bridge, 'interrupt', {
      call: async (channel: string, body: Record<string, unknown>) => {
        const serialized = JSON.parse(JSON.stringify(body)) as Record<string, unknown>
        ipcCalls.push({ channel, body: serialized })
        return route({ args: [serialized] })
      },
    })
    for (const expectedTurnId of ['turn-9', undefined, null]) {
      const before = ipcCalls.length
      expect(await interrupt('stop-wire', expectedTurnId)).toEqual(reply)
      expect(ipcCalls).toHaveLength(before + 1)
      expect(stops).toHaveLength(before + 1)
      expect(ipcCalls.at(-1)).toEqual({ channel: 'chat:interrupt', body: {
        sessionId: 'stop-wire', ...(expectedTurnId == null ? {} : { expectedTurnId }),
      } })
      expect(stops.at(-1)).toEqual({ sessionId: 'stop-wire', expectedTurnId: expectedTurnId ?? undefined, origin: 'user-stop' })
    }
    // The store must actually hold a Turn id to send: without it the request is
    // session-wide again and the host has nothing to compare.
    const sessionId = 'stop-names-turn'
    store.ingestLocalUserTurn(sessionId, { text: 'go' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-9' })
    expect(store.getSessionStream(sessionId).activeTurnId).toBe('turn-9')
  })
})

// While a turn runs the composer's primary button hands itself back to submit
// the moment the composer holds content: the press then queues or steers the
// follow-up instead of aborting the turn. The matrix below drives the real
// updateSendBtn() source through every combination the rule names.
describe('stop interaction vectors: running composer submit mode', () => {
  const spec = rule('running-composer-submit-mode')

  function makeFixture() {
    const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
    const cacheStart = chat.indexOf('let composerContinueOffered = false')
    const cacheEnd = chat.indexOf('// Number of live-approval units', cacheStart)
    const functionsStart = chat.indexOf('function sessionContinueMode(')
    const functionsEnd = chat.indexOf('// ==================== Input events', functionsStart)
    for (const index of [cacheStart, cacheEnd, functionsStart, functionsEnd]) expect(index).toBeGreaterThanOrEqual(0)
    const classes = new Set<string>()
    const button = {
      disabled: false, title: '',
      classList: {
        toggle: (name: string, active: boolean) => { if (active) classes.add(name); else classes.delete(name) },
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        add: (name: string) => classes.add(name),
        contains: (name: string) => classes.has(name),
      },
    }
    const sandbox = { currentPendingComposerSubmission: () => undefined,
      voiceChatUi: undefined,
      window: { currentSessionId: 'run', addEventListener: () => {} }, busy: false, composerPredictions: undefined, composerReferenceEntries: () => [], friendSendInFlight: false,
      btnSend: button, creatingGoalSessions: new Set(), stoppingSessions: new Set(), continuingSessions: new Set(),
      continueArmUntil: new Map(), pendingFiles: [] as unknown[],
      followUpQueueMode: 'queue', pendingSendAfterUpload: null as unknown,
      canContinueTurn: () => false,
      hasComposerText: () => inputText.length > 0,
      // `composerContinueMode` consults the active edit; none is open here, which is the
      // running-composer submit path under test.
      hasUploadInFlight: () => uploadInFlight, stopEscArmed: () => escArmed, tt: (key: string) => key,
    }
    let inputText = ''
    let uploadInFlight = false
    let escArmed = false
    const source = [chat.slice(cacheStart, cacheEnd), chat.slice(functionsStart, functionsEnd),
      // Friend compose controls are not under test here; neutralise the module-level
      // refresher so the send/continue role checks do not pull in friend state.
      'function updateFriendComposeControls() {}', '({ updateSendBtn })'].join('\n')
    const code = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.None } }).outputText
    const fixture = runInNewContext(code, sandbox) as { updateSendBtn(): void }
    return {
      classes, button, sandbox,
      run(input: { text?: string; busy?: boolean; stopping?: boolean; mode?: 'queue' | 'steer'; upload?: boolean; parked?: boolean; escArmed?: boolean; files?: number }) {
        inputText = input.text || ''
        uploadInFlight = !!input.upload
        escArmed = !!input.escArmed
        sandbox.busy = !!input.busy
        sandbox.followUpQueueMode = input.mode || 'queue'
        sandbox.pendingSendAfterUpload = input.parked ? { invertFollowUp: false } : null
        sandbox.pendingFiles = new Array(input.files || 0).fill('f')
        if (input.stopping) sandbox.stoppingSessions.add('run'); else sandbox.stoppingSessions.delete('run')
        fixture.updateSendBtn()
        return { runningSubmit: classes.has('running-submit'), disabled: button.disabled, title: button.title, classes }
      },
    }
  }

  test('the mode formula: stop only while the composer is empty', () => {
    expect(spec.klaus.cssClass).toBe('running-submit')
    const f = makeFixture()
    // Running, empty composer: the stop affordance, pressable, labelled Stop.
    let out = f.run({ busy: true })
    expect(out.runningSubmit).toBe(false)
    expect(out.disabled).toBe(false)
    expect(out.title).toBe('submit_tooltip_stop')
    expect(out.classes.has('esc-armed')).toBe(false)
    // Running, text typed: the button hands back to submit.
    out = f.run({ busy: true, text: 'one more thing' })
    expect(out.runningSubmit).toBe(true)
    expect(out.disabled).toBe(false)
    expect(out.title).toBe('submit_tooltip_queue')
    // Attachments alone count as content.
    out = f.run({ busy: true, files: 1 })
    expect(out.runningSubmit).toBe(true)
    // Steer preference names the other action.
    out = f.run({ busy: true, text: 'now', mode: 'steer' })
    expect(out.title).toBe('submit_tooltip_steer')
    // Idle with content is plain send, never the follow-up label.
    out = f.run({ text: 'now' })
    expect(out.runningSubmit).toBe(false)
    expect(out.title).toBe('submit_tooltip_send')
    expect(out.disabled).toBe(false)
    // Idle and empty stays disabled.
    out = f.run({})
    expect(out.disabled).toBe(true)
  })

  test('a stop in flight wins over typed content, and an armed Escape yields to it', () => {
    const f = makeFixture()
    const out = f.run({ busy: true, stopping: true, text: 'queued anyway' })
    expect(out.runningSubmit).toBe(false)
    expect(out.disabled).toBe(true)
    expect(out.title).toBe('submit_tooltip_stopping')
    expect(out.classes.has('esc-armed')).toBe(false)
    // The arm shows on the stop face only: with content the button is a submit,
    // and Escape has nothing to arm on it.
    const armed = f.run({ busy: true, escArmed: true })
    expect(armed.classes.has('esc-armed')).toBe(true)
    const armedWithText = f.run({ busy: true, text: 'x', escArmed: true })
    expect(armedWithText.classes.has('esc-armed')).toBe(false)
  })

  test('a submit parked on an upload keeps breathing and says so', () => {
    const f = makeFixture()
    const out = f.run({ busy: true, text: 'with an image', upload: true, parked: true })
    expect(out.runningSubmit).toBe(true)
    expect(out.classes.has('awaiting-upload')).toBe(true)
    expect(out.title).toBe('submit_tooltip_waiting_upload')
    // Without the parked intent the upload alone must not breathe the button.
    const unparked = f.run({ busy: true, text: 'with an image', upload: true })
    expect(unparked.classes.has('awaiting-upload')).toBe(false)
    expect(unparked.title).toBe('submit_tooltip_queue')
  })

  test('the labels and the face come from committed i18n and CSS', () => {
    expect(I18N.en['submit_tooltip_queue']).toBe('Queue')
    expect(I18N.zh['submit_tooltip_queue']).toBe('排队')
    expect(I18N.en['submit_tooltip_steer']).toBe('Steer')
    expect(I18N.zh['submit_tooltip_steer']).toBe('引导')
    const css = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')
    expect(css).toContain('#send.busy.running-submit .icon-send, :is(#side-send, #left-side-send).busy.running-submit .icon-send { display: block; }')
    expect(css).toContain('#send.busy.running-submit .icon-stop, :is(#side-send, #left-side-send).busy.running-submit .icon-stop { display: none; }')
    expect(css).toContain('#send.busy.running-submit, :is(#side-send, #left-side-send).busy.running-submit {\n  background-color: var(--accent);')
    const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
    // The click on the submit face is a submit; every other busy click is a stop.
    expect(chat).toContain("if (btnSend.classList.contains('running-submit')) void send()")
    expect(chat).toContain("else requestTurnStop(window.currentSessionId || '')")
    // The side composer keeps parity with the main one.
    expect(chat).toContain("if (running && !stopping && hasContent) sideSubmit({ followUp: true })")
    expect(chat).toContain('const runningSubmit = !!running && !stopping && !empty')
  })
})

// The sent-message edit path depends on ONE fact no other suite asserts: after a stop, the
// optimistic bubble is still on screen and carries the turn id that lets the host resolve
// it. Everything else in the edit fix (the pencil rendering, the click resolving by turn)
// is downstream of this. It is proven here rather than assumed, because the DOM harness
// feeds the turnId in by hand and would not notice if the store never stamped it.
describe('a fast stop keeps the optimistic bubble through the idle frame', () => {
  // The host settles its running registry synchronously on the stop click and
  // projects an idle frame BEFORE the engine's interrupted verdict arrives.
  // That idle frame must not clear the interrupted Turn's start stamp or reopen
  // history reads while the live layer still owns the Turn: a disk read that is
  // empty or ahead of the rollout flush would erase the message the user typed
  // (the 2026-10-10 regression: send, stop within a second, bubble gone, only
  // the waiting indicator left).
  function runFastStop(sessionId: string) {
    store.ingestLocalUserTurn(sessionId, { text: 'give the console a quota view' })
    store.ingestChatEvent({ type: 'stream_mode', sessionId, mode: 'requesting', turnId: 'turn-fast' })
    store.requestTurnInterrupt(sessionId)
    // Host stop settlement: idle frame first, interrupted verdict a moment later.
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'idle', turnId: 'turn-fast' })
    return store.getSessionStream(sessionId)
  }

  test('the stop-click idle frame leaves the interrupted Turn untouched', async () => {
    const sessionId = 'fast-stop-idle-frame'
    const state = runFastStop(sessionId)
    expect(state.running).toBe(true)
    expect(state.stopRequestedAt).not.toBe(null)
    expect(state.liveUnits.some(unit => unit.type === 'live-user')).toBe(true)
    // The stamp the stopped label reads its duration from must survive.
    expect(state.turnStartedAt).not.toBe(0)
    await flush()
    const after = store.getSessionStream(sessionId)
    expect(after.liveUnits.some(unit => unit.type === 'live-user')).toBe(true)
    expect(after.historyStale).toBe(false)
  })

  test('a pre-flush empty history read cannot erase the stopped turn', async () => {
    const sessionId = 'fast-stop-empty-read'
    runFastStop(sessionId)
    store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'turn-fast' }, { userInterrupted: true })
    // The rollout has not flushed yet: the transcript's own reload still reads
    // nothing from disk. The frozen handoff must keep the live layer instead of
    // treating the empty capture as the whole conversation.
    await store.loadSessionHistory(sessionId)
    await flush()
    const state = store.getSessionStream(sessionId)
    expect(state.liveUnits.some(unit => unit.type === 'live-user')).toBe(true)
    expect(state.interruptedLiveTurn).not.toBe(null)
  })

  test('the interrupted verdict still settles the turn after the idle frame', () => {
    const sessionId = 'fast-stop-settles'
    runFastStop(sessionId)
    store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: 'turn-fast' }, { userInterrupted: true })
    const state = store.getSessionStream(sessionId)
    expect(state.running).toBe(false)
    expect(state.interruptedLiveTurn).toEqual({ turnId: 'turn-fast' })
    expect(state.liveUnits.some(unit => unit.type === 'live-user')).toBe(true)
    expect(state.liveUnits.some(unit => unit.type === 'live-turn-status')).toBe(true)
  })
})

describe('a stopped turn leaves an addressable optimistic bubble', () => {
  test('the live user bubble keeps its turn id after the interrupt', () => {
    const state = runStoppedTurn('stopped-addressable', 'text', 'turn-42')
    const bubble = state.liveUnits.find(unit => unit.type === 'live-user')
    expect(bubble).toBeDefined()
    // The engine assigns the message uuid and no event carries it back, so the bubble has
    // none — the turn id is the only handle the host can resolve it by.
    expect((bubble as { msg?: { uuid?: unknown } })?.msg?.uuid).toBeFalsy()
    expect(bubble?.turnId).toBe('turn-42')
  })

  test('the transcript names that bubble as the edit target, by turn', () => {
    const state = runStoppedTurn('stopped-target', 'text', 'turn-7')
    const liveUsers = state.liveUnits
      .filter(unit => unit.type === 'live-user')
      .map(unit => ({ type: unit.type, turnId: unit.turnId, msg: (unit as { msg?: { uuid?: string } }).msg }))
    // History is deliberately NOT reloaded after a stop, so it still ends at the PREVIOUS
    // message. Reading it alone would name that one — the bug this fixes.
    const settledHistory = [{ type: 'user', key: 'u-prev', msg: { uuid: 'u-prev' }, turnId: 'turn-old' }]
    const target = editTargetFor(settledHistory as never, liveUsers as never)
    expect(target).toEqual({ uuid: '', turnId: 'turn-7' })
  })

  test('once history takes over, the same message is addressed by its uuid', () => {
    // The handoff: a completed turn reloads history, so the newest row gains a real uuid.
    // The edit target must follow it rather than keep naming a turn that no longer exists.
    const settled = [
      { type: 'user', key: 'u1', msg: { uuid: 'u1' }, turnId: 'turn-1' },
      { type: 'user', key: 'u2', msg: { uuid: 'u2' }, turnId: 'turn-2' },
    ]
    expect(editTargetFor(settled as never, [])).toEqual({ uuid: 'u2', turnId: 'turn-2' })
  })
})
