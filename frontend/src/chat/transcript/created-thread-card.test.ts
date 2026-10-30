// The `::created-thread` card list markup and its per-line consumption.
//
// The directive PARSER is pinned by created-thread-directive.test.ts against real
// marked output. This file covers the other half: what the cards actually render,
// and which paragraphs `renderCreatedThreadCards` consumes (via postProcessHtml,
// the function TranscriptView really runs).
//
// The renderer used to swap a card in for a paragraph whose ENTIRE text was one
// directive. `marked` merges consecutive lines into one `<p>`, so two adjacent
// directives — the shape the coordination prompt asks for when one turn creates
// two chats — merged into a single paragraph and leaked as raw protocol text.
// The fix is per-line consumption plus a card list mounted after the body;
// the regression cases below pin both halves.
//
// Two things must not regress: the thread id is model-authored text that ends up
// in an attribute a click handler reads back, so it MUST be escaped; and the
// cards must stay real navigable buttons rather than degrading to inert text.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en' }
// No global `document` stub here on purpose: bun runs this file's process against
// other suites' expectations (canvas-image keys off `typeof document`), and these
// tests only exercise the DOM-free factories plus `postProcessHtmlForTests`.

// CSS modules are not loaded under bun, so every `styles[...]` lookup renders as
// `undefined` — the same as in the other transcript tests, which therefore assert
// structure rather than class names. The class names the builder references are
// verified against the stylesheet source instead, which is the assertion that
// actually catches a typo (a missing rule would silently leave the card unstyled).
const stylesheet = readFileSync(new URL('./transcript.module.css', import.meta.url), 'utf8')

const { renderCreatedThreadCardHtml, renderCreatedThreadListHtml } = await import('./factories')
const { parseCreatedThreadDirective } = await import('../../../../contracts/created-thread-directive')
const { makeTranscriptClickHandler, postProcessHtmlForTests } = await import('./TranscriptView')

const attr = (html: string, name: string): string | null => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html)
  return match ? match[1]! : null
}

/**
 * postProcessHtml with the DOM stubbed to just enough for the created-thread
 * pass: the code-block pass is skipped (no `pre code` in any fixture here), and
 * the paragraph walk gets a tiny parser-free DOM built from `<p>` splits. The
 * real browser behavior of that walk is pinned separately by the headless-Chrome
 * DOM evidence under dist/created-thread-align-logs/ — this stub pins WHICH
 * paragraphs are consumed and WHAT the caller appends, without a DOM engine.
 */
function postProcess(markdownHtml: string): string {
  const paragraphs = markdownHtml.split(/(?=<p[ >])|(?<=<\/p>)/g)
  return postProcessHtmlForTests(paragraphs)
}

/**
 * The click wiring for the raw-HTML created-thread cards.
 *
 * These cards are built as HTML strings, so they cannot use a React onClick —
 * the container delegate in `makeTranscriptClickHandler` is their ONLY click
 * path. A broken selector there would leave a card that looks clickable and does
 * nothing, and no other test would notice. Driven with a fake element the way
 * agent-lifecycle.test.tsx drives the copy button, since these tests have no DOM.
 */
describe('thread card navigation through the transcript click delegate', () => {
  /** A stand-in element whose `closest` answers only the selector asked for. */
  function cardWith(selector: string, dataset: Record<string, string>) {
    const element: any = {
      dataset,
      closest: (asked: string) => (asked === selector ? element : null),
    }
    return element
  }
  function click(element: any): { stopped: boolean } {
    let stopped = false
    const handler = makeTranscriptClickHandler('current-session')
    const originalElement = globalThis.Element
    class FixtureElement {}
    ;(globalThis as any).Element = FixtureElement
    try {
      handler({ target: Object.assign(new FixtureElement(), element), stopPropagation: () => { stopped = true } } as unknown as Event)
    } finally {
      if (originalElement) globalThis.Element = originalElement
      else delete (globalThis as any).Element
    }
    return { stopped }
  }

  test('clicking a created-thread card switches to the created conversation', () => {
    const navigated: string[] = []
    ;(globalThis as any).window.klausSwitchSession = (id: string) => { navigated.push(id) }
    const { stopped } = click(cardWith('[data-created-thread-id]', { createdThreadId: 'thread-b' }))
    expect(navigated).toEqual(['thread-b'])
    expect(stopped).toBe(true)
  })

  test('an empty id stops the click but navigates nowhere', () => {
    // A card with no usable id must not switch to an empty session. Swallowing the
    // click is still right: falling through would bubble into the message-level
    // handler and do something the user did not ask for.
    const navigated: string[] = []
    ;(globalThis as any).window.klausSwitchSession = (id: string) => { navigated.push(id) }
    const { stopped } = click(cardWith('[data-created-thread-id]', { createdThreadId: '' }))
    expect(navigated).toEqual([])
    expect(stopped).toBe(true)
  })

  test('a click elsewhere is left for the other handlers', () => {
    const navigated: string[] = []
    ;(globalThis as any).window.klausSwitchSession = (id: string) => { navigated.push(id) }
    const plain: any = { dataset: {}, closest: () => null }
    click(plain)
    expect(navigated).toEqual([])
  })
})

