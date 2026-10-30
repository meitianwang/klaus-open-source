import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { encodeDelegationEnvelope } from '../../../../contracts/thread-delegation'
import type { ActivityToolData } from './activity-tool'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {} }

const {
  ActivityToolContent,
  activityAnsiChunks,
  activityInputText,
  activityShellResult,
  activityToolPresentation,
  activityToolSummary,
  displayShellCommand,
} = await import('./activity-tool')

function tool(overrides: Partial<ActivityToolData> = {}): ActivityToolData {
  return { toolCallId: 'call-1', toolName: 'bash', args: { command: 'npm run build' }, state: 'done', ...overrides }
}

function render(value: ActivityToolData, open = false, locale = 'en') {
  return renderToStaticMarkup(<ActivityToolContent tool={value} open={open} onToggle={() => {}} locale={locale} />)
}

describe('activity command meaning', () => {
  test('recognizes a quoted filename without losing spaces or classifying compounds as reads', () => {
    expect(activityToolPresentation(tool({ args: { command: "cat 'src/my file.ts'" } }))).toMatchObject({ kind: 'read', path: 'src/my file.ts' })
    expect(activityToolPresentation(tool({ args: { command: 'cat file.ts && npm test' } })).kind).toBe('exec')
    expect(activityToolPresentation(tool({ args: { command: 'cat "$HOME/file.ts"' } })).kind).toBe('exec')
    expect(activityToolPresentation(tool({ args: { command: "sed -n '20,40p' src/file.ts" } }))).toMatchObject({ kind: 'read', path: 'src/file.ts' })
  })

  test('extracts search patterns separately from flags and file roots', () => {
    expect(activityToolPresentation(tool({ args: { command: "rg -n --glob '*.tsx' 'useEffect' src" } }))).toMatchObject({ kind: 'search', path: 'src', query: 'useEffect' })
    expect(activityToolPresentation(tool({ args: { command: 'rg --files src' } }))).toMatchObject({ kind: 'list', path: 'src' })
    expect(activityToolPresentation(tool({ args: { command: 'rg -f patterns.txt src' } })).kind).toBe('exec')
    expect(activityToolPresentation(tool({ toolName: 'grep', args: { pattern: 'TODO', path: 'src' } }))).toMatchObject({ kind: 'search', query: 'TODO' })
  })

  test('unwraps only complete shell invocations and retains command text', () => {
    expect(displayShellCommand("/bin/zsh -lc 'git status --short && git diff'" )).toBe('git status --short && git diff')
    expect(displayShellCommand('zsh -lc "echo $HOME"')).toBe('zsh -lc "echo $HOME"')
    expect(displayShellCommand("bash -lc 'echo hello' extra")).toBe("bash -lc 'echo hello' extra")
  })

  test('preserves unknown plugin inputs instead of reducing them to a short target', () => {
    const value = tool({ toolName: 'mcp__calendar__lookup', args: { query: { limit: 20, title: 'Meeting' }, extra: ['one', 'two'] } })
    expect(activityToolPresentation(value).kind).toBe('tool')
    expect(activityInputText(value.args)).toContain('"limit": 20')
    expect(activityInputText(value.args)).toContain('"two"')
  })
})

describe('interactive widget activity', () => {
  test('only the exact host tool shows a pending card; no iframe runs before success', () => {
    const pending = render(tool({ toolName: 'show_widget', sessionId: 'session-12345678', state: 'running', args: { title: 'Counter' } }))
    expect(pending).toContain('data-widget-state="pending"')
    expect(pending).toContain('Counter')
    expect(pending).not.toContain('<iframe')
    expect(render(tool({ toolName: 'show_widget_fake', state: 'running', args: { title: 'Counter' } }))).not.toContain('data-widget-state')
    const output = JSON.stringify({ kind: 'klaus-widget', sessionId: 'session-12345678', toolCallId: 'call-1',
      widgetId: 'a'.repeat(64), title: 'Counter', revision: 1, path: '/widgets/counter.html', nonce: 'b'.repeat(32) })
    const completed = render(tool({ toolName: 'show_widget', sessionId: 'session-12345678', state: 'done', output }))
    expect(completed).toContain('data-widget-state="loading"')
    expect(completed).not.toContain('<iframe')
  })
})

