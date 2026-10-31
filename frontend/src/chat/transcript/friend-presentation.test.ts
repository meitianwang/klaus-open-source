import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { attachFriendFollowUps, friendMessageActionsHtml, friendOutgoingForMessage, friendRequestTarget, friendStatusDisplay, isIncomingFriendRequest, renderFriendCardHtml, renderFriendOutgoingStatusHtml, supersededFriendRequestIds } from './friend-presentation'
import { friendDisplayName } from '../../pages/friends/display-name'
import { t as globalT } from '../../i18n'
import { renderFriendMessageHtml } from '../../friend-message-summary'
import type { FriendOutgoingSummary } from '../../../../shared/friends'

let originalWindow: PropertyDescriptor | undefined
beforeAll(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { currentLang: 'zh' } })
})
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

const t = (key: string) => ({
  friend_identity_tag: '好友', chat_friend_reply: '的回复', chat_friend_incoming_task: '发来的任务',
  chat_friend_request_at: '回应你 {time} 的请求', friend_message_expand: '展开全文', friend_message_open_reader: '打开阅读器',
  friend_message_meta: '{chars} 字 · {lines} 行',
} as Record<string, string>)[key] || key
const external = (displayText: string, extra = {}) => ({ externalFriendMessage: true, displayText, ...extra })

describe('friend status projection', () => {
  test('projects structured statuses and retains a bounded failure detail', () => {
    for (const status of ['rejected', 'cancelled', 'failed']) expect(friendStatusDisplay(external('anything', { friendStatus: status, statusDetail: 'detail' }))).toEqual({ status, detail: 'detail' })
    expect(friendStatusDisplay(external('old status', { friendStatus: 'expired' }))?.status).toBe('failed')
    expect(friendStatusDisplay({ friendStatus: 'failed' })).toBeNull()
  })
  test('v3 completed prose cannot impersonate a legacy status event', () => {
    const prose = 'The receiving user declined this task request. No task was run.'
    expect(friendStatusDisplay(external(prose, { protocolVersion: 3, replyType: 'completed' }))).toBeNull()
    expect(friendStatusDisplay(external(prose, { replyType: 'progress' }))).toBeNull()
    expect(friendStatusDisplay(external(prose, { protocolVersion: 3, replyType: 'rejected', friendStatus: 'rejected' }))?.status).toBe('rejected')
  })
  test('recognizes every host-authored legacy status sentence without broad keyword matching', () => {
    const cases = [
      ['The receiving user declined this task request. No task was run.', 'rejected'],
      ['The receiving user configured this friendship to decline task requests. No task was run.', 'rejected'],
      ['The receiving user cancelled this task and revoked its resource authorization.', 'cancelled'],
      ['The receiving task was cancelled and its resource authorization ended.', 'cancelled'],
      ['The receiving desktop restarted before this task finished. The receiving user must authorize a new attempt.', 'failed'],
      ['The receiving task stopped because friend communication disconnected. The receiving user must authorize a new attempt.', 'failed'],
      ['The receiving user did not handle this request in time. No task was run.', 'failed'],
    ]
    for (const [text, status] of cases) expect(friendStatusDisplay(external(text))?.status).toBe(status)
    expect(friendStatusDisplay(external('The receiving task failed: network error'))).toEqual({ status: 'failed', detail: 'network error' })
    expect(friendStatusDisplay(external('I cancelled an old run and fixed the bug.'))).toBeNull()
    expect(friendStatusDisplay(external(' The receiving user declined this task request. No task was run.'))).toBeNull()
  })
})

describe('friend display names', () => {
  test('uses local remark, nickname, then email local part', () => {
    expect(friendDisplayName({ remark: ' 林晓 ', displayName: 'Klaus' })).toBe('林晓')
    expect(friendDisplayName({ displayName: 'kLaUs' })).toBe('kLaUs')
    expect(friendDisplayName({ email: 'lin@example.com' })).toBe('lin')
    expect(friendDisplayName({})).toBe(globalT('friends_no_nickname'))
  })
})

