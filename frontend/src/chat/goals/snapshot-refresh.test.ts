import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptKind, ScriptTarget, transpileModule } from 'typescript'
import { GoalSnapshots } from './snapshots'
import type { GoalSnapshot } from './types'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true, ScriptKind.TS)
const names = new Set(['hydrateGoalSnapshot', 'refreshGoalSnapshot'])
const functions = ast.statements.filter(node => isFunctionDeclaration(node) && names.has(node.name?.text || '')).map(node => node.getText(ast))
const code = transpileModule(`${functions.join('\n')}\n({ hydrateGoalSnapshot, refreshGoalSnapshot });`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText
const goal: GoalSnapshot = { goalId: 'saved-goal', threadId: 'chat', objective: 'Keep the saved objective', status: 'paused', tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 1, createdAtMs: 1, updatedAtMs: 2 }

function fixture(read: () => Promise<unknown>) {
  const snapshots = new GoalSnapshots()
  snapshots.receive('chat', goal, 3)
  const toasts: string[] = [], warnings: unknown[][] = []
  let renders = 0
  const context = {
    window: { currentSessionId: 'chat' as string | null }, goalSnapshots: snapshots,
    klausApi: { goal: { get: read } }, sessionDeletePending: new Set(),
    showToast: (message: string) => toasts.push(message), tt: (key: string) => key,
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    updateGoalIndicator: () => { renders++ },
    onGoalUpdated: (payload: { sessionId: string; goal: GoalSnapshot | null; goalRevision: number }, readToken: symbol) => {
      snapshots.receive(payload.sessionId, payload.goal, payload.goalRevision, readToken)
    },
  }
  const api = runInNewContext(code, context) as {
    hydrateGoalSnapshot(sessionId: string): Promise<GoalSnapshot | null>
    refreshGoalSnapshot(sessionId: string): Promise<void>
  }
  return { api, context, snapshots, toasts, warnings, renders: () => renders }
}

for (const response of ['timeout', 'invalid'] as const) test(`a ${response} goal refresh preserves the saved snapshot without a mutation toast`, async () => {
  const error = new Error('Goal read timed out')
  const f = fixture(async () => {
    if (response === 'timeout') throw error
    return { goal: null }
  })
  const previous = f.snapshots.get('chat')
  await f.api.refreshGoalSnapshot('chat')
  expect(f.toasts).toEqual([])
  expect(f.snapshots.get('chat')).toBe(previous)
  expect(f.snapshots.revision('chat')).toBe(3)
  expect(f.renders()).toBe(1)
  expect(f.warnings).toHaveLength(1)
  expect(f.warnings[0][1]).toBe('chat')
  if (response === 'timeout') expect(f.warnings[0][2]).toBe(error)
})

test('an explicit goal read still rejects so a goal action cannot proceed with stale state', async () => {
  const error = new Error('Goal read timed out')
  const f = fixture(async () => { throw error })
  const outcome = await f.api.hydrateGoalSnapshot('chat').then(
    value => ({ value }),
    failure => ({ failure }),
  )
  expect(outcome).toEqual({ failure: error })
  expect(f.snapshots.revision('chat')).toBe(3)
  expect(f.toasts).toEqual([])
})

test('a successful refresh installs the authoritative snapshot and redraws the current goal', async () => {
  const f = fixture(async () => ({ goal: null, goalRevision: 4 }))
  await f.api.refreshGoalSnapshot('chat')
  expect(f.snapshots.get('chat')).toBeNull()
  expect(f.snapshots.revision('chat')).toBe(4)
  expect(f.renders()).toBe(1)
  expect(f.warnings).toEqual([])
})

test('a late failed refresh does not interrupt or redraw another chat', async () => {
  let reject!: (error: Error) => void
  const f = fixture(() => new Promise((_resolve, fail) => { reject = fail }))
  const pending = f.api.refreshGoalSnapshot('chat')
  f.context.window.currentSessionId = 'other-chat'
  reject(new Error('Goal read timed out'))
  await pending
  expect(f.toasts).toEqual([])
  expect(f.renders()).toBe(0)
  expect(f.snapshots.revision('chat')).toBe(3)
})

for (const invalidation of ['push', 'clear', 'forget'] as const) test(`an explicit read invalidated by ${invalidation} never returns its obsolete result`, async () => {
  let resolve!: (value: unknown) => void
  const f = fixture(() => new Promise(done => { resolve = done }))
  const pending = f.api.hydrateGoalSnapshot('chat').then(value => ({ value }), () => ({ cancelled: true }))
  if (invalidation === 'forget') f.snapshots.forget('chat')
  else f.snapshots.receive('chat', invalidation === 'clear' ? null : { ...goal, objective: 'Updated objective' }, 4)
  resolve({ goal: { ...goal, objective: 'Obsolete objective' }, goalRevision: 99 })
  expect(await pending).toEqual(invalidation === 'forget' ? { cancelled: true } : { value: f.snapshots.get('chat') })
  expect(f.snapshots.get('chat')?.objective).not.toBe('Obsolete objective')
})
