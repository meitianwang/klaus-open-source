import type { FriendAppsSnapshot, FriendExecutionTargets, FriendsRuntimeSnapshot, FriendTaskGrant } from '../../../../shared/friends'
import { failureText } from './data'

interface GrantChange { draft: FriendTaskGrant; persisted: FriendTaskGrant }

export interface PendingDefaultGrant {
  latestDraft: FriendTaskGrant
  confirmedDraft: FriendTaskGrant
  confirmedPersisted: FriendTaskGrant
  changes: GrantChange[]
  done: Promise<void>
}

export interface GrantViewData {
  draft: FriendTaskGrant
  confirmedPersisted: FriendTaskGrant
  deviceId: string | null
  sharedRoot: string | null
  targets: FriendExecutionTargets
  apps: FriendAppsSnapshot | null
  pending?: PendingDefaultGrant
  error?: string
  saveError?: boolean
}

export function grantSignature(grant: FriendTaskGrant): string {
  const { deviceId, mode, policy, computerUse, apps, directories, remember, network, target } = grant
  return JSON.stringify({ deviceId, mode, policy: policy ?? null, computerUse, apps,
    directories: directories.map(({ path, access }) => ({ path, access })), remember, network: network === true,
    target: !target || target.kind === 'none' ? { kind: 'none' } : target })
}

export function persistableDefaultGrant(draft: FriendTaskGrant, deviceId: string, apps: FriendAppsSnapshot | null): FriendTaskGrant {
  const validApps = draft.computerUse && apps?.available
    ? [...new Set(draft.apps)].filter(id => apps.apps.some(app => app.id === id)) : []
  const computerUse = draft.computerUse && validApps.length > 0
  return { ...draft, computerUse, apps: computerUse ? validApps : [], deviceId, network: draft.network === true }
}

function reconcileDraft(draft: FriendTaskGrant, confirmed: FriendTaskGrant): FriendTaskGrant {
  return draft.computerUse && !draft.apps.length ? { ...confirmed, computerUse: true, apps: [] } : confirmed
}

export function enqueueDefaultGrantChange(
  next: (draft: FriendTaskGrant) => FriendTaskGrant,
  update: (change: (current: GrantViewData | null) => GrantViewData | null) => void,
  api: { setDefaultGrant: (request: { grant: FriendTaskGrant }) => Promise<FriendsRuntimeSnapshot>; onRuntime?: (runtime: FriendsRuntimeSnapshot) => void },
): void {
  update(current => {
    if (!current?.deviceId) return current
    const { deviceId } = current
    const nextDraft = next(current.draft)
    const nextPersisted = persistableDefaultGrant(nextDraft, deviceId, current.apps)
    if (!current.pending && grantSignature(nextPersisted) === grantSignature(current.confirmedPersisted)) {
      return { ...current, draft: nextDraft, error: undefined, saveError: false }
    }

    const pending: PendingDefaultGrant = current.pending ?? {
      latestDraft: nextDraft, confirmedPersisted: current.confirmedPersisted,
      confirmedDraft: reconcileDraft(current.draft, current.confirmedPersisted),
      changes: [], done: Promise.resolve(),
    }
    pending.latestDraft = nextDraft
    pending.changes = [{ draft: nextDraft, persisted: nextPersisted }]
    if (!current.pending) pending.done = Promise.resolve().then(async () => {
      let error: string | undefined
      for (let item = pending.changes.shift(); item; item = pending.changes.shift()) {
        try {
          if (grantSignature(item.persisted) !== grantSignature(pending.confirmedPersisted)) {
            const runtime = await api.setDefaultGrant({ grant: item.persisted })
            const saved = { ...runtime.defaultGrant, deviceId: runtime.currentDeviceId ?? deviceId }
            pending.confirmedPersisted = saved
            pending.confirmedDraft = reconcileDraft(item.draft, saved)
            api.onRuntime?.(runtime)
          } else {
            pending.confirmedDraft = reconcileDraft(item.draft, pending.confirmedPersisted)
          }
          error = undefined
        } catch (cause) { error = failureText(cause) }
      }
      update(latest => latest?.pending === pending ? {
        ...latest, pending: undefined, confirmedPersisted: pending.confirmedPersisted,
        draft: error === undefined ? reconcileDraft(pending.latestDraft, pending.confirmedPersisted) : pending.confirmedDraft,
        error, saveError: error !== undefined,
      } : latest)
    })
    return { ...current, draft: nextDraft, pending, error: undefined, saveError: false }
  })
}
