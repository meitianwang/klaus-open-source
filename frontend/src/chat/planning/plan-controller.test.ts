import workflowVectors from '../../../../contracts/vectors/planning-goals-vectors.json'
import { describe, expect, test } from 'bun:test'
import { createPlanReviewController } from './plan-controller'
import type { PlanningApi, PlanningSnapshot, ProposedPlan } from './types'
import { createPlanSourceState, planSourceContent } from './plan-source'

function setup() {
  const plan: ProposedPlan = { id: 'plan-a', threadId: 'thread-a', turnId: 'turn-a', revision: 1, content: '# Full plan\n\nComplete steps', status: 'proposed' }
  let document = { planId: plan.id, revision: 1, path: '/owned/PLAN.md', content: plan.content }
  const planning: PlanningSnapshot = { mode: 'plan', revision: 1, plans: [plan] }
  const calls: Array<{ method: string; params: unknown }> = []
  const api: PlanningApi = {
    async get() { return { planning } },
    async readDocument() { return { planning, document: { ...document } } },
    async saveDocument(session, params) { calls.push({ method: 'save', params }); document = { ...document, content: params.content }; plan.content = params.content; return { planning, document } },
    async accept(session, params) { calls.push({ method: 'accept', params }); return { planning, accepted: true } },
    async feedback(session, params) { calls.push({ method: 'feedback', params }); return { planning } },
    async cancel() { calls.push({ method: 'cancel', params: {} }); return { planning } },
  }
  return { plan, api, calls, planning, setDocument: (content: string) => { document.content = content }, controller: createPlanReviewController('thread-a', plan, api, () => {}) }
}
describe('proposed plan review', () => {
  test('acceptance saves edits and transports the complete reviewed document', async () => {
    const { controller, calls } = setup()
    await controller.openEditor()
    controller.edit('# Revised full plan\n\nOne\nTwo\nThree')
    expect(await controller.accept()).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['save', 'accept'])
    expect(calls[1].params).toMatchObject({ planId: 'plan-a', revision: 1, content: '# Revised full plan\n\nOne\nTwo\nThree' })
  })
  test('acceptance reloads full external document edits', async () => {
    const { controller, calls, setDocument } = setup()
    setDocument('# External review\n\nEntire document')
    expect(await controller.accept()).toBe(true)
    expect(calls[0].params).toMatchObject({ content: '# External review\n\nEntire document' })
  })
  test('double acceptance is single flight and stale revision cannot execute', async () => {
    const { controller, api, calls, plan } = setup()
    let release!: () => void
    api.readDocument = async () => { await new Promise<void>(resolve => { release = resolve }); return { planning: { mode: 'plan', revision: 1, plans: [plan] }, document: { planId: plan.id, revision: 1, content: plan.content, path: '/owned/PLAN.md' } } }
    const first = controller.accept()
    await Promise.resolve()
    expect(await controller.accept()).toBe(false)
    controller.sync({ ...plan, revision: 2, content: '# New plan' })
    release()
    expect(await first).toBe(false)
    expect(calls).toEqual([])
  })
  test('failed acceptance preserves edits and stable retry identity', async () => {
    const { controller, api, calls } = setup()
    api.accept = async (session, params) => { calls.push({ method: 'accept', params }); throw new Error('offline') }
    controller.edit('# Complete updated plan')
    expect(await controller.accept()).toBe(false)
    expect(controller.getSnapshot().content).toBe('# Complete updated plan')
    expect(controller.getSnapshot().error).toBe('planning_accept_failed')
    expect(await controller.accept()).toBe(false)
    const attempts = calls.filter(call => call.method === 'accept')
    expect((attempts[0].params as any).clientRequestId).toBe((attempts[1].params as any).clientRequestId)
  })
  test('feedback remains a separate action and cancellation never accepts', async () => {
    const { controller, calls } = setup()
    expect(await controller.feedback('Add migration tests')).toBe(true)
    const other = setup()
    expect(await other.controller.cancel()).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['feedback'])
    expect(other.calls.map(call => call.method)).toEqual(['cancel'])
  })
  test('switching away saves the previous editor before hiding it', async () => {
    const { controller, calls } = setup()
    await controller.openEditor()
    controller.edit('# Saved on switch')
    await controller.closeEditor()
    expect(calls[0]).toMatchObject({ method: 'save', params: { content: '# Saved on switch' } })
    expect(controller.getSnapshot().editorOpen).toBe(false)
  })
})

test('saving adopts the authoritative successor revision before accepting edited content', async () => {
  const fixture = setup()
  fixture.api.saveDocument = async (sessionId, input) => {
    const successor = { ...fixture.plan, revision: 2, content: input.content }
    const planning = { ...fixture.planning, revision: 2, plans: [successor] }
    fixture.api.readDocument = async () => ({ planning, document: { planId: successor.id, revision: 2, path: '/owned/PLAN.md', content: successor.content } })
    return { planning, document: { planId: successor.id, revision: 2, path: '/owned/PLAN.md', content: successor.content } }
  }
  fixture.controller.edit('# Full revised implementation plan')
  expect(await fixture.controller.accept()).toBe(true)
  expect(fixture.controller.getSnapshot().plan.revision).toBe(2)
  expect(fixture.calls[0]).toMatchObject({ method: 'accept', params: { revision: 2, content: '# Full revised implementation plan' } })
})

