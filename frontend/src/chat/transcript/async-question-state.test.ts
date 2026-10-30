import { describe, expect, test } from 'bun:test'
import vector from '../../../../contracts/vectors/async-user-question-vectors.json'
import { EMPTY_ASYNC_QUESTIONS, QUESTION_PANEL_TIMEOUT_MS, QUESTION_COUNTDOWN_VISIBLE_MS, canAnswerAsyncQuestion, closeAsyncQuestionPanel, declineAsyncQuestion, editAsyncQuestion, expireAsyncQuestions, navigateAsyncQuestion, openAsyncQuestion, questionCountdown, receiveAsyncQuestion, reopenAsyncQuestions, resetAsyncQuestionDeadline, resolveAsyncQuestion, retireAsyncQuestion, type AsyncQuestionRequest } from './async-question-state'
import { chooseQuestionOption, questionAnswers } from './question-state'

const request = vector.request as AsyncQuestionRequest

describe('optional question interaction contract', () => {
  test('new optional questions have empty drafts and an initial 30 second panel', () => {
    const ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 100)
    expect(ui.requests[request.requestId].draft.answers.map(row => row.selected)).toEqual([[], []])
    expect(questionAnswers(request.toolInput.questions, ui.requests[request.requestId].draft)).toEqual({})
    expect(ui.panel).toEqual({ id: 1, items: [{ requestId: request.requestId, index: 0 }, { requestId: request.requestId, index: 1 }], selected: 0, deadlineMs: 30100 })
    expect(QUESTION_PANEL_TIMEOUT_MS).toBe(vector.panel.initialTimeoutMs)
    expect(QUESTION_COUNTDOWN_VISIBLE_MS).toBe(vector.panel.countdownVisibleMs)
  })
  test('countdown begins in the last 20 seconds; hover resets only an active deadline', () => {
    const ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 100)
    expect(questionCountdown(ui.panel?.deadlineMs, 100)).toBeNull()
    expect(questionCountdown(ui.panel?.deadlineMs, 10100)).toBe(20)
    expect(questionCountdown(ui.panel?.deadlineMs, 30100)).toBe(0)
    expect(resetAsyncQuestionDeadline(ui, 200).panel?.deadlineMs).toBe(30200)
    const reopened = openAsyncQuestion(closeAsyncQuestionPanel(ui), { requestId: request.requestId, index: 1 })
    expect(reopened.panel?.deadlineMs).toBeNull()
    expect(resetAsyncQuestionDeadline(reopened, 300).panel?.deadlineMs).toBeNull()
  })
  test('minimize preserves drafts, and stale timeout cannot close an edited or reopened panel', () => {
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    const draft = chooseQuestionOption(ui.requests[request.requestId].draft, request.toolInput.questions, 1)
    ui = editAsyncQuestion(ui, request.requestId, draft)
    expect(ui.panel?.deadlineMs).toBeNull()
    expect(closeAsyncQuestionPanel(ui, 30000)).toBe(ui)
    ui = openAsyncQuestion(closeAsyncQuestionPanel(ui), { requestId: request.requestId, index: 0 })
    expect(ui.requests[request.requestId].draft).toBe(draft)
    expect(ui.panel?.items).toEqual([{ requestId: request.requestId, index: 0 }])
    expect(closeAsyncQuestionPanel(ui, 30000)).toBe(ui)
  })
  test('same-turn arrivals append stable original indexes; a recovered question never autoopens', () => {
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    const second = { ...request, requestId: 'second', toolCallId: 'second-tool', toolInput: { questions: [request.toolInput.questions[0]] } }
    ui = receiveAsyncQuestion(ui, second, 100)
    expect(ui.panel?.items).toHaveLength(3)
    expect(ui.panel?.deadlineMs).toBe(30000)
    expect(navigateAsyncQuestion(ui, 2, 100).panel).toMatchObject({ selected: 2, deadlineMs: 30100 })
    expect(receiveAsyncQuestion(ui, second, 200).panel?.items).toHaveLength(3)
    expect(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0, true).panel).toBeNull()
  })
  test('partial answers remove only resolved indexes and retain skipped questions for reopening', () => {
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    const draft = ui.requests[request.requestId].draft
    ui = editAsyncQuestion(ui, request.requestId, { ...draft, answers: [{ selected: [1], text: '' }, { selected: [], text: '', skipped: true }] })
    ui = resolveAsyncQuestion(ui, request.requestId, 'pending', vector.partialAnswer)
    expect(ui.panel?.items).toEqual([{ requestId: request.requestId, index: 1 }])
    expect(ui.requests[request.requestId].answers).toEqual(vector.partialAnswer)
    ui = openAsyncQuestion(closeAsyncQuestionPanel(ui), { requestId: request.requestId, index: 1 })
    expect(ui.panel?.items[0].index).toBe(1)
    ui = resolveAsyncQuestion(ui, request.requestId, 'answered', vector.lateAnswer)
    expect(ui.panel).toBeNull()
    expect(openAsyncQuestion(ui, { requestId: request.requestId, index: 1 })).toBe(ui)
  })
  test('only the original running turn admits answers', () => {
    const row = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0).requests[request.requestId]
    expect(canAnswerAsyncQuestion(row, true, request.turnId)).toBe(true)
    expect(canAnswerAsyncQuestion(row, false, request.turnId)).toBe(false)
    expect(canAnswerAsyncQuestion(row, true, 'another-turn')).toBe(false)
    const expired = expireAsyncQuestions(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0))
    expect(canAnswerAsyncQuestion(expired.requests[request.requestId], true, request.turnId)).toBe(false)
  })
  test('terminal cleanup restores changed unsent reply text once and retains completed prose', () => {
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    const draft = ui.requests[request.requestId].draft
    ui = editAsyncQuestion(ui, request.requestId, { ...draft, answers: [{ selected: [], text: 'unsent reply' }, draft.answers[1]] })
    expect(expireAsyncQuestions(ui, 'another-turn').requests[request.requestId].state).toBe('pending')
    ui = expireAsyncQuestions(ui, request.turnId)
    expect(ui.panel).toBeNull()
    expect(ui.restoredDrafts).toEqual([{ turnId: request.turnId, text: 'unsent reply' }])
    expect(ui.requests[request.requestId].request).toBe(request)
    expect(expireAsyncQuestions(ui, request.turnId)).toBe(ui)
    const untouched = expireAsyncQuestions(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0), request.turnId)
    expect(untouched.restoredDrafts).toEqual([])
  })
  test('accepted drafts are never restored as unsent text at terminal', () => {
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    ui = editAsyncQuestion(ui, request.requestId, chooseQuestionOption(ui.requests[request.requestId].draft, request.toolInput.questions, 1))
    ui = resolveAsyncQuestion(ui, request.requestId, 'pending', vector.partialAnswer)
    expect(expireAsyncQuestions(ui, request.turnId).restoredDrafts).toEqual([])
  })
  // Entering a conversation is the "later" a deferred question waits for, so a
  // surface that starts showing a session puts back everything it can still
  // answer. The trigger is that surface, never a state change, which is what
  // keeps Later/Escape from being undone while the user stays on the same chat.
  test('entering a session reopens a dismissed question without restarting its countdown', () => {
    const running = { running: true, activeTurnId: request.turnId }
    const answered = { ...running, running: false, activeTurnId: null }
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    // A live countdown is left alone: rebuilding it would restart the 30 seconds
    // under someone who is reading it.
    expect(reopenAsyncQuestions(ui, running, 100).panel).toBe(ui.panel)
    ui = closeAsyncQuestionPanel(ui)
    const reopened = reopenAsyncQuestions(ui, running, 100)
    expect(reopened.panel).toEqual({ id: 2, items: [{ requestId: request.requestId, index: 0 },
      { requestId: request.requestId, index: 1 }], selected: 0, deadlineMs: vector.reopen.reopenedDeadlineMs })
    // No deadline means no timer will hide it again on the way back in.
    expect(reopened.panel?.deadlineMs).toBeNull()
    expect(questionCountdown(reopened.panel?.deadlineMs, 100_000)).toBeNull()
    expect(resetAsyncQuestionDeadline(reopened, 200).panel?.deadlineMs).toBeNull()
    // A closed turn admits nothing, so a session that finished while away stays quiet.
    expect(reopenAsyncQuestions(ui, answered, 100)).toBe(ui)
    expect(reopenAsyncQuestions(ui, { ...running, activeTurnId: 'another-turn' }, 100)).toBe(ui)
  })
  test('reopening queues every answerable question across requests and keeps drafts', () => {
    const running = { running: true, activeTurnId: request.turnId }
    const second = { ...request, requestId: 'second', toolCallId: 'second-tool',
      toolInput: { questions: [request.toolInput.questions[1]] } }
    let ui = receiveAsyncQuestion(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0), second, 0)
    ui = editAsyncQuestion(ui, 'second', { ...ui.requests['second'].draft, answers: [{ selected: [], text: 'kept reply' }] })
    ui = closeAsyncQuestionPanel(ui)
    const reopened = reopenAsyncQuestions(ui, running, 100)
    expect(reopened.panel?.items).toEqual([{ requestId: request.requestId, index: 0 },
      { requestId: request.requestId, index: 1 }, { requestId: 'second', index: 0 }])
    expect(reopened.requests['second'].draft.answers[0].text).toBe('kept reply')
  })
  test('reopening drops questions that settled while the session was away', () => {
    const running = { running: true, activeTurnId: request.turnId }
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    // The first of two questions was answered before leaving.
    ui = resolveAsyncQuestion(ui, request.requestId, 'pending', vector.partialAnswer)
    ui = closeAsyncQuestionPanel(ui)
    expect(reopenAsyncQuestions(ui, running, 100).panel?.items).toEqual([{ requestId: request.requestId, index: 1 }])
    // Everything answered: nothing to put back.
    const complete = closeAsyncQuestionPanel(resolveAsyncQuestion(ui, request.requestId, 'answered', vector.lateAnswer))
    expect(reopenAsyncQuestions(complete, running, 100)).toBe(complete)
    // A decline is the user's verdict and reopening must not resurrect it.
    const declined = declineAsyncQuestion(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0), request.requestId)
    expect(reopenAsyncQuestions(declined, running, 100)).toBe(declined)
    // Same for a question its own turn expired.
    const expired = expireAsyncQuestions(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0), request.turnId)
    expect(reopenAsyncQuestions(expired, running, 100)).toBe(expired)
  })
  test('a stale deadline left behind by unmounting is restored instead of closing on remount', () => {
    const running = { running: true, activeTurnId: request.turnId }
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
    ui = navigateAsyncQuestion(ui, 1, 0)
    // Leaving the chat unmounts the card that drives the tick, so the deadline
    // survives in the store; a question the user came back for is restored from
    // what it held, on the question it was parked on, with the timer cleared.
    const restored = reopenAsyncQuestions(ui, running, ui.panel!.deadlineMs! + 1)
    expect(restored.panel).toMatchObject({ selected: 1, deadlineMs: null })
    expect(restored.panel?.items).toEqual(ui.panel?.items)
    expect(restored.panel?.id).not.toBe(ui.panel?.id)
    // A question that stopped being answerable during that window drops out.
    const expiredTurn = { running: false, activeTurnId: null }
    expect(reopenAsyncQuestions(ui, expiredTurn, ui.panel!.deadlineMs! + 1).panel).toBeNull()
  })
  test('reopening never disturbs a submission already in flight', () => {
    const running = { running: true, activeTurnId: request.turnId }
    const ui = { ...closeAsyncQuestionPanel(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)), submitting: true }
    expect(reopenAsyncQuestions(ui, running, 100)).toBe(ui)
  })
  // The reopen contract, pinned against the vector so a change to either side
  // fails loudly: what triggers it, and the three invariants above.
  test('the reopen contract matches its committed vector', () => {
    const running = { running: true, activeTurnId: request.turnId }
    const single = { ...request, toolInput: { questions: [request.toolInput.questions[0]] } }
    const second = { ...single, requestId: 'second', toolCallId: 'second-tool' }
    const queued = closeAsyncQuestionPanel(
      receiveAsyncQuestion(receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, single, 0), second, 0))
    const reopened = reopenAsyncQuestions(queued, running, 100)
    expect(reopened.panel?.deadlineMs).toBe(vector.reopen.reopenedDeadlineMs)
    expect(reopened.panel?.items.map(item => item.requestId)).toEqual(
      vector.reopen.queuesEveryAnswerableQuestion ? ['question-optional-1', 'second'] : ['question-optional-1'])
    // A countdown that outlived its unmounted card is restored, not replayed.
    const live = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, single, 0)
    const stale = reopenAsyncQuestions(live, running, live.panel!.deadlineMs! + 1)
    expect(stale.panel?.deadlineMs).toBe(vector.reopen.restoresStaleDeadline ? null : live.panel!.deadlineMs)
    expect(stale.panel?.id).not.toBe(live.panel?.id)
    const sending = { ...queued, submitting: true }
    expect(reopenAsyncQuestions(sending, running, 100) === sending).toBe(vector.reopen.neverDuringSubmission)
  })
  test('authoritative removal preserves the selected question identity within a queue', () => {
    const single = { ...request, toolInput: { questions: [request.toolInput.questions[0]] } }
    const second = { ...single, requestId: 'second' }
    const third = { ...single, requestId: 'third' }
    let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, single, 0)
    ui = receiveAsyncQuestion(receiveAsyncQuestion(ui, second, 0), third, 0)
    ui = navigateAsyncQuestion(ui, 1, 0)
    ui = retireAsyncQuestion(ui, single.requestId)
    expect(ui.panel?.items[ui.panel.selected]).toEqual({ requestId: 'second', index: 0 })
    expect(ui.closedTurnIds).toBeUndefined()
  })
})
