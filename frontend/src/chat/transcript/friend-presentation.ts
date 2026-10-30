import type { FriendOutgoingSummary, FriendOutgoingStatus, FriendsRuntimeSnapshot } from '../../../../shared/friends'
import { friendDisplayName } from '../../pages/friends/display-name'
import { renderFriendMessageHtml } from '../../friend-message-summary'
import { rawIconHtml } from '../../components/Icon'
import { externalMessageDisplay } from './factories'
import styles from './transcript.module.css'
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * `unreplied`: on this computer, the task ended without a reply and the friend was told it ended.
 * `ended`: on the requesting side, the friend's Klaus finished without attaching a result.
 * `moved`: the conversation this exchange belonged to was deleted, so it continues here.
 */
export type FriendStatus = Extract<FriendOutgoingStatus, 'rejected' | 'cancelled' | 'failed'> | 'unreplied' | 'ended' | 'moved'
export interface FriendStatusDisplay { status: FriendStatus; detail?: string }

const LEGACY_STATUS: Record<string, FriendStatusDisplay> = {
  'The receiving user declined this task request. No task was run.': { status: 'rejected' },
  'The receiving user configured this friendship to decline task requests. No task was run.': { status: 'rejected' },
  'The receiving user cancelled this task and revoked its resource authorization.': { status: 'cancelled' },
  'The receiving task was cancelled and its resource authorization ended.': { status: 'cancelled' },
  'The receiving task stopped because friend communication disconnected. The receiving user must authorize a new attempt.': { status: 'failed' },
  'The receiving desktop restarted before this task finished. The receiving user must authorize a new attempt.': { status: 'failed' },
  'The receiving user did not handle this request in time. No task was run.': { status: 'failed', detail: 'The request was not processed.' },
}

export function friendStatusDisplay(local: any): FriendStatusDisplay | null {
  if (local?.externalFriendMessage !== true) return null
  // Legacy rows only: expiry is no longer produced anywhere, but history written
  // before it was removed still carries the status.
  if (local.friendStatus === 'expired') return { status: 'failed', detail: 'The request was not processed.' }
  if (['rejected', 'cancelled', 'failed', 'unreplied', 'ended', 'moved'].includes(local.friendStatus)) {
    return { status: local.friendStatus, ...(typeof local.statusDetail === 'string' ? { detail: local.statusDetail } : {}) }
  }
  if (local.protocolVersion === 3 || typeof local.replyType === 'string') return null
  const text = typeof local.displayText === 'string' ? local.displayText : ''
  if (LEGACY_STATUS[text]) return LEGACY_STATUS[text]
  const prefix = 'The receiving task failed: '
  return text.startsWith(prefix) ? { status: 'failed', detail: text.slice(prefix.length) } : null
}

export function resolveFriendIdentity(sender: any): { name: string; avatarUrl?: string } {
  const directory = typeof window !== 'undefined' ? (window as any).getFriendDirectoryEntry?.(sender?.friendshipId, sender?.userId) : undefined
  return { name: directory?.name || friendDisplayName(sender || {}), avatarUrl: directory?.avatarUrl || sender?.avatarUrl }
}

/**
 * Whether a missing-reply row still offers to have Klaus reply. Once the task
 * reports a delivered reply the offer is gone; without a snapshot the button
 * stays and the host refuses a second reply on its own.
 */
export function friendReplyStillMissing(taskId: string, runtime: FriendsRuntimeSnapshot | null | undefined): boolean {
  const task = runtime?.tasks.find(row => row.id === taskId)
  return task?.replied !== true
}

type FriendComposeAction = 'reply' | 'supplement' | 'handoff'
const FRIEND_ACTION_LABEL: Record<FriendComposeAction, string> = {
  reply: 'chat_friend_reply_action', supplement: 'chat_friend_supplement_action', handoff: 'chat_friend_quote_action',
}

/**
 * The icon buttons a friend message offers next to its time and copy control:
 * answer the sender (or add the information they asked for) and hand the
 * message to this computer's Klaus. Each is icon-only, so its name rides both
 * the accessible label and the transcript tooltip. Empty when the message has
 * no actions (a request whose decision card owns them, or a status with no
 * follow-up).
 */
