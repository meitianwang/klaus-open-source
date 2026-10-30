import { expect, test } from 'bun:test'
import type { PptChatRequest } from '../../bridge/ppt-api'
import { createPptChatConsumer } from './ppt-chat'

function fixture() {
  let session: string | null = 'chat-a'
  const staged: string[] = [], sent: string[] = [], replies: unknown[] = [], toasts: string[] = []
  let focus = 0
  let send: (accepted: () => void, expected: string) => Promise<unknown> = async accepted => { accepted() }
  const consume = createPptChatConsumer({
    currentSession: () => session,
    stage: text => { staged.push(text) }, focus: () => { focus++ },
    send: async (accepted, expected) => { sent.push(expected); return send(accepted, expected) },
    reply: async (...args) => { replies.push(args) }, toast: message => { toasts.push(message) }, text: key => key,
  })
  return { consume, staged, sent, replies, toasts, focus: () => focus,
    session: (next: string | null) => { session = next },
    send: (next: typeof send) => { send = next },
  }
}
const request = (overrides: Partial<PptChatRequest> = {}): PptChatRequest => ({ requestId: 'request-a', sessionId: 'chat-a', id: 'deck-a', text: 'Repair the selected slide.', submit: false, ...overrides })
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

test('a draft action preserves its text, focuses the current composer and acknowledges placement', async () => {
  const f = fixture(), text = '  Review slide 2.\nKeep its layout.  '
  await f.consume(request({ text }))
  expect(f.staged).toEqual([text])
  expect(f.focus()).toBe(1)
  expect(f.sent).toHaveLength(0)
  expect(f.replies).toEqual([['request-a', true, undefined]])
})

test('a request from another chat leaves the composer untouched and receives an error', async () => {
  const f = fixture()
  await f.consume(request({ sessionId: 'chat-b', submit: true }))
  expect(f.staged).toHaveLength(0)
  expect(f.sent).toHaveLength(0)
  expect(f.replies).toEqual([['request-a', false, 'ppt_chat_wrong_session']])
  expect(f.toasts).toEqual(['ppt_chat_wrong_session'])
})

test('submit waits for the composer receipt and only reports actual acceptance', async () => {
  const f = fixture()
  let finish!: () => void, accept!: () => void
  f.send(async accepted => { accept = accepted; await new Promise<void>(resolve => { finish = resolve }) })
  const action = f.consume(request({ submit: true }))
  await tick()
  expect(f.sent).toEqual(['chat-a'])
  expect(f.replies).toHaveLength(0)
  accept()
  expect(f.replies).toHaveLength(0)
  finish()
  await action
  expect(f.replies).toEqual([['request-a', true, undefined]])
  expect(f.focus()).toBe(0)
})

test('cancelled or refused submits never claim that a message was sent', async () => {
  const f = fixture()
  f.send(async () => {})
  await f.consume(request({ submit: true }))
  expect(f.replies).toEqual([['request-a', false, 'ppt_chat_not_accepted']])
  expect(f.toasts).toHaveLength(0)
})

test('a chat switch during send refusal reports ownership loss without touching the new draft', async () => {
  const f = fixture()
  f.send(async () => { f.session('chat-b') })
  await f.consume(request({ submit: true }))
  expect(f.staged).toEqual(['Repair the selected slide.'])
  expect(f.replies).toEqual([['request-a', false, 'ppt_chat_wrong_session']])
})

test('send exceptions are acknowledged in finally and displayed to the user', async () => {
  const f = fixture()
  f.send(async () => { throw new Error('The current chat is unavailable.') })
  await f.consume(request({ submit: true }))
  expect(f.replies).toEqual([['request-a', false, 'The current chat is unavailable.']])
  expect(f.toasts).toEqual(['The current chat is unavailable.'])
})

test('an error after acceptance preserves the accepted receipt', async () => {
  const f = fixture()
  f.send(async accepted => { accepted(); throw new Error('Draft refresh failed.') })
  await f.consume(request({ submit: true }))
  expect(f.replies).toEqual([['request-a', true, undefined]])
  expect(f.toasts).toEqual(['Draft refresh failed.'])
})

test('duplicate delivery reuses one action and never sends or acknowledges twice', async () => {
  const f = fixture(), payload = request({ submit: true })
  const first = f.consume(payload), duplicate = f.consume(payload)
  expect(duplicate).toBe(first)
  await first
  await f.consume(payload)
  expect(f.staged).toHaveLength(1)
  expect(f.sent).toEqual(['chat-a'])
  expect(f.replies).toEqual([['request-a', true, undefined]])
})

test('queued actions recheck ownership before changing any draft', async () => {
  const f = fixture()
  let finish!: () => void
  f.send(async accepted => { await new Promise<void>(resolve => { finish = resolve }); accepted() })
  const first = f.consume(request({ submit: true }))
  await tick()
  const second = f.consume(request({ requestId: 'request-b', text: 'A second action.' }))
  f.session('chat-b')
  finish()
  await Promise.all([first, second])
  expect(f.staged).toEqual(['Repair the selected slide.'])
  expect(f.replies).toEqual([['request-a', true, undefined], ['request-b', false, 'ppt_chat_wrong_session']])
})

test('empty and incomplete requests are acknowledged without changing the composer', async () => {
  const f = fixture()
  await f.consume(request({ text: '  ' }))
  await f.consume(request({ requestId: 'request-b', id: '' }))
  expect(f.staged).toHaveLength(0)
  expect(f.replies).toEqual([['request-a', false, 'ppt_chat_empty_request'], ['request-b', false, 'ppt_chat_invalid_request']])
})
