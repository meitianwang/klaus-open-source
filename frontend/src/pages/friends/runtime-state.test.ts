import { beforeEach, describe, expect, test } from 'bun:test'
import type { FriendsRuntimeSnapshot, FriendTaskSummary } from '../../../../shared/friends'
import { subscribeFriendsRuntime, updateFriendsRuntime } from './runtime-state'

const task = (extra: Partial<FriendTaskSummary> = {}): FriendTaskSummary => ({ id: 'task-a', friendId: 'friend-a', senderUserId: 'user-b', senderDisplayName: 'Alice', senderAvatarUrl: null,
  requestId: 'request-a', prompt: 'A real task', status: 'running', receiverDeviceId: 'desktop-a', threadId: 'conversation-a', createdAt: 100, updatedAt: 100,
  grant: { deviceId: 'desktop-a', mode: 'auto-edit', computerUse: false, apps: [], directories: [{ path: '/docs', access: 'read' }], remember: false }, ...extra })
const snapshot = (tasks: FriendTaskSummary[]): FriendsRuntimeSnapshot => ({ signedIn: true, currentDeviceId: 'desktop-a', receiver: { selectedDeviceId: 'desktop-a', devices: [] }, tasks, templates: [], outgoing: [], defaultGrant: { deviceId: 'local', mode: 'manual', computerUse: false, apps: [], directories: [], remember: false, network: false, policy: 'approve' }, friendFilesRoot: '/tmp/klaus-friends', executionTargets: { projects: [], workspaces: [] } })
beforeEach(() => updateFriendsRuntime(null))

describe('friends runtime snapshot subscription', () => {
  test('runtime subscribers see actual lifecycle changes and can unsubscribe', () => {
    let changes = 0
    const off = subscribeFriendsRuntime(() => { ++changes })
    updateFriendsRuntime(snapshot([task()]))
    updateFriendsRuntime(snapshot([task({ status: 'cancelled' })]))
    expect(changes).toBe(2)
    off(); updateFriendsRuntime(null)
    expect(changes).toBe(2)
  })
})
