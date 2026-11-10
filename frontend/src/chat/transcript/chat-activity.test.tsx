import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from './chat-activity-vectors.json'
import activityContract from '../../../../contracts/vectors/activity-summary-vectors.json'
import type { ToolCardState, LiveUnit } from '../stream-store'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en' }

const { I18N } = await import('../../i18n')
const skillsData = await import('../../pages/skills/data')
const { ChatActivity, ChatActivityDisclosure, chatActivityKind, dynamicActivityLabel, isDynamicActivityTool, isExplicitMediaGenerationTool, chatActivityTarget, chatActivitySummaryLabel, navigateChatActivity } = await import('./chat-activity')
const { activityToolPresentation, activityToolSummary } = await import('./activity-tool')
const { describeActivity } = await import('./activity-model')
const { HistoryToolCards, LiveToolCard, activitySummaryLabel, activitySummaryIconTool, chatGroupIcon, foldUnits: projectTurnUnits, groupLiveActivityUnits: projectLiveUnits, hasActiveChatActivitySummary, unitsFromMessages, segmentsFromBlocks } = await import('./TranscriptView')

// These cases inspect tool grouping inside the process disclosure.
const groupLiveActivityUnits = (...args: Parameters<typeof projectLiveUnits>) => projectLiveUnits(...args).flatMap(node => node.kind === 'turn' ? node.items : [node])
const foldUnits = (...args: Parameters<typeof projectTurnUnits>) => projectTurnUnits(...args).flatMap(node => node.kind === 'turn-fold' ? node.items : [node])

const card = (toolName: string, status: ToolCardState['status'] = 'ok', id = 'call-read'): ToolCardState => ({
  toolName, status, toolCallId: id, args: { threadId: 'target-chat' }, argsDelta: '', progress: [], agent: false, bgTask: false,
})
const toolsUnit = (order: string[]): LiveUnit => ({ type: 'live-tools', key: 'tools-1', order, sealed: false })
const translate = (locale: 'en' | 'zh') => (key: string) => I18N[locale][key] || key
const liveSummary = (node: ReturnType<typeof groupLiveActivityUnits>[number]) => {
  if (node.kind !== 'activity') throw new Error('Expected an activity group')
  return activitySummaryLabel(translate('en'), node)
}

describe('Klaus query activity meaning', () => {
  test('uses executed top-level actions and never infers an action from nested arguments', () => {
    const values: Array<[unknown, string]> = [
      [{ key: 'account' }, '已查看账号功能'],
      [{ key: 'account', action: 'status' }, '已查询登录状态'],
      [{ key: 'docs', action: 'search', arguments: { query: 'login' } }, '已搜索帮助文档'],
      [{ key: 'docs', action: 'section', arguments: { name: 'login' } }, '已读取帮助章节'],
      [{ key: 'docs', arguments: { action: 'search' } }, '已查看帮助文档功能'],
      [{ key: 'docs', action: 'outline' }, '已查看帮助目录'],
      [{}, '已查询Klaus'],
    ]
    for (const [args, expected] of values) expect(dynamicActivityLabel(translate('zh'), { toolName: 'klaus_query', args, state: 'done' }, true)).toBe(expected)
    for (const [state, expected] of [['running', '正在查询Klaus'], ['error', '查询Klaus失败'], ['interrupted', '已停止查询Klaus']]) {
      expect(dynamicActivityLabel(translate('zh'), { toolName: 'klaus_query', args: '{', state }, state !== 'running')).toBe(expected)
    }
  })

  test('summary retains distinct query operations while deduping repetitions', () => {
    const previous = (window as any).currentLang
    ;(window as any).currentLang = 'en'
    try {
      const tools = [
        { key: 'account' }, { key: 'docs', action: 'search' }, { key: 'docs', action: 'section' }, { key: 'docs', action: 'search' },
      ].map(args => ({ toolName: 'klaus_query', args, state: 'done' }))
      const label = chatActivitySummaryLabel(translate('en'), tools)
      expect(label).toContain('Viewed account actions')
      expect(label).toContain('searched help documentation')
      expect(label).toContain('read a help section')
      expect(label.match(/searched help documentation/g)).toHaveLength(1)
    } finally { (window as any).currentLang = previous }
  })
})

