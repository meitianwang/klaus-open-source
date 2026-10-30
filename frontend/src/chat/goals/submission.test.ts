import { expect, test } from 'bun:test'
import { GoalSubmissionReceipts, goalAttachmentIntent, serializeGoalSubmissionIntent, isGoalConflict } from './submission'
import { createGoalFromDraft } from '../goal-creation'

const absent = { expectedGoalId: null, expectedGoalRevision: 0 }
test('reconnect and exact retry retain the original conditional intent without storing objective content', async () => {
  let stored = ''
  const receipts = new GoalSubmissionReceipts(value => { stored = value })
  const intent = JSON.stringify({ draft: 'Finish the private objective', attachments: [{ path: '/uploads/evidence.png' }] })
  const first = await receipts.forIntent('thread-a', intent, absent)
  const retry = await receipts.forIntent('thread-a', intent, { expectedGoalId: 'new-generation', expectedGoalRevision: 19 })
  expect(retry.id).toBe(first.id)
  expect(retry.expectedGoalId).toBeNull()
  expect(retry.expectedGoalRevision).toBe(0)
  expect(stored).not.toContain('private objective')
  expect(stored).not.toContain('/uploads')
  const restored = new GoalSubmissionReceipts(value => { stored = value }, stored)
  const reopened = await restored.forIntent('thread-a', intent, { expectedGoalId: 'new-generation', expectedGoalRevision: 19 })
  expect(reopened.id).toBe(first.id)
  expect(reopened.expectedGoalRevision).toBe(0)
  const next = await restored.forIntent('thread-a', JSON.stringify({ draft: 'Finish the private objective', attachments: [{ path: '/uploads/new-evidence.png' }] }), { expectedGoalId: 'new-generation', expectedGoalRevision: 19 })
  expect(next.id).not.toBe(first.id)
  expect(next.expectedGoalRevision).toBe(19)
})
test('a completed submission ends its receipt and different conversations remain independent', async () => {
  let stored = ''
  const receipts = new GoalSubmissionReceipts(value => { stored = value })
  const first = await receipts.forIntent('a', 'Same exact objective', absent)
  const other = await receipts.forIntent('b', 'Same exact objective', absent)
  expect(first.id).not.toBe(other.id)
  receipts.forget('a')
  expect((await receipts.forIntent('a', 'Same exact objective', absent)).id).not.toBe(first.id)
  expect((await receipts.forIntent('b', 'Same exact objective', absent)).id).toBe(other.id)
})

test('only a structured conditional-write conflict permits a new submission identity', async () => {
  const receipts = new GoalSubmissionReceipts(() => {})
  const first = await receipts.forIntent('a', 'Objective', absent)
  for (const error of [new Error('GOAL_CONFLICT'), { code: 'ENGINE_REQUEST_FAILED', message: 'GOAL_CONFLICT' }, { data: { error: { code: 'STALE_REQUEST' } } }, { data: { code: 'TIMEOUT' } }]) {
    expect(isGoalConflict(error)).toBe(false)
    expect(receipts.rejectConflict('a', first.id, error)).toBe(false)
    expect((await receipts.forIntent('a', 'Objective', { expectedGoalId: 'new', expectedGoalRevision: 5 })).id).toBe(first.id)
  }
  const conflict = Object.assign(new Error('The goal changed'), { data: { ok: false, error: { code: 'GOAL_CONFLICT', message: 'The goal changed' } } })
  expect(receipts.rejectConflict('a', 'old-receipt', conflict)).toBe(false)
  expect(receipts.rejectConflict('a', first.id, conflict)).toBe(true)
  const next = await receipts.forIntent('a', 'Objective', { expectedGoalId: 'new', expectedGoalRevision: 5 })
  expect(next.id).not.toBe(first.id)
  expect(next.expectedGoalRevision).toBe(5)
  expect(isGoalConflict({ code: 'GOAL_CONFLICT' })).toBe(true)
  expect(isGoalConflict({ data: { code: 'GOAL_CONFLICT' } })).toBe(true)
})

test('a rejected conditional submission preserves the draft until a newly reviewed intent succeeds', async () => {
  const receipts = new GoalSubmissionReceipts(() => {})
  let draft = 'Keep my complete objective'
  let consumed = 0, accepted = 0
  const stale = await receipts.forIntent('a', draft, absent)
  const conflict = Object.assign(new Error('The goal changed'), { data: { error: { code: 'GOAL_CONFLICT' } } })
  await createGoalFromDraft({
    create: async () => { throw conflict },
    accept: () => { accepted++ },
    consumeUnchangedDraft: () => { consumed++; draft = '' },
  }).catch(error => { expect(receipts.rejectConflict('a', stale.id, error)).toBe(true) })
  expect(draft).toBe('Keep my complete objective')
  expect(accepted).toBe(0)
  expect(consumed).toBe(0)
  const reviewed = await receipts.forIntent('a', draft, { expectedGoalId: 'current', expectedGoalRevision: 9 })
  expect(reviewed.id).not.toBe(stale.id)
  await createGoalFromDraft({
    create: async () => ({ ok: true, goal: { goalId: reviewed.expectedGoalId!, objective: draft, status: 'active' } }),
    accept: () => { accepted++; receipts.forget('a') },
    consumeUnchangedDraft: () => { consumed++; draft = '' },
  })
  expect(accepted).toBe(1)
  expect(consumed).toBe(1)
  expect(draft).toBe('')
})

 test('attachment snapshots preserve the durable receipt fingerprint format across reconnect', async () => {
  const draft = { text: 'Finish the objective', references: [] }
  const file = { uploading: false, file: new File(['evidence'], 'evidence.png', { type: 'image/png' }), uploadPath: '/owned/evidence.png', kind: 'file' as const }
  const captured = { ...file }
  const priorInput = JSON.stringify({ draft, files: [{ path: '/owned/evidence.png', type: 'image/png', name: 'evidence.png', size: 8, kind: 'file' }] })
  let stored = ''
  const first = await new GoalSubmissionReceipts(value => { stored = value }).forIntent('chat', priorInput, absent)
  const snapshot = goalAttachmentIntent([captured])
  file.uploadPath = '/owned/new.png'
  expect(snapshot).toEqual([{ path: '/owned/evidence.png', type: 'image/png', name: 'evidence.png', size: 8, kind: 'file', text: undefined, source: undefined }])
  expect(serializeGoalSubmissionIntent(draft, [captured])).toBe(priorInput)
  const restored = new GoalSubmissionReceipts(() => {}, stored)
  expect((await restored.forIntent('chat', serializeGoalSubmissionIntent(draft, [captured]), { expectedGoalId: 'newer', expectedGoalRevision: 5 })).id).toBe(first.id)
})
