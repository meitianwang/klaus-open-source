import { describe, expect, test } from 'bun:test'
import {
  applyLiveTaskToolEnd, dropLiveTaskPending, forgetTaskItems, hasTaskItems,
  noteLiveTaskToolInputDelta, noteLiveTaskToolStart, setTaskItems, taskItems,
  taskNumberLabel, taskPlanIdentity, taskProgress, type TaskItem,
} from './task-state'

const task = (id: string, status: TaskItem['status'], activeForm?: string): TaskItem => ({
  id,
  subject: `Task ${id}`,
  status,
  activeForm,
  blockedBy: [],
})

describe('task capsule progress', () => {
  test('hides only when no task list exists and keeps N/N visible while the turn runs', () => {
    expect(taskProgress([])).toBeNull()
    expect(taskProgress([task('1', 'completed'), task('2', 'completed')])).toMatchObject({
      completed: 2,
      total: 2,
    })
  })

  test('preserves authoritative plan order and active labels in the capsule', () => {
    expect(taskProgress([
      task('3', 'pending'),
      task('2', 'in_progress', 'Implementing live updates'),
      task('1', 'completed'),
    ])).toEqual({
      completed: 1,
      total: 3,
      entries: [
        { step: 'Task 3', status: 'pending' },
        { step: 'Implementing live updates', status: 'in_progress' },
        { step: 'Task 1', status: 'completed' },
      ],
    })
  })
})

describe('current plan snapshots', () => {
  test('replaces a completed plan without accumulating rows and keeps sessions independent', () => {
    setTaskItems('plan-session-a', [task('14', 'completed'), task('2', 'completed')], {
      planId: 'old-plan', planKind: 'tasks',
    })
    setTaskItems('plan-session-b', [task('6', 'in_progress')], {
      planId: 'other-plan', planKind: 'tasks',
    })
    setTaskItems('plan-session-a', [task('20', 'pending')], {
      planId: 'new-plan', planKind: 'plan',
    })
    expect(taskItems('plan-session-a').map(item => item.id)).toEqual(['20'])
    expect(taskPlanIdentity('plan-session-a')).toEqual({ planId: 'new-plan', planKind: 'plan' })
    expect(taskItems('plan-session-b').map(item => item.id)).toEqual(['6'])
    expect(taskPlanIdentity('plan-session-b')).toEqual({ planId: 'other-plan', planKind: 'tasks' })
    forgetTaskItems('plan-session-a')
    forgetTaskItems('plan-session-b')
  })

  test('restores the complete plan identity and order after cache disposal', () => {
    const rows = [task('9', 'completed'), task('4', 'pending')]
    const identity = { planId: 'persisted-plan', planKind: 'plan' as const }
    setTaskItems('restored-plan', rows, identity)
    forgetTaskItems('restored-plan')
    expect(hasTaskItems('restored-plan')).toBe(false)
    setTaskItems('restored-plan', rows, identity)
    expect(taskItems('restored-plan')).toEqual(rows)
    expect(taskPlanIdentity('restored-plan')).toEqual(identity)
    forgetTaskItems('restored-plan')
  })

  test('ordinary plan entries are unnumbered; structured tasks use IDs then position', () => {
    expect(taskNumberLabel(task('14', 'completed'), 0, 'tasks')).toBe('#14')
    expect(taskNumberLabel(task('', 'pending'), 3, 'tasks')).toBe('#4')
    expect(taskNumberLabel(task('14', 'pending'), 0, 'plan')).toBeNull()
    expect(taskNumberLabel(task('', 'pending'), 3, 'plan')).toBeNull()
  })
})

