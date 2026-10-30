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

test('acknowledged pin updates the current row after a refresh replaced the menu row', async () => {
  const pending = deferred<typeof vectors.reply>()
  const state = setup(() => pending.promise)
  const update = state.pinning.toggle('thread-pin')
  state.replace([row('thread-pin', { title: 'Fresh title', workdir: '/repo' }), row('other')])
  pending.resolve(vectors.reply)
  await update
  expect(state.rows[0].title).toBe('Fresh title')
  expect(state.rows[0].sidebarPinnedAt).toBe(vectors.pinnedAt)
  const groups = partitionSidebarSessions(state.rows, () => false)
  expect(groups.pinned.map(row => row.id)).toEqual(['thread-pin'])
  expect(groups.local.map(row => row.id)).toEqual(['other'])
  expect(state.renders).toBe(1)
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

test('a failed write preserves state and permits retry without overlapping writes', async () => {
  const pending = deferred<typeof vectors.reply>()
  let calls = 0
  const state = setup(() => ++calls === 1 ? pending.promise : Promise.resolve(vectors.reply))
  const update = state.pinning.toggle('thread-pin')
  await state.pinning.toggle('thread-pin')
  expect(calls).toBe(1)
  pending.reject(new Error('storage unavailable'))
  expect(await update.catch(error => error.message)).toBe('storage unavailable')
  expect(state.rows[0].sidebarPinnedAt).toBeUndefined()
  expect(state.renders).toBe(0)
  await state.pinning.toggle('thread-pin')
  expect(state.rows[0].sidebarPinnedAt).toBe(vectors.pinnedAt)
})

test('a failed reply or missing persisted timestamp cannot produce a successful pin', async () => {
  for (const reply of [{ ok: false, error: 'storage unavailable' }, { ok: true }]) {
    const state = setup(async () => reply)
    expect(await state.pinning.toggle('thread-pin').catch(error => error.message))
      .toBe(reply.error || 'session_pin_failed')
    expect(state.rows[0].sidebarPinnedAt).toBeUndefined()
    expect(state.renders).toBe(0)
  }
})
