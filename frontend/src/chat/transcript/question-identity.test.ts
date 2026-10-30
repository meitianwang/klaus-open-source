import { expect, test } from 'bun:test'
import { canonicalQuestionMap, questionAnswerKey } from '../../../../contracts/user-questions'
import { EMPTY_ASYNC_QUESTIONS, receiveAsyncQuestion, resolveAsyncQuestion, type AsyncQuestionRequest } from './async-question-state'

const questions = [
  { id: 'first', question: 'Choose?', options: [{ label: 'One' }] },
  { id: 'second', question: 'Choose?', options: [{ label: 'Two' }] },
]

test('canonical IDs reject ambiguous old prompt keys and duplicate aliases', () => {
  expect(canonicalQuestionMap(questions, { first: 'One', second: 'Two' })).toEqual({ first: 'One', second: 'Two' })
  expect(canonicalQuestionMap(questions, { 'Choose?': 'One' })).toBeUndefined()
  const unique = [questions[0]]
  expect(canonicalQuestionMap(unique, { 'Choose?': 'One' })).toEqual({ first: 'One' })
  expect(canonicalQuestionMap(unique, { first: 'One', 'Choose?': 'Two' })).toBeUndefined()
  expect(questionAnswerKey({ question: 'Historical prompt' })).toBe('Historical prompt')
  expect(canonicalQuestionMap([{ ...questions[0], id: 'format' }, { ...questions[1], question: 'format' }], { format: 'One' })).toBeUndefined()
})

test('partial answers to identical prompts retire only their own question IDs', () => {
  const request: AsyncQuestionRequest = { requestId: 'stable-request', sessionId: 'stable-session', turnId: 'stable-turn',
    toolName: 'ask_user_async', responseChannel: 'async-question', toolInput: { questions } }
  let ui = receiveAsyncQuestion(EMPTY_ASYNC_QUESTIONS, request, 0)
  ui = resolveAsyncQuestion(ui, request.requestId, 'pending', { first: 'One' })
  expect(ui.panel?.items).toEqual([{ requestId: request.requestId, index: 1 }])
  expect(ui.requests[request.requestId].answers).toEqual({ first: 'One' })
  ui = resolveAsyncQuestion(ui, request.requestId, 'answered', { second: 'Two' })
  expect(ui.panel).toBeNull()
  expect(ui.requests[request.requestId].answers).toEqual({ first: 'One', second: 'Two' })
})
