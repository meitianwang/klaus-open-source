// A friend request waits for its decision inside the conversation it arrived
// in. The first request in a friend conversation asks once for the whole
// conversation; later requests reuse that admission. The card offers the
// one-click approval (the friend's saved permission on this computer, or the
// account default when the friend has none), a decline, and a look at the
// scope the approval would run. A decided request leaves a quiet status line.
import { useState, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { Icon } from '../../components/Icon'
import { FriendsDialog } from '../../pages/friends/FriendsDialog'
import { GrantSummary } from '../../pages/friends/FriendsPage'
import { failureText } from '../../pages/friends/data'
import { friendApprovalGrant, friendInboxRevision, ownerChatTask, pendingFriendTaskByRequest, pendingFriendTaskForSession, refreshFriendInbox, settledFriendTaskByRequest, settledFriendTaskForSession, subscribeFriendInbox } from '../friend-inbox'
import type { FriendTaskSummary } from '../../../../shared/friends'
import { approveFriendTask } from '../friend-task-start'
import styles from '../chat.module.css'

function SettledLine({ task }: { task: FriendTaskSummary }) {
  const t = useT()
  const key = task.status === 'rejected' ? 'friend_approval_rejected' : task.status === 'cancelled' ? 'friend_approval_cancelled' : 'friend_approval_ignored'
  return <div className={styles['friend-approval-settled']} data-friend-settled={task.id}><span>{t(key)}</span></div>
}

export function FriendTaskApproval({ sessionId, requestId, skipPending }: {
  sessionId: string
  /** Render the decision for one specific request (the message row that carries it). */
  requestId?: string
  /** Requests whose decision card already renders inline beside their message. */
  skipPending?: ReadonlySet<string>
}) {
  const t = useT()
  useSyncExternalStore(subscribeFriendInbox, friendInboxRevision, friendInboxRevision)
  const [busy, setBusy] = useState<'allow' | 'reject' | ''>('')
  const [scopeOpen, setScopeOpen] = useState(false)
  const [error, setError] = useState('')
  const found = requestId ? pendingFriendTaskByRequest(sessionId, requestId) : pendingFriendTaskForSession(sessionId)
  const pending = found && !skipPending?.has(found.requestId) ? found : null
  const grant = pending ? friendApprovalGrant(pending) : null
  const target = grant?.target
  const location = !target || target.kind === 'none'
    ? t('friend_approval_location_chat')
    : target.kind === 'project' ? target.root : target.id

  const decide = async (kind: 'allow' | 'reject') => {
    if (!pending || busy) return
    setBusy(kind); setError('')
    try {
      if (kind === 'allow') {
        if (!grant) throw new Error(t('friends_runtime_loading'))
        await approveFriendTask(pending, grant)
      } else {
        await window.klaus.friends.reject({ taskId: pending.id })
      }
      await refreshFriendInbox()
    } catch (failure) {
      setError(t(failureText(failure)))
      setBusy('')
    }
  }

  if (pending) {
    return <>
      <div className={styles['friend-approval']} data-friend-approval={pending.id}>
        <div className={styles['friend-approval-title']}><Icon name="lock" size={15} />{t('friend_approval_title').replace('{name}', pending.senderDisplayName)}</div>
        <p className={styles['friend-approval-location']}>{t('friend_approval_location').replace('{value}', location)}</p>
        <p className={styles['friend-approval-hint']}>{t('friend_approval_hint')}</p>
        <div className={styles['friend-approval-btns']}>
          <button className="kls-btn kls-btn-primary" disabled={busy !== '' || !grant} onClick={() => void decide('allow')}>{t('friend_approval_allow')}</button>
          <button className="kls-btn kls-btn-secondary" disabled={busy !== ''} onClick={() => void decide('reject')}>{t('friend_approval_reject')}</button>
          <button className={styles['friend-approval-link']} disabled={!grant} onClick={() => setScopeOpen(true)}>{t('friend_approval_scope')}</button>
        </div>
        {error && <p className={styles['friend-approval-error']} role="alert">{error}</p>}
      </div>
      {scopeOpen && grant ? <FriendsDialog title={t('friend_approval_scope_title')} onClose={() => setScopeOpen(false)} footer={<button className="kls-btn kls-btn-secondary" onClick={() => setScopeOpen(false)}>{t('friends_done')}</button>}>
        <GrantSummary grant={grant} />
      </FriendsDialog> : null}
    </>
  }
  // A request with its own message row shows its decided state right there; the
  // conversation-end line covers only decisions without such a row.
  const settled = requestId ? settledFriendTaskByRequest(sessionId, requestId) : settledFriendTaskForSession(sessionId, skipPending)
  return settled ? <SettledLine task={settled} /> : null
}

/**
 * A request that arrived in one of the owner's ordinary conversations is not a
 * separate friend task. It runs under that conversation's existing permissions
 * without an admission card. Normal message reply actions remain available;
 * this row reports whether it is queued or already handed to Klaus.
 */
export function FriendOwnerChatRequest({ requestId, friendName }: {
  requestId: string; friendId?: string; friendName: string; messageId?: string
}) {
  const t = useT()
  useSyncExternalStore(subscribeFriendInbox, friendInboxRevision, friendInboxRevision)
  const task = ownerChatTask(requestId)
  if (!task) return null
  if (task.status !== 'pending') {
    const key = task.status === 'completed' ? (task.replyError ? 'chat_friend_owner_request_reply_pending' : 'chat_friend_owner_request_replied')
      : task.status === 'rejected' ? 'friend_approval_rejected' : task.status === 'cancelled' ? 'friend_approval_cancelled' : 'friend_approval_ignored'
    return <div className={styles['friend-approval-settled']} data-friend-settled={task.id}><span>{t(key).replace('{name}', friendName)}</span></div>
  }
  const handedOff = typeof task.ownerHandoffAt === 'number'
  return <div className={styles['friend-approval-settled']} data-friend-owner-request={task.id}>
    <span>{t(handedOff ? 'chat_friend_owner_request_handed_off' : 'chat_friend_owner_request_waiting').replace(/\{name\}/g, friendName)}</span>
  </div>
}
