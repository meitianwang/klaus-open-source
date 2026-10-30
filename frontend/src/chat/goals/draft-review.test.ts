import { expect, test } from 'bun:test'
import { createGoalFromDraft } from '../goal-creation'
import { goalSubmissionRoute, reviewGoalDraft, sameGoalDraft } from './draft-review'
import type { GoalSnapshot } from './types'

const goal: GoalSnapshot = { goalId: 'goal-a', threadId: 'thread-a', objective: 'Finish the complete objective', status: 'active', tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 2, createdAtMs: 1, updatedAtMs: 1 }
function fixture(objective = goal.objective, withAttachment = false) {
  const draft = { text: objective, references: [{ id: 'selected-source', label: 'Source' }] }
  const attachment = { path: '/uploads/evidence.png', name: 'evidence.png' }
  const attachments = withAttachment ? [attachment] : []
  const binding = { sessionId: 'thread-a', draft, attachments }
  const state = { current: binding, confirms: 0, reads: 0, prepares: 0, discards: 0, accepted: 0, consumed: 0 }
  const options = {
    binding, current: () => state.current, objective, goal,
    readGoal: async () => options.goal, currentGoal: () => options.goal, goalIntentVersion: () => 0,
    prepare: async () => { state.prepares++; return { objective, displayText: objective, preparationId: 'prepared-draft' } },
    readObjective: async (target: GoalSnapshot) => { state.reads++; expect(target.goalId).toBe(goal.goalId); return goal.objective },
    confirm: async () => { state.confirms++; return true },
    discard: async () => { state.discards++ },
  }
  const submit = async () => {
    const reviewed = await reviewGoalDraft(options)
    if (!reviewed) return null
    const { prepared } = reviewed
    return createGoalFromDraft({
      create: async () => ({ ok: true, goal: { ...goal, objective: prepared.objective } }),
      accept: () => { state.accepted++ }, consumeUnchangedDraft: () => { state.consumed++ },
    })
  }
  return { binding, state, options, submit, attachment }
}

test('an ordinary follow-up routes to a message even when a persistent goal is active', async () => {
  const context = fixture('A plain follow-up')
  let messages = 0
  const route = goalSubmissionRoute(false)
  if (route === 'message') messages++
  else await context.submit()
  expect(messages).toBe(1)
  expect(context.state).toMatchObject({ confirms: 0, prepares: 0, accepted: 0, consumed: 0 })
  expect(goal.objective).toBe('Finish the complete objective')
  expect(context.binding.draft.text).toBe('A plain follow-up')
})

test('the same explicit objective without attachments submits without a replacement confirmation', async () => {
  const context = fixture(`  ${goal.objective}  `)
  expect(goalSubmissionRoute(true)).toBe('goal')
  expect(await context.submit()).toMatchObject({ status: 'active' })
  expect(context.state).toMatchObject({ confirms: 0, reads: 0, prepares: 1, accepted: 1, consumed: 1, discards: 0 })
})

test('a completed objective permits a different attached objective without replacement confirmation', async () => {
  const objective = 'Complete the next objective\nPreserve its attached evidence.'
  const context = fixture(objective, true)
  const completed = { ...goal, status: 'complete' as const }
  context.options.goal = completed
  const originalDraft = context.binding.draft, originalAttachments = context.binding.attachments
  const prepared = {
    objective: 'Read the complete goal objective from this Klaus-owned file: /owned/next-objective/objective.md',
    displayText: objective, preparationId: 'next-objective-preparation',
  }
  context.options.prepare = async () => { context.state.prepares++; return prepared }

  expect(await context.submit()).toMatchObject({ status: 'active', objective: prepared.objective })
  expect(context.state).toMatchObject({ confirms: 0, reads: 0, prepares: 1, accepted: 1, consumed: 1, discards: 0 })
  expect(context.state.current.draft).toBe(originalDraft)
  expect(context.state.current.draft.text).toBe(objective)
  expect(context.state.current.attachments).toBe(originalAttachments)
  expect(context.state.current.attachments[0]).toBe(context.attachment)
  expect(completed).toMatchObject({ status: 'complete', objective: goal.objective })
})

