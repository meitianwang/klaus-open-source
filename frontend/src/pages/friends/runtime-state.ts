import type { FriendsRuntimeSnapshot } from '../../../../shared/friends'

let snapshot: FriendsRuntimeSnapshot | null = null
const subscribers = new Set<() => void>()
export function updateFriendsRuntime(next: FriendsRuntimeSnapshot | null): void {
  snapshot = next
  for (const subscriber of subscribers) subscriber()
}
export const friendsRuntimeSnapshot = () => snapshot
export function subscribeFriendsRuntime(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  return () => { subscribers.delete(subscriber) }
}
