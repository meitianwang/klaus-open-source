import { expect, test } from 'bun:test'
import type { GoalObjectiveInput } from '../../../../contracts/planning-goals'
import type { PendingFileEntry } from '../engine-events'
import { goalImageInputs, prepareGoalSubmission } from './preparation'
import { GoalSubmissionReceipts, isGoalIntentConflict, serializeGoalSubmissionIntent } from './submission'

const target = { expectedGoalId: null, expectedGoalRevision: 4 }
const draft = { text: 'Complete the objective', references: [] }
const image = (name: string, type: string, path: string): PendingFileEntry => ({ file: new File([new Uint8Array([66, 77, 0, 255, 3])], name, { type }), uploadPath: path, uploading: false })

test('submission identity and original guards are durable before the first preparation call', async () => {
  let stored = '', calls = 0, capturedId = ''
  const receipts = new GoalSubmissionReceipts(value => { stored = value })
  const files = [image('Evidence.TIFF', 'image/tiff', '/original/evidence.tiff')]
  const serializedIntent = serializeGoalSubmissionIntent(draft, files)
  const prepared = await prepareGoalSubmission({ receipts, sessionId: 'chat', serializedIntent, target,
    input: { text: draft.text, images: goalImageInputs(files) }, valid: () => true,
    onReceipt: receipt => { capturedId = receipt.id },
    prepare: async input => {
      calls++
      expect(input.clientRequestId).toBe(capturedId)
      expect(stored).toContain(capturedId)
      expect(stored).not.toContain('/original/')
      const restored = new GoalSubmissionReceipts(() => {}, stored)
      expect(await restored.forIntent('chat', serializedIntent, { expectedGoalId: 'newer', expectedGoalRevision: 10 })).toMatchObject({ id: capturedId, ...target })
      return { objective: 'Read the complete goal objective from this Klaus-owned file: /owned/original/objective.md', displayText: draft.text, preparationId: 'original-preparation' }
    },
  })
  expect(calls).toBe(1)
  expect(prepared?.receipt).toMatchObject({ id: capturedId, ...target })
  expect(prepared?.preparationId).toBe('original-preparation')
})

test('a lost preparation reply and renderer reload retain the original identity instead of creating another intent', async () => {
  let stored = '', firstId = ''
  const files = [image('Evidence.BMP', 'image/bmp', '/original/evidence.bmp')]
  const serializedIntent = serializeGoalSubmissionIntent(draft, files)
  const first = new GoalSubmissionReceipts(value => { stored = value })
  await prepareGoalSubmission({ receipts: first, sessionId: 'chat', serializedIntent, target,
    input: { text: draft.text, images: goalImageInputs(files) }, valid: () => true,
    onReceipt: receipt => { firstId = receipt.id }, prepare: async () => { throw new Error('Connection closed after preparation') },
  }).then(() => { throw new Error('Expected the lost reply') }, error => { expect(error.message).toBe('Connection closed after preparation') })
  expect(first.rejectConflict('chat', firstId, new Error('Connection closed after preparation'))).toBe(false)
  const restored = new GoalSubmissionReceipts(value => { stored = value }, stored)
  const seen: GoalObjectiveInput[] = []
  const retry = await prepareGoalSubmission({ receipts: restored, sessionId: 'chat', serializedIntent,
    target: { expectedGoalId: 'already-admitted-goal', expectedGoalRevision: 100 },
    input: { text: draft.text, images: goalImageInputs(files) }, valid: () => true, onReceipt() {},
    prepare: async input => { seen.push(input); return { objective: 'Original owned objective', displayText: draft.text, preparationId: 'original-preparation' } },
  })
  expect(retry?.receipt).toMatchObject({ id: firstId, ...target })
  expect(seen[0]).toMatchObject({ clientRequestId: firstId, images: [{ filename: 'Evidence.BMP', mimeType: 'image/bmp', path: '/original/evidence.bmp' }] })
})