for (const attachments of [false, true]) for (const accepted of [false, true]) test(`${attachments ? 'new attachments' : 'a changed explicit objective'} ${accepted ? 'confirm' : 'cancel'} preserves exact draft and attachment identity`, async () => {
  const context = fixture(attachments ? goal.objective : 'A different explicit objective', attachments)
  const originalDraft = context.binding.draft, originalAttachments = context.binding.attachments
  context.options.confirm = async () => { context.state.confirms++; return accepted }
  const result = await context.submit()
  expect(result === null).toBe(!accepted)
  expect(context.state.confirms).toBe(1)
  expect(context.state.accepted).toBe(accepted ? 1 : 0)
  expect(context.state.consumed).toBe(accepted ? 1 : 0)
  expect(context.state.discards).toBe(0)
  expect(context.state.current.draft).toBe(originalDraft)
  expect(context.state.current.attachments).toBe(originalAttachments)
  if (attachments) expect(context.state.current.attachments[0]).toBe(context.attachment)
})

test('identical complete materialized text does not compare different owned document references', async () => {
  const fullObjective = 'Complete objective\n'.repeat(500)
  const context = fixture(fullObjective)
  context.options.goal = { ...goal, objective: 'Read the complete goal objective from this Klaus-owned file: /owned/previous/objective.md', objectiveMaterialized: true }
  context.options.readObjective = async target => {
    context.state.reads++
    expect(target).toBe(context.options.goal)
    expect(target.threadId).toBe('thread-a')
    return fullObjective
  }
  context.options.prepare = async () => ({ objective: 'Read the complete goal objective from this Klaus-owned file: /owned/new/objective.md', displayText: fullObjective, preparationId: 'new-preparation' })
  expect(await context.submit()).not.toBeNull()
  expect(context.state).toMatchObject({ reads: 1, confirms: 0, discards: 0, accepted: 1 })
})

test('editing the draft or switching attachments while confirmation is pending cannot submit the old intent', async () => {
  for (const change of ['draft', 'attachment', 'session'] as const) {
    const context = fixture('A different objective', true)
    let finish!: (accepted: boolean) => void
    context.options.confirm = () => new Promise(resolve => { finish = resolve })
    const pending = context.submit()
    await Promise.resolve(); await Promise.resolve()
    const newerAttachment = { path: '/uploads/new.png', name: 'new.png' }
    context.state.current = change === 'draft' ? { ...context.binding, draft: { ...context.binding.draft, text: 'A newer draft' } }
      : change === 'attachment' ? { ...context.binding, attachments: [newerAttachment] } : { ...context.binding, sessionId: 'thread-b' }
    finish(true)
    expect(await pending).toBeNull()
    expect(context.state).toMatchObject({ accepted: 0, consumed: 0, discards: 0 })
    expect(sameGoalDraft(context.binding, context.state.current)).toBe(false)
    if (change === 'attachment') expect(context.state.current.attachments[0]).toBe(newerAttachment)
  }
})

test('an edit during a validated objective read remains untouched and prevents stale review', async () => {
  const context = fixture('A new long objective')
  context.options.goal = { ...goal, objectiveMaterialized: true }
  let finish!: (text: string) => void
  context.options.readObjective = () => new Promise(resolve => { finish = resolve })
  const pending = context.submit()
  await Promise.resolve(); await Promise.resolve()
  context.state.current = { ...context.binding, draft: { ...context.binding.draft, text: 'Newer authored text' } }
  finish(goal.objective)
  expect(await pending).toBeNull()
  expect(context.state.current.draft.text).toBe('Newer authored text')
  expect(context.state).toMatchObject({ confirms: 0, accepted: 0, consumed: 0, discards: 0 })
})
