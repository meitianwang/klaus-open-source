import { describe, expect, test } from 'bun:test'
import type { FriendAppsSnapshot, FriendReceivingDevice, FriendsRuntimeSnapshot, FriendsSnapshot, FriendTaskGrant, FriendTaskSummary } from '../../../../shared/friends'
import { createFriendsPageController, grantSubmission, pendingTaskCount } from './data'

const device: FriendReceivingDevice = { id: 'desktop-a', name: 'My Mac', platform: 'darwin', online: true, supportsFriendsMessaging: true, isCurrent: true }
const management = (account = 'account-a'): FriendsSnapshot => ({ signedIn: true, selfUserId: account, friends: [] })
const task = (overrides: Partial<FriendTaskSummary> = {}): FriendTaskSummary => ({ id: 'task-a', friendId: 'friend-a', senderUserId: 'user-b', senderDisplayName: 'Alice', senderAvatarUrl: null,
  requestId: 'request-a', prompt: 'Review the selected files', status: 'pending', receiverDeviceId: device.id, threadId: null, createdAt: 100, updatedAt: 100, ...overrides })
const runtime = (tasks: FriendTaskSummary[] = []): FriendsRuntimeSnapshot => ({ signedIn: true, currentDeviceId: device.id, receiver: { selectedDeviceId: device.id, devices: [device] }, tasks, templates: [], outgoing: [], defaultGrant: { deviceId: 'local', mode: 'manual', computerUse: false, apps: [], directories: [], remember: false, network: false, policy: 'approve' }, friendFilesRoot: '/tmp/klaus-friends', executionTargets: { projects: [], workspaces: [] } })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('live friend state and account boundaries', () => {
  test('offline snapshots preserve local tasks and permit acknowledged cancellation without hiding the connection error', async () => {
    const offline = { ...runtime([task()]), error: 'The receiving service is offline' }
    const controller = createFriendsPageController({ list: async () => management(), runtime: async () => offline })
    await controller.refresh()
    expect(controller.getSnapshot().runtime?.tasks).toEqual([task()])
    expect(controller.getSnapshot().runtimeError).toBe(offline.error)
    expect(await controller.mutateRuntime('cancel:a', async () => ({ ...offline, tasks: [task({ status: 'cancelled' })] }))).toBe(true)
    expect(controller.getSnapshot().runtime?.tasks[0].status).toBe('cancelled')
    expect(controller.getSnapshot().runtimeError).toBe(offline.error)
  })
  test('loads real management and runtime snapshots and retains independent source failures', async () => {
    let failRuntime = false
    const controller = createFriendsPageController({ list: async () => management(), runtime: async () => {
      if (failRuntime) throw new Error('The receiving service is offline')
      return runtime([task()])
    } })
    await controller.refresh()
    expect(controller.getSnapshot().runtime?.tasks).toEqual([task()])
    failRuntime = true
    await controller.refresh()
    expect(controller.getSnapshot().friends?.selfUserId).toBe('account-a')
    expect(controller.getSnapshot().runtimeError).toBe('The receiving service is offline')
    expect(controller.getSnapshot().runtime?.tasks).toHaveLength(1)
    expect(controller.getSnapshot().loading).toBe(false)
  })

  test('a synchronous unavailable bridge is a visible error instead of an indefinite loading state', async () => {
    const controller = createFriendsPageController({ list: () => { throw new Error('Bridge unavailable') }, runtime: async () => runtime() })
    await controller.refresh()
    expect(controller.getSnapshot().friends).toBeNull()
    expect(controller.getSnapshot().friendsError).toBe('Bridge unavailable')
    expect(controller.getSnapshot().loading).toBe(false)
  })

  test('an old refresh cannot resurrect a pending task after successful authorization', async () => {
    const oldRuntime = deferred<FriendsRuntimeSnapshot>()
    const controller = createFriendsPageController({ list: async () => management(), runtime: () => oldRuntime.promise })
    const read = controller.refresh()
    const running = runtime([task({ status: 'running', threadId: 'actual-conversation' })])
    expect(await controller.mutateRuntime('approve:task-a', async () => running)).toBe(true)
    oldRuntime.resolve(runtime([task()]))
    await read
    expect(controller.getSnapshot().runtime?.tasks[0].status).toBe('running')
    expect(controller.getSnapshot().runtime?.tasks[0].threadId).toBe('actual-conversation')
  })

  test('duplicate approve clicks make one call and keep controls busy until acknowledgement', async () => {
    const response = deferred<FriendsRuntimeSnapshot>()
    const controller = createFriendsPageController({ list: async () => management(), runtime: async () => runtime() })
    let requests = 0
    const approve = () => { ++requests; return response.promise }
    const first = controller.mutateRuntime('approve:task-a', approve)
    expect(controller.getSnapshot().busy).toBe('approve:task-a')
    expect(await controller.mutateRuntime('approve:task-a', approve)).toBe(false)
    expect(requests).toBe(1)
    response.resolve(runtime([task({ status: 'starting', threadId: 'new-conversation' })]))
    expect(await first).toBe(true)
    expect(controller.getSnapshot().busy).toBeNull()
  })

  test('account changes discard late reads and mutation results without repopulating private state', async () => {
    const old = deferred<FriendsRuntimeSnapshot>()
    const controller = createFriendsPageController({ list: async () => management(), runtime: () => old.promise })
    const read = controller.refresh()
    const write = deferred<FriendsRuntimeSnapshot>(), action = controller.mutateRuntime('approve:a', () => write.promise)
    controller.reset()
    old.resolve(runtime([task()])); write.resolve(runtime([task({ status: 'running' })]))
    await read
    expect(await action).toBe(false)
    expect(controller.getSnapshot().friends).toBeNull()
    expect(controller.getSnapshot().runtime).toBeNull()
    expect(controller.getSnapshot().busy).toBeNull()
  })

  test('host authorization errors retain the pending task and propagate their actual message', async () => {
    const controller = createFriendsPageController({ list: async () => management(), runtime: async () => runtime([task()]) })
    await controller.refresh()
    expect(await controller.mutateRuntime('approve:a', async () => { throw new Error('The friend revoked this request') })).toBe(false)
    expect(controller.getSnapshot().runtime?.tasks[0].status).toBe('pending')
    expect(controller.getSnapshot().actionError).toBe('The friend revoked this request')
    expect(controller.getSnapshot().busy).toBeNull()
  })

  test('receiver and template mutations use acknowledged state, and rejected writes preserve the existing selection', async () => {
    const controller = createFriendsPageController({ list: async () => management(), runtime: async () => runtime() })
    await controller.refresh()
    expect(await controller.mutateRuntime('receiver:b', async () => { throw new Error('Device authorization expired') })).toBe(false)
    expect(controller.getSnapshot().runtime?.receiver?.selectedDeviceId).toBe(device.id)
    const stopped = runtime([task({ status: 'cancelled', threadId: 'saved-history' })])
    expect(await controller.mutateRuntime('revoke:template-a', async () => stopped)).toBe(true)
    expect(controller.getSnapshot().runtime?.tasks[0].status).toBe('cancelled')
    expect(controller.getSnapshot().runtime?.tasks[0].threadId).toBe('saved-history')
  })
})