describe('the created-thread card row', () => {
  test('renders one navigable button carrying the thread id', () => {
    const html = renderCreatedThreadCardHtml('614cc8f1-8c61-5f4f-8ef8-8199ba8b267a')
    // A real button, so it is focusable and the container click delegate matches it.
    expect(html.startsWith('<button type="button"')).toBe(true)
    expect(html.endsWith('</button>')).toBe(true)
    expect(attr(html, 'data-created-thread-id')).toBe('614cc8f1-8c61-5f4f-8ef8-8199ba8b267a')
    // Exactly one button: a row, not a nested control stack.
    expect(html.split('<button').length - 1).toBe(1)
    expect(html.split('</button>').length - 1).toBe(1)
    expect(html).toContain('Created chat')
    expect(html).toContain('<svg')
    // The row's accessible name is the action, not the title.
    expect(attr(html, 'aria-label')).toBe('Open chat')
  })

  test('references only class names that exist in the stylesheet', () => {
    // Catches a typo'd CSS-module key, which would render an unstyled card while
    // every structural assertion still passed. The builder looks these up through
    // `styles[...]`, so a missing rule is invisible without this check.
    for (const name of [
      'created-thread-list', 'created-thread-card', 'created-thread-card-compact',
      'created-thread-icon', 'created-thread-title', 'created-thread-trailing',
      'created-thread-chevron', 'created-thread-more',
    ]) {
      expect(stylesheet).toContain(`.${name}`)
    }
  })

  test('an id with markup or quotes cannot break out of its attribute', () => {
    // This is the injection case: the id is model-authored and untrusted, and the
    // rendered attribute is read back by the click handler. If it were
    // concatenated raw, `"><script>` would close the tag early.
    const hostile = '"><script>alert(1)</script>'
    const html = renderCreatedThreadCardHtml(hostile)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('"><script>')
    expect(attr(html, 'data-created-thread-id')).toBe('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    // Exactly one button, not two: the breakout did not inject a sibling element.
    expect(html.split('<button').length - 1).toBe(1)
    expect(html.split('</button>').length - 1).toBe(1)
  })

  test('an id containing an ampersand is escaped once, not double-escaped', () => {
    const html = renderCreatedThreadCardHtml('a&b')
    expect(attr(html, 'data-created-thread-id')).toBe('a&amp;b')
    expect(html).not.toContain('a&amp;amp;b')
  })

  test('the row carries no hover tooltip of any kind', () => {
    // The row's only visible text is the card title and its accessible name is
    // the action, so a hover bubble would only repeat one of the two. Neither a
    // native `title=` nor a custom tooltip span ships here; the transcript
    // vectors assert the same absence.
    const html = renderCreatedThreadCardHtml('thread-b')
    expect(html).not.toContain('title=')
    expect(html).not.toContain('data-klaus-tip')
    expect(html).not.toContain('role="tooltip"')
  })

  test('the label follows the UI language', () => {
    ;(window as any).currentLang = 'zh'
    try {
      expect(renderCreatedThreadCardHtml('thread-b')).toContain('已新建聊天')
    } finally {
      ;(window as any).currentLang = 'en'
    }
  })

  test('a parsed directive renders a card whose id matches what the parser returned', () => {
    // End to end from raw model text: parse, then render, and the id must survive
    // unchanged. This is the pair that postProcessHtml actually performs.
    const directive = parseCreatedThreadDirective('::created-thread{threadId="thread-b"}')
    expect(directive).not.toBe(null)
    const html = renderCreatedThreadCardHtml(directive!.threadId)
    expect(attr(html, 'data-created-thread-id')).toBe('thread-b')
  })
})

describe('the created-thread list shell', () => {
  test('one directive renders the bare row inside the list, no expander', () => {
    const html = renderCreatedThreadListHtml(['thread-a'])
    expect(html.split('<button').length - 1).toBe(1)
    expect(html).not.toContain('data-created-thread-more')
    expect(html).not.toContain('data-collapsed')
  })

  test('two directives render two rows, still no expander', () => {
    // The screenshot bug's shape: two chats created in one turn. Both must be
    // visible without any expansion — the cap only bites past three.
    const html = renderCreatedThreadListHtml(['thread-a', 'thread-b'])
    expect(html.split('<button').length - 1).toBe(2)
    expect(html).not.toContain('data-created-thread-more')
  })

  test('five directives cap at three rows plus a Show-more expander', () => {
    // Overflow rows render as compact cards after the expander, and
    // the expander carries both labels pre-rendered so the click delegate never
    // needs a live i18n lookup.
    const ids = ['a', 'b', 'c', 'd', 'e']
    const html = renderCreatedThreadListHtml(ids)
    expect(html.split('<button').length - 1).toBe(6) // 5 cards + 1 expander
    expect(html).toContain('data-created-thread-more')
    expect(attr(html, 'data-collapsed')).toBe('true')
    expect(html).toContain('Show 2 more chats')
    expect(html).toContain('Show fewer chats')
    // All five ids are present in the markup; overflow rows start display:none via
    // the delegate, so their presence here is about id integrity, not visibility.
    for (const id of ids) expect(html).toContain(`data-created-thread-id="${id}"`)
  })

  test('zero directives render nothing', () => {
    expect(renderCreatedThreadListHtml([])).toBe('')
  })
})

describe('per-line consumption in postProcessHtml', () => {
  const D1 = '<p>::created-thread{threadId=&quot;a1&quot;}</p>'
  const D2 = '<p>::created-thread{threadId=&quot;b2&quot;}</p>'

  test('two adjacent directive lines (one merged paragraph) both become cards', () => {
    // THE regression: marked emits ONE <p> for two consecutive directive lines.
    // Whole-paragraph matching leaked both as raw text; per-line matching must
    // consume the paragraph and emit two rows.
    const out = postProcess('<p>::created-thread{threadId=&quot;a1&quot;}<br>::created-thread{threadId=&quot;b2&quot;}</p>')
    expect(out).not.toContain('::created-thread')
    expect(out).toContain('data-created-thread-id="a1"')
    expect(out).toContain('data-created-thread-id="b2"')
  })

  test('separate paragraphs are consumed and the list mounts once, after the body', () => {
    const out = postProcess(`${D1}${D2}<p>Done.</p>`)
    expect(out).not.toContain('::created-thread')
    expect(out).toContain('data-created-thread-id="a1"')
    expect(out).toContain('data-created-thread-id="b2"')
    const listAt = out.indexOf('data-created-thread-list')
    expect(listAt).toBeGreaterThan(out.indexOf('Done.'))
  })

  test('a directive sharing its paragraph with prose is left as visible text', () => {
    // The parser refuses glued prose, and the walk must not delete the sentence
    // around it: swallowing model output is the worse failure.
    const out = postProcess('<p>Done. ::created-thread{threadId=&quot;thread-b&quot;} is ready.</p>')
    expect(out).toContain('::created-thread')
    expect(out).toContain('Done.')
    expect(out).not.toContain('data-created-thread-list')
  })

  test('a malformed directive line keeps its paragraph as text', () => {
    const out = postProcess('<p>::created-thread{threadId=unquoted}</p>')
    expect(out).toContain('::created-thread')
    expect(out).not.toContain('data-created-thread-list')
  })

  test('no directives means the caller appends nothing', () => {
    const out = postProcess('<p>Just prose.</p>')
    expect(out).not.toContain('data-created-thread-list')
    expect(out).toContain('Just prose.')
  })
})
