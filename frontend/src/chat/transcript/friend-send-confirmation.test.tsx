// A message Klaus wrote for a friend waits for the owner: the card names who
// receives it, what kind of message it is and the exact text, and resolves
// into a short sent / not-sent result.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'

;(globalThis as any).window = {
  currentLang: 'zh',
  tt: (key: string) => (I18N.zh as Record<string, string>)[key] ?? key,
  addEventListener: () => {},
  removeEventListener: () => {},
}

const { PermissionCard } = await import('./approval-cards')

const request = (input: Record<string, unknown>) => ({ requestId: 'confirm-1', sessionId: 'chat-1', toolName: 'friend_send_confirmation',
  toolInput: { friendId: 'friend-b', friendName: 'B', intent: 'request', onReply: 'follow_up', prompt: 'Can you upgrade the shop runner to <Node 20>?', ...input } })
const render = (input: Record<string, unknown>, resolved: null | { decision: string } = null) => {
  // Other suites in the same run replace the shared window; pin the language per render.
  ;(window as any).currentLang = 'zh'
  return renderToStaticMarkup(<PermissionCard req={request(input)} startedAt={Date.now()} resolved={resolved as any} sessionId="chat-1" />)
}

describe('friend send confirmation', () => {
  test('a request shows recipient, type, follow-up and the exact text before anything is sent', () => {
    const html = render({})
    expect(html).toContain('data-tool-name="friend_send_confirmation"')
    expect(html).toContain(I18N.zh.friend_confirm_chip_request.replace('{name}', 'B'))
    expect(html).toContain(I18N.zh.friend_confirm_type_request)
    expect(html).toContain(I18N.zh.friend_confirm_follow_up)
    expect(html).toContain('Can you upgrade the shop runner to &lt;Node 20&gt;?')
    expect(html).not.toContain('<Node 20>')
    for (const label of [I18N.zh.friend_confirm_decline, I18N.zh.friend_confirm_edit, I18N.zh.friend_confirm_send]) expect(html).toContain(label)
    expect(html).toContain(I18N.zh.friend_confirm_hint)
  })

  test('a notice says it will not start their Klaus and has no reply arrangement', () => {
    const html = render({ intent: 'notice', onReply: undefined, prompt: 'Release moved to Monday.' })
    expect(html).toContain(I18N.zh.friend_confirm_chip_notice.replace('{name}', 'B'))
    expect(html).toContain(I18N.zh.friend_confirm_type_notice)
    expect(html).not.toContain(I18N.zh.friend_confirm_after_reply)
  })

  test('a confirmation required by a friend task omits the settings hint', () => {
    expect(render({ reason: 'task' })).not.toContain(I18N.zh.friend_confirm_hint)
  })

  test('a decided card keeps the text and states the outcome without controls', () => {
    const sent = render({}, { decision: 'allow' })
    expect(sent).toContain(I18N.zh.friend_confirm_sent)
    expect(sent).toContain('Can you upgrade the shop runner')
    expect(sent).not.toContain(I18N.zh.friend_confirm_edit)
    const declined = render({}, { decision: 'deny' })
    expect(declined).toContain(I18N.zh.friend_confirm_declined)
    expect(declined).not.toContain(I18N.zh.friend_confirm_send + '</button>')
  })
})