describe('activity command result metadata', () => {
  test('preserves complete stdout and stderr and prefers supplied runtime metadata', () => {
    const output = 'A'.repeat(5000)
    const value = tool({ output: JSON.stringify({ stdout: output, stderr: '\nwarning', exit_code: 7, duration_ms: 1500 }), exitCode: 0, durationMs: 2000 })
    expect(activityShellResult(value)).toMatchObject({ output: output + '\nwarning', exitCode: 0, durationMs: 2000 })
  })

  test('does not mistake arbitrary JSON output for transport metadata or synthesize exit codes', () => {
    const raw = '{"message":"Hello","data":[1,2,3]}'
    expect(activityShellResult(tool({ output: raw })).output).toBe(raw)
    expect(activityShellResult(tool({ state: 'error', output: 'Permission denied' })).exitCode).toBeUndefined()
    expect(activityShellResult(tool({ output: '{"exitCode":0,"stdout":""}' })).output).toBe('')
  })

  test('reports cancellation and timeout independently of an exit code', () => {
    expect(activityShellResult(tool({ output: '{"aborted":true,"timedOut":true,"exitCode":0}' }))).toMatchObject({ aborted: true, timedOut: true, exitCode: 0 })
    expect(render(tool({ output: '{"aborted":true,"exitCode":0}' }), true)).toContain('Stopped')
    expect(render(tool({ output: '{"timedOut":true,"exitCode":0}' }), true)).toContain('Timed out')
  })
})

