import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import vector from '../../../../contracts/vectors/async-user-question-vectors.json'
import type { AsyncQuestionRequest } from './async-question-state'
import { closeAsyncQuestionPanel, declineAsyncQuestion, editAsyncQuestion, openAsyncQuestion } from './async-question-state'
import type { ApprovalsDeps } from '../approvals'
import { liveApprovalsOf } from '../sidebar/attention'
import { createSidePaneComposerFixture } from '../test-support/side-pane-composer-fixture'

let previousWindow: any
let stream: typeof import('../stream-store')
let controller: typeof import('./async-question-controller')
let view: typeof import('./async-question-view')
let transcript: typeof import('./TranscriptView')
let cards: typeof import('./approval-cards')
beforeAll(async () => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = { ...previousWindow, addEventListener() {}, currentLang: 'en', klaus: { question: {} } }
  stream = await import('../stream-store')
  cards = await import('./approval-cards')
  controller = await import('./async-question-controller')
  view = await import('./async-question-view')
  transcript = await import('./TranscriptView')
})
afterAll(() => { (globalThis as any).window = previousWindow })
let sequence = 0
function begin(recovered = false): AsyncQuestionRequest {
  const sessionId = `async-fixture-${++sequence}`
  const request = { ...vector.request, sessionId } as AsyncQuestionRequest
  stream.ingestAsyncQuestion(request, recovered)
  return request
}
function edit(request: AsyncQuestionRequest, values: string[]) {
  stream.updateAsyncQuestionUi(request.sessionId, ui => editAsyncQuestion(ui, request.requestId, {
    ...ui.requests[request.requestId].draft, answers: values.map(text => ({ selected: [], text })),
  }))
}
function renderRequest(request: AsyncQuestionRequest, panel = false, readOnly = false) {
  const initial = stream.chatStreamStore.getInitialState()
  const previous = initial.sessions
  initial.sessions = stream.chatStreamStore.getState().sessions
  try { return renderToStaticMarkup(panel ? <view.AsyncQuestionComposer sessionId={request.sessionId} />
    : <view.AsyncQuestionText request={request} sessionId={request.sessionId} readOnly={readOnly} />) }
  finally { initial.sessions = previous }
}
const metadata = (request: AsyncQuestionRequest, answers = vector.partialAnswer) => ({ ...vector.answerMetadata, ...request, questions: request.toolInput.questions, answers })