describe('task controls use actual admission and conversation state', () => {
  test('the pending count reflects only actual pending requests', () => {
    const rows = [task(), task({ id: 'task-b', friendId: 'friend-b', status: 'pending' }), task({ id: 'task-c', status: 'ignored' }), task({ id: 'task-d', status: 'pending', receiverDeviceId: 'desktop-b' })]
    expect(pendingTaskCount(runtime(rows))).toBe(3)
    expect(pendingTaskCount({ ...runtime(rows), signedIn: false })).toBe(0)
    expect(pendingTaskCount(null)).toBe(0)
  })
})

describe('resource choices remain local and explicit', () => {
  const apps: FriendAppsSnapshot = { available: true, apps: [{ id: 'com.apple.Safari', name: 'Safari' }] }
  const grant = (extra: Partial<FriendTaskGrant> = {}): FriendTaskGrant => ({ deviceId: device.id, mode: 'manual', computerUse: false, apps: [], directories: [], remember: false, ...extra })
  test('allows a files-only task when Computer Use is unavailable and keeps selected read/write boundaries', () => {
    const selected = grant({ directories: [{ path: '/Users/test/notes', access: 'read' }, { path: '/Users/test/output', access: 'write' }] })
    expect(grantSubmission(selected, device, device.id, { available: false, apps: [], error: 'Unavailable platform' })).toEqual({ ...selected, network: false })
  })
  test('rejects remote resource approval and offline or unsupported receiver choices', () => {
    expect(() => grantSubmission(grant(), device, 'desktop-b', apps)).toThrow('friends_grant_local_only')
    expect(() => grantSubmission(grant(), { ...device, online: false }, device.id, apps)).toThrow('friends_receiver_unavailable')
    expect(() => grantSubmission(grant(), { ...device, supportsFriendsMessaging: false }, device.id, apps)).toThrow('friends_receiver_unavailable')
  })
  test('Computer Use grants require selected real available apps and preserve explicit future-task permission', () => {
    expect(() => grantSubmission(grant({ computerUse: true }), device, device.id, apps)).toThrow('friends_select_available_apps')
    expect(() => grantSubmission(grant({ computerUse: true, apps: ['missing-app'] }), device, device.id, apps)).toThrow('friends_select_available_apps')
    expect(() => grantSubmission(grant({ computerUse: true, apps: ['com.apple.Safari'] }), device, device.id, { available: false, apps: [], error: 'Native permissions denied' })).toThrow('Native permissions denied')
    const selected = grantSubmission(grant({ mode: 'scoped-auto', computerUse: true, apps: ['com.apple.Safari', 'com.apple.Safari'], remember: true }), device, device.id, apps)
    expect(selected.apps).toEqual(['com.apple.Safari'])
    expect(selected.remember).toBe(true)
    expect(selected.deviceId).toBe(device.id)
    expect(selected.mode).toBe('scoped-auto')
  })
  test('network is denied unless explicitly selected and survives a scoped task submission independently of app access', () => {
    expect(grantSubmission(grant(), device, device.id, apps).network).toBe(false)
    const network = grantSubmission(grant({ network: true }), device, device.id, apps)
    expect(network.network).toBe(true)
    expect(network.computerUse).toBe(false)
    expect(network.apps).toEqual([])
    expect(() => grantSubmission(grant({ network: true }), device, device.id, { ...apps, taskCommands: false })).toThrow('friends_commands_unavailable')
  })
})
