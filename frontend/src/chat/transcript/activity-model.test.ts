import { describe, expect, test } from 'bun:test'
import { describeActivity, projectActivity, summarizeActivity, transcriptPageStart, turnCollapseState } from './activity-model'
import vectors from './activity-collapse-vectors.json'

describe('committed activity contract', () => {
  test('final, stop, manual choice, and child lifecycle form independent inputs', () => {
    expect(turnCollapseState({ hasFinal: false, interrupted: false, hasActivity: true, allowCollapseBeforeFinal: vectors.rules.allowCollapseBeforeFinal }).allowed).toBe(!vectors.rules.outerRequiresFinal)
    expect(turnCollapseState({ hasFinal: true, interrupted: true, hasActivity: true, allowCollapseBeforeFinal: true }).allowed).toBe(vectors.rules.interruptedOuterFold)
    expect(turnCollapseState({ hasFinal: true, interrupted: false, hasActivity: true }).open).toBe(false)
    expect(turnCollapseState({ hasFinal: true, interrupted: false, hasActivity: true, preventAutoCollapse: true }).open).toBe(vectors.rules.unsettledSubagentsPreventAutoCollapse)
    expect(turnCollapseState({ hasFinal: true, interrupted: false, hasActivity: true, preventAutoCollapse: true, collapsed: true }).open).toBe(false)
    expect(turnCollapseState({ hasFinal: true, interrupted: false, hasActivity: true, collapsed: false }).open).toBe(vectors.rules.manualChoiceWins)
    // A failed child is settled and does not hold the completed process open.
    expect(turnCollapseState({ hasFinal: true, interrupted: false, hasActivity: true, preventAutoCollapse: !vectors.rules.failedSubagentIsSettled }).open).toBe(false)
  })
  test('running processes allow manual collapse and default open until completion', () => {
    const running = { hasFinal: false, interrupted: false, hasActivity: true, hasRunningTools: true, allowCollapseBeforeFinal: true, preventAutoCollapse: true }
    expect(turnCollapseState(running)).toEqual({ allowed: true, open: true })
    expect(turnCollapseState({ ...running, collapsed: true })).toEqual({ allowed: true, open: false })
    expect(turnCollapseState({ ...running, hasFinal: true, preventAutoCollapse: false })).toEqual({ allowed: true, open: false })
    expect(turnCollapseState({ ...running, hasFinal: true, preventAutoCollapse: false, collapsed: false }).open).toBe(true)
  })
  test('repeated reads and multi-file edits count distinct paths while calls retain their identities', () => {
    const entries = [
      { key: 'r1', value: 1, grouping: 'tool' as const, action: describeActivity('read', { path: '/a' }, 'done') },
      { key: 'r2', value: 2, grouping: 'tool' as const, action: describeActivity('read', { path: '/a' }, 'done') },
      { key: 'p', value: 3, grouping: 'tool' as const, action: describeActivity('apply_patch', { patch: '*** Update File: /a\n*** Add File: /b\n' }, 'done') },
    ]
    expect(summarizeActivity(entries)).toMatchObject({ reads: 1, edits: 2 })
    expect(projectActivity(entries, false)[0].kind).toBe('group')
    expect(projectActivity(entries.slice(2), false)[0].kind).toBe('item')
  })
  test('counts every viewed image without also claiming a file read', () => {
    const entries = [
      { key: 'i1', value: 1, grouping: 'tool' as const, action: describeActivity('read', { path: '/a.png' }, 'done') },
      { key: 'i2', value: 2, grouping: 'tool' as const, action: describeActivity('read', { path: '/a.png' }, 'done') },
      { key: 'i3', value: 3, grouping: 'tool' as const, action: describeActivity('view_image', { referenced_image_paths: ['/b.jpg', '/c.webp'] }, 'done') },
    ]
    expect(summarizeActivity(entries)).toMatchObject({ images: 4, reads: 0 })
    expect(projectActivity(entries, false)[0]).toMatchObject({ kind: 'group', summary: { images: 4 } })
    expect(projectActivity(entries.slice(0, 1), false)[0].kind).toBe('item')
  })
  test('compound shell programs never become misleading read-only summaries', () => {
    for (const command of ['cat a; rm b', 'ls && echo done', 'cat $(build)', 'rg x | head']) {
      expect(describeActivity('bash', { command }, 'done').kind).toBe('command')
    }
  })
  test('a page cannot begin in the middle of a turn, including imported records', () => {
    const messages = [
      { role: 'user', turnId: 'a' }, { role: 'assistant', turnId: 'a' },
      { role: 'user', turnId: 'b' }, ...Array.from({ length: 130 }, () => ({ role: 'assistant', turnId: 'b' })),
    ]
    expect(transcriptPageStart(messages, 32)).toBe(2)
    expect(transcriptPageStart(messages.map(({ role }) => ({ role })), 32)).toBe(2)
    expect(transcriptPageStart(messages, 1)).toBe(0)
  })
})


