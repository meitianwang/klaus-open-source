import { describe, expect, test } from 'bun:test'
import { isTurnInProgressRefusal } from './send-refusal'

describe('turn-in-progress refusal routing', () => {
  test('the structured code routes the send to the follow-up channel', () => {
    expect(isTurnInProgressRefusal({ code: 'TURN_IN_PROGRESS', message: 'anything' })).toBe(true)
  })
  test('the host wording routes even when the bridge keeps only the message', () => {
    expect(isTurnInProgressRefusal(new Error('Use a follow-up while a turn is running'))).toBe(true)
  })
  test('provider failures and other refusals keep their transcript row', () => {
    expect(isTurnInProgressRefusal(new Error('Provider failed'))).toBe(false)
    expect(isTurnInProgressRefusal({ code: 'SESSION_UNAVAILABLE', message: 'The conversation closed before the turn started' })).toBe(false)
  })
  test('absent or non-object errors are not refusals', () => {
    expect(isTurnInProgressRefusal(null)).toBe(false)
    expect(isTurnInProgressRefusal(undefined)).toBe(false)
    expect(isTurnInProgressRefusal('boom')).toBe(false)
  })
})
