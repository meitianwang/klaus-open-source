import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { providerErrorDetails, providerErrorTextWithRequestId } from '../../../contracts/provider-error-details'
import vectors from '../../../contracts/vectors/provider-error-details-vectors.json'
import { renderErrorNoticeHtml } from './error-notice'

let store: typeof import('./stream-store')
let previousWindow: unknown
let reply: unknown = []
const sessions = new Set<string>()
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeAll(async () => {
  previousWindow = (globalThis as any).window
  const prior = previousWindow as any
  ;(globalThis as any).window = {
    ...prior,
    addEventListener: prior?.addEventListener ?? (() => {}),
    klaus: { ...prior?.klaus, session: { ...prior?.klaus?.session, history: async () => reply } },
  }
  store = await import('./stream-store')
})

afterEach(async () => {
  await flush()
  store.chatStreamStore.setState(state => {
    const next = { ...state.sessions }
    for (const id of sessions) delete next[id]
    return { sessions: next }
  })
  sessions.clear()
  reply = []
})

afterAll(() => {
  ;(globalThis as any).window = previousWindow
})

function session(id: string): string {
  const value = `provider-diagnostics-${id}`
  sessions.add(value)
  return value
}

for (const status of [413, undefined]) {
  test(`terminal payload diagnostics retain identity with HTTP status ${status ?? 'absent'}`, async () => {
    const sessionId = session(`live-${status ?? 'stream'}`)
    const turnId = 'payload-turn'
    const details = { message: 'Request body exceeds the allowed limit', kind: 'request_too_large', requestId: 'req_payload', providerType: 'request_too_large', providerCode: 'BODY_LIMIT', ...(status === undefined ? {} : { status }) }
    const text = providerErrorTextWithRequestId(details.message, details.requestId)
    reply = { messages: [{ role: 'user', uuid: 'payload-user', text: 'Review this media', turnId }], turnStatuses: { [turnId]: 'failed' }, turnErrors: { [turnId]: text }, turnErrorKinds: { [turnId]: details.kind }, turnErrorDetails: { [turnId]: details } }
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, turnId, status: 'active' })
    store.ingestChatEvent({ type: 'api_error', sessionId, turnId, terminal: true, error: text, kind: details.kind, errorDetails: details })
    const live = store.getSessionStream(sessionId)
    expect(live.running).toBe(false)
    expect(live.lastTerminalStatus).toBe('failed')
    expect(live.turnErrorDetails[turnId]).toEqual(details)
    const error = live.liveUnits.find(unit => unit.type === 'live-error')
    expect(error?.type === 'live-error' ? error.errorDetails : undefined).toEqual(details)
    await store.loadSessionHistory(sessionId)
    await flush()
    const restored = store.getSessionStream(sessionId)
    expect(restored.turnErrors[turnId]).toBe(text)
    expect(restored.turnErrorKinds[turnId]).toBe('request_too_large')
    expect(restored.turnErrorDetails[turnId]).toEqual(details)
    if (status === undefined) expect('status' in restored.turnErrorDetails[turnId]).toBe(false)
  })
}

for (const existingSuffix of [false, true]) {
  test(`history restores diagnostics without mutating input or repeating identity (${existingSuffix})`, async () => {
    const sessionId = session(`history-${existingSuffix}`)
    const message = 'Request body exceeds the allowed limit'
    const text = providerErrorTextWithRequestId(message, 'req_history')
    const original = {
      messages: [{ role: 'user', uuid: 'history-user', text: 'Review this media', turnId: 'history-turn' }],
      turnStatuses: { 'history-turn': 'failed' },
      turnErrors: Object.freeze({ 'history-turn': existingSuffix ? text : message }),
      turnErrorKinds: Object.freeze({ 'history-turn': 'unknown' }),
      turnErrorDetails: Object.freeze({ 'history-turn': Object.freeze({ message, kind: 'request_too_large', status: 413, requestId: 'req_history' }) }),
    }
    const before = JSON.stringify(original)
    reply = original
    await store.loadSessionHistory(sessionId)
    const restored = store.getSessionStream(sessionId)
    expect(restored.turnErrors['history-turn']).toBe(text)
    expect(restored.turnErrorKinds['history-turn']).toBe('request_too_large')
    expect(restored.turnErrorDetails['history-turn'].requestId).toBe('req_history')
    expect(JSON.stringify(original)).toBe(before)
  })
}

test('old saved errors remain compatible without invented diagnostic fields', async () => {
  const sessionId = session('legacy')
  reply = { messages: [], turnStatuses: { old: 'failed' }, turnErrors: { old: 'Original provider refusal' }, turnErrorKinds: { old: 'unknown' } }
  await store.loadSessionHistory(sessionId)
  const restored = store.getSessionStream(sessionId)
  expect(restored.turnErrors.old).toBe('Original provider refusal')
  expect(restored.turnErrorDetails).toEqual({})
})

