// The live friend inbox for the chat surface: which conversation currently
// holds a friend request awaiting its owner's decision, and which standing
// grant an approval would run it with. Friend requests are reviewed inside
// the conversation they arrived in, so the transcript reads the same runtime
// snapshot the friends page reads, from one shared subscription.
import type { FriendsRuntimeSnapshot, FriendTaskGrant, FriendTaskSummary } from '../../../shared/friends'

let snapshot: FriendsRuntimeSnapshot | null = null
let revision = 0
let inflight: Promise<void> | null = null
let wired = false
const listeners = new Set<() => void>()

function emit(): void {
  revision += 1
  for (const listener of [...listeners]) listener()
}

export function friendInboxRevision(): number {
  return revision
}

export function subscribeFriendInbox(listener: () => void): () => void {
  listeners.add(listener)
  wireFriendInbox()
  return () => { listeners.delete(listener) }
}

export function friendInboxSnapshot(): FriendsRuntimeSnapshot | null {
  return snapshot
}

export function refreshFriendInbox(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      snapshot = await window.klaus.friends.runtime()
      emit()
    } catch {
      // A failed read keeps the last good snapshot; the next change retries.
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function wireFriendInbox(): void {
  if (wired) return
  wired = true
  try {
    // Harness stubs of the bridge may omit the event surface entirely; the
    // explicit refresh below still fills the snapshot for them.
    window.klaus.on.friendsChanged?.(() => { void refreshFriendInbox() })
    // The boot refresh can race the account restore, and a request that arrived
    // while every window was closed left no change event behind to announce it;
    // both settle on the next auth or focus transition.
    if (typeof window.klaus.on.klausAuthUpdated === 'function') {
      window.klaus.on.klausAuthUpdated(() => { void refreshFriendInbox() })
    }
  } catch {
    /* no event surface: explicit refreshes still keep the snapshot current */
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => { void refreshFriendInbox() })
  }
  void refreshFriendInbox()
}

export function friendTaskById(taskId: string): FriendTaskSummary | null {
  return snapshot?.tasks.find(task => task.id === taskId) ?? null
}

/** The request still awaiting this conversation's owner, if any. */
export function pendingFriendTaskForSession(sessionId: string): FriendTaskSummary | null {
  if (!sessionId || !snapshot) return null
  return snapshot.tasks.find(task => task.threadId === sessionId && task.status === 'pending') ?? null
}

export function pendingFriendTaskByRequest(sessionId: string, requestId: string): FriendTaskSummary | null {
  if (!sessionId || !requestId || !snapshot) return null
  return snapshot.tasks.find(task => task.threadId === sessionId && task.requestId === requestId && task.status === 'pending') ?? null
}

/** A pending request that arrived in one of the owner's ordinary conversations. */
export function ownerChatPendingTask(requestId: string): FriendTaskSummary | null {
  const task = ownerChatTask(requestId)
  return task?.status === 'pending' ? task : null
}

/** A request that arrived in one of the owner's ordinary conversations, in any state. */
export function ownerChatTask(requestId: string): FriendTaskSummary | null {
  if (!requestId || !snapshot) return null
  return snapshot.tasks.find(task => task.requestId === requestId && !!task.ownerChatThreadId) ?? null
}

const SETTLED_STATUSES = ['rejected', 'cancelled', 'ignored']

/** The newest decided request of this conversation worth a quiet status line. */
export function settledFriendTaskForSession(sessionId: string, skip?: ReadonlySet<string>): FriendTaskSummary | null {
  if (!sessionId || !snapshot) return null
  const rows = snapshot.tasks.filter(task => task.threadId === sessionId && SETTLED_STATUSES.includes(task.status) && !skip?.has(task.requestId))
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return rows[0] ?? null
}

/** The decided state of one request, for the status line under its own message. */
export function settledFriendTaskByRequest(sessionId: string, requestId: string): FriendTaskSummary | null {
  if (!sessionId || !requestId || !snapshot) return null
  return snapshot.tasks.find(task => task.threadId === sessionId && task.requestId === requestId && SETTLED_STATUSES.includes(task.status)) ?? null
}

/** The grant an approval runs the task with: this friend's saved permission on
 *  this computer, else the account default. The settings surfaces own every
 *  standing grant, so an approval never edits one here. */
export function friendApprovalGrant(task: FriendTaskSummary): FriendTaskGrant | null {
  const deviceId = snapshot?.currentDeviceId
  if (!snapshot || !deviceId) return null
  const base = snapshot.templates.find(row => row.friendId === task.friendId && row.deviceId === deviceId)?.grant ?? snapshot.defaultGrant
  if (!base) return null
  return { ...base, deviceId, apps: [...base.apps], directories: base.directories.map(row => ({ ...row })), remember: false }
}
