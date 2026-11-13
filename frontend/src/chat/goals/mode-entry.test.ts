import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ScriptTarget, transpileModule } from 'typescript'
import { leavePlanningForGoal } from './mode-entry'
import { GoalInteractionClock } from './draft-review'
import type { PlanningSnapshot } from '../planning/types'

const snapshot = (mode: 'default' | 'plan'): PlanningSnapshot => ({ mode, revision: 1, plans: [] })
function fixture(mode: 'default' | 'plan' = 'plan') {
  const clock = new GoalInteractionClock(), token = clock.token('chat')
  const state = { mode, reads: 0, sets: 0, applied: null as PlanningSnapshot | null }
  const options = { valid: () => clock.token('chat') === token,
    read: async () => { state.reads++; return { planning: snapshot(state.mode) } },
    setDefault: async () => { state.sets++; state.mode = 'default'; return { planning: snapshot('default') } },
    apply: (planning: PlanningSnapshot) => { state.applied = planning },
  }
  return { state, options, clock }
}

test('fresh actual Plan state is disabled and re-read even when the local Goal badge was already armed', async () => {
  const f = fixture()
  expect(await leavePlanningForGoal(f.options)).toBe(true)
  expect(f.state).toMatchObject({ mode: 'default', reads: 2, sets: 1, applied: { mode: 'default' } })
})

test('an authoritative Default snapshot is applied without a mode mutation', async () => {
  const f = fixture('default')
  expect(await leavePlanningForGoal(f.options)).toBe(true)
  expect(f.state).toMatchObject({ reads: 1, sets: 0, applied: { mode: 'default' } })
})

test('a mode acknowledgement without an authoritative state change cannot arm Goal', async () => {
  const f = fixture()
  f.options.setDefault = async () => ({ planning: snapshot('default') })
  expect(await leavePlanningForGoal(f.options).then(() => false, () => true)).toBe(true)
  expect(f.state.applied).toBeNull()
})

test('a resolved mode refusal cannot authorize its plausible Default snapshot', async () => {
  const f = fixture()
  f.options.setDefault = async () => { f.state.sets++; return { ok: false, planning: snapshot('default') } }
  expect(await leavePlanningForGoal(f.options).then(() => null, (error: Error) => error.message)).toBe('Planning mode did not change')
  expect(f.state).toEqual({ mode: 'plan', reads: 1, sets: 1, applied: null })
})

for (const result of [undefined, { ok: false }, { planning: { mode: 'unknown' } }, { ok: false, planning: snapshot('default') }, { error: 'Read failed', planning: snapshot('default') }]) test(`malformed collaboration response cannot arm Goal: ${JSON.stringify(result)}`, async () => {
  const f = fixture()
  f.options.read = async () => result as any
  expect(await leavePlanningForGoal(f.options).then(() => false, () => true)).toBe(true)
  expect(f.state).toMatchObject({ sets: 0, applied: null })
})

