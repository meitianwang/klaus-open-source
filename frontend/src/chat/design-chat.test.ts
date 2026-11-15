import { expect, test } from 'bun:test'
import { createDesignChatConsumer } from './design-chat'

test('design chat consumer stages requests for the owning session and deduplicates requestIds', async () => {
  let staged = '', focused = 0
  const replies: unknown[] = [], toasts: string[] = []
  const consume = createDesignChatConsumer({
    currentSession: () => 'chat-1',
    stage: text => { staged = text },
    focus: () => { focused++ },
    send: async onAccepted => { onAccepted() },
    reply: async (requestId, ok, error) => { replies.push([requestId, ok, error]) },
    toast: msg => { toasts.push(msg) },
    text: key => key,
  })
  const payload = { requestId: 'r-1', sessionId: 'chat-1', id: 'canvas-1', text: 'Design Canvas canvas-1\n\nFix header spacing', submit: false }
  await Promise.all([consume(payload), consume(payload)])
  expect(staged).toBe(payload.text)
  expect(focused).toBe(1)
  expect(replies).toEqual([['r-1', true, undefined]])
  expect(toasts).toEqual([])
})

test('design chat consumer rejects requests from a non-active chat without staging', async () => {
  let staged = ''
  const replies: unknown[] = [], toasts: string[] = []
  const consume = createDesignChatConsumer({
    currentSession: () => 'chat-1',
    stage: text => { staged = text },
    focus: () => {},
    send: async () => {},
    reply: async (requestId, ok, error) => { replies.push([requestId, ok, error]) },
    toast: msg => { toasts.push(msg) },
    text: key => key,
  })
  await consume({ requestId: 'r-2', sessionId: 'chat-2', id: 'canvas-2', text: 'Repair', submit: true })
  expect(staged).toBe('')
  expect(replies).toEqual([['r-2', false, 'design_chat_wrong_session']])
  expect(toasts).toEqual(['design_chat_wrong_session'])
})