describe('skill load activity naming', () => {
  const seedSkillCache = async (installed: unknown[]) => {
    skillsData.invalidateSkillsDataCache()
    ;(window as any).klaus = {
      skills: {
        list: async () => installed,
        market: async () => ({ items: [] }),
        builtin: async () => ({ items: [] }),
      },
    }
    await skillsData.loadSkillsData()
  }

  // Seed the market name table directly on the test window: importing the real
  // market-tables module here would bind its window tables to this file's
  // throwaway window object and, being cached, never re-bind them for the
  // plugin-market-terms test that resets window to globalThis later.
  function seedSkillNames() {
    ;(window as any).SKILL_TEXT_I18N = {
      'code-review-and-clean': {
        en: ['Code Review and Cleanup', 'Review code and remove dead paths.'],
        zh: ['代码审查与清理', '审查代码并清理无用实现。'],
      },
    }
  }

  test('names the skill the way the market does, in both languages and all four states', async () => {
    seedSkillNames()
    await seedSkillCache([{ dirName: 'code-review-and-clean', name: 'code-review-and-clean' }])
    const previousLang = (window as any).currentLang
    try {
      const call = (state: string) => ({ toolName: 'skill', args: { name: 'code-review-and-clean' }, state })
      // The market display name follows the UI language, like on the Skills page.
      ;(window as any).currentLang = 'zh'
      expect(dynamicActivityLabel(translate('zh'), call('running') as any, false)).toBe('正在加载代码审查与清理技能')
      expect(dynamicActivityLabel(translate('zh'), call('done') as any, true)).toBe('已加载代码审查与清理技能')
      expect(dynamicActivityLabel(translate('zh'), call('error') as any, true)).toBe('加载代码审查与清理技能失败')
      expect(dynamicActivityLabel(translate('zh'), call('interrupted') as any, true)).toBe('已停止加载代码审查与清理技能')
      ;(window as any).currentLang = 'en'
      // A non-following position still starts lowercase, like every other family member.
      expect(dynamicActivityLabel(translate('en'), call('running') as any, false)).toBe('Loading Code Review and Cleanup skill')
      expect(dynamicActivityLabel(translate('en'), call('done') as any, true)).toBe('Loaded Code Review and Cleanup skill')
      // A following position keeps the lowercase form.
      expect(dynamicActivityLabel(translate('en'), call('done') as any, true, false)).toBe('loaded Code Review and Cleanup skill')
    } finally {
      ;(window as any).currentLang = previousLang
      skillsData.invalidateSkillsDataCache()
    }
  })

  test('an identifier the market does not know keeps its raw name, and a streaming call without one stays generic', async () => {
    skillsData.invalidateSkillsDataCache()
    expect(dynamicActivityLabel(translate('zh'), { toolName: 'skill', args: { name: 'my-local-skill' }, state: 'done' }, true)).toBe('已加载my-local-skill技能')
    expect(dynamicActivityLabel(translate('en'), { toolName: 'skill', args: { name: 'my-local-skill' }, state: 'done' }, true)).toBe('Loaded my-local-skill skill')
    expect(dynamicActivityLabel(translate('zh'), { toolName: 'skill', args: {}, state: 'running' }, false)).toBe('正在加载技能')
    expect(dynamicActivityLabel(translate('en'), { toolName: 'skill', args: {}, state: 'done' }, true)).toBe('Loaded a skill')
  })

  test('a SKILL.md read words the same event as the skill tool card', async () => {
    seedSkillNames()
    await seedSkillCache([{ dirName: 'code-review-and-clean', name: 'code-review-and-clean' }])
    const previousLang = (window as any).currentLang
    try {
      const presentation = activityToolPresentation({ toolCallId: 'c', toolName: 'read', args: { file_path: '/skills/code-review-and-clean/SKILL.md' }, state: 'done' })
      ;(window as any).currentLang = 'zh'
      expect(activityToolSummary(presentation, 'running', false, 'zh')).toBe('正在加载代码审查与清理技能')
      expect(activityToolSummary(presentation, 'done', false, 'zh')).toBe('已加载代码审查与清理技能')
      // The in-progress headline above the fold agrees with the row below it.
      const action = describeActivity('read', { file_path: '/skills/code-review-and-clean/SKILL.md' }, 'running')
      const headline = activitySummaryLabel(translate('zh'), { mode: 'active', activeAction: action, summary: undefined as never, thinkingHeading: '' })
      expect(headline).toBe('正在加载代码审查与清理技能')
      ;(window as any).currentLang = 'en'
      expect(activityToolSummary(presentation, 'done', false, 'en')).toBe('Loaded Code Review and Cleanup skill')
    } finally {
      ;(window as any).currentLang = previousLang
      skillsData.invalidateSkillsDataCache()
    }
  })
})

