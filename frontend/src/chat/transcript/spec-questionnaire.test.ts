import { expect, test } from 'bun:test'
import { createQuestionSubmissionController, questionShortcutIntent } from './spec-questionnaire'

test('Enter advances, modified Enter submits, and composition or multiline keys remain text input', () => {
  expect(questionShortcutIntent({ key: 'Enter' })).toBe('advance')
  expect(questionShortcutIntent({ key: 'Enter', ctrlKey: true })).toBe('submit-all')
  expect(questionShortcutIntent({ key: 'Enter', metaKey: true })).toBe('submit-all')
  expect(questionShortcutIntent({ key: 'Enter', shiftKey: true })).toBe(null)
  expect(questionShortcutIntent({ key: 'Enter', isComposing: true })).toBe(null)
  expect(questionShortcutIntent({ key: 'Enter', keyCode: 229 })).toBe(null)
})

test('a failed response preserves the pending question and permits retry', async () => {
  const controller = createQuestionSubmissionController()
  let calls = 0
  const action = async () => ++calls === 1 ? { ok: false, error: 'Offline' } : { ok: true }
  expect(await controller.send(action, 'submitted')).toBe(false)
  expect(controller.getSnapshot()).toEqual({ phase: 'pending', failed: true })
  expect(await controller.send(action, 'submitted')).toBe(true)
  expect(controller.getSnapshot()).toEqual({ phase: 'submitted', failed: false })
  expect(calls).toBe(2)
})

test('shows submission progress and suppresses duplicate response attempts', async () => {
  const controller = createQuestionSubmissionController()
  let done!: (result: unknown) => void
  let calls = 0
  const first = controller.send(() => { calls++; return new Promise(resolve => { done = resolve }) }, 'submitted')
  expect(controller.getSnapshot().phase).toBe('submitting')
  expect(await controller.send(() => { calls++ }, 'submitted')).toBe(false)
  done({ ok: true })
  expect(await first).toBe(true)
  expect(calls).toBe(1)
})

test('a failed cancellation remains retryable and a later cancellation invalidates an in-flight answer', async () => {
  const controller = createQuestionSubmissionController()
  expect(await controller.send(() => { throw new Error('Offline') }, 'skipped')).toBe(false)
  expect(controller.getSnapshot().phase).toBe('pending')
  let done!: (result: unknown) => void
  const first = controller.send(() => new Promise(resolve => { done = resolve }), 'submitted')
  controller.resolve('skipped')
  done({ ok: true })
  expect(await first).toBe(false)
  expect(controller.getSnapshot().phase).toBe('skipped')
})
