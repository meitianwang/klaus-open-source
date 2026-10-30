// A friend message approval names the communication action and recipient; it
// never presents the engine's raw tool name or a generic sandbox permission.
import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'
import { updateFriendsRuntime } from '../../pages/friends/runtime-state'

;(globalThis as any).window = {
  currentLang: 'zh',
  tt: (key: string) => (I18N.zh as Record<string, string>)[key] ?? key,
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { PermissionCard } = await import('./approval-cards')

function render(toolName: string, toolInput: Record<string, unknown> = { prompt: '早上好，今天也很顺利。' }, lang: 'zh' | 'en' = 'zh') {
  ;(window as any).currentLang = lang
  ;(window as any).tt = (key: string) => (I18N[lang] as Record<string, string>)[key] ?? key
  return renderToStaticMarkup(<PermissionCard req={{ requestId: 'approval-1', toolName, toolInput, message: 'Allow this task operation?' }}
    startedAt={Date.now()} resolved={null} sessionId="chat-1" />)
}

afterEach(() => updateFriendsRuntime(null))

describe('friend message approval', () => {
  test('a task reply uses the friend card and resolves the requester from the task', () => {
    updateFriendsRuntime({ tasks: [{ threadId: 'chat-1', friendId: 'friend-a', senderDisplayName: 'Klaus' }] } as any)
    const html = render('reply_to_friend')
    expect(html).toContain(I18N.zh.friend_message_approval_reply.replace('{name}', 'Klaus'))
    expect(html).toContain(I18N.zh.friend_message_approval_recipient.replace('{name}', 'Klaus'))
    expect(html).toContain(I18N.zh.friend_message_approval_hint)
    expect(html).toContain(I18N.zh.friend_message_approval_allow_reply)
    expect(html).toContain(I18N.zh.friend_message_approval_view)
    expect(html).not.toContain('Allow this task operation?')
    expect(html).not.toContain(I18N.zh.permission_chip)
  })

  test('progress and clarification actions have their own localized labels', () => {
    expect(render('send_friend_progress')).toContain(I18N.zh.friend_message_approval_allow_progress)
    const question = render('ask_friend_for_information', { friendId: 'friend-a', question: 'Which directory should I use?' })
    expect(question).toContain(I18N.zh.friend_message_approval_allow_question)
    expect(question).toContain(I18N.zh.friend_message_approval_question.replace('{name}', 'friend-a'))
  })

  test('English cards do not leak the generic permission message or raw tool name', () => {
    const html = render('reply_to_friend', { friendId: 'friend-a', friendName: 'Alice', prompt: 'Done.' }, 'en')
    expect(html).toContain(I18N.en.friend_message_approval_reply.replace('{name}', 'Alice'))
    expect(html).toContain(I18N.en.friend_message_approval_allow_reply)
    expect(html).not.toContain('Allow this task operation?')
    expect(html).not.toContain('permission-chip-tool')
  })
})
