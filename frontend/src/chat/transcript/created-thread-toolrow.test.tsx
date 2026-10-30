// The created-chat card a `create_thread` TOOL ROW renders from its own result.
//
// A second, redundant path: when a `create_thread` call completed successfully,
// the whole activity row is replaced by the same created-chat card the
// `::created-thread` directive draws, with the thread id parsed out of the tool
// RESULT. Both paths stay alive on purpose — a model that forgets to echo the
// directive still leaves a card.
//
// Klaus only had the directive path, so a `create_thread` row with no directive
// in the reply announced "Created chat" as inert text with nothing to click. This
// file pins the new path: which results yield an id, which rows swap, and that the
// swap never widens what can navigate.
//
// The thread id here is MODEL- and TOOL-authored data arriving from a result
// rather than from a `::created-thread` line, so it is untrusted input on a second
// route; it must reach the attribute escaped, exactly like the directive's.
import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en' }
// No global `document` stub here on purpose: bun runs this file's process against
// other suites' expectations (canvas-image keys off `typeof document`).

const { createdThreadCardId, createdThreadIdFromToolResult } = await import('./chat-activity')
const { ActivityToolContent } = await import('./activity-tool')
const { renderCreatedThreadCardHtml } = await import('./factories')

/**
 * The result text as it reaches a renderer, in the two wrappings that occur.
 *
 * `hostEnvelope` is what `thread-tools.ts` `toolText` hands the engine. The BARE
 * form is the one that actually lands on a card, because these are dynamic tools:
 * the host splits `contentItems` into `content` before the renderer sees them
 * (`splitDynamicToolMedia`), and the block list arrives as `content`. Both are
 * tested because a replay route may hand over either.
 */
const RESULT_JSON = JSON.stringify({ ok: true, threadId: 'thread-9', hostId: 'local', kind: 'klaus', title: null, delivered: 'started' })
const HOST_ENVELOPE = JSON.stringify({ success: true, contentItems: [{ type: 'inputText', text: RESULT_JSON }] })

function row(overrides: { toolName?: string; state?: string; output?: string | null } = {}) {
  return {
    toolCallId: 'call-create-1',
    toolName: overrides.toolName ?? 'create_thread',
    args: { prompt: 'Investigate the flaky test.' },
    state: overrides.state ?? 'done',
    output: overrides.output === undefined ? RESULT_JSON : overrides.output,
  }
}

function render(value: ReturnType<typeof row>): string {
  return renderToStaticMarkup(
    <ActivityToolContent tool={value as never} open={false} onToggle={() => {}} locale="en" />,
  )
}

describe('createdThreadIdFromToolResult', () => {
  test('reads the id out of every wrapping a result arrives in', () => {
    // The bare result object: what a LIVE card holds.
    expect(createdThreadIdFromToolResult(JSON.parse(RESULT_JSON))).toBe('thread-9')
    // The host tool envelope, before the contentItems split.
    expect(createdThreadIdFromToolResult(JSON.parse(HOST_ENVELOPE))).toBe('thread-9')
    // The envelope's text still wrapped as result content blocks.
    expect(createdThreadIdFromToolResult([{ type: 'text', text: RESULT_JSON }])).toBe('thread-9')
    // A JSON document quoted as a string, which is how a result rides a text block.
    expect(createdThreadIdFromToolResult(RESULT_JSON)).toBe('thread-9')
    expect(createdThreadIdFromToolResult(HOST_ENVELOPE)).toBe('thread-9')
  })

  test('a result with no usable id yields null instead of a wrong card', () => {
    expect(createdThreadIdFromToolResult(null)).toBeNull()
    expect(createdThreadIdFromToolResult(undefined)).toBeNull()
    // An error message is ordinary output, not a JSON document.
    expect(createdThreadIdFromToolResult('The conversation was not found.')).toBeNull()
    expect(createdThreadIdFromToolResult(JSON.stringify({ ok: false, error: 'nope' }))).toBeNull()
    // An id key that is not a usable string is not an id.
    expect(createdThreadIdFromToolResult({ threadId: '' })).toBeNull()
    expect(createdThreadIdFromToolResult({ threadId: '   ' })).toBeNull()
    expect(createdThreadIdFromToolResult({ threadId: 42 })).toBeNull()
    // A result that carries threadId: null alongside a real one still resolves.
    expect(createdThreadIdFromToolResult({ ok: true, threadId: 'thread-9', title: null })).toBe('thread-9')
  })

  test('a malformed result never throws', () => {
    // `{` makes this look like a quoted JSON document and JSON.parse will reject it.
    expect(createdThreadIdFromToolResult('{not json')).toBeNull()
    expect(createdThreadIdFromToolResult({ contentItems: [{ type: 'inputText', text: '{oops' }] })).toBeNull()
    // Self-referential structures must terminate rather than recurse forever.
    const cyclic: Record<string, unknown> = { ok: true }
    cyclic.result = cyclic
    expect(createdThreadIdFromToolResult(cyclic)).toBeNull()
  })

  test('a remote host id is refused, like every other conversation card', () => {
    // This navigator opens local conversations only, and a remote id can collide
    // with a local one — the same rule `chatActivityTarget` applies to arguments.
    expect(createdThreadIdFromToolResult({ ok: true, threadId: 'thread-9', hostId: 'remote-mac' })).toBeNull()
    expect(createdThreadIdFromToolResult({ ok: true, threadId: 'thread-9', hostId: 'local' })).toBe('thread-9')
    expect(createdThreadIdFromToolResult({ ok: true, threadId: 'thread-9' })).toBe('thread-9')
    // The refusal reads the record the id came from, so it cannot be side-stepped
    // by a nested local-looking result.
    expect(createdThreadIdFromToolResult({
      hostId: 'remote-mac', threadId: 'remote-thread', result: { threadId: 'local-thread' },
    })).toBeNull()
  })
})

