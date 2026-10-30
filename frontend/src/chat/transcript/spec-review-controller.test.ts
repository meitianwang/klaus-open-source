import { describe, expect, test } from 'bun:test'
import { createSpecReviewController, isSpecExecuteShortcut, type SpecReviewDependencies } from './spec-review-controller'

const path = '/project/.klaus/specs/summary.md'
const fullDocument = '# CSV summary\n\n## Design\nKeep Decimal precision.\n\n## Interfaces\nUse a file path.\n\n## Assumptions\nNegative values are valid.\n'

function setup(overrides: Partial<SpecReviewDependencies> = {}) {
  let document = fullDocument
  let revision = 'revision-1'
  const responses: Array<{ decision: string; input?: Record<string, unknown> }> = []
  const goals: string[] = []
  const controller = createSpecReviewController({
    input: { plan: 'Create a CSV summary utility.', planFilePath: path, planRevision: 'old-tool-revision' }, path,
  }, {
    readDocument: async () => ({ content: document, revision }),
    getGoal: async () => null,
    setGoal: async objective => {
      goals.push(objective)
      return { ok: true, goal: { goalId: 'goal-1', status: 'active', objective } }
    },
    respond: async (decision, updatedInput) => { responses.push({ decision, input: updatedInput }); return { ok: true } },
    goalObjective: specPath => `Implement the Spec at ${specPath}.`,
    ...overrides,
  })
  return { controller, responses, goals, setDocument(value: string) { document = value; revision = 'revision-2' } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Spec review approval', () => {
  test('approves full text instead of an inline summary, even without an edit', async () => {
    const { controller, responses } = setup()
    expect(await controller.approve()).toBe(false)
    await controller.loadDocument()
    expect(controller.getSnapshot().content).toBe(fullDocument)
    expect(await controller.approve()).toBe(true)
    expect(responses).toEqual([{ decision: 'allow', input: { plan: fullDocument, planFilePath: path, planRevision: 'revision-1' } }])
    expect(controller.getSnapshot().phase).toBe('accepted')
  })

  test('editing an acceptance condition preserves design, interfaces and assumptions', async () => {
    const { controller, responses } = setup()
    await controller.loadDocument()
    const revised = controller.getSnapshot().content + '\n## Acceptance\nSPEC_APPROVAL_EDIT_CONFIRMED\n'
    controller.edit(revised)
    expect(await controller.approve()).toBe(true)
    expect(responses[0].input?.plan).toBe(revised)
    expect(String(responses[0].input?.plan)).toContain('## Design')
    expect(String(responses[0].input?.plan)).toContain('## Interfaces')
    expect(String(responses[0].input?.plan)).toContain('## Assumptions')
  })

  test('cannot fall back to the summary when reading the full file fails', async () => {
    const { controller, responses, goals } = setup({ readDocument: async () => ({ error: 'missing' }) })
    await controller.loadDocument()
    expect(controller.getSnapshot()).toMatchObject({ error: 'spec_review_load_failed', content: '' })
    expect(await controller.approve()).toBe(false)
    expect(responses).toEqual([])
    expect(goals).toEqual([])
  })

  test('preserves edits on conflict and uses the new revision after reload', async () => {
    const { controller, responses, setDocument } = setup()
    await controller.loadDocument()
    const edited = fullDocument + 'User acceptance condition'
    controller.edit(edited)
    setDocument(fullDocument + 'A newer revision')
    expect(await controller.approve()).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'pending', content: edited, error: 'spec_review_changed' })
    expect(responses).toEqual([])
    await controller.loadDocument()
    expect(await controller.approve()).toBe(true)
    expect(responses[0].input?.planRevision).toBe('revision-2')
    expect(responses[0].input?.plan).toBe(fullDocument + 'A newer revision')
  })

  test('never executes an empty document or empty edit', async () => {
    const empty = setup({ readDocument: async () => ({ content: '  \n' }) })
    await empty.controller.loadDocument()
    expect(empty.controller.getSnapshot().error).toBe('spec_review_empty')
    expect(await empty.controller.approve()).toBe(false)
    const edited = setup()
    await edited.controller.loadDocument()
    edited.controller.edit('  ')
    expect(await edited.controller.approve()).toBe(false)
    expect(edited.responses).toEqual([])
  })

  test('creates a path-based goal before approving the full edited document', async () => {
    const order: string[] = []
    const { controller } = setup({
      setGoal: async objective => { order.push(objective); return { ok: true, goal: { goalId: 'goal-1', status: 'active' } } },
      respond: async (_decision, input) => { order.push(String(input?.plan)); return { ok: true } },
    })
    await controller.loadDocument()
    controller.edit(fullDocument + 'Acceptance condition')
    controller.setGoalEnabled(true)
    expect(await controller.approve()).toBe(true)
    expect(order).toEqual([`Implement the Spec at ${path}.`, fullDocument + 'Acceptance condition'])
  })

  test('goal creation errors leave the review pending and allow retry', async () => {
    let attempts = 0
    const { controller, responses } = setup({ setGoal: async () => {
      if (++attempts === 1) throw new Error('Offline')
      return { ok: true, goal: { status: 'active', goalId: 'goal-1' } }
    } })
    await controller.loadDocument()
    controller.edit(fullDocument + 'Acceptance condition')
    controller.setGoalEnabled(true)
    expect(await controller.approve()).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'pending', goalEnabled: true, content: fullDocument + 'Acceptance condition', error: 'spec_review_goal_failed' })
    expect(responses).toEqual([])
    expect(await controller.approve()).toBe(true)
    expect(attempts).toBe(2)
    expect(responses).toHaveLength(1)
  })

  for (const reply of [
    { ok: false, error: 'rejected' },
    { ok: true, goal: null },
    { ok: true, goal: { status: 'complete' } },
  ]) test(`does not approve malformed or failed goal replies: ${JSON.stringify(reply)}`, async () => {
    const { controller, responses } = setup({ setGoal: async () => reply })
    await controller.loadDocument()
    controller.setGoalEnabled(true)
    expect(await controller.approve()).toBe(false)
    expect(controller.getSnapshot().error).toBe('spec_review_goal_failed')
    expect(responses).toEqual([])
  })

  test('an existing live goal is selected and locked without being replaced', async () => {
    const { controller, goals, responses } = setup()
    controller.syncGoal({ goalId: 'existing', status: 'paused' })
    controller.setGoalEnabled(false)
    expect(controller.getSnapshot()).toMatchObject({ goalEnabled: true, goalLocked: true })
    await controller.loadDocument()
    expect(await controller.approve()).toBe(true)
    expect(goals).toEqual([])
    expect(responses).toHaveLength(1)
  })

  test('finds a newly arrived goal before creating another one', async () => {
    const { controller, goals } = setup({ getGoal: async () => ({ status: 'active', goalId: 'other' }) })
    await controller.loadDocument()
    controller.setGoalEnabled(true)
    expect(await controller.approve()).toBe(true)
    expect(goals).toEqual([])
    expect(controller.getSnapshot().goalLocked).toBe(true)
  })

  test('approval retry does not recreate an already established goal', async () => {
    let attempts = 0
    const { controller, goals } = setup({ respond: async () => {
      if (++attempts === 1) throw new Error('Disconnected')
      return { ok: true }
    } })
    await controller.loadDocument()
    controller.setGoalEnabled(true)
    expect(await controller.approve()).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'pending', goalLocked: true, error: 'spec_review_approval_failed' })
    expect(await controller.approve()).toBe(true)
    expect(goals).toHaveLength(1)
  })

  test('shows Starting and prevents duplicate execution while responding', async () => {
    const response = deferred<unknown>()
    let calls = 0
    const { controller } = setup({ respond: async () => { calls++; return response.promise } })
    await controller.loadDocument()
    const first = controller.approve()
    expect(controller.getSnapshot().phase).toBe('starting')
    expect(await controller.approve()).toBe(false)
    await Promise.resolve()
    expect(calls).toBe(1)
    response.resolve({ ok: true })
    expect(await first).toBe(true)
    expect(controller.getSnapshot().phase).toBe('accepted')
    expect(await controller.approve()).toBe(false)
    controller.completeTool('ok')
    expect(controller.getSnapshot().phase).toBe('ran')
  })

  for (const status of ['ok', 'error', 'interrupted'] as const) {
    test(`uses the engine ${status} result after the approval acknowledgement`, async () => {
      const { controller, responses } = setup()
      await controller.loadDocument()
      expect(await controller.approve()).toBe(true)
      controller.resolve('allow')
      expect(controller.getSnapshot().phase).toBe('accepted')
      controller.completeTool(status)
      const phase = status === 'ok' ? 'ran' : status === 'error' ? 'failed' : 'cancelled'
      expect(controller.getSnapshot().phase).toBe(phase)
      controller.resolve('allow')
      expect(controller.getSnapshot().phase).toBe(phase)
      expect(await controller.approve()).toBe(false)
      expect(responses).toHaveLength(1)
    })
  }

  test('keeps an engine failure that arrives before the approval acknowledgement', async () => {
    const response = deferred<unknown>()
    const { controller } = setup({ respond: () => response.promise })
    await controller.loadDocument()
    const approving = controller.approve()
    await Promise.resolve()
    controller.completeTool('error')
    response.resolve({ ok: true })
    expect(await approving).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'failed', error: 'spec_review_execution_failed' })
    expect(await controller.approve()).toBe(false)
  })

  test('engine cancellation while reading prevents a later approval', async () => {
    const latest = deferred<{ content: string }>()
    let reads = 0
    const { controller, responses } = setup({ readDocument: async () => ++reads === 1 ? { content: fullDocument } : latest.promise })
    await controller.loadDocument()
    const approving = controller.approve()
    controller.resolve('cancelled')
    latest.resolve({ content: fullDocument })
    expect(await approving).toBe(false)
    expect(responses).toEqual([])
    expect(controller.getSnapshot().phase).toBe('cancelled')
  })

  test('cancellation is only final after a successful response', async () => {
    let attempts = 0
    const { controller } = setup({ respond: async () => ++attempts === 1 ? { ok: false } : { ok: true } })
    expect(await controller.cancel()).toBe(false)
    expect(controller.getSnapshot().phase).toBe('pending')
    expect(await controller.cancel()).toBe(true)
    expect(controller.getSnapshot().phase).toBe('cancelled')
  })

  test('recognizes execute shortcuts without hijacking plain Enter or composition', () => {
    expect(isSpecExecuteShortcut({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isSpecExecuteShortcut({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
    expect(isSpecExecuteShortcut({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
    expect(isSpecExecuteShortcut({ key: 'Enter', metaKey: true, ctrlKey: false, isComposing: true })).toBe(false)
    expect(isSpecExecuteShortcut({ key: 'Enter', metaKey: true, ctrlKey: false, altKey: true })).toBe(false)
  })
})
