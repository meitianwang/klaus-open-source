import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createGoalSubmissionGate } from './goal-creation'
import { parseManualCompactInput } from './composer/manual-compact-command'
import { chatRunnerStubContext } from './test-support/chat-runner-stubs'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const sendSource = source.slice(source.indexOf('async function send(options:'), source.indexOf('\n/**', source.indexOf('async function send(options:')))

type SendOptions = { invertFollowUp?: boolean; onAccepted?: () => void }

function fixture(action: (options: SendOptions) => Promise<void>) {
  const window = { currentSessionId: null as string | null }
  const preparingSubmissions = createGoalSubmissionGate()
  const context = { window, preparingSubmissions, creatingGoalSessions: createGoalSubmissionGate(), busy: false,
    ...chatRunnerStubContext(),
    pendingFiles: [], composedInputText: () => 'Ready submission', parseCompactSlashInput: parseManualCompactInput,
    composerGoalEnabled: false, hasLiveGoal: () => false, sendMessage: action,
    updateSendBtn: () => {}, syncBusyForCurrentSession: () => {} }
  const body = sendSource.replace('options: ComposerSendOptions = {}', 'options = {}')
  const send = new Function('context', `with (context) { return (${body}); }`)(context) as (options?: SendOptions) => Promise<void>
  return { context, window, preparingSubmissions, send }
}

test('the real send entry reserves before delayed worktree creation and session promotion', async () => {
  let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  let creates = 0
  const f = fixture(async () => { creates++; await wait })
  const first = f.send()
  await f.send()
  expect(creates).toBe(1)
  expect(f.context.busy).toBe(false)
  expect(source).toContain('preparingSubmissions.promote(null, info.id)')
  f.preparingSubmissions.promote(null, 'created')
  f.window.currentSessionId = 'created'
  await f.send()
  expect(creates).toBe(1)
  finish(); await first
  expect(f.preparingSubmissions.has('created')).toBe(false)
  expect(f.preparingSubmissions.has(null)).toBe(false)
})

test('the real send entry releases failed preparation and does not block other chats or running follow-ups', async () => {
  let calls = 0, fail = true
  const f = fixture(async () => { calls++; if (fail) throw new Error('creation failed') })
  const failure = await f.send().then(() => null, error => error.message)
  expect(failure).toBe('creation failed')
  expect(f.preparingSubmissions.has(null)).toBe(false)
  fail = false
  await f.send()
  expect(calls).toBe(2)
  const release = f.preparingSubmissions.begin(null)!
  f.window.currentSessionId = 'other'
  await f.send()
  f.context.busy = true
  await f.send({ invertFollowUp: true })
  expect(calls).toBe(4)
  release()
})