describe('chat activity contract vectors', () => {
  for (const vector of vectors.rows) {
    test(vector.name, () => {
      for (const locale of ['en', 'zh'] as const) {
        ;(window as any).currentLang = locale
        const markup = renderToStaticMarkup(<ChatActivity tool={vector} />)
        expect(markup).toContain(vector[locale])
        expect(markup.includes('<button')).toBe(vector.target !== null)
        expect(markup).not.toContain('title=')
        expect(markup).not.toContain('tool-item-detail')
        expect(markup).not.toContain('Input')
        expect(markup).not.toContain('tool-chevron')
        if (vector.target) expect(markup).toContain(`data-chat-activity-thread-id="${vector.target}"`)
        const prompt = vector.args && typeof vector.args === 'object' && !Array.isArray(vector.args) && 'prompt' in vector.args
          ? vector.args.prompt : null
        if (vector.toolName === 'send_message_to_thread' && typeof prompt === 'string') {
          expect(markup).toContain('data-chat-send-disclosure')
          expect(markup).toContain(prompt)
          if (vector.target) expect(markup.indexOf('data-chat-activity-thread-id')).toBeGreaterThan(markup.indexOf('</summary>'))
          else expect(markup).not.toContain('data-chat-activity-thread-id')
        }
      }
      const navigations: string[] = []
      expect(navigateChatActivity(vector.toolName, vector.args, id => navigations.push(id))).toBe(vector.target !== null)
      expect(navigations).toEqual(vector.target === null ? [] : [vector.target])
      expect(chatActivityTarget(vector.toolName, vector.args, 'summary')).toBe(null)
      expect(chatActivityTarget(vector.toolName, vector.args, 'summary-text')).toBe(null)
      ;(window as any).currentLang = 'en'
    })
  }

  for (const vector of vectors.dynamicLabels) {
    test(`generic words and state: ${vector.toolName}`, () => {
      const tool = { toolName: vector.toolName, args: {}, state: 'done' }
      const previous = (window as any).currentLang
      for (const locale of ['en', 'zh'] as const) {
        ;(window as any).currentLang = locale
        expect(dynamicActivityLabel(translate(locale), tool, false)).toBe(vector[locale].active)
        expect(dynamicActivityLabel(translate(locale), tool, true)).toBe(vector[locale].completed)
        expect(dynamicActivityLabel(translate(locale), tool, true, false)).toBe(vector[locale].following)
      }
      ;(window as any).currentLang = previous
    })
  }

  test('summary text never becomes a navigation control', () => {
    const tool = { toolName: 'read_thread', args: { threadId: 'another-chat' }, state: 'done' }
    const summary = renderToStaticMarkup(<ChatActivity tool={tool} variant="summary-text" leading={false} />)
    expect(summary).toContain('read chat')
    expect(summary).not.toContain('<button')
    expect(summary).not.toContain('<svg')
  })

  test('unrelated MCP tools never gain a kind or navigation', () => {
    // The security-relevant invariant: an unrelated MCP tool that merely shares a
    // suffix (or the bare `read`, or klaus_query without a session scope) must
    // keep its own renderer and must NEVER gain the host tool's navigation. This
    // is an allowlist test, not a "looks like a thread tool" test.
    for (const name of ['mcp__external__read_thread', 'functions.read_thread', 'read', 'klaus_query']) {
      expect(chatActivityKind(name, { threadId: 'chat' })).toBe(null)
      expect(chatActivityTarget(name, { threadId: 'chat' })).toBe(null)
    }
  })

  test('list_archived_threads is a first-class kind but still never navigates', () => {
    // It joined the coordination family, so it has its own six-state label
    // instead of falling through to a lowercase tool-name string — but it takes no
    // threadId argument, so there is nothing to navigate to and it must not become
    // a button.
    expect(chatActivityKind('list_archived_threads', { limit: 5 })).toBe('list_archived')
    expect(chatActivityTarget('list_archived_threads', { limit: 5 })).toBe(null)
    expect(chatActivityTarget('list_archived_threads', { threadId: 'chat' })).toBe(null)
  })

  for (const vector of vectors.summaries) {
    test(`summary ${vector.kinds.join(', ')}`, () => {
      // Entries that carry explicit `tools` are the coordination family, whose
      // kinds and arguments differ per entry; the original two-kind vectors are
      // reconstructed from `kinds` exactly as before.
      const declared = (vector as { tools?: Array<{ toolName: string; args?: unknown; state?: string }> }).tools
      const tools = declared
        ? declared.map(tool => ({ toolName: tool.toolName, args: tool.args ?? {}, state: tool.state ?? 'done' }))
        : vector.kinds.map(kind => ({ toolName: kind === 'read' ? 'read_thread' : 'list_threads', args: {}, state: 'done' }))
      for (const locale of ['en', 'zh'] as const) {
        ;(window as any).currentLang = locale
        expect(chatActivitySummaryLabel(translate(locale), tools)).toBe(vector[locale])
      }
      ;(window as any).currentLang = 'en'
    })
  }

  for (const vector of vectors.nonLeading) {
    test(`non-leading ${vector.name}`, () => {
      // A card that FOLLOWS another action in a summary line: leading=false picks
      // the lowercase following/failedFollowing wording. A rendered row always
      // leads, so this path is pinned through the label function directly.
      const tool = { toolName: vector.toolName, args: vector.args, state: vector.state }
      for (const locale of ['en', 'zh'] as const) {
        expect(dynamicActivityLabel(translate(locale), tool, true, false)).toBe(vector[locale])
      }
    })
  }

  test('an unmodelled card state falls back to the `other` wording instead of showing a raw i18n key', () => {
    const tool = { toolName: 'send_message_to_thread', args: {}, state: 'done' }
    // With the real dictionary, the completed wording resolves directly.
    expect(dynamicActivityLabel(translate('en'), tool, true, true)).toBe('Sent message to chat')
    // `chatActivityState` only ever returns the five reachable states, so `other`
    // is the defensive branch: if a future state slips through and its own key is
    // missing, the card must stay readable rather than print
    // `chat_activity_send_other` into the transcript.
    const onlyOther = (key: string) => {
      if (key === 'chat_activity_send_other') return 'Send message to chat'
      return key === 'chat_activity_send_completed' ? 'chat_activity_send_completed' : translate('en')(key)
    }
    expect(dynamicActivityLabel(onlyOther, tool, true, true)).toBe('Send message to chat')
  })
})

