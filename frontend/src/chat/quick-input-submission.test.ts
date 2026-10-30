import { expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { createQuickInputConsumer } from './quick-input-submission'

test('repeated deliveries wait for the same send before acknowledging', async () => {
  let calls = 0, finish!: () => void
  const accept = createQuickInputConsumer(() => { calls++; return new Promise(resolve => { finish = resolve }) })
  const value = { text:'One conversation', submissionId:'same' }
  const first = accept(value), second = accept(value)
  await Promise.resolve()
  expect(calls).toBe(1)
  finish(); await Promise.all([first, second]); await accept(value)
  expect(calls).toBe(1)
})
test('a failed attempt and conflicting payload cannot start a second conversation', async () => {
  let calls = 0
  const accept = createQuickInputConsumer(async () => { calls++; throw new Error('Send was not accepted') })
  await rejects(accept({text:'Draft',submissionId:'one'}), /not accepted/)
  await rejects(accept({text:'Draft',submissionId:'one'}), /not accepted/)
  await rejects(accept({text:'Different',submissionId:'one'}), /conflicts/)
  expect(calls).toBe(1)
})
