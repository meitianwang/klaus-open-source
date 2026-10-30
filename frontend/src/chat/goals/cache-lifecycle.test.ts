import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { GoalEditorController } from './editor-state'
import { GoalSnapshots } from './snapshots'
import type { GoalSnapshot } from './types'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const names = new Set(['goalEditorKey', 'goalEditorFor', 'retireGoalSessionCaches', 'goalSummary', 'normalizeGoal', 'onGoalUpdated', 'forgetSessionLocalState', 'closeGoalPanel', 'forgetEditedQueueReinsert', 'persistEditedQueueReinsert'])
const functions = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text || '')).map(node => node.getText(ast))
const code = transpileModule(`${functions.join('\n')}\n({ goalEditorKey, goalEditorFor, goalSummary, onGoalUpdated, forgetSessionLocalState });`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
const base: GoalSnapshot = { goalId: 'generation-one', threadId: 'a', objective: 'Saved inline objective', status: 'paused', tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 1, createdAtMs: 1, updatedAtMs: 2 }
const materialized = { ...base, objective: 'Read the complete goal objective from /owned/one.md', objectiveMaterialized: true }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

function fixture() {
  const snapshots = new GoalSnapshots(), editors = new Map<string, GoalEditorController>()
  const presentation = new Map<string, { source: string; content: string | null; failed: boolean }>()
  const reads: ReturnType<typeof deferred<{ content: string }>>[] = []
  const otherDraft = { text: 'Keep the other conversation draft' }
  const otherFiles = [{ path: '/owned/other.png' }]
  const sessionDrafts = new Map([['a:sibling', otherDraft]]), filesBySession = new Map([['a:sibling', otherFiles]])
  let closed = 0
  const context: Record<string, any> = {
    window: { currentSessionId: null, KlausPanelTabs: { closeGoal() { closed++ } } },
    GoalEditorController, goalSnapshots: snapshots, goalEditors: editors, goalPresentationObjectives: presentation, goalPursuitEligibility: new Map(),
    goalEditorRoot: { render() {} }, openGoalSessionId: null,
    ingestTaskGoalSnapshot() {}, ingestGoalCompletion() {}, goalCompletionCleanup: { run: async () => {} }, renderGoalEditor() {}, updateGoalIndicator() {},
    tt: (key: string) => key, persistLocalValue: () => true,
    klausApi: { goal: { readObjective: async () => { const response = deferred<{ content: string }>(); reads.push(response); return response.promise } } },
    retireSessionStream() {}, engineQueueBySession: new Map(), draftOnlySessionIds: new Set(), submittedTurnSessionIds: new Set(), clearUnsentSubmission() {}, reloadOnMessageCompleteSessions: new Set(), runningSessions: new Set(), sidebarListedWorkingSessions: new Set(),
    backgroundAgentPoller: { cancel() {} }, _agentMissingObservations: new Map(), clientQueueBySession: new Map(), clientQueueMutationsInFlight: new Set(), editedQueueReinsertBySession: new Map(),
    inlineUserEdits: { forgetSession() {} }, _agentSaveTimers: new Map(), _agentSaveFailures: new Map(), tasksBySession: new Map(), pendingPermissionsBySession: new Map(), specDocBySession: new Map(),
    taskPanel: { unavailable: new Map(), metadata: new Map(), requestIds: new Map(), liveVersions: new Map() },
    ctxPanel: { sessions: new Map(), inflight: new Map(), loading: new Map(), pending: new Map() }, sessionDrafts, sessionHistories: new Map(),
    forgetLocallySentSteers() {}, forgetRunModeForDraft() {}, forgetTerminalGroup() {}, forgetSessionInputSnoozes() {}, forgetPendingQueueAdditionsForSession() {},
    markSidebarSessionSeen() {}, forgetTaskItems() {}, untrackApprovalRequestsOfSession() {}, persistDrafts() {}, persistSessionHistories() {},
    dropPendingFilesForSession: (id: string) => filesBySession.delete(id),
  }
  const api = runInNewContext(code, context) as {
    goalEditorKey(sessionId: string, goal: GoalSnapshot): string
    goalEditorFor(sessionId: string, goal: GoalSnapshot): GoalEditorController
    goalSummary(sessionId: string, goal: GoalSnapshot): string
    onGoalUpdated(payload: { sessionId: string; goal: GoalSnapshot | null; goalRevision: number }): void
    forgetSessionLocalState(sessionId: string): void
  }
  const push = (goal: GoalSnapshot | null, revision: number, sessionId = 'a') => api.onGoalUpdated({ sessionId, goal, goalRevision: revision })
  const open = (sessionId = 'a') => api.goalEditorFor(sessionId, snapshots.get(sessionId)!)
  push({ ...base, threadId: 'a:sibling', goalId: 'other-generation' }, 1, 'a:sibling')
  const other = open('a:sibling'); other.setText('Keep the other editor draft')
  return { api, context, snapshots, editors, presentation, reads, push, open, other, closed: () => closed,
    expectOtherIntact() {
      expect(editors.get(api.goalEditorKey('a:sibling', snapshots.get('a:sibling')!))).toBe(other)
      expect(other.getSnapshot()).toMatchObject({ text: 'Keep the other editor draft', dirty: true })
      expect(sessionDrafts.get('a:sibling')).toBe(otherDraft)
      expect(filesBySession.get('a:sibling')).toBe(otherFiles)
    },
  }
}

for (const outcome of ['clear', 'complete', 'replacement'] as const) test(`accepted ${outcome} retires the actual editor and full-objective presentation caches while preserving another chat`, async () => {
  const f = fixture(); f.push(materialized, 1)
  const editor = f.open(), oldKey = f.api.goalEditorKey('a', materialized)
  expect(await editor.readObjective(async () => 'Full saved objective')).toBe(true)
  editor.setText('Unsaved old-generation objective')
  f.api.goalSummary('a', f.snapshots.get('a')!)
  f.reads[0].resolve({ content: 'Full presentation objective' }); await flush()
  expect(f.presentation.get(oldKey)?.content).toBe('Full presentation objective')
  f.push(outcome === 'clear' ? null : outcome === 'complete' ? { ...materialized, status: 'complete' } : { ...base, goalId: 'generation-two', objective: 'Replacement objective' }, 2)
  expect(f.editors.has(oldKey)).toBe(false)
  expect(f.presentation.has(oldKey)).toBe(false)
  expect(editor.getSnapshot()).toMatchObject({ goal: null, text: '', savedText: '', dirty: false, loading: false, saving: false })
  if (outcome === 'replacement') expect(f.open().getSnapshot().text).toBe('Replacement objective')
  expect(f.editors.size).toBe(outcome === 'replacement' ? 2 : 1)
  f.expectOtherIntact()
})

for (const operation of ['read', 'save'] as const) test(`authoritative replacement invalidates a pending old editor ${operation} and late presentation callbacks cannot repopulate its caches`, async () => {
  const f = fixture(); f.push(materialized, 1)
  const editor = f.open(), oldGoal = f.snapshots.get('a')!, oldKey = f.api.goalEditorKey('a', oldGoal)
  const oldRead = deferred<string>(), oldSave = deferred<GoalSnapshot>()
  let pending: Promise<boolean>
  if (operation === 'read') pending = editor.readObjective(async () => oldRead.promise)
  else { await editor.readObjective(async () => 'Original complete objective'); editor.setText('Old local objective'); pending = editor.save(async () => oldSave.promise) }
  f.api.goalSummary('a', oldGoal)
  f.push({ ...base, goalId: 'generation-two', objective: 'Current objective' }, 2)
  const current = f.open(); current.setText('Current recoverable draft')
  oldRead.resolve('Stale loaded objective'); oldSave.resolve({ ...base, objective: 'Old local objective' }); f.reads[0].resolve({ content: 'Stale presentation objective' })
  expect(await pending).toBe(false); await flush()
  expect(f.editors.has(oldKey)).toBe(false)
  expect(f.presentation.has(oldKey)).toBe(false)
  expect(editor.getSnapshot()).toMatchObject({ goal: null, text: '', savedText: '' })
  expect(current.getSnapshot()).toMatchObject({ goal: { goalId: 'generation-two' }, text: 'Current recoverable draft', dirty: true })
  expect(f.editors.size).toBe(2)
  f.expectOtherIntact()
})

for (const operation of ['read', 'save'] as const) test(`forgetSessionLocalState invalidates an owned pending ${operation} without discarding another conversation`, async () => {
  const f = fixture(); f.push(materialized, 1)
  const editor = f.open(), response = deferred<string>(), saved = deferred<GoalSnapshot>()
  let pending: Promise<boolean>
  if (operation === 'read') pending = editor.readObjective(async () => response.promise)
  else { await editor.readObjective(async () => 'Original complete objective'); editor.setText('Forgotten local objective'); pending = editor.save(async () => saved.promise) }
  f.api.goalSummary('a', f.snapshots.get('a')!)
  f.context.openGoalSessionId = 'a'
  f.api.forgetSessionLocalState('a')
  response.resolve('Late forgotten objective'); saved.resolve({ ...base, objective: 'Forgotten local objective' }); f.reads[0].resolve({ content: 'Late forgotten presentation' })
  expect(await pending).toBe(false); await flush()
  expect(f.editors.size).toBe(1)
  expect(f.presentation.size).toBe(0)
  expect(editor.getSnapshot()).toMatchObject({ goal: null, text: '', savedText: '' })
  expect(f.context.openGoalSessionId).toBeNull()
  expect(f.closed()).toBe(1)
  f.expectOtherIntact()
})

test('older rejected events leave the current controller and dirty objective intact', () => {
  const f = fixture(); f.push({ ...base, goalId: 'generation-two' }, 2)
  const editor = f.open(); editor.setText('Keep current draft')
  f.push(null, 1); f.push({ ...base, status: 'complete' }, 1)
  expect(f.open()).toBe(editor)
  expect(editor.getSnapshot()).toMatchObject({ goal: { goalId: 'generation-two' }, text: 'Keep current draft', dirty: true })
  f.expectOtherIntact()
})

test('a changed objective source removes the old presentation cache before a delayed read returns', async () => {
  const f = fixture(); f.push(materialized, 1)
  const editor = f.open(), key = f.api.goalEditorKey('a', materialized)
  f.api.goalSummary('a', f.snapshots.get('a')!)
  const replacement = { ...materialized, objective: 'Read the complete goal objective from /owned/two.md' }
  f.push(replacement, 2)
  expect(f.presentation.has(key)).toBe(false)
  expect(f.open()).toBe(editor)
  f.api.goalSummary('a', f.snapshots.get('a')!)
  f.reads[0].resolve({ content: 'Obsolete complete objective' }); await flush()
  expect(f.presentation.get(key)).toMatchObject({ source: replacement.objective, content: null, failed: false })
  f.reads[1].resolve({ content: 'Current complete objective' }); await flush()
  expect(f.presentation.get(key)).toMatchObject({ source: replacement.objective, content: 'Current complete objective', failed: false })
  expect(editor.getSnapshot()).toMatchObject({ goal: { objective: replacement.objective }, text: replacement.objective, needsRead: true })
  f.expectOtherIntact()
})