describe('asynchronous question lifecycle', () => {
  test('new panel exposes empty selection, header and an independent Send without dictation', () => {
    const request = begin()
    const panel = renderRequest(request, true)
    expect(panel).toContain('Question</span>')
    expect(panel).toContain('Which format?')
    // Both modes share one placeholder; the reply field never offered dictation.
    expect(panel).toContain('placeholder="Type your answer…"')
    expect(panel).toContain('Send</button>')
    expect(panel).not.toContain('aria-label="Voice input"')
    expect(panel).toContain('aria-label="Attach file"')
    expect(panel).not.toContain('aria-checked="true"')
    expect(renderRequest(request)).not.toContain('Answer question')
    expect(stream.getSessionStream(request.sessionId).running).toBe(true)
  })
  test('Send advertises the submit shortcut only when it submits the panel', () => {
    const request = begin()
    // A multi-question panel parked on its first question: Send only advances,
    // while the shortcut submits every answered question, so the two disagree and
    // the button must not claim the key.
    expect(renderRequest(request, true)).toContain('>Send</button>')
    expect(renderRequest(request, true)).not.toContain('aria-keyshortcuts')
    // A single-question panel, the shape a reopened transcript chip produces:
    // Send submits, so it carries the same hint the blocking card's Submit does.
    stream.updateAsyncQuestionUi(request.sessionId, ui => openAsyncQuestion(ui, { requestId: request.requestId, index: 1 }))
    const single = renderRequest(request, true)
    expect(single).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
    expect(single).toContain('⌘ / Ctrl ↵</span></button>')
  })
  test('minimized chips reopen only their original question and read-only copies offer no action', () => {
    const request = begin()
    edit(request, ['saved first draft', ''])
    stream.updateAsyncQuestionUi(request.sessionId, closeAsyncQuestionPanel)
    expect(renderRequest(request).match(/Answer question/g)).toHaveLength(2)
    expect(renderRequest(request, false, true)).not.toContain('Answer question')
    stream.updateAsyncQuestionUi(request.sessionId, ui => openAsyncQuestion(ui, { requestId: request.requestId, index: 1 }))
    expect(renderRequest(request, true)).toContain('Which details?')
    expect(renderRequest(request).match(/Answer question/g)).toHaveLength(1)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId].draft.answers[0].text).toBe('saved first draft')
  })
  test('reading the native clipboard keeps the answer field editable and still blocks sending', () => {
    const request = begin()
    // A plain-text paste probes the native clipboard for file paths. The probe is
    // synchronous with the paste event, so a field disabled by it is disabled
    // before the browser runs its default insertion and the pasted text is lost.
    stream.updateAsyncQuestionUi(request.sessionId, ui => editAsyncQuestion(ui, request.requestId, {
      ...ui.requests[request.requestId].draft, answers: [{ selected: [], text: 'typed while probing' }], readingClipboard: true,
    }))
    const panel = renderRequest(request, true)
    const field = panel.match(/<textarea[^>]*aria-label="Other \(specify\)"[\s\S]*?<\/textarea>/)?.[0] ?? ''
    expect(field).toContain('typed while probing')
    expect(field).not.toContain('disabled')
    expect(panel).toContain('Reading clipboard…')
    const send = panel.match(/<button[^>]*>Send<\/button>/)?.[0] ?? ''
    expect(send).toContain('disabled')
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId].draft.readingClipboard).toBe(true)
  })
  test('a reopened question submits its own text and leaves other unsent drafts pending', async () => {
    const request = begin()
    edit(request, ['do not submit this draft', 'late reply'])
    stream.updateAsyncQuestionUi(request.sessionId, ui => openAsyncQuestion(ui, { requestId: request.requestId, index: 1 }))
    const calls: any[] = []
    ;(window.klaus.question as any).answer = async (...args: any[]) => { calls.push(args); return { accepted: true, state: 'pending' } }
    await controller.submitAsyncQuestionPanel(request.sessionId)
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(0, 3)).toEqual([request.sessionId, request.requestId, request.turnId])
    expect(calls[0][4]).toEqual({ 'Which details?': 'late reply' })
    const row = stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId]
    expect(row.answers).toEqual({ 'Which details?': 'late reply' })
    expect(row.draft.answers[0].text).toBe('do not submit this draft')
  })
  test('failed answers retain drafts, retries use the same identity, changed replies use a fresh identity', async () => {
    const request = begin()
    edit(request, ['answer to retry', ''])
    const ids: string[] = []
    ;(window.klaus.question as any).answer = async (_s: string, _r: string, _t: string, id: string) => { ids.push(id); throw new Error('connection lost') }
    await controller.submitAsyncQuestionPanel(request.sessionId).then(() => { throw new Error('Expected submission failure') }, cause => { expect(cause.message).toBe('connection lost') })
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel).not.toBeNull()
    await controller.submitAsyncQuestionPanel(request.sessionId).then(() => { throw new Error('Expected submission failure') }, cause => { expect(cause.message).toBe('connection lost') })
    expect(ids[1]).toBe(ids[0])
    edit(request, ['changed answer', ''])
    await controller.submitAsyncQuestionPanel(request.sessionId).then(() => { throw new Error('Expected submission failure') }, cause => { expect(cause.message).toBe('connection lost') })
    expect(ids[2]).not.toBe(ids[0])
  })
  test('all queued payloads are captured at Send, before preceding RPCs complete', async () => {
    const first = begin()
    const second = { ...first, requestId: 'second-request', toolCallId: 'second-tool' }
    stream.ingestAsyncQuestion(second)
    edit(first, ['first reply', ''])
    edit(second, ['second snapshot', ''])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: any[] = []
    ;(window.klaus.question as any).answer = async (...args: any[]) => {
      calls.push(args)
      if (args[1] === first.requestId) await gate
      return { accepted: true, state: 'pending' }
    }
    const submitting = controller.submitAsyncQuestionPanel(first.sessionId)
    edit(second, ['new draft after Send', ''])
    release()
    await submitting
    expect(calls[1][4]).toEqual({ 'Which format?': 'second snapshot' })
  })
  test('an interrupted submission cannot block or close the next turn panel', async () => {
    const first = begin()
    edit(first, ['first reply', ''])
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    const calls: any[] = []
    ;(window.klaus.question as any).answer = async (...args: any[]) => {
      calls.push(args)
      await (args[2] === first.turnId ? firstGate : secondGate)
      return { accepted: true, state: 'pending' }
    }
    const oldSubmission = controller.submitAsyncQuestionPanel(first.sessionId)
    stream.ingestChatEvent({ type: 'done', sessionId: first.sessionId, turnId: first.turnId })
    const second = { ...first, turnId: 'next-turn', requestId: 'next-request', toolCallId: 'next-tool' }
    stream.ingestAsyncQuestion(second)
    edit(second, ['next reply', ''])
    const panelId = stream.getSessionStream(second.sessionId).asyncQuestions.panel!.id
    const newSubmission = controller.submitAsyncQuestionPanel(second.sessionId)
    expect(calls.map(args => args[2])).toEqual([first.turnId, second.turnId])
    releaseFirst()
    await oldSubmission
    expect(stream.getSessionStream(second.sessionId).asyncQuestions.panel?.id).toBe(panelId)
    expect(stream.getSessionStream(second.sessionId).asyncQuestions.submittingTurnId).toBe(second.turnId)
    releaseSecond()
    await newSubmission
    expect(stream.getSessionStream(second.sessionId).asyncQuestions.requests[second.requestId].answers).toEqual({ 'Which format?': 'next reply' })
  })
  test('finishing an older panel submission leaves a newly reopened sibling panel open', async () => {
    const request = begin()
    edit(request, ['first reply', ''])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ;(window.klaus.question as any).answer = async () => { await gate; return { accepted: true, state: 'pending' } }
    const submitting = controller.submitAsyncQuestionPanel(request.sessionId)
    stream.updateAsyncQuestionUi(request.sessionId, ui => openAsyncQuestion(ui, { requestId: request.requestId, index: 1 }))
    const panelId = stream.getSessionStream(request.sessionId).asyncQuestions.panel!.id
    release()
    await submitting
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel?.id).toBe(panelId)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel?.items).toEqual([{ requestId: request.requestId, index: 1 }])
  })
  test('a question arriving during Send remains open after the earlier answer completes', async () => {
    const first = begin()
    edit(first, ['first reply', ''])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ;(window.klaus.question as any).answer = async () => { await gate; return { accepted: true, state: 'pending' } }
    const submitting = controller.submitAsyncQuestionPanel(first.sessionId)
    const second = { ...first, requestId: 'newly-arrived', toolCallId: 'newly-arrived-tool' }
    stream.ingestAsyncQuestion(second)
    release()
    await submitting
    const panel = stream.getSessionStream(first.sessionId).asyncQuestions.panel
    expect(panel?.items.some(item => item.requestId === second.requestId)).toBe(true)
  })
  test('pending recovery before first history load retains the complete saved running turn', async () => {
    const request = begin(true)
    let reads = 0
    const messages = [{ role: 'user', text: 'Original request', uuid: 'opener', turnId: request.turnId },
      { role: 'assistant', text: 'Earlier commentary', uuid: 'comment', turnId: request.turnId, phase: 'commentary' }]
    ;(window.klaus as any).session = { history: async () => { reads++; return { messages } } }
    await stream.loadSessionHistory(request.sessionId)
    expect(reads).toBe(1)
    expect(stream.getSessionStream(request.sessionId).history?.map(message => message.text)).toEqual(messages.map(message => message.text))
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel).toBeNull()
    expect(renderRequest(request)).toContain('Answer question')
  })
  test('late recovery cannot revive a terminal owner or insert a question into the next turn', () => {
    const request = begin()
    stream.ingestChatEvent({ type: 'done', sessionId: request.sessionId, turnId: request.turnId })
    stream.ingestAsyncQuestion(request, true)
    expect(stream.getSessionStream(request.sessionId).running).toBe(false)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId].state).toBe('expired')
    expect(renderRequest(request)).not.toContain('Answer question')
  })
  test('a stale pending read cannot revive a request that was absent when its owner completed', () => {
    const request = begin(true)
    stream.updateAsyncQuestionUi(request.sessionId, ui => ({ ...ui, requests: {} }))
    stream.ingestChatEvent({ type: 'done', sessionId: request.sessionId, turnId: request.turnId })
    // History handoff may clear liveTurnId, while the terminal boundary still owns rejection.
    stream.chatStreamStore.setState(state => ({ sessions: { ...state.sessions, [request.sessionId]: { ...state.sessions[request.sessionId], liveTurnId: null } } }))
    stream.ingestAsyncQuestion(request, true)
    expect(stream.getSessionStream(request.sessionId).running).toBe(false)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId]).toBeUndefined()
  })
  test('an authoritative empty pending snapshot removes a missed chip without closing sibling turns', async () => {
    const request = begin()
    const approvals = await import('../approvals')
    ;(window.klaus as any).permission = { pending: async () => [] }
    ;(window.klaus as any).elicit = { pending: async () => [] }
    ;(window.klaus.question as any).pending = async () => []
    await approvals.restorePendingPermissions(request.sessionId)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId].state).toBe('expired')
    expect(stream.getSessionStream(request.sessionId).running).toBe(true)
    expect(renderRequest(request)).not.toContain('Answer question')
  })
  test('editing during recovery does not override an authoritative missing request', async () => {
    const request = begin()
    const approvals = await import('../approvals')
    ;(window.klaus as any).permission = { pending: async () => [] }
    ;(window.klaus as any).elicit = { pending: async () => [] }
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    ;(window.klaus.question as any).pending = async () => { await gate; return [] }
    const recovery = approvals.restorePendingPermissions(request.sessionId)
    edit(request, ['keep my draft', ''])
    release()
    await recovery
    const ui = stream.getSessionStream(request.sessionId).asyncQuestions
    expect(ui.requests[request.requestId].state).toBe('expired')
    expect(ui.restoredDrafts).toEqual([{ turnId: request.turnId, text: 'keep my draft' }])
  })
  test('resolutions received before recovery prevent stale completed chips and retain partial answers', () => {
    for (const state of ['answered', 'pending'] as const) {
      const request = { ...vector.request, sessionId: `async-fixture-${++sequence}` } as AsyncQuestionRequest
      stream.ingestAsyncQuestionResolution({ sessionId: request.sessionId, requestId: request.requestId, turnId: request.turnId, state, answers: vector.partialAnswer })
      stream.ingestAsyncQuestion(request, true)
      const row = stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId]
      expect(row.state).toBe(state)
      expect(row.answers).toEqual(vector.partialAnswer)
      expect(renderRequest(request).match(/Answer question/g)?.length || 0).toBe(state === 'pending' ? 1 : 0)
      expect(stream.getSessionStream(request.sessionId).running).toBe(state === 'pending')
    }
  })
  test('a terminal resolution arriving before recovery never revives a running turn', () => {
    const request = { ...vector.request, sessionId: `async-fixture-${++sequence}` } as AsyncQuestionRequest
    stream.ingestAsyncQuestionResolution({ sessionId: request.sessionId, requestId: request.requestId, turnId: request.turnId, state: 'expired', answers: {} })
    stream.ingestAsyncQuestion(request, true)
    expect(stream.getSessionStream(request.sessionId).running).toBe(false)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId]).toBeUndefined()
  })
  test('a durable answer settled during cancellation restores only other unsent replies', () => {
    const request = begin()
    edit(request, ['accepted during cancellation', 'unsent second reply'])
    stream.ingestAsyncQuestionResolution({ sessionId: request.sessionId, requestId: request.requestId, turnId: request.turnId,
      state: 'cancelled', answers: { 'Which format?': 'accepted during cancellation' } })
    const ui = stream.getSessionStream(request.sessionId).asyncQuestions
    expect(ui.requests[request.requestId].state).toBe('cancelled')
    expect(ui.requests[request.requestId].answers).toEqual({ 'Which format?': 'accepted during cancellation' })
    expect(ui.restoredDrafts).toEqual([{ turnId: request.turnId, text: 'unsent second reply' }])
  })
  test('answer events retain typed attribution once and render a native quoted user bubble', () => {
    const request = begin()
    const message = { uuid: 'answer-uuid', timestamp: '2026-10-04T00:00:00Z', message: { content: 'Three bullets', steered: true, questionAnswer: metadata(request) } }
    stream.ingestChatEvent({ type: 'user_message', sessionId: request.sessionId, turnId: request.turnId, message })
    stream.ingestChatEvent({ type: 'user_message', sessionId: request.sessionId, turnId: request.turnId, message })
    const users = stream.getSessionStream(request.sessionId).liveUnits.filter(unit => unit.type === 'live-user')
    expect(users).toHaveLength(1)
    const built = transcript.buildUserBubbleHtml((users[0] as any).msg, true)!
    expect(built.html).toContain('class="msg user"')
    expect(built.html).toContain('Which format?')
    expect(built.html).toContain('Three bullets')
    expect(built.html).not.toContain('question-summary')
    expect(built.navTurn).toBe(false)
  })
  test('accepted answer UUIDs reconcile across history reads and event replay in either order', async () => {
    for (const eventFirst of [true, false]) {
      const request = { ...vector.request, sessionId: `async-fixture-${++sequence}` } as AsyncQuestionRequest
      const answer = { role: 'user', uuid: `answer-${sequence}`, text: 'Three bullets', steered: true, turnId: request.turnId, questionAnswer: metadata(request) }
      const event = { type: 'user_message', sessionId: request.sessionId, turnId: request.turnId,
        message: { uuid: answer.uuid, message: { content: answer.text, steered: true, questionAnswer: answer.questionAnswer } } }
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      ;(window.klaus as any).session = { history: async () => { await gate; return { messages: [answer] } } }
      const reading = stream.loadSessionHistory(request.sessionId)
      if (eventFirst) {
        stream.ingestAsyncQuestion(request)
        stream.ingestChatEvent(event)
      }
      release()
      await reading
      if (!eventFirst) stream.ingestChatEvent(event)
      const state = stream.getSessionStream(request.sessionId)
      const copies = (state.history?.filter(message => message.uuid === answer.uuid).length || 0)
        + state.liveUnits.filter(unit => unit.type === 'live-user' && unit.msg.uuid === answer.uuid).length
      expect(copies).toBe(1)
    }
  })
  test('a submitted answer folds with its process once a following final reply exists', () => {
    const request = begin()
    const question = stream.getSessionStream(request.sessionId).liveUnits[0]
    const units: import('../stream-store').LiveUnit[] = [
      { type: 'live-text', key: 'comment', text: 'Continuing independent work', phase: 'commentary', streaming: false, turnId: request.turnId },
      question,
      { type: 'live-user', key: 'answer', msg: { role: 'user', text: 'Three bullets', steered: true, questionAnswer: metadata(request) }, turnId: request.turnId },
      { type: 'live-text', key: 'final', text: 'Final result', phase: 'final_answer', streaming: true, turnId: request.turnId },
    ]
    const nodes = transcript.groupLiveActivityUnits(units, {}, true, false)
    const fold = nodes.find(node => node.kind === 'turn')
    expect(fold?.kind).toBe('turn')
    if (fold?.kind !== 'turn') throw new Error('Expected turn disclosure')
    expect(fold.messageCount).toBe(3)
    expect(fold.persistent.some(node => node.kind === 'unit' && node.unit.key === 'answer')).toBe(false)
    expect(fold.persistent.some(node => node.kind === 'unit' && node.unit.key === question.key)).toBe(false)
    expect(nodes.at(-1)).toMatchObject({ kind: 'unit', key: 'final' })
  })
  test('saved transcript replay retains native answer attribution and the whole-turn disclosure', () => {
    const request = begin()
    const messages = [
      { role: 'user', uuid: 'opener', text: 'Check the results', turnId: request.turnId },
      { role: 'assistant', uuid: 'process', turnId: request.turnId, contentBlocks: [
        { type: 'text', text: 'Continuing independent work', phase: 'commentary' },
        { type: 'tool_use', id: request.toolCallId, name: 'ask_user_async', input: request.toolInput, __result: { content: JSON.stringify({ requestId: request.requestId, turnId: request.turnId, status: 'pending' }) } },
      ] },
      { role: 'user', uuid: 'reply', text: 'Three bullets', steered: true, turnId: request.turnId, questionAnswer: metadata(request) },
      { role: 'assistant', uuid: 'final', text: 'Final result', phase: 'final_answer', isFinalReply: true, turnId: request.turnId },
    ]
    const previousDocument = (globalThis as any).document
    ;(globalThis as any).document = { createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }) }
    let html: string, expanded: string
    try {
      html = renderToStaticMarkup(<transcript.StaticTranscriptView msgs={messages} container={{} as HTMLElement} running={false} sessionId={request.sessionId} />)
      expanded = renderToStaticMarkup(<transcript.StaticTranscriptView msgs={messages} container={{} as HTMLElement} running sessionId={request.sessionId} />)
    } finally { (globalThis as any).document = previousDocument }
    expect(html).toContain('data-variant="turn"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Three bullets')
    expect(html).toContain('Final result')
    expect(expanded).toContain('Which format?')
    expect(expanded).toContain('Three bullets')
    expect(expanded).not.toContain('question-summary')
    expect(expanded).not.toContain('Answer question')
    expect(expanded.indexOf('Three bullets')).toBeLessThan(expanded.indexOf('Final result'))
  })
})

