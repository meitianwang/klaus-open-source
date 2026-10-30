import { expect, test } from 'bun:test'
import { createAgentTaskSaveGuard } from './agent-task-save-guard'

test('unacknowledged and in-flight task snapshots remain protected until their own durable acknowledgement', () => {
  const guard = createAgentTaskSaveGuard<object>()
  const first = {}, second = {}
  expect(guard.protected('parent', first)).toBe(true)
  const oldSave = guard.begin('parent')
  const newSave = guard.begin('parent')
  expect(guard.complete(newSave, second)).toBe(true)
  expect(guard.acknowledged('parent', second)).toBe(true)
  expect(guard.protected('parent', second)).toBe(true)
  expect(guard.complete(oldSave, first)).toBe(true)
  expect(guard.acknowledged('parent', second)).toBe(true)
  expect(guard.protected('parent', second)).toBe(false)
  expect(guard.protected('parent', first)).toBe(true)
})

test('retired task payloads reject old success and failure callbacks after a session is rehydrated', () => {
  const guard = createAgentTaskSaveGuard<object>()
  const stale = guard.begin('parent')
  const failed = guard.begin('parent')
  guard.forget('parent')
  expect(guard.active(stale)).toBe(false)
  const replacement = {}, current = guard.begin('parent')
  expect(guard.complete(stale, {})).toBe(false)
  expect(guard.fail(failed)).toBe(false)
  expect(guard.complete(current, replacement)).toBe(true)
  expect(guard.protected('parent', replacement)).toBe(false)
  guard.forget('parent')
  expect(guard.acknowledged('parent', replacement)).toBe(false)
})