describe('the create_thread row swap gate', () => {
  test('only a completed, non-failed create_thread with an id swaps', () => {
    expect(createdThreadCardId({ toolName: 'create_thread', state: 'done', output: RESULT_JSON })).toBe('thread-9')
    // Interrupted keeps the card: a cancelled turn can still have created the
    // conversation, and the result says so. This is the same reasoning the activity
    // labels use to keep neutral wording for `interrupted`.
    expect(createdThreadCardId({ toolName: 'create_thread', state: 'interrupted', output: RESULT_JSON })).toBe('thread-9')
    // Still running: no result yet, and an in-flight row must show its progress.
    expect(createdThreadCardId({ toolName: 'create_thread', state: 'running', output: RESULT_JSON })).toBeNull()
    expect(createdThreadCardId({ toolName: 'create_thread', state: 'awaiting-approval', output: RESULT_JSON })).toBeNull()
    // Failed: the row has to say the call failed, not offer to open what it did not create.
    expect(createdThreadCardId({ toolName: 'create_thread', state: 'error', output: RESULT_JSON })).toBeNull()
  })

  test('no other tool swaps, however much its result looks like a created chat', () => {
    for (const toolName of ['fork_thread', 'read_thread', 'send_message_to_thread', 'list_threads', 'klaus_query', 'mcp__external__create_thread', 'bash']) {
      expect(createdThreadCardId({ toolName, state: 'done', output: RESULT_JSON })).toBeNull()
    }
  })
})

describe('the create_thread tool row', () => {
  test('a settled row becomes the created-chat card and drops the plain label', () => {
    const html = render(row())
    expect(html).toContain('data-created-thread-id="thread-9"')
    expect(html).toContain('Created chat')
    // The row IS the card: one button, and the activity label it replaces is gone.
    expect(html.split('<button').length - 1).toBe(1)
    expect(html).not.toContain('data-chat-activity=')
    // The ordinary row's own identity survives the swap, so the row is still
    // identifiable in the DOM.
    expect(html).toContain('data-tool-call-id="call-create-1"')
    expect(html).toContain('data-created-thread-tool-row')
    expect(html).toContain('aria-label="Open chat"')
  })

  test('the host envelope form and the split form render the same card', () => {
    // A replay route may hand over either wrapping; both must produce the card, or
    // the same turn would render differently depending on how it was loaded.
    for (const output of [RESULT_JSON, HOST_ENVELOPE]) {
      expect(render(row({ output }))).toContain('data-created-thread-id="thread-9"')
    }
  })

  test('a running, failed or id-less row keeps the ordinary activity row', () => {
    // Running and error keep the label row (an error row must not offer to open a
    // conversation it did not create).
    for (const state of ['running', 'error'] as const) {
      const html = render(row({ state }))
      expect(html).not.toContain('data-created-thread-id')
      expect(html).not.toContain('data-created-thread-tool-row')
      expect(html).toContain('data-chat-activity=')
    }
    // A settled row whose result carries no id stays the plain label: better than a
    // card that navigates nowhere.
    const noId = render(row({ output: JSON.stringify({ ok: true, delivered: 'started' }) }))
    expect(noId).not.toContain('data-created-thread-id')
    expect(noId).toContain('Created chat')
    expect(render(row({ output: null }))).not.toContain('data-created-thread-id')
  })

  test('the row never leaks the tool result text', () => {
    // The card replaces the row, so neither the JSON nor the prompt may appear.
    const html = render(row())
    expect(html).not.toContain('contentItems')
    expect(html).not.toContain('Investigate the flaky test.')
    expect(html).not.toContain('delivered')
  })

  test('a hostile id from the result cannot break out of its attribute', () => {
    // Second injection route for the same untrusted data: the directive route is
    // pinned by created-thread-card.test.ts, and this one must escape identically.
    const hostile = '"><script>alert(1)</script>'
    const html = render(row({ output: JSON.stringify({ ok: true, threadId: hostile }) }))
    expect(html).not.toContain('<script>')
    expect(html.split('<button').length - 1).toBe(1)
    expect(html).toContain('data-created-thread-id="&quot;&gt;&lt;script&gt;')
  })

  test('the label follows the UI language like the directive card does', () => {
    ;(window as any).currentLang = 'zh'
    try {
      expect(render(row())).toContain('已新建聊天')
    } finally {
      ;(window as any).currentLang = 'en'
    }
  })

  test('a lone create_thread row renders without an activity fold of its own', () => {
    // The mechanism check this task turned on: a settled single tool is promoted
    // out of the ACTIVITY fold to an `item` (projectActivity), so no "processed N
    // operations" disclosure stands between the row and the reader. Measured
    // against the real projection in the DOM harness (case 8) — and note the
    // second fold layer it also recorded: a turn WITH a final reply wraps every
    // row in a closed TURN fold, so the card is one expansion away there, exactly
    // like every other tool row. The message-body directive card is outside that
    // fold, which is why the two redundant paths do not have equal visibility.
    const html = render(row())
    expect(html).not.toContain('aria-expanded')
    expect(html).toContain('data-created-thread-id="thread-9"')
  })
})

describe('the tool row card and the directive card are one card', () => {
  test('both routes render byte-identical markup for the same id', () => {
    // The redundant paths must produce the SAME card, or one turn would show two
    // different-looking rows for one chat. The row adds only its own wrapper
    // attributes, so the card body is built by the one shared builder.
    const fromRow = render(row())
    const fromDirective = renderCreatedThreadCardHtml('thread-9')
    expect(fromRow).toContain(fromDirective)
  })
})
