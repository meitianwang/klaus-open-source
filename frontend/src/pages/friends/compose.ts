import { friendMentionValue } from '../../../../shared/friends'

export const FRIEND_COMPOSE_EVENT = 'klaus:friend-compose'
export interface FriendComposeRequest { friendId: string; name: string; value: string }
let queued: FriendComposeRequest | null = null

export function composeFriendTask(friendId: string, name: string): void {
  queued = { friendId, name, value: friendMentionValue(friendId) }
  window.dispatchEvent(new CustomEvent<FriendComposeRequest>(FRIEND_COMPOSE_EVENT, { detail: queued }))
}

export function takeQueuedFriendCompose(): FriendComposeRequest | null {
  const request = queued
  queued = null
  return request
}