test('skill definitions and named MCP sources have independent completed summaries', () => {
  const entries = [
    ['read', { path: '/skills/review/SKILL.md' }],
    ['bash', { command: 'cat /skills/review/SKILL.md' }],
    ['mcp__calendar__search', { query: 'today' }],
    ['custom_tool', { query: 'value' }],
  ].map(([name, args], index) => ({ key: String(index), value: null, grouping: 'tool' as const, action: describeActivity(name as string, args, 'done') }))
  expect(summarizeActivity(entries)).toMatchObject({ skills: 1, reads: 0, sources: ['Calendar'], tools: [], dynamicTools: [{ toolName: 'custom_tool' }] })
  expect(describeActivity('apply_patch', '*** Add File: /a\n+x\n*** Add File: /b\n+y', 'done').paths).toEqual(['/a', '/b'])
})

describe('host activity and discovery metadata', () => {
  const entries = (calls: Array<[string, unknown, string?]>) => calls.map(([name, args, output], index) => ({
    key: String(index), value: index, grouping: 'tool' as const, action: describeActivity(name, args, 'done', output),
  }))

  test('keeps every call while deduping dynamic summaries by exact host identity and query kind', () => {
    const summary = summarizeActivity(entries([
      ['list_threads', {}], ['read_thread', { threadId: 'a' }], ['read_thread', { threadId: 'b' }],
      ['klaus_query', { key: 'session', action: 'history', arguments: { sessionId: 'a' } }],
      ['klaus_query', { key: 'session', action: 'list' }], ['list_archived_threads', {}], ['list_threads', {}],
    ]))
    expect(summary.allTools).toHaveLength(7)
    expect(summary.dynamicTools.map(tool => [tool.toolName, (tool.args as any)?.action])).toEqual([
      ['list_threads', undefined], ['read_thread', undefined], ['klaus_query', 'history'], ['klaus_query', 'list'], ['list_archived_threads', undefined],
    ])
    expect(summary.reads + summary.lists + summary.searches).toBe(0)
    expect(summary.tools).toEqual([])
  })

  test('counts only newly loaded tool identities and preserves source output for both discovery aliases', () => {
    const first = 'These tools are now available:\n- calendar_lookup: Search\n- email_search: Search email'
    const second = 'These tools are now available:\n- calendar_lookup: Search\nThese tools were already available:\n- other_tool: Existing\nNo matching tools found for:\n- missing: Missing'
    const summary = summarizeActivity(entries([
      ['tool_search', { query: 'calendar' }, first], ['ToolSearch', { query: 'email' }, second], ['tool_search', {}, 'No matching tools found.'],
    ]))
    expect(summary.loadedTools).toBe(2)
    expect(summary.searches).toBe(0)
    expect(summary.skills).toBe(0)
    expect(summary.tools).toEqual([])
    expect(summary.allTools[1].content).toBe(second)
    expect(describeActivity('tool_search', {}, 'done').discoveredNames).toEqual([])
    expect(summarizeActivity(entries([['tool_search', {}, 'No matching tools found.']])).loadedTools).toBe(0)
  })

  test('formats and dedupes named MCP sources without confusing REPL calls with integrations', () => {
    const summary = summarizeActivity(entries([
      ['mcp__openai_API__read', {}], ['mcp__OpenAI-API__list', {}], ['mcp__github_and_PRs__query', {}],
      ['mcp__node_repl__js', {}], ['mcp__cua_repl__js', {}], ['mcp__', {}],
    ]))
    expect(summary.sources).toEqual(['OpenAI API', 'GitHub and PRs'])
    expect(summary.commands).toBe(2)
    expect(summary.unnamedMcp).toBe(1)
    expect(summary.dynamicTools).toEqual([])
    expect(summary.tools).toEqual([])
  })

  test('keeps native aliases and agent controls out of dynamic rows while retaining skill counts', () => {
    for (const [name, args] of [['exec', { command: 'npm test' }], ['run_command', { command: 'npm test' }], ['multi_edit', {}], ['send_message', {}], ['SendMessage', {}], ['browser_navigate', {}]] as const) {
      expect(describeActivity(name, args, 'running').dynamic).not.toBe(true)
    }
    const summary = summarizeActivity(entries([
      ['read', { path: '/skills/review/SKILL.md' }], ['bash', { command: 'cat /skills/review/SKILL.md' }],
      ['tool_search', {}, 'These tools are now available:\n- useful_tool: A useful tool'],
    ]))
    expect(summary.skills).toBe(1)
    expect(summary.loadedTools).toBe(1)
    expect(describeActivity('NotebookRead', { notebook_path: '/a.ipynb' }, 'done').target).toBe('/a.ipynb')
    expect(describeActivity('kill_shell', {}, 'done').kind).toBe('command')
    expect(describeActivity('advisor', {}, 'done').kind).toBe('search')
  })
})
