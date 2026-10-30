// The decision a paused queue forces on an ordinary send.
//
// This is the rule, not the dialog: three exits, two of which send. The case that
// matters most is the dismissal — a user who pressed Escape was asked a question
// and did not answer it, so nothing may go out. Every branch here was reachable
// from the composer before it had a name.
import { describe, expect, test } from 'bun:test'
import { decisionFromDialog, needsPausedQueueConfirmation, pausedQueueDecision } from './paused-queue-submit'

describe('sending while the queue is paused', () => {
  test('the primary answer sends and keeps the queued rows', () => {
    expect(pausedQueueDecision({ cancelled: false, clear: false })).toBe('send-and-resume')
  })

  test('the destructive answer sends and drops the queued rows', () => {
    expect(pausedQueueDecision({ cancelled: false, clear: true })).toBe('send-and-clear')
  })

  test('a dismissed dialog sends nothing', () => {
    expect(pausedQueueDecision({ cancelled: true, clear: false })).toBe('cancel')
    // Escape with the checkbox ticked must still not send: the destructive flag
    // only means something together with an actual send.
    expect(pausedQueueDecision({ cancelled: true, clear: true })).toBe('cancel')
  })

  test('a dialog that never answered is treated as a dismissal', () => {
    expect(pausedQueueDecision(null)).toBe('cancel')
    expect(pausedQueueDecision(undefined)).toBe('cancel')
  })

  test('only a paused queue asks; a merely non-empty one does not', () => {
    expect(needsPausedQueueConfirmation(true, 1)).toBe(true)
    expect(needsPausedQueueConfirmation(true, 3)).toBe(true)
    // Rows waiting for a turn that is still running are the ordinary case, and a
    // modal on every one of them would be worse than the ambiguity it resolves.
    expect(needsPausedQueueConfirmation(false, 3)).toBe(false)
    expect(needsPausedQueueConfirmation(true, 0)).toBe(false)
  })

  test('a malformed queue count never triggers the dialog', () => {
    expect(needsPausedQueueConfirmation(true, Number.NaN)).toBe(false)
    expect(needsPausedQueueConfirmation(true, -1)).toBe(false)
    expect(needsPausedQueueConfirmation(true, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('translating the dialog result into a decision', () => {
  // The dialog answers `{confirmed, checked}` but the queue wants
  // `{cancelled, clear}`. This mapping is the untested seam my verification
  // harness walked straight through: feeding it a raw result gave the same
  // `send-and-resume` for every path, because nothing was inverting `confirmed`.
  // These assert the translation itself, field by field.
  test('a confirmed send without the checkbox keeps the rows', () => {
    expect(decisionFromDialog({ confirmed: true, checked: false })).toBe('send-and-resume')
    // `checked` absent means the checkbox was never offered — still a plain send.
    expect(decisionFromDialog({ confirmed: true })).toBe('send-and-resume')
  })

  test('a confirmed send with the checkbox clears the rows', () => {
    expect(decisionFromDialog({ confirmed: true, checked: true })).toBe('send-and-clear')
  })

  test('Escape / backdrop / Cancel sends nothing, checkbox ticked or not', () => {
    expect(decisionFromDialog({ confirmed: false, checked: false })).toBe('cancel')
    // The single most dangerous case: a user who ticked "clear the queue" and then
    // dismissed must NOT have their queue destroyed — they never sent.
    expect(decisionFromDialog({ confirmed: false, checked: true })).toBe('cancel')
  })

  test('a missing result is a dismissal, never a silent send', () => {
    expect(decisionFromDialog(null)).toBe('cancel')
    expect(decisionFromDialog(undefined)).toBe('cancel')
  })
})
