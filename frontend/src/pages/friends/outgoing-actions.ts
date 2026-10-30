import { t } from '../../i18n'
import type { FriendsRuntimeSnapshot } from '../../../../shared/friends'
import { updateFriendsRuntime } from './runtime-state'

export type FriendOutgoingAction = 'cancel' | 'retry'
export interface FriendOutgoingActionDeps {
  confirmCancel(): Promise<boolean>
  cancel(requestId: string): Promise<FriendsRuntimeSnapshot>
  retry(requestId: string): Promise<FriendsRuntimeSnapshot>
  updated(snapshot: FriendsRuntimeSnapshot): void
  failed(error: unknown): void
}

const pending = new Map<string, Promise<boolean>>()
const subscribers = new Set<() => void>()
let revision = 0
const notify = () => { ++revision; for (const subscriber of subscribers) subscriber() }
export const subscribeFriendOutgoingActions = (subscriber: () => void) => { subscribers.add(subscriber); return () => { subscribers.delete(subscriber) } }
export const friendOutgoingActionsRevision = () => revision
export const friendOutgoingActionPending = (requestId: string) => pending.has(requestId)

const defaultDeps = (): FriendOutgoingActionDeps => ({
  confirmCancel: () => window.klausDialog.confirm({ title: t('chat_friend_cancel_request'), message: t('chat_friend_cancel_request_message'), confirmText: t('chat_friend_cancel_request'), cancelText: t('cancel') }),
  cancel: requestId => window.klaus.friends.cancel({ requestId }),
  retry: requestId => window.klaus.friends.retrySend({ requestId }),
  updated: updateFriendsRuntime,
  failed: error => window.showToast?.((error as Error)?.message || String(error)),
})

/** All outgoing surfaces share one stable request action and one in-flight guard. */
export function performFriendOutgoingAction(action: FriendOutgoingAction, requestId: string, deps: FriendOutgoingActionDeps = defaultDeps()): Promise<boolean> {
  if (!requestId) return Promise.resolve(false)
  const existing = pending.get(requestId)
  if (existing) return existing
  const work = Promise.resolve().then(async () => {
    if (action === 'cancel' && !await deps.confirmCancel()) return false
    deps.updated(await (action === 'cancel' ? deps.cancel(requestId) : deps.retry(requestId)))
    return true
  }).catch(error => { deps.failed(error); return false }).finally(() => { pending.delete(requestId); notify() })
  pending.set(requestId, work)
  notify()
  return work
}
