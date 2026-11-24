import { expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/session-pin-vectors.json'
import type { SessionInfo } from '../engine-events'
import { partitionSidebarSessions } from './model'
import { SessionPinning } from './pinning'

const row = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: id, updatedAt: 1, ...extra })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup(persist: ConstructorParameters<typeof SessionPinning>[0]['persist']) {
  let rows = [row('thread-pin', { workdir: '/repo' }), row('other')]
  let renders = 0
  const pinning = new SessionPinning({
    getSessions: () => rows,
    setSessions: next => { rows = next },
    persist,
    render: () => { renders++ },
  })
  return { pinning, get rows() { return rows }, replace: (next: SessionInfo[]) => { rows = next }, get renders() { return renders } }
}

test('pin updates the sidebar optimistically on click and reconciles after a refresh replaced the row', async () => {
  expect(vectors.sidebar.optimisticToggle).toBe(true)
  const pending = deferred<typeof vectors.reply>()
  const state = setup(() => pending.promise)
  const update = state.pinning.toggle('thread-pin')
  expect(state.renders).toBe(1)
  expect(partitionSidebarSessions(state.rows, () => false).pinned.map(item => item.id)).toEqual(['thread-pin'])

  state.replace([row('thread-pin', { title: 'Fresh title', workdir: '/repo' }), row('other')])
  pending.resolve(vectors.reply)
  await update
  expect(state.rows[0].title).toBe('Fresh title')
  expect(state.rows[0].sidebarPinnedAt).toBe(vectors.pinnedAt)
  const groups = partitionSidebarSessions(state.rows, () => false)
  expect(groups.pinned.map(item => item.id)).toEqual(['thread-pin'])
  expect(groups.local.map(item => item.id)).toEqual(['other'])
  expect(state.renders).toBe(2)
})

test('older refreshes cannot undo pin or unpin, while later snapshots remain authoritative', async () => {
  const state = setup(async (_, pinned) => pinned ? vectors.reply : vectors.unpinnedReply)
  const beforePin = state.pinning.snapshot()
  const oldRows = state.rows
  await state.pinning.toggle('thread-pin')
  state.replace(state.pinning.mergeSnapshot(oldRows, beforePin))
  expect(state.rows[0].sidebarPinnedAt).toBe(vectors.pinnedAt)
  const beforeUnpin = state.pinning.snapshot()
  const pinnedRows = state.rows
  await state.pinning.toggle('thread-pin')
  state.replace(state.pinning.mergeSnapshot(pinnedRows, beforeUnpin))
  expect(state.rows[0].sidebarPinnedAt).toBeNull()
  expect(state.rows[0].workdir).toBe('/repo')
  expect(partitionSidebarSessions(state.rows, () => false).pinned).toEqual([])
  expect(state.pinning.mergeSnapshot(pinnedRows, state.pinning.snapshot())[0].sidebarPinnedAt).toBe(vectors.pinnedAt)
})

test('rapid pin-then-unpin toggles update immediately and serialize persistence without overlapping writes', async () => {
  expect(vectors.sidebar.coalesceRapidToggles).toBe(true)
  const firstWrite = deferred<typeof vectors.reply>()
  const secondWrite = deferred<typeof vectors.unpinnedReply>()
  const persisted: boolean[] = []
  let activeWrites = 0
  let maxConcurrentWrites = 0
  const state = setup(async (_, pinned) => {
    persisted.push(pinned)
    activeWrites++
    maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites)
    try {
      return pinned ? await firstWrite.promise : await secondWrite.promise
    } finally {
      activeWrites--
    }
  })

  const firstClick = state.pinning.toggle('thread-pin')
  expect(partitionSidebarSessions(state.rows, () => false).pinned.map(item => item.id)).toEqual(['thread-pin'])
  const secondClick = state.pinning.toggle('thread-pin')
  expect(partitionSidebarSessions(state.rows, () => false).pinned).toEqual([])
  expect(persisted).toEqual([true])

  firstWrite.resolve(vectors.reply)
  await Promise.resolve()
  await Promise.resolve()
  expect(partitionSidebarSessions(state.rows, () => false).pinned).toEqual([])
  expect(persisted).toEqual([true, false])

  secondWrite.resolve(vectors.unpinnedReply)
  await Promise.all([firstClick, secondClick])
  expect(maxConcurrentWrites).toBe(1)
  expect(state.rows[0].sidebarPinnedAt).toBeNull()
})

test('rapid pin-unpin-pin coalesces back to a single write when in-flight persistence matches final intent', async () => {
  const firstWrite = deferred<typeof vectors.reply>()
  const persisted: boolean[] = []
  const state = setup((_, pinned) => {
    persisted.push(pinned)
    return firstWrite.promise
  })

  const p1 = state.pinning.toggle('thread-pin')
  const p2 = state.pinning.toggle('thread-pin')
  const p3 = state.pinning.toggle('thread-pin')
  expect(partitionSidebarSessions(state.rows, () => false).pinned.map(item => item.id)).toEqual(['thread-pin'])

  firstWrite.resolve(vectors.reply)
  await Promise.all([p1, p2, p3])
  expect(persisted).toEqual([true])
  expect(state.rows[0].sidebarPinnedAt).toBe(vectors.pinnedAt)
})

test('a failed write rolls back optimistic state and permits retry', async () => {
  expect(vectors.sidebar.failedWriteLeavesSidebarUnchanged).toBe(true)
  const pending = deferred<typeof vectors.reply>()
  let calls = 0
  const state = setup(() => ++calls === 1 ? pending.promise : Promise.resolve(vectors.reply))
  const update = state.pinning.toggle('thread-pin')
  expect(partitionSidebarSessions(state.rows, () => false).pinned.map(item => item.id)).toEqual(['thread-pin'])

  pending.reject(new Error('storage unavailable'))
  expect(await update.catch(error => error.message)).toBe('storage unavailable')
  expect(state.rows[0].sidebarPinnedAt).toBeUndefined()
  expect(partitionSidebarSessions(state.rows, () => false).pinned).toEqual([])

  await state.pinning.toggle('thread-pin')
  expect(calls).toBe(2)
  expect(state.rows[0].sidebarPinnedAt).toBe(vectors.pinnedAt)
})

test('a failed reply or missing persisted timestamp rolls back and cannot produce a successful pin', async () => {
  for (const reply of [{ ok: false, error: 'storage unavailable' }, { ok: true }]) {
    const state = setup(async () => reply)
    expect(await state.pinning.toggle('thread-pin').catch(error => error.message))
      .toBe(reply.error || 'session_pin_failed')
    expect(state.rows[0].sidebarPinnedAt).toBeUndefined()
    expect(partitionSidebarSessions(state.rows, () => false).pinned).toEqual([])
  }
})
