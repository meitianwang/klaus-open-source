import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'

const approvedGrant = { deviceId: 'desktop-a', mode: 'manual' as const, computerUse: false, apps: [], directories: [], remember: false, network: false }

// The approval card reads the shared friend inbox, so the fixture feeds the
// runtime snapshot through the bridge the card subscribes to.
const snapshot = {
  signedIn: true,
  currentDeviceId: 'desktop-a',
  error: '',
  tasks: [
    { id: 'task-a', friendId: 'friend-a', requestId: 'req-a', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-a', receiverDeviceId: 'desktop-a', threadId: 'thread-a', status: 'pending', prompt: 'check the connection pool logs', createdAt: 5, updatedAt: 5 },
    { id: 'task-b', friendId: 'friend-b', requestId: 'req-b', senderUserId: 'user-b', senderDisplayName: 'Bob', senderAvatarUrl: null, sourceThreadId: 'src-b', receiverDeviceId: 'desktop-a', threadId: 'thread-b', status: 'rejected', prompt: 'an earlier request', createdAt: 1, updatedAt: 9 },
    { id: 'task-c', friendId: 'friend-a', requestId: 'req-c', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-c', receiverDeviceId: 'desktop-a', threadId: null, ownerChatThreadId: 'owner-chat', status: 'pending', prompt: 'look at the deploy', createdAt: 6, updatedAt: 6 },
    { id: 'task-d', friendId: 'friend-a', requestId: 'req-d', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-c', receiverDeviceId: 'desktop-a', threadId: 'owner-chat', ownerChatThreadId: 'owner-chat', status: 'completed', replied: true, prompt: 'an answered request', createdAt: 2, updatedAt: 3 },
    { id: 'task-e', friendId: 'friend-a', requestId: 'req-e', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-c', receiverDeviceId: 'desktop-a', threadId: 'owner-chat', ownerChatThreadId: 'owner-chat', status: 'completed', replied: true, replyError: 'offline', prompt: 'a reply still in flight', createdAt: 2, updatedAt: 4 },
    { id: 'task-f', friendId: 'friend-a', requestId: 'req-f', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-c', receiverDeviceId: 'desktop-a', threadId: null, ownerChatThreadId: 'owner-chat', status: 'pending', ownerHandoffAt: 7, prompt: 'handed to Klaus already', createdAt: 6, updatedAt: 7 },
    { id: 'task-g', friendId: 'friend-c', requestId: 'req-g', senderUserId: 'user-c', senderDisplayName: 'Cy', senderAvatarUrl: null, sourceThreadId: 'src-g', receiverDeviceId: 'desktop-a', threadId: 'thread-b', status: 'rejected', prompt: 'a later declined request', createdAt: 8, updatedAt: 10 },
    { id: 'task-h', friendId: 'friend-a', requestId: 'req-h', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-h', receiverDeviceId: 'desktop-a', threadId: 'thread-multi', status: 'pending', prompt: 'later pending request', createdAt: 12, updatedAt: 12 },
    { id: 'task-i', friendId: 'friend-a', requestId: 'req-i', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-i', receiverDeviceId: 'desktop-a', threadId: 'thread-multi', status: 'pending', prompt: 'earlier pending request', createdAt: 11, updatedAt: 11 },
    { id: 'task-j', friendId: 'friend-a', requestId: 'req-j', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-j', receiverDeviceId: 'desktop-a', threadId: 'thread-admitted', status: 'completed', replied: true, grant: approvedGrant, prompt: 'already admitted', createdAt: 10, updatedAt: 13 },
    { id: 'task-k', friendId: 'friend-a', requestId: 'req-k', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-k', receiverDeviceId: 'desktop-a', threadId: 'thread-admitted', status: 'pending', prompt: 'later request in admitted conversation', createdAt: 14, updatedAt: 14 },
    { id: 'task-l', friendId: 'friend-a', requestId: 'req-l', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-l', receiverDeviceId: 'desktop-a', threadId: 'thread-failed-unapproved', status: 'failed', prompt: 'automatic setup failed before approval', createdAt: 15, updatedAt: 15 },
    { id: 'task-m', friendId: 'friend-a', requestId: 'req-m', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-m', receiverDeviceId: 'desktop-a', threadId: 'thread-failed-unapproved', status: 'pending', prompt: 'new request after failed setup', createdAt: 16, updatedAt: 16 },
    { id: 'task-n', friendId: 'friend-a', requestId: 'req-n', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-n', receiverDeviceId: 'desktop-a', threadId: 'thread-failed-approved', status: 'failed', grant: approvedGrant, prompt: 'approved task failed', createdAt: 17, updatedAt: 17 },
    { id: 'task-o', friendId: 'friend-a', requestId: 'req-o', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-o', receiverDeviceId: 'desktop-a', threadId: 'thread-failed-approved', status: 'pending', prompt: 'later request after approved failure', createdAt: 18, updatedAt: 18 },
    { id: 'task-p', friendId: 'friend-a', requestId: 'req-p', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-p', receiverDeviceId: 'desktop-a', threadId: 'thread-cancelled-approved', status: 'cancelled', grant: approvedGrant, prompt: 'approved task was cancelled', createdAt: 19, updatedAt: 19 },
    { id: 'task-q', friendId: 'friend-a', requestId: 'req-q', senderUserId: 'user-a', senderDisplayName: 'Nick', senderAvatarUrl: null, sourceThreadId: 'src-q', receiverDeviceId: 'desktop-a', threadId: 'thread-cancelled-approved', status: 'pending', prompt: 'later request after approved cancellation', createdAt: 20, updatedAt: 20 },
  ],
  templates: [{ id: 'tpl-a', friendId: 'friend-a', deviceId: 'desktop-a', grant: { deviceId: 'desktop-a', mode: 'manual', policy: 'approve', computerUse: false, apps: [], directories: [{ path: '/notes', access: 'read' }], remember: true, network: false } }],
  defaultGrant: { deviceId: 'desktop-a', mode: 'manual', policy: 'approve', computerUse: false, apps: [], directories: [], remember: false, network: false },
  outgoing: [],
} as unknown

;(globalThis as any).window = {
  currentLang: 'zh',
  tt: (key: string) => (I18N.zh as Record<string, string>)[key] ?? key,
  addEventListener: () => {},
  removeEventListener: () => {},
  klaus: { friends: { runtime: async () => snapshot }, on: { friendsChanged: () => () => {} } },
}

const { friendApprovalGrant, friendConversationAdmitted, pendingFriendTaskByRequest, pendingFriendTaskForSession, refreshFriendInbox, settledFriendTaskForSession } = await import('../friend-inbox')
const { FriendOwnerChatRequest, FriendTaskApproval } = await import('./friend-task-approval')

describe('the friend approval card lives inside the conversation', () => {
  test('a pending request renders the three decisions', async () => {
    await refreshFriendInbox()
    expect(pendingFriendTaskForSession('thread-a')?.id).toBe('task-a')
    expect(pendingFriendTaskForSession('thread-b')).toBeNull()
    const markup = renderToStaticMarkup(<FriendTaskApproval sessionId="thread-a" />)
    expect(markup).toContain('Nick 请求在这个新会话中处理')
    // The request itself is an ordinary transcript row now; the card carries
    // only the decision, so the prompt must not appear twice.
    expect(markup).not.toContain('check the connection pool logs')
    expect(markup).toContain('允许此会话')
    expect(markup).toContain(I18N.zh.friend_approval_reject)
    expect(markup).toContain(I18N.zh.friend_approval_scope)
    // The card names where the task would run, matching the message it sits under.
    expect(markup).toContain(I18N.zh.friend_approval_location.replace('{value}', I18N.zh.friend_approval_location_chat))
  })
  test('a request selects its own decision card and yields to the inline one', async () => {
    await refreshFriendInbox()
    const own = renderToStaticMarkup(<FriendTaskApproval sessionId="thread-a" requestId="req-a" />)
    expect(own).toContain(I18N.zh.friend_approval_allow)
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-a" requestId="req-missing" />)).toBe('')
    // The conversation-end card must not repeat a decision rendered beside its message.
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-a" skipPending={new Set(['req-a'])} />)).toBe('')
  })
  test('an unadmitted conversation shows only its earliest pending request', async () => {
    await refreshFriendInbox()
    expect(pendingFriendTaskForSession('thread-multi')?.id).toBe('task-i')
    expect(pendingFriendTaskByRequest('thread-multi', 'req-i')?.id).toBe('task-i')
    expect(pendingFriendTaskByRequest('thread-multi', 'req-h')).toBeNull()
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-multi" requestId="req-i" />)).toContain('允许此会话')
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-multi" requestId="req-h" />)).toBe('')
  })
  test('a completed task admits the conversation and later requests do not ask again', async () => {
    await refreshFriendInbox()
    expect(friendConversationAdmitted('thread-admitted')).toBe(true)
    expect(pendingFriendTaskForSession('thread-admitted')).toBeNull()
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-admitted" />)).toBe('')
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-admitted" requestId="req-k" />)).toBe('')
  })
  test('a failed task without a grant does not admit the conversation', async () => {
    await refreshFriendInbox()
    expect(friendConversationAdmitted('thread-failed-unapproved')).toBe(false)
    expect(pendingFriendTaskForSession('thread-failed-unapproved')?.id).toBe('task-m')
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-failed-unapproved" />)).toContain('允许此会话')
  })
  test('a failed or cancelled task carrying an approved grant stays admitted', async () => {
    await refreshFriendInbox()
    expect(friendConversationAdmitted('thread-failed-approved')).toBe(true)
    expect(friendConversationAdmitted('thread-cancelled-approved')).toBe(true)
    expect(pendingFriendTaskForSession('thread-failed-approved')).toBeNull()
    expect(pendingFriendTaskForSession('thread-cancelled-approved')).toBeNull()
  })
  test('the approval grant follows the saved template and never remembers edits', async () => {
    const grant = friendApprovalGrant(pendingFriendTaskForSession('thread-a')!)
    expect(grant?.directories).toEqual([{ path: '/notes', access: 'read' }])
    expect(grant?.remember).toBe(false)
    expect(grant?.deviceId).toBe('desktop-a')
  })
  test('a pending request in an ordinary conversation leaves a quiet status line and no task approval', async () => {
    await refreshFriendInbox()
    const markup = renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-c" friendId="friend-a" friendName="Nick" messageId="req-c" />)
    expect(markup).toContain(I18N.zh.chat_friend_owner_request_waiting)
    expect(markup).toContain('排队')
    expect(markup).not.toContain('等待你的回复')
    expect(markup).not.toContain('data-friend-owner-action')
    expect(markup).not.toContain('data-friend-compose-action')
    expect(markup).not.toContain(I18N.zh.friend_approval_allow)
    // A friend-task request is not an owner-chat request.
    expect(renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-a" friendId="friend-a" friendName="Nick" messageId="req-a" />)).toBe('')
  })
  test('a request already handed to Klaus leaves a quiet status line', async () => {
    const markup = renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-f" friendId="friend-a" friendName="Nick" messageId="req-f" />)
    expect(markup).toContain(I18N.zh.chat_friend_owner_request_handed_off)
    expect(markup).not.toContain('data-friend-owner-action')
  })
  test('an answered ordinary-conversation request leaves a status line under its message', async () => {
    expect(renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-d" friendId="friend-a" friendName="Nick" messageId="req-d" />))
      .toBe(`<div data-friend-settled="task-d"><span>${I18N.zh.chat_friend_owner_request_replied.replace('{name}', 'Nick')}</span></div>`)
    expect(renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-e" friendId="friend-a" friendName="Nick" messageId="req-e" />))
      .toContain(I18N.zh.chat_friend_owner_request_reply_pending.replace('{name}', 'Nick'))
  })
  test('a decided request leaves a quiet status line and an unrelated session renders nothing', async () => {
    expect(settledFriendTaskForSession('thread-b')?.id).toBe('task-g')
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-b" />)).toContain(I18N.zh.friend_approval_rejected)
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-c" />)).toBe('')
  })
  test('a declined request shows its status once, under its own message', async () => {
    // The inline line belongs to that request, not to whichever request was decided last.
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-b" requestId="req-b" />)).toBe('<div data-friend-settled="task-b"><span>你已拒绝本次请求。</span></div>')
    // The conversation-end line skips every request already shown inline.
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-b" skipPending={new Set(['req-b', 'req-g'])} />)).toBe('')
    expect(renderToStaticMarkup(<FriendTaskApproval sessionId="thread-b" skipPending={new Set(['req-g'])} />)).toContain('data-friend-settled="task-b"')
  })
})