test('canonical nested provider diagnostics survive reopening without invented stream status', async () => {
  const sessionId = session('nested-stream')
  const provider = { message: 'Original stream payload refusal', kind: 'request_too_large', code: 'BODY_LIMIT', type: 'request_too_large', requestId: 'req_nested' }
  const details = { code: 'provider_error', message: provider.message, kind: provider.kind, providerError: provider, recoveryReason: 'reactive-compaction-disabled' }
  reply = { messages: [], turnStatuses: { nested: 'failed' }, turnErrors: { nested: provider.message }, turnErrorKinds: { nested: 'unknown' }, turnErrorDetails: { nested: details } }
  await store.loadSessionHistory(sessionId)
  const restored = store.getSessionStream(sessionId)
  expect(restored.turnErrors.nested).toBe('Original stream payload refusal (request-id: req_nested)')
  expect(restored.turnErrorKinds.nested).toBe('request_too_large')
  const normalized = restored.turnErrorDetails.nested
  expect(normalized.code).toBe('provider_error')
  expect(normalized.providerCode).toBe('BODY_LIMIT')
  expect(normalized.providerType).toBe('request_too_large')
  expect(normalized.providerError).toEqual(provider)
  expect(normalized.recoveryReason).toBe('reactive-compaction-disabled')
  expect('status' in normalized).toBe(false)
})

for (const row of vectors.projectionCases.filter(row => row.name.startsWith('canonical_nested'))) {
  test(`${row.name} retains source diagnostics in live state and reopened history`, async () => {
    const sessionId = session(row.name)
    const turnId = 'canonical-turn'
    const original = JSON.stringify(row.error)
    const details = providerErrorDetails(row.expectedDetails)!
    reply = Object.freeze({
      messages: [{ role: 'user', uuid: 'canonical-user', text: 'Review this media', turnId }],
      turnStatuses: Object.freeze({ [turnId]: 'failed' }),
      turnErrors: Object.freeze({ [turnId]: row.error.message }),
      turnErrorKinds: Object.freeze({ [turnId]: 'unknown' }),
      turnErrorDetails: Object.freeze({ [turnId]: row.error }),
    })
    store.ingestChatEvent({ type: 'session_runtime_status', sessionId, turnId, status: 'active' })
    store.ingestChatEvent({ type: 'api_error', sessionId, turnId, terminal: true, error: row.expectedText, kind: row.expectedKind, errorDetails: details })
    expect(store.getSessionStream(sessionId).turnErrorDetails[turnId]).toEqual(row.expectedDetails)
    await store.loadSessionHistory(sessionId)
    const restored = store.getSessionStream(sessionId)
    expect(restored.turnErrors[turnId]).toBe(row.expectedText)
    expect(restored.turnErrorKinds[turnId]).toBe(row.expectedKind)
    expect(restored.turnErrorDetails[turnId]).toEqual(row.expectedDetails)
    expect(JSON.stringify(row.error)).toBe(original)
    if (row.name.includes('statusless')) expect(restored.turnErrorDetails[turnId]).not.toHaveProperty('status')
    const html = renderErrorNoticeHtml(row.expectedText)
    expect(html).toContain(row.expectedText)
    expect(html).not.toContain(JSON.stringify(restored.turnErrorDetails[turnId], null, 2))
    expect(html).not.toContain(row.error.recoveryReason!)
    expect(html).not.toContain('<details')
    expect(html).not.toContain('<summary')
    expect(html).not.toContain('error-notice-detail')
  })
}

describe('diagnostic input validation', () => {
  test('invalid fields do not become status, delay, or request identity', () => {
    expect(providerErrorDetails({ message: 'Original refusal', status: 413.5, retryAfterMs: -1, requestId: {} })).toEqual({ message: 'Original refusal' })
    for (const value of [null, [], 'failure', 413]) expect(providerErrorDetails(value)).toBeUndefined()
  })

  test('static notices escape their message and never expose diagnostic details', () => {
    const html = renderErrorNoticeHtml('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).toBe('<div class="error-notice"><div class="error-notice-text">&lt;img src=x onerror=alert(1)&gt;</div></div>')
  })

  test('an explicit empty request identity retains legacy formatting', () => {
    expect(providerErrorTextWithRequestId('Original refusal', '')).toBe('Original refusal (request-id: )')
    expect(providerErrorTextWithRequestId('Original refusal (request-id: )', '')).toBe('Original refusal (request-id: )')
    expect(providerErrorTextWithRequestId('Original refusal (request-id: req) recovery exhausted', 'req')).toBe('Original refusal (request-id: req) recovery exhausted')
  })
})