describe('friend messages', () => {
  test('renders Markdown inside a message bubble with provenance above it', () => {
    const html = renderFriendCardHtml(external('## Result\n\n- **One**\n- Two', { requestCreatedAt: new Date(2026, 9, 14, 15, 27).getTime(), replyToRequestId: 'req' }), { displayName: '林晓' }, t, 'original')
    expect(html).toContain('<ul>')
    expect(html).toContain('<strong>One</strong>')
    expect(html).toContain('data-external-sender-name>林晓')
    expect(html).toContain('好友')
    expect(html).toContain('15:27')
    expect(html).toContain('data-friend-request-target="original"')
    expect(html).not.toContain('data-external-sender-col')
    expect(html).toContain('class="msg user friend-card-body"')
    expect(html).toContain('class="sent-user-stack"')
    expect(html).not.toContain('<article')
    expect(html).not.toContain('<header')
  })
  test('incoming tasks share the bubble and long replies share small action buttons', () => {
    expect(renderFriendCardHtml(external('task'), { displayName: '林晓' }, t)).toContain('发来的任务')
    const html = renderFriendMessageHtml(Array.from({ length: 15 }, (_, i) => `- item ${i}`).join('\n'), t)
    expect(html).toContain('<button type="button" class="friend-msg-btn"')
    expect(html).toContain('class="md friend-msg-full" hidden')
    expect(html).toContain('<li>item 14</li>')
  })
  test('notice actions preserve stable reply identity without model instructions', () => {
    const local = external('A <script>notice</script>', { friendIntent: 'notice', requestId: 'notice-1', messageId: 'event-1' })
    const html = renderFriendCardHtml(local, { friendshipId: 'friend-1', displayName: 'Mia' }, t)
    expect(html).toContain('chat_friend_notice')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('data-friend-followup')
    // The actions moved out of the card into the row's action bar.
    expect(html).not.toContain('data-friend-compose-action')
    const actions = friendMessageActionsHtml(local, { friendshipId: 'friend-1', displayName: 'Mia' }, t)
    expect(actions).toContain('data-friend-compose-action="reply"')
    expect(actions).toContain('data-friend-compose-action="handoff"')
    expect(actions).toContain('data-friend-message-id="event-1"')
    expect(actions).not.toContain('<script>')
    const question = friendMessageActionsHtml(external('Which project?', { replyType: 'needs_input', questionId: 'q-1', replyToRequestId: 'root-1' }), { friendshipId: 'friend-1' }, t)
    expect(question).toContain('data-friend-compose-action="supplement"')
    expect(question).toContain('data-friend-question-id="q-1"')
    expect(question).toContain('data-friend-request-id="root-1"')
  })
  test('a friend answering our request can be replied to and handed over like any message', () => {
    // The host records a response to one of our requests with the request's
    // purpose plus the request it answers and its result type.
    const local = external('那就快去休息吧', { protocolVersion: 3, friendIntent: 'request', requestId: 'their-reply', messageId: 'their-reply',
      replyToRequestId: 'our-request', requestCreatedAt: 1, replyType: 'completed' })
    expect(isIncomingFriendRequest(local)).toBe(false)
    const actions = friendMessageActionsHtml(local, { friendshipId: 'friend-1', displayName: 'Nick' }, t)
    expect(actions).toContain('data-friend-compose-action="reply"')
    expect(actions).toContain('data-friend-compose-action="handoff"')
    // A friend's own request still waits for its card.
    const request = external('看下磁盘', { protocolVersion: 3, friendIntent: 'request', requestId: 'req-9', messageId: 'req-9' })
    expect(isIncomingFriendRequest(request)).toBe(true)
    expect(friendMessageActionsHtml(request, { friendshipId: 'friend-1', displayName: 'Nick' }, t)).toBe('')
    // A response row never hides an earlier request row that shares no id with it.
    expect([...supersededFriendRequestIds([request, local])]).toEqual([])
  })
  test('reply sends with a paper plane and handoff shows the Klaus mark', () => {
    const actions = friendMessageActionsHtml(external('hello', { friendIntent: 'notice', messageId: 'event-3' }), { friendshipId: 'friend-1', displayName: 'Mia' }, t)
    const [reply, handoff] = actions.split('</button>')
    expect(reply).toContain('data-friend-compose-action="reply"')
    expect(reply).toContain('M227.32,28.68')
    expect(handoff).toContain('data-friend-compose-action="handoff"')
    expect(handoff).toContain('M24 5 38.5 13v16.5')
  })
  test('friend message actions are icon buttons that sit in the message action bar with a tooltip', () => {
    const actions = friendMessageActionsHtml(external('hello', { friendIntent: 'notice', messageId: 'event-2' }), { friendshipId: 'friend-1', displayName: 'Mia' }, t)
    const buttons = actions.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    for (const button of buttons) {
      // Same control family as copy, so the bar's hover reveal and styling apply.
      expect(button).toContain('class="msg-action-btn"')
      // Icon-only: the name is the accessible label and the transcript tooltip.
      expect(button).toMatch(/aria-label="chat_friend_(reply|quote)_action"/)
      expect(button).toMatch(/data-klaus-tip="chat_friend_(reply|quote)_action"/)
    }
    expect(actions).toContain('<svg')
    expect(actions).not.toMatch(/>chat_friend_(reply|quote)_action</)
    expect(friendMessageActionsHtml({ displayText: 'own text' }, { friendshipId: 'friend-1' }, t)).toBe('')
    expect(friendMessageActionsHtml(external('no sender'), {}, t)).toBe('')
  })
  test('an approval request reads as a message asking for handling, without duplicate reply actions', () => {
    const html = renderFriendCardHtml(external('check the pool', { friendIntent: 'request', requestId: 'req-1', messageId: 'req-1' }), { friendshipId: 'friend-1', displayName: 'Nick' }, t)
    expect(html).toContain('chat_friend_request_incoming')
    expect(html).toContain('check the pool')
    // The decision card under the bubble owns the actions.
    expect(html).not.toContain('data-friend-compose-action')
    expect(friendMessageActionsHtml(external('check the pool', { friendIntent: 'request', requestId: 'req-1', messageId: 'req-1' }), { friendshipId: 'friend-1', displayName: 'Nick' }, t)).toBe('')
  })
  test('failed and rejected records retain a local handoff containing the full cause', () => {
    const full = 'A complete failure detail. '.repeat(30) + '<last cause>'
    for (const status of ['failed', 'rejected']) {
      const html = renderFriendCardHtml(external('Short status', { friendStatus: status, statusDetail: full, messageId: 'failed-event' }), { friendshipId: 'friend-a', displayName: 'Mia' }, t)
      expect(html).toContain('data-friend-compose-action="handoff"')
      expect(html).toContain('data-friend-message-id="failed-event"')
      expect(html).toContain('&lt;last cause&gt;')
      expect(html).not.toContain('data-friend-compose-action="reply"')
    }
  })
  test('a request in an ordinary conversation is decided on its card, then reads as a plain message', () => {
    const local = external('check the pool', { friendIntent: 'request', ownerChat: true, requestId: 'req-2', messageId: 'req-2' })
    const sender = { friendshipId: 'friend-1', displayName: 'Nick' }
    expect(renderFriendCardHtml(local, sender, t)).toContain('chat_friend_request_incoming')
    // While the request is open (or its state is not known yet) the card owns the choices.
    expect(friendMessageActionsHtml(local, sender, t)).toBe('')
    expect(friendMessageActionsHtml(local, sender, t, { ownerRequestOpen: true })).toBe('')
    const actions = friendMessageActionsHtml(local, sender, t, { ownerRequestOpen: false })
    expect(actions).toContain('data-friend-compose-action="reply"')
    expect(actions).toContain('data-friend-compose-action="handoff"')
    // A handoff carries the friend's text, which becomes the local prompt.
    expect(actions).toContain('data-friend-text="check the pool"')
  })
  test('a task that ended without a reply offers a Klaus reply until one is delivered', () => {
    const local = external('fixed status', { friendStatus: 'unreplied', statusDetail: 'fixed status', friendTaskId: 'task-9' })
    const tr = (key: string) => key === 'chat_friend_status_unreplied' ? 'Klaus 没有给出回复，已告知 {name} 处理已结束'
      : key === 'chat_friend_request_reply_action' ? '让 Klaus 回复 {name}' : t(key)
    expect(friendStatusDisplay(local)?.status).toBe('unreplied')
    const open = renderFriendCardHtml(local, { friendshipId: 'friend-1', displayName: 'Nick' }, tr, undefined, '', { tasks: [{ id: 'task-9', replied: false }] } as any)
    expect(open).toContain('Klaus 没有给出回复，已告知 Nick 处理已结束')
    expect(open).toContain('data-friend-request-reply="task-9"')
    expect(open).toContain('让 Klaus 回复 Nick')
    // Restating the status to a new local turn is not a useful follow-up here.
    expect(open).not.toContain('data-friend-compose-action')
    const replied = renderFriendCardHtml(local, { friendshipId: 'friend-1', displayName: 'Nick' }, tr, undefined, '', { tasks: [{ id: 'task-9', replied: true }] } as any)
    expect(replied).toContain('Klaus 没有给出回复')
    expect(replied).not.toContain('data-friend-request-reply')
  })
  test('the requester sees a friend that ended without a result, and a relocated chat explains itself', () => {
    const tr = (key: string) => ({ chat_friend_status_ended: '{name} 的 Klaus 已结束处理，没有附上结果', chat_friend_status_moved: '原来的对话已删除，{name} 的后续消息显示在这里' } as Record<string, string>)[key] || t(key)
    const ended = renderFriendCardHtml(external('ended', { friendStatus: 'ended', messageId: 'e1' }), { friendshipId: 'friend-1', displayName: 'Mei' }, tr)
    expect(ended).toContain('Mei 的 Klaus 已结束处理，没有附上结果')
    expect(ended).toContain('data-friend-compose-action="handoff"')
    const moved = renderFriendCardHtml(external('moved', { friendStatus: 'moved' }), { friendshipId: 'friend-1', displayName: 'Mei' }, tr)
    expect(moved).toContain('原来的对话已删除，Mei 的后续消息显示在这里')
    expect(moved).not.toContain('<button')
  })
  test('request links select the latest matching user row before the request', () => {
    const refs = [{ kind: 'friend', id: 'f' }]
    const messages = [
      { role: 'user', uuid: 'old', timestamp: 100, localRender: { composerReferences: refs } },
      { role: 'user', uuid: 'target', timestamp: 200, localRender: { composerReferences: refs } },
      { role: 'user', uuid: 'future', timestamp: 400, localRender: { composerReferences: refs } },
    ]
    expect(friendRequestTarget(messages, { sender: { friendshipId: 'f' }, requestCreatedAt: 300 })).toBe('target')
    expect(friendRequestTarget(messages, { sender: { friendshipId: 'other' }, requestCreatedAt: 300 })).toBeUndefined()
  })
})