export function friendMessageActionsHtml(local: any, sender: any, t: (key: string) => string, options: { ownerRequestOpen?: boolean } = {}): string {
  if (externalMessageDisplay(local) === null) return ''
  const { name } = resolveFriendIdentity(sender)
  const friendId = sender?.friendshipId || local.friendId || ''
  if (!friendId) return ''
  const state = friendStatusDisplay(local)
  // A relocated exchange is orientation only, and a missing reply is answered
  // by its own action in the status line.
  if (state?.status === 'moved' || state?.status === 'unreplied') return ''
  // A request's decisions are the card's job: offering reply and handoff next
  // to them would present the same choice twice. A request that arrived in the
  // owner's ordinary conversation is a plain message again once it is decided.
  if (!state && local.friendIntent === 'request' && (local.ownerChat !== true || options.ownerRequestOpen !== false)) return ''
  const messageId = local.messageId || local.requestId || ''
  const sentence = state ? t(`chat_friend_status_${state.status}`).replace('{name}', name) : ''
  const text = state ? state.detail || local.displayText || sentence : local.displayText || ''
  const button = (action: FriendComposeAction) => {
    const label = t(FRIEND_ACTION_LABEL[action])
    return `<button type="button" class="msg-action-btn" data-friend-compose-action="${action}" aria-label="${escapeHtml(label)}" data-klaus-tip="${escapeHtml(label)}"`
      + ` data-friend-id="${escapeHtml(friendId)}" data-friend-name="${escapeHtml(name)}" data-friend-message-id="${escapeHtml(messageId)}"`
      + ` data-friend-question-id="${escapeHtml(local.questionId || '')}" data-friend-request-id="${escapeHtml(local.replyToRequestId || local.requestId || '')}"`
      + ` data-friend-text="${escapeHtml(text)}">${rawIconHtml(`friend-${action}`)}</button>`
  }
  // A failed or declined exchange has nothing to answer; it can still be handed over.
  if (state) return button('handoff')
  return button(local.replyType === 'needs_input' ? 'supplement' : 'reply') + button('handoff')
}

export function renderFriendCardHtml(local: any, sender: any, t: (key: string) => string, requestTarget?: string, sessionId = '', runtime?: FriendsRuntimeSnapshot | null): string {
  const { name } = resolveFriendIdentity(sender)
  const state = friendStatusDisplay(local)
  if (state) {
    const detail = state.detail?.replace(/\s+/g, ' ').trim().slice(0, 180)
    const sentence = t(`chat_friend_status_${state.status}`).replace('{name}', name)
    const icon = `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="8" cy="8" r="6"/><path d="${state.status === 'rejected' || state.status === 'cancelled' ? 'M5 5l6 6m0-6l-6 6' : 'M8 4v5m0 2v1'}"/></svg>`
    // A relocated exchange is orientation only; nothing in it awaits a decision.
    if (state.status === 'moved') return `<div class="friend-system-status" role="status">${icon}<span>${escapeHtml(sentence)}</span></div>`
    if (state.status === 'unreplied') {
      // The only follow-up is a reply from this computer's Klaus; handing the
      // status line itself to a new turn would just restate it.
      const taskId = typeof local.friendTaskId === 'string' ? local.friendTaskId : ''
      const action = taskId && friendReplyStillMissing(taskId, runtime)
        ? `<button type="button" class="friend-status-action" data-friend-request-reply="${escapeHtml(taskId)}">${escapeHtml(t('chat_friend_request_reply_action').replace('{name}', name))}</button>` : ''
      return `<div class="friend-system-status" role="status">${icon}<span>${escapeHtml(sentence)}</span>${action}</div>`
    }
    // The handoff stays reachable on the line itself, revealed on hover like a
    // message's action bar.
    const handoff = friendMessageActionsHtml(local, sender, t)
    return `<div class="friend-system-status" role="status">${icon}<span>${escapeHtml(sentence)}${state.status === 'failed' && detail ? `：${escapeHtml(detail)}` : ''}</span>${handoff ? `<span class="msg-actions friend-status-actions">${handoff}</span>` : ''}</div>`
  }
  const isReply = !!local.replyToRequestId || typeof local.requestCreatedAt === 'number'
  const requestTime = typeof local.requestCreatedAt === 'number' && Number.isFinite(local.requestCreatedAt)
    ? new Date(local.requestCreatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
  const requestLabel = requestTime ? t('chat_friend_request_at').replace('{time}', requestTime) : ''
  const request = requestLabel ? ` · ${requestTarget
    ? `<button type="button" class="friend-request-link" data-friend-request-target="${escapeHtml(requestTarget)}">${escapeHtml(requestLabel)}</button>`
    : `<span>${escapeHtml(requestLabel)}</span>`}` : ''
  const isNotice = local.friendIntent === 'notice'
  // The reply and handoff controls live in the row's action bar next to copy;
  // see friendMessageActionsHtml.
  return `<div class="${styles['delegation-label-row']} friend-source-row"><span data-external-sender-name>${escapeHtml(name)}</span><span class="friend-identity-tag">${escapeHtml(t('friend_identity_tag'))}</span><span>${escapeHtml(t(isNotice ? 'chat_friend_notice' : isReply ? 'chat_friend_reply' : local.friendIntent === 'request' ? 'chat_friend_request_incoming' : 'chat_friend_incoming_task'))}</span>${request}</div><div class="sent-user-stack"><div class="msg user friend-card-body" data-friend-card>${renderFriendMessageHtml(local.displayText || '', t, sessionId)}</div></div>`
}

export function friendOutgoingForMessage(outgoing: readonly FriendOutgoingSummary[], sessionId: string, friendIds: string[], timestamp: unknown, correlation: { requestId?: string; dispatchId?: string } = {}): FriendOutgoingSummary[] {
  const sentAt = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp || ''))
  return friendIds.flatMap(friendId => {
    const candidates = outgoing.filter(row => row.sourceThreadId === sessionId && row.friendId === friendId)
    if (correlation.requestId || correlation.dispatchId) {
      const row = candidates.find(row => correlation.requestId ? row.requestId === correlation.requestId : row.dispatchId === correlation.dispatchId)
      return row ? [row] : []
    }
    // Legacy rows predate stable composer correlation.
    const row = Number.isFinite(sentAt) ? candidates
      .filter(row => Math.abs(row.createdAt - sentAt) < 120_000)
      .sort((a, b) => Math.abs(a.createdAt - sentAt) - Math.abs(b.createdAt - sentAt))[0] : undefined
    return row ? [row] : []
  })
}