describe('streaming and replay interactions', () => {
  test('known chat titles keep reads readable and navigable in live and replay rows', () => {
    const previousLang = (window as any).currentLang
    const previousLookup = (window as any).getKnownSessionInfo
    ;(window as any).getKnownSessionInfo = () => ({ title: 'Storage settings' })
    try {
      for (const locale of ['en', 'zh'] as const) {
        ;(window as any).currentLang = locale
        const tool = card('read_thread')
        const live = renderToStaticMarkup(<LiveToolCard card={{ ...tool, content: 'private output' }} open onToggle={() => {}} />)
        const replay = segmentsFromBlocks([{ type: 'tool_use', id: tool.toolCallId, name: tool.toolName, input: tool.args, __result: { text: 'private output' } }], undefined)
        const history = renderToStaticMarkup(<HistoryToolCards tools={replay[0].tools!} />)
        for (const markup of [live, history]) {
          expect(markup).toContain(locale === 'en' ? 'Read chat' : '已读取聊天')
          expect(markup).toContain('<button')
          expect(markup).toContain('data-chat-activity-thread-id="target-chat"')
          expect(markup).not.toContain('chat_activity_')
          expect(markup).not.toContain('Storage settings')
          expect(markup).not.toContain('private output')
          expect(markup).not.toContain('tool-item-detail')
        }
      }
    } finally {
      ;(window as any).currentLang = previousLang
      ;(window as any).getKnownSessionInfo = previousLookup
    }
  })

  test('sending exposes the complete multiline prompt in both live and replay rows', () => {
    const prompt = `First line <keep literal>\n${'A'.repeat(120)}\nLast line`
    for (const hostId of [undefined, 'remote-device']) {
      const args = { threadId: 'target-chat', prompt, ...(hostId ? { hostId } : {}) }
      for (const status of ['running', 'ok'] as const) {
        const tool = { ...card('send_message_to_thread', status, `send-${hostId || 'local'}-${status}`), args }
        const live = renderToStaticMarkup(<LiveToolCard card={tool} open={false} onToggle={() => {}} />)
        const replay = segmentsFromBlocks([{ type: 'tool_use', id: tool.toolCallId, name: tool.toolName, input: args, __result: { text: 'sent' } }], undefined)
        const history = renderToStaticMarkup(<HistoryToolCards tools={replay[0].tools!} />)
        for (const markup of [live, history]) {
          expect(markup).toContain('data-chat-send-disclosure')
          expect(markup).toContain('data-chat-send-summary')
          expect(markup).toContain('First line &lt;keep literal&gt;')
          expect(markup).toContain('Last line')
          expect(markup).toContain('A'.repeat(120))
          expect(markup).not.toContain('<keep literal>')
          if (hostId) expect(markup).not.toContain('data-chat-activity-thread-id="target-chat"')
          else expect(markup).toContain('data-chat-activity-thread-id="target-chat"')
        }
      }
    }
  })

  test('an active single read keeps an active projection until its result arrives', () => {
    const tool = card('read_thread', 'running')
    const nodes = groupLiveActivityUnits([toolsUnit([tool.toolCallId])], { [tool.toolCallId]: tool }, true, false)
    expect(nodes.map(node => node.kind)).toEqual(['activity'])
    expect(liveSummary(nodes[0])).toBe('Reading chat')
    const markup = renderToStaticMarkup(<ChatActivityDisclosure label="Reading chat" active open onToggle={() => {}}>
      <ChatActivity tool={{ toolName: tool.toolName, args: tool.args, state: tool.status }} />
    </ChatActivityDisclosure>)
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('data-chat-activity-thread-id')
  })

  test('completed calls keep the live sequence open while waiting is tracked separately', () => {
    const tool = card('read_thread')
    const units = [toolsUnit([tool.toolCallId])]
    const tools = { [tool.toolCallId]: tool }
    expect(groupLiveActivityUnits(units, tools, true, false)[0]).toMatchObject({ kind: 'activity', mode: 'thinking' })
    expect(hasActiveChatActivitySummary(units, tools, true)).toBe(false)
    expect(hasActiveChatActivitySummary(units, tools, false)).toBe(false)
    expect(hasActiveChatActivitySummary([...units, { type: 'live-text', key: 'reply', text: 'Done', streaming: true }], tools, true)).toBe(false)
  })

  test('a single completed or failed read stays a standalone row once its slice closes', () => {
    for (const status of ['ok', 'error'] as const) {
      const tool = card('read_thread', status)
      const nodes = groupLiveActivityUnits([toolsUnit([tool.toolCallId])], { [tool.toolCallId]: tool }, false, false)
      expect(nodes.map(node => node.kind)).toEqual(['unit'])
    }
  })

  test('list and repeated reads keep every navigable row while deduping completed summary', () => {
    const tools = { list: card('list_threads', 'ok', 'list'), read: card('read_thread', 'ok', 'read'), page: card('read_thread', 'ok', 'page') }
    const nodes = groupLiveActivityUnits([toolsUnit(['list', 'read', 'page'])], tools, false, false)
    expect(nodes.map(node => node.kind)).toEqual(['activity'])
    expect(liveSummary(nodes[0])).toBe('Listed chats, read chat')
    const group = nodes[0]
    if (group.kind !== 'activity') throw new Error('Expected activity group')
    expect(group.summary.allTools).toHaveLength(3)
    expect(group.units.flatMap(unit => unit.type === 'live-tools' ? unit.order : [])).toEqual(['list', 'read', 'page'])
  })

  test('expanded summary exposes read navigation without a nested button', () => {
    const html = renderToStaticMarkup(<ChatActivityDisclosure label="Read chat" active={false} open onToggle={() => {}}>
      <ChatActivity tool={{ toolName: 'read_thread', args: { threadId: 'chat-b' }, state: 'done' }} />
    </ChatActivityDisclosure>)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-chat-activity-thread-id="chat-b"')
    expect(html.indexOf('</button>')).toBeLessThan(html.indexOf('data-chat-activity-thread-id'))
  })

  test('replayed groups have the same deduped summary and remain collapsed on errors', () => {
    const messages = [{ role: 'user', uuid: 'u', turnId: 'turn-1', text: 'Read chats' }, {
      role: 'assistant', uuid: 'a', turnId: 'turn-1', contentBlocks: [
        { type: 'tool_use', name: 'list_threads', id: 'l', input: {}, __result: { text: '{}' } },
        { type: 'tool_use', name: 'read_thread', id: 'r', input: { threadId: 'target-chat' }, __result: { text: 'failed', isError: true } },
      ],
    }]
    const nodes = foldUnits(unitsFromMessages(messages), null, { 'turn-1': 'completed' }, {})
    const group = nodes.find(node => node.kind === 'activity-fold')
    expect(group?.kind).toBe('activity-fold')
    if (group?.kind !== 'activity-fold') throw new Error('Expected activity group')
    expect(group.open).toBe(false)
    expect(activitySummaryLabel(translate('en'), group)).toBe('Listed chats, couldn’t read chat')
  })

  test('commentary separates completed reads into independent rows', () => {
    const tools = { a: card('read_thread', 'ok', 'a'), b: card('read_thread', 'ok', 'b') }
    const units: LiveUnit[] = [toolsUnit(['a']), { type: 'live-text', key: 'commentary', text: 'Checking another chat', streaming: false }, { ...toolsUnit(['b']), key: 'tools-2' }]
    expect(groupLiveActivityUnits(units, tools, false, false).map(node => node.kind)).toEqual(['unit', 'unit', 'unit'])
    const replay = unitsFromMessages([{ role: 'assistant', uuid: 'a', contentBlocks: [
      { type: 'tool_use', name: 'read_thread', id: 'a', input: { threadId: 'chat-a' }, __result: { text: '{}' } },
      { type: 'text', text: 'Checking another chat' },
      { type: 'tool_use', name: 'read_thread', id: 'b', input: { threadId: 'chat-b' }, __result: { text: '{}' } },
    ] }])
    expect(foldUnits(replay, null, {}, {}).map(node => node.kind)).toEqual(['unit', 'unit', 'unit'])
  })

  test('reasoning neither creates a group nor separates adjacent reads', () => {
    const tools = { a: card('read_thread', 'ok', 'a'), b: card('read_thread', 'ok', 'b') }
    const thinking: LiveUnit = { type: 'live-thinking-done', key: 'thinking', text: 'Check a chat', elapsedSeconds: 1 }
    expect(groupLiveActivityUnits([thinking, toolsUnit(['a'])], tools, false, false).map(node => node.kind)).toEqual(['unit'])
    const grouped = groupLiveActivityUnits([toolsUnit(['a']), thinking, { ...toolsUnit(['b']), key: 'tools-2' }], tools, false, false)
    expect(grouped.map(node => node.kind)).toEqual(['activity'])
    expect(liveSummary(grouped[0])).toBe('Read chat')
  })

  test('mixed tool summaries use category order and hide counts', () => {
    const tools = {
      read: card('read_thread', 'ok', 'read'),
      file: { ...card('read', 'ok', 'file'), args: { path: '/project/a.ts' } },
      edit: { ...card('edit', 'ok', 'edit'), args: { path: '/project/a.ts' } },
      command: card('bash', 'ok', 'command'),
      web: card('web_search', 'ok', 'web'),
    }
    const nodes = groupLiveActivityUnits([toolsUnit(['read', 'command', 'web', 'file', 'edit'])], tools, false, false)
    expect(liveSummary(nodes[0])).toBe('Edited a file, read files, ran a command, searched the web, read chat')
  })

  test('missing result is active only in an explicitly active parent turn', () => {
    const messages = [{ role: 'assistant', uuid: 'a', turnId: 'turn-active', contentBlocks: [
      { type: 'tool_use', name: 'read_thread', id: 'read', input: { threadId: 'chat-b' } },
    ] }]
    const active = foldUnits(unitsFromMessages(messages), { turnId: 'turn-active' }, { 'turn-active': 'in-progress' }, {})
    const group = active.find(node => node.kind === 'activity-fold')
    if (group?.kind !== 'activity-fold') throw new Error('Expected active group')
    expect(activitySummaryLabel(translate('en'), group)).toBe('Reading chat')
    for (const status of ['completed', 'failed', 'interrupted']) {
      const finished = foldUnits(unitsFromMessages(messages), null, { 'turn-active': status }, {})
      // A settled lone read is its own row, not a one-child disclosure.
      expect(finished.some(node => node.kind === 'activity-fold')).toBe(false)
      const toolUnit = finished.find((node): node is Extract<(typeof finished)[number], { kind: 'unit' }> => node.kind === 'unit' && node.unit.type === 'tools')
      expect(toolUnit?.unit.segment?.tools?.[0].state).not.toBe('running')
    }
  })

  test('repeated unknown dynamic calls dedupe into one ordered summary in live and replay', () => {
    // `list_archived_threads` now has its own six-state label, so the repeated
    // entry uses a genuinely unknown dynamic tool. Keeping `archive` and `repeat`
    // on the SAME tool name is the point of this test: they must dedupe into one
    // label, so four cards still yield three summary parts.
    const tools = {
      read: card('read_thread', 'ok', 'read'), archive: card('custom_probe_index', 'ok', 'archive'),
      screenshot: card('screenshot', 'ok', 'screenshot'), repeat: card('custom_probe_index', 'error', 'repeat'),
    }
    const orders = [
      ['read', 'archive', 'screenshot', 'repeat'],
      ['archive', 'screenshot', 'read', 'repeat'],
    ]
    const labels = ['Viewed 1 image, read chat, failed Custom probe index', 'Viewed 1 image, failed Custom probe index, read chat']
    orders.forEach((order, index) => {
      const nodes = groupLiveActivityUnits([toolsUnit(order)], tools, false, false)
      expect(nodes.map(node => node.kind)).toEqual(['activity'])
      expect(liveSummary(nodes[0])).toBe(labels[index])
      expect(nodes[0].kind === 'activity' && nodes[0].summary.allTools.length).toBe(4)
      const replay = unitsFromMessages([{ role: 'assistant', uuid: 'mixed', contentBlocks: order.map(id => ({
        type: 'tool_use', id, name: tools[id as keyof typeof tools].toolName, input: {}, __result: { text: 'raw result', isError: id === 'repeat' },
      })) }])
      const group = foldUnits(replay, null, {}, {})[0]
      if (group.kind !== 'activity-fold') throw new Error('Expected one replay activity group')
      expect(activitySummaryLabel(translate('en'), group)).toBe(labels[index])
      expect(group.open).toBe(false)
    })
  })

  test('generic host rows retain lifecycle feedback and expandable outcomes in live and replay', () => {
    for (const status of ['running', 'ok', 'error'] as const) {
      const tool = { ...card('custom_probe_index', status), args: { cursor: 'private-input' }, content: 'private-output' }
      const live = renderToStaticMarkup(<LiveToolCard card={tool} open onToggle={() => {}} />)
      const replay = segmentsFromBlocks([{ type: 'tool_use', id: tool.toolCallId, name: tool.toolName, input: tool.args, __result: { text: 'private-output', isError: status === 'error' } }], undefined)
      const history = renderToStaticMarkup(<HistoryToolCards tools={replay[0].tools!} />)
      for (const html of [live, history]) {
        expect(html).toContain('Custom probe index')
        expect(html).toContain('aria-expanded=')
      }
      expect(live).toContain('private-input')
      expect(live).toContain('private-output')
      expect(history).not.toContain('private-input')
      expect(history).not.toContain('private-output')
    }
  })

  test('generic names containing file and web words retain their dynamic identity', () => {
    const tools = { read: card('read_thread'), custom: card('custom_read_web_index', 'ok', 'custom') }
    expect(liveSummary(groupLiveActivityUnits([toolsUnit(['read', 'custom'])], tools, false, false)[0]))
      .toBe('Read chat, completed Custom read web index')
    for (const name of ['read', 'NotebookRead', 'write_stdin', 'apply_patch', 'ask_user', 'update_plan', 'generate_image', 'generate_video', 'generate_audio', 'generate_music', 'mcp__external__read_thread']) {
      expect(isDynamicActivityTool(name)).toBe(false)
    }
  })

  test('generation tools get separate cards and audio files stay out of the image path', () => {
    // The generation tools read the same way in the transcript: a card, not a
    // line folded into the turn's activity summary.
    for (const name of ['generate_image', 'generate_video', 'generate_audio', 'generate_music']) {
      expect(isDynamicActivityTool(name)).toBe(false)
    }
    // Only image and video feed the turn's produced-media figures, which render as
    // images. Audio answers with its saved path as text, so claiming it here would
    // point a future change at drawing an <img> for an mp3.
    expect(isExplicitMediaGenerationTool('generate_image')).toBe(true)
    expect(isExplicitMediaGenerationTool('generate_video')).toBe(true)
    expect(isExplicitMediaGenerationTool('generate_audio')).toBe(false)
    expect(isExplicitMediaGenerationTool('generate_music')).toBe(false)
  })

  test('only unfinished generic calls retain the dynamic activity placeholder', () => {
    const tools = { read: card('read_thread'), archive: card('custom_probe_index', 'running', 'archive') }
    const units = [toolsUnit(['read', 'archive'])]
    expect(liveSummary(groupLiveActivityUnits(units, tools, true, false)[0])).toBe('Running Custom probe index')
    expect(hasActiveChatActivitySummary(units, tools, true)).toBe(true)
    tools.archive.status = 'ok'
    expect(hasActiveChatActivitySummary(units, tools, true)).toBe(false)
    expect(hasActiveChatActivitySummary([toolsUnit(['archive', 'read'])], tools, true)).toBe(false)
  })

  test('native terminal reads use their dedicated localized generic label', () => {
    const tool = { toolName: 'read_thread_terminal', args: {}, state: 'done' }
    expect(dynamicActivityLabel(translate('en'), tool, false)).toBe('Reading chat terminal')
    expect(dynamicActivityLabel(translate('en'), tool, true, false)).toBe('read chat terminal')
    expect(dynamicActivityLabel(translate('zh'), tool, true, false)).toBe('已读取聊天终端')
  })

  test('native browser captures keep their visible images in live and history', () => {
    const previous = (window as any).klaus
    ;(window as any).klaus = { media: { url: (path: string) => `klaus-media://fixture${path}` } }
    try {
      for (const name of ['browser_screenshot', 'browser_computer', 'browser_navigate']) {
        const tool = { ...card(name), args: { tabId: 'tab-1' }, content: 'Browser capture', media: [{ path: '/capture.png' }] }
        const live = renderToStaticMarkup(<LiveToolCard card={tool} open onToggle={() => {}} />)
        const replay = segmentsFromBlocks([{ type: 'tool_use', id: tool.toolCallId, name, input: tool.args, __result: { content: [
          { type: 'text', text: 'Browser capture' }, { type: 'image', path: '/capture.png' },
        ] } }], undefined)
        const history = renderToStaticMarkup(<HistoryToolCards tools={replay[0].tools!} />)
        for (const html of [live, history]) {
          if (name === 'browser_screenshot' && html === history) expect(html).not.toContain('<img')
          else {
            expect(html).toContain('<img')
            expect(html).toContain('src="klaus-media://fixture/capture.png"')
            expect(html).toContain('alt="capture.png"')
          }
          expect(html).not.toContain('data-chat-activity=')
        }
        expect(live).toContain('Browser capture')
        expect(replay[0].tools![0].output?.text).toContain('Browser capture')
        expect(history).toContain('aria-expanded="false"')
      }
    } finally {
      ;(window as any).klaus = previous
    }
  })

  test('native tool search and its imported alias retain their icon, query, and output controls', () => {
    for (const name of ['tool_search', 'ToolSearch']) {
      const tool = { ...card(name), args: { query: 'calendar lookup' }, content: 'Found calendar tools' }
      const live = renderToStaticMarkup(<LiveToolCard card={tool} open onToggle={() => {}} />)
      const replay = segmentsFromBlocks([{ type: 'tool_use', id: tool.toolCallId, name, input: tool.args, __result: { text: tool.content } }], undefined)
      const history = renderToStaticMarkup(<HistoryToolCards tools={replay[0].tools!} />)
      for (const html of [live, history]) {
        expect(html).toContain('<svg')
        expect(html).toContain('calendar lookup')
        expect(html).not.toContain('data-chat-activity=')
      }
      expect(live).toContain('Found calendar tools')
      expect(live).toContain('aria-label="Copy output"')
      expect(replay[0].tools![0].output?.text).toBe('Found calendar tools')
      expect(history).toContain('aria-expanded="false"')
    }
  })

  for (const vector of vectors.mixedSummaries) {
    test(`mixed summary category: ${vector.name}`, () => {
      const tools = Object.fromEntries(vector.tools.map((tool, index) => [String(index), {
        ...card(tool.toolName, 'ok', String(index)), ...tool,
      }]))
      const order = Object.keys(tools)
      const live = groupLiveActivityUnits([toolsUnit(order)], tools, false, false)
      expect(live.map(node => node.kind)).toEqual(['activity'])
      const liveGroup = live[0]
      if (liveGroup.kind !== 'activity') throw new Error('Expected one mixed live group')
      const replay = unitsFromMessages([{ role: 'assistant', uuid: vector.name, contentBlocks: Object.values(tools).map(tool => ({
        type: 'tool_use', id: tool.toolCallId, name: tool.toolName, input: tool.args, __result: { text: tool.content ?? 'Completed' },
      })) }])
      const history = foldUnits(replay, null, {}, {})
      expect(history.map(node => node.kind)).toEqual(['activity-fold'])
      const historyGroup = history[0]
      if (historyGroup.kind !== 'activity-fold') throw new Error('Expected one mixed history group')
      for (const locale of ['en', 'zh'] as const) {
        ;(window as any).currentLang = locale
        expect(activitySummaryLabel(translate(locale), liveGroup)).toBe(vector[locale])
        expect(activitySummaryLabel(translate(locale), historyGroup)).toBe(vector[locale])
      }
      expect(activitySummaryIconTool(liveGroup)?.toolName).toBe(vector.iconTool)
      expect(activitySummaryIconTool(historyGroup)?.toolName).toBe(vector.iconTool)
      const icon = renderToStaticMarkup(chatGroupIcon(historyGroup))
      if (vector.iconTool === 'tool_search' || vector.iconTool === 'ToolSearch') {
        expect(icon).toContain('M13.1892 6.42285')
      } else if (vector.iconTool.startsWith('mcp__') && !vector.iconTool.includes('node_repl')) {
        expect(icon).toContain('M11.5381 1.80957')
      }
      expect(liveGroup.units.flatMap(unit => unit.type === 'live-tools' ? unit.order : [])).toEqual(order)
      ;(window as any).currentLang = 'en'
    })
  }

  test('shared desktop and iOS activity contract keeps its exact summary and every source row', () => {
    const tools = Object.fromEntries(activityContract.mixed.calls.map((tool, index) => [String(index), {
      ...card(tool.toolName, 'ok', String(index)), args: tool.args ?? {}, content: tool.output ?? 'Completed',
    }]))
    const order = Object.keys(tools)
    const group = groupLiveActivityUnits([toolsUnit(order)], tools, false, false)[0]
    if (group.kind !== 'activity') throw new Error('Expected one shared activity group')
    for (const locale of ['en', 'zh'] as const) {
      ;(window as any).currentLang = locale
      expect(activitySummaryLabel(translate(locale), group)).toBe(activityContract.mixed.expected[locale])
    }
    expect(group.units.flatMap(unit => unit.type === 'live-tools' ? unit.order : [])).toEqual(order)
    ;(window as any).currentLang = 'en'
  })

  test('MCP source display names dedupe after source casing and preserve rich rows', () => {
    const tools = {
      chat: card('read_thread'),
      a: { ...card('mcp__openai_API__read', 'ok', 'a'), content: 'MCP result' },
      b: card('mcp__OpenAI-API__list', 'ok', 'b'),
      c: card('mcp__github_and_PRs__query', 'ok', 'c'),
    }
    const group = groupLiveActivityUnits([toolsUnit(['chat', 'a', 'b', 'c'])], tools, false, false)[0]
    expect(liveSummary(group)).toBe('Used OpenAI API and GitHub and PRs integrations, read chat')
    const rich = renderToStaticMarkup(<LiveToolCard card={tools.a} open onToggle={() => {}} />)
    expect(rich).toContain('MCP result')
    expect(rich).toContain('aria-expanded="true"')
    expect(rich).toContain('aria-label="Copy output"')
    expect(rich).not.toContain('data-chat-activity=')
  })

})