test('outgoing status belongs to the same friend, chat, and nearest send', () => {
  const row: FriendOutgoingSummary = { requestId: 'r', friendId: 'f', friendDisplayName: 'Lin', friendAvatarUrl: null, sourceThreadId: 's', prompt: 'hello', createdAt: 1000, updatedAt: 2000, status: 'replied' }
  const rows = [row, { ...row, requestId: 'later', createdAt: 90_000, status: 'delivered' as const }, { ...row, requestId: 'other', sourceThreadId: 'other' }]
  expect(friendOutgoingForMessage(rows, 's', ['f'], 1000)).toEqual([row])
  expect(friendOutgoingForMessage(rows, 's', ['f'], 600_000)).toEqual([])
  expect(friendOutgoingForMessage(rows, 's', ['unknown'], 1000)).toEqual([])
})

test('stable request and dispatch identities never borrow a nearby send status', () => {
  const first: FriendOutgoingSummary = { requestId: 'old', dispatchId: 'dispatch-old', friendId: 'f', friendDisplayName: 'Lin', friendAvatarUrl: null, sourceThreadId: 's', prompt: 'hello', createdAt: 1000, updatedAt: 2000, status: 'failed' }
  const next: FriendOutgoingSummary = { ...first, requestId: 'new', dispatchId: 'dispatch-new', createdAt: 1001, status: 'delivered' }
  expect(friendOutgoingForMessage([first, next], 's', ['f'], 1001, { requestId: 'old' })).toEqual([first])
  expect(friendOutgoingForMessage([first, next], 's', ['f'], 900_000, { dispatchId: 'dispatch-old' })).toEqual([first])
  expect(friendOutgoingForMessage([first, next], 's', ['f'], 1001, { dispatchId: 'not-loaded' })).toEqual([])
})