test('leaving and returning during authoritative mode read cannot arm the restored composer', async () => {
  const f = fixture()
  f.options.read = async () => { f.clock.navigate(); f.clock.navigate(); return { planning: snapshot('default') } }
  expect(await leavePlanningForGoal(f.options)).toBe(false)
  expect(f.state).toMatchObject({ sets: 0, applied: null })
})

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const start = source.indexOf('async function toggleComposerGoalEnabled(')
const planningStart = source.indexOf('function applyPlanningUpdated(')
const toggleSource = transpileModule([
  source.slice(planningStart, source.indexOf('\nwindow.addEventListener', planningStart)),
  source.slice(start, source.indexOf('function hasLiveGoal(', start)),
].join('\n'), { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText

function actualEntryFixture(permission: string, refuseChange = false) {
  let mode: 'default' | 'plan' = 'plan'
  const calls: string[] = []
  const notices: string[] = []
  const preferences = { mode: 'chosen-model', thinkingLevel: 'high', fastMode: true, permissionMode: permission }
  const rejectPreferenceMutation = () => { throw new Error('Goal entry must preserve model, thinking, Fast mode and permission settings') }
  const context: Record<string, any> = { composerGoalEligible: () => true, window: { currentSessionId: 'chat' }, goalInteractions: new GoalInteractionClock(), specModeRevision: 0,
    hydrateGoalSnapshot: async () => null, composerGoalEnabled: !refuseChange, composerSpecEnabled: false, inputEl: { value: 'Preserve authored objective' }, permission, leavePlanningForGoal,
    composerPreferencesSnapshot: preferences, mainModelApi: { setItems: rejectPreferenceMutation }, permissionSelectApi: { setValue: rejectPreferenceMutation },
    klausApi: { session: {
      getCollaborationMode: async () => { calls.push('read mode'); return { planning: snapshot(mode) } },
      setCollaborationMode: async (sessionId: string, next: 'default') => {
        expect(sessionId).toBe('chat')
        expect(next).toBe('default')
        calls.push('set mode')
        if (refuseChange) return { ok: false, planning: snapshot('default') }
        mode = next
        return { planning: snapshot(mode) }
      },
      getPermissionMode: () => { throw new Error('Goal entry must not infer collaboration from permissions') },
      setPermissionMode: rejectPreferenceMutation,
      setMainModel: rejectPreferenceMutation, setThinkingLevel: rejectPreferenceMutation, setFastMode: rejectPreferenceMutation,
    } },
    receivePlanningSnapshot: () => true, ingestPlanningSnapshot() {}, composerPredictions: { invalidate() {}, suspend() {}, refresh: async () => {} },
    updateSpecBadge() {}, setComposerGoalEnabled: (enabled: boolean) => { context.composerGoalEnabled = enabled },
    showToast: (message: string) => { notices.push(message) }, tt: (key: string) => key,
  }
  const toggle = runInNewContext(`${toggleSource}; toggleComposerGoalEnabled`, context) as (force: boolean) => Promise<boolean>
  return { context, calls, notices, preferences, toggle, mode: () => mode }
}

for (const permission of ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk']) test(`the actual Goal entry exits stale Plan while preserving ${permission} permissions and authored draft`, async () => {
  const f = actualEntryFixture(permission)
  expect(await f.toggle(true)).toBe(true)
  expect(f.calls).toEqual(['read mode', 'set mode', 'read mode'])
  expect(f.context.composerGoalEnabled).toBe(true)
  expect(f.context.composerSpecEnabled).toBe(false)
  expect(f.context.permission).toBe(permission)
  expect(f.context.composerPreferencesSnapshot).toBe(f.preferences)
  expect(f.context.composerPreferencesSnapshot).toEqual({ mode: 'chosen-model', thinkingLevel: 'high', fastMode: true, permissionMode: permission })
  expect(f.context.inputEl.value).toBe('Preserve authored objective')
  expect(f.notices).toEqual([])
})

test('a refused actual Goal mode change retains the authored draft and independent preferences', async () => {
  const f = actualEntryFixture('acceptEdits', true)
  expect(await f.toggle(true)).toBe(false)
  expect(f.mode()).toBe('plan')
  expect(f.calls).toEqual(['read mode', 'set mode'])
  expect(f.context.composerGoalEnabled).toBe(false)
  expect(f.context.inputEl.value).toBe('Preserve authored objective')
  expect(f.context.composerPreferencesSnapshot).toBe(f.preferences)
  expect(f.context.composerPreferencesSnapshot).toEqual({ mode: 'chosen-model', thinkingLevel: 'high', fastMode: true, permissionMode: 'acceptEdits' })
  expect(f.notices).toEqual(['planning_mode_failed'])
})

test('an explicit goal read failure preserves the draft and reports the failed read before any mode mutation', async () => {
  const f = actualEntryFixture('acceptEdits', true)
  f.context.hydrateGoalSnapshot = async () => { throw new Error('Read timed out') }
  expect(await f.toggle(true)).toBe(false)
  expect(f.calls).toEqual([])
  expect(f.notices).toEqual(['composer_goal_load_failed'])
  expect(f.context.composerGoalEnabled).toBe(false)
  expect(f.context.inputEl.value).toBe('Preserve authored objective')
})
