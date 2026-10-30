import { describe, expect, test } from 'bun:test'
import { GoalActionController } from './action-state'
import { startGoalClock } from './clock'
import { GoalEditorController } from './editor-state'
import { goalDurationText, goalElapsedMilliseconds, goalMetricIsTokens, goalMetricText, goalUpdatedText, isGoalSaveShortcut } from './format'
import { goalStatusLabel } from './messages'
import { goalNextStatus, type GoalSnapshot, type GoalStatus } from './types'

const goal: GoalSnapshot = {
  goalId: 'goal-one', threadId: 'thread-one', objective: 'Ship the feature', status: 'active',
  tokenBudget: 10000, tokensUsed: 6400, timeUsedSeconds: 62, createdAtMs: 1000, updatedAtMs: 10000,
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('goal presentation', () => {
  const labels: Record<GoalStatus, string> = {
    active: 'Pursuing goal', paused: 'Paused goal', blocked: 'Goal stalled', usage_limited: 'Goal usage limited',
    budget_limited: 'Goal limited', complete: 'Goal achieved',
  }
  for (const status of Object.keys(labels) as GoalStatus[]) {
    test(`${status} has localized state, permitted control and exact metric`, () => {
      expect(goalStatusLabel(status)).toBe(labels[status])
      expect(goalStatusLabel(status, 'zh-CN')).not.toBe(labels[status])
      expect(goalNextStatus(status)).toBe(status === 'active' ? 'paused' :
        ['paused', 'blocked', 'usage_limited'].includes(status) ? 'active' : null)
      for (const tokenBudget of [null, 10000]) {
        const snapshot = { ...goal, status, tokenBudget }
        const tokens = (status === 'active' || status === 'budget_limited') && tokenBudget !== null
        expect(goalMetricIsTokens(snapshot)).toBe(tokens)
        expect(goalMetricText(snapshot, 'en', 12000)).toBe(tokens ? '6.4K / 10K' : status === 'active' ? '1m 4s' : '1m 2s')
      }
    })
  }
  test('token formatting follows locale and keeps at most one fractional digit', () => {
    const snapshot = { ...goal, tokensUsed: 12666, tokenBudget: 26555 }
    expect(goalMetricText(snapshot, 'en', 12000)).toBe('12.7K / 26.6K')
    expect(goalMetricText(snapshot, 'zh-CN', 12000)).toBe('1.3万 / 2.7万')
  })
  test('elapsed time never subtracts persisted work and terminal time stays frozen', () => {
    expect(goalElapsedMilliseconds(goal, 9000)).toBe(62000)
    expect(goalMetricText({ ...goal, status: 'complete' }, 'en', 100000000)).toBe('1m 2s')
    expect(goalDurationText(-100)).toBe('0s')
    expect(goalDurationText(90061000)).toBe('1d 1h 1m 1s')
    expect(goalDurationText(3600000)).toBe('1h')
    expect(goalDurationText(60000, 'zh-CN')).toBe('1分钟')
  })
  test('relative update copy is localized with future timestamps treated as current', () => {
    expect(goalUpdatedText(10000, 'en', 9000)).toBe('Updated just now')
    expect(goalUpdatedText(10000, 'en', 130000)).toBe('Updated 2 minutes ago')
    expect(goalUpdatedText(10000, 'zh-CN', 130000)).toBe('2分钟前更新')
  })
  test('the active clock delivers second ticks and releases its timer', () => {
    let now = 1000, callback: (() => void) | null = null, stopped = false
    const ticks: number[] = []
    const stop = startGoalClock(value => ticks.push(value), {
      now: () => now,
      everySecond(tick) { callback = tick; return () => { stopped = true; callback = null } },
    })
    expect(ticks).toEqual([1000])
    now = 2000
    ;(callback as (() => void) | null)?.()
    expect(ticks).toEqual([1000, 2000])
    stop()
    expect(stopped).toBe(true)
    expect(callback).toBeNull()
  })
  test('save shortcut follows the platform and ignores key repeats or extra modifiers', () => {
    const key = { key: 's', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false }
    expect(isGoalSaveShortcut({ ...key, metaKey: true }, 'MacIntel')).toBe(true)
    expect(isGoalSaveShortcut({ ...key, ctrlKey: true }, 'Win32')).toBe(true)
    expect(isGoalSaveShortcut({ ...key, ctrlKey: true }, 'Linux x86_64')).toBe(true)
    expect(isGoalSaveShortcut({ ...key, ctrlKey: true }, 'MacIntel')).toBe(false)
    expect(isGoalSaveShortcut({ ...key, metaKey: true, repeat: true }, 'MacIntel')).toBe(false)
    expect(isGoalSaveShortcut({ ...key, metaKey: true, altKey: true }, 'MacIntel')).toBe(false)
  })
})

describe('goal mutation reservation', () => {
  test('pause, resume and clear share one reservation and await authoritative completion', async () => {
    const controller = new GoalActionController()
    const response = deferred<void>()
    const calls: string[] = []
    const pause = controller.run('pause', goal, async snapshot => { calls.push(snapshot.goalId); await response.promise })
    expect(controller.getSnapshot().pending).toBe('pause')
    expect(goal.status).toBe('active')
    expect(await controller.run('clear', goal, async () => { calls.push('clear') })).toBe(false)
    expect(await controller.run('resume', goal, async () => { calls.push('resume') })).toBe(false)
    expect(calls).toEqual(['goal-one'])
    response.resolve()
    expect(await pause).toBe(true)
    expect(controller.getSnapshot()).toEqual({ pending: null, failed: false })
  })
  test('rejected and resolved failures release the reservation and allow recovery', async () => {
    const controller = new GoalActionController()
    expect(await controller.run('clear', goal, async () => ({ ok: false, error: 'offline' }))).toBe(false)
    expect(controller.getSnapshot()).toEqual({ pending: null, failed: true })
    expect(await controller.run('pause', goal, async () => { throw new Error('offline') })).toBe(false)
    expect(await controller.run('clear', goal, async () => ({ ok: true }))).toBe(true)
    expect(controller.getSnapshot().failed).toBe(false)
  })
})

describe('persistent goal editor', () => {
  test('clean, empty and whitespace-only edits cannot save; multiline syntax is preserved', async () => {
    const controller = new GoalEditorController(goal)
    expect(controller.canSave()).toBe(false)
    controller.setText('   ')
    expect(controller.canSave()).toBe(false)
    controller.setText(` ${goal.objective} `)
    expect(controller.canSave()).toBe(false)
    const text = '# Objective\n\nUse `code` and [a link](https://example.com).\n/ordinary @text'
    controller.setText(text)
    expect(controller.canSave()).toBe(true)
    const saved = await controller.save(async (objective, snapshot) => {
      expect(objective).toBe(text)
      expect(snapshot).toBe(goal)
      return { ...snapshot, objective, updatedAtMs: 20000 }
    })
    expect(saved).toBe(true)
    expect(controller.getSnapshot().text).toBe(text)
    expect(controller.getSnapshot().dirty).toBe(false)
  })
  test('draft survives resubscription, accounting events and Revert restores saved content', () => {
    const controller = new GoalEditorController(goal)
    let renders = 0
    const off = controller.subscribe(() => renders++)
    controller.setText('Unfinished local draft')
    off()
    controller.update({ ...goal, tokensUsed: 7000, updatedAtMs: 22000 })
    const offAgain = controller.subscribe(() => renders++)
    expect(controller.getSnapshot().text).toBe('Unfinished local draft')
    expect(controller.getSnapshot().dirty).toBe(true)
    controller.revert()
    expect(controller.getSnapshot().text).toBe(goal.objective)
    expect(controller.getSnapshot().dirty).toBe(false)
    expect(renders).toBe(2)
    offAgain()
  })
  test('external replacement invalidates Save while preserving a recoverable draft', () => {
    const controller = new GoalEditorController(goal)
    controller.setText('Local unsaved work')
    controller.update({ ...goal, objective: 'Updated elsewhere' })
    expect(controller.getSnapshot().text).toBe('Local unsaved work')
    expect(controller.getSnapshot().sourceChanged).toBe(true)
    expect(controller.canSave()).toBe(false)
    controller.revert()
    expect(controller.getSnapshot().text).toBe('Updated elsewhere')
    expect(controller.getSnapshot().sourceChanged).toBe(false)
  })
  test('the same generation in a different conversation cannot inherit an editor draft', () => {
    const controller = new GoalEditorController(goal)
    controller.setText('Draft for the first conversation')
    controller.update({ ...goal, threadId: 'forked-thread' })
    expect(controller.getSnapshot().text).toBe(goal.objective)
    expect(controller.getSnapshot().dirty).toBe(false)
  })
  test('failed saves retain the draft; pending saves reject duplicate Save and Revert', async () => {
    const controller = new GoalEditorController(goal)
    controller.setText(' New objective ')
    const response = deferred<GoalSnapshot>()
    const request = controller.save(async () => response.promise)
    expect(controller.getSnapshot().saving).toBe(true)
    controller.revert()
    expect(controller.getSnapshot().text).toBe(' New objective ')
    expect(await controller.save(async () => { throw new Error('duplicate') })).toBe(false)
    response.reject(new Error('offline'))
    expect(await request).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ text: ' New objective ', dirty: true, error: 'save', saving: false })
    expect(await controller.save(async (objective, snapshot) => ({ ...snapshot, objective }))).toBe(true)
    expect(controller.getSnapshot().text).toBe('New objective')
  })
  test('own authoritative event may precede Save response without creating a conflict', async () => {
    const controller = new GoalEditorController(goal)
    controller.setText('New objective')
    const response = deferred<GoalSnapshot>()
    const request = controller.save(async () => response.promise)
    const updated = { ...goal, objective: 'New objective', revision: 2 }
    controller.update(updated)
    expect(controller.getSnapshot().sourceChanged).toBe(false)
    expect(controller.getSnapshot().saving).toBe(true)
    response.resolve(updated)
    expect(await request).toBe(true)
    expect(controller.getSnapshot().dirty).toBe(false)
  })
  test('late Save cannot replace an external objective or a cleared goal', async () => {
    for (const replacement of [{ ...goal, objective: 'External update' }, null]) {
      const controller = new GoalEditorController(goal)
      controller.setText('Local edit')
      const response = deferred<GoalSnapshot>()
      const request = controller.save(async () => response.promise)
      controller.update(replacement)
      response.resolve({ ...goal, objective: 'Local edit' })
      expect(await request).toBe(false)
      expect(controller.getSnapshot().goal).toBe(replacement)
    }
  })
  test('materialized objective cannot be edited until read; failed read exposes retry', async () => {
    const controller = new GoalEditorController({ ...goal, objective: 'Saved objective reference', objectiveMaterialized: true })
    controller.setText('Must not replace unread content')
    expect(controller.getSnapshot().text).toBe('Saved objective reference')
    expect(controller.canSave()).toBe(false)
    expect(await controller.readObjective(async () => { throw new Error('unavailable') })).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ needsRead: true, loading: false, error: 'load' })
    expect(await controller.readObjective(async () => '# Full objective\n\n`code`')).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ text: '# Full objective\n\n`code`', needsRead: false, error: null })
    controller.setText('Edited full objective')
    expect(controller.canSave()).toBe(true)
  })
  test('late materialized reads cannot populate a replacement generation', async () => {
    const controller = new GoalEditorController({ ...goal, objectiveMaterialized: true })
    const response = deferred<string>()
    const request = controller.readObjective(async () => response.promise)
    controller.update({ ...goal, goalId: 'goal-two', objective: 'Replacement generation' })
    response.resolve('Late old objective')
    expect(await request).toBe(false)
    expect(controller.getSnapshot().text).toBe('Replacement generation')
  })
  test('late materialized reads cannot populate a changed objective within the same generation', async () => {
    const controller = new GoalEditorController({ ...goal, objective: 'Original objective reference', objectiveMaterialized: true })
    const oldResponse = deferred<string>()
    const oldRead = controller.readObjective(async () => oldResponse.promise)
    const replacement = { ...goal, objective: 'Replacement objective reference', objectiveMaterialized: true }
    controller.update(replacement)
    const newResponse = deferred<string>()
    const newRead = controller.readObjective(async () => newResponse.promise)
    oldResponse.resolve('Stale complete objective')
    expect(await oldRead).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ goal: replacement, text: replacement.objective, loading: true, needsRead: true })
    newResponse.resolve('Current complete objective')
    expect(await newRead).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ goal: replacement, text: 'Current complete objective', savedText: 'Current complete objective', loading: false, needsRead: false })
  })
})

 test('pending editor saves in different conversations retain independent ownership', async () => {
  const a = new GoalEditorController({ ...goal, threadId: 'chat-a' }), b = new GoalEditorController({ ...goal, threadId: 'chat-b', goalId: 'goal-b' })
  a.setText('Save objective A'); b.setText('Save objective B')
  let finishA!: (goal: GoalSnapshot) => void, finishB!: (goal: GoalSnapshot) => void
  const first = a.save(() => new Promise(resolve => { finishA = resolve }))
  const second = b.save(() => new Promise(resolve => { finishB = resolve }))
  expect(a.getSnapshot().saving).toBe(true); expect(b.getSnapshot().saving).toBe(true)
  finishA({ ...goal, threadId: 'chat-a', objective: 'Save objective A' })
  expect(await first).toBe(true)
  expect(a.getSnapshot()).toMatchObject({ saving: false, dirty: false })
  expect(b.getSnapshot()).toMatchObject({ saving: true, dirty: true, text: 'Save objective B' })
  finishB({ ...goal, threadId: 'chat-b', goalId: 'goal-b', objective: 'Save objective B' })
  expect(await second).toBe(true)
  expect(b.getSnapshot()).toMatchObject({ saving: false, dirty: false })
})
