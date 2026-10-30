import { expect, test } from 'bun:test'
import { createGoalFromDraft, createGoalSubmissionGate } from './goal-creation'

test('reserves a goal draft before asynchronous preflight and session promotion', async () => {
  const gate = createGoalSubmissionGate()
  let finishPreflight!: () => void
  const preflight = new Promise<void>(resolve => { finishPreflight = resolve })
  let submissions = 0
  async function submit(sessionId: string | null) {
    const release = gate.begin(sessionId)
    if (!release) return
    try {
      await preflight
      gate.promote(null, 'created-session')
      await submit('created-session')
      submissions++
    } finally {
      release()
    }
  }
  const first = submit(null)
  await submit(null)
  expect(gate.has(null)).toBe(true)
  finishPreflight()
  await first
  expect(submissions).toBe(1)
  expect(gate.has(null)).toBe(false)
  expect(gate.has('created-session')).toBe(false)
})

test('goal reservations are independent per session and release on failure', async () => {
  const gate = createGoalSubmissionGate()
  const releaseA = gate.begin('a')!
  const releaseB = gate.begin('b')!
  expect(gate.begin('a')).toBeNull()
  expect(gate.has('b')).toBe(true)
  await (async () => {
    try { throw new Error('model unavailable') } finally { releaseA() }
  })().catch(() => {})
  expect(gate.has('a')).toBe(false)
  expect(gate.has('b')).toBe(true)
  const retry = gate.begin('a')
  expect(retry).not.toBeNull()
  retry!()
  releaseB()
})

for (const reply of [undefined, { ok: false }, { ok: true, goal: null }, { ok: true, goal: { status: 'complete' } }]) {
  test(`unsuccessful goal creation preserves the draft: ${JSON.stringify(reply)}`, async () => {
    let draft = 'Keep my objective'
    let accepted = false
    const failure = createGoalFromDraft({
      create: async () => reply,
      accept: () => { accepted = true },
      consumeUnchangedDraft: () => { draft = '' },
    }).catch(error => error.message)
    expect(await failure).toBe('Goal was not created')
    expect(draft).toBe('Keep my objective')
    expect(accepted).toBe(false)
  })
}

test('a rejected goal request leaves the draft and has no accepted side effects', async () => {
  let consumed = false
  const failure = createGoalFromDraft({
    create: async () => { throw new Error('engine offline') },
    accept: () => { throw new Error('must not accept') },
    consumeUnchangedDraft: () => { consumed = true },
  }).catch(error => error.message)
  expect(await failure).toBe('engine offline')
  expect(consumed).toBe(false)
})

test('accepts the goal before consuming only the unchanged draft', async () => {
  const events: string[] = []
  const goal = { status: 'active', objective: 'Repair tests' }
  expect(await createGoalFromDraft({
    create: async () => ({ ok: true, goal }),
    accept: () => { events.push('accepted') },
    consumeUnchangedDraft: () => { events.push('consumed') },
  })).toBe(goal)
  expect(events).toEqual(['accepted', 'consumed'])
})

for (const latest of [null, { status: 'complete', goalId: 'accepted-goal' }]) test(`accepted admission consumes its draft despite newer goal ${JSON.stringify(latest)}`, async () => {
  const events: unknown[] = []
  expect(await createGoalFromDraft({ create: async () => ({ ok: true, goal: latest, admission: 'scheduled' }),
    accept: result => events.push(result), consumeUnchangedDraft: () => { events.push('consumed') },
  })).toEqual(latest)
  expect(events).toEqual([latest, 'consumed'])
})
