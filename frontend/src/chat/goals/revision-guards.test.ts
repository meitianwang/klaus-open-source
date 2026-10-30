import { expect, test } from 'bun:test'
import { GoalSnapshots } from './snapshots'
import { GoalEditorController } from './editor-state'
import { GoalActionController } from './action-state'
import type { GoalSnapshot } from './types'

const initial: GoalSnapshot = { goalId: 'generation-a', threadId: 'thread-a', objective: 'Finish the task', status: 'paused', tokenBudget: 10000, tokensUsed: 100, timeUsedSeconds: 10, createdAtMs: 1, updatedAtMs: 10 }
function barrier() { let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve }); return { pending, release } }
function fixture() {
  const snapshots = new GoalSnapshots()
  snapshots.receive('thread-a', initial, 1)
  const editor = new GoalEditorController(snapshots.get('thread-a')!)
  const receive = (goal: GoalSnapshot, revision: number) => { snapshots.receive('thread-a', goal, revision); editor.update(snapshots.get('thread-a')) }
  return { snapshots, editor, receive }
}

test('counter-only snapshots rebase a dirty editor and its delayed commit without losing text', async () => {
  const { snapshots, editor, receive } = fixture()
  editor.setText('Revised complete objective')
  const prepared = barrier()
  let writes = 0
  const saving = editor.save(async (objective, captured) => {
    await prepared.pending
    const guard = snapshots.guard('thread-a', captured)
    expect(guard.expectedGoalRevision).toBe(2)
    writes++
    const saved = { ...snapshots.get('thread-a')!, objective }
    receive(saved, 3)
    return snapshots.get('thread-a')!
  })
  receive({ ...initial, tokensUsed: 120, timeUsedSeconds: 11, updatedAtMs: 11 }, 2)
  expect(editor.getSnapshot().text).toBe('Revised complete objective')
  expect(editor.getSnapshot().sourceChanged).toBe(false)
  prepared.release()
  expect(await saving).toBe(true)
  expect(writes).toBe(1)
  expect(editor.getSnapshot().savedText).toBe('Revised complete objective')
})

test('a same-generation objective change during preparation prevents any stale editor write', async () => {
  const { snapshots, editor, receive } = fixture()
  editor.setText('Unsaved local objective')
  const prepared = barrier()
  let writes = 0
  const saving = editor.save(async (objective, captured) => {
    await prepared.pending
    snapshots.guard('thread-a', captured)
    writes++
    return { ...captured, objective }
  })
  receive({ ...initial, objective: 'New objective from another window' }, 2)
  prepared.release()
  expect(await saving).toBe(false)
  expect(writes).toBe(0)
  expect(snapshots.get('thread-a')?.objective).toBe('New objective from another window')
  expect(editor.getSnapshot().text).toBe('Unsaved local objective')
  expect(editor.getSnapshot().sourceChanged).toBe(true)
})

for (const changed of [{ status: 'active' as const }, { tokenBudget: 20000 }]) test(`source-affecting ${Object.keys(changed)[0]} updates cannot silently authorize a dirty save`, () => {
  const { snapshots, editor, receive } = fixture()
  const captured = snapshots.get('thread-a')!
  editor.setText('Keep this draft')
  receive({ ...initial, ...changed }, 2)
  expect(editor.getSnapshot().sourceChanged).toBe(true)
  expect(editor.getSnapshot().text).toBe('Keep this draft')
  expect(editor.canSave()).toBe(false)
  expect(() => snapshots.guard('thread-a', captured)).toThrow('Goal intent changed')
})

test('a stopped-goal confirmation cannot act after a later source edit even if the text returns to its old value', async () => {
  const { snapshots } = fixture()
  const captured = snapshots.get('thread-a')!
  snapshots.receive('thread-a', { ...initial, objective: 'Replacement objective' }, 2)
  snapshots.receive('thread-a', initial, 3)
  let resumed = 0
  const actions = new GoalActionController()
  expect(await actions.run('resume', captured, async goal => { snapshots.guard('thread-a', goal); resumed++ })).toBe(false)
  expect(resumed).toBe(0)
  expect(actions.getSnapshot().failed).toBe(true)
})

test('late automatic completion cleanup is rejected after same-generation reactivation', () => {
  const { snapshots } = fixture()
  snapshots.receive('thread-a', { ...initial, status: 'complete' }, 2)
  const complete = snapshots.get('thread-a')!
  snapshots.receive('thread-a', { ...initial, status: 'active' }, 3)
  expect(() => snapshots.guard('thread-a', complete)).toThrow('Goal intent changed')
  expect(snapshots.get('thread-a')?.status).toBe('active')
})
