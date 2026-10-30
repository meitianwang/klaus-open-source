import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { activateGoalShortcut } from '../composer/goal-shortcut'
import { goalSurfaceControlsAvailable, goalSurfaceEligible, type GoalSurfaceSession } from '../composer/workflow-surface'
import { GoalEditorController } from './editor-state'
import { GoalInteractionClock, reviewGoalResume } from './draft-review'
import { leavePlanningForGoal } from './mode-entry'
import { GoalSnapshots } from './snapshots'
import type { GoalSnapshot } from './types'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const names = new Set(['denyComposerGoalAttempt', 'setComposerGoalEnabled', 'composerGoalControlsAvailable', 'composerGoalEligible', 'toggleComposerGoalEnabled', 'mutateDisplayedGoal', 'updateGoalIndicator', 'renderGoalEditor', 'retireGoalSessionCaches', 'normalizeGoal', 'onGoalUpdated'])
const functions: string[] = []
function collect(node: any) { if (isFunctionDeclaration(node) && names.has(node.name?.text || '')) functions.push(node.getText(ast)); forEachChild(node, collect) }
collect(ast)
const code = transpileModule(`${functions.join('\n')}\n({ setComposerGoalEnabled, toggleComposerGoalEnabled, mutateDisplayedGoal, renderGoalEditor, composerGoalEligible, onGoalUpdated });`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
const goal: GoalSnapshot = { goalId: 'legacy-goal', threadId: 'chat', objective: 'Retain the saved objective', status: 'active', tokenBudget: null, tokensUsed: 40, timeUsedSeconds: 2, createdAtMs: 1, updatedAtMs: 2 }
function fixture(session: GoalSurfaceSession) {
  const snapshots = new GoalSnapshots(); snapshots.receive('chat', goal, 1)
  const controller = new GoalEditorController(snapshots.get('chat')!)
  const calls = { mode: 0, prepare: 0, set: [] as any[], clear: [] as any[], discard: [] as any[], hydrate: 0 }
  const toasts: string[] = []
  let editor: any, row: any
  const parent = { insertBefore() {} }
  const context: Record<string, any> = { syncBusyForCurrentSession() {}, window: { currentSessionId: 'chat' }, findKnownSession: () => session,
    goalSurfaceControlsAvailable, goalSurfaceEligible, detectChannelPrefix: () => null, goalPursuitEligibility: new Map(),
    goalInteractions: new GoalInteractionClock(), specModeRevision: 0, composerGoalEnabled: false, composerSpecEnabled: false,
    goalSnapshots: snapshots, goalEditors: new Map(), goalPresentationObjectives: new Map(), goalEditorKey: () => 'editor', openGoalSessionId: null, ingestTaskGoalSnapshot() {}, leavePlanningForGoal, inputEl: { value: '/goal Preserve this draft' },
    hydrateGoalSnapshot: async () => { calls.hydrate++; return snapshots.get('chat') },
    updateGoalBadge() {}, updateGoalPlaceholder() {},
    updateSpecBadge() {}, applyPlanningUpdated() {}, showToast: (message: string) => toasts.push(message), tt: (key: string) => key,
    isGoalConflict: () => false, refreshGoalSnapshot: async () => {},
    onGoalUpdated: ({ goal: next, goalRevision }: any) => snapshots.receive('chat', next, goalRevision),
    goalEditorRoot: null, goalEditorFor: () => controller, goalLocale: () => 'en', GoalEditor: () => null,
    goalRowRoot: null, GoalProgressRow: () => null, goalSummary: (_sessionId: string, target: GoalSnapshot) => target.objective, syncComposerStatusOrder() {}, reviewGoalResume,
    inputWrapperEl: { querySelector: () => ({ parentElement: parent }) },
    createElement: (_component: any, props: any) => props, createRoot: () => ({ render: (props: any) => { if (props?.onReviewResume) row = props; else editor = props } }),
    document: { getElementById: () => ({ parentElement: parent }) },
    klausApi: { session: {
      getCollaborationMode: async () => { calls.mode++; return { planning: { mode: 'default', revision: 0, plans: [] } } },
      setCollaborationMode: async () => { calls.mode++; return { planning: { mode: 'default', revision: 0, plans: [] } } },
    }, goal: {
      prepareObjective: async () => { calls.prepare++; return { objective: 'New saved objective', displayText: 'New saved objective', preparationId: 'owned-preparation' } },
      readObjective: async () => ({ content: goal.objective }),
      discardPreparedObjective: async (...args: any[]) => { calls.discard.push(args) },
      set: async (_sessionId: string, input: any) => { calls.set.push(input); return { ok: true, goal: { ...snapshots.get('chat'), status: input.status || 'active' }, goalRevision: 2 } },
      clear: async (_sessionId: string, input: any) => { calls.clear.push(input); return { ok: true, goal: null, goalRevision: 3 } },
    } },
  }
  const api = runInNewContext(code, context) as { setComposerGoalEnabled(enabled: boolean): void; toggleComposerGoalEnabled(force: boolean): Promise<boolean>; mutateDisplayedGoal(sessionId: string, goal: GoalSnapshot, status?: 'active' | 'paused'): Promise<unknown>; renderGoalEditor(sessionId: string, goal: GoalSnapshot): void; composerGoalEligible(): boolean; onGoalUpdated(payload: any, readToken?: number): void }
  return { api, context, calls, toasts, controller, snapshots, editor: () => editor, row: () => row }
}

for (const session of [{ threadSource: 'friend' }, { friendGroupId: 'friendship' }, { hostMetadata: { friendTask: { taskId: 'bounded' } } }, { goalPursuitEligible: false }]) test(`actual Goal entry and slash activation have no preparation or mutation side effects for ${JSON.stringify(session)}`, async () => {
  const f = fixture(session)
  f.context.composerGoalEnabled = true
  expect(await f.api.toggleComposerGoalEnabled(true)).toBe(false)
  expect(f.context.composerGoalEnabled).toBe(false)
  const draft = f.context.inputEl.value
  expect(await activateGoalShortcut({ sessionId: () => 'chat', enabled: () => f.context.composerGoalEnabled,
    enable: () => f.api.toggleComposerGoalEnabled(true), readDraft: () => f.context.inputEl.value,
    replaceDraft: value => { f.context.inputEl.value = value },
  }, { start: 0, end: 5 })).toBe(false)
  expect(f.context.inputEl.value).toBe(draft)
  expect(f.calls).toMatchObject({ hydrate: 0, mode: 0, prepare: 0, set: [], clear: [] })
})

test('fresh provider-free ineligibility prevents arming before changing collaboration mode', async () => {
  const f = fixture({})
  f.context.hydrateGoalSnapshot = async () => { f.calls.hydrate++; f.context.goalPursuitEligibility.set('chat', false); return f.snapshots.get('chat') }
  expect(await f.api.toggleComposerGoalEnabled(true)).toBe(false)
  expect(f.context.composerGoalEnabled).toBe(false)
  expect(f.calls).toMatchObject({ hydrate: 1, mode: 0, prepare: 0, set: [] })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

for (const route of ['plus', 'slash'] as const) for (const stage of ['read', 'change', 'verify'] as const) for (const armed of [false, true]) test(`${route} Goal entry stays disarmed when eligibility changes during mode ${stage}, initially armed=${armed}`, async () => {
  const f = fixture({})
  const waiting = deferred<void>(), release = deferred<void>()
  let reads = 0, applied = 0
  f.context.composerGoalEnabled = armed
  f.context.applyPlanningUpdated = () => { applied++ }
  f.context.klausApi.session.getCollaborationMode = async () => {
    f.calls.mode++
    const readStage = ++reads === 1 ? 'read' : 'verify'
    if (stage === readStage) { waiting.resolve(); await release.promise }
    return { planning: { mode: readStage === 'read' ? 'plan' : 'default', revision: reads, plans: [] } }
  }
  f.context.klausApi.session.setCollaborationMode = async () => {
    f.calls.mode++
    if (stage === 'change') { waiting.resolve(); await release.promise }
    return { planning: { mode: 'default', revision: 2, plans: [] } }
  }
  const draft = f.context.inputEl.value
  const token = f.context.goalInteractions.token('chat')
  const entry = route === 'plus' ? f.api.toggleComposerGoalEnabled(true) : activateGoalShortcut({
    sessionId: () => 'chat', enabled: () => f.context.composerGoalEnabled,
    enable: () => f.api.toggleComposerGoalEnabled(true), readDraft: () => f.context.inputEl.value,
    replaceDraft: value => { f.context.inputEl.value = value },
  }, { start: 0, end: 5 })
  await waiting.promise
  f.api.onGoalUpdated({ sessionId: 'chat', goal, goalRevision: 2, goalPursuitEligible: false })
  expect(f.context.goalInteractions.token('chat')).toBe(token)
  expect(f.context.composerGoalEnabled).toBe(false)
  release.resolve()
  expect(await entry).toBe(false)
  expect(f.context.composerGoalEnabled).toBe(false)
  expect(f.context.inputEl.value).toBe(draft)
  expect(f.calls).toMatchObject({ hydrate: 1, mode: { read: 1, change: 2, verify: 3 }[stage], prepare: 0, set: [], clear: [] })
  expect(applied).toBe(0)
  expect(f.toasts).toEqual(['goal_unavailable_context'])
})

test('final Goal arming rejects eligibility lost during an awaited conflict refresh', async () => {
  const f = fixture({})
  f.context.composerGoalEnabled = true
  const refresh = deferred<void>()
  const rearm = (async () => { await refresh.promise; f.api.setComposerGoalEnabled(true) })()
  f.api.onGoalUpdated({ sessionId: 'chat', goal, goalRevision: 2, goalPursuitEligible: false })
  refresh.resolve()
  await rearm
  expect(f.context.composerGoalEnabled).toBe(false)
  expect(f.calls).toMatchObject({ mode: 0, prepare: 0, set: [], clear: [] })
})

for (const stage of ['snapshot', 'objective'] as const) test(`resume review cannot reopen after eligibility changes during its ${stage} read`, async () => {
  const f = fixture({})
  const paused = { ...goal, status: 'paused' }
  f.api.onGoalUpdated({ sessionId: 'chat', goal: paused, goalRevision: 2, goalPursuitEligible: true })
  const waiting = deferred<void>(), release = deferred<void>()
  let objectiveReads = 0
  f.context.hydrateGoalSnapshot = async () => {
    f.calls.hydrate++
    if (stage === 'snapshot') { waiting.resolve(); await release.promise }
    return f.snapshots.get('chat')
  }
  f.context.klausApi.goal.readObjective = async () => {
    objectiveReads++
    if (stage === 'objective') { waiting.resolve(); await release.promise }
    return { content: goal.objective }
  }
  const reviewing = f.row().onReviewResume(f.snapshots.get('chat'))
  await waiting.promise
  f.api.onGoalUpdated({ sessionId: 'chat', goal: paused, goalRevision: 3, goalPursuitEligible: false })
  release.resolve()
  expect(await reviewing).toBeNull()
  expect(f.row().canPursue).toBe(false)
  expect(objectiveReads).toBe(stage === 'objective' ? 1 : 0)
  expect(f.calls).toMatchObject({ hydrate: 1, mode: 0, prepare: 0, set: [], clear: [] })
})

test('legacy bounded goals can pause and clear with exact guards while resume has no host side effect', async () => {
  const f = fixture({ threadSource: 'friend' })
  await f.api.mutateDisplayedGoal('chat', f.snapshots.get('chat')!, 'active').then(() => { throw new Error('Resume must be unavailable') }, error => { expect(error.message).toBe('Goal changed') })
  expect(f.calls.set).toEqual([])
  await f.api.mutateDisplayedGoal('chat', f.snapshots.get('chat')!, 'paused')
  expect(f.calls.set).toEqual([{ status: 'paused', expectedGoalId: goal.goalId, expectedGoalRevision: 1 }])
  await f.api.mutateDisplayedGoal('chat', f.snapshots.get('chat')!)
  expect(f.calls.clear).toEqual([{ expectedGoalId: goal.goalId, expectedGoalRevision: 2 }])
})

test('an existing bounded goal opens a read-only editor and stale Save callbacks cannot prepare or mutate', async () => {
  const f = fixture({ goalPursuitEligible: false })
  f.api.renderGoalEditor('chat', f.snapshots.get('chat')!)
  expect(f.editor().readOnly).toBe(true)
  await f.editor().onSave('A new objective', f.snapshots.get('chat')).then(() => { throw new Error('Save must be unavailable') }, (error: Error) => { expect(error.message).toBe('Goal editing is unavailable') })
  expect(f.calls).toMatchObject({ prepare: 0, set: [], clear: [] })
})

test('eligibility lost during editor materialization discards only that preparation and never saves it', async () => {
  const session: GoalSurfaceSession = {}
  const f = fixture(session)
  f.api.renderGoalEditor('chat', f.snapshots.get('chat')!)
  let finish!: (value: any) => void
  f.context.klausApi.goal.prepareObjective = async () => { f.calls.prepare++; return new Promise(resolve => { finish = resolve }) }
  const saving = f.editor().onSave('A new objective', f.snapshots.get('chat'))
  session.goalPursuitEligible = false
  finish({ objective: 'Owned objective reference', displayText: 'Full new objective', preparationId: 'owned-preparation' })
  await saving.then(() => { throw new Error('Save must be unavailable') }, (error: Error) => { expect(error.message).toBe('Goal editing is unavailable') })
  expect(f.calls.set).toEqual([])
  expect(f.calls.discard).toEqual([['chat', 'owned-preparation']])
})

 test('authoritative eligibility survives metadata-less accounting and null clear while stale reads cannot reopen pursuit', () => {
  const f = fixture({})
  f.api.onGoalUpdated({ sessionId: 'chat', goal, goalRevision: 2, goalPursuitEligible: false })
  expect(f.api.composerGoalEligible()).toBe(false)
  f.api.onGoalUpdated({ sessionId: 'chat', goal: { ...goal, tokensUsed: 100 }, goalRevision: 3 })
  expect(f.api.composerGoalEligible()).toBe(false)
  f.api.onGoalUpdated({ sessionId: 'chat', goal, goalRevision: 1, goalPursuitEligible: true })
  expect(f.api.composerGoalEligible()).toBe(false)
  f.api.onGoalUpdated({ sessionId: 'chat', goal: null, goalRevision: 4 })
  expect(f.api.composerGoalEligible()).toBe(false)
  expect(f.context.composerGoalEnabled).toBe(false)
  expect(f.calls).toMatchObject({ prepare: 0, set: [], clear: [] })
  expect(f.toasts).toEqual([])
})