test('outgoing controls use host eligibility and preserve the original request id', () => {
  const row: FriendOutgoingSummary = { requestId: 'original-request', friendId: 'f', friendDisplayName: 'Lin', friendAvatarUrl: null, sourceThreadId: 's', prompt: 'hello', createdAt: 1, updatedAt: 1, status: 'sent', canCancel: true }
  expect(renderFriendOutgoingStatusHtml(row, 'Lin', t)).toContain('data-friend-outgoing-action="cancel" data-friend-request-id="original-request"')
  expect(renderFriendOutgoingStatusHtml(row, 'Lin', t)).not.toContain('data-friend-outgoing-action="retry"')
  const retry = renderFriendOutgoingStatusHtml({ ...row, status: 'failed', canCancel: false, canRetry: true }, 'Lin', t, true)
  expect(retry).toContain('data-friend-outgoing-action="retry" data-friend-request-id="original-request" disabled')
  expect(retry).toContain('chat_friend_delivery_send_failed')
})

test('superseded request ids hide the parked row once the task-delivery row arrives', () => {
  const request = { externalFriendMessage: true, friendIntent: 'request', requestId: 'r1' }
  const delivery = { externalFriendMessage: true, requestId: 'r1' }
  expect(supersededFriendRequestIds([request])).toEqual(new Set())
  expect(supersededFriendRequestIds([request, delivery])).toEqual(new Set(['r1']))
  expect(supersededFriendRequestIds([delivery, request])).toEqual(new Set())
  expect(supersededFriendRequestIds([{ externalFriendMessage: true, friendIntent: 'request', requestId: 'r2' }, delivery])).toEqual(new Set())
})

