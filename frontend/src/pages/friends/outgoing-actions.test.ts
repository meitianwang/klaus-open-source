import { describe, expect, test } from 'bun:test'
import type { FriendsRuntimeSnapshot } from '../../../../shared/friends'
import { friendOutgoingActionPending, performFriendOutgoingAction, type FriendOutgoingActionDeps } from './outgoing-actions'

const snapshot = { signedIn: true, outgoing: [] } as unknown as FriendsRuntimeSnapshot
function fixture() {
  const calls: string[] = [], updates: FriendsRuntimeSnapshot[] = [], errors: unknown[] = []
  const deps: FriendOutgoingActionDeps = {
    confirmCancel: async () => { calls.push('confirm'); return true },
    cancel: async id => { calls.push('cancel:' + id); return snapshot },
    retry: async id => { calls.push('retry:' + id); return snapshot },
    updated: value => updates.push(value), failed: error => errors.push(error),
  }
  return { deps, calls, updates, errors }
}

describe('outgoing friend request actions', () => {
  test('cancels only after confirmation and updates the returned runtime', async () => {
    const f = fixture()
    expect(await performFriendOutgoingAction('cancel', 'root-one', f.deps)).toBe(true)
    expect(f.calls).toEqual(['confirm', 'cancel:root-one'])
    expect(f.updates).toEqual([snapshot])
    expect(friendOutgoingActionPending('root-one')).toBe(false)
  })
  test('a declined cancellation sends no command', async () => {
    const f = fixture(); f.deps.confirmCancel = async () => false
    expect(await performFriendOutgoingAction('cancel', 'root-two', f.deps)).toBe(false)
    expect(f.calls).toEqual([])
    expect(f.updates).toEqual([])
  })
  test('retry reuses the original identity and concurrent surfaces share one operation', async () => {
    const f = fixture(); let resolve!: (value: FriendsRuntimeSnapshot) => void
    f.deps.retry = id => { f.calls.push('retry:' + id); return new Promise(done => { resolve = done }) }
    const first = performFriendOutgoingAction('retry', 'same-message', f.deps)
    const second = performFriendOutgoingAction('retry', 'same-message', f.deps)
    expect(first).toBe(second)
    expect(friendOutgoingActionPending('same-message')).toBe(true)
    await Promise.resolve()
    resolve(snapshot)
    expect(await first).toBe(true)
    expect(f.calls).toEqual(['retry:same-message'])
    expect(f.updates).toEqual([snapshot])
  })
  test('failed operations preserve a usable retry action', async () => {
    const f = fixture(); f.deps.retry = async () => { throw new Error('Not accepted') }
    expect(await performFriendOutgoingAction('retry', 'retryable', f.deps)).toBe(false)
    expect(f.errors).toHaveLength(1)
    expect(friendOutgoingActionPending('retryable')).toBe(false)
    f.deps.retry = async () => snapshot
    expect(await performFriendOutgoingAction('retry', 'retryable', f.deps)).toBe(true)
  })
})