// Three surfaces drew tool glyphs from three independent tables: the per-item
// card, the collapsed group summary, and the in-progress headline. They
// disagreed, so a web search drew a globe when grouped but a generic wrench on
// its own row, and the headline announced a running `read` with `tool-notebook`
// while the row it summarised drew `tool-read`. One resolver now feeds all three.
// The two tests below pin each pair of surfaces against the other, so a future
// re-divergence fails even if someone reintroduces a second table.
describe('single glyph source across surfaces', () => {
  const svgPath = (markup: string): string => {
    const match = /\sd="([^"]{12,})"/.exec(markup)
    if (!match) throw new Error(`No svg path in: ${markup.slice(0, 200)}`)
    return match[1]
  }

  test('a lone tool row and its group summary draw the same glyph', async () => {
    const { ActivityToolContent } = await import('./activity-tool')
    const { toolIconForName } = await import('./factories')
    // Ten of these seventeen drew two different glyphs before the single
    // resolver: the card keyed off `ToolKind`, which has no `web` member and no
    // agent / ask-user / skill cases, while the summary keyed off the tool name,
    // so a lone row and the fold containing it disagreed. `read` (SKILL.md),
    // `write`, `notebook_edit`, `glob`, `task`, `ask_user`,
    // `unknown_plugin_tool` and both web tools were the diverging ones; the rest
    // agree already and are kept so a future re-split still fails here.
    // Plan mutations are excluded: they are dropped before rendering, so they
    // never reach either surface. Native message notices are standalone events
    // with their own message glyph and do not enter tool groups.
    //
    // This compares the card against the shared resolver. The real group summary
    // (`chatGroupIcon`) additionally overrides MCP and tool-discovery rows to
    // `activity-mcp-source` / `activity-loaded-tools` — a deliberate group-level
    // distinction pinned by the vector test above, not a re-divergence — so the
    // MCP cases here assert resolver parity rather than literal summary parity.
    const cases: Array<[string, unknown]> = [
      ['web_search', { query: 'klaus' }],
      ['web_fetch', { url: 'https://example.com' }],
      ['read', { file_path: 'src/main.ts' }],
      ['read', { file_path: 'assets/preview.png' }],
      ['read', { file_path: '/skills/deploy/SKILL.md' }],
      ['ls', { path: 'src' }],
      ['grep', { pattern: 'TODO' }],
      ['bash', { command: 'npm run build' }],
      ['write', { file_path: 'src/a.ts' }],
      ['notebook_edit', { notebook_path: 'a.ipynb' }],
      ['glob', { pattern: '**/*.ts' }],
      ['browser_navigate', { url: 'https://example.com' }],
      ['task', { prompt: 'audit this' }],
      ['ask_user', { questions: [] }],
      ['mcp__slack__send_message', { channel: 'updates' }],
      ['mcp__node_repl__js', { code: '1+1' }],
      ['unknown_plugin_tool', { input: 'x' }],
    ]
    for (const [toolName, args] of cases) {
      const itemPath = svgPath(renderToStaticMarkup(
        <ActivityToolContent tool={{ toolCallId: 'c', toolName, args, state: 'done' }} open={false} onToggle={() => {}} locale="en" />,
      ))
      // The shared resolver, which is also what the collapsed group summary
      // resolves through for every kind except MCP and discovery (see above).
      const groupPath = svgPath(toolIconForName(toolName, args))
      // bun's `expect` takes no message argument (the two-argument form is vitest's
      // and fails typecheck here), so the tool name rides inside the compared value
      // to keep a failure self-describing instead of an opaque path mismatch.
      expect({ tool: toolName, glyph: groupPath }).toEqual({ tool: toolName, glyph: itemPath })
    }
  })

  test('the in-progress headline renders the same glyph as the row it summarises', async () => {
    const { ActivityHeader } = await import('./TranscriptView')
    const { ActivityToolContent } = await import('./activity-tool')
    const { describeActivity } = await import('./activity-model')
    // The headline used to key off the summary's ActivityKind vocabulary, which
    // has no web/notebook distinction, so it announced a running `read` with
    // tool-notebook and a running list with `folder` — neither of which the row
    // below it drew. Rendering the header itself (rather than calling the shared
    // resolver twice) is what makes a re-divergence fail here.
    const cases: Array<[string, unknown]> = [
      ['read', { file_path: 'src/main.ts' }],
      ['read', { file_path: 'assets/preview.png' }],
      ['ls', { path: 'src' }],
      ['web_search', { query: 'klaus' }],
      ['grep', { pattern: 'TODO' }],
      ['bash', { command: 'npm run build' }],
      ['write', { file_path: 'src/a.ts' }],
      ['task', { prompt: 'audit this' }],
      ['unknown_plugin_tool', { input: 'x' }],
    ]
    for (const [toolName, args] of cases) {
      const action = describeActivity(toolName, args, 'running')
      if (!action.running) continue
      const headlinePath = svgPath(renderToStaticMarkup(
        <ActivityHeader node={{ mode: 'active', activeAction: action, summary: undefined as never, thinkingHeading: '' }} />,
      ))
      const itemPath = svgPath(renderToStaticMarkup(
        <ActivityToolContent tool={{ toolCallId: 'c', toolName, args, state: 'running' }} open={false} onToggle={() => {}} locale="en" />,
      ))
      // Same bun/vitest signature difference as above: the tool name travels with
      // the compared value so a divergence names the tool that caused it.
      expect({ tool: toolName, glyph: headlinePath }).toEqual({ tool: toolName, glyph: itemPath })
    }
  })
})
