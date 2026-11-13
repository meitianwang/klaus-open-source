import { expect, test } from 'bun:test'
import { transpileModule, ScriptTarget } from 'typescript'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { chatRunnerStubContext } from './test-support/chat-runner-stubs'
import { GoalInteractionClock } from './goals/draft-review'
const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
function extracted(name: string, end: string) {
  const start = source.indexOf(`function ${name}(`)
  return transpileModule(source.slice(start, source.indexOf(end, start)), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
}

test('a real running turn retains the primary Stop while explicit goal submission is pending', () => {
  const classes = new Set(['busy'])
  const attributes = new Map<string, string>()
  const button = { disabled: false, title: '',
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    getAttribute: (name: string) => attributes.get(name), removeAttribute: (name: string) => { attributes.delete(name) },
    classList: { add(name: string) { classes.add(name) }, toggle(name: string, value: boolean) { if (value) classes.add(name); else classes.delete(name) }, remove(...names: string[]) { names.forEach(name => classes.delete(name)) } } }
  const context = { ...chatRunnerStubContext(), currentPendingComposerSubmission: () => undefined, stopPendingComposerSubmission: () => false, voiceChatUi: undefined, window: { currentSessionId: 's' }, composerPredictions: undefined, composerContinueSessionId: null, composerContinueOffered: false,
    composerContinueMode: () => false, continuingSessions: new Set(), creatingGoalSessions: new Set(['s']), busy: true, stoppingSessions: new Set(), btnSend: button,
    getSessionStream: () => ({ running: true }), hasComposerText: () => true, pendingFiles: [], hasUploadInFlight: () => false, pendingSendAfterUpload: null, followUpQueueMode: 'queue', stopEscArmed: () => false, tt: (key: string) => key, updateFriendComposeControls: () => {}, friendSendInFlight: false }
  const update = runInNewContext(`${extracted('updateSendBtn', '// ==================== Input events')}; updateSendBtn`, context) as () => void
  update()
  expect(button.disabled).toBe(false)
  expect(button.title).toBe('submit_tooltip_stop')
  expect(button.getAttribute('aria-label')).toBe('submit_tooltip_stop')
  expect(classes.has('running-submit')).toBe(false)
})

test('goal duplicate-submit admission never prevents interruption of the owned running turn', () => {
  const calls: unknown[] = []
  const clock = new GoalInteractionClock()
  const originalToken = clock.token('s')
  const context = { ...chatRunnerStubContext(), currentPendingComposerSubmission: () => undefined, stopPendingComposerSubmission: () => false, stopPendingFriendTask: () => false, creatingGoalSessions: new Set(['s']), stoppingSessions: new Set(), goalInteractions: clock, clearStopEscArm() {},
    userInterruptedSessions: new Set(), getSessionStream: () => ({ activeTurnId: 'owned-turn' }), requestTurnInterrupt() {}, updateSendBtn() {}, clearTurnInterruptRequest() {},
    klausApi: { chat: { interrupt: async (...args: unknown[]) => { calls.push(args); return { accepted: true } } } } }
  const stop = runInNewContext(`${extracted('requestTurnStop', '// Continue a stopped or failed Turn')}; requestTurnStop`, context) as (sessionId: string) => void
  stop('s')
  expect(calls).toEqual([['s', 'owned-turn']])
  expect(clock.token('s')).not.toBe(originalToken)
})

 test('a successful stop with goal pause failure retains its stop ownership and shows the failure', async () => {
  const toasts: string[] = [], stopped = new Set<string>(), requested = new Set<string>()
  const context = { ...chatRunnerStubContext(), currentPendingComposerSubmission: () => undefined, stopPendingComposerSubmission: () => false, stopPendingFriendTask: () => false, stoppingSessions: stopped, goalInteractions: new GoalInteractionClock(), clearStopEscArm() {},
    userInterruptedSessions: new Set(), getSessionStream: () => ({ activeTurnId: 'turn' }), requestTurnInterrupt: (id: string) => requested.add(id), updateSendBtn() {},
    clearTurnInterruptRequest: (id: string) => requested.delete(id), showToast: (text: string) => toasts.push(text),
    klausApi: { chat: { interrupt: async () => ({ accepted: true, goalPauseError: 'Could not pause the saved goal' }) } },
  }
  const stop = runInNewContext(`${extracted('requestTurnStop', '// Continue a stopped or failed Turn')}; requestTurnStop`, context) as (sessionId: string) => void
  stop('s')
  await Promise.resolve(); await Promise.resolve()
  expect(toasts).toEqual(['Could not pause the saved goal'])
  expect(stopped.has('s')).toBe(true)
  expect(requested.has('s')).toBe(true)
})

 test('a bounded conversation with a legacy goal keeps the actual Stop path', async () => {
  const calls: unknown[] = []
  const context = { ...chatRunnerStubContext(), currentPendingComposerSubmission: () => undefined, stopPendingComposerSubmission: () => false, stopPendingFriendTask: () => false, goalPursuitEligibility: new Map([['bounded', false]]), stoppingSessions: new Set(), goalInteractions: new GoalInteractionClock(), clearStopEscArm() {},
    userInterruptedSessions: new Set(), getSessionStream: () => ({ activeTurnId: 'bounded-turn', running: true }), requestTurnInterrupt() {}, updateSendBtn() {}, clearTurnInterruptRequest() {},
    klausApi: { chat: { interrupt: async (...args: unknown[]) => { calls.push(args); return { accepted: true } } } },
  }
  const stop = runInNewContext(`${extracted('requestTurnStop', '// Continue a stopped or failed Turn')}; requestTurnStop`, context) as (sessionId: string) => void
  stop('bounded'); await Promise.resolve()
  expect(calls).toEqual([['bounded', 'bounded-turn']])
  expect(context.stoppingSessions.has('bounded')).toBe(true)
})
