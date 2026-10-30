import type { FriendAppsSnapshot, FriendReceivingDevice, FriendsRuntimeSnapshot, FriendsSnapshot, FriendTaskGrant } from '../../../../shared/friends'
import { updateFriendsRuntime } from './runtime-state'

export interface FriendsPageState {
  friends: FriendsSnapshot | null
  runtime: FriendsRuntimeSnapshot | null
  loading: boolean
  busy: string | null
  friendsError: string
  runtimeError: string
  actionError: string
}

export function failureText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Account changes invalidate every outstanding read and mutation result. */
export function createFriendsPageController(api: { list(): Promise<FriendsSnapshot>; runtime(): Promise<FriendsRuntimeSnapshot> }) {
  const initial = (): FriendsPageState => ({ friends: null, runtime: null, loading: true, busy: null, friendsError: '', runtimeError: '', actionError: '' })
  let state = initial(), generation = 0, disposed = false
  const subscribers = new Set<() => void>()
  const publish = (next: Partial<FriendsPageState>) => {
    if (disposed) return
    state = { ...state, ...next }
    if ('runtime' in next) updateFriendsRuntime(next.runtime ?? null)
    else if (next.runtimeError) updateFriendsRuntime(null)
    for (const subscriber of subscribers) subscriber()
  }
  const refresh = async () => {
    if (disposed || state.busy) return
    const current = ++generation
    publish({ loading: true })
    const [friends, runtime] = await Promise.allSettled([Promise.resolve().then(() => api.list()), Promise.resolve().then(() => api.runtime())])
    if (disposed || current !== generation) return
    publish({
      loading: false,
      ...(friends.status === 'fulfilled' ? { friends: friends.value, friendsError: '' } : { friendsError: failureText(friends.reason) }),
      ...(runtime.status === 'fulfilled' ? { runtime: runtime.value, runtimeError: runtime.value.error || '' } : { runtimeError: failureText(runtime.reason) }),
    })
  }
  const mutate = async <T extends FriendsSnapshot | FriendsRuntimeSnapshot>(kind: 'friends' | 'runtime', key: string, action: () => Promise<T>): Promise<boolean> => {
    if (disposed || state.busy) return false
    const current = ++generation
    publish({ busy: key, actionError: '', loading: false })
    try {
      const next = await action()
      if (disposed || current !== generation) return false
      publish(kind === 'friends' ? { friends: next as FriendsSnapshot, friendsError: '' } : { runtime: next as FriendsRuntimeSnapshot, runtimeError: (next as FriendsRuntimeSnapshot).error || '' })
      return true
    } catch (failure) {
      if (!disposed && current === generation) publish({ actionError: failureText(failure) })
      return false
    } finally {
      if (!disposed && current === generation) publish({ busy: null })
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (subscriber: () => void) => { subscribers.add(subscriber); return () => { subscribers.delete(subscriber) } },
    refresh,
    reset: () => { ++generation; publish(initial()) },
    clearActionError: () => publish({ actionError: '' }),
    mutateFriends: (key: string, action: () => Promise<FriendsSnapshot>) => mutate('friends', key, action),
    mutateRuntime: (key: string, action: () => Promise<FriendsRuntimeSnapshot>) => mutate('runtime', key, action),
    dispose: () => { ++generation; disposed = true; subscribers.clear() },
  }
}

export function pendingTaskCount(snapshot: FriendsRuntimeSnapshot | null): number {
  return snapshot?.signedIn ? snapshot.tasks.filter(task => task.status === 'pending').length : 0
}

export function grantSubmission(draft: FriendTaskGrant, device: FriendReceivingDevice, currentDeviceId: string | null, apps: FriendAppsSnapshot): FriendTaskGrant {
  if (device.id !== currentDeviceId) throw new Error('friends_grant_local_only')
  if (!device.online || !device.supportsFriendsMessaging) throw new Error('friends_receiver_unavailable')
  if (!['manual', 'auto-edit', 'scoped-auto'].includes(draft.mode)) throw new Error('friends_invalid_grant')
  if (draft.network === true && apps.taskCommands === false) throw new Error('friends_commands_unavailable')
  if (draft.computerUse && !apps.available) throw new Error(apps.error || 'friends_apps_unavailable')
  const selected = draft.computerUse ? [...new Set(draft.apps)] : []
  if (draft.computerUse && (!selected.length || selected.some(id => !apps.apps.some(app => app.id === id)))) throw new Error('friends_select_available_apps')
  const directories = draft.directories.map(row => {
    if (!row.path.trim() || row.path.includes('\0') || !['read', 'write'].includes(row.access)) throw new Error('friends_invalid_directory')
    return { path: row.path, access: row.access }
  })
  // The execution location travels with the grant; the host re-checks it against
  // this computer's registry before any conversation is created.
  const target = draft.target
  return { ...draft, deviceId: device.id, apps: selected, directories, network: draft.network === true,
    ...(target ? { target } : {}) }
}