test('a conflicting external document remains intact and local edits remain recoverable', async () => {
  const { controller, setDocument, calls } = setup()
  await controller.openEditor()
  controller.edit('# Local review edits')
  setDocument('# External review edits')
  expect(await controller.accept()).toBe(false)
  expect(calls).toEqual([])
  expect(controller.getSnapshot().content).toBe('# Local review edits')
  expect(controller.getSnapshot().conflict?.content).toBe('# External review edits')
  controller.useSavedDocument()
  expect(controller.getSnapshot().content).toBe('# External review edits')
  expect(controller.getSnapshot().conflict).toBeNull()
})

test('a successor save event arriving before the reply preserves the review lease', async () => {
  const { controller, api, plan, planning } = setup()
  api.saveDocument = async (sessionId, input) => {
    const successor = { ...plan, revision: 2, content: input.content }
    controller.sync(successor)
    return { planning: { ...planning, revision: 2, plans: [successor] }, document: { planId: plan.id, revision: 2, content: input.content, path: '/owned/PLAN.md' } }
  }
  controller.edit('# Saved edits')
  expect(await controller.save()).toBe(true)
  expect(controller.getSnapshot().plan.revision).toBe(2)
  controller.edit('# New unsaved edits after save')
  expect(controller.getSnapshot().content).toBe('# New unsaved edits after save')
})

test('feedback and Escape cancellation dismiss the pending implementation choice', async () => {
  const feedback = setup()
  expect(await feedback.controller.feedback('Add recovery coverage')).toBe(true)
  expect(feedback.controller.getSnapshot().reviewPending).toBe(false)
  expect(await feedback.controller.accept()).toBe(false)
  const cancelled = setup()
  expect(await cancelled.controller.cancel()).toBe(true)
  expect(cancelled.controller.getSnapshot().reviewPending).toBe(false)
  expect(await cancelled.controller.accept()).toBe(false)
})

test('changed action kinds and content get new receipts while exact retries retain identity', async () => {
  const { controller, api, calls } = setup()
  api.feedback = async (sessionId, input) => { calls.push({ method: 'feedback', params: input }); throw new Error('offline') }
  api.accept = async (sessionId, input) => { calls.push({ method: 'accept', params: input }); throw new Error('offline') }
  await controller.feedback('Add tests')
  await controller.feedback('Add tests')
  await controller.feedback('Add migration tests')
  await controller.accept()
  const ids = calls.map(call => (call.params as { clientRequestId: string }).clientRequestId)
  expect(ids[0]).toBe(ids[1])
  expect(ids[1]).not.toBe(ids[2])
  expect(ids[2]).not.toBe(ids[3])
})

test('an open writing preview streams without materializing a partial document', async () => {
  const { plan, api } = setup()
  let reads = 0
  api.readDocument = async () => { reads++; throw new Error('A partial plan must not be materialized') }
  const controller = createPlanReviewController('thread-a', { ...plan, status: 'writing', content: '# Writing' }, api, () => {})
  expect(await controller.openEditor()).toBe(true)
  expect(reads).toBe(0)
  controller.sync({ ...plan, status: 'writing', content: '# Writing\n\nMore detail' })
  expect(controller.getSnapshot().content).toBe('# Writing\n\nMore detail')
  controller.sync({ ...plan, status: 'proposed', content: '# Finished complete plan' })
  expect(controller.getSnapshot().content).toBe('# Finished complete plan')
  expect(controller.getSnapshot().reviewPending).toBe(true)
})

test('an external successor preserves a dirty local draft until the user chooses the saved document', () => {
  const { controller, plan } = setup()
  controller.edit('# Unsaved local review')
  controller.sync({ ...plan, revision: 2, content: '# Changed elsewhere' })
  expect(controller.getSnapshot().content).toBe('# Unsaved local review')
  expect(controller.getSnapshot().plan.revision).toBe(2)
  expect(controller.getSnapshot().conflict?.content).toBe('# Changed elsewhere')
  controller.useSavedDocument()
  expect(controller.getSnapshot().content).toBe('# Changed elsewhere')
})

test('a changed chat binding cancels delayed admission while preserving the reviewed draft', async () => {
  const { controller, api, calls, plan, planning } = setup()
  let release!: () => void
  api.readDocument = async () => {
    await new Promise<void>(resolve => { release = resolve })
    return { planning, document: { planId: plan.id, revision: 1, path: '/owned/PLAN.md', content: plan.content } }
  }
  const accepting = controller.accept()
  await Promise.resolve()
  controller.invalidateBinding()
  release()
  expect(await accepting).toBe(false)
  expect(calls).toEqual([])
  expect(controller.getSnapshot().content).toBe(plan.content)
  expect(controller.getSnapshot().reviewPending).toBe(true)
})