export function renderFriendOutgoingStatusHtml(row: FriendOutgoingSummary, name: string, t: (key: string) => string, pending = false): string {
  const request = escapeHtml(row.requestId)
  const disabled = pending ? ' disabled' : ''
  const controls = `${row.canCancel ? `<button type="button" data-friend-outgoing-action="cancel" data-friend-request-id="${request}"${disabled}>${escapeHtml(t('chat_friend_cancel_request'))}</button>` : ''}${row.canRetry ? `<button type="button" data-friend-outgoing-action="retry" data-friend-request-id="${request}"${disabled}>${escapeHtml(t('chat_friend_retry_send'))}</button>` : ''}`
  return `<span class="friend-delivery-chip" data-friend-delivery-status="${escapeHtml(row.status)}"><span>${escapeHtml(name)} ${escapeHtml(t(friendOutgoingStatusKey(row)))}</span>${controls}</span>`
}

export const friendOutgoingStatusKey = (row: FriendOutgoingSummary) => row.status === 'failed' && row.canRetry ? 'chat_friend_delivery_send_failed' : `chat_friend_delivery_${row.status}`

export function friendRequestTarget(messages: any[], local: any): string | undefined {
  const id = local?.sender?.friendshipId
  const at = local?.requestCreatedAt
  if (!id || typeof at !== 'number') return undefined
  return messages.filter(msg => msg.role === 'user' && msg.uuid && msg.localRender?.composerReferences?.some((ref: any) => ref.kind === 'friend' && ref.id === id))
    .map(msg => ({ msg, time: typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(msg.timestamp) }))
    .filter(row => Number.isFinite(row.time) && row.time <= at)
    .sort((a, b) => b.time - a.time)[0]?.msg.uuid
}

/** The set of request ids that have both a parked request row and a later
 *  task-delivery row. The request row is hidden once the turn row exists so the
 *  same arrival is not rendered twice. */
export function supersededFriendRequestIds(locals: any[]): ReadonlySet<string> {
  const superseded = new Set<string>()
  const requestIds = new Set<string>()
  for (const local of locals) {
    if (local?.externalFriendMessage !== true || typeof local?.requestId !== 'string') continue
    if (local.friendIntent === 'request') requestIds.add(local.requestId)
    else if (requestIds.has(local.requestId)) superseded.add(local.requestId)
  }
  return superseded
}

export function attachFriendFollowUps<T extends { type: string; turnId?: string; msg?: any }>(units: T[]): Array<T & { friendFollowUp?: boolean }> {
  let deliveryTurn: string | undefined
  const startedTurns = new Set<string>()
  return units.map(unit => {
    if (unit.type === 'user' || unit.type === 'delegation' || unit.type === 'live-user' || unit.type === 'live-delegation') {
      deliveryTurn = !!unit.turnId && !startedTurns.has(unit.turnId) && unit.msg?.localRender?.externalFriendMessage === true
        && (unit.msg.localRender.replyToRequestId || typeof unit.msg.localRender.requestCreatedAt === 'number')
        && !friendStatusDisplay(unit.msg.localRender) ? unit.turnId : undefined
    }
    if (unit.turnId && ['user', 'delegation', 'text', 'thinking', 'tools', 'live-user', 'live-delegation', 'live-text', 'live-thinking', 'live-tools'].includes(unit.type)) startedTurns.add(unit.turnId)
    return (unit.type === 'text' || unit.type === 'live-text') && deliveryTurn && unit.turnId === deliveryTurn ? { ...unit, friendFollowUp: true } : unit
  })
}
