import { expect, test } from 'bun:test'
import { activatePlanShortcut, isPlanShortcut, withPlanShortcut } from './plan-shortcut'

test('plan entry toggles in either direction while preserving a nonempty draft', async () => {
  let mode = false
  let draft = '/plan Investigate the request'
  const host = { sessionId: () => 'thread-a', readDraft: () => draft, toggle: async () => { mode = !mode; return true }, replaceDraft: (value: string) => { draft = value } }
  expect(await activatePlanShortcut(host, { start: 0, end: 5 })).toBe(true)
  expect(mode).toBe(true)
  expect(draft).toBe('Investigate the request')
  expect(await activatePlanShortcut(host, null)).toBe(true)
  expect(mode).toBe(false)
  expect(draft).toBe('Investigate the request')
})
test('a failed mode update or changed draft never consumes authored content', async () => {
  let draft = '/plan Initial request'
  const host = { sessionId: () => 'thread-a', readDraft: () => draft, toggle: async () => false, replaceDraft: (value: string) => { draft = value } }
  expect(await activatePlanShortcut(host, { start: 0, end: 5 })).toBe(false)
  expect(draft).toBe('/plan Initial request')
  host.toggle = async () => { draft = 'Changed while saving'; return true }
  expect(await activatePlanShortcut(host, { start: 0, end: 5 })).toBe(true)
  expect(draft).toBe('Changed while saving')
})
test('chat changes invalidate the draft lease and bare entry creates no model input', async () => {
  let sessionId = 'thread-a'
  let draft = '/plan'
  const host = { sessionId: () => sessionId, readDraft: () => draft, toggle: async () => { sessionId = 'thread-b'; return true }, replaceDraft: (value: string) => { draft = value } }
  expect(await activatePlanShortcut(host, { start: 0, end: 5 })).toBe(false)
  expect(draft).toBe('/plan')
  host.toggle = async () => true
  expect(await activatePlanShortcut(host, { start: 0, end: 5 })).toBe(true)
  expect(draft).toBe('')
})
test('local plan command cannot be overridden by discovery', () => {
  const commands = withPlanShortcut([{ name: 'PLAN', kind: 'command', type: 'action' }, { name: 'review', kind: 'command', type: 'action' }], 'Plan')
  expect(commands.map(command => command.name)).toEqual(['plan', 'review'])
  expect(isPlanShortcut(commands[0])).toBe(true)
})
