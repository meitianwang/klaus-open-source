// Pins the deferred-send rule: a submit made while an attachment is still
// uploading must be kept and replayed, never silently dropped.
import { describe, expect, test } from 'bun:test'
import { hasUploadInFlight, resolveDeferredSend } from './deferred-send'

const intent = { invertFollowUp: false }

describe('hasUploadInFlight', () => {
  test('reports in-flight uploads and tolerates sparse entries', () => {
    expect(hasUploadInFlight([])).toBe(false)
    expect(hasUploadInFlight([{ uploading: false }])).toBe(false)
    expect(hasUploadInFlight([{ uploading: false }, { uploading: true }])).toBe(true)
    expect(hasUploadInFlight([{}])).toBe(false)
  })
})

describe('resolveDeferredSend', () => {
  test('does nothing when no submit was parked', () => {
    expect(resolveDeferredSend(null, [{ uploading: true }], true)).toEqual({ action: 'none' })
    expect(resolveDeferredSend(null, [], true)).toEqual({ action: 'none' })
  })

  test('keeps waiting while any upload is still in flight', () => {
    expect(resolveDeferredSend(intent, [{ uploading: true }], true)).toEqual({ action: 'wait' })
    expect(resolveDeferredSend(intent, [{ uploading: false }, { uploading: true }], true))
      .toEqual({ action: 'wait' })
  })

  test('sends once every upload settled, carrying the original options', () => {
    expect(resolveDeferredSend(intent, [{ uploading: false }], true))
      .toEqual({ action: 'send', intent })
    expect(resolveDeferredSend({ invertFollowUp: true }, [{ uploading: false }], true))
      .toEqual({ action: 'send', intent: { invertFollowUp: true } })
  })

  test('drops the intent when the uploads failed and nothing is left to send', () => {
    // Every attachment was removed by a failed upload and the composer is empty:
    // replaying the submit would be a no-op, so the intent is discarded.
    expect(resolveDeferredSend(intent, [], false)).toEqual({ action: 'none' })
  })

  test('still sends when uploads failed but the user typed text', () => {
    expect(resolveDeferredSend(intent, [], true)).toEqual({ action: 'send', intent })
  })
})