describe('sidebar waiting state follows the async question lifecycle', () => {
  // The sidebar's Needs-input pill enumerates unresolved live approval units, so
  // a question whose card settled must stop counting as a parked wait.
  const pendingInputs = (sessionId: string) => liveApprovalsOf(
    stream.getSessionStream(sessionId).liveUnits as unknown as Array<Record<string, unknown>>)
    .filter(entry => entry.kind === 'input')
  const resolvedOf = (sessionId: string) => {
    const unit = stream.getSessionStream(sessionId).liveUnits.find(row => row.type === 'live-ask')
    return unit && 'resolved' in unit ? unit.resolved : null
  }
  test('a submitted answer settles the transcript card and releases the badge count', async () => {
    const request = begin()
    const released: string[] = []
    ;(window as any).untrackApprovalRequest = (requestId: string) => released.push(requestId)
    edit(request, ['my reply', ''])
    ;(window.klaus.question as any).answer = async () => ({ accepted: true, state: 'answered' })
    expect(pendingInputs(request.sessionId).map(entry => entry.requestId)).toEqual([request.requestId])
    await controller.submitAsyncQuestionPanel(request.sessionId)
    expect(pendingInputs(request.sessionId)).toEqual([])
    expect(resolvedOf(request.sessionId)).toMatchObject({ mode: 'submitted', answers: { 'Which format?': 'my reply' } })
    expect(released).toEqual([request.requestId])
  })
  test('an expired question settles its card as skipped', () => {
    const request = begin()
    stream.ingestAsyncQuestionResolution({ sessionId: request.sessionId, requestId: request.requestId,
      turnId: request.turnId, state: 'expired', answers: {} })
    expect(pendingInputs(request.sessionId)).toEqual([])
    expect(resolvedOf(request.sessionId)).toMatchObject({ mode: 'skipped' })
  })
  test('the owning turn terminal event settles a question the turn left unanswered', () => {
    const request = begin()
    expect(pendingInputs(request.sessionId)).toHaveLength(1)
    stream.ingestChatEvent({ type: 'done', sessionId: request.sessionId, turnId: request.turnId })
    expect(pendingInputs(request.sessionId)).toEqual([])
    expect(resolvedOf(request.sessionId)).toMatchObject({ mode: 'skipped' })
  })
  test('another turn terminal event leaves a parked question waiting', () => {
    const request = begin()
    stream.ingestChatEvent({ type: 'done', sessionId: request.sessionId, turnId: 'some-other-turn' })
    expect(pendingInputs(request.sessionId).map(entry => entry.requestId)).toEqual([request.requestId])
    expect(resolvedOf(request.sessionId)).toBeNull()
  })
  test('declining an optional question is terminal: pill clears, no reopen chip, recovery cannot revive it', () => {
    const request = begin()
    const released: string[] = []
    ;(window as any).untrackApprovalRequest = (requestId: string) => released.push(requestId)
    expect(pendingInputs(request.sessionId)).toHaveLength(1)
    stream.updateAsyncQuestionUi(request.sessionId, ui => declineAsyncQuestion(ui, request.requestId))
    controller.declineAsyncQuestionRequest(request.sessionId, request.requestId)
    expect(pendingInputs(request.sessionId)).toEqual([])
    expect(resolvedOf(request.sessionId)).toMatchObject({ mode: 'skipped' })
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId].state).toBe('declined')
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel).toBeNull()
    expect(renderRequest(request)).not.toContain('Answer question')
    expect(released).toEqual([request.requestId])
    // The engine still lists the question as pending until its turn closes; a
    // recovery read must not resurrect a declined question.
    stream.ingestAsyncQuestion(request, true)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.requests[request.requestId].state).toBe('declined')
    expect(pendingInputs(request.sessionId)).toEqual([])
    expect(renderRequest(request)).not.toContain('Answer question')
  })
  test('the async panel offers Later and Decline while the blocking card keeps its dismiss label', () => {
    const request = begin()
    const panel = renderRequest(request, true)
    expect(panel).toContain('>Later</button>')
    expect(panel).toContain('>Decline to answer</button>')
    expect(panel).toContain('aria-label="Decline to answer"')
    const blocking = renderToStaticMarkup(<cards.AskUserQuestionCard req={{ requestId: 'blocking-1', toolInput: request.toolInput }}
      resolved={null} sessionId={request.sessionId} />)
    expect(blocking).toContain('aria-label="Dismiss questions"')
    expect(blocking).not.toContain('>Later</button>')
  })
})

