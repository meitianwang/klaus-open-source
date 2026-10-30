import { expect, test } from 'bun:test'
;(globalThis as any).window ??= { addEventListener() {} }
const { receivePlanningQuestion, pendingPlanningQuestions, planningQuestionReadToken, reconcilePlanningQuestionRead, configurePlanningQuestions, planningQuestionController, planningQuestionForTool } = await import('./questions-runtime')
const question = { id: 'choice', header: 'Choice', question: 'Choose one?', options: [{ label: 'One', description: 'First' }, { label: 'Two', description: 'Second' }] }
test('a reconnect snapshot expires absent requests while preserving authoritative optional metadata', () => {
  const request = { sessionId: 'questions-expire', requestId: 'request-a', turnId: 'turn-a', toolCallId: 'tool-a', questions: [question], status: 'pending' as const, optional: false }
  receivePlanningQuestion(request)
  const token = planningQuestionReadToken(request.sessionId)
  expect(reconcilePlanningQuestionRead(request.sessionId, [], token)).toBe(true)
  expect(pendingPlanningQuestions(request.sessionId)).toEqual([])
})
test('an older pending read cannot expire a request pushed while it was loading', () => {
  const sessionId = 'questions-read-race'
  const token = planningQuestionReadToken(sessionId)
  const request = { sessionId, requestId: 'request-b', turnId: 'turn-b', toolCallId: 'tool-b', questions: [question], status: 'pending' as const, optional: true }
  receivePlanningQuestion(request)
  expect(reconcilePlanningQuestionRead(sessionId, [], token)).toBe(false)
  expect(pendingPlanningQuestions(sessionId)[0]?.optional).toBe(true)
})
test('accepted answers settle both the controller and the runtime without invalidating their own acknowledgement', async () => {
  const request = { sessionId: 'questions-accepted', requestId: 'real-request', turnId: 'real-turn', toolCallId: 'real-tool', questions: [question], status: 'pending' as const }
  receivePlanningQuestion(request)
  configurePlanningQuestions(async identity => ({ accepted: true, identity }))
  const controller = planningQuestionController(request)
  controller.select(1)
  expect(await controller.submit()).toBe(true)
  expect(controller.getSnapshot().request.status).toBe('answered')
  expect(pendingPlanningQuestions(request.sessionId)).toEqual([])
  expect(planningQuestionForTool(request.sessionId, request.toolCallId, request.turnId)?.answers).toEqual({ choice: { answers: ['Two'] } })
})
test('an acknowledgement for another request never changes authoritative runtime state', async () => {
  const request = { sessionId: 'questions-wrong-ack', requestId: 'real-request', turnId: 'real-turn', toolCallId: 'real-tool', questions: [question], status: 'pending' as const }
  receivePlanningQuestion(request)
  configurePlanningQuestions(async identity => ({ accepted: true, identity: { ...identity, turnId: 'other-turn' } }))
  const controller = planningQuestionController(request)
  controller.select(0)
  expect(await controller.submit()).toBe(false)
  expect(pendingPlanningQuestions(request.sessionId)).toHaveLength(1)
  expect(controller.getSnapshot().request.status).toBe('pending')
})
