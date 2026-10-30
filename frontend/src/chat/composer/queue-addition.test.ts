import { describe, expect, test } from 'bun:test'
import { addQueuedWithReceipt } from '../../../bridge/queue-addition'

const input = { sessionId: 'queue-session', id: 'stable-row', item: { finalText: 'Keep the original instruction', media: [{ path: '/uploads/diagram.png', type: 'image' }] }, afterId: 'before', beforeId: 'after' }

describe('durable queued additions', () => {
  test('lost acknowledgements replay the same request without changing its owner or payload', async () => {
    const calls: any[] = []
    const reply = { ok: true, snapshot: { revision: 3, items: [] } }
    const result = await addQueuedWithReceipt(async request => {
      calls.push(structuredClone(request))
      if (calls.length < 3) throw Error('Acknowledgement lost after persistence')
      return reply
    }, input)
    expect(result).toBe(reply)
    expect(calls).toHaveLength(3)
    expect(calls[0].clientMutationId).toBe(input.id)
    expect(calls[0].mutationFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(calls[0]).toEqual({ ...input, clientMutationId: input.id, mutationFingerprint: calls[0].mutationFingerprint })
    expect(calls[1]).toEqual(calls[0])
    expect(calls[2]).toEqual(calls[0])
  })

  test('a later recovery keeps the same receipt and different contents cannot reuse its fingerprint', async () => {
    const calls: any[] = []
    const send = async (request: any) => { calls.push(request); return { ok: true } }
    await addQueuedWithReceipt(send, input)
    await addQueuedWithReceipt(send, JSON.parse(JSON.stringify(input)))
    await addQueuedWithReceipt(send, { ...input, item: { ...input.item, finalText: 'Different instruction' } })
    expect(calls[1]).toEqual(calls[0])
    expect(calls[2].clientMutationId).toBe(calls[0].clientMutationId)
    expect(calls[2].mutationFingerprint).not.toBe(calls[0].mutationFingerprint)
  })

  test('transport exhaustion remains explicit after bounded attempts and a confirmed refusal is not retried', async () => {
    let calls = 0
    const failure = Error('Transport unavailable')
    let rejected: unknown
    try { await addQueuedWithReceipt(async () => { calls++; throw failure }, input) } catch (error) { rejected = error }
    expect(rejected).toBe(failure)
    expect(calls).toBe(3)
    const refused = { ok: false, error: 'Queue is full' }
    const reply = await addQueuedWithReceipt(async () => { calls++; return refused }, input)
    expect(reply).toBe(refused)
    expect(calls).toBe(4)
  })
})