test('an invalidated draft stops after receipt persistence and before any resource preparation', async () => {
  let valid = true, calls = 0, persisted = ''
  const prepared = await prepareGoalSubmission({ receipts: new GoalSubmissionReceipts(value => { persisted = value }), sessionId: 'chat', serializedIntent: 'intent', target,
    input: { text: draft.text }, valid: () => valid, onReceipt: () => { valid = false },
    prepare: async () => { calls++; return { objective: draft.text, displayText: draft.text } },
  })
  expect(prepared).toBeNull()
  expect(calls).toBe(0)
  expect(persisted).not.toBe('')
})

test('only the definitive host intent conflict releases a preparation receipt for a newly reviewed submission', async () => {
  const receipts = new GoalSubmissionReceipts(() => {})
  const first = await receipts.forIntent('chat', 'intent', target)
  for (const error of [new Error('GOAL_INTENT_CONFLICT'), { data: { error: { code: 'TIMEOUT' } } }, { code: 'ENGINE_REQUEST_FAILED', message: 'GOAL_INTENT_CONFLICT' }]) {
    expect(isGoalIntentConflict(error)).toBe(false)
    expect(receipts.rejectConflict('chat', first.id, error)).toBe(false)
    expect((await receipts.forIntent('chat', 'intent', target)).id).toBe(first.id)
  }
  const conflict = { data: { ok: false, error: { code: 'GOAL_INTENT_CONFLICT', message: 'Prepared intent changed' } } }
  expect(isGoalIntentConflict(conflict)).toBe(true)
  expect(receipts.rejectConflict('chat', first.id, conflict)).toBe(true)
  expect((await receipts.forIntent('chat', 'intent', target)).id).not.toBe(first.id)
})

for (const [filename, mimeType] of [['Evidence.BMP', 'image/bmp'], ['Scan.TIFF', 'image/tiff'], ['Photo.AVIF', 'image/avif'], ['Drawing.custom12', 'image/x-new-format']]) test(`goal image descriptors preserve ${filename} without an inline decoder allowlist`, async () => {
  const file = image(filename!, mimeType!, '/source/' + filename)
  const before = new Uint8Array(await (file.file as File).arrayBuffer())
  expect(goalImageInputs([file])).toEqual([{ filename, mimeType, path: '/source/' + filename }])
  expect(new Uint8Array(await (file.file as File).arrayBuffer())).toEqual(before)
})

test('data image content and HTTP references retain their original source strings and filenames', () => {
  const data = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E'
  expect(goalImageInputs([image('Drawing.SVG', 'image/svg+xml', data), image('Remote.TIF', 'image/tiff', 'https://images.example/source.tif')]))
    .toEqual([{ filename: 'Drawing.SVG', mimeType: 'image/svg+xml', dataUrl: data }, { filename: 'Remote.TIF', mimeType: 'image/tiff', url: 'https://images.example/source.tif' }])
})

test('text cards and non-image attachments do not become Goal image descriptors', () => {
  expect(goalImageInputs([{ ...image('quote.png', 'image/png', '/quote.png'), kind: 'selected-text' }, { ...image('paste.png', 'image/png', '/paste.png'), kind: 'pasted-text' }, image('notes.txt', 'text/plain', '/notes.txt')])).toEqual([])
  expect(goalImageInputs([image('path-image.PNG', '', '/path-image.PNG')])).toEqual([{ filename: 'path-image.PNG', path: '/path-image.PNG' }])
})

 test('explicit image metadata and data image sources do not depend on filename or MIME guesses', () => {
  const dataUrl = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E'
  const local = { ...image('Original.Scan.TIFF', '', '/owned/local-image'), kind: 'image' }
  expect(goalImageInputs([image('Drawing', '', dataUrl), local])).toEqual([{ filename: 'Drawing', dataUrl }, { filename: 'Original.Scan.TIFF', path: '/owned/local-image' }])
})
