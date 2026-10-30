import { describe, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/sent-message-edit-vectors.json'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en' }
const store = await import('./stream-store')
type Snapshot = import('./stream-store').EditedUserTurnSnapshot

function accept(sessionId: string, snapshot: Snapshot, payload: typeof vectors.display | { text: string }): void {
  store.commitEditedUserTurn(sessionId, snapshot, payload)
}

function stopped(sessionId: string) {
  store.ingestLocalUserTurn(sessionId, { text: vectors.original.text })
  store.ingestChatEvent({ type: 'stream_mode', sessionId, turnId: vectors.original.turnId, mode: 'requesting' })
  store.ingestChatEvent({ type: 'interrupted', sessionId, turnId: vectors.original.turnId }, { userInterrupted: true })
  const before = store.getSessionStream(sessionId)
  return store.observeEditedUserTurn(sessionId, vectors.original, new Set(before.liveUnits.map(unit => unit.key)))
}

function replacementEvent(sessionId: string, event: string): void {
  const base = { sessionId, turnId: vectors.replacement.turnId }
  if (event === 'requesting') {
    // The lifecycle frame opens the replacement turn; activity frames alone no longer do.
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: base.turnId })
    store.ingestChatEvent({ ...base, type: 'stream_mode', mode: 'requesting',
      inference: { revision: 2, model: 'fixture-model' } })
  }
  if (event === 'thinking') store.ingestChatEvent({ ...base, type: 'thinking_delta', thinking: 'New thinking' })
  if (event === 'text') store.ingestChatEvent({ ...base, type: 'text_delta', text: 'New reply' })
  if (event === 'tool') store.ingestChatEvent({ ...base, type: 'tool_start', toolCallId: 'new-tool', toolName: 'Read', args: {} })
  if (event === 'failed') store.ingestChatEvent({ ...base, type: 'api_error', terminal: true, error: 'Provider failed', kind: 'provider' })
  if (event === 'done' || event === 'interrupted') store.ingestChatEvent({ ...base, type: event }, { userInterrupted: event === 'interrupted' })
}

