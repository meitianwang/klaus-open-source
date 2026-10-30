import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { FRIEND_MESSAGE_COLLAPSE_MIN_CHARS, FRIEND_MESSAGE_COLLAPSE_MIN_LINES, summarizeFriendMessage } from './friend-message-summary'

// The factory layer reads the UI language off `window` at call time, and some
// transitively imported module touches it at load time — so the shim is set in
// beforeAll (never at collection time, which pollutes sibling test files) and
// the factory is imported dynamically after the shim exists.
let renderFriendCollapsedHtml: (typeof import('./chat/transcript/factories'))['renderFriendCollapsedHtml']
let savedWindow: unknown
beforeAll(async () => {
  savedWindow = (globalThis as any).window
  ;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en' }
  ;({ renderFriendCollapsedHtml } = await import('./chat/transcript/factories'))
})
afterAll(() => {
  if (savedWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = savedWindow
})

const longMessage = [
  'Klaus，上次任务在接收端引擎中断了，我精简后重发一次。下面是 feat/chat-input-drafts-history 的完整源码 diff。只读：别改文件、别提交推送。',
  '',
  '按 P0/P1/P2 审这六点，每条给 文件:行号 + 触发/复现 + 为何是问题 + 建议改法：',
  '1 键盘优先级：命令菜单/历史/IME/修饰键判定顺序有无吞键或漏判。',
  '2 翻阅游标失效/复活：navigation 派生值用 entries[index]!==value 判存活。',
  '3 withoutTextAttachments 解析安全：JSON.parse 对超大附件正文的性能/异常。',
  '4 去重(Set)与100上限边界(第101条)会否越界或丢最新。',
  '5 草稿归属竞态：setInputDraft 的 conversationId 默认值 activeId 闭包捕获时机。',
  '6 attachments.ts 是否真保持 attachmentPrompt 输出逐字节不变。',
  '',
  '输出：一句话结论+分级问题清单+你实际读过哪些文件。',
  '',
  '===== 源码 diff 开始 =====',
  'diff --git a/apps/web/src/app/conversation-context.tsx b/apps/web/src/app/conversation-context.tsx',
  'index 36771b7..92aa20f 100644',
  '--- a/apps/web/src/app/conversation-context.tsx',
  '+++ b/apps/web/src/app/conversation-context.tsx',
  '@@ -10,6 +10,7 @@ import {',
  '   type SetStateAction,',
  ' } from "react";',
  '+import { flushDraftFor, moveDraft } from "../state/drafts";',
].join('\n')

describe('summarizeFriendMessage', () => {
  test('short messages stay uncollapsed', () => {
    const summary = summarizeFriendMessage('帮我看下这个报错')
    expect(summary.collapsed).toBe(false)
    expect(summary.lead).toBe('帮我看下这个报错')
  })
  test('line count alone trips the threshold', () => {
    const lines = Array.from({ length: FRIEND_MESSAGE_COLLAPSE_MIN_LINES + 1 }, (_, index) => `line ${index}`)
    expect(summarizeFriendMessage(lines.join('\n')).collapsed).toBe(true)
  })
  test('character count alone trips the threshold', () => {
    const one = 'a'.repeat(FRIEND_MESSAGE_COLLAPSE_MIN_CHARS + 1)
    expect(summarizeFriendMessage(one).collapsed).toBe(true)
  })
  test('lead is the first meaningful line, trimmed', () => {
    const summary = summarizeFriendMessage(longMessage)
    expect(summary.lead.startsWith('Klaus，上次任务在接收端引擎中断了')).toBe(true)
    expect(summary.lead.length).toBeLessThanOrEqual(161)
  })
  test('numbered and bulleted lines become asks', () => {
    const summary = summarizeFriendMessage(longMessage)
    expect(summary.asks.length).toBeGreaterThan(0)
    expect(summary.asks[0]).toContain('键盘优先级')
    expect(summary.asks.length).toBeLessThanOrEqual(4)
  })
  test('diff headers become file chips', () => {
    const summary = summarizeFriendMessage(longMessage)
    expect(summary.files).toContain('apps/web/src/app/conversation-context.tsx')
  })
  test('diff markers are detected', () => {
    expect(summarizeFriendMessage(longMessage).hasDiff).toBe(true)
    expect(summarizeFriendMessage('just prose\nno diff here').hasDiff).toBe(false)
  })
})

describe('renderFriendCollapsedHtml', () => {
  test('short display text renders no shell', () => {
    expect(renderFriendCollapsedHtml('short note')).toBeNull()
  })
  test('long display text renders lead, meta and both entry buttons', () => {
    const html = renderFriendCollapsedHtml(longMessage)
    expect(html).not.toBeNull()
    expect(html).toContain('friend-msg-collapsed')
    expect(html).toContain('data-friend-msg-action="expand"')
    expect(html).toContain('data-friend-msg-action="reader"')
    // The full text is present but hidden, so expand and the reader can read it back.
    expect(html).toContain('class="md friend-msg-full" hidden')
    expect(html).toContain('diff --git')
  })
  test('the shell escapes markup in the source text', () => {
    const html = renderFriendCollapsedHtml(`${'x'.repeat(900)}\n<img src=x onerror=alert(1)>`)!
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })
})
