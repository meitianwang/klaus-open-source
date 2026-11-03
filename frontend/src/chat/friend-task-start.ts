import type { FriendTaskGrant, FriendTaskSummary, FriendsRuntimeSnapshot } from '../../../shared/friends'
import { applyFriendInboxReceipt, friendTaskById, subscribeFriendInbox } from './friend-inbox'
import { beginPendingUserTurn, finishPendingUserTurn, hasPendingTurnStart } from './stream-store'

type Attempt = { taskId: string; sessionId: string; uuid: string; stopping: boolean }
const attempts = new Map<string, Attempt>()

function finish(attempt: Attempt, outcome: 'cancelled' | 'failed', error?: string): void {
  if (attempts.get(attempt.sessionId) !== attempt) return
  attempts.delete(attempt.sessionId)
  finishPendingUserTurn(attempt.sessionId, attempt.uuid, outcome, error)
}

// Ownership outlives the approval card and navigation. A failure before the
// first engine frame must settle the same startup state that ordinary sends use.
let wired = false
function wire(): void {
  if (wired) return
  wired = true
  subscribeFriendInbox(() => {
    for (const attempt of attempts.values()) {
      const task = friendTaskById(attempt.taskId)
      if (!task || task.status === 'pending' || task.status === 'starting' || task.status === 'running') continue
      finish(attempt, task.status === 'failed' ? 'failed' : 'cancelled', task.error)
    }
  })
}

export async function approveFriendTask(task: FriendTaskSummary, grant: FriendTaskGrant): Promise<void> {
  const sessionId = task.threadId
  if (!sessionId || attempts.has(sessionId)) return
  const attempt: Attempt = { taskId: task.id, sessionId, uuid: `friend-approval:${crypto.randomUUID()}`, stopping: false }
  attempts.set(sessionId, attempt)
  wire()
  // The friend's message already exists in history. Submit only its runtime
  // ownership so startup never creates a second bubble or resets the draft.
  beginPendingUserTurn(sessionId, { text: task.prompt, uuid: attempt.uuid, timestamp: Date.now() }, { messageAlreadyVisible: true })
  try {
    const receipt = await window.klaus.friends.approve({ taskId: task.id, grant })
    if (attempt.stopping) {
      if (attempts.get(sessionId) !== attempt) return
      try {
        const cancelled = await window.klaus.friends.cancel({ taskId: task.id })
        applyFriendInboxReceipt(cancelled)
        finish(attempt, 'cancelled')
      } catch (error) {
        attempt.stopping = false
        finishPendingUserTurn(sessionId, attempt.uuid, 'accepted')
        window.showToast?.(error instanceof Error ? error.message : String(error))
      }
      return
    }
    applyFriendInboxReceipt(receipt)
    finishPendingUserTurn(sessionId, attempt.uuid, 'accepted')
  } catch (error) {
    finish(attempt, 'cancelled')
    if (!attempt.stopping) throw error
  }
}

/** The ordinary stop control also cancels an approved request still preparing. */
export function stopPendingFriendTask(sessionId: string): boolean {
  const attempt = attempts.get(sessionId)
  if (!attempt || !hasPendingTurnStart(sessionId)) return false
  if (attempt.stopping) return true
  attempt.stopping = true
  void window.klaus.friends.cancel({ taskId: attempt.taskId }).then((receipt: FriendsRuntimeSnapshot) => {
    applyFriendInboxReceipt(receipt)
    finish(attempt, 'cancelled')
  }).catch((error: unknown) => {
    attempt.stopping = false
    window.showToast?.(error instanceof Error ? error.message : String(error))
  })
  return true
}