// The transcript copy of an optional question is process evidence: it folds with
// its turn, and a folded turn unmounts it, so a question whose panel went away
// can have no chip left to click. What still marks the chat is the sidebar pill,
// which carries no position. Entering the conversation therefore puts its
// answerable questions back into the composer.
describe('entering a session reopens what it can still answer', () => {
  test('a dismissed panel returns to the composer with its draft intact', () => {
    const request = begin()
    edit(request, ['typed before leaving', ''])
    stream.updateAsyncQuestionUi(request.sessionId, closeAsyncQuestionPanel)
    expect(renderRequest(request, true)).toBe('')
    stream.reopenAsyncQuestionsForSession(request.sessionId)
    const panel = renderRequest(request, true)
    expect(panel).toContain('Question</span>')
    expect(panel).toContain('Which format?')
    expect(panel).toContain('typed before leaving')
    // Restored, not restarted: a question the user came back for has no timer.
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel?.deadlineMs).toBeNull()
  })
  test('a panel still counting down is left exactly as it is', () => {
    const request = begin()
    const before = stream.getSessionStream(request.sessionId).asyncQuestions.panel
    expect(before?.deadlineMs).not.toBeNull()
    stream.reopenAsyncQuestionsForSession(request.sessionId)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel).toBe(before)
  })
  test('a session whose turn closed while away reopens nothing', () => {
    const request = begin()
    stream.updateAsyncQuestionUi(request.sessionId, closeAsyncQuestionPanel)
    stream.ingestChatEvent({ type: 'done', sessionId: request.sessionId, turnId: request.turnId })
    stream.reopenAsyncQuestionsForSession(request.sessionId)
    expect(renderRequest(request, true)).toBe('')
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel).toBeNull()
  })
  test('a declined question is not put back', () => {
    const request = begin()
    stream.updateAsyncQuestionUi(request.sessionId, ui => declineAsyncQuestion(ui, request.requestId))
    stream.reopenAsyncQuestionsForSession(request.sessionId)
    expect(stream.getSessionStream(request.sessionId).asyncQuestions.panel).toBeNull()
  })
  test('dismissing while still on the session stays dismissed', () => {
    const request = begin()
    // Later/Escape closes the panel without a session switch, and nothing may
    // reopen it from the state change alone.
    stream.updateAsyncQuestionUi(request.sessionId, closeAsyncQuestionPanel)
    expect(renderRequest(request, true)).toBe('')
    expect(renderRequest(request).match(/Answer question/g)).toHaveLength(2)
  })
})