test('an explicit refused admission keeps the review available and reports failure', async () => {
  const { controller, api, planning } = setup()
  api.accept = async () => ({ planning, accepted: false })
  expect(await controller.accept()).toBe(false)
  expect(controller.getSnapshot().reviewPending).toBe(true)
  expect(controller.getSnapshot().error).toBe('planning_accept_failed')
})

test('an externally admitted plan can close while retaining a conflicting local draft', async () => {
  const { controller, plan } = setup()
  await controller.openEditor()
  controller.edit('# Local edits kept for recovery')
  controller.sync({ ...plan, status: 'accepted' })
  await controller.closeEditor()
  expect(controller.getSnapshot().editorOpen).toBe(false)
  expect(controller.getSnapshot().content).toBe('# Local edits kept for recovery')
})

test('feedback transports complete authored units and retries use their exact identity', async () => {
  const { controller, api, calls } = setup()
  api.feedback = async (sessionId, input) => { expect(sessionId).toBe('thread-a'); calls.push({ method: 'feedback', params: input }); throw new Error('offline') }
  const feedback = '\r\n  Keep \ud800 and 🦀\udc00  \r\n'
  expect(await controller.feedback(feedback)).toBe(false)
  expect(await controller.feedback(feedback)).toBe(false)
  expect(await controller.feedback(feedback.trim())).toBe(false)
  const attempts = calls.map(call => call.params as { feedback: string; clientRequestId: string })
  expect(attempts.map(attempt => attempt.feedback)).toEqual([feedback, feedback, feedback.trim()])
  expect(attempts[0].clientRequestId).toBe(attempts[1].clientRequestId)
  expect(attempts[1].clientRequestId).not.toBe(attempts[2].clientRequestId)
  expect(await controller.feedback(' \r\n\t')).toBe(false)
  expect(calls).toHaveLength(3)
})

test('an unchanged review does not save and edited acceptance retains unedited exact source text', async () => {
  const { controller, plan, setDocument, calls } = setup()
  const source = '# Review\r\n\ud800before\r中文\n🦀\udc00\r\n'
  plan.content = source
  setDocument(source)
  expect(await controller.openEditor()).toBe(true)
  expect(controller.getSnapshot().content).toBe(source)
  expect(await controller.save()).toBe(true)
  expect(calls).toHaveLength(0)
  const editor = createPlanSourceState(source)
  const start = editor.doc.toString().indexOf('before')
  const edited = planSourceContent(editor.update({ changes: { from: start, to: start + 'before'.length, insert: 'after' } }).state)
  controller.edit(edited)
  expect(await controller.accept()).toBe(true)
  expect(calls.map(call => call.method)).toEqual(['save', 'accept'])
  expect(calls[0].params).toMatchObject({ content: '# Review\r\n\ud800after\r中文\n🦀\udc00\r\n', expectedContent: source })
  expect(calls[1].params).toMatchObject({ content: edited })
})


test('feedback drafts survive artifact replay and revisions and remain separate from another artifact', () => {
  const { controller, plan } = setup()
  const draft = workflowVectors.planFeedbackHandoff.draft
  controller.setFeedbackOpen(true)
  controller.editFeedback(draft)
  controller.sync({ ...plan })
  controller.sync({ ...plan, revision: 2, content: '# Authoritative revision' })
  expect(controller.getSnapshot()).toMatchObject({ feedbackOpen: true, feedbackDraft: draft })
  controller.setFeedbackOpen(false)
  expect(controller.getSnapshot()).toMatchObject({ feedbackOpen: false, feedbackDraft: draft })
  controller.setFeedbackOpen(true)
  expect(controller.getSnapshot().feedbackDraft).toBe(draft)
  expect(setup().controller.getSnapshot()).toMatchObject({ feedbackOpen: false, feedbackDraft: '' })
  controller.dispose()
  expect(controller.getSnapshot()).toMatchObject({ feedbackOpen: false, feedbackDraft: '' })
})

test('failed feedback keeps the whole draft and only its successful acknowledgement clears it', async () => {
  const { controller, api, planning } = setup()
  const draft = workflowVectors.planFeedbackHandoff.draft
  let refused = true
  api.feedback = async () => { if (refused) throw new Error('offline'); return { planning } }
  controller.setFeedbackOpen(true)
  controller.editFeedback(draft)
  expect(await controller.feedback(controller.getSnapshot().feedbackDraft)).toBe(false)
  expect(controller.getSnapshot()).toMatchObject({ feedbackOpen: true, feedbackDraft: draft, error: 'planning_feedback_failed' })
  refused = false
  expect(await controller.feedback(controller.getSnapshot().feedbackDraft)).toBe(true)
  expect(controller.getSnapshot()).toMatchObject({ feedbackOpen: false, feedbackDraft: '', reviewPending: false })
})