test('follow-up projection attaches only assistant text in the friend delivery turn', () => {
  const units = [
    { type: 'user', turnId: 'one', msg: { localRender: external('reply', { replyToRequestId: 'r' }) } },
    { type: 'thinking', turnId: 'one' }, { type: 'text', turnId: 'one' },
    { type: 'user', turnId: 'two', msg: { text: 'next question' } }, { type: 'text', turnId: 'two' },
  ]
  const projected = attachFriendFollowUps(units)
  expect(projected[2].friendFollowUp).toBe(true)
  expect(projected[4].friendFollowUp).toBeUndefined()
  expect(units[2]).not.toHaveProperty('friendFollowUp')
  expect(attachFriendFollowUps([{ type: 'user', turnId: 'one', msg: { localRender: external('status', { replyToRequestId: 'r', friendStatus: 'failed' }) } }, { type: 'text', turnId: 'one' }])[1].friendFollowUp).toBeUndefined()
  expect(attachFriendFollowUps([{ type: 'user', turnId: 'one', msg: { localRender: external('incoming task') } }, { type: 'text', turnId: 'one' }])[1].friendFollowUp).toBeUndefined()
  expect(attachFriendFollowUps([{ type: 'user', turnId: 'one', msg: { text: 'owner request' } }, { type: 'user', turnId: 'one', msg: { localRender: external('midturn reply', { replyToRequestId: 'r' }) } }, { type: 'text', turnId: 'one' }])[2].friendFollowUp).toBeUndefined()
  expect(attachFriendFollowUps([{ type: 'live-user', turnId: 'live', msg: { localRender: external('reply', { replyToRequestId: 'r' }) } }, { type: 'live-text', turnId: 'live' }])[1].friendFollowUp).toBe(true)
})
