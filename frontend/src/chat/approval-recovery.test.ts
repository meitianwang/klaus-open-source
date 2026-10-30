import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createApprovalRecovery } from './approval-recovery'
import vectors from '../../../contracts/vectors/approval-recovery-vectors.json'

const cards = vectors.cards
type Card = (typeof cards)[number]
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => { resolve = finish })
  return { promise, resolve }
}

function renderer<T extends { requestId: string; sessionId: string } = Card>(read: (sessionId: string) => Promise<T[]>) {
  const visible = new Map<string, T>()
  const received: string[] = []
  const recovery = createApprovalRecovery({
    read,
    contains: (card: T) => visible.has(card.requestId),
    receive: (card: T) => { visible.set(card.requestId, card); received.push(card.requestId) },
  })
  return { recovery, visible, received }
}

describe('pending approval recovery contract', () => {
  test('a fresh renderer restores full write and Spec cards without running-state knowledge', async () => {
    const host = async () => cards
    const first = renderer(host)
    await first.recovery.restore('session-a')
    expect([...first.visible.values()]).toEqual([cards[0]])
    // Restore every session the vector declares, in card order, so adding a card
    // to the vector needs no change here.
    const sessions = [...new Set(cards.map(card => card.sessionId))]
    const reloaded = renderer(host)
    for (const sessionId of sessions) await reloaded.recovery.restore(sessionId)
    expect([...reloaded.visible.values()]).toEqual(cards)
    expect(reloaded.visible.get('pending-spec-review')?.toolInput.plan).toBe('# Complete reviewed Spec')
    // The live plan-tool name is create_plan; a card recorded under the old name
    // must still recover, so a session opened after the rename keeps its review.
    expect(reloaded.visible.get('pending-spec-review')?.toolName).toBe('create_plan')
    expect(reloaded.visible.get('pending-spec-review-legacy')?.toolName).toBe('exit_plan_mode')
  })

  test('snapshot duplicates and an already delivered live push produce one card', async () => {
    const client = renderer(async () => [cards[0], cards[0]])
    await client.recovery.restore('session-a')
    await client.recovery.restore('session-a')
    expect(client.received).toEqual(['pending-write'])
    expect(client.recovery.accepts(cards[0])).toBe(false)
  })

  test('resolution and cancellation arriving during a snapshot cannot resurrect cards', async () => {
    for (const card of cards) {
      const pending = deferred<Card[]>()
      const client = renderer(() => pending.promise)
      const restore = client.recovery.restore(card.sessionId)
      client.recovery.settle(card.requestId)
      pending.resolve([card])
      await restore
      expect(client.visible.size).toBe(0)
      expect(client.recovery.accepts(card)).toBe(false)
    }
  })

  test('a completed host response is absent after another renderer reload', async () => {
    let pending = [...cards]
    const client = renderer(async () => pending)
    await client.recovery.restore('session-a')
    pending = pending.filter(card => card.requestId !== 'pending-write')
    const reloaded = renderer(async () => pending)
    await reloaded.recovery.restore('session-a')
    expect(reloaded.visible.size).toBe(0)
  })

  test('ignores older snapshots after a newer empty result or session removal', async () => {
    const old = deferred<Card[]>()
    let read = () => old.promise
    const client = renderer(() => read())
    const stale = client.recovery.restore('session-a')
    read = async () => []
    await client.recovery.restore('session-a')
    old.resolve([cards[0]])
    await stale
    expect(client.visible.size).toBe(0)
    const removed = deferred<Card[]>()
    read = () => removed.promise
    const late = client.recovery.restore('session-a')
    client.recovery.invalidate('session-a')
    removed.resolve([cards[0]])
    await late
    expect(client.visible.size).toBe(0)
  })

  test('retries failed reads and never routes a different session from the snapshot', async () => {
    let online = false
    const client = renderer(async () => { if (!online) throw new Error('offline'); return cards })
    await client.recovery.restore('session-a')
    expect(client.visible.size).toBe(0)
    online = true
    await client.recovery.restore('session-b')
    expect([...client.visible.values()]).toEqual([cards[1]])
  })

  test('startup and session switching request recovery outside running-session gates', () => {
    const chat = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
    expect(chat).toContain('for (const session of sessions) void restorePendingPermissions(session.id)')
    expect(chat).toContain('void restorePendingPermissions(id)')
    const bridge = readFileSync(new URL('../../bridge/klaus-api.ts', import.meta.url), 'utf8')
    expect(bridge).toContain("pending: (sessionId: string) => call('permission:pending', { sessionId })")
    expect(bridge).toContain("pending: (sessionId: string) => call('elicit:pending', { sessionId })")
    const approvals = readFileSync(new URL('./approvals.ts', import.meta.url), 'utf8')
    expect(bridge).toContain("pending: (sessionId: string) => call('question:pending', { sessionId })")
    expect(approvals).toContain('elicitationRecovery.settle(requestId)')
    expect(approvals).toContain('elicitationRecovery.invalidate(sessionId)')
  })

  test('a reloaded Spec clarification keeps options, session identity, and a single card', async () => {
    const questions = vectors.elicitationCards
    const beforeReload = renderer(async () => questions)
    await beforeReload.recovery.restore('session-a')
    const reloaded = renderer(async () => questions)
    await reloaded.recovery.restore('session-a')
    await reloaded.recovery.restore('session-a')
    expect([...reloaded.visible.values()]).toEqual([questions[0]])
    expect(reloaded.received).toEqual(['pending-spec-clarification'])
    expect(reloaded.recovery.accepts(questions[0])).toBe(false)
    expect(reloaded.visible.get(questions[0].requestId)?.options).toEqual(['Include examples', 'Keep it brief'])
  })

  test('answered and cancelled questions cannot return from a late snapshot or reload', async () => {
    for (const question of vectors.elicitationCards) {
      const pending = deferred<typeof vectors.elicitationCards>()
      const client = renderer(() => pending.promise)
      const restore = client.recovery.restore(question.sessionId)
      client.recovery.settle(question.requestId)
      pending.resolve([question])
      await restore
      expect(client.visible.size).toBe(0)
      const reloaded = renderer(async () => vectors.elicitationCards.filter(card => card.requestId !== question.requestId))
      await reloaded.recovery.restore(question.sessionId)
      expect(reloaded.visible.size).toBe(0)
    }
  })
})
