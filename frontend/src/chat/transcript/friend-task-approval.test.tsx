import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'

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

const { friendApprovalGrant, pendingFriendTaskForSession, refreshFriendInbox, settledFriendTaskForSession } = await import('../friend-inbox')
const { FriendOwnerChatRequest, FriendTaskApproval } = await import('./friend-task-approval')

describe('the friend approval card lives inside the conversation', () => {
  test('a pending request renders the three decisions', async () => {
    await refreshFriendInbox()
    expect(pendingFriendTaskForSession('thread-a')?.id).toBe('task-a')
    expect(pendingFriendTaskForSession('thread-b')).toBeNull()
    const markup = renderToStaticMarkup(<FriendTaskApproval sessionId="thread-a" />)
    expect(markup).toContain('Nick 请求你的 Klaus 处理')
    // The request itself is an ordinary transcript row now; the card carries
    // only the decision, so the prompt must not appear twice.
    expect(markup).not.toContain('check the connection pool logs')
    expect(markup).toContain(I18N.zh.friend_approval_allow)
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
  test('the approval grant follows the saved template and never remembers edits', async () => {
    const grant = friendApprovalGrant(pendingFriendTaskForSession('thread-a')!)
    expect(grant?.directories).toEqual([{ path: '/notes', access: 'read' }])
    expect(grant?.remember).toBe(false)
    expect(grant?.deviceId).toBe('desktop-a')
  })
  test('a request in an ordinary conversation offers handoff, a written reply or a decline, never the task approval', async () => {
    await refreshFriendInbox()
    const markup = renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-c" friendId="friend-a" friendName="Nick" messageId="req-c" />)
    // The same card anatomy as the task approval: title, where it lives, what happens next, then the choices.
    expect(markup).toContain(I18N.zh.chat_friend_owner_request.replace('{name}', 'Nick'))
    expect(markup).toContain(I18N.zh.chat_friend_owner_request_location)
    expect(markup).toContain(I18N.zh.chat_friend_owner_request_hint.replace('{name}', 'Nick'))
    expect(markup).toMatch(/class="kls-btn kls-btn-primary" data-friend-owner-action="handoff"[^>]*>交给我的 Klaus</)
    expect(markup).toMatch(/class="kls-btn kls-btn-secondary" data-friend-compose-action="answer"[^>]*data-friend-request-id="req-c"[^>]*>亲自回复</)
    expect(markup).toMatch(/class="kls-btn kls-btn-secondary" data-friend-owner-action="decline"[^>]*>拒绝</)
    expect(markup).not.toContain(I18N.zh.friend_approval_allow)
    // A friend-task request is not an owner-chat request.
    expect(renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-a" friendId="friend-a" friendName="Nick" messageId="req-a" />)).toBe('')
  })
  test('a request already handed to Klaus says so and can be handed over again', async () => {
    const markup = renderToStaticMarkup(<FriendOwnerChatRequest requestId="req-f" friendId="friend-a" friendName="Nick" messageId="req-f" />)
    expect(markup).toContain(I18N.zh.chat_friend_owner_request_hint_handed_off.replace(/\{name\}/g, 'Nick'))
    expect(markup).toContain(I18N.zh.chat_friend_owner_request_handoff_again)
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
