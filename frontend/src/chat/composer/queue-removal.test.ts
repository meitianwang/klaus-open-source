import { expect, test } from 'bun:test'
import { removeQueuedWithReceipt } from '../../../bridge/queue-removal'

test('a lost removal reply replays one immutable receipt and recovers the complete removed row', async () => {
  const requests: unknown[] = []
  const receipts = new Map<string, unknown>()
  let mutations = 0
  const row = { id: 'queued', item: { media: [{ path: '/uploads/diagram.png' }], displayText: 'Review this' } }
  const result = await removeQueuedWithReceipt(async request => {
    requests.push(structuredClone(request))
    const previous = receipts.get(request.clientMutationId)
    if (previous) return previous
    mutations++
    receipts.set(request.clientMutationId, { ok: true, removed: row })
    throw Error('Reply lost after persistence')
  }, { sessionId: 'conversation', id: 'queued', expectedRevision: 7 })
  expect(mutations).toBe(1)
  expect(requests).toHaveLength(2)
  expect(requests[0]).toEqual(requests[1])
  expect((requests[0] as any).mutationFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(result).toEqual({ ok: true, removed: row })
})

test('a confirmed refusal is returned without repeating the mutation', async () => {
  let calls = 0
  expect(await removeQueuedWithReceipt(async () => { calls++; return { ok: false, code: 'queue_revision_changed' } },
    { sessionId: 'conversation', id: 'queued' })).toEqual({ ok: false, code: 'queue_revision_changed' })
  expect(calls).toBe(1)
})

test('a persistent transport failure stays explicit after bounded receipt replay', async () => {
  let calls = 0
  let message = ''
  try { await removeQueuedWithReceipt(async () => { calls++; throw Error('Host disconnected') },
    { sessionId: 'conversation', id: 'queued' }) } catch (error) { message = String((error as Error).message) }
  expect(message).toBe('Host disconnected')
  expect(calls).toBe(3)
})
