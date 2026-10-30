// user 气泡的粘贴 chip 复原：只在输入框发出来的那一面猜，子 Agent 转录的 prompt
// 原文直接出。回归「子 Agent 的任务指令被收进一枚点不开的 PASTED chip，只剩最后
// 一段可读」。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { encodeSelectedTextEnvelope } from '../selected-text-envelope'
import { browserTabMentionUri, type BrowserTabMention } from '../../../../shared/browser-tab-mention'
import { browserTabReference } from '../composer/browser-tab-reference'
import imageVector from '../../../../contracts/vectors/ui-screenshot-delivery.json'
import documentVector from '../../../../contracts/vectors/composer-document-vectors.json'

import { composerDocumentFromText, composerDocumentSchema as documentSchema, composerTokenNode, serializeComposerDocument, snapshotComposerDocument } from '../composer/document-model'
// stream-store 在模块装载时挂调试口到 window；mock 后再动态导入。
;(globalThis as any).window = {
  addEventListener: () => {},
  renderSlashPillHtml: (name: string) => `<span class="slash-pill"><span class="slash-pill-label">${name}</span></span>`,
  renderComposerReferencePillHtml: (reference: { kind: string; name: string }) => `<span class="slash-pill is-${reference.kind}-reference"><span class="slash-pill-label">${reference.name}</span></span>`,
}
const { buildUserBubbleHtml, composerDraftFromDisplayMetadata } = await import('./TranscriptView')
const { externalMessageDisplay, externalMessageSender, renderExternalSenderAvatarHtml, renderMsgActionsHtml, userCopyText } = await import('./factories')
const DISPLAY_VECTOR = JSON.parse(readFileSync(fileURLToPath(new URL(
  '../../../../contracts/vectors/user-message-display-vectors.json',
  import.meta.url,
)), 'utf8'))

// 8 行起算大段粘贴（isLargePastedText）。两种形状都要覆盖：前文自身够大时末段
// 留在气泡外，前文不够大时整段进 chip、气泡为空。
const HEAD = [
  'In the repo /Users/me/workspace/klaus, investigate the fold logic.',
  'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8', 'line 9',
].join('\n')
const TAIL = 'Report concise findings with file:line references.'
const PROMPT = `${HEAD}\n\n${TAIL}`
const SHORT_HEAD_PROMPT = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', '', TAIL].join('\n')

const htmlOf = (text: string, composerAuthored: boolean) =>
  buildUserBubbleHtml({ text }, composerAuthored)?.html || ''

test('authored marker-like prose never becomes a generated reference or quote', () => {
  const literal = documentVector.literalMarkerText
  const text = `${literal} [Selected skill](klaus:skill/review) /manual @"src/file.ts"`
  const html = buildUserBubbleHtml({ text, localRender: { displayText: text,
    selectedTextAttachments: [{ text: 'KLAUS_USER_TOKEN__QUOTE_0_TOKEN', requestOffset: text.length }],
  } }, true)?.html || ''
  expect(html).toContain(literal)
  expect(html).toContain('Selected skill')
  expect(html).toContain('KLAUS_USER_TOKEN__QUOTE_0_TOKEN')
  expect(html).toContain('src/file.ts')
  expect(html.match(/is-quote is-inline/g)).toHaveLength(1)
})

describe('question-answer bubbles', () => {
  test('a synthesized answer row keeps its structured replies and never gains an inferred pasted chip', () => {
    const questions = [
      { question: '这个版本主要给谁用、跑在哪里？这决定要不要做签名公证、要不要独立域名。' },
      { question: '账号登录怎么走？现在两个站点是第三方 OAuth + 邮箱。' },
      { question: '它和现有两个站点是什么关系？' },
    ]
    const answers: Record<string, string> = {
      [questions[0].question]: '团队自己的服务器 + 独立域名',
      [questions[1].question]: '接团队自己的统一登录',
      [questions[2].question]: '同一份代码第三个 edition',
    }
    // Eight lines: exactly the shape that trips isLargePastedText.
    const text = questions.map(entry => `${entry.question}\n${answers[entry.question]}`).join('\n\n')
    const html = buildUserBubbleHtml({ text, questionAnswer: { questions, answers } }, true)?.html || ''
    expect(html).not.toContain('is-pasted')
    expect(html).toContain('团队自己的服务器 + 独立域名')
  })
})

