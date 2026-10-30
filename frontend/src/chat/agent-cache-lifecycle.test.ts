import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { agentTasksEquivalent, observeMissingBackgroundAgents, reconcileAgentRuntimeState } from './agent-status'
import { createAgentTaskSaveGuard } from './agent-task-save-guard'
import { createAgentTaskSnapshotBuilder } from './agent-task-snapshot'
import { ByteBudgetLru } from './byte-budget'
import type { AgentTask } from './engine-events'

const source = readFileSync(new URL('./chat.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('chat.ts', source, ts.ScriptTarget.Latest, true)
const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'refreshAgentsForSession')!
const code = ts.transpileModule(`${declaration.getText(parsed)}\nrefreshAgentsForSession`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const deferred = () => {
  let resolve!: (result: any) => void
  const promise = new Promise<any>(complete => { resolve = complete })
  return { promise, resolve }
}

for (const stage of ['history', 'snapshot'] as const) test(`a retired agent ${stage} read cannot rehydrate an old task payload`, async () => {
  const reply = deferred(), lifetimes = new Map(), tokens = new Map(), tasks = new Map()
  let snapshotCalls = 0, trimCalls = 0
  const context = {
    agentTaskLifetimes: lifetimes, agentTaskLoadTokens: tokens, isSessionStreamRetired: () => false,
    klausApi: { agents: {
      loadTasks: () => stage === 'history' ? reply.promise : Promise.resolve({ tasks: { saved: {} } }),
      snapshot: () => { snapshotCalls++; return stage === 'snapshot' ? reply.promise : Promise.resolve({ tasks: {} }) },
    } },
    mergeAgentTasks: (id: string, rows: any) => { tasks.set(id, rows) }, autoTerminateVanishedRunningTasks() {},
    reconcileAgentTasksFromEngine: async () => {}, renderSubagentSection() {},
    trimSessionStreamCache: () => { trimCalls++ }, window: { currentSessionId: 'retired' }, console,
  }
  const refresh = runInNewContext(code, context) as (id: string) => Promise<void>
  const pending = refresh('retired')
  await Promise.resolve(); await Promise.resolve()
  lifetimes.delete('retired'); tokens.delete('retired'); tasks.delete('retired')
  const replacement = {}, replacementToken = {}
  lifetimes.set('retired', replacement); tokens.set('retired', replacementToken)
  reply.resolve({ tasks: { stale: { messages: ['old payload'] } } })
  await pending
  expect(tasks.has('retired')).toBe(false)
  expect(lifetimes.get('retired')).toBe(replacement)
  expect(tokens.get('retired')).toBe(replacementToken)
  expect(snapshotCalls).toBe(stage === 'history' ? 0 : 1)
  expect(trimCalls).toBe(1)
})

const reconcileDeclaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'reconcileAgentTasksFromEngine')!
const reconcileCode = ts.transpileModule(`${reconcileDeclaration.getText(parsed)}\nreconcileAgentTasksFromEngine`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function reconcilerFixture(initial: Record<string, AgentTask>, summaries: unknown[]) {
  const tasks = new Map([['saved-parent', initial]])
  let saves = 0, notifications = 0
  const reconcile = runInNewContext(reconcileCode, {
    agentTaskLifetimes: new Map([['saved-parent', {}]]), tasksBySession: tasks, _agentMissingObservations: new Map(),
    isSessionStreamRetired: () => false,
    klausApi: { agents: { backgroundSummaries: async () => ({ agents: summaries }) } },
    observeMissingBackgroundAgents, reconcileAgentRuntimeState, agentTasksEquivalent,
    backgroundAgentPoller: { update() {}, retry() {} },
    ingestChatEvent() {}, notifySubagentsChanged: () => { notifications++ },
    scheduleAgentTasksSave: () => { saves++ }, scheduleTeammateViewRefresh() {}, console,
  }) as (sessionId: string) => Promise<boolean>
  return { tasks, reconcile: () => reconcile('saved-parent'), saves: () => saves, notifications: () => notifications }
}

test('unchanged authoritative reconciliation preserves an acknowledged snapshot and permits its cache eviction', async () => {
  const initial: Record<string, AgentTask> = { task: { agentId: 'saved-agent', status: 'completed', isBackground: true, isIdle: false,
    messages: [{ role: 'assistant', text: 'Saved child reply' }] } }
  const fixture = reconcilerFixture(initial, [{ id: 'saved-agent', status: 'completed' }])
  const build = createAgentTaskSnapshotBuilder(), guard = createAgentTaskSaveGuard<object>()
  const timeline: any[] = []
  const snapshot = () => build(fixture.tasks.get('saved-parent')!, () => 'saved-parent', () => timeline)
  const acknowledged = snapshot()
  guard.complete(guard.begin('saved-parent'), acknowledged)
  expect(await fixture.reconcile()).toBe(false)
  expect(await fixture.reconcile()).toBe(false)
  expect(fixture.tasks.get('saved-parent')).toBe(initial)
  expect(snapshot()).toBe(acknowledged)
  expect(guard.protected('saved-parent', snapshot())).toBe(false)
  expect(fixture.saves()).toBe(0)
  expect(fixture.notifications()).toBe(0)
  const cache = new ByteBudgetLru<string, object>(1)
  cache.set('saved-parent', initial, 8)
  expect(cache.trim(id => guard.protected(id, snapshot())).map(([id]) => id)).toEqual(['saved-parent'])
})

test('a changed authoritative reconciliation replaces and saves the snapshot once before it becomes stable again', async () => {
  const initial: Record<string, AgentTask> = { task: { agentId: 'saved-agent', status: 'running', isBackground: true } }
  const fixture = reconcilerFixture(initial, [{ id: 'saved-agent', status: 'completed', model: 'current-model', modelSource: 'current-source',
    parentAgentId: 'parent-agent', spawnTurnId: 'child-turn', depth: 2, startedAtMs: 10, updatedAtMs: 30, completedAtMs: 30 }])
  expect(await fixture.reconcile()).toBe(true)
  const changed = fixture.tasks.get('saved-parent')!
  expect(changed).not.toBe(initial)
  expect(changed.task).toMatchObject({ status: 'completed', isIdle: false, model: 'current-model', modelSource: 'current-source',
    parentAgentId: 'parent-agent', spawnTurnId: 'child-turn', depth: 2, startedAtMs: 10, updatedAtMs: 30, completedAtMs: 30, lifecycleUpdatedAtMs: 30, recencyAtMs: 30 })
  expect(fixture.saves()).toBe(1)
  expect(fixture.notifications()).toBe(1)
  expect(await fixture.reconcile()).toBe(false)
  expect(fixture.tasks.get('saved-parent')).toBe(changed)
  expect(fixture.saves()).toBe(1)
})