describe('live Task* tool calls as the second plan input', () => {
  const result = '#t1 completed: 拉取分支 [entryId: t1]\n#t2 in_progress: 读文件 [entryId: t2]'

  test('applies a live TaskWrite result and keeps moving mid-turn', () => {
    setTaskItems('live-a', [task('t1', 'in_progress'), task('t2', 'pending')])
    noteLiveTaskToolStart('live-a', 'call-1', 'TaskWrite', { merge: true, tasks: [
      { id: 't1', subject: 'Task t1', status: 'completed' },
      { id: 't2', subject: 'Task t2', status: 'in_progress', activeForm: '读文件' },
    ] })
    expect(applyLiveTaskToolEnd('live-a', 'call-1', false, result)).toBe(true)
    expect(taskItems('live-a').map(row => [row.id, row.status, row.activeForm])).toEqual([
      ['t1', 'completed', undefined],
      ['t2', 'in_progress', '读文件'],
    ])
    forgetTaskItems('live-a')
  })

  test('a non-merge TaskWrite replaces the whole stored plan', () => {
    setTaskItems('live-b', [task('old', 'completed'), task('older', 'completed')])
    noteLiveTaskToolStart('live-b', 'call-2', 'TaskWrite', { tasks: [
      { id: 'n1', subject: 'New one', status: 'in_progress' },
    ] })
    applyLiveTaskToolEnd('live-b', 'call-2', false, '#n1 in_progress: New one [entryId: n1]')
    expect(taskItems('live-b').map(row => row.id)).toEqual(['n1'])
    forgetTaskItems('live-b')
  })

  test('TaskUpdate resolves entry aliases learned from results', () => {
    setTaskItems('live-c', [task('plan-step-real', 'pending', '定位')])
    noteLiveTaskToolStart('live-c', 'call-3', 'TaskUpdate', { taskId: 't1', status: 'completed' })
    applyLiveTaskToolEnd('live-c', 'call-3', false, '#plan-step-real completed: 定位 [entryId: t1]')
    expect(taskItems('live-c')[0].status).toBe('completed')
    forgetTaskItems('live-c')
  })

  test('an authoritative snapshot supersedes live-applied state', () => {
    setTaskItems('live-d', [task('t1', 'pending')])
    noteLiveTaskToolStart('live-d', 'call-4', 'TaskUpdate', { taskId: 't1', status: 'completed' })
    applyLiveTaskToolEnd('live-d', 'call-4', false, '#t1 completed: Task t1 [entryId: t1]')
    expect(taskItems('live-d')[0].status).toBe('completed')
    setTaskItems('live-d', [task('t1', 'pending')], { planId: 'p', planKind: 'plan' })
    expect(taskItems('live-d')[0].status).toBe('pending')
    // A live update arriving after the snapshot is newer than it, so it applies
    // on top of the fresh list (the result line carries the entry mapping).
    noteLiveTaskToolStart('live-d', 'call-5', 'TaskUpdate', { taskId: 't1', status: 'completed' })
    expect(applyLiveTaskToolEnd('live-d', 'call-5', false, '#t1 completed: Task t1 [entryId: t1]')).toBe(true)
    expect(taskItems('live-d')[0].status).toBe('completed')
    forgetTaskItems('live-d')
  })

  test('failed calls and unknown tool calls change nothing', () => {
    setTaskItems('live-e', [task('t1', 'pending')])
    noteLiveTaskToolStart('live-e', 'call-6', 'TaskUpdate', { taskId: 't1', status: 'completed' })
    expect(applyLiveTaskToolEnd('live-e', 'call-6', true, 'boom')).toBe(false)
    noteLiveTaskToolStart('live-e', 'call-7', 'Bash', { command: 'ls' })
    expect(applyLiveTaskToolEnd('live-e', 'call-7', false, 'output')).toBe(false)
    expect(taskItems('live-e')[0].status).toBe('pending')
    forgetTaskItems('live-e')
  })

  test('fragmented arguments complete through input deltas', () => {
    setTaskItems('live-f', [task('t1', 'pending')])
    noteLiveTaskToolStart('live-f', 'call-8', 'TaskUpdate', '{"taskId":"t1","stat')
    noteLiveTaskToolInputDelta('live-f', 'call-8', '{"taskId":"t1","status":"completed"}')
    expect(applyLiveTaskToolEnd('live-f', 'call-8', false, '#t1 completed: Task t1 [entryId: t1]')).toBe(true)
    expect(taskItems('live-f')[0].status).toBe('completed')
    forgetTaskItems('live-f')
  })

  test('a terminal turn drops in-flight calls without touching the plan', () => {
    setTaskItems('live-g', [task('t1', 'pending')])
    noteLiveTaskToolStart('live-g', 'call-9', 'TaskUpdate', { taskId: 't1', status: 'completed' })
    dropLiveTaskPending('live-g')
    expect(applyLiveTaskToolEnd('live-g', 'call-9', false, '#t1 completed: Task t1 [entryId: t1]')).toBe(false)
    expect(taskItems('live-g')[0].status).toBe('pending')
    forgetTaskItems('live-g')
  })
})
