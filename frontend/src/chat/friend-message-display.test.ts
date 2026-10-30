// The live bubble of an externally delivered friend task must render the display
// snapshot the host pushes with the admitted user frame, not the approval envelope
// the model receives. History replay restores the same snapshot from the engine's
// provider-invisible metadata row, so the live unit only has to carry it through.
import { expect, test } from 'bun:test'

;(globalThis as any).window ??= { addEventListener: () => {} }
const { getSessionStream, ingestChatEvent } = await import('./stream-store')

const ENVELOPE = 'This friend task was approved by this device owner with the explicit resource grant below.'
const SNAPSHOT = { externalFriendMessage: true, displayText: 'Stored Friend: Help draft the launch announcement.' }

test('the admitted friend frame carries its display snapshot onto the live bubble', () => {
  const sessionId = 'friend-live-display'
  ingestChatEvent({ sessionId, type: 'user_message', message: { message: { content: ENVELOPE, localRender: SNAPSHOT } } })
  const unit = getSessionStream(sessionId).liveUnits[0]
  expect(unit.type).toBe('live-user')
  if (unit.type !== 'live-user') return
  expect(unit.msg.text).toBe(ENVELOPE)
  expect(unit.msg.localRender).toEqual(SNAPSHOT)
})

test('a frame without a snapshot leaves the live bubble untouched', () => {
  const sessionId = 'friend-live-plain'
  ingestChatEvent({ sessionId, type: 'user_message', message: { message: { content: 'typed text' } } })
  const unit = getSessionStream(sessionId).liveUnits[0]
  expect(unit.type).toBe('live-user')
  if (unit.type !== 'live-user') return
  expect(unit.msg.localRender).toBeUndefined()
})