describe('activity text and accessibility', () => {
  test('Chinese search rows keep the active and completed location wording distinct', () => {
    const presentation = activityToolPresentation(tool({ toolName: 'grep', args: { pattern: 'needle', path: 'apps/tauri' } }))
    expect(activityToolSummary(presentation, 'running', false, 'zh')).toBe('正在 apps/tauri 中搜索“needle”')
    expect(activityToolSummary(presentation, 'done', false, 'zh')).toBe('已在 apps/tauri 中搜索“needle”')
    const withoutPath = activityToolPresentation(tool({ toolName: 'grep', args: { pattern: 'needle' } }))
    expect(activityToolSummary(withoutPath, 'running', false, 'zh')).toBe('正在搜索“needle”')
  })

  test('keeps a successful semantic file row actionable and its result expandable', () => {
    const html = render(tool({ toolName: 'read', args: { file_path: '/tmp/file.ts' }, output: 'FILE CONTENT' }))
    expect(html).toContain('Read')
    expect(html).toContain('data-agent-activity-file-link')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('FILE CONTENT')
    expect(render(tool({ toolName: 'read', args: { file_path: '/tmp/file.ts' }, output: 'FILE CONTENT' }), true)).toContain('FILE CONTENT')
  })

  test('distinguishes engine-readable images and preserves all lifecycle labels', () => {
    for (const path of ['/tmp/a.png', '/tmp/a.JPG', '/tmp/a.jpeg', '/tmp/a.gif', '/tmp/a.webp']) {
      expect(activityToolPresentation(tool({ toolName: 'read', args: { file_path: path } }))).toMatchObject({ kind: 'image', path, imageCount: 1 })
    }
    for (const path of ['/tmp/a.svg', '/tmp/a.pdf']) {
      expect(activityToolPresentation(tool({ toolName: 'read', args: { file_path: path } })).kind).toBe('read')
    }
    const presentation = activityToolPresentation(tool({ toolName: 'view_image', args: { referenced_image_paths: ['/a.png', '/b.png'] } }))
    expect(presentation).toMatchObject({ kind: 'image', imageCount: 2 })
    expect(activityToolSummary(presentation, 'running', false, 'zh')).toBe('正在查看 2 张图像')
    expect(activityToolSummary(presentation, 'done', false, 'zh')).toBe('已查看 2 张图像')
    expect(activityToolSummary(presentation, 'error', false, 'en')).toBe('Failed to view 2 images')
    expect(activityToolSummary(presentation, 'interrupted', false, 'en')).toBe('Stopped viewing 2 images')
  })

  test('advisor rows carry localized consultation labels in every lifecycle state', () => {
    const presentation = activityToolPresentation(tool({ toolName: 'advisor', args: { question: 'Is this safe?' } }))
    expect(presentation.kind).toBe('tool')
    expect(activityToolSummary(presentation, 'running', false, 'zh')).toBe('正在咨询顾问')
    expect(activityToolSummary(presentation, 'done', false, 'zh')).toBe('已咨询顾问')
    expect(activityToolSummary(presentation, 'error', false, 'zh')).toBe('顾问咨询失败')
    expect(activityToolSummary(presentation, 'interrupted', false, 'zh')).toBe('已停止咨询顾问')
    expect(activityToolSummary(presentation, 'running', false, 'en')).toBe('Consulting advisor')
    expect(activityToolSummary(presentation, 'done', false, 'en')).toBe('Consulted advisor')
    expect(activityToolSummary(presentation, 'error', false, 'en')).toBe('Advisor consultation failed')
  })

  test('the advisor card shows the question and the advice as labeled panels, not an input dump', () => {
    const advice = 'Freeze writes first, then migrate with a rollback window.'
    const html = render(tool({ toolName: 'advisor', args: { question: 'Is this migration safe?' }, output: advice }), true, 'zh')
    expect(html).toContain('请教的问题')
    expect(html).toContain('Is this migration safe?')
    expect(html).toContain('顾问建议')
    expect(html).toContain(advice)
    expect(html).toContain('aria-label="复制建议"')
    expect(html).not.toContain('输入')
    expect(html).not.toContain('{\n  &quot;question&quot;')
    const failed = render(tool({ toolName: 'advisor', args: { question: 'q' }, state: 'error', output: 'Advisor failed: advisor_unavailable' }), true, 'zh')
    expect(failed).toContain('顾问未能回答')
    expect(failed).toContain('Advisor failed: advisor_unavailable')
    expect(failed).not.toContain('顾问建议')
  })

  test('never describes a failed command as successfully run', () => {
    const presentation = activityToolPresentation(tool())
    expect(activityToolSummary(presentation, 'error', false, 'en')).toBe('Failed to run npm run build')
    expect(activityToolSummary(presentation, 'error', false, 'zh')).toBe('未能运行 npm run build')
  })

  test('long read paths retain a visible basename and the full accessible navigation target', () => {
    for (const path of ['/workspace/very-long-project-name/agent-memory/notes/mobile-feature-state.md', 'C:\\Users\\Example\\workspace\\project\\src\\accounts.rs']) {
      const html = render(tool({ toolName: 'read', args: { path } }), false, 'zh')
      expect(html).toContain(`aria-label="${path}"`)
      expect(html).toContain(`>${path.split(/[/\\]/).at(-1)}</button>`)
      expect(html).toContain('data-file="true"')
      expect(html).not.toContain(`>${path}</button>`)
    }
  })

  test('keeps failures inspectable even when the operation normally has a semantic row', () => {
    const html = render(tool({ toolName: 'read', args: { file_path: '/tmp/missing.ts' }, state: 'error', output: 'File not found' }), true)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('File not found')
    expect(html).toContain('aria-label="Failed"')
  })

  test('exposes native disclosure and command buttons, scroll regions, and separate copy actions', () => {
    const html = render(tool({ output: 'Build complete', exitCode: 0 }), true)
    expect(html).toContain('aria-controls=')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('aria-label="$ npm run build"')
    expect(html).toContain('aria-label="Copy command"')
    expect(html).toContain('aria-label="Copy output"')
    expect(html).toContain('role="region" aria-label="Command output"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('Success')
  })

  test('does not render collapsed payloads and keeps all unknown tool payload text accessible on expansion', () => {
    const value = tool({ toolName: 'mcp__test__details', args: { input: '<script>input()</script>' }, output: '<img src=x onerror=output()>' + 'Z'.repeat(6000) })
    expect(render(value)).not.toContain('output()')
    const html = render(value, true)
    expect(html).toContain('&lt;script&gt;input()&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=output()&gt;')
    expect(html).toContain('Z'.repeat(6000))
    expect(html).not.toContain('<script>')
    expect(html).toContain('aria-label="Copy input"')
  })

  test('uses measured durations, switches expanded command summaries, and translates pending states', () => {
    const presentation = activityToolPresentation(tool())
    expect(activityToolSummary(presentation, 'done', false, 'en', 2100)).toBe('Ran npm run build in 2s')
    expect(activityToolSummary(presentation, 'done', true, 'en')).toBe('Ran command')
    expect(activityToolSummary(presentation, 'awaiting-approval', false, 'zh-CN')).toBe('等待批准')
    expect(render(tool({ state: 'done' }), true)).toContain('Exit code unknown')
    expect(render(tool({ state: 'awaiting-approval' }), true, 'zh-CN')).toContain('等待批准')
  })
})

describe('terminal text rendering', () => {
  test('keeps ANSI text safe and preserves styled spans and overwritten progress lines', () => {
    const chunks = activityAnsiChunks('\u001b[31mError\u001b[0m\nHello\rYo\n<x>')
    expect(chunks.map(chunk => chunk.text).join('')).toBe('Error\nYollo\n<x>')
    expect(chunks[0].style.color).toBe('#bb0000')
    expect(activityAnsiChunks('old\u001b[2Knew').map(chunk => chunk.text).join('')).toBe('   new')
    expect(activityAnsiChunks('value\b!').map(chunk => chunk.text).join('')).toBe('valu!')
  })

  test('handles truecolor, palette color, and terminal hyperlinks without making links executable', () => {
    const chunks = activityAnsiChunks('\u001b[38;2;1;2;3mColor\u001b[0m \u001b[38;5;196mRed\u001b[0m \u001b]8;;https://example.test\u0007Link\u001b]8;;\u0007')
    expect(chunks.map(chunk => chunk.text).join('')).toBe('Color Red Link')
    expect(chunks[0].style.color).toBe('rgb(1,2,3)')
    expect(chunks.find(chunk => chunk.text === 'Red')?.style.color).toBe('rgb(255,0,0)')
  })
})

describe('host navigation, discovery, and integration rows', () => {
  test('routes actual chat reads to navigable compact rows on completion, error, and interruption', () => {
    ;(window as any).currentLang = 'en'
    // The navigation and privacy invariants hold for every terminal state. The
    // LABEL differs: an errored read says so rather than claiming success, while
    // an interrupted one keeps neutral wording because a cancelled turn may still
    // have delivered its work.
    const labels = { done: 'Read chat', error: 'Couldn’t read chat', interrupted: 'Read chat' } as const
    for (const state of ['done', 'error', 'interrupted'] as const) {
      const html = render(tool({ toolName: 'read_thread', args: { threadId: 'other-chat' }, state, output: 'Private chat result' }), true)
      expect(html).toContain(labels[state])
      expect(html).toContain('data-chat-activity-thread-id="other-chat"')
      expect(html).not.toContain('Private chat result')
      expect(html).not.toContain('aria-expanded')
    }
    const legacy = render(tool({ toolName: 'klaus_query', args: JSON.stringify({ key: 'session', action: 'history', arguments: { sessionId: 'nested-target' } }) }))
    expect(legacy).toContain('data-chat-activity-thread-id="nested-target"')
    for (const name of ['functions.read_thread', 'mcp__external__read_thread', 'list_threads']) {
      expect(render(tool({ toolName: name, args: { threadId: 'must-not-navigate' } }), true)).not.toContain('data-chat-activity-thread-id')
    }
  })

  test('preserves readable tool names and inspectable outcomes while terminal rows remain compact', () => {
    ;(window as any).currentLang = 'en'
    const html = render(tool({ toolName: 'HTTPServerXML2JSON', args: { secret: 'private-input' }, output: 'private-output' }), true)
    expect(html).toContain('Http server xml 2 json')
    expect(html).toContain('private-input')
    expect(html).toContain('private-output')
    expect(html).toContain('aria-expanded="true"')
    expect(render(tool({ toolName: 'automation_update', state: 'running' }))).toContain('Updating scheduled task')
    expect(render(tool({ toolName: 'automation_update' }))).toContain('Updated scheduled task')
    ;(window as any).currentLang = 'zh'
    expect(render(tool({ toolName: 'read_thread_terminal', state: 'running' }), false, 'zh-CN')).toContain('正在读取聊天终端')
    ;(window as any).currentLang = 'en'
  })

  test('keeps tool discovery expandable with its query, output, and separate copy controls', () => {
    for (const name of ['tool_search', 'ToolSearch']) {
      const value = tool({ toolName: name, args: { query: 'calendar lookup' }, output: 'Found calendar tools' })
      expect(activityToolPresentation(value).kind).toBe('discovery')
      const collapsed = render(value)
      expect(collapsed).toContain('calendar lookup')
      expect(collapsed).toContain('aria-expanded="false"')
      expect(collapsed).not.toContain('Found calendar tools')
      const expanded = render(value, true)
      expect(expanded).toContain('Found calendar tools')
      expect(expanded).toContain('aria-label="Copy input"')
      expect(expanded).toContain('aria-label="Copy output"')
      expect(expanded).not.toContain('data-chat-activity=')
    }
  })

  test('preserves MCP source, full tool identity, and output while native aliases keep specialized views', () => {
    const value = tool({ toolName: 'mcp__openai_API__read', args: { query: 'lookup' }, output: 'MCP result' })
    expect(render(value)).toContain('OpenAI API · Read')
    expect(render(value, true)).toContain('mcp__openai_API__read')
    expect(render(value, true)).toContain('MCP result')
    expect(render(value, true)).not.toContain('data-chat-activity=')
    const mcpMessage = render(tool({ toolName: 'mcp__slack__send_message', args: { channel: 'updates' }, output: 'Message result' }), true)
    expect(mcpMessage).toContain('Slack · Send message')
    expect(mcpMessage).toContain('Message result')
    expect(mcpMessage).not.toContain('data-agent-action=')
    expect(render(tool({ toolName: 'exec' }), true)).toContain('aria-label="Copy command"')
    const nativeMessage = render(tool({ toolName: 'send_message', args: { target: 'review', message: 'Continue' }, output: '{"ok":true}' }), true)
    expect(nativeMessage).toContain('data-agent-action="message"')
    expect(nativeMessage).toContain('data-agent-message-notice')
    expect(nativeMessage).not.toContain('Continue')
    expect(nativeMessage).not.toContain('<button')
    expect(render(tool({ toolName: 'browser_navigate', output: 'Browser capture' }), true)).toContain('Browser capture')
    for (const name of ['fetch_url', 'functions.web_fetch', 'functions.browser_navigate']) {
      expect(render(tool({ toolName: name, output: 'Native result' }), true)).toContain('Native result')
    }
  })
})

/**
 * A delegation drained into a tool result.
 *
 * The engine folds a message delivered mid-turn into the output of that turn's LAST
 * tool call, so a `read` or `bash` result can end with the raw `<klaus-delegation>`
 * wrapper. Printed verbatim that reads as corruption — protocol markup where the
 * user expects their command's output, which is exactly what made a real recipient
 * grep its own repository for tampering.
 */
describe('a delegation inside tool output is folded, not printed as protocol markup', () => {
  const envelope = encodeDelegationEnvelope('Stop and report what you found.', 'thread-sender')

  test('the tool keeps its own output and the message becomes a readable card', () => {
    const html = render(tool({ toolName: 'read', args: { path: '/tmp/a.ts' }, output: `   514\t  const x = 1\n${envelope}` }), true)
    // The tool's own text survives byte-for-byte — folding must not eat output.
    expect(html).toContain('const x = 1')
    // The message is readable, and the wrapper is gone. The live-side fold renders
    // the same shape as the idle-delivered path: an ordinary user bubble with one
    // provenance line, not a tool-card attachment.
    expect(html).toContain('Stop and report what you found.')
    expect(html).toContain('Sent by Klaus from another chat')
    expect(html).toContain('msg-group user delegation')
    expect(html).toContain('class="msg user"')
    expect(html).not.toContain('&lt;klaus-delegation&gt;')
    expect(html).not.toContain('<klaus-delegation>')
    expect(html).not.toContain('<source-thread-id>')
    expect(html).not.toContain('</input>')
  })

  test('the same holds on the shell card, where the output is aggregated stdout', () => {
    const html = render(tool({ toolName: 'bash', args: { command: 'npm test' }, output: JSON.stringify({ exitCode: 0, aggregatedOutput: `exit=0\n12 passed\n${envelope}` }) }), true)
    expect(html).toContain('12 passed')
    expect(html).toContain('Stop and report what you found.')
    expect(html).not.toContain('klaus-delegation')
  })

  test('the edit card does not leak the wrapper either', () => {
    // Edit-family tools have their OWN renderer, which prints the tool result into a
    // `<pre>` of its own. A fold that lived inside `ToolDetails` would miss it —
    // which is exactly the hole the first version of this fix shipped with. The
    // engine drains into whichever call was last, and that can be an edit.
    const html = render(tool({ toolName: 'multi_edit', args: { path: '/tmp/a.ts', edits: [] }, output: `Applied 2 edits\n${envelope}` }), true)
    expect(html).toContain('Applied 2 edits')
    expect(html).toContain('Stop and report what you found.')
    expect(html).not.toContain('klaus-delegation')
    expect(html).not.toContain('source-thread-id')
  })

  test('the agent-action card does not leak the wrapper either', () => {
    // A successful send remains a static notice; external deliveries keep their own row.
    const html = render(tool({ toolName: 'SendMessage', args: { to: 'peer', message: 'hi' }, output: `Delivered to peer\n${envelope}` }), true)
    expect(html).toContain('data-agent-message-notice')
    expect(html).not.toContain('>hi</div>')
    expect(html).not.toContain('Delivered to peer')
    expect(html).toContain('Stop and report what you found.')
    expect(html).not.toContain('klaus-delegation')
  })

  test('every envelope is folded and the text between them is kept in order', () => {
    const second = encodeDelegationEnvelope('Second message.', 'thread-sender')
    const html = render(tool({ output: `HEAD\n${envelope}\nMIDDLE\n${second}\nTAIL` }), true)
    for (const kept of ['HEAD', 'MIDDLE', 'TAIL', 'Stop and report what you found.', 'Second message.']) {
      expect(html).toContain(kept)
    }
    expect(html).not.toContain('klaus-delegation')
    // Order is preserved: the fold cannot reorder the tool's own output.
    expect(html.indexOf('HEAD')).toBeLessThan(html.indexOf('MIDDLE'))
    expect(html.indexOf('MIDDLE')).toBeLessThan(html.indexOf('TAIL'))
  })

  test('output with no envelope renders exactly as before', () => {
    const html = render(tool({ output: 'plain stdout\nline two' }), true)
    expect(html).toContain('plain stdout')
    expect(html).not.toContain('Sent by Klaus from another chat')
  })

  test('a malformed envelope stays visible rather than being swallowed', () => {
    // Same rule as the delivered-message path: showing protocol markup is better
    // than silently dropping text the user may need.
    const html = render(tool({ output: 'before <klaus-delegation><input>unclosed' }), true)
    expect(html).toContain('before')
    expect(html).toContain('unclosed')
    expect(html).not.toContain('Sent by Klaus from another chat')
  })

  test('markup in the message is escaped by the renderer, not injected', () => {
    const hostile = encodeDelegationEnvelope('<img src=x onerror=alert(1)>', 'thread-sender')
    const html = render(tool({ output: `out\n${hostile}` }), true)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('the card renders at all — an unknown icon name throws and would blank the whole tool card', () => {
    // `icon()` throws on an unknown name, and nothing type-checks icon strings, so
    // this is the assertion that catches a typo'd glyph reaching production. It is
    // deliberately separate from the content assertions above: those would also
    // fail, but with a message that points at the wrong thing.
    expect(() => render(tool({ output: `out\n${envelope}` }), true)).not.toThrow()
    expect(render(tool({ output: `out\n${envelope}` }), true)).toContain('<svg')
  })

  test('the label follows the UI language', () => {
    ;(globalThis as any).window.currentLang = 'zh'
    try {
      const html = render(tool({ output: `out\n${envelope}` }), true)
      expect(html).toContain('由 Klaus 从另一个对话发送')
    } finally {
      ;(globalThis as any).window.currentLang = 'en'
    }
  })

  test('references only class names that exist in the stylesheet', () => {
    const stylesheet = readFileSync(new URL('./activity-tool.module.css', import.meta.url), 'utf8')
    for (const name of ['toolDelegation', 'toolDelegationHead', 'toolDelegationText']) {
      expect(stylesheet).toContain(`.${name} `)
    }
  })
})
