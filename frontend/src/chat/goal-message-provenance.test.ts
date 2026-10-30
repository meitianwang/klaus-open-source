import { expect, test } from 'bun:test'

;(globalThis as any).window ??= { addEventListener: () => {} }
const { getSessionStream, ingestChatEvent } = await import('./stream-store')

for (const location of ['event', 'envelope', 'message'] as const) {
  test(`a meta user message at ${location} does not add a bubble or start visible activity`, () => {
    const sessionId = `goal-meta-${location}`
    const event: any = { sessionId, type: 'user_message', message: { message: { content: 'Internal continuation' } } }
    if (location === 'event') event.isMeta = true
    else if (location === 'envelope') event.message.is_meta = true
    else event.message.message.isMeta = true
    ingestChatEvent(event)
    expect(getSessionStream(sessionId).liveUnits).toEqual([])
    expect(getSessionStream(sessionId).running).toBe(false)
  })
}

test('ordinary user text resembling a Goal prompt remains visible', () => {
  const sessionId = 'goal-user-quoted-prompt'
  const text = 'Continue working toward the active thread goal. This sentence is quoted by the user.'
  ingestChatEvent({ sessionId, type: 'user_message', message: { message: { content: text } } })
  const unit = getSessionStream(sessionId).liveUnits[0]
  expect(unit.type).toBe('live-user')
  expect(unit.type === 'live-user' ? unit.msg.text : '').toBe(text)
})
