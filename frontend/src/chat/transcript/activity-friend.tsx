import { useSyncExternalStore } from 'react'
import { Icon } from '../../components/Icon'
import { I18N } from '../../i18n'
import { friendDisplayName } from '../../pages/friends/display-name'
import { friendsRuntimeSnapshot, subscribeFriendsRuntime } from '../../pages/friends/runtime-state'
import { friendOutgoingActionPending, friendOutgoingActionsRevision, performFriendOutgoingAction, subscribeFriendOutgoingActions } from '../../pages/friends/outgoing-actions'
import type { ActivityToolData } from './activity-tool-model'
import { activityErrorText, activityRecord, activityResultObjects, friendRecipientName, friendSendResult, friendSendToolName } from './activity-semantic'
import styles from './activity-rich-details.module.css'
import { friendOutgoingStatusKey } from './friend-presentation'

export function friendActivityResult(output: string | undefined) {
  const objects = activityResultObjects(output)
  const directory = objects.find(item => Array.isArray(item.friends))
  const receipt = objects.find(item => item.accepted === true || item.delivered === true)
  const friends = directory ? (directory.friends as unknown[]).flatMap(value => {
    const row = activityRecord(value)
    if (typeof row.id !== 'string' || !row.id) return []
    return [{ id: row.id,
      displayName: typeof row.displayName === 'string' ? row.displayName : undefined,
      remark: typeof row.remark === 'string' ? row.remark : undefined,
      online: typeof row.online === 'boolean' ? row.online : undefined,
      peerAllowsAgentTasks: typeof row.peerAllowsAgentTasks === 'boolean' ? row.peerAllowsAgentTasks : undefined,
    }]
  }) : undefined
  return { friends, signedIn: directory?.signedIn, accepted: !!receipt, delivered: receipt?.delivered === true, awaitingAuthorization: receipt?.awaitingAuthorization === true,
    requestId: typeof receipt?.requestId === 'string' ? receipt.requestId : undefined }
}

const FRIEND_KIND_KEYS: Record<string, string> = {
  request: 'chat_friend_kind_request', notice: 'chat_friend_kind_notice', reply: 'chat_friend_kind_reply',
  progress: 'chat_friend_kind_progress', question: 'chat_friend_kind_question',
}

export function FriendActivityDetails({ tool, locale }: { tool: ActivityToolData; locale: string }) {
  const zh = locale.startsWith('zh')
  const t = (key: string) => I18N[zh ? 'zh' : 'en'][key] || key
  const args = activityRecord(tool.args)
  const result = friendActivityResult(tool.output)
  const sent = friendSendResult(tool.output)
  const runtime = useSyncExternalStore(subscribeFriendsRuntime, friendsRuntimeSnapshot, friendsRuntimeSnapshot)
  useSyncExternalStore(subscribeFriendOutgoingActions, friendOutgoingActionsRevision, friendOutgoingActionsRevision)
  const name = friendSendToolName(tool.toolName)
  const sending = name !== null
  const friendId = typeof args.friendId === 'string' ? args.friendId : sent.friendId
  // Only a started collaboration owns an outgoing row with its own cancel and retry.
  const outgoing = name === 'send_message_to_friend' && result.requestId
    ? runtime?.outgoing.find(row => row.requestId === result.requestId && row.friendId === friendId) : undefined
  const pending = !!outgoing && friendOutgoingActionPending(outgoing.requestId)
  const recipient = friendRecipientName(args, tool.output) || (zh ? '好友' : 'Friend')
  const kind = sent.converted ? 'reply' : name === 'send_message_to_friend' ? args.intent === 'notice' ? 'notice' : 'request'
    : name === 'reply_to_friend' ? 'reply' : name === 'send_friend_progress' ? 'progress' : 'question'
  // The owner may have edited the text before it left; the result carries what was sent.
  const message = sent.prompt ?? (typeof args.prompt === 'string' ? args.prompt : typeof args.question === 'string' ? args.question : '')
  const failed = tool.state === 'error' || tool.state === 'interrupted'
  const failure = failed ? activityErrorText(tool.output) : ''
  return <div className={styles.friendDetails} data-friend-result={sending ? 'send' : 'list'} data-friend-kind={sending ? kind : undefined}>
    {sending ? <>
      <div className={styles.friendRecipient}><Icon name="tool-friends" size={16} /><span>{recipient}</span></div>
      <div className={styles.caption} data-friend-kind-caption>{t(FRIEND_KIND_KEYS[kind]!)}</div>
      {kind === 'request' && (args.onReply === 'display' || args.onReply === 'follow_up')
        ? <div className={styles.caption} data-friend-arrangement>{t(args.onReply === 'follow_up' ? 'chat_friend_followup_auto' : 'chat_friend_followup_display')}</div> : null}
      {message ? <div className={styles.friendMessage} data-friend-message>{message}</div> : null}
      {sent.declined ? <div className={styles.caption} data-friend-delivery="declined"><span>{t('chat_friend_not_sent_detail')}</span></div>
        : outgoing || tool.state === 'done' && result.accepted ? <div className={styles.caption} data-friend-delivery>
        <span>{outgoing ? t(friendOutgoingStatusKey(outgoing)) : t(result.delivered ? 'chat_friend_delivery_to_device' : 'chat_friend_delivery_sent')}</span>
        {!outgoing && result.awaitingAuthorization ? <span>{t('chat_friend_delivery_awaiting_authorization')}</span> : null}
        {outgoing?.canCancel ? <button type="button" className={styles.friendAction} disabled={pending} onClick={() => void performFriendOutgoingAction('cancel', outgoing.requestId)}>{t('chat_friend_cancel_request')}</button> : null}
        {outgoing?.canRetry ? <button type="button" className={styles.friendAction} disabled={pending} onClick={() => void performFriendOutgoingAction('retry', outgoing.requestId)}>{t('chat_friend_retry_send')}</button> : null}
      </div> : null}
    </> : tool.state === 'done' && result.friends ? <>
      {result.signedIn === false ? <p className={styles.notice}>{zh ? '登录后可查看好友' : 'Sign in to view friends'}</p>
        : result.friends.length ? result.friends.map(friend => <div className={styles.friendRow} key={friend.id}>
          <Icon name="tool-friends" size={16} />
          <div className={styles.friendInfo}><div>{friendDisplayName(friend)}</div><div className={styles.caption}>
            {friend.online !== undefined ? <span>{friend.online ? zh ? '在线' : 'Online' : zh ? '离线' : 'Offline'}</span> : null}
            {friend.peerAllowsAgentTasks !== undefined ? <span>{friend.peerAllowsAgentTasks ? zh ? '允许接收任务' : 'Accepts tasks' : zh ? '未允许接收任务' : 'Does not accept tasks'}</span> : null}
          </div></div>
        </div>) : <p className={styles.notice}>{zh ? '暂无好友' : 'No friends yet'}</p>}
    </> : null}
    {failure ? <div className={styles.friendFailure} role="status">{failure}</div> : null}
  </div>
}
