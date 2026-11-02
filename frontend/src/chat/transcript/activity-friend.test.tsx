import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/tool-activity-events.json'
import { FriendActivityDetails, friendActivityResult } from './activity-friend'
import type { ActivityToolData } from './activity-tool-model'
import { updateFriendsRuntime } from '../../pages/friends/runtime-state'
import type { FriendsRuntimeSnapshot } from '../../../../shared/friends'

const originalWindow = (globalThis as any).window
beforeAll(() => { (globalThis as any).window = { ...originalWindow, addEventListener: originalWindow?.addEventListener ?? (() => {}), currentLang: 'en', getFriendDirectoryEntry: (id: string) => id === 'friend-a' ? { name: 'Reviewer' } : undefined } })
afterAll(() => { (globalThis as any).window = originalWindow; updateFriendsRuntime(null) })
const tool = (name: string, output: unknown, state: ActivityToolData['state'] = 'done'): ActivityToolData => ({
  toolCallId: 'friend-event', toolName: name, args: { friendId: 'friend-a', prompt: 'Review <script>alert(1)</script>\nSecond line' }, state,
  output: typeof output === 'string' ? output : JSON.stringify(output),
})
const wrap = (value: unknown) => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] })
const render = (value: ActivityToolData, locale = 'zh') => renderToStaticMarkup(<FriendActivityDetails tool={value} locale={locale} />)