// Startup recovery sweeps every known session, including background ones the
// engine still lists as pending, so it may only rebuild a panel for the session
// a composer is actually showing.
describe('pending recovery reopens only the session on screen', () => {
  async function recover(request: AsyncQuestionRequest, currentSessionId: string | null) {
    const approvals = await import('../approvals')
    const deps: ApprovalsDeps = {
      currentSessionId: () => currentSessionId, isCronRunSession: () => false, markCronRunUnread: () => {},
      renderSessionList: () => {},
      pendingPermissionsBySession: new Map(), pendingElicitsBySession: new Map(),
    }
    approvals.initApprovals(deps)
    ;(window.klaus as any).permission = { pending: async () => [] }
    ;(window.klaus as any).elicit = { pending: async () => [] }
    ;(window.klaus.question as any).pending = async () => [request]
    await approvals.restorePendingPermissions(request.sessionId)
    return stream.getSessionStream(request.sessionId).asyncQuestions.panel
  }
  test('a recovered question reaches the composer of the session being shown', async () => {
    // Recovery alone never opens a panel; showing the session does.
    const sessionId = `async-fixture-${++sequence}`
    const request = { ...vector.request, sessionId } as AsyncQuestionRequest
    expect(await recover(request, 'some-other-session')).toBeNull()
    expect(stream.getSessionStream(sessionId).asyncQuestions.requests[request.requestId].state).toBe('pending')
    const second = `async-fixture-${++sequence}`
    const shown = { ...vector.request, sessionId: second } as AsyncQuestionRequest
    const panel = await recover(shown, second)
    expect(panel?.items).toEqual([{ requestId: shown.requestId, index: 0 }, { requestId: shown.requestId, index: 1 }])
    expect(panel?.deadlineMs).toBeNull()
    expect(stream.getSessionStream(second).asyncQuestions.requests[shown.requestId].state).toBe('pending')
  })
})