describe('accepted sent-message edit transcript', () => {
  for (const vector of vectors.cases) test(vector.name, async () => {
    const sessionId = `edit-stream-${vector.name}`
    const window = (globalThis as any).window
    const previous = window.klaus
    let resolveHistory!: (value: unknown) => void
    let dispose = () => {}
    try {
      window.klaus = { session: { history: () => new Promise(resolve => { resolveHistory = resolve }) } }
      const observation = stopped(sessionId)
      dispose = observation.dispose
      const { snapshot } = observation
      for (const event of vector.events) replacementEvent(sessionId, event)
      const beforeAck = store.getSessionStream(sessionId)
      accept(sessionId, snapshot, { text: vectors.replacement.text })
      const after = store.getSessionStream(sessionId)
      expect(after.running).toBe(vector.running)
      expect(after.lastTerminalStatus).toBe(vector.terminal)
      expect(after.liveUnits[0]).toMatchObject({ type: 'live-user', msg: { text: vectors.replacement.text } })
      expect(after.liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(1)
      expect(after.liveUnits.some(unit => snapshot.droppedKeys.has(unit.key))).toBe(false)
      if (vector.events.length) {
        expect(after.liveUnits[0].turnId).toBe(vectors.replacement.turnId)
        expect(after.activeTurnId).toBe(beforeAck.activeTurnId)
        expect(after.currentInference).toBe(beforeAck.currentInference)
        expect(after.thinkingText).toBe(beforeAck.thinkingText)
        expect(after.thinkingActive).toBe(beforeAck.thinkingActive)
        expect(after.turnStartedAt).toBe(beforeAck.turnStartedAt)
      }
      if (vector.events.includes('text')) {
        expect(after.liveUnits[1]).toMatchObject({ type: 'live-text', text: 'New reply' })
        if (vector.running) {
          replacementEvent(sessionId, 'text')
          expect(store.getSessionStream(sessionId).liveUnits.filter(unit => unit.type === 'live-text')).toHaveLength(1)
          expect(store.getSessionStream(sessionId).liveUnits[1]).toMatchObject({ text: 'New replyNew reply', streaming: true })
        }
      }
      if (vector.events.includes('tool')) expect(after.tools['new-tool'].status).toBe('running')
      if (resolveHistory) {
        resolveHistory({ messages: [] })
        await store.loadSessionHistory(sessionId)
        expect(store.getSessionStream(sessionId).liveUnits[0]).toMatchObject({ type: 'live-user', msg: { text: vectors.replacement.text } })
        expect(store.getSessionStream(sessionId).lastTerminalStatus).toBe(vector.terminal)
      }
    } finally { dispose(); window.klaus = previous }
  })

  test('a late read of earlier history cannot be mistaken for the replacement turn', async () => {
    const sessionId = 'edit-earlier-history-race'
    const window = (globalThis as any).window
    const previous = window.klaus
    let dispose = () => {}
    try {
      const observation = stopped(sessionId)
      dispose = observation.dispose
      window.klaus = { session: { history: async () => ({ messages: [vectors.earlier,
        { ...vectors.original, role: 'user' }] }) } }
      await store.loadSessionHistory(sessionId)
      accept(sessionId, observation.snapshot, { text: vectors.replacement.text })
      const after = store.getSessionStream(sessionId)
      expect(after.history).toEqual([vectors.earlier])
      expect(after.running).toBe(true)
      expect(after.lastTerminalStatus).toBeNull()
      expect(after.liveUnits[0]).toMatchObject({ type: 'live-user', msg: { text: vectors.replacement.text } })
      expect(after.liveUnits[0].turnId).toBeUndefined()
      replacementEvent(sessionId, 'requesting')
      expect(store.getSessionStream(sessionId).liveUnits[0].turnId).toBe(vectors.replacement.turnId)
    } finally { dispose(); window.klaus = previous }
  })

  for (const vector of vectors.laggingHistory) test(`${vector.name} keeps its bubble through lagging history before and after ACK`, async () => {
    const sessionId = `edit-lagging-history-${vector.name}`
    const window = (globalThis as any).window
    const previous = window.klaus
    let dispose = () => {}
    let saved = false
    const messages = [{ ...vectors.replacement, role: 'user' }]
    try {
      window.klaus = { session: { history: async () => ({ messages: saved ? messages : [] }) } }
      const observation = stopped(sessionId)
      dispose = observation.dispose
      for (const event of vector.events) replacementEvent(sessionId, event)
      await store.loadSessionHistory(sessionId)
      accept(sessionId, observation.snapshot, { text: vectors.replacement.text })
      observation.dispose()
      await store.loadSessionHistory(sessionId)
      const after = store.getSessionStream(sessionId)
      expect(after.running).toBe(false)
      expect(after.lastTerminalStatus).toBe(vector.terminal)
      expect(after.liveUnits[0]).toMatchObject({ type: 'live-user', turnId: vectors.replacement.turnId,
        msg: { text: vectors.replacement.text } })
      if (vector.events.includes('text')) expect(after.liveUnits[1]).toMatchObject({ type: 'live-text', text: 'New reply' })
      saved = true
      await store.loadSessionHistory(sessionId)
      expect(store.getSessionStream(sessionId).liveUnits).toEqual([])
      expect(store.getSessionStream(sessionId).history).toEqual([
        { ...messages[0], localRender: vectors.defaultLocalRender },
      ])
      expect(store.getSessionStream(sessionId).running).toBe(false)
    } finally { dispose(); window.klaus = previous }
  })

  test('disposing a refused edit leaves the original transcript unchanged', () => {
    const sessionId = 'edit-refused'
    const observation = stopped(sessionId)
    const before = store.getSessionStream(sessionId)
    observation.dispose()
    expect(store.getSessionStream(sessionId)).toBe(before)
    replacementEvent(sessionId, 'requesting')
    expect(observation.snapshot.replacementTurnId).toBeNull()
  })

  test('removes the edited history tail while preserving earlier messages and display metadata', async () => {
    const sessionId = 'edit-history-tail'
    const window = (globalThis as any).window
    const previous = window.klaus
    let dispose = () => {}
    try {
      const original = { ...vectors.original, role: 'user' }
      window.klaus = { session: { history: async () => ({ messages: [vectors.earlier, original] }) } }
      await store.loadSessionHistory(sessionId)
      const observation = store.observeEditedUserTurn(sessionId, vectors.original, new Set<string>())
      dispose = observation.dispose
      replacementEvent(sessionId, 'requesting')
      accept(sessionId, observation.snapshot, vectors.display)
      const after = store.getSessionStream(sessionId)
      expect(after.history).toEqual([vectors.earlier])
      expect(after.liveUnits[0]).toMatchObject({ type: 'live-user', msg: {
        text: vectors.display.text, localRender: {
          displayText: vectors.display.displayText, attachments: vectors.display.attachments,
          slashCommand: vectors.display.slashCommand, composerReferences: vectors.display.composerReferences,
          composerDocument: vectors.display.composerDocument,
          pastedCards: vectors.display.pastedCards, selectedTextAttachments: vectors.display.selectedTextAttachments,
        },
      } })
    } finally { dispose(); window.klaus = previous }
  })

  for (const vector of vectors.laggingHistory) test(`a ${vector.terminal} replacement already handed to history is not duplicated or restarted`, async () => {
    const sessionId = `edit-${vector.terminal}-history`
    const window = (globalThis as any).window
    const previous = window.klaus
    let dispose = () => {}
    try {
      const observation = stopped(sessionId)
      dispose = observation.dispose
      const messages = [{ ...vectors.replacement, role: 'user' },
        { uuid: 'reply', role: 'assistant', turnId: vectors.replacement.turnId, text: 'New reply' }]
      window.klaus = { session: { history: async () => ({ messages }) } }
      for (const event of vector.events) replacementEvent(sessionId, event)
      await store.loadSessionHistory(sessionId)
      expect(store.getSessionStream(sessionId).liveUnits).toEqual([])
      expect(store.getSessionStream(sessionId).history).toEqual(messages)
      accept(sessionId, observation.snapshot, { text: vectors.replacement.text })
      const after = store.getSessionStream(sessionId)
      expect(after.history).toEqual([{ ...messages[0], localRender: vectors.defaultLocalRender }, messages[1]])
      expect(after.liveUnits).toEqual([])
      expect(after.running).toBe(false)
      expect(after.lastTerminalStatus).toBe(vector.terminal)
      await store.loadSessionHistory(sessionId)
      expect(store.getSessionStream(sessionId).history).toEqual(after.history)
    } finally { dispose(); window.klaus = previous }
  })

  for (const vector of vectors.laggingHistory) {
    for (const ackFirst of [true, false]) test(`${vector.name} preserves edited display metadata with ACK ${ackFirst ? 'before' : 'after'} history`, async () => {
      const sessionId = `edit-display-${vector.name}-${ackFirst}`
      const window = (globalThis as any).window
      const previous = window.klaus
      let dispose = () => {}
      let saved = false
      const messages = [{ ...vectors.replacement, role: 'user', text: vectors.display.text }]
      const { text: _text, ...display } = vectors.display
      try {
        window.klaus = { session: { history: async () => ({ messages: saved ? messages : [] }) } }
        const observation = stopped(sessionId)
        dispose = observation.dispose
        if (ackFirst) accept(sessionId, observation.snapshot, vectors.display)
        for (const event of vector.events) replacementEvent(sessionId, event)
        await store.loadSessionHistory(sessionId)
        if (ackFirst) {
          const after = store.getSessionStream(sessionId)
          expect(after.liveUnits.filter(unit => unit.type === 'live-user')).toHaveLength(1)
          expect(after.liveUnits[0]).toMatchObject({ msg: { text: vectors.display.text, localRender: display } })
        }
        saved = true
        await store.loadSessionHistory(sessionId)
        if (!ackFirst) accept(sessionId, observation.snapshot, vectors.display)
        const after = store.getSessionStream(sessionId)
        expect(after.history).toEqual([{ ...messages[0], localRender: display }])
        expect(after.liveUnits).toEqual([])
        expect(after.running).toBe(false)
        expect(after.lastTerminalStatus).toBe(vector.terminal)
        await store.loadSessionHistory(sessionId)
        expect(store.getSessionStream(sessionId).history).toEqual(after.history)
      } finally { dispose(); window.klaus = previous }
    })
  }

  for (const position of ['before', 'after']) test(`ACK removes an unidentified original snapshot ${position} saved replacement without truncating later turns`, async () => {
    const sessionId = `edit-retained-original-${position}`
    const window = (globalThis as any).window
    const previous = window.klaus
    let dispose = () => {}
    try {
      const observation = stopped(sessionId)
      dispose = observation.dispose
      const messages = [vectors.earlier, { ...vectors.replacement, role: 'user' },
        { uuid: 'later-user', turnId: 'later-turn', role: 'user', text: vectors.original.text }]
      window.klaus = { session: { history: async () => ({ messages }) } }
      replacementEvent(sessionId, 'requesting')
      replacementEvent(sessionId, 'done')
      await store.loadSessionHistory(sessionId)
      // A prior handoff may already have retained the original row without a UUID.
      store.chatStreamStore.setState(state => {
        const stream = state.sessions[sessionId]
        const history = [...stream.history!]
        history.splice(position === 'before' ? 1 : history.length, 0, {
          role: 'user', turnId: vectors.original.turnId, text: vectors.original.text, userRenderSnapshot: true,
        })
        return { sessions: { ...state.sessions, [sessionId]: { ...stream, history } } }
      })
      accept(sessionId, observation.snapshot, { text: vectors.replacement.text })
      const after = store.getSessionStream(sessionId)
      expect(after.history).toEqual([
        messages[0], { ...messages[1], localRender: vectors.defaultLocalRender }, messages[2],
      ])
      expect(after.liveUnits).toEqual([])
      expect(after.running).toBe(false)
      expect(after.lastTerminalStatus).toBe('completed')
    } finally { dispose(); window.klaus = previous }
  })

  for (const savedDisplay of [true, false]) test(`history before ACK ${savedDisplay ? 'retains saved display metadata' : 'rejects display metadata for different text'}`, async () => {
    const sessionId = `edit-saved-display-${savedDisplay}`
    const window = (globalThis as any).window
    const previous = window.klaus
    let dispose = () => {}
    try {
      const observation = stopped(sessionId)
      dispose = observation.dispose
      const messages = [{ ...vectors.replacement, role: 'user',
        ...(savedDisplay ? { text: vectors.display.text, localRender: { displayText: 'Saved display' } } : {}),
      }]
      window.klaus = { session: { history: async () => ({ messages }) } }
      replacementEvent(sessionId, 'requesting')
      replacementEvent(sessionId, 'done')
      await store.loadSessionHistory(sessionId)
      accept(sessionId, observation.snapshot, vectors.display)
      const after = store.getSessionStream(sessionId)
      expect(after.history).toEqual(messages)
      expect(after.liveUnits).toEqual([])
      expect(after.running).toBe(false)
    } finally { dispose(); window.klaus = previous }
  })

  test('a late edit ACK preserves a later active turn without duplicating its saved replacement', async () => {
    const sessionId = 'edit-ack-after-next-turn'
    const window = (globalThis as any).window
    const previous = window.klaus
    let dispose = () => {}
    try {
      const observation = stopped(sessionId)
      dispose = observation.dispose
      const messages = [{ ...vectors.replacement, role: 'user' }]
      window.klaus = { session: { history: async () => ({ messages }) } }
      replacementEvent(sessionId, 'requesting')
      replacementEvent(sessionId, 'done')
      await store.loadSessionHistory(sessionId)
      store.ingestLocalUserTurn(sessionId, { uuid: 'later-user', text: 'Next request' })
      store.ingestChatEvent({ type: 'session_runtime_status', sessionId, status: 'active', turnId: 'later-turn' })
      store.ingestChatEvent({ type: 'text_delta', sessionId, turnId: 'later-turn', text: 'Next reply' })
      const before = store.getSessionStream(sessionId)
      accept(sessionId, observation.snapshot, { text: vectors.replacement.text })
      const after = store.getSessionStream(sessionId)
      expect(after.history).toEqual([{ ...messages[0], localRender: vectors.defaultLocalRender }])
      expect(after.liveUnits).toEqual(before.liveUnits)
      expect(after.activeTurnId).toBe('later-turn')
      expect(after.running).toBe(true)
      expect(after.lastTerminalStatus).toBe(before.lastTerminalStatus)
    } finally { dispose(); window.klaus = previous }
  })
})

describe('a steer this renderer sent', () => {
  // A mid-turn follow-up is drawn locally before the host answers. The canonical
  // `user_message` frame that carries `steered` is skipped once that bubble holds the
  // same uuid, so the flag has to be set at paint time. Without it the stopped turn's
  // live bubble looks like a turn opener and Edit lands on a row the host refuses.
  test('is painted with the steered flag', () => {
    const sessionId = 'edit-local-steer-flag'
    store.ingestLocalUserTurn(sessionId, { uuid: 'opener-1', text: 'Opening question' })
    store.ingestLocalUserTurn(sessionId, { uuid: 'steer-1', text: 'Mid-turn follow-up', steered: true })
    const live = store.getSessionStream(sessionId).liveUnits
    const steer = live.find(unit => unit.type === 'live-user' && unit.msg.uuid === 'steer-1')
    expect((steer as any)?.msg.steered).toBe(true)
  })

  test('takes the canonical flag when the host frame lands after the local bubble', () => {
    const sessionId = 'edit-local-steer-merge'
    store.ingestLocalUserTurn(sessionId, { uuid: 'steer-2', text: 'Typed while the turn ran' })
    store.ingestChatEvent({ type: 'user_message', sessionId, turnId: 'turn-1',
      message: { uuid: 'steer-2', message: { content: 'Typed while the turn ran', steered: true } } })
    const live = store.getSessionStream(sessionId).liveUnits
    expect(live).toHaveLength(1)
    expect((live[0] as any).msg.steered).toBe(true)
  })
})