describe('friend activity results', () => {
  test('keeps both actions readable in a mixed activity summary', async () => {
    const { describeActivity, summarizeActivity } = await import('./activity-model')
    const { activitySummaryLabel } = await import('./TranscriptView')
    const { I18N } = await import('../../i18n')
    const tools = [tool('list_friends', vectors.friendResults.directory), tool('send_message_to_friend', vectors.friendResults.receipt)]
    const summary = summarizeActivity(tools.map((value, i) => ({ key: String(i), value, grouping: 'tool' as const, action: describeActivity(value.toolName, value.args, value.state, value.output) })))
    ;(window as any).currentLang = 'zh'
    try {
      expect(activitySummaryLabel(key => I18N.zh[key] || key, { mode: 'summary', summary })).toBe('已查看好友列表 · 已向 Reviewer 发送请求')
    } finally { (window as any).currentLang = 'en' }
  })

  test('decodes both direct results and host envelopes', () => {
    for (const result of [vectors.friendResults.directory, wrap(vectors.friendResults.directory)]) {
      expect(friendActivityResult(JSON.stringify(result))).toMatchObject({ signedIn: true, friends: [
        { id: 'friend-a', remark: 'Reviewer', online: true, peerAllowsAgentTasks: true },
        { id: 'friend-b', displayName: 'Blair', online: false, peerAllowsAgentTasks: false },
      ] })
    }
    expect(friendActivityResult('unstructured output').friends).toBeUndefined()
  })

  test('lists names with online and incoming task acceptance states', () => {
    const html = render(tool('list_friends', wrap(vectors.friendResults.directory)))
    for (const label of ['Reviewer', 'Blair', '在线', '离线', '允许接收任务', '未允许接收任务']) expect(html).toContain(label)
    expect(html).not.toContain('Alex')
    expect(html).not.toContain('friend-a')
  })

  test('distinguishes signed-out, empty, and failed directory reads', () => {
    expect(render(tool('list_friends', vectors.friendResults.empty))).toContain('暂无好友')
    expect(render(tool('list_friends', vectors.friendResults.signedOut))).toContain('登录后可查看好友')
    const failed = render(tool('list_friends', vectors.friendResults.empty, 'error'))
    expect(failed).not.toContain('暂无好友')
    expect(render(tool('list_friends', vectors.friendResults.empty), 'en')).toContain('No friends yet')
  })

  test('shows the recipient and inert message text with the actual delivery receipt', () => {
    const html = render(tool('functions.send_message_to_friend', wrap(vectors.friendResults.receipt)))
    for (const label of ['Reviewer', '&lt;script&gt;', 'Second line', '已送达，等待对方批准']) expect(html).toContain(label)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('任务完成')
    const en = render(tool('send_message_to_friend', vectors.friendResults.receipt), 'en')
    expect(en).toContain('Delivered, waiting for their approval')
  })

  test('only confirmed completed calls show delivery and authorization', () => {
    for (const state of ['error', 'interrupted', 'awaiting-approval'] as const) {
      expect(render(tool('send_message_to_friend', vectors.friendResults.receipt, state))).not.toContain('data-friend-status')
    }
    const running = render(tool('send_message_to_friend', vectors.friendResults.receipt, 'running'))
    expect(running).toContain('正在发送…')
    expect(running).not.toContain('data-friend-status="sent"')
    const html = render(tool('send_message_to_friend', { delivered: true, awaitingAuthorization: false }))
    expect(html).toContain('data-friend-status="sent"')
    expect(html).toContain('已送达')
    expect(html).not.toContain('等待对方批准')
    expect(html).not.toContain('已开始')
  })

  test('a durable receipt is sent without claiming device delivery', () => {
    const html = render({ ...tool('send_message_to_friend', { accepted: true, delivered: false }), args: { friendId: 'friend-a', prompt: 'A request', intent: 'request', onReply: 'follow_up' } })
    expect(html).toContain('已发送，尚未送达')
    expect(html).toContain('收到回复后继续原任务')
    expect(html).not.toContain('已送达')
    expect(html).not.toContain('等待好友')
  })

  test('shows display-only arrangement and reads later progress by exact request identity', () => {
    const value = { ...tool('send_message_to_friend', { accepted: true, delivered: false, requestId: 'request-one' }), args: { friendId: 'friend-a', intent: 'request', onReply: 'display', prompt: 'Check A' } }
    updateFriendsRuntime({ outgoing: [
      { requestId: 'unrelated', friendId: 'friend-a', status: 'replied' },
      { requestId: 'request-one', friendId: 'friend-a', status: 'processing', canCancel: true },
    ] } as FriendsRuntimeSnapshot)
    try {
      const html = render(value)
      expect(html).toContain('好友答复只展示')
      expect(html).toContain('对方处理中')
      expect(html).toContain('取消请求')
      expect(html).not.toContain('尚未送达')
      expect(html).not.toContain('已回复')
      updateFriendsRuntime({ outgoing: [{ requestId: 'request-one', friendId: 'friend-a', status: 'failed', canRetry: true }] } as FriendsRuntimeSnapshot)
      const failed = render(value)
      expect(failed).toContain('发送失败')
      expect(failed).toContain('重试发送')
    } finally { updateFriendsRuntime(null) }
  })

  test('each friend send names its kind of message and its recipient', async () => {
    const { semanticActivity, semanticActivityLabel } = await import('./activity-semantic')
    const label = (name: string, args: unknown, output: unknown, locale = 'zh', state = 'done') =>
      semanticActivityLabel(semanticActivity(name, args, JSON.stringify(output))!, state, locale)
    // The reply, progress and question tools carry no friend argument; the host names the recipient in its result.
    const hostResult = { accepted: true, delivered: true, friendId: 'friend-b', friendName: 'Blair', prompt: 'Done' }
    expect(label('send_message_to_friend', { friendId: 'friend-a', intent: 'request' }, { accepted: true })).toBe('已向 Reviewer 发送请求')
    expect(label('send_message_to_friend', { friendId: 'friend-a', intent: 'notice' }, { accepted: true })).toBe('已通知 Reviewer')
    expect(label('reply_to_friend', { prompt: 'Done' }, hostResult)).toBe('已回复 Blair')
    expect(label('send_friend_progress', { prompt: 'Halfway' }, hostResult)).toBe('已向 Blair 发送进展')
    expect(label('ask_friend_for_information', { question: 'Which branch?' }, hostResult)).toBe('已向 Blair 提问')
    expect(label('reply_to_friend', { prompt: 'Done' }, hostResult, 'en')).toBe('Replied to Blair')
    // A notice the host turned into a pending request's result reads as a reply.
    expect(label('send_message_to_friend', { friendId: 'friend-a', intent: 'notice' }, { accepted: true, converted: true })).toBe('已回复 Reviewer')
    // An explicit friend argument wins over the result.
    expect(label('reply_to_friend', { friendId: 'friend-a', prompt: 'Done' }, hostResult)).toBe('已回复 Reviewer')
    // The owner declined the confirmation: nothing left this computer.
    expect(label('send_message_to_friend', { friendId: 'friend-a', intent: 'request' }, { accepted: false, declined: true, friendName: 'Reviewer' })).toBe('未发送给 Reviewer')
    expect(label('send_message_to_friend', { friendId: 'friend-a', intent: 'request' }, { accepted: false, declined: true }, 'en')).toBe('Not sent to Reviewer')
    // A running call keeps the generic wording until it settles.
    expect(label('reply_to_friend', { prompt: 'Done' }, {}, 'zh', 'running')).toBe('正在回复好友')
    expect(semanticActivity('reply_to_friend', {})?.category).toBe('friend')
  })

  test('reply, progress and question rows show what was sent and to whom', () => {
    const base = { accepted: true, delivered: true, friendId: 'friend-b', friendName: 'Blair' }
    const reply = render({ toolCallId: 'r', toolName: 'reply_to_friend', args: { prompt: 'Original draft' }, state: 'done', output: JSON.stringify({ ...base, prompt: 'Edited by the owner' }) })
    expect(reply).toContain('data-friend-result="send"')
    expect(reply).toContain('Blair')
    expect(reply).toContain('已送达，对方的请求已完成')
    // What the friend received is what the owner edited, not the model's draft.
    expect(reply).toContain('Edited by the owner')
    expect(reply).not.toContain('Original draft')
    const progress = render({ toolCallId: 'p', toolName: 'send_friend_progress', args: { prompt: 'Halfway there' }, state: 'done', output: JSON.stringify({ ...base, delivered: false }) })
    expect(progress).toContain('已发送，尚未送达，不会结束对方的请求')
    expect(progress).toContain('Halfway there')
    const question = render({ toolCallId: 'q', toolName: 'ask_friend_for_information', args: { question: 'Which branch?' }, state: 'done', output: JSON.stringify(base) })
    expect(question).toContain('已送达，对方补充后在这个对话继续')
    expect(question).toContain('Which branch?')
  })

  test('a declined confirmation says nothing was sent', () => {
    const html = render({ ...tool('send_message_to_friend', { accepted: false, declined: true, friendId: 'friend-a', friendName: 'Reviewer' }), args: { friendId: 'friend-a', intent: 'notice', prompt: 'Release moved' } })
    expect(html).toContain('你选择了不发送')
    expect(html).not.toContain('不会启动对方的 Klaus')
    expect(html).not.toContain('已送达')
    expect(html).not.toContain('尚未送达')
  })

  test('keeps actual failure text readable', () => {
    const html = render(tool('send_message_to_friend', { success: false, contentItems: [{ type: 'inputText', text: vectors.friendResults.failure }] }, 'error'))
    expect(html).toContain('Friend is offline.')
    expect(html).not.toContain('data-friend-status')
  })

  test('shows the failure reason without the model-facing error envelope', () => {
    const output = '<tool_use_error tool="reply_to_friend">\nPermissions changed while awaiting approval; retry this action under the current policy.\n</tool_use_error>'
    for (const value of [output, { success: false, contentItems: [{ type: 'inputText', text: output }] }]) {
      const html = render(tool('reply_to_friend', value, 'error'))
      expect(html).toContain('Permissions changed while awaiting approval; retry this action under the current policy.')
      expect(html).not.toContain('tool_use_error')
    }
  })
})