// The trigger is the whole point of this contract. Wired to a store change it
// would undo Later/Escape the moment the user dismisses the panel, because
// dismissing is itself a state change on the session they are still looking at.
describe('reopen is wired to surfaces showing a session, never to state changes', () => {
  const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../stream-store.ts', import.meta.url), 'utf8')
  test('the vector names the trigger and the store exposes exactly one entry point', () => {
    expect(vector.reopen.trigger).toBe('surface-shows-session')
    expect(store).toContain('export function reopenAsyncQuestionsForSession(sessionId: string): void {')
    // The store declares the entry point and never calls it: wiring it to a state
    // change would put a second reference here and fail this count, which is what
    // keeps the trigger on the surface instead of on the store's own mutations.
    expect(store.match(/reopenAsyncQuestionsForSession\(/g)).toHaveLength(1)
  })
  test('the main transcript reopens only after its switch guard has run', () => {
    // Before the guard, a session the user already navigated away from would get
    // a panel rebuilt for a composer that no longer shows it.
    const guard = chat.indexOf('if (mySeq !== switchSeq || window.currentSessionId !== id || sessionDeletePending.has(id)) return')
    const reopen = chat.indexOf('reopenAsyncQuestionsForSession(id)')
    expect(guard).toBeGreaterThan(-1)
    expect(reopen).toBeGreaterThan(guard)
    expect(chat.indexOf('reopenAsyncQuestionsForSession(id)', reopen + 1)).toBe(-1)
  })
  test('the side tab reopens only its identity after binding and mounting its transcript', async () => {
    const f = createSidePaneComposerFixture()
    try {
      await f.window.klausSideSurfaceActivate('question-left', 'left')
      await f.window.klausSideSurfaceActivate('question-right', 'right')
      expect(f.calls.reopens).toEqual([
        { id: 'question-left', left: 'question-left', right: null, mounted: true },
        { id: 'question-right', left: 'question-left', right: 'question-right', mounted: true },
      ])
      f.setRuntime('question-left', { running: true })
      expect(f.calls.reopens).toHaveLength(2)
      f.window.klausSideSurfaceClear('left')
      expect(f.calls.reopens).toHaveLength(2)
      await f.window.klausSideSurfaceActivate('question-left', 'left')
      expect(f.calls.reopens.at(-1)).toEqual({ id: 'question-left', left: 'question-left', right: 'question-right', mounted: true })
    } finally { await f.destroy() }
  })
  test('startup recovery sweeps every session but reopens only the current one', () => {
    const approvals = readFileSync(new URL('../approvals.ts', import.meta.url), 'utf8')
    // The startup sweep lives in chat.ts and recovers every known session; the
    // reopen inside recovery is gated on the session a composer is showing.
    expect(chat).toContain('for (const session of sessions) void restorePendingPermissions(session.id)')
    expect(approvals).toContain('if (recovered && sessionId === deps?.currentSessionId?.()) reopenAsyncQuestionsForSession(sessionId)')
  })
})