describe('sent image preview ownership', () => {
  for (const row of imageVector.sentAttachmentCases) test(row.name, () => {
    const host = (globalThis as any).window
    const previous = { currentSessionId: host.currentSessionId, klaus: host.klaus }
    const path = '/uploads/sent.png'
    const attachment = { type: 'image', name: 'image.png', path, src: row.src,
      ...('snapshotOwner' in row ? { sessionId: row.snapshotOwner } : {}) }
    const original = { ...attachment }
    host.currentSessionId = row.global
    host.klaus = { ...host.klaus, media: { url: (_path: string, owner: string) => `klaus-media://test/${owner}` } }
    try {
      const text = 'text' in row ? row.text : 'Inspect this image'
      const msg = row.replay
        ? { text, contentBlocks: [{ type: 'image', path }] }
        : { text, localRender: { attachments: [attachment] } }
      const html = buildUserBubbleHtml(msg, true, row.sessionId)?.html || ''
      expect(html).toContain(`data-media-path="${path}"`)
      expect(html).toContain(`data-media-session="${row.expectedOwner}"`)
      expect(html).toContain(`src="${row.replay ? `klaus-media://test/${row.sessionId}` : row.src}"`)
      expect(attachment).toEqual(original)
    } finally { Object.assign(host, previous) }
  })
})

describe('sent file preview ownership', () => {
  for (const type of ['file', 'document']) test(`replayed ${type} keeps its stored path and transcript owner`, () => {
    const html = buildUserBubbleHtml({ text: 'Inspect', contentBlocks: [{ type, path: '/pool/notes.pdf', name: 'Original.pdf' }] }, true, 'replay-owner')?.html || ''
    expect(html).toContain('data-user-file="/pool/notes.pdf"')
    expect(html).toContain('data-user-file-session="replay-owner"')
    expect(html).toContain('Original.pdf')
  })
  test('optimistic files keep explicit owners while unbound files receive the transcript owner', () => {
    const attachments = [{ type: 'file', name: 'first.txt', path: '/pool/first', sessionId: 'explicit-owner' },
      { type: 'file', name: 'second.txt', path: '/pool/second' }]
    const snapshot = JSON.stringify(attachments)
    const html = buildUserBubbleHtml({ text: 'Inspect', localRender: { displayText: 'Inspect', attachments } }, true, 'transcript-owner')?.html || ''
    expect(html).toContain('data-user-file-session="explicit-owner"')
    expect(html).toContain('data-user-file-session="transcript-owner"')
    expect(JSON.stringify(attachments)).toBe(snapshot)
  })
})

describe('browser tab chip display metadata', () => {
  test('reload and sent-message edit preserve the browser snapshot and its chip', () => {
    const identity = { source: 'extension' as const, browserId: 'chrome:profile-a', tabId: '42', title: 'Project notes',
      url: 'https://example.com/notes', browserName: 'Chrome', lastOpened: 123, faviconUrl: 'data:image/png;base64,AAAA' }
    const row: BrowserTabMention = { ...identity, mention: browserTabMentionUri(identity) }
    const selected = browserTabReference(row)
    const reference = { ...selected, range: { start: 5, end: 5 + selected.value.length } }
    const displayText = `read ${selected.value} now`
    const metadata = { displayText, composerReferences: [reference] }
    const restored = JSON.parse(JSON.stringify(metadata))
    const live = buildUserBubbleHtml({ text: displayText, localRender: metadata }, true)?.html || ''
    const reloaded = buildUserBubbleHtml({ text: displayText, localRender: restored }, true)?.html || ''
    expect(reloaded).toBe(live)
    expect(reloaded).toContain('is-browser-tab-reference')
    expect(reloaded).toContain('Project notes')
    expect(reloaded).not.toContain('plugin://')
    expect(composerDraftFromDisplayMetadata(restored)).toEqual({ text: displayText, references: [reference] })
  })
})

describe('buildUserBubbleHtml 粘贴卡复原', () => {
  const PATH = '/cfg/pasted-text/00000000-0000-4000-8000-000000000000/pasted-text.txt'
  test('发送快照：卡进托盘行，气泡只留用户打的正文', () => {
    const html = buildUserBubbleHtml({
      text: PROMPT,
      localRender: { displayText: TAIL, pastedCards: [{ path: PATH, preview: 'In the repo', text: HEAD }], selectedTextAttachments: [] },
    }, true)?.html || ''
    expect(html).toContain('kls-paste-card is-thread')
    expect(html).toContain(`data-paste-path="${PATH}"`)
    // 托盘在气泡之前；被收走的正文不在气泡里。
    expect(html.indexOf('kls-paste-card is-thread')).toBeLessThan(html.indexOf('<div class="msg user">'))
    const bubble = html.split('<div class="msg user">')[1] || ''
    expect(bubble).toContain(TAIL)
    expect(bubble).not.toContain('kls-paste-card')
    expect(bubble).not.toContain('line 9')
  })

  test('无快照的历史从引用段复原卡与正文', () => {
    const requestText = `给我配置一个自定义模型，请求如下：\n\n# Files pasted by the user:\n\n## "curl -X POST https://example.test": ${PATH}\n`
    const html = htmlOf(requestText, true)
    expect(html).toContain('kls-paste-card is-thread')
    expect(html).toContain(`data-paste-path="${PATH}"`)
    const bubble = html.split('<div class="msg user">')[1] || ''
    expect(bubble).toContain('给我配置一个自定义模型，请求如下：')
    expect(bubble).not.toContain('# Files pasted by the user:')
  })

  test('子 Agent 的 prompt：不出卡，原文完整在气泡里', () => {
    const html = htmlOf(PROMPT, false)
    expect(html).not.toContain('kls-paste-card')
    expect(html).toContain('In the repo')
    expect(html).toContain('line 9')
    expect(html).toContain('Report concise findings')
  })

  test('没有记录的长文本按原文渲染：体量反猜已退役', () => {
    const html = htmlOf(PROMPT, true)
    expect(html).not.toContain('kls-paste-card')
    expect(html).toContain('line 9')
    const short = htmlOf(SHORT_HEAD_PROMPT, true)
    expect(short).not.toContain('kls-paste-card')
    expect(short).toContain('a7')
  })

  test('遗留纯文本快照卡进托盘行，不再内联进气泡', () => {
    const html = buildUserBubbleHtml({
      text: PROMPT,
      localRender: { displayText: TAIL, pastedCards: [{ text: HEAD, previewText: 'In the repo' }], selectedTextAttachments: [] },
    }, true)?.html || ''
    expect(html).toContain('kls-paste-card is-thread')
    const bubble = html.split('<div class="msg user">')[1] || ''
    expect(bubble).not.toContain('kls-paste-card')
    expect(bubble).toContain(TAIL)
  })

  test('向量：正文在气泡、粘贴卡在托盘行', () => {
    const vector = DISPLAY_VECTOR.pastedTextOrdering
    const html = buildUserBubbleHtml({
      text: vector.requestText,
      localRender: {
        displayText: vector.displayText,
        pastedCards: vector.pastedCards,
        selectedTextAttachments: [],
      },
    }, true)?.html || ''
    expect(html.indexOf('kls-paste-card is-thread')).toBeLessThan(html.indexOf('<div class="msg user">'))
    expect(html).not.toContain('kls-attach-chip is-pasted')
    expect(html.split('<div class="msg user">')[1] || '').toContain(vector.displayText)
  })
})

describe('buildUserBubbleHtml 引用复原', () => {
  test('即时气泡与历史重载气泡使用同一引用结构', () => {
    const selectedTextAttachments = [{ text: '这是引用的消息', previewText: '这是引用的消息' }]
    const text = encodeSelectedTextEnvelope('按这个逻辑修改', selectedTextAttachments)
    const optimistic = buildUserBubbleHtml({
      text,
      localRender: { displayText: '按这个逻辑修改', selectedTextAttachments },
    }, true)?.html
    const reloaded = buildUserBubbleHtml({ text }, true)?.html
    expect(reloaded).toBe(optimistic)
  })

  test('短引用在历史重载后仍与用户请求分开渲染', () => {
    const text = encodeSelectedTextEnvelope('按这个逻辑修改', [{ text: '这是引用的消息' }])
    const html = htmlOf(text, true)
    expect(html).toContain('kls-attach-chip is-quote')
    expect(html).toContain('这是引用的消息')
    expect(html).toContain('<div class="msg user">按这个逻辑修改</div>')
    expect(html).not.toContain('# Selected text:')
    expect(html).not.toContain('## My request:')
    expect(html).toContain('data-user-quote="这是引用的消息"')
    expect(html).toContain('title="这是引用的消息"')
    expect(html).toContain('aria-label="QUOTE: 这是引用的消息"')
  })

  test('多条引用按独立卡片复原', () => {
    const text = encodeSelectedTextEnvelope('继续', [{ text: '第一条' }, { text: '第二条' }])
    const html = htmlOf(text, true)
    expect(html.match(/kls-attach-chip is-quote/g)?.length).toBe(2)
    expect(html).toContain('第一条')
    expect(html).toContain('第二条')
    expect(html).toContain('<div class="msg user">继续</div>')
  })

  test('内联引用按正文中的位置复原，后续文字紧跟对应引用', () => {
    const quotes = [
      { text: '引用一', requestOffset: 0 },
      { text: '引用三', requestOffset: 3 },
    ]
    const text = encodeSelectedTextEnvelope('这是啥是咋回事', quotes)
    const html = htmlOf(text, true)
    expect(html).toContain('<div class="msg user">')
    expect(html).toContain('kls-attach-chip is-quote is-inline')
    expect(html.indexOf('引用一')).toBeLessThan(html.indexOf('这是啥'))
    expect(html.indexOf('这是啥')).toBeLessThan(html.indexOf('引用三'))
    expect(html.indexOf('引用三')).toBeLessThan(html.indexOf('是咋回事'))
    expect(html).not.toContain('kls-attach-row')
  })

  test('内联 chip 与两侧正文紧贴，模板换行缩进不进 pre-wrap 气泡', () => {
    // .msg.user 是 white-space: pre-wrap：chip HTML 里任何换行/缩进都会渲染成
    // 真实换行，把一行消息拆成三行。
    const quoteHtml = htmlOf(encodeSelectedTextEnvelope('这是啥是咋回事', [
      { text: '引用一', requestOffset: 0 },
      { text: '引用三', requestOffset: 3 },
    ]), true)
    const quoteBubble = quoteHtml.split('<div class="msg user">')[1]?.split('</div>')[0] || ''
    expect(quoteBubble.startsWith('<button type="button" class="kls-attach-chip is-quote is-inline"')).toBe(true)
    expect(quoteBubble).toContain('</span></button>这是啥<button type="button" class="kls-attach-chip is-quote is-inline"')
    expect(quoteBubble).toContain('</span></button>是咋回事')
    expect(quoteBubble).not.toContain('\n')

  })

  test('内联引用的即时气泡与历史重载结构一致', () => {
    const quotes = [
      { text: '引用一', previewText: '引用一', requestOffset: 0 },
      { text: '引用三', previewText: '引用三', requestOffset: 3 },
    ]
    const text = encodeSelectedTextEnvelope('这是啥是咋回事', quotes)
    const optimistic = buildUserBubbleHtml({
      text,
      localRender: { displayText: '这是啥是咋回事', selectedTextAttachments: quotes },
    }, true)?.html
    const reloaded = buildUserBubbleHtml({ text }, true)?.html
    expect(reloaded).toBe(optimistic)
  })

  test('子 Agent 的普通 prompt 不按用户引用信封解释', () => {
    const text = encodeSelectedTextEnvelope('继续', [{ text: '父任务上下文' }])
    const html = htmlOf(text, false)
    expect(html).not.toContain('is-quote')
    expect(html).toContain('# Selected text:')
    expect(html).toContain('## My request:')
  })
})

describe('buildUserBubbleHtml skill chip 恢复', () => {
  test('历史展示元数据把展开后的 skill 正文还原成无 tooltip 的 chip', () => {
    const expanded = [
      'Base directory for this skill:',
      ...Array.from({ length: 12 }, (_, index) => `expanded skill line ${index + 1}`),
    ].join('\n')
    const html = buildUserBubbleHtml({
      text: expanded,
      localRender: {
        displayText: '/push-code',
        pastedCards: [],
        selectedTextAttachments: [],
        slashCommand: { name: 'push-code', kind: 'skill' },
      },
    }, true)?.html || ''

    expect(html).toContain('slash-pill')
    expect(html).toContain('push-code')
    expect(html).not.toContain('Base directory for this skill')
    expect(html).not.toContain('is-pasted')
    expect(html).not.toContain('title=')
    expect(html).not.toContain('data-klaus-tip')
  })

  test('skill 展示元数据不遮掉历史内容块里的附件', () => {
    const html = buildUserBubbleHtml({
      text: 'expanded skill body',
      contentBlocks: [{ type: 'image', path: '/tmp/screenshot.png', filename: 'screenshot.png' }],
      localRender: {
        displayText: '/push-code',
        attachments: [],
        pastedCards: [],
        selectedTextAttachments: [],
        slashCommand: { name: 'push-code', kind: 'skill' },
      },
    }, true)?.html || ''

    expect(html).toContain('slash-pill')
    expect(html).toContain('screenshot.png')
  })

  test('skill 展示元数据保留普通文件附件卡', () => {
    const html = buildUserBubbleHtml({
      text: 'expanded skill body\n\nAttached:\n- /tmp/report.pdf',
      contentBlocks: [],
      localRender: {
        displayText: '/push-code',
        attachments: [{ type: 'file', name: 'report.pdf' }],
        pastedCards: [],
        selectedTextAttachments: [],
        slashCommand: { name: 'push-code', kind: 'skill' },
      },
    }, true)?.html || ''

    expect(html).toContain('slash-pill')
    expect(html).toContain('report.pdf')
    expect(html).not.toContain('/tmp/report.pdf')
  })
})

describe('skill rewind composer restoration', () => {
  test('restores an explicitly selected skill instead of inferring from plain text', () => {
    expect(composerDraftFromDisplayMetadata({
      displayText: '/push-code release',
      slashCommand: { name: 'push-code', kind: 'skill' },
    })).toEqual({
      text: '/push-code release',
      slashCommand: {
        command: { name: 'push-code', kind: 'skill' },
        range: { start: 0, end: 10 },
      },
    })
    expect(composerDraftFromDisplayMetadata({
      displayText: '/push-code-other',
      slashCommand: { name: 'push-code', kind: 'skill' },
    })).toBeNull()
  })

  test('restores ordinary pasted-card display metadata', () => {
    expect(composerDraftFromDisplayMetadata({
      displayText: '请求如下：',
      pastedCards: [{ text: HEAD, requestOffset: 5 }],
    })).toEqual({ text: '请求如下：' })
  })
})

describe('agent reference chip restoration', () => {
  test('renders configured agent syntax as the same chip before and after history reload', () => {
    const displayText = '@agent-Explore inspect the migration'
    const reference = {
      kind: 'agent',
      name: 'Explore',
      value: '@agent-Explore',
      range: { start: 0, end: 14 },
      source: 'configured',
    }
    const optimistic = buildUserBubbleHtml({
      text: displayText,
      localRender: { displayText, composerReferences: [reference] },
    }, true)?.html || ''
    const reloaded = buildUserBubbleHtml({ text: displayText }, true)?.html || ''

    expect(optimistic).toBe(reloaded)
    expect(reloaded).toContain('is-agent-reference')
    expect(reloaded).toContain('Explore')
    expect(reloaded).not.toContain('@agent-Explore')
    expect(reloaded).not.toContain('title=')
    expect(reloaded).not.toContain('data-klaus-tip')
  })

  test('keeps live agent and plugin identities from explicit display metadata', () => {
    const displayText = 'ask @worker with @tools'
    const html = buildUserBubbleHtml({
      text: displayText,
      localRender: {
        displayText,
        composerReferences: [
          { kind: 'agent', name: 'worker', value: '@worker', range: { start: 4, end: 11 }, source: 'live' },
          { kind: 'plugin', name: 'tools', value: '@tools', range: { start: 17, end: 23 }, source: 'plugin' },
        ],
      },
    }, true)?.html || ''

    expect(html).toContain('is-agent-reference')
    expect(html).toContain('is-plugin-reference')
    expect(html).toContain('worker')
    expect(html).toContain('tools')
  })

  test('keeps agent chips inline while pasted cards ride the tray', () => {
    const displayText = '先问 @agent-Explore 再处理'
    const html = buildUserBubbleHtml({
      text: displayText,
      localRender: {
        displayText,
        composerReferences: [{
          kind: 'agent',
          name: 'Explore',
          value: '@agent-Explore',
          range: { start: 3, end: 17 },
          source: 'configured',
        }],
        pastedCards: [{ text: HEAD, previewText: 'migration notes' }],
        selectedTextAttachments: [],
      },
    }, true)?.html || ''

    const bubble = html.split('<div class="msg user">')[1] || ''
    expect(html.indexOf('kls-paste-card is-thread')).toBeLessThan(html.indexOf('<div class="msg user">'))
    expect(bubble.indexOf('先问')).toBeLessThan(bubble.indexOf('is-agent-reference'))
    expect(bubble.indexOf('is-agent-reference')).toBeLessThan(bubble.indexOf('再处理'))
    expect(bubble).not.toContain('kls-paste-card')
  })

  test('restores reference identity when rewinding a sent message', () => {
    expect(composerDraftFromDisplayMetadata({
      displayText: '@agent-Explore inspect',
      composerReferences: [{
        kind: 'agent',
        name: 'Explore',
        value: '@agent-Explore',
        range: { start: 0, end: 14 },
        source: 'configured',
      }],
    })).toEqual({
      text: '@agent-Explore inspect',
      references: [{
        kind: 'agent',
        name: 'Explore',
        value: '@agent-Explore',
        range: { start: 0, end: 14 },
        source: 'configured',
      }],
    })
  })
})

describe('external friend message display', () => {
  const ENVELOPE = [
    'This friend task was approved by this device owner with the explicit resource grant below.',
    '{"sender":{"displayName":"Mia"},"grant":{"mode":"manual"},"prompt":"你的运行环境是什么"}',
  ].join('\n\n')
  const localRender = { externalFriendMessage: true, displayText: 'Mia: 你的运行环境是什么' }

  test('the bubble shows the sender prose, never the approval envelope', () => {
    const html = buildUserBubbleHtml({ text: ENVELOPE, localRender }, false)?.html || ''
    expect(html).toContain(localRender.displayText)
    expect(html).not.toContain('approved by this device owner')
    expect(html).not.toContain('"grant"')
  })

  test('history replay and the live frame restore the same snapshot', () => {
    const live = buildUserBubbleHtml({ text: ENVELOPE, localRender }, false)?.html || ''
    const replayed = buildUserBubbleHtml({ text: ENVELOPE, localRender: JSON.parse(JSON.stringify(localRender)) }, false)?.html || ''
    expect(replayed).toBe(live)
  })

  test('only externally delivered rows expose a display override', () => {
    expect(externalMessageDisplay(localRender)).toBe(localRender.displayText)
    expect(externalMessageDisplay({ displayText: 'typed text' })).toBeNull()
    expect(externalMessageDisplay(null)).toBeNull()
    expect(externalMessageDisplay('nonsense')).toBeNull()
  })

  test('long friend messages collapse to the vector-pinned summary shell', () => {
    const vector = DISPLAY_VECTOR.externalFriendMessage.collapse
    const shellClass = String(vector.shell).split(' ')[0].replace('div.', '')
    expect(shellClass).toBe('friend-msg-collapsed')
    const longText = Array.from({ length: 20 }, (_, index) => `line ${index} of a very long friend task prompt`).join('\n')
    const html = buildUserBubbleHtml({ text: 'envelope', localRender: { externalFriendMessage: true, displayText: longText } }, false)?.html || ''
    expect(html).toContain(shellClass)
    // The full text stays inside the shell (hidden), so expand and the reader never lose it.
    expect(html).toContain('line 19 of a very long friend task prompt')
    expect(html).toContain('hidden')
    // Short messages and the owner's own typing render verbatim.
    const shortHtml = buildUserBubbleHtml({ text: 'envelope', localRender: { externalFriendMessage: true, displayText: 'quick note' } }, false)?.html || ''
    expect(shortHtml).not.toContain(shellClass)
    const typedHtml = buildUserBubbleHtml({ text: longText }, true)?.html || ''
    expect(typedHtml).not.toContain(shellClass)
  })

  test('the sender column shows the friend avatar and name on the row', () => {
    const withSender = { ...localRender, sender: { userId: 'user-1', displayName: 'Mia', avatarUrl: 'https://example.test/a.png' } }
    const html = renderExternalSenderAvatarHtml(withSender, ENVELOPE)
    expect(html).toContain('Mia')
    expect(html).toContain('src="https://example.test/a.png"')
    expect(html).toContain('>M<')
    expect(html).toContain('data-media-figure')
    expect(html).not.toContain('user-1')
    expect(html).not.toContain('title=')
    expect(html).not.toContain('data-klaus-tip')
    expect(externalMessageSender(withSender)).toEqual({ userId: 'user-1', displayName: 'Mia', avatarUrl: 'https://example.test/a.png' })
  })

  test('a legacy snapshot without sender recovers the name from the envelope', () => {
    // Rows persisted before sender identity rode the display metadata still
    // carry the host-authored JSON paragraph in the model-facing text; that
    // paragraph has no avatar, so the column shows the initial alone.
    const html = renderExternalSenderAvatarHtml(localRender, ENVELOPE)
    expect(html).toContain('Mia')
    expect(html).not.toContain('<img')
  })

  test('typed messages and hand-typed envelopes render no sender column', () => {
    expect(renderExternalSenderAvatarHtml(undefined, 'plain prose')).toBe('')
    expect(renderExternalSenderAvatarHtml({ displayText: 'x' }, 'x')).toBe('')
    // The external mark is host-set; prose alone never earns a sender column.
    expect(renderExternalSenderAvatarHtml(null, ENVELOPE)).toBe('')
  })
})

describe('copy follows the typed text, not the stored request', () => {
  // The host appends a friend mention's delivery receipt to the request text
  // before it reaches the engine; the bubble only ever shows the typed sentence.
  const RECEIPT = [
    'The user explicitly mentioned these friends. The host already forwarded ONLY this message text:',
    '- Friend friend-194d1edf: delivered (request f15a98f1a38630d13db09e6d).',
    'Do not resend this message. Continue the local task; no files, earlier chat history or attachments were shared.',
  ].join('\n')
  const TYPED = '@friend-friend-194d1edf 你用的什么电脑'
  const stored = `${TYPED}\n\n${RECEIPT}`

  test('a friend mention row copies the typed sentence without the receipt', () => {
    expect(userCopyText({ text: stored, localRender: { displayText: TYPED, composerReferences: [] } }, true)).toBe(TYPED)
  })

  test('the same row replayed from history copies the same sentence', () => {
    const localRender = JSON.parse(JSON.stringify({ displayText: TYPED }))
    expect(userCopyText({ text: stored, localRender }, true)).toBe(TYPED)
  })

  test('the rendered action bar carries the typed text as its copy payload', () => {
    const msg = { text: stored, localRender: { displayText: TYPED }, uuid: 'u-friend-copy' }
    const actions = renderMsgActionsHtml({
      ts: 0, copyText: userCopyText(msg, true), uuid: msg.uuid, kind: 'user',
      archived: false, running: false, readOnly: false, canEdit: true,
    })
    expect(actions).toContain(`data-copy-text="${TYPED}"`)
    expect(actions).not.toContain('delivered (request')
  })

  test('a row without a display snapshot keeps the envelope parse fallback', () => {
    const envelope = encodeSelectedTextEnvelope('fix this', [{ text: 'quoted line', requestOffset: 0 }])
    expect(userCopyText({ text: envelope }, true)).toBe('fix this')
    expect(userCopyText({ text: 'plain text' }, true)).toBe('plain text')
    expect(userCopyText(null, true)).toBe('')
  })

  test('a non-composer row without a snapshot copies its stored text verbatim', () => {
    const envelope = encodeSelectedTextEnvelope('parent prompt', [{ text: 'quoted', requestOffset: 0 }])
    expect(userCopyText({ text: envelope }, false)).toBe(envelope)
  })
})


describe('submitted document preservation', () => {
  test('actual formatting and literal Markdown remain distinct after replay and edit refill', () => {
    const formatted = documentSchema.nodes.doc.create(null, documentSchema.nodes.paragraph.create(null, [
      documentSchema.text('bold', [documentSchema.marks.strong.create()]), documentSchema.text(' and **literal**'),
    ]))
    const snapshot = snapshotComposerDocument(formatted)
    const metadata = JSON.parse(JSON.stringify({ displayText: serializeComposerDocument(formatted).text, composerDocument: snapshot }))
    const html = buildUserBubbleHtml({ text: metadata.displayText, localRender: metadata }, true)?.html || ''
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('and **literal**')
    expect(userCopyText({ text: metadata.displayText, localRender: metadata }, true)).toBe('bold and **literal**')
    expect(composerDraftFromDisplayMetadata(metadata)?.document).toEqual(snapshot)
    const plain = snapshotComposerDocument(composerDocumentFromText('**literal** /manual'))
    const literalHtml = buildUserBubbleHtml({ text: '**literal** /manual', localRender: { displayText: '**literal** /manual', composerDocument: plain } }, true)?.html || ''
    expect(literalHtml).toContain('**literal** /manual')
    expect(literalHtml).not.toContain('slash-pill')
  })
  test('authored non-text blocks remain visible while an empty paragraph stays empty', () => {
    for (const block of [documentSchema.nodes.horizontal_rule.create(), documentSchema.nodes.code_block.create()]) {
      const document = snapshotComposerDocument(documentSchema.nodes.doc.create(null, block))
      const html = buildUserBubbleHtml({ text: '', localRender: { displayText: '', composerDocument: document } }, true)?.html || ''
      expect(html).toContain('msg user')
      expect(html).toContain(block.type.name === 'horizontal_rule' ? '<hr>' : '<pre><code></code></pre>')
    }
    const empty = snapshotComposerDocument(composerDocumentFromText(''))
    expect(buildUserBubbleHtml({ text: '', localRender: { displayText: '', composerDocument: empty } }, true)).toBeNull()
  })
  test('inline quote and repeated resource identities render once in authored order', () => {
    const quote = { kind: 'selected-text', quoteId: 'quote-one', text: 'full quote', previewText: 'Quote' }
    const reference = { kind: 'device', id: 'device-one', name: 'Device', value: '@device-device-one' }
    const doc = documentSchema.nodes.doc.create(null, documentSchema.nodes.paragraph.create(null, [
      documentSchema.text('before '), composerTokenNode({ value: '\uFFFC', label: 'Quote', data: quote }),
      documentSchema.text(' between '), composerTokenNode({ value: reference.value, label: 'Device', data: reference }), documentSchema.text(' after'),
    ]))
    const html = buildUserBubbleHtml({ text: '', localRender: { displayText: serializeComposerDocument(doc).text,
      composerDocument: snapshotComposerDocument(doc), selectedTextAttachments: [quote] } }, true)?.html || ''
    expect(html.match(/is-quote/g)).toHaveLength(1)
    // A document-rendered quote sits in the text flow, so it keeps the inline
    // pill styling (no tray border) instead of the attachment-card chrome.
    expect(html).toContain('is-quote is-inline')
    expect(html).toContain('title="full quote"')
    expect(html.indexOf('before')).toBeLessThan(html.indexOf('is-quote'))
    expect(html.indexOf('between')).toBeLessThan(html.indexOf('Device'))
    expect(html.indexOf('Device')).toBeLessThan(html.indexOf('after'))
  })
})
